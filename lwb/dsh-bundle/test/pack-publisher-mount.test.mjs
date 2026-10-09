import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LwbPackServices } from '../pack-services.mjs'
import { LwbPackWorkspaces } from '../pack-workspaces.mjs'

const PACK_ID = 'publisher'
const PACK_ROOT = join(import.meta.dirname, '..', '..', 'packs', PACK_ID)

/**
 * Mount the publisher pack through the same service layer the workbench uses.
 * This is the gate that matters: a pack whose manifest or scope usage is wrong
 * fails here rather than at startup in front of the user.
 */
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-publisher-mount-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = {
    credentials: {
      resolve: async () => ({ value: null }),
      describe: async () => ({ configured: false }),
      set: async () => {},
      unset: async () => {},
    },
    settings: { register: (name) => name },
  }
  const workspaces = new LwbPackWorkspaces({ root })
  const services = new LwbPackServices(ctx, workspaces)
  const manifest = JSON.parse(await readFile(join(PACK_ROOT, 'lwb-pack.json'), 'utf8'))
  return { root, workspaces, services, manifest }
}

test('the publisher manifest is accepted by the host and activates its own workspace', async (t) => {
  const { services, manifest, root } = await setup(t)
  const scope = await services.mount(manifest)
  assert.equal(scope.id, PACK_ID)
  const context = await scope.context()
  // The host assigns a dedicated directory per pack; business data lives under it.
  assert.ok(context.workspacePath.startsWith(root))
  assert.ok(context.workspacePath.endsWith(join('workspaces', PACK_ID)))
})

test('credential references are namespaced per pack and cannot collide', async (t) => {
  const { services, manifest } = await setup(t)
  const scope = await services.mount(manifest)
  const ref = scope.credentialRef('douyin')
  // The host prefixes refs with pack identity, so two packs may use the same
  // logical name without overwriting each other's secret.
  assert.match(ref, /publisher/iu)
  assert.notEqual(ref, scope.credentialRef('wechat'))
})

test('settings namespaces are pack-scoped', async (t) => {
  const { services, manifest } = await setup(t)
  const scope = await services.mount(manifest)
  assert.match(scope.settingsNamespace('publish'), /publisher/u)
  assert.throws(() => scope.settingsNamespace('Bad Name'), /设置名称/u)
})

test('the pack entry declares no hard dependency on the video pack', async () => {
  const entry = await readFile(join(PACK_ROOT, 'index.mjs'), 'utf8')
  const declared = entry.match(/export const inject = \[([^\]]*)\]/u)
  assert.ok(declared, 'the entry must declare its inject list')
  // Declaring spokenVideo* as an inject would make Cordis keep this pack
  // pending forever when the video pack is absent, instead of loading with a
  // disabled publish shelf.
  assert.doesNotMatch(declared[1], /spokenVideo/u)
})

test('the pack ships the four files the manifest contract requires', async () => {
  for (const file of ['lwb-pack.json', 'package.json', 'index.mjs', 'client.js']) {
    const raw = await readFile(join(PACK_ROOT, file), 'utf8')
    assert.ok(raw.length > 0, `${file} must not be empty`)
  }
  const pkg = JSON.parse(await readFile(join(PACK_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['.'], './index.mjs')
})

test('the client registers exactly the menus the manifest declares', async () => {
  const manifest = JSON.parse(await readFile(join(PACK_ROOT, 'lwb-pack.json'), 'utf8'))
  const client = await readFile(join(PACK_ROOT, 'client.js'), 'utf8')
  const registered = client.match(/pages: \{([^}]*)\}/u)
  assert.ok(registered, 'the client must register pages')
  for (const menu of manifest.menus) {
    assert.match(registered[1], new RegExp(`\\b${menu.id}\\b`, 'u'), `menu ${menu.id} must have a page`)
  }
})

test('browser automation is opt-in and reported when unavailable', async (t) => {
  const { services, manifest } = await setup(t)
  const scope = await services.mount(manifest)
  const context = await scope.context()
  const { PublisherStore } = await import('../../packs/publisher/publisher-store.mjs')
  const { PublisherBrowserPool } = await import('../../packs/publisher/publisher-browser.mjs')
  const { PublisherHost } = await import('../../packs/publisher/publisher-host.mjs')
  const store = new PublisherStore({ workspacePath: context.workspacePath })
  const browser = new PublisherBrowserPool({ dataRoot: store.dataRoot, onLog: () => {} })
  const host = new PublisherHost({ store, browser, workspacePath: context.workspacePath })
  const status = await host.status()
  // Whatever this machine has installed, the pack must answer with a usable
  // diagnosis instead of throwing.
  assert.equal(typeof status.browser.ready, 'boolean')
  if (!status.browser.ready) {
    assert.ok(status.browser.playwright === null || status.browser.executable === null)
  }
  assert.equal(status.spokenVideo.available, false)
  // Every declared adapter must be present in status so the form and the docs
  // cannot drift from the registry.
  assert.deepEqual(status.adapters, ['douyin', 'bilibili', 'kuaishou'])
})

test('a pack workspace is isolated from other packs', async (t) => {
  const { services, manifest, root } = await setup(t)
  const publisher = await services.mount(manifest)
  const other = await services.mount({ id: 'someone-else', packageName: '@test/someone-else', name: 'other' })
  const a = await publisher.context()
  const b = await other.context()
  assert.notEqual(a.workspacePath, b.workspacePath)
  await writeFile(join(a.workspacePath, 'marker.txt'), 'publisher')
  const seen = await readFile(join(a.workspacePath, 'marker.txt'), 'utf8')
  assert.equal(seen, 'publisher')
  assert.ok(b.workspacePath.startsWith(root))
  // Compare the assigned directory, not the whole path: the temp root itself
  // may legitimately contain the pack id in its name.
  assert.equal(b.workspacePath.split(/[\\/]/u).at(-1), 'someone-else')
  assert.notEqual(a.workspacePath.split(/[\\/]/u).at(-1), b.workspacePath.split(/[\\/]/u).at(-1))
})
