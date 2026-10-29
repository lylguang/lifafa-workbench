import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const packRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const packJson = JSON.parse(await readFile(join(packRoot, 'package.json'), 'utf8'))

test('story-account 声明对 spoken-video 的依赖（不再用跨包相对路径 import）', () => {
  const declared = Object.assign({}, packJson.dependencies, packJson.peerDependencies)
  assert.ok(
    typeof declared['@scitiger-ai/lwb-spoken-video'] === 'string',
    'package.json 必须声明 @scitiger-ai/lwb-spoken-video 依赖（workspace:*）',
  )
})

test('story-account 全包不再有 ../spoken-video/ 的跨包相对路径 import', async () => {
  const entries = await readdir(packRoot, { withFileTypes: true })
  let violations = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const source = await readFile(join(packRoot, entry.name), 'utf8')
    // 只匹配真正的 import 说明符（from '../spoken-video/...'），忽略注释与测试自身的字面量。
    if (/\bfrom\s*['"]\.\.\/spoken-video\//u.test(source)) violations += 1
  }
  assert.equal(violations, 0, `仍发现 ${violations} 个跨包相对路径 import（应为 0）`)
})
