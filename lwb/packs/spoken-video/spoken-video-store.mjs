import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spokenVideoDataPath } from './spoken-video-paths.mjs'
import { validateSrt } from './spoken-video-subtitles.mjs'
import { parseAccountSnapshot } from './spoken-video-topic.mjs'

const PROJECT_SCHEMA_VERSION = 1
const PROJECT_ID = /^[a-f0-9-]{36}$/iu
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/u
const STAGES = Object.freeze(['signals', 'topic', 'script', 'voiceover', 'subtitles', 'video', 'qc', 'packaging'])
const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage, index]))
const REQUIRED_POINTERS = Object.freeze({
  signals: [],
  topic: [],
  script: ['topic'],
  voiceover: ['script'],
  subtitles: ['voiceover'],
  video: ['voiceover'],
  qc: ['video'],
  packaging: ['qc'],
})

export class SpokenVideoStoreError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function failure(code, message) {
  return new SpokenVideoStoreError(code, message)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label} 必须是对象。`)
  return value
}

function text(value, label, maxLength, options = {}) {
  if (typeof value !== 'string') throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label} 必须是文本。`)
  const normalized = options.trim === false ? value : value.trim()
  if (!normalized || normalized.length > maxLength) throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label} 长度必须在 1-${maxLength} 之间。`)
  return normalized
}

function optionalText(value, label, maxLength, options) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  return text(value, label, maxLength, options)
}

function projectId(value) {
  const normalized = text(value, '项目标识', 36)
  if (!PROJECT_ID.test(normalized)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '项目标识无效。')
  return normalized.toLowerCase()
}

function idempotencyKey(value) {
  const normalized = text(value, '幂等标识', 128)
  if (!IDEMPOTENCY_KEY.test(normalized)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '幂等标识无效。')
  return normalized
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '项目版本无效。')
  return value
}

function stageName(value) {
  if (typeof value !== 'string' || !STAGE_INDEX.has(value)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '生产阶段无效。')
  return value
}

async function workspaceForAgent(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw failure('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '口播项目需要已加载的能力包专属工作区。')
  }
  try {
    const workspace = await realpath(cwd)
    const stats = await lstat(workspace)
    if (!stats.isDirectory()) throw new Error('not directory')
    return workspace
  } catch {
    throw failure('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '能力包专属工作区不可用，请重新加载能力包后重试。')
  }
}

async function directory(path, create = true) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw failure('SPOKEN_VIDEO_DIRECTORY_INVALID', '口播项目目录无效。')
  return path
}

async function projectsDirectory(workspace, create = true) {
  const spokenVideo = await directory(spokenVideoDataPath(workspace), create)
  if (!spokenVideo) return undefined
  return await directory(join(spokenVideo, 'projects'), create)
}

async function projectDirectory(workspace, id, create = true) {
  const root = await projectsDirectory(workspace, create)
  return root ? await directory(join(root, id), create) : undefined
}

function pathInside(root, candidate) {
  const relativePath = relative(root, candidate)
  return relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath)
}

async function readJson(path, label) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw failure('SPOKEN_VIDEO_NOT_FOUND', `${label} 不存在。`)
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw failure('SPOKEN_VIDEO_FILE_INVALID', `${label} 无效。`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw failure('SPOKEN_VIDEO_FILE_INVALID', `${label} 不是有效 JSON。`)
  }
}

async function writeJson(path, value) {
  const parent = dirname(path)
  await directory(parent)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await renameAtomic(temporary, path)
  } catch (error) {
    // 失败时清掉自己的临时文件：否则每次被拒都在数据目录留下一个整份状态副本。
    await unlink(temporary).catch(() => {})
    throw error
  }
}

// Windows 上 rename 的目标只要有任意打开句柄就会被拒（EPERM），而界面每 1.5s
// 轮询一次状态接口，读窗口正好会撞上写入——实测 topic-generations.json 连续
// 七次选题都因此失败。按退避重试吸收这个毫秒级窗口，总窗口约 8.6s；真故障仍抛出。
const RENAME_BACKOFF_MS = [50, 120, 280, 600, 1200, 2400, 4000]
async function renameAtomic(temporary, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, target)
      return
    } catch (error) {
      if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= RENAME_BACKOFF_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS[attempt]))
    }
  }
}

function pointer(value, label) {
  const input = object(value, label)
  const id = text(input.id, `${label}.id`, 36)
  const stage = stageName(input.stage)
  const revision = expectedRevision(input.revision)
  const file = text(input.file, `${label}.file`, 180)
  if (!new RegExp(`^artifacts/${revision}-${stage}-[a-f0-9-]{36}\\.json$`, 'iu').test(file)) {
    throw failure('SPOKEN_VIDEO_FILE_INVALID', `${label}.file 无效。`)
  }
  return {
    id,
    stage,
    revision,
    file,
    createdAt: text(input.createdAt, `${label}.createdAt`, 64),
    ...(input.passed === true ? { passed: true } : {}),
  }
}

function projectRecord(value) {
  const input = object(value, '项目文件')
  if (input.schemaVersion !== PROJECT_SCHEMA_VERSION) throw failure('SPOKEN_VIDEO_FILE_INVALID', '项目文件版本不受支持。')
  const id = projectId(input.id)
  const revision = expectedRevision(input.revision)
  const stage = stageName(input.stage)
  const artifactsInput = object(input.artifacts, '项目文件.artifacts')
  const artifacts = {}
  for (const [name, candidate] of Object.entries(artifactsInput)) {
    if (!STAGE_INDEX.has(name)) throw failure('SPOKEN_VIDEO_FILE_INVALID', '项目文件包含未知阶段。')
    artifacts[name] = pointer(candidate, `项目文件.artifacts.${name}`)
  }
  if (!Array.isArray(input.history) || !Array.isArray(input.receipts)) throw failure('SPOKEN_VIDEO_FILE_INVALID', '项目文件历史无效。')
  const approvalInput = input.scriptApproval === undefined || input.scriptApproval === null ? null : object(input.scriptApproval, '项目文件.scriptApproval')
  const scriptApproval = approvalInput
    ? {
      approvedAt: text(approvalInput.approvedAt, '项目文件.scriptApproval.approvedAt', 64),
      revision: expectedRevision(approvalInput.revision),
      // Who confirmed this revision: a person on the script page, or an
      // unattended content-schedule round. Absent on records written before
      // the field existed, which read as manual.
      source: approvalInput.source === 'automation' ? 'automation' : 'manual',
    }
    : null
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    title: text(input.title, '项目文件.title', 160),
    revision,
    stage,
    createdAt: text(input.createdAt, '项目文件.createdAt', 64),
    updatedAt: text(input.updatedAt, '项目文件.updatedAt', 64),
    artifacts,
    history: input.history.slice(-100),
    receipts: input.receipts.slice(-64),
    scriptApproval,
    // Older projects predate this field and stay eligible for writing.
    topicSelected: input.topicSelected !== false,
  }
}

async function readProject(workspace, id) {
  const root = await projectDirectory(workspace, id, false)
  if (!root) throw failure('SPOKEN_VIDEO_NOT_FOUND', '口播项目不存在。')
  return { root, project: projectRecord(await readJson(join(root, 'project.json'), '口播项目')) }
}

async function readArtifact(root, artifactPointer) {
  const target = resolve(root, artifactPointer.file)
  if (!pathInside(root, target)) throw failure('SPOKEN_VIDEO_FILE_INVALID', '阶段产物路径无效。')
  const artifact = object(await readJson(target, '阶段产物'), '阶段产物')
  if (artifact.projectId === undefined || artifact.id !== artifactPointer.id || artifact.stage !== artifactPointer.stage) {
    throw failure('SPOKEN_VIDEO_FILE_INVALID', '阶段产物与项目不匹配。')
  }
  return artifact
}

function stageData(stage, payload) {
  const input = object(payload, '阶段内容')
  if (stage === 'signals') {
    const item = {
      id: randomUUID(),
      source: optionalText(input.source, '信号来源', 80) || 'manual',
      text: text(input.text, '信号内容', 6000),
      capturedAt: new Date().toISOString(),
    }
    return { appendSignal: item }
  }
  if (stage === 'topic') return {
    title: text(input.title, '选题标题', 160),
    angle: optionalText(input.angle, '选题角度', 500) || null,
    account: parseAccountSnapshot(input.account),
    source: 'manual',
  }
  if (stage === 'script') return { body: text(input.body, '口播稿', 30000, { trim: false }), source: 'manual' }
  if (stage === 'voiceover') return { notes: text(input.notes, '配音说明', 6000, { trim: false }), mode: 'manual' }
  if (stage === 'subtitles') {
    const srt = text(input.srt, '字幕内容', 30000, { trim: false })
    const { cues, errors } = validateSrt(srt)
    if (errors.length) throw failure('SPOKEN_VIDEO_SUBTITLES_INVALID', `字幕格式无效：${errors.join(' ')}`)
    return { srt, mode: 'manual', cueCount: cues.length }
  }
  if (stage === 'video' || stage === 'qc' || stage === 'packaging') {
    throw failure('SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED', '视频制作、技术质检和发布包装只能由受控任务生成；任务失败后请修正问题并重试。')
  }
  throw failure('SPOKEN_VIDEO_INVALID_INPUT', '生产阶段无效。')
}

function mediaFile(value, label, prefix) {
  const file = text(value, label, 280)
  if (!new RegExp(`^media/${prefix}/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`, 'u').test(file)) {
    throw failure('SPOKEN_VIDEO_FILE_INVALID', `${label}无效。`)
  }
  return file
}

function mediaType(value, label, expected) {
  const type = text(value, label, 80)
  if (!expected.includes(type)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label}不受支持。`)
  return type
}

