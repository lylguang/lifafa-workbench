import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAntiPlastic, measureSentenceRhythm, findDialogue, measureConcreteness,
  HARD_BLOCKED, LIFTED_ENDINGS,
} from '../story-account-antiplastic.mjs'

/** 一段刻意写成「合格人味」的稿子：具体场景、对白、长短句参差、留白收尾。 */
const GOOD = `「妈，锅里的鱼你吃吧，我不饿。」
年初三晚上，我在厨房说完这句，就把碗放回水池。
水龙头开得很大。我没关。
我妈坐在饭桌那头，没抬头，只说了一句：「那你明天几点走。」
我说八点。
她说：「哦。」
后来我把行李箱从阳台拖出来，轮子在地砖上响。她起来给我塞了两个橘子，说路上吃。
门关上的时候，我听见厨房的水还在流。
我走到楼下，抬头看了一眼。灯还亮着。`

function report(body) { return checkAntiPlastic({ body }) }

test('合格稿件通过反塑料感检查', () => {
  const result = report(GOOD)
  assert.equal(result.passed, true, result.blocking.join('; '))
  assert.ok(result.score >= 70, `score ${result.score}`)
  assert.equal(result.deterministic, true)
})

test('套路词命中即硬拦', () => {
  for (const rule of HARD_BLOCKED) {
    const sample = `${GOOD}\n${rule.re.source.replace(/\\/gu, '')}`
    const result = report(sample)
    assert.ok(result.blocking.some((item) => item.includes(rule.name)), `${rule.id} 未被拦下`)
  }
})

test('结尾升华句被拦下', () => {
  for (const phrase of LIFTED_ENDINGS.slice(0, 6)) {
    const result = report(`${GOOD}\n${phrase}，这就是生活。`)
    assert.equal(result.passed, false, phrase)
    assert.ok(result.blocking.some((item) => item.includes('升华')))
  }
})

test('全篇没有对白时判为 AI 结构', () => {
  const body = `${'我在厨房站了很久，水龙头一直开着。'.repeat(6)}${'后来我下楼，街上没有人。'.repeat(4)}`
  const result = report(body)
  assert.equal(findDialogue(body).count, 0)
  assert.ok(result.blocking.some((item) => item.includes('对白')))
})

test('句长均匀被判为 AI 指纹', () => {
  // 每句都是 14 字、没有短句——这正是模型最常见的输出形态。
  const sentence = '我站在厨房门口看着那锅冷掉的鱼汤'
  const body = Array.from({ length: 12 }, () => sentence).join('。')
  const rhythm = measureSentenceRhythm(body)
  assert.equal(rhythm.uniform, true)
  const result = report(body)
  assert.ok(result.blocking.some((item) => item.includes('均匀')))
})

test('合格稿件的句长不是均匀的', () => {
  const rhythm = measureSentenceRhythm(GOOD)
  assert.equal(rhythm.uniform, true === false)
  assert.ok(rhythm.standardDeviation > 4.5)
  assert.ok(rhythm.shortRatio >= 0.12)
})

test('完全没有具体锚点时硬拦', () => {
  // 刻意不含任何时间/地点/物件锚点，只用情绪词与抽象叙述；长度超过门限才进入该判据。
  const body = `${'我很难过，一直难过，说不出话。'.repeat(16)}「你还好吗。」他说。`
  const concrete = measureConcreteness(body)
  assert.equal(concrete.timeAnchors + concrete.placeAnchors + concrete.objectAnchors, 0)
  const result = report(body)
  assert.ok(result.charCount >= 200, `charCount ${result.charCount}`)
  assert.ok(result.blocking.some((item) => item.includes('具体时间、地点或物件')))
})

test('AI 口癖累计到 3 处以上硬拦', () => {
  const body = `${GOOD}\n某种意义上，不得不说，那一刻五味杂陈。`
  const result = report(body)
  assert.equal(result.passed, false)
  assert.ok(result.blocking.some((item) => item.includes('口癖')))
})

test('单处 AI 口癖只给建议不拦截', () => {
  const body = `${GOOD}\n某种意义上，那天晚上很安静。`
  const result = report(body)
  assert.equal(result.passed, true)
  assert.ok(result.suggestions.some((item) => item.includes('口癖')))
})

test('对白里的书面语连接词只给建议', () => {
  const body = `${GOOD}\n他说：「因此我不打算去了。」`
  const result = report(body)
  assert.equal(result.passed, true)
  assert.ok(result.suggestions.some((item) => item.includes('书面语')))
})

test('空稿件不崩，且不产生无意义结论', () => {
  const result = report('')
  assert.equal(result.charCount, 0)
  assert.equal(result.passed, true)
  assert.equal(result.score >= 0, true)
})

test('报告结构稳定，供 UI 直接渲染', () => {
  const result = report(GOOD)
  for (const key of ['artifactType', 'reportVersion', 'deterministic', 'charCount', 'sentenceCount', 'blocking', 'suggestions', 'passed', 'score', 'checks']) {
    assert.ok(key in result, `缺少字段 ${key}`)
  }
  for (const key of ['banned', 'dialogue', 'cliches', 'rhythm', 'concrete', 'liftedEndings', 'expectedHook', 'expectedTheme']) {
    assert.ok(key in result.checks, `checks 缺少字段 ${key}`)
  }
})
