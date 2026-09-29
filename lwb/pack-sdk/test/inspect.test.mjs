import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectLwbPack } from '../../pack-manager.mjs'

test('inspects a standalone package without executing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lwb-pack-inspect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  const manifest = {
    schemaVersion: 1, id: 'example-pack', packageName: '@example/lwb-pack', name: '示例', version: '0.1.0', description: '示例能力包。',
    menus: [{ id: 'home', label: '主页' }],
  }
  await Promise.all([
    writeFile(join(root, 'lwb-pack.json'), JSON.stringify(manifest)),
    writeFile(join(root, 'index.mjs'), 'throw new Error("must not execute")\n'),
    writeFile(join(root, 'client.js'), 'throw new Error("must not execute")\n'),
    writeFile(join(root, 'package.json'), JSON.stringify({
      name: '@example/lwb-pack', version: '0.1.0', type: 'module', main: './index.mjs',
      exports: { '.': './index.mjs', './client': './client.js' }, dsh: { client: { platform: 'web' } },
    })),
  ])
  const inspected = await inspectLwbPack(root)
  assert.equal(inspected.manifest.id, 'example-pack')
  assert.equal(inspected.hostEntry, './index.mjs')
  assert.equal(inspected.clientEntry, './client.js')
})