function optionalNumber(value, label, minimum, maximum) {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label}必须在 ${minimum}-${maximum} 之间。`)
  return Number(value)
}

function optionalInteger(value, label, minimum, maximum) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label}必须在 ${minimum}-${maximum} 之间。`)
  return value
}

function messages(value, label, maximum) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maximum) throw failure('SPOKEN_VIDEO_INVALID_INPUT', `${label}最多包含 ${maximum} 项。`)
  return value.map((item, index) => text(item, `${label}[${index}]`, 400))
}

function productionSource(value) {
  const source = text(value, '自动产物来源', 120)
  if (!/^spoken-video\/[a-z0-9-]+$/u.test(source)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '自动产物来源无效。')
  return source
}

function visualPlan(value) {
  if (value === undefined || value === null) return null
  const input = object(value, '视觉方案')
  const theme = text(input.theme, '视觉方案主题', 20)
  if (!['ink', 'ocean', 'coral', 'forest', 'plum'].includes(theme)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '视觉方案主题无效。')
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 8) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '视觉方案场景必须为 1-8 项。')
  const scenes = input.scenes.map((item, index) => {
    const scene = object(item, `视觉方案场景[${index}]`)
    const startPercent = optionalInteger(scene.startPercent, `视觉方案场景[${index}].startPercent`, 0, 99)
    const endPercent = optionalInteger(scene.endPercent, `视觉方案场景[${index}].endPercent`, 1, 100)
    if (startPercent === null || endPercent === null || endPercent <= startPercent) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '视觉方案场景时间范围无效。')
    const mode = text(scene.mode, `视觉方案场景[${index}].mode`, 20)
    if (!['editorial', 'kinetic', 'contrast', 'notebook', 'spotlight'].includes(mode)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '视觉方案场景模式无效。')
    return {
      startPercent, endPercent, mode,
      eyebrow: text(scene.eyebrow, `视觉方案场景[${index}].eyebrow`, 24),
      headline: text(scene.headline, `视觉方案场景[${index}].headline`, 48),
      supporting: text(scene.supporting, `视觉方案场景[${index}].supporting`, 96),
      emphasis: optionalText(scene.emphasis, `视觉方案场景[${index}].emphasis`, 24) || '',
    }
  })
  return { theme, coverTitle: text(input.coverTitle, '视觉方案封面标题', 160), scenes }
}

