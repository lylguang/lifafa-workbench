import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bucketSeries,
  contentEngagementRate,
  currentFollowers,
  eachDayKey,
  engagementRate,
  followersNetGain,
  funnelFromPipeline,
  isoWeekStartKey,
  localDateKey,
  publishSuccessRate,
  sortAndPage,
  withinRange,
} from '../analytics-metrics.mjs'

test('互动率分母固定为 views，views 缺失的内容既不进分子也不进分母', () => {
  // S 里只有第一条有 views：100 赞 / 1000 播放 = 0.1
  const contents = [
    { metrics: { views: 1000, likes: 100, comments: 5, shares: 3, favorites: 2 } },
    { metrics: { views: null, likes: 500, comments: 50, shares: 50, favorites: 50 } },
  ]
  assert.equal(engagementRate(contents), 110 / 1000)
})

test('views 为 0 或全为空时互动率是 null，不是 0', () => {
  assert.equal(engagementRate([{ metrics: { views: 0, likes: 10 } }]), null)
  assert.equal(engagementRate([{ metrics: { views: null, likes: 10 } }]), null)
  assert.equal(engagementRate([]), null)
  assert.equal(contentEngagementRate({ views: null, likes: 1 }), null)
  assert.equal(contentEngagementRate({ views: 0, likes: 1 }), null)
})

test('互动率分子里单个指标缺失按 0 计，不让整条变 null', () => {
  assert.equal(engagementRate([{ metrics: { views: 100, likes: 10, comments: null } }]), 0.1)
})

test('净增粉取区间末次减首次，乱序输入也能算出同一个差值', () => {
  const snapshots = [
    { date: '2026-03-05', followers: 1200 },
    { date: '2026-03-01', followers: 1000 },
    { date: '2026-03-10', followers: 1350 },
  ]
  assert.deepEqual(followersNetGain(snapshots), { netGain: 350, baselineDate: '2026-03-01', currentDate: '2026-03-10' })
})

test('净增粉只有一个快照时是 null（差值无从谈起），但仍给出基线日期', () => {
  assert.deepEqual(followersNetGain([{ date: '2026-03-01', followers: 1000 }]), {
    netGain: null,
    baselineDate: '2026-03-01',
    currentDate: '2026-03-01',
  })
  assert.deepEqual(followersNetGain([]), { netGain: null, baselineDate: null, currentDate: null })
})

test('快照跨月分片交界处的净增粉照常计算（只有差值，没有分片假设）', () => {
  const snapshots = [
    { date: '2026-01-31', followers: 900 },
    { date: '2026-02-01', followers: 1000 },
  ]
  assert.equal(followersNetGain(snapshots).netGain, 100)
})

test('粉丝当前值取最新一次有效快照', () => {
  assert.deepEqual(currentFollowers([{ date: '2026-01-01', followers: 10 }, { date: '2026-02-01', followers: 20 }]), {
    current: 20,
    currentDate: '2026-02-01',
  })
  assert.deepEqual(currentFollowers([]), { current: null, currentDate: null })
})

test('发布成功率只拿已出终态的任务做分母，没终态时是 null', () => {
  assert.equal(publishSuccessRate([{ status: 'succeeded' }, { status: 'failed' }]), 0.5)
  assert.equal(publishSuccessRate([{ status: 'queued' }, { status: 'running' }]), null)
  // 待确认的任务尚未定论，不该把成功率压低
  assert.equal(publishSuccessRate([{ status: 'succeeded' }, { status: 'awaiting-confirm' }]), 1)
})

test('本地日期键按本地时区归属，23:59:59 不能滚到第二天', () => {
  const late = new Date(2026, 2, 1, 23, 59, 59)
  assert.equal(localDateKey(late), '2026-03-01')
  assert.equal(localDateKey(new Date(2026, 2, 2, 0, 0, 1)), '2026-03-02')
  assert.equal(localDateKey('not-a-date'), null)
})

test('区间两端闭区间，含端点', () => {
  const from = '2026-03-01T00:00:00'
  const to = '2026-03-07T23:59:59'
  assert.equal(withinRange('2026-03-01T00:00:00', from, to), true)
  assert.equal(withinRange('2026-03-07T23:59:59', from, to), true)
  assert.equal(withinRange('2026-02-28T23:59:59', from, to), false)
  assert.equal(withinRange('2026-03-08T00:00:00', from, to), false)
})

test('ISO 周从周一起算，跨年周也算对（2026-01-01 归入 2025-12-29 那周）', () => {
  // 2026-03-01 是周日 → 它所在 ISO 周的周一是 2026-02-23（不是当天所在周的月末）
  assert.equal(isoWeekStartKey('2026-03-01'), '2026-02-23')
  assert.equal(isoWeekStartKey('2026-03-02'), '2026-03-02') // 周一归自己
  assert.equal(isoWeekStartKey('2026-01-01'), '2025-12-29') // 周四，归上一年的周一
})

test('eachDayKey 含两端', () => {
  assert.deepEqual(eachDayKey('2026-03-01T00:00:00', '2026-03-04T23:59:59'), [
    '2026-03-01',
    '2026-03-02',
    '2026-03-03',
    '2026-03-04',
  ])
})

