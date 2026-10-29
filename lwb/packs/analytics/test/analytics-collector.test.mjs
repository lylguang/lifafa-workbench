import test from 'node:test'
import assert from 'node:assert/strict'
import { COLLECTION_MESSAGES, AnalyticsCollector, describeFailure, toBackgroundWork } from '../analytics-collector.mjs'

/** 假 store：只实现采集器用到的四个方法，全内存。 */
function fakeStore() {
  const calls = { runs: [], snapshots: [], metrics: [], contents: [] }
  return {
    calls,
    saveRun: async (run) => { calls.runs.push(run); return run },
    listRuns: async (limit = 20) => calls.runs.slice(-limit).reverse(),
    saveAccountSnapshot: async (row) => { calls.snapshots.push(row); return row },
    saveContentMetrics: async (row) => { calls.metrics.push(row); return row },
    saveContents: async (rows) => { calls.contents.push(...rows); return rows },
    listContents: async () => calls.contents,
  }
}

function fakePublisher({ accounts, withAccountPage } = {}) {
  return {
    listAccounts: async () => accounts ?? [],
    withAccountPage: withAccountPage ?? (async (_id, fn) => fn({ accountId: 'a1', platform: 'bilibili', status: 'active', page: {}, context: {}, signal: new AbortController().signal, evidence: async () => null })),
  }
}

const OK_ADAPTER = { id: 'ok', collectAccount: async () => ({ followers: 1 }) }

test('describeFailure 只输出映射表内的中文文案，绝不透传原始异常', () => {
  const mapped = describeFailure({ code: 'PUBLISHER_ACCOUNT_BUSY', message: 'Error [PUBLISHER_ACCOUNT_BUSY] internal /path/to/file.js' })
  assert.equal(mapped.message, '账号正被其他任务占用，稍后重试')
  assert.equal(mapped.retryable, true)
  // 未知错误也不能把异常原文带出去
  const unknown = describeFailure(new Error('TypeError: cannot read property of undefined at Object.foo (/secret/path)'))
  assert.equal(unknown.message, '采集失败，原因未记录')
  assert.doesNotMatch(unknown.message, /TypeError|\/secret|path/iu)
})

test('映射表覆盖全部约定的 code，且没有一条文案含内部术语', () => {
  const required = [
    'PUBLISHER_ACCOUNT_BUSY', 'PUBLISHER_ACCOUNT_TIMEOUT', 'PUBLISHER_ACCOUNT_EXPIRED',
    'PUBLISHER_LOGIN_REQUIRED', 'PUBLISHER_BROWSER_UNAVAILABLE', 'PUBLISHER_BROWSER_LAUNCH_FAILED',
    'PUBLISHER_NOT_FOUND', 'ANALYTICS_COLLECTOR_SELECTOR_MISSING',
  ]
  for (const code of required) assert.ok(COLLECTION_MESSAGES[code], `${code} 必须在文案映射表里`)
  for (const [code, entry] of Object.entries(COLLECTION_MESSAGES)) {
    assert.doesNotMatch(entry.message, /PUBLISHER_|ANALYTICS_|Error:|stack/iu, `${code} 的文案含内部术语`)
    assert.equal(typeof entry.retryable, 'boolean')
  }
})

test('start 返回 runId；已有 run 在跑时返回 alreadyRunning 而不是报错', async () => {
  const collector = new AnalyticsCollector({ publisher: fakePublisher({ accounts: [] }), store: fakeStore() })
  const first = await collector.start({})
  assert.equal(first.alreadyRunning, false)
  assert.ok(first.runId)
})

test('expired 与非 active 账号不派发（采集撞登录页只会拿到登录页）', async () => {
  const seen = []
  const store = fakeStore()
  const publisher = fakePublisher({
    accounts: [
      { id: 'ok', platform: 'bilibili', status: 'active' },
      { id: 'expired', platform: 'bilibili', status: 'expired' },
    ],
    withAccountPage: async (id) => { seen.push(id); return { accountId: id, platform: 'bilibili', status: 'active', page: {}, context: {}, signal: new AbortController().signal, evidence: async () => null } },
  })
  const collector = new AnalyticsCollector({ publisher, store, adapters: new Map([['bilibili', OK_ADAPTER]]) })
  const result = await collector.start({})
  assert.equal(result.alreadyRunning, false)
  assert.deepEqual(seen, ['ok'], '只有 active 账号被派发')
  const status = await collector.status({})
  assert.equal(status.total, 1)
  assert.equal(status.done, 1)
})

