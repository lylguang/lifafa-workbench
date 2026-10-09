import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ACCOUNTS_SCHEMA_VERSION = 1
const JOBS_SCHEMA_VERSION = 1
const SETTINGS_SCHEMA_VERSION = 1
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
const MAX_ACCOUNTS = 40
const MAX_JOBS = 400

/**
 * Supported platforms. Only the ones with a working adapter can actually
 * publish; the rest are listed so the account can be registered and its login
 * state tracked before an adapter exists.
 */
export const PLATFORMS = Object.freeze(['douyin', 'wechat', 'xhs', 'bilibili', 'kuaishou'])
export const PLATFORM_LABELS = Object.freeze({
  douyin: '抖音',
  wechat: '视频号',
  xhs: '小红书',
  bilibili: 'B站',
  kuaishou: '快手',
})
/** Platforms whose publish flow is implemented by an adapter in this pack. */
export const ADAPTER_PLATFORMS = Object.freeze(['douyin', 'bilibili', 'kuaishou'])

export const ACCOUNT_STATES = Object.freeze(['active', 'expired'])
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'awaiting-confirm', 'succeeded', 'failed', 'cancelled'])
export const SUBMIT_MODES = Object.freeze(['confirm', 'auto'])

export function platformLabel(kind) {
  return PLATFORM_LABELS[kind] || String(kind || '')
}

export class PublisherStoreError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  throw new PublisherStoreError(code, message)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('PUBLISHER_INVALID_INPUT', `${label}必须是对象。`)
  return value
}

function text(value, label, maxLength) {
  if (typeof value !== 'string') fail('PUBLISHER_INVALID_INPUT', `${label}必须是文本。`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) fail('PUBLISHER_INVALID_INPUT', `${label}长度必须在 1-${maxLength} 之间。`)
  return normalized
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  return text(value, label, maxLength)
}

function oneOf(value, label, options) {
  const normalized = text(value, label, 40)
  if (!options.includes(normalized)) fail('PUBLISHER_INVALID_INPUT', `${label}不受支持。`)
  return normalized
}

function identifier(value, label) {
  const normalized = text(value, label, 36).toLowerCase()
  if (!UUID.test(normalized)) fail('PUBLISHER_INVALID_INPUT', `${label}无效。`)
  return normalized
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('PUBLISHER_INVALID_INPUT', `${label}必须是正整数。`)
  return value
}

/**
 * Windows：rename 的目标只要被任意句柄打开就会 EPERM，而工作台会轮询读取这些
 * 文件，写入窗口容易撞上。退避重试吸收偶发冲突，真故障仍然抛出。
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break }
      catch (error) {
        if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= 6) throw error
        await new Promise((resolve) => setTimeout(resolve, [50, 120, 280, 600, 1200, 2400, 4000][attempt]))
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function readJson(path, fallback, label) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    fail('PUBLISHER_STORAGE_UNREADABLE', `读取${label}失败：${error?.message || error}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    fail('PUBLISHER_STORAGE_CORRUPT', `${label}不是有效 JSON。`)
  }
}

function accountRecord(value, profileDirOf) {
  const input = object(value, '账号记录')
  const stored = optionalText(input.profileDir, '登录态目录', 200)
  return {
    id: identifier(input.id, '账号标识'),
    platform: oneOf(input.platform, '平台', PLATFORMS),
    label: text(input.label, '账号备注名', 80),
    nickname: optionalText(input.nickname, '平台昵称', 120) || null,
    handle: optionalText(input.handle, '平台账号号', 120) || null,
    status: ACCOUNT_STATES.includes(input.status) ? input.status : 'expired',
    profileDir: stored || profileDirOf(identifier(input.id, '账号标识')),
    contentAccountId: input.contentAccountId === undefined || input.contentAccountId === null
      ? null
      : identifier(input.contentAccountId, '关联定位账号'),
    lastCheckedAt: optionalText(input.lastCheckedAt, '最近检测时间', 64) || null,
    lastLoginAt: optionalText(input.lastLoginAt, '最近登录时间', 64) || null,
    lastError: optionalText(input.lastError, '最近错误', 600) || null,
    createdAt: text(input.createdAt, '创建时间', 64),
    updatedAt: text(input.updatedAt, '更新时间', 64),
  }
}

/** 失败原因上限 1000 字；超长截断并标注，绝不因日志过长而丢弃整条任务记录。 */
function clippedError(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  return text.length <= 1000 ? text : `${text.slice(0, 1000)}…（已截断，原文 ${text.length} 字）`
}

