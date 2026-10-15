/**
 * 开工前体检（runtime preflight）。
 *
 * 2026-10 的审计里，33 轮失败中有 16 轮的根因是外部依赖不可用：API Key 过期
 * （7 轮）、本地引擎没起来（4 轮）、引擎路径指向已删除的目录。而这些全部是在
 * 流水线第 5 个阶段才暴露——前面 20 多分钟的选题、写稿、配音已经烧掉了。
 *
 * 这个模块把「能不能开工」的判断提前到第一秒。它不新增任何依赖，只使用已经
 * 在进程里可用的东西：media/publish host 自己的 status、一次真实的 HTTP 探测、
 * 以及 os 模块。检查项全部失败也不抛错，而是返回结构化报告，由调用方决定是
 * 自动修复、阻断、还是放行。
 *
 * 为什么不做「最小合成请求」那种真实凭据探测：那会消耗配额、每次开工多花数秒，
 * 而且 429 会被误判成密钥失效。这里的判据是「配置上有没有凭据」加「本地服务在不在」，
 * 已经能覆盖历史故障的绝大部分；真正的凭据失效仍由 classifyFailure 在阶段内
 * 捕获并给出明确修法。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BRIDGE = 'http://127.0.0.1:8199'
/** 本地模型合成（Local LongCat）实测要 23 GB 空闲，12 GB 是保守下限。 */
const LOCAL_MODEL_MEMORY_FLOOR_MIB = 12_000
/** 走云端配音时不需要大内存，只挡真正会崩的极端情况。 */
const CLOUD_MEMORY_FLOOR_MIB = 2_000

/**
 * 本轮是否真的要跑本地模型。
 *
 * 桥接的 `local` 通道才是本地合成；`scitiger` 走的是桥接的云端转发（小米/百炼），
 * 内存占用和纯云端没区别。把这两者混为一谈会让预检在不该拦的时候拦下整轮
 * ——2026-10-09 实测：机器空闲 9.8 GB，走云端配音却被 12 GB 门槛挡成 blocked。
 */
function providerUsesLocalModel(mediaStatus) {
  const provider = mediaStatus?.connection?.provider || ''
  const bridge = mediaStatus?.connection?.providers?.[provider]?.bridge
  if (bridge === 'local' || bridge === 'localLongCat') return true
  // 媒体 host 自己会声明本地通道；拿不到就按「不需要本地模型」处理。
  return mediaStatus?.localModelRequired === true
}

function bridgeBase(environment = process.env) {
  const configured = environment.LWB_MEDIA_BRIDGE_URL
  return (configured || DEFAULT_BRIDGE).replace(/\/+$/u, '')
}

/**
 * 桥接自愈：本地媒体桥接（8199）本身不可达时，把它拉回来。
 *
 * 为什么必须单独有这一个函数：ensureLocalEngine 在桥接不通时会直接返回
 * `{ ok:false, reason:'bridge-unreachable' }`（见下），因为它自己也没有能力救桥接——
 * 桥接是那个「负责拉起引擎的上一层」。2026-10-10 18:13 那次真实故障就是死在这里：
 * 8199 整个进程没了，#autoRepair 拿着 ensureEngine 反复去拉 8188 引擎，三次全废，
 * 而故障建议还写着「请打开 127.0.0.1:8199 点一键启动」——那个端口当时根本是死的，
 * 这条建议在当场无法执行。
 *
 * 现在把预检里已有的 /admin/launch 逻辑下沉到这里，让「运行中撞上桥接掉线」也有
 * 修复动作。返回 ok 后调用方再照常走 ensureLocalEngine 拉引擎。
 *
 * 2026-10-10 实测补的一环：`/admin/launch` 只能叫醒「已经活着但没引擎」的桥接。
 * 桥接整个进程不在时，那个 HTTP 接口根本无人应答——实测 kill 掉 8199 之后
 * 这里空等满 60 秒仍然 fetch failed。真正能把进程拉回来的是自己 spawn 一个
 * `node bridge.mjs`（保活脚本 lwb-keepalive.ps1 做的也是同一件事），所以两条路
 * 都试：先问接口（便宜），不通再自己起进程（贵但兜底）。
 */
