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

import { readFile } from 'node:fs/promises'
import { bindByTitle, normalizeTitle } from './analytics-bind.mjs'

const ORIGIN = 'https://creator.douyin.com'
/**
 * 数据页入口。
 *
 * 2026-10-29 实测：直连 `creator-micro/data/overview` 会被重定向到首页
 * 「关注列表」——那个路径在当前版本已经不存在。抖音的数据入口是侧栏的
 * 「数据中心」，它的真实路径随版本变化。
 * 所以账号级采集改成**先走侧栏点击**，再退到候选直连路径；
 * 数字一律按正文里的标签就近取值（parseLabeledNumber），不依赖 class 哈希。
 */
const HOME_URL = `${ORIGIN}/creator-micro/home`
/** 侧栏「数据中心」的可见文案。 */
const DATA_CENTER_LABELS = ['数据中心', '数据概览']
/** 数据中心直连候选（点击失败时按顺序试）。 */
const DATA_URL_CANDIDATES = [
  `${ORIGIN}/creator-micro/data-center/overview`,
  `${ORIGIN}/creator-micro/data-center/content`,
  `${ORIGIN}/creator-micro/data/overview`,
]
/** 作品管理（publisher 发布 adapter 已在跑，路径生产验证过）。 */
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

/** 读整页正文（限长）。平台改版时 class 会变，正文文案相对稳定。 */
async function bodyText(page, limit = 8000) {
  try {
    if (typeof page.evaluate !== 'function') return ''
    const text = await page.evaluate(() => (globalThis.document?.body?.innerText ?? ''))
    return String(text ?? '').slice(0, limit)
  } catch { return '' }
}

/**
 * 按标签就近取数字：`粉丝总数\n1.2万` / `粉丝 1.2万` / `1.2万 粉丝` 都能读。
 * 只认标签附近 40 个字符内的数字，避免抓到无关指标；取不到返回 null。
 */
export function parseLabeledNumber(text, labels) {
  const source = String(text ?? '')
  if (!source) return null
  const NUMBER = '([\\d,.]+\\s*[万亿wkK]?)'
  for (const label of labels) {
    // 标签在前（创作者中心卡片就是这种：标题一行、数值下一行）
    const after = new RegExp(`${label}[^\\d]{0,40}?${NUMBER}`, 'u').exec(source)
    if (after) {
      const value = parseCount(after[1])
      if (value !== null) return value
    }
    // 数字在前
    const before = new RegExp(`${NUMBER}\\s*${label}`, 'u').exec(source)
    if (before) {
      const value = parseCount(before[1])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * 打开数据中心：优先点侧栏入口（路径无关），失败再试候选直连。
 * @returns {Promise<boolean>} 是否成功切到数据中心
 */
async function openDataCenter(page) {
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForTimeout(3500)
    for (const label of DATA_CENTER_LABELS) {
      const link = page.locator(`text=${label}`).first()
      const count = await link.count().catch(() => 0)
      if (!count) continue
      await link.click().catch(() => {})
      await page.waitForTimeout(4500)
      return true
    }
  } catch { /* 落到直连候选 */ }
  for (const url of DATA_URL_CANDIDATES) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(3500)
      if (!/home/iu.test(page.url())) return true
    } catch { /* 试下一个 */ }
  }
  return false
}

/**
 * 从内容管理页读作品列表：标题 + 统计文本 + 作品链接。
 *
 * 为什么不用 class 选择器：抖音的 class 带构建哈希，且列表行是深层嵌套的
 * div，2026-10-29 实测选择器一个都没命中（截图显示 24 个作品明明都在页面上）。
 * 改用「结构特征」定位，对改版免疫：
 *  - 统计条 = 同时含「播放/点赞/评论」且没有子元素也含这三个词的最深层节点；
 *  - 从统计条向上最多 6 层找到含作品链接的容器，取其中最长的一行非统计文本作标题。
 */
