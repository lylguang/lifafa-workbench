/**
 * 渲染链真实验证脚本（开发用，不进单测）。
 *
 * 单测里 Remotion 与 ffmpeg 全部是注入的假实现，测的是编排逻辑；这个脚本
 * 反过来——假的是稿子，真的是浏览器与编码器。它回答单测回答不了的问题：
 * 工程能不能搭起来、合成能不能渲出来、成片是不是真的 1080x1920 / 30fps /
 * 有音轨、技术闸门会不会放行、画面帧看起来对不对。
 *
 * 用法：
 *   node lwb/packs/story-account/test/render-smoke.mjs
 *
 * 需要：ffmpeg / ffprobe 在 PATH 上，Remotion 依赖已随 vendor 安装。
 * 成片与抽帧写到 lwb/local/verification/render/（不会进版本库）。
 */
import test from 'node:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareStoryVideoProject, renderStoryVideo, probeStoryVideo, storyRemotionAvailable, buildStoryBeats } from '../story-account-render.mjs'
import { buildTechnicalReport } from '../story-account-qc.mjs'
import { buildProportionalCues } from '../story-account-voice.mjs'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const outputDir = join(root, 'lwb', 'local', 'verification', 'render')

// 一段真实的、没有升华的稿子：口语、具体动作、不解释情绪。
const SCRIPT = [
  '「妈，锅里的鱼你吃吧，我不饿。」',
  '年初三晚上，我在厨房说完这句，就把碗放回水池。',
  '水龙头开得很大。我没关。',
  '我妈坐在饭桌那头，没抬头，只说了一句：「那你明天几点走。」',
  '我说八点。',
  '她说：「哦。」',
].join('\n')
const DURATION = 20

function log(step, message) {
  process.stdout.write(`${step.padEnd(12)} ${message}\n`)
}

async function main() {
  if (!(await storyRemotionAvailable())) {
    log('跳过', '本机没有可用的 Remotion 依赖，先跑 npm run setup。')
    return
  }
  await mkdir(outputDir, { recursive: true })
  const workDir = await mkdtemp(join(tmpdir(), 'story-render-smoke-'))
  try {
    // 1) 用 ffmpeg 合成一段静音配音，模拟真实配音产物。
    const audioPath = join(workDir, 'narration.wav')
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(DURATION), audioPath])
    log('配音', `合成 ${DURATION}s 静音音轨`)

    // 2) 画面节拍 + 跟随节拍的字幕。
    const beats = buildStoryBeats({ body: SCRIPT, durationSeconds: DURATION })
    const { cues } = buildProportionalCues({ body: SCRIPT, durationSeconds: DURATION, maxChars: 16, beats })
    log('节拍', `${beats.length} 拍 / ${cues.length} 条字幕`)

    // 3) 搭 Remotion 工程并真渲染。
    const prepared = await prepareStoryVideoProject({
      projectRoot: workDir,
      runId: 'smoke',
      title: '锅里的鱼',
      script: SCRIPT,
      audioPath,
      durationSeconds: DURATION,
      subtitles: cues,
      palette: 'kitchen',
    })
    log('工程', prepared.projectDir)

    const started = Date.now()
    await renderStoryVideo(prepared, {})
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const info = await stat(prepared.outputPath)
    log('渲染', `${seconds}s，${(info.size / 1024 / 1024).toFixed(2)} MB`)

    // 4) ffprobe 读数 + 技术闸门。
    const probed = await probeStoryVideo(prepared.outputPath)
    log('ffprobe', JSON.stringify(probed))
    const report = buildTechnicalReport({
      video: { durationSeconds: probed.durationSeconds, width: probed.width, height: probed.height, fps: probed.fps, hasAudio: probed.hasAudio },
      audio: { durationSeconds: probed.audioDurationSeconds },
      subtitles: { cueCount: cues.length, maxCueChars: Math.max(...cues.map((cue) => [...cue.text].length)) },
      subtitleEnabled: true,
    })
    log('技术闸门', report.passed ? '通过' : `不通过：${report.issues.join('；')}`)

    // 5) 成片与抽帧留档，人工看一眼画面。
    const videoCopy = join(outputDir, 'smoke.mp4')
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', prepared.outputPath, '-c', 'copy', videoCopy])
    for (const at of ['2', '6', '12', '18']) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', at, '-i', prepared.outputPath, '-frames:v', '1', join(outputDir, `frame-${at}s.jpg`)])
    }
    log('留档', outputDir)

    const expected = probed.width === 1080 && probed.height === 1920 && Math.abs(probed.fps - 30) < 0.1 && probed.hasAudio
    if (!expected || !report.passed) {
      throw new Error('不符合竖屏规格或技术闸门未通过，详见上方读数。')
    }
    log('结果', '符合 1080x1920 / 30fps / 有音轨，技术闸门通过。')
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

test('story-account 渲染链真实验证（本机无 Remotion 时跳过）', async (t) => {
  // 单测里 Remotion 与 ffmpeg 都是假实现；这条用例反过来——假的是稿子，真的是
  // 浏览器与编码器。本机没有 Remotion 依赖时跳过，避免拖慢 node --test 全量跑。
  if (!(await storyRemotionAvailable())) {
    t.skip('本机没有可用的 Remotion 依赖，先跑 npm run setup；跳过真实渲染验证。')
    return
  }
  await main()
})
