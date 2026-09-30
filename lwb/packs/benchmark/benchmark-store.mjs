import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FILES_SCHEMA_VERSION = 1
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
export const PLATFORMS = Object.freeze(['douyin', 'bilibili', 'xhs', 'wechat', 'kuaishou', 'toutiao', 'other'])
const PLATFORM_LABELS = Object.freeze({ douyin: '抖音', bilibili: 'B站', xhs: '小红书', wechat: '视频号', kuaishou: '快手', toutiao: '今日头条', other: '其他' })
const TEARDOWN_STATUSES = Object.freeze(['analyzing', 'completed', 'failed'])
const MAX_ACCOUNTS = 200
const MAX_TEARDOWNS = 2000
const MAX_SUGGESTION_BATCHES = 30

export function platformLabel(kind) {
  return PLATFORM_LABELS[kind] || String(kind || '')
}

export class BenchmarkStoreError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  return new BenchmarkStoreError(code, message)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('BENCHMARK_INVALID_INPUT', `${label} 必须是对象。`)
  return value
}

function text(value, label, maxLength) {
  if (typeof value !== 'string') throw fail('BENCHMARK_INVALID_INPUT', `${label} 必须是文本。`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw fail('BENCHMARK_INVALID_INPUT', `${label} 长度必须在 1-${maxLength} 之间。`)
  return normalized
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  return text(value, label, maxLength)
}

function optionalUrl(value, label) {
  const normalized = optionalText(value, label, 1000)
  if (normalized === undefined) return undefined
  if (!/^https?:\/\/\S+$/iu.test(normalized)) throw fail('BENCHMARK_INVALID_INPUT', `${label} 必须是 http(s) 链接。`)
  return normalized
}

function stringList(value, label, maxItems, maxLength) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('BENCHMARK_INVALID_INPUT', `${label} 必须是列表。`)
  const values = value.map((item) => text(item, `${label}项`, maxLength))
  if (values.length > maxItems) throw fail('BENCHMARK_INVALID_INPUT', `${label} 最多 ${maxItems} 项。`)
  return [...new Set(values)]
}

function oneOf(value, label, options) {
  const normalized = text(value, label, 40)
  if (!options.includes(normalized)) throw fail('BENCHMARK_INVALID_INPUT', `${label} 不受支持。`)
  return normalized
}

function optionalCount(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw fail('BENCHMARK_INVALID_INPUT', `${label} 必须是非负整数。`)
  return parsed
}

export function parseAccountInput(input) {
  const source = object(input, '账号信息')
  return {
    platform: oneOf(source.platform, '平台', PLATFORMS),
    name: text(source.name, '账号名称', 80),
    url: optionalUrl(source.url, '主页链接'),
    note: optionalText(source.note, '备注', 600),
    tags: stringList(source.tags, '标签', 8, 24),
  }
}

export function parseTeardownInput(input) {
  const source = object(input, '爆款内容')
  const accountId = optionalText(source.accountId, '关联账号', 36)
  if (accountId !== undefined && !UUID.test(accountId)) throw fail('BENCHMARK_INVALID_INPUT', '关联账号标识无效。')
  const statsSource = source.stats === undefined || source.stats === null ? {} : object(source.stats, '数据指标')
  const stats = {
    views: optionalCount(statsSource.views, '播放/阅读'),
    likes: optionalCount(statsSource.likes, '点赞'),
    comments: optionalCount(statsSource.comments, '评论'),
    favorites: optionalCount(statsSource.favorites, '收藏'),
  }
  return {
    accountId: accountId === undefined ? null : accountId,
    platform: source.platform === undefined || source.platform === null || source.platform === '' ? undefined : oneOf(source.platform, '平台', PLATFORMS),
    title: text(source.title, '标题', 200),
    url: optionalUrl(source.url, '内容链接'),
    content: text(source.content, '文案原文', 20000),
    ...(Object.values(stats).some((item) => item !== undefined) ? { stats } : {}),
    tags: stringList(source.tags, '标签', 8, 24),
  }
}

