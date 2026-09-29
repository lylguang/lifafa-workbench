import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'

const MAX_RESPONSE_BYTES = 1_500_000
const MAX_REDIRECTS = 3
const SIGNAL_SOURCE_KINDS = Object.freeze([
  'baidu-hot',
  'toutiao-hot',
  'douyin-hot',
  'bilibili-popular',
  'weibo-hot',
  'public-hot-list',
  'github-trending',
  'rss',
  'github-releases',
  'huggingface-papers',
  'ai-daily-json',
])

export const AI_DAILY_PLATFORMS = Object.freeze(['抖音', 'B站', '公众号', '小红书', '视频号'])

export const SOURCE_KIND_OPTIONS = Object.freeze([
  { id: 'baidu-hot', label: '百度实时热榜', description: '读取百度实时热榜的公开页面。' },
  { id: 'toutiao-hot', label: '今日头条热点', description: '读取今日头条公开热点榜。' },
  { id: 'douyin-hot', label: '抖音热榜', description: '读取抖音公开热榜。' },
  { id: 'bilibili-popular', label: 'B站热门内容', description: '读取 B 站公开热门内容。' },
  { id: 'weibo-hot', label: '微博热搜', description: '读取微博公开热搜。' },
  { id: 'public-hot-list', label: '公开热榜 JSON', description: '读取兼容 { code, data } 格式的公开热榜源。' },
  { id: 'github-trending', label: 'GitHub Trending', description: '读取 GitHub 每日 Trending 公开页面。' },
  { id: 'rss', label: 'RSS / Atom', description: '订阅公开 HTTPS RSS 或 Atom feed。' },
  { id: 'github-releases', label: 'GitHub Releases', description: '订阅指定 GitHub 仓库的 Releases Atom feed。' },
  { id: 'huggingface-papers', label: 'AI 论文日报 · Hugging Face', description: '读取 Hugging Face 的每日论文公开接口。' },
  { id: 'ai-daily-json', label: 'AI 日报 JSON', description: '读取符合口播视频包 AI 日报格式的公开 JSON 报告。' },
])