function jobRecord(value) {
  const input = object(value, '发布任务')
  const proofInput = input.proof === undefined || input.proof === null ? {} : object(input.proof, '发布证据')
  const screenshots = Array.isArray(proofInput.screenshots) ? proofInput.screenshots.filter((item) => typeof item === 'string').slice(0, 24) : []
  return {
    id: identifier(input.id, '任务标识'),
    accountId: identifier(input.accountId, '账号标识'),
    platform: oneOf(input.platform, '平台', PLATFORMS),
    accountLabel: optionalText(input.accountLabel, '账号备注名', 80) || null,
    projectId: identifier(input.projectId, '项目标识'),
    projectTitle: optionalText(input.projectTitle, '项目标题', 200) || null,
    projectRevision: revision(input.projectRevision, '项目版本'),
    media: input.media === undefined || input.media === null ? null : object(input.media, '成片快照'),
    content: input.content === undefined || input.content === null ? null : object(input.content, '发布内容'),
    submitMode: SUBMIT_MODES.includes(input.submitMode) ? input.submitMode : 'confirm',
    status: JOB_STATUSES.includes(input.status) ? input.status : 'failed',
    phase: optionalText(input.phase, '发布阶段', 40) || null,
    // 截断而非丢弃：Playwright 的点击超时日志动辄两千多字（2026-10-08 实测 2019），
    // 超限时 optionalText 会抛错、让整条记录在 #readJobs 里被 try/catch 静默丢掉——
    // 于是 getJob 报「发布任务不存在」，真因（按钮点不到）彻底消失。
    error: clippedError(input.error),
    proof: {
      screenshots,
      diagnostics: Array.isArray(proofInput.diagnostics) ? proofInput.diagnostics.filter((item) => typeof item === 'string').slice(0, 24) : [],
      remoteUrl: optionalText(proofInput.remoteUrl, '作品链接', 600) || null,
      submittedAt: optionalText(proofInput.submittedAt, '提交时间', 64) || null,
    },
    trigger: ['manual', 'schedule'].includes(input.trigger) ? input.trigger : 'manual',
    createdAt: text(input.createdAt, '创建时间', 64),
    updatedAt: text(input.updatedAt, '更新时间', 64),
    completedAt: optionalText(input.completedAt, '完成时间', 64) || null,
  }
}

function settingsRecord(value) {
  const input = object(value, '发布设置')
  return {
    submitMode: SUBMIT_MODES.includes(input.submitMode) ? input.submitMode : 'confirm',
    headless: input.headless === true,
    keepWindowOpenMs: Number.isSafeInteger(input.keepWindowOpenMs) && input.keepWindowOpenMs >= 0
      ? Math.min(input.keepWindowOpenMs, 10 * 60 * 1000)
      : 0,
  }
}

/** Default login-state directory for an account, relative to the pack data root. */
export function defaultProfileDir(id) {
  return join('chrome-profiles', id)
}

/**
 * Pack-owned persistence: platform accounts, publish jobs and publish policy.
 * Login state itself never lands in JSON — it lives in each account's Chrome
 * profile directory, which keeps platform cookies with the browser's own
 * encryption instead of copying them into a plain file.
 */
export class PublisherStore {
  constructor({ workspacePath, now = () => new Date().toISOString() } = {}) {
    if (typeof workspacePath !== 'string' || !workspacePath) throw new Error('PublisherStore requires a workspace path.')
    this.workspacePath = workspacePath
    this.dataRoot = join(workspacePath, 'data')
    this.now = now
    this.writes = new Map()
  }

  get accountsFile() { return join(this.dataRoot, 'accounts.json') }
  get jobsFile() { return join(this.dataRoot, 'jobs.json') }
  get settingsFile() { return join(this.dataRoot, 'settings.json') }
  root(...segments) { return join(this.dataRoot, ...segments) }

  /** Per-file write serialization; the UI polls while jobs write. */
  async serial(key, operation) {
    const previous = this.writes.get(key) || Promise.resolve()
    const result = previous.then(operation)
    const tail = result.catch(() => {})
    this.writes.set(key, tail)
    try {
      return await result
    } finally {
      if (this.writes.get(key) === tail) this.writes.delete(key)
    }
  }

  /* -------------------------------- accounts ------------------------------- */

