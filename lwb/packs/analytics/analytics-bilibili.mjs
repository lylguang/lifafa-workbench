/**
 * B 站采集 adapter（P2 首个平台）。
 *
 * 采集两条线：
 *  1. 账号级：创作中心数据概览 → 粉丝总数、主页访问
 *  2. 内容级：稿件管理列表 → 单稿件的播放/点赞/评论/收藏
 *
 * 为什么先做 B 站：它的创作中心页面结构相对稳定，且发布 adapter 已经在这个
 * 域名下跑通了 400+ 行（`/platform/upload-manager/article`），选择器与登录态
 * 判定的路子可以直接沿用；抖音的创作者微服务多一层跳转。
 *
 * **选择器失效是常态**：B 站改版频繁。这里的约定是——
 *  - 找不到关键元素 → 抛 ANALYTICS_COLLECTOR_SELECTOR_MISSING，并在抛出前
 *    留一张截图，让「平台改版」这件事有证据可查，而不是留下一句「采集失败」。
 *  - 登录态中途失效 → 抛 PUBLISHER_LOGIN_REQUIRED，由 publisher 标记 expired。
 */

const ORIGIN = 'https://member.bilibili.com'
const DATA_URL = `${ORIGIN}/platform/data-up/overview`
const CONTENT_URL = `${ORIGIN}/platform/upload-manager/article`

const SELECTORS = {
  fans: ['.up-stat .up-stat__item:nth-child(1) .up-stat__value', '.stat-item .stat-item__value', '[class*="fans"] [class*="value"]'],
  fansLabel: ['.up-stat .up-stat__item:nth-child(1) .up-stat__label', '.stat-item .stat-item__label'],
  visits: ['.up-stat .up-stat__item:nth-child(2) .up-stat__value', '.stat-item:nth-child(2) .stat-item__value'],
  visitsLabel: ['.up-stat .up-stat__item:nth-child(2) .up-stat__label', '.stat-item:nth-child(2) .stat-item__label'],
  contentRows: ['.table-item', '.content-table .table-item', '[class*="稿件管理"] tbody tr', 'tbody tr'],
  rowTitle: ['.title', '.table-item-title', '[class*="title"]'],
  rowStats: ['.statistics', '.table-item-stat', '[class*="stat"]'],
}

/** 与发布 adapter 同款：逐个候选选择器试，第一个可用的赢。 */
async function firstMatch(page, selectors, { timeout = 0, visible = true } = {}) {
  const perTry = timeout > 0 ? Math.max(500, Math.floor(timeout / selectors.length)) : 0
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first()
      if (perTry > 0) {
        await locator.waitFor({ state: visible ? 'visible' : 'attached', timeout: perTry })
      } else if (await locator.count() === 0) {
        continue
      } else if (visible && !(await locator.isVisible())) {
        continue
      }
      return locator
    } catch { /* try the next candidate */ }
  }
  return null
}

function selectorMissing(message, evidencePath = null) {
  const error = new Error(message)
  error.code = 'ANALYTICS_COLLECTOR_SELECTOR_MISSING'
  error.evidencePath = evidencePath
  return error
}

function loginRequired() {
  const error = new Error('B 站登录态已失效。')
  error.code = 'PUBLISHER_LOGIN_REQUIRED'
  return error
}

/** 「1.2万」/「3,456」/「12」→ number；解析不出来返回 null（不是 0）。 */
export function parseCount(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const unit = { 万: 1e4, w: 1e4, W: 1e4, 亿: 1e8, k: 1e3, K: 1e3 }[text.slice(-1)]
  const number = Number.parseFloat(unit ? text.slice(0, -1).replace(/,/g, '') : text.replace(/,/g, ''))
  if (!Number.isFinite(number)) return null
  return Math.round(unit ? number * unit : number)
}

async function textOf(page, selectors) {
  const locator = await firstMatch(page, selectors)
  if (!locator) return null
  try { return (await locator.innerText()).trim().slice(0, 200) || null } catch { return null }
}