export const DEFAULT_SIGNAL_SOURCES = Object.freeze([
  {
    id: 'baidu', name: '百度热榜', kind: 'baidu-hot', url: 'https://top.baidu.com/board?tab=realtime',
    repository: null, enabled: true, intervalMinutes: 30, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['热点', '综合'], family: '公共热点',
  },
  {
    id: 'toutiao', name: '今日头条', kind: 'toutiao-hot', url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
    repository: null, enabled: true, intervalMinutes: 30, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['热点', '资讯'], family: '公共热点',
  },
  {
    id: 'douyin-hot', name: '抖音热榜', kind: 'douyin-hot', url: 'https://www.douyin.com/aweme/v1/web/hot/search/list/',
    repository: null, enabled: true, intervalMinutes: 30, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['抖音', '热榜'], family: '内容平台',
  },
  {
    id: 'bilibili-popular', name: 'B站热门内容', kind: 'bilibili-popular', url: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1',
    repository: null, enabled: true, intervalMinutes: 60, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['B站', '视频'], family: '内容平台',
  },
  {
    id: 'zhihu-hot', name: '知乎热榜', kind: 'public-hot-list', url: 'https://api.zxz.ee/api/hot/?type=zhihu',
    repository: null, enabled: true, intervalMinutes: 60, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['知乎', '讨论'], family: '内容平台',
  },
  {
    id: 'weibo-hot', name: '微博热搜', kind: 'weibo-hot', url: 'https://weibo.com/ajax/side/hotSearch',
    repository: null, enabled: true, intervalMinutes: 30, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['微博', '热搜'], family: '内容平台',
  },
  {
    id: 'huggingface-papers', name: 'AI 论文日报 · Hugging Face', kind: 'huggingface-papers', url: 'https://huggingface.co/api/daily_papers?limit=20',
    repository: null, enabled: true, intervalMinutes: 360, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['AI', '论文'], family: 'AI / 开源',
  },
  {
    id: '36kr', name: '36氪', kind: 'rss', url: 'https://www.36kr.com/feed',
    repository: null, enabled: true, intervalMinutes: 180, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['商业', '科技'], family: '科技与商业',
  },
  {
    id: 'infoq', name: 'InfoQ', kind: 'rss', url: 'https://www.infoq.cn/feed',
    repository: null, enabled: true, intervalMinutes: 180, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['技术', '开发'], family: '科技与商业',
  },
  {
    id: 'ithome', name: 'IT之家', kind: 'rss', url: 'https://www.ithome.com/rss/',
    repository: null, enabled: true, intervalMinutes: 120, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['科技', '数码'], family: '科技与商业',
  },
  {
    id: 'geekpark', name: '极客公园', kind: 'rss', url: 'https://www.geekpark.net/rss',
    repository: null, enabled: true, intervalMinutes: 180, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['科技', '创业'], family: '科技与商业',
  },
  {
    id: 'ifanr', name: '爱范儿', kind: 'rss', url: 'https://www.ifanr.com/feed',
    repository: null, enabled: true, intervalMinutes: 180, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['科技', '产品'], family: '科技与商业',
  },
  {
    id: 'sspai', name: '少数派', kind: 'rss', url: 'https://sspai.com/feed',
    repository: null, enabled: true, intervalMinutes: 240, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['效率', '产品'], family: '科技与商业',
  },
  {
    id: 'juejin', name: '掘金', kind: 'rss', url: 'https://juejin.cn/rss',
    repository: null, enabled: true, intervalMinutes: 180, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['开发', '技术'], family: '开发者社区',
  },
  {
    id: 'github-trending', name: 'GitHub Trending', kind: 'github-trending', url: 'https://github.com/trending?since=daily',
    repository: null, enabled: true, intervalMinutes: 360, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['开源', '开发'], family: 'AI / 开源',
  },
  {
    id: 'hacker-news', name: 'Hacker News', kind: 'rss', url: 'https://hnrss.org/frontpage',
    repository: null, enabled: true, intervalMinutes: 180, maxItems: 20, requiredKeywords: [], excludeKeywords: [], tags: ['海外', '科技'], family: '开发者社区',
  },
  {
    id: 'ai-daily-import', name: 'AI 内容日报', kind: 'ai-daily-json', url: 'https://scitiger.cn/reports/daily.json',
    repository: null, enabled: true, intervalMinutes: 60, maxItems: 200, requiredKeywords: [], excludeKeywords: [], tags: ['AI日报', '社媒情报'], family: 'AI 内容日报',
  },
])

export class SignalAdapterError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function failure(code, message) { return new SignalAdapterError(code, message) }
function cleanText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maxLength)
}
function cleanList(values, maxItems = 12, maxLength = 80) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map((value) => cleanText(value, maxLength)).filter(Boolean))].slice(0, maxItems)
}
function decodeEntities(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, (_, content) => String(content).replace(/</gu, '&lt;').replace(/>/gu, '&gt;'))
    .replace(/&nbsp;/giu, ' ')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/giu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
}
function stripHtml(value) {
  const raw = decodeEntities(String(value ?? ''))
  return cleanText(raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '), 3000)
}
function hash(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 32) }
function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true
  const private172 = /^172\.(\d+)\./u.exec(host)
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true
  return /^(?:fc|fd|fe80:)/iu.test(host)
}
function blockedAddress(address) { return blockedHostname(address) }

/** Validate an operator-configured public source URL before making a request. */
export async function assertPublicHttpsUrl(value, options = {}) {
  let url
  try { url = new URL(String(value)) } catch { throw failure('SIGNAL_SOURCE_URL_INVALID', '来源地址不是有效 URL。') }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw failure('SIGNAL_SOURCE_URL_UNSAFE', '来源地址必须是无凭据的公开 HTTPS 地址。')
  }
  if (blockedHostname(url.hostname)) throw failure('SIGNAL_SOURCE_URL_UNSAFE', '来源地址不能指向本机或私有网络。')
  const resolver = options.resolveHostname || lookup
  try {
    const records = await resolver(url.hostname, { all: true, verbatim: true })
    if (!Array.isArray(records) || records.length === 0 || records.some((record) => blockedAddress(record.address))) {
      throw failure('SIGNAL_SOURCE_URL_UNSAFE', '来源地址没有可用的公开网络地址。')
    }
  } catch (error) {
    if (error instanceof SignalAdapterError) throw error
    throw failure('SIGNAL_SOURCE_URL_UNRESOLVABLE', '来源地址无法解析为公开网络地址。')
  }
  return url
}

