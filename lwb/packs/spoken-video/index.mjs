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

const MediaConnectionSettings = z.object({
  provider: z.union(['bailian', 'scitiger']).default('bailian'),
  bailianReferenceVoices: z.any().default({}),
})

// `enabled` is retained only so existing settings files remain readable. Cover
// generation availability is derived from the selected provider's credential.
const PublishConnectionSettings = z.object({
  enabled: z.boolean().default(false),
  provider: z.union(['bailian', 'scitiger']).default('bailian'),
  model: z.string().default(''),
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
      const prefix = Array.isArray(run.localAgent?.session?.events) ? [...run.localAgent.session.events] : []
      prefix.forEach((event) => observeEvent(run.localAgent.session, event))
      let result = await run.result
      await traceTail
      if (continuationFailure) throw continuationFailure
      if (result.stopReason !== 'completed') {
        if (!structured && result.stopReason === 'max-tokens' && maxTokenContinuations > 0) {
          throw new Error(`视频 Agent 连续 ${continuationCount + 1} 个创作轮次达到单次输出上限，未能完成可渲染工程。`)
        }
        const detail = result.diagnostic ? `：${result.diagnostic}` : ''
        throw new Error(`生成未正常结束（${result.stopReason}）${detail}`)
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
          const boundary = child.session.events.length
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
          const events = child.session.events.slice(boundary)
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

function createStructuredExecutor(ctx, subagents, label) {
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
