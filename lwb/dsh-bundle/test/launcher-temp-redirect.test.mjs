import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const launcherPath = fileURLToPath(new URL('../../dsh-launcher.mjs', import.meta.url))

// launcher 是顶层就执行的脚本，直接 import 会真的去启动工作台。
// 这里只把选盘与重定向的代码抽出来在沙箱里跑，验证临时目录的取舍。
//
// 盘符探测用注入的 statfsSync 驱动：真机上D: 到 Z: 的存在与空闲各不相同，
// 断言只能针对"规则"而不能针对某一个盘。
async function loadApplyTempRedirect({ mkdirFails = false, freeGb = {}, existing = [] } = {}) {
  const source = await readFile(launcherPath, 'utf8')
  const start = source.indexOf('// 渲染要写大量临时数据')
  const end = source.indexOf('async function ensureSymlink(', start)
  assert.ok(start >= 0 && end > start, 'launcher must keep the scratch-picking helper extractable')
  const toBytes = (gb) => BigInt(Math.round(gb * 1024 ** 3))
  const sandbox = {
    join,
    resolve: (...parts) => resolve('/', ...parts),
    mkdirSync: () => { if (mkdirFails) throw new Error('read-only checkout') },
    existsSync: (p) => existing.includes(String(p).replace(/\//gu, '')) || String(p).replace(/\//gu, '') === '/',
    statfsSync: (root) => {
      const letter = String(root).toUpperCase().replace(/[^A-Z]/gu, '')
      const gb = freeGb[letter]
      if (gb === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { bavail: toBytes(gb), bsize: 1n }
    },
    // 被抽出的片段引用了 launcher 顶部的常量，这里补上即可。
    ROOT_DIR: resolve('/', 'repo', 'lifafa-workbench-main'),
  }
  vm.runInNewContext(
    `${source.slice(start, end)}\n;globalThis.__h = { applyTempRedirect, resolveScratchRoot, isScratchOffSystemDrive, SCRATCH_MIN_FREE_GB }`,
    sandbox,
  )
  return sandbox.__h
}

test('launcher picks the roomiest non-system drive instead of a hardcoded one', async () => {
  //客户机没有我们的 E: 盘，写死盘符的机器直接起不来。
  const { resolveScratchRoot } = await loadApplyTempRedirect({
    freeGb: { D: 30, E: 120, F: 60 },
    existing: ['D:\\', 'E:\\', 'F:\\'],
  })
  assert.equal(resolveScratchRoot({ SystemDrive: 'C:' }), 'E:\\lifa-scratch')
})

test('launcher skips drives too small to hold a render', async () => {
  // 渲染中途把盘写满比慢更糟，所以低于门槛的非系统盘不参与选择。
  const { resolveScratchRoot, SCRATCH_MIN_FREE_GB } = await loadApplyTempRedirect({
    freeGb: { D: 4, E: 12 },
    existing: ['D:\\', 'E:\\'],
  })
  assert.ok(4 < SCRATCH_MIN_FREE_GB && 12 < SCRATCH_MIN_FREE_GB)
  //两个都不够，退回系统盘的 LOCALAPPDATA，而不是硬塞进一个快满的盘。
  assert.equal(
    resolveScratchRoot({ SystemDrive: 'C:', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }),
    'C:\\Users\\x\\AppData\\Local\\lifa-scratch',
  )
})

test('launcher honours LWB_SCRATCH_ROOT so a delivery package can pin the drive', async () => {
  const { resolveScratchRoot } = await loadApplyTempRedirect({ freeGb: { Z: 200 }, existing: ['Z:\\'] })
  assert.equal(resolveScratchRoot({ SystemDrive: 'C:', LWB_SCRATCH_ROOT: 'Z:\\客户数据盘' }), 'Z:\\客户数据盘')
})

test('launcher moves TEMP off the system drive so renders cannot fill C:', async () => {
  const { applyTempRedirect } = await loadApplyTempRedirect({
    freeGb: { E: 120 }, existing: ['E:\\'],
  })
  const env = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'C:\\Users\\x\\AppData\\Local\\Temp', TMP: 'C:\\Users\\x\\AppData\\Local\\Temp' })
  assert.equal(env.TEMP.startsWith('C:'), false)
  assert.equal(env.TMP, env.TEMP)
  // 子进程（Remotion / Chrome / ffmpeg）靠这个变量判断是否已重定向。
  assert.equal(env.LWB_TEMP_DIR, env.TEMP)
})

test('launcher leaves an explicit or already-relocated TEMP alone', async () => {
  const { applyTempRedirect } = await loadApplyTempRedirect({
    freeGb: { E: 120 }, existing: ['E:\\'],
  })
  const override = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'C:\\Temp', LWB_TEMP_DIR: 'D:\\custom' })
  assert.equal(override.TEMP, 'C:\\Temp')

  const relocated = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'D:\\scratch', TMP: 'D:\\scratch' })
  assert.equal(relocated.TEMP, 'D:\\scratch')
  assert.equal(relocated.LWB_TEMP_DIR, undefined)
})

