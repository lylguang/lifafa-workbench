import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import manifest from './lwb-pack.json' with { type: 'json' }
import { registerLwbPack } from '@scitiger-ai/lwb-pack-sdk'
import PublisherGateway from './gateway.mjs'
import { PublisherStore } from './publisher-store.mjs'
import { PublisherBrowserPool } from './publisher-browser.mjs'
import { PublisherHost } from './publisher-host.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices']

const PACK_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Host entry for the publishing capability pack.
 *
 * The sibling spoken-video pack is reached through `ctx.get` rather than an
 * `inject` entry on purpose: Cordis treats injected names as hard dependencies
 * and keeps the plugin pending until they exist, so declaring them would turn
 * "the video pack is not installed" into "this pack never loads". An explicit
 * config override still wins, which is what the tests inject.
 */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The publisher pack must be loaded by an LWB Profile.')
  }
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()

  const store = new PublisherStore({ workspacePath: context.workspacePath })
  const settings = await store.settings().catch(() => ({ headless: false }))
  const browser = new PublisherBrowserPool({
    dataRoot: store.dataRoot,
    headless: settings.headless === true,
    onLog: (kind, message) => console.log(`[publisher:${kind}] ${message}`),
  })

  // Resolved lazily per call so that loading either pack alone still works.
  const lazy = (name) => {
    if (config[name]) return config[name]
    if (typeof ctx.get !== 'function') return null
    try { return ctx.get(name) || null } catch { return null }
  }
  const spokenVideo = {
    get projects() { return lazy('spokenVideoProjects') },
    get publish() { return lazy('spokenVideoPublish') },
    context: async () => {
      const scope = ctx.lwbPackServices.forPack('spoken-video')
      return scope.context()
    },
  }

  const host = new PublisherHost({
    store,
    browser,
    spokenVideo,
    workspacePath: context.workspacePath,
    background: scope.background,
    onLog: (kind, message) => console.log(`[publisher:${kind}] ${message}`),
  })

  await host.recoverInterrupted().catch(() => {})
  ctx.provide('publisherHost', host)
  ctx.plugin(PublisherGateway)
  ctx.effect(() => {
    const stop = () => { void host.shutdown() }
    scope.onStop(stop)
    return stop
  }, 'publisher: close browser sessions on stop')
  ctx.effect(() => ctx.lwbPackRegistry.register(manifest), 'publisher: register LWB capability pack')
}
