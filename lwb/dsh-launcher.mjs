import { existsSync, mkdirSync, realpathSync } from 'node:fs'
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
const DEFAULT_TEMP_DIR = 'E:\lifa-scratch\temp'

/**
 * Keep scratch files on this drive instead of the system drive.
 *
 * Video rendering writes a lot of temporary data — Remotion's webpack bundle,
 * a Chromium profile per render, and the render workspace — all of which follow
 * TEMP/TMP. On a machine whose system drive is nearly full, a single render can
 * exhaust it and fail with ENOSPC. Redirecting TEMP/TMP here means `npm run dev`
 * and `npm start` are safe no matter how they were launched, not just when the
 * start script is used.
 *
 * Respects an explicit override and never overrides a TEMP the caller already
 * pointed at a non-system drive.
 */
function applyTempRedirect(env) {
  if (env.LWB_TEMP_DIR) return env
  const current = env.TEMP || env.TMP || ''
  const systemDrive = (env.SystemDrive || 'C:').toLowerCase()
  // Already redirected off the system drive by the caller: leave it alone.
  if (current && !current.toLowerCase().startsWith(systemDrive)) return env
  const target = DEFAULT_TEMP_DIR
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

const cliArgs = existsSync(BUILT_CLI_ENTRY)
  ? [BUILT_CLI_ENTRY, '--profile', 'lwb', ...process.argv.slice(2)]
  : ['--import', TSX_LOADER, SOURCE_CLI_ENTRY, '--profile', 'lwb', ...process.argv.slice(2)]
const child = spawn(process.execPath, cliArgs, {
  cwd: ROOT_DIR,
  env: applyTempRedirect({ ...process.env, DSH_HOME }),
  stdio: 'inherit',
})

const forwardSignal = (signal) => child.kill(signal)
process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
