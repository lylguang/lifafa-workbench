import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectMaterialCandidates, collectNeteaseComments, collectBilibiliComments, collectToutiaoEvents,
  canonicalSourceUrl, fingerprintSource, assertPublicHttpsUrl, fetchPublicText, StorySourceError,
} from '../story-account-harvest-sources.mjs'
import { buildHarvestPrompt, parseHarvestInput } from '../story-account-harvest.mjs'
import { StoryAccountContent } from '../story-account-content.mjs'
import { StoryAccountStore } from '../story-account-store.mjs'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 真实采集源。
 *
 * 这一组用例守的是「出处不能是模型编的」这条底线：
 * 1. 采集源只走公开 HTTPS，不碰本机与私有网络；
 * 2. 每条候选素材都必须带可回访的 sourceUrl；
 * 3. 真实抓到的素材交给 agent 时，提示词切成「筛选模式」——只能引用候选清单里的地址；
 * 4. 某个源挂掉不拖垮整轮，但要如实报告哪个源出了问题。
 *
 * 网络用例全部用打桩的 fetch 跑，不依赖真实外网。
 */

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

const NETEASE_PLAYLIST = {
  result: {
    tracks: [
      { id: 111, name: '我不难过' },
      { id: 222, name: '回家' },
    ],
  },
}

const NETEASE_COMMENTS = {
  111: {
    hotComments: [
      { commentId: 9001, content: '我妈走的那天，我才发现她把存折都换成了我的名字。', likedCount: 12000 },
      { commentId: 9002, content: '前排出售瓜子饮料矿泉水。', likedCount: 3 },
      { commentId: 9003, content: '短', likedCount: 999 },
    ],
  },
  222: {
    hotComments: [
      { commentId: 9004, content: '结婚十年以后，他第一次问我累不累，我当场就哭了。', likedCount: 800 },
    ],
  },
}

function neteaseFetch(url) {
  if (String(url).includes('/api/playlist/detail')) return Promise.resolve(jsonResponse(NETEASE_PLAYLIST))
  const match = /comments\/R_SO_4_(\d+)/u.exec(String(url))
  if (match) return Promise.resolve(jsonResponse(NETEASE_COMMENTS[Number(match[1])] || { hotComments: [] }))
  return Promise.resolve(new Response('not found', { status: 404 }))
}

const BILI_POOL = {
  data: {
    list: [
      { aid: 501, bvid: 'BV501', title: '女儿：爸爸妈妈要结婚啦？' },
    ],
  },
}

const BILI_REPLIES = {
  data: {
    replies: [
      { rpid: 7001, like: 5000, content: { message: '我爸把我妈赶出家门那晚，我第一次学会不哭。' } },
      { rpid: 7002, like: 30, content: { message: '打卡第 100 天。' } },
    ],
    cursor: { pagination_reply: { next_offset: null } },
  },
}

function bilibiliFetch(url) {
  if (String(url).includes('/ranking/v2')) return Promise.resolve(jsonResponse(BILI_POOL))
  if (String(url).includes('/reply/main')) return Promise.resolve(jsonResponse(BILI_REPLIES))
  return Promise.resolve(new Response('not found', { status: 404 }))
}

const TOUTIAO = {
  data: [
    { Title: '全国妇联发布婚姻家庭调查数据', Url: 'https://www.toutiao.com/trending/1/?log_pb=abc&utm_source=x', HotValue: 990 },
    { Title: '某地暴雨预警', Url: 'https://www.toutiao.com/trending/2/', HotValue: 880 },
    { Title: '辽宁舰现身菲律宾家门口', Url: 'https://www.toutiao.com/trending/3/', HotValue: 770 },
  ],
}

function toutiaoFetch(url) {
  if (String(url).includes('/hot-board/')) return Promise.resolve(jsonResponse(TOUTIAO))
  return Promise.resolve(new Response('not found', { status: 404 }))
}

/* ── URL 与安全 ── */

test('来源地址只允许公开 HTTPS，本机与私有网络一律拒绝', async () => {
  for (const value of ['http://example.com/a', 'https://user:pass@example.com/a']) {
    await assert.rejects(() => assertPublicHttpsUrl(value, { resolveHostname: async () => [{ address: '93.184.216.34' }] }), /公开|HTTPS|凭据/u)
  }
  for (const value of ['https://127.0.0.1/a', 'https://localhost/a', 'https://192.168.1.1/a']) {
    await assert.rejects(() => assertPublicHttpsUrl(value, { resolveHostname: async () => [{ address: '93.184.216.34' }] }), /本机或私有网络/u)
  }
  const url = await assertPublicHttpsUrl('https://example.com/a', { resolveHostname: async () => [{ address: '93.184.216.34' }] })
  assert.equal(url.toString(), 'https://example.com/a')
})

