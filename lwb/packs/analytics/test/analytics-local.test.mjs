import test from 'node:test'
import assert from 'node:assert/strict'
import { AnalyticsError, AnalyticsLocalSource } from '../analytics-local.mjs'

const RANGE = { from: '2026-03-01T00:00:00', to: '2026-03-07T23:59:59' }

/** 内存假数据：字段名与 publisher-store 的真实返回一致。 */
function job(overrides = {}) {
  return {
    id: 'job-1',
    accountId: 'acc-a',
    platform: 'bilibili',
    projectId: 'proj-1',
    projectTitle: '标题',
    status: 'succeeded',
    proof: { remoteUrl: 'https://member.bilibili.com/platform/upload-manager/article', submittedAt: '2026-03-02T10:00:00' },
    trigger: 'manual',
    createdAt: '2026-03-02T09:00:00',
    completedAt: '2026-03-02T10:05:00',
    ...overrides,
  }
}

function account(overrides = {}) {
  return {
    id: 'acc-a',
    platform: 'bilibili',
    label: '主号',
    nickname: '某某',
    handle: null,
    status: 'active',
    profileDir: 'chrome-profiles/acc-a',
    contentAccountId: null,
    lastError: null,
    ...overrides,
  }
}

function source({ accounts = [account()], jobs = [], items = [] } = {}) {
  return new AnalyticsLocalSource({
    publisher: {
      listAccounts: async () => accounts,
      listJobs: async () => jobs,
    },
    spokenVideo: { pipelineOverview: async () => ({ items, total: items.length }) },
  })
}

test('区间校验：缺端点、起晚于止、超过一年都报 ANALYTICS_INVALID_INPUT', async () => {
  const data = source()
  for (const bad of [{}, { from: '2026-03-01' }, { from: 'x', to: 'y' }, { from: '2026-03-07', to: '2026-03-01' }, { from: '2020-01-01', to: '2026-03-01' }]) {
    await assert.rejects(() => data.summary(bad), (error) => error instanceof AnalyticsError && error.code === 'ANALYTICS_INVALID_INPUT')
  }
})

test('summary：无采集源时播放/互动类 KPI 一律 null，且 stale 为 true', async () => {
  const data = source({ jobs: [job()] })
  const result = await data.summary(RANGE)
  assert.equal(result.kpis.views, null)
  assert.equal(result.kpis.likes, null)
  assert.equal(result.kpis.engagementRate, null)
  assert.equal(result.kpis.followers.current, null)
  assert.equal(result.kpis.followers.netGain, null)
  assert.equal(result.stale, true)
  assert.ok(result.generatedAt, '读接口必须带 generatedAt')
})

test('summary：已发布计数=区间内全部发布尝试，成功率用同源分母', async () => {
  const jobs = [
    job({ id: 'j1', status: 'succeeded' }),
    job({ id: 'j2', status: 'succeeded' }),
    job({ id: 'j3', status: 'failed' }),
    job({ id: 'j4', status: 'queued' }),
    job({ id: 'j5', status: 'awaiting-confirm' }),
  ]
  const result = await source({ jobs }).summary(RANGE)
  assert.equal(result.kpis.published.count, 5, '发布量统计全部尝试，与成功率分母同源')
  assert.equal(result.kpis.published.successRate, 2 / 3, '成功率分母只算已出终态的（succeeded/failed/cancelled），未定的 queued/awaiting-confirm 不压低比率')
})

test('summary：contents 只列成功作品，但发布量把失败尝试也计入', async () => {
  const jobs = [
    job({ id: 'ok', status: 'succeeded' }),
    job({ id: 'bad', status: 'failed', proof: { remoteUrl: null, submittedAt: null } }),
  ]
  const data = source({ jobs })
  assert.equal((await data.summary(RANGE)).kpis.published.count, 2, '发布量含失败尝试')
  const contents = await data.contents({ ...RANGE, offset: 0, limit: 10 })
  assert.deepEqual(contents.items.map((row) => row.contentId), ['ok'], '失败任务不是「已发布作品」')
})

test('kpis.published.count 是尝试数而非成功数（QA 验收意见：命名易被误读）', async () => {
  const jobs = [
    job({ id: 'ok1', status: 'succeeded' }),
    job({ id: 'ok2', status: 'succeeded' }),
    job({ id: 'bad', status: 'failed' }),
  ]
  const data = source({ jobs })
  const summary = await data.summary(RANGE)
  const contents = await data.contents({ ...RANGE, offset: 0, limit: 10 })
  assert.equal(summary.kpis.published.count, 3, 'count 含失败尝试')
  assert.equal(contents.total, 2, '真正发布成功的作品只有 2 条')
  // 成功数只能由 contents 条数或 count×successRate 得到，count 本身不是成功数。
  assert.notEqual(summary.kpis.published.count, contents.total)
})