function agentWorkspacePath(value, label) {
  const file = text(value, label, 500)
  if (!/^media\/video-agent\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,160})*$/u.test(file)) {
    throw failure('SPOKEN_VIDEO_FILE_INVALID', `${label}无效。`)
  }
  return file
}

function sampledFrameFiles(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 8) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '质检抽帧最多包含 8 项。')
  return value.map((file, index) => agentWorkspacePath(file, `质检抽帧[${index}]`))
}

function reviewFindings(value) {
  if (!Array.isArray(value) || value.length > 12) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '独立审片问题最多包含 12 项。')
  return value.map((candidate, index) => {
    const item = object(candidate, `独立审片问题[${index}]`)
    const severity = text(item.severity, `独立审片问题[${index}].severity`, 20)
    const category = text(item.category, `独立审片问题[${index}].category`, 24)
    if (!['blocker', 'major', 'minor', 'note'].includes(severity)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '独立审片问题严重度无效。')
    if (!['technical', 'composition', 'readability', 'pacing', 'relevance', 'variation'].includes(category)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '独立审片问题类别无效。')
    return { severity, category, timestampSeconds: optionalNumber(item.timestampSeconds, `独立审片问题[${index}].timestampSeconds`, 0, 36_000), message: text(item.message, `独立审片问题[${index}].message`, 500) }
  })
}

function videoReview(value) {
  const input = object(value, '独立审片报告')
  if (!Array.isArray(input.reviewEvidence) || input.reviewEvidence.length < 2 || input.reviewEvidence.length > 8) {
    throw failure('SPOKEN_VIDEO_INVALID_INPUT', '独立审片证据必须包含 2-8 项。')
  }
  const reviewEvidence = input.reviewEvidence.map((candidate, index) => {
    const item = object(candidate, `独立审片证据[${index}]`)
    const timestampSeconds = optionalNumber(item.timestampSeconds, `独立审片证据[${index}].timestampSeconds`, 0, 36_000)
    if (timestampSeconds === null) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '独立审片证据缺少时间点。')
    return { timestampSeconds, observedMainVisual: text(item.observedMainVisual, `独立审片证据[${index}].observedMainVisual`, 600) }
  })
  return {
    passed: input.passed === true,
    technicalPass: input.technicalPass === true,
    editorialPass: input.editorialPass === true,
    evidencePassed: input.evidencePassed === true,
    score: optionalInteger(input.score, '独立审片评分', 0, 100) ?? 0,
    summary: text(input.summary, '独立审片摘要', 1000),
    findings: reviewFindings(input.findings),
    reviewEvidence,
  }
}

