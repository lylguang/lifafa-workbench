/**
 * 素材真实采集源：让「来源地址」是抓来的，不是模型编的。
 *
 * 为什么要这一层：
 * 采集层原本把整件事交给 LLM——「你去网上找素材」。但模型给不出可核对的
 * 链接，它给出的 sourceUrl 要么是编的，要么是凭记忆写的。这两条路都会撞上
 * 素材层的底线：**没有来源地址的条目直接丢弃**。于是每轮采集的结果几乎
 * 必然是空，界面上只剩一句「没有找到可入库的素材」。
 *
 * 口播视频包已经踩过并解决了同一个问题：它的「信号」不是模型给的，是
 * 适配器真实抓回来的（spoken-video-signal-adapters.mjs）——真实 HTTPS、
 * 公开源白名单、URL 规范化、指纹去重，每条都带可回访的地址。
 *
 * 这一层就是故事素材版的同一套做法，但目标不同：
 *
 *   口播包的信号是「**热点事件**」——今天什么在涨；
 *   故事素材要的是「**具体的人和原话**」——谁在什么场景说了什么。
 *
 * 所以这里的源不是热榜，而是能给出真实原话的公开社区：
 *   - 网易云音乐热评：一段真实的人话 + 点赞数 + 指向那条评论的链接；
 *   - B 站热门视频的评论：同上；
 *   - 今日头条热榜：账号关心的现实议题（公共事件，带链接）。
 *
 * 与素材层的关系：抓回来的每条都已经是「可追溯的候选素材」，
 * 交给 agent 做的是**筛选与提炼**（这条能不能撑起故事、场景是什么、
 * 最扎人的那句是哪句），而不是**从零想出出处**。出处由这里保证。
 */

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'

const MAX_RESPONSE_BYTES = 1_500_000
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 20_000

/**
 * 默认 UA 用普通浏览器标识，而不是自报身份的采集器 UA。
 *
 * 实测：不少中文站点（B 站热榜接口是最明显的一个）会对自曝爬虫的 UA
 * 直接降级——B 站返回 `{"code":-352}`，正文只有 39 字节，看起来像"没数据"，
 * 实际上是风控在拦。用一个常规 UA 拿到的就是完整数据。
 *
 * 代价是这个 UA 会被记成一次普通浏览请求。这是可接受的：这些都是公开页面，
 * 采集频率低（一次一轮），不构成压力。
 */
export const DEFAULT_SOURCE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export class StorySourceError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function failure(code, message) { return new StorySourceError(code, message) }

function cleanText(value, maximum = 1000) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function stripHtml(value) {
  return cleanText(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '), 3000)
}

function blockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/u, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true
  const private172 = /^172\.(\d+)\./u.exec(host)
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true
  return /^(?:fc|fd|fe80:)/iu.test(host)
}

/**
 * 解析出来的地址是不是内网/保留段。
 *
 * 198.18.0.0/15 是基准测试保留段（RFC 2544），本机的 DNS 代理常用它来
 * 映射公网域名——把这一段当内网拦掉，等于把所有走代理的源全毙了。
 * 真正的 SSRF 风险在 10/8、172.16/12、192.168/16 与回环段，那些照拦。
 */
function blockedAddress(address) {
  const value = String(address || '').trim()
  if (blockedHostname(value)) return true
  if (/^198\.1[89]\./u.test(value)) return false
  if (/^198\.51\.100\./u.test(value)) return true
  if (/^203\.0\.113\./u.test(value)) return true
  return false
}

/**
 * 只允许公开 HTTPS 源。素材层是唯一事实来源，它抓回来的每个地址将来都要
 * 被人点开核对——指向本机或私有网络的地址既不可核对也不该被采集。
 */
