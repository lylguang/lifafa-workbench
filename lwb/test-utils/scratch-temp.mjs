/**
 * 让「会写真实媒体产物」的测试把临时工作区落在空闲盘上，而不是系统盘。
 *
 * 生产侧的机制在 `lwb/dsh-launcher.mjs`：启动时把 TEMP/TMP 从系统盘挪到最空闲的非系统盘
 * （`resolveScratchRoot`），所以 `npm run dev` / `npm start` 跑出来的真实渲染不受「系统盘
 * 快满」影响。但 `node --test` 不经过 launcher，`os.tmpdir()` 停在系统盘上。两类后果在
 * 2026-10-31 本机实测到（C 盘只剩 0.2 GB 空闲，F 盘还有 60 GB）：
 *  - 渲染前的磁盘预检连临时盘一起查（`spoken-video-remotion.mjs` 的 `assertRenderDiskSpace`），
 *    于是 `spoken-video-media` 4 个用例报「磁盘空间不足，无法开始渲染」；
 *  - 923 个用例并发往同一个快满的系统盘写 ffmpeg 成片/抽帧，`story-account/qc.test.mjs`
 *    那条真实抽帧用例里的 ffmpeg 直接崩掉（退出码 0xDFABA7BB，不是容量错误码）。
 * 两条都是机器状态，不是被测代码的问题——门不该红在环境上。
 *
 * 选址口径与 launcher 保持一致（同样的空闲下限、同样的 `LWB_SCRATCH_ROOT` / `LWB_TEMP_DIR`
 * 覆盖语义），两边的约定靠这几个环境变量锚住。生产的预检没被削弱：它照样同时查输出盘与
 * `tmpdir()`，真实渲染该有的保护一点没削。一台空闲非系统盘都没有时原样不动，退回
 * `tmpdir()` 的真实语义——那种情况预检该红就让它红，不替测试伪造一个"够用的盘"。
 *
 * 放在包外（`lwb/packs/*` 会被单独打包安装，跨包引测试文件会破坏打包边界）。
 */
import { existsSync, mkdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 与 lwb/dsh-launcher.mjs 的同名常量同口径：改那里时这里要跟着改。
const SCRATCH_MIN_FREE_GB = 20
const SCRATCH_DIR_NAME = 'lifa-scratch'

function freeBytesOn(root) {
  try {
    const stats = statfsSync(root, { bigint: true })
    return Number(stats.bavail * stats.bsize)
  } catch {
    return null
  }
}

/** 最空闲的非系统盘（≥ SCRATCH_MIN_FREE_GB 空闲）；一台都没有就返回 null。 */
export function pickScratchRoot(env = process.env) {
  if (env.LWB_SCRATCH_ROOT) return env.LWB_SCRATCH_ROOT.replace(/[\\/]+$/u, '')
  const systemDrive = (env.SystemDrive || 'C:').toLowerCase()
  const minFree = SCRATCH_MIN_FREE_GB * 1024 ** 3
  const viable = []
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (root.toLowerCase() === `${systemDrive}\\`) continue
    if (!existsSync(root)) continue
    const free = freeBytesOn(root)
    if (free === null || free < minFree) continue
    viable.push({ root, free })
  }
  if (!viable.length) return null
  viable.sort((a, b) => b.free - a.free)
  return `${viable[0].root}${SCRATCH_DIR_NAME}`
}

/**
 * 把 TEMP/TMP/TMPDIR 指到空闲盘上的 scratch 目录，让后续 `os.tmpdir()`（含生产预检读到的
 * 那个）都跟着走。调用一次就够：同一进程内的 `mkdtemp(join(tmpdir(), …))` 全部落到新位置。
 * 返回实际生效的目录，便于日志与调试。
 */
export function useRoomyTempScratch(env = process.env) {
  if (env.LWB_TEMP_DIR) {
    const target = env.LWB_TEMP_DIR.replace(/[\\/]+$/u, '')
    mkdirSync(target, { recursive: true })
    env.TEMP = target
    env.TMP = target
    env.TMPDIR = target
    return target
  }
  const scratchRoot = pickScratchRoot(env)
  if (!scratchRoot) return tmpdir()
  // 反斜杠盘根（`F:\lifa-scratch`）在 POSIX 上会被当成普通目录名，这里只在本机真有
  // 空闲非系统盘时才走到这一步。
  const target = join(scratchRoot, 'temp')
  mkdirSync(target, { recursive: true })
  env.TEMP = target
  env.TMP = target
  env.TMPDIR = target
  return target
}

/**
 * 按进程隔离的 scratch：在同一空闲盘下建 `unit-<pid>` 子目录，并把 TEMP/TMP/TMPDIR 指过去。
 *
 * 共享目录会让并发跑的两份测试互相删对方的工作区——2026-11-01 本机实测到：一方退出前的
 * 兜底扫描按名字前缀删掉了另一方正在用的目录，表现是 ffmpeg `Command failed` 与
 * 「媒体任务记录丢失」，看起来像被测代码坏了。所以会做退出前清理的测试必须只扫自己进程
 * 的目录；不需要清理的测试用 `useRoomyTempScratch()` 就够（mkdtemp 的名字本来就唯一）。
 */
export function useProcessScratch(env = process.env) {
  const base = useRoomyTempScratch(env)
  const own = join(base, `unit-${process.pid}`)
  mkdirSync(own, { recursive: true })
  env.TEMP = own
  env.TMP = own
  env.TMPDIR = own
  return own
}
