import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LwbPackServices } from '../pack-services.mjs'
import { LwbPackWorkspaces } from '../pack-workspaces.mjs'

const manifest = (id) => ({ id, packageName: `@test/${id}`, name: id })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-services-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keys = new Map([['BAILIAN_API_KEY', 'ordinary-secret']])
  const settings = { providers: { ordinary: { apiKeyEnv: 'BAILIAN_API_KEY' } } }
  const calls = []
  let selection = { provider: 'ordinary', model: 'dsh-default', reasoningEffort: 'high' }
  const ctx = {
    agentDefaultModel: { currentSelection: () => selection },
    credentials: {
      resolve: async (ref) => ({ value: keys.get(ref) }),
      describe: async (ref) => ({ configured: keys.has(ref) }),
      set: async (ref, value) => keys.set(ref, value), unset: async (ref) => keys.delete(ref),
    },
    settings: {
      get: () => settings,
      register: (name) => name,
      mutate: async (ns, ops) => { assert.equal(ns, 'llm-pi-ai'); for (const op of ops) settings.providers[op.path[1]] = op.value },
    },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async (_, id) => calls.push(['preset', id]) },
    permissionPresets: { set: (_, value) => calls.push(['permission', value]) },
    agents: { create: async (options) => {
      const owned = await workspaces.visibility()
      assert.ok(owned.sessionIds.includes(options.sessionId), 'ownership must be durable before Agent publication')
      calls.push(['create', options])
      const agent = { session: { header: { cwd: options.meta.cwd } } }
      // The real setup Context deliberately does not inject `agent`.
      await options.setup({})
      return { agent, dispose: async () => calls.push(['dispose']) }
    } },
  }
  const workspaces = new LwbPackWorkspaces({ root })
  const services = new LwbPackServices(ctx, workspaces)
  const first = await services.mount(manifest('spoken-video'))
  const second = await services.mount(manifest('another-pack'))
  return { root, ctx, keys, settings, calls, services, workspaces, first, second, setSelection: (value) => { selection = value } }
}

test('data access needs no Agent; directories, credentials and settings are isolated', async (t) => {
  const { first, second, calls, keys } = await setup(t)
  assert.notEqual((await first.context()).workspacePath, (await second.context()).workspacePath)
  await first.request(async (context) => writeFile(join(context.workspacePath, 'data'), 'first'))
  assert.equal(calls.length, 0)
  assert.equal((await first.credentials.describe('BAILIAN_API_KEY')).configured, false)
  await first.credentials.set('BAILIAN_API_KEY', 'first-secret')
  assert.equal((await second.credentials.describe('BAILIAN_API_KEY')).configured, false)
  assert.equal((await first.credentials.resolve('BAILIAN_API_KEY')).value, 'first-secret')
  assert.equal(keys.get('BAILIAN_API_KEY'), 'ordinary-secret')
  assert.notEqual(first.settingsNamespace('media'), second.settingsNamespace('media'))
  await assert.rejects(first.assertAgent({ session: { header: { cwd: (await second.context()).workspacePath } } }), /此工具/)
})

test('AI roots use DSH defaults without pack model credentials and keep owned cwd and permissions', async (t) => {
  const { first, second, calls, services, ctx, settings, keys } = await setup(t)
  // Authentication belongs to the DSH adapter, including OAuth/environment
  // discovery. The pack must neither inspect nor rewrite model credentials.
  ctx.credentials = new Proxy({}, { get() { throw new Error('pack must not touch DSH model authentication') } })
  const originalSettings = structuredClone(settings)
  const originalKeys = [...keys]
  assert.equal((await services.executionStatus(first.id)).configured, true)
  assert.equal((await services.executionStatus(second.id)).configured, true)
  await assert.rejects(first.withAgent(() => { throw new Error('job failed') }), /job failed/)
  const options = calls.find(([kind]) => kind === 'create')[1]
  assert.deepEqual(options.agentOptions, { provider: 'ordinary', model: 'dsh-default', reasoningEffort: 'high' })
  assert.equal(options.meta.cwd, (await first.context()).workspacePath)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'create'), [['preset', 'standard'], ['permission', 'workspace-write'], ['dispose']])
  assert.deepEqual(settings, originalSettings)
  assert.deepEqual([...keys], originalKeys)
})

