/**
 * 采集结果的持久化（P2）。
 *
 * 文件布局按定稿 §4.3-5：
 *  - `accounts-snapshots-YYYY-MM.json` —— 账号日快照，时间序列按月分片
 *  - `content-metrics-YYYY-MM.json`   —— 作品指标日采集点，按月分片
 *  - `contents.json`                  —— 作品元数据 + 最新值 + 绑定（小文件，不放历史）
 *
 * 为什么历史必须分片而不是塞进 contents.json：内容级历史按每天一个点涨，
 * 几千个作品一年就是百万级行，单个 JSON 读一次就要把全部历史载入内存，
 * 而概览页只想看最近 7 天。
 *
 * 初版不自动清理、不设保留期（§4.3-5），裁剪策略等真实数据量出来再定。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { durationSecondsOrNull, finiteOrNull, localDateKey, percentOrNull } from './analytics-metrics.mjs'

/**
 * Windows：rename 的目标只要被任意句柄打开就会 EPERM，而工作台会轮询读取这些
 * 文件。退避重试吸收偶发冲突，真故障仍然抛出。与 publisher/spoken-video 同款。
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt += 1) {
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
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) throw new Error(`采集数据文件不是有效 JSON：${path}`)
    throw error
  }
}

/** `YYYY-MM`，用于按月分片。 */
function monthKey(dateKey) {
  return String(dateKey).slice(0, 7)
}

export class AnalyticsStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AnalyticsStoreError'
    this.code = code
  }
}

function fail(code, message) {
  throw new AnalyticsStoreError(code, message)
}

/** 账号快照允许的字段；平台专属字段（如抖音的总获赞）原样保留。 */
function snapshotRecord(value) {
  const input = value && typeof value === 'object' ? value : {}
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
  const date = localDateKey(input.date)
  if (!accountId) fail('ANALYTICS_INVALID_INPUT', '账号快照缺少 accountId。')
  if (!date) fail('ANALYTICS_INVALID_INPUT', '账号快照缺少有效日期。')
  return {
    accountId,
    date,
    platform: typeof input.platform === 'string' ? input.platform : null,
    followers: countOrNull(input.followers),
    profileVisits: countOrNull(input.profileVisits),
    totalLikes: countOrNull(input.totalLikes),
    collectedAt: typeof input.collectedAt === 'string' ? input.collectedAt : null,
    source: input.source === 'api' || input.source === 'manual' ? input.source : 'collector',
  }
}

function countOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function contentMetricsRecord(value) {
  const input = value && typeof value === 'object' ? value : {}
  const metrics = input.metrics && typeof input.metrics === 'object' ? input.metrics : {}
  return {
    views: countOrNull(metrics.views),
    likes: countOrNull(metrics.likes),
    comments: countOrNull(metrics.comments),
    shares: countOrNull(metrics.shares),
    favorites: countOrNull(metrics.favorites),
    followersGained: countOrNull(metrics.followersGained),
    completionRate: percentOrNull(metrics.completionRate),
    // 诊断列（抖音导出文件自带）。percent 统一 0–100，时长统一秒。
    fiveSecondRate: percentOrNull(metrics.fiveSecondRate),
    coverClickRate: percentOrNull(metrics.coverClickRate),
    twoSecondBounceRate: percentOrNull(metrics.twoSecondBounceRate),
    avgPlaySeconds: durationSecondsOrNull(metrics.avgPlaySeconds),
  }
}

function contentRecord(value) {
  const input = value && typeof value === 'object' ? value : {}
  const contentId = typeof input.contentId === 'string' ? input.contentId.trim() : ''
  if (!contentId) fail('ANALYTICS_INVALID_INPUT', '作品记录缺少 contentId。')
  return {
    contentId,
    projectId: typeof input.projectId === 'string' ? input.projectId : null,
    title: typeof input.title === 'string' ? input.title : null,
    platform: typeof input.platform === 'string' ? input.platform : null,
    accountId: typeof input.accountId === 'string' ? input.accountId : null,
    publishedAt: typeof input.publishedAt === 'string' ? input.publishedAt : null,
    remoteId: typeof input.remoteId === 'string' && input.remoteId ? input.remoteId : null,
    remoteUrl: typeof input.remoteUrl === 'string' && input.remoteUrl ? input.remoteUrl : null,
    // bound 由 remoteId/remoteUrl 推导，不接受外部随意置 true —— 否则「绑定了」
    // 只是一个能随手填的标记，采集器会拿着一张空地址去平台页面空转。
    bound: Boolean(input.remoteId || input.remoteUrl),
    metrics: contentMetricsRecord(input),
    collectedAt: typeof input.collectedAt === 'string' ? input.collectedAt : null,
    source: input.source === 'api' || input.source === 'manual' ? input.source : 'collector',
  }
}

