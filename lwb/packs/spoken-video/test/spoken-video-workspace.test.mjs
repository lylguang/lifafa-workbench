import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm, readdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpokenVideoGateway } from '../gateway.mjs'
import { SpokenVideoContentStore } from '../spoken-video-content-store.mjs'
import { SpokenVideoProjectStore } from '../spoken-video-store.mjs'
import { LwbPackWorkspaces } from '../../../dsh-bundle/pack-workspaces.mjs'

test('account RPCs use the host-owned workspace without an Agent and ignore client-supplied cwd', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spoken-video-scope-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manager = new LwbPackWorkspaces({ root })
  const first = await manager.activate({ id: 'spoken-video', packageName: '@test/spoken-video' })
  const other = await manager.activate({ id: 'other-pack', packageName: '@test/other-pack' })
  const content = new SpokenVideoContentStore({ workspacePath: first.workspacePath })
  const receiver = { ctx: { spokenVideoScope: { request: (operation) => manager.run('spoken-video', operation) }, spokenVideoContent: content } }
  await SpokenVideoGateway.prototype.createAccount.call(receiver, { name: 'isolated account', workspacePath: other.workspacePath, agentId: 'ordinary-session' })
  const result = await SpokenVideoGateway.prototype.listAccounts.call(receiver)
  assert.equal(result.accounts[0].name, 'isolated account')
  const projects = new SpokenVideoProjectStore()
  const project = await projects.create(first, { title: 'owned project' })
  assert.deepEqual(await readdir(first.workspacePath), ['data'])
  assert.equal(JSON.parse(await readFile(join(first.workspacePath, 'data', 'projects', project.id, 'project.json'), 'utf8')).title, 'owned project')
  const restored = new SpokenVideoContentStore({ workspacePath: first.workspacePath })
  assert.equal((await restored.listAccounts(first)).accounts[0].name, 'isolated account')
  await assert.rejects(restored.listAccounts(other), /工作区不匹配/u)
  assert.deepEqual(await readdir(other.workspacePath), [])
  await manager.deactivate('spoken-video')
  await assert.rejects(SpokenVideoGateway.prototype.listAccounts.call(receiver), { code: 'PACK_WORKSPACE_INACTIVE' })
})

test('business stores reject a data directory redirected outside the owned workspace', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spoken-video-data-boundary-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manager = new LwbPackWorkspaces({ root })
  const first = await manager.activate({ id: 'spoken-video', packageName: '@test/spoken-video' })
  const other = await manager.activate({ id: 'other-pack', packageName: '@test/other-pack' })
  await symlink(other.workspacePath, join(first.workspacePath, 'data'))
  const content = new SpokenVideoContentStore({ workspacePath: first.workspacePath })
  await assert.rejects(content.listAccounts(first), /数据目录无效/u)
  await assert.rejects(new SpokenVideoProjectStore().create(first, { title: 'must not escape' }), /项目目录无效/u)
  assert.deepEqual(await readdir(other.workspacePath), [])
})
