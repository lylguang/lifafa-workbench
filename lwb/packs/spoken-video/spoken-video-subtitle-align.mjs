// 字幕时间轴对齐守卫。
//
// 背景（2026-09-30 实测）：云端字幕接口（SciTiger /api/v1/subtitle/jobs）返回的时间戳
// 可能与真实音频脱节——文本转写全对，时间轴整体滞后 4-6 秒且各段不均匀。这份错误 SRT
// 会同时毒化烧录字幕与场景切场（场景边界从 SRT 推导），而「场景表 vs SRT」这类同源
// 一致性检查互相印证，测不出问题。唯一可靠的判据是把 cue 与音频的实际语音分布对齐。
//
// 方法：ffmpeg 解码出 8k 单声道 PCM → 能量 VAD 得到真实语音区间 → cue 按发音字符占比
// 铺到语音活跃时间上（停顿不计入）→ 吸附到语音起始点。占比模型对「局部语速偏差」有
// 最高约 3 秒的误差，所以疑点成立时再用本地 ComfyUI Qwen3-ASR 抽窗转写做锚点，对占比
// 估计做分段线性校正。锚点不可用时只在漂移严重时采用纯 VAD 修正（宁枉勿纵的阈值更高）。
//
// 守卫绝不阻塞字幕产出：任何内部异常都降级为「放行 + 记录原因」。
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 判定阈值（秒）：
// - SUSPICION_*：占比估计与原 SRT 的分歧（便宜检查，只用于决定是否升级到本地 ASR；
//   占比模型对局部语速偏差最高有 ~3s 误差，所以该分歧本身不能定罪）。
// - ANCHOR_DEVIATION_*：原始 SRT 在锚点 cue 上与锚点实测时间的偏差。锚点是带噪声的
//   地面真值采样（±1s），原始时间轴只有在明显超出噪声底时才判错并采纳修正。
export const SUSPICION_MEAN = 1.2
// 仅用于预检兜底的纯 VAD 怀疑检查（无锚点、只警告不定罪）。
export const SUSPICION_MAX = 3.0
export const ANCHOR_DEVIATION_MEAN = 1.8
export const ANCHOR_DEVIATION_MAX = 4.5
// 没有锚点可用时，只有怀疑程度更重才采用纯 VAD 修正（占比模型本身有 ~3s 误差）。
export const ADOPT_WITHOUT_ANCHORS_MEAN = 2.0
export const MIN_ANCHORS = 4
const ASR_WINDOW_SECONDS = 12
const ASR_TIMEOUT_MS = 240_000

export function parseSrt(text) {
  const cues = []
  for (const block of String(text || '').replace(/\r/g, '').trim().split(/\n\n+/)) {
    const lines = block.split('\n')
    const m = lines[1] && lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
    if (!m) continue
    const at = (h, mi, s, ms) => Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000
    cues.push({ index: cues.length + 1, start: at(m[1], m[2], m[3], m[4]), end: at(m[5], m[6], m[7], m[8]), text: lines.slice(2).join(' ').trim() })
  }
  return cues
}