test('summary：区间外的任务不进发布量', async () => {
  const jobs = [
    job({ id: 'in', proof: { remoteUrl: null, submittedAt: '2026-03-03T10:00:00' }, createdAt: '2026-03-03T09:00:00' }),
    job({ id: 'out', proof: { remoteUrl: null, submittedAt: '2026-02-20T10:00:00' }, createdAt: '2026-02-20T09:00:00' }),
  ]
  assert.equal((await source({ jobs }).summary(RANGE)).kpis.published.count, 1)
})

test('summary：series 里只有 published 是全量补点，其余指标是 null 而非 0', async () => {
  const jobs = [job({ proof: { remoteUrl: null, submittedAt: '2026-03-02T10:00:00' } })]
  const result = await source({ jobs }).summary(RANGE)
  assert.equal(result.series.length, 7, '3-01 到 3-07 共 7 天')
  assert.deepEqual(result.series.map((point) => point.published), [0, 1, 0, 0, 0, 0, 0])
  for (const point of result.series) {
    assert.equal(point.views, null, 'views 缺失必须是 null')
    assert.equal(point.likes, null)
    assert.equal(point.comments, null)
    assert.equal(point.followersNetGain, null)
  }
})

test('summary：funnel 来自 pipelineOverview，且各区块独立降级', async () => {
  const data = new AnalyticsLocalSource({
    publisher: { listAccounts: async () => [account()], listJobs: async () => [job()] },
    spokenVideo: null,
  })
  const result = await data.summary(RANGE)
  assert.deepEqual(result.funnel, [], 'spoken-video 未加载时漏斗为空而非抛错')
  assert.equal(result.available.funnel, false)
  assert.match(result.available.funnelReason, /口播视频能力包未加载/u)
  assert.equal(result.available.publisher, true, 'publisher 可用时其余区块照常出数')
})

test('funnel 按阶段聚合并带归属页面', async () => {
  const data = source({ jobs: [job()], items: [{ stage: 'video', page: 'video-preview' }, { stage: 'publish', page: 'publish' }] })
  const result = await data.summary(RANGE)
  assert.deepEqual(result.funnel, [
    { stage: 'video', label: '待制作', count: 1, page: 'video-preview' },
    { stage: 'publish', label: '可发布', count: 1, page: 'publish' },
  ])
})

test('accounts：P1 无快照，粉丝/净增粉为 null，状态恒为 never', async () => {
  const data = source({ accounts: [account(), account({ id: 'acc-b', nickname: null })], jobs: [job({ accountId: 'acc-a' })] })
  const result = await data.accounts(RANGE)
  assert.equal(result.items.length, 2)
  assert.equal(result.total, 2)
  const first = result.items[0]
  assert.equal(first.accountId, 'acc-a')
  assert.equal(first.nickname, '某某')
  assert.equal(first.followers, null)
  assert.equal(first.followersNetGain, null)
  assert.equal(first.baselineDate, null)
  assert.equal(first.collectionStatus, 'never')
  assert.equal(first.publishedCount, 1)
  assert.equal(first.engagementRate, null)
  assert.ok(result.generatedAt)
  assert.equal(result.stale, true)
})

test('contents：contentId 即 jobId，bound 一律 false，指标全 null', async () => {
  const jobs = [job({ id: 'job-xyz' })]
  const result = await source({ jobs }).contents({ ...RANGE, offset: 0, limit: 10 })
  const row = result.items[0]
  assert.equal(row.contentId, 'job-xyz')
  assert.equal(row.projectId, 'proj-1')
  assert.equal(row.bound, false, '绑定是 P2 的事，P1 一律 false')
  assert.equal(row.metrics.views, null)
  assert.equal(row.metrics.likes, null)
  assert.equal(row.engagementRate, null)
  assert.equal(row.source, null)
  assert.equal(row.collectedAt, null)
  assert.equal(result.total, 1)
  assert.ok(result.generatedAt)
})

test('contents：bound:false 过滤即「待绑定」列表（契约已删除 unboundContents）', async () => {
  const jobs = [job({ id: 'job-1' }), job({ id: 'job-2' })]
  const result = await source({ jobs }).contents({ ...RANGE, bound: false, offset: 0, limit: 10 })
  assert.equal(result.total, 2, 'P1 全部内容都是未绑定')
  assert.deepEqual(result.items.map((row) => row.contentId).sort(), ['job-1', 'job-2'])
})

test('contents：按账号与平台筛选', async () => {
  const jobs = [
    job({ id: 'a1', accountId: 'acc-a', platform: 'bilibili' }),
    job({ id: 'a2', accountId: 'acc-b', platform: 'douyin' }),
  ]
  const data = source({ accounts: [account(), account({ id: 'acc-b', platform: 'douyin' })], jobs })
  assert.equal((await data.contents({ ...RANGE, accountId: 'acc-a', offset: 0, limit: 10 })).total, 1)
  assert.equal((await data.contents({ ...RANGE, platform: 'douyin', offset: 0, limit: 10 })).total, 1)
})

