import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('unloading releases capability pages so the client can be loaded again', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('    async function apply(ctx)')
  const end = source.indexOf('    exports.inject', start)
  assert.ok(start >= 0 && end > start)
  const components = ['AccountPositioningPage', 'SignalsPage', 'TopicsPage', 'ScriptPage',
    'AudioCaptionsPageV2', 'VideoPreviewPageV2', 'PublishPageV4', 'ContentSchedulePage']
  const apply = vm.runInNewContext(`${source.slice(start, end)}; apply`, {
    connection: null, executionRemote: null, executionStreams: null, installStyle() {},
    ...Object.fromEntries(components.map(name => [name, () => null])),
  })
  const registered = new Map()
  const effects = []
  const ctx = {
    get: (key) => key === 'remote' ? { async $mount(contribution) { assert.equal(contribution.descriptors[0].mode, 'stream'); } } : {},
    async plugin(plugin) { plugin.apply(ctx) },
    effect: setup => effects.push(setup()),
    lwbPackClient: {
      register({ packId, pages }) {
        assert.equal(registered.has(packId), false, 'no stale page registration survives unload')
        registered.set(packId, pages)
        return () => registered.delete(packId)
      },
    },
  }
  for (let cycle = 0; cycle < 2; cycle++) {
    await apply(ctx)
    assert.equal(Object.keys(registered.get('spoken-video')).length, 8)
    while (effects.length) effects.pop()()
    assert.equal(registered.size, 0, 'host disposal must unregister the pages')
  }
})
