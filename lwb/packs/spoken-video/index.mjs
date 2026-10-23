import manifest from './lwb-pack.json' with { type: 'json' }
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import SpokenVideoGateway from './gateway.mjs'
import { SpokenVideoProjectStore } from './spoken-video-store.mjs'
import { SpokenVideoContentStore } from './spoken-video-content-store.mjs'
import { SpokenVideoMediaHost } from './spoken-video-media-host.mjs'
import { SpokenVideoPublishHost } from './spoken-video-publish-host.mjs'
import { SpokenVideoScheduleHost } from './spoken-video-schedule-host.mjs'
import { registerSpokenVideoMediaTools } from './spoken-video-media-tools.mjs'
import { buildVideoCreatorContinuationPrompt, VIDEO_REVIEW_SCHEMA } from './spoken-video-video-agent.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices', 'subagents', 'tools', 'settings']

// 配音渠道：小米 MiMo 是唯一启用的渠道。bailian/scitiger 仍留在枚举里，
// 这样老设置文件能继续读出来（老任务也要能打开），只是新建任务时前端只给 mimo。
const MediaConnectionSettings = z.object({
  provider: z.union(['mimo', 'bailian', 'scitiger']).default('mimo'),
  bailianReferenceVoices: z.any().default({}),
})

// `enabled` is retained only so existing settings files remain readable. Cover
// generation availability is derived from the selected provider's credential.
const PublishConnectionSettings = z.object({
  enabled: z.boolean().default(false),
  provider: z.union(['bailian', 'scitiger', 'custom']).default('bailian'),
  model: z.string().default(''),
  // 自定义云端生图的服务描述。只在 provider === 'custom' 时有意义，随任务一起
  // 冻结进 imageProvider，让已在跑的那一轮不会因为中途改配置而换服务。
  customImage: z.object({
    baseUrl: z.string().default(''),
    protocol: z.union(['openai', 'async-generic']).default('openai'),
    path: z.string().default(''),
    authHeader: z.union(['bearer', 'raw']).default('bearer'),
  }).default({ baseUrl: '', protocol: 'openai', path: '', authHeader: 'bearer' }),
})

/**
 * Structured-output executor. It spawns a one-shot structured child through
 * the harness `subagents` seam and returns the captured structured output.
 * The service handle is captured from the pack's own declared `inject` —
 * Cordis contexts only expose services named there, so reaching through
 * `agent.ctx` is rejected. All model/credential/approval boundaries stay
 * inside DSH; the pack only supplies the prompt and schema. Topic
 * generation, script generation and account completion each receive one
 * instance.
 */

// 非结构化创作（视频导演）环节的时间预算。
//
// 为什么必须有：2026-10-23 实测，一条 611 秒的长片（82 条字幕）让创作 Agent
// 在导演环节连续打磨 61 分钟仍未跑一次预检——它自己写了 audit 脚本逐幕审计，
// 又写了 21 个 tune-*.cjs 反复微调字幕入点（±0.06s 级），事件流始终活跃，
// 没有任何失败迹象，也就没有任何机制能拦它。maxRepairs 只管预检失败后的
// 修复轮次，不管单轮打磨时长；awaitWithin 只用在 ASR 上。用户看到的就是
// 「卡在 AI 导演环节 45 分钟」。
//
// 为什么是 35 分钟：2026-10-23 成功的长片导演用时 15 分钟（45dd5497，
// 676 秒片长），今天成功的一条 158 秒短片用了 15 分钟。35 分钟约为实测
// 最慢正常值的 2 倍多，正常任务不会碰到；真陷入打磨循环的任务则被及时
// 止损，错误信息里写明可直接重跑（Agent 的阶段性产物已落盘，重跑不是
// 从零开始）。
//
// 可用环境变量 LWB_VIDEO_DIRECTOR_TIMEOUT_MS 覆盖（毫秒）。设为 0 或负数
// 表示不设限——留给确有特殊长片需求的场景，但默认必须有限。
export function directorTimeBudget(env = process.env) {
  const raw = Number(env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS)
  if (Number.isFinite(raw)) return raw > 0 ? raw : 0
  return 35 * 60 * 1000
}

