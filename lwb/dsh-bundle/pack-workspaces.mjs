import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

const PACK_ID = /^[a-z][a-z0-9-]{1,62}$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

// The canonical-root check below exists to reject symlink redirection, but
// `realpath` also normalizes incidental spelling: on Windows it upper-cases the
// drive letter, and on macOS it may change case. Comparing raw strings would
// reject a perfectly safe root that was merely configured as `f:\...`, which
// surfaced as "The profile-owned root must be canonical." and an empty pack
// sidebar. Compare case-insensitively on platforms whose filesystems are, so
// only a genuine redirection fails.
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

function samePath(left, right) {
  return CASE_INSENSITIVE_PATHS ? left.toLowerCase() === right.toLowerCase() : left === right
}

function packId(value) {
  if (typeof value !== 'string' || !PACK_ID.test(value)) fail('PACK_WORKSPACE_INVALID', 'Invalid capability pack id.')
  return value
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('PACK_WORKSPACE_UNSAFE', `Expected an owned directory: ${path}`)
  return path
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function readState(path) {
  if (!await exists(path)) return { schemaVersion: 1, packs: {} }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) fail('PACK_WORKSPACE_UNSAFE', 'Workspace ownership index must be a regular file.')
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (state?.schemaVersion !== 1 || !state.packs || Array.isArray(state.packs) || typeof state.packs !== 'object') {
    fail('PACK_WORKSPACE_CORRUPT', 'Invalid workspace ownership index; refusing to replace it.')
  }
  for (const [id, record] of Object.entries(state.packs)) {
    packId(id)
    if (!record || typeof record.packageName !== 'string' || !PACKAGE.test(record.packageName) || !['registered', 'unregistered', 'unregistering'].includes(record.status)
      || !(record.workspaceId === null || typeof record.workspaceId === 'string')
      || !Number.isSafeInteger(record.generation) || record.generation < 0
      || !Array.isArray(record.sessionIds) || record.sessionIds.some((session) => typeof session !== 'string' || !session)) {
      fail('PACK_WORKSPACE_CORRUPT', `Invalid workspace ownership for ${id}.`)
    }
    if (record.reset && (!/^[a-f0-9-]{36}$/u.test(record.reset.id) || !['prepared', 'moved'].includes(record.reset.phase))) {
      fail('PACK_WORKSPACE_CORRUPT', `Invalid workspace reset journal for ${id}.`)
    }
  }
  return state
}

async function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    // Windows：目标文件可能被杀毒/索引器短暂占用，rename 抛 EPERM；退避重试吸收。
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break }
      catch (error) {
        if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= 6) throw error
        await new Promise((resolve) => setTimeout(resolve, [50, 120, 280, 600, 1200, 2400, 4000][attempt]))
      }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}

/**
 * Profile-local capability workspace ownership, separate from DSH's ordinary
 * workspace picker. Internal execution still uses native DSH Agents/Sessions.
 * One host instance owns this root. The caller must not share it across hosts.
 *
 * All background work must remain inside run() until its final write settles.
 * Unload closes admission first and waits for those operations before returning.
 * No model, browser session, process cwd, or package source path is consulted.
 */
