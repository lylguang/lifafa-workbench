/**
 * 媒体流水线：把「配音 → 字幕 → 成片 → 质检 → 发布资料」串成一条受控任务链。
 *
 * 为什么放在单独一层而不是塞进 store：store 只做「校验 + 落库」，它是纯的、
 * 可测的、不碰外部服务；这一层才会真的调用 ffmpeg、Remotion、媒体服务和子会话。
 * 混在一起的后果是 store 的测试要么全跳，要么全 mock，最后没人跑。
 *
 * 每一步只做一件事，并把产物直接交给 store 的阶段提交：任何一步失败都停在
 * 那一步，不会把半成品写成「已完成」。这一点比「少几次调用」重要得多——
 * 一条情感故事成片有问题却标成可发布，代价是账号信用。
 */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildTechnicalReport, finalGate, mergeReview, STORY_VIDEO_SPEC } from './story-account-qc.mjs'
import { prepareStoryVideoProject, probeStoryVideo, renderStoryVideo, buildStoryBeats } from './story-account-render.mjs'
import { buildProportionalCues, checkScriptForVoice, normalizeStoryVoiceRequest, requestStoryVoiceover } from './story-account-voice.mjs'
import { renderPlainStoryCover, STORY_COVER_SIZE } from './story-account-cover.mjs'
import { parseSrt, serializeSrt, splitLongCues, validateSrt } from './story-account-subtitles.mjs'
import { storyAccountDataPath } from './story-account-paths.mjs'

export const STORY_PIPELINE_STEPS = Object.freeze([
  { id: 'voiceover', label: '合成配音' },
  { id: 'subtitles', label: '生成字幕' },
  { id: 'render', label: 'Remotion 竖屏渲染' },
  { id: 'probe', label: 'ffprobe 技术质检' },
  { id: 'review', label: '独立审片' },
  { id: 'packaging', label: '发布资料与封面' },
])

export class StoryPipelineError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
    this.message = message
  }
}

function fail(code, message) { throw new StoryPipelineError(code, message) }

function mediaFile(relative) {
  const normalized = String(relative || '').replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/u.test(normalized) || normalized.includes('..')) {
    fail('STORY_PIPELINE_INVALID_PATH', '媒体文件路径无效。')
  }
  return normalized
}

async function fileSize(path) {
  const info = await stat(path).catch(() => null)
  return info?.size ?? null
}

/**
 * 跑完整条媒体链。
 *
 * 依赖全部由外部注入（store / agent / 配音函数 / 审片函数），所以这条链本身
 * 可以在测试里用假实现跑通——真正的外部调用只有四类：媒体服务、ffmpeg、
 * Remotion、子会话。注入点就是这四个，不多不少。
 */
