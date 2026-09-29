import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { LwbPackRegistry } from '../pack-registry.mjs'
import { projectClientBundle } from '../pack-runtime.mjs'

const manifest = {
  schemaVersion: 1,
  id: 'spoken-video',
  packageName: '@scitiger-ai/lwb-spoken-video',
  name: '口播视频内容创作',
  version: '0.1.0',
  description: '一个独立的内容创作能力包。',
  menus: [{ id: 'projects', label: '项目', glyph: '创', tone: 'orange' }],
}

test('projects mounted packs without exposing mutable registry state', () => {
  const registry = new LwbPackRegistry()
  const unregister = registry.register(manifest)
  const list = registry.list()
  assert.deepEqual(list, [manifest])
  list[0].name = 'browser mutation'
  assert.equal(registry.list()[0].name, manifest.name)
  unregister()
  assert.deepEqual(registry.list(), [])
})

test('fails closed for package-id collisions', () => {
  const registry = new LwbPackRegistry()
  registry.register(manifest)
  assert.throws(() => registry.register(manifest), /registered more than once/u)
  assert.throws(() => registry.register({ ...manifest, packageName: '@example/other', name: 'other' }), /id collision/u)
})

test('projects only a revisioned DSH-served browser bundle for a mounted pack', () => {
  const bundle = projectClientBundle({
    entries: [{
      id: '@example/pack',
      url: '/plugins/??@example/pack/client.js&rev=opaque-revision',
      rev: 'opaque-revision',
      inject: ['@scitiger-ai/lwb-dsh-bundle'],
      external: [],
    }],
  }, '@example/pack')

  assert.deepEqual(bundle, {
    id: '@example/pack',
    url: '/plugins/??@example/pack/client.js&rev=opaque-revision',
    rev: 'opaque-revision',
    inject: ['@scitiger-ai/lwb-dsh-bundle'],
    external: [],
  })
  assert.equal(projectClientBundle({ entries: [] }, '@example/pack'), undefined)
  assert.throws(() => projectClientBundle({ entries: [{ id: '@example/pack', url: '/unsafe.js', rev: 'r' }] }, '@example/pack'), /受控浏览器 bundle/u)
  assert.throws(() => projectClientBundle({ entries: [{ id: '@example/pack', url: '/plugins/??@example/pack/client.js&rev=r', rev: 'r', inject: 'not-an-array' }] }, '@example/pack'), /模块图 inject 无效/u)
})

test('declares the host services required for dynamic browser bundle projection', async () => {
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(source, /export const inject = \['loader', 'clientModules', 'settings', 'agents', 'agentPresets', 'permissionPresets', 'credentials', 'agentDefaultModel'\]/u)
})

test('restores enabled packs after the LWB host activates inside its loader subtree', async () => {
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function restoreEnabledPacks(')
  const end = source.indexOf('\nasync function createPackGroup(', start)
  const restoreEnabledPacks = runInNewContext(`${source.slice(start, end)}; restoreEnabledPacks`, { FIBER_ACTIVE: 2 })
  let notify, effect, startup, finish, calls = 0
  const pending = new Promise(resolve => { finish = resolve })
  const ctx = {
    fiber: { state: 1 },
    on: (event, callback) => { assert.equal(event, 'internal/status'); notify = callback },
    inject: (dependencies, callback) => {
      assert.deepEqual([...dependencies], ['subagents', 'tools'])
      effect = callback()
      return { await: () => effect }
    },
  }
  restoreEnabledPacks(ctx, {
    restore: async () => { calls++; await pending; return { loaded: ['spoken-video'], failed: [] } },
    setStartupRestore: task => { startup = task },
  })
  notify({ state: 2 }); notify(ctx.fiber)
  assert.equal(calls, 0)
  ctx.fiber.state = 2
  notify(ctx.fiber); notify(ctx.fiber)
  assert.equal(calls, 1)
  assert.equal(startup, effect)
  finish()
  assert.equal(await startup, undefined, 'Cordis must not receive the restore report as a disposal effect')
  assert.match(source, /const fiber = ctx\.plugin\(Group, \[\]\)[\s\S]*?const group = ctx\.fiber\.entry\?\.subgroup/u)
  assert.match(source, /new LwbPackRuntime\(ctx, \{ group: packGroup \}\)/u)
})
