import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LwbPackWorkspaces, packCredentialRef } from '../pack-workspaces.mjs'

const manifest = (id = 'spoken-video') => ({ id, packageName: `@example/${id}`, name: id })
const code = (expected) => (error) => error.code === expected
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function setup(t, options = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'lwb-pack-workspaces-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'pack-state')
  const entities = new Map()
  let counter = 0
  const registry = {
    async create(path) {
      const existing = [...entities.values()].find((row) => row.path === path)
      if (existing) return existing
      const row = { id: `workspace-${++counter}`, path }
      entities.set(row.id, row)
      return row
    },
    async delete(id) { return entities.delete(id) },
  }
  const make = () => new LwbPackWorkspaces({ root, workspaceRegistry: registry, ...options })
  return { temporary, root, registry, entities, manager: make(), make }
}

test('activates without a conversation and reuses one workspace across modules, versions and host restarts', async (t) => {
  const { manager, make, entities } = await setup(t)
  const contexts = await Promise.all(Array.from({ length: 10 }, () => manager.activate(manifest())))
  assert.equal(entities.size, 1)
  assert.ok(contexts.every((item) => item.workspaceId === contexts[0].workspaceId))
  assert.deepEqual(await manager.context('spoken-video'), contexts[0])
  const data = join(contexts[0].workspacePath, 'account.json')
  await writeFile(data, '{"account":"kept"}')
  await manager.deactivate('spoken-video')
  await assert.rejects(manager.context('spoken-video'), code('PACK_WORKSPACE_INACTIVE'))
  const restarted = make()
  assert.deepEqual(await restarted.activate({ ...manifest(), version: '2.0.0' }), contexts[0])
  assert.equal(await readFile(data, 'utf8'), '{"account":"kept"}')
})

test('different packs have disjoint directories and session ownership; manifests cannot supply a path', async (t) => {
  const { manager, temporary } = await setup(t)
  const first = await manager.activate({ ...manifest(), workspacePath: temporary })
  const second = await manager.activate(manifest('second-pack'))
  assert.notEqual(first.workspacePath, second.workspacePath)
  assert.notEqual(first.workspaceId, second.workspaceId)
  assert.notEqual(first.workspacePath, temporary)
  await manager.recordSession('spoken-video', 'internal-root')
  await assert.rejects(manager.recordSession('second-pack', 'internal-root'), code('PACK_WORKSPACE_COLLISION'))
  await assert.rejects(manager.activate({ ...manifest(), packageName: '@other/impersonator' }), code('PACK_WORKSPACE_COLLISION'))
})

test('unload aborts only its own operations and waits for final writes', async (t) => {
  const { manager } = await setup(t)
  const first = await manager.activate(manifest())
  await manager.activate(manifest('second-pack'))
  const admitted = deferred()
  const aborted = deferred()
  const release = deferred()
  const secondRelease = deferred()
  let otherAborted = false
  const otherTask = manager.run('second-pack', async (_, signal) => {
    signal.addEventListener('abort', () => { otherAborted = true })
    await secondRelease.promise
  })
  const task = manager.run('spoken-video', async (context, signal) => {
    signal.addEventListener('abort', aborted.resolve, { once: true })
    admitted.resolve()
    await release.promise
    await writeFile(join(context.workspacePath, 'final.txt'), 'settled')
  })
  await admitted.promise
  let stopped = false
  const unload = manager.deactivate('spoken-video').then(() => { stopped = true })
  await aborted.promise
  assert.equal(stopped, false)
  await assert.rejects(manager.run('spoken-video', () => {}), code('PACK_WORKSPACE_INACTIVE'))
  await assert.rejects(manager.clearData('spoken-video'), code('PACK_WORKSPACE_BUSY'))
  assert.equal(otherAborted, false)
  release.resolve()
  await Promise.all([task, unload])
  assert.equal(await readFile(join(first.workspacePath, 'final.txt'), 'utf8'), 'settled')
  secondRelease.resolve()
  await otherTask
  await manager.deactivate('second-pack')
})

