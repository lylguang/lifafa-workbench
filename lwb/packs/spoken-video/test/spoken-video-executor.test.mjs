import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentExecutor, createStructuredExecutor, directorTimeBudget } from '../index.mjs'
import { buildVideoCreatorContinuationPrompt } from '../spoken-video-video-agent.mjs'

function executorHarness(reasons) {
  let sessionListener = null
  let disposed = 0
  let started = 0
  let resolveResult
  let rejectResult
  const followups = []
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const log = []
  // 真实 harness 的 Session 没有公开 events 数组，只暴露 seq 与 snapshotEvents(fromSeq)。
  const session = {
    id: 'creator-session-1',
    get seq() { return log.length },
    snapshotEvents: (fromSeq = 0) => log.slice(fromSeq),
  }
  const emitTurnEnd = (turn, reason) => {
    const event = { seq: turn, time: Date.now(), type: 'turn/end', data: { turn, reason: { kind: reason } } }
    log.push(event)
    const before = followups.length
    sessionListener?.(session, event)
    if (reason !== 'max-tokens' || followups.length === before) { idleWaiter?.(); idleWaiter = null }
    if (reason !== 'max-tokens' || followups.length === before) {
      resolveResult({ output: [{ type: 'text', text: reason }], stopReason: reason })
    }
  }
  let idleWaiter = null
  const child = {
    id: session.id,
    session,
    whenIdle() { return new Promise(resolve => { idleWaiter = resolve }) },
    followup(message) {
      followups.push(message)
      const turn = followups.length + 1
      queueMicrotask(() => emitTurnEnd(turn, reasons[turn - 1]))
    },
  }
  const ctx = {
    on(name, callback) {
      assert.equal(name, 'session/event')
      sessionListener = callback
      return () => { sessionListener = null }
    },
  }
  const subagents = {
    async start(_label, { signal } = {}) {
      started += 1
      // reasons === null：模拟「打磨循环」——永不发 turn/end，result 永不 resolve。
      // 与真实 DSH 驱动一致：start 收到的 signal 被 abort 时，result 以错误收尾
      // （这里用 reject 模拟「取消导致 run.result 拒绝」的路径）。
      if (reasons !== null) setImmediate(() => emitTurnEnd(1, reasons[0]))
      signal?.addEventListener('abort', () => rejectResult(signal.reason ?? new Error('cancelled')), { once: true })
      return {
        id: session.id,
        localAgent: child,
        result,
        async dispose() { disposed += 1 },
      }
    },
  }
  return { ctx, subagents, followups, counts: () => ({ disposed, started }) }
}

test('continues a max-token video creator in the same DSH child session', async () => {
  const harness = executorHarness(['max-tokens', 'completed'])
  const continuations = []
  const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator', {
    maxTokenContinuations: 2,
    continuationPrompt: buildVideoCreatorContinuationPrompt,
  })
  const result = await executor({
    prompt: 'create video',
    agent: { id: 'parent-session-1' },
    onDshContinuation: (value) => continuations.push(value),
  })
  assert.equal(result.childSessionId, 'creator-session-1')
  assert.equal(harness.counts().started, 1)
  assert.equal(harness.counts().disposed, 1)
  assert.equal(harness.followups.length, 1)
  assert.match(harness.followups[0].content[0].text, /1\/2/u)
  assert.deepEqual(continuations.map((item) => item.attempt), [1])
})

test('fails clearly after the same creator session reaches three output ceilings', async () => {
  const harness = executorHarness(['max-tokens', 'max-tokens', 'max-tokens'])
  const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator', {
    maxTokenContinuations: 2,
    continuationPrompt: buildVideoCreatorContinuationPrompt,
  })
  await assert.rejects(
    executor({ prompt: 'create video', agent: { id: 'parent-session-1' } }),
    /连续 3 个创作轮次达到单次输出上限/u,
  )
  assert.equal(harness.counts().started, 1)
  assert.equal(harness.counts().disposed, 1)
  assert.equal(harness.followups.length, 2)
})

test('preflight repairs continue the same child, retain diagnostics, and stop after success', async () => {
  const harness = executorHarness(['completed', 'completed'])
  const repairs = []; let checks = 0
  const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator')
  const result = await executor({ prompt: 'create', agent: { id: 'parent' },
    validate: async () => ({ passed: ++checks > 1, repairable: true, failures: ['CreativeVideo.tsx:12 transition'] }),
    repairPrompt: ({ report }) => report.failures.join('\n'), onDshRepair: value => repairs.push(value),
  })
  assert.equal(result.childSessionId, 'creator-session-1')
  assert.equal(checks, 2)
  assert.equal(harness.followups.length, 1)
  assert.match(harness.followups[0].content[0].text, /CreativeVideo.tsx:12/)
  assert.equal(repairs[0].attempt, 1)
  assert.deepEqual(harness.counts(), { started: 1, disposed: 1 })
})