async function responseText(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (Number.isFinite(declared) && declared > limit) throw failure('SIGNAL_SOURCE_RESPONSE_TOO_LARGE', '来源响应过大。')
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > limit) throw failure('SIGNAL_SOURCE_RESPONSE_TOO_LARGE', '来源响应过大。')
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw failure('SIGNAL_SOURCE_RESPONSE_TOO_LARGE', '来源响应过大。')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock?.()
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Fetch a small public payload, validating every redirect target. */
export async function fetchPublicText(value, options = {}) {
  const fetcher = options.fetch || globalThis.fetch
  if (typeof fetcher !== 'function') throw failure('SIGNAL_SOURCE_FETCH_UNAVAILABLE', '当前主机不支持网络采集。')
  let url = await assertPublicHttpsUrl(value, options)
  const timeoutMs = Math.max(3_000, Math.min(Number(options.timeoutMs) || 20_000, 60_000))
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetcher(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          'user-agent': 'LWB-Spoken-Video-Signal/1.0 (+public-source-collector)',
          accept: 'application/json,application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.8,*/*;q=0.5',
          ...(options.headers || {}),
        },
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw failure('SIGNAL_SOURCE_TIMEOUT', '来源请求超时。')
      throw failure('SIGNAL_SOURCE_FETCH_FAILED', `来源请求失败：${cleanText(error?.message || '未知网络错误', 180)}`)
    } finally { clearTimeout(timer) }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location')
      if (!location) throw failure('SIGNAL_SOURCE_REDIRECT_INVALID', '来源重定向缺少目标地址。')
      url = await assertPublicHttpsUrl(new URL(location, url).toString(), options)
      continue
    }
    if (response.status === 304) {
      return {
        url: url.toString(), text: '', status: response.status,
        etag: response.headers?.get?.('etag') || null,
        lastModified: response.headers?.get?.('last-modified') || null,
        contentType: response.headers?.get?.('content-type') || null,
      }
    }
    const text = await responseText(response, options.maxBytes || MAX_RESPONSE_BYTES)
    if (!response.ok) throw failure('SIGNAL_SOURCE_HTTP_ERROR', `来源返回 HTTP ${response.status}。`)
    return {
      url: url.toString(), text, status: response.status,
      etag: response.headers?.get?.('etag') || null,
      lastModified: response.headers?.get?.('last-modified') || null,
      contentType: response.headers?.get?.('content-type') || null,
    }
  }
  throw failure('SIGNAL_SOURCE_REDIRECT_LIMIT', '来源重定向次数过多。')
}

function signalUrl(value, base) {
  if (!value) return null
  try {
    const url = new URL(String(value), base)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch { return null }
}
function normalizeNumber(value) {
  const raw = String(value ?? '').replace(/,/gu, '').trim()
  if (!raw) return null
  let multiplier = 1
  if (/万/u.test(raw)) multiplier = 10_000
  else if (/亿/u.test(raw)) multiplier = 100_000_000
  else if (/k/iu.test(raw)) multiplier = 1_000
  else if (/m/iu.test(raw)) multiplier = 1_000_000
  const number = Number(raw.replace(/[^\d.]/gu, ''))
  return Number.isFinite(number) ? Math.round(number * multiplier) : null
}
function dateIso(value) {
  const timestamp = Date.parse(String(value ?? ''))
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}
function candidate(value, fallback = {}) {
  const title = cleanText(value?.title, 240)
  if (!title) return null
  return {
    title,
    summary: cleanText(value?.summary, 600),
    url: signalUrl(value?.url, fallback.url),
    publishedAt: dateIso(value?.publishedAt),
    rank: Number.isSafeInteger(value?.rank) && value.rank > 0 ? value.rank : null,
    hotValue: Number.isFinite(Number(value?.hotValue)) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(Number(value.hotValue)))) : null,
    tags: cleanList(value?.tags, 8, 32),
    platform: cleanText(value?.platform, 32) || null,
  }
}

