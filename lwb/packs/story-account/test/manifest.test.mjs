import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 能力包清单与模块契约的静态断言。
 *
 * 这些断言替代了「打开浏览器点一遍」：环境里起不了子进程（沙箱拒绝 spawn），
 * 而清单与模块导出是可静态验证的——页面漏注册、菜单与清单不一致、命名空间
 * 与另一个内容包撞车，这三类问题上线前最容易漏，也最贵。
 */

const here = dirname(fileURLToPath(import.meta.url))
const packRoot = resolve(here, '..')
const repoRoot = resolve(packRoot, '..', '..', '..')

async function manifest() { return JSON.parse(await readFile(join(packRoot, 'lwb-pack.json'), 'utf8')) }

test('清单 id 与包名和目录约定一致', async () => {
  const data = await manifest()
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.id, 'story-account')
  assert.equal(data.packageName, '@scitiger-ai/lwb-story-account')
  assert.equal(data.name, '情感故事号')
})

test('每个菜单都有唯一的 id、label 与 glyph', async () => {
  const data = await manifest()
  const ids = data.menus.map((menu) => menu.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const menu of data.menus) {
    assert.ok(menu.label && menu.glyph, `菜单 ${menu.id} 缺 label/glyph`)
  }
})

test('功能页都能在菜单里找到对应项', async () => {
  const data = await manifest()
  const menuIds = new Set(data.menus.map((menu) => menu.id))
  for (const feature of data.market.features) {
    assert.ok(menuIds.has(feature.menuId), `功能 ${feature.menuId} 没有对应菜单`)
  }
})

test('流程与功能页数量一致，不漏阶段', async () => {
  const data = await manifest()
  assert.ok(data.market.workflow.length >= 6)
  assert.ok(data.market.features.length >= 7)
  for (const hint of data.market.gettingStarted) assert.ok(hint.length > 0)
})

test('浏览器端注册的页面覆盖全部功能页', async () => {
  const data = await manifest()
  const client = await readFile(join(packRoot, 'client.js'), 'utf8')
  for (const feature of data.market.features) {
    // 键名可能带引号（audio-captions / video-preview 这类带连字符的），两种写法都认。
    const registered = client.includes(`${feature.menuId}:`) || client.includes(`'${feature.menuId}':`)
    assert.ok(registered, `client.js 未注册页面 ${feature.menuId}`)
  }
  assert.ok(client.includes(`id: '@scitiger-ai/lwb-story-account'`))
})

test('浏览器桥的命名空间与通用口播包隔离', async () => {
  const gateway = await readFile(join(packRoot, 'gateway.mjs'), 'utf8')
  assert.ok(gateway.includes("super(ctx, 'storyAccount')"), '网关命名空间必须是 storyAccount')
  assert.ok(!gateway.includes("super(ctx, 'spokenVideo')"))
  assert.ok(gateway.includes('storyAccountScope'))
})

test('没有实现内容安排：前期日更需要人守评论', async () => {
  const data = await manifest()
  assert.equal(data.menus.some((menu) => menu.id === 'content-schedule'), false)
  assert.ok(data.market.gettingStarted.some((line) => line.includes('内容安排')))
})

test('技能文档把「禁止升华」写成硬约束', async () => {
  const { STORY_SKILL_DOCUMENT, STORY_SKILL_FILE } = await import('../story-account-skill.mjs')
  assert.ok(STORY_SKILL_DOCUMENT.includes('禁止升华'))
  assert.ok(STORY_SKILL_DOCUMENT.includes('反塑料感'))
  assert.ok(STORY_SKILL_FILE.endsWith('story-account.md'))
})

test('包已被接入仓库的 check 与 unit:test 脚本', async () => {
  const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  assert.ok(rootPackage.scripts.check.includes('lwb/packs/story-account/index.mjs'))
  assert.ok(rootPackage.scripts.check.includes('lwb/packs/story-account/client.js'))
  assert.ok(rootPackage.scripts['unit:test'].includes('lwb/packs/story-account/test/*.test.mjs'))
})

test('包内不引入仓库外的绝对路径', async () => {
  const files = [
    'index.mjs', 'gateway.mjs', 'story-account-store.mjs', 'story-account-content.mjs',
    'story-account-paths.mjs', 'story-account-profile.mjs', 'story-account-materials.mjs',
    'story-account-topic.mjs', 'story-account-antiplastic.mjs', 'story-account-script.mjs',
    'story-account-qc.mjs', 'story-account-publish.mjs', 'story-account-subtitles.mjs',
  ]
  for (const file of files) {
    const source = await readFile(join(packRoot, file), 'utf8')
    assert.ok(!/[A-Z]:\\\\/u.test(source), `${file} 含绝对路径`)
  }
})