export async function readWorksFromPage(page) {
  if (typeof page.evaluate !== 'function') return []
  try {
    return await page.evaluate(() => {
      const STAT = ['播放', '点赞', '评论']
      const hasStats = (text) => STAT.every((word) => text.includes(word))
      const nodes = [...document.querySelectorAll('div,li,section,article,tr')]
      const strips = nodes.filter((el) => {
        const text = el.innerText || ''
        if (text.length > 600 || !hasStats(text)) return false
        return ![...el.children].some((child) => hasStats(child.innerText || ''))
      })
      const works = []
      const seen = new Set()
      for (const strip of strips) {
        let row = strip
        for (let depth = 0; depth < 6 && row.parentElement; depth += 1) {
          row = row.parentElement
          if (row.querySelector('a[href*="/video/"]')) break
        }
        const link = row.querySelector('a[href*="/video/"]')
        const lines = (row.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean)
        const title = lines.find((line) => line.length >= 8 && !hasStats(line)
          && !/^(已发布|定时发布中|审核中|未通过|仅自己可见|修改|置顶)/u.test(line)) || ''
        if (!title) continue
        const key = title + '|' + (link ? link.getAttribute('href') : '')
        if (seen.has(key)) continue
        seen.add(key)
        works.push({ title, stats: strip.innerText || '', href: link ? link.getAttribute('href') : null })
        if (works.length >= 200) break
      }
      return works
    })
  } catch { return [] }
}

/**
 * 极简 CSV 解析：支持双引号包裹、字段内逗号/换行、\r\n、BOM。
 *
 * 为什么不引依赖：这是采集侧的一次性解析，几十行足够，也避免给能力包
 * 增加第三方依赖（发布包已经因为 playwright 体积吃过一次教训）。
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/u, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (quoted) {
      if (ch === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1 }
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''))
}

/**
 * 把平台导出的 CSV 映射成作品指标。
 *
 * 表头列顺序会变、文案也会微调，所以**按关键字找列**而不是按位置：
 * 只要某列标题里含「播放 / 点赞 / 评论 / 分享 / 收藏 / 涨粉」就认。
 * 标题列同理（标题 / 作品名称 / 作品标题）。认不出标题列就返回空，
 * 由调用方退回 DOM 读取——宁可采不到，也不要采错。
 */
export function worksFromExport(csvText) {
  const rows = parseCsv(csvText)
  if (rows.length < 2) return { works: [], header: rows[0] ?? [] }
  const header = rows[0].map((cell) => String(cell).trim())
  const find = (keywords) => header.findIndex((cell) => keywords.some((word) => cell.includes(word)))
  const columns = {
    title: find(['标题', '作品名称', '作品标题', '视频名称']),
    views: find(['播放']),
    likes: find(['点赞']),
    comments: find(['评论']),
    shares: find(['分享', '转发']),
    favorites: find(['收藏']),
    followers: find(['涨粉', '吸粉']),
    link: find(['链接', '地址', 'URL', 'url']),
  }
  if (columns.title < 0) return { works: [], header }
  const works = []
  for (const row of rows.slice(1)) {
    const title = String(row[columns.title] ?? '').trim()
    if (!title) continue
    const cell = (index) => (index >= 0 ? row[index] : null)
    const metrics = {
      views: parseCount(cell(columns.views)),
      likes: parseCount(cell(columns.likes)),
      comments: parseCount(cell(columns.comments)),
      shares: parseCount(cell(columns.shares)),
      favorites: parseCount(cell(columns.favorites)),
      followersGained: parseCount(cell(columns.followers)),
      completionRate: null,
    }
    const link = cell(columns.link) ? String(cell(columns.link)).trim() : null
    works.push({ title, metrics, stats: '', remoteId: videoIdFromHref(link), remoteUrl: link || null })
    if (works.length >= 500) break
  }
  return { works, header }
}

/**
 * 点「导出数据」并捕获下载，返回文件内容（utf8）。
 *
 * 为什么走导出而不是读页面：内容管理页不给作品 id、标题被拼接重复、
 * 列表懒加载只渲染 1 条（2026-10-29 诊断证据 works:1 / withHref:0）。
 * 平台自己的导出文件是按作品一行、带完整标题与全部指标的最可靠来源。
 */
