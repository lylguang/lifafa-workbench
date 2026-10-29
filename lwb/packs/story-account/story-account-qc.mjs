/**
 * 质检双闸门 —— 本包与通用口播包共享同一个骨架，但判据整套换掉。
 *
 * 第一道闸门是技术质检：ffprobe 量出来的客观事实。竖屏成片必须是
 * 1080x1920 / 30fps / 有音轨 / 有字幕，时长与配音差不超过 2 秒。这些不通过，
 * 片子就是不能用，没有讨论空间。
 *
 * 第二道闸门是独立审片 Agent：它看抽帧，判断「这一帧的说话速度和情绪对不对」。
 * 情感故事的技术质检全过、审片却不过是最常见的情形——画面是对的，但节奏不
 * 对：开场三秒还在空镜、一帧静止超过二十秒、字幕压住了脸。这些只有看片的人
 * 能发现，所以审片必须是独立会话，不能由创作者自评。
 *
 * 关键设计：technicallyPassed 是审片的上游前提。技术不通过时审片结论里
 * technicalPass 必须为 false，且 finalPassed 一律 false——两个闸门是「与」不是「或」。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

export const REVIEW_FINDING_LIMIT = 12
export const REVIEW_EVIDENCE_LIMIT = 8
export const REVIEW_SCORE_THRESHOLD = 70

/** 竖屏成片的硬规格。改这几个数字前先确认平台规格没有变化。 */
export const STORY_VIDEO_SPEC = Object.freeze({
  width: 1080,
  height: 1920,
  fps: 30,
  fpsTolerance: 0.1,
  audioDurationToleranceSeconds: 2,
})

export const REVIEW_FINDING_SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'note'])
export const REVIEW_FINDING_CATEGORIES = Object.freeze(['technical', 'composition', 'readability', 'pacing', 'relevance', 'emotion'])

export class StoryQcError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(message) { throw new StoryQcError('STORY_QC_INVALID_INPUT', `质检：${message}`) }

/**
 * 技术质检报告。输入是 ffprobe 的实际读数，不是估算值。
 *
 * `subtitles` 只接受解析后的 cue 数量与最长条目字数：字幕文件本身已经在
 * 字幕阶段校验过格式，这里只关心「有没有」和「放不放得下」。
 */
export function buildTechnicalReport({ video, audio, subtitles, subtitleEnabled = true, spec = STORY_VIDEO_SPEC }) {
  const issues = []
  const warnings = []

  if (!video?.durationSeconds) issues.push('视频没有可识别的时长。')
  if (video?.width !== spec.width || video?.height !== spec.height) {
    issues.push(`视频必须为 ${spec.width}x${spec.height} 竖屏，实际为 ${video?.width || '未知'}x${video?.height || '未知'}。`)
  }
  if (!video?.fps || Math.abs(video.fps - spec.fps) > spec.fpsTolerance) {
    issues.push(`视频必须为 ${spec.fps}fps，实际为 ${video?.fps ?? '未知'}。`)
  }
  if (!video?.hasAudio) issues.push('视频缺少音轨。')
  if (audio?.durationSeconds && video?.durationSeconds && Math.abs(audio.durationSeconds - video.durationSeconds) > spec.audioDurationToleranceSeconds) {
    issues.push('视频与配音时长差超过 2 秒：音画不同步会被观众直接听出来。')
  }
  if (subtitleEnabled && !subtitles?.cueCount) issues.push('视频没有可用字幕。')

  // 字幕过长不拦截：它不影响片子可用性，但会被迫缩小字号，移动端可读性下降。
  if (subtitleEnabled && subtitles?.maxCueChars > 40) {
    warnings.push(`最长字幕 ${subtitles.maxCueChars} 字，超过 40 字会被迫缩小字号。`)
  }
  if (video?.durationSeconds && video.durationSeconds > 180) {
    warnings.push(`成片 ${Math.round(video.durationSeconds)} 秒，超过 3 分钟，情感故事的完播率会明显下降。`)
  }

  return {
    artifactType: 'story_technical_report',
    reportVersion: '1.0.0',
    passed: issues.length === 0,
    issues,
    warnings,
    video: video || null,
    audio: audio || null,
    subtitles: { enabled: subtitleEnabled, cueCount: subtitles?.cueCount || 0, maxCueChars: subtitles?.maxCueChars || 0 },
    spec,
  }
}

