/**
 * 手动稿件成片 · Host 入口
 *
 * 这个包和「口播视频内容创作」共用同一套生产后端：项目存储、媒体主机（配音/字幕/
 * 成片渲染/技术质检）、发布主机（发布资料与封面）。共用是**代码共用、数据隔离**：
 *
 * - 代码：直接引用兄弟包的实现，不复制第二份。媒体主机几百行渲染与质检逻辑复制一遍，
 *   将来修一个 bug 要改两处，迟早漂移。
 * - 数据：这些服务的状态全在「传入的 context 指向的工作区」里。本包用自己的 scope，
 *   所以稿件、音频、成片、发布资料全部落在本包自己的专属工作区，与口播包互不可见。
 *
 * 本包不做的事：不采集信号、不做选题、不做账号定位、不做定时编排。用户已经有稿子，
 * 直接进来配音、做片、发资料。
 */
import manifest from './lwb-pack.json' with { type: 'json' }
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { packCredentialRef } from '@scitiger-ai/lwb-dsh-bundle/pack-workspaces.mjs'
import { SpokenVideoProjectStore } from '../spoken-video/spoken-video-store.mjs'
import { SpokenVideoMediaHost } from '../spoken-video/spoken-video-media-host.mjs'
import { SpokenVideoPublishHost } from '../spoken-video/spoken-video-publish-host.mjs'
import {
  MediaConnectionSettings,
  PublishConnectionSettings,
  createAgentExecutor,
  createStructuredExecutor,
  creatorModel,
  creatorModelProvider,
  reviewerModel,
  reviewerTimeBudget,
} from '../spoken-video/index.mjs'
import { buildVideoCreatorContinuationPrompt, VIDEO_REVIEW_SCHEMA } from '../spoken-video/spoken-video-video-agent.mjs'
import { ManualPolishService } from './manual-script-polish.mjs'
import ManualScriptVideoGateway from './gateway.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices', 'subagents', 'tools', 'settings', 'credentials']

/**
 * 媒体密钥与「口播视频内容创作」共用同一份。
 *
 * 凭据条目按「包 id + 用途」存在 DSH 私有凭据库里。这里刻意把本包的凭据门面固定绑到
 * spoken-video 的命名空间，而不是本包自己的——用户要求「填一次即可」：在任一包保存
 * 百炼/MiMo 的 key，另一包立刻能用。
 *
 * 代价说清楚：两个包从此共用一条密钥记录，在任一包撤销 key，另一包也一起失效。
 * 这是产品决定，不是疏漏；其它凭据（模型认证等）仍然各包隔离。
 */
const SHARED_CREDENTIAL_PACK = 'spoken-video'

/** 本包使用的凭据引用（与口播包命名空间一致）。 */
export function sharedCredentialRef(purpose) {
  const normalized = typeof purpose === 'string' ? purpose.trim().toLowerCase().replaceAll('_', '-') : ''
  if (!normalized) throw new Error('媒体凭据引用无效。')
  return packCredentialRef(SHARED_CREDENTIAL_PACK, normalized)
}

function sharedCredentials(ctx) {
  const methods = ['resolve', 'describe', 'set', 'unset']
  return Object.fromEntries(methods.map((method) => [method, (ref, ...args) => {
    return ctx.credentials[method](sharedCredentialRef(ref), ...args)
  }]))
}

export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The manual-script-video pack must be loaded by an LWB Profile.')
  }
  assertObjectJsonSchema(VIDEO_REVIEW_SCHEMA)

  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  const credentials = sharedCredentials(ctx)

  const projects = new SpokenVideoProjectStore()
  const connectionSettings = ctx.settings.register(scope.settingsNamespace('media'), MediaConnectionSettings, { base: {} })
  const media = new SpokenVideoMediaHost({
    background: scope.background, fetch: scope.fetch, signal: scope.signal,
    projectsStore: projects,
    credentials,
    connectionSettings,
    videoCreator: config.videoCreator || createAgentExecutor(ctx, ctx.subagents, 'manual-script-video-creator', {
      maxTokenContinuations: 4,
      continuationPrompt: buildVideoCreatorContinuationPrompt,
      model: creatorModel(),
      modelProvider: creatorModelProvider(),
      // 子会话的工作区与沙箱跟包走：共享的执行器工厂默认落在口播包工作区，
      // 必须显式声明本包 id，否则导演会被沙箱关进别人的工作区（2026-11-04 实测）。
      packId: manifest.id,
    }),
    videoReviewer: config.videoReviewer || createStructuredExecutor(ctx, ctx.subagents, 'manual-script-video-reviewer', {
      model: reviewerModel(),
      timeBudget: reviewerTimeBudget,
      budgetLabel: '独立审片',
      budgetEnvHint: 'LWB_VIDEO_REVIEWER_TIMEOUT_MS',
      packId: manifest.id,
    }),
  })
  const publishConnectionSettings = ctx.settings.register(scope.settingsNamespace('publish'), PublishConnectionSettings, { base: {} })
  const publish = new SpokenVideoPublishHost({
    background: scope.background, fetch: scope.fetch,
    projectsStore: projects,
    credentials,
    connectionSettings: publishConnectionSettings,
    packageExecutor: config.publishExecutor || createStructuredExecutor(ctx, ctx.subagents, 'manual-script-video-publish', { packId: manifest.id }),
  })
  const polish = new ManualPolishService({
    background: scope.background,
    projectsStore: projects,
    executor: config.polishExecutor || createStructuredExecutor(ctx, ctx.subagents, 'manual-script-video-polish', { packId: manifest.id }),
  })
  // 标题生成与润色分用两个执行器：起名是单轮小任务，不背润色的会话上下文。
  // 用**非结构化**执行器：模型的文本回答就是标题。结构化通道要求模型调
  // structured_output 收尾，实测部分模型（minimax-m3.1-flash）起完标题后用
  // 纯文本结束，会被判成失败——起标题这种一行文字的任务不值得这道工序。
  const titleExecutor = config.titleExecutor || createAgentExecutor(ctx, ctx.subagents, 'manual-script-video-title', { packId: manifest.id })

  ctx.provide('manualScriptVideoScope', scope)
  ctx.provide('manualScriptVideoProjects', projects)
  ctx.provide('manualScriptVideoMedia', media)
  ctx.provide('manualScriptVideoPublish', publish)
  ctx.provide('manualScriptVideoPolish', polish)
  ctx.provide('manualScriptVideoTitle', titleExecutor)
  ctx.plugin(ManualScriptVideoGateway)
  ctx.effect(() => ctx.lwbPackRegistry.register(manifest), 'manual-script-video: register LWB capability pack')
}
