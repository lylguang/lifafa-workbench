import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeLocalQc, DEFAULT_LOCAL_QC_THRESHOLDS } from '../spoken-video-local-qc.mjs'
import { LOUDNESS_TOLERANCE, NARRATION_LOUDNESS, measureLoudness, normalizeNarrationLoudness, parseEbur128 } from '../spoken-video-loudness.mjs'

const ffmpegReady = () => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); return true } catch { return false } }

// 真实的 ebur128 汇总输出（ffmpeg 5/6/7 同形）。
const EBUR_SAMPLE = `
[Parsed_ebur128_0 @ 000001] t: 233.7  M: -14.2 S: -14.3 I: -14.3 LUFS  LRA: 3.3 LU
[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.6 LUFS

  Loudness range:
    LRA:         3.3 LU
    Threshold: -34.6 LUFS
    LRA low:   -17.1 LUFS
    LRA high:  -13.8 LUFS

  True peak:
    Peak:       -1.8 dBFS
`

test('解析 ebur128：整片响度、响度范围、真峰值都要认出来', () => {
  assert.deepEqual(parseEbur128(EBUR_SAMPLE), { integratedLufs: -14.3, loudnessRangeLu: 3.3, truePeakDb: -1.8 })
  // 没有 Summary 段（比如只跑了短窗口）时不能把 momentary 的 M: 当成整片响度。
  assert.deepEqual(parseEbur128('[Parsed_ebur128_0 @ x] t: 3.2  M: -12.0 S: -13.0 I: -13.5 LUFS  LRA: 2.0 LU'), { integratedLufs: null, loudnessRangeLu: null, truePeakDb: null })
  assert.deepEqual(parseEbur128(''), { integratedLufs: null, loudnessRangeLu: null, truePeakDb: null })
})

test('响度闸门：正常带沉默、轻度偏离警告、严重偏离否决、测不出来不判定', () => {
  const base = { blackSpans: [], freezeSpans: [], silenceSpans: [], volume: { meanVolumeDb: -18, maxVolumeDb: -1.5 }, durationSeconds: 100 }
  const quiet = judgeLocalQc({ ...base, loudness: { integratedLufs: -14.3, truePeakDb: -1.8 } })
  assert.deepEqual(quiet.issues, [])
  assert.deepEqual(quiet.warnings, [])

  // -15.4 在 -16 ~ -13 的建议带内：沉默
  assert.deepEqual(judgeLocalQc({ ...base, loudness: { integratedLufs: -15.4 } }).warnings, [])

  // -17.2 落在建议带外但未到否决线：只警告，不否决（有些内容本来就想做轻声）
  const slightlyQuiet = judgeLocalQc({ ...base, loudness: { integratedLufs: -17.2 } })
  assert.deepEqual(slightlyQuiet.issues, [])
  assert.equal(slightlyQuiet.warnings.length, 1)
  assert.match(slightlyQuiet.warnings[0], /-17\.2 LUFS/u)

  // 实测事故值 -21.3：比目标低 7dB，必须否决——这正是 2026-11-01 那条已发布成片的实测值
  const wayQuiet = judgeLocalQc({ ...base, loudness: { integratedLufs: -21.3 } })
  assert.equal(wayQuiet.issues.length, 1)
  assert.equal(wayQuiet.defects[0].kind, 'loudness')
  assert.match(wayQuiet.issues[0], /-21\.3 LUFS/u)

  // 压得太狠同样否决
  assert.equal(judgeLocalQc({ ...base, loudness: { integratedLufs: -10.2 } }).defects[0].kind, 'loudness')

  // 测不出来：只记 warning，绝不把「没测」当成「有问题」
  const unmeasured = judgeLocalQc({ ...base, loudness: {} })
  assert.deepEqual(unmeasured.issues, [])
  assert.equal(unmeasured.warnings.length, 1)
  assert.match(unmeasured.warnings[0], /未能读取成片响度/u)
  assert.deepEqual(DEFAULT_LOCAL_QC_THRESHOLDS.loudnessWarnLufs, [-16, -13])
})

