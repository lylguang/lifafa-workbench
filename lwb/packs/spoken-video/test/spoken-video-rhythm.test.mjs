import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  countCaptionLines,
  measureCaptionLength,
  measureNarrativeRhythm,
  measureSceneTimeline,
} from '../spoken-video-rhythm.mjs'

test('measures caption length with Chinese counted per character and English per word', () => {
  assert.equal(measureCaptionLength('数据质量').chars, 4)
  assert.equal(measureCaptionLength('').chars, 0)
  assert.equal(measureCaptionLength('   ').chars, 0)
  // 三个英文单词折算 1.5 字，向上取整为 2
  assert.equal(measureCaptionLength('use GPT now').chars, 2)
  // 中英混排：6 个汉字 + 2 个词（各 0.5→1）
  assert.equal(measureCaptionLength('我用 GPT 写作').chars, 5)
})

test('counts caption lines against the 28-character guideline', () => {
  assert.equal(countCaptionLines('短句一行就够了'), 1)
  // 30 个汉字在横屏需要两行
  assert.equal(countCaptionLines('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'), 2)
  // 60 个汉字需要三行——超配额
  const long = '一二三四五六七八九十'.repeat(6)
  assert.equal(countCaptionLines(long), 3)
})

test('parses the one SCENES shape the sampler can read and ignores the rest', () => {
  const source = `
const SCENES = [
  { id: "s01-hook", start: 0, end: 12.5 },
  { id: "s02-body", start: 12.5, end: 30 },
  { id: "s03-outro", start: 30, end: 38.86 },
];
`
  const timeline = measureSceneTimeline(source)
  assert.equal(timeline.sceneCount, 3)
  assert.equal(timeline.firstSceneStartSeconds, 0)
  assert.equal(timeline.longestSceneSeconds, 17.5)
  assert.equal(timeline.averageSceneSeconds, 12.95)
  assert.equal(timeline.totalSeconds, 38.86)
})

test('refuses to guess when the SCENES table uses an unreadable shape', () => {
  // 帧数 + dur 代替 end + 展开运算符：解析器读不出来，必须返回 null 而不是瞎猜
  const source = `
const SCENES = [
  { name: "hook", start: F(3.34), dur: 240 },
  ...SC.extra,
];
`
  assert.equal(measureSceneTimeline(source), null)
  assert.equal(measureSceneTimeline('const nothing = 1'), null)
  assert.equal(measureSceneTimeline(''), null)
})

test('skips malformed scenes but keeps the readable ones', () => {
  const source = `
const SCENES = [
  { id: "good", start: 0, end: 10 },
  { id: "reversed", start: 20, end: 5 },
  { id: "also-good", start: 10, end: 22 },
];
`
  const timeline = measureSceneTimeline(source)
  assert.equal(timeline.sceneCount, 2)
  assert.equal(timeline.scenes.map((scene) => scene.id).join(','), 'good,also-good')
})

test('reports rhythm without a scene timeline instead of failing', () => {
  const cues = [
    { startMs: 0, endMs: 2600, text: '先说结论' },
    { startMs: 2700, endMs: 5200, text: '数据质量决定上限' },
    { startMs: 5300, endMs: 9000, text: '这跟模型能力关系不大' },
  ]
  const rhythm = measureNarrativeRhythm({ sceneTimeline: null, cues, durationSeconds: 60 })
  assert.equal(rhythm.scenes, null)
  assert.equal(rhythm.subtitles.cueCount, 3)
  assert.equal(rhythm.hook.cueCount, 2)
})

test('counts leading silence as silence rather than as an empty opening', () => {
  // 首 cue 起点 3.34 秒：前 3.34 秒是配音前导静音，不是空白片头
  const source = `const SCENES = [ { id: "s01", start: 3.34, end: 38.86 } ];`
  const cues = [{ startMs: 3340, endMs: 5810, text: '先说结论' }]
  const rhythm = measureNarrativeRhythm({ sceneTimeline: measureSceneTimeline(source), cues, durationSeconds: 468.5 })

  assert.equal(rhythm.leadSilenceSeconds, 3.34)
  // 钩子窗口从 3.34 起算 3 秒，落在窗口内的 cue 仍然被抓到
  assert.equal(rhythm.hook.cueCount, 1)
  assert.equal(rhythm.hook.silentHook, false)
  // 有发言就不是静默开场
  assert.ok(rhythm.hook.charsPerSpeechSecond > 0)
})

test('flags a genuinely silent opening', () => {
  const source = `const SCENES = [ { id: "s01", start: 0, end: 40 } ];`
  const rhythm = measureNarrativeRhythm({
    sceneTimeline: measureSceneTimeline(source),
    cues: [{ startMs: 12000, endMs: 15000, text: '很久之后才开口' }],
    durationSeconds: 60,
  })
  assert.equal(rhythm.hook.cueCount, 0)
  assert.equal(rhythm.hook.silentHook, true)
})