export async function downloadExport(page, { timeoutMs = 60_000 } = {}) {
  if (typeof page.waitForEvent !== 'function') return null
  const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs }).catch(() => null)
  const clickText = async (labels) => {
    for (const label of labels) {
      const target = page.locator(`text=${label}`).first()
      const count = await target.count().catch(() => 0)
      if (!count) continue
      await target.click({ timeout: 5000 }).catch(() => {})
      return label
    }
    return null
  }
  const opened = await clickText(['导出数据', '导出作品数据', '下载数据'])
  if (!opened) return null
  // 可能弹二级菜单：作品数据 / 全部作品 / 确认导出
  await page.waitForTimeout(1200)
  await clickText(['作品数据', '导出作品', '全部作品', '确认导出', '下载'])
  const download = await downloadPromise
  if (!download) return null
  const path = await download.path().catch(() => null)
  if (!path) return null
  const buffer = await readFile(path).catch(() => null)
  if (!buffer || !buffer.length) return null
  // xlsx/zip 是二进制：交给调用方按文件名判断，这里只回传原始字节。
  const name = download.suggestedFilename?.() ?? ''
  return { name, buffer, text: isProbablyText(buffer) ? buffer.toString('utf8') : null }
}

/** 粗判是否文本（xlsx 是 zip，前两字节 PK）。 */
function isProbablyText(buffer) {
  if (buffer.length < 2) return false
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return false
  return !buffer.subarray(0, 512).includes(0)
}

async function textOf(page, selectors) {
  const locator = await firstMatch(page, selectors)
  if (!locator) return null
  try { return (await locator.innerText()).trim().slice(0, 200) || null } catch { return null }
}

/** 登录墙的文案特征。抖音掉登录时 URL 不变，只在页面里渲染扫码/验证码登录。 */
const LOGIN_WALL_MARKERS = ['扫码登录', '验证码登录', '密码登录', '登录即代表同意']

/**
 * 登录页判定：URL、页面文本、可见元素三条都看。
 *
 * 为什么必须看文本：抖音掉登录时**不会**跳转 URL，只在原来的
 * creator-micro 路径下渲染登录墙（2026-10-29 实测：data/overview 与
 * content/manage 都停在扫码登录页，URL 仍是原路径）。
 * 只靠选择器判定会漏，于是把登录墙误报成「页面结构已变化」，
 * 用户拿到的提示是「平台改版」，而真正该做的是重新扫码。
 */
async function assertLoggedIn(page) {
  if (/login/iu.test(page.url())) throw loginRequired()
  const out = await firstMatch(page, SELECTORS.loggedOut)
  if (out) throw loginRequired()
  let text = ''
  try {
    text = typeof page.evaluate === 'function'
      ? await page.evaluate(() => (globalThis.document?.body?.innerText ?? '').slice(0, 4000))
      : ''
  } catch { text = '' }
  if (text && LOGIN_WALL_MARKERS.some((marker) => text.includes(marker))) throw loginRequired()
}

/**
 * 采集账号级指标：粉丝数、主页访问。
 *
 * 同日同账号只保留最后一次成功快照（与 B 站一致），覆盖由 store 负责。
 */
