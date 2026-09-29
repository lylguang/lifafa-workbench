import {
  loadMarketplaceLwbPack,
  marketplaceLwbPacks,
  unloadLwbPack,
} from '../pack-manager.mjs'
import { linkLwbPackForRuntime } from '../pack-runtime-links.mjs'

function requestId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('能力包操作请求无效。')
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(id)) throw new Error('能力包标识无效。')
  return id
}

function clientOnly(entry) {
  return entry.options.config?.clientOnly === true
}

function stringList(value, field, packageName) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`能力包 ${JSON.stringify(packageName)} 的浏览器模块图 ${field} 无效。`)
  }
  return [...value]
}

/**
 * Project the host-owned, revisioned browser artifact for one mounted pack.
 * The URL comes from DSH's client-module registry, never from a pack manifest.
 */
export function projectClientBundle(graph, packageName) {
  const entries = graph?.entries
  if (!Array.isArray(entries)) throw new Error('DSH 浏览器模块图尚未就绪。')
  const row = entries.find((candidate) => candidate?.id === packageName)
  if (!row) return undefined
  if (typeof row.url !== 'string' || !row.url.startsWith('/plugins/')) {
    throw new Error(`能力包 ${JSON.stringify(packageName)} 缺少受控浏览器 bundle。`)
  }
  if (typeof row.rev !== 'string' || !row.rev) {
    throw new Error(`能力包 ${JSON.stringify(packageName)} 的浏览器 bundle 版本无效。`)
  }
  return Object.freeze({
    id: packageName,
    url: row.url,
    rev: row.rev,
    inject: stringList(row.inject, 'inject', packageName),
    external: stringList(row.external, 'external', packageName),
  })
}

/**
 * Generic lifecycle manager for optional packages. It never imports a package
 * while cataloguing. Code is imported only by Cordis Loader from an
 * inspectable package source, either after an explicit user load or while
 * restoring a previously enabled package at startup.
 */
