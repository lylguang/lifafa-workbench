/**
 * corepack / pnpm 的跨脚本辅助。
 *
 * 两个构建期脚本（build-delivery.mjs 打包、setup-delivery.mjs 客户机首次运行）
 * 都要跑 `pnpm install` 与 `pnpm run build`，而后者内部还会再 spawn `pnpm`
 * （上游 scripts/build.ts → build:lib → `pnpm run build:lib:host`）。子进程只认
 * PATH，看不到我们用 corepack.js 直接调起来的那个 pnpm，于是报
 * 「'pnpm' 不是内部或外部命令（build:lib exited with 1）」。
 *
 * 2026-11-03 实测：这条在**客户机首次运行**时必炸——交付包不带 pnpm，客户装完
 * 解压、双击「首次运行.cmd」直接失败。开发机上因为装了 pnpm 一直没暴露。
 *
 * `corepack enable` 能解决，但要写 Node 安装目录（Program Files），需要管理员
 * 权限，还会改用户机器环境。这里改成在临时目录造一个 pnpm 垫片，只对这个
 * 子进程的 PATH 生效。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** corepack 的 JS 入口：Windows 上直接 spawn `corepack.cmd` 拿不到退出码。 */
export function corepackEntry() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return { command: process.execPath, prefix: [found] }
  return { command: 'corepack', prefix: [] }
}

/**
 * 返回一份 PATH 里带 pnpm 垫片的环境变量。
 *
 * 垫片放在系统临时目录（而不是 Node 安装目录旁边）：客户机的 Node 装在
 * `<包>\运行环境\node\node.exe`，旁边写文件没问题；但开发机上 Node 在
 * `C:\Program Files\nodejs`，`..` 就是 `C:\Program Files`——非管理员直接写失败。
 * 2026-11-03 实测：以管理员跑构建时默默成功，换到普通用户就会炸。
 * 垫片只在这个子进程的 PATH 里生效，用完不用清。
 */
export function pnpmShimEnv(env = process.env) {
  const corepack = corepackEntry()
  const corepackPath = corepack.prefix[0]
  if (!corepackPath) return env
  const shimDir = join(tmpdir(), 'lwb-build-bin')
  mkdirSync(shimDir, { recursive: true })
  // 垫片内容必须是**纯 ASCII**。
  //
  // 2026-11-03 实测：一开始把 node.exe 的绝对路径直接写进 pnpm.cmd，而交付包里那
  // 个路径是 `<包>\运行环境\node\node.exe`。cmd.exe 按系统 ANSI 编码（中文系统是
  // GBK）读 .cmd 文本，而我们写的是 UTF-8，于是路径被读成一堆乱码，报
  // 「系统找不到指定的路径」——比直接说“找不到 pnpm”更难查。
  // 所以 .cmd 里只出现 `node "%~dp0pnpm.js"`（全 ASCII），真正的路径交给
  // pnpm.js（Node 读 UTF-8，不会乱码）。node 本身由调用方放进 PATH。
  writeFileSync(join(shimDir, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0pnpm.js" %*\r\n', 'utf8')
  writeFileSync(join(shimDir, 'pnpm.js'), [
    '// 由 pnpm.cmd 调用：转交 corepack 执行 pnpm。路径写在 JS 里避免 cmd 的编码问题。',
    `const CORE = ${JSON.stringify(corepackPath)}`,
    "const { spawnSync } = require('node:child_process')",
    'const result = spawnSync(process.execPath, [CORE, \'pnpm\', ...process.argv.slice(2)], { stdio: \'inherit\', env: process.env })',
    'if (result.error) { console.error(result.error.message); process.exit(1) }',
    'process.exit(result.status ?? 1)',
  ].join('\n'), 'utf8')
  // Git Bash 用的同名脚本：sh 按 UTF-8 读，路径可以直接写。
  writeFileSync(join(shimDir, 'pnpm'), `#!/bin/sh\nexec node "${join(shimDir, 'pnpm.js').replace(/\\/g, '/')}" "$@"\n`, 'utf8')
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  // 用 path.delimiter 而不是硬编码 ';'：非 Windows 上分隔符是 ':'，
  // 硬编码会把整条 PATH 变成一个坏掉的目录名。
  return { ...env, [pathKey]: `${shimDir}${delimiter}${env[pathKey] ?? ''}` }
}

/**
 * 用 corepack 跑一条 pnpm 命令，PATH 里带上 pnpm 垫片。
 *
 * install 与 build 必须走同一个入口，否则「首次安装的机器能跑、第二次不能跑」
 * 这类差异会以极难复现的形式出现。三件必须一起做的事：
 *   1. `corepackEntry()` 给出 corepack.js 的绝对路径、用 node 跑它
 *      ——Windows 上 corepack 是 corepack.cmd，`shell:false` spawn 拿不到退出码；
 *   2. `pnpmShimEnv()` 让嵌套 spawn（上游 build:lib 会再 spawn 一次 pnpm）
 *      找得到 pnpm；
 *   3. `CI=true` 让 pnpm 敢在无 TTY 下清空 node_modules（上游 build:lib 会重装）。
 *
 * @param cwd - pnpm 的工作目录。
 * @param args - pnpm 参数，例如 `['run', 'build']`。
 * @param label - 日志前缀。
 * @returns the child's exit code.
 */
export function runPnpm(cwd, args, label = 'pnpm') {
  const corepack = corepackEntry()
  return new Promise((resolveRun, reject) => {
    console.log(`=== [${label}] pnpm ${args.join(' ')}`)
    const child = spawn(corepack.command, [...corepack.prefix, 'pnpm', ...args], {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: { ...pnpmShimEnv(process.env), CI: 'true' },
    })
    child.once('error', reject)
    child.once('exit', code => resolveRun(code ?? 1))
  })
}