export async function ensureLocalBridge({ timeoutMs = 90_000, environment = process.env, signal = null, spawnBridge = spawnBridgeProcess } = {}) {
  const base = bridgeBase(environment)
  const before = await probeJson(`${base}/health`)
  if (before.ok) return { ok: true, reason: 'already-up' }
  // 第一条路：请还活着的桥接自己去拉引擎。桥接已死时这步必然失败，无害。
  const launched = await postJson(`${base}/admin/launch`, 8000)
  if (await waitForBridge(base, Math.min(8000, timeoutMs), signal)) {
    return { ok: true, reason: launched.ok ? 'launched' : 'recovered' }
  }
  // 第二条路：桥接进程本身没了，自己起一个。目录解析与保活脚本一致
  // （LWB_BRIDGE_DIR → <repo>/media-bridge），找不到就如实报出来，不假装成功。
  const spawned = await spawnBridge({ environment, signal }).catch((error) => ({ ok: false, detail: String(error?.message || error) }))
  if (!spawned?.ok) {
    return {
      ok: false,
      reason: 'bridge-launch-failed',
      detail: `桥接不可达且无法拉起：${spawned?.detail || '未知原因'}（目录：${spawned?.dir || bridgeDir(environment)}）`,
    }
  }
  const recovered = await waitForBridge(base, timeoutMs, signal)
  return recovered
    ? { ok: true, reason: 'spawned' }
    : { ok: false, reason: 'bridge-launch-failed', detail: `已启动桥接进程，但它在 ${Math.round(timeoutMs / 1000)} 秒内没有响应 /health` }
}

/** 轮询 /health 直到桥接应答。返回 false 表示这段时间内一直没起来。 */
async function waitForBridge(base, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    if ((await probeJson(`${base}/health`)).ok) return true
    await sleep(2000)
  }
  return (await probeJson(`${base}/health`)).ok
}

/** 桥接脚本所在目录。解析顺序与保活脚本 lwb-keepalive.ps1 一致。 */
function bridgeDir(environment = process.env) {
  const configured = environment.LWB_BRIDGE_DIR
  if (configured) return configured
  // 包在 <repo>/lwb/packs/spoken-video/，桥接在 <repo>/media-bridge/，上溯两层。
  const here = fileURLToPath(new URL('.', import.meta.url))
  return resolve(here, '..', '..', '..', 'media-bridge')
}

/**
 * 直接起一个桥接进程。detached + unref 让它独立于工作台活着——否则工作台重启
 * 会连带杀掉刚拉起来的桥接，等于白救。
 */
async function spawnBridgeProcess({ environment = process.env, signal = null } = {}) {
  const dir = bridgeDir(environment)
  const script = resolve(dir, 'bridge.mjs')
  if (!existsSync(script)) return { ok: false, dir, detail: '目录下没有 bridge.mjs' }
  const child = spawn(process.execPath, [script], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...environment },
  })
  child.unref()
  return { ok: true, dir, pid: child.pid }
}

