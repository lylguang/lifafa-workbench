/**
 * 首次获取并构建上游 DSH 基座：`npm run setup` 的入口。
 *
 * 职责：克隆 → fetch → checkout 锁定 commit → 安装依赖 → 构建。
 *
 * 为什么 install / build 不直接 spawn `corepack`：
 *   - Windows 上 `corepack` 是无扩展名的 shell 脚本 + `corepack.cmd`，Node 的
 *     `shell:false` spawn 两者都认不出来，实测直接 ENOENT——`npm run setup`
 *     在开发机上就是坏的。
 *   - 上游 `pnpm run build` 内部还会再 spawn `pnpm`（scripts/build.ts →
 *     build:lib → `pnpm run build:lib:host`），子进程只看 PATH。
 *   两者都由 scripts/pnpm-shim.mjs 的 corepackEntry() + pnpmShimEnv() 解决，
 *   与 scripts/dsh-upgrade-build.mjs 用的是同一套机制。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPnpm } from './pnpm-shim.mjs'
import { compareVendorHead } from './vendor-lock.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor', 'deepseek-harness')
const lock = JSON.parse(await readFile(join(root, 'lwb', 'UPSTREAM.lock.json'), 'utf8'))

const run = (cmd, args, cwd = root) => new Promise((resolveRun, reject) => {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${cmd} exited with code ${code}`)))
})

if (!existsSync(vendor)) {
  await mkdir(join(root, 'vendor'), { recursive: true })
  // 不能加 --depth：上游有 4000+ 提交，浅克隆拿不到锁定 commit 的历史，
  // checkout 到一个不在浅层里的 sha 会直接失败。
  await run('git', ['clone', lock.repository, vendor])
}
await run('git', ['-C', vendor, 'fetch', '--tags', '--force', 'origin'])
await run('git', ['-C', vendor, 'checkout', '--detach', lock.commit])

// checkout 之后再核对一次：clone/fetch/checkout 三步之后 vendor 才真的停在
// 锁定 commit 上，此前 HEAD 可能还是上一次 checkout 留下的任意 sha。
// 「构建错基座」比「构建失败」更难查——依赖装的是旧 commit，源码跑的是新
// commit，产物看着正常、运行时才炸。所以不一致就直接退出。
const { expected, actual, matched } = compareVendorHead(root, vendor)
if (!matched) {
  console.error(`\n=== [setup-upstream] FAILED: vendor HEAD ${actual ?? '(未解析)'} != lwb/UPSTREAM.lock.json commit ${expected}`)
  console.error('=== [setup-upstream] 先把 vendor checkout 到锁定的 commit，再安装构建。')
  process.exit(1)
}
console.log(`=== [setup-upstream] vendor HEAD ${actual} / locked ${expected}`)

const installCode = await runPnpm(vendor, ['install', '--frozen-lockfile'], 'setup-upstream')
if (installCode !== 0) {
  console.error(`\n=== [setup-upstream] FAILED: install exited with code ${installCode}`)
  process.exit(installCode)
}
const buildCode = await runPnpm(vendor, ['run', 'build'], 'setup-upstream')
if (buildCode !== 0) {
  console.error(`\n=== [setup-upstream] FAILED: build exited with code ${buildCode}`)
  process.exit(buildCode)
}
console.log(`DeepSeek Harness ${lock.commit} is ready.`)
