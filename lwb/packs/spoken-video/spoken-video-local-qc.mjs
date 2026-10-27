/**
 * 全片解码级检测：黑帧、冻结、静音、削波。
 *
 * 为什么要有这一层：现有技术质检看的是「抽帧」——12~24 张采样帧的色数/透明/边缘密度。
 * 抽帧天然有盲区：一段 8 秒的纯黑画面，只要没落在采样点上就完全看不见；
 * 整条音轨静音，只要字幕数够、时长对，也照样通过。2026-10-21 连续三次给出
 * 「质检合格」的空片，暴露的就是这个盲区。
 *
 * 这一层用 ffmpeg 把整片**解码一遍**（不做编码，只出检测日志），因此覆盖每一帧、
 * 每一秒音频。它是纯本地计算：零 API 成本，量级约等于一次软解码，通常在数秒内。
 *
 * 定位是**客观缺陷的守门人**，不判美感。主观问题（构图、信息密度、视觉一致性）
 * 仍交给模型审片；但客观缺陷必须在花掉一次模型往返之前就拦住。
 */

/** 低于这个时长的问题段落才视为「可忽略的瞬态」，不否决。 */
export const LOCAL_QC_MIN_DEFECT_SECONDS = 0.5

/**
 * 默认阈值。数值来自实测标定，不是拍脑袋：
 *
 * · blackMinSeconds 1.2：正常的场景切换、淡入淡出会有 0.1~0.4 秒的近黑过渡；
 *   连续 1.2 秒以上全黑才是「内容没画出来」。
 * · silenceMinSeconds 2.0：段间本来就有 0.2 秒静音，句间换气也常到 1 秒；
 *   连续 2 秒以上无声才是「音轨断了」。
 * · peakDb / clipRatio：响度归一化后峰值应贴近 -1dB；持续削波说明混音有问题。
 *
 * **刻意没有 freeze 阈值。** 2026-10-26 实测：拿一条已通过审片并发布的真实成片
 * （250 秒、1920x1080）跑 freezedetect(n=-60dB:d=3)，检出 28 段、累计约 165 秒
 * 「画面完全静止」——占全片 66%。但那是**正常作品**：我们的视觉风格就是静态信息
 * 卡片 + 文字入场动画，一个场景讲完一段话，画面本来就长时间不动。
 *
 * 也就是说 freeze 在这个项目里不是缺陷信号，而是风格特征。照搬 OpenChatCut 的
 * 「静止超过 N 秒即告警」会把每一条正常成片都判为不合格。真要检测「动画没跑起来」，
 * 判据应当是「该有入场动画的场景里一帧都没变」，这需要结合场景表与动画窗口，
 * 属于模型审片的职责，不该用全片 freezedetect 硬判。
 */
export const DEFAULT_LOCAL_QC_THRESHOLDS = Object.freeze({
  blackMinSeconds: 1.2,
  blackPixelThreshold: 0.98,
  silenceMinSeconds: 2.0,
  silenceNoiseDb: -45,
  clipPeakDb: -0.1,
  clipRatioLimit: 0.001,
})

/**
 * 解析 `-af silencedetect` 的日志行。
 *
 * 输出形如：
 *   [silencedetect @ 0x...] silence_start: 12.3456
 *   [silencedetect @ 0x...] silence_end: 14.5678 | silence_duration: 2.2222
 *
 * 片尾若以静音结束，ffmpeg 不会打 silence_end，需要用总时长补齐——
 * 这是最容易被漏掉的一段（结尾静音往往就是「最后一句没念完」）。
 */
export function parseSilenceDetect(log, durationSeconds = null) {
  const spans = []
  let open = null
  for (const line of String(log || '').split(/\r?\n/u)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (start) {
      open = Number(start[1])
      continue
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (end && open !== null) {
      spans.push({ startSeconds: open, endSeconds: Number(end[1]), durationSeconds: Number(end[2]) })
      open = null
    }
  }
  if (open !== null && Number.isFinite(durationSeconds) && durationSeconds > open) {
    spans.push({ startSeconds: open, endSeconds: durationSeconds, durationSeconds: durationSeconds - open })
  }
  return spans.filter((span) => span.durationSeconds > 0)
}

/**
 * 解析 `-vf blackdetect` 的日志行。
 *
 * 输出形如：
 *   [blackdetect @ 0x...] black_start:3.2 black_end:5.6 black_duration:2.4
 */
export function parseBlackDetect(log) {
  const spans = []
  for (const line of String(log || '').split(/\r?\n/u)) {
    const hit = /black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)\s+black_duration:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (hit) spans.push({ startSeconds: Number(hit[1]), endSeconds: Number(hit[2]), durationSeconds: Number(hit[3]) })
  }
  return spans.filter((span) => span.durationSeconds > 0)
}

/**
 * 解析 `-vf freezedetect` 的日志行。
 *
 * 输出形如：
 *   [freezedetect @ 0x...] lavfi.freezedetect.freeze_start: 4.5
 *   [lavfi.freezedetect ...] lavfi.freezedetect.freeze_end: 9.1
 *   [lavfi.freezedetect ...] lavfi.freezedetect.freeze_duration: 4.6
 *
 * 不同 ffmpeg 版本的字段前缀不一致，所以两种写法都要认。
 */
