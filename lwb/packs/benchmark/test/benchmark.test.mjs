import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BenchmarkStore,
  normalizeTeardownAnalysis,
  parseAccountInput,
  parseTeardownInput,
  parseSuggestion,
} from '../benchmark-store.mjs'
import {
  SUGGESTIONS_SCHEMA,
  TEARDOWN_SCHEMA,
  buildSuggestionsPrompt,
  buildTeardownPrompt,
} from '../benchmark-agent.mjs'
import { BenchmarkHost } from '../benchmark-host.mjs'

test('parseAccountInput validates platform, trims fields and dedupes tags', () => {
  assert.throws(() => parseAccountInput({ platform: 'tiktok', name: 'x' }), /平台 不受支持/u)
  assert.throws(() => parseAccountInput({ platform: 'douyin' }), /账号名称/u)
  assert.throws(() => parseAccountInput({ platform: 'douyin', name: 'x', url: 'ftp://a' }), /http\(s\) 链接/u)
  const parsed = parseAccountInput({ platform: ' douyin ', name: ' 某某说AI ', url: ' https://example.com ', note: ' 学习钩子 ', tags: ['口播', '口播', ' AI '] })
  assert.deepEqual(parsed, { platform: 'douyin', name: '某某说AI', url: 'https://example.com', note: '学习钩子', tags: ['口播', 'AI'] })
})

test('parseTeardownInput requires title and content, validates stats and account id', () => {
  assert.throws(() => parseTeardownInput({ title: 't' }), /文案原文/u)
  assert.throws(() => parseTeardownInput({ content: 'c' }), /标题/u)
  assert.throws(() => parseTeardownInput({ title: 't', content: 'c', accountId: 'nope' }), /关联账号标识无效/u)
  assert.throws(() => parseTeardownInput({ title: 't', content: 'c', stats: { views: -1 } }), /播放\/阅读/u)
  assert.throws(() => parseTeardownInput({ title: 't', content: 'c', platform: 'xhsx' }), /平台 不受支持/u)
  const parsed = parseTeardownInput({ title: ' 标题 ', content: ' 正文 ', accountId: '0f0e0d0c-0b0a-0908-0706-050403020100', stats: { views: 100, likes: '' } })
  assert.equal(parsed.title, '标题')
  assert.equal(parsed.accountId, '0f0e0d0c-0b0a-0908-0706-050403020100')
  assert.deepEqual(parsed.stats, { views: 100, likes: undefined, comments: undefined, favorites: undefined })
  assert.ok(parsed.stats)
  const minimal = parseTeardownInput({ title: 't', content: 'c' })
  assert.equal(minimal.accountId, null)
  assert.equal(minimal.stats, undefined)
})

test('normalizeTeardownAnalysis clamps score, limits arrays and drops unknown fields', () => {
  const normalized = normalizeTeardownAnalysis({
    summary: ' 概括 ', hookType: ' 悬念反问 ', hookQuote: ' 原句 ',
    structure: [{ segment: ' 开头 ', purpose: ' 留人 ', extra: 'drop' }],
    pacing: ' 前3秒密集 ', titleFormulas: ['数字+反常识', '数字+反常识'],
    commentInsight: ' 推断 ', reusable: ['动作1'], viralityScore: 128, noise: 'x',
  })
  assert.deepEqual(normalized, {
    summary: '概括', hookType: '悬念反问', hookQuote: '原句',
    structure: [{ segment: '开头', purpose: '留人' }],
    pacing: '前3秒密集', titleFormulas: ['数字+反常识'],
    commentInsight: '推断', reusable: ['动作1'], viralityScore: 100,
  })
  const minimal = normalizeTeardownAnalysis({ summary: 's', hookType: 'h', structure: [], titleFormulas: [], reusable: [], viralityScore: -5 })
  assert.equal(minimal.hookQuote, '')
  assert.equal(minimal.viralityScore, 0)
  assert.equal(minimal.pacing, '')
  assert.throws(() => normalizeTeardownAnalysis({ summary: 's' }), /hookType/u)
})

