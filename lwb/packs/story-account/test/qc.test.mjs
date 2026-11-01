import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTechnicalReport, mergeReview, finalGate, runIndependentReview, extractReviewFrames, STORY_VIDEO_SPEC, STORY_REVIEW_SCHEMA } from '../story-account-qc.mjs'
import { parseSrt, validateSrt, serializeSrt, splitLongCues, cueChars, srtMaxLineChars } from '../story-account-subtitles.mjs'
import { normalizePackage, shortenCoverHeadline, STORY_PACKAGE_SCHEMA, COVER_HEADLINE_MAX } from '../story-account-publish.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { useRoomyTempScratch } from '../../../test-utils/scratch-temp.mjs'

// 真实抽帧用例会用 ffmpeg 造成片并抽帧，工作区建在 os.tmpdir() 上。`node --test` 不经过
// lwb/dsh-launcher.mjs，系统盘快满的机器上并发写会直接把 ffmpeg 崩掉（本机实测退出码
// 0xDFABA7BB）。选址口径与 launcher 一致，理由见 ../../../test-utils/scratch-temp.mjs。
useRoomyTempScratch()

function ffmpegAvailable() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}

const GOOD_VIDEO = { durationSeconds: 66, width: 1080, height: 1920, fps: 30, hasAudio: true }

function goodTechnical(overrides = {}) {
  return buildTechnicalReport({
    video: { ...GOOD_VIDEO, ...(overrides.video || {}) },
    audio: { durationSeconds: overrides.audioDuration ?? 66 },
    subtitles: { cueCount: overrides.cueCount ?? 30, maxCueChars: overrides.maxCueChars ?? 14 },
    subtitleEnabled: overrides.subtitleEnabled !== false,
  })
}

/* -------------------------------- 技术闸门 -------------------------------- */

test('合格规格通过技术质检', () => {
  assert.equal(goodTechnical().passed, true)
})

test('分辨率不符时拦截', () => {
  const report = goodTechnical({ video: { width: 1920, height: 1080 } })
  assert.equal(report.passed, false)
  assert.ok(report.issues.some((item) => item.includes('1080x1920')))
})

test('帧率不符时拦截', () => {
  const report = goodTechnical({ video: { fps: 25 } })
  assert.ok(report.issues.some((item) => item.includes('30fps')))
})

test('缺音轨时拦截', () => {
  const report = goodTechnical({ video: { hasAudio: false } })
  assert.ok(report.issues.some((item) => item.includes('音轨')))
})

test('音画时长差超过 2 秒时拦截', () => {
  const report = goodTechnical({ audioDuration: 70 })
  assert.ok(report.issues.some((item) => item.includes('时长差')))
})

test('没有字幕时拦截', () => {
  const report = goodTechnical({ cueCount: 0 })
  assert.ok(report.issues.some((item) => item.includes('字幕')))
})

test('字幕过长只警告不拦截', () => {
  const report = goodTechnical({ maxCueChars: 52 })
  assert.equal(report.passed, true)
  assert.ok(report.warnings.some((item) => item.includes('字幕')))
})

test('规格常量就是平台要求', () => {
  assert.equal(STORY_VIDEO_SPEC.width, 1080)
  assert.equal(STORY_VIDEO_SPEC.height, 1920)
  assert.equal(STORY_VIDEO_SPEC.fps, 30)
})

/* --------------------------------- 审片闸门 -------------------------------- */

function review(overrides = {}) {
  return {
    passed: true,
    technicalPass: true,
    editorialPass: true,
    score: 82,
    summary: '开场对白直接进入冲突，画面在全片内有推进，字幕没有压脸。',
    findings: [],
    reviewEvidence: [
      { timestampSeconds: 3, observedMainVisual: '厨房近景，人物手部与碗，暖黄灯光' },
      { timestampSeconds: 40, observedMainVisual: '饭桌对面空椅子，字幕落在下半屏安全区内' },
    ],
    ...overrides,
  }
}

test('技术闸门与审片同时通过才算通过', () => {
  const merged = mergeReview(review(), { technicalReport: goodTechnical(), sampledTimestamps: [3, 40] })
  assert.equal(merged.passed, true)
  assert.equal(merged.evidencePassed, true)
})

test('技术不通过时无论审片怎么说都不通过', () => {
  const failed = goodTechnical({ video: { fps: 25 } })
  const merged = mergeReview(review(), { technicalReport: failed, sampledTimestamps: [3, 40] })
  assert.equal(merged.passed, false)
  assert.equal(merged.technicalPass, false)
})

test('存在 blocker 时审片不通过', () => {
  const merged = mergeReview(review({ findings: [{ severity: 'blocker', category: 'pacing', timestampSeconds: 3, message: '前 3 秒是空镜' }] }), { technicalReport: goodTechnical(), sampledTimestamps: [3, 40] })
  assert.equal(merged.editorialPass, false)
  assert.equal(merged.passed, false)
})

