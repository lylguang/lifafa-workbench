import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function executionChunks(')
const end = source.indexOf('    function ExecutionSession(', start)
const h = React.createElement
const { executionContext, executionToolSummary, executionTurns, ExecutionTranscript } = vm.runInNewContext(`${source.slice(start, end)}; ({ executionContext, executionToolSummary, executionTurns, ExecutionTranscript })`, {
  h, React, exJson: value => { try { return JSON.parse(value) } catch { return null } },
  exText: value => typeof value === 'string' ? value : JSON.stringify(value),
  formatTime: () => '12:00',
  ExecutionText: ({ text }) => h('p', null, text),
  ExecutionData: ({ label, value }) => h('details', null, h('summary', null, label), h('pre', null, JSON.stringify(value))),
})
const event = (seq, type, data = {}) => ({ event: { seq, time: seq, type, data } })
const input = (seq, source, text) => event(seq, 'user/message', { source, content: [{ type: 'text', text }] })
const call = (seq, callId, step = 1) => event(seq, 'tool/call', { turn: 1, step, callId, name: 'bash', arguments: '{"description":"读取创作素材","command":"cat notes.md"}' })
const result = (seq, callId, step = 1, isError = false) => event(seq, 'tool/result', { turn: 1, step, message: { source: { callId }, content: [{ type: 'tool-result', isError, content: [{ type: 'text', text: isError ? '文件不存在' : '素材正文' }] }] } })

test('context producers retain their identity, including future source kinds', () => {
  assert.equal(executionContext({ kind: 'user' }), null)
  assert.equal(executionContext(undefined), null)
  for (const [source, label] of [
    [{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, '@deepseek-ai/dsh-system-prompt'],
    [{ kind: 'skill-catalog' }, 'skill-catalog'],
    [{ kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }, { path: 'AGENTS.md' }] }, 'AGENTS.md'],
    [{ kind: 'skill-invocation', name: 'video' }, 'video'],
    [{ kind: 'future-producer' }, 'future-producer'],
  ]) assert.equal(executionContext(source).label, label)
  assert.equal(executionContext({ kind: 'session-reference', references: [{ label: '创作简报' }] }).title, '上下文召回')
})

test('real context-only history renders process rows without inventing model reasoning', () => {
  const records = [event(1, 'turn/start'), input(2, { kind: 'user' }, '生成选题'), input(3, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, '运行指令'), input(4, { kind: 'skill-catalog' }, '技能目录正文'), event(5, 'assistant/message', { message: { content: [{ type: 'text', text: '选题结果' }] } }), event(6, 'turn/end', { reason: { kind: 'completed' } })]
  const html = renderToStaticMarkup(h(ExecutionTranscript, { records }))
  assert.equal((html.match(/上下文注入/g) || []).length, 2)
  assert.equal((html.match(/任务输入/g) || []).length, 1)
  assert.match(html, /2 项上下文/)
  assert.match(html, /skill-catalog/)
  assert.match(html, /DSH · 结果输出/)
  assert.doesNotMatch(html, /已思考|data-kind="reasoning"/)
})

test('tool result association is stable across pagination and step-local call IDs', () => {
  const tail = [result(4, 'a')]
  assert.equal(executionTurns(tail)[0].rows[0].event.type, 'tool/result')
  const rows = executionTurns([call(3, 'a'), ...tail, call(5, 'a', 2), result(6, 'a', 2, true)])[0].rows
  assert.equal(rows.length, 2)
  assert.equal(rows[0].result.seq, 4)
  assert.equal(rows[1].result.seq, 6)
  const html = renderToStaticMarkup(h(ExecutionTranscript, { records: [call(3, 'a'), ...tail, call(5, 'a', 2), result(6, 'a', 2, true)] }))
  assert.match(html, /读取创作素材/)
  assert.match(html, /素材正文/)
  assert.match(html, /文件不存在/)
  assert.match(html, /data-error="true"/)
})

test('streamed reasoning previews and settled results preserve content without duplication', () => {
  const start = event(1, 'turn/start')
  const partial = { blocks: [{ type: 'reasoning', text: '**核对来源**\n正在比对发布时间' }, { type: 'tool-call', name: 'bash', arguments: '{"description":"读取创作素材"}' }] }
  const live = renderToStaticMarkup(h(ExecutionTranscript, { records: [start], partial }))
  assert.match(live, /title="正在比对发布时间"/)
  assert.match(live, /组织参数/)
  const records = [start, event(2, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '**核对来源**\n已完成比对' }, { type: 'text', text: '最终稿件' }] } }), event(3, 'turn/end', { reason: { kind: 'completed' } })]
  const settled = renderToStaticMarkup(h(ExecutionTranscript, { records }))
  assert.match(settled, /title="核对来源"/)
  assert.equal((settled.match(/最终稿件/g) || []).length, 1)
  assert.doesNotMatch(settled, /组织参数|输出中/)
  assert.equal(executionTurns([...records, event(4, 'turn/start'), call(5, 'b')]).length, 2)
})

test('tool summaries prefer descriptions and paths and tolerate incomplete streamed JSON', () => {
  assert.equal(executionToolSummary('bash', '{"description":"检查素材","command":"ls"}'), '检查素材')
  assert.equal(executionToolSummary('read', { path: '/workspace/script.md' }), '/workspace/script.md')
  assert.equal(executionToolSummary('search', { queries: ['字幕', '配音'] }), '字幕, 配音')
  assert.equal(executionToolSummary('bash', '{"description":'), '{"description":')
  const html = renderToStaticMarkup(h(ExecutionTranscript, { records: [call(1, 'a'), event(2, 'turn/end', { reason: { kind: 'cancelled' } })] }))
  assert.match(html, /未记录返回/)
  assert.doesNotMatch(html, /sv-ex-row-status">执行中/)
})
