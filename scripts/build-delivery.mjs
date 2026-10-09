/**
 * 构建客户交付包。
 *
 * 形态是「预构建离线包」：客户解压即用，不需要自己装 Git / pnpm / 编译环境。
 * 源码从 `git archive` 取，而不是复制工作副本——工作副本里的 node_modules 是
 * pnpm hardlink 与指向 vendor 的绝对路径 junction，普通复制扛不住：
 * 2026-10-09 实测 `cp -r` 复制 vendor 时 66027 个文件里几百个符号链接失败。
 * `git archive` 只导出被跟踪的文件，天然不含任何构建产物与链接。
 *
 * 用法：
 *   node scripts/build-delivery.mjs --out <目录> [--edition standard|local] [--skip-browser]
 *
 * edition=standard 不含本地媒体桥接与引擎（配音/生图走云端）；
 * edition=local 额外带桥接目录与引擎安装指引（不含模型，模型由自检脚本按硬件推荐下载）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_NAME = 'deepseek-harness'
const NPM_REGISTRY = 'https://registry.npmmirror.com'
// 渲染实测快5.6 倍于系统 Chrome（11073 帧 20 分钟 → 3.5 分钟）。渲染慢是客户
// 最容易投诉的点，不值得为省 150M 让客户自己下载——尤其国内下载常常失败。
const HEADLESS_SHELL_REL = join('浏览器', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')

function parseArgs(argv) {
  const args = { edition: 'standard', skipBrowser: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--edition') args.edition = argv[++i]
    else if (argv[i] === '--skip-browser') args.skipBrowser = true
  }
  if (!args.out) throw new Error('必须指定 --out <输出目录>')
  if (!['standard', 'local'].includes(args.edition)) throw new Error(`未知版本 ${args.edition}`)
  return args
}

/**
 * 找到 npm 的 JS 入口，绕开 `npm.cmd`。
 *
 * Windows 上 Node 24拒绝无 shell 地 spawn .cmd（CVE-2024-27980），直接 spawn
 * 'npm' 会拿到退出码 null 而不是报错信息——"失败（退出码 null）"什么也说明不了。
 * 走 JS 入口既不需要 shell，也不受这条限制影响。同 scripts/install-publisher-deps.mjs。
 */
function npmEntry() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('找不到 npm 的 JS 入口，请确认 Node.js 安装完整（需含 npm）。')
  return found
}

function runNpm(args, cwd, label) {
  run(process.execPath, [npmEntry(), ...args], cwd, label)
}

/**
 * corepack 的 JS 入口，与 npm 同理：直接 spawn `corepack.cmd` 在 Windows 上拿不到退出码。
 * 找不到时回退到普通 spawn，让脚本自己报错。
 */
function corepackEntry() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return { command: process.execPath, prefix: [found] }
  return { command: 'corepack', prefix: [] }
}

function runPnpm(args, cwd, label) {
  const { command, prefix } = corepackEntry()
  run(command, [...prefix, 'pnpm', ...args], cwd, label)
}

function run(command, commandArgs, cwd, label) {
  const started = Date.now()
  process.stdout.write(`[..] ${label}\n`)
  const result = spawnSync(command, commandArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    const detail = `${result.stderr?.toString().slice(-2000) ?? ''}\n${result.stdout?.toString().slice(-2000) ?? ''}`
    throw new Error(`${label} 失败（退出码 ${result.status}）：\n${detail}`)
  }
  process.stdout.write(`[ok] ${label}（${seconds}s）\n`)
}

