import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const clientPath = new URL('../client.js', import.meta.url)
const gatewayPath = new URL('../gateway.mjs', import.meta.url)

// 白名单：gateway 里「确实没有 UI 入口」的方法。每一项都要写清为什么留着、后续谁来接。
// 一旦为某个方法补了 UI 入口（字面量 remote('x') 或 useLiveTask('kind','x',...)），
// 就把它的名字从这里删掉——否则本测试会红。
// 当前所有面向用户的方法都已接上 UI 入口（UI 工程师本轮把账号矩阵 5 个与
// listScriptGenerations 都接上了），故白名单为空；若后续新增无人调用的 remote 方法，
// 再在此登记并附理由，不要为「其实没接上」的方法开白名单。
const RESERVED_OR_UNCALLED = new Set([
])

function gatewayMethodNames(gateway) {
  // 权威来源：gateway.mjs 里 `for (const method of [...]) decorateRemote(...)` 数组，
  // 列出的就是所有对外暴露的 remote 方法（不含 constructor / 内部 local）。
  const block = gateway.match(/for\s*\(const method of \[([\s\S]*?)\]\)\s*decorateRemote/)
  assert.ok(block, 'gateway.mjs 必须包含 decorateRemote 方法数组')
  return new Set([...block[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]))
}

// 客户端实际调用到的方法名：既要抓字面量 remote('x')，也要抓
// useLiveTask('kind', 'x', ...) 这类把方法名当字符串参数间接传给 remote 的形式
// （useLiveTask 内部就是 remote(statusMethod, ...)）。漏抓会让「有 UI 入口的方法」
// 被误判成死接口，也能让真正漏接的方法逃过检查。
function calledMethods(client) {
  const names = new Set()
  for (const m of client.matchAll(/remote\(\s*['"]([A-Za-z]+)['"]/gmu)) names.add(m[1])
  for (const m of client.matchAll(/useLiveTask\(\s*(?:['"][A-Za-z]+['"]|[A-Za-z_$][\w$]*)\s*,\s*['"]([A-Za-z]+)['"]/gu)) names.add(m[1])
  return names
}

test('client.js 调用的每个 remote 方法都在 gateway.mjs 中存在', async () => {
  const client = await readFile(clientPath, 'utf8')
  const gateway = await readFile(gatewayPath, 'utf8')

  const gatewayMethods = gatewayMethodNames(gateway)
  const called = calledMethods(client)

  assert.ok(called.size > 0, 'client.js 应至少调用一个 remote 方法')
  for (const method of called) {
    assert.ok(gatewayMethods.has(method), `client.js 调用了 gateway 不存在的方法：${method}`)
  }
})

test('gateway 里每个面向用户的方法要么被 client.js 调用、要么在白名单中', async () => {
  const client = await readFile(clientPath, 'utf8')
  const gateway = await readFile(gatewayPath, 'utf8')

  const gatewayMethods = gatewayMethodNames(gateway)
  const called = calledMethods(client)

  const unaccounted = [...gatewayMethods].filter((m) => !called.has(m) && !RESERVED_OR_UNCALLED.has(m))
  assert.deepEqual(
    unaccounted,
    [],
    `以下 gateway 方法既没被 client.js 调用、也不在白名单里（死接口或漏接 UI）：${unaccounted.join(', ')}`,
  )
})

// 盲点修复证明：提取逻辑必须认得出 useLiveTask 这类间接调用，而不只是字面量 remote('x')。
test('calledMethods 同时识别字面量与 useLiveTask 间接调用', () => {
  const synthetic = [
    "remote('literalMethod', {})",
    "useLiveTask('harvest', 'indirectMethod', 'harvests', 2000)",
    "useLiveTask('topic', 'anotherIndirect', 'topics')",
    "useLiveTask(kind, 'variableKindIndirect', 'items')",
  ].join('\n')
  const called = calledMethods(synthetic)
  assert.ok(called.has('literalMethod'), '字面量调用应被识别')
  assert.ok(called.has('indirectMethod'), 'useLiveTask 间接调用应被识别')
  assert.ok(called.has('anotherIndirect'), 'useLiveTask 间接调用应被识别')
  assert.ok(called.has('variableKindIndirect'), 'useLiveTask 的 kind 为变量时也应被识别')
})

// 抓得住真问题：一个既没被调用、也不在白名单的方法必须被判为漏接。
test('既没被调用、也不在白名单的方法会被判为漏接', () => {
  const gatewayMethods = new Set(['realMethod', 'ghostMethod'])
  const called = new Set(['realMethod'])
  const unaccounted = [...gatewayMethods].filter((m) => !called.has(m) && !RESERVED_OR_UNCALLED.has(m))
  assert.deepEqual(unaccounted, ['ghostMethod'], '漏接的方法应被列出')
})