test('基准测试保留段 198.18/15 允许通过，本机 DNS 代理常用它映射公网域名', async () => {
  const url = await assertPublicHttpsUrl('https://www.toutiao.com/a', { resolveHostname: async () => [{ address: '198.18.2.61' }] })
  assert.equal(url.toString(), 'https://www.toutiao.com/a')
})

test('域名解析到私有地址时拒绝采集', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl('https://sneaky.example.com/a', { resolveHostname: async () => [{ address: '10.1.2.3' }] }),
    /公开网络地址/u,
  )
})

test('来源地址去掉追踪参数，网易云的锚点路由要留住', () => {
  assert.equal(
    canonicalSourceUrl('https://www.toutiao.com/trending/1/?log_pb=abc&utm_source=x'),
    'https://www.toutiao.com/trending/1/',
  )
  assert.equal(
    canonicalSourceUrl('https://music.163.com/#/song?id=287398&commentid=7355569'),
    'https://music.163.com/#/song?id=287398&commentid=7355569',
  )
  assert.equal(canonicalSourceUrl('https://music.163.com/#/song?id=1&commentid=2'), 'https://music.163.com/#/song?id=1&commentid=2')
})

test('同一素材的不同追踪参数认成同一条', () => {
  assert.equal(
    fingerprintSource('https://example.com/a?utm_source=x'),
    fingerprintSource('https://example.com/a'),
  )
})

/* ── 采集源 ── */

