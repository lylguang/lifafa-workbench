import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 能力包注册表生命周期：安装、重载、启用、卸载、重装。
 *
 * AGENTS.md 要求「pack changes must verify load, unload, and reload」。这一组
 * 用例直接调 pack-manager 的导出函数（而不是 CLI），因为要断言的正是
 * 「装好 ≠ 启用」这个两步语义，以及重复安装不会在注册表里留下两条记录。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const packSource = join(root, 'lwb', 'packs', 'story-account')
const PACK_ID = 'story-account'

async function withRegistry(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-lifecycle-'))
  const previous = process.env.LWB_PACK_REGISTRY
  process.env.LWB_PACK_REGISTRY = join(dir, 'packs.json')
  try {
    // 每次都要新鲜导入：registry 路径在模块加载时读取。
    const manager = await import(`../../../pack-manager.mjs?lifecycle=${Date.now()}-${Math.random()}`)
    await run(manager)
  } finally {
    if (previous === undefined) delete process.env.LWB_PACK_REGISTRY
    else process.env.LWB_PACK_REGISTRY = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('安装后注册表只有一条记录，且 manifest 完整', async () => {
  await withRegistry(async (manager) => {
    const installed = await manager.installLwbPack(packSource)
    assert.equal(installed.manifest.id, PACK_ID)
    const packs = (await manager.installedLwbPacks()).filter((pack) => pack.manifest.id === PACK_ID)
    assert.equal(packs.length, 1)
    assert.ok(packs[0].manifest.menus.length >= 7)
  })
})

test('重复安装不会在注册表里留下两条记录', async () => {
  await withRegistry(async (manager) => {
    await manager.installLwbPack(packSource)
    await manager.installLwbPack(packSource)
    await manager.installLwbPack(packSource)
    const packs = (await manager.installedLwbPacks()).filter((pack) => pack.manifest.id === PACK_ID)
    assert.equal(packs.length, 1, `重载后出现 ${packs.length} 条记录`)
  })
})

test('装好不等于启用：enabled 由宿主装载时决定', async () => {
  await withRegistry(async (manager) => {
    const installed = await manager.installLwbPack(packSource)
    assert.equal(installed.enabled, false)
    const enabled = await manager.installLwbPack(packSource, { enabled: true })
    assert.equal(enabled.enabled, true)
    const packs = (await manager.installedLwbPacks()).filter((pack) => pack.manifest.id === PACK_ID)
    assert.equal(packs.length, 1)
  })
})

test('卸载后注册表清空，源码目录不受影响', async () => {
  await withRegistry(async (manager) => {
    await manager.installLwbPack(packSource, { enabled: true })
    await manager.removeLwbPack(PACK_ID)
    assert.equal((await manager.installedLwbPacks()).filter((pack) => pack.manifest.id === PACK_ID).length, 0)
    // 卸载只动注册表，不删仓库里的源码。
    const reinstalled = await manager.installLwbPack(packSource)
    assert.equal(reinstalled.manifest.id, PACK_ID)
  })
})

test('菜单 id 唯一，且功能页都能对上菜单', async () => {
  await withRegistry(async (manager) => {
    const installed = await manager.installLwbPack(packSource)
    const ids = installed.manifest.menus.map((menu) => menu.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const feature of installed.manifest.market.features) {
      assert.ok(ids.includes(feature.menuId), `功能 ${feature.menuId} 没有对应菜单`)
    }
  })
})
