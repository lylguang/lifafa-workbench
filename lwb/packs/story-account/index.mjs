import manifest from './lwb-pack.json' with { type: 'json' }
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import StoryAccountGateway from './gateway.mjs'
import { StoryAccountStore } from './story-account-store.mjs'
import { StoryAccountContent } from './story-account-content.mjs'
import { collectMaterialCandidates } from './story-account-harvest-sources.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices', 'subagents']

/**
 * 结构化输出执行器。
 *
 * 通过主机 `subagents` 接缝起一个一次性结构化子会话，把结构化结果取回来。
 * 模型调用、凭据与审批边界全部留在 DSH 内部，本包只提供提示词与 schema。
 *
 * 两处防御性处理沿用了通用口播包踩过的坑：
 *
 * 1) 结构化轮次正常结束却没调用 structured_output：模型偶尔直接输出一段文本
 *    收尾。这里在同一会话里补一次提醒，仍拿不到结果才算失败。
 * 2) 子会话必须 dispose：一次性任务结束后不放，会把会话一直挂在注册表里。
 */
export function createStructuredExecutor(ctx, subagents, label) {
  return async function structuredExecutor({ prompt, schema, agent, resolveAgent = false }) {
    // 没有 agent 时不能往下走：subagents.start 会拿 parent: undefined 去起子会话，
    // DSH 内部读 agent.options 时报的是 "Cannot read properties of undefined
    // (reading 'options')"——看不出是谁漏传的。这里就地拦住并说清楚。
    if (!agent || typeof agent !== 'object') {
      throw new Error('生成任务缺少工作区 agent：调用方必须传 agent（{ workspacePath }）。')
    }
    // 传入的是合成 agent（带 workspacePath 占位）：通过 withAgent 换出真正的
    // 工作区 agent 再继续。用 resolveAgent 显式终止递归，不再依赖「真实 agent
    // 没有 workspacePath」这个隐含假设——否则 withAgent 一旦回传带 workspacePath
    // 的 agent，就会无限递归。
    if (agent?.workspacePath && !resolveAgent) {
      return ctx.lwbPackServices.forPack(manifest.id).withAgent((parent) => structuredExecutor({ prompt, schema, agent: parent, resolveAgent: true }))
    }
    if (!subagents || typeof subagents.start !== 'function') {
      throw new Error('当前环境不提供子代理执行接缝，无法执行生成任务。')
    }
    const controller = new AbortController()
    const scope = ctx.lwbPackServices.forPack(manifest.id)
    const runSignal = scope?.signal ? AbortSignal.any([controller.signal, scope.signal]) : controller.signal
    let run
    try {
      run = await subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: runSignal,
        outputSchema: schema,
      })
      let result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`生成未正常结束（${result.stopReason}）${result.diagnostic ? `：${result.diagnostic}` : ''}`)
      }
      if (result.structured === undefined) {
        const child = run.localAgent
        if (child?.followup && child?.whenIdle) {
          child.followup(createUserMessage({
            content: [{ type: 'text', text: '你的上一轮回答是普通文本，没有调用 structured_output 工具提交结果。请严格按任务要求重新产出完整结果，并必须通过 structured_output 工具提交（参数须完全符合给定 schema）。不要输出任何普通文本作为最终答案。' }],
            source: { kind: 'plugin', plugin: 'story-account' },
          }))
          await child.whenIdle()
          runSignal.throwIfAborted()
          const followup = await run.result
          if (followup.structured !== undefined) result = followup
        }
      }
      if (result.structured === undefined) {
        throw new Error('生成未正常结束：模型未通过 structured_output 提交结果（已重试一次）。')
      }
      return result.structured
    } finally {
      await run?.dispose().catch(() => {})
    }
  }
}

/**
 * 能力包主入口。
 *
 * 与通用口播包（只声明一个总 scope）的差别：这里注册的是**同一份 manifest**
 * 加两组服务。`storyAccountScope` 负责工作区归属与生命周期信号，
 * provider 只暴露 storyAccount* 命名空间，因此两个内容包可以同时加载。
 */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('story-account 能力包必须由 LWB Profile 加载。')
  }
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  ctx.provide('storyAccountScope', scope)

  const projects = new StoryAccountStore()
  const agent = { workspacePath: context.workspacePath }
  // 启动完整性自检：损坏的 project.json 不该被静默忽略，至少要在启动时就显形。
  projects.verifyIntegrity(agent).then((report) => {
    if (report.corrupt.length) {
      const message = `[story-account] 检测到 ${report.corrupt.length}/${report.total} 个项目文件损坏：${report.corrupt.map((item) => item.id).join(', ')}`
      if (ctx?.logger?.warn) ctx.logger.warn(message)
      else console.warn(message)
    }
  }).catch(() => {})
  const content = new StoryAccountContent({
    workspacePath: context.workspacePath,
    topicExecutor: config.topicExecutor || createStructuredExecutor(ctx, ctx.subagents, 'story-account-topic'),
    scriptExecutor: config.scriptExecutor || createStructuredExecutor(ctx, ctx.subagents, 'story-account-script'),
    profileExecutor: config.profileExecutor || createStructuredExecutor(ctx, ctx.subagents, 'story-account-profile'),
    packageExecutor: config.packageExecutor || createStructuredExecutor(ctx, ctx.subagents, 'story-account-packaging'),
    // 审片用独立执行器与独立会话：审片必须是不带作者感情的那双眼睛。
    reviewExecutor: config.reviewExecutor || createStructuredExecutor(ctx, ctx.subagents, 'story-account-review'),
    // 采集要检索外部内容，与写稿/审片分开：它读的是别人的文本，上下文不该混。
    harvestExecutor: config.harvestExecutor || createStructuredExecutor(ctx, ctx.subagents, 'story-account-harvest'),
    // 真实采集源：出处由这里保证。模型只做筛选与提炼，不负责给链接。
    // 默认不联网：采集是隐式外发行为，宿主没显式开启就不该在后台偷偷发请求
    // （与 story-account-content.mjs 构造里的 "默认不启用" 注释保持一致）。
    // 开启方式二选一：① 宿主注入 config.sourceCollector；② 宿主声明
    // config.enableRealHarvest 为真，这里再接上真实采集器。
    sourceCollector: config.sourceCollector ?? (config.enableRealHarvest ? collectMaterialCandidates : null),
    // 私有凭据库句柄：与通用口播包共用同一套后端密钥，按 ref 名存取。
    credentials: scope.credentials || null,
  })
  content.attachProjects(projects, agent)

  ctx.provide('storyAccountProjects', projects)
  ctx.provide('storyAccountContent', content)
  ctx.plugin(StoryAccountGateway)
  ctx.effect(() => ctx.lwbPackRegistry.register(manifest), 'story-account: register LWB capability pack')
}