test('证据不足两个不同时间点时判证据不足', () => {
  const merged = mergeReview(review({ reviewEvidence: [{ timestampSeconds: 3, observedMainVisual: '厨房近景，人物手部与碗，暖黄灯光' }] }), { technicalReport: goodTechnical(), sampledTimestamps: [3, 40] })
  assert.equal(merged.evidencePassed, false)
  assert.equal(merged.passed, false)
})

test('证据时间点吸附到实际抽帧时刻', () => {
  const merged = mergeReview(review({ reviewEvidence: [{ timestampSeconds: 3.4, observedMainVisual: '厨房近景，人物手部与碗，暖黄灯光' }, { timestampSeconds: 39.6, observedMainVisual: '饭桌对面空椅子，字幕落在下半屏安全区内' }] }), { technicalReport: goodTechnical(), sampledTimestamps: [3, 40] })
  assert.deepEqual(merged.reviewEvidence.map((item) => item.timestampSeconds), [3, 40])
  assert.equal(merged.passed, true)
})

test('分数不足 70 时不通过', () => {
  const merged = mergeReview(review({ score: 55 }), { technicalReport: goodTechnical(), sampledTimestamps: [3, 40] })
  assert.equal(merged.passed, false)
})

test('审片证据里过短的描述被丢弃', () => {
  const merged = mergeReview(review({ reviewEvidence: [{ timestampSeconds: 3, observedMainVisual: '厨房' }, { timestampSeconds: 40, observedMainVisual: '饭桌对面空椅子，字幕落在下半屏安全区内' }] }), { technicalReport: goodTechnical(), sampledTimestamps: [3, 40] })
  assert.equal(merged.evidencePassed, false)
})

test('审片 schema 可被断言为对象 schema', () => {
  assert.equal(STORY_REVIEW_SCHEMA.type, 'object')
  assert.ok(STORY_REVIEW_SCHEMA.required.includes('reviewEvidence'))
})

/* --------------------------------- 最终闸门 -------------------------------- */

test('finalGate 汇总三道条件', () => {
  const technical = goodTechnical()
  const merged = mergeReview(review(), { technicalReport: technical, sampledTimestamps: [3, 40] })
  assert.equal(finalGate({ technicalReport: technical, review: merged }).passed, true)
  const blocked = finalGate({ technicalReport: technical, review: merged, antiPlastic: { passed: false, blocking: ['结尾出现升华句'] } })
  assert.equal(blocked.passed, false)
  assert.ok(blocked.blockers.some((item) => item.includes('升华')))
})

test('finalGate 缺少审片报告时不通过', () => {
  assert.equal(finalGate({ technicalReport: goodTechnical(), review: null }).passed, false)
})

/* ---------------------------------- 字幕 ---------------------------------- */

const SRT = `1
00:00:00,000 --> 00:00:02,400
「妈，锅里的鱼你吃吧，我不饿。」

2
00:00:02,400 --> 00:00:05,000
年初三晚上，我在厨房说完这句。`

test('parseSrt 解析条目', () => {
  const { cues, errors } = parseSrt(SRT)
  assert.equal(errors.length, 0)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].durationMs, 2400)
})

test('parseSrt 报告结构性错误', () => {
  const { errors } = parseSrt(`not srt at all`)
  assert.ok(errors.length > 0)
})

test('validateSrt 给出条数与最长字数', () => {
  const result = validateSrt(SRT)
  assert.equal(result.cueCount, 2)
  assert.ok(result.maxCueChars > 0)
  assert.equal(result.maxLineChars, 16)
})

test('竖屏单行上限比横屏窄', () => {
  assert.ok(srtMaxLineChars('portrait') < srtMaxLineChars('landscape'))
})

test('serializeSrt 往返一致', () => {
  const { cues } = parseSrt(SRT)
  const round = parseSrt(serializeSrt(cues))
  assert.equal(round.cues.length, cues.length)
  assert.equal(round.cues[1].startMs, cues[1].startMs)
})

test('cueChars 中英混排按视觉宽度折算', () => {
  assert.equal(cueChars('你好'), 2)
  // 一个英文单词按半个汉字宽折算，向上取整：视觉上约等于一个汉字。
  assert.equal(cueChars('hello'), 1)
  assert.equal(cueChars('hello world'), 1)
  assert.equal(cueChars('你好 hello'), 3)
})

test('splitLongCues 切分超长条目且时间单调', () => {
  const long = `1\n00:00:00,000 --> 00:00:20,000\n${'我在厨房站了很久，水龙头一直开着。'.repeat(3)}`
  const result = splitLongCues(long)
  assert.ok(result.splitCount >= 1)
  assert.ok(result.cues.length > 1)
  for (let index = 1; index < result.cues.length; index += 1) {
    assert.ok(result.cues[index].startMs >= result.cues[index - 1].endMs)
  }
})

