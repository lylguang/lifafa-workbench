import assert from 'node:assert/strict'
import test from 'node:test'
import {
  anchorFromTranscript,
  applyAnchorCorrections,
  assessAndCorrect,
  cjkSignature,
  driftStats,
  estimateStarts,
  guardSubtitleTimeline,
  parseSrt,
  planAnchorWindows,
  serializeSrt,
  snapStarts,
  speechIntervalsFromPcm,
} from '../spoken-video-subtitle-align.mjs'
import { validateSrt } from '../spoken-video-subtitles.mjs'

// ---------- SRT 解析/序列化 ----------

test('parseSrt 与 serializeSrt 往返一致', () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,047\nOpenAI 开发者大会那天\n\n2\n00:00:02,047 --> 00:00:06,566\nSam Altman 讲到会员调整\n'
  const cues = parseSrt(srt)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].start, 0)
  assert.equal(cues[0].end, 2.047)
  assert.equal(cues[1].text, 'Sam Altman 讲到会员调整')
  const round = parseSrt(serializeSrt(cues))
  assert.deepEqual(round.map((c) => [c.start, c.end, c.text]), cues.map((c) => [c.start, c.end, c.text]))
})

// ---------- VAD ----------

const tone = (seconds, amplitude = 0.3) => {
  const out = new Float32Array(Math.round(seconds * 8000))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((i / 8000) * 440) * amplitude
  return out
}
const silence = (seconds) => new Float32Array(Math.round(seconds * 8000))
// 大数组不能用 spread 拼接（RangeError），按位复制。
const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}

test('VAD 能从合成 PCM 里切出语音区间，句内短停顿并入', () => {
  const pcm = concat([tone(4), silence(1), tone(0.05), silence(0.05), tone(4), silence(2), tone(3)])
  const intervals = speechIntervalsFromPcm(pcm)
  assert.equal(intervals.length, 3)
  assert.ok(Math.abs(intervals[0][1] - 4) < 0.2, `第一块到 4s：${intervals[0][1]}`)
  assert.ok(Math.abs(intervals[1][0] - 5) < 0.05 && Math.abs(intervals[1][1] - 9.1) < 0.2, `0.05s 微停顿应并入：${JSON.stringify(intervals[1])}`)
  assert.ok(Math.abs(intervals[2][0] - 11.1) < 0.05)
})

test('语音占比极高时 VAD 依然工作（阈值钳到中位能量一半）', () => {
  const pcm = concat([tone(2), silence(0.3), tone(2)])
  const intervals = speechIntervalsFromPcm(pcm)
  assert.equal(intervals.length, 2)
})

test('纯静音返回空区间', () => {
  assert.deepEqual(speechIntervalsFromPcm(silence(5)), [])
})

// ---------- 占比估计 + 吸附 ----------

test('estimateStarts 把 cue 铺在语音活跃时间上，停顿被排除', () => {
  const intervals = [[0, 10], [20, 30]]
  const cues = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, text: `第${i}句话啊` }))
  const starts = estimateStarts(cues, intervals)
  assert.equal(starts.length, 10)
  assert.ok(Math.abs(starts[4] - 8) < 1, `一半内容应落在第一段语音尾部：${starts[4]}`)
  assert.ok(starts[6] >= 20, `60% 之后的内容应落到第二段语音里：${starts[6]}`)
})

test('snapStarts 吸附到语音起始点并保持单调', () => {
  const intervals = [[1, 5], [9, 20]]
  const snapped = snapStarts([0.5, 8.9, 15], intervals, { audioDuration: 20 })
  assert.equal(snapped[0], 0.9)
  assert.equal(snapped[1], 8.9)
  assert.ok(snapped[2] > snapped[1])
})

// ---------- 锚点 ----------