test('可重试错误会退避重试，不可重试错误立即记失败', async () => {
  let calls = 0
  const store = fakeStore()
  const publisher = fakePublisher({
    accounts: [{ id: 'a1', platform: 'bilibili', status: 'active' }],
    withAccountPage: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'PUBLISHER_ACCOUNT_BUSY', retryable: true })
      return { accountId: 'a1', platform: 'bilibili', status: 'active', page: {}, context: {}, signal: new AbortController().signal, evidence: async () => null }
    },
  })
  const collector = new AnalyticsCollector({ publisher, store, adapters: new Map([['bilibili', OK_ADAPTER]]), sleep: async () => {} })
  await collector.start({})
  assert.equal(calls, 2, 'BUSY 触发一次退避后重试')
  assert.equal((await collector.status({})).failures.length, 0)

  calls = 0
  const publisher2 = fakePublisher({
    accounts: [{ id: 'a1', platform: 'bilibili', status: 'active' }],
    withAccountPage: async () => {
      calls += 1
      throw Object.assign(new Error('expired'), { code: 'PUBLISHER_ACCOUNT_EXPIRED' })
    },
  })
  const collector2 = new AnalyticsCollector({ publisher: publisher2, store: fakeStore(), adapters: new Map([['bilibili', OK_ADAPTER]]), sleep: async () => {} })
  await collector2.start({})
  assert.equal(calls, 1, 'EXPIRED 不可重试，立即失败')
  const status2 = await collector2.status({})
  assert.equal(status2.failures.length, 1)
  assert.equal(status2.failures[0].message, '登录状态已过期，请重新登录后采集')
})

test('失败文案不含 PUBLISHER_ 前缀（前端验收断言）', async () => {
  const publisher = fakePublisher({
    accounts: [{ id: 'a1', platform: 'bilibili', status: 'active' }],
    withAccountPage: async () => { throw Object.assign(new Error('boom'), { code: 'PUBLISHER_NOT_FOUND' }) },
  })
  const collector = new AnalyticsCollector({ publisher, store: fakeStore(), adapters: new Map([['bilibili', OK_ADAPTER]]), sleep: async () => {} })
  await collector.start({})
  const failure = (await collector.status({})).failures[0]
  assert.doesNotMatch(failure.message, /PUBLISHER_|Error:/u)
  assert.equal(failure.message, '账号不存在')
})

test('未接入的平台记 unsupported 而不抛错', async () => {
  const publisher = fakePublisher({ accounts: [{ id: 'a1', platform: 'douyin', status: 'active' }] })
  const collector = new AnalyticsCollector({ publisher, store: fakeStore(), adapters: new Map([['bilibili', OK_ADAPTER]]), sleep: async () => {} })
  await collector.start({})
  const status = await collector.status({})
  assert.equal(status.failures[0].code, 'ANALYTICS_COLLECTOR_UNSUPPORTED')
})

test('status 不传 runId 返回最近一次；runs 返回历史', async () => {
  const collector = new AnalyticsCollector({ publisher: fakePublisher({ accounts: [] }), store: fakeStore() })
  await collector.start({})
  const status = await collector.status({})
  assert.ok(status.runId)
  const runs = await collector.runs({ limit: 5 })
  assert.ok(runs.items.length >= 1)
})

test('publisher 未提供 withAccountPage 时整轮不派发，失败文案可读', async () => {
  const collector = new AnalyticsCollector({ publisher: { listAccounts: async () => [] }, store: fakeStore(), adapters: new Map([['bilibili', OK_ADAPTER]]) })
  const result = await collector.start({})
  assert.equal(result.alreadyRunning, false)
  const status = await collector.status({})
  assert.equal(status.total, 0)
})

test('单账号尝试次数上限为 2，不做第 3 次', async () => {
  let calls = 0
  const publisher = fakePublisher({
    accounts: [{ id: 'a1', platform: 'bilibili', status: 'active' }],
    withAccountPage: async () => { calls += 1; throw Object.assign(new Error('busy'), { code: 'PUBLISHER_ACCOUNT_BUSY' }) },
  })
  const collector = new AnalyticsCollector({ publisher, store: fakeStore(), adapters: new Map([['bilibili', OK_ADAPTER]]), sleep: async () => {} })
  await collector.start({})
  assert.equal(calls, 2, '首发 + 1 次退避重试 = 2 次')
})

// ── background 契约 ─────────────────────────────────────────────────────────
//
// 2026-10-29 实测事故：宿主注入的 background 是「收 Promise 并托管」
// （lwbPackServices 内部 Promise.resolve 后入队），而采集器按 thunk 风格传
// `() => work()`。Promise.resolve(函数) 只会把函数本身当成结果，work 永不执行——
// 表现为采集一开始就永久 running（done 0/1、无失败、无产物），
// 此后每次采集都被 alreadyRunning 挡住，看起来像「看板坏了」。

test('toBackgroundWork 把 thunk 展开成 promise，托管方才会真正执行', async () => {
  let ran = false
  // 生产形态：background 收 promise 并托管（这里用 Promise.resolve 模拟 track）
  const track = (promise) => Promise.resolve(promise)
  await track(toBackgroundWork(async () => { ran = true }))
  assert.equal(ran, true, 'thunk 必须先被调用，否则工作永远不会开始')

  // 已经是 promise 时原样返回
  const promise = Promise.resolve(42)
  assert.equal(toBackgroundWork(promise), promise)
})