export async function assertPublicHttpsUrl(value, options = {}) {
  let url
  try { url = new URL(String(value)) } catch { throw failure('STORY_SOURCE_URL_INVALID', '来源地址不是有效 URL。') }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw failure('STORY_SOURCE_URL_UNSAFE', '来源地址必须是无凭据的公开 HTTPS 地址。')
  }
  if (blockedHostname(url.hostname)) throw failure('STORY_SOURCE_URL_UNSAFE', '来源地址不能指向本机或私有网络。')
  const resolver = options.resolveHostname || lookup
  try {
    const records = await resolver(url.hostname, { all: true, verbatim: true })
    if (!Array.isArray(records) || records.length === 0 || records.some((record) => blockedAddress(record.address))) {
      throw failure('STORY_SOURCE_URL_UNSAFE', '来源地址没有可用的公开网络地址。')
    }
  } catch (error) {
    if (error instanceof StorySourceError) throw error
    throw failure('STORY_SOURCE_URL_UNRESOLVABLE', '来源地址无法解析为公开网络地址。')
  }
  return url
}

async function responseText(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (Number.isFinite(declared) && declared > limit) throw failure('STORY_SOURCE_RESPONSE_TOO_LARGE', '来源响应过大。')
  const reader = response.body?.getReader
    ? response.body.getReader()
    : null
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > limit) throw failure('STORY_SOURCE_RESPONSE_TOO_LARGE', '来源响应过大。')
    return text
  }
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw failure('STORY_SOURCE_RESPONSE_TOO_LARGE', '来源响应过大。')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock?.()
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** 抓一个公开源，校验每个重定向目标。 */
export async function fetchPublicText(value, options = {}) {
  const fetcher = options.fetch || globalThis.fetch
  if (typeof fetcher !== 'function') throw failure('STORY_SOURCE_FETCH_UNAVAILABLE', '当前主机不支持网络采集。')
  let url = await assertPublicHttpsUrl(value, options)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let response
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': options.userAgent || DEFAULT_SOURCE_USER_AGENT,
          accept: 'application/json,text/html;q=0.9,*/*;q=0.5',
          ...(options.headers || {}),
        },
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw failure('STORY_SOURCE_TIMEOUT', '来源请求超时。')
      throw failure('STORY_SOURCE_FETCH_FAILED', `来源请求失败：${cleanText(error?.message || '未知网络错误', 180)}`)
    } finally { clearTimeout(timer) }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location')
      if (!location) throw failure('STORY_SOURCE_REDIRECT_INVALID', '来源重定向缺少目标地址。')
      url = await assertPublicHttpsUrl(new URL(location, url).toString(), options)
      continue
    }
    const text = await responseText(response, options.maxBytes || MAX_RESPONSE_BYTES)
    if (!response.ok) throw failure('STORY_SOURCE_HTTP_ERROR', `来源返回 HTTP ${response.status}。`)
    return { url: url.toString(), text, status: response.status, contentType: response.headers?.get?.('content-type') || null }
  }
  throw failure('STORY_SOURCE_REDIRECT_LIMIT', '来源重定向次数过多。')
}

/**
 * URL 规范化 + 指纹。
 *
 * 规范化是必须的：同一个评论，链接里可能带不同的追踪参数，不先做归一化，
 * 去重就删不干净；指纹则用来认「同一条素材」——哪怕链接变了也认得。
 */
export function canonicalSourceUrl(value) {
  try {
    const url = new URL(String(value))
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|spm$|from$|source$|share_|log_pb$|category_name$|event_type$|hot_board_)/iu.test(key)) url.searchParams.delete(key)
    }
    // 锚点是路由时必须留着，否则出处会退化成"只有域名"：
    // 网易云是 #/song?id=…&commentid=…，B 站是 #reply<rpid>。
    if (!/^#(?:\/song\b|reply\d+)/u.test(url.hash)) url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function fingerprintSource(value) {
  const url = canonicalSourceUrl(value)
  const basis = url || String(value ?? '')
  return `url:${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`
}

/* ────────────────────────────── 采集源 ────────────────────────────── */

