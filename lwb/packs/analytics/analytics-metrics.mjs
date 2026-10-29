/**
 * 数据看板的指标口径层。
 *
 * 纯函数，不依赖 Cordis、不读文件、不碰网络——所有派生口径都在这里定死，
 * 便于离线单测逐条钉死（方案 §4.3）。
 *
 * 贯穿全文件的一条铁律：**数值缺失是 null，不是 0。** 0 是「测得为零」，
 * null 是「不知道」。看板把 null 画成 0 就是在骗人。
 */

/** 可用的内容级指标。P1 没有任何采集源，它们恒为 null；P2 起由采集器填充。 */
export const CONTENT_METRICS = Object.freeze(['views', 'likes', 'comments', 'shares', 'favorites', 'followersGained', 'completionRate'])

/**
 * 诊断列（抖音「导出数据」文件自带，2026-10-29 接入）。
 *
 * 这些是平台官方给的「这条视频哪里掉了人」的信号：
 * 完播率低 → 内容铺垫太长；封面点击率低 → 封面/标题问题；
 * 2s跳出率高 → 钩子不够强。百分比统一存 0–100 的数字。
 */
export const DIAGNOSTIC_METRICS = Object.freeze({
  completionRate: '完播率',
  fiveSecondRate: '5s完播率',
  coverClickRate: '封面点击率',
  twoSecondBounceRate: '2s跳出率',
  avgPlaySeconds: '平均播放时长（秒）',
})

/** 分母固定为 views 的那批指标：views 为 null 时它们一律 null，不参与任何求和。 */
export const VIEWS_BACKED_METRICS = Object.freeze(['likes', 'comments', 'shares', 'favorites'])

export const SERIES_METRICS = Object.freeze(['views', 'likes', 'comments', 'followersNetGain', 'published'])

/** pipelineOverview 的 stage 枚举到漏斗展示顺序的映射（spoken-video-store 的 order 反向）。 */
const STAGE_ORDER = Object.freeze(['script-pending', 'script-review', 'topic', 'voiceover', 'video', 'publish'])

const STAGE_LABELS = Object.freeze({
  'script-pending': '待写稿',
  'script-review': '待确认稿',
  topic: '待选题',
  voiceover: '待配音',
  video: '待制作',
  publish: '可发布',
})

/** 只接受有限数值；null/undefined/NaN/Infinity 一律视为缺失。 */
export function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把值收敛成非负整数计数，用于 views/likes 这类平台计数。
 * 非数值（含 null、字符串、NaN）返回 null——**不回退 0**。
 */
export function countOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0) return null
  return Math.round(value)
}

/**
 * 百分比字段解析："12.34%" → 12.34；0.1234（≤1 的小数，平台常见的小数形态）
 * → 12.34；解析不出来返回 null。统一存 0–100 的数字。
 */
export function percentOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return null
    return value <= 1 ? +(value * 100).toFixed(2) : +value.toFixed(2)
  }
  const text = String(value ?? '').trim()
  const match = /^([\d.]+)\s*%$/.exec(text)
  if (match) {
    const number = Number.parseFloat(match[1])
    return Number.isFinite(number) && number >= 0 ? +number.toFixed(2) : null
  }
  const bare = Number.parseFloat(text)
  if (Number.isFinite(bare) && bare >= 0) return bare <= 1 ? +(bare * 100).toFixed(2) : +bare.toFixed(2)
  return null
}

/**
 * 时长解析："00:00:42" / "01:05" / "42秒" / 42 → 秒数；解析不出来返回 null。
 * 抖音导出的「平均播放时长」常见这几种形态。
 */
export function durationSecondsOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  const text = String(value ?? '').trim()
  if (!text) return null
  const parts = /^(\d{1,2}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(text)
  if (parts) {
    const seconds = parts[3] !== undefined
      ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3])
      : Number(parts[1]) * 60 + Number(parts[2])
    return Number.isFinite(seconds) ? seconds : null
  }
  const seconds = /^([\d.]+)\s*(?:秒|s)?$/i.exec(text)
  if (seconds) return Math.round(Number(seconds[1]))
  return null
}

/**
 * 互动率（方案 §4.3-1）。
 *
 * 分母固定为 views。集合 S = 「参与计算的那批内容」，由调用方用
 * `views != null` 预先筛好——没 views 的内容既不进分子也不进分母，
 * 否则一条无播放量的记录会把分母拉低、把比率抬高。
 *
 * 分子里单字段缺失按 0 计（点赞数缺失与「0 赞」在比率里等价，区别只在
 * 单项展示时的 null，§1.3 的单项比率各自单独算）。
 *
 * @param {Array<{metrics: object}>} contents 集合 S
 * @returns {number|null} 分母为 0 或 null 时返回 null
 */