const KIND_PLATFORMS = Object.freeze({ 'douyin-hot': '抖音', 'bilibili-popular': 'B站', 'weibo-hot': '微博' })

/** Platform dimension for the signal board cards; null when the source is not platform-bound. */
export function platformForSource(sourceId, kind) {
  if (sourceId === 'zhihu-hot') return '知乎'
  return KIND_PLATFORMS[kind] || null
}

/** Structure Hacker News style feed descriptions: Points → hotValue, URLs out of the summary. */
function structureFeedSummary(summary) {
  const points = /Points:\s*([\d,]+)/iu.exec(summary)
  const comments = /#\s*Comments:\s*([\d,]+)/iu.exec(summary)
  if (!points && !comments) return { summary, hotValue: null }
  const cleaned = summary
    .replace(/Article URL:\s*\S+/giu, ' ')
    .replace(/Comments URL:\s*\S+/giu, ' ')
    .replace(/Points:\s*[\d,]+/giu, ' ')
    .replace(/#\s*Comments:\s*[\d,]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const hotValue = points ? normalizeNumber(points[1]) : null
  const meta = [hotValue != null ? `${hotValue} points` : '', comments ? `${comments[1]} 评论` : ''].filter(Boolean).join(' · ')
  return { summary: cleaned || (meta ? `社区讨论 · ${meta}` : ''), hotValue }
}
function decodeJsonScriptText(value) {
  return String(value ?? '').replace(/&quot;/giu, '"').replace(/&#34;/giu, '"').replace(/&amp;/giu, '&').replace(/\\u002F/giu, '/')
}

export function parseBaiduHotList(html) {
  const marker = '<!--s-data:'
  const entries = []
  let cursor = 0
  while (cursor < html.length) {
    const start = html.indexOf(marker, cursor)
    if (start < 0) break
    const end = html.indexOf('-->', start + marker.length)
    if (end < 0) break
    cursor = end + 3
    try {
      const payload = JSON.parse(decodeJsonScriptText(html.slice(start + marker.length, end)))
      for (const card of payload?.data?.cards || []) {
        for (const item of Array.isArray(card?.content) ? card.content : []) {
          entries.push(candidate({
            title: item.query || item.word || item.title,
            summary: stripHtml(item.desc || item.show?.join?.(' ') || ''),
            url: item.rawUrl || item.url || item.appUrl,
            rank: Number(item.index ?? entries.length) + 1,
            hotValue: normalizeNumber(item.hotScore), tags: typeof item.hotTag === 'string' && item.hotTag.trim() && !/^\d+$/u.test(item.hotTag) ? [item.hotTag.trim()] : [],
          }))
        }
      }
    } catch (_) {}
  }
  return dedupeCandidates(entries)
}

export function parseToutiaoHotList(value) {
  const items = Array.isArray(value?.data) ? value.data : []
  return dedupeCandidates(items.map((item, index) => candidate({
    title: item.Title || item.QueryWord,
    summary: item.Label || '', url: item.Url || '', rank: index + 1,
    hotValue: normalizeNumber(item.HotValue), tags: Array.isArray(item.InterestCategory) ? item.InterestCategory : [],
  })))
}

export function parseDouyinHotList(value) {
  const items = Array.isArray(value?.data?.word_list) ? value.data.word_list : []
  return dedupeCandidates(items.map((item, index) => {
    const word = cleanText(item.word || item.sentence || item.title, 240)
    const groupId = cleanText(item.group_id || item.sentence_id, 80)
    return candidate({
      title: word,
      summary: [
        item.video_count ? `${item.video_count} 条相关视频` : '',
        item.discuss_video_count ? `${item.discuss_video_count} 条讨论视频` : '',
      ].filter(Boolean).join(' · '),
      url: word ? `https://www.douyin.com/search/${encodeURIComponent(word)}${groupId ? `?modal_id=${encodeURIComponent(groupId)}` : ''}` : '',
      publishedAt: item.event_time ? new Date(Number(item.event_time) * 1_000).toISOString() : null,
      rank: Number(item.position || index + 1), hotValue: normalizeNumber(item.hot_value), tags: ['抖音热榜'],
    })
  }))
}

export function parseBilibiliPopular(value) {
  const items = Array.isArray(value?.data?.list) ? value.data.list : []
  return dedupeCandidates(items.map((item, index) => {
    const stat = item?.stat || {}
    const bvid = cleanText(item.bvid, 40)
    const author = cleanText(item?.owner?.name, 80)
    const category = cleanText(item.tnamev2 || item.tname, 40)
    return candidate({
      title: item.title,
      summary: [item.desc, author ? `UP 主：${author}` : '', stat.view ? `播放 ${stat.view}` : '', stat.like ? `点赞 ${stat.like}` : ''].filter(Boolean).join(' · '),
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : item.short_link_v2 || '',
      publishedAt: item.pubdate ? new Date(Number(item.pubdate) * 1_000).toISOString() : null,
      rank: index + 1, hotValue: stat.view || stat.like || null, tags: [category || 'B站'],
    })
  }))
}

export function parseWeiboHotList(value) {
  const body = value && typeof value === 'object' ? value : {}
  const items = Array.isArray(body?.data?.realtime) ? body.data.realtime : []
  return dedupeCandidates(items.map((item, index) => {
    const word = cleanText(item.word || item.note || item.word_scheme, 240)
    return candidate({
      title: word,
      summary: [item.label_name, item.icon_desc, item.flag === 1 ? '热搜' : ''].filter(Boolean).join(' · '),
      url: word ? `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${word}#`)}` : '',
      rank: Number(item.realpos || item.rank || index + 1), hotValue: normalizeNumber(item.num), tags: ['微博热搜'],
    })
  }))
}

export function parsePublicHotList(value) {
  const body = value && typeof value === 'object' ? value : {}
  if (typeof body.code === 'number' && body.code !== 200) throw failure('SIGNAL_SOURCE_PROVIDER_ERROR', `公开热榜返回异常：${cleanText(body.msg || body.message || String(body.code), 160)}`)
  const items = Array.isArray(body.data) ? body.data : []
  return dedupeCandidates(items.map((item, index) => candidate({
    title: item.title || item.name || item.word || item.query,
    summary: item.desc || item.description || item.summary || item.extra || '',
    url: item.link || item.url || item.mobileUrl || item.pcUrl || '',
    rank: Number(item.rank || item.index || index + 1), hotValue: normalizeNumber(item.hot || item.hot_value || item.score || item.extra), tags: [item.category || item.type || '热榜'],
  })))
}

export function parseGithubTrending(html) {
  const entries = []
  for (const match of String(html).matchAll(/<article\b[\s\S]*?<\/article>/giu)) {
    const article = match[0]
    const link = /<h2[^>]*>[\s\S]*?<a[^>]+href=["']\/([^"']+)["'][^>]*>/iu.exec(article)?.[1]
    if (!link || !link.includes('/')) continue
    const description = /<p[^>]*>([\s\S]*?)<\/p>/iu.exec(article)?.[1] || ''
    const language = /itemprop=["']programmingLanguage["'][^>]*>([\s\S]*?)<\/span>/iu.exec(article)?.[1] || ''
    const stars = /([\d,.]+[kKmM]?)\s+stars today/iu.exec(stripHtml(article))?.[1] || ''
    entries.push(candidate({ title: link.replace(/\s+/gu, ''), summary: [stripHtml(description), stripHtml(language)].filter(Boolean).join(' · '), url: `https://github.com/${link}`, rank: entries.length + 1, hotValue: normalizeNumber(stars), tags: [stripHtml(language) || '开源'] }))
  }
  return dedupeCandidates(entries)
}

function xmlTag(block, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}(?=[\\s>])[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${name}>`, 'iu').exec(block)
    if (match) return stripHtml(match[1])
  }
  return ''
}
function xmlLink(block, base) {
  const atom = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/iu.exec(block)
  if (atom) return signalUrl(decodeEntities(atom[1]), base)
  return signalUrl(xmlTag(block, ['link']), base)
}
function xmlCategories(block) {
  const tags = []
  for (const match of block.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>|<category\b([^>]*)\/?\s*>/giu)) {
    const attributes = `${match[1] || ''} ${match[3] || ''}`
    const term = /\bterm=["']([^"']+)["']/iu.exec(attributes)?.[1] || match[2] || ''
    const normalized = stripHtml(term)
    if (normalized) tags.push(normalized)
  }
  return cleanList(tags, 8, 32)
}

export function parseFeed(xml, sourceUrl) {
  const blocks = [
    ...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu),
    ...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/giu),
  ].map((match) => match[1])
  return dedupeCandidates(blocks.map((block, index) => {
    const structured = structureFeedSummary(xmlTag(block, ['description', 'summary', 'content:encoded', 'content']))
    return candidate({
      title: xmlTag(block, ['title']),
      summary: structured.summary,
      ...(structured.hotValue != null ? { hotValue: structured.hotValue } : {}),
      url: xmlLink(block, sourceUrl),
      publishedAt: xmlTag(block, ['pubDate', 'published', 'updated', 'dc:date']),
      rank: index + 1, tags: xmlCategories(block),
    }, { url: sourceUrl })
  }))
}

export function parseHuggingFaceDailyPapers(value) {
  const papers = Array.isArray(value) ? value : []
  return dedupeCandidates(papers.map((entry, index) => {
    const paper = entry?.paper || entry || {}
    const id = cleanText(paper.id || entry?.paper_id, 120)
    const authors = Array.isArray(paper.authors) ? paper.authors.map((author) => cleanText(author?.name, 80)).filter(Boolean).slice(0, 5).join('、') : ''
    return candidate({
      title: paper.title, summary: [paper.summary || paper.abstract, authors ? `作者：${authors}` : ''].filter(Boolean).join('\n'),
      url: id ? `https://huggingface.co/papers/${id}` : null,
      publishedAt: paper.publishedAt || paper.published_at || entry?.published_at,
      rank: index + 1, hotValue: entry?.upvotes || paper?.upvotes, tags: Array.isArray(paper.tags) ? paper.tags : ['论文'],
    })
  }))
}

