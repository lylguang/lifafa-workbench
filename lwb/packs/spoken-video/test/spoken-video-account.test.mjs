import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCOUNT_COMPLETION_SCHEMA,
  buildAccountCompletionPrompt,
  normalizeAccountSuggestion,
  parseAccountCompletionInput,
} from '../spoken-video-account.mjs'

test('parseAccountCompletionInput requires at least one field and reuses profile limits', () => {
  assert.throws(() => parseAccountCompletionInput({}), /至少录入一项/u)
  assert.throws(() => parseAccountCompletionInput(null), /至少录入一项/u)
  assert.throws(() => parseAccountCompletionInput({ name: '   ' }), /至少录入一项/u)
  assert.deepEqual(parseAccountCompletionInput({ name: ' AI 科普 ' }), { name: 'AI 科普', positioning: null, audience: null, pillars: [], boundary: null })
  const full = parseAccountCompletionInput({ name: '老傅聊 AI', positioning: ' AI 工具解读 ', pillars: ['工具拆解', '工具拆解', '行业观察'], boundary: '不做投资建议' })
  assert.deepEqual(full, { name: '老傅聊 AI', positioning: 'AI 工具解读', audience: null, pillars: ['工具拆解', '行业观察'], boundary: '不做投资建议' })
  assert.throws(() => parseAccountCompletionInput({ name: 'x'.repeat(81) }), /长度必须在 1-80/u)
  assert.throws(() => parseAccountCompletionInput({ positioning: 'p'.repeat(601) }), /长度必须在 1-600/u)
})

test('buildAccountCompletionPrompt treats user input as a polishable draft and lists gaps', () => {
  const prompt = buildAccountCompletionPrompt({ input: parseAccountCompletionInput({ positioning: 'AI科普' }) })
  assert.ok(prompt.includes('用户草稿（保留意图，可润色扩写）'))
  assert.ok(prompt.includes('账号定位：AI科普'))
  assert.ok(prompt.includes('保留其核心意图'))
  assert.ok(prompt.includes('待补齐'))
  assert.ok(prompt.includes('账号名称'))
  assert.ok(prompt.includes('目标受众'))
  assert.ok(prompt.includes('内容方向'))
  assert.ok(prompt.includes('内容边界'))
  assert.ok(prompt.includes('不得编造用户的真实情况'))

  const nameOnly = buildAccountCompletionPrompt({ input: parseAccountCompletionInput({ name: '老傅聊 AI' }) })
  assert.ok(nameOnly.includes('账号名称：老傅聊 AI'))
  const missing = nameOnly.split('待补齐').at(-1)
  assert.ok(!missing.includes('\n- 账号名称'))
  for (const label of ['账号定位', '目标受众', '内容方向', '内容边界']) assert.ok(missing.includes(`- ${label}`))
})

test('normalizeAccountSuggestion lets the AI polish filled fields and fills every gap', () => {
  const input = parseAccountCompletionInput({ positioning: 'AI科普' })
  const result = normalizeAccountSuggestion({
    name: 'AI 科普站',
    positioning: '被扩写后的完整定位',
    audience: '对 AI 好奇的普通人',
    pillars: ['前沿解读', '前沿解读', '工具上手', ''].concat(Array.from({ length: 10 }, (_, index) => `方向${index}`)),
    boundary: '不做医疗与投资建议',
    summary: '已完善',
  }, input)
  assert.equal(result.suggestion.positioning, '被扩写后的完整定位')
  assert.equal(result.suggestion.name, 'AI 科普站')
  assert.equal(result.suggestion.audience, '对 AI 好奇的普通人')
  assert.equal(result.suggestion.pillars.length, 8)
  assert.equal(result.suggestion.boundary, '不做医疗与投资建议')
  assert.deepEqual(result.filled, ['name', 'audience', 'pillars', 'boundary'])
  assert.deepEqual(result.updated, ['positioning'])
  assert.equal(result.summary, '已完善')
  const untouched = normalizeAccountSuggestion({ name: 'AI 科普站', positioning: 'AI科普', audience: '对 AI 好奇的普通人' }, input)
  assert.deepEqual(untouched.updated, [])
})

test('normalizeAccountSuggestion truncates oversized output and survives empty responses', () => {
  const input = parseAccountCompletionInput({ name: '老傅聊 AI' })
  const result = normalizeAccountSuggestion({ positioning: '定'.repeat(700), audience: 'a'.repeat(400), pillars: ['超'.repeat(80)], summary: '长'.repeat(400) }, input)
  assert.equal(result.suggestion.name, '老傅聊 AI')
  assert.equal([...result.suggestion.positioning].length, 600)
  assert.equal([...result.suggestion.audience].length, 300)
  assert.deepEqual(result.suggestion.pillars, [`${'超'.repeat(59)}…`])
  assert.equal([...result.summary].length, 300)
  assert.deepEqual(result.filled, ['positioning', 'audience', 'pillars'])
  const empty = normalizeAccountSuggestion(null, input)
  assert.deepEqual(empty.suggestion, { name: '老傅聊 AI', positioning: null, audience: null, pillars: [], boundary: null })
  assert.deepEqual(empty.filled, [])
})

test('ACCOUNT_COMPLETION_SCHEMA stays an unconstrained object schema', () => {
  assert.equal(ACCOUNT_COMPLETION_SCHEMA.type, 'object')
  assert.deepEqual(ACCOUNT_COMPLETION_SCHEMA.required, [])
  assert.deepEqual(Object.keys(ACCOUNT_COMPLETION_SCHEMA.properties).sort(), ['audience', 'boundary', 'name', 'pillars', 'positioning', 'summary'])
})