/**
 * 从 git 仓库导出指定 ref 的文件树到 destination。
 *
 * 试过三条路，两条都死在 Windows 上：
 *
 * 1. `tar -x -C 'F:\...'` —— 盘符被 Git Bash 的 MSYS 改写成 `F\:\...`
 *    （“Cannot open: No such file or directory”）；`MSYS2_ARG_CONV_EXCL` 在管道里
 *    对自带 tar 不生效；`git archive -o 'F:\...'` 还会把 `F:` 当远程主机。
 * 2. 绕开 MSYS 改用 System32 的原生 tar —— 能跑，但**中文文件名报
 *    “Invalid empty pathname”**，而交付物里有一半文件名是中文（启动工作台.cmd、
 *    打开工作台.ps1、docs/…）。
 *
 * `git worktree` 两条都躲开：它不经过任何 shell 管道，路径由 git 自己处理；
 * 而且 `.git` 在 worktree 里是一个**文件**而非目录，DSH 的构建脚本
 * `scripts/build.ts` 要执行的 `git rev-parse HEAD` 照样能用（这一点很关键：
 * 直接 `git archive` 剥掉 .git 会让上游构建失败）。
 */
function exportRef(repoDir, ref, destination) {
  mkdirSync(destination, { recursive: true })
  run('git', ['worktree', 'add', '--detach', '--force', destination, ref], repoDir, `检出 ${ref.slice(0, 8)}`)
  // worktree 会把自己登记在源仓库的 .git 里，不清掉的话源仓库下次操作会报错。
  run('git', ['worktree', 'prune'], repoDir, '清理 worktree 登记')
}

