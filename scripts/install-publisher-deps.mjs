import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACK_DIR = join(ROOT, 'lwb', 'packs', 'publisher')
const STAGING = join(ROOT, '.tmp', 'publisher-deps')

/**
 * Run npm through its JS entry point rather than the .cmd shim: Node 24
 * refuses to spawn .cmd files without a shell (CVE-2024-27980), and using a
 * shell here would mean quoting user-controlled paths into a command line.
 */
async function runNpm(args, options) {
  const npmEntry = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate))
  if (npmEntry) return execFileAsync(process.execPath, [npmEntry, ...args], options)
  return execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, shell: process.platform === 'win32' })
}

/**
 * Install the publisher pack's browser dependency.
 *
 * The pack declares its DSH peers as `workspace:*`, which the host resolves by
 * symlinking into the profile's node_modules — so a plain `npm install` inside
 * the pack fails on those peer specs. Playwright is the one dependency that is
 * a real npm package, so it is installed in a clean staging directory and then
 * copied into the pack's own node_modules.
 */
async function main() {
  const version = process.env.LWB_PUBLISHER_PLAYWRIGHT_VERSION || '^1.63.0'
  const target = join(PACK_DIR, 'node_modules', 'playwright-core')
  if (existsSync(join(target, 'package.json'))) {
    const installed = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    console.log(`[publisher] playwright-core ${installed.version} 已安装，跳过。`)
    return
  }
  await rm(STAGING, { recursive: true, force: true })
  await mkdir(STAGING, { recursive: true })
  await writeFile(join(STAGING, 'package.json'), `${JSON.stringify({ name: 'publisher-deps', private: true, version: '0.0.0' }, null, 2)}\n`)
  console.log(`[publisher] 正在安装 playwright-core ${version} …`)
  try {
    await runNpm(['install', `playwright-core@${version}`, '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: STAGING,
      env: { ...process.env, npm_config_cache: process.env.npm_config_cache || join(ROOT, '.tmp', 'npm-cache') },
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    console.error('[publisher] 安装失败：', error?.stderr || error?.message || error)
    process.exitCode = 1
    return
  }
  await mkdir(dirname(target), { recursive: true })
  await cp(join(STAGING, 'node_modules', 'playwright-core'), target, { recursive: true })
  await rm(STAGING, { recursive: true, force: true })
  const installed = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  console.log(`[publisher] 已安装 playwright-core ${installed.version}。`)
  console.log('[publisher] 未下载浏览器：本包使用本机已安装的 Chrome / Edge。')
}

main().catch((error) => {
  console.error('[publisher] 安装脚本异常：', error)
  process.exitCode = 1
})
