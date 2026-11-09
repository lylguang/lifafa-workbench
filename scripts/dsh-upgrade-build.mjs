/**
 * 一次性脚本：按 docs/08-base-lock.md 的升级规程，在 vendor 里安装并构建 DSH。
 *
 * 关键点：上游 scripts/build.ts → build:lib → `pnpm run build:lib:host` 会再 spawn
 * `pnpm`，子进程只看 PATH。这里复用 scripts/pnpm-shim.mjs 的垫片，
 * 让嵌套 spawn 能找到 pnpm（Windows 上 corepack.cmd 拿不到退出码的老问题）。
 *
 * 「首次获取并构建上游」用 `npm run setup`（scripts/setup-upstream.mjs）；
 * 本脚本只负责「已在 vendor 上、已切到目标 commit」的重复安装/构建。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPnpm } from './pnpm-shim.mjs'
import { compareVendorHead } from './vendor-lock.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor', 'deepseek-harness')

const steps = process.argv.slice(2)
if (steps.length === 0) {
  console.error('usage: node scripts/dsh-upgrade-build.mjs <install|install-nofreeze|build>')
  process.exit(2)
}

// 构建前核对 vendor HEAD 与锁定文件是否一致：构建错基座比构建失败更难查。
// 校验逻辑放在 scripts/vendor-lock.mjs，setup-upstream.mjs 与本脚本共用一份。
const { expected, actual, matched } = compareVendorHead(root, vendor)
if (actual !== undefined && !matched) {
  console.error(`\n=== [dsh-upgrade] FAILED: vendor HEAD ${actual} != lwb/UPSTREAM.lock.json commit ${expected}`)
  console.error('=== [dsh-upgrade] 先把 vendor checkout 到锁定的 commit，再构建。')
  process.exit(1)
}
console.log(`=== [dsh-upgrade] vendor HEAD ${actual ?? '(未解析)'} / locked ${expected}`)

try {
  for (const step of steps) {
    if (step === 'install') {
      const code = await runPnpm(vendor, ['install', '--frozen-lockfile'], 'dsh-upgrade')
      if (code !== 0) throw new Error(`install failed with exit code ${code}`)
    } else if (step === 'install-nofreeze') {
      const code = await runPnpm(vendor, ['install'], 'dsh-upgrade')
      if (code !== 0) throw new Error(`install failed with exit code ${code}`)
    } else if (step === 'build') {
      const code = await runPnpm(vendor, ['run', 'build'], 'dsh-upgrade')
      if (code !== 0) throw new Error(`build failed with exit code ${code}`)
    } else throw new Error(`unknown step: ${step}`)
  }
  console.log('\n=== [dsh-upgrade] done')
} catch (error) {
  console.error(`\n=== [dsh-upgrade] FAILED: ${error.message}`)
  process.exit(1)
}
