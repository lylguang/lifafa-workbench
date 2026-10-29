/**
 * 档位 A 本地聚合数据源（P1 本地聚合 + P2 采集结果读取）。
 *
 * P1 没有任何平台采集，所以这里只回答「自媒体产了多少」和「流水线走到哪」。
 * 全部实时读取已有的 JSON（publisher 的 accounts/jobs、spoken-video 的
 * pipeline），**不落任何新文件**。P2 起由采集器往同一批返回体里填真指标。
 *
 * 降级约定（方案 §2.2）：publisher / spoken-video 不可用时，各区块**独立**
 * 返回 `{ items, available:false, reason }`，其余区块照常出数，绝不整页报错。
 */

import {
  bucketSeries,
  contentEngagementRate,
  currentFollowers,
  eachDayKey,
  engagementRate,
  followersNetGain,
  funnelFromPipeline,
  localDateKey,
  platformRows,
  publishSuccessRate,
  sortAndPage,
  countOrNull,
  sumMetrics,
  withinRange,
} from './analytics-metrics.mjs'

const REASON_PUBLISHER = '发布能力包未加载，平台账号与发布记录不可用。'
const REASON_SPOKEN_VIDEO = '口播视频能力包未加载，生产漏斗不可用。'
const MAX_RANGE_DAYS = 366

export class AnalyticsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AnalyticsError'
    this.code = code
  }
}

function fail(code, message) {
  throw new AnalyticsError(code, message)
}

/** 区间校验：两端必填 `from`/`to`，最长一年（防止 series 补点打爆 CPU）。 */
export function parseRange(request = {}) {
  const from = request?.from
  const to = request?.to
  if (!from || !to) fail('ANALYTICS_INVALID_INPUT', '时间范围必须同时提供 from 与 to。')
  const fromAt = new Date(from).getTime()
  const toAt = new Date(to).getTime()
  if (Number.isNaN(fromAt) || Number.isNaN(toAt)) fail('ANALYTICS_INVALID_INPUT', '时间范围不是有效时间。')
  if (fromAt > toAt) fail('ANALYTICS_INVALID_INPUT', '时间范围的起点不能晚于终点。')
  if ((toAt - fromAt) / 86_400_000 > MAX_RANGE_DAYS) fail('ANALYTICS_INVALID_INPUT', '时间范围最长支持一年。')
  return { from, to, fromAt, toAt }
}

function accountFilter(accountIds, platform) {
  const wanted = Array.isArray(accountIds) ? new Set(accountIds.filter((id) => typeof id === 'string')) : null
  return (job) => {
    if (wanted && wanted.size && !wanted.has(job.accountId)) return false
    if (platform && job.platform !== platform) return false
    return true
  }
}

/** 只有 succeeded 的任务才算「已发布作品」——发布中/已取消/待确认都不是。 */
const PUBLISHED = Object.freeze(['succeeded'])

export class AnalyticsLocalSource {
  /**
   * @param {{publisher: object|null, spokenVideo: object|null, store?: object|null}} sources
   *   注入解析器而非 ctx：让离线单测都能塞内存假数据，也让 host 决定何时接线。
   *   publisher 需实现 listAccounts() / listJobs()；spokenVideo 需实现 pipelineOverview()。
   *   store 是 P2 的采集结果存储；没有它时全部门槛递降，退回 P1 的「无采集源」形态。
   */
  constructor({ publisher = null, spokenVideo = null, store = null } = {}) {
    this.publisher = publisher
    this.spokenVideo = spokenVideo
    this.store = store
  }

  /** 最近一次采集时间：没有任何快照时 null。 */
  async #latestCollectedAt() {
    if (!this.store?.listAccountSnapshots) return null
    const months = await this.store.listAccountSnapshots(this.#recentMonths()).catch(() => [])
    const dates = (Array.isArray(months) ? months : [])
      .map((row) => row?.collectedAt)
      .filter((value) => typeof value === 'string' && value)
      .sort()
    return dates.length ? dates[dates.length - 1] : null
  }

