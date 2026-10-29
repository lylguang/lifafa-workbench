/**
 * 抖音采集 adapter。
 *
 * 采集两条线，与 B 站 adapter 同构：
 *  1. 账号级：创作者中心数据概览 → 粉丝总数、主页访问
 *  2. 内容级：作品管理列表 → 单作品的播放/点赞/评论/收藏
 *
 * 为什么内容级选「作品管理」而不是「作品数据」页：
 *  - 作品管理是 publisher 发布 adapter 已经在跑的页面（`creator-micro/content/manage`），
 *    登录态判定与页面稳定性都有生产验证；
 *  - 它每行就带播放/点赞/评论，一次读取覆盖全部已发布作品；
 *  - 「作品数据」页需要逐个作品点进去，N 次跳转在 300 秒预算内跑不完。
 *
 * **选择器失效是常态**：抖音的 class 带构建哈希（如 `upload-tips-KomyJM`），
 * 随版本变化。这里的约定沿用 B 站那一套——
 *  - 优先用 `data-e2e` 这类语义属性，其次才用带前缀匹配的 class；
 *  - 找不到关键元素 → 抛 ANALYTICS_COLLECTOR_SELECTOR_MISSING，并在抛出前
 *    留一张截图 + 页面文本摘录，让「平台改版」有证据可查；
 *  - 登录态中途失效 → 抛 PUBLISHER_LOGIN_REQUIRED，由 publisher 标记 expired。
 */

const ORIGIN = 'https://creator.douyin.com'
/** 数据概览（粉丝、主页访问）。 */
const DATA_URL = `${ORIGIN}/creator-micro/data/overview`
/** 作品管理（逐条播放/点赞/评论）。 */
const MANAGE_URL = `${ORIGIN}/creator-micro/content/manage`

const SELECTORS = {
  /** 已登录标志：右上角用户信息区（与发布 adapter 同源，生产已验证）。 */
  loggedIn: [
    '[data-e2e="user-info"]',
    '.user-info',
    'img[class*="avatar"]',
    '[class*="avatar"] img',
  ],
  loggedOut: [
    'text=扫码登录',
    'text=验证码登录',
    '[class*="login-panel"]',
  ],
  /** 粉丝数：概览页的「粉丝总数 / 总粉丝」。 */
  followers: [
    '[data-e2e="fans-count"]',
    '[class*="fans"] [class*="value"]',
    '[class*="fans"] [class*="num"]',
    '[class*="follower"] [class*="value"]',
  ],
  /** 主页访问：部分版本有，取不到就是 null（不猜）。 */
  profileVisits: [
    '[data-e2e="profile-visit"]',
    '[class*="visit"] [class*="value"]',
    '[class*="home-visit"] [class*="value"]',
  ],
  /** 作品管理列表的一行。 */
  contentRows: [
    '[data-e2e="video-item"]',
    '[class*="video-item"]',
    '[class*="content-card"]',
    'tr[class*="row"]',
  ],
  rowTitle: [
    '[data-e2e="video-title"]',
    '[class*="video-title"]',
    '[class*="title"]',
  ],
  rowStats: [
    '[data-e2e="video-stats"]',
    '[class*="stat"]',
    '[class*="data"]',
  ],
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
    } catch { /* 试下一个候选 */ }
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
  const error = new Error('抖音登录态已失效。')
  error.code = 'PUBLISHER_LOGIN_REQUIRED'
  return error
}

/**
 * 「1.2万」/「3,456」/「12」→ number；解析不出来返回 null（不是 0）。
 *
 * 与 B 站 adapter 同一套语义：平台没给的数不能用 0 冒充，
 * 否则看板上「0 播放」和「还没采到」会长得一模一样。
 */
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

/** 登录页判定：URL 跳转与页面元素两条都要看——SPA 有时不换 URL。 */
async function assertLoggedIn(page) {
  if (/login/iu.test(page.url())) throw loginRequired()
  const out = await firstMatch(page, SELECTORS.loggedOut)
  if (out) throw loginRequired()
}

/**
 * 采集账号级指标：粉丝数、主页访问。
 *
 * 同日同账号只保留最后一次成功快照（与 B 站一致），覆盖由 store 负责。
 */
