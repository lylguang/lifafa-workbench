import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const clientPath = new URL('../client.js', import.meta.url)
const contentPath = new URL('../story-account-content.mjs', import.meta.url)

// 历史写稿记录的状态四态，与后端 story-account-content.mjs 共用同一套字面量。
// 后端只可能产出这三种 record.status；任何其它拼写（如 'succeeded'）都会被
// writeRecordStatus 归到「排队中」兜底，导致已完成稿件误显示。
const VALID_RECORD_STATUS = new Set(['running', 'success', 'failed'])

// 最小加载 client.js：只为了拿到模块导出的 writeRecordStatus 做行为断言，
// 不触发 apply（apply 会真正创建 React 组件树）。
async function loadWriteRecordStatus() {
  const source = await readFile(clientPath, 'utf8')
  const React = { createElement: () => ({ }) }
  const win = {
    __ModuleLoader__: { load: (entry) => { win.__entry = entry } },
    setTimeout: () => 0,
    clearTimeout: () => { },
  }
  const doc = {
    getElementById: () => null,
    createElement: () => ({ style: { }, setAttribute() { } }),
    head: { appendChild() { } },
  }
  const runner = new Function('window', 'document', 'React', `${source}\nreturn window.__entry;`)
  const entry = runner(win, doc, React)
  const mod = entry.factory(() => ({ }))
  assert.ok(typeof mod.writeRecordStatus === 'function', 'client.js 应导出 writeRecordStatus 供历史列表统一判定')
  return mod.writeRecordStatus
}

test('后端只产出 running/success/failed 三种 record.status，不含 succeeded', async () => {
  const source = await readFile(contentPath, 'utf8')
  const found = [...source.matchAll(/record\.status\s*=\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(found.length > 0, '应在 story-account-content.mjs 中找到 record.status 赋值')
  for (const value of found) {
    assert.ok(VALID_RECORD_STATUS.has(value), `record.status 出现了非约定值 '${value}'（只应是 running/success/failed）`)
  }
})

test('client.js 对写稿记录状态的判断不再出现 succeeded', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.doesNotMatch(source, /'succeeded'/u, '百炼/旧拼写 succeeded 一旦混进前端判断，已完成稿件会被误判为排队中')
  // 历史列表的 chip 必须走统一判定函数，而不是再写一遍内联三元。
  assert.match(source, /writeRecordStatus\(record\.status\)/u, '历史写稿记录的 chip 应使用 writeRecordStatus 统一判定')
})

test('历史写稿记录 chip：success 显示「已完成」且 good 色', async () => {
  const writeRecordStatus = await loadWriteRecordStatus()
  const done = writeRecordStatus('success')
  assert.equal(done.label, '已完成', '后端 status: success 必须渲染成「已完成」')
  assert.equal(done.tone, 'good', '已完成应有 good 色，否则 chip 不显绿')
})

test('历史写稿记录 chip：其它三态映射正确', async () => {
  const writeRecordStatus = await loadWriteRecordStatus()
  assert.deepEqual(writeRecordStatus('failed'), { label: '失败', tone: 'bad' })
  assert.deepEqual(writeRecordStatus('running'), { label: '进行中', tone: undefined })
  // 后端从不产出 'succeeded'，若有人误写，必须落到「排队中」兜底（即红不起来、不谎报已完成）。
  assert.deepEqual(writeRecordStatus('succeeded'), { label: '排队中', tone: undefined })
  assert.deepEqual(writeRecordStatus('weird'), { label: '排队中', tone: undefined })
})