function normalizeAiDailyPlatform(value) {
  const normalized = cleanText(value, 80).toLowerCase().replace(/[\s-]+/gu, '_')
  if (!normalized) return ''
  if (normalized.includes('douyin') || normalized.includes('抖音')) return '抖音'
  if (normalized.includes('bilibili') || normalized.includes('bili') || normalized.includes('b站')) return 'B站'
  if (normalized.includes('xiaohongshu') || normalized.includes('xhs') || normalized.includes('小红书')) return '小红书'
  if (normalized.includes('wechat') || normalized.includes('weixin') || normalized.includes('gzh') || normalized.includes('公众号') || normalized.includes('微信')) return '公众号'
  if (normalized.includes('video_channel') || normalized.includes('视频号')) return '视频号'
  if (normalized.includes('zhihu') || normalized.includes('知乎')) return '知乎'
  return cleanText(value, 32)
}

/** Normalize the AI Daily report artifact emitted by the reference my-agent workflow. */
export function parseAiDailyReport(value) {
  const body = value && typeof value === 'object' ? value : {}
  const entries = []
  for (const [platformKey, values] of Object.entries(body.items_by_platform || {})) {
    const platform = normalizeAiDailyPlatform(platformKey)
    for (const item of Array.isArray(values) ? values : []) entries.push({ item, platform })
  }
  for (const item of Array.isArray(body.trending_topics) ? body.trending_topics : []) entries.push({ item, platform: normalizeAiDailyPlatform(item.platform || item.source_platform) })
  return dedupeCandidates(entries.map(({ item, platform }, index) => candidate({
    title: item.title || item.name,
    summary: [item.summary, item.author ? `作者：${item.author}` : '', platform ? `${platform} AI 日报` : 'AI 日报'].filter(Boolean).join(' · '),
    url: item.url || item.link || '', publishedAt: item.published_at || item.created_at,
    rank: Number(item.rank || index + 1), hotValue: normalizeNumber(item.hot_value || item.hot || item.metrics), tags: ['AI日报', platform || '社媒'],
    platform: platform || null,
  })))
}

