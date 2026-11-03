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
  // .cmd 给 cmd.exe（上游用 shell 调脚本时走它），无扩展名的 sh 给 Git Bash。
  writeFileSync(join(shimDir, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${corepackPath}" pnpm %*\r\n`, 'utf8')
  writeFileSync(join(shimDir, 'pnpm'), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "${corepackPath.replace(/\\/g, '/')}" pnpm "$@"\n`, 'utf8')
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [pathKey]: `${shimDir};${env[pathKey] ?? ''}` }
}