function createDshExecutor(ctx, subagents, label, structured, { maxTokenContinuations = 0, continuationPrompt } = {}) {
  return async function dshExecutor({ prompt, schema, agent, onDshStarted, onDshEvent, onDshContinuation, validate, repairPrompt, onDshRepair, maxRepairs = 2 }) {
    if (agent?.workspacePath) {
      return ctx.lwbPackServices.forPack(manifest.id).withAgent((parent) => dshExecutor({ prompt, schema, agent: parent, onDshStarted, onDshEvent, onDshContinuation, validate, repairPrompt, onDshRepair, maxRepairs }))
    }
    if (!subagents || typeof subagents.start !== 'function') {
      throw new Error('当前环境不提供子代理执行接缝，无法执行生成任务。')
    }
    const controller = new AbortController()
    let childSessionId = null
    let continuationCount = 0
    let continuationFailure = null
    const continuedTurns = new Set()
    let traceTail = Promise.resolve()
    const recordEvent = (event) => {
      if (!onDshEvent) return
      traceTail = traceTail.then(() => Promise.resolve(onDshEvent(event)).catch(() => {}))
    }
    let run
    const runSignal = ctx.lwbPackServices ? AbortSignal.any([controller.signal, ctx.lwbPackServices.forPack(manifest.id).signal]) : controller.signal
    const cancelChild = () => run?.localAgent?.cancel?.({ kind: 'parent' })
    const observeEvent = (session, event) => {
      if (!childSessionId || session.id !== childSessionId) return
      recordEvent(event)
      if (structured || event?.type !== 'turn/end' || event.data?.reason?.kind !== 'max-tokens') return
      const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : `seq-${event.seq}`
      if (continuedTurns.has(turn)) return
      continuedTurns.add(turn)
      if (continuationCount >= maxTokenContinuations) return
      const child = run?.localAgent
      if (!child || typeof child.followup !== 'function') {
        continuationFailure = new Error('当前子代理运行方式不支持在同一 DSH 会话中继续生成。')
        return
      }
      continuationCount += 1
      const text = continuationPrompt({ attempt: continuationCount, maximum: maxTokenContinuations })
      try {
        child.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'spoken-video-video-creator' },
        }))
        if (onDshContinuation) {
          traceTail = traceTail.then(() => Promise.resolve(onDshContinuation({
            childSessionId: String(childSessionId),
            attempt: continuationCount,
            maximum: maxTokenContinuations,
          })).catch(() => {}))
        }
      } catch (error) {
        continuationFailure = error instanceof Error ? error : new Error(String(error))
      }
    }
    const disposeSessionEvent = ctx.on('session/event', observeEvent, { global: true })
    try {
      run = await subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: runSignal,
        ...(structured ? { outputSchema: schema } : {}),
      })
      childSessionId = run.id
      if (onDshStarted) {
        await Promise.resolve(onDshStarted({
          childSessionId: String(run.id),
          parentSessionId: typeof agent?.id === 'string' ? agent.id : null,
        })).catch(() => {})
      }
      // The one-shot run begins immediately after publication. Replay the in-memory prefix so
      // the audit timeline cannot miss an early turn or step before the listener observes it.
      const prefix = run.localAgent?.session ? [...run.localAgent.session.snapshotEvents()] : []
      prefix.forEach((event) => observeEvent(run.localAgent.session, event))
      // 非结构化创作（视频导演）加时间预算：Agent 事件流活跃不代表在收敛，
      // 2026-10-23 实测一条长片连续打磨 61 分钟仍未提交预检（期间写了 21 个
      // tune 脚本），而宿主没有任何机制能拦住它。超时通过 controller.abort()
      // 走与「能力包停止」同一条取消链路（cancelChild），子会话被有序取消，
      // 错误信息给出可执行动作。structured 任务（选题/写稿等）不在此列——
      // 它们有 structured_output 兜底与补交机制，节奏由模型轮次决定。
      let directorTimer = null
      let directorDeadlineHit = false
      const directorTimeoutMs = structured ? 0 : directorTimeBudget()
      // 报错里的时长要按预算的量级选择单位：默认预算是分钟级，测试与极端配置
      // 可能是毫秒级——统一用「<60s 显示秒，其余显示分钟」。
      const directorBudgetText = directorTimeoutMs < 60_000
        ? `${(directorTimeoutMs / 1000).toFixed(1)} 秒`
        : `${Math.round(directorTimeoutMs / 60000)} 分钟`
      let result
      try {
        if (directorTimeoutMs > 0) {
          directorTimer = setTimeout(() => {
            directorDeadlineHit = true
            controller.abort(new Error('视觉导演时间预算已到。'))
          }, directorTimeoutMs)
        }
        result = await run.result
      } catch (error) {
        // 超时触发的取消，无论子会话以 reject 还是非 completed 收尾，都要把
        // 「为什么停、下一步做什么」讲清楚，而不是让用户看到一句裸的取消错误。
        if (directorDeadlineHit) {
          throw new Error(
            `视觉导演超过 ${directorBudgetText}仍未提交可渲染工程（Agent 一直在打磨但从未跑预检）。`
            + '已停止本轮以止损：可直接重跑本任务，阶段产物已落盘，重跑不必从零开始；'
            + `如确需更长创作时间，可设置环境变量 LWB_VIDEO_DIRECTOR_TIMEOUT_MS（毫秒，当前 ${directorTimeoutMs}）后重启。`,
          )
        }
        throw error
      } finally {
        if (directorTimer) clearTimeout(directorTimer)
      }
      // 超时后子会话也可能「正常收尾」（cancel 的 turn/end 可能先于 abort 传播），
      // 那时 result 存在但 stopReason 不是 completed——同样要给出超时语境。
      if (directorDeadlineHit) {
        throw new Error(
          `视觉导演超过 ${directorBudgetText}仍未提交可渲染工程（Agent 一直在打磨但从未跑预检）。`
          + '已停止本轮以止损：可直接重跑本任务，阶段产物已落盘，重跑不必从零开始；'
          + `如确需更长创作时间，可设置环境变量 LWB_VIDEO_DIRECTOR_TIMEOUT_MS（毫秒，当前 ${directorTimeoutMs}）后重启。`,
        )
      }
      await traceTail
      if (continuationFailure) throw continuationFailure
      if (result.stopReason !== 'completed') {
        if (!structured && result.stopReason === 'max-tokens' && maxTokenContinuations > 0) {
          throw new Error(`视频 Agent 连续 ${continuationCount + 1} 个创作轮次达到单次输出上限，未能完成可渲染工程。`)
        }
        const detail = result.diagnostic ? `：${result.diagnostic}` : ''
        throw new Error(`生成未正常结束（${result.stopReason}）${detail}`)
      }
      // structured 轮次正常结束但从未调 structured_output：模型偶尔会直接用一段
      // 短文本收尾（2026-10-17 晚报实测：turn 正常 completed、文本仅百余 token、
      // 无任何工具调用），in-process-driver 会把这种结果降级成 stopReason='error'
      // 且不带 diagnostic——报错只有「生成未正常结束（error）」，且此前一次机会
      // 都不重试。这里在判定之前给一次同会话补交的机会：followup 提醒模型必须
      // 走 structured_output 提交，成功则照常返回。
      if (structured && result.structured === undefined) {
        const child = run.localAgent
        if (child?.followup && child?.whenIdle) {
          await onDshContinuation?.({
            childSessionId: String(childSessionId),
            attempt: continuationCount + 1,
            maximum: 1,
            label: '模型未提交结构化结果，要求补交',
          }).catch(() => {})
          child.followup(createUserMessage({
            content: [{ type: 'text', text: '你的上一轮回答是普通文本，没有调用 structured_output 工具提交结果。请严格按任务要求重新产出完整结果，并必须通过 structured_output 工具提交（参数须完全符合给定 schema）。不要输出任何普通文本作为最终答案。' }],
            source: { kind: 'plugin', plugin: 'spoken-video-video-creator' },
          }))
          await child.whenIdle()
          await traceTail
          runSignal.throwIfAborted()
          const followup = await run.result
          if (followup.structured !== undefined) result = followup
        }
      }
      if (structured && result.structured === undefined) {
        throw new Error('生成未正常结束（error）：模型未通过 structured_output 提交结果（已重试一次）。')
      }
      // The driver keeps the published local child alive until dispose(). A repair
      // is another turn in that same session, after the first result has settled.
      if (!structured && validate) {
        runSignal.addEventListener('abort', cancelChild, { once: true })
        const maximum = Math.max(0, Math.min(2, Number.isSafeInteger(maxRepairs) ? maxRepairs : 2))
        for (let attempt = 0; ; attempt += 1) {
          runSignal.throwIfAborted()
          const report = await validate()
          runSignal.throwIfAborted()
          if (report.passed || report.repairable !== true || attempt >= maximum) break
          const child = run.localAgent
          if (!child?.followup || !child?.whenIdle || !repairPrompt) break
          const boundary = child.session.seq
          await onDshRepair?.({ attempt: attempt + 1, maximum, failures: report.failures, childSessionId: String(run.id) })
          runSignal.throwIfAborted()
          child.followup(createUserMessage({
            content: [{ type: 'text', text: repairPrompt({ report, attempt: attempt + 1, maximum }) }],
            source: { kind: 'plugin', plugin: 'spoken-video-video-preflight' },
          }))
          await child.whenIdle()
          await traceTail
          runSignal.throwIfAborted()
          if (continuationFailure) throw continuationFailure
          const events = child.session.snapshotEvents(boundary)
          const end = events.findLast((event) => event.type === 'turn/end')
          if (end?.data?.reason?.kind !== 'completed') throw new Error(`视频修复未正常结束（${end?.data?.reason?.kind || 'unknown'}）`)
          result = { ...result, output: events.filter((event) => event.type === 'assistant/message').at(-1)?.data?.message?.content || [] }
        }
      }
      return structured
        ? result.structured
        : { childSessionId: String(run.id), output: result.output }
    } finally {
      runSignal.removeEventListener('abort', cancelChild)
      disposeSessionEvent()
      await run?.dispose().catch(() => {})
    }
  }
}

