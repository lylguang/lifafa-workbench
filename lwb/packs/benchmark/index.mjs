import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import manifest from './lwb-pack.json' with { type: 'json' }
import { registerLwbPack } from '@scitiger-ai/lwb-pack-sdk'
import BenchmarkGateway from './gateway.mjs'
import { BenchmarkStore } from './benchmark-store.mjs'
import { BenchmarkHost } from './benchmark-host.mjs'
import { SUGGESTIONS_SCHEMA, TEARDOWN_SCHEMA, createStructuredExecutor } from './benchmark-agent.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices', 'subagents', 'tools']

/** Host entry for the benchmark teardown capability pack. */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The benchmark pack must be loaded by an LWB Profile.')
  }
  assertObjectJsonSchema(TEARDOWN_SCHEMA)
  assertObjectJsonSchema(SUGGESTIONS_SCHEMA)
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  const store = new BenchmarkStore({ workspacePath: context.workspacePath })
  const host = new BenchmarkHost({
    store,
    background: scope.background,
    teardownExecutor: config.teardownExecutor || createStructuredExecutor(ctx, ctx.subagents, scope, 'benchmark-teardown'),
    topicsExecutor: config.topicsExecutor || createStructuredExecutor(ctx, ctx.subagents, scope, 'benchmark-topics'),
  })
  // 重启后清理遗留的 analyzing 状态，避免前端永久等待。
  await host.recoverStaleAnalyses()
  ctx.provide('benchmarkHost', host)
  ctx.plugin(BenchmarkGateway)
  ctx.effect(() => registerLwbPack(ctx, manifest), 'benchmark: register LWB capability pack')
}