/* -------------------------------- 审片协议 -------------------------------- */

export const STORY_REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    technicalPass: { type: 'boolean' },
    editorialPass: { type: 'boolean' },
    score: { type: 'integer', description: '0 到 100 的整数评分；范围由主机强制校验' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      description: `审核问题，主机最多接受 ${REVIEW_FINDING_LIMIT} 项`,
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...REVIEW_FINDING_SEVERITIES] },
          category: { type: 'string', enum: [...REVIEW_FINDING_CATEGORIES] },
          timestampSeconds: { type: 'number', description: '非负的成片时间点（秒）；范围由主机强制校验' },
          message: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
        additionalProperties: false,
      },
    },
    reviewEvidence: {
      type: 'array',
      description: '必须提供 2 到 8 项不同抽帧时间点的观察证据；数量由主机强制校验',
      items: {
        type: 'object',
        properties: {
          timestampSeconds: { type: 'number', description: '非负的已提供抽帧时间点（秒）；范围由主机强制校验' },
          observedMainVisual: { type: 'string' },
        },
        required: ['timestampSeconds', 'observedMainVisual'],
        additionalProperties: false,
      },
    },
  },
  required: ['passed', 'technicalPass', 'editorialPass', 'score', 'summary', 'findings', 'reviewEvidence'],
  additionalProperties: false,
})

/**
 * 审片提示词。
 *
 * 审片 Agent 与创作会话相互独立：它不改文件、不重渲染、不替创作者解释。
 * 它只回答一个问题——把这片子当成推送里划到的一条短视频，前 3 秒会不会被划走。
 *
 * 明确写进去的两条边界：
 * - 技术报告是事实，不能用主观判断推翻；
 * - 「没有实拍素材、用的是程序化或生成画面」是既定前提，不是缺陷。
 *   没有这一条，审片的每一条结论都会变成「画面不够真实」，永远不通过。
 */