test('网易云热评抓到的每条都带可回访链接与点赞数', async () => {
  const items = await collectNeteaseComments({ fetch: neteaseFetch, limit: 10 })
  assert.ok(items.length >= 2, `至少要抓到两条，实际 ${items.length}`)
  for (const item of items) {
    assert.match(item.sourceUrl, /^https:\/\/music\.163\.com\/#\/song\?id=\d+&commentid=\d+$/u, '出处必须指到那条评论本身')
    assert.ok(item.content.length > 0)
    assert.ok(item.hotValue > 0)
  }
  // 灌水与过短的评论不进素材池。
  assert.ok(!items.some((item) => item.content.includes('前排')))
  assert.ok(!items.some((item) => item.content === '短'))
})

test('B 站热评抓到的每条都带可回访链接', async () => {
  const items = await collectBilibiliComments({ fetch: bilibiliFetch, limit: 10 })
  assert.equal(items.length, 1)
  assert.match(items[0].sourceUrl, /^https:\/\/www\.bilibili\.com\/video\/BV501\/#reply7001$/u)
  assert.equal(items[0].kind, 'news-comment')
})
test('头条热榜只收与账号题材相关的现实议题', async () => {
  const items = await collectToutiaoEvents({ fetch: toutiaoFetch, limit: 5 })
  // 军事、天气类与情感故事无关，不该进素材池。
  assert.equal(items.length, 1)
  assert.equal(items[0].sourceUrl, 'https://www.toutiao.com/trending/1/')
})

test('B 站只扫家庭与情感向的视频，其余评论区不扫', async () => {
  const pool = { data: { list: [{ aid: 501, bvid: 'BV501', title: '女儿：爸爸妈妈要结婚啦？' }, { aid: 502, bvid: 'BV502', title: '【】游戏实况' }] } }
  const fetch = (url) => {
    if (String(url).includes('/ranking/v2')) return Promise.resolve(jsonResponse(pool))
    if (String(url).includes('/reply/main')) return Promise.resolve(jsonResponse(BILI_REPLIES))
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
  const items = await collectBilibiliComments({ fetch, limit: 10 })
  assert.equal(items.length, 1)
  assert.equal(items[0].sourceUrl, 'https://www.bilibili.com/video/BV501/#reply7001')
})

test('一个源挂掉不拖垮整轮，但要如实报告是哪个源', async () => {
  const result = await collectMaterialCandidates({
    limit: 10,
    fetch: (url) => {
      if (String(url).includes('/hot-board/')) return Promise.resolve(new Response('boom', { status: 500 }))
      if (String(url).includes('/api/playlist/detail')) return Promise.resolve(jsonResponse(NETEASE_PLAYLIST))
      if (String(url).includes('/ranking/v2')) return Promise.resolve(jsonResponse(BILI_POOL))
      if (String(url).includes('/reply/main')) return Promise.resolve(jsonResponse(BILI_REPLIES))
      if (String(url).includes('comments/R_SO_4_')) {
        const match = /comments\/R_SO_4_(\d+)/u.exec(String(url))
        return Promise.resolve(jsonResponse(NETEASE_COMMENTS[Number(match?.[1])] || { hotComments: [] }))
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    },
  })
  assert.ok(result.items.length >= 2, '可用的源仍然要出素材')
  const failed = result.sources.filter((item) => item.status === 'error')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 'toutiao-hot')
  assert.match(failed[0].error, /HTTP 500/u)
})

test('重复抓到的素材只留一条', async () => {
  const result = await collectMaterialCandidates({
    limit: 10,
    sourceIds: ['netease-comments'],
    fetch: neteaseFetch,
  })
  const urls = result.items.map((item) => item.sourceUrl)
  assert.equal(new Set(urls).size, urls.length)
})

test('候选按点赞数排序，热度高的排在前面', async () => {
  const result = await collectMaterialCandidates({
    limit: 10,
    sourceIds: ['netease-comments'],
    fetch: neteaseFetch,
  })
  const values = result.items.map((item) => item.hotValue || 0)
  assert.ok(values.length >= 2)
  assert.deepEqual(values, [...values].sort((left, right) => right - left))
})

test('灌水与玩梗的评论不进素材池', async () => {
  const result = await collectMaterialCandidates({
    limit: 10,
    sourceIds: ['netease-comments'],
    fetch: neteaseFetch,
  })
  assert.ok(!result.items.some((item) => item.content.includes('前排')))
  assert.ok(!result.items.some((item) => item.content.includes('打卡')))
})

/* ── 与素材层的接线 ── */

test('有真实候选时提示词切成筛选模式，只能引用候选里的地址', () => {
  const prompt = buildHarvestPrompt({
    input: parseHarvestInput({}),
    profile: null,
    existing: [],
    candidates: [
      { title: '候选一', content: '原文', kind: 'qa-answer', sourceUrl: 'https://music.163.com/#/song?id=1&commentid=2', note: '12 赞' },
    ],
  })
  assert.match(prompt, /本轮已经真实抓取到 1 条候选素材/u)
  assert.match(prompt, /https:\/\/music\.163\.com\/#\/song\?id=1&commentid=2/u)
  assert.match(prompt, /不要另找出处/u)
  assert.match(prompt, /sourceUrl 必须原样抄写/u)
})

test('没有真实候选时仍是检索模式，并保留「找不到就说找不到」的底线', () => {
  const prompt = buildHarvestPrompt({ input: parseHarvestInput({}), profile: null, existing: [], candidates: [] })
  assert.match(prompt, /就返回空的 items/u)
  assert.ok(!/不要另找出处/u.test(prompt))
})

test('采集会先真实抓一轮，再把候选交给 agent 筛选', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-src-'))
  try {
    const content = new StoryAccountContent({ workspacePath: dir })
    content.attachProjects(new StoryAccountStore(), { workspacePath: dir })
    const seen = []
    content.sourceCollector = async () => ({
      items: [{ title: '候选', content: '原文', kind: 'qa-answer', sourceUrl: 'https://example.com/x' }],
      sources: [{ id: 'netease-comments', name: '网易云音乐热评', status: 'ready', count: 1, durationMs: 5, error: null }],
    })
    content.harvestExecutor = async (request) => {
      seen.push(request)
      return { items: [{ title: '候选', content: '原文', kind: 'qa-answer', sourceUrl: 'https://example.com/x', sceneHint: '厨房', keyLineHint: '一句原话' }] }
    }
    const created = await content.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 60))
    const record = await content.materialHarvestStatus({ id: created.id })
    assert.equal(record.status, 'success')
    assert.match(seen[0].prompt, /本轮已经真实抓取到 1 条候选素材/u)
    assert.equal(record.sources[0].id, 'netease-comments')
    assert.equal(record.items.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('真实采集失败不终止整轮，退回 agent 自己找', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-src-'))
  try {
    const content = new StoryAccountContent({ workspacePath: dir })
    content.attachProjects(new StoryAccountStore(), { workspacePath: dir })
    const seen = []
    content.sourceCollector = async () => { throw new Error('网络不通') }
    content.harvestExecutor = async (request) => { seen.push(request); return { items: [] } }
    const created = await content.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 60))
    const record = await content.materialHarvestStatus({ id: created.id })
    assert.equal(record.status, 'success', '采集源挂了不等于整轮失败')
    assert.match(record.sources[0].error, /网络不通/u)
    assert.ok(!/本轮已经真实抓取到/u.test(seen[0].prompt))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
