/**
 * 全片解码级检测的单测。
 *
 * 分两层：
 *   1. 解析器与判定是纯函数，直接喂 ffmpeg 的真实日志形状断言；
 *   2. 端到端：用 ffmpeg 真造出「全黑 / 冻结 / 静音」的片子，
 *      跑同一套 ffmpeg 检测参数，确认解析结果与判定都符合预期。
 *
 * 第二层是本文件的重点——只测正则很容易「格式猜对了、实际 ffmpeg 不这么打」。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  DEFAULT_LOCAL_QC_THRESHOLDS,
  judgeLocalQc,
  parseBlackDetect,
  parseFreezeDetect,
  parseSilenceDetect,
  parseVolumeDetect,
} from '../spoken-video-local-qc.mjs'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------- 解析器

test('silencedetect 解析：成对的行与「片尾静音没有 end」两种情况', () => {
  const log = [
    '[silencedetect @ 0x55f] silence_start: 12.3456',
    '[silencedetect @ 0x55f] silence_end: 14.5678 | silence_duration: 2.2222',
    '[silencedetect @ 0x55f] silence_start: 18.0',
  ].join('\n')
  const spans = parseSilenceDetect(log, 20.5)
  assert.equal(spans.length, 2)
  assert.deepEqual(spans[0], { startSeconds: 12.3456, endSeconds: 14.5678, durationSeconds: 2.2222 })
  // 片尾静音必须用总时长补齐——否则「最后一句没念完」会被漏掉。
  assert.equal(spans[1].startSeconds, 18)
  assert.equal(spans[1].endSeconds, 20.5)
  assert.equal(spans[1].durationSeconds, 2.5)
})

test('blackdetect 解析：只认三字段齐全的行', () => {
  const log = [
    '[blackdetect @ 0x1] black_start:3.2 black_end:5.6 black_duration:2.4',
    '[blackdetect @ 0x1] black_start:9.0',  // 不完整，忽略
  ].join('\n')
  const spans = parseBlackDetect(log)
  assert.equal(spans.length, 1)
  assert.deepEqual(spans[0], { startSeconds: 3.2, endSeconds: 5.6, durationSeconds: 2.4 })
})

test('freezedetect 解析：兼容 lavfi 前缀，且片尾冻结用总时长补齐', () => {
  const log = [
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 4.5',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 4.6',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 9.1',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 15.0',
  ].join('\n')
  const spans = parseFreezeDetect(log, 17.5)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].startSeconds, 4.5)
  assert.equal(spans[0].endSeconds, 9.1)
  assert.equal(spans[1].durationSeconds, 2.5)
})

test('volumedetect 解析：峰值与均值', () => {
  const log = '[Parsed_volumedetect_0 @ 0x3] mean_volume: -21.5 dB\n[Parsed_volumedetect_0 @ 0x3] max_volume: -1.2 dB'
  assert.deepEqual(parseVolumeDetect(log), { meanVolumeDb: -21.5, maxVolumeDb: -1.2 })
  assert.deepEqual(parseVolumeDetect(''), { meanVolumeDb: null, maxVolumeDb: null })
})

// ---------------------------------------------------------------- 判定

test('判定：超阈值的黑帧/静音都否决，并报出最长那段', () => {
  const judged = judgeLocalQc({
    blackSpans: [{ startSeconds: 3, endSeconds: 8, durationSeconds: 5 }],
    freezeSpans: [{ startSeconds: 10, endSeconds: 16, durationSeconds: 6 }],
    silenceSpans: [{ startSeconds: 20, endSeconds: 23, durationSeconds: 3 }],
    volume: { meanVolumeDb: -20, maxVolumeDb: -1.5 },
    durationSeconds: 30,
  })
  assert.equal(judged.passed, false)
  assert.deepEqual(judged.defects.map((d) => d.kind).sort(), ['black', 'silence'])
  assert.ok(judged.issues.some((i) => /全黑/.test(i) && /5\.0 秒/.test(i)))
  assert.ok(judged.issues.some((i) => /无声/.test(i) && /3\.0 秒/.test(i)))
})

/**
 * 冻结只记录、不否决。
 *
 * 2026-10-26 实测依据：一条已通过审片并发布的真实成片（250 秒）跑 freezedetect
 * 检出 28 段、累计约 165 秒静止，占全片 66%——但它是正常作品。本项目的视觉风格
 * 就是静态信息卡片 + 文字入场动画，画面长时间不动是风格特征而非缺陷。
 * 若把冻结做成否决项，每一条正常成片都会被拦下。
 */
