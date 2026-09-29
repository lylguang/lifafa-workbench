import assert from 'node:assert/strict'
import test from 'node:test'
import { LwbPackManifestError, validateLwbPackManifest, getLwbPackScope } from '../index.mjs'

const manifest = {
  schemaVersion: 1,
  id: 'spoken-video',
  packageName: '@scitiger-ai/lwb-spoken-video',
  name: '口播视频内容创作',
  version: '0.1.0',
  description: '一个独立的内容创作能力包。',
  menus: [{ id: 'projects', label: '项目', glyph: '创', tone: 'orange' }],
}

test('normalizes a public LWB capability pack manifest into an immutable value', () => {
  const result = validateLwbPackManifest(manifest)
  assert.deepEqual(result, manifest)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.menus), true)
  assert.throws(() => { result.name = 'changed' }, TypeError)
})

test('rejects unsafe package identity and duplicate menu ids', () => {
  assert.throws(() => validateLwbPackManifest({ ...manifest, packageName: '../outside' }), LwbPackManifestError)
  assert.throws(() => validateLwbPackManifest({ ...manifest, menus: [...manifest.menus, { id: 'projects', label: '重复' }] }), LwbPackManifestError)
})

test('obtains an existing host scope without accepting a browser workspace binding', () => {
  const scope = Object.freeze({ id: manifest.id })
  assert.equal(getLwbPackScope({ lwbPackServices: { forPack: (id) => { assert.equal(id, manifest.id); return scope } } }, manifest), scope)
  assert.throws(() => getLwbPackScope({}, manifest), /workspace service/)
})

test('normalizes and freezes optional detail content while preserving legacy manifests', () => {
  const market = {
    introduction: '  从灵感到作品。  ',
    workflowHint: '按需使用。',
    gettingStarted: ['  先配置模型。  '],
    features: [{ menuId: 'projects', title: '项目管理', description: '管理创作项目。', icon: 'future-icon' }],
  }
  const result = validateLwbPackManifest({ ...manifest, market })
  assert.equal(result.market.introduction, '从灵感到作品。')
  assert.deepEqual(result.market.gettingStarted, ['先配置模型。'])
  assert.equal(result.market.features[0].icon, 'future-icon')
  assert.equal(Object.isFrozen(result.market.features[0]), true)
  assert.throws(() => result.market.gettingStarted.push('修改'), TypeError)
  market.features[0].title = '修改原始输入'
  assert.equal(result.market.features[0].title, '项目管理')
  assert.deepEqual(validateLwbPackManifest({ ...manifest, market: { category: '创作' } }).market, { category: '创作' })
})

test('rejects invalid detail references and oversized or incomplete detail content', () => {
  const feature = { menuId: 'projects', title: '项目管理', description: '管理创作项目。' }
  for (const market of [
    { features: [{ ...feature, menuId: 'missing' }] },
    { features: [feature, feature] },
    { features: [] },
    { features: Array(17).fill(feature) },
    { features: [{ ...feature, description: '' }] },
    { features: [{ ...feature, title: 'x'.repeat(81) }] },
    { features: [{ ...feature, icon: 'x'.repeat(33) }] },
    { introduction: 'x'.repeat(501) },
    { workflowHint: 'x'.repeat(241) },
    { gettingStarted: [] },
    { gettingStarted: ['重复', '重复'] },
    { gettingStarted: ['x'.repeat(241)] },
    { gettingStarted: Array.from({ length: 9 }, (_, i) => String(i)) },
  ]) assert.throws(() => validateLwbPackManifest({ ...manifest, market }), LwbPackManifestError)
})