export async function collectAccount(lease, { runId, store } = {}) {
  const { page, signal } = lease
  await page.goto(DATA_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  // 创作中心是重 SPA，首屏数字常在 1.5–4 秒后才挂出来，等一下再读。
  await page.waitForTimeout(3500)
  await assertLoggedIn(page)
  if (signal?.aborted) return null

  const followers = parseCount(await textOf(page, SELECTORS.followers))
  const profileVisits = parseCount(await textOf(page, SELECTORS.profileVisits))
  if (followers === null && profileVisits === null) {
    const evidence = await lease.evidence?.('douyin-account-data', runId).catch(() => null)
    throw selectorMissing('抖音数据概览页没有可读的粉丝/访问数（页面结构可能已改版）。', evidence?.relativePath ?? null)
  }

  const record = {
    accountId: lease.accountId,
    platform: lease.platform,
    date: new Date().toISOString().slice(0, 10),
    followers,
    profileVisits,
    collectedAt: new Date().toISOString(),
    source: 'collector',
  }
  await store.saveAccountSnapshot(record)
  return record
}

/**
 * 采集内容级指标：作品管理列表里每条的播放/点赞/评论/收藏。
 *
 * 只处理**已绑定**的作品（拿到了 remoteId/remoteUrl 的），未绑定的不猜——
 * 绑定正确性优先于绑定率，宁缺勿错。标题对不上就跳过，不做模糊匹配。
 */
export async function collectContents(lease, { runId, store, contentIds } = {}) {
  const { page } = lease
  const wanted = Array.isArray(contentIds) && contentIds.length ? new Set(contentIds) : null
  const contents = await store.listContents()
  const targets = contents.filter((row) => row.bound && (!wanted || wanted.has(row.contentId)))
  if (!targets.length) return []

  await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(3500)
  await assertLoggedIn(page)

  const rows = await page.locator(SELECTORS.contentRows.join(', ')).all()
  if (!rows.length) {
    const evidence = await lease.evidence?.('douyin-content-manage', runId).catch(() => null)
    throw selectorMissing('抖音作品管理页没有读到作品行（页面结构可能已改版）。', evidence?.relativePath ?? null)
  }

  const collected = []
  for (const row of rows) {
    const title = (await row.locator(SELECTORS.rowTitle.join(', ')).first().innerText().catch(() => '')).trim()
    if (!title) continue
    const target = targets.find((item) => item.title === title)
    if (!target) continue
    const stats = (await row.locator(SELECTORS.rowStats.join(', ')).first().innerText().catch(() => '')).trim()
    const metrics = parseRowStats(stats)
    // 一个数都读不到时不要落一条全 null 的记录——那会让「采集成功」变成假象。
    if (Object.values(metrics).every((value) => value === null)) continue
    const record = { ...target, metrics, source: 'collector', collectedAt: new Date().toISOString() }
    await store.saveContentMetrics({ contentId: target.contentId, date: record.collectedAt, collectedAt: record.collectedAt, metrics, source: 'collector' })
    await store.saveContents([record])
    collected.push(record)
    if (collected.length >= 50) break
  }
  return collected
}

/**
 * 作品行统计文本解析：抖音这一格形如「1.2万 播放 · 345 点赞 · 12 评论」，
 * 数字有时在标签前、有时在后，所以两种顺序都试。
 * **找不到就 null**——平台没给的数不能用 0 冒充。
 */
export function parseRowStats(text) {
  const result = { views: null, likes: null, comments: null, shares: null, favorites: null, followersGained: null, completionRate: null }
  const source = String(text ?? '')
  if (!source) return result
  const NUMBER = '([\\d,.]+\\s*[万亿wkK]?)'
  const pick = (labels) => {
    for (const label of labels) {
      // 数字在前（抖音作品管理的主形态：「1.2万 播放 345 点赞」）。
      // 必须先试这一种：反过来先试「标签在前」时，「评论 8」会把下一个数字
      // 当成评论数（实测把 12 评论 8 分享 解析成 8）。
      const before = new RegExp(`${NUMBER}\\s*${label}`, 'u').exec(source)
      if (before) return parseCount(before[1])
      // 标签在前（B 站那一类排版：「播放: 1.2万」）
      const after = new RegExp(`${label}\\s*[:：]?\\s*${NUMBER}`, 'u').exec(source)
      if (after) return parseCount(after[1])
    }
    return null
  }
  result.views = pick(['播放', '观看', '浏览', 'view'])
  result.likes = pick(['点赞', '赞', 'like'])
  result.comments = pick(['评论', 'comment'])
  result.favorites = pick(['收藏', 'favorite'])
  result.shares = pick(['分享', '转发', 'share'])
  return result
}

export const id = 'douyin'
export default { id, collectAccount, collectContents }
