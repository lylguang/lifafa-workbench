import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import * as cordis from '../../../vendor/deepseek-harness/vendor/cordis/lib/index.js'
import * as slots from '../../../vendor/deepseek-harness/packages/client/ui-slots/lib/index.js'

const require = createRequire(import.meta.url)
const upstream = new URL('../../../vendor/deepseek-harness/packages/client/', import.meta.url)

async function clientModule(path) {
  let plugin
  vm.runInNewContext(await readFile(new URL(path, upstream), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => {
      plugin = factory((name) => name === '@deepseek-ai/cordis' ? cordis
        : name === '@deepseek-ai/dsh-client-ui-slots' ? slots : require(name))
    } } },
    queueMicrotask,
  })
  return plugin
}

test('LWB shell keeps both native DSH directory pickers active across slot lifetimes', async () => {
  const { SlotRegistry } = await clientModule('ui-renderer/lib/client.js')
  const picker = await clientModule('ui-directory-picker-native/lib/client.js')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const options = source.match(/ctx\.slots\.inject\('shell\.overlay', \(\) => ctx\.slots\.register\((\{[\s\S]*?\}), WorkbenchOverlay\)\)/u)?.[1]
  assert.ok(options, 'read the actual LWB overlay declaration')

  const ctx = new cordis.Context()
  const slotRuntime = ctx.plugin(SlotRegistry)
  await slotRuntime.await()
  const registry = ctx.slots
  ctx.provide('uiWorkspace', { pickDirectory: async () => null })
  const hero = 'conversation.hero.workspace.directoryFlow'
  const sidebar = 'sidebar.workspaces.directoryFlow'
  const disposeRoot = registry.register({ name: 'root', children: {
    'shell.overlay': { kind: 'list', scope: 'root' },
    [hero]: { kind: 'single', scope: 'root' },
  } }, () => null)
  const runtime = ctx.plugin(picker)
  await runtime.await()
  try {
    // This was the broken composition: the native picker waits for its sibling.
    assert.equal(registry.entries(hero).length, 0)
    for (let mount = 0; mount < 2; mount++) {
      const disposeOverlay = registry.register(vm.runInNewContext(`(${options})`), () => null)
      assert.equal(registry.entries(hero).length, 1, 'empty conversation must have a picker')
      assert.equal(registry.entries(sidebar).length, 1, 'history must share the DSH picker')
      disposeOverlay()
      assert.equal(registry.entries(hero).length, 0, 'paired picker retires with its owner')
    }
  } finally {
    await runtime.dispose()
    disposeRoot()
    await slotRuntime.dispose()
  }
  assert.match(source, /h\(ConversationOverlay, \{ renderSlot \}\)/u)
  assert.match(source, /renderSlot\('sidebar\.workspaces\.directoryFlow', \{/u)
  assert.doesNotMatch(source, /services\??\.uiWorkspace\??\.pickDirectory/u)
})