export async function collectAccount(lease, { runId, store } = {}) {
  const { page, signal } = lease
  await openDataCenter(page)
  await assertLoggedIn(page)
  if (signal?.aborted) return null

  // 两条取值路径：先按语义选择器，再退回正文标签就近取数。
  // 平台改版时 class 会变，但「粉丝总数 / 主页访问」这些文案相对稳定。
  const text = await bodyText(page)
  const followers = parseCount(await textOf(page, SELECTORS.followers)) ?? parseLabeledNumber(text, ['粉丝总数', '总粉丝', '粉丝数', '粉丝'])
  const profileVisits = parseCount(await textOf(page, SELECTORS.profileVisits)) ?? parseLabeledNumber(text, ['主页访问', '主页访客', '主页浏览量'])
  if (followers === null && profileVisits === null) {
    const evidence = await lease.evidence?.('douyin-account-data', runId).catch(() => null)
    throw selectorMissing(`抖音数据中心页没有可读的粉丝/访问数（页面可能改版或仍在加载）。当前页：${page.url()}`, evidence?.relativePath ?? null)
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
  const bound = contents.filter((row) => row.bound && (!wanted || wanted.has(row.contentId)))
  // 没有已绑定作品也要打开页面：绑定需要「平台作品列表」，而那份列表只能从这里读。
  // 之前这里提前 return，导致 bindAll 永远没有候选（鸡生蛋），
  // 内容级指标在 P2 上线后一直是 0 条。
  const unbound = contents.filter((row) => !row.bound && (!wanted || wanted.has(row.contentId)))
  if (!bound.length && !unbound.length) return []

  await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(4000)
  await assertLoggedIn(page)

  // 作品列表来源有两条，按可靠性排序：
  //  1. 平台「导出数据」——按作品一行、带完整标题与全部指标，最可靠；
  //  2. DOM 结构读取——页面不给作品 id、标题还会被拼接重复，只作兜底。
  let works = []
  let exportHeader = null
  const exported = await downloadExport(page).catch(() => null)
  if (exported?.text) {
    const parsed = worksFromExport(exported.text)
    exportHeader = parsed.header
    works = parsed.works
  }
  if (!works.length) {
    const rawWorks = await readWorksFromPage(page)
    if (!rawWorks.length) {
      const evidence = await lease.evidence?.('douyin-content-manage', runId).catch(() => null)
      throw selectorMissing(`抖音内容管理页没有读到作品，导出数据也没拿到（页面可能改版或仍在加载）。当前页：${page.url()}`, evidence?.relativePath ?? null)
    }
    works = rawWorks.map((work) => ({
      title: work.title,
      stats: work.stats,
      metrics: null,
      remoteId: videoIdFromHref(work.href),
      remoteUrl: work.href ? absoluteUrl(work.href) : null,
    }))
  }

  // 用平台列表给未绑定的本地内容做按标题绑定（宁可待绑定，也不静默绑错）。
  const boundNow = new Map()
  if (unbound.length) {
    const { matched } = bindByTitle(unbound, works)
    for (const row of matched) {
      await store.saveContents([row])
      boundNow.set(row.contentId, row)
    }
  }

  // 一条都没匹配上时留一份诊断证据：平台读到几条、标题与链接长什么样。
  // 「采集成功但没数据」最需要证据——2026-10-29 就是靠截图才定位到选择器失效。
  const matchedCount = works.filter((work) => bound.some((item) => item.title === work.title)
    || [...boundNow.values()].some((item) => item.title === work.title)).length
  if (!matchedCount && typeof lease.evidenceJson === 'function') {
    await lease.evidenceJson('douyin-works-diagnostic', {
      works: works.length,
      exportHeader,
      sampleMetrics: works.slice(0, 3).map((work) => ({ title: work.title.slice(0, 40), metrics: work.metrics })),
      withHref: works.filter((work) => work.remoteUrl).length,
      sample: works.slice(0, 5).map((work) => ({ title: work.title.slice(0, 60), remoteId: work.remoteId })),
      localTitles: contents.slice(0, 5).map((row) => String(row.title || '').slice(0, 60)),
    }).catch(() => null)
  }

  const collected = []
  for (const work of works) {
    // 标题精确匹配（归一化后）：宁可待绑定，也不静默绑错。
    const target = bound.find((item) => normalizeTitle(item.title) === normalizeTitle(work.title))
      ?? [...boundNow.values()].find((item) => normalizeTitle(item.title) === normalizeTitle(work.title))
    if (!target) continue
    const metrics = work.metrics ?? parseRowStats(work.stats)
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

/** 从作品链接里取 video id：`https://www.douyin.com/video/7412...` 或 `?modal_id=`。 */
export function videoIdFromHref(href) {
  const value = String(href ?? '')
  if (!value) return null
  const path = /\/video\/(\d{6,})/u.exec(value)
  if (path) return path[1]
  const query = /[?&](?:modal_id|vid|item_id)=(\d{6,})/u.exec(value)
  return query ? query[1] : null
}

function absoluteUrl(href) {
  const value = String(href ?? '')
  if (!value) return null
  if (/^https?:\/\//iu.test(value)) return value
  return `${ORIGIN}${value.startsWith('/') ? '' : '/'}${value}`
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
