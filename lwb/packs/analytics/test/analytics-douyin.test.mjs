import test from 'node:test'
import assert from 'node:assert/strict'
import douyin, { parseCount, parseRowStats, collectAccount, collectContents } from '../analytics-douyin.mjs'

/**
 * 假 page：只实现 adapter 用到的 locator/goto/waitForTimeout/url。
 * rows 是每行的「标题 + 统计文本」，用来验证匹配与解析，不依赖真实浏览器。
 */
function fakePage({ url = 'https://creator.douyin.com/creator-micro/content/manage', rows = [], texts = {} } = {}) {
  const rowLocators = rows.map((row) => ({
    locator: (selector) => ({
      first: () => ({
        innerText: async () => (/title/u.test(selector) ? row.title : row.stats),
      }),
    }),
  }))
  // 作品行容器的选择器（adapter 把候选 join 成一个字符串传进来）
  const isRowContainer = (selector) => /video-item|content-card/u.test(selector)
  return {
    gotos: [],
    async goto(target) { this.gotos.push(target) },
    async waitForTimeout() {},
    url: () => url,
    locator(selector) {
      // 只有真正对应的选择器才命中；其余一律 count 0，
      // 否则登录态检查（找「扫码登录」）会被假 page 误命中。
      const key = Object.keys(texts).find((name) => selector.includes(name))
      const value = key ? texts[key] : undefined
      const rowMatch = isRowContainer(selector) && rowLocators.length > 0
      const hit = value !== undefined || rowMatch
      return {
        first: () => ({
          count: async () => (hit ? 1 : 0),
          isVisible: async () => true,
          waitFor: async () => {},
          innerText: async () => {
            if (value !== undefined) return value
            throw new Error('no text')
          },
        }),
        count: async () => (rowMatch ? rowLocators.length : 0),
        all: async () => (rowMatch ? rowLocators : []),
      }
    },
  }
}

function fakeStore(contents = []) {
  const calls = { snapshots: [], metrics: [], contents: [] }
  return {
    calls,
    listContents: async () => contents,
    saveAccountSnapshot: async (row) => { calls.snapshots.push(row); return row },
    saveContentMetrics: async (row) => { calls.metrics.push(row); return row },
    saveContents: async (rows) => { calls.contents.push(...rows); return rows },
  }
}

test('parseCount 认得万/亿/k 与千分位，解析不出来返回 null 而不是 0', () => {
  assert.equal(parseCount('1.2万'), 12000)
  assert.equal(parseCount('3,456'), 3456)
  assert.equal(parseCount('12'), 12)
  assert.equal(parseCount('1.5亿'), 150000000)
  assert.equal(parseCount('2.3w'), 23000)
  assert.equal(parseCount(''), null)
  assert.equal(parseCount('—'), null)
  assert.equal(parseCount('暂无'), null)
})

test('parseRowStats 同时支持「标签在前」和「数字在前」两种排版', () => {
  // 抖音作品管理常见形态：数字在前
  assert.deepEqual(
    parseRowStats('1.2万 播放 345 点赞 12 评论 8 分享'),
    { views: 12000, likes: 345, comments: 12, shares: 8, favorites: null, followersGained: null, completionRate: null },
  )
  // 标签在前
  assert.equal(parseRowStats('播放: 1.2万 · 点赞 345 · 评论 12').views, 12000)
  // 一个数都没有：全 null（绝不用 0 冒充）
  assert.deepEqual(parseRowStats('审核中'), { views: null, likes: null, comments: null, shares: null, favorites: null, followersGained: null, completionRate: null })
  assert.equal(parseRowStats('').views, null)
})

test('账号级采集：读到粉丝数就落一条快照，取不到就报选择器缺失', async () => {
  const store = fakeStore()
  const page = fakePage({ url: 'https://creator.douyin.com/creator-micro/data/overview', texts: { fans: '2.4万' } })
  const record = await collectAccount({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(record.followers, 24000)
  assert.equal(store.calls.snapshots.length, 1)

  const empty = fakePage({ url: 'https://creator.douyin.com/creator-micro/data/overview' })
  await assert.rejects(
    () => collectAccount({ accountId: 'a1', platform: 'douyin', page: empty, signal: null, evidence: async () => null }, { runId: 'r1', store: fakeStore() }),
    (error) => error.code === 'ANALYTICS_COLLECTOR_SELECTOR_MISSING',
  )
})

test('登录态失效要抛 PUBLISHER_LOGIN_REQUIRED，而不是报成选择器缺失', async () => {
  const page = fakePage({ url: 'https://creator.douyin.com/login' })
  await assert.rejects(
    () => collectAccount({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store: fakeStore() }),
    (error) => error.code === 'PUBLISHER_LOGIN_REQUIRED',
  )
})

test('内容级采集：只更新已绑定且标题精确匹配的作品', async () => {
  const contents = [
    { contentId: 'c1', title: '已绑定的作品', bound: true, remoteId: 'v1' },
    { contentId: 'c2', title: '未绑定的作品', bound: false },
  ]
  const store = fakeStore(contents)
  const page = fakePage({
    rows: [
      { title: '已绑定的作品', stats: '1.2万 播放 345 点赞 12 评论' },
      { title: '未绑定的作品', stats: '999 播放' },
      { title: '标题不完全一致的作品', stats: '888 播放' },
    ],
  })
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(collected.length, 1, '只有已绑定且标题精确匹配的那条会被写回')
  assert.equal(collected[0].contentId, 'c1')
  assert.equal(store.calls.metrics[0].metrics.views, 12000)
})

test('内容级采集：一条都读不到数字时不落全 null 记录（避免「采集成功」的假象）', async () => {
  const store = fakeStore([{ contentId: 'c1', title: '作品', bound: true, remoteId: 'v1' }])
  const page = fakePage({ rows: [{ title: '作品', stats: '审核中' }] })
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(collected.length, 0)
  assert.equal(store.calls.metrics.length, 0)
})

test('没有已绑定作品时不打开作品管理页（省一次页面跳转）', async () => {
  const store = fakeStore([{ contentId: 'c1', title: '未绑定', bound: false }])
  const page = fakePage({ rows: [] })
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.deepEqual(collected, [])
  assert.deepEqual(page.gotos, [])
})

test('adapter 导出形态符合采集器契约', () => {
  assert.equal(douyin.id, 'douyin')
  assert.equal(typeof douyin.collectAccount, 'function')
  assert.equal(typeof douyin.collectContents, 'function')
})

test('登录墙按页面文本识别：URL 不变也要判成登录失效', async () => {
  // 抖音掉登录时不跳 URL，只在原路径下渲染登录墙（2026-10-29 实测）。
  // 只靠选择器判定会漏，把登录墙误报成「页面结构已变化」。
  const page = fakePage({ url: 'https://creator.douyin.com/creator-micro/data/overview' })
  page.evaluate = async () => '抖音创作者的一站式创作与服务平台\n扫码登录\n验证码登录'
  await assert.rejects(
    () => collectAccount({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store: fakeStore() }),
    (error) => error.code === 'PUBLISHER_LOGIN_REQUIRED',
  )
})
