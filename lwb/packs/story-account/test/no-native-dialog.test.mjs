import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'client.js'), 'utf8')

// 原生 alert/prompt/confirm 是同步阻塞的：弹窗一开主线程就冻住，自动化、无人值守、
// 嵌入式 webview 里连 Runtime.evaluate 都会超时。所有反馈必须走页面内组件。
test('story-account 客户端不再调用原生阻塞弹窗（window.alert / prompt / confirm）', () => {
  const calls = clientSrc.match(/window\.(alert|prompt|confirm)\s*\(/g) || []
  assert.deepEqual(
    calls,
    [],
    `不应存在任何 window.alert/prompt/confirm 调用，发现：${calls.join(', ')}`,
  )
})