export function buildReviewPrompt({ runDir, technicalReportFile, frameFiles = [], timestamps = [], contactSheetFile = null, scriptBody = '' }) {
  const sheetLine = contactSheetFile
    ? `\n另外有一张全片接触表：${contactSheetFile}。它按时间均匀采样拼成网格，用于纵览节奏与重复版式；缩略图较小，只用于发现全局问题，精确判断仍以逐帧图片为准。`
    : ''
  return [
    '你是独立的情感故事短视频审片 Agent，不是创作者。你与创作会话相互独立：不得修改任何文件、不得重新渲染、不得替创作者解释问题。',
    `任务工作目录：${runDir}`,
    `先读取 ${technicalReportFile} 与稿件正文，再逐张查看以下从最终成片提取的全帧图片：\n${frameFiles.map((file, index) => `- ${timestamps[index]} 秒：${file}`).join('\n')}${sheetLine}`,
    '技术报告是尺寸、帧率、音轨、时长与字幕的确定性事实，不得用主观判断推翻。若技术报告未通过，technicalPass 必须为 false。',
    '你是以「30-40 岁女性、深夜刷抖音」的身份在审这条片子。只回答一个问题：前 3 秒会不会被划走；如果没划走，后面哪一帧会让她划走。',
    '重点审核：开场第一帧是否就是冲突或对白（不能是空镜、logo、黑屏、字幕卡）；画面是否与讲述的情绪一致；是否出现长时间静止画面（超过 20 秒没有任何视觉变化）；字幕是否压住人脸或重要物件；竖屏安全区内的关键内容是否被右侧交互区和底部信息区遮挡；是否有连续多帧版式雷同。',
    '本片使用的是程序化绘制或生成的画面，不使用实拍素材。「没有真实拍摄镜头」是既定前提，不是缺陷，不得据此判定 editorialPass=false，也不得写进 findings。判据是画面有没有承担叙事作用，而不是像不像实拍。',
    '抽帧已经对齐每个场景的稳定期。因此某一帧仍是空白或半成品就是真实缺陷，不要归因为「入场动画未完成」。',
    `通过条件：technicalPass 与 editorialPass 都为 true，score 不低于 ${REVIEW_SCORE_THRESHOLD}，且 reviewEvidence 至少引用两个不同的已提供时间点并具体描述当时看到的主画面。无法从抽帧确认的内容不得臆测。`,
    '发现 blocker 或 major 问题时必须判定 editorialPass=false、passed=false，并写明准确时间点、实际看到的画面和可执行的问题描述。',
    '严格返回 schema 要求的结构化审核结果，不输出 Markdown 或额外说明。',
    scriptBody ? `稿件正文（判断画面是否忠实于内容时使用，不要评论文字本身）：\n${String(scriptBody).slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n\n')
}

/* -------------------------------- 结果合并 -------------------------------- */

function nearestSample(value, samples) {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number) || number < 0 || !samples.length) return null
  return samples.reduce((best, sample) => (Math.abs(sample - number) < Math.abs(best - number) ? sample : best), samples[0])
}

function clipped(value, maximum) {
  const text = String(value || '').trim()
  return text.length > maximum ? text.slice(0, maximum) : text
}

/**
 * 把模型判断与确定性闸门合并。
 *
 * 模型说通过不算通过：还要技术闸门真过了、分数够、证据是两个不同时间点。
 * 这一步是整条质检链路上唯一可信的判定点，store 层的 commitProduced 还会
 * 再校一遍结论一致性（passed 与 issues 是否矛盾），两道防护都保留。
 */
export function mergeReview(value, { technicalReport, sampledTimestamps } = {}) {
  const samples = Array.isArray(sampledTimestamps)
    ? sampledTimestamps.map(Number).filter((item) => Number.isFinite(item) && item >= 0)
    : []
  const findings = (Array.isArray(value?.findings) ? value.findings : [])
    .slice(0, REVIEW_FINDING_LIMIT)
    .map((item) => ({
      severity: REVIEW_FINDING_SEVERITIES.includes(item?.severity) ? item.severity : 'major',
      category: REVIEW_FINDING_CATEGORIES.includes(item?.category) ? item.category : 'composition',
      timestampSeconds: nearestSample(item?.timestampSeconds, samples),
      message: clipped(item?.message, 500) || '审核发现未提供具体说明。',
    }))
  const evidence = (Array.isArray(value?.reviewEvidence) ? value.reviewEvidence : [])
    .slice(0, REVIEW_EVIDENCE_LIMIT)
    .map((item) => ({
      timestampSeconds: nearestSample(item?.timestampSeconds, samples),
      observedMainVisual: clipped(item?.observedMainVisual, 600),
    }))
    .filter((item) => item.timestampSeconds !== null && item.observedMainVisual.length >= 12)
  const distinctEvidence = new Set(evidence.map((item) => item.timestampSeconds.toFixed(2))).size
  const score = Number.isSafeInteger(value?.score) && value.score >= 0 && value.score <= 100 ? value.score : 0

  const technicalPassed = technicalReport?.passed === true
  const technicalPass = technicalPassed && value?.technicalPass === true
  const editorialPass = value?.editorialPass === true && !findings.some((item) => ['blocker', 'major'].includes(item.severity))
  const passed = technicalPass && editorialPass && score >= REVIEW_SCORE_THRESHOLD && distinctEvidence >= 2 && value?.passed === true

  return {
    passed,
    technicalPass,
    editorialPass,
    evidencePassed: distinctEvidence >= 2,
    score,
    summary: clipped(value?.summary, 1000) || (passed ? '成片通过独立审核。' : '成片未通过独立审核。'),
    findings,
    reviewEvidence: evidence,
  }
}

/**
 * 最终闸门：技术 + 审片 + 反塑料感。
 *
 * 反塑料感本该在写稿阶段就拦住，这里再查一次的原因很实际——成片环节允许
 * 用「导入稿件」跳过写稿页，那条路径不会经过写稿质检。质检页是最后一次机会。
 */
/**
 * 从成片按给定时间点抽取全帧图片到任务目录，供独立审片 Agent 真正看图。
 *
 * 这一层是 B0 修复的核心：之前根本没有抽帧，审片 Agent 拿到的是空帧列表，
 * 却能用文字凭空编出「抽帧观察」并通过闸门。抽不到帧绝不静默继续——
 * 调用方（runIndependentReview）会据此判不通过并写明原因。
 */
export async function extractReviewFrames({ workspacePath, videoRelative, timestamps = [], durationSeconds = null }) {
  const videoAbsolute = join(workspacePath, 'data', videoRelative)
  const dir = join(workspacePath, 'data', 'media', 'qc', 'review-frames')
  await mkdir(dir, { recursive: true })
  const files = []
  for (const value of Array.isArray(timestamps) ? timestamps : []) {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0) continue
    if (durationSeconds != null && seconds >= durationSeconds) continue
    const file = join(dir, `frame-${Math.round(seconds * 1000)}.png`)
    await execFileAsync('ffmpeg', ['-y', '-ss', String(seconds), '-i', videoAbsolute, '-frames:v', '1', '-q:v', '2', file], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    files.push(file)
  }
  return files
}

/**
 * 独立审片会话：抽帧 → 按 buildReviewPrompt 的签名喂真实画面证据 → 子会话看图 →
 * 用确定性闸门 mergeReview 合并。没有可用抽帧画面时直接判不通过，绝不静默放行。
 */
export async function runIndependentReview({ reviewExecutor, workspacePath, videoFile, sampledTimestamps = [], topic, script, technicalReportFile = null, durationSeconds = null }) {
  if (typeof reviewExecutor !== 'function') throw new StoryQcError('STORY_QC_NOT_READY', '缺少独立审片执行器。')
  // 真抽帧：审片必须有画面证据。抽不到帧不能静默放行——返回明确的不通过结论。
  let frameFiles = []
  try {
    frameFiles = await extractReviewFrames({ workspacePath, videoRelative: videoFile, timestamps: sampledTimestamps, durationSeconds })
  } catch {
    frameFiles = []
  }
  if (frameFiles.length < 2) {
    return {
      passed: false,
      technicalPass: false,
      editorialPass: false,
      evidencePassed: false,
      score: 0,
      summary: '独立审片缺少可用的抽帧画面证据，无法据此判通过；质检闸门判不通过。',
      findings: [{ severity: 'blocker', category: 'technical', timestampSeconds: null, message: '未能从成片抽取审片抽帧画面，审片闸门缺少证据，按不通过处理。' }],
      reviewEvidence: [],
    }
  }
  const runDir = dirname(join(workspacePath, 'data', videoFile))
  const prompt = buildReviewPrompt({
    runDir,
    technicalReportFile: technicalReportFile ? join(workspacePath, 'data', technicalReportFile) : null,
    frameFiles,
    timestamps: sampledTimestamps,
    contactSheetFile: null,
    scriptBody: script?.body || '',
  })
  // 不在这里合并技术结论——技术结论由流水线在拿到 ffprobe 报告后统一合并，
  // 这里只负责「抽真帧 + 让子会话看图 + 返回原始审片结论」。没有「技术恒过」垫片。
  const raw = await reviewExecutor({ prompt, schema: STORY_REVIEW_SCHEMA })
  return raw
}

export function finalGate({ technicalReport, review, antiPlastic = null }) {
  const blockers = []
  if (technicalReport?.passed !== true) blockers.push(...(technicalReport?.issues?.length ? technicalReport.issues : ['技术质检未通过。']))
  if (!review) blockers.push('缺少独立审片报告。')
  else if (review.passed !== true) {
    const reasons = review.findings.filter((item) => ['blocker', 'major'].includes(item.severity)).map((item) => item.message)
    blockers.push(...(reasons.length ? reasons : [`独立审片未通过（评分 ${review.score}）。`]))
  }
  if (antiPlastic && antiPlastic.passed === false) blockers.push(...antiPlastic.blocking)
  return { passed: blockers.length === 0, blockers }
}