export async function runStoryMediaPipeline({
  store,
  agent,
  projectId,
  voice = {},
  palette = 'dusk',
  subtitleMaxChars = 16,
  reviewVideo,
  // 允许替换外部服务，便于在没有媒体服务/浏览器时跑集成测试。
  speak = requestStoryVoiceover,
  render = renderStoryVideo,
  probe = probeStoryVideo,
  coverRenderer = renderPlainStoryCover,
  // 搭渲染工程时要建 node_modules 符号链接，受限环境不允许；测试可关掉。
  linkDependencies = true,
  signal,
}) {
  const workspacePath = agent?.workspacePath
  if (!workspacePath) fail('STORY_PIPELINE_INVALID_INPUT', '缺少专属工作区，无法执行媒体流水线。')

  const detail = await store.get(agent, { projectId })
  const project = detail
  const script = detail.artifacts.script?.data
  const topic = detail.artifacts.topic?.data
  if (!script?.body) fail('STORY_PIPELINE_STAGE_BLOCKED', '需要先完成稿件才能进入媒体流水线。')

  const steps = STORY_PIPELINE_STEPS.map((step) => ({ ...step, status: 'pending', detail: null }))
  const setStep = (id, status, note = null) => {
    const step = steps.find((item) => item.id === id)
    if (step) { step.status = status; step.detail = note }
  }

  let revision = project.revision
  const commit = async (stage, payload, idempotencyKey, produced = true) => {
    const request = {
      projectId,
      expectedRevision: revision,
      stage,
      idempotencyKey,
      payload,
      ...(produced ? { source: 'story-account/pipeline' } : {}),
    }
    const result = produced
      ? await store.commitProduced(agent, request)
      : await store.commit(agent, request)
    revision = result.project.revision
    return result
  }

  const runId = `run-${Date.now().toString(36)}`
  // 自动阶段要么引用真实文件，要么明确 null——store 对文件路径做白名单校验，
  // 这里给出的每个路径都必须是媒体目录下已存在的相对路径。
  const mediaRoot = join(workspacePath, 'data', 'media')
  await mkdir(join(mediaRoot, 'voiceovers'), { recursive: true })
  await mkdir(join(mediaRoot, 'subtitles'), { recursive: true })
  await mkdir(join(mediaRoot, 'videos'), { recursive: true })
  await mkdir(join(mediaRoot, 'qc'), { recursive: true })

  /* ------------------------------- 配音 ------------------------------- */
  setStep('voiceover', 'running')
  const scriptCheck = checkScriptForVoice(script.body)
  const voiceRequest = normalizeStoryVoiceRequest(voice)
  // 原始 voice 交给配音函数自己归一化：界面传进来的是「声音方案」，归一化在
  // 配音层做一次，避免这里归一化后又被归一化一次把音色描述覆盖掉。
  const spoken = await speak({ workspacePath, text: script.body, voice, signal, runId })
  // 配音文件由媒体服务写到专属工作区，这里补一个稳定的相对路径。
  const audioRelative = mediaFile(spoken.audio.file || `media/voiceovers/${runId}.wav`)
  setStep('voiceover', 'done', `${scriptCheck.charCount} 字 · 语速 ${voiceRequest.rate}`)
  await commit('voiceover', {
    mode: 'story-account/tts',
    provider: spoken.request?.provider || voiceRequest.provider,
    voiceId: spoken.request?.voiceId || voiceRequest.voiceId || null,
    voiceName: spoken.request?.voiceName || voiceRequest.voiceName || null,
    audio: {
      file: audioRelative,
      mediaType: spoken.audio.mediaType || 'audio/wav',
      durationSeconds: spoken.audio.durationSeconds || null,
    },
  }, `pipe-voice-${runId}`)

  const audioAbsolute = join(workspacePath, 'data', audioRelative)
  const audioDuration = spoken.audio.durationSeconds || scriptCheck.estimatedSeconds

  /* ------------------------------- 字幕 ------------------------------- */
  setStep('subtitles', 'running')
  // 先切画面节拍，再让字幕严格跟着节拍走：两处各自按字数切会错位，
  // 实测抽帧能看到画面换了三句、字幕还停在第二条。
  const beats = buildStoryBeats({ body: script.body, durationSeconds: audioDuration })
  const proportional = buildProportionalCues({ body: script.body, durationSeconds: audioDuration, maxChars: subtitleMaxChars, beats })
  const cues = proportional.cues
  if (!cues.length) fail('STORY_PIPELINE_SUBTITLES_FAILED', '稿件无法切出字幕条目。')
  const rawSrt = serializeSrt(cues)
  const split = splitLongCues(rawSrt)
  if (split.errors?.length) fail('STORY_PIPELINE_SUBTITLES_FAILED', `字幕切分失败：${split.errors.join(' ')}`)
  const checked = validateSrt(split.srt)
  if (checked.errors.length) fail('STORY_PIPELINE_SUBTITLES_FAILED', `字幕校验失败：${checked.errors.join(' ')}`)
  const finalSrt = split.srt
  const subtitleRelative = mediaFile(`media/subtitles/${runId}.srt`)
  await writeFile(join(workspacePath, 'data', subtitleRelative), `${finalSrt}\n`, 'utf8')
  setStep('subtitles', 'done', `${checked.cueCount} 条${proportional.aligned ? '（已对齐）' : '（按字数估算）'}`)
  await commit('subtitles', {
    mode: proportional.aligned ? 'story-account/asr' : 'story-account/proportional',
    sourceAudioFile: audioRelative,
    srt: finalSrt,
    srtFile: subtitleRelative,
  }, `pipe-srt-${runId}`)

  /* ------------------------------ 成片渲染 ------------------------------ */
  setStep('render', 'running')
  const { cues: finalCues } = parseSrt(finalSrt)
  const prepared = await prepareStoryVideoProject({
    projectRoot: join(workspacePath, 'data'),
    runId,
    title: project.title,
    script: script.body,
    audioPath: audioAbsolute,
    durationSeconds: audioDuration,
    subtitles: finalCues,
    subtitleSrt: finalSrt,
    subtitleEnabled: true,
    palette,
    linkDependencies,
  })
  // 沙箱里跑真渲染要浏览器，失败必须是显式失败而不是「假装通过」。
  await render(prepared, { signal })
  const videoRelative = mediaFile(`media/videos/${runId}.mp4`)
  await mkdir(join(mediaRoot, 'videos'), { recursive: true })
  // 渲染产物在任务目录里，登记前拷到统一的 video 目录，避免路径随任务目录漂移。
  await copyFile(prepared.outputPath, join(workspacePath, 'data', videoRelative))
  const videoBytes = await fileSize(join(workspacePath, 'data', videoRelative))
  setStep('render', 'done', `${prepared.beats.length} 个画面节拍`)
  await commit('video', {
    mode: 'story-account/remotion',
    renderer: 'remotion',
    orientation: 'portrait',
    sourceAudioFile: audioRelative,
    subtitleEnabled: true,
    sourceSubtitleFile: subtitleRelative,
    video: {
      file: videoRelative,
      mediaType: 'video/mp4',
      bytes: videoBytes,
      durationSeconds: audioDuration,
      width: STORY_VIDEO_SPEC.width,
      height: STORY_VIDEO_SPEC.height,
      fps: STORY_VIDEO_SPEC.fps,
      hasAudio: true,
    },
  }, `pipe-video-${runId}`)

  /* ------------------------------ 技术质检 ------------------------------ */
  setStep('probe', 'running')
  const videoAbsolute = join(workspacePath, 'data', videoRelative)
  const probed = await probe(videoAbsolute)
  const technical = buildTechnicalReport({
    video: { durationSeconds: probed.durationSeconds, width: probed.width, height: probed.height, fps: probed.fps, hasAudio: probed.hasAudio },
    audio: { durationSeconds: probed.audioDurationSeconds || audioDuration },
    subtitles: { cueCount: checked.cueCount, maxCueChars: checked.maxCueChars },
    subtitleEnabled: true,
  })
  setStep('probe', technical.passed ? 'done' : 'failed', technical.passed ? '规格符合' : `${technical.issues.length} 条问题`)
  const reportRelative = mediaFile(`media/qc/${runId}-technical.json`)
  await writeFile(join(workspacePath, 'data', reportRelative), JSON.stringify(technical, null, 2), 'utf8')
  if (!technical.passed) {
    // 技术不过也要留下报告文件，人回头能看见到底哪一项不合格。
    return { status: 'failed', failedAt: 'probe', steps, technical, reportFile: reportRelative, blockers: technical.issues }
  }

  /* ------------------------------ 独立审片 ------------------------------ */
  setStep('review', 'running')
  if (typeof reviewVideo !== 'function') {
    // 没有审片函数时不能自己判通过：双闸门的意义就是不许单方面放行。
    fail('STORY_PIPELINE_REVIEW_REQUIRED', '缺少独立审片环节，无法通过质检闸门。')
  }
  const sampled = [0.12, 0.38, 0.62, 0.88].map((ratio) => Math.round(ratio * (probed.durationSeconds || audioDuration)))
  const reviewRaw = await reviewVideo({ workspacePath, videoFile: videoRelative, sampledTimestamps: sampled, topic, script, technicalReportFile: reportRelative, durationSeconds: (probed.durationSeconds || audioDuration) })
  const merged = mergeReview(reviewRaw, { technicalReport: technical, sampledTimestamps: sampled })
  setStep('review', merged.passed ? 'done' : 'failed', `${merged.score} 分`)
  const gate = finalGate({ technicalReport: technical, review: merged, antiPlastic: script.antiPlastic })
  const reviewRelative = mediaFile(`media/qc/${runId}-review.json`)
  await writeFile(join(workspacePath, 'data', reviewRelative), JSON.stringify(merged, null, 2), 'utf8')
  await commit('qc', {
    mode: 'story-account/qc-gate',
    reportFile: reportRelative,
    reviewFile: reviewRelative,
    passed: gate.passed,
    technical,
    review: merged,
    antiPlastic: script.antiPlastic || null,
  }, `pipe-qc-${runId}`)
  if (!gate.passed) return { status: 'failed', failedAt: 'review', steps, technical, review: merged, blockers: gate.blockers }

  /* ----------------------------- 发布资料 ----------------------------- */
  setStep('packaging', 'running')
  if (!detail.artifacts.packaging?.data) {
    // 发布资料要模型现场写标题与文案，属于人的判断，不在自动化链里替人做。
    return { status: 'awaiting-packaging', steps, technical, review: merged, note: '质检已通过，发布资料需要在发布页生成。' }
  }
  setStep('packaging', 'done')

  return { status: 'succeeded', steps, technical, review: merged }
}