/**
 * 灌水与玩梗的评论。
 *
 * 热榜评论里这类占比很高（"前排""打卡""收藏了"）。它们没有信息量，
 * 却会挤占 agent 的注意力预算，还把真正能撑起故事的素材挤到后面。
 * 门槛放在采集层而不是 agent 那一层——agent 的注意力比这里贵得多。
 */
const NOISE_COMMENT = /打卡|签到|沙发|前排|占楼|收藏了|三连|投币|一键三连|好歌|好听|音质|耳机|专辑|循环|翻唱|cover|哈哈|233|666|早安|晚安|今日份|已阅|主播|网易云|云村|插画版|现场版|钢琴版|纯音乐|remix|伴奏|教程|扒谱|应援|开箱|测评|安利|新歌|定档|巡演|演出|购票|恭喜|祝福|祝大家|祝各位|支持|爱你|关注|好运|暴富|财神/gu

/** 视频标题里出现这些词，评论区才可能装着情感故事。 */
const FAMILY_VIDEO = /家|爸|妈|父母|女儿|儿子|老婆|老公|妻子|丈夫|婚姻|离婚|结婚|婆婆|儿媳|孩子|娃|奶奶|爷爷|婆媳|催婚|相亲|亲情|孤独|一个人|长大|离开|回家/gu

/** 头条热榜里与账号题材无关的类别（国际、军事、体育、财经）。 */
const OFF_TOPIC = /国防|美军|日美|海峡|航母|军演|部队|强震|地震|进球|比赛|球员|奥运|世界杯|冠军|股票|股价|上市|财报|汇率|通胀|总统|外交|峰会|导弹|战机|台风|洪水/gu

/** 头条热榜里与账号题材相关的词。 */
const FAMILY_EVENT = /爸|妈|父母|孩子|女儿|儿子|婚姻|离婚|结婚|老人|奶奶|爷爷|婆|媳|养老|催婚|婆婆|媳妇|家庭|孤儿|单亲|留守/gu

/**
 * 网易云音乐热评。
 *
 * 为什么是它：一段热评就是**一个人写下的具体处境**，而且带点赞数——
 * 点赞数是「多少人认这句话」的客观信号，可以直接用来排序。
 * 链接指到那条评论本身（commentid），点开就能核对原文。
 */
export async function collectNeteaseComments({ limit = 12, fetch: fetcher } = {}) {
  const options = { fetch: fetcher, headers: { referer: 'https://music.163.com/' } }
  // 榜单拉不到就是源级失败，必须抛出去：静默变成"0 条"会让人以为
  // 这个源今天没有内容，而不是这个源挂了。
  const playlist = await fetchPublicText('https://music.163.com/api/playlist/detail?id=3778678', options)
  let tracks = []
  try { tracks = JSON.parse(playlist.text)?.result?.tracks || [] } catch { tracks = [] }
  const items = []
  const seen = new Set()
  for (const track of tracks) {
    if (items.length >= limit) break
    if (!track?.id || !track?.name) continue
    let payload = null
    try {
      const response = await fetchPublicText(`https://music.163.com/api/v1/resource/comments/R_SO_4_${track.id}?limit=20&offset=0`, options)
      payload = JSON.parse(response.text)
    } catch { continue }
    for (const comment of payload.hotComments || []) {
      if (items.length >= limit) break
      const content = cleanText(comment?.content, 900)
      if (content.length < 16) continue
      if (NOISE_COMMENT.test(content)) continue
      const sourceUrl = canonicalSourceUrl(`https://music.163.com/#/song?id=${track.id}&commentid=${comment.commentId}`)
      if (!sourceUrl) continue
      const fingerprint = fingerprintSource(sourceUrl)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      items.push({
        title: `《${cleanText(track.name, 60)}》热评「${content.slice(0, 12)}…」`,
        content,
        kind: 'qa-answer',
        sourceUrl,
        note: `网易云音乐热评，${Number(comment.likedCount) || 0} 人点赞`,
        sceneHint: null,
        keyLineHint: content.slice(0, 36),
        hotValue: Number(comment.likedCount) || 0,
        sourceName: '网易云音乐热评',
      })
    }
  }
  return items
}