test('prompts carry the source material and reference teardown conclusions', () => {
  const prompt = buildTeardownPrompt({
    input: { title: '爆款标题', content: '正文内容', platform: 'douyin', stats: { views: 1000, likes: 50 }, url: 'https://example.com' },
    platformLabelOf: (kind) => (kind === 'douyin' ? '抖音' : kind),
  })
  assert.ok(prompt.includes('平台：抖音'))
  assert.ok(prompt.includes('爆款标题'))
  assert.ok(prompt.includes('正文内容'))
  assert.ok(prompt.includes('播放/阅读 1000'))
  assert.ok(prompt.includes('不编造'))

  const suggestions = buildSuggestionsPrompt({
    teardowns: [{ title: '拆解一', platform: 'xhs', analysis: { summary: '总结', hookType: '反常识', titleFormulas: ['公式A'], reusable: ['动作'], viralityScore: 88 } }],
    platformLabelOf: (kind) => (kind === 'xhs' ? '小红书' : kind),
  })
  assert.ok(suggestions.includes('拆解一'))
  assert.ok(suggestions.includes('小红书'))
  assert.ok(suggestions.includes('公式A'))
  assert.ok(suggestions.includes('5-8 条'))
})

test('schema declarations cover every normalized analysis field', () => {
  for (const field of ['summary', 'hookType', 'hookQuote', 'structure', 'pacing', 'titleFormulas', 'commentInsight', 'reusable', 'viralityScore']) {
    assert.ok(TEARDOWN_SCHEMA.required.includes(field), `TEARDOWN_SCHEMA 缺少 ${field}`)
  }
  assert.ok(SUGGESTIONS_SCHEMA.properties.suggestions.items.required.includes('basedOn'))
})

test('parseSuggestion validates shape and dedupes basedOn entries', () => {
  assert.throws(() => parseSuggestion({ title: 't', angle: 'a' }, 's[0]'), /rationale/u)
  const parsed = parseSuggestion({ title: ' t ', angle: ' a ', rationale: ' r ', basedOn: ['x', 'x'] }, 's[0]')
  assert.deepEqual(parsed, { title: 't', angle: 'a', rationale: 'r', basedOn: ['x'] })
})