/**
 * 对一批内容指标做 null 感知求和。
 *
 * 语义与 countOrNull 一致：某指标在**所有**内容上都是 null（平台没给、
 * 或还没采到）时，结果为 null——不用 0 冒充「没数据」；只要有一条有值，
 * 其余 null 按 0 计入（那些是平台明确报了 0 的）。
 */
export function sumMetrics(contents) {
  const sums = { views: null, likes: null, comments: null, shares: null, favorites: null }
  for (const content of contents || []) {
    const metrics = content?.metrics || {}
    for (const key of Object.keys(sums)) {
      const value = countOrNull(metrics[key])
      if (value !== null) sums[key] = (sums[key] ?? 0) + value
    }
  }
  return sums
}

export function engagementRate(contents) {
  let likes = 0
  let views = 0
  let seen = false
  for (const content of contents) {
    const metrics = content?.metrics || {}
    const contentViews = countOrNull(metrics.views)
    if (contentViews === null) continue
    seen = true
    views += contentViews
    for (const key of VIEWS_BACKED_METRICS) likes += countOrNull(metrics[key]) ?? 0
  }
  if (!seen || views <= 0) return null
  return likes / views
}

/**
 * 单条内容的互动率。views 缺失或为 0 时返回 null。
 * 与聚合版同一个口径，单项展示用。
 */
export function contentEngagementRate(metrics) {
  const views = countOrNull(metrics?.views)
  if (views === null || views <= 0) return null
  let likes = 0
  for (const key of VIEWS_BACKED_METRICS) likes += countOrNull(metrics?.[key]) ?? 0
  return likes / views
}

/**
 * 点赞率 / 评论率（方案 §1.3）。views 缺失或为 0 → null。
 */
export function ratioToViews(numeratorValue, metrics) {
  const views = countOrNull(metrics?.views)
  if (views === null || views <= 0) return null
  const numerator = countOrNull(numeratorValue)
  if (numerator === null) return null
  return numerator / views
}

/**
 * 净增粉（方案 §4.3-2）：区间内**末次快照 − 首次快照**。
 *
 * 刻意不用平台后台直读的「涨粉」：各平台口径不一（有的含取关、有的不含），
 * 只有快照差值是跨平台统一、可复算的口径。
 *
 * @param {Array<{date: string, followers: number|null}>} snapshots 按任意顺序
 * @returns {{netGain: number|null, baselineDate: string|null, currentDate: string|null}}
 *   少于 2 个有效快照时 netGain 为 null（差值无从谈起）
 */
export function followersNetGain(snapshots) {
  const usable = (snapshots || [])
    .map((snapshot) => ({ date: snapshot?.date, followers: countOrNull(snapshot?.followers) }))
    .filter((snapshot) => snapshot.date && snapshot.followers !== null)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
  if (!usable.length) return { netGain: null, baselineDate: null, currentDate: null }
  const first = usable[0]
  const last = usable[usable.length - 1]
  if (usable.length < 2) return { netGain: null, baselineDate: first.date, currentDate: first.date }
  return { netGain: last.followers - first.followers, baselineDate: first.date, currentDate: last.date }
}

/** 区间内最新一次快照的粉丝数。 */
export function currentFollowers(snapshots) {
  const usable = (snapshots || [])
    .map((snapshot) => ({ date: snapshot?.date, followers: countOrNull(snapshot?.followers) }))
    .filter((snapshot) => snapshot.date && snapshot.followers !== null)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
  if (!usable.length) return { current: null, currentDate: null }
  const last = usable[usable.length - 1]
  return { current: last.followers, currentDate: last.date }
}

/**
 * 发布成功率（方案 §1.4）。
 *
 * 分母是**已出终态的任务**（succeeded / failed / cancelled）：queued 和
 * running 还没定论，计进分母会把成功率压低到一个假象值。
 *
 * @returns {number|null} 没有终态任务时 null，不返回 0
 */