/**
 * B 站热门视频的评论。
 *
 * 和网易云互补：B 站的评论更短更口语，常有一句话就能立住一个人的处境。
 * 同样指到那条评论（#reply<rpid>）。
 *
 * 只扫标题命中「家庭/情感」的视频：全站热榜里绝大多数是游戏、美食、技术，
 * 它们的评论区跟情感故事没有关系，扫了只是白跑。
 */
export async function collectBilibiliComments({ limit = 12, fetch: fetcher } = {}) {
  const options = { fetch: fetcher }
  const items = []
  const seen = new Set()
  const pool = []
  for (const rid of [160, 0]) {
    let payload = null
    try {
      const response = await fetchPublicText(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, options)
      payload = JSON.parse(response.text)
    } catch { continue }
    for (const video of payload?.data?.list || []) {
      if (video?.bvid && video?.aid) pool.push(video)
    }
  }
  if (!pool.length) throw failure('STORY_SOURCE_EMPTY_POOL', '没有取到任何热门视频。')
  // 先按视频标题筛：只看家庭与情感向的，其余评论区与本赛道无关。
  const candidates = pool.filter((video) => FAMILY_VIDEO.test(String(video.title || '')))
  for (const video of candidates) {
    if (items.length >= limit) break
    let offset = ''
    for (let page = 0; page < 2; page += 1) {
      let payload = null
      try {
        const pagination = encodeURIComponent(JSON.stringify(offset ? { offset } : {}))
        const response = await fetchPublicText(
          `https://api.bilibili.com/x/v2/reply/main?oid=${video.aid}&type=1&mode=3&pagination_str=${pagination}&plat=1&web_location=1315875`,
          { ...options, headers: { referer: `https://www.bilibili.com/video/${video.bvid}` } },
        )
        payload = JSON.parse(response.text)
      } catch { break }
      for (const reply of payload?.data?.replies || []) {
        if (items.length >= limit) break
        const content = cleanText(reply?.content?.message, 900)
        if (content.length < 16) continue
        if (NOISE_COMMENT.test(content)) continue
        const sourceUrl = canonicalSourceUrl(`https://www.bilibili.com/video/${video.bvid}/#reply${reply.rpid}`)
        if (!sourceUrl) continue
        const fingerprint = fingerprintSource(sourceUrl)
        if (seen.has(fingerprint)) continue
        seen.add(fingerprint)
        items.push({
          title: `${cleanText(video.title, 40)}｜热评「${content.slice(0, 12)}…」`,
          content,
          kind: 'news-comment',
          sourceUrl,
          note: `B 站热榜视频《${cleanText(video.title, 30)}》下 ${Number(reply.like) || 0} 赞热评`,
          sceneHint: null,
          keyLineHint: content.slice(0, 36),
          hotValue: Number(reply.like) || 0,
          sourceName: 'B 站视频热评',
        })
      }
      offset = payload?.data?.cursor?.pagination_reply?.next_offset
      if (!offset || items.length >= limit) break
    }
  }
  return items
}

/**
 * 今日头条热榜里的现实议题。
 *
 * 与前两个源不同：它给的是事件而不是原话。账号要处理的是「现实里正在发生
 * 什么」，这条事件是选题的由头；真正的人话仍从前两个源里来。
 */