/** 手动补录覆盖采集原值时的取值：manual 无条件优先（定稿 §4.2-8）。 */
function latestMetrics(history) {
  const rows = [...(history || [])]
  const manual = rows.filter((row) => row.source === 'manual')
  if (manual.length) {
    return manual.sort((left, right) => String(right.collectedAt).localeCompare(String(left.collectedAt)))[0]
  }
  if (!rows.length) return null
  return rows.sort((left, right) => String(right.collectedAt).localeCompare(String(left.collectedAt)))[0]
}

export class AnalyticsStore {
  constructor({ dataRoot } = {}) {
    if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('AnalyticsStore requires the pack data root.')
    this.dataRoot = dataRoot
    /** 分片文件的写串行化：概览页会并发读多个月份。 */
    this.writes = new Map()
  }

  get contentsFile() { return join(this.dataRoot, 'contents.json') }
  snapshotFile(month) { return join(this.dataRoot, `accounts-snapshots-${month}.json`) }
  metricsFile(month) { return join(this.dataRoot, `content-metrics-${month}.json`) }

  /** 同 publisher 的 serial：按文件键串行写，避免并发写互相覆盖。 */
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

  /**
   * 写账号日快照。**同日同账号只保留最后一次成功快照**（定稿 §4.3-4）：
   * 手动采集覆盖当日定时值，不追加第二条，否则净增粉的差值会被同一天的
   * 两次采样搅乱。
   */
  async saveAccountSnapshot(input) {
    const record = snapshotRecord(input)
    const month = monthKey(record.date)
    const file = this.snapshotFile(month)
    return this.serial(file, async () => {
      const current = await readJson(file, { schemaVersion: 1, snapshots: [] })
      const rows = Array.isArray(current.snapshots) ? current.snapshots : []
      const kept = rows.filter((row) => !(row.accountId === record.accountId && row.date === record.date))
      kept.push(record)
      kept.sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.accountId).localeCompare(String(right.accountId)))
      await writeJson(file, { schemaVersion: 1, snapshots: kept })
      return record
    })
  }

  /** 读取某月（或给定月份列表）的账号快照。 */
  async listAccountSnapshots(months) {
    const keys = (Array.isArray(months) && months.length ? months : [monthKey(localDateKey(new Date()))])
      .filter((month) => typeof month === 'string' && /^\d{4}-\d{2}$/u.test(month))
    const rows = []
    for (const month of keys) {
      const shard = await readJson(this.snapshotFile(month), { snapshots: [] })
      if (Array.isArray(shard.snapshots)) rows.push(...shard.snapshots)
    }
    return rows
  }

  /**
   * 写作品指标采集点。
   *
   * 与账号快照不同，这里**保留全部采集点**（趋势图要看曲线）。但 manual
   * 记录同样按 (contentId, source=manual) 去重为一条最新的，避免用户反复
   * 补录把历史撑爆。
   */
  async saveContentMetrics(input) {
    const record = contentMetricsRecord(input)
    const contentId = typeof input?.contentId === 'string' ? input.contentId.trim() : ''
    const date = localDateKey(input?.date ?? input?.collectedAt)
    if (!contentId) fail('ANALYTICS_INVALID_INPUT', '作品指标缺少 contentId。')
    if (!date) fail('ANALYTICS_INVALID_INPUT', '作品指标缺少有效日期。')
    const point = {
      contentId,
      date,
      metrics: record,
      source: input.source === 'api' || input.source === 'manual' ? input.source : 'collector',
      collectedAt: typeof input.collectedAt === 'string' ? input.collectedAt : new Date().toISOString(),
    }
    const month = monthKey(date)
    const file = this.metricsFile(month)
    return this.serial(file, async () => {
      const current = await readJson(file, { schemaVersion: 1, points: [] })
      const rows = Array.isArray(current.points) ? current.points : []
      // 同日同来源覆盖；不同来源并存（manual 才能压过 collector）。
      const kept = rows.filter((row) => !(row.contentId === contentId && row.date === date && row.source === point.source))
      kept.push(point)
      kept.sort((left, right) => String(left.date).localeCompare(String(right.date)))
      await writeJson(file, { schemaVersion: 1, points: kept })
      return point
    })
  }

  async listContentMetrics(months) {
    const keys = (Array.isArray(months) && months.length ? months : [monthKey(localDateKey(new Date()))])
      .filter((month) => typeof month === 'string' && /^\d{4}-\d{2}$/u.test(month))
    const rows = []
    for (const month of keys) {
      const shard = await readJson(this.metricsFile(month), { points: [] })
      if (Array.isArray(shard.points)) rows.push(...shard.points)
    }
    return rows
  }

  /** 作品元数据 + 绑定 + 最新值（小文件，全部常驻内存）。 */
  async saveContents(records) {
    const list = (Array.isArray(records) ? records : [records]).map(contentRecord)
    const file = this.contentsFile
    return this.serial(file, async () => {
      const current = await readJson(file, { schemaVersion: 1, contents: [] })
      const byId = new Map((Array.isArray(current.contents) ? current.contents : []).map((row) => [row.contentId, row]))
      for (const record of list) {
        const previous = byId.get(record.contentId)
        // 绑定关系只增不减：一次误清不该抹掉已经确认过的 remoteId/remoteUrl。
        byId.set(record.contentId, {
          ...previous,
          ...record,
          remoteId: record.remoteId ?? previous?.remoteId ?? null,
          remoteUrl: record.remoteUrl ?? previous?.remoteUrl ?? null,
          bound: Boolean(record.remoteId || record.remoteUrl || previous?.remoteId || previous?.remoteUrl),
        })
      }
      const contents = [...byId.values()].sort((left, right) => left.contentId.localeCompare(right.contentId))
      await writeJson(file, { schemaVersion: 1, contents })
      return contents
    })
  }

  async listContents() {
    const current = await readJson(this.contentsFile, { contents: [] })
    return Array.isArray(current.contents) ? current.contents : []
  }

  async getContent(contentId) {
    const contents = await this.listContents()
    return contents.find((row) => row.contentId === contentId) || null
  }

  /** 手动补录：作为 source=manual 的叠加记录写入，不覆盖采集原值（§4.2-8）。 */
  async recordManualMetrics(contentId, metrics, { note, collectedAt } = {}) {
    const content = await this.getContent(contentId)
    if (!content) fail('ANALYTICS_CONTENT_NOT_FOUND', '作品不存在。')
    const at = typeof collectedAt === 'string' && collectedAt ? collectedAt : new Date().toISOString()
    await this.saveContentMetrics({ contentId, date: at, collectedAt: at, metrics, source: 'manual' })
    await this.saveContents([{ ...content, metrics, source: 'manual', collectedAt: at }])
    return this.contentDetail(contentId)
  }

  /** 作品明细行：最新值按 manual > collector 取（§4.2-8）。 */
  async contentDetail(contentId) {
    const content = await this.getContent(contentId)
    if (!content) return null
    const months = await this.#monthsWithData()
    const history = (await this.listContentMetrics(months)).filter((row) => row.contentId === contentId)
    const latest = latestMetrics(history)
    return {
      ...content,
      metrics: latest ? latest.metrics : content.metrics,
      source: latest ? latest.source : content.source,
      collectedAt: latest ? latest.collectedAt : content.collectedAt,
      bound: Boolean(content.remoteId || content.remoteUrl),
    }
  }

  async contentHistory(contentId, { from, to } = {}) {
    const months = await this.#monthsWithData()
    const rows = (await this.listContentMetrics(months))
      .filter((row) => row.contentId === contentId)
      .filter((row) => {
        const at = Date.parse(row.collectedAt || row.date)
        if (Number.isNaN(at)) return false
        if (from && !Number.isNaN(Date.parse(from)) && at < Date.parse(from)) return false
        if (to && !Number.isNaN(Date.parse(to)) && at > Date.parse(to)) return false
        return true
      })
      .sort((left, right) => String(left.collectedAt).localeCompare(String(right.collectedAt)))
    return rows
  }

  /** 采集 run 记录：只留最近若干次（定稿 §4.1 的 collectionRuns 需要它）。 */
  async saveRun(run) {
    const file = join(this.dataRoot, 'runs.json')
    return this.serial(file, async () => {
      const current = await readJson(file, { schemaVersion: 1, runs: [] })
      const rows = Array.isArray(current.runs) ? current.runs : []
      const byId = new Map(rows.map((row) => [row.runId, row]))
      byId.set(run.runId, run)
      const runs = [...byId.values()]
        .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
        .slice(0, 50)
      await writeJson(file, { schemaVersion: 1, runs })
      return run
    })
  }

  async listRuns(limit = 20) {
    const current = await readJson(join(this.dataRoot, 'runs.json'), { runs: [] })
    const rows = Array.isArray(current.runs) ? current.runs : []
    return rows.slice(0, Math.max(0, Math.min(100, Number.isFinite(limit) ? Math.trunc(limit) : 20)))
  }

  /** 哪些月份有采集数据：按文件名分片列出，避免盲扫整个目录。 */
  async #monthsWithData() {
    const { readdir } = await import('node:fs/promises')
    let names = []
    try { names = await readdir(this.dataRoot) } catch { return [] }
    const months = new Set()
    for (const name of names) {
      const match = /^content-metrics-(\d{4}-\d{2})\.json$/u.exec(name)
      if (match) months.add(match[1])
    }
    return [...months].sort()
  }
}

export default AnalyticsStore