export class LwbPackRuntime {
  static inject = ['lwbPackRegistry', 'clientModules', 'lwbPackServices', 'lwbPackWorkspaces']

  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.group = options.group
    this.tail = Promise.resolve()
    this.restoreFailures = new Map()
    this.startupRestore = Promise.resolve()
  }

  serial(operation) {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  isMounted(id) {
    return this.ctx.lwbPackRegistry.list().some((pack) => pack.id === id)
  }

  entriesFor(packageName) {
    const entries = this.group
      ? [...this.group.tree.entries()].filter((entry) => entry.parent === this.group)
      : [...this.ctx.loader.entries()]
    return entries.filter((entry) => entry.options.name === packageName)
  }

  async clientBundle(packageName) {
    // clientModules reconciles Loader entry changes in a microtask. Loader.await()
    // has settled the pack fiber by this point, so a short bounded yield is enough
    // to observe its immutable, revisioned browser artifact.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bundle = projectClientBundle(this.ctx.clientModules?.graph?.(), packageName)
      if (bundle) return bundle
      await Promise.resolve()
    }
    throw new Error(`能力包 ${JSON.stringify(packageName)} 未能加入 DSH 浏览器模块图。`)
  }

  async removeCreatedEntries(packageName, previous) {
    const created = this.entriesFor(packageName)
      .filter((entry) => !previous.has(entry.id))
      .sort((left, right) => Number(clientOnly(right)) - Number(clientOnly(left)))
    for (const entry of created) {
      try { await this.removeEntry(entry) } catch (_) {}
    }
  }

  async awaitEntries(ids) {
    for (const id of ids) {
      const fiber = this.ctx.loader.resolve(id).fiber
      if (!fiber) throw new Error(`能力包加载条目 ${JSON.stringify(id)} 未能创建运行实例。`)
      await fiber.await()
    }
  }

  async mount(pack) {
    const { id, packageName } = pack.manifest
    if (!pack.available) {
      throw new Error(`LWB pack ${JSON.stringify(id)} is unavailable: ${pack.error || 'source cannot be inspected'}`)
    }
    if (this.isMounted(id)) {
      return {
        id,
        packageName,
        status: 'loaded',
        reloaded: false,
        client: await this.clientBundle(packageName),
      }
    }

    await linkLwbPackForRuntime(pack)
    const before = new Set(this.entriesFor(packageName).map((entry) => entry.id))
    try {
      await this.ctx.lwbPackServices?.mount(pack.manifest)
      const entries = [
        await this.createEntry({ name: packageName }),
        await this.createEntry({ name: packageName, config: { clientOnly: true } }),
      ]
      // Do not await the entire Loader here. Startup restoration runs while the
      // LWB root entry is still activating, so the global tree includes us.
      await this.awaitEntries(entries)
      if (!this.isMounted(id)) {
        throw new Error(`能力包 ${JSON.stringify(id)} 未能成功注册到 LWB 宿主。`)
      }
      return { id, packageName, status: 'loaded', reloaded: true, client: await this.clientBundle(packageName) }
    } catch (error) {
      await this.removeCreatedEntries(packageName, before)
      await this.ctx.lwbPackServices?.unmount(id)
      throw error
    }
  }

  async createEntry(options) {
    if (this.group) {
      // EntryGroup.create starts a fiber but does not add its config to data.
      // Keep the group roster so unload and parent disposal own these entries.
      this.group.data.push(options)
      return this.group.create(options)
    }
    return this.ctx.loader.create(options)
  }

  async removeEntry(entry) {
    if (this.group && entry.parent === this.group) {
      this.group.remove(entry.options.id)
    } else {
      await this.ctx.loader.remove(entry.id)
    }
    // Group.remove starts disposal synchronously but does not await effects.
    // Wait before reporting success or registering replacement services.
    while (entry.fiber?.inertia) await entry.fiber.inertia
  }

  setStartupRestore(task) {
    this.startupRestore = Promise.resolve(task).catch((error) => {
      this.ctx.logger.error(error)
      return { loaded: [], failed: [{ id: 'startup', error: error instanceof Error ? error.message : String(error) }] }
    })
  }

  ready() {
    return this.startupRestore
  }

  async restore() {
    return this.serial(async () => {
      let packs
      try {
        packs = await marketplaceLwbPacks()
      } catch (error) {
        this.ctx.logger.error(error)
        return { loaded: [], failed: [{ id: 'marketplace', error: error instanceof Error ? error.message : String(error) }] }
      }

      const loaded = []
      const failed = []
      for (const pack of packs.filter((candidate) => candidate.enabled === true)) {
        try {
          loaded.push(await this.mount(pack))
          this.restoreFailures.delete(pack.manifest.id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.restoreFailures.set(pack.manifest.id, message)
          this.ctx.logger.error(`LWB capability pack ${JSON.stringify(pack.manifest.id)} was not restored: ${message}`)
          failed.push({ id: pack.manifest.id, error: message })
        }
      }
      return { loaded, failed }
    })
  }

  async market() {
    const mounted = new Set(this.ctx.lwbPackRegistry.list().map((pack) => pack.id))
    const packs = await marketplaceLwbPacks()
    return {
      schemaVersion: 1,
      packs: packs.map((pack) => ({
        ...pack.manifest,
        status: mounted.has(pack.manifest.id) ? 'loaded' : pack.available ? 'available' : 'unavailable',
        origin: pack.origin,
        installedAt: pack.installedAt,
        enabled: pack.enabled,
        ...((pack.error || this.restoreFailures.get(pack.manifest.id)) ? { error: pack.error || this.restoreFailures.get(pack.manifest.id) } : {}),
      })),
    }
  }

  async load(request) {
    const id = requestId(request)
    return this.serial(async () => {
      if (this.isMounted(id)) {
        const pack = (await marketplaceLwbPacks()).find((item) => item.manifest.id === id)
        if (!pack) throw new Error(`未找到能力包 ${JSON.stringify(id)}。`)
        this.restoreFailures.delete(id)
        return {
          id,
          packageName: pack.manifest.packageName,
          status: 'loaded',
          reloaded: false,
          client: await this.clientBundle(pack.manifest.packageName),
        }
      }
      const pack = await loadMarketplaceLwbPack(id)
      try {
        const result = await this.mount(pack)
        this.restoreFailures.delete(id)
        return result
      } catch (error) {
        await unloadLwbPack(id).catch(() => {})
        throw error
      }
    })
  }

  async unload(request) {
    const id = requestId(request)
    return this.serial(async () => {
      const market = await marketplaceLwbPacks()
      const pack = market.find((item) => item.manifest.id === id)
      if (!pack) throw new Error(`未找到能力包 ${JSON.stringify(id)}。`)
      const entries = this.entriesFor(pack.manifest.packageName)
        .sort((left, right) => Number(clientOnly(right)) - Number(clientOnly(left)))
      await this.ctx.lwbPackServices?.unmount(id)
      for (const entry of entries) await this.removeEntry(entry)
      await unloadLwbPack(id)
      this.restoreFailures.delete(id)
      return { id, packageName: pack.manifest.packageName, status: 'available', reloaded: entries.length > 0 }
    })
  }

  async maintain(request, operation) {
    const id = requestId(request)
    if (request.confirm !== true) throw new Error('请明确确认本次能力包数据操作。')
    return this.serial(async () => {
      if (this.isMounted(id)) throw new Error('请先卸载能力包，等待任务停止后再执行数据操作。')
      return this.ctx.lwbPackWorkspaces[operation](id)
    })
  }
}