test('cjkSignature 去掉数字与英文，规避 ASR 的数字转写差异', () => {
  assert.equal(cjkSignature('原因很简单：200 美元那一档'), '原因很简单美元那一档')
  assert.equal(cjkSignature('Sam Altman 讲到会员调整'), '讲到会员调整')
})

test('applyAnchorCorrections 锚点处精确贴合、之间线性过渡、端外平推', () => {
  const estimate = [10, 20, 30, 40, 50]
  const anchors = new Map([[2, 25], [4, 35]])
  const corrected = applyAnchorCorrections(estimate, anchors)
  assert.equal(corrected[1], 25)
  assert.equal(corrected[3], 35)
  assert.equal(corrected[0], 15, '首锚点之前的 cue 平推首锚点校正量')
  assert.equal(corrected[4], 45, '末锚点之后的 cue 平推末锚点校正量')
  assert.ok(corrected[2] > 25 && corrected[2] < 35)
})

test('anchorFromTranscript 用 CJK 签名匹配并给出时间估计', () => {
  const cues = [
    { index: 1, text: '第一步把这一个月的事写下来' },
    { index: 2, text: '按当时你在干嘛写就行' },
    { index: 3, text: '比如周一早上写周报' },
  ]
  const transcript = '好那么第一步把这一个月的事写下来，按当时你在干嘛写就行，比如周一早上写周报之类的'
  const anchor = anchorFromTranscript({ transcript, cues, window: { from: 100, to: 112 }, intervals: [[100, 112]], minCueIndex: 1 })
  assert.ok(anchor, '应命中锚点')
  const [time] = anchor.values()
  assert.ok(time >= 100 && time <= 112)
})

test('anchorFromTranscript 对 ASR 把 200 写成二百的情况依然命中（后半段签名回退）', () => {
  const cues = [{ text: '原因很简单：200 美元那一档价格没变' }]
  const transcript = '原因很简单，二百美元那一档价格没变，'
  const anchor = anchorFromTranscript({ transcript, cues, window: { from: 5, to: 17 }, intervals: [[5, 17]], minCueIndex: 1 })
  assert.ok(anchor?.has(1), '锚点 key 是位置序号而非 cue.index')
})

test('planAnchorWindows 均匀铺满且不越界', () => {
  const cues = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, text: `句子${i}啊哈哈` }))
  const windows = planAnchorWindows(cues, cues.map((_, i) => i * 10), 200)
  assert.ok(windows.length >= 6 && windows.length <= 24)
  for (const w of windows) {
    assert.ok(w.from >= 0 && w.to <= 200 + 0.001)
    assert.ok(w.to > w.from)
  }
})

test('planAnchorWindows 按 ~20s 密度取样，长片不得把锚点预算全压在片头', () => {
  // 回归（2026-10-01《牡丹亭》）：抽窗原为 audioDuration/45 且上限 12，配合守卫里
  // minCueIndex 的单调推进，134 条 cue 的片子只锚到 #79 —— 后 55 条（漂移最重的尾部，
  // 用户报的 5:02 处）从未被验证，整体因此被误判 healthy 放行。
  const cues = Array.from({ length: 134 }, (_, i) => ({ index: i + 1, text: `第${i}句台词内容啊` }))
  const estimate = cues.map((_, i) => i * 3.43)
  const windows = planAnchorWindows(cues, estimate, 460)
  assert.ok(windows.length >= 20, `460s 的片子至少应有 20 个锚窗，实际 ${windows.length}`)
  // 锚窗必须覆盖到尾部：最后一个窗的 cueIndex 应接近末条。
  const last = windows[windows.length - 1]
  assert.ok(last.cueIndex >= cues.length * 0.85, `锚窗必须覆盖尾部，最后一个只到 #${last.cueIndex}`)
  // 且窗口在时间上跨越大半部片子。
  assert.ok(last.from > 400, `最后一个锚窗应在片尾附近，实际 ${last.from}`)
})

// ---------- 守卫决策（assessAndCorrect 纯决策，锚点直接注入） ----------