test('判定：画面静止只记 warning、绝不否决（静态信息卡片是正常风格）', () => {
  const judged = judgeLocalQc({
    blackSpans: [],
    freezeSpans: [
      { startSeconds: 14.8, endSeconds: 22.3, durationSeconds: 7.5 },
      { startSeconds: 27.9, endSeconds: 34, durationSeconds: 6.1 },
    ],
    silenceSpans: [],
    volume: { meanVolumeDb: -26, maxVolumeDb: -3.2 },
    durationSeconds: 250,
  })
  assert.equal(judged.passed, true, '静态画面不得否决')
  assert.equal(judged.defects.length, 0, '冻结不该进 defects')
  assert.ok(judged.warnings.some((w) => /画面静止 2 段/.test(w) && /不参与否决/.test(w)))
})

test('判定：低于阈值的瞬态不算问题（正常淡入淡出、句间换气）', () => {
  const judged = judgeLocalQc({
    blackSpans: [{ startSeconds: 1, endSeconds: 1.3, durationSeconds: 0.3 }],
    freezeSpans: [{ startSeconds: 5, endSeconds: 6.5, durationSeconds: 1.5 }],
    silenceSpans: [{ startSeconds: 8, endSeconds: 8.6, durationSeconds: 0.6 }],
    volume: { meanVolumeDb: -21, maxVolumeDb: -1.2 },
    durationSeconds: 30,
  })
  assert.equal(judged.passed, true, `不该否决，实际 issues=${JSON.stringify(judged.issues)}`)
  assert.equal(judged.defects.length, 0)
})

test('判定：测不出来不否决，只记 warning ——「没测」不能等于「有问题」', () => {
  const judged = judgeLocalQc({
    blackSpans: [],
    freezeSpans: [],
    silenceSpans: [],
    volume: {},   // volumedetect 无输出
    durationSeconds: null,
  })
  assert.equal(judged.passed, true, '空测量结果不得否决')
  assert.ok(judged.warnings.some((w) => /未能读取音频峰值/.test(w)))
})

test('判定：峰值过高/过低只记 warning，不否决', () => {
  const hot = judgeLocalQc({ volume: { maxVolumeDb: 0.5 }, durationSeconds: 10 })
  assert.equal(hot.passed, true)
  assert.ok(hot.warnings.some((w) => /削波风险/.test(w)))

  const quiet = judgeLocalQc({ volume: { maxVolumeDb: -35 }, durationSeconds: 10 })
  assert.equal(quiet.passed, true)
  assert.ok(quiet.warnings.some((w) => /偏轻/.test(w)))
})

test('判定：阈值可从外部覆盖，且默认阈值有明确取值', () => {
  assert.equal(DEFAULT_LOCAL_QC_THRESHOLDS.blackMinSeconds, 1.2)
  assert.equal(DEFAULT_LOCAL_QC_THRESHOLDS.silenceMinSeconds, 2.0)
  assert.equal(DEFAULT_LOCAL_QC_THRESHOLDS.freezeMinSeconds, undefined, '冻结阈值应已移除（改为只记录）')

  const span = [{ startSeconds: 0, endSeconds: 4, durationSeconds: 4 }]
  // 默认 1.2 秒阈值下 4 秒全黑应否决
  assert.equal(judgeLocalQc({ blackSpans: span }).passed, false)
  // 把阈值抬到 5 秒，同一段就不再否决
  assert.equal(judgeLocalQc({ blackSpans: span, thresholds: { ...DEFAULT_LOCAL_QC_THRESHOLDS, blackMinSeconds: 5 } }).passed, true)
})

// ---------------------------------------------------------------- 端到端（真 ffmpeg）