async function probeJson(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    return { ok: true, body: await response.json() }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? '探测超时' : String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

async function postJson(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'POST', signal: controller.signal })
    return { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? '启动超时' : String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ok(key, label, detail = '') {
  return { key, label, status: 'ok', detail, remedy: null, remedyTarget: null }
}

function blocked(key, label, detail, remedy, remedyTarget = null) {
  return { key, label, status: 'blocked', detail, remedy, remedyTarget }
}

function degraded(key, label, detail, remedy) {
  return { key, label, status: 'degraded', detail, remedy, remedyTarget: null }
}

/**
 * 引擎自愈：桥接在线但引擎不可达时尝试拉起，并轮询等待它真正可用。
 *
 * 等待预算与 bridge.mjs 的 ENGINE_BOOT_TIMEOUT_MS（180 秒）保持一致：本地模型
 * 从冷启动到可用真的要那么久，早于它判定失败只会造成反复拉起的假象。
 */
export async function ensureLocalEngine(kind, { reason = '', timeoutMs = 180_000, environment = process.env } = {}) {
  const base = bridgeBase(environment)
  const before = await probeJson(`${base}/admin/engines`)
  if (!before.ok) return { ok: false, reason: 'bridge-unreachable', detail: before.error }
  const engine = (before.body?.engines || []).find((item) => item.kind === kind)
  if (engine?.reachable) return { ok: true, reason: 'already-up' }
  if (engine?.starting) {
    // 已经在启动中：只等，不重复拉起（重复 spawn 会占满显存）。
    const waited = await waitForEngine(base, kind, timeoutMs)
    if (waited.ok) return { ok: true, reason: 'waited' }
  }
  const launched = await postJson(`${base}/admin/engines/${kind}/launch`)
  if (!launched.ok && launched.status !== 409) {
    return { ok: false, reason: 'launch-failed', detail: launched.error }
  }
  const waited = await waitForEngine(base, kind, timeoutMs)
  return waited.ok ? { ok: true, reason: 'launched' } : { ok: false, reason: 'timeout', detail: waited.detail }
}

async function waitForEngine(base, kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await probeJson(`${base}/admin/engines`)
    if (probe.ok) {
      const engine = (probe.body?.engines || []).find((item) => item.kind === kind)
      if (engine?.reachable) return { ok: true }
      // 显存/内存不够时引擎可能永久起不来，继续等只是浪费时间。
      if (engine && engine.lastError && !engine.starting) {
        const blockedByResources = /(内存|显存|memory|VRAM)/iu.test(String(engine.lastError))
        if (blockedByResources) return { ok: false, detail: String(engine.lastError) }
      }
    }
    if (Date.now() > deadline) return { ok: false, detail: '等待引擎就绪超时' }
    await sleep(3000)
  }
}

/**
 * 跑一遍体检。
 *
 * @param {object} options
 * @param {string[]} options.steps      本轮将要走的阶段，决定哪些检查是必要的
 * @param {object} options.mediaStatus  media host 的 status() 结果（可选，缺省则跳过相关检查）
 * @param {object} options.publishStatus publish host 的 status() 结果
 * @param {Function} [options.ensureEngine] 注入的引擎拉起函数，测试用
 * @returns {Promise<{ok: boolean, checks: object[], blockers: object[], repaired: string[]}>}
 */