export function fingerprintSignal(value) {
  const url = signalUrl(value?.url)
  if (url) {
    const canonical = new URL(url)
    for (const key of [...canonical.searchParams.keys()]) {
      if (/^(?:utm_|spm$|from$|source$|share_)/iu.test(key)) canonical.searchParams.delete(key)
    }
    canonical.hash = ''
    return `url:${hash(canonical.toString())}`
  }
  const title = cleanText(value?.title, 240).toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '')
  return `title:${hash(title || String(value?.sourceId || 'unknown'))}`
}

export function dedupeCandidates(values) {
  const result = []
  const keys = new Set()
  for (const value of values) {
    if (!value?.title) continue
    const key = fingerprintSignal(value)
    if (keys.has(key)) continue
    keys.add(key)
    result.push(value)
  }
  return result
}

function passesFilters(value, source) {
  const content = `${value.title}\n${value.summary}`.toLowerCase()
  if (source.excludeKeywords.some((keyword) => content.includes(keyword.toLowerCase()))) return false
  return source.requiredKeywords.every((keyword) => content.includes(keyword.toLowerCase()))
}

export function scoreSignal(value) {
  let score = 40
  if (value.rank) score += Math.max(0, 30 - Math.min(30, value.rank))
  if (value.hotValue) score += Math.min(15, Math.round(Math.log10(value.hotValue + 1) * 3))
  if (value.publishedAt) {
    const hours = Math.max(0, (Date.now() - Date.parse(value.publishedAt)) / 3_600_000)
    if (hours <= 6) score += 15
    else if (hours <= 24) score += 10
    else if (hours <= 72) score += 5
  }
  return Math.max(0, Math.min(100, score))
}

