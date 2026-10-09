import { existsSync, mkdirSync, realpathSync, statfsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// On Windows `fileURLToPath` preserves the drive-letter case used in the URL,
// so a checkout reached via `file:///f:/...` yields `f:\...`. Downstream code
// (pack-workspaces.mjs) compares `realpath(root)` against the configured root,
// and `realpath` always upper-cases the drive letter — a case-only difference
// makes that strict check fail with "The profile-owned root must be canonical.",
// which surfaces as an empty capability-pack sidebar. Canonicalizing here keeps
// every derived path stable no matter how the launcher was invoked.
function canonicalDir(path) {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

const ROOT_DIR = canonicalDir(join(dirname(fileURLToPath(import.meta.url)), '..'))
const DSH_DIR = join(ROOT_DIR, 'vendor', 'deepseek-harness')
const PROFILE_SOURCE_DIR = join(ROOT_DIR, 'lwb', 'profile')
const BUNDLE_DIR = join(ROOT_DIR, 'lwb', 'dsh-bundle')
const LLM_DIR = join(DSH_DIR, 'packages', 'llm', 'llm')
const CORDIS_DIR = join(DSH_DIR, 'vendor', 'cordis')
const TYPERT_PROTOCOL_DIR = join(DSH_DIR, 'packages', 'typert', 'protocol')
// `LWB_DSH_HOME` may be supplied by the caller with a differently-cased drive
// letter; canonicalize it the same way so the pack workspace root check passes.
const DSH_HOME = canonicalDir(process.env.LWB_DSH_HOME || join(ROOT_DIR, 'lwb', 'local', 'dsh-home'))
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'lwb')
const PROFILE_NODE_MODULES = join(PROFILE_DIR, 'node_modules')
const BUNDLE_NODE_MODULES = join(BUNDLE_DIR, 'node_modules')
const BUILT_CLI_ENTRY = join(DSH_DIR, 'apps', 'cli', 'lib', 'bin.js')
const SOURCE_CLI_ENTRY = join(DSH_DIR, 'apps', 'cli', 'src', 'bin.ts')
const TSX_LOADER = join(DSH_DIR, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')

// 渲染要写大量临时数据（Remotion 的 webpack bundle、每次渲染一个 Chromium
// profile、渲染工作区），系统盘满了会以 ENOSPC 失败。临时目录因此必须挑一个
// 空闲盘——写死盘符的机器上没有那个盘，客户机直接起不来。
//
// 选盘顺序：非系统盘中可用空间最大者（低于阈值的跳过：渲染中途写满比慢更
// 糟）> 系统盘下的 %LOCALAPPDATA%。LWB_SCRATCH_ROOT 可显式指定根目录。
const SCRATCH_DIR_NAME = 'lifa-scratch'
const SCRATCH_MIN_FREE_GB = 20

function freeBytesOn(root) {
  try {
    // Windows 上按根路径查询返回该卷的可用空间。
    const stats = statfsSync(root, { bigint: true })
    return Number(stats.bavail * stats.bsize)
  } catch {
    return null
  }
}

/**
 * Whether a TEMP/TMP value already points off the system drive.
 *
 * Deliberately a string test rather than a path comparison: TEMP is always a
 * drive-rooted Windows path here, and resolving it costs correctness on
 * non-Windows hosts (where `resolve('C:\\...')` is not a drive path at all).
 */
function isScratchOffSystemDrive(env) {
  const current = env.TEMP || env.TMP || ''
  if (!current) return false
  const systemDrive = (env.SystemDrive || 'C:').toLowerCase().replace(/\\?$/u, '')
  const normalized = current.replace(/\//gu, '\\').toLowerCase()
  const root = `${systemDrive}\\`
  return normalized !== systemDrive && !normalized.startsWith(root)
}

function resolveScratchRoot(env) {
  if (env.LWB_SCRATCH_ROOT) return env.LWB_SCRATCH_ROOT.replace(/[\\/]+$/u, '')
  const systemDrive = (env.SystemDrive || 'C:').toLowerCase()
  const minFree = SCRATCH_MIN_FREE_GB * 1024 ** 3
  const viable = []
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (root.toLowerCase() === `${systemDrive}\\`) continue
    if (!existsSync(root)) continue
    const free = freeBytesOn(root)
    if (free === null || free < minFree) continue
    viable.push({ root, free })
  }
  if (viable.length) {
    viable.sort((a, b) => b.free - a.free)
    return `${viable[0].root}${SCRATCH_DIR_NAME}`
  }
  // 没有非系统盘（或都放不下 20G）：退回系统盘的本地应用数据目录。
  const fallback = env.LOCALAPPDATA || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : null)
  return fallback ? join(fallback, SCRATCH_DIR_NAME) : join(ROOT_DIR, SCRATCH_DIR_NAME)
}


/**
 * Keep scratch files on a roomy drive instead of the system drive.
 *
 * Video rendering writes a lot of temporary data — Remotion's webpack bundle,
 * a Chromium profile per render, and the render workspace — all of which follow
 * TEMP/TMP. On a machine whose system drive is nearly full, a single render can
 * exhaust it and fail with ENOSPC. Redirecting TEMP/TMP here means `npm run dev`
 * and `npm start` are safe no matter how they were launched, not just when the
 * start script is used.
 *
 * The drive is picked at run time (see `resolveScratchRoot`) instead of being
 * hardcoded, because a customer machine has no reason to have our E: drive.
 *
 * Respects an explicit override and never overrides a TEMP the caller already
 * pointed at a non-system drive.
 */
function applyTempRedirect(env) {
  if (env.LWB_TEMP_DIR) return env
  // Already redirected off the system drive by the caller: leave it alone.
  if (isScratchOffSystemDrive(env)) return env
  const target = join(resolveScratchRoot(env), 'temp')
  try {
    mkdirSync(target, { recursive: true })
  } catch {
    // A read-only checkout must not stop the workbench from starting.
    return env
  }
  return { ...env, TEMP: target, TMP: target, LWB_TEMP_DIR: target }
}

async function ensureSymlink(linkPath, target) {
  await mkdir(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath)) {
    const stats = await lstat(linkPath)
    if (!stats.isSymbolicLink()) throw new Error(`LWB profile path is not a symlink: ${linkPath}`)
    if (resolve(dirname(linkPath), await readlink(linkPath)) === resolve(target)) return
    await unlink(linkPath)
  }
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

const LOCAL_BRIDGE_URL = 'http://127.0.0.1:8199'

/**
 * Point the SciTiger channel at this machine's media bridge.
 *
 * Without this the channel falls back to the real cloud endpoint, where the
 * locally saved key does not exist — every voiceover then fails with
 * "Invalid API key" even though the bridge is running and healthy. `启动工作台.cmd`
 * sets the variable, but `npm run dev` (and every other entry point) does not,
 * which made the failure depend on how the workbench happened to be started.
 * Probing the bridge keeps the channel correct no matter how it was launched;
 * an explicit operator override always wins.
 */
async function resolveScitigerBaseUrl(env) {
  const configured = env.LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL || env.SCITIGER_BASE_URL
  if (configured && configured.trim()) return configured
  try {
    const response = await fetch(`${LOCAL_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    if (response.ok) return LOCAL_BRIDGE_URL
  } catch {
    // Bridge not running: leave the variable unset so the media host reports
    // the real cause instead of an unreachable loopback address.
  }
  return undefined
}

async function syncProfile() {
  if (!existsSync(DSH_DIR)) throw new Error(`Missing vendored DSH checkout: ${DSH_DIR}`)
  if (!existsSync(BUILT_CLI_ENTRY) && (!existsSync(SOURCE_CLI_ENTRY) || !existsSync(TSX_LOADER))) {
    throw new Error('Vendored DSH dependencies are not built/installed; run corepack pnpm install and pnpm run build in vendor/deepseek-harness')
  }

  await mkdir(PROFILE_DIR, { recursive: true })
  await mkdir(PROFILE_NODE_MODULES, { recursive: true })
  const sourceProfile = JSON.parse(await readFile(join(PROFILE_SOURCE_DIR, 'package.json'), 'utf8'))
  const bundles = sourceProfile?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('LWB Profile source must declare dsh.profile.bundles')
  await writeFile(join(PROFILE_DIR, 'package.json'), `${JSON.stringify(sourceProfile, null, 2)}\n`)
  await writeFile(join(PROFILE_DIR, 'cordis.patch.yml'), await readFile(join(PROFILE_SOURCE_DIR, 'cordis.patch.yml')))
  const profileSettingsSource = join(PROFILE_SOURCE_DIR, 'settings.yaml')
  const profileSettingsTarget = join(PROFILE_DIR, 'settings.yaml')
  if (!existsSync(profileSettingsTarget) && existsSync(profileSettingsSource)) {
    await writeFile(profileSettingsTarget, await readFile(profileSettingsSource), { flag: 'wx' })
  }
  const settingsTarget = join(DSH_HOME, 'settings.yaml')
  const settingsSource = join(PROFILE_SOURCE_DIR, 'settings.yaml')
  if (!existsSync(settingsTarget) && existsSync(settingsSource)) {
    await writeFile(settingsTarget, await readFile(settingsSource), { flag: 'wx' })
  }

  await ensureSymlink(join(PROFILE_NODE_MODULES, '@scitiger-ai', 'lwb-dsh-bundle'), BUNDLE_DIR)
  await ensureSymlink(join(BUNDLE_NODE_MODULES, '@deepseek-ai', 'schemastery'), join(DSH_DIR, 'vendor', 'schemastery'))
  await ensureSymlink(join(BUNDLE_NODE_MODULES, '@deepseek-ai', 'dsh-settings'), join(DSH_DIR, 'packages', 'settings', 'settings'))
  await ensureSymlink(join(BUNDLE_NODE_MODULES, '@deepseek-ai', 'dsh-llm'), LLM_DIR)
  await ensureSymlink(join(BUNDLE_NODE_MODULES, '@deepseek-ai', 'cordis'), CORDIS_DIR)
  await ensureSymlink(join(BUNDLE_NODE_MODULES, '@deepseek-ai', 'dsh-typert-protocol'), TYPERT_PROTOCOL_DIR)
}

await syncProfile()

const scitigerBaseUrl = await resolveScitigerBaseUrl(process.env)
if (scitigerBaseUrl) console.log(`[lwb] 配音/字幕渠道 -> ${scitigerBaseUrl}`)

const cliArgs = existsSync(BUILT_CLI_ENTRY)
  ? [BUILT_CLI_ENTRY, '--profile', 'lwb', ...process.argv.slice(2)]
  : ['--import', TSX_LOADER, SOURCE_CLI_ENTRY, '--profile', 'lwb', ...process.argv.slice(2)]
const child = spawn(process.execPath, cliArgs, {
  cwd: ROOT_DIR,
  env: applyTempRedirect({
    ...process.env,
    DSH_HOME,
    ...(scitigerBaseUrl ? { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: scitigerBaseUrl } : {}),
  }),
  stdio: 'inherit',
})

const forwardSignal = (signal) => child.kill(signal)
process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