test('uncooperative tasks block destructive operations after stop timeout', async (t) => {
  const { manager } = await setup(t, { stopTimeoutMs: 15 })
  await manager.activate(manifest())
  const admitted = deferred()
  const release = deferred()
  const run = manager.run('spoken-video', async () => { admitted.resolve(); await release.promise })
  await admitted.promise
  await assert.rejects(manager.deactivate('spoken-video'), code('PACK_WORKSPACE_BUSY'))
  await assert.rejects(manager.clearData('spoken-video'), code('PACK_WORKSPACE_BUSY'))
  await assert.rejects(manager.unregister('spoken-video'), code('PACK_WORKSPACE_BUSY'))
  await assert.rejects(manager.activate(manifest()), code('PACK_WORKSPACE_BUSY'))
  release.resolve()
  await run
  await manager.deactivate('spoken-video')
  await manager.clearData('spoken-video')
})

test('a rejected task releases its admission lease without blocking unload', async (t) => {
  const { manager } = await setup(t)
  await manager.activate(manifest())
  await assert.rejects(manager.run('spoken-video', () => { throw new Error('generation failed') }), /generation failed/u)
  await manager.deactivate('spoken-video')
  await manager.clearData('spoken-video')
})

test('clearData preserves registration and internal-session visibility; reset is recoverable and pack-local', async (t) => {
  const { manager, entities } = await setup(t)
  const first = await manager.activate(manifest())
  const second = await manager.activate(manifest('second-pack'))
  await writeFile(join(first.workspacePath, 'video.mp4'), 'first artifact')
  await writeFile(join(second.workspacePath, 'video.mp4'), 'other artifact')
  await manager.recordSession('spoken-video', 'root-1')
  await manager.recordSession('spoken-video', 'root-1')
  await manager.deactivate('spoken-video')
  const result = await manager.clearData('spoken-video')
  assert.equal(result.workspaceId, first.workspaceId)
  assert.equal(result.generation, 1)
  assert.equal(entities.size, 2)
  assert.deepEqual(await readdir(first.workspacePath), [])
  assert.equal(await readFile(join(result.retainedDataPath, 'video.mp4'), 'utf8'), 'first artifact')
  assert.equal(await readFile(join(second.workspacePath, 'video.mp4'), 'utf8'), 'other artifact')
  assert.deepEqual((await manager.visibility()).sessionIds, ['root-1'])
})

test('unregister retains files and ownership history, and reload re-registers the same directory', async (t) => {
  const { manager, make, entities } = await setup(t)
  const first = await manager.activate(manifest())
  await writeFile(join(first.workspacePath, 'data.json'), 'retained')
  await manager.recordSession('spoken-video', 'old-root')
  await assert.rejects(manager.unregister('spoken-video'), code('PACK_WORKSPACE_BUSY'))
  await manager.deactivate('spoken-video')
  const result = await manager.unregister('spoken-video')
  assert.equal(result.status, 'unregistered')
  assert.equal(result.workspaceId, null)
  assert.equal(entities.size, 0)
  assert.equal(await readFile(join(first.workspacePath, 'data.json'), 'utf8'), 'retained')
  const restarted = make()
  const hidden = await restarted.visibility()
  assert.deepEqual(hidden.sessionIds, ['old-root'])
  assert.deepEqual(hidden.workspacePaths, [first.workspacePath])
  const next = await restarted.activate(manifest())
  assert.equal(next.workspacePath, first.workspacePath)
  assert.notEqual(next.workspaceId, first.workspaceId)
})

test('registration failure is retryable and an interrupted unregister finishes before reactivation', async (t) => {
  const { manager, registry, entities, make } = await setup(t)
  const create = registry.create
  registry.create = async () => { throw new Error('registry unavailable') }
  await assert.rejects(manager.activate(manifest()), /registry unavailable/u)
  registry.create = create
  const first = await manager.activate(manifest())
  await manager.deactivate('spoken-video')
  const remove = registry.delete
  registry.delete = async () => { throw new Error('delete interrupted') }
  await assert.rejects(manager.unregister('spoken-video'), /delete interrupted/u)
  registry.delete = remove
  const restored = await make().activate(manifest())
  assert.equal(entities.size, 1)
  assert.notEqual(restored.workspaceId, first.workspaceId)
})