export function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`
}

export function serializeSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join('\n\n') + '\n'
}

/** 发音字符数（CJK/字母/数字）；标点代表停顿，停顿不在语音活跃时间里。 */
export function pronouncedChars(text) {
  return (String(text).match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length
}

/** 能量 VAD：10ms 帧，阈值取噪声底(10 分位)×4，短于 150ms 的句内停顿并入语音块。 */
export function speechIntervalsFromPcm(pcm, sampleRate = 8000) {
  const frameSamples = Math.max(1, Math.round(sampleRate / 100))
  const frameCount = Math.floor(pcm.length / frameSamples)
  if (frameCount < 10) return []
  const energy = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    for (let j = 0; j < frameSamples; j++) { const v = pcm[i * frameSamples + j]; sum += v * v }
    energy[i] = Math.sqrt(sum / frameSamples)
  }
  const sorted = Float32Array.from(energy).sort()
  const floor = sorted[Math.floor(frameCount * 0.1)]
  // 语音占比高时 10 分位可能落进语音能量区（实测合成音/密集口播都会），钳到中位能量的一半，
  // 避免阈值反超语音本身导致整段判静音。
  const median = sorted[Math.floor(frameCount * 0.5)]
  const threshold = Math.max(Math.min(floor * 4, median * 0.5), 0.005)
  const speech = new Uint8Array(frameCount)
  for (let i = 0; i < frameCount; i++) speech[i] = energy[i] > threshold ? 1 : 0
  for (let i = 0; i < frameCount;) {
    if (!speech[i]) {
      let j = i
      while (j < frameCount && !speech[j]) j++
      if ((j - i) / 100 < 0.15 && i > 0 && j < frameCount) for (let k = i; k < j; k++) speech[k] = 1
      i = j
    } else i++
  }
  const intervals = []
  for (let i = 0; i < frameCount;) {
    if (speech[i]) {
      const from = i
      while (i < frameCount && speech[i]) i++
      intervals.push([from / 100, i / 100])
    } else i++
  }
  return intervals
}

export function speechOnsets(intervals) {
  return intervals.map(([from]) => from)
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 占比估计：累计发音字符占总量之比 → 语音活跃时间上的对应时刻。 */
export function estimateStarts(cues, intervals) {
  const totalSpeech = intervals.reduce((acc, [from, to]) => acc + (to - from), 0)
  if (!(totalSpeech > 1)) return null
  const weights = cues.map((c) => Math.max(1, pronouncedChars(c.text)))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const starts = []
  let consumed = 0
  for (let i = 0; i < cues.length; i++) {
    const target = (consumed / totalWeight) * totalSpeech
    let acc = 0
    let wall = intervals.at(-1)[1]
    for (const [from, to] of intervals) {
      const span = to - from
      if (acc + span >= target) { wall = from + (target - acc); break }
      acc += span
    }
    starts.push(wall)
    consumed += weights[i]
  }
  return starts
}

/** 吸附到语音起始点（字幕比声音提前 lead 秒出现），并保证单调、最小间隔。 */
export function snapStarts(starts, intervals, { audioDuration, lead = 0.10, snapWindow = 0.55, minGap = 0.35 } = {}) {
  const onsets = speechOnsets(intervals)
  const speechEnd = intervals.length ? intervals.at(-1)[1] : (audioDuration || 0)
  const out = []
  for (let i = 0; i < starts.length; i++) {
    let t = starts[i]
    let best = null
    let bestDistance = snapWindow
    for (const onset of onsets) {
      if (onset < t - snapWindow) continue
      if (onset > t + snapWindow) break
      const distance = Math.abs(onset - t)
      if (distance < bestDistance) { bestDistance = distance; best = onset }
    }
    if (best !== null) t = best - lead
    if (out.length && t < out.at(-1) + minGap) t = out.at(-1) + minGap
    // 钳制上限必须是最后一段语音的结束，而不是音频时长：minGap 级联会把尾部 cue
    // 的开始推到音频尽头（2026-10-02 实测推到 380.68s），而末条 cue 的结束被语音
    // 区间封顶，结束于是早于开始，整份 SRT 在提交校验时被判死。
    out.push(clamp(t, 0, Math.max(0, Math.min(audioDuration || speechEnd, speechEnd))))
  }
  return out
}

export function driftStats(a, b) {
  let sum = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    sum += d
    if (d > max) max = d
  }
  return { mean: a.length ? sum / a.length : 0, max, count: a.length }
}

const isSuspicious = (stats) => stats.mean > SUSPICION_MEAN

/** 原始 SRT 在锚点 cue 上与锚点实测的偏差：定罪依据，绕开占比模型自身误差。 */
function anchorDeviationStats(originalStarts, anchors) {
  const a = []
  const b = []
  for (const [idx, time] of anchors) {
    a.push(originalStarts[idx - 1])
    b.push(time)
  }
  return driftStats(a, b)
}

/** 锚点校正：在锚点 cue 处把估计值拉到实测值，锚点之间按 cue 序号线性插值。 */
export function applyAnchorCorrections(estimate, anchors) {
  const indices = [...anchors.keys()].sort((a, b) => a - b)
  if (!indices.length) return estimate.slice()
  const correctionAt = (idx) => {
    if (idx <= indices[0]) return anchors.get(indices[0]) - estimate[indices[0] - 1]
    if (idx >= indices.at(-1)) return anchors.get(indices.at(-1)) - estimate[indices.at(-1) - 1]
    let i = 0
    while (indices[i + 1] < idx) i++
    const lo = indices[i]
    const hi = indices[i + 1]
    const c0 = anchors.get(lo) - estimate[lo - 1]
    const c1 = anchors.get(hi) - estimate[hi - 1]
    return c0 + (c1 - c0) * ((idx - lo) / (hi - lo))
  }
  return estimate.map((_, i) => estimate[i] + correctionAt(i + 1))
}

/** 只保留 CJK：ASR 会把数字/英文转写成汉字（200→二百），签名比对必须绕开。 */
export function cjkSignature(text) {
  return (String(text).match(/[\u4e00-\u9fff]/g) || []).join('')
}

/**
 * 规划锚点抽窗：全片均匀取若干 12 秒窗，窗心对准占比估计的 cue 位置。
 *
 * 锚点密度直接决定修正精度：`applyAnchorCorrections` 只在锚点之间做线性插值，
 * 锚点之外则平推端点修正量。原先全片只取 6-12 个（约每 45s 一个），一段 460s
 * 的口播在锚点之间仍有 2-3s 的残余误差（2026-10-01《牡丹亭》实测均值 2.67s）。
 * 占比模型本身有 ~3s 固有误差，所以锚点越密越准；本地 ASR 单窗约 1-2s，
 * 24 个窗仍在可接受范围内。
 */
export function planAnchorWindows(cues, estimate, audioDuration) {
  const count = clamp(Math.round(audioDuration / 20), 6, 24)
  const windows = []
  for (let i = 0; i < count; i++) {
    const idx = clamp(Math.round(((i + 0.5) / count) * cues.length), 1, cues.length)
    const center = estimate[idx - 1]
    const from = clamp(center - 4.5, 0, Math.max(0, audioDuration - ASR_WINDOW_SECONDS))
    windows.push({ cueIndex: idx, from, to: Math.min(audioDuration, from + ASR_WINDOW_SECONDS) })
  }
  return windows.sort((a, b) => a.from - b.from)
}

/** 从一窗转写里找可锚定的 cue：CJK 签名子串匹配，锚窗内中间那条命中 cue。 */
export function anchorFromTranscript({ transcript, cues, window, intervals, minCueIndex }) {
  const transcriptSig = cjkSignature(transcript)
  if (transcriptSig.length < 4) return null
  const matched = []
  let misses = 0
  for (let idx = Math.max(1, minCueIndex); idx <= cues.length; idx++) {
    const sig = cjkSignature(cues[idx - 1].text)
    if (sig.length < 4) continue
    let pos = transcriptSig.indexOf(sig)
    let sigLen = sig.length
    if (pos < 0 && sig.length >= 8) {
      // ASR 可能把数字转成汉字（cue「200 美元」→ 转写「二百美元」），把完整签名从中间切断。
      // 退而用后半段签名匹配：命中位置对应 cue 的中点，时间估计按半长折算。
      const tail = sig.slice(Math.ceil(sig.length / 2))
      pos = transcriptSig.indexOf(tail)
      sigLen = tail.length
    }
    if (pos >= 0) { matched.push({ idx, pos, sigLen }); misses = 0 } else if (matched.length && ++misses > 3) break
  }
  if (!matched.length) return null
  const span = window.to - window.from
  const timeAt = (pos, length) => window.from + clamp((pos + length / 2) / transcriptSig.length, 0, 1) * span
  const middle = matched[Math.floor(matched.length / 2)]
  let time = timeAt(middle.pos, middle.sigLen)
  time = snapToNearestOnset(time, intervals, 0.9)
  const anchors = new Map([[middle.idx, time]])
  if (matched.length >= 3) {
    const first = matched[0]
    anchors.set(first.idx, snapToNearestOnset(timeAt(first.pos, first.sigLen), intervals, 0.9))
  }
  return anchors
}

function snapToNearestOnset(time, intervals, window) {
  let best = null
  let bestDistance = window
  for (const [from] of intervals) {
    if (from < time - window) continue
    if (from > time + window) break
    const distance = Math.abs(from - time)
    if (distance < bestDistance) { bestDistance = distance; best = from }
  }
  return best === null ? time : best
}

// ---------- 本地 ASR（ComfyUI Qwen3-ASR，与桥接本地模式同款节点） ----------

export async function transcribeWavViaComfyUI({ baseUrl, wav, fetchImpl = fetch, signal, model = 'Qwen3-ASR-1.7B', language = 'Chinese' }) {
  const form = new FormData()
  form.append('image', new Blob([wav], { type: 'audio/wav' }), `align_${Date.now()}.wav`)
  form.append('overwrite', 'true')
  const uploaded = await (await fetchImpl(`${baseUrl}/upload/image`, { method: 'POST', body: form, signal })).json()
  if (!uploaded?.name) throw new Error(`ComfyUI 音频上传失败：${JSON.stringify(uploaded).slice(0, 200)}`)
  const workflow = {
    '1': { class_type: 'LoadAudio', inputs: { audio: uploaded.name } },
    '2': { class_type: 'Qwen3ASRLoader', inputs: { model_name: model } },
    '3': { class_type: 'Qwen3ASRTranscribe', inputs: { model: ['2', 0], audio: ['1', 0], language } },
    '4': { class_type: 'easy showAnything', inputs: { anything: ['3', 0] } },
  }
  const prompted = await (await fetchImpl(`${baseUrl}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: 'lwb-subtitle-align' }), signal })).json()
  if (prompted?.error || (prompted?.node_errors && Object.keys(prompted.node_errors).length)) throw new Error(`ComfyUI 工作流被拒绝：${JSON.stringify(prompted).slice(0, 200)}`)
  const promptId = prompted?.prompt_id
  if (!promptId) throw new Error('ComfyUI 没有返回任务标识。')
  const started = Date.now()
  for (;;) {
    if (signal?.aborted) throw new Error('已取消。')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const history = await (await fetchImpl(`${baseUrl}/history/${promptId}`, { signal })).json()
    const entry = history?.[promptId]
    if (!entry) continue
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI 执行失败。')
    if (entry.status?.status_str === 'success' && entry.outputs && Object.keys(entry.outputs).length) {
      const found = []
      for (const output of Object.values(entry.outputs)) {
        for (const key of ['string', 'text', 'strings', 'transcript', 'result']) {
          const value = output[key]
          if (typeof value === 'string' && value.trim()) found.push(value.trim())
          else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && item.trim()) found.push(item.trim())
        }
      }
      if (!found.length) throw new Error('ComfyUI 输出里没有文本。')
      return found.sort((a, b) => b.length - a.length)[0]
    }
    if (Date.now() - started > ASR_TIMEOUT_MS) throw new Error('本地 ASR 超时。')
  }
}

