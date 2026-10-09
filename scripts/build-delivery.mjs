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
import { basename, dirname, join, resolve } from 'node:path'
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
 * 这里有两处 Windows/Git Bash 的坑，绕开它们才能跑通：
 *
 * 1. `tar -x -C 'F:\...'` 里的盘符会被 MSYS 改写成 `F\:\...`，直接报
 *    "Cannot open: No such file or directory"（2026-10-09 实测）。`MSYS2_ARG_CONV_EXCL`
 *    在管道里对 Windows 自带的 tar 不生效。
 * 2. `git archive -o 'F:\...'` 会把 `F:` 当成远程主机，报 "Cannot connect to F"。
 *
 * 所以：tar 文件用**相对名**写到工作目录，解包交给 PowerShell 里的 Windows
 * 原生 tar —— 整条链路上没有任何盘符形式的参数。
 */
function gitArchive(repoDir, ref, destination) {
  mkdirSync(destination, { recursive: true })
  // tar 落在交付目录里而不是 repoDir：工作副本可能只读，而且打包脚本本来就
  // 要求工作区干净，不能留下临时文件。
  const tarPath = join(destination, `.lwb-archive-${process.pid}.tar`)
  // 解包必须在目标目录里、用**文件名**而不是盘符路径：Git Bash 的 MSYS 会把
  // `F:\...` 改写成 `F\:\...`，`git archive -o F:\...` 还会把 `F:` 当远程主机。
  // tar 与目标目录都在 cwd 下，整条链路就没有盘符形式的参数。
  const tarName = basename(tarPath)
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', ref, '-o', tarPath], {
      cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    })
    if (archive.status !== 0) {
      throw new Error(`git archive ${ref} 失败：${archive.stderr?.toString().slice(-500) ?? ''}`)
    }
    // 必须用 Windows 原生 tar：PowerShell 解析到的 `tar` 可能是 Git Bash 的
    // /usr/bin/tar，它把 `F:` 当成远程主机，报 "Cannot connect to F: resolve failed"。
    const extract = spawnSync(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
      ['-xf', tarName],
      { cwd: destination, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    )
    if (extract.status !== 0) {
      throw new Error(`解包失败：${extract.stderr?.toString().slice(-500) ?? ''}`)
    }
  } finally {
    rmSync(tarPath, { force: true })
  }
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
  gitArchive(ROOT, 'HEAD', pkgDir)
  writeFileSync(join(pkgDir, '.npmrc'), npmrc(NPM_REGISTRY), 'utf8')

  // 2) vendor：DSH 的构建脚本要跑 `git rev-parse HEAD`，所以必须是 git 仓库。
  //    archive 只给源码（115M，无历史），再 init 一个单提交仓库满足构建脚本。
  const vendorDir = join(pkgDir, 'vendor', VENDOR_NAME)
  process.stdout.write('[--] 导出上游 DSH 源码\n')
  const upstreamRepo = process.env.LWB_UPSTREAM_REPO
  if (upstreamRepo && existsSync(join(upstreamRepo, '.git'))) {
    gitArchive(upstreamRepo, lock.commit, vendorDir)
  } else {
    const localVendor = join(ROOT, 'vendor', VENDOR_NAME)
    if (!existsSync(join(localVendor, '.git'))) {
      throw new Error(`找不到 ${localVendor} 的 git 仓库。请先 npm run setup，或用 LWB_UPSTREAM_REPO 指定。`)
    }
    gitArchive(localVendor, lock.commit, vendorDir)
  }
  run('git', ['init', '-q'], vendorDir, '初始化 vendor 仓库')
  run('git', ['config', 'user.email', 'build@lifafa.local'], vendorDir, '配置 vendor 提交身份')
  run('git', ['config', 'user.name', 'Lifafa Delivery Build'], vendorDir, '配置 vendor 提交身份')
  run('git', ['add', '-A'], vendorDir, '暂存 vendor 源码')
  run('git', ['commit', '-q', '-m', `vendored ${VENDOR_NAME} ${lock.commit.slice(0, 8)}`], vendorDir, '提交 vendor 源码')

  // 3) 依赖：现场装（实测 npm ci 7s + pnpm install 17s，走镜像）。
  //    不复制工作副本的 node_modules——那是 hardlink 与绝对路径 junction 的集合。
  writeFileSync(join(vendorDir, '.npmrc'), npmrc(NPM_REGISTRY), 'utf8')
  run('npm', ['ci', '--no-audit', '--no-fund'], pkgDir, '安装工作台依赖')
  run('corepack', ['pnpm', 'install', '--frozen-lockfile'], vendorDir, '安装上游依赖')
  run('corepack', ['pnpm', 'run', 'build'], vendorDir, '构建上游')

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
