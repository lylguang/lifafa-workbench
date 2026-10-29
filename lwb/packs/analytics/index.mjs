import manifest from './lwb-pack.json' with { type: 'json' }
import { registerLwbPack } from '@scitiger-ai/lwb-pack-sdk'
import AnalyticsGateway from './gateway.mjs'
import { AnalyticsHost } from './analytics-host.mjs'
import { toBackgroundWork } from './analytics-collector.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices']

/**
 * 数据看板包入口。
 *
 * 数据来自两个兄弟包，本包不自己存一份业务数据：
 * - publisher：平台账号与发布记录（经 publisherHost 懒访问）
 * - spoken-video：流水线阶段存量（经 spokenVideoProjects）
 * 任一包未安装时，AnalyticsHost 会把对应区块降级成
 * { available:false, reason }，看板其余部分照常可用。
 */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The analytics pack must be loaded by an LWB Profile.')
  }
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  const host = new AnalyticsHost({
    workspacePath: context.workspacePath,
    // 两个兄弟包都可能缺席：懒访问取不到就传 null，由 host 负责降级。
    publisher: resolvePublisher(ctx),
    spokenVideo: resolveSpokenVideo(ctx),
    // 契约适配：采集器/调度器传的是 thunk（`() => work()`），而
    // lwbPackServices 的 background 收的是 **Promise**（内部
    // `Promise.resolve(promise)` 后加入 pending 集合）。
    // 直接把 thunk 递过去，Promise.resolve 只会把函数本身当成结果，
    // work 永远不会执行——实测表现是「采集一开始就永远 running：
    // done 0/1、没有失败、没有产物，之后每次采集都被 alreadyRunning 挡住」。
    // 这里统一展开：是函数就先调用，再把得到的 promise 交给宿主托管。
    background: (work) => scope.background(toBackgroundWork(work)),
  })
  ctx.provide('analyticsHost', host)
  ctx.plugin(AnalyticsGateway)
  // 定时采集：与 spoken-video 同一模式，排期随包的生命周期起停。
  // scope.onStop 保证卸载本包时停掉定时器，不会继续在后台对平台发请求。
  ctx.effect(() => {
    const stop = () => host.dispose()
    scope.onStop(stop)
    return stop
  }, 'analytics: daily collection scheduler')
  ctx.effect(() => registerLwbPack(ctx, manifest), 'analytics: register LWB capability pack')
}

function resolvePublisher(ctx) {
  try {
    return ctx.get('publisherHost') || null
  } catch {
    // publisher 包未安装。看板会降级为「发布数据不可用」，不因此启动失败。
    return null
  }
}

function resolveSpokenVideo(ctx) {
  try {
    // 优先用 spoken-video 预绑定好的漏斗服务（自带工作区，跨包可调）。
    const pipeline = ctx.get('spokenVideoPipeline')
    if (pipeline) return pipeline
    return ctx.get('spokenVideoProjects') || null
  } catch {
    return null
  }
}
