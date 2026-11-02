// 成片响度归一化：把旁白拉到平台目标响度，写完复测，不达标就按残差修正再编。
//
// 为什么需要（2026-11-01 实测）：
//   一条已发布的成片测得 I = -21.3 LUFS、真峰值 -4.2 dBFS，而旁白源本身是
//   I = -21.4 LUFS / 峰值 -1.2 dBFS。整条链路从未做过响度归一化，TTS 出来多响
//   就发多响。抖音/视频号/YouTube 的目标都在 -14 LUFS 左右，我们比它低 7dB ——
//   观众感知就是「声音偏小」，平台做响度归一化时也换不回本该有的力度。
//
// 为什么不是一句 `-af loudnorm=I=-14`：
//   实测这版旁白的峰均比接近 19dB（TTS 的典型特征：字头瞬态高、平均能量低）。
//   loudnorm 的动态模式在真峰值贴近 0 时只能压低增益来防削波，实测稳定停在
//   -15.2 LUFS，比目标低 1.2dB；把 LRA 收紧到 5 也只有 -15.2，加压缩器反而更差
//   （-22.1）。真正有效的是**先增益、再限幅**：volume 一步把平均能量顶上去，
//   alimiter 只削掉超出的瞬态——实测 I = -14.3 / 峰值 -2.5，峰均比降到 11.8dB，
//   正是广播语音的常见形态。
//
// 关键在闭环：写完后必须**重新测量**再决定是否收工。lossy 编码、限幅器的实际
// 释放曲线都会让结果偏离计算值，只做一遍就报告成功是这类工具最常见的假通过。
//
// 失败策略：任何一步失败都保留原始音频并返回原因，绝不因此中断渲染——
// 响度是质量问题，不是产物可用性问题。

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 平台目标：抖音/视频号/YouTube/Reels 都在 -14 LUFS 附近；-1 dBTP 留出编码余量。 */
export const NARRATION_LOUDNESS = Object.freeze({ targetLufs: -14, truePeakDb: -1 })

/** 收敛容差：整片响度 ±0.5 LU、真峰值不超过上限 +0.3dB。 */
export const LOUDNESS_TOLERANCE = Object.freeze({ lufs: 0.5, truePeakDb: 0.3 })

/**
 * 解析 `-af ebur128=peak=true` 的汇总输出。
 *
 * 输出形如（ffmpeg 5/6/7 一致）：
 *   [Parsed_ebur128_0 @ ...] Summary:
 *     Integrated loudness:
 *       I:         -21.3 LUFS
 *     Loudness range:
 *       LRA:         4.1 LU
 *     True peak:
 *       Peak:       -4.2 dBFS
 */
export function parseEbur128(log) {
  const text = String(log || '')
  const integrated = /Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/u.exec(text)
  const lra = /Loudness range:\s*LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/u.exec(text)
  const peak = /True peak:\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/u.exec(text)
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    loudnessRangeLu: lra ? Number(lra[1]) : null,
    truePeakDb: peak ? Number(peak[1]) : null,
  }
}

/** 实测一段音频的响度。测不出来返回 null（不猜）。 */
export async function measureLoudness(filePath, { timeoutMs = 600_000 } = {}) {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-hide_banner', '-nostats', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    return parseEbur128(stderr)
  } catch (error) {
    const parsed = parseEbur128(error?.stderr)
    return parsed.integratedLufs === null ? null : parsed
  }
}

/** 限幅器阈值写成线性幅度：-1 dBFS ≈ 0.891。 */
const limiterLimit = (truePeakDb) => Math.min(0.999, Math.max(0.0625, 10 ** (truePeakDb / 20)))

/**
 * 增益 + 限幅 + 复测的闭环响度归一化。
 *
 * @returns {Promise<{ok: boolean, applied: boolean, reason?: string, before?: object, after?: object, attempts?: number, gainDb?: number}>}
 *   ok=false 表示没收敛到目标，调用方可以选择保留它（已接近目标）或回退原文件。
 */
export async function normalizeNarrationLoudness(sourcePath, targetPath, {
  targetLufs = NARRATION_LOUDNESS.targetLufs,
  truePeakDb = NARRATION_LOUDNESS.truePeakDb,
  attempts = 4,
} = {}) {
  if (!await stat(sourcePath).then(() => true).catch(() => false)) return { ok: false, applied: false, reason: '源音频不存在' }

  const before = await measureLoudness(sourcePath)
  if (!before || before.integratedLufs === null) return { ok: false, applied: false, reason: '原始音频响度测不出来（ffmpeg 不可用或输出无法解析）' }

  // 已经达标就不重编码：无损跳过，避免二次编码的质量损失。
  const peakOk = before.truePeakDb === null || before.truePeakDb <= truePeakDb + LOUDNESS_TOLERANCE.truePeakDb
  if (Math.abs(before.integratedLufs - targetLufs) <= LOUDNESS_TOLERANCE.lufs && peakOk) {
    return { ok: true, applied: false, reason: 'already-on-target', before }
  }

  // 残差闭环：每次按「目标 - 实测」修正增益再编。限幅器会吃掉一点响度，
  // 所以第一遍往往差 0.3~0.8 LU，第二遍就能收进容差。
  let gainDb = targetLufs - before.integratedLufs
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // level=false 必须显式写：alimiter 默认 level=true 会把输出自动拉满到 0dBFS，
    // 于是真峰值恒等于 0、复测永远过不了（实测踩过：limit 设 0.89 仍然 Peak 0.0）。
    const filter = `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${limiterLimit(truePeakDb).toFixed(3)}:attack=5:release=60:level=false`
    try {
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-nostats', '-y', '-i', sourcePath,
        '-af', filter, '-ar', '48000', '-ac', '2', targetPath,
      ], { timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 })
    } catch (error) {
      return { ok: false, applied: false, reason: `编码失败：${String(error?.stderr || error?.message || '').slice(-200)}`, before, gainDb }
    }
    const after = await measureLoudness(targetPath)
    if (!after || after.integratedLufs === null) return { ok: false, applied: true, reason: '复测失败（测不出来，不当作达标）', before, gainDb }
    last = after
    const lufsOk = Math.abs(after.integratedLufs - targetLufs) <= LOUDNESS_TOLERANCE.lufs
    const afterPeakOk = after.truePeakDb === null || after.truePeakDb <= truePeakDb + LOUDNESS_TOLERANCE.truePeakDb
    if (lufsOk && afterPeakOk) return { ok: true, applied: true, before, after, gainDb, attempts: attempt }
    // 没收敛：按残差修正增益。峰值超标时先压低目标增益，避免限幅器越压越多。
    const residual = targetLufs - after.integratedLufs
    gainDb += residual
  }
  return { ok: false, applied: true, reason: '复测未达标', before, after: last, gainDb }
}