test('new pack sessions follow updated DSH defaults while each in-flight session keeps its snapshot', async (t) => {
  const { first, second, calls, settings, setSelection } = await setup(t)
  settings.providers['lwb-pack-spoken-video'] = { apiKeyEnv: 'STALE_PACK_KEY', models: [{ id: 'stale-pack-model' }] }
  const entered = deferred(), finish = deferred()
  const inFlight = first.withAgent(async () => { entered.resolve(); await finish.promise })
  await entered.promise
  setSelection({ provider: 'updated-dsh', model: 'new-default' })
  await second.withAgent(() => {})
  await first.withAgent(() => {})
  const roots = calls.filter(([kind]) => kind === 'create').map(([, options]) => options)
  assert.deepEqual(roots.map((options) => options.agentOptions), [
    { provider: 'ordinary', model: 'dsh-default', reasoningEffort: 'high' },
    { provider: 'updated-dsh', model: 'new-default' },
    { provider: 'updated-dsh', model: 'new-default' },
  ])
  assert.notEqual(roots[0].meta.cwd, roots[1].meta.cwd)
  assert.equal(roots[0].meta.cwd, roots[2].meta.cwd)
  finish.resolve(); await inFlight
})

test('missing DSH selection points to native settings; native execution errors propagate unchanged', async (t) => {
  const { first, services, setSelection, calls, ctx } = await setup(t)
  setSelection(null)
  assert.equal((await services.executionStatus(first.id)).configured, false)
  await assert.rejects(first.withAgent(() => {}), /DSH 尚未选择默认模型/)
  assert.equal(calls.length, 0)
  setSelection({ provider: 'ordinary', model: 'dsh-default' })
  const failure = Object.assign(new Error('DSH provider credentials unavailable'), { code: 'MISSING_CREDENTIAL' })
  ctx.agents.create = async () => { throw failure }
  await assert.rejects(first.withAgent(() => {}), (error) => error === failure)
})

test('unload waits for late background final writes admitted by an in-flight request', async (t) => {
  const { first, second, services, workspaces } = await setup(t)
  const entered = deferred(), release = deferred(), backgroundStarted = deferred(), finish = deferred()
  const path = join((await first.context()).workspacePath, 'final')
  const request = first.request(async () => {
    entered.resolve(); await release.promise
    first.background((async () => { backgroundStarted.resolve(); await finish.promise; await writeFile(path, 'settled') })())
  })
  await entered.promise
  let stopped = false
  const stopping = services.unmount(first.id).then(() => { stopped = true })
  await new Promise((resolve) => setImmediate(resolve))
  release.resolve(); await request; await backgroundStarted.promise
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  await assert.rejects(workspaces.clearData(first.id), { code: 'PACK_WORKSPACE_BUSY' })
  assert.equal(second.signal.aborted, false)
  finish.resolve(); await stopping
  assert.equal(await readFile(path, 'utf8'), 'settled')
  assert.equal(first.signal.aborted, true)
  await assert.rejects(first.request(() => {}), { code: 'PACK_WORKSPACE_INACTIVE' })
  const replacement = await services.mount(manifest(first.id))
  assert.equal(replacement.signal.aborted, false)
})

test('stopping a pack cancels its HTTP and explicit-signal AI operations only', async (t) => {
  const { first, second, services } = await setup(t)
  await services.unmount(first.id)
  assert.throws(() => first.fetch('http://127.0.0.1:1'), /停止/)
  await assert.rejects(first.withAgent(() => {}, new AbortController().signal), /停止/)
  assert.equal(second.signal.aborted, false)
})