test('preflight repair budget is capped, and protected file changes cannot trigger repairs', async () => {
  for (const repairable of [true, false]) {
    const harness = executorHarness(['completed', 'completed', 'completed'])
    const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator')
    await executor({ prompt: 'create', agent: { id: 'parent' }, maxRepairs: 99,
      validate: async () => ({ passed: false, repairable, failures: ['invalid'] }), repairPrompt: () => 'repair',
    })
    assert.equal(harness.followups.length, repairable ? 2 : 0)
    assert.deepEqual(harness.counts(), { started: 1, disposed: 1 })
  }
})

test('a failed repair turn disposes the child and never proceeds as completed', async () => {
  const harness = executorHarness(['completed', 'error'])
  const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator')
  await assert.rejects(executor({ prompt: 'create', agent: { id: 'parent' },
    validate: async () => ({ passed: false, repairable: true, failures: ['invalid'] }), repairPrompt: () => 'repair',
  }), /视频修复未正常结束/u)
  assert.equal(harness.counts().disposed, 1)
})

test('pack cancellation between preflight and repair prevents another model turn', async () => {
  const harness = executorHarness(['completed'])
  const controller = new AbortController()
  harness.ctx.lwbPackServices = { forPack: () => ({ signal: controller.signal }) }
  const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator')
  await assert.rejects(executor({ prompt: 'create', agent: { id: 'parent' },
    validate: async () => { controller.abort(); return { passed: false, repairable: true, failures: ['invalid'] } }, repairPrompt: () => 'repair',
  }), { name: 'AbortError' })
  assert.equal(harness.followups.length, 0)
  assert.equal(harness.counts().disposed, 1)
})

/**
 * 回归：视频导演必须有时间预算，且超时报错要说清「下一步做什么」。
 *
 * 2026-10-23 线上实测：一条 611 秒长片让创作 Agent 在导演环节连续打磨
 * 61 分钟仍未跑一次预检——它自己写了 audit 脚本，又写了 21 个 tune-*.cjs
 * 反复微调字幕入点，事件流始终活跃、没有任何失败迹象，宿主没有任何机制
 * 能拦它，用户看到的就是「卡在 AI 导演环节 45 分钟」。maxRepairs 只管
 * 预检失败后的修复轮次，不管单轮打磨时长。
 */
test('director time budget defaults to 35 minutes, is overridable, and 0 disables it', () => {
  assert.equal(directorTimeBudget({}), 35 * 60 * 1000)
  assert.equal(directorTimeBudget({ LWB_VIDEO_DIRECTOR_TIMEOUT_MS: '60000' }), 60000)
  // 0 与负数都表示不设限——留给确有特殊长片需求的场景
  assert.equal(directorTimeBudget({ LWB_VIDEO_DIRECTOR_TIMEOUT_MS: '0' }), 0)
  assert.equal(directorTimeBudget({ LWB_VIDEO_DIRECTOR_TIMEOUT_MS: '-1' }), 0)
  // 非法值回落到默认预算，而不是把 NaN 传给 setTimeout（那会立刻触发）
  assert.equal(directorTimeBudget({ LWB_VIDEO_DIRECTOR_TIMEOUT_MS: 'abc' }), 35 * 60 * 1000)
})

test('a creator that never finishes is stopped at the deadline with an actionable message', async () => {
  // 模拟打磨循环：result 永不 resolve（reasons 为 null 表示「不要发 turn/end」）。
  // 2026-10-23 线上实况就是这种形态——事件流活跃、任务不结束、无任何失败迹象。
  const harness = executorHarness(null)
  const previous = process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS
  process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS = '50'
  try {
    const executor = createAgentExecutor(harness.ctx, harness.subagents, 'video-creator')
    await assert.rejects(executor({ prompt: 'create', agent: { id: 'parent' } }),
      /视觉导演超过 0\.1 秒仍未提交可渲染工程[\s\S]*LWB_VIDEO_DIRECTOR_TIMEOUT_MS/u)
  } finally {
    if (previous === undefined) delete process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS
    else process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS = previous
  }
  // 超时必须真的取消了子会话并释放资源——否则打磨循环只是换了个地方继续烧
  assert.equal(harness.counts().disposed, 1)
})

test('structured tasks are never subject to the director deadline', async () => {
  // structured 执行器（选题/写稿等）固定 structured=true，不装时间预算：
  // 50ms 的极端预算也不得打断它。harness 无 structured_output 提交，任务会
  // 以「未通过 structured_output 提交」收尾——关键断言是错误**不是**超时文案，
  // 且没有在 50ms 被取消（dispose 发生在正常收尾路径上）。
  const harness = executorHarness([])
  const previous = process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS
  process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS = '50'
  try {
    const executor = createStructuredExecutor(harness.ctx, harness.subagents, 'topic-generator')
    // harness 无 structured_output 提交 → 结果以「生成未正常结束」收尾。
    // 关键不变量：错误**不是**导演超时文案——50ms 预算没有装到 structured 路径。
    await assert.rejects(executor({ prompt: 'pick topic', agent: { id: 'parent' } }),
      (error) => {
        assert.match(error.message, /生成未正常结束/u)
        assert.doesNotMatch(error.message, /视觉导演超过/u)
        return true
      })
    // harness 只支持一次 start，dispose 断言由上一条非结构化超时用例覆盖。
    assert.equal(harness.counts().disposed, 1)
  } finally {
    if (previous === undefined) delete process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS
    else process.env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS = previous
  }
})