/**
 * 生成并落盘封面。
 *
 * 两条路径必须都在：有生图底图时叠字，没有底图时用纯色底 + 大字兜底。
 * 情感号的封面永远要有字——没字的封面在信息流里等于没有封面。
 */
export async function buildStoryCover({ workspacePath, projectId, headline, palette }) {
  if (!workspacePath) fail('STORY_PIPELINE_INVALID_INPUT', '缺少专属工作区，无法生成封面。')
  const dir = storyAccountDataPath(workspacePath, 'media', 'covers')
  await mkdir(dir, { recursive: true })
  const outputPath = join(dir, `${projectId}.png`)
  // 底图走生图服务时叠字的路径（backgroundImage）从未被接入，统一走确定性纯色底 + 大字兜底。
  const result = await renderPlainStoryCover({ outputPath, headline, palette, size: STORY_COVER_SIZE })
  const relative = `media/covers/${projectId}.png`
  return {
    ...result,
    file: result.applied ? relative : null,
    bytes: result.applied ? await fileSize(outputPath) : null,
    size: STORY_COVER_SIZE,
  }
}

/** 读回已生成的封面信息（给发布页展示，不重新渲染）。 */
export async function readStoryCoverInfo({ workspacePath, projectId }) {
  const path = storyAccountDataPath(workspacePath, 'media', 'covers', `${projectId}.png`)
  const bytes = await fileSize(path)
  if (bytes === null) return { file: null, exists: false }
  return { file: `media/covers/${projectId}.png`, exists: true, bytes }
}

/** 发布资料文案导出成可直接粘贴的纯文本。 */
export function formatStoryPackageText(packaging) {
  if (!packaging?.title) return ''
  const tags = (packaging.tags || []).map((tag) => `#${tag}`).join(' ')
  return [
    packaging.title,
    '',
    packaging.copy || '',
    '',
    packaging.description || '',
    '',
    tags,
    '',
    `封面大字：${packaging.coverHeadline || ''}`,
  ].join('\n').trim()
}

/** 读回稿件原文，供导出与二次编辑。 */
export async function readStoryScript({ store, agent, projectId }) {
  const detail = await store.get(agent, { projectId })
  const body = detail.artifacts.script?.data?.body
  if (!body) fail('STORY_PIPELINE_STAGE_BLOCKED', '项目还没有稿件。')
  return { body, title: detail.project.title }
}

/** 把外部读到的内容按 UTF-8 读成文本，供导入稿件时校验编码。 */
export async function readTextFile(path) {
  const buffer = await readFile(path)
  const text = buffer.toString('utf8')
  if (text.includes('\uFFFD')) fail('STORY_PIPELINE_INVALID_ENCODING', '文件不是有效的 UTF-8 文本。')
  return text
}