test('records the longest scene so the caller can flag a static stretch', () => {
  const source = `
const SCENES = [
  { id: "quick", start: 0, end: 9 },
  { id: "long", start: 9, end: 69 },
  { id: "tail", start: 69, end: 80 },
];
`
  const rhythm = measureNarrativeRhythm({ sceneTimeline: measureSceneTimeline(source), cues: [], durationSeconds: 80 })
  assert.equal(rhythm.scenes.longestSceneSeconds, 60)
  assert.equal(rhythm.scenes.longestSceneId, 'long')
})

test('reports subtitle line compliance including the failures', () => {
  const cues = [
    { startMs: 0, endMs: 2000, text: '短' },
    { startMs: 2100, endMs: 4000, text: '中等长度的字幕内容' },
    { startMs: 4100, endMs: 6000, text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' },
  ]
  const rhythm = measureNarrativeRhythm({ sceneTimeline: null, cues, durationSeconds: 30, orientation: 'landscape' })
  assert.equal(rhythm.subtitles.cueCount, 3)
  assert.equal(rhythm.subtitles.overTwoLines, 0)
  assert.equal(rhythm.subtitles.maxLines, 2)
  assert.equal(rhythm.subtitles.twoLineComplianceRate, 1)
})
// ---------------------------------------------------------------------------
// 闸门接入：buildTechnicalReport 必须真的用上节奏指标，且不因为「测不了」而拦截
// ---------------------------------------------------------------------------

test('QC stays green when rhythm inputs are absent', async () => {
  const { buildTechnicalReport } = await import('../spoken-video-media.mjs')
  const report = buildTechnicalReport({
    video: { durationSeconds: 60, width: 1080, height: 1920, fps: 30, hasAudio: true },
    audio: { durationSeconds: 60 },
    subtitles: { cueCount: 10 },
    orientation: 'portrait',
  })
  // 没有 cues / sceneSource：指标缺失，但绝不能因此拦住发布
  assert.equal(report.rhythm, null)
  assert.equal(report.passed, true)
})

test('QC fails a genuinely silent opening but passes one with lead-in silence', async () => {
  const { buildTechnicalReport } = await import('../spoken-video-media.mjs')
  const base = {
    video: { durationSeconds: 60, width: 1080, height: 1920, fps: 30, hasAudio: true },
    audio: { durationSeconds: 60 },
    subtitles: { cueCount: 3 },
    orientation: 'portrait',
  }

  const silent = buildTechnicalReport({
    ...base,
    cues: [{ startMs: 30000, endMs: 33000, text: '太晚才开口' }],
    sceneSource: 'const SCENES=[{id:"a",start:0,end:60}]',
  })
  assert.equal(silent.passed, false)
  assert.ok(silent.issues.some((issue) => issue.includes('前 3 秒')))

  // 首 cue 从 3.34 秒开始：那是配音前导静音，不是空白片头，不该拦
  const leadIn = buildTechnicalReport({
    ...base,
    cues: [{ startMs: 3340, endMs: 5810, text: '先说结论' }],
    sceneSource: 'const SCENES=[{id:"a",start:3.34,end:60}]',
  })
  assert.equal(leadIn.passed, true)
  assert.equal(leadIn.issues.length, 0)
})

test('an overlong scene warns without blocking release', async () => {
  const { buildTechnicalReport } = await import('../spoken-video-media.mjs')
  const report = buildTechnicalReport({
    video: { durationSeconds: 60, width: 1920, height: 1080, fps: 30, hasAudio: true },
    audio: { durationSeconds: 60 },
    subtitles: { cueCount: 3 },
    orientation: 'landscape',
    cues: [{ startMs: 0, endMs: 2000, text: '开场' }],
    sceneSource: 'const SCENES=[{id:"long",start:0,end:58},{id:"tail",start:58,end:60}]',
  })
  assert.equal(report.passed, true, '超长场景是「值得再看一眼」，不是「片子不能用」')
  assert.ok(report.warnings.some((warning) => warning.includes('最长场景')))
})

test('rhythm thresholds can be tightened per project', async () => {
  const { buildTechnicalReport } = await import('../spoken-video-media.mjs')
  const args = {
    video: { durationSeconds: 60, width: 1920, height: 1080, fps: 30, hasAudio: true },
    audio: { durationSeconds: 60 },
    subtitles: { cueCount: 3 },
    orientation: 'landscape',
    cues: [{ startMs: 0, endMs: 2000, text: '开场' }],
    sceneSource: 'const SCENES=[{id:"mid",start:0,end:25},{id:"tail",start:25,end:30}]',
  }
  const relaxed = buildTechnicalReport(args)
  assert.equal(relaxed.warnings.length, 0)

  const strict = buildTechnicalReport({ ...args, rhythmThresholds: { longestSceneSeconds: 20, minAverageSceneSeconds: 4, maxOverTwoLinesRatio: 0.25 } })
  assert.ok(strict.warnings.some((warning) => warning.includes('最长场景')))
})