test('series：published 按天全量输出，缺失日 0 是真值', async () => {
  const jobs = [job({ proof: { remoteUrl: null, submittedAt: '2026-03-02T10:00:00' } })]
  const result = await source({ jobs }).series({ ...RANGE, metric: 'published', groupBy: 'day' })
  assert.equal(result.metric, 'published')
  assert.equal(result.groupBy, 'day')
  assert.deepEqual(result.points, [
    { date: '2026-03-01', value: 0 },
    { date: '2026-03-02', value: 1 },
    { date: '2026-03-03', value: 0 },
    { date: '2026-03-04', value: 0 },
    { date: '2026-03-05', value: 0 },
    { date: '2026-03-06', value: 0 },
    { date: '2026-03-07', value: 0 },
  ])
  assert.equal(result.stale, false, '发布量是完全已知的本地事实，不算过期')
})

test('series：groupBy=week 用 ISO 周一，同一周的多天合并、缺失周补 0', async () => {
  const jobs = [
    job({ id: 'x', proof: { remoteUrl: null, submittedAt: '2026-03-02T10:00:00' } }),
    job({ id: 'y', proof: { remoteUrl: null, submittedAt: '2026-03-03T11:00:00' } }),
    job({ id: 'z', proof: { remoteUrl: null, submittedAt: '2026-03-05T11:00:00' } }),
  ]
  const result = await source({ jobs }).series({ ...RANGE, metric: 'published', groupBy: 'week' })
  // 3-01 是周日，属 2-23 起那周（区间内无人发布 → 0）；3-02..3-07 同属 3-02 起那周（3 条）
  assert.deepEqual(result.points, [
    { date: '2026-02-23', value: 0 },
    { date: '2026-03-02', value: 3 },
  ])
})

test('series：四个采集指标 P1 无源，返回空 points 且 stale=true（不填 0）', async () => {
  const data = source({ jobs: [job()] })
  for (const metric of ['views', 'likes', 'comments', 'followersNetGain']) {
    const result = await data.series({ ...RANGE, metric })
    assert.deepEqual(result.points, [], `${metric} 无源必须为空数组`)
    assert.equal(result.stale, true, `${metric} 必须标记 stale`)
  }
})

test('series：缺 metric 报 ANALYTICS_INVALID_INPUT', async () => {
  await assert.rejects(() => source().series(RANGE), (error) => error instanceof AnalyticsError && error.code === 'ANALYTICS_INVALID_INPUT')
})

test('publisher 未加载时各读接口独立降级，不抛错、不给白屏', async () => {
  const data = new AnalyticsLocalSource({ publisher: null, spokenVideo: null })
  const summary = await data.summary(RANGE)
  assert.equal(summary.kpis.published.count, 0)
  assert.equal(summary.available.publisher, false)
  assert.match(summary.available.reason, /发布能力包未加载/u)
  assert.deepEqual(summary.funnel, [])
  const accounts = await data.accounts(RANGE)
  assert.deepEqual(accounts.items, [])
  assert.equal(accounts.available, false)
  const contents = await data.contents({ ...RANGE, offset: 0, limit: 10 })
  assert.deepEqual(contents.items, [])
  assert.equal(contents.total, 0)
  const series = await data.series({ ...RANGE, metric: 'published' })
  assert.equal(series.available, false)
})

test('publisher 读取抛错时降级并把原因带给前端，不吞错', async () => {
  const data = new AnalyticsLocalSource({
    publisher: {
      listAccounts: async () => { throw new Error('磁盘炸了') },
      listJobs: async () => { throw new Error('磁盘炸了') },
    },
    spokenVideo: null,
  })
  const result = await data.summary(RANGE)
  assert.equal(result.available.publisher, false)
  assert.match(result.available.reason, /磁盘炸了/u)
})

test('读接口都带 generatedAt+stale，区间原样回显', async () => {
  const data = source({ jobs: [job()], items: [{ stage: 'publish', page: 'publish' }] })
  for (const call of [
    () => data.summary(RANGE),
    () => data.accounts(RANGE),
    () => data.contents({ ...RANGE, offset: 0, limit: 10 }),
    () => data.series({ ...RANGE, metric: 'published' }),
  ]) {
    const result = await call()
    assert.ok(typeof result.generatedAt === 'string' && !Number.isNaN(Date.parse(result.generatedAt)), 'generatedAt 必须是合法 ISO 时间')
    assert.equal(typeof result.stale, 'boolean', 'stale 必须是布尔')
  }
  assert.deepEqual((await data.summary(RANGE)).range, { from: RANGE.from, to: RANGE.to })
})

test('净增粉快照差值口径留了唯一实现点，供 P2 复用', () => {
  assert.deepEqual(AnalyticsLocalSource.followersFromSnapshots([
    { date: '2026-03-01', followers: 1000 },
    { date: '2026-03-05', followers: 1100 },
  ]), { current: 1100, currentDate: '2026-03-05', netGain: 100, baselineDate: '2026-03-01' })
})
