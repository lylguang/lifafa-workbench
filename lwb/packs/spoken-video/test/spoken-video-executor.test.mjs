import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createAgentExecutor, createStructuredExecutor, directorTimeBudget, reviewerTimeBudget } from '../index.mjs'
import { buildVideoCreatorContinuationPrompt } from '../spoken-video-video-agent.mjs'
import { classifyFailure } from '../spoken-video-failure.mjs'

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
  const emitTurnEnd = async (turn, reason) => {
    const event = { seq: turn, time: Date.now(), type: 'turn/end', data: { turn, reason: { kind: reason } } }
    log.push(event)
    const before = followups.length
    sessionListener?.(session, event)
    // 续写 followup 现在被推迟到微任务里（真实 DSH 的 Session.append 有重入守卫，
    // 在 session/event 回调里同步 append 会抛
    // `session append cannot reenter while another append is being published`）。
    // 所以这里必须让出一轮微任务再判断「有没有触发续写」。
    await Promise.resolve()
    await Promise.resolve()
    if (reason !== 'max-tokens' || followups.length === before) {
      idleWaiter?.(); idleWaiter = null
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

/**
 * 模拟上游网关额度耗尽的执行器。
 *
 * 真实形态（2026-10-26 实测）：模型请求立刻被网关拒绝，子会话发出
 * `turn/end`，原因是 `{ kind: 'error', error: { message, code } }`，
 * `stopReason` 为 'error'，LLM token 用量为 0。
 *
 * 这个 harness 让第一次尝试按「额度耗尽」收尾、第二次按「成功提交结构化
 * 结果」收尾，用以验证额度兜底换模型确实会发生、且只发生一次。
 */
function quotaHarness(quotaMessage) {
  let sessionListener = null
  let disposed = 0
  let started = 0
  const routes = []
  const ctx = {
    on(name, callback) {
      assert.equal(name, 'session/event')
      sessionListener = callback
      return () => { sessionListener = null }
    },
  }
  const subagents = {
    async start(_label, { agentOptions } = {}) {
      started += 1
      routes.push(agentOptions)
      const attempt = started
      const log = []
      const session = {
        id: `quota-session-${attempt}`,
        get seq() { return log.length },
        snapshotEvents: () => log,
      }
      const reason = attempt === 1
        ? { kind: 'error', error: { message: quotaMessage, code: 'QUOTA' } }
        : { kind: 'completed' }
      let resolveResult
      const result = new Promise((resolve) => { resolveResult = resolve })
      const child = {
        id: session.id,
        session,
        whenIdle() { return Promise.resolve() },
        followup() {},
      }
      setImmediate(() => {
        const event = { seq: 1, time: Date.now(), type: 'turn/end', data: { turn: 1, reason } }
        log.push(event)
        sessionListener?.(session, event)
        resolveResult({
          stopReason: attempt === 1 ? 'error' : 'completed',
          ...(attempt === 1 ? {} : { structured: { ok: true } }),
        })
      })
      return {
        id: session.id,
        localAgent: child,
        result,
        async dispose() { disposed += 1 },
      }
    },
  }
  return { ctx, subagents, routes, counts: () => ({ disposed, started }) }
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

test('structured tasks ask for a large output budget and can recover from max-tokens', async () => {
  // 2026-10-25 定时任务「11」在写稿阶段失败：
  //   `生成未正常结束（max-tokens）：子会话以 max-tokens 结束`
  // 事件流显示「DSH 达到单次输出上限，正在继续」之后就没有下文了——因为续写
  // 机制只对**非结构化**任务生效（observer 里 `if (structured || ...) return`），
  // 而写稿恰恰是 structured，且它要在一个 JSON 里装下整篇口播稿 + 大纲 +
  // 事实核查 + 风险提示，是最容易触顶的形态。
  //
  // 这里锁住两条修复：结构化任务显式要一个够大的 maxTokens；撞到 max-tokens
  // 时给一次同会话续写机会，而不是直接判死。
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  // 输出预算改为可配置项，默认 128k，结构化与非结构化执行器统一申请。
  assert.match(source, /maxTokens = 128_000/u, '执行器默认必须申请 128k 输出预算')
  assert.match(source, /\.\.\.\(maxTokens \? \{ maxTokens \} : \{\}\)/u, 'maxTokens 必须真的传给 subagents.start')
  // 视频导演也是大输出任务（历史成功案例的组件 84KB），续写次数要够。
  assert.match(source, /maxTokenContinuations: 4/u, '视频导演的续写次数要抬到 4')
  // 续写补救必须存在，且只针对 structured + max-tokens。
  assert.match(source, /if \(structured && result\.stopReason === 'max-tokens'\)/u,
    '结构化任务撞到 max-tokens 时要有补救分支')
  assert.match(source, /被截断了。请接着已生成的内容/u, '续写提示要说明被截断并要求接着写')
  // 补救只给一次，不能无限续写。
  const branch = source.slice(source.indexOf("if (structured && result.stopReason === 'max-tokens')"))
  const body = branch.slice(0, branch.indexOf('if (result.stopReason !== '))
  assert.equal((body.match(/child\.followup\(/g) || []).length, 1, '续写只允许一次')
})

test('续写 followup 不能在 session/event 回调里同步执行（DSH 有重入守卫）', async () => {
  // 2026-10-25 实测：定时任务「11」的视频导演跑了 18 分钟，整轮栽在
  //   `session append cannot reenter while another append is being published`
  // 渲染一次都没开始。原因是 observeEvent 里同步调 child.followup()，而 followup
  // 本质是往子会话 append，DSH 的 Session.append 此时带着 appending 标志位
  // （packages/core/session/src/index.ts 的重入守卫），同步 append 直接抛错。
  //
  // 这条用例守的是「必须延后」这个事实——用 queueMicrotask 把 append 推到
  // 发布边界之外。
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const listener = source.slice(source.indexOf('const observeEvent ='), source.indexOf('const disposeSessionEvent'))
  assert.match(listener, /queueMicrotask\(/u, '续写 followup 必须延后到微任务')
  // followup 调用必须出现在 queueMicrotask 的回调里，而不是监听器的主体中。
  const micro = listener.slice(listener.indexOf('queueMicrotask('))
  assert.match(micro, /child\.followup\(/u, 'followup 必须在延后回调里调用')
})

test('视频导演用专用模型，且模型/预算必须走 agentOptions', async () => {
  // 2026-10-25 失败日志分析：33 次工具调用里 31 次是 read/glob，零次 write，
  // src/CreativeVideo.tsx 只落下 1KB。路由到的 step-5-preview 在这类长任务上
  // 收敛不了，所以视频导演单独指定 deepseek-v4.1-flash（同条件实测 13.1s 写出
  // 12615 字符的完整 Remotion 组件）。
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(source, /model: 'workbuddy-ai\/deepseek-v4\.1-flash'/u, '视频导演必须指定专用模型')

  // 关键结构约束：SubagentStartRequest 没有顶层 model / maxTokens，写错了不报错，
  // 只会被静默忽略（等于修复完全没生效）。必须放进 agentOptions。
  assert.match(source, /agentOptions: \{/u, '必须通过 agentOptions 传模型与预算')
  assert.match(source, /route\.model \|\| effectiveModel/u, 'model 必须和 provider 成对出现')
  const body = source.slice(source.indexOf('run = await subagents.start'), source.indexOf('childSessionId = run.id'))
  assert.doesNotMatch(body, /^\s*model: /mu, '不允许在顶层传 model（会被静默忽略）')
  assert.doesNotMatch(body, /^\s*maxTokens: /mu, '不允许在顶层传 maxTokens（会被静默忽略）')
})

/**
 * 2026-10-26 线上回归：两条成片（鹤岗房、AI 数字人）渲染完全成功、技术质检
 * 也过了，全都倒在审片这一步，报「子会话以 error 结束」。
 *
 * 真实根因是上游模型网关返回 429「Credits exhausted」——默认模型
 * group/smart-split 的额度包用完了。同一台机器上 hy3 / deepseek-v4.1-flash
 * 仍然 200，所以这不是网关整体故障，是默认路由组这一个模型没额度。
 *
 * 这条用例守三件事：
 *   1. 审片 Agent 必须显式指定模型，不能再继承默认路由（否则跟着一起挂）；
 *   2. 真实错误报文必须能透出来——DSH 的 `turn/end` 失败原因是
 *      `{ kind: 'error', error: { message, code } }`，读错字段名会把上游原文
 *      整段丢掉，只剩「子会话以 error 结束」；
 *   3. 丢掉原文会连带误分类：额度耗尽被报成 code.defect（内部缺陷），
 *      而正确的分类是 credential.model_quota（模型额度耗尽）。
 */
test('审片 Agent 显式指定模型，不再继承可能额度耗尽的默认路由', async () => {
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const reviewer = source.slice(source.indexOf('videoReviewer:'), source.indexOf('publishConnectionSettings'))
  assert.match(reviewer, /videoReviewer/u, '审片执行器必须存在')
  assert.match(reviewer, /model: 'workbuddy-ai\/deepseek-v4\.1-flash'/u,
    '审片必须显式指定模型——它要逐帧看图，模型必须支持图片输入')
  // 审片用的是结构化执行器，模型必须能透传下去。
  assert.match(reviewer, /createStructuredExecutor\([^)]*,\s*\{[\s\S]*model:/u,
    '审片的模型必须通过 options 传给结构化执行器')
})

test('上游额度耗尽的原文能被读出来（DSH turn/end 的 error 形状）', async () => {
  // DSH 的失败原因是 `{ kind: 'error', error: LlmFailure }`，
  // LlmFailure 是 `{ message, code }`（见 core/session/src/types.ts 的
  // TurnEndReasonMap）。原来只读 `reason.message`，读不到，于是真实原因
  // 被丢掉。
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const explain = source.slice(source.indexOf('function explainDshStop'), source.indexOf('function isModelQuotaExhausted'))
  assert.match(explain, /reason\?\.error\?\.message/u, '必须按 DSH 的真实形状读 reason.error.message')
})

test('额度耗尽会换模型重试一次，而不是直接判死', async () => {
  // 2026-10-26 实测：默认路由组额度用完后，选题（10:17）与审片（10:54）
  // 两个环节相继失败。额度耗尽是唯一值得「换个模型再来一次」的失败——
  // 网关对每次请求都直接回 429，退避永远等不到恢复，但别的模型还有额度。
  const quotaMessage = 'WorkBuddy AI: Credits exhausted. Please visit the link below to purchase add-on packs and get more credits'
  const harness = quotaHarness(quotaMessage)
  const executor = createStructuredExecutor(harness.ctx, harness.subagents, 'topic-generator')
  const result = await executor({ prompt: 'pick topic', agent: { id: 'parent-session-1' } })
  assert.equal(result?.ok, true, '换模型后应该成功')
  assert.equal(harness.counts().started, 2, '额度耗尽后必须再跑一次')
  assert.equal(harness.routes[0]?.model, undefined, '第一次不该带模型覆盖（跟随默认路由）')
  assert.equal(harness.routes[1]?.model, 'workbuddy-ai/deepseek-v4.1-flash', '兜底必须换到还有额度的模型')
  assert.equal(harness.counts().disposed, 2, '每次尝试都要释放子会话')
})

test('额度耗尽时错误原文会透出来，能被分类成模型额度问题', async () => {
  // 没有兜底机会时（已显式指定模型），报错必须带上游原文，
  // 这样 spoken-video-failure.mjs 的 credential.model_quota 规则才能命中，
  // 而不是被误报成 code.defect（内部缺陷）。
  const quotaMessage = 'WorkBuddy AI: Credits exhausted. Please visit the link below to purchase add-on packs and get more credits'
  const harness = quotaHarness(quotaMessage)
  const executor = createStructuredExecutor(harness.ctx, harness.subagents, 'topic-generator', { model: 'workbuddy-ai/deepseek-v4.1-flash' })
  await assert.rejects(
    executor({ prompt: 'pick topic', agent: { id: 'parent-session-1' } }),
    (error) => {
      assert.match(error.message, /Credits exhausted/u, '报错必须带出上游原文')
      const failure = classifyFailure({ error, step: 'topic' })
      assert.equal(failure.category, 'credential.model_quota', '必须被分类成模型额度耗尽，而不是内部缺陷')
      return true
    },
  )
})


// ---------------------------------------------------------------- 审片时间预算

/**
 * 审片预算的取值依据。
 *
 * 2026-10-26 从历史数据挖出的根因：审片耗时是双峰分布——36 个会话里 22 个
 * ≤25 步（秒级完成），10 个 >50 步（最长 221 步），这 10 个长尾吃掉 84% 的
 * token（129.2M / 153.3M）。一轮成功任务 177 分钟里，首审 56 分钟 + 复审
 * 82 分钟 = 138 分钟，占 78%。根因是结构化任务的时间预算被写成 0（无上限）。
 */
test('reviewerTimeBudget：默认 12 分钟，可覆盖，0/负数表示不设限', () => {
  assert.equal(reviewerTimeBudget({}), 12 * 60 * 1000)
  assert.equal(reviewerTimeBudget({ LWB_VIDEO_REVIEWER_TIMEOUT_MS: '300000' }), 300_000)
  assert.equal(reviewerTimeBudget({ LWB_VIDEO_REVIEWER_TIMEOUT_MS: '0' }), 0)
  assert.equal(reviewerTimeBudget({ LWB_VIDEO_REVIEWER_TIMEOUT_MS: '-1' }), 0)
  // 非法值回落默认，不能把 NaN 传给 setTimeout（那会立刻触发）
  assert.equal(reviewerTimeBudget({ LWB_VIDEO_REVIEWER_TIMEOUT_MS: 'abc' }), 12 * 60 * 1000)
})

test('审片超时被截住，且报错点明是「审片」而不是「视觉导演」', async () => {
  // 复刻长尾形态：审片 Agent 事件流活跃但永不收敛。
  const harness = executorHarness(null)
  const previous = process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS
  process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS = '50'
  try {
    const executor = createStructuredExecutor(harness.ctx, harness.subagents, 'spoken-video-video-reviewer', {
      timeBudget: reviewerTimeBudget,
      budgetLabel: '独立审片',
      budgetEnvHint: 'LWB_VIDEO_REVIEWER_TIMEOUT_MS',
    })
    await assert.rejects(executor({ prompt: 'review', agent: { id: 'parent' } }),
      /独立审片超过 0\.1 秒[\s\S]*LWB_VIDEO_REVIEWER_TIMEOUT_MS/u)
  } finally {
    if (previous === undefined) delete process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS
    else process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS = previous
  }
  // 超时必须真的取消子会话，否则长尾只是换了个地方继续烧 token
  assert.equal(harness.counts().disposed, 1)
})

test('没有 timeBudget 的结构化执行器仍然不设限（选题/写稿行为不变）', async () => {
  // 回归保护：审片加预算不能顺带改变选题/写稿的既有行为。
  const harness = executorHarness([])
  const previous = process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS
  process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS = '50'
  try {
    const executor = createStructuredExecutor(harness.ctx, harness.subagents, 'topic-generator')
    await assert.rejects(executor({ prompt: 'topic', agent: { id: 'parent' } }),
      (error) => !/超过 0\.1 秒/u.test(String(error?.message)))
  } finally {
    if (previous === undefined) delete process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS
    else process.env.LWB_VIDEO_REVIEWER_TIMEOUT_MS = previous
  }
})