export function publishSuccessRate(jobs) {
  const settled = (jobs || []).filter((job) => ['succeeded', 'failed', 'cancelled'].includes(job?.status))
  if (!settled.length) return null
  return settled.filter((job) => job.status === 'succeeded').length / settled.length
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 *
 * §4.1 要求区间含端点、按本地时区归属，所以这里走本地时间而不是 UTC——
 * 23:59:59 的发布必须算当天，不能因为时差滚到明天。
 */
export function localDateKey(value) {
  if (value === undefined || value === null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 区间是否含该时刻（两端闭区间）。 */
export function withinRange(value, from, to) {
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (Number.isNaN(at)) return false
  const fromAt = new Date(from).getTime()
  const toAt = new Date(to).getTime()
  if (!Number.isNaN(fromAt) && at < fromAt) return false
  if (!Number.isNaN(toAt) && at > toAt) return false
  return true
}

/**
 * ISO 周的周一日期键（方案 §4.2-4：groupBy:'week' 用 ISO 周一、本地时区）。
 * 2026-01-01 所在的周从 2025-12-29 起算——所以不能直接按月初对齐。
 */
export function isoWeekStartKey(value) {
  const key = localDateKey(value)
  if (!key) return null
  const date = new Date(`${key}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  // getDay(): 0=周日。转成「周一为 0」的偏移。
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return localDateKey(date)
}

/** 区间内每一天的日期键，含两端。用于全量计数的补点。 */
export function eachDayKey(from, to) {
  const keys = []
  const cursor = new Date(`${localDateKey(from)}T00:00:00`)
  const last = localDateKey(to)
  if (Number.isNaN(cursor.getTime()) || !last) return keys
  // 上限保护：跨 20 年的区间不该让服务端 OOM，区间本身也该被校验（见 analytics-local）。
  for (let guard = 0; guard < 4000 && localDateKey(cursor) <= last; guard += 1) {
    keys.push(localDateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/** 把一组 {date,value} 按日或周合并成有序点数组。缺失的日期不补 0（§4.2-4）。 */
export function bucketSeries(entries, { groupBy = 'day' } = {}) {
  const keyOf = groupBy === 'week' ? isoWeekStartKey : localDateKey
  const buckets = new Map()
  for (const entry of entries || []) {
    const key = keyOf(entry.at)
    if (!key) continue
    const value = countOrNull(entry.value)
    if (value === null) continue
    buckets.set(key, (buckets.get(key) ?? 0) + value)
  }
  return [...buckets.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

/**
 * 生产漏斗（方案 §1.4 / §4.2-1）。
 *
 * 来自 pipelineOverview()，是**当前时点快照，不受 {from,to} 影响**——
 * 每个项目的 stage 只反映此刻它走到哪一步，历史区间对它没有意义。
 */
export function funnelFromPipeline(items) {
  const counts = new Map(STAGE_ORDER.map((stage) => [stage, 0]))
  const pages = new Map()
  for (const item of items || []) {
    const stage = item?.stage
    if (!counts.has(stage)) continue
    counts.set(stage, counts.get(stage) + 1)
    if (!pages.has(stage) && typeof item.page === 'string') pages.set(stage, item.page)
  }
  return STAGE_ORDER
    .map((stage) => ({ stage, label: STAGE_LABELS[stage], count: counts.get(stage), page: pages.get(stage) ?? null }))
    .filter((entry) => entry.count > 0)
}

/** 平台枚举沿用 publisher 的 PLATFORMS（P1 不做二次校验，只做展示排序）。 */
export function platformRows(totals) {
  return Object.entries(totals || {})
    .map(([platform, values]) => ({
      platform,
      views: countOrNull(values.views),
      likes: countOrNull(values.likes),
      comments: countOrNull(values.comments),
      followers: countOrNull(values.followers),
    }))
    .sort((left, right) => left.platform.localeCompare(right.platform))
}

/**
 * 内容明细排序 + 分页。
 *
 * 方向由 `order` 直接进比较器，而不是「先升序排完再 reverse」——后者会把
 * 排到尾部的 null 甩到开头，等于把「没数据」显示成「排第一」，恰好是 §4.1
 * 要禁的那件事。数值型按 order 翻符号，null 恒定垫底。
 */
const NUMERIC_SORTS = Object.freeze({
  views: (row) => finiteOrNull(row.metrics?.views),
  engagement: (row) => finiteOrNull(row.engagementRate),
})

const DATE_SORTS = Object.freeze({
  publishedAt: (row) => (typeof row.publishedAt === 'string' && row.publishedAt ? row.publishedAt : null),
  collectedAt: (row) => (typeof row.collectedAt === 'string' && row.collectedAt ? row.collectedAt : null),
})

export function sortAndPage(items, { sort, order = 'desc', offset = 0, limit = 20 } = {}) {
  const numeric = NUMERIC_SORTS[sort]
  const date = DATE_SORTS[sort]
  const direction = order === 'asc' ? 1 : -1
  const copy = [...(items || [])]
  copy.sort((left, right) => {
    // 没有合法 sort 时按发布时间倒序（最新发布在前）。
    if (!numeric && !date) {
      const a = DATE_SORTS.publishedAt(left)
      const b = DATE_SORTS.publishedAt(right)
      if (a === null && b === null) return 0
      if (a === null) return 1
      if (b === null) return -1
      return b.localeCompare(a)
    }
    if (numeric) {
      const a = numeric(left)
      const b = numeric(right)
      if (a === null && b === null) return 0
      if (a === null) return 1
      if (b === null) return -1
      return (a - b) * direction
    }
    const a = date(left)
    const b = date(right)
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return a.localeCompare(b) * direction
  })
  const start = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0)
  const size = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 20
  return { items: copy.slice(start, start + size), total: copy.length, offset: start, limit: size }
}

/**
 * 单作品诊断（规则式，零成本、可解释）。
 *
 * 思路：拿本条作品的诊断列与**账号内其他作品的_tokens_中位数**比，
 * 显著偏离才说话——每条 diagnosis 都说清「你的是多少、账号基准是多少、该做什么」。
 *
 * 为什么不用 LLM：这些规则是确定性的，LLM 反而会编原因。周报里的
 * 「为什么」交给模型，这里的「是什么」必须可复现。
 *
 * @param {object} content - 带 metrics 的作品行
 * @param {Array} peers - 同账号的其他作品行（用于算中位数基准）
 * @returns {{level:'good'|'warn'|'info', messages:string[]}|null} 数据不足时返回 null
 */
export function diagnoseContent(content, peers = []) {
  const metrics = content?.metrics || {}
  const MIN_WORKS = 3
  const samePlatform = (peers || []).filter((row) => row.platform === content?.platform && row.contentId !== content?.contentId)
  const rates = samePlatform.filter((row) => finiteOrNull(row?.metrics?.completionRate) !== null)
  // 播放量太小不下结论：一两次播放的完播率是噪声。
  if ((finiteOrNull(metrics.views) ?? 0) < 5) {
    return { level: 'info', messages: ['播放量还小，先攒数据；满 5 次播放后给出诊断。'] }
  }
  if (rates.length < MIN_WORKS) {
    return { level: 'info', messages: [`数据积累中（账号内已有 ${rates.length} 条带完播率的作品，满 ${MIN_WORKS} 条后开始对比诊断）。`] }
  }
  const medianOf = (values) => {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : +((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)
  }
  const completionMedian = medianOf(rates.map((row) => row.metrics.completionRate))
  const messages = []
  let level = 'good'
  const completion = finiteOrNull(metrics.completionRate)
  if (completion !== null) {
    if (completion < completionMedian * 0.7) {
      level = 'warn'
      messages.push(`完播率 ${completion}% 低于账号中位数 ${completionMedian}%：观众中途流失多，优先压缩开头 20 秒的铺垫，把结论或冲突提前。`)
    } else if (completion > completionMedian * 1.2) {
      messages.push(`完播率 ${completion}% 高于账号中位数 ${completionMedian}%：这个结构跑通了，同类选题可以复用。`)
    }
  }
  const bounce = finiteOrNull(metrics.twoSecondBounceRate)
  const bounceMedian = medianOf(samePlatform.filter((row) => finiteOrNull(row?.metrics?.twoSecondBounceRate) !== null).map((row) => row.metrics.twoSecondBounceRate))
  if (bounce !== null && bounceMedian !== null && bounce > bounceMedian * 1.3) {
    level = 'warn'
    messages.push(`2s跳出率 ${bounce}% 高于账号中位数 ${bounceMedian}%：前两秒的钩子没抓住人，换开头第一句或把冲突画面提前。`)
  }
  const coverClick = finiteOrNull(metrics.coverClickRate)
  const coverMedian = medianOf(samePlatform.filter((row) => finiteOrNull(row?.metrics?.coverClickRate) !== null).map((row) => row.metrics.coverClickRate))
  if (coverClick !== null && coverMedian !== null && coverClick < coverMedian * 0.7) {
    level = level === 'warn' ? 'warn' : 'info'
    messages.push(`封面点击率 ${coverClick}% 低于账号中位数 ${coverMedian}%：试一版更直给文字的封面，或把标题里的数字挪到封面上。`)
  }
  if (!messages.length) {
    messages.push('各项指标与账号中位数接近，保持当前结构。')
  }
  return { level, messages }
}