test('BenchmarkStore round-trips accounts, teardowns and suggestion batches in a temp workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'benchmark-store-'))
  try {
    const store = new BenchmarkStore({ workspacePath: workspace })
    const account = await store.createAccount({ platform: 'douyin', name: '对标一号', tags: ['口播'] })
    assert.equal((await store.listAccounts()).length, 1)
    await store.updateAccount({ id: account.id, platform: 'douyin', name: '对标一号改' })
    assert.equal((await store.listAccounts())[0].name, '对标一号改')

    const record = await store.createTeardown({ title: '爆款标题', content: '正文', accountId: account.id })
    assert.equal(record.status, 'analyzing')
    assert.equal((await store.listTeardowns())[0].status, 'analyzing')

    // 模拟服务重启：analyzing 记录被标记为失败，而不是永久转圈。
    assert.equal(await store.markStaleAnalysesFailed(), true)
    assert.equal((await store.listTeardowns())[0].status, 'failed')

    await store.completeTeardown(record.id, { summary: 's', hookType: 'h', structure: [], titleFormulas: [], reusable: [], viralityScore: 72 })
    const completed = (await store.listTeardowns())[0]
    assert.equal(completed.status, 'completed')
    assert.equal(completed.analysis.viralityScore, 72)
    assert.equal(await store.markStaleAnalysesFailed(), false)

    await store.failTeardown(record.id, '模型超时')
    assert.equal((await store.listTeardowns())[0].status, 'failed')

    const batch = { id: 'batch-1', status: 'running', suggestions: null, error: null, inputs: [], createdAt: new Date().toISOString() }
    await store.saveSuggestionsBatch(batch)
    await store.updateSuggestionsBatch(batch.id, { status: 'completed', suggestions: [] })
    assert.equal((await store.listSuggestionBatches())[0].status, 'completed')

    await store.deleteTeardown(record.id)
    await assert.rejects(() => store.deleteTeardown(record.id), /拆解记录不存在/u)
    await store.deleteAccount(account.id)
    await assert.rejects(() => store.deleteAccount(account.id), /对标账号不存在/u)

    const raw = await readFile(join(workspace, 'data', 'teardowns.json'), 'utf8')
    assert.match(raw, /"schemaVersion": 1/u)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('BenchmarkHost runs teardowns to completion through injected executors', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'benchmark-host-'))
  try {
    const store = new BenchmarkStore({ workspacePath: workspace })
    const prompts = []
    const settled = []
    const background = (promise) => { settled.push(promise.catch(() => {})) }
    const host = new BenchmarkHost({
      store,
      background,
      teardownExecutor: async ({ prompt }) => {
        prompts.push(prompt)
        return { summary: 's', hookType: 'h', structure: [{ segment: 'a', purpose: 'b' }], titleFormulas: [], reusable: [], viralityScore: 55 }
      },
      topicsExecutor: async ({ prompt }) => {
        return { suggestions: [{ title: '建议一', angle: '角度', rationale: '依据拆解一', basedOn: ['拆解一'] }] }
      },
    })
    await host.recoverStaleAnalyses()
    const account = await store.createAccount({ platform: 'douyin', name: '对标一号' })
    const { teardownId } = await host.startTeardown({ title: '拆解一', content: '正文素材', accountId: account.id })
    await Promise.all(settled)
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].includes('正文素材'))
    const status = await host.teardownStatus({ teardownId })
    assert.equal(status.status, 'completed')
    const teardowns = await host.listTeardowns()
    assert.equal(teardowns[0].analysis.viralityScore, 55)

    // 未完成/不存在的记录不能作为选题依据。
    await store.createTeardown({ title: '未完成', content: 'c' })
    await assert.rejects(() => host.startTopicSuggestions({ teardownIds: ['missing'] }), /不存在/u)
    const pending = (await store.listTeardowns()).find((item) => item.title === '未完成')
    await assert.rejects(() => host.startTopicSuggestions({ teardownIds: [pending.id] }), /还没有完成的拆解/u)

    const { teardownId: id2 } = await host.startTeardown({ title: '拆解二', content: '素材二' })
    await Promise.all(settled)
    const second = (await store.listTeardowns()).find((item) => item.id === id2)
    assert.equal(second.status, 'completed')

    const { batchId } = await host.startTopicSuggestions({ teardownIds: [teardowns[0].id] })
    await Promise.all(settled)
    const batches = await host.listSuggestionBatches()
    const finished = batches.find((item) => item.id === batchId)
    assert.equal(finished.status, 'completed')
    assert.equal(finished.suggestions[0].title, '建议一')
    assert.equal((await host.suggestionsStatus({ batchId })).status, 'completed')
    const summary = await host.status()
    assert.equal(summary.accounts, 1)
    assert.equal(summary.teardowns, 3)
    assert.equal(summary.teardownsCompleted, 2)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('BenchmarkHost surfaces executor failures on the teardown record', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'benchmark-host-fail-'))
  try {
    const store = new BenchmarkStore({ workspacePath: workspace })
    const settled = []
    const host = new BenchmarkHost({
      store,
      background: (promise) => { settled.push(promise.catch(() => {})) },
      teardownExecutor: async () => { throw new Error('默认模型未配置') },
      topicsExecutor: async () => { throw new Error('unused') },
    })
    const { teardownId } = await host.startTeardown({ title: '会失败', content: 'c' })
    await Promise.all(settled)
    const status = await host.teardownStatus({ teardownId })
    assert.equal(status.status, 'failed')
    assert.match(status.error, /默认模型未配置/u)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