/**
 * 采集账号级指标：粉丝数、主页访问。
 *
 * 同日同账号只保留最后一次成功快照（定稿 §4.3-4），所以这里不判断是否已有快照——
 * 那是 store.saveAccountSnapshot 的事，它会按 (accountId, date) 覆盖。
 */
export async function collectAccount(lease, { runId, store } = {}) {
  const { page, signal } = lease
  await page.goto(DATA_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  // 创作中心是重 SPA，首屏数据常在 1.5–3s 后才挂出来，等一下再读。
  await page.waitForTimeout(3000)
  if (/passport\.bilibili\.com|login/iu.test(page.url())) throw loginRequired()
  if (signal?.aborted) return null

  const fans = parseCount(await textOf(page, SELECTORS.fans))
  const visits = parseCount(await textOf(page, SELECTORS.visits))
  if (fans === null && visits === null) {
    const evidence = await lease.evidence?.('account-data', runId).catch(() => null)
    throw selectorMissing('B 站数据概览页没有可读的粉丝/访问数（页面结构可能已改版）。', evidence?.relativePath ?? null)
  }

  const record = {
    accountId: lease.accountId,
    platform: lease.platform,
    date: new Date().toISOString().slice(0, 10),
    followers: fans,
    profileVisits: visits,
    collectedAt: new Date().toISOString(),
    source: 'collector',
  }
  await store.saveAccountSnapshot(record)
  return record
}

/**
 * 采集内容级指标：稿件列表里每条的播放/点赞/评论/收藏。
 *
 * 只处理**已绑定**的作品（拿到了 remoteId/remoteUrl 的），未绑定的不猜——
 * 定稿 §4.3-6：绑定正确性优先于绑定率，宁缺勿错。
 */
export async function collectContents(lease, { runId, store, contentIds } = {}) {
  const { page } = lease
  const wanted = Array.isArray(contentIds) && contentIds.length ? new Set(contentIds) : null
  const contents = await store.listContents()
  const targets = contents.filter((row) => row.bound && (!wanted || wanted.has(row.contentId)))
  if (!targets.length) return []

  await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(3000)
  if (/passport\.bilibili\.com|login/iu.test(page.url())) throw loginRequired()

  const rows = await page.locator(SELECTORS.contentRows.join(', ')).all()
  const collected = []
  for (const row of rows) {
    const title = (await row.locator(SELECTORS.rowTitle.join(', ')).first().innerText().catch(() => '')).trim()
    if (!title) continue
    const target = targets.find((item) => item.title === title)
    // 标题对不上就跳过，不做模糊匹配——「宁可进待绑定也不能静默绑错」。
    if (!target) continue
    const stats = (await row.locator(SELECTORS.rowStats.join(', ')).first().innerText().catch(() => '')).trim()
    const parsed = parseRowStats(stats)
    const record = { ...target, metrics: parsed, source: 'collector', collectedAt: new Date().toISOString() }
    await store.saveContentMetrics({ contentId: target.contentId, date: record.collectedAt, collectedAt: record.collectedAt, metrics: parsed, source: 'collector' })
    await store.saveContents([record])
    collected.push(record)
    if (collected.length >= 50) break
  }
  return collected
}

/**
 * 稿件行的统计文本解析：B 站这一格形如「播放 1.2万 · 点赞 345 · 评论 12」。
 * 逐个标签找它后面的数字，**找不到就 null**——平台没给的数不能用 0 冒充。
 */
export function parseRowStats(text) {
  const result = { views: null, likes: null, comments: null, shares: null, favorites: null, followersGained: null, completionRate: null }
  const source = String(text ?? '')
  if (!source) return result
  const pick = (labels) => {
    for (const label of labels) {
      const match = new RegExp(`${label}\\s*[:：]?\\s*([\\d,.]+\\s*[万亿wkK]?)`, 'u').exec(source)
      if (match) return parseCount(match[1])
    }
    return null
  }
  result.views = pick(['播放', '阅读', 'view'])
  result.likes = pick(['点赞', 'like'])
  result.comments = pick(['评论', 'comment'])
  result.favorites = pick(['收藏', 'favorite'])
  return result
}

export const id = 'bilibili'
export default { id, collectAccount, collectContents }