test('bucketSeries 只 emit 有数据的日期，缺失日不补 0', () => {
  const points = bucketSeries([{ at: '2026-03-01T10:00:00', value: 2 }, { at: '2026-03-03T10:00:00', value: 1 }])
  assert.deepEqual(points, [{ date: '2026-03-01', value: 2 }, { date: '2026-03-03', value: 1 }])
  // 同日多条合并
  assert.deepEqual(bucketSeries([{ at: '2026-03-01T01:00:00', value: 1 }, { at: '2026-03-01T02:00:00', value: 3 }]), [{ date: '2026-03-01', value: 4 }])
})

test('漏斗只保留有项目的阶段，并带上归属页面', () => {
  const rows = funnelFromPipeline([
    { stage: 'video', page: 'video-preview' },
    { stage: 'video', page: 'video-preview' },
    { stage: 'publish', page: 'publish' },
  ])
  assert.deepEqual(rows, [{ stage: 'video', label: '待制作', count: 2, page: 'video-preview' }, { stage: 'publish', label: '可发布', count: 1, page: 'publish' }])
})

test('内容排序把 null 排在末尾，不当成 0 排到最前', () => {
  const rows = [
    { contentId: 'a', metrics: { views: null }, engagementRate: null, publishedAt: '2026-03-03' },
    { contentId: 'b', metrics: { views: 5 }, engagementRate: 0.5, publishedAt: '2026-03-02' },
    { contentId: 'c', metrics: { views: 50 }, engagementRate: 0.2, publishedAt: '2026-03-01' },
  ]
  const desc = sortAndPage(rows, { sort: 'views', order: 'desc' })
  assert.deepEqual(desc.items.map((row) => row.contentId), ['c', 'b', 'a'])
  // asc 也不能把 null 顶到最前
  const asc = sortAndPage(rows, { sort: 'views', order: 'asc' })
  assert.deepEqual(asc.items.map((row) => row.contentId), ['b', 'c', 'a'])
  assert.equal(desc.total, 3)
})

test('分页按 offset/limit 切片并回传总数，desc 从最新一页开始', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    contentId: `c${index}`,
    metrics: { views: index },
    publishedAt: `2026-03-0${index + 1}`,
  }))
  // desc → c4,c3,c2,c1,c0
  const first = sortAndPage(rows, { sort: 'publishedAt', order: 'desc', offset: 0, limit: 2 })
  assert.deepEqual(first.items.map((row) => row.contentId), ['c4', 'c3'])
  const second = sortAndPage(rows, { sort: 'publishedAt', order: 'desc', offset: 1, limit: 2 })
  assert.deepEqual(second.items.map((row) => row.contentId), ['c3', 'c2'])
  assert.deepEqual({ total: first.total, offset: first.offset, limit: first.limit }, { total: 5, offset: 0, limit: 2 })
})

// ── 诊断列与规则式诊断 ─────────────────────────────────────────────────────
import { percentOrNull, durationSecondsOrNull, diagnoseContent } from '../analytics-metrics.mjs'

test('percentOrNull：百分比字符串 / 小数形态 / 非法值', () => {
  assert.equal(percentOrNull('12.34%'), 12.34)
  assert.equal(percentOrNull(0.1234), 12.34)
  assert.equal(percentOrNull(45.6), 45.6)
  assert.equal(percentOrNull('暂无'), null)
  assert.equal(percentOrNull(-1), null)
})

test('durationSecondsOrNull：时分秒 / 秒 / 纯数字', () => {
  assert.equal(durationSecondsOrNull('00:00:42'), 42)
  assert.equal(durationSecondsOrNull('01:05'), 65)
  assert.equal(durationSecondsOrNull('42秒'), 42)
  assert.equal(durationSecondsOrNull(42.4), 42)
  assert.equal(durationSecondsOrNull('待发布'), null)
})

test('diagnoseContent：完播率显著低于中位数要给出可执行建议', () => {
  const peers = [1, 2, 3, 4, 5, 6].map((i) => ({ platform: 'douyin', contentId: `p${i}`, metrics: { views: 100, completionRate: 20 + i } }))
  const weak = { platform: 'douyin', metrics: { views: 100, completionRate: 8 } }
  const diagnosis = diagnoseContent(weak, peers)
  assert.equal(diagnosis.level, 'warn')
  assert.match(diagnosis.messages[0], /完播率 8% 低于账号中位数/, '要点名你的值与基准值')
  assert.match(diagnosis.messages[0], /压缩开头/, '建议必须可执行')
})

test('diagnoseContent：播放量太小不下结论，数据不足只提示积累', () => {
  const small = { platform: 'douyin', metrics: { views: 2, completionRate: 5 } }
  assert.deepEqual(diagnoseContent(small, [{ platform: 'douyin', metrics: { views: 100, completionRate: 30 } }]), {
    level: 'info', messages: ['播放量还小，先攒数据；满 5 次播放后给出诊断。'],
  })
  const lonely = { platform: 'douyin', metrics: { views: 100, completionRate: 5 } }
  const diagnosis = diagnoseContent(lonely, [])
  assert.equal(diagnosis.level, 'info')
  assert.match(diagnosis.messages[0], /数据积累中/)
})