export class LwbPackWorkspaces {
  constructor({ root, workspaceRegistry, stopTimeoutMs = 30_000 } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root)) fail('PACK_WORKSPACE_INVALID', 'An absolute profile-owned root is required.')
    if (workspaceRegistry && (!workspaceRegistry.create || !workspaceRegistry.delete)) fail('PACK_WORKSPACE_INVALID', 'Invalid workspace registry adapter.')
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) fail('PACK_WORKSPACE_INVALID', 'Invalid task stop timeout.')
    this.root = resolve(root)
    // Native DSH workspace registration participates in ordinary conversation
    // auto-selection. Pack directories use their own stable identities; DSH
    // Agents need cwd, not an entry in that user-facing registry.
    this.registry = workspaceRegistry || {
      create: async (path) => ({ id: `lwb-pack-workspace-${basename(path)}`, path }),
      delete: async () => true,
    }
    this.stopTimeoutMs = stopTimeoutMs
    this.tail = Promise.resolve()
    this.active = new Map()
  }

  serial(operation) {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => {})
    return next
  }

  async state() {
    // Only this configured root may be created recursively. All owned children
    // below it are checked individually to reject symlink redirection.
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await directory(this.root)
    const canonical = await realpath(this.root)
    if (!samePath(canonical, this.root)) fail('PACK_WORKSPACE_UNSAFE', 'The profile-owned root must be canonical.')
    await directory(join(this.root, 'workspaces'), true)
    await directory(join(this.root, 'retained'), true)
    return readState(join(this.root, 'ownership.json'))
  }

  save(state) { return saveState(join(this.root, 'ownership.json'), state) }
  path(id) { return join(this.root, 'workspaces', packId(id)) }

  requireRecord(state, id) {
    const record = state.packs[packId(id)]
    if (!record) fail('PACK_WORKSPACE_UNKNOWN', `No workspace belongs to ${id}.`)
    return record
  }

  projection(id, record) {
    return Object.freeze({
      packId: id,
      workspaceId: record.workspaceId,
      workspacePath: this.path(id),
      generation: record.generation,
      status: record.status,
    })
  }

  async recoverReset(state, id) {
    const record = this.requireRecord(state, id)
    if (!record.reset) return
    const path = this.path(id)
    const backup = join(this.root, 'retained', `${id}-${record.reset.id}`)
    if (record.reset.phase === 'prepared') {
      if (!await exists(backup)) {
        await directory(path)
        await rename(path, backup)
      } else if (await exists(path)) {
        // In this phase the replacement has not been created by us. Never
        // guess which directory belongs to the interrupted operation.
        fail('PACK_WORKSPACE_RECOVERY_REQUIRED', 'Both reset source and backup exist; manual recovery is required.')
      }
      await directory(backup)
      record.reset.phase = 'moved'
      await this.save(state)
    }
    await directory(backup)
    await directory(path, true)
    record.generation += 1
    record.lastReset = { backup, at: new Date().toISOString() }
    delete record.reset
    await this.save(state)
  }

  /** Create/reuse the one workspace, and allow task admission after it is ready. */
  activate(manifest) {
    return this.serial(async () => {
      const id = packId(manifest?.id)
      if (typeof manifest.packageName !== 'string' || !PACKAGE.test(manifest.packageName)) fail('PACK_WORKSPACE_INVALID', 'Invalid package identity.')
      const state = await this.state()
      let record = state.packs[id]
      if (record && record.packageName !== manifest.packageName) fail('PACK_WORKSPACE_COLLISION', 'This workspace belongs to a different package.')
      if (this.active.has(id)) {
        const runtime = this.active.get(id)
        if (runtime.closing) fail('PACK_WORKSPACE_BUSY', 'Workspace is still stopping tasks.')
        await directory(this.path(id))
        return this.projection(id, record)
      }
      if (!record) {
        if (await exists(this.path(id))) {
          await directory(this.path(id))
          if ((await readdir(this.path(id))).length) fail('PACK_WORKSPACE_UNOWNED', 'Refusing to adopt an unregistered nonempty directory.')
        }
        record = state.packs[id] = {
          packageName: manifest.packageName, status: 'unregistered', workspaceId: null,
          generation: 0, sessionIds: [],
        }
        // Persist ownership before registration, so a crash can reuse the
        // exact directory and the adapter's idempotent create(path) on retry.
        await this.save(state)
      }
      await this.recoverReset(state, id)
      if (record.status === 'unregistering') {
        if (record.workspaceId) await this.registry.delete(record.workspaceId)
        record.workspaceId = null
        record.status = 'unregistered'
        await this.save(state)
      }
      await directory(this.path(id), true)
      const workspace = await this.registry.create(this.path(id), manifest.name)
      if (typeof workspace?.id !== 'string' || workspace.path !== this.path(id)) fail('PACK_WORKSPACE_INVALID', 'Registry returned a mismatched workspace.')
      record.workspaceId = workspace.id
      record.status = 'registered'
      await this.save(state)
      this.active.set(id, { closing: false, tasks: new Set() })
      return this.projection(id, record)
    })
  }

  /** A data context, available without constructing a DSH Agent. */
  context(id) {
    return this.serial(async () => {
      const runtime = this.active.get(packId(id))
      if (!runtime || runtime.closing) fail('PACK_WORKSPACE_INACTIVE', 'Capability pack is not active.')
      const record = this.requireRecord(await this.state(), id)
      await directory(this.path(id))
      return this.projection(id, record)
    })
  }

  /** Track a complete operation, including background execution and final writes. */
  async run(id, operation) {
    let task
    await this.serial(async () => {
      const runtime = this.active.get(packId(id))
      if (!runtime || runtime.closing) fail('PACK_WORKSPACE_INACTIVE', 'Capability pack is not active.')
      const record = this.requireRecord(await this.state(), id)
      await directory(this.path(id))
      const context = this.projection(id, record)
      const controller = new AbortController()
      task = { controller, done: null }
      runtime.tasks.add(task)
      task.done = Promise.resolve().then(() => operation(context, controller.signal))
      // Observe failures immediately, even while the admission lock is pending.
      task.done.then(() => runtime.tasks.delete(task), () => runtime.tasks.delete(task))
    })
    return task.done
  }

  /** Keep ownership independently of blank-state projections or UI selection. */
  recordSession(id, sessionId) {
    return this.serial(async () => {
      const runtime = this.active.get(packId(id))
      if (!runtime || runtime.closing) fail('PACK_WORKSPACE_INACTIVE', 'Capability pack is not active.')
      if (typeof sessionId !== 'string' || !sessionId) fail('PACK_WORKSPACE_INVALID', 'Invalid internal session id.')
      const state = await this.state()
      const record = this.requireRecord(state, id)
      for (const [owner, item] of Object.entries(state.packs)) {
        if (owner !== id && item.sessionIds.includes(sessionId)) fail('PACK_WORKSPACE_COLLISION', 'Session belongs to another pack.')
      }
      if (!record.sessionIds.includes(sessionId)) {
        record.sessionIds.push(sessionId)
        await this.save(state)
      }
    })
  }

  onStop(id, callback) {
    const runtime = this.active.get(packId(id))
    if (!runtime || runtime.closing) fail('PACK_WORKSPACE_INACTIVE', 'Capability pack is not active.')
    runtime.stop = callback
  }

  /** Unload does not remove any durable data or registration. */
  async deactivate(id) {
    let runtime
    await this.serial(() => {
      runtime = this.active.get(packId(id))
      if (!runtime) return
      runtime.closing = true
      for (const task of runtime.tasks) task.controller.abort(new Error('Capability pack stopped.'))
    })
    if (!runtime) return
    const stopped = Promise.resolve().then(() => runtime.stop?.())
    let timer
    try {
      await Promise.race([
        Promise.all([stopped, Promise.allSettled([...runtime.tasks].map((task) => task.done))])
          // Admitted requests may enqueue background work while shutting down.
          // Drain once more after those requests have finished admitting work.
          .then(() => runtime.stop?.()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Tasks have not stopped; data operations remain blocked.'), { code: 'PACK_WORKSPACE_BUSY' })), this.stopTimeoutMs)
        }),
      ])
    } finally { clearTimeout(timer) }
    await this.serial(() => { if (this.active.get(id) === runtime) this.active.delete(id) })
  }

  requireStopped(id) {
    if (this.active.has(packId(id))) fail('PACK_WORKSPACE_BUSY', 'Unload the pack and wait for all tasks before maintenance.')
  }

  /** Recoverable data reset. Credentials/settings/session logs live elsewhere. */
  clearData(id) {
    return this.serial(async () => {
      this.requireStopped(id)
      const state = await this.state()
      const record = this.requireRecord(state, id)
      if (!record.reset) {
        await directory(this.path(id))
        record.reset = { id: randomUUID(), phase: 'prepared' }
        await this.save(state)
      }
      await this.recoverReset(state, id)
      return { ...this.projection(id, record), retainedDataPath: record.lastReset.backup }
    })
  }

  /** Delete the binding, retaining ownership history so old Sessions stay hidden. */
  unregister(id) {
    return this.serial(async () => {
      this.requireStopped(id)
      const state = await this.state()
      const record = this.requireRecord(state, id)
      await this.recoverReset(state, id)
      record.status = 'unregistering'
      await this.save(state)
      if (record.workspaceId) await this.registry.delete(record.workspaceId)
      record.status = 'unregistered'
      record.workspaceId = null
      await this.save(state)
      return this.projection(id, record)
    })
  }

  /** Host-owned facts for all ordinary conversation projections, including archives. */
  visibility() {
    return this.serial(async () => {
      const state = await this.state()
      return {
        workspaceIds: Object.values(state.packs).map((item) => item.workspaceId).filter(Boolean),
        workspacePaths: Object.keys(state.packs).map((id) => this.path(id)),
        sessionIds: [...new Set(Object.values(state.packs).flatMap((item) => item.sessionIds))],
      }
    })
  }
}

/** DSH CredentialRef accepts shell identifiers, not dot-separated paths. */
export function packCredentialRef(id, purpose) {
  packId(id)
  if (typeof purpose !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(purpose)) fail('PACK_WORKSPACE_INVALID', 'Invalid credential purpose.')
  // Length prefixes preserve the two-segment boundary (a-b/c vs a/b-c).
  return `LWB_PACK_${id.length}_${id.replaceAll('-', '_').toUpperCase()}_${purpose.length}_${purpose.replaceAll('-', '_').toUpperCase()}`
}
