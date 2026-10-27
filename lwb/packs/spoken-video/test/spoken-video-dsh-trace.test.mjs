import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendDshTrace,
  appendDshSessionTrace,
  dshTrace,
  ensureDshTrace,
  projectDshSessionEvent,
  startDshTraceSession,
} from '../spoken-video-dsh-trace.mjs'

test('projects only safe DSH execution facts and discards model text and raw tool data', () => {
  const at = '2026-09-03T01:02:03.000Z'
  const trace = dshTrace()
  const start = projectDshSessionEvent({ seq: 1, time: Date.parse(at), type: 'step/start', data: { turn: 1, step: 1 } }, at)
  const call = projectDshSessionEvent({ seq: 2, time: Date.parse(at), type: 'tool/call', data: { name: 'web/search', arguments: '{"token":"do-not-store"}' } }, at)
  const result = projectDshSessionEvent({ seq: 3, time: Date.parse(at), type: 'tool/result', data: { error: { name: 'Error', code: 'FAILED' }, message: 'secret result body' } }, at)
  const text = projectDshSessionEvent({ seq: 4, time: Date.parse(at), type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'model text must stay private' } } }, at)
  const reasoning = projectDshSessionEvent({ seq: 5, time: Date.parse(at), type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'reasoning must stay private' } } }, at)

  assert.equal(text, null)
  assert.equal(reasoning, null)
  assert.equal(appendDshTrace(trace, start), true)
  assert.equal(appendDshTrace(trace, call), true)
  assert.equal(appendDshTrace(trace, result), true)
  assert.equal(appendDshTrace(trace, { ...start }), false)
  assert.deepEqual(trace.events, [
    { id: 'session-1', at, status: 'running', label: 'DSH 正在请求模型生成', detail: null },
    { id: 'session-2', at, status: 'running', label: 'DSH 正在调用工具', detail: 'web/search' },
    { id: 'session-3', at, status: 'error', label: '一个工具步骤未完成', detail: null },
  ])
  assert.equal(JSON.stringify(trace).includes('do-not-store'), false)
  assert.equal(JSON.stringify(trace).includes('secret result body'), false)
})

test('额度兜底换模型的事件要说清是换模型，而不是原地重试', () => {
  // 2026-10-26 实测：默认模型额度耗尽后换模型重跑。如果这里复用
  // 「模型重试步骤结束」，用户会以为原地重试能解决——而额度耗尽恰恰是
  // 原地重试永远解决不了的。
  const at = '2026-10-26T11:12:00.000Z'
  const projected = projectDshSessionEvent({
    seq: 9,
    time: Date.parse(at),
    type: 'quota/fallback',
    data: { reason: { kind: 'quota-fallback', message: '当前模型额度已耗尽，改用 workbuddy-ai/deepseek-v4.1-flash 重试一次' } },
  }, at)
  assert.equal(projected.status, 'running')
  assert.match(projected.label, /额度/u, '必须说清是额度问题')
  assert.match(projected.label, /换/u, '必须说清是换模型重跑')
})

test('repairs a legacy generation record with an empty DSH trace', () => {
  const record = {}
  const trace = ensureDshTrace(record)
  assert.equal(record.dsh, trace)
  assert.deepEqual(trace, { childSessionId: null, parentSessionId: null, events: [], sessions: [] })
})

test('keeps creator and reviewer events in separate DSH trace sessions', () => {
  const trace = dshTrace()
  startDshTraceSession(trace, { role: 'creator', label: '视觉导演', childSessionId: 'creator-1', parentSessionId: 'parent-1' })
  appendDshSessionTrace(trace, 'creator', { id: 'session-1', at: '2026-09-09T00:00:00.000Z', status: 'running', label: '正在创作', detail: null })
  startDshTraceSession(trace, { role: 'reviewer', label: '独立审片', childSessionId: 'reviewer-1', parentSessionId: 'parent-1' })
  appendDshSessionTrace(trace, 'reviewer', { id: 'session-1', at: '2026-09-09T00:00:01.000Z', status: 'done', label: '审片完成', detail: null })
  assert.deepEqual(trace.sessions.map((session) => session.role), ['creator', 'reviewer'])
  assert.deepEqual(trace.events.map((event) => event.id), ['creator-session-1', 'reviewer-session-1'])
  assert.equal(trace.childSessionId, 'reviewer-1')
})

test('projects max-token turn endings as a recoverable continuation state', () => {
  const at = '2026-09-10T03:51:58.945Z'
  const projected = projectDshSessionEvent({
    seq: 13,
    time: Date.parse(at),
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'max-tokens' } },
  }, at)
  assert.deepEqual(projected, {
    id: 'session-13',
    at,
    status: 'running',
    label: 'DSH 达到单次输出上限，正在继续',
    detail: null,
  })
})