function npmrc(registry) {
  return [
    '# 交付包内置镜像源：国内直连 npmjs.org 平均 1.26s，npmmirror 0.34s（实测）。',
    '# 海外用户或公司网络可改回 https://registry.npmjs.org，或删掉本文件。',
    `registry=${registry}`,
    '',
  ].join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(args.out)
  const lock = JSON.parse(readFileSync(join(ROOT, 'lwb', 'UPSTREAM.lock.json'), 'utf8'))
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()

  if (dirty) {
    // 脏工作区打出来的包无法复现，也无法对应到任何一个 commit——客户报问题时
    // 我们定位不到具体代码。拒绝，而不是打一个说不清来源的包。
    throw new Error('工作区有未提交改动。请先提交或 stash，再打包。\n' + dirty.split('\n').slice(0, 10).join('\n'))
  }

  process.stdout.write(`[==] 李发发工作台交付包\n[==] 版本 ${head.slice(0, 8)} · ${args.edition}\n\n`)

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, ignoreErrors: true })
  mkdirSync(outDir, { recursive: true })
  const pkgDir = join(outDir, 'lifafa-workbench')

  // 1) 工作台源码：只取被跟踪的文件，天然不含 node_modules / lwb/local / .venv。
  process.stdout.write('[--] 导出工作台源码\n')
  exportRef(ROOT, 'HEAD', pkgDir)
  writeFileSync(join(pkgDir, '.npmrc'), npmrc(NPM_REGISTRY), 'utf8')

  // 2) vendor。DSH 的构建脚本 scripts/build.ts 要执行 `git rev-parse HEAD`，
  //    所以这里必须是一个 git 仓库——用 worktree 而不是 archive 正是为此：
  //    worktree 的 .git 是文件，`git rev-parse HEAD` 在里面照样工作。
  const vendorDir = join(pkgDir, 'vendor', VENDOR_NAME)
  process.stdout.write('[--] 导出上游 DSH 源码\n')
  const upstreamRepo = process.env.LWB_UPSTREAM_REPO
  const localVendor = join(ROOT, 'vendor', VENDOR_NAME)
  const source = upstreamRepo && existsSync(join(upstreamRepo, '.git'))
    ? upstreamRepo
    : existsSync(join(localVendor, '.git')) ? localVendor : null
  if (!source) {
    throw new Error(
      `找不到上游 DSH 仓库（已找 ${upstreamRepo ?? '未设置 LWB_UPSTREAM_REPO'} 与 ${localVendor}）。\n` +
      '先在开发机上跑 npm run setup，或用 LWB_UPSTREAM_REPO 指向一个已检出的 DSH 仓库。',
    )
  }
  exportRef(source, lock.commit, vendorDir)

  // 3) 依赖：现场装（实测 npm ci 7s + pnpm install 17s，走镜像）。
  //    不复制工作副本的 node_modules——那是 hardlink 与绝对路径 junction 的集合。
  writeFileSync(join(vendorDir, '.npmrc'), npmrc(NPM_REGISTRY), 'utf8')
  runNpm(['ci', '--no-audit', '--no-fund'], pkgDir, '安装工作台依赖')
  runPnpm(['install', '--frozen-lockfile'], vendorDir, '安装上游依赖')
  runPnpm(['run', 'build'], vendorDir, '构建上游')

  // 4) 包运行期符号链接。必须在依赖装好之后——链接目标在 vendor 里。
  run('node', ['lwb/link-packs.mjs'], pkgDir, '建立能力包运行期链接')

  // 5) 渲染浏览器。
  if (args.skipBrowser) {
    process.stdout.write('[--] 跳过渲染浏览器（--skip-browser）\n')
  } else {
    const shellSource = process.env.LWB_HEADLESS_SHELL_SOURCE
    if (!shellSource || !existsSync(shellSource)) {
      throw new Error(
        '未找到 chrome-headless-shell。请设置 LWB_HEADLESS_SHELL_SOURCE 指向已下载的\n' +
        'chrome-headless-shell-win64 目录（或其下的 chrome-headless-shell.exe），\n' +
        '也可以用 --skip-browser 跳过——但客户首次渲染会慢 5 倍以上。',
      )
    }
    const shellExe = shellSource.endsWith('.exe') ? shellSource : join(shellSource, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    if (!existsSync(shellExe)) throw new Error(`LWB_HEADLESS_SHELL_SOURCE 指向的文件不存在：${shellExe}`)
    const target = join(pkgDir, HEADLESS_SHELL_REL)
    mkdirSync(dirname(target), { recursive: true })
    process.stdout.write('[--] 复制渲染浏览器\n')
    cpSync(dirname(shellExe), dirname(target), { recursive: true })
  }

  // 6) 本地增强版才带桥接；标准版客户没有本地引擎，带过去只会让人困惑。
  if (args.edition === 'local') {
    const bridgeSrc = join(ROOT, '..', '本地媒体桥接')
    if (!existsSync(bridgeSrc)) throw new Error(`找不到本地媒体桥接目录：${bridgeSrc}`)
    const bridgeDst = join(outDir, '本地媒体桥接')
    process.stdout.write('[--] 复制本地媒体桥接\n')
    // 只带代码与音色库，绝不带 data/（缓存 2.4G）与 .bak 备份。
    for (const item of ['bridge.mjs', 'chinese-numbers.mjs', 'config.example.json', '启动桥接.cmd', '使用说明.md']) {
      const from = join(bridgeSrc, item)
      if (existsSync(from)) cpSync(from, join(bridgeDst, item))
    }
    cpSync(join(bridgeSrc, 'voices'), join(bridgeDst, 'voices'), { recursive: true })
    mkdirSync(join(bridgeDst, 'data'), { recursive: true })
  }

  // 7) 交付说明与自检脚本。
  process.stdout.write('[--] 写入安装说明与自检脚本\n')
  cpSync(join(ROOT, 'docs', 'delivery', '安装说明.md'), join(pkgDir, '安装说明.md'))
  cpSync(join(ROOT, 'docs', 'delivery', '自检.ps1'), join(pkgDir, '自检.ps1'))
  cpSync(join(ROOT, 'docs', 'delivery', '自检.cmd'), join(pkgDir, '自检.cmd'))
  if (args.edition === 'local') {
    cpSync(join(ROOT, 'docs', 'delivery', '引擎安装指引.md'), join(pkgDir, '引擎安装指引.md'))
  }

  // 8) 收尾提示。
  process.stdout.write('\n[==] 交付包已生成\n')
  process.stdout.write(`[==] 目录：${outDir}\n`)
  process.stdout.write(`[==] 内容：lifafa-workbench/（${args.edition}）`)
  if (args.edition === 'local') process.stdout.write(' + 本地媒体桥接/')
  process.stdout.write('\n[==] 下一步：压缩成 zip 后交给客户，客户解压双击 自检.cmd 再双击 启动工作台.cmd\n')
}

main().catch((error) => {
  process.stderr.write(`\n[ERR] ${error.message}\n`)
  process.exit(1)
})