/** 检测 ffmpeg 是否可用；不可用就跳过端到端用例（本机环境可能没有）。 */
async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function detect(videoPath, durationSeconds) {
  const thresholds = DEFAULT_LOCAL_QC_THRESHOLDS
  const run = async (args) => {
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-nostats', ...args, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 * 8 })
      return String(stderr || '')
    } catch (error) {
      return String(error?.stderr || '')
    }
  }
  const [blackLog, freezeLog, silenceLog, volumeLog] = await Promise.all([
    run(['-i', videoPath, '-vf', `blackdetect=d=${thresholds.blackMinSeconds}:pic_th=${thresholds.blackPixelThreshold}:pix_th=0.10`, '-an']),
    run(['-i', videoPath, '-vf', 'freezedetect=n=-60dB:d=3.0', '-an']),
    run(['-i', videoPath, '-vn', '-af', `silencedetect=n=${thresholds.silenceNoiseDb}dB:d=${thresholds.silenceMinSeconds}`]),
    run(['-i', videoPath, '-vn', '-af', 'volumedetect']),
  ])
  return judgeLocalQc({
    blackSpans: parseBlackDetect(blackLog),
    freezeSpans: parseFreezeDetect(freezeLog, durationSeconds),
    silenceSpans: parseSilenceDetect(silenceLog, durationSeconds),
    volume: parseVolumeDetect(volumeLog),
    durationSeconds,
    thresholds,
  })
}

test('端到端：全黑静音的片子必须被否决', async (t) => {
  if (!await hasFfmpeg()) return t.skip('本机没有 ffmpeg')
  const dir = await mkdtemp(join(tmpdir(), 'lwb-localqc-black-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'black.mp4')
  // 6 秒纯黑 + 静音。
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=6:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ], { timeout: 120_000 })

  const judged = await detect(file, 6)
  assert.equal(judged.passed, false, '全黑静音片必须被否决')
  assert.ok(judged.defects.some((d) => d.kind === 'black'), `应检出黑帧，实际 ${JSON.stringify(judged.defects)}`)
  assert.ok(judged.defects.some((d) => d.kind === 'silence'), `应检出静音，实际 ${JSON.stringify(judged.defects)}`)
})

test('端到端：正常有画面的片子不该被误判', async (t) => {
  if (!await hasFfmpeg()) return t.skip('本机没有 ffmpeg')
  const dir = await mkdtemp(join(tmpdir(), 'lwb-localqc-ok-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'ok.mp4')
  // 6 秒持续变化的画面（testsrc 自带运动）+ 1kHz 正弦音。
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=6:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=6:sample_rate=48000',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ], { timeout: 120_000 })

  const judged = await detect(file, 6)
  assert.equal(judged.passed, true, `正常片不该否决，实际 issues=${JSON.stringify(judged.issues)}`)
})

test('端到端：静止画面只被记录、不被否决（有声音）', async (t) => {
  if (!await hasFfmpeg()) return t.skip('本机没有 ffmpeg')
  const dir = await mkdtemp(join(tmpdir(), 'lwb-localqc-freeze-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'freeze.mp4')
  // 静止的彩色画面 8 秒 + 持续正弦音：音频正常，画面完全不动。
  // 这正是本项目静态信息卡片的形态，必须放行，只记 warning。
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x336699:s=320x240:d=8:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ], { timeout: 120_000 })

  const judged = await detect(file, 8)
  assert.equal(judged.passed, true, `静止画面不该否决，实际 issues=${JSON.stringify(judged.issues)}`)
  assert.equal(judged.defects.length, 0, '冻结不该进 defects')
  assert.ok(judged.warnings.some((w) => /画面静止/.test(w)), '应当记录静止段数供人工参考')
})

test('端到端：有画面但音轨断了，必须被否决', async (t) => {
  if (!await hasFfmpeg()) return t.skip('本机没有 ffmpeg')
  const dir = await mkdtemp(join(tmpdir(), 'lwb-localqc-nosound-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'nosound.mp4')
  // 画面正常变化，但音轨是纯静音——抽帧质检完全看不出这种问题。
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=6:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ], { timeout: 120_000 })

  const judged = await detect(file, 6)
  assert.equal(judged.passed, false, '音轨静音必须被否决')
  assert.ok(judged.defects.some((d) => d.kind === 'silence'), `应检出静音，实际 ${JSON.stringify(judged.defects)}`)
})