/** Validate the AI teardown output before it enters the library; unknown fields are dropped. */
export function normalizeTeardownAnalysis(value) {
  const source = object(value, '拆解结果')
  const segment = (item, label) => {
    const entry = object(item, label)
    return { segment: text(entry.segment, `${label}.segment`, 120), purpose: text(entry.purpose, `${label}.purpose`, 240) }
  }
  const structure = Array.isArray(source.structure) ? source.structure.slice(0, 20).map((item, index) => segment(item, `structure[${index}]`)) : []
  const score = Number(source.viralityScore)
  return {
    summary: text(source.summary, 'summary', 500),
    hookType: text(source.hookType, 'hookType', 80),
    hookQuote: optionalText(source.hookQuote, 'hookQuote', 300) || '',
    structure,
    pacing: optionalText(source.pacing, 'pacing', 600) || '',
    titleFormulas: stringList(source.titleFormulas, 'titleFormulas', 8, 120),
    commentInsight: optionalText(source.commentInsight, 'commentInsight', 1200) || '',
    reusable: stringList(source.reusable, 'reusable', 10, 200),
    viralityScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
  }
}

export function parseSuggestion(value, label) {
  const entry = object(value, label)
  return {
    title: text(entry.title, `${label}.title`, 200),
    angle: text(entry.angle, `${label}.angle`, 600),
    rationale: text(entry.rationale, `${label}.rationale`, 1200),
    basedOn: stringList(entry.basedOn, `${label}.basedOn`, 12, 200),
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    // Windows：rename 的目标只要被任意句柄打开就会 EPERM（界面轮询会撞上写入窗口）；
    // 退避重试吸收，真故障仍抛出。失败时清掉临时文件，不在数据目录留下整份副本。
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

async function readJson(path, fallback) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw fail('BENCHMARK_STORAGE_UNREADABLE', `读取 ${path} 失败：${error?.message || error}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw fail('BENCHMARK_STORAGE_CORRUPT', `文件 ${path} 不是有效 JSON。`)
  }
}

export class BenchmarkStore {
  constructor({ workspacePath }) {
    if (typeof workspacePath !== 'string' || !workspacePath) throw fail('BENCHMARK_INVALID_WORKSPACE', '缺少包专属工作区路径。')
    this.#root = join(workspacePath, 'data')
  }

  #root
  #accountsFile = () => join(this.#root, 'accounts.json')
  #teardownsFile = () => join(this.#root, 'teardowns.json')
  #insightsFile = () => join(this.#root, 'insights.json')

  async #readAccounts() {
    const data = await readJson(this.#accountsFile(), { schemaVersion: FILES_SCHEMA_VERSION, accounts: [] })
    return Array.isArray(data.accounts) ? data.accounts : []
  }

  async #writeAccounts(accounts) {
    await writeJson(this.#accountsFile(), { schemaVersion: FILES_SCHEMA_VERSION, accounts })
  }

  async #readTeardowns() {
    const data = await readJson(this.#teardownsFile(), { schemaVersion: FILES_SCHEMA_VERSION, teardowns: [] })
    return Array.isArray(data.teardowns) ? data.teardowns : []
  }

  async #writeTeardowns(teardowns) {
    await writeJson(this.#teardownsFile(), { schemaVersion: FILES_SCHEMA_VERSION, teardowns })
  }

  async #readInsights() {
    const data = await readJson(this.#insightsFile(), { schemaVersion: FILES_SCHEMA_VERSION, batches: [] })
    return Array.isArray(data.batches) ? data.batches : []
  }

  async #writeInsights(batches) {
    await writeJson(this.#insightsFile(), { schemaVersion: FILES_SCHEMA_VERSION, batches })
  }

  async listAccounts() {
    const accounts = await this.#readAccounts()
    return [...accounts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  async createAccount(input) {
    const parsed = parseAccountInput(input)
    const accounts = await this.#readAccounts()
    if (accounts.length >= MAX_ACCOUNTS) throw fail('BENCHMARK_LIMIT_REACHED', `对标账号最多保留 ${MAX_ACCOUNTS} 个。`)
    const now = new Date().toISOString()
    const account = { id: randomUUID(), ...parsed, createdAt: now, updatedAt: now }
    await this.#writeAccounts([account, ...accounts])
    return account
  }

  async updateAccount(request) {
    const source = object(request, '更新请求')
    const id = text(source.id, '账号标识', 36)
    if (!UUID.test(id)) throw fail('BENCHMARK_INVALID_INPUT', '账号标识无效。')
    const patch = parseAccountInput(source)
    const accounts = await this.#readAccounts()
    const index = accounts.findIndex((item) => item.id === id)
    if (index < 0) throw fail('BENCHMARK_NOT_FOUND', '对标账号不存在。')
    const updated = { ...accounts[index], ...patch, updatedAt: new Date().toISOString() }
    accounts[index] = updated
    await this.#writeAccounts(accounts)
    return updated
  }

  async deleteAccount(id) {
    const normalized = text(id, '账号标识', 36)
    if (!UUID.test(normalized)) throw fail('BENCHMARK_INVALID_INPUT', '账号标识无效。')
    const accounts = await this.#readAccounts()
    const next = accounts.filter((item) => item.id !== normalized)
    if (next.length === accounts.length) throw fail('BENCHMARK_NOT_FOUND', '对标账号不存在。')
    await this.#writeAccounts(next)
    // 拆解记录保留 accountId 归属，账号删除后前端按“已删除账号”展示，不改写历史。
    return { ok: true }
  }

  async listTeardowns() {
    const teardowns = await this.#readTeardowns()
    return [...teardowns].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  async getTeardown(id) {
    const normalized = text(id, '拆解标识', 36)
    const teardowns = await this.#readTeardowns()
    const found = teardowns.find((item) => item.id === normalized)
    if (!found) throw fail('BENCHMARK_NOT_FOUND', '拆解记录不存在。')
    return found
  }

  async createTeardown(input) {
    const parsed = parseTeardownInput(input)
    const teardowns = await this.#readTeardowns()
    if (teardowns.length >= MAX_TEARDOWNS) throw fail('BENCHMARK_LIMIT_REACHED', `拆解记录最多保留 ${MAX_TEARDOWNS} 条。`)
    const record = {
      id: randomUUID(),
      ...parsed,
      platform: parsed.platform || 'other',
      status: 'analyzing',
      analysis: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    }
    await this.#writeTeardowns([record, ...teardowns])
    return record
  }

  async completeTeardown(id, analysis) {
    const normalized = normalizeTeardownAnalysis(analysis)
    const teardowns = await this.#readTeardowns()
    const index = teardowns.findIndex((item) => item.id === id)
    if (index < 0) throw fail('BENCHMARK_NOT_FOUND', '拆解记录不存在。')
    teardowns[index] = { ...teardowns[index], status: 'completed', analysis: normalized, error: null, completedAt: new Date().toISOString() }
    await this.#writeTeardowns(teardowns)
    return teardowns[index]
  }

  async failTeardown(id, message) {
    const teardowns = await this.#readTeardowns()
    const index = teardowns.findIndex((item) => item.id === id)
    if (index < 0) return null
    teardowns[index] = { ...teardowns[index], status: 'failed', error: String(message || '拆解失败。').slice(0, 600), completedAt: new Date().toISOString() }
    await this.#writeTeardowns(teardowns)
    return teardowns[index]
  }

  async deleteTeardown(id) {
    const normalized = text(id, '拆解标识', 36)
    if (!UUID.test(normalized)) throw fail('BENCHMARK_INVALID_INPUT', '拆解标识无效。')
    const teardowns = await this.#readTeardowns()
    const next = teardowns.filter((item) => item.id !== normalized)
    if (next.length === teardowns.length) throw fail('BENCHMARK_NOT_FOUND', '拆解记录不存在。')
    await this.#writeTeardowns(next)
    return { ok: true }
  }

  /** 服务重启会让内存中的执行器丢失；把仍处于 analyzing 的记录标记为失败，避免永久转圈。 */
  async markStaleAnalysesFailed() {
    const teardowns = await this.#readTeardowns()
    let changed = false
    const next = teardowns.map((item) => {
      if (item.status !== 'analyzing') return item
      changed = true
      return { ...item, status: 'failed', error: '服务重启导致拆解中断，请重新发起。', completedAt: new Date().toISOString() }
    })
    if (changed) await this.#writeTeardowns(next)
    return changed
  }

  async saveSuggestionsBatch(batch) {
    const batches = await this.#readInsights()
    const next = [batch, ...batches].slice(0, MAX_SUGGESTION_BATCHES)
    await this.#writeInsights(next)
    return batch
  }

  async updateSuggestionsBatch(batchId, patch) {
    const batches = await this.#readInsights()
    const index = batches.findIndex((item) => item.id === batchId)
    if (index < 0) throw fail('BENCHMARK_NOT_FOUND', '选题批次不存在。')
    batches[index] = { ...batches[index], ...patch }
    await this.#writeInsights(batches)
    return batches[index]
  }

  async listSuggestionBatches() {
    const batches = await this.#readInsights()
    return [...batches].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }
}
