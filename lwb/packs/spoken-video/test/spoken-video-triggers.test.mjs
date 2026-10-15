import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  buildHookReference,
  findHookPattern,
  findTrigger,
  HOOK_PATTERNS,
  TRIGGER_CATEGORIES,
} from '../spoken-video-triggers.mjs'

test('every hook pattern carries a shape and a boundary', () => {
  assert.ok(HOOK_PATTERNS.length >= 5)
  for (const pattern of HOOK_PATTERNS) {
    assert.ok(pattern.id, '钩子类型必须有 id')
    assert.ok(pattern.shape, `${pattern.id} 必须给出句式`)
    assert.ok(pattern.avoid, `${pattern.id} 必须说明什么时候不适用`)
  }
})

test('every trigger subtype carries formulas and a usage boundary', () => {
  assert.ok(TRIGGER_CATEGORIES.length >= 3)
  for (const category of TRIGGER_CATEGORIES) {
    assert.ok(category.subtypes.length, `${category.id} 至少要有一个子类`)
    for (const subtype of category.subtypes) {
      assert.ok(subtype.formulas.length, `${subtype.id} 必须给公式`)
      assert.ok(subtype.boundary, `${subtype.id} 必须给出使用边界`)
    }
  }
})

test('lookup returns the exact match and null for anything unknown', () => {
  assert.equal(findHookPattern('number-promise')?.name, '数字承诺')
  // 不猜、不近似匹配——挑错钩子类型比没有提示更糟
  assert.equal(findHookPattern('number'), null)
  assert.equal(findHookPattern(''), null)
  assert.equal(findTrigger('greed-efficiency')?.category.name, '贪婪')
  assert.equal(findTrigger('nope'), null)
})

test('hook reference lists every pattern and trigger without shipping ready-made copy', () => {
  const reference = buildHookReference()
  for (const pattern of HOOK_PATTERNS) {
    assert.ok(reference.includes(pattern.id), `${pattern.id} 必须出现在参考文本里`)
    assert.ok(reference.includes(pattern.shape))
  }
  for (const category of TRIGGER_CATEGORIES) {
    assert.ok(reference.includes(category.name))
  }
})

test('no trigger ships a finished headline, only formulas', () => {
  // 成品文案会被逐字复述，复述出来的钩子听感上像模板。
  // 例子只能出现在 hook library 的示例位，且要短。
  const examples = TRIGGER_CATEGORIES.flatMap((category) => category.subtypes.flatMap((subtype) => subtype.examples))
  assert.ok(examples.length > 0, '至少要有示例，否则公式太抽象')
  for (const example of examples) {
    assert.ok([...example].length <= 24, `示例过长会变成可被逐字复述的成品文案：${example}`)
  }
})