/** Collect normalized public candidates for one configured source. */
export async function collectSignalSource(source, options = {}) {
  if (!SIGNAL_SOURCE_KINDS.includes(source?.kind)) throw failure('SIGNAL_SOURCE_KIND_INVALID', '不支持的信号来源类型。')
  const startedAt = options.now?.() || new Date().toISOString()
  const requestUrl = source.kind === 'github-releases'
    ? `https://github.com/${source.repository}/releases.atom`
    : source.url
  const headers = {}
  if (source.cache?.etag) headers['if-none-match'] = source.cache.etag
  if (source.cache?.lastModified) headers['if-modified-since'] = source.cache.lastModified
  const providerHeaders = source.kind === 'douyin-hot'
    ? { referer: 'https://www.douyin.com/hot', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
    : source.kind === 'bilibili-popular'
      ? { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }
      : source.kind === 'weibo-hot'
        ? { referer: 'https://weibo.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
      : {}
  const response = await fetchPublicText(requestUrl, { ...options, headers: { ...headers, ...providerHeaders } })
  if (response.status === 304) {
    return {
      startedAt, completedAt: options.now?.() || new Date().toISOString(), status: 'skipped', httpStatus: response.status,
      etag: response.etag || source.cache?.etag || null,
      lastModified: response.lastModified || source.cache?.lastModified || null, fetched: [], filteredCount: 0,
    }
  }
  let fetched
  if (source.kind === 'baidu-hot') fetched = parseBaiduHotList(response.text)
  else if (source.kind === 'toutiao-hot') fetched = parseToutiaoHotList(JSON.parse(response.text))
  else if (source.kind === 'douyin-hot') fetched = parseDouyinHotList(JSON.parse(response.text))
  else if (source.kind === 'bilibili-popular') fetched = parseBilibiliPopular(JSON.parse(response.text))
  else if (source.kind === 'weibo-hot') fetched = parseWeiboHotList(JSON.parse(response.text))
  else if (source.kind === 'public-hot-list') fetched = parsePublicHotList(JSON.parse(response.text))
  else if (source.kind === 'github-trending') fetched = parseGithubTrending(response.text)
  else if (source.kind === 'huggingface-papers') fetched = parseHuggingFaceDailyPapers(JSON.parse(response.text))
  else if (source.kind === 'ai-daily-json') fetched = parseAiDailyReport(JSON.parse(response.text))
  else fetched = parseFeed(response.text, response.url)
  const filtered = fetched.filter((item) => passesFilters(item, source)).slice(0, source.maxItems)
  return {
    startedAt, completedAt: options.now?.() || new Date().toISOString(), status: 'success', httpStatus: response.status,
    etag: response.etag, lastModified: response.lastModified, fetched: filtered, filteredCount: fetched.length - filtered.length,
  }
}
