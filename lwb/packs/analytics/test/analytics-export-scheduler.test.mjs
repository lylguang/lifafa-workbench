/**
 * RPC 12 导出 与 定时调度（P2 收尾两项）。
 *
 * 导出必须与页面所见同口径（复用 contents 而非另开查询），
 * 调度必须「不并发、不补跑、可撤销」——这三条是这里真正要守的东西。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { AnalyticsExport } from '../analytics-export.mjs'
import { AnalyticsScheduler } from '../analytics-scheduler.mjs'

const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' }

function hostWith(items, total = items.length) {
  return { contents: async () => ({ items, total, stale: false }) }
}

test('CSV 带表头、UTF-8 BOM 与行数', async () => {
  const exporter = new AnalyticsExport({ host: hostWith([
    { contentId: 'j1', title: '标题一', platform: 'bilibili', metrics: { views: 10 } },
    { contentId: 'j2', title: '标题二', platform: 'bilibili', metrics: {} },
  ]) })
  const res = await exporter.analyticsExport({ ...RANGE, format: 'csv' })
  assert.equal(res.rowCount, 2)
  assert.ok(res.content.startsWith('﻿'), 'CSV 需要 BOM 让 Excel 正确识别中文')
  const lines = res.content.replace('﻿', '').trim().split('\r\n')
  assert.equal(lines.length, 3)
  assert.ok(lines[0].includes('内容ID'))
  assert.ok(lines[1].includes('标题一'))
})

test('指标缺失导出为空单元格，绝不写成 0', async () => {
  const exporter = new AnalyticsExport({ host: hostWith([
    { contentId: 'j1', metrics: { views: 0, likes: null, comments: null } },
  ]) })
  const res = await exporter.analyticsExport({ ...RANGE, format: 'csv' })
  const cells = res.content.replace('﻿', '').trim().split('\r\n')[1].split(',')
  const header = res.content.replace('﻿', '').trim().split('\r\n')[0].split(',')
  // 真实的 0（确实没人看）导出成 0；未知的 null 导出成空单元格。
  assert.equal(cells[header.indexOf('播放')], '0', '真实零值应保留')
  assert.equal(cells[header.indexOf('点赞')], '', '未知指标应为空单元格，不能是 0')
  assert.equal(cells[header.indexOf('评论')], '', '未知指标应为空单元格，不能是 0')
})

test('标题含逗号/引号/换行时正确转义', async () => {
  const exporter = new AnalyticsExport({ host: hostWith([
    { contentId: 'j1', title: 'a,b"c\nd', metrics: {} },
  ]) })
  const res = await exporter.analyticsExport({ ...RANGE })
  const body = res.content.replace('﻿', '').trim().split('\r\n').slice(1).join('\r\n')
  assert.ok(body.includes('"a,b""c\nd"'), '分隔符与引号需按 RFC 4180 转义')
})

test('assetUrl 字段保留但为 null（网关待落地），字段不删不改名', async () => {
  const exporter = new AnalyticsExport({ host: hostWith([]) })
  const res = await exporter.analyticsExport({ ...RANGE })
  assert.equal(res.assetUrl, null)
  assert.ok('assetUrl' in res)
})

test('超出 limit 时标 truncated，不假装导全了', async () => {
  const exporter = new AnalyticsExport({ host: hostWith([{ contentId: 'j1', metrics: {} }], 500) })
  const res = await exporter.analyticsExport({ ...RANGE })
  assert.equal(res.truncated, true)
  assert.equal(res.rowCount, 1)
})

test('不支持的格式报 INVALID_INPUT，不静默降级', async () => {
  const exporter = new AnalyticsExport({ host: hostWith([]) })
  await assert.rejects(() => exporter.analyticsExport({ ...RANGE, format: 'xlsx' }), (error) => {
    assert.equal(error.code, 'ANALYTICS_INVALID_INPUT')
    return true
  })
})

// ---- 调度 ----

function fakeClock() {
  const timers = []
  return {
    timers,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1 },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true },
    // 被 clearTimeout 撤销的定时器不会真的触发（与真 setTimeout 一致）。
    async run(id) { if (!timers[id]?.cleared) await timers[id].fn() },
  }
}

function stubCollector() {
  const calls = []
  return { calls, async start(req) { calls.push(req); return { runId: `run${calls.length}` } } }
}

test('排期在间隔到达时才触发采集，且 trigger 为 schedule', async () => {
  const collector = stubCollector()
  const clock = fakeClock()
  const scheduler = new AnalyticsScheduler({
    collector, intervalMs: 1000, background: (work) => work(), ...clock,
  })
  scheduler.start()
  assert.equal(collector.calls.length, 0, '启动时不该立刻采集')
  await clock.run(0)
  assert.equal(collector.calls.length, 1)
  assert.equal(collector.calls[0].trigger, 'schedule')
  scheduler.stop()
})

test('stop 后不再触发，且已排的定时器被清掉', async () => {
  const collector = stubCollector()
  const clock = fakeClock()
  const scheduler = new AnalyticsScheduler({ collector, intervalMs: 1000, background: (work) => work(), ...clock })
  scheduler.start()
  scheduler.stop()
  assert.ok(clock.timers[0].cleared, 'stop 应清掉已排的定时器')
  await clock.run(0)
  assert.equal(collector.calls.length, 0)
})

test('start 幂等：重复调用不会排出两条链', async () => {
  const collector = stubCollector()
  const clock = fakeClock()
  const scheduler = new AnalyticsScheduler({ collector, intervalMs: 1000, background: (work) => work(), ...clock })
  assert.equal(scheduler.start(), true)
  assert.equal(scheduler.start(), false, '重复 start 应被忽略')
  assert.equal(clock.timers.length, 1)
  scheduler.stop()
})

test('采集抛错不外抛（无人盯着该 Promise），且仍会排下一轮', async () => {
  let calls = 0
  const collector = { async start() { calls += 1; if (calls === 1) throw new Error('boom'); return { runId: 'r' } } }
  const clock = fakeClock()
  const scheduler = new AnalyticsScheduler({ collector, intervalMs: 1000, background: (work) => work(), ...clock })
  scheduler.start()
  await clock.run(0)
  assert.equal(clock.timers.length, 2, '失败后仍要排下一轮，否则调度会静默死掉')
  await clock.run(1)
  assert.equal(calls, 2)
  scheduler.stop()
})

test('describe 暴露排期状态与预算，便于宿主打印', () => {
  const scheduler = new AnalyticsScheduler({ collector: stubCollector(), intervalMs: 86_400_000 })
  const info = scheduler.describe()
  assert.equal(info.running, false)
  assert.equal(info.intervalMs, 86_400_000)
  assert.equal(info.lastRunId, null)
  assert.ok(info.budget, '应带上采集预算常量')
})
