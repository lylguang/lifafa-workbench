import assert from 'node:assert/strict'
import test from 'node:test'
import { AnalyticsLocalSource } from '../analytics-local.mjs'
import {
  coverage,
  densifySeries,
  displayCount,
  displayRate,
  engagementRate,
  funnelRows,
  metricNumber,
  platformBreakdown,
  rangeWindow,
  topContents,
} from '../analytics-ui-metrics.mjs'

/*
 * 前后端联调冒烟：拿真实 AnalyticsLocalSource 的返回体，直接喂给前端口径函数。
 *
 * 单元测试各测各的只能证明"自己没写错"，这里证明的是"我的页面读得懂后端给的形状"——
 * 后端改了字段名而前端没跟上时，这条会先红。全部用内存假数据，不碰任何环境前置。
 */

const ACCOUNT = {
  id: 'acc-1', platform: 'douyin', label: '主号', nickname: '某某说AI', handle: null,
  status: 'active', contentAccountId: null, lastError: null,
}
const OTHER_ACCOUNT = { ...ACCOUNT, id: 'acc-2', platform: 'bilibili', label: 'B站号', nickname: '某B' }

function job(id, overrides) {
  return {
    id, accountId: 'acc-1', platform: 'douyin', accountLabel: '主号',
    projectId: `p-${id}`, projectTitle: `作品 ${id}`, projectRevision: 1,
    media: null, content: null, submitMode: 'confirm', status: 'succeeded',
    phase: 'committed', error: null,
    proof: { screenshots: [], diagnostics: [], remoteUrl: null, submittedAt: '2026-10-10T02:00:00.000Z' },
    trigger: 'manual', createdAt: '2026-10-10T02:00:00.000Z', updatedAt: '2026-10-10T02:05:00.000Z',
    completedAt: '2026-10-10T02:05:00.000Z',
    ...overrides,
  }
}

function pipelineItem(id, stage, page) {
  return { id, title: `项目 ${id}`, updatedAt: '2026-10-10T00:00:00.000Z', stage, page, account: null, stages: {} }
}

function makeSource(jobs, overviewItems) {
  return new AnalyticsLocalSource({
    publisher: {
      listAccounts: async () => [ACCOUNT, OTHER_ACCOUNT],
      listJobs: async () => jobs,
    },
    spokenVideo: {
      pipelineOverview: async () => ({ items: overviewItems, total: overviewItems.length }),
    },
  })
}

const RANGE = (() => {
  const window_ = rangeWindow('30d', new Date(2026, 9, 19, 12))
  return { from: window_.from, to: window_.to }
})()

test('summary 返回体能被概览页逐字段消费，且采集指标一律 null 不填 0', async () => {
  const source = makeSource(
    [job('j1'), job('j2', { status: 'failed', proof: { screenshots: [], diagnostics: [], remoteUrl: null, submittedAt: null } })],
    [pipelineItem('p1', 'script-pending', 'scripts'), pipelineItem('p2', 'publish', 'publish')],
  )
  const summary = await source.summary(RANGE)

  // 发布数与成功率由后端按发布任务口径计算（其分母语义 Backend 在定稿中负责）。
  // 前端只负责展示，所以这里只断言「是合法非负数」与「成功率是合法比率」，
  // 不断言具体数值——数值口径属于后端职责，前端锁死会阻碍它调整。
  assert.ok(Number.isInteger(summary.kpis.published.count) && summary.kpis.published.count >= 0)
  assert.ok(summary.kpis.published.successRate === null
    || (Number.isFinite(summary.kpis.published.successRate) && summary.kpis.published.successRate >= 0 && summary.kpis.published.successRate <= 1))

  // 采集指标在 P1 没有数据源，必须是 null——页面显示「—」而不是 0。
  // 这条断言刻意不依赖阶段：P2 接入采集后，只有真正采到数才有值，
  // 采集器缺席或失败时仍必须是 null，不能回填假 0（§4.1 的 null ≠ 0）。
  for (const key of ['views', 'likes', 'comments', 'shares', 'favorites']) {
    assert.equal(summary.kpis[key], null, `${key} 应为 null`)
    assert.equal(displayCount(summary.kpis[key]), '—', `${key} 不应渲染成 0`)
  }
  assert.equal(summary.kpis.engagementRate, null)
  assert.equal(displayRate(summary.kpis.engagementRate), '—')
  assert.equal(summary.kpis.followers.netGain, null)

  // 跨阶段恒成立：generatedAt 恒在；stale 恒为布尔（取值可随采集状态变，形状不可变）。
  assert.equal(typeof summary.generatedAt, 'string')
  assert.ok(summary.generatedAt.length > 0)
  assert.equal(typeof summary.stale, 'boolean')
})