// 合成场景：60s 音频，语音块 0-12 / 14-30 / 32-58；10 句互异文本按语音分布推进。
const INTERVALS = [[0, 12], [14, 30], [32, 58]]
const TEXTS = ['今天聊订阅额度的事', '价格没变用量砍半', '上面还多出一档', '同样的钱拿到的量变少', '想要原来的量得加钱', '所以今天不聊贵不贵', '聊一件更实在的事', '这笔订阅费在买什么', '哪些根本不该占额度', '把这件事拆成三层']
// TRUTH 严格按发音字符占比铺在语音活跃时间上（与 estimateStarts 的模型一致），
// 保证「健康」场景对占比估计零偏差，决策阈值测试才成立。
const TRUTH = (() => {
  const weights = TEXTS.map((t) => (t.match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const totalSpeech = INTERVALS.reduce((n, [a, b]) => n + (b - a), 0)
  const out = []
  let consumed = 0
  for (const w of weights) {
    let target = (consumed / totalWeight) * totalSpeech
    let acc = 0
    let wall = INTERVALS.at(-1)[1]
    for (const [a, b] of INTERVALS) {
      if (acc + (b - a) >= target) { wall = a + (target - acc); break }
      acc += b - a
    }
    out.push(wall)
    consumed += w
  }
  return out
})()
const cuesFrom = (starts) => starts.map((s, i) => ({ start: s, end: s + 3, text: TEXTS[i] }))
const ANCHORS_TRUE = new Map(TRUTH.map((t, i) => [i + 1, t + (i % 2 ? 0.2 : -0.2)])) // 锚点带 ±0.2s 噪声

test('决策：健康时间轴 → 便宜检查直接放行（不消耗锚点）', () => {
  const r = assessAndCorrect({ cues: cuesFrom(TRUTH), intervals: INTERVALS, audioDuration: 60, anchors: ANCHORS_TRUE })
  assert.equal(r.applied, false)
  assert.equal(r.guard.verdict, 'healthy')
  assert.equal(r.guard.anchorSource, 'skipped')
})

test('决策：轻度漂移 + 锚点核实一致 → 锚点路径放行', () => {
  // 1.5s 漂移越过便宜检查阈值，但锚点实测（TRUTH±0.2）与漂移值只差 1.5s，
  // 在 ANCHOR_DEVIATION_MEAN(1.8) 以内 → 判健康、不改动。
  const drifted = TRUTH.map((t) => t + 1.5)
  const r = assessAndCorrect({ cues: cuesFrom(drifted), intervals: INTERVALS, audioDuration: 60, anchors: ANCHORS_TRUE })
  assert.equal(r.applied, false)
  assert.equal(r.guard.verdict, 'healthy')
  assert.equal(r.guard.method, 'vad+asr-anchors')
  assert.ok(r.guard.anchorDeviation.mean <= 1.8, `锚点偏差应在噪声底内：${r.guard.anchorDeviation.mean}`)
})

test('决策：漂移时间轴 + 锚点 → 采纳修正且贴近真值', () => {
  const drifted = TRUTH.map((t) => t + 4)
  const r = assessAndCorrect({ cues: cuesFrom(drifted), intervals: INTERVALS, audioDuration: 60, anchors: ANCHORS_TRUE })
  assert.equal(r.applied, true)
  assert.equal(r.guard.method, 'vad+asr-anchors')
  assert.ok(r.guard.anchorDeviation.mean > 1.8)
  const corrected = parseSrt(r.srt)
  assert.ok(Math.abs(corrected[0].start - TRUTH[0]) < 1.5)
  assert.ok(Math.abs(corrected[5].start - TRUTH[5]) < 2.5)
})

test('决策：漂移严重且无锚点 → 按 VAD 采纳修正', () => {
  const drifted = TRUTH.map((t) => t + 9)
  const r = assessAndCorrect({ cues: cuesFrom(drifted), intervals: INTERVALS, audioDuration: 60 })
  assert.equal(r.applied, true)
  assert.equal(r.guard.method, 'vad')
  const corrected = parseSrt(r.srt)
  assert.ok(Math.abs(corrected[0].start - TRUTH[0]) < 1.5)
})

test('决策：轻度漂移且无锚点 → 未核实放行', () => {
  const drifted = TRUTH.map((t) => t + 1.5)
  const r = assessAndCorrect({ cues: cuesFrom(drifted), intervals: INTERVALS, audioDuration: 60 })
  assert.equal(r.applied, false)
  assert.equal(r.guard.verdict, 'unverified')
})

test('决策：语音区间缺失 → not-assessed', () => {
  const r = assessAndCorrect({ cues: cuesFrom(TRUTH), intervals: [], audioDuration: 60 })
  assert.equal(r.guard.verdict, 'not-assessed')
})

// ---------- 守卫 IO 管道（解码/降级路径） ----------

test('守卫：解码失败降级为 error 且放行原 SRT', async () => {
  const result = await guardSubtitleTimeline({ audioPath: 'fixture.wav', srt: serializeSrt(cuesFrom(TRUTH)), asrBaseUrl: '', decodePcm: async () => { throw new Error('ffmpeg missing') } })
  assert.equal(result.applied, false)
  assert.equal(result.guard.verdict, 'error')
  assert.ok(result.srt.includes('今天聊订阅额度的事'))
})

test('守卫：便宜检查即健康时跳过 ASR（probe 不应被调用）', async () => {
  const pcm = concat([tone(12), silence(2), tone(16), silence(2), tone(26)])
  let probed = 0
  const result = await guardSubtitleTimeline({
    audioPath: 'fixture.wav',
    srt: serializeSrt(cuesFrom(TRUTH)),
    asrBaseUrl: 'stub://',
    decodePcm: async () => pcm,
    probeAvailable: async () => { probed++; return true },
  })
  assert.equal(result.guard.verdict, 'healthy')
  assert.equal(probed, 0, '健康路径不应触碰本地 ASR')
})

// ---------- 2026-10-02 退化回归：尾部 cue 开始被推到音频尽头，结束早于开始 ----------

test('snapStarts 不会把开始钳到音频尽头——必须落在最后一段语音结束之内', () => {
  // 复刻 20:00 自动轮：语音到 380.1s 结束，音频 380.68s；minGap 级联把尾部开始推过 380.6。
  const intervals = [[0, 100], [101, 380.1]]
  const starts = [50, 150, 250, 300, 350, 380.3, 380.65]
  const snapped = snapStarts(starts, intervals, { audioDuration: 380.68 })
  assert.equal(snapped.at(-1), 380.1, `末条开始应钳到语音结束：${snapped.at(-1)}`)
  for (const t of snapped) assert.ok(t <= 380.1 + 1e-9, `开始 ${t} 越过了最后一段语音的结束`)
})

test('守卫修正后的 SRT 不允许任何一条结束早于开始（末条锚点越界场景）', () => {
  // 末条 cue 的锚点被推到语音结束之后（58.55 > 58）：修正采纳后，末条开始曾越过其结束。
  const anchors = new Map(ANCHORS_TRUE)
  anchors.set(TEXTS.length, 58.55)
  const drifted = TRUTH.map((t) => t + 4)
  const r = assessAndCorrect({ cues: cuesFrom(drifted), intervals: INTERVALS, audioDuration: 58.58, anchors })
  assert.equal(r.applied, true, r.guard.reason)
  const checked = validateSrt(r.srt)
  assert.equal(checked.errors.length, 0, checked.errors.join(' '))
  const cues = parseSrt(r.srt)
  for (const cue of cues) assert.ok(cue.end > cue.start, `第 ${cue.index} 条结束 ${cue.end} 未晚于开始 ${cue.start}`)
})
