#!/usr/bin/env node
/**
 * 交付包首次运行：重建依赖与符号链接。
 *
 * zip 存不了 symlink 与 junction，所以压缩时把它们全部跳过了（跟链接走会撞上
 * pnpm 的 .pnpm 环，实测递归 20 分钟不收敛）。解压后的包缺两样东西：
 *
 *   1. vendor 的 pnpm workspace 链接 → 用 lockfile 跑一次 pnpm install 重建
 *   2. 各能力包 node_modules/@deepseek-ai 下的 junction → npm run pack:link
 *
 * 两者都很快（实测 pnpm 25s、link 0.1s）。已构建的产物（apps/cli/lib 等）
 * 都在包里，不用重新 build。
 *
 * 幂等：已经就绪时什么都不做，可以反复运行。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'vendor', 'deepseek-harness')

function corepackEntry() {
  const nodeDir = dirname(process.execPath)
  const candidates = [
    join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  return found ? { command: process.execPath, prefix: [found] } : { command: 'corepack', prefix: [] }
}

function run(command, args, cwd, label) {
  const started = Date.now()
  process.stdout.write(`[..] ${label}\n`)
  // CI=true 让 pnpm 敢在无 TTY 下清空 node_modules：交付包里那份被 zip 拆散过
  // （符号链接全丢），不重装就是错的。不设的话 pnpm 中止并要人按 y——实测报
  // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY。
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, CI: 'true' },
  })
  if (result.status !== 0) {
    process.stderr.write(`\n[ERR] ${label} 失败。请检查网络（国内应走交付包内置的 .npmrc 镜像）。\n`)
    process.exit(1)
  }
  process.stdout.write(`[ok] ${label}（${((Date.now() - started) / 1000).toFixed(1)}s）\n`)
}

/** vendor 的 workspace 链接是否还在（解压跳过了它们）。 */
function vendorLinksIntact() {
  // 任取一个 pnpm workspace 链接作为探针：apps/cli 依赖 app-boot。
  const probe = join(VENDOR, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  if (!existsSync(join(probe, 'package.json'))) return false
  // 内容在不代表链接在；实体目录说明它被解压展开了。
  try {
    const stats = lstatSync(probe)
    // 真链接（symlink 或 junction）都算就绪；实体目录说明被解压展开了。
    if (stats.isSymbolicLink()) return true
    return ((stats.st_fileAttributes ?? 0) & 0x400) !== 0
  } catch {
    return false
  }
}

function main() {
  if (!existsSync(VENDOR)) {
    process.stderr.write('[ERR] 找不到 vendor 目录，交付包不完整，请重新解压。\n')
    process.exit(1)
  }

  if (vendorLinksIntact()) {
    process.stdout.write('[ok] 上游依赖链接已就绪\n')
  } else {
    const { command, prefix } = corepackEntry()
    run(command, [...prefix, 'pnpm', 'install', '--frozen-lockfile'], VENDOR, '重建上游依赖链接')
    run(command, [...prefix, 'pnpm', 'run', 'build'], VENDOR, '构建上游')
  }

  run(process.execPath, [join(ROOT, 'lwb', 'link-packs.mjs')], ROOT, '建立能力包运行期链接')
  process.stdout.write('\n[ok] 准备完成，可以双击「启动工作台.cmd」。\n')
}

main()