test('区间外的发布不计入 contents 明细', async () => {
  const inside = job('j1')
  const outside = job('j2', {
    createdAt: '2026-10-10T02:00:00.000Z',
    proof: { screenshots: [], diagnostics: [], remoteUrl: null, submittedAt: '2026-09-01T02:00:00.000Z' },
  })
  const source = makeSource([inside, outside], [])
  const page = await source.contents({ ...RANGE, offset: 0, limit: 10 })
  // 2 号虽然创建于区间内，但真正提交上线在 9 月，不该出现在 10 月的作品明细里。
  const ids = page.items.map((item) => item.contentId)
  assert.equal(ids.includes('j1'), true)
  assert.equal(ids.includes('j2'), false)
})

test('漏斗行带 label，前端映射不会覆盖后端标签', async () => {
  const source = makeSource([], [
    pipelineItem('p1', 'script-pending', 'scripts'),
    pipelineItem('p2', 'script-review', 'scripts'),
    pipelineItem('p3', 'voiceover', 'audio-captions'),
    pipelineItem('p4', 'video', 'video-preview'),
    pipelineItem('p5', 'publish', 'publish'),
  ])
  const summary = await source.summary(RANGE)
  const rows = funnelRows(summary.funnel)
  assert.deepEqual(rows.map((row) => row.label), ['待写稿', '待确认稿件', '待配音 / 字幕', '待视频制作', '可发布'])
  // 每个非空阶段都必须带 page，页面上的「去处理」才有跳转目标。
  assert.ok(rows.every((row) => typeof row.page === 'string' && row.page))
  assert.equal(rows[0].count, 1)
  assert.equal(metricNumber(rows[0].count), 1)
})

test('series 的 published 按天全量输出，采集指标为空点并标 stale', async () => {
  const source = makeSource([job('j1')], [])
  const summary = await source.summary(RANGE)
  const points = densifySeries(summary.series.map((item) => ({ date: item.date, value: item.published })), RANGE)
  // 区间内每天一个点：没发布的日期是 0（真值，不是缺失）。
  assert.equal(points.points.length, 30)
  assert.equal(points.points.some((item) => item.value === null), false, '发布量是已知本地事实，不该出现 null 缺口')
  assert.equal(points.points.filter((item) => item.value > 0).length, 1)
  // stale 的取值随采集状态推进而变，但形状恒为布尔（见上方 summary 用例）。
  assert.equal(typeof summary.stale, 'boolean')
})

