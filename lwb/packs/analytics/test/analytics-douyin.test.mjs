import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import douyin, { parseCount, parseRowStats, parseLabeledNumber, videoIdFromHref, readWorksFromPage, parseCsv, worksFromExport, collectAccount, collectContents } from '../analytics-douyin.mjs'

/**
 * 假 page：只实现 adapter 用到的 locator/goto/waitForTimeout/url。
 * rows 是每行的「标题 + 统计文本」，用来验证匹配与解析，不依赖真实浏览器。
 */
function fakePage({ url = 'https://creator.douyin.com/creator-micro/content/manage', rows = [], texts = {} } = {}) {
  const rowLocators = rows.map((row) => ({
    locator: (selector) => ({
      first: () => ({
        innerText: async () => (/title/u.test(selector) ? row.title : row.stats),
        getAttribute: async () => (/href/u.test(selector) ? (row.href ?? null) : null),
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
  const page = fakePage({ rows: [] })
  page.evaluate = async () => ([
    { title: '已绑定的作品', stats: '1.2万 播放 345 点赞 12 评论', href: null },
    { title: '未绑定的作品', stats: '999 播放', href: null },
    { title: '标题不完全一致的作品', stats: '888 播放', href: null },
  ])
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(collected.length, 1, '只有已绑定且标题精确匹配的那条会被写回')
  assert.equal(collected[0].contentId, 'c1')
  assert.equal(store.calls.metrics[0].metrics.views, 12000)
})

test('内容级采集：一条都读不到数字时不落全 null 记录（避免「采集成功」的假象）', async () => {
  const store = fakeStore([{ contentId: 'c1', title: '作品', bound: true, remoteId: 'v1' }])
  const page = fakePage({ rows: [] })
  page.evaluate = async () => ([{ title: '作品', stats: '审核中', href: null }])
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(collected.length, 0)
  assert.equal(store.calls.metrics.length, 0)
})

test('既没有已绑定也没有未绑定内容时，不打开作品管理页', async () => {
  const store = fakeStore([])
  const page = fakePage({ rows: [] })
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.deepEqual(collected, [])
  assert.deepEqual(page.gotos, [])
})

test('内容级采集：未绑定内容按标题从平台列表绑定后再采指标', async () => {
  // 这条守的是「鸡生蛋」：bindAll 需要平台作品列表，而列表只能从作品管理页读。
  // 旧实现没有已绑定作品就提前 return，导致内容级指标永远是 0 条。
  const store = fakeStore([{ contentId: 'c1', title: '折叠屏首发翻车', bound: false }])
  const page = fakePage({ rows: [] })
  page.evaluate = async () => ([
    { title: '折叠屏首发翻车', stats: '1.2万 播放 345 点赞 12 评论', href: 'https://www.douyin.com/video/7412345678901' },
  ])
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(collected.length, 1)
  const boundRow = store.calls.contents.find((row) => row.contentId === 'c1')
  assert.equal(boundRow.remoteId, '7412345678901', '标题匹配成功后要落 remoteId')
  assert.equal(store.calls.metrics[0].metrics.views, 12000)
})

test('videoIdFromHref 认 /video/ 与 modal_id 两种链接', () => {
  assert.equal(videoIdFromHref('https://www.douyin.com/video/7412345678901'), '7412345678901')
  assert.equal(videoIdFromHref('/video/7412345678901'), '7412345678901')
  assert.equal(videoIdFromHref('https://www.douyin.com/user/x?modal_id=7412345678901'), '7412345678901')
  assert.equal(videoIdFromHref('https://creator.douyin.com/creator-micro/content/manage'), null)
  assert.equal(videoIdFromHref(null), null)
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

test('parseLabeledNumber 按标签就近取数，支持「标题一行数值一行」的卡片排版', () => {
  // 创作者中心数据卡的典型正文：标题与数值各占一行
  const text = '数据中心\n粉丝总数\n2.4万\n主页访问\n1,203\n播放量\n18.6万'
  assert.equal(parseLabeledNumber(text, ['粉丝总数', '总粉丝']), 24000)
  assert.equal(parseLabeledNumber(text, ['主页访问']), 1203)
  // 数字在前也认
  assert.equal(parseLabeledNumber('1.2万 粉丝', ['粉丝']), 12000)
  // 取不到就是 null，不用 0 冒充
  assert.equal(parseLabeledNumber('数据中心\n暂无数据', ['粉丝总数']), null)
  // 不会把远处无关指标当成目标：标签后 40 字符内没有数字就不取
  assert.equal(parseLabeledNumber('粉丝总数\n' + '占位'.repeat(30) + '999', ['粉丝总数']), null)
})

test('账号级采集：选择器失效时退回正文标签取值', async () => {
  const store = fakeStore()
  const page = fakePage({ url: 'https://creator.douyin.com/creator-micro/data-center/overview' })
  // 所有语义选择器都不命中，只有正文里有数字
  page.evaluate = async () => '数据中心\n粉丝总数\n3.1万\n主页访问\n880'
  const record = await collectAccount({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(record.followers, 31000)
  assert.equal(record.profileVisits, 880)
})

test('readWorksFromPage：读不到任何作品时返回空数组，由调用方报选择器缺失', async () => {
  // 不能抛错也不能编造：页面结构变了就是变了，交给上层留证据并报 SELECTOR_MISSING。
  assert.deepEqual(await readWorksFromPage({}), [])
  assert.deepEqual(await readWorksFromPage({ evaluate: async () => [] }), [])
  assert.deepEqual(await readWorksFromPage({ evaluate: async () => { throw new Error('boom') } }), [])
})

// ── 导出数据（CSV）路径 ────────────────────────────────────────────────────
//
// 为什么走导出：内容管理页不给作品 id（诊断证据 withHref:0）、标题被拼接重复、
// 列表懒加载只渲染 1 条。平台自己的导出文件按作品一行、带完整标题与全部指标。

test('parseCsv 支持引号字段、字段内逗号/换行、BOM 与 CRLF', () => {
  const csv = '\uFEFF标题,播放,备注\r\n"作品A, 副标题",1.2万,"第一行\n第二行"\r\n作品B,345,\r\n'
  const rows = parseCsv(csv)
  assert.deepEqual(rows[0], ['标题', '播放', '备注'])
  assert.deepEqual(rows[1], ['作品A, 副标题', '1.2万', '第一行\n第二行'])
  assert.deepEqual(rows[2], ['作品B', '345', ''])
})

test('worksFromExport 按表头关键字认列，不依赖列顺序', () => {
  // 故意打乱列序、改表头文案
  const csv = [
    '作品名称,点赞,播放量,评论数,分享次数,收藏数,涨粉',
    '折叠屏首发翻车,345,1.2万,12,8,60,3',
    '无人小店踩坑,88,2.5万,4,1,12,0',
  ].join('\n')
  const { works, header } = worksFromExport(csv)
  assert.equal(header[0], '作品名称')
  assert.equal(works.length, 2)
  assert.equal(works[0].title, '折叠屏首发翻车')
  assert.equal(works[0].metrics.views, 12000)
  assert.equal(works[0].metrics.likes, 345)
  assert.equal(works[0].metrics.comments, 12)
  assert.equal(works[0].metrics.shares, 8)
  assert.equal(works[0].metrics.favorites, 60)
  assert.equal(works[0].metrics.followersGained, 3)
})

test('worksFromExport 认不出标题列时返回空，交给 DOM 兜底', () => {
  const { works } = worksFromExport('日期,播放\n2026-10-29,100')
  assert.deepEqual(works, [])
})

test('内容级采集：导出 CSV 优先，按归一化标题匹配后落指标', async () => {
  // 真跑下载路径：写一份 CSV 到临时文件，让 waitForEvent 返回的 download 指向它。
  const dir = await mkdtemp(join(tmpdir(), 'an-douyin-csv-'))
  const csvPath = join(dir, 'works.csv')
  await writeFile(csvPath, '标题,播放,点赞,评论\n折叠屏首发翻车,1.2万,345,12\n', 'utf8')

  const store = fakeStore([{ contentId: 'c1', title: '折叠屏首发翻车', bound: true, remoteId: 'v1' }])
  const page = {
    gotos: [],
    async goto(url) { this.gotos.push(url) },
    async waitForTimeout() {},
    url: () => 'https://creator.douyin.com/creator-micro/content/manage',
    async waitForEvent() { return { path: async () => csvPath, suggestedFilename: () => 'works.csv' } },
    locator(selector) {
      // 只认「导出数据」这类按钮；登录墙/其它选择器一律未命中，
      // 否则 assertLoggedIn 会被假 page 骗过。
      const hit = /导出|作品数据|确认导出/u.test(selector)
      return { first: () => ({ count: async () => (hit ? 1 : 0), isVisible: async () => hit, waitFor: async () => {}, click: async () => {}, innerText: async () => (hit ? '导出数据' : '') }) }
    },
    async evaluate() { throw new Error('导出成功后不该再读 DOM') },
  }
  const collected = await collectContents({ accountId: 'a1', platform: 'douyin', page, signal: null }, { runId: 'r1', store })
  assert.equal(collected.length, 1, '导出 CSV 里的作品要能匹配上')
  assert.equal(store.calls.metrics[0].metrics.views, 12000)
  assert.equal(store.calls.metrics[0].metrics.likes, 345)
})