export async function runPreflight({ steps = [], mediaStatus = null, publishStatus = null, ensureEngine = ensureLocalEngine, environment = process.env } = {}) {
  const checks = []
  const repaired = []
  const wantsMedia = steps.some((step) => ['voiceover', 'subtitles', 'video'].includes(step))
  const wantsCover = steps.includes('packaging') || steps.includes('publish')

  // --- 本地桥接 ---
  const base = bridgeBase(environment)
  const health = await probeJson(`${base}/health`)
  if (!health.ok) {
    // 桥接不在：这是唯一「先修再判」的一项，保活脚本会在 5 分钟内拉起它，
    // 这里主动拉一次，避免整轮白等。
    checks.push(degraded('bridge.reachable', '本地媒体桥接', `桥接不可达（${health.error}），正在尝试拉起`, '正在自动拉起本地媒体桥接'))
    const relaunched = await postJson(`${base}/admin/launch`)
    await sleep(3000)
    if (relaunched.ok || (await probeJson(`${base}/health`)).ok) {
      repaired.push('bridge.reachable')
      checks[checks.length - 1] = ok('bridge.reachable', '本地媒体桥接', '桥接已自动拉起')
    } else {
      // 桥接拉不起来不算硬阻断：云端配音（百炼/小米）不需要本地桥接。
      //
      // 2026-10-10 18:13：桥接整个进程没起来时，这里让人「打开 8199 点一键启动」，
      // 而那个端口当时就是死的——建议在当场根本执行不了。桥接自己不可达时，
      // 唯一能做的动作是在别处把它拉起来，所以指向保活计划任务与桥接目录。
      const provider = mediaStatus?.connection?.provider || ''
      const cloudOnly = ['bailian', 'mimo'].includes(provider)
      const manual = '桥接自动拉起失败。请确认计划任务 LWBKeepAlive 处于「就绪」状态（它每 5 分钟会把桥接拉回来），或手工运行 E:\\lifa-scratch\\lwb-keepalive.ps1；确认无误后本任务可重试。'
      checks.push(cloudOnly
        ? degraded('bridge.reachable', '本地媒体桥接', `桥接不可达（${health.error}），但当前走云端配音，不阻断`, `${manual}如需本地配音还需先恢复桥接。`)
        : blocked('bridge.reachable', '本地媒体桥接', `桥接不可达（${health.error}），自动拉起也未成功`, `${manual}临时可把配音服务切到云端继续出片。`))
    }
  } else {
    checks.push(ok('bridge.reachable', '本地媒体桥接', health.body?.service || '在线'))
  }

  // --- 本地引擎（仅当本轮真的要用本地推理）---
  if (wantsMedia && health.ok || (wantsMedia && checks[0]?.status === 'ok')) {
    for (const [kind, label] of [['tts', '字幕/配音引擎（8188）'], ['image', '封面生图引擎（8187）']]) {
      if (kind === 'image' && !wantsCover) continue
      const result = await probeJson(`${base}/admin/engines`)
      const engine = result.ok ? (result.body?.engines || []).find((item) => item.kind === kind) : null
      if (engine?.reachable) {
        checks.push(ok(`engine.${kind}`, label, '运行中'))
        continue
      }
      // 引擎不在线：本地配音确实需要它，所以尝试拉起；封面引擎起不来时，
      // packaging 会记 coverState=none 并提示人工上传，不阻断整轮。
      const fixed = await ensureEngine(kind, { environment }).catch(() => ({ ok: false }))
      if (fixed.ok) {
        repaired.push(`engine.${kind}`)
        checks.push(ok(`engine.${kind}`, label, `已自动拉起（${fixed.reason}）`))
      } else if (kind === 'image') {
        checks.push(degraded(`engine.${kind}`, label, `未运行且自动拉起失败：${fixed.detail || '未知原因'}`, '封面可人工上传；如需自动生成请打开桥接配置中心点「一键启动」'))
      } else {
        checks.push(blocked(`engine.${kind}`, label, `未运行且自动拉起失败：${fixed.detail || '未知原因'}`, '请打开桥接配置中心 http://127.0.0.1:8199/ 点「一键启动」。注意 16G 显卡上生图与配音不能同时驻留。'))
      }
    }
  }

  // --- 云端凭据（只判配置，不消耗配额）---
  if (wantsMedia && mediaStatus) {
    const provider = mediaStatus.connection?.provider || 'bailian'
    const configured = mediaStatus.connection?.providers?.[provider]?.configured === true
    const ttsReady = mediaStatus.ttsConfigured === true
    const localBridge = provider === 'scitiger'
    if (localBridge) {
      checks.push(configured || ttsReady
        ? ok('tts.credential', '配音服务', '本机桥接')
        : blocked('tts.credential', '配音服务', '本机桥接未连接', '请打开桥接配置中心完成引擎启动'))
    } else if (configured && ttsReady) {
      checks.push(ok('tts.credential', '配音服务', `${provider} 凭据已配置`))
    } else if (!configured) {
      checks.push(blocked('tts.credential', '配音服务', `${provider} 未配置 API Key`, '请到「连接配置」填写该服务的 API Key，或把配音服务切换到本机桥接', 'media-connection'))
    } else {
      checks.push(blocked('tts.credential', '配音服务', `${provider} 已配置但服务未就绪`, '请到「连接配置」检查该服务是否可用，或切换到其它配音通道', 'media-connection'))
    }
  }

  // --- 封面生图服务 ---
  // 只在「确实读到状态且明确未配置」时才阻断。读不到状态（服务未加载、探测失败）
  // 只能提示不能拦：把「不知道」当成「坏了」，会在依赖探测本身出问题的环境里
  // 拦下所有轮次——那比不做预检更糟。真正的缺失会在 packaging 阶段以
  // coverState=none 呈现，提示人工上传，流程仍然走完。
  if (wantsCover) {
    if (!publishStatus) {
      checks.push(degraded('image.credential', '封面生图服务', '未能读取封面生图服务状态（不阻断）', '如需自动生成封面，请确认「发布与账号管理」能力包已加载并完成配置'))
    } else {
      checks.push(publishStatus.configured === true
        ? ok('image.credential', '封面生图服务', '已配置')
        : blocked('image.credential', '封面生图服务', '未配置封面生图服务', '请到「连接配置」配置生图服务；未配置时封面需人工上传，任务仍会继续', 'media-connection'))
    }
  }

  // --- 内存 ---
  // 门槛按「本轮真的要跑本地推理」来定，不是无条件卡。
  //
  // 2026-10-09 踩过：机器上空闲 9.8 GB，被 12 GB 的固定门槛拦成 blocked，可这一轮
  // 走的是云端配音，根本不需要那 23 GB。本地合成才是内存大户（Local LongCat
  // 实测要 23 GB 空闲），所以只有它才配得上这道门槛。
  const localModelNeeded = wantsMedia && providerUsesLocalModel(mediaStatus)
  let freeMiB = null
  try {
    const { freemem } = await import('node:os')
    freeMiB = Math.round(freemem() / 1024 / 1024)
  } catch { /* 拿不到就跳过这项检查 */ }
  if (freeMiB !== null) {
    const floor = Number(environment.LWB_PREFLIGHT_MEMORY_FLOOR_MIB)
      || (localModelNeeded ? LOCAL_MODEL_MEMORY_FLOOR_MIB : CLOUD_MEMORY_FLOOR_MIB)
    checks.push(freeMiB >= floor
      ? ok('resources.memory', '可用内存', `${freeMiB} MB`)
      : blocked('resources.memory', '可用内存', `仅剩 ${freeMiB} MB，低于 ${floor} MB 门槛${localModelNeeded ? '（本地模型合成需要较大内存）' : ''}`,
        localModelNeeded
          ? '请关闭占内存的程序（浏览器、剪辑软件等）后重试；本地合成需要约 23 GB 空闲内存，或把配音服务切换到云端。'
          : '请关闭占内存的程序后重试。'))
  }

  // --- 磁盘 ---
  try {
    const { statfs } = await import('node:fs/promises')
    const stats = await statfs(environment.LWB_PREFLIGHT_DISK_PATH || process.cwd())
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    const floor = Number(environment.LWB_PREFLIGHT_DISK_FLOOR_GB || 20) * 1024 ** 3
    checks.push(freeBytes >= floor
      ? ok('resources.disk', '工作盘剩余空间', `${(freeBytes / 1024 ** 3).toFixed(1)} GB`)
      : blocked('resources.disk', '工作盘剩余空间', `仅剩 ${(freeBytes / 1024 ** 3).toFixed(1)} GB，低于 ${floor / 1024 ** 3} GB 门槛`, '渲染中间产物与成片需要较大空间，请清理磁盘后重试'))
  } catch { /* 拿不到就跳过这项检查 */ }

  const blockers = checks.filter((check) => check.status === 'blocked')
  return {
    ok: blockers.length === 0,
    checks,
    blockers,
    repaired,
  }
}

/** 体检报告压成一行人能读的话，用于 blocked 记录的 error 字段。 */
export function preflightSummary(report) {
  if (report.ok) return '开工前体检通过。'
  const first = report.blockers[0]
  return `${first.label}：${first.detail}。${first.remedy}`
}