test('contents 的 contentId 就是 jobId，绑定状态与来源字段齐全', async () => {
  const source = makeSource([job('j1'), job('j2')], [])
  const page = await source.contents({ ...RANGE, offset: 0, limit: 10, sort: 'views', order: 'desc' })
  assert.equal(page.total, 2)
  // 契约 §4.1/§4.2-3：contentId 就是 publisher 的 jobId，不新造 id 空间。
  // 这条要真的拦住「另造合成 id」——所以断言返回的 id 集合恰等于输入的 job id 集合，
  // 而不是写一个自反等式（那样任何值都成立，等于没测）。
  const contentIds = page.items.map((item) => item.contentId)
  assert.deepEqual([...contentIds].sort(), ['j1', 'j2'])
  // 且必须与 publisher 侧的 jobId 同源：换成任意合成 id 就会红。
  assert.equal(contentIds.includes('WRONG-SYNTHETIC-ID'), false)

  const row = page.items[0]
  assert.ok(['acc-1'].includes(row.accountId))
  assert.equal(row.platform, 'douyin')
  // bound 的取值随绑定进度推进而变（契约 §4.2-9），但恒为布尔。
  assert.equal(typeof row.bound, 'boolean')
  assert.equal(typeof row.title, 'string')
  // 采集器缺席时 metrics 全 null；页面渲染成「—」。这条不随 P2 改变：
  // 采不到数必须仍是 null，不能回填假 0。
  assert.equal(row.metrics.views, null)
  assert.equal(displayCount(row.metrics.views), '—')
  assert.equal(row.engagementRate, null)
  assert.equal(typeof page.generatedAt, 'string')
})

test('accounts 的采集态是契约五态之一，且不带 unbound', async () => {
  const source = makeSource([job('j1')], [])
  const result = await source.accounts(RANGE)
  assert.equal(result.items.length, 2)
  // 契约 §4.2-2 冻结的五个词。新增状态必须先改契约再改这里，不能悄悄加。
  const allowed = ['ok', 'stale', 'expired', 'failed', 'never']
  for (const item of result.items) {
    assert.ok(allowed.includes(item.collectionStatus), `未定义的采集态：${item.collectionStatus}`)
    assert.equal(item.lastCollectedAt, null, '未采集过就没有采集时间')
    // 本用例的假 publisher 不提供粉丝数据，净增粉无从计算——必须是 null 而非 0。
    assert.equal(item.followers, null)
    assert.equal(item.followersNetGain, null)
    assert.equal(item.unbound, undefined, 'unbound 是内容维度，不该出现在账号上')
  }
  assert.equal(coverage(result.items).label, '来自 2/2 个账号')
})

test('publisher 缺席时各区块独立降级，不抛错', async () => {
  const source = new AnalyticsLocalSource({ publisher: null, spokenVideo: null })
  const summary = await source.summary(RANGE)
  assert.equal(summary.available.publisher, false)
  assert.ok(summary.available.reason)
  assert.equal(summary.available.funnel, false)
  // 缺失也不能变成 0。
  assert.equal(summary.kpis.published.count, 0)
  const accounts = await source.accounts(RANGE)
  assert.equal(accounts.available, false)
  assert.equal(accounts.items.length, 0)
  const contents = await source.contents({ ...RANGE, offset: 0, limit: 8 })
  assert.equal(contents.available, false)
})

test('spokenVideo 缺席只影响漏斗，发布侧仍可用', async () => {
  const source = new AnalyticsLocalSource({
    publisher: { listAccounts: async () => [ACCOUNT], listJobs: async () => [job('j1')] },
    spokenVideo: null,
  })
  const summary = await source.summary(RANGE)
  assert.equal(summary.available.publisher, true)
  assert.equal(summary.available.funnel, false)
  assert.equal(summary.kpis.published.count, 1)
})

test('平台分布与互动率在前端口径下不会把 null 当 0 画出来', async () => {
  const source = makeSource([job('j1'), job('j2', { accountId: 'acc-2', platform: 'bilibili' })], [])
  const summary = await source.summary(RANGE)
  const breakdown = platformBreakdown(summary.platforms)
  // P1 各平台播放都是 null：横条区块应显示空态，而不是两条 0 长度条。
  assert.equal(breakdown.items.length, 0)
  assert.equal(breakdown.total, 0)
  assert.equal(engagementRate(summary.contents || []), null)
  assert.deepEqual(topContents([], 'views'), [])
})
