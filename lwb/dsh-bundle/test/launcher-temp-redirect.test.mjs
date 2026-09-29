import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const launcherPath = fileURLToPath(new URL('../../dsh-launcher.mjs', import.meta.url))

// launcher 是顶层就执行的脚本，直接 import 会真的去启动工作台。
// 这里只把 applyTempRedirect 抽出来在沙箱里跑，验证临时目录重定向的取舍。
async function loadApplyTempRedirect({ mkdirFails = false } = {}) {
  const source = await readFile(launcherPath, 'utf8')
  const start = source.indexOf('const DEFAULT_TEMP_DIR =')
  const end = source.indexOf('async function ensureSymlink(', start)
  assert.ok(start >= 0 && end > start, 'launcher must keep the temp redirect helper extractable')
  const sandbox = {
    join,
    resolve: (...parts) => resolve('/', ...parts),
    mkdirSync: () => { if (mkdirFails) throw new Error('read-only checkout') },
    // 被抽出的片段引用了 launcher 顶部的常量，这里补上即可。
    ROOT_DIR: resolve('/', 'repo', 'lifafa-workbench-main'),
  }
  vm.runInNewContext(`${source.slice(start, end)}\n;globalThis.__h = { applyTempRedirect, DEFAULT_TEMP_DIR }`, sandbox)
  return sandbox.__h
}

test('launcher moves TEMP off the system drive so renders cannot fill C:', async () => {
  const { applyTempRedirect } = await loadApplyTempRedirect()
  const env = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'C:\\Users\\x\\AppData\\Local\\Temp', TMP: 'C:\\Users\\x\\AppData\\Local\\Temp' })
  assert.equal(env.TEMP.startsWith('C:'), false)
  assert.equal(env.TMP, env.TEMP)
  // 子进程（Remotion / Chrome / ffmpeg）靠这个变量判断是否已重定向。
  assert.equal(env.LWB_TEMP_DIR, env.TEMP)
})

test('launcher leaves an explicit or already-relocated TEMP alone', async () => {
  const { applyTempRedirect } = await loadApplyTempRedirect()
  const override = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'C:\\Temp', LWB_TEMP_DIR: 'D:\\custom' })
  assert.equal(override.TEMP, 'C:\\Temp')

  const relocated = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'D:\\scratch', TMP: 'D:\\scratch' })
  assert.equal(relocated.TEMP, 'D:\\scratch')
  assert.equal(relocated.LWB_TEMP_DIR, undefined)
})

test('launcher still starts when the target directory cannot be created', async () => {
  const { applyTempRedirect } = await loadApplyTempRedirect({ mkdirFails: true })
  const env = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'C:\\Temp' })
  // 只读检出不应阻止工作台启动：保持原样即可。
  assert.equal(env.TEMP, 'C:\\Temp')
})

test('the launcher passes the redirected environment to the DSH child process', async () => {
  const source = await readFile(launcherPath, 'utf8')
  assert.match(source, /env: applyTempRedirect\(\{ \.\.\.process\.env, DSH_HOME \}\)/u)
  assert.doesNotMatch(source, /env: \{ \.\.\.process\.env, DSH_HOME \}/u)
})

test('the media bridge keeps ffmpeg scratch files off the system drive', async () => {
  // bridge.mjs 位于工作台根目录下的「本地媒体桥接」，不在 lifafa-workbench-main 内。
  const bridgePath = fileURLToPath(new URL('../../../../本地媒体桥接/bridge.mjs', import.meta.url))
  const bridge = await readFile(bridgePath, 'utf8')
  // 重定向必须发生在第一个 ffmpeg 调用之前，否则设置不生效。
  const redirectAt = bridge.indexOf('process.env.TEMP = scratch')
  const firstFfmpegAt = bridge.indexOf("execFile('ffmpeg'")
  assert.ok(redirectAt > 0, 'bridge must redirect TEMP')
  assert.ok(firstFfmpegAt > redirectAt, 'bridge must redirect TEMP before invoking ffmpeg')
  assert.match(bridge, /if \(!process\.env\.LWB_TEMP_DIR\)/u)
})
