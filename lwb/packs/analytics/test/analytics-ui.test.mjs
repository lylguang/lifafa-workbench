import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import {
  COLLECTION_STATUS,
  coverage,
  densifySeries,
  displayCount,
  displayRate,
  engagementRate,
  funnelRows,
  localDateKey,
  metricNumber,
  platformBreakdown,
  platformLabel,
  rangeWindow,
  successRate,
  topContents,
} from '../analytics-ui-metrics.mjs'

/*
 * 前端口径跑在浏览器 bundle 里（client.js 无法 import 宿主 .mjs），
 * 所以同一套逻辑有两份副本：本文件直接测 analytics-ui-metrics.mjs，
 * 下面再把 client.js 拉进 vm 沙箱真跑一遍，两边用同一组断言。
 * 任一侧口径漂移都会在这里暴露。
 */

const clientPath = new URL('../client.js', import.meta.url)

async function clientMetrics() {
  const source = await readFile(clientPath, 'utf8')
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { sandbox.exports = factory(requireStub) } } } }
  const requireStub = (name) => { if (name === 'react') return reactStub(); throw new Error(`未预期的依赖：${name}`) }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  // 工厂的返回值本身就是 module.exports。
  return sandbox.exports.__metrics
}

function reactStub() {
  const useState = () => [null, () => {}]
  return {
    createElement: () => null,
    useState,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

test('metricNumber keeps real zeros but turns every unknown into null', () => {
  assert.equal(metricNumber(0), 0)
  assert.equal(metricNumber('1200'), 1200)
  assert.equal(metricNumber(null), null)
  assert.equal(metricNumber(undefined), null)
  assert.equal(metricNumber(''), null)
  assert.equal(metricNumber('abc'), null)
  assert.equal(metricNumber(-1), null)
  assert.equal(metricNumber(Number.NaN), null)
})

test('displayCount never renders an unknown as 0', () => {
  assert.equal(displayCount(0), '0')
  assert.equal(displayCount(null), '—')
  assert.equal(displayCount(undefined), '—')
  assert.equal(displayCount(12345), '1.2 万')
  assert.equal(displayCount(123456789), '1.23 亿')
})

test('displayRate renders missing rates as a dash, not 0.00%', () => {
  assert.equal(displayRate(null), '—')
  assert.equal(displayRate(undefined), '—')
  assert.equal(displayRate(0), '0.00%')
  assert.equal(displayRate(0.1234), '12.34%')
})

test('engagementRate follows 定稿 §4.3-1: denominator is views, unbound and null-view items excluded', () => {
  const rate = engagementRate([
    { bound: true, metrics: { views: 1000, likes: 100, comments: 20, shares: 10, favorites: 20 } },
    { bound: true, metrics: { views: 1000, likes: 50, comments: 0, shares: 0, favorites: 0 } },
  ])
  assert.equal(rate, (150 + 50) / 2000)

  // views 缺失的内容不进分子也不进分母。
  assert.equal(engagementRate([{ bound: true, metrics: { likes: 999 } }]), null)
  // views 为 0 的内容同样不参与，结果是 null 而不是 0。
  assert.equal(engagementRate([{ bound: true, metrics: { views: 0, likes: 5 } }]), null)
  // 未绑定的内容不进集合。
  assert.equal(engagementRate([{ bound: false, metrics: { views: 500, likes: 100 } }]), null)
  // 单字段 null 按 0 参与分子。
  assert.equal(engagementRate([{ bound: true, metrics: { views: 100, likes: null, comments: 10 } }]), 0.1)
  assert.equal(engagementRate([]), null)
  assert.equal(engagementRate(null), null)
})

test('platformBreakdown ignores platforms without views and computes shares', () => {
  const result = platformBreakdown([
    { platform: 'douyin', views: 300 },
    { platform: 'bilibili', views: 100 },
    { platform: 'xhs', views: null },
  ])
  assert.equal(result.total, 400)
  assert.deepEqual(result.items.map((item) => item.label), ['抖音', 'B站'])
  assert.equal(result.items[0].share, 0.75)
  assert.equal(platformBreakdown([]).total, 0)
})

test('coverage reports "来自 N/M 个账号" for the 总播放 KPI', () => {
  assert.equal(coverage([{ followers: 10 }, { followers: null, publishedCount: 2 }, {}]).label, '来自 2/3 个账号')
  assert.equal(coverage([]).label, '来自 0/0 个账号')
})

test('densifySeries fills gaps with null, never 0', () => {
  const result = densifySeries(
    [{ date: '2026-10-01', value: 5 }, { date: '2026-10-04', value: 7 }],
    { from: '2026-10-01T00:00:00', to: '2026-10-05T23:59:59' },
  )
  assert.deepEqual(result.points.map((item) => item.value), [5, null, null, 7, null])
  assert.equal(result.filled, 3)
  // 无法确定区间时原样返回，不凭空造点。
  assert.deepEqual(densifySeries([{ date: '2026-10-01', value: 1 }]).points, [{ date: '2026-10-01', value: 1 }])
})

test('rangeWindow covers 近 N 天 inclusively and ends at end of day', () => {
  const window_ = rangeWindow('7d', new Date(2026, 9, 19, 12, 0, 0))
  assert.equal(window_.days, 7)
  assert.equal(localDateKey(window_.from), '2026-10-13')
  assert.equal(localDateKey(window_.to), '2026-10-19')
  assert.equal(rangeWindow('30d').days, 30)
})

test('successRate returns null when there were no publish jobs at all', () => {
  assert.equal(successRate({ count: 4, success: 3 }), 0.75)
  assert.equal(successRate({ count: 0, success: 0 }), null)
  assert.equal(successRate(null), null)
  assert.equal(successRate({ count: 2 }), null)
})

test('funnelRows labels pipeline stages and keeps missing counts as null', () => {
  const rows = funnelRows([{ stage: 'script-pending', count: 3, page: 'scripts' }, { stage: 'publish', count: null }])
  assert.equal(rows[0].label, '待写稿')
  assert.equal(rows[1].label, '可发布')
  assert.equal(rows[1].count, null)
  assert.deepEqual(funnelRows(null), [])
})

test('topContents ranks by views and pushes unknown metrics to the end', () => {
  const ranked = topContents([
    { contentId: 'a', metrics: { views: 10 } },
    { contentId: 'b', metrics: { views: 900 } },
    { contentId: 'c', metrics: { views: null } },
  ], 'views', 2)
  assert.deepEqual(ranked.map((item) => item.contentId), ['b', 'a'])
  // 采集尚未上线时全部缺失，返回空榜而不是把缺失当 0 排进去。
  assert.deepEqual(topContents([{ contentId: 'a', metrics: {} }], 'views'), [])
})

test('collection status vocabulary matches the contract in 定稿 §4.2-2', () => {
  assert.deepEqual([...COLLECTION_STATUS], ['ok', 'stale', 'expired', 'failed', 'never'])
})

test('platformLabel passes unknown platforms through instead of swallowing them', () => {
  assert.equal(platformLabel('douyin'), '抖音')
  assert.equal(platformLabel('tiktok'), 'tiktok')
  assert.equal(platformLabel(null), '—')
})

test('client.js exposes the same metric behaviour as analytics-ui-metrics.mjs', async () => {
  const metrics = await clientMetrics()
  assert.equal(metrics.metricNumber(null), null)
  assert.equal(metrics.displayCount(null), '—')
  assert.equal(metrics.displayRate(null), '—')
  assert.equal(metrics.engagementRate([{ bound: true, metrics: { views: 200, likes: 20 } }]), 0.1)
  assert.equal(metrics.engagementRate([{ bound: true, metrics: { likes: 20 } }]), null)
  assert.equal(metrics.coverage([{ followers: 1 }]).label, '来自 1/1 个账号')
  assert.deepEqual(
    // 沙箱是另一个 realm，数组原型不同，逐项断言而不是 deepStrictEqual。
    [...metrics.densifySeries([{ date: '2026-10-01', value: 1 }], { from: '2026-10-01T00:00:00', to: '2026-10-02T23:59:59' }).points].map((item) => item.value),
    [1, null],
  )
  assert.equal(metrics.successRate({ count: 0, success: 0 }), null)
  assert.equal(metrics.funnelRows([{ stage: 'voiceover', count: 1 }])[0].label, '待配音 / 字幕')
  assert.equal(metrics.collectionStatusLabel('never').label, '尚未采集')
  assert.deepEqual(Object.keys(metrics).sort(), [
    'collectionStatusLabel', 'coverage', 'densifySeries', 'displayCount', 'displayRate',
    'engagementRate', 'funnelRows', 'localDateKey', 'metricNumber', 'platformBreakdown',
    'platformLabel', 'rangeWindow', 'successRate', 'topContents',
  ])
})