// 导出仅供测试：验证 structured 任务不受导演时间预算约束。
export function createStructuredExecutor(ctx, subagents, label) {
  return createDshExecutor(ctx, subagents, label, true)
}

export function createAgentExecutor(ctx, subagents, label, options = {}) {
  return createDshExecutor(ctx, subagents, label, false, options)
}

/** Host entry for the standalone spoken-video capability pack. */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The spoken-video pack must be loaded by an LWB Profile.')
  }
  assertObjectJsonSchema(VIDEO_REVIEW_SCHEMA)
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  ctx.provide('spokenVideoScope', scope)
  const projects = new SpokenVideoProjectStore()
  const connectionSettings = ctx.settings.register(scope.settingsNamespace('media'), MediaConnectionSettings, { base: {} })
  const content = new SpokenVideoContentStore({
    workspacePath: context.workspacePath, background: scope.background, fetch: scope.fetch,
    topicExecutor: config.topicExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-topic'),
    scriptExecutor: config.scriptExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-script'),
    accountExecutor: config.accountExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-account'),
    projectsStore: projects,
  })
  const media = new SpokenVideoMediaHost({
    background: scope.background, fetch: scope.fetch, signal: scope.signal,
    projectsStore: projects,
    credentials: scope.credentials,
    connectionSettings,
    videoCreator: config.videoCreator || createAgentExecutor(ctx, ctx.subagents, 'spoken-video-video-creator', {
      maxTokenContinuations: 2,
      continuationPrompt: buildVideoCreatorContinuationPrompt,
    }),
    videoReviewer: config.videoReviewer || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-video-reviewer'),
    lineArtPlanner: config.lineArtPlanner || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-whiteboard-line-art'),
  })
  const publishConnectionSettings = ctx.settings.register(scope.settingsNamespace('publish'), PublishConnectionSettings, { base: {} })
  const publish = new SpokenVideoPublishHost({
    background: scope.background, fetch: scope.fetch,
    projectsStore: projects,
    credentials: scope.credentials,
    connectionSettings: publishConnectionSettings,
    packageExecutor: config.publishExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-publish'),
  })
  // Scheduling uses the same owned data context and DSH defaults as manual jobs.
  const schedule = new SpokenVideoScheduleHost({
    context, background: scope.background,
    executionStatus: () => ctx.lwbPackServices.executionStatus(manifest.id),
    ctx,
    content,
    projects,
    media,
    publish,
  })
  ctx.provide('spokenVideoProjects', projects)
  ctx.provide('spokenVideoContent', content)
  ctx.provide('spokenVideoMedia', media)
  ctx.provide('spokenVideoPublish', publish)
  ctx.provide('spokenVideoSchedule', schedule)
  ctx.plugin(SpokenVideoGateway)
  registerSpokenVideoMediaTools(ctx, media, scope)
  ctx.effect(() => { const stop = content.startScheduler(); scope.onStop(stop); return stop }, 'spoken-video: durable content scheduler')
  ctx.effect(() => { const stop = schedule.startScheduler(); scope.onStop(stop); return stop }, 'spoken-video: durable content schedule orchestrator')
  ctx.effect(() => ctx.lwbPackRegistry.register(manifest), 'spoken-video: register LWB capability pack')
}
