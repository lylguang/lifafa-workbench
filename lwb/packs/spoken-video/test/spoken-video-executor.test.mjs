import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentExecutor } from '../index.mjs'
import { buildVideoCreatorContinuationPrompt } from '../spoken-video-video-agent.mjs'

function executorHarness(reasons) {
  let sessionListener = null
  let disposed = 0
  let started = 0
  let resolveResult
  const followups = []
  const result = new Promise((resolve) => { resolveResult = resolve })
  const session = { id: 'creator-session-1', events: [] }
  const emitTurnEnd = (turn, reason) => {
    const event = { seq: turn, time: Date.now(), type: 'turn/end', data: { turn, reason: { kind: reason } } }
    session.events.push(event)
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
    async start() {
      started += 1
      setImmediate(() => emitTurnEnd(1, reasons[0]))
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
