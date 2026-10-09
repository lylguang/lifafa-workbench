import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import manifest from './lwb-pack.json' with { type: 'json' }
import { registerLwbPack } from '@scitiger-ai/lwb-pack-sdk'
import WhiteboardGateway from './gateway.mjs'
import { WhiteboardStore } from './whiteboard-store.mjs'
import { WhiteboardHost } from './whiteboard-host.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices']

const PACK_ROOT = dirname(fileURLToPath(import.meta.url))

/** Host entry for the whiteboard hand-drawn animation capability pack. */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The whiteboard pack must be loaded by an LWB Profile.')
  }
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  const store = new WhiteboardStore({ workspacePath: context.workspacePath })
  const host = new WhiteboardHost({
    store,
    background: scope.background,
    engineRoot: join(PACK_ROOT, 'engine'),
    workspacePath: context.workspacePath,
  })
  ctx.provide('whiteboardHost', host)
  ctx.plugin(WhiteboardGateway)
  ctx.effect(() => registerLwbPack(ctx, manifest), 'whiteboard: register LWB capability pack')
}