for (const phase of ['prepared-before-move', 'prepared-after-move', 'moved']) {
  test(`recovers reset journal ${phase} without restoring old business data`, async (t) => {
    const { manager, root, make } = await setup(t)
    const context = await manager.activate(manifest())
    await writeFile(join(context.workspacePath, 'old.json'), 'old data')
    await manager.deactivate('spoken-video')
    const journal = join(root, 'ownership.json')
    const state = JSON.parse(await readFile(journal, 'utf8'))
    const id = '01234567-89ab-cdef-0123-456789abcdef'
    state.packs['spoken-video'].reset = { id, phase: phase === 'moved' ? 'moved' : 'prepared' }
    await writeFile(journal, JSON.stringify(state))
    if (phase !== 'prepared-before-move') {
      await rename(context.workspacePath, join(root, 'retained', `spoken-video-${id}`))
    }
    if (phase === 'moved') await mkdir(context.workspacePath)
    const restored = await make().activate(manifest())
    assert.equal(restored.generation, 1)
    assert.deepEqual(await readdir(context.workspacePath), [])
    assert.equal(await readFile(join(root, 'retained', `spoken-video-${id}`, 'old.json'), 'utf8'), 'old data')
  })
}

test('rejects symlinked workspace instead of reading or clearing an ordinary directory', async (t) => {
  const { manager, temporary } = await setup(t)
  const context = await manager.activate(manifest())
  await manager.deactivate('spoken-video')
  const outside = join(temporary, 'ordinary-workspace')
  await mkdir(outside)
  await writeFile(join(outside, 'precious.txt'), 'keep')
  await rm(context.workspacePath, { recursive: true })
  await symlink(outside, context.workspacePath, 'dir')
  await assert.rejects(manager.activate(manifest()), code('PACK_WORKSPACE_UNSAFE'))
  await assert.rejects(manager.clearData('spoken-video'), code('PACK_WORKSPACE_UNSAFE'))
  assert.equal(await readFile(join(outside, 'precious.txt'), 'utf8'), 'keep')
})

test('rejects corrupt index, path traversal and unowned nonempty directories', async (t) => {
  const { manager, root } = await setup(t)
  await assert.rejects(manager.activate(manifest('../ordinary')), code('PACK_WORKSPACE_INVALID'))
  await manager.visibility()
  const unowned = join(root, 'workspaces', 'spoken-video')
  await mkdir(unowned)
  await writeFile(join(unowned, 'existing.txt'), 'do not adopt')
  await assert.rejects(manager.activate(manifest()), code('PACK_WORKSPACE_UNOWNED'))
  await writeFile(join(root, 'ownership.json'), '{"schemaVersion":99,"packs":{}}')
  await assert.rejects(manager.visibility(), code('PACK_WORKSPACE_CORRUPT'))
  assert.equal(await readFile(join(unowned, 'existing.txt'), 'utf8'), 'do not adopt')
})

test('credential references obey DSH syntax and cannot collide across pack/purpose boundaries', () => {
  const first = packCredentialRef('spoken-video', 'bailian')
  assert.match(first, /^[A-Za-z_][A-Za-z0-9_]*$/u)
  assert.notEqual(first, packCredentialRef('second-pack', 'bailian'))
  assert.notEqual(packCredentialRef('ab-cd', 'ef'), packCredentialRef('ab', 'cd-ef'))
  assert.throws(() => packCredentialRef('spoken-video', '../secret'), code('PACK_WORKSPACE_INVALID'))
})

// A launcher invoked through `file:///f:/...` derives a lower-case drive letter,
// while `realpath` always upper-cases it. That case-only difference used to fail
// the canonical-root check, which left the pack sidebar empty with the message
// "The profile-owned root must be canonical." — a safe root must still be accepted.
test('accepts a root spelled with a differently-cased drive letter', async (t) => {
  const { manager, root } = await setup(t)
  const flipped = root.replace(/^[A-Za-z]:/u, (drive) => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase())
  const relocated = new LwbPackWorkspaces({ root: flipped })
  await relocated.state()
  const context = await relocated.activate(manifest())
  assert.equal(context.packId, 'spoken-video')
  assert.equal(await readFile(join(root, 'ownership.json'), 'utf8').then(() => true), true)
})

// The loosened comparison must not weaken the symlink guarantee.
test('still rejects a root that resolves somewhere else', async (t) => {
  const { temporary } = await setup(t)
  const real = join(temporary, 'canonical-root')
  await mkdir(real)
  const link = join(temporary, 'link-root')
  await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  const relocated = new LwbPackWorkspaces({ root: link })
  await assert.rejects(relocated.state(), code('PACK_WORKSPACE_UNSAFE'))
})