test('两遍闭环：安静的旁白被拉到目标响度，且复测确认（真 ffmpeg）', async (t) => {
  if (!ffmpegReady()) { t.skip('ffmpeg 不可用'); return }
  const dir = await mkdtemp(join(tmpdir(), 'loudness-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'quiet.wav')
  // 造一段「峰均比很高」的音频：低幅度正弦 + 稀疏尖峰，模拟 TTS 旁白
  // （实测旁白 I=-21.4 LUFS / 峰值 -1.2，峰均比接近 19dB，正是 loudnorm 动态模式
  //  会停在 -15.2 的那种素材）。
  execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-y', '-f', 'lavfi',
    '-i', 'aevalsrc=0.06*sin(2*PI*220*t)*(1+0.9*sin(2*PI*3*t))+0.85*sin(2*PI*1800*t)*exp(-30*mod(t\\,0.9)):s=48000:d=6',
    '-ar', '48000', '-ac', '2', source], { stdio: 'pipe' })
  const before = await measureLoudness(source)
  assert.ok(before.integratedLufs !== null, '原始响度必须测得出来')
  assert.ok(before.integratedLufs < NARRATION_LOUDNESS.targetLufs - 2, `测试素材应当明显偏轻，实测 ${before.integratedLufs}`)

  const target = join(dir, 'normalized.wav')
  const result = await normalizeNarrationLoudness(source, target)
  assert.equal(result.ok, true, `归一化应当收敛：${result.reason || ''}`)
  assert.equal(result.applied, true)
  assert.ok(await stat(target).then(() => true))
  // 复测值是写完之后重新测的，不是把计算值抄回来——这是闭环的意义。
  assert.ok(Math.abs(result.after.integratedLufs - NARRATION_LOUDNESS.targetLufs) <= LOUDNESS_TOLERANCE.lufs,
    `复测响度 ${result.after.integratedLufs} 应当落在目标 ±${LOUDNESS_TOLERANCE.lufs} LU 内`)
  assert.ok(result.after.truePeakDb <= NARRATION_LOUDNESS.truePeakDb + LOUDNESS_TOLERANCE.truePeakDb,
    `复测真峰值 ${result.after.truePeakDb} 不得超过 ${NARRATION_LOUDNESS.truePeakDb}dB`)
  // 独立再测一次，确认文件本身达标（而不是只信函数返回值）。
  const independent = await measureLoudness(target)
  assert.ok(Math.abs(independent.integratedLufs - NARRATION_LOUDNESS.targetLufs) <= LOUDNESS_TOLERANCE.lufs)
})

test('已经达标的音频不重编码（避免二次编码损失）', async (t) => {
  if (!ffmpegReady()) { t.skip('ffmpeg 不可用'); return }
  const dir = await mkdtemp(join(tmpdir(), 'loudness-skip-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'loud.wav')
  execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'loudnorm=I=-14:TP=-1.5', '-ar', '48000', '-ac', '2', source], { stdio: 'pipe' })
  const target = join(dir, 'out.wav')
  const result = await normalizeNarrationLoudness(source, target)
  if (result.reason === 'already-on-target') {
    assert.equal(result.ok, true)
    assert.equal(result.applied, false)
    assert.equal(await stat(target).then(() => true).catch(() => false), false, '跳过时不应写出文件')
  } else {
    // 若素材恰好落在容差外，就必须真的处理到达标——两种结果都合法，但不能既没写文件又没达标。
    assert.equal(result.ok, true)
    assert.equal(result.applied, true)
  }
})

test('源文件不存在时明确失败，不抛异常', async () => {
  const result = await normalizeNarrationLoudness(join(tmpdir(), 'does-not-exist-9f3a.wav'), join(tmpdir(), 'out-9f3a.wav'))
  assert.equal(result.ok, false)
  assert.equal(result.applied, false)
  assert.match(result.reason, /不存在/u)
})
