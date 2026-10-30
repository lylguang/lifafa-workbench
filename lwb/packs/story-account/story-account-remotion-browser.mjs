// 渲染浏览器可执行文件解析（镜像 spoken-video 的 resolveRemotionBrowserExecutable）。
//
// 与 spoken-video 保持同一套环境变量名与回退次序：
//   1) LWB_REMOTION_HEADLESS_SHELL（显式指定，优先）
//   2) 仓库 node_modules/.remotion 里已随 vendor 安装的 chrome-headless-shell
//   3) LWB_REMOTION_BROWSER_EXECUTABLE（系统 Chrome，慢但一定能启动）
// 找不到任何可用浏览器时返回 null——调用方应据此抛领域错误，绝不让 Remotion 去
// storage.googleapis.com 联网下载（离线/内网/CI 必失败）。
//
// 这是对 spoken-video 那份实现的镜像，沿用 mediaServiceConfig 的「包内镜像 + 声明依赖」
// 模式：story-account 不跨包 import spoken-video，避免单独安装/加载时路径解析失败。
// 修改回退次序或路径时，两边要同步。
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACK_ROOT = dirname(fileURLToPath(import.meta.url))
export const APP_NODE_MODULES = resolve(PACK_ROOT, '../../..', 'node_modules')

// Windows 默认 MAX_PATH 260，而渲染工作区路径本身已近 300 字符；exe 绝对路径
// 过长时 CreateProcessW spawn 直接报 ENOENT（文件明明存在）。只接受长度安全的路径。
const MAX_EXECUTABLE_PATH = 200

function sharedHeadlessShellPath() {
  const exe = join(APP_NODE_MODULES, '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  try {
    // 必须先 realpath 化：任务工作区的 node_modules 含指向共享目录的符号链接，
    // Windows 的 CreateProcessW spawn「symlink 路径下的 exe」会报 ENOENT（2026-10-01 实测）。
    const real = realpathSync(exe)
    if (real.length <= MAX_EXECUTABLE_PATH) return real
  } catch { /* 浏览器未安装时退回自选路径 */ }
  return null
}

export function resolveRemotionBrowserExecutable() {
  const headlessShell = process.env.LWB_REMOTION_HEADLESS_SHELL?.trim()
  if (headlessShell && headlessShell.length <= MAX_EXECUTABLE_PATH) return headlessShell
  const shared = sharedHeadlessShellPath()
  if (shared) return shared
  const override = process.env.LWB_REMOTION_BROWSER_EXECUTABLE?.trim()
  if (override) return override
  return null
}
