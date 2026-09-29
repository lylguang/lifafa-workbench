import assert from 'node:assert/strict'
import test from 'node:test'
import { LwbPackRuntime } from '../pack-runtime.mjs'

test('dynamic group entries remain owned and removal awaits asynchronous service disposal', async () => {
  const entries = new Map()
  let release
  const disposal = new Promise((resolve) => { release = resolve })
  const group = {
    data: [], tree: { entries: () => entries.values() },
    async create(options) {
      options.id = 'host-entry'
      entries.set(options.id, { id: options.id, options, parent: group, fiber: {} })
      return options.id
    },
    remove(id) {
      const entry = entries.get(id)
      entry.fiber.inertia = disposal.then(() => { entry.fiber.inertia = undefined })
      entries.delete(id)
      group.data.splice(group.data.indexOf(entry.options), 1)
    },
  }
  const runtime = new LwbPackRuntime({}, { group })
  await runtime.createEntry({ name: '@test/pack' })
  assert.equal(group.data.length, 1, 'parent group disposal must include dynamic entries')
  const [entry] = runtime.entriesFor('@test/pack')
  assert.ok(entry)
  let removed = false
  const removing = runtime.removeEntry(entry).then(() => { removed = true })
  await Promise.resolve()
  assert.equal(removed, false)
  release(); await removing
  assert.equal(group.data.length, 0)
  assert.deepEqual(runtime.entriesFor('@test/pack'), [])
})