test('launcher still starts when the target directory cannot be created', async () => {
  const { applyTempRedirect } = await loadApplyTempRedirect({
    mkdirFails: true, freeGb: { E: 120 }, existing: ['E:\\'],
  })
  const env = applyTempRedirect({ SystemDrive: 'C:', TEMP: 'C:\\Temp' })
  // 只读检出不应阻止工作台启动：保持原样即可。
  assert.equal(env.TEMP, 'C:\\Temp')
})

test('the launcher passes the redirected environment to the DSH child process', async () => {
  const source = await readFile(launcherPath, 'utf8')
  // 重定向必须仍然包住整个 env；桥接地址是往里加的额外键，不能取代它。
  assert.match(source, /env: applyTempRedirect\(\{\s*\.\.\.process\.env,\s*DSH_HOME,/u)
  assert.doesNotMatch(source, /env: \{ \.\.\.process\.env, DSH_HOME \}/u)
})

// launcher 顶层会真的启动工作台，这里同样只抽取函数在沙箱里验证取舍。
async function loadResolveScitigerBaseUrl(fetchImpl) {
  const source = await readFile(launcherPath, 'utf8')
  const start = source.indexOf('const LOCAL_BRIDGE_URL =')
  const end = source.indexOf('async function syncProfile(', start)
  assert.ok(start >= 0 && end > start, 'launcher must keep the bridge probe helper extractable')
  const sandbox = { fetch: fetchImpl, AbortSignal, console }
  vm.runInNewContext(`${source.slice(start, end)}\n;globalThis.__h = { resolveScitigerBaseUrl, LOCAL_BRIDGE_URL }`, sandbox)
  return sandbox.__h
}

test('launcher points the voiceover channel at the local bridge when one is running', async () => {
  const calls = []
  const { resolveScitigerBaseUrl, LOCAL_BRIDGE_URL } = await loadResolveScitigerBaseUrl(async (url) => {
    calls.push(String(url))
    return { ok: true }
  })
  assert.equal(await resolveScitigerBaseUrl({}), LOCAL_BRIDGE_URL)
  assert.deepEqual(calls, [`${LOCAL_BRIDGE_URL}/health`])
  // 显式配置永远优先，探测只是兜底。
  assert.equal(await resolveScitigerBaseUrl({ LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://example.test' }), 'https://example.test')
  assert.equal(await resolveScitigerBaseUrl({ SCITIGER_BASE_URL: 'https://fallback.test' }), 'https://fallback.test')
})

test('launcher leaves the channel unset when no bridge answers', async () => {
  const unreachable = await loadResolveScitigerBaseUrl(async () => { throw new Error('ECONNREFUSED') })
  assert.equal(await unreachable.resolveScitigerBaseUrl({}), undefined)
  const unhealthy = await loadResolveScitigerBaseUrl(async () => ({ ok: false }))
  assert.equal(await unhealthy.resolveScitigerBaseUrl({}), undefined)
  // 空字符串与未设置同义，不能把渠道钉在一个空地址上。
  const blank = await loadResolveScitigerBaseUrl(async () => ({ ok: true }))
  assert.equal(await blank.resolveScitigerBaseUrl({ LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: '   ' }), blank.LOCAL_BRIDGE_URL)
})

test('the media bridge keeps ffmpeg scratch files off the system drive', async (t) => {
  // bridge.mjs 位于工作台根目录下的「本地媒体桥接」，不在 lifafa-workbench-main 内，
  // 标准版交付包不包含它。缺失时跳过而不是让整条测试报 ENOENT——否则客户从仓库
  // 拉下代码跑 npm test，会看到一个与他的代码无关的失败（2026-10-09 实测）。
  const bridgePath = fileURLToPath(new URL('../../../../本地媒体桥接/bridge.mjs', import.meta.url))
  if (!existsSync(bridgePath)) {
    t.skip('本地媒体桥接未随包交付（标准版）')
    return
  }
  const bridge = await readFile(bridgePath, 'utf8')
  // 重定向必须发生在第一个 ffmpeg 调用之前，否则设置不生效。
  const redirectAt = bridge.indexOf('process.env.TEMP = scratch')
  const firstFfmpegAt = bridge.indexOf("execFile('ffmpeg'")
  assert.ok(redirectAt > 0, 'bridge must redirect TEMP')
  assert.ok(firstFfmpegAt > redirectAt, 'bridge must redirect TEMP before invoking ffmpeg')
  assert.match(bridge, /if \(!process\.env\.LWB_TEMP_DIR\)/u)
})