  async #readAccounts() {
    const raw = await readJson(this.accountsFile, { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts: [] }, '账号库')
    const list = Array.isArray(raw?.accounts) ? raw.accounts : []
    const accounts = []
    for (const item of list) {
      try { accounts.push(accountRecord(item, defaultProfileDir)) } catch { /* a broken row must not hide the rest */ }
    }
    return accounts
  }

  async listAccounts() {
    return this.#readAccounts()
  }

  async getAccount(id) {
    const target = identifier(id, '账号标识')
    const accounts = await this.#readAccounts()
    const account = accounts.find((item) => item.id === target)
    if (!account) fail('PUBLISHER_NOT_FOUND', '平台账号不存在。')
    return account
  }

  async createAccount(input) {
    const source = object(input, '账号信息')
    const platform = oneOf(source.platform, '平台', PLATFORMS)
    const label = text(source.label, '账号备注名', 80)
    const contentAccountId = optionalText(source.contentAccountId, '关联定位账号', 36)
    if (contentAccountId !== undefined && !UUID.test(contentAccountId)) fail('PUBLISHER_INVALID_INPUT', '关联定位账号标识无效。')
    return this.serial('accounts', async () => {
      const accounts = await this.#readAccounts()
      if (accounts.length >= MAX_ACCOUNTS) fail('PUBLISHER_LIMIT_REACHED', `平台账号最多 ${MAX_ACCOUNTS} 个。`)
      const now = this.now()
      const id = randomUUID()
      const account = {
        id, platform, label,
        nickname: null, handle: null, status: 'expired',
        profileDir: defaultProfileDir(id),
        contentAccountId: contentAccountId === undefined ? null : contentAccountId.toLowerCase(),
        lastCheckedAt: null, lastLoginAt: null, lastError: null,
        createdAt: now, updatedAt: now,
      }
      await writeJson(this.accountsFile, { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts: [...accounts, account] })
      return account
    })
  }

  async updateAccount(id, input) {
    const target = identifier(id, '账号标识')
    const source = object(input, '账号信息')
    const patch = {}
    if (source.label !== undefined) patch.label = text(source.label, '账号备注名', 80)
    if (source.contentAccountId !== undefined) {
      const value = optionalText(source.contentAccountId, '关联定位账号', 36)
      if (value !== undefined && !UUID.test(value)) fail('PUBLISHER_INVALID_INPUT', '关联定位账号标识无效。')
      patch.contentAccountId = value === undefined ? null : value.toLowerCase()
    }
    return this.serial('accounts', async () => {
      const accounts = await this.#readAccounts()
      const index = accounts.findIndex((item) => item.id === target)
      if (index === -1) fail('PUBLISHER_NOT_FOUND', '平台账号不存在。')
      accounts[index] = { ...accounts[index], ...patch, updatedAt: this.now() }
      await writeJson(this.accountsFile, { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts })
      return accounts[index]
    })
  }

  /** Runtime state written by the browser layer after a login check. */
  async patchAccountState(id, patch) {
    const target = identifier(id, '账号标识')
    return this.serial('accounts', async () => {
      const accounts = await this.#readAccounts()
      const index = accounts.findIndex((item) => item.id === target)
      if (index === -1) fail('PUBLISHER_NOT_FOUND', '平台账号不存在。')
      const next = { ...accounts[index] }
      if (patch.status !== undefined) {
        if (!ACCOUNT_STATES.includes(patch.status)) fail('PUBLISHER_INVALID_INPUT', '账号状态无效。')
        next.status = patch.status
      }
      if (patch.nickname !== undefined) next.nickname = patch.nickname === null ? null : text(patch.nickname, '平台昵称', 120)
      if (patch.handle !== undefined) next.handle = patch.handle === null ? null : text(patch.handle, '平台账号号', 120)
      if (patch.lastError !== undefined) next.lastError = patch.lastError === null ? null : text(patch.lastError, '最近错误', 600)
      if (patch.lastCheckedAt !== undefined) next.lastCheckedAt = patch.lastCheckedAt
      if (patch.lastLoginAt !== undefined) next.lastLoginAt = patch.lastLoginAt
      next.updatedAt = this.now()
      accounts[index] = next
      await writeJson(this.accountsFile, { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts })
      return next
    })
  }

  async deleteAccount(id) {
    const target = identifier(id, '账号标识')
    return this.serial('accounts', async () => {
      const accounts = await this.#readAccounts()
      const account = accounts.find((item) => item.id === target)
      if (!account) fail('PUBLISHER_NOT_FOUND', '平台账号不存在。')
      const running = (await this.#readJobs()).some((job) => job.accountId === target && ['queued', 'running', 'awaiting-confirm'].includes(job.status))
      if (running) fail('PUBLISHER_ACCOUNT_BUSY', '该账号还有未完成的发布任务，请先取消或等待完成。')
      await writeJson(this.accountsFile, { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts: accounts.filter((item) => item.id !== target) })
      return { id: target, profileDir: account.profileDir }
    })
  }

  /* ---------------------------------- jobs --------------------------------- */

  async #readJobs() {
    const raw = await readJson(this.jobsFile, { schemaVersion: JOBS_SCHEMA_VERSION, jobs: [] }, '发布任务')
    const list = Array.isArray(raw?.jobs) ? raw.jobs : []
    const jobs = []
    for (const item of list.slice(0, MAX_JOBS)) {
      try { jobs.push(jobRecord(item)) } catch { /* same reasoning as accounts */ }
    }
    return jobs
  }

  async listJobs() {
    return this.#readJobs()
  }

  async getJob(id) {
    const target = identifier(id, '任务标识')
    const jobs = await this.#readJobs()
    const job = jobs.find((item) => item.id === target)
    if (!job) fail('PUBLISHER_NOT_FOUND', '发布任务不存在。')
    return job
  }

  async createJob(input) {
    const source = object(input, '发布任务')
    const now = this.now()
    const job = {
      id: randomUUID(),
      accountId: identifier(source.accountId, '账号标识'),
      platform: oneOf(source.platform, '平台', PLATFORMS),
      accountLabel: optionalText(source.accountLabel, '账号备注名', 80) || null,
      projectId: identifier(source.projectId, '项目标识'),
      projectTitle: optionalText(source.projectTitle, '项目标题', 200) || null,
      projectRevision: revision(source.projectRevision, '项目版本'),
      media: source.media === undefined || source.media === null ? null : object(source.media, '成片快照'),
      content: source.content === undefined || source.content === null ? null : object(source.content, '发布内容'),
      submitMode: SUBMIT_MODES.includes(source.submitMode) ? source.submitMode : 'confirm',
      status: 'queued',
      phase: null,
      error: null,
      proof: { screenshots: [], diagnostics: [], remoteUrl: null, submittedAt: null },
      trigger: source.trigger === 'schedule' ? 'schedule' : 'manual',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    return this.serial('jobs', async () => {
      const jobs = await this.#readJobs()
      const duplicate = jobs.find((item) => item.projectId === job.projectId && item.accountId === job.accountId
        && ['queued', 'running', 'awaiting-confirm'].includes(item.status))
      if (duplicate) fail('PUBLISHER_JOB_DUPLICATE', '该项目在此账号下已有未完成的发布任务。')
      await writeJson(this.jobsFile, { schemaVersion: JOBS_SCHEMA_VERSION, jobs: [job, ...jobs].slice(0, MAX_JOBS) })
      return job
    })
  }

  async mutateJob(id, operation) {
    const target = identifier(id, '任务标识')
    return this.serial('jobs', async () => {
      const jobs = await this.#readJobs()
      const index = jobs.findIndex((item) => item.id === target)
      if (index === -1) fail('PUBLISHER_NOT_FOUND', '发布任务不存在。')
      const next = structuredClone(jobs[index])
      const result = await operation(next)
      next.updatedAt = this.now()
      jobs[index] = next
      await writeJson(this.jobsFile, { schemaVersion: JOBS_SCHEMA_VERSION, jobs })
      return result === undefined ? next : result
    })
  }

  /* -------------------------------- settings ------------------------------- */

  async settings() {
    const raw = await readJson(this.settingsFile, null, '发布设置')
    return settingsRecord(raw === null ? {} : raw)
  }

  async updateSettings(input) {
    const patch = object(input, '发布设置')
    return this.serial('settings', async () => {
      const current = await this.settings()
      const next = settingsRecord({ ...current, ...patch })
      await writeJson(this.settingsFile, { schemaVersion: SETTINGS_SCHEMA_VERSION, ...next })
      return next
    })
  }

  /* -------------------------------- evidence ------------------------------- */

  /** Write one evidence screenshot; returns the pack-relative path. */
  async saveEvidence(jobId, name, bytes) {
    const target = identifier(jobId, '任务标识')
    const safeName = text(name, '证据文件名', 120).replace(/[^A-Za-z0-9._-]/gu, '-')
    const relative = join('evidence', target, safeName)
    const absolute = this.root(relative)
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    await writeFile(absolute, bytes, { mode: 0o600 })
    return relative
  }

  async readEvidence(relative) {
    const value = text(relative, '证据路径', 400)
    const absolute = this.root(value)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) fail('PUBLISHER_NOT_FOUND', '证据文件不存在。')
    return { path: absolute, bytes: info.size, data: await readFile(absolute) }
  }

  /** Remove an account's Chrome profile after the account row is gone. */
  async removeProfile(profileDir) {
    if (typeof profileDir !== 'string' || !profileDir.startsWith('chrome-profiles')) return false
    const { rm } = await import('node:fs/promises')
    await rm(this.root(profileDir), { recursive: true, force: true }).catch(() => {})
    return true
  }
}