function publishContent(value) {
  const input = object(value, '发布内容')
  if (!Array.isArray(input.tags) || input.tags.length < 1 || input.tags.length > 10) {
    throw failure('SPOKEN_VIDEO_INVALID_INPUT', '发布标签必须包含 1-10 项。')
  }
  const tags = [...new Set(input.tags.map((tag, index) => text(tag, `发布标签[${index}]`, 30).replace(/^#/u, '')))]
  if (!tags.length) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '发布标签不能为空。')
  return {
    title: text(input.title, '发布标题', 80),
    copy: text(input.copy, '视频文案', 2000, { trim: false }),
    description: text(input.description, '视频描述', 1000, { trim: false }),
    tags,
  }
}

function publishCover(value, label) {
  if (value === undefined || value === null) return null
  const input = object(value, label)
  return {
    file: mediaFile(input.file, `${label}文件`, 'publish-covers'),
    mediaType: mediaType(input.mediaType, `${label}类型`, ['image/png', 'image/jpeg', 'image/webp']),
    bytes: optionalInteger(input.bytes, `${label}字节数`, 1, 20 * 1024 * 1024),
    width: optionalInteger(input.width, `${label}宽度`, 1, 8_192),
    height: optionalInteger(input.height, `${label}高度`, 1, 8_192),
    source: text(input.source, `${label}来源`, 20),
  }
}

function publishPackaging(value) {
  const input = object(value, '发布包装')
  const prompts = object(input.prompts, '封面提示词')
  const covers = object(input.covers, '发布封面')
  const errors = input.coverErrors === undefined || input.coverErrors === null ? {} : object(input.coverErrors, '封面错误')
  const provider = input.imageProvider === undefined || input.imageProvider === null ? null : object(input.imageProvider, '生图配置')
  const mode = text(input.mode, '发布包装模式', 40)
  if (!['agent', 'manual-update', 'cover-upload', 'cover-regenerate'].includes(mode)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '发布包装模式无效。')
  return {
    mode,
    taskId: optionalText(input.taskId, '发布包装任务标识', 200) || null,
    content: publishContent(input.content),
    prompts: {
      landscape: text(prompts.landscape, '横屏封面提示词', 3000, { trim: false }),
      portrait: text(prompts.portrait, '竖屏封面提示词', 3000, { trim: false }),
      negative: optionalText(prompts.negative, '封面负面提示词', 1000, { trim: false }) || '',
    },
    covers: {
      landscape: publishCover(covers.landscape, '横屏封面'),
      portrait: publishCover(covers.portrait, '竖屏封面'),
    },
    imageProvider: provider ? {
      provider: text(provider.provider, '生图渠道', 40),
      model: text(provider.model, '生图模型', 120),
    } : null,
    coverErrors: {
      landscape: optionalText(errors.landscape, '横屏封面错误', 500) || null,
      portrait: optionalText(errors.portrait, '竖屏封面错误', 500) || null,
    },
    generatedAt: text(input.generatedAt, '发布时间', 64),
  }
}

/** Validate the limited production payload written only by the host media adapters. */
function producedStageData(stage, payload) {
  const input = object(payload, '自动阶段内容')
  if (stage === 'voiceover') {
    const audio = object(input.audio, '自动配音')
    const settings = object(input.settings, '配音参数')
    return {
      mode: text(input.mode, '配音模式', 40), provider: text(input.provider, 'TTS 提供方', 80), taskId: optionalText(input.taskId, 'TTS 任务标识', 200) || null,
      voiceId: optionalText(input.voiceId, '音色标识', 160) || null, voiceName: optionalText(input.voiceName, '音色名称', 120) || null,
      settings: {
        rate: optionalNumber(settings.rate, '配音参数.rate', 0.5, 2) ?? 1,
        volume: optionalNumber(settings.volume, '配音参数.volume', 0, 2) ?? 1,
        pitch: optionalNumber(settings.pitch, '配音参数.pitch', -12, 12) ?? 0,
      },
      audio: {
        file: mediaFile(audio.file, '自动配音文件', 'voiceovers'),
        mediaType: mediaType(audio.mediaType, '自动配音类型', ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg']),
        bytes: optionalInteger(audio.bytes, '自动配音字节数', 1, 80 * 1024 * 1024),
        durationSeconds: optionalNumber(audio.durationSeconds, '自动配音时长', 0.01, 36_000),
        sampleRate: optionalInteger(audio.sampleRate, '自动配音采样率', 1, 384_000),
      },
    }
  }
  if (stage === 'subtitles') {
    const srt = text(input.srt, '自动字幕内容', 30000, { trim: false })
    const checked = validateSrt(srt)
    if (checked.errors.length) throw failure('SPOKEN_VIDEO_SUBTITLES_INVALID', `字幕格式无效：${checked.errors.join(' ')}`)
    return {
      mode: text(input.mode, '字幕模式', 40), taskId: optionalText(input.taskId, '字幕任务标识', 200) || null,
      sourceAudioFile: mediaFile(input.sourceAudioFile, '字幕来源配音文件', 'voiceovers'), srt,
      srtFile: mediaFile(input.srtFile, '自动字幕文件', 'subtitles'), cueCount: checked.cues.length,
    }
  }
  if (stage === 'video') {
    const video = object(input.video, '自动视频')
    const backgroundMusic = input.backgroundMusic === undefined || input.backgroundMusic === null ? null : object(input.backgroundMusic, '背景音乐')
    const orientation = optionalText(input.orientation, '视频方向', 20) || 'portrait'
    if (!['portrait', 'landscape'].includes(orientation)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '视频方向无效。')
    const plan = visualPlan(input.visualPlan)
    const planSource = optionalText(input.visualPlanSource, '视觉方案来源', 40)
    if (planSource && !['dsh', 'deterministic-fallback'].includes(planSource)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '视觉方案来源无效。')
    const fallback = input.fallback === undefined || input.fallback === null ? null : object(input.fallback, '渲染降级信息')
    const remotion = input.remotion === undefined || input.remotion === null ? null : object(input.remotion, 'Remotion Agent 产物')
    const preflight = remotion?.preflight === undefined || remotion?.preflight === null ? null : object(remotion.preflight, 'Remotion 预检')
    const preflightFailures = preflight ? messages(preflight.failures, 'Remotion 预检问题', 20) : []
    if (preflight && ((preflight.passed === true) !== (preflightFailures.length === 0))) throw failure('SPOKEN_VIDEO_INVALID_INPUT', 'Remotion 预检结论不一致。')
    const editorialRepair = remotion?.editorialRepair === undefined || remotion?.editorialRepair === null ? null : object(remotion.editorialRepair, 'Remotion 审片修复')
    const repairAttempts = editorialRepair ? optionalInteger(editorialRepair.attempts, 'Remotion 审片修复次数', 0, 2) : 0
    const repairMaximum = editorialRepair ? optionalInteger(editorialRepair.maxAttempts, 'Remotion 审片修复上限', 0, 2) : 0
    const repairHistory = editorialRepair ? (Array.isArray(editorialRepair.history) ? editorialRepair.history : null) : []
    if (editorialRepair && (!repairHistory || repairHistory.length < 1 || repairHistory.length > 3 || repairAttempts !== repairHistory.length - 1 || repairAttempts > repairMaximum)) {
      throw failure('SPOKEN_VIDEO_INVALID_INPUT', 'Remotion 审片修复历史与次数不一致。')
    }
    return {
      mode: text(input.mode, '视频模式', 40), renderer: text(input.renderer, '渲染器', 80), orientation, visualBrief: text(input.visualBrief, '画面制作说明', 6000, { trim: false }),
      sourceAudioFile: mediaFile(input.sourceAudioFile, '视频来源配音文件', 'voiceovers'),
      subtitleEnabled: input.subtitleEnabled !== false,
      sourceSubtitleFile: input.sourceSubtitleFile === null ? null : mediaFile(input.sourceSubtitleFile, '视频来源字幕文件', 'subtitles'),
      sourceBgmFile: input.sourceBgmFile === undefined || input.sourceBgmFile === null ? null : mediaFile(input.sourceBgmFile, '视频来源背景音乐文件', 'bgm-uploads'),
      backgroundMusic: backgroundMusic ? {
        id: text(backgroundMusic.id, '背景音乐标识', 64),
        file: mediaFile(backgroundMusic.file, '背景音乐文件', 'bgm-uploads'),
        name: text(backgroundMusic.name, '背景音乐名称', 255),
        mediaType: mediaType(backgroundMusic.mediaType, '背景音乐类型', ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg']),
        bytes: optionalInteger(backgroundMusic.bytes, '背景音乐字节数', 1, 20 * 1024 * 1024),
        durationSeconds: optionalNumber(backgroundMusic.durationSeconds, '背景音乐时长', 0.01, 36_000),
      } : null,
      bgmVolume: backgroundMusic ? optionalNumber(input.bgmVolume, 'BGM 音量', 0, 0.5) ?? 0.12 : null,
      ...(plan ? { visualPlan: plan } : {}), ...(planSource ? { visualPlanSource: planSource } : {}),
      ...(fallback ? { fallback: { from: text(fallback.from, '渲染降级来源', 40), reason: text(fallback.reason, '渲染降级原因', 500) } } : {}),
      ...(remotion?.projectDir ? { remotion: {
        projectDir: agentWorkspacePath(remotion.projectDir, 'Remotion 项目目录'),
        propsFile: agentWorkspacePath(remotion.propsFile, 'Remotion 参数文件'),
        entryFile: agentWorkspacePath(remotion.entryFile, 'Remotion 入口文件'),
        ...(remotion.creativeFile ? { creativeFile: agentWorkspacePath(remotion.creativeFile, 'Remotion 创意源文件') } : {}),
        ...(preflight ? { preflight: { passed: preflight.passed === true, failures: preflightFailures, creativeBytes: optionalInteger(preflight.creativeBytes, 'Remotion 创意源字节数', 1, 2_000_000) } } : {}),
        ...(editorialRepair ? { editorialRepair: {
          attempts: repairAttempts,
          maxAttempts: repairMaximum,
          history: repairHistory.map((item, index) => {
            const entry = object(item, `Remotion 审片修复历史[${index}]`)
            const attempt = optionalInteger(entry.attempt, `Remotion 审片修复历史[${index}].attempt`, 0, 2)
            if (attempt !== index) throw failure('SPOKEN_VIDEO_INVALID_INPUT', 'Remotion 审片修复历史顺序无效。')
            return {
              attempt,
              passed: entry.passed === true,
              score: optionalInteger(entry.score, `Remotion 审片修复历史[${index}].score`, 0, 100),
              summary: text(entry.summary, `Remotion 审片修复历史[${index}].summary`, 1000),
              reviewReportFile: agentWorkspacePath(entry.reviewReportFile, `Remotion 审片修复历史[${index}].reviewReportFile`),
            }
          }),
        } } : {}),
      } } : {}),
      video: {
        file: mediaFile(video.file, '自动视频文件', 'videos'), mediaType: mediaType(video.mediaType, '自动视频类型', ['video/mp4']),
        bytes: optionalInteger(video.bytes, '自动视频字节数', 1024, 80 * 1024 * 1024), durationSeconds: optionalNumber(video.durationSeconds, '自动视频时长', 0.01, 36_000),
        width: optionalInteger(video.width, '自动视频宽度', 1, 8_192), height: optionalInteger(video.height, '自动视频高度', 1, 8_192),
        fps: optionalNumber(video.fps, '自动视频帧率', 1, 240), frameCount: optionalInteger(video.frameCount, '自动视频帧数', 1, 10_000_000), hasAudio: video.hasAudio === true,
      },
    }
  }
  if (stage === 'qc') {
    const technical = object(input.technical, '技术质检报告')
    const passed = input.passed === true
    const issues = messages(technical.issues, '技术质检问题', 40)
    const warnings = messages(technical.warnings, '技术质检警告', 40)
    if ((technical.passed === true) !== passed) {
      throw failure('SPOKEN_VIDEO_QC_FAILED', '技术质检结论与通过状态不一致。')
    }
    if (passed && issues.length) {
      throw failure('SPOKEN_VIDEO_QC_FAILED', '存在技术质检问题时不能标记为通过。')
    }
    const mode = text(input.mode, '质检模式', 40)
    const review = input.review === undefined || input.review === null ? null : videoReview(input.review)
    if (mode === 'ai-director' && !review) throw failure('SPOKEN_VIDEO_QC_FAILED', 'AI 视频质检缺少独立审片报告。')
    if (passed && review && !review.passed) throw failure('SPOKEN_VIDEO_QC_FAILED', '独立审片未通过时不能标记质检通过。')
    const variationInput = technical.variation === undefined || technical.variation === null ? null : object(technical.variation, '主画面变化报告')
    return {
      mode, reportFile: mediaFile(input.reportFile, '技术质检报告文件', 'qc'),
      ...(input.reviewFile ? { reviewFile: mediaFile(input.reviewFile, '独立审片报告文件', 'qc') } : {}),
      passed,
      technical: {
        passed: technical.passed === true, issues, warnings,
        video: object(technical.video, '技术质检视频信息'), audio: object(technical.audio, '技术质检音频信息'),
        subtitles: object(technical.subtitles, '技术质检字幕信息'),
        ...(variationInput ? { variation: {
          assessed: variationInput.assessed === true,
          passed: variationInput.passed === true,
          sampledFrameCount: optionalInteger(variationInput.sampledFrameCount, '主画面抽帧数', 1, 8),
          distinctMainFrames: optionalInteger(variationInput.distinctMainFrames, '主画面不同帧数', 1, 8),
          meaningfulPairs: optionalInteger(variationInput.meaningfulPairs, '主画面有效变化对数', 0, 7),
          averagePairDifference: optionalNumber(variationInput.averagePairDifference, '主画面平均变化值', 0, 255),
          pairDifferences: Array.isArray(variationInput.pairDifferences) ? variationInput.pairDifferences.slice(0, 7).map((item, index) => optionalNumber(item, `主画面变化值[${index}]`, 0, 255) ?? 0) : [],
          crop: text(variationInput.crop, '主画面检测区域', 80),
          ...(variationInput.note ? { note: text(variationInput.note, '主画面变化说明', 300) } : {}),
        } } : {}),
      },
      ...(review ? { review } : {}),
      sampledFrames: sampledFrameFiles(input.sampledFrames),
    }
  }
  if (stage === 'packaging') return publishPackaging(input)
  throw failure('SPOKEN_VIDEO_INVALID_INPUT', '自动生产阶段无效。')
}

function satisfied(project, stage) {
  for (const required of REQUIRED_POINTERS[stage]) {
    if (!project.artifacts[required]) throw failure('SPOKEN_VIDEO_STAGE_BLOCKED', `当前阶段需要先完成「${required}」。`)
  }
  if (stage === 'packaging' && !(project.artifacts.qc?.passed === true)) {
    throw failure('SPOKEN_VIDEO_STAGE_BLOCKED', '质检未通过，不能生成发布资料。')
  }
}

function invalidateDownstream(project, stage) {
  const index = STAGE_INDEX.get(stage)
  for (const [name] of Object.entries(project.artifacts)) {
    if (STAGE_INDEX.get(name) >= index) delete project.artifacts[name]
  }
}

function projectSummary(project) {
  const scriptApproved = Boolean(project.scriptApproval && project.artifacts.script && project.scriptApproval.revision >= project.artifacts.script.revision)
  return {
    id: project.id,
    title: project.title,
    revision: project.revision,
    stage: project.stage,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    completedStages: STAGES.filter((stage) => project.artifacts[stage] !== undefined),
    scriptApproval: project.scriptApproval ? { ...project.scriptApproval, current: scriptApproved } : null,
    topicSelected: project.topicSelected,
  }
}

async function projectSummaryWithAccount(root, project) {
  let account = null
  try {
    const topic = project.artifacts.topic
    if (topic) account = (await readArtifact(root, topic)).data?.account || null
  } catch (_) { account = null }
  return { ...projectSummary(project), account }
}

/** Workspace-isolated, durable project and immutable stage-artifact store. */
export class SpokenVideoProjectStore {
  constructor() {
    this.writes = new Map()
  }

  async list(agent) {
    const workspace = await workspaceForAgent(agent)
    const root = await projectsDirectory(workspace, false)
    if (!root) return []
    const entries = await readdir(root, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID.test(entry.name)) continue
      try {
        const project = projectRecord(await readJson(join(root, entry.name, 'project.json'), '口播项目'))
        projects.push(await projectSummaryWithAccount(join(root, entry.name), project))
      } catch (error) {
        if (error instanceof SpokenVideoStoreError) continue
        throw error
      }
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Searchable, paginated selector feed for the audio workbench. */
  async listScripts(agent, request = {}) {
    const input = object(request, '稿件列表请求')
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0
    const limit = Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50 ? input.limit : 8
    const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? projectId(input.accountId) : null
    const generalOnly = input.general === true
    const workspace = await workspaceForAgent(agent)
    const root = await projectsDirectory(workspace, false)
    if (!root) return { items: [], total: 0 }
    const entries = await readdir(root, { withFileTypes: true })
    const scripts = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID.test(entry.name)) continue
      try {
        const projectRoot = join(root, entry.name)
        const project = projectRecord(await readJson(join(projectRoot, 'project.json'), '口播项目'))
        const pointer = project.artifacts.script
        if (!pointer) continue
        const body = (await readArtifact(projectRoot, pointer)).data?.body
        if (typeof body !== 'string' || !body.trim()) continue
        const searchable = `${project.title}\n${body}`.toLowerCase()
        if (query && !searchable.includes(query)) continue
        const account = (await projectSummaryWithAccount(projectRoot, project)).account
        if (accountId && account?.id !== accountId) continue
        if (generalOnly && account) continue
        const approved = Boolean(project.scriptApproval && project.scriptApproval.revision >= pointer.revision)
        scripts.push({
          id: project.id,
          title: project.title,
          revision: project.revision,
          updatedAt: project.updatedAt,
          approvedAt: approved ? project.scriptApproval.approvedAt : null,
          scriptChars: Array.from(body.replace(/\s+/g, '')).length,
          account,
        })
      } catch (error) {
        if (error instanceof SpokenVideoStoreError) continue
        throw error
      }
    }
    scripts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { items: scripts.slice(offset, offset + limit), total: scripts.length }
  }

  async listApprovedScripts(agent, request = {}) {
    const input = object(request, '已确认稿件列表请求')
    const result = await this.listScripts(agent, { ...input, offset: 0, limit: 50 })
    const approvedItems = result.items.filter((item) => item.approvedAt)
    const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0
    const limit = Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50 ? input.limit : 8
    return { items: approvedItems.slice(offset, offset + limit), total: approvedItems.length }
  }

  async create(agent, request) {
    const input = object(request, '创建项目请求')
    const workspace = await workspaceForAgent(agent)
    const id = randomUUID()
    const root = await projectDirectory(workspace, id)
    await directory(join(root, 'artifacts'))
    const now = new Date().toISOString()
    const project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id,
      title: text(input.title, '项目标题', 160),
      revision: 1,
      stage: 'signals',
      createdAt: now,
      updatedAt: now,
      artifacts: {},
      history: [],
      receipts: [],
      topicSelected: true,
    }
    await writeJson(join(root, 'project.json'), project)
    return projectSummary(project)
  }

  async get(agent, request) {
    const workspace = await workspaceForAgent(agent)
    const { root, project } = await readProject(workspace, projectId(object(request, '读取项目请求').projectId))
    const artifacts = {}
    for (const [stage, artifactPointer] of Object.entries(project.artifacts)) {
      const artifact = await readArtifact(root, artifactPointer)
      artifacts[stage] = { ...artifactPointer, data: artifact.data, passed: artifact.data?.passed === true }
    }
    return { ...(await projectSummaryWithAccount(root, project)), artifacts }
  }

  async commit(agent, request) {
    const input = object(request, '阶段提交请求')
    const workspace = await workspaceForAgent(agent)
    const id = projectId(input.projectId)
    const key = idempotencyKey(input.idempotencyKey)
    const stage = stageName(input.stage)
    const expected = expectedRevision(input.expectedRevision)
    const writeKey = `${workspace}\u0000${id}`
    const previous = this.writes.get(writeKey) || Promise.resolve()
    const result = previous.then(async () => {
      const { root, project } = await readProject(workspace, id)
      const operation = `${stage}:${key}`
      const prior = project.receipts.find((receipt) => receipt.operation === operation)
      if (prior) return prior.result
      if (project.revision !== expected) {
        throw failure('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已被其他操作更新，请刷新后重试。')
      }
      if (stage === 'video' || stage === 'qc' || stage === 'packaging') {
        throw failure('SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED', '视频制作、技术质检和发布包装只能由受控任务生成；任务失败后请修正问题并重试。')
      }
      satisfied(project, stage)
      if (stage === 'qc' && project.artifacts.qc) {
        const priorQc = await readArtifact(root, project.artifacts.qc)
        if (priorQc.data?.mode === 'automatic' && priorQc.data?.passed === false) {
          throw failure('SPOKEN_VIDEO_QC_FAILED', '自动技术质检未通过。请修复并重新生成视频后再次运行技术质检，不能用人工质检覆盖失败结果。')
        }
      }
      const data = stageData(stage, input.payload)
      if (stage === 'signals') {
        const current = project.artifacts.signals ? await readArtifact(root, project.artifacts.signals) : undefined
        data.items = [...(Array.isArray(current?.data?.items) ? current.data.items : []), data.appendSignal]
        delete data.appendSignal
      }
      invalidateDownstream(project, stage)
      const revision = project.revision + 1
      const artifactId = randomUUID()
      const createdAt = new Date().toISOString()
      const file = `artifacts/${revision}-${stage}-${artifactId}.json`
      const artifact = { schemaVersion: PROJECT_SCHEMA_VERSION, id: artifactId, projectId: project.id, stage, revision, createdAt, source: 'manual', data }
      await writeJson(join(root, file), artifact)
      const artifactPointer = { id: artifactId, stage, revision, file, createdAt, ...(data.passed === true ? { passed: true } : {}) }
      project.artifacts[stage] = artifactPointer
      project.revision = revision
      project.stage = stage
      project.updatedAt = createdAt
      project.history = [...project.history, { ...artifactPointer }].slice(-100)
      const response = { project: projectSummary(project), artifact: artifactPointer }
      project.receipts = [...project.receipts, { operation, result: response }].slice(-64)
      await writeJson(join(root, 'project.json'), project)
      return response
    })
    const tail = result.catch(() => {})
    this.writes.set(writeKey, tail)
    try {
      return await result
    } finally {
      if (this.writes.get(writeKey) === tail) this.writes.delete(writeKey)
    }
  }

  /**
   * Commit a host-produced artifact after its adapter has written a constrained
   * project-local media file. This is deliberately not exposed through the
   * browser gateway: callers cannot forge a TTS/ASR/render source or bypass
   * the adapter's provider boundary.
   */
  async commitProduced(agent, request) {
    const input = object(request, '自动阶段提交请求')
    const workspace = await workspaceForAgent(agent)
    const id = projectId(input.projectId)
    const key = idempotencyKey(input.idempotencyKey)
    const stage = stageName(input.stage)
    if (!['voiceover', 'subtitles', 'video', 'qc', 'packaging'].includes(stage)) throw failure('SPOKEN_VIDEO_INVALID_INPUT', '该阶段不支持自动产物提交。')
    const expected = expectedRevision(input.expectedRevision)
    const source = productionSource(input.source)
    const writeKey = `${workspace}\u0000${id}`
    const previous = this.writes.get(writeKey) || Promise.resolve()
    const result = previous.then(async () => {
      const { root, project } = await readProject(workspace, id)
      const operation = `${stage}:${key}`
      const prior = project.receipts.find((receipt) => receipt.operation === operation)
      if (prior) return prior.result
      if (project.revision !== expected) throw failure('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已被其他操作更新，请刷新后重试。')
      satisfied(project, stage)
      const data = producedStageData(stage, input.payload)
      invalidateDownstream(project, stage)
      const revision = project.revision + 1
      const artifactId = randomUUID()
      const createdAt = new Date().toISOString()
      const file = `artifacts/${revision}-${stage}-${artifactId}.json`
      const artifact = { schemaVersion: PROJECT_SCHEMA_VERSION, id: artifactId, projectId: project.id, stage, revision, createdAt, source, data }
      await writeJson(join(root, file), artifact)
      const artifactPointer = { id: artifactId, stage, revision, file, createdAt, ...(data.passed === true ? { passed: true } : {}) }
      project.artifacts[stage] = artifactPointer
      project.revision = revision
      project.stage = stage
      project.updatedAt = createdAt
      project.history = [...project.history, { ...artifactPointer }].slice(-100)
      const response = { project: projectSummary(project), artifact: artifactPointer }
      project.receipts = [...project.receipts, { operation, result: response }].slice(-64)
      await writeJson(join(root, 'project.json'), project)
      return response
    })
    const tail = result.catch(() => {})
    this.writes.set(writeKey, tail)
    try {
      return await result
    } finally {
      if (this.writes.get(writeKey) === tail) this.writes.delete(writeKey)
    }
  }

  /**
   * approve_draft gate: mark the current script revision as confirmed. The
   * approval is revision-bound, so any later script commit invalidates it
   * automatically. Not an artifact stage — recorded on project.json.
   *
   * `source` records who confirmed: 'manual' (default, a person on the script
   * page) or 'automation' (an unattended content-schedule round that reached a
   * depth authorising it). The gate itself is identical either way.
   */
  async approveScript(agent, request) {
    const workspace = await workspaceForAgent(agent)
    const input = object(request, '确认稿件请求')
    const id = projectId(input.projectId)
    const source = input.source === 'automation' ? 'automation' : 'manual'
    const writeKey = `${workspace}\u0000${id}`
    const previous = this.writes.get(writeKey) || Promise.resolve()
    const result = previous.then(async () => {
      const { root, project } = await readProject(workspace, id)
      const scriptPointer = project.artifacts.script
      if (!scriptPointer) throw failure('SPOKEN_VIDEO_STAGE_BLOCKED', '当前项目还没有口播稿，无法确认。')
      project.scriptApproval = { approvedAt: new Date().toISOString(), revision: scriptPointer.revision, source }
      await writeJson(join(root, 'project.json'), project)
      return projectSummary(project)
    })
    const tail = result.catch(() => {})
    this.writes.set(writeKey, tail)
    try {
      return await result
    } finally {
      if (this.writes.get(writeKey) === tail) this.writes.delete(writeKey)
    }
  }

  /** Keep a topic in or out of the writing queue before any script exists. */
  async setTopicSelected(agent, request) {
    const input = object(request, '设置待写稿选题请求')
    const workspace = await workspaceForAgent(agent)
    const id = projectId(input.projectId)
    if (typeof input.selected !== 'boolean') throw failure('SPOKEN_VIDEO_INVALID_INPUT', '待写稿状态必须是布尔值。')
    const writeKey = `${workspace}\u0000${id}`
    const previous = this.writes.get(writeKey) || Promise.resolve()
    const result = previous.then(async () => {
      const { root, project } = await readProject(workspace, id)
      if (!project.artifacts.topic) throw failure('SPOKEN_VIDEO_STAGE_BLOCKED', '项目尚未完成选题，不能调整待写稿状态。')
      if (!input.selected && project.artifacts.script) {
        throw failure('SPOKEN_VIDEO_STAGE_BLOCKED', '该选题已有稿件，不能直接移出待写稿；请改用归档流程保留生产记录。')
      }
      if (project.topicSelected === input.selected) return projectSummary(project)
      project.topicSelected = input.selected
      project.updatedAt = new Date().toISOString()
      await writeJson(join(root, 'project.json'), project)
      return projectSummary(project)
    })
    const tail = result.catch(() => {})
    this.writes.set(writeKey, tail)
    try {
      return await result
    } finally {
      if (this.writes.get(writeKey) === tail) this.writes.delete(writeKey)
    }
  }

  /**
   * Topic-picker feed for the script page: one card per project whose topic is
   * confirmed, carrying everything the picker needs to group and rank (account
   * snapshot, angle, signal count, script state) without shipping script
   * bodies. `account` stays the project's frozen snapshot — whether that
   * account is still active is the account library's business, decided by the
   * caller. Read-only.
   */
  async listWritableTopics(agent) {
    const workspace = await workspaceForAgent(agent)
    const root = await projectsDirectory(workspace, false)
    if (!root) return []
    const entries = await readdir(root, { withFileTypes: true })
    const topics = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID.test(entry.name)) continue
      try {
        const projectRoot = join(root, entry.name)
        const project = projectRecord(await readJson(join(projectRoot, 'project.json'), '口播项目'))
        if (!project.topicSelected) continue
        const topicPointer = project.artifacts.topic
        if (!topicPointer) continue
        const topic = (await readArtifact(projectRoot, topicPointer)).data
        const signalsPointer = project.artifacts.signals
        const signalItems = signalsPointer ? (await readArtifact(projectRoot, signalsPointer)).data?.items : null
        const scriptPointer = project.artifacts.script
        const scriptBody = scriptPointer ? (await readArtifact(projectRoot, scriptPointer)).data?.body : null
        const hasScript = typeof scriptBody === 'string' && Boolean(scriptBody.trim())
        const approved = Boolean(
          project.scriptApproval &&
          scriptPointer &&
          project.scriptApproval.revision >= scriptPointer.revision,
        )
        topics.push({
          projectId: project.id,
          title: project.title,
          revision: project.revision,
          stage: project.stage,
          updatedAt: project.updatedAt,
          angle: typeof topic?.angle === 'string' && topic.angle.trim() ? topic.angle : null,
          account: topic?.account && typeof topic.account === 'object'
            ? { id: topic.account.id, name: topic.account.name, revision: topic.account.revision }
            : null,
          signalCount: Array.isArray(signalItems) ? signalItems.length : 0,
          scriptState: approved ? 'approved' : hasScript ? 'draft' : 'none',
          scriptChars: hasScript ? Array.from(scriptBody.replace(/\s+/g, '')).length : 0,
          approvalRevision: approved ? project.scriptApproval.revision : null,
          approvedAt: approved ? project.scriptApproval.approvedAt : null,
        })
      } catch (error) {
        if (error instanceof SpokenVideoStoreError) continue
        throw error
      }
    }
    return topics.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * Similarity corpus: latest saved script of every project (optionally
   * excluding one), as { projectId, title, body }. Read-only.
   */
  async listScriptCorpus(agent, request) {
    const workspace = await workspaceForAgent(agent)
    const exclude = object(request ?? {}, '查重语料请求').excludeProjectId
    const root = await projectsDirectory(workspace, false)
    if (!root) return []
    const entries = await readdir(root, { withFileTypes: true })
    const corpus = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID.test(entry.name)) continue
      if (exclude && entry.name === exclude) continue
      try {
        const project = projectRecord(await readJson(join(root, entry.name, 'project.json'), '口播项目'))
        const scriptPointer = project.artifacts.script
        if (!scriptPointer) continue
        const artifact = await readArtifact(join(root, entry.name), scriptPointer)
        const body = artifact?.data?.body
        if (typeof body !== 'string' || !body.trim()) continue
        corpus.push({ projectId: project.id, title: project.title, body })
      } catch (error) {
        if (error instanceof SpokenVideoStoreError) continue
        throw error
      }
    }
    return corpus
  }
}