/* --------------------------------- 发布资料 -------------------------------- */

test('shortenCoverHeadline 保留合规长度原文', () => {
  assert.equal(shortenCoverHeadline('锅里的鱼记得吃完'), '锅里的鱼记得吃完')
})

test('shortenCoverHeadline 挑句而不是硬砍', () => {
  const result = shortenCoverHeadline('离婚那天，他给我发了一条微信，让我把锅里的鱼吃完')
  assert.ok([...result].length <= COVER_HEADLINE_MAX, result)
  assert.ok(!result.endsWith('…'))
})

test('normalizePackage 拒绝超过 30 字的标题', () => {
  assert.throws(() => normalizePackage({
    title: '一'.repeat(31),
    copy: 'c', description: 'd', tags: ['a'], coverHeadline: '封面大字', coverMood: 'm',
  }), /30 字/u)
})

test('normalizePackage 去掉标签里的井号并去重', () => {
  const result = normalizePackage({
    title: '锅里的鱼', copy: 'c', description: 'd', tags: ['#情感', '情感', '#原生家庭'],
    coverHeadline: '锅里的鱼记得吃完', coverMood: '厨房里的暖黄灯光',
  })
  assert.deepEqual(result.tags, ['情感', '原生家庭'])
})

test('normalizePackage 在缺字段时报错', () => {
  assert.throws(() => normalizePackage({ title: 't' }), /不完整/u)
})

test('发布资料 schema 要求全部字段', () => {
  assert.deepEqual([...STORY_PACKAGE_SCHEMA.required].sort(), ['copy', 'coverHeadline', 'coverMood', 'description', 'tags', 'title'])
})

test('审片：抽帧时间点全空时证据不足，闸门判不通过', () => {
  // B0：之前独立审片即使没有画面证据也能「凭文字」判通过。这里证明 empty evidence → 不通过。
  const merged = mergeReview(review(), { technicalReport: goodTechnical(), sampledTimestamps: [] })
  assert.equal(merged.passed, false)
  assert.equal(merged.evidencePassed, false)
})

test('独立审片：抽不到帧直接判不通过，绝不静默放行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-qc-noframe-'))
  const workspacePath = join(dir, 'ws')
  await mkdir(join(workspacePath, 'data'), { recursive: true })
  // 故意放一个非视频文件：ffmpeg 抽帧必然失败，没有画面证据。
  await writeFile(join(workspacePath, 'data', 'bad.bin'), Buffer.from('not a video'))
  const result = await runIndependentReview({
    reviewExecutor: async () => review(),
    workspacePath,
    videoFile: 'bad.bin',
    sampledTimestamps: [3, 40],
  })
  assert.equal(result.passed, false)
  assert.equal(result.evidencePassed, false)
  assert.ok(result.findings.some((item) => item.severity === 'blocker'), '应给出 blocker 级别的不通过原因')
})

test('独立审片：真实成片抽帧后交给子会话看图并合并证据', async (t) => {
  if (!ffmpegAvailable()) t.skip('ffmpeg 不可用，跳过真实抽帧用例')
  const dir = await mkdtemp(join(tmpdir(), 'story-qc-frame-'))
  const workspacePath = join(dir, 'ws')
  await mkdir(join(workspacePath, 'data'), { recursive: true })
  const videoFile = join(workspacePath, 'data', 'clip.mp4')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:d=2', '-pix_fmt', 'yuv420p', videoFile], { stdio: 'ignore' })
  let promptText = ''
  const result = await runIndependentReview({
    reviewExecutor: async ({ prompt }) => { promptText = prompt; return review() },
    workspacePath,
    videoFile: 'clip.mp4',
    sampledTimestamps: [0.5, 1.5],
    durationSeconds: 2,
    script: { body: '厨房里，母亲把鱼推到我面前。' },
    technicalReportFile: 'media/qc/tech.json',
  })
  assert.equal(result.passed, true, '独立审片应返回原始审片结论')
  assert.ok(promptText.includes('frame-'), '提示词应包含抽帧图片路径')
})

test('extractReviewFrames 仅抽取落在 [0,时长) 内的时间点', async (t) => {
  if (!ffmpegAvailable()) t.skip('ffmpeg 不可用，跳过')
  const dir = await mkdtemp(join(tmpdir(), 'story-qc-extract-'))
  const workspacePath = join(dir, 'ws')
  await mkdir(join(workspacePath, 'data'), { recursive: true })
  const videoFile = join(workspacePath, 'data', 'clip.mp4')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=1080x1920:d=2', '-pix_fmt', 'yuv420p', videoFile], { stdio: 'ignore' })
  const files = await extractReviewFrames({ workspacePath, videoRelative: 'clip.mp4', timestamps: [0, 999], durationSeconds: 2 })
  assert.equal(files.length, 1, '越界时间点不应抽帧')
})
