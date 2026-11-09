import assert from 'node:assert/strict'
import test from 'node:test'
import { checkNumberConsistency, extractNumbers } from '../spoken-video-number-consistency.mjs'

// 数字一致性是本轮改造最硬的一条判据（docs/39 §4.2）：
// 写稿层拿到了真实星数之后，正文里出现的数字必须能在信号素材里原样找到。
// 找不到就是编造——这就是过去 10 篇稿子只能写「轻量强大」的根因。

test('extractNumbers 归一化千分位、万、亿三种形态', () => {
  const numbers = extractNumbers('65,243 star · 4,236 fork · 今日 +2,088 · 6.5万关注 · 1.2亿下载')
  assert.ok(numbers.has(65243), '千分位应归一化')
  assert.ok(numbers.has(4236))
  assert.ok(numbers.has(2088))
  assert.ok(numbers.has(65000), '万应换算')
  assert.ok(numbers.has(120000000), '亿应换算')
})

test('extractNumbers 不把英文单位当成千/兆', () => {
  // `10 min` / `5 km` / `24 kWh` / `1,200 members` 里的字母紧跟数字。
  // 把 k/M 当量级会把完全正常的句子判成编造——这个校验在生产链路上。
  const numbers = extractNumbers('跑完只要 10 min，距离 5 km，电量 24 kWh，1,200 members')
  assert.equal(numbers.has(10000000), false, 'min 不能当兆')
  assert.equal(numbers.has(5000), false, 'km 不能当千')
  assert.equal(numbers.has(24000), false, 'kWh 不能当千')
  assert.ok(numbers.has(1200), '千分位仍要正常归一化')
  assert.equal(numbers.has(200000000), false, 'members 不能当兆')
})

test('extractNumbers 把「万亿」当成一个量级，不当成万', () => {
  const numbers = extractNumbers('2.8 万亿参数')
  assert.ok(numbers.has(2800000000000), `万亿应换算成 2.8e12，实际 ${[...numbers].join(',')}`)
  assert.equal(numbers.has(28000), false)
})

test('extractNumbers 读得出中文数字', () => {
  assert.ok(extractNumbers('他有六万五千个星').has(65000))
  assert.ok(extractNumbers('一万三').has(13000))
  assert.ok(extractNumbers('二十亿千瓦').has(2000000000))
})

test('extractNumbers 能读到句末被句号收尾的整数', () => {
  assert.ok(extractNumbers('他有 12000. 这是真的').has(12000))
})

test('extractNumbers 不把小数点后的零散数字当引用事实', () => {
  const numbers = extractNumbers('版本 1.2.3，参数 0.75')
  assert.equal(numbers.has(123), false)
  assert.equal(numbers.has(75), false)
})

test('日期与 IP 里的数字段不当成引用事实', () => {
  const numbers = extractNumbers('更新于 2026-11-08，来源 192.168.1.1')
  assert.equal(numbers.has(2026), false, '日期里的年份不该算数字')
  assert.equal(numbers.has(11), false)
  assert.equal(numbers.has(192), false)
  assert.equal(numbers.has(168), false)
})

test('正文数字能在信号里原样找到时判为有据', () => {
  const signals = [{
    text: 'An extremely fast Python linter · 65,243 star · 4,236 fork · 今日 +2,088',
    hotValue: 2088,
    rank: 3,
  }]
  // 正文用中文数字说「六万」，素材是 65,243 —— 口播的取整说法不是编造。
  const result = checkNumberConsistency('这个项目总星数已经超过六万。', signals)
  assert.equal(result.consistent, true, `不应有编造数字：${result.unsupported.join(',')}`)
})

test('信号与正文用不同写法说同一个数时也算对得上', () => {
  const signals = [{ text: '项目 · 六万五千 star', hotValue: null, rank: null }]
  const result = checkNumberConsistency('这个项目已经有 65,000 个星了。', signals)
  assert.equal(result.consistent, true, '中文写法与阿拉伯数字写法应当能对上')
  assert.ok(result.cited.includes(65000))
})

test('正文出现信号里没有的大数字时判为编造', () => {
  const signals = [{ text: '项目 · 65,243 star · 今日 +2,088', hotValue: 2088, rank: 3 }]
  const result = checkNumberConsistency('听说它已经攒到 30 万用户了。', signals)
  assert.equal(result.consistent, false)
  assert.ok(result.unsupported.includes(300000), '30 万应被判为无据')
  assert.ok(result.cited.length === 0)
})

test('小于 1000 的数字不参与一致性判定（结构计数不算引用事实）', () => {
  const signals = [{ text: '项目说明', hotValue: null, rank: null }]
  const result = checkNumberConsistency('三个方法，两个例子，都在这里。', signals)
  assert.equal(result.consistent, true)
  assert.deepEqual(result.unsupported, [])
})

test('信号带 hotValue 时正文可引用该数值', () => {
  const signals = [{ text: '热榜项目', hotValue: 2088, rank: 1 }]
  const result = checkNumberConsistency('今天涨了 2,088 个星。', signals)
  assert.equal(result.consistent, true)
  assert.ok(result.cited.includes(2088))
})

test('信号为空时正文的大数字全部判为无据', () => {
  const result = checkNumberConsistency('这个项目有 120,000 个星。', [])
  assert.equal(result.consistent, false)
  assert.ok(result.unsupported.includes(120000))
})

test('年份不判为编造数字（时间指代不是数据引用）', () => {
  const signals = [{ text: '项目说明', hotValue: null, rank: null }]
  const result = checkNumberConsistency('这是 2026 年的新版本，参数也换了。', signals)
  assert.equal(result.consistent, true, '年份不该被判为编造')
  assert.deepEqual(result.unsupported, [])
})
