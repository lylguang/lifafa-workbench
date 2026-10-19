/**
 * 数据看板的纯口径函数。
 *
 * 这些函数只依赖入参，不碰 RPC、文件系统或浏览器，因此可以在
 * `test/analytics.test.mjs` 里离线单测——看板最容易出的错是把「未知」
 * 画成 0，所有涉及缺失的判断都收在这里，前端只负责渲染。
 */

/** 已知数值的非负整数；0 是合法值，null/undefined/NaN 一律返回 null（缺失不是 0）。 */
export function metricNumber(value) {
  if (value === null || value === undefined) return null
  // 空串、空白串必须先挡掉：Number('') === 0，会把「没有数据」变成「真的是 0」。
  if (typeof value === 'string' && !value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/** 展示用计数：缺失时给「—」，永远不要把未知渲染成 0。 */
export function displayCount(value) {
  const parsed = metricNumber(value)
  if (parsed === null) return '—'
  if (parsed >= 100000000) return `${(parsed / 100000000).toFixed(2)} 亿`
  if (parsed >= 10000) return `${(parsed / 10000).toFixed(1)} 万`
  return String(parsed)
}

/**
 * 互动率 =（赞+评+转+藏）/ views，口径见定稿 §4.2-1：
 * 只统计「已绑定且 views 非 null」的内容；单字段 null 按 0，
 * views 为 0 或整集合无有效播放时结果为 null，不填 0。
 */
export function engagementRate(contents) {
  const list = Array.isArray(contents) ? contents : []
  let views = 0
  let interactions = 0
  let counted = 0
  for (const item of list) {
    if (!item || item.bound === false) continue
    const metrics = item.metrics || {}
    const viewCount = metricNumber(metrics.views)
    if (viewCount === null) continue
    counted += 1
    views += viewCount
    interactions += ['likes', 'comments', 'shares', 'favorites'].reduce((sum, key) => sum + (metricNumber(metrics[key]) || 0), 0)
  }
  if (!counted || views <= 0) return null
  return interactions / views
}

/** 百分比展示：null 一律显示「—」，不显示 0.00%。 */
export function displayRate(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return `${(Number(value) * 100).toFixed(2)}%`
}

/**
 * 涨粉 = 区间末次快照 − 首次快照（定稿 §4.2-2）。
 * 只有一条快照时算不出净增，返回 null 并交由 UI 标「基线不完整」。
 */
export function followersNetGain(snapshots) {
  const list = (Array.isArray(snapshots) ? snapshots : [])
    .filter((item) => item && metricNumber(item.followers) !== null)
    .sort((a, b) => String(a.baselineDate || a.collectedAt || '').localeCompare(String(b.baselineDate || b.collectedAt || '')))
  if (list.length < 2) return null
  const first = metricNumber(list[0].followers)
  const last = metricNumber(list[list.length - 1].followers)
  if (first === null || last === null) return null
  return last - first
}

/** 账号采集状态：定稿 §4.2-2 的 ok|stale|expired|failed|never。 */
export const COLLECTION_STATUS = Object.freeze(['ok', 'stale', 'expired', 'failed', 'never'])

export function collectionStatusLabel(status) {
  const map = {
    ok: ['已采集', 'green'],
    stale: ['数据较旧', 'orange'],
    expired: ['登录已过期', 'red'],
    failed: ['采集失败', 'red'],
    never: ['尚未采集', 'muted'],
  }
  const [label, tone] = map[status] || ['未知', 'muted']
  return { label, tone }
}

/** 平台 id → 中文名。未知平台原样返回，不吞掉。 */
const PLATFORM_LABEL = Object.freeze({
  douyin: '抖音', bilibili: 'B站', xhs: '小红书', wechat: '视频号',
  kuaishou: '快手', toutiao: '今日头条', other: '其他',
})

export function platformLabel(platform) {
  if (!platform) return '—'
  return PLATFORM_LABEL[platform] || String(platform)
}

/**
 * 平台分布横条：按 views 降序。缺失播放的内容不计入，也不回填 0。
 * 定稿 §4.2-3 要求跨平台求和时标注覆盖度，所以这里同时返回已统计平台数。
 */
export function platformBreakdown(platforms) {
  const list = (Array.isArray(platforms) ? platforms : [])
    .map((item) => ({ platform: item?.platform || null, views: metricNumber(item?.views) }))
    .filter((item) => item.platform && item.views !== null)
    .sort((a, b) => b.views - a.views)
  const total = list.reduce((sum, item) => sum + item.views, 0)
  return {
    total,
    items: list.map((item) => ({ ...item, label: platformLabel(item.platform), share: total > 0 ? item.views / total : null })),
  }
}

/**
 * 覆盖度「来自 N/M 个账号」（定稿 §4.2-3）：
 * N = 有有效播放数据的账号数，M = 筛选范围内的账号总数。
 * 后端不提供该字段，前端从账号列表算。
 */
export function coverage(accounts) {
  const list = Array.isArray(accounts) ? accounts : []
  const covered = list.filter((item) => metricNumber(item?.followers) !== null || metricNumber(item?.publishedCount) !== null).length
  return { covered, total: list.length, label: `来自 ${covered}/${list.length} 个账号` }
}

/** ISO 周一（本地时区）。groupBy:'week' 的口径与后端保持一致，见定稿 §4.2-4。 */
export function weekStart(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (day.getDay() + 6) % 7
  day.setDate(day.getDate() - offset)
  return day
}

/** 本地日期 → YYYY-MM-DD。 */
export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 把后端返回的稀疏序列补成连续日期轴。
 * 定稿 §4.2-4：后端只返回有数据的日期，缺口由前端补，**不填 0**，
 * 缺口必须是 null，否则「当天没发内容」会被画成「当天播放 0」。
 */
export function densifySeries(points, { from, to, groupBy = 'day' } = {}) {
  const source = (Array.isArray(points) ? points : [])
    .filter((item) => item && item.date)
    .map((item) => ({ date: String(item.date), value: metricNumber(item.value) }))
  const byDate = new Map(source.map((item) => [item.date, item.value]))
  const start = from ? new Date(from) : null
  const end = to ? new Date(to) : null
  if (!Number.isFinite(start?.getTime()) || !Number.isFinite(end?.getTime())) {
    return { points: source, axis: source.map((item) => item.date), filled: 0 }
  }
  const axis = []
  const cursor = groupBy === 'week' ? weekStart(start) : new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const step = groupBy === 'week' ? 7 : 1
  let filled = 0
  while (cursor.getTime() <= end.getTime()) {
    const key = localDateKey(cursor)
    axis.push(key)
    if (!byDate.has(key)) filled += 1
    cursor.setDate(cursor.getDate() + step)
  }
  return { points: axis.map((date) => ({ date, value: byDate.has(date) ? byDate.get(date) : null })), axis, filled }
}

/** TOP 内容榜：按指定指标降序，缺失值排最后（不是 0 名）。 */
export function topContents(contents, metric = 'views', limit = 10) {
  const rank = { views: (item) => metricNumber(item?.metrics?.views), engagement: (item) => engagementRate([item]), publishedAt: () => null }
  const read = rank[metric] || rank.views
  return (Array.isArray(contents) ? contents : [])
    .map((item, index) => ({ item, index, value: read(item) }))
    .filter((row) => row.value !== null)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.item)
}

/** 时间范围 chips → {from,to}（本地时区，含端点）。 */
export function rangeWindow(rangeKey, today = new Date()) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999)
  const days = { '7d': 7, '30d': 30 }[rangeKey] || 30
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1))
  return { rangeKey, days, from: start.toISOString(), to: end.toISOString(), label: `近 ${days} 天` }
}

/** 发布成功率：分母为 0 时是「没有发布记录」而不是「成功率 0%」。 */
export function successRate(published) {
  const count = metricNumber(published?.count)
  const success = metricNumber(published?.success)
  if (count === null || success === null) return null
  if (count <= 0) return null
  return success / count
}

/**
 * 生产漏斗（定稿 §4.2-1）：来自 pipelineOverview()，是**当前时点快照**，
 * 不受所选时间范围影响——UI 必须明示这一点，否则用户会以为漏斗随时间筛选变化。
 */
export const FUNNEL_LABEL = Object.freeze({
  'script-pending': '待写稿', 'script-review': '待确认稿件', voiceover: '待配音 / 字幕',
  video: '待视频制作', publish: '可发布',
})

export function funnelRows(funnel) {
  return (Array.isArray(funnel) ? funnel : []).map((item) => ({
    stage: item?.stage || null,
    label: FUNNEL_LABEL[item?.stage] || item?.stage || '—',
    count: metricNumber(item?.count),
    page: item?.page || null,
  }))
}