  /** 最近三个自然月，够「趋势」与「近期是否采过」的判断。 */
  #recentMonths() {
    const out = []
    const cursor = new Date()
    for (let i = 0; i < 3; i += 1) {
      out.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
      cursor.setMonth(cursor.getMonth() - 1)
    }
    return out
  }

  /**
   * `stale` 的语义：有采集源时按「最近一次采集距今超过一天」判断；
   * 完全没有采集源时 true（P1 形态）。
   *
   * `stale` 只描述**数据新鲜度**，不表示「缺失的字段该填 0」——那是另一件事。
   */
  async #stale() {
    const latest = await this.#latestCollectedAt()
    if (!latest) return true
    const at = Date.parse(latest)
    if (Number.isNaN(at)) return true
    return Date.now() - at > 24 * 60 * 60 * 1000
  }

  #publisher() {
    if (!this.publisher) return null
    return this.publisher
  }

  async #accounts() {
    const publisher = this.#publisher()
    if (!publisher?.listAccounts) return { items: [], available: false, reason: REASON_PUBLISHER }
    try {
      const items = await publisher.listAccounts()
      return { items: Array.isArray(items) ? items : [], available: true, reason: null }
    } catch (error) {
      return { items: [], available: false, reason: `读取平台账号失败：${message(error)}` }
    }
  }

  async #jobs() {
    const publisher = this.#publisher()
    if (!publisher?.listJobs) return { items: [], available: false, reason: REASON_PUBLISHER }
    try {
      const items = await publisher.listJobs()
      return { items: Array.isArray(items) ? items : [], available: true, reason: null }
    } catch (error) {
      return { items: [], available: false, reason: `读取发布记录失败：${message(error)}` }
    }
  }

  async #pipeline() {
    if (!this.spokenVideo?.pipelineOverview) return { items: [], available: false, reason: REASON_SPOKEN_VIDEO }
    try {
      const overview = await this.spokenVideo.pipelineOverview()
      return { items: Array.isArray(overview?.items) ? overview.items : [], available: true, reason: null }
    } catch (error) {
      return { items: [], available: false, reason: `读取生产漏斗失败：${message(error)}` }
    }
  }

  /** 区间内已发布的作品记录（contentId 即 jobId，方案 §4.1）。 */
  #publishedInRange(jobs, range, request) {
    return jobs
      .filter((job) => PUBLISHED.includes(job.status))
      .filter(accountFilter(request?.accountIds, request?.platform))
      .filter((job) => {
        // 发布时间优先取提交时间（作品真正上线的那一刻），否则退回创建时间。
        const at = job.proof?.submittedAt || job.createdAt
        return withinRange(at, range.from, range.to)
      })
  }

  /**
   * 内容行：P1 无采集源时全部指标为 null、bound 为 false（绑定是 P2 才有）。
   *
   * 保留完整字段是为了让前端从 P1 起就按最终行型渲染，P2 只填值、不改结构。
   */
  #contentRow(job, stored = null) {
    // 有采集记录时以它为准（绑定关系、最新指标、来源、时间戳都在 store 里）。
    const metrics = stored?.metrics || { views: null, likes: null, comments: null, shares: null, favorites: null, followersGained: null, completionRate: null }
    return {
      contentId: job.id,
      projectId: job.projectId,
      title: job.projectTitle || null,
      platform: job.platform,
      accountId: job.accountId,
      publishedAt: job.proof?.submittedAt || job.createdAt || null,
      remoteUrl: stored?.remoteUrl || job.proof?.remoteUrl || null,
      metrics,
      engagementRate: contentEngagementRate(metrics),
      source: stored?.source ?? null,
      collectedAt: stored?.collectedAt ?? null,
      bound: Boolean(stored?.remoteId || stored?.remoteUrl),
    }
  }

  /** 已采集的作品记录（按 jobId 对齐）。没 store 或没采过时返回空表。 */
  async #storedContents() {
    if (!this.store?.listContents) return new Map()
    const rows = await this.store.listContents().catch(() => [])
    return new Map((Array.isArray(rows) ? rows : []).map((row) => [row.contentId, row]))
  }

  /**
   * 把 store 里按日的作品指标点位按日期聚合成 {date → {views,likes,comments}}。
   * 只聚合**有值**的点位；某天没有任何点位就是缺口（前端画缺口，不画 0）。
   */
  async #dailyContentMetrics(range) {
    if (!this.store?.listContentMetrics) return new Map()
    const months = []
    const cursor = new Date(range.from)
    while (cursor <= new Date(range.to)) {
      months.push(cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0'))
      cursor.setMonth(cursor.getMonth() + 1)
    }
    months.push(new Date(range.to).getFullYear() + '-' + String(new Date(range.to).getMonth() + 1).padStart(2, '0'))
    const points = await this.store.listContentMetrics([...new Set(months)]).catch(() => [])
    const byDate = new Map()
    for (const point of points || []) {
      if (!point?.date) continue
      const bucket = byDate.get(point.date) ?? { views: 0, likes: 0, comments: 0 }
      bucket.views += countOrNull(point.metrics?.views) ?? 0
      bucket.likes += countOrNull(point.metrics?.likes) ?? 0
      bucket.comments += countOrNull(point.metrics?.comments) ?? 0
      byDate.set(point.date, bucket)
    }
    return byDate
  }

  async #funnel() {
    const pipeline = await this.#pipeline()
    return { rows: funnelFromPipeline(pipeline.items), available: pipeline.available, reason: pipeline.reason }
  }

  /**
   * 概览（方案 §4.2-1）。
   *
   * `stale:true` 表示内容级指标全部缺源——P1 这是常态，前端据此显示「待采集」，
   * 而不是把「缺失」全画成 0。
   */
  async summary(request = {}) {
    const range = parseRange(request)
    const generatedAt = new Date().toISOString()
    const [accounts, jobs] = await Promise.all([this.#accounts(), this.#jobs()])
    const stored = await this.#storedContents()
    const publishedJobs = this.#publishedInRange(jobs.items, range, request)
    const rows = publishedJobs.map((job) => this.#contentRow(job, stored.get(job.id)))

    // 平台分布：P1 无采集源，各平台播放/互动均为 null（不是 0）。
    const platforms = {}
    for (const row of rows) {
      if (!platforms[row.platform]) platforms[row.platform] = { views: null, likes: null, comments: null, followers: null }
    }

    const funnel = await this.#funnel()
    // 发布量 = 区间内的全部发布尝试（对应 §4.2「发布成功率 = succeeded / total」）。
    // 失败的任务也是一次发布行为，所以 count 与 successRate 的分母同源。
    // 注意 contents 只列真正成功的作品——那些才拿得到作品链接。
    const attempts = jobs.items
      .filter(accountFilter(request?.accountIds, request?.platform))
      .filter((job) => withinRange(job.createdAt, range.from, range.to))

    // 内容级指标聚合（P2 采集上线后这里有真数据）：
    // rows 已按发布区间过滤，且 #contentRow 会把 store 里的最新指标合进来。
    // 旧实现在这里把 kpis 写死为 null——那是采集未上线时代的占位，
    // 采集上线后忘了跟进，导致看板「总播放」永远是「—」。
    const contentSums = sumMetrics(rows)
    const dailyContent = await this.#dailyContentMetrics(range)

    return {
      range: { from: range.from, to: range.to },
      generatedAt,
      stale: await this.#stale(),
      kpis: {
        views: contentSums.views,
        likes: contentSums.likes,
        comments: contentSums.comments,
        shares: contentSums.shares,
        favorites: contentSums.favorites,
        engagementRate: engagementRate(rows),
        followers: { current: null, netGain: null, baselineDate: null },
        // published.count 是**发布尝试数**（区间内 createdAt 落在此的全部任务，含失败、
        // 取消与在途），不是「发布成功数」——命名容易被读成后者，故意在此写死语义。
        // 成功数请用 analyticsContents 的条数；count 与 successRate 同源，不要自行推算。
        // successRate 的分母只算已出终态的（succeeded/failed/cancelled），
        // 在途的 queued/running/awaiting-confirm 不参与，免得把比率压成一个假象。
        published: { count: attempts.length, successRate: publishSuccessRate(attempts) },
      },
      // 契约 §4.2-1 的 series 是逐日的宽表行。published 一直有真数据；
      // views/likes/comments 在采集上线后按「当天有采集点才有值」补进宽表，
      // 保留「缺口 = 当天没采」的语义（前端画缺口，不画 0）。
      series: summarySeries(attempts, range, dailyContent),
      platforms: platformRows(contentPlatformTotals(rows)),
      funnel: funnel.rows,
      available: {
        publisher: accounts.available || jobs.available,
        reason: accounts.available || jobs.available ? null : accounts.reason || jobs.reason,
        funnel: funnel.available,
        funnelReason: funnel.reason,
      },
    }
  }

  /** 账号列表（方案 §4.2-2）。P1 无快照，档位恒为 never，等级恒为 null。 */
  async accounts(request = {}) {
    const range = parseRange(request)
    const generatedAt = new Date().toISOString()
    const [accounts, jobs] = await Promise.all([this.#accounts(), this.#jobs()])
    const inRange = (job) => withinRange(job.createdAt, range.from, range.to)
    const accountJobs = jobs.items.filter(inRange)

    const items = accounts.items.map((account) => {
      const own = accountJobs.filter((job) => job.accountId === account.id)
      const published = own.filter((job) => PUBLISHED.includes(job.status))
      // P1 从未采集 → 快照缺失，状态恒为 never，等级恒为 null。
      return {
        accountId: account.id,
        platform: account.platform,
        nickname: account.nickname || null,
        label: account.label || null,
        contentAccountId: account.contentAccountId || null,
        followers: null,
        baselineDate: null,
        followersNetGain: null,
        publishedCount: published.length,
        engagementRate: engagementRate(published.map((job) => this.#contentRow(job))),
        lastCollectedAt: null,
        collectionStatus: 'never',
        lastError: account.lastError || null,
      }
    })

    return {
      items,
      total: items.length,
      generatedAt,
      stale: await this.#stale(),
      available: accounts.available,
      reason: accounts.reason,
    }
  }

  /** 内容明细（方案 §4.2-3）。P1 全部 bound:false（即「待绑定」列表）。 */
  async contents(request = {}) {
    const range = parseRange(request)
    const generatedAt = new Date().toISOString()
    const jobs = await this.#jobs()
    const stored = await this.#storedContents()
    const publishedJobs = this.#publishedInRange(jobs.items, range, {
      accountIds: request?.accountId ? [request.accountId] : request?.accountIds,
      platform: request?.platform,
    })
    const rows = publishedJobs
      .map((job) => this.#contentRow(job, stored.get(job.id)))
      .filter((row) => (request?.bound === undefined ? true : row.bound === request.bound))
    const page = sortAndPage(rows, request)
    return { ...page, generatedAt, stale: await this.#stale(), available: jobs.available, reason: jobs.reason }
  }

  /**
   * 指标序列（方案 §4.2-4）。
   *
   * P1 只有 published 有真数据，且是**全量补点**：区间内每天一个点，
   * 没发布的日期 value=0——0 在这里是**真值**（那天确实没发），不是缺失。
   * 其余四个指标无源 → 空 points + stale:true，前端补点不画 0。
   */
  async series(request = {}) {
    const range = parseRange(request)
    const metric = request?.metric
    if (!metric) fail('ANALYTICS_INVALID_INPUT', '缺少 metric。')
    const groupBy = request?.groupBy === 'week' ? 'week' : 'day'
    const jobs = await this.#jobs()
    const publishedJobs = this.#publishedInRange(jobs.items, range, request)

    if (metric === 'published') {
      return {
        metric,
        groupBy,
        points: publishedDaily(publishedJobs, range, groupBy),
        generatedAt: new Date().toISOString(),
        stale: false,
        available: jobs.available,
        reason: jobs.reason,
      }
    }
    return {
      metric,
      groupBy,
      points: [],
      generatedAt: new Date().toISOString(),
      stale: true,
      available: jobs.available,
      reason: jobs.reason,
    }
  }

  /**
   * 账号等级派生（P1 恒为 null，为 P2 预留同一条口径路径）。
   *
   * 独立成方法是为了让 §4.3-2 的差值口径有唯一实现，不在两处各算一遍。
   */
  static followersFromSnapshots(snapshots) {
    return { ...currentFollowers(snapshots), ...followersNetGain(snapshots) }
  }
}

/**
 * 概览的趋势区：逐日宽表行（契约 §4.2-1 的 `series`）。
 *
 * P1 没有快照，所以只有 `published` 是可求和的计数（按天**全量输出**）；
 * 没发布的日期 0 是**真值**；
 * views/likes/comments/followersNetGain 两头都是 null——
 * 前端按「缺口 → 断线渲染」，绝不画成 0。RPC 4 的单指标序列同义。
 */
function summarySeries(jobs, range, dailyContent = new Map()) {
  const counts = new Map(publishedDaily(jobs, range).map((point) => [point.date, point.value]))
  return eachDayKey(range.from, range.to).map((date) => ({
    date,
    views: dailyContent.get(date)?.views ?? null,
    likes: dailyContent.get(date)?.likes ?? null,
    comments: dailyContent.get(date)?.comments ?? null,
    followersNetGain: null,
    published: counts.get(date) ?? 0,
  }))
}

/** 按平台聚合内容指标，供 platformRows 使用（旧实现传的是全 null 的空壳）。 */
function contentPlatformTotals(rows) {
  const totals = {}
  for (const row of rows || []) {
    const platform = row?.platform
    if (!platform) continue
    const bucket = totals[platform] ??= { views: null, likes: null, comments: null, followers: null }
    for (const key of ['views', 'likes', 'comments']) {
      const value = countOrNull(row?.metrics?.[key])
      if (value !== null) bucket[key] = (bucket[key] ?? 0) + value
    }
  }
  return totals
}

/**
 * 发布量按天（全量补点，缺失日 0）。
 * groupBy:'week' 时同样全量补 ISO 周，缺失周 0。
 */
function publishedDaily(jobs, range, groupBy = 'day') {
  const counted = bucketSeries(
    jobs.map((job) => ({ at: job.proof?.submittedAt || job.createdAt, value: 1 })),
    { groupBy },
  )
  const found = new Map(counted.map((point) => [point.date, point.value]))
  const keys = groupBy === 'week' ? weekKeys(range) : eachDayKey(range.from, range.to)
  return keys.map((date) => ({ date, value: found.get(date) ?? 0 }))
}

/** 区间覆盖的每个 ISO 周的周一日期键。 */
function weekKeys(range) {
  const seen = new Set()
  for (const key of eachDayKey(range.from, range.to)) {
    const week = new Date(`${key}T00:00:00`)
    const offset = (week.getDay() + 6) % 7
    week.setDate(week.getDate() - offset)
    seen.add(localDateKey(week))
  }
  return [...seen].sort()
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

export default AnalyticsLocalSource
