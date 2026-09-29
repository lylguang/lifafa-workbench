const PROFILE_ID = 'lwb'
const FIBER_ACTIVE = 2

// The pack runtime projects Loader-managed browser bundles through DSH's
// client-module graph. Declare both host services at the bundle boundary.
export const inject = ['loader', 'clientModules', 'settings', 'agents', 'agentPresets', 'permissionPresets', 'credentials', 'agentDefaultModel']

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LwbPackWorkspaces } from './pack-workspaces.mjs'
import { LwbPackServices } from './pack-services.mjs'

import z from '@deepseek-ai/schemastery'
import LwbArchiveGateway from './archive-gateway.mjs'
import LwbPackGateway from './pack-gateway.mjs'
import LwbRemoteSettingsGateway, { normalizeRemoteSettingsMode } from './remote-settings-gateway.mjs'
import { LwbPackRegistry } from './pack-registry.mjs'
import { LwbPackRuntime } from './pack-runtime.mjs'

const WORKBENCH_NS = 'lwb-workbench'
const WorkbenchSettings = z.object({
  state: z.any().default({}),
})

function restoreEnabledPacks(ctx, packRuntime) {
  let started = false
  ctx.on('internal/status', (fiber) => {
    if (started || fiber !== ctx.fiber || fiber.state !== FIBER_ACTIVE) return
    started = true
    // Cordis treats callback results as disposal effects, not task results.
    const restore = ctx.inject(['subagents', 'tools'], async () => { await packRuntime.restore() })
    packRuntime.setStartupRestore(restore.await())
  }, { global: true })
}

async function createPackGroup(ctx) {
  const Group = ctx.loader?.builtins?.group
  if (typeof Group !== 'function') {
    throw new Error('LWB capability pack loader group is unavailable.')
  }
  const fiber = ctx.plugin(Group, [])
  await fiber.await()
  const group = ctx.fiber.entry?.subgroup
  if (!group || typeof group.create !== 'function') {
    throw new Error('LWB capability pack loader group failed to initialize.')
  }
  return group
}

/**
 * Host-side product identity for the LWB DSH composition.
 *
 * This intentionally contributes a small service first. Product features will
 * be added as separate host/client bundles instead of growing a parallel HTTP
 * application beside the Harness tree.
 */
export async function apply(ctx, config = {}) {
  // The browser roster needs the same package name as the host bundle. Its
  // dedicated loader row is host-side only to expose ./client, so do not
  // register the identity service a second time for that row.
  if (config.clientOnly) return
  const identity = Object.freeze({
    id: PROFILE_ID,
    name: String(config.name || '李发发工作台'),
    version: String(config.version || '0.1.0'),
    architecture: 'dsh-profile',
  })
  ctx.provide('lwbProfile', identity)
  ctx.provide('lwbPackRegistry', new LwbPackRegistry())
  const dshHome = resolve(process.env.DSH_HOME || process.env.LWB_DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..', 'local', 'dsh-home'))
  const workspaces = new LwbPackWorkspaces({ root: join(dshHome, 'profiles', PROFILE_ID, 'pack-state') })
  ctx.provide('lwbPackWorkspaces', workspaces)
  ctx.provide('lwbPackServices', new LwbPackServices(ctx, workspaces))
  const packGroup = await createPackGroup(ctx)
  const packRuntime = new LwbPackRuntime(ctx, { group: packGroup })
  ctx.provide('lwbPackRuntime', packRuntime)
  ctx.settings.installSection(ctx, WORKBENCH_NS, WorkbenchSettings, { state: {} }, {
    setSource: () => {},
    onChange: () => {},
  })
  ctx.plugin(LwbArchiveGateway)
  ctx.plugin(LwbPackGateway)
  ctx.plugin(LwbRemoteSettingsGateway, {
    mode: normalizeRemoteSettingsMode(config.remoteSettings?.mode),
  })
  // The bundle's own services are only injectable once this fiber is active.
  // Start restoration on that transition, after the baseline pack dependencies
  // are available, and let the gateway await the resulting task.
  restoreEnabledPacks(ctx, packRuntime)
}