export async function collectToutiaoEvents({ limit = 6, fetch: fetcher } = {}) {
  const options = { fetch: fetcher }
  // 源级失败要抛出去：吞掉只会让界面显示"这个源今天没内容"，
  // 而真相是"这个源挂了"。空与坏必须区分开。
  const response = await fetchPublicText('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', options)
  let payload = null
  try { payload = JSON.parse(response.text) } catch { payload = null }
  const items = []
  for (const entry of payload?.data || []) {
    if (items.length >= limit) break
    const title = cleanText(entry?.Title, 160)
    if (!title) continue
    // 热榜里绝大多数是国际、军事、体育、财经——跟情感故事无关。
    // 只收与家庭、婚恋、养老相关的现实议题。
    if (!FAMILY_EVENT.test(title)) continue
    if (OFF_TOPIC.test(title)) continue
    const sourceUrl = canonicalSourceUrl(entry.Url || entry.LabelUrl)
    if (!sourceUrl) continue
    items.push({
      title,
      content: `今日头条热榜（热度 ${Number(entry.HotValue) || 0}）事件：${title}。`,
      kind: 'news-comment',
      sourceUrl,
      note: '今日头条热榜公共事件',
      sceneHint: null,
      keyLineHint: title.slice(0, 28),
      hotValue: Number(entry.HotValue) || 0,
      sourceName: '今日头条热榜',
    })
  }
  return items
}

/** 全部真实采集源。顺序即可信度：先给人话，再给事件。 */
export const STORY_MATERIAL_SOURCE_COLLECTORS = Object.freeze([
  { id: 'netease-comments', name: '网易云音乐热评', collect: collectNeteaseComments },
  { id: 'bilibili-comments', name: 'B 站视频热评', collect: collectBilibiliComments },
  { id: 'toutiao-hot', name: '今日头条热榜', collect: collectToutiaoEvents },
])

/**
 * 跑一轮真实采集。
 *
 * 返回的是**候选素材**：出处已经可靠，但「能不能撑起一条故事」还没判断——
 * 那是 agent 的活。这里只负责把「有出处的真实原话」放到桌面上。
 *
 * 两条取舍：
 *
 * 1. **按热度排序**：点赞数是「多少人认这句话」的客观信号。二十条冷门评论
 *    和一条十万赞的评论摆在 agent 面前，价值不是一个量级。
 * 2. **宁少勿滥**：热榜里大量评论是灌水与玩梗（"前排""打卡"），对情感故事
 *    毫无用处，还会挤占 agent 的注意力预算。达不到门槛的宁可不收。
 *
 * 某个源失败不拖垮整轮：采集是尽力而为，一源不可用时如实报告，
 * 而不是让整轮变成「失败」。
 */
export async function collectMaterialCandidates({ limit = 12, sourceIds = null, fetch: fetcher, minHotValue = 0 } = {}) {
  const collectors = sourceIds
    ? STORY_MATERIAL_SOURCE_COLLECTORS.filter((item) => sourceIds.includes(item.id))
    : STORY_MATERIAL_SOURCE_COLLECTORS
  const items = []
  const sources = []
  for (const collector of collectors) {
    const startedAt = Date.now()
    try {
      const fetched = await collector.collect({ limit: limit * 2, fetch: fetcher })
      const kept = fetched.filter((item) => {
        const fingerprint = fingerprintSource(item.sourceUrl)
        if (!fingerprint) return false
        if ((item.hotValue || 0) < minHotValue) return false
        if (items.some((existing) => fingerprintSource(existing.sourceUrl) === fingerprint)) return false
        return true
      })
      items.push(...kept)
      sources.push({ id: collector.id, name: collector.name, status: 'ready', count: kept.length, durationMs: Date.now() - startedAt, error: null })
    } catch (error) {
      sources.push({ id: collector.id, name: collector.name, status: 'error', count: 0, durationMs: Date.now() - startedAt, error: cleanText(error?.message || '采集失败', 200) })
    }
  }
  // 热度高的排前面：agent 的注意力有限，先看到最可能成为故事的那些。
  items.sort((left, right) => (right.hotValue || 0) - (left.hotValue || 0))
  return {
    items: items.slice(0, limit),
    sources,
    fetchedAt: new Date().toISOString(),
  }
}
