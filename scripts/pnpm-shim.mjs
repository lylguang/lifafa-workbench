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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  return { ...env, [pathKey]: `${shimDir};${env[pathKey] ?? ''}` }
}
