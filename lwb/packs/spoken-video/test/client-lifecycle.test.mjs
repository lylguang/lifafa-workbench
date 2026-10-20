import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('unloading releases capability pages so the client can be loaded again', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('    async function apply(ctx)')
  // 只取到「第一个顶格导出行」为止。vm 沙箱只注入了 apply 需要的宿主依赖、
  // 并没有 `exports`，把导出语句切进来会抛 ReferenceError: exports is not defined。
  // 按正则找第一个 `^ {4}exports\.` 而不是枚举具体导出名：将来新增任何导出
  // （排在 exports.inject 之前或之后都一样）都不会再被切进沙箱。
  const rest = source.slice(start)
  const match = /^\s{4}exports\./mu.exec(rest)
  const end = match ? start + match.index : source.length
  assert.ok(start >= 0 && end > start)
  const components = ['AccountPositioningPage', 'SignalsPage', 'TopicsPage', 'ScriptPage',
    'AudioCaptionsPageV2', 'VideoPreviewPageV2', 'PublishPageV4', 'ContentSchedulePage', 'PipelineBoardPage']
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
    assert.equal(Object.keys(registered.get('spoken-video')).length, 9)
    while (effects.length) effects.pop()()
    assert.equal(registered.size, 0, 'host disposal must unregister the pages')
  }
})