export function parseFreezeDetect(log, durationSeconds = null) {
  const spans = []
  let open = null
  for (const line of String(log || '').split(/\r?\n/u)) {
    const start = /freeze_start:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (start) {
      open = Number(start[1])
      continue
    }
    const end = /freeze_end:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (end && open !== null) {
      const endSeconds = Number(end[1])
      spans.push({ startSeconds: open, endSeconds, durationSeconds: endSeconds - open })
      open = null
    }
  }
  // 片尾冻结同样没有 freeze_end。
  if (open !== null && Number.isFinite(durationSeconds) && durationSeconds > open) {
    spans.push({ startSeconds: open, endSeconds: durationSeconds, durationSeconds: durationSeconds - open })
  }
  return spans.filter((span) => span.durationSeconds > 0)
}

/**
 * 解析 `-af volumedetect` 的峰值与统计。
 *
 * 输出形如：
 *   [Parsed_volumedetect_0 @ ...] mean_volume: -21.5 dB
 *   [Parsed_volumedetect_0 @ ...] max_volume: -1.2 dB
 */
export function parseVolumeDetect(log) {
  const text = String(log || '')
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/u.exec(text)
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/u.exec(text)
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null,
  }
}

/**
 * 把四类检测结果汇总成「是否否决」的判定。
 *
 * 设计原则（与现有技术质检一致）：**测不出来不否决**。
 * 检测命令失败、日志为空、时长未知时，只记 warning，绝不让「测不了」
 * 变成「片子有问题」——那会把偶发的 ffmpeg 抖动放大成误判。
 *
 * 反过来，一旦测出来且超阈值，就必须否决：这些是客观缺陷，
 * 送进模型审片只是浪费一次往返，而且模型很可能因为「看起来挺简洁」而放过。
 */
export function judgeLocalQc({
  blackSpans = [],
  freezeSpans = [],
  silenceSpans = [],
  volume = {},
  durationSeconds = null,
  thresholds = DEFAULT_LOCAL_QC_THRESHOLDS,
} = {}) {
  const issues = []
  const warnings = []
  const defects = []

  const significant = (span, minimum) => span.durationSeconds >= Math.max(minimum, LOCAL_QC_MIN_DEFECT_SECONDS)

  const blacks = blackSpans.filter((span) => significant(span, thresholds.blackMinSeconds))
  if (blacks.length) {
    const worst = blacks.reduce((a, b) => (b.durationSeconds > a.durationSeconds ? b : a))
    defects.push({ kind: 'black', count: blacks.length, worst })
    issues.push(`成片有 ${blacks.length} 段全黑画面，最长 ${worst.durationSeconds.toFixed(1)} 秒（${worst.startSeconds.toFixed(1)}s 起）。`)
  }

  // 冻结只记录、不否决。原因见 DEFAULT_LOCAL_QC_THRESHOLDS 的说明：
  // 静态信息卡片是本项目的正常风格，实测一条已发布的正常成片有 66% 时长静止。
  // 这里仍把数字报出来，供人工和模型审片参考「哪里特别久没动」。
  const freezes = Array.isArray(freezeSpans) ? freezeSpans : []
  if (freezes.length) {
    const worst = freezes.reduce((a, b) => (b.durationSeconds > a.durationSeconds ? b : a))
    const totalSeconds = freezes.reduce((sum, span) => sum + span.durationSeconds, 0)
    const ratio = durationSeconds ? totalSeconds / durationSeconds : null
    warnings.push(
      `画面静止 ${freezes.length} 段，累计 ${totalSeconds.toFixed(1)} 秒`
      + (ratio === null ? '' : `（占全片 ${(ratio * 100).toFixed(0)}%）`)
      + `，最长一段 ${worst.durationSeconds.toFixed(1)} 秒（${worst.startSeconds.toFixed(1)}s 起）。`
      + '静态信息卡片属于正常风格，此项仅记录，不参与否决。',
    )
  }

  const silences = silenceSpans.filter((span) => significant(span, thresholds.silenceMinSeconds))
  if (silences.length) {
    const worst = silences.reduce((a, b) => (b.durationSeconds > a.durationSeconds ? b : a))
    defects.push({ kind: 'silence', count: silences.length, worst })
    issues.push(`成片有 ${silences.length} 段连续无声，最长 ${worst.durationSeconds.toFixed(1)} 秒（${worst.startSeconds.toFixed(1)}s 起）。`)
  }

  // 削波：峰值贴 0dB 说明混音已经压爆。单看峰值不够（TTS 归一化后本就接近 -1dB），
  // 所以只把「比 clipPeakDb 还高」记为问题；真正的削波比例要额外解码统计，
  // 这里不做，避免为了一个罕见问题多跑一遍全片。
  if (Number.isFinite(volume?.maxVolumeDb) && volume.maxVolumeDb > thresholds.clipPeakDb) {
    warnings.push(`音频峰值 ${volume.maxVolumeDb.toFixed(1)}dB 已超过 ${thresholds.clipPeakDb}dB，存在削波风险。`)
  }
  if (Number.isFinite(volume?.maxVolumeDb) && volume.maxVolumeDb < -30) {
    warnings.push(`音频峰值仅 ${volume.maxVolumeDb.toFixed(1)}dB，整体偏轻。`)
  }
  if (!Number.isFinite(volume?.maxVolumeDb)) {
    warnings.push('未能读取音频峰值（volumedetect 无输出），该项未参与判定。')
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    defects,
    measured: {
      blackSpans,
      freezeSpans,
      silenceSpans,
      volume,
      durationSeconds,
    },
  }
}