async function comfyUiAvailable(baseUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

// ---------- 音频解码与抽窗 ----------

export async function decodePcmMono8k(audioPath, { signal } = {}) {
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { signal, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' })
  const pcm = new Float32Array(stdout.length / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = stdout.readInt16LE(i * 2) / 32768
  return pcm
}

async function cutWindowWav(audioPath, from, to, outPath, { signal } = {}) {
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', audioPath, '-ac', '1', '-ar', '24000', outPath], { signal, maxBuffer: 1024 * 1024 })
  return readFile(outPath)
}

// ---------- 守卫主流程 ----------

/**
 * 校验 ASR 字幕时间轴是否忠于音频；漂移成立时返回修正后的 SRT。
 * 返回 { srt, applied, guard }，guard 为 diagnostics 记录。任何异常都降级放行。
 * decodePcm/transcribe/probeAvailable 供测试注入。
 */
/**
 * 纯决策：给定 cue、语音区间与（可选的）锚点实测，判定时间轴是否漂移并给出修正。
 * 锚点 key 为 cue 的位置序号（1 起）。测试直接注入锚点，不必经过 ASR。
 */
export function assessAndCorrect({ cues, intervals, audioDuration, anchors = new Map() }) {
  const estimate = estimateStarts(cues, intervals)
  if (!estimate) return { srt: serializeSrt(cues), applied: false, guard: { verdict: 'not-assessed', applied: false, method: 'none', reason: '语音区间过短，无法建立对齐。', cueCount: cues.length } }
  const estimateSnapped = snapStarts(estimate, intervals, { audioDuration })
  const original = cues.map((c) => c.start)
  const suspicion = driftStats(original, estimateSnapped)
  if (!isSuspicious(suspicion)) {
    return { srt: serializeSrt(cues), applied: false, guard: { verdict: 'healthy', applied: false, method: 'none', suspicion, anchorSource: 'skipped', reason: '字幕时间轴与语音分布一致，未启用修正。', cueCount: cues.length } }
  }
  const aligned = (corrected, extra) => {
    // 末条 cue 的结束同样必须不早于开始：语音封顶值可能小于吸附后的开始。
    const lastSpeechEnd = intervals.length ? intervals.at(-1)[1] : audioDuration
    const aligned = cues.map((c, i) => ({ ...c, start: corrected[i], end: i < cues.length - 1 ? Math.max(corrected[i] + 0.45, corrected[i + 1] - 0.06) : Math.max(corrected[i] + 0.45, Math.min(audioDuration, lastSpeechEnd + 0.5)) }))
    return { srt: serializeSrt(aligned), applied: true, guard: extra }
  }
  if (anchors.size >= MIN_ANCHORS) {
    const deviation = anchorDeviationStats(original, anchors)
    if (deviation.mean > ANCHOR_DEVIATION_MEAN || deviation.max > ANCHOR_DEVIATION_MAX) {
      const corrected = snapStarts(applyAnchorCorrections(estimateSnapped, anchors), intervals, { audioDuration })
      const adoptedDrift = driftStats(original, corrected)
      return aligned(corrected, { verdict: 'corrected', applied: true, method: 'vad+asr-anchors', suspicion, anchorDeviation: deviation, adoptedDrift, anchorCount: anchors.size, cueCount: cues.length, reason: `字幕时间轴与锚点实测平均偏差 ${deviation.mean.toFixed(2)}s（最大 ${deviation.max.toFixed(2)}s），已按音频重对齐。` })
    }
    return { srt: serializeSrt(cues), applied: false, guard: { verdict: 'healthy', applied: false, method: 'vad+asr-anchors', suspicion, anchorDeviation: deviation, anchorCount: anchors.size, cueCount: cues.length, reason: `锚点实测确认时间轴与语音一致（平均偏差 ${deviation.mean.toFixed(2)}s），保持原样。` } }
  }
  if (suspicion.mean > ADOPT_WITHOUT_ANCHORS_MEAN) {
    const adoptedDrift = driftStats(original, estimateSnapped)
    return aligned(estimateSnapped, { verdict: 'corrected', applied: true, method: 'vad', suspicion, adoptedDrift, anchorCount: 0, cueCount: cues.length, reason: `字幕时间轴严重偏离语音（平均 ${adoptedDrift.mean.toFixed(2)}s），本地 ASR 不可用，已按语音能量分布重对齐（无锚点，精度有限）。` })
  }
  return { srt: serializeSrt(cues), applied: false, guard: { verdict: 'unverified', applied: false, method: 'none', suspicion, anchorCount: anchors.size, cueCount: cues.length, reason: '存在疑点但本地 ASR 不可用，无法核实；漂移未达无锚点采纳阈值，保持原样。' } }
}

export async function guardSubtitleTimeline({ audioPath, srt, language = 'zh', fetchImpl = fetch, asrBaseUrl = process.env.LWB_SUBTITLE_ALIGN_ASR_URL ?? 'http://127.0.0.1:8188', asrModel = process.env.LWB_SUBTITLE_ALIGN_ASR_MODEL || 'Qwen3-ASR-1.7B', signal, log, decodePcm = decodePcmMono8k, transcribe = transcribeWavViaComfyUI, probeAvailable = comfyUiAvailable, cutWindow = cutWindowWav } = {}) {
  const run = async () => {
    const cues = parseSrt(srt)
    if (cues.length < 6) return { srt, applied: false, guard: { verdict: 'not-assessed', applied: false, method: 'none', reason: `cue 数过少（${cues.length}），跳过对齐校验。`, cueCount: cues.length } }
    const pcm = await decodePcm(audioPath, { signal })
    const audioDuration = pcm.length / 8000
    const intervals = speechIntervalsFromPcm(pcm)
    if (!intervals.length) return { srt, applied: false, guard: { verdict: 'not-assessed', applied: false, method: 'none', reason: '音频里没有检测到语音活动，跳过对齐校验。', cueCount: cues.length } }
    // 有疑点才升级到本地 ASR 抽窗锚定；healthy/无锚点的决策都在 assessAndCorrect 里。
    const quick = assessAndCorrect({ cues, intervals, audioDuration })
    if (quick.guard.verdict === 'healthy' || quick.guard.verdict === 'not-assessed') return { srt, applied: false, guard: quick.guard }
    const anchors = new Map()
    let anchorSource = 'unavailable'
    if (asrBaseUrl && await probeAvailable(asrBaseUrl, fetchImpl)) {
      anchorSource = 'comfyui'
      const estimate = estimateStarts(cues, intervals)
      const windows = planAnchorWindows(cues, snapStarts(estimate, intervals, { audioDuration }), audioDuration)
      const dir = await mkdtemp(join(tmpdir(), 'lwb-align-'))
      try {
        for (const window of windows) {
          // 上限按「每窗最多 2 个锚点」给足，避免锚点预算在片头就被吃光。
          //
          // 原先硬编码 16，配合 minCueIndex 的单调推进（每个锚点只能落在已锚定 cue
          // 之后），预算会在视频中段就耗尽：实测 134 条 cue 的片子只锚到 #79，
          // 后 55 条（正是漂移最严重的尾部，用户报的 5:02 处）从未被验证，
          // 于是整体判 healthy 放行。
          if (anchors.size >= windows.length * 2) break
          try {
            const wav = await cutWindow(audioPath, window.from, window.to, join(dir, `win-${Math.round(window.from * 1000)}.wav`), { signal })
            const transcript = await transcribe({ baseUrl: asrBaseUrl, wav, fetchImpl, signal, model: asrModel, language: language.startsWith('en') ? 'English' : language.startsWith('yue') ? 'Cantonese' : language.startsWith('ja') ? 'Japanese' : 'Chinese' })
            // minCueIndex 只用于「同一窗内避免把一条 cue 锚到更早的重复句」，不能跨窗单调递增：
            // 每个窗本来就对准它自己那一段 cue（planAnchorWindows 按 cueIndex 均匀取样），
            // 全局单调会让靠后的窗找不到任何可锚定的 cue，尾部于是永远不被验证。
            const windowStart = Math.max(1, window.cueIndex - 8)
            const found = anchorFromTranscript({ transcript, cues, window, intervals, minCueIndex: windowStart })
            if (found) for (const [idx, time] of found) if (!anchors.has(idx)) anchors.set(idx, time)
          } catch (error) {
            log?.(`对齐锚点窗口 ${window.from.toFixed(1)}s 失败：${error?.message || error}`)
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    const result = assessAndCorrect({ cues, intervals, audioDuration, anchors })
    if (anchors.size) result.guard.anchorSource = anchorSource
    return result
  }
  try {
    return await run()
  } catch (error) {
    return { srt, applied: false, guard: { verdict: 'error', applied: false, method: 'none', reason: `对齐校验未执行：${error?.message || error}` } }
  }
}
