/**
 * 叙事节奏指标——把「生动」变成可测量的数字。
 *
 * 为什么需要：技术质检（buildTechnicalReport）只看时长/分辨率/帧率/音轨/字幕有无，
 * 这些全是「片子有没有做好」，没有一项能看出「片子好不好看」。于是节奏问题
 * 永远不会被拦下，只能靠人看。
 *
 * 四项指标各自对应一个实测问题：
 *   hookDensity         —— 前 3 秒常常全空白（前导静音被误当成可以不放内容）
 *   sceneCount / 平均幕长 —— 历史成片幕长从 6s 到 32s 不等，没有统一标尺
 *   longestSceneSeconds —— 单幕过长会让观众在语义未变时盯着静止画面
 *   subtitleLineCompliance —— 字幕超长会被迫缩字号，实测 37-42px 在预览里已经偏小
 *
 * 全部只读输入、纯计算，不调模型、不碰文件系统。
 */

/** 中文按字计，英文按词计——两种都要能给出「这条字幕有多长」。 */
export function measureCaptionLength(text) {
  const raw = String(text || '').trim()
  if (!raw) return { chars: 0 }
  // 中文逐字计数，连续的拉丁词按 0.5 字折算（一个英文单词视觉宽度约等于两个汉字的一半）
  const han = (raw.match(/[㐀-鿿豈-﫿]/gu) || []).length
  const words = (raw.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu) || []).length
  return { chars: han + Math.ceil(words * 0.5) }
}

/**
 * 字幕应该断成几行。
 *
 * 横屏单行 28 字上限（content-video 规则），竖屏按字幕带可用宽度折算。
 * 这不是排版建议——它决定渲染时字号会不会被压小到读不清。
 */
export function countCaptionLines(text, { maxCharsPerLine = 28 } = {}) {
  const raw = String(text || '').trim()
  if (!raw) return 0
  const { chars } = measureCaptionLength(raw)
  return Math.max(1, Math.ceil(chars / Math.max(1, maxCharsPerLine)))
}

/**
 * 从 SCENES 表算出幕数与幕长分布。
 *
 * 解析的是 `src/CreativeVideo.tsx` 里那张字面量秒数的表——创作提示词强制
 * 那个格式（id/start/end 都是秒的小数），就是为了让机器能读出来对齐抽帧。
 * 读不出来时返回 null，让调用方降级成「不检查」，绝不猜。
 */
export function measureSceneTimeline(source) {
  const table = /const\s+SCENES[^=]*=\s*\[([\s\S]*?)\]/u.exec(String(source || ''))
  if (!table) return null

  const scenes = []
  // 只认字面量秒数。帧数、dur 代替 end、展开运算符一律读不出来，跳过而不是猜。
  const re = /\{\s*id:\s*"([^"]+)"\s*,\s*start:\s*(-?\d+(?:\.\d+)?)\s*,\s*end:\s*(-?\d+(?:\.\d+)?)\s*\}/gu
  let match
  while ((match = re.exec(table[1]))) {
    const start = Number(match[2])
    const end = Number(match[3])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    scenes.push({ id: match[1], start, end, seconds: +(end - start).toFixed(3) })
  }
  if (!scenes.length) return null

  scenes.sort((a, b) => a.start - b.start)
  const totalSeconds = +scenes[scenes.length - 1].end.toFixed(3)
  const durations = scenes.map((scene) => scene.seconds)
  const longest = durations.reduce((best, value) => (value > best ? value : best), 0)

  return {
    scenes,
    sceneCount: scenes.length,
    totalSeconds,
    averageSceneSeconds: +(totalSeconds / scenes.length).toFixed(2),
    longestSceneSeconds: +longest.toFixed(2),
    /** 首场景起点。正值即前导静音，不算「空白片头」的过失。 */
    firstSceneStartSeconds: scenes[0].start,
  }
}

/**
 * 节奏指标。全部是**观察值**，不是判决——阈值由调用方按内容类型决定。
 * 这里只负责把事实算清楚，不预设「多少秒一幕才对」。
 */
export function measureNarrativeRhythm({ sceneTimeline, cues = [], durationSeconds = null, orientation = 'landscape' }) {
  const total = Number(durationSeconds) || sceneTimeline?.totalSeconds || (cues.length ? cues[cues.length - 1].endMs / 1000 : 0)

  // 前 3 秒的字幕密度：0 就是真空白（开头的静音段落除外，见 leadSilence）
  const leadSilence = sceneTimeline ? sceneTimeline.firstSceneStartSeconds : 0
  const hookWindowEndMs = Math.max(leadSilence, 0) * 1000 + 3000
  const hookCues = cues.filter((cue) => cue.startMs < hookWindowEndMs)
  const hookChars = hookCues.reduce((sum, cue) => sum + measureCaptionLength(cue.text).chars, 0)
  /** 钩子窗口内的实际发言时长（秒）；前导静音不计入，否则会把留白算成"有内容"。 */
  const hookSpeechSeconds = hookCues.reduce((sum, cue) => sum + Math.max(0, cue.endMs - cue.startMs), 0) / 1000

  // 字幕换行合规率
  // 竖屏字幕带更窄，单行上限相应收紧；横屏沿用 content-video 的 28 字。
  const maxCharsPerLine = orientation === 'portrait' ? 20 : 28
  const lineCounts = cues.map((cue) => countCaptionLines(cue.text, { maxCharsPerLine }))
  const compliant = lineCounts.filter((lines) => lines <= 2).length

  return {
    durationSeconds: +Number(total).toFixed(3),
    leadSilenceSeconds: +Number(leadSilence || 0).toFixed(3),
    hook: {
      windowSeconds: 3,
      cueCount: hookCues.length,
      charCount: hookChars,
      speechSeconds: +hookSpeechSeconds.toFixed(3),
      /** 前导静音之后的发言部分，密度才有意义。 */
      charsPerSpeechSecond: hookSpeechSeconds > 0 ? +(hookChars / hookSpeechSeconds).toFixed(2) : null,
      /** 静音期间没有任何内容，密度为 0——这才是真的空白开场。 */
      silentHook: hookSpeechSeconds === 0 && total > 0,
    },
    scenes: sceneTimeline
      ? {
          sceneCount: sceneTimeline.sceneCount,
          averageSceneSeconds: sceneTimeline.averageSceneSeconds,
          longestSceneSeconds: sceneTimeline.longestSceneSeconds,
          longestSceneId: sceneTimeline.scenes.reduce((best, scene) => (scene.seconds > best.seconds ? scene : best)).id,
        }
      : null,
    subtitles: {
      cueCount: cues.length,
      maxLines: lineCounts.length ? Math.max(...lineCounts) : 0,
      overTwoLines: lineCounts.length - compliant,
      twoLineComplianceRate: lineCounts.length ? +(compliant / lineCounts.length).toFixed(4) : null,
      longestCaptionChars: cues.reduce((max, cue) => Math.max(max, measureCaptionLength(cue.text).chars), 0),
    },
  }
}