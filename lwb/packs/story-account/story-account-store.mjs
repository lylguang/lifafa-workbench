/**
 * 工作区隔离的、可恢复的项目与阶段产物存储。
 *
 * 骨架沿用通用口播包（阶段化产物、单调 revision、幂等回执、下游失效），
 * 但阶段集合与校验规则整套换掉：
 *
 *   定位（profile）→ 选题（topic）→ 稿件（script）→ 配音（voiceover）
 *   → 字幕（subtitles）→ 成片（video）→ 质检（qc）→ 发布资料（packaging）
 *
 * 两个刻意的差异：
 *
 * 1) 稿件阶段写入前强制跑反塑料感检查，硬拦项命中直接拒绝落库。这是本包
 *    「减少人工参与」的关键——人可以跳过阅读，但跳不过这道闸门。
 * 2) 质检阶段是**不可人工覆盖**的：没有自动质检结论就不能提交包装，自动质检
 *    失败后也不能用人工结论覆盖。两个闸门都是「与」的关系。
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { finalGate } from './story-account-qc.mjs'
import { storyAccountDataPath } from './story-account-paths.mjs'
import { checkAntiPlastic } from './story-account-antiplastic.mjs'
import { parseAccountSnapshot } from './story-account-profile.mjs'
import { validateSrt } from './story-account-subtitles.mjs'

const PROJECT_SCHEMA_VERSION = 1
const PROJECT_ID = /^[a-f0-9-]{36}$/iu
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/u

export const STORY_STAGES = Object.freeze(['topic', 'script', 'voiceover', 'subtitles', 'video', 'qc', 'packaging'])
const STAGE_INDEX = new Map(STORY_STAGES.map((stage, index) => [stage, index]))

const REQUIRED_POINTERS = Object.freeze({
  topic: [],
  script: ['topic'],
  voiceover: ['script'],
  subtitles: ['voiceover'],
  video: ['voiceover'],
  qc: ['video'],
  packaging: ['qc'],
})

/** 允许由受控任务自动写入的阶段。其余阶段只能人工提交。 */
const PRODUCIBLE_STAGES = Object.freeze(['voiceover', 'subtitles', 'video', 'qc', 'packaging'])

export class StoryStoreError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function failure(code, message) { return new StoryStoreError(code, message) }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}必须是对象。`)
  return value
}

function text(value, label, maximum, options = {}) {
  if (typeof value !== 'string') throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}必须是文本。`)
  const normalized = options.trim === false ? value : value.trim()
  if (!normalized || normalized.length > maximum) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return normalized
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}必须是文本。`)
  const result = value.trim()
  if (!result) return null
  if (result.length > maximum) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return result
}

function projectId(value) {
  const normalized = text(value, '项目标识', 36)
  if (!PROJECT_ID.test(normalized)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '项目标识无效。')
  return normalized.toLowerCase()
}

function idempotencyKey(value) {
  const normalized = text(value, '幂等标识', 128)
  if (!IDEMPOTENCY_KEY.test(normalized)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '幂等标识无效。')
  return normalized
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure('STORY_ACCOUNT_INVALID_INPUT', '项目版本无效。')
  return value
}

function stageName(value) {
  if (typeof value !== 'string' || !STAGE_INDEX.has(value)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '生产阶段无效。')
  return value
}

function mediaFile(value, label, prefix) {
  const file = text(value, label, 280)
  if (!new RegExp(`^media/${prefix}/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`, 'u').test(file)) {
    throw failure('STORY_ACCOUNT_FILE_INVALID', `${label}无效。`)
  }
  return file
}

function mediaType(value, label, expected) {
  const type = text(value, label, 80)
  if (!expected.includes(type)) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}不受支持。`)
  return type
}

function optionalNumber(value, label, minimum, maximum) {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}必须在 ${minimum}-${maximum} 之间。`)
  return Number(value)
}

function optionalInteger(value, label, minimum, maximum) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}必须在 ${minimum}-${maximum} 之间。`)
  return value
}

function messages(value, label, maximum) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maximum) throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}最多包含 ${maximum} 项。`)
  return value.map((item, index) => text(item, `${label}[${index}]`, 600))
}

/* ------------------------------- 文件系统 ------------------------------- */

async function workspaceForAgent(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw failure('STORY_ACCOUNT_WORKSPACE_REQUIRED', '情感故事项目需要已加载能力包的专属工作区。')
  }
  try {
    const workspace = await realpath(cwd)
    const info = await lstat(workspace)
    if (!info.isDirectory()) throw new Error('not a directory')
    return workspace
  } catch {
    throw failure('STORY_ACCOUNT_WORKSPACE_REQUIRED', '能力包专属工作区不可用，请重新加载能力包后重试。')
  }
}

async function directory(path, create = true) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('STORY_ACCOUNT_DIRECTORY_INVALID', '故事项目目录无效。')
  return path
}

async function projectsDirectory(workspace, create = true) {
  const root = await directory(storyAccountDataPath(workspace), create)
  if (!root) return undefined
  return await directory(join(root, 'projects'), create)
}

async function projectDirectory(workspace, id, create = true) {
  const root = await projectsDirectory(workspace, create)
  return root ? await directory(join(root, id), create) : undefined
}

async function readJson(path, label) {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw failure('STORY_ACCOUNT_FILE_INVALID', `${label}不是有效的 JSON。`)
  }
}

async function writeJsonAtomicWithRetry(source, target, attempt = 1) {
  const maxAttempts = 5
  try {
    await rename(source, target)
  } catch (error) {
    // Windows 上目标文件被占用时 rename 会报 EPERM/EBUSY，退避后重试。
    if ((error?.code === 'EPERM' || error?.code === 'EBUSY') && attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
      return writeJsonAtomicWithRetry(source, target, attempt + 1)
    }
    throw error
  }
}

// 原子写：先写临时文件再 rename 覆盖。进程在写临时文件时崩溃不会留下半截的
// 正式文件；只有 rename 那一步是原子的，保证读到的要么是旧版、要么是新版。
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await writeJsonAtomicWithRetry(temporary, path)
}

/* ------------------------------- 项目记录 ------------------------------- */

function projectRecord(value) {
  const input = object(value, '项目记录')
  if (input.schemaVersion !== PROJECT_SCHEMA_VERSION) throw failure('STORY_ACCOUNT_FILE_INVALID', '项目记录版本不受支持。')
  const artifacts = {}
  for (const [stage, pointer] of Object.entries(input.artifacts || {})) {
    if (!STAGE_INDEX.has(stage)) continue
    artifacts[stage] = {
      id: text(pointer.id, '产物标识', 36),
      stage,
      revision: expectedRevision(pointer.revision),
      file: text(pointer.file, '产物文件', 200),
      createdAt: text(pointer.createdAt, '产物创建时间', 40),
      ...(pointer.passed === true ? { passed: true } : {}),
    }
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: projectId(input.id),
    title: text(input.title, '项目标题', 160),
    revision: expectedRevision(input.revision),
    stage: typeof input.stage === 'string' && STAGE_INDEX.has(input.stage) ? input.stage : 'topic',
    createdAt: text(input.createdAt, '创建时间', 40),
    updatedAt: text(input.updatedAt, '更新时间', 40),
    artifacts,
    history: Array.isArray(input.history) ? input.history.slice(-100) : [],
    receipts: Array.isArray(input.receipts) ? input.receipts.slice(-64) : [],
    scriptApproval: input.scriptApproval && typeof input.scriptApproval === 'object' ? input.scriptApproval : null,
  }
}

async function readProject(workspace, id) {
  const root = await projectDirectory(workspace, id, false)
  if (!root) throw failure('STORY_ACCOUNT_NOT_FOUND', '故事项目不存在。')
  return { root, project: projectRecord(await readJson(join(root, 'project.json'), '项目记录')) }
}

async function readArtifact(root, pointer) {
  const artifact = await readJson(join(root, pointer.file), '阶段产物')
  if (artifact?.projectId !== pointer.id && artifact?.id !== pointer.id) {
    // 指针与产物不一致说明文件被替换过，直接拒绝而不是继续用。
    if (artifact?.stage !== pointer.stage || artifact?.revision !== pointer.revision) {
      throw failure('STORY_ACCOUNT_FILE_INVALID', '阶段产物与项目不匹配。')
    }
  }
  return artifact
}

/* ------------------------------ 人工阶段校验 ------------------------------ */

function stageData(stage, payload) {
  const input = object(payload, '阶段内容')
  if (stage === 'topic') {
    return {
      title: text(input.title, '选题标题', 160),
      scenario: text(input.scenario, '选题场景', 500),
      keyLine: text(input.keyLine, '关键对白', 300),
      theme: optionalText(input.theme, '题材', 32),
      hook: optionalText(input.hook, '钩子', 32),
      emotion: optionalText(input.emotion, '情绪驱动', 32),
      account: parseAccountSnapshot(input.account),
      source: 'manual',
    }
  }
  if (stage === 'script') {
    const body = text(input.body, '口播稿', 30000, { trim: false })
    // 反塑料感是落库前的硬闸门：人可以不读稿，但不能绕过它。
    const report = checkAntiPlastic({ body, topic: input.topic || null })
    if (!report.passed) {
      throw failure('STORY_ACCOUNT_SCRIPT_REJECTED', `反塑料感检查未通过：${report.blocking.join(' ')}`)
    }
    return {
      body,
      title: optionalText(input.title, '稿件标题', 160),
      antiPlastic: report,
      unsupportedDetails: Array.isArray(input.unsupportedDetails)
        ? input.unsupportedDetails.map((item, index) => text(item, `无素材支撑细节[${index}]`, 300)).slice(0, 30)
        : [],
      source: 'manual',
    }
  }
  if (stage === 'voiceover') {
    const audio = object(input.audio, '配音')
    return {
      mode: 'manual',
      audio: {
        file: mediaFile(audio.file, '配音文件', 'voiceovers'),
        mediaType: mediaType(audio.mediaType, '配音类型', ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg']),
        bytes: optionalInteger(audio.bytes, '配音字节数', 1, 80 * 1024 * 1024),
        durationSeconds: optionalNumber(audio.durationSeconds, '配音时长', 0.01, 36_000),
      },
    }
  }
  if (stage === 'subtitles') {
    const srt = text(input.srt, '字幕内容', 30000, { trim: false })
    const checked = validateSrt(srt)
    if (checked.errors.length) throw failure('STORY_ACCOUNT_SUBTITLES_INVALID', `字幕格式无效：${checked.errors.join(' ')}`)
    return { srt, mode: 'manual', cueCount: checked.cueCount, maxCueChars: checked.maxCueChars }
  }
  if (stage === 'video' || stage === 'qc' || stage === 'packaging') {
    throw failure('STORY_ACCOUNT_STAGE_AUTOMATION_REQUIRED', '成片、质检与发布资料只能由受控任务生成；任务失败后请修正问题并重试。')
  }
  throw failure('STORY_ACCOUNT_INVALID_INPUT', '生产阶段无效。')
}

/* ------------------------------ 自动阶段校验 ------------------------------ */

function antiPlasticRecord(value) {
  const input = object(value, '反塑料感报告')
  const passed = input.passed === true
  const blocking = messages(input.blocking, '反塑料感硬拦项', 20)
  if (passed && blocking.length) throw failure('STORY_ACCOUNT_SCRIPT_REJECTED', '反塑料感报告结论不一致：已标记通过但仍存在硬拦项。')
  return {
    passed,
    score: optionalInteger(input.score, '反塑料感评分', 0, 100) ?? 0,
    blocking,
    suggestions: messages(input.suggestions, '反塑料感建议', 30),
    charCount: optionalInteger(input.charCount, '反塑料感字数', 0, 100_000) ?? 0,
  }
}

function reviewRecord(value) {
  const input = object(value, '独立审片报告')
  if (!Array.isArray(input.reviewEvidence) || input.reviewEvidence.length < 2 || input.reviewEvidence.length > 8) {
    throw failure('STORY_ACCOUNT_INVALID_INPUT', '独立审片证据必须包含 2-8 项。')
  }
  const reviewEvidence = input.reviewEvidence.map((candidate, index) => {
    const item = object(candidate, `独立审片证据[${index}]`)
    const timestampSeconds = optionalNumber(item.timestampSeconds, `独立审片证据[${index}].timestampSeconds`, 0, 36_000)
    if (timestampSeconds === null) throw failure('STORY_ACCOUNT_INVALID_INPUT', '独立审片证据缺少时间点。')
    return { timestampSeconds, observedMainVisual: text(item.observedMainVisual, `独立审片证据[${index}].observedMainVisual`, 600) }
  })
  if (!Array.isArray(input.findings) || input.findings.length > 12) throw failure('STORY_ACCOUNT_INVALID_INPUT', '独立审片问题最多包含 12 项。')
  const findings = input.findings.map((candidate, index) => {
    const item = object(candidate, `独立审片问题[${index}]`)
    const severity = text(item.severity, `独立审片问题[${index}].severity`, 20)
    const category = text(item.category, `独立审片问题[${index}].category`, 24)
    if (!['blocker', 'major', 'minor', 'note'].includes(severity)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '独立审片问题严重度无效。')
    if (!['technical', 'composition', 'readability', 'pacing', 'relevance', 'emotion'].includes(category)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '独立审片问题类别无效。')
    return { severity, category, timestampSeconds: optionalNumber(item.timestampSeconds, `独立审片问题[${index}].timestampSeconds`, 0, 36_000), message: text(item.message, `独立审片问题[${index}].message`, 500) }
  })
  return {
    passed: input.passed === true,
    technicalPass: input.technicalPass === true,
    editorialPass: input.editorialPass === true,
    evidencePassed: input.evidencePassed === true,
    score: optionalInteger(input.score, '独立审片评分', 0, 100) ?? 0,
    summary: text(input.summary, '独立审片摘要', 1000),
    findings,
    reviewEvidence,
  }
}

function packageRecord(value) {
  const input = object(value, '发布资料')
  if (!Array.isArray(input.tags) || input.tags.length < 1 || input.tags.length > 8) {
    throw failure('STORY_ACCOUNT_INVALID_INPUT', '发布标签必须包含 1-8 项。')
  }
  const tags = [...new Set(input.tags.map((tag, index) => text(tag, `发布标签[${index}]`, 30).replace(/^#/u, '')))]
  if (!tags.length) throw failure('STORY_ACCOUNT_INVALID_INPUT', '发布标签不能为空。')
  return {
    title: text(input.title, '发布标题', 30),
    copy: text(input.copy, '视频文案', 2000, { trim: false }),
    description: text(input.description, '视频描述', 1000, { trim: false }),
    tags,
    coverHeadline: text(input.coverHeadline, '封面大字', 14),
    coverMood: text(input.coverMood, '封面情绪', 200),
    generatedAt: text(input.generatedAt, '发布时间', 64),
  }
}

/* ------------------------- 反塑料感人工放行（审计） ------------------------- */

/**
 * 反塑料感硬闸的「人工放行」记录：谁在什么时候、以什么理由、放行了哪一条硬拦项。
 * 持久化在专属 JSON 文件里，按项目分组，供后续质检读取——放行的条目不再触发该条
 * blocker，但其它 blocker 仍然拦住。放行不是静默删除：原始 blocking 原样保留，
 * 放行记录单独挂在 antiPlasticOverrides 上，质检页看得到「本条经人工放行」。
 */
async function readAllOverrides(workspace) {
  const file = storyAccountDataPath(workspace, 'media', 'anti-plastic-overrides.json')
  let raw = null
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.items) ? parsed.items : []
  } catch {
    return []
  }
}

async function readAntiPlasticOverrides(workspace, projectId) {
  return (await readAllOverrides(workspace)).filter((item) => item && item.projectId === projectId)
}

async function writeAntiPlasticOverrides(workspace, items) {
  const file = storyAccountDataPath(workspace, 'media', 'anti-plastic-overrides.json')
  await writeJson(file, { schemaVersion: 1, items })
}

/**
 * 把已放行（带操作者+理由）的硬拦项从 blocking 里过滤掉，但不改动原始记录——
 * 原始 blocker 仍原样写回产物，放行记录单列，保证审计可见、不是静默覆盖。
 */
function resolveAntiPlastic(antiPlastic, overrides = []) {
  if (!antiPlastic) return null
  const overridden = new Set(overrides.map((item) => item?.blocker).filter(Boolean))
  const blocking = Array.isArray(antiPlastic.blocking) ? antiPlastic.blocking : []
  return {
    ...antiPlastic,
    blocking: blocking.filter((item) => !overridden.has(item)),
    overrides,
  }
}

function producedStageData(stage, payload, overrides = []) {
  const input = object(payload, '自动阶段内容')
  if (stage === 'voiceover') {
    const audio = object(input.audio, '自动配音')
    return {
      mode: text(input.mode, '配音模式', 40),
      provider: text(input.provider, 'TTS 提供方', 80),
      voiceId: optionalText(input.voiceId, '音色标识', 160),
      voiceName: optionalText(input.voiceName, '音色名称', 120),
      audio: {
        file: mediaFile(audio.file, '自动配音文件', 'voiceovers'),
        mediaType: mediaType(audio.mediaType, '自动配音类型', ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg']),
        bytes: optionalInteger(audio.bytes, '自动配音字节数', 1, 80 * 1024 * 1024),
        durationSeconds: optionalNumber(audio.durationSeconds, '自动配音时长', 0.01, 36_000),
      },
    }
  }
  if (stage === 'subtitles') {
    const srt = text(input.srt, '自动字幕内容', 30000, { trim: false })
    const checked = validateSrt(srt)
    if (checked.errors.length) throw failure('STORY_ACCOUNT_SUBTITLES_INVALID', `字幕格式无效：${checked.errors.join(' ')}`)
    return {
      mode: text(input.mode, '字幕模式', 40),
      sourceAudioFile: mediaFile(input.sourceAudioFile, '字幕来源配音文件', 'voiceovers'),
      srt,
      srtFile: mediaFile(input.srtFile, '自动字幕文件', 'subtitles'),
      cueCount: checked.cueCount,
      maxCueChars: checked.maxCueChars,
    }
  }
  if (stage === 'video') {
    const video = object(input.video, '自动成片')
    const orientation = optionalText(input.orientation, '视频方向', 20) || 'portrait'
    if (!['portrait', 'landscape'].includes(orientation)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '视频方向无效。')
    return {
      mode: text(input.mode, '视频模式', 40),
      renderer: text(input.renderer, '渲染器', 80),
      orientation,
      sourceAudioFile: mediaFile(input.sourceAudioFile, '成片来源配音文件', 'voiceovers'),
      subtitleEnabled: input.subtitleEnabled !== false,
      sourceSubtitleFile: input.sourceSubtitleFile === null || input.sourceSubtitleFile === undefined
        ? null
        : mediaFile(input.sourceSubtitleFile, '成片来源字幕文件', 'subtitles'),
      video: {
        file: mediaFile(video.file, '自动成片文件', 'videos'),
        mediaType: mediaType(video.mediaType, '自动成片类型', ['video/mp4']),
        bytes: optionalInteger(video.bytes, '自动成片字节数', 1024, 200 * 1024 * 1024),
        durationSeconds: optionalNumber(video.durationSeconds, '自动成片时长', 0.01, 36_000),
        width: optionalInteger(video.width, '自动成片宽度', 1, 8_192),
        height: optionalInteger(video.height, '自动成片高度', 1, 8_192),
        fps: optionalNumber(video.fps, '自动成片帧率', 1, 240),
        frameCount: optionalInteger(video.frameCount, '自动成片帧数', 1, 10_000_000),
        hasAudio: video.hasAudio === true,
      },
    }
  }
  if (stage === 'qc') {
    const technical = object(input.technical, '技术质检报告')
    const issues = messages(technical.issues, '技术质检问题', 40)
    const review = input.review === undefined || input.review === null ? null : reviewRecord(input.review)
    if (!review) throw failure('STORY_ACCOUNT_QC_FAILED', '质检缺少独立审片报告：两个闸门缺一不可。')
    const antiPlastic = input.antiPlastic === undefined || input.antiPlastic === null ? null : antiPlasticRecord(input.antiPlastic)
    // 应用人工放行：被放行的硬拦项从 finalGate 的 blocking 里摘掉，但原始
    // antiPlastic.blocking 原样保留（不静默删除），放行记录单列到 antiPlasticOverrides。
    const resolved = antiPlastic ? resolveAntiPlastic(antiPlastic, overrides) : null
    // 以 finalGate 为唯一真源：技术、审片、反塑料感三道闸合到一起判。
    // 落库结论直接取 finalGate 的结果——绝不复算一套不同的判定，杜绝
    // 「流水线判不过、落库却通过」这类不一致。
    const gate = finalGate({ technicalReport: technical, review, antiPlastic: resolved })
    // 防不一致：调用方声称「通过」，但 finalGate 仍有 blocker —— 这是数据矛盾，必须拒收。
    // 这也让「质检报告有 blocker 却落库通过」在结构上不可能发生（落库 passed 恒等于 gate.passed）。
    if (input.passed === true && !gate.passed) {
      throw failure('STORY_ACCOUNT_QC_FAILED', `质检结论与最终闸门不一致：${gate.blockers.join('；')}`)
    }
    return {
      mode: text(input.mode, '质检模式', 40),
      reportFile: mediaFile(input.reportFile, '技术质检报告文件', 'qc'),
      ...(input.reviewFile ? { reviewFile: mediaFile(input.reviewFile, '独立审片报告文件', 'qc') } : {}),
      passed: gate.passed,
      blockers: gate.blockers,
      technical: {
        passed: technical.passed === true,
        issues,
        warnings: messages(technical.warnings, '技术质检警告', 40),
        video: object(technical.video, '技术质检视频信息'),
        audio: object(technical.audio, '技术质检音频信息'),
        subtitles: object(technical.subtitles, '技术质检字幕信息'),
      },
      review,
      ...(antiPlastic ? { antiPlastic } : {}),
      ...(overrides?.length ? { antiPlasticOverrides: overrides } : {}),
    }
  }
  if (stage === 'packaging') return packageRecord(input)
  throw failure('STORY_ACCOUNT_INVALID_INPUT', '自动生产阶段无效。')
}

/* -------------------------------- 阶段依赖 -------------------------------- */

function satisfied(project, stage) {
  for (const required of REQUIRED_POINTERS[stage]) {
    if (!project.artifacts[required]) throw failure('STORY_ACCOUNT_STAGE_BLOCKED', `当前阶段需要先完成「${STAGE_LABELS[required] || required}」。`)
  }
  if (stage === 'packaging' && project.artifacts.qc?.passed !== true) {
    throw failure('STORY_ACCOUNT_STAGE_BLOCKED', '质检未通过，不能生成发布资料。')
  }
}

export const STAGE_LABELS = Object.freeze({
  topic: '故事选题',
  script: '故事写稿',
  voiceover: '配音',
  subtitles: '字幕',
  video: '竖屏成片',
  qc: '质检闸门',
  packaging: '发布资料',
})

/**
 * 让候选相对路径在 base 下解析后严格落在 safeDir 内（含 safeDir 自身）。
 * 只接受相对、无 `..`、无绝对/协议前缀的路径——任何逃逸工作区的路径都返回 null，
 * 绝不删除。这是删除产物的安全红线。
 */
export function safeJoin(base, relative, safeDir) {
  if (typeof relative !== 'string' || !relative.trim()) return null
  if (relative.startsWith('/') || relative.includes('..') || /^[a-zA-Z]:[\\/]/u.test(relative) || /^[a-z][a-z0-9+.-]*:/iu.test(relative)) return null
  const target = resolve(base, relative)
  const boundary = resolve(safeDir)
  if (target !== boundary && !target.startsWith(`${boundary}${sep}`)) return null
  return target
}

/** 从阶段产物里收集受 mediaFile 约束的媒体相对路径（media/<prefix>/<name>）。 */
function collectMediaPaths(value, found = []) {
  if (typeof value === 'string') {
    if (/^media\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(value)) found.push(value)
    return found
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaPaths(item, found)
    return found
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectMediaPaths(item, found)
  }
  return found
}

const ARTIFACT_FILE = /^artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.json$/u

/**
 * 失效下游阶段：删掉指针，并连同对应的产物文件一起删。
 *
 * 指针删了但文件不删，磁盘会越积越多（每次重做配音/字幕/成片都留一份孤儿媒体）。
 * 这里在删指针的同时，把产物 JSON 与其内嵌媒体（配音/字幕/成片文件）一并删除，
 * 所有待删路径都经 safeJoin 做严格包含校验——只许落在项目工作区内。
 */
export async function invalidateDownstream(project, stage, { root, workspace }) {
  const index = STAGE_INDEX.get(stage)
  const dataRoot = join(workspace, 'data')
  for (const name of Object.keys(project.artifacts)) {
    if (STAGE_INDEX.get(name) < index) continue
    const pointer = project.artifacts[name]
    delete project.artifacts[name]
    await removeArtifactFiles(pointer, { root, dataRoot, safeDir: workspace })
  }
}

async function removeArtifactFiles(pointer, { root, dataRoot, safeDir }) {
  if (!pointer || typeof pointer !== 'object') return
  const targets = []
  if (typeof pointer.file === 'string' && ARTIFACT_FILE.test(pointer.file)) {
    const resolved = safeJoin(root, pointer.file, safeDir)
    if (resolved) targets.push(resolved)
  }
  let artifact = null
  try {
    artifact = await readJson(join(root, pointer.file), '阶段产物')
  } catch {
    // 产物读不到也能删指针；仅跳过内嵌媒体清理。
  }
  if (artifact && typeof artifact === 'object') {
    for (const relative of collectMediaPaths(artifact)) {
      const resolved = safeJoin(dataRoot, relative, safeDir)
      if (resolved) targets.push(resolved)
    }
  }
  for (const target of targets) {
    await rm(target, { force: true, recursive: false })
  }
}

function projectSummary(project) {
  const script = project.artifacts.script
  const scriptApproved = Boolean(project.scriptApproval && script && project.scriptApproval.revision >= script.revision)
  return {
    id: project.id,
    title: project.title,
    revision: project.revision,
    stage: project.stage,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    completedStages: STORY_STAGES.filter((stage) => project.artifacts[stage] !== undefined),
    qcPassed: project.artifacts.qc?.passed === true,
    scriptApproval: project.scriptApproval ? { ...project.scriptApproval, current: scriptApproved } : null,
  }
}

/* --------------------------------- 主类 --------------------------------- */

export class StoryAccountStore {
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
        projects.push(projectSummary(projectRecord(await readJson(join(root, entry.name, 'project.json'), '项目记录'))))
      } catch (error) {
        if (error instanceof StoryStoreError) continue
        throw error
      }
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * 启动完整性自检：扫描所有项目目录，逐个解析 project.json。
   * 损坏或版本不受支持的项目会被收集到 corrupt，绝不像 get/list 那样跳过——
   * 否则损坏会被静默忽略，等用户真正点开时才崩。返回 { total, corrupt }。
   */
  async verifyIntegrity(agent) {
    const workspace = await workspaceForAgent(agent)
    const root = await projectsDirectory(workspace, false)
    if (!root) return { total: 0, corrupt: [] }
    const entries = await readdir(root, { withFileTypes: true })
    const corrupt = []
    let total = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID.test(entry.name)) continue
      total += 1
      try {
        projectRecord(await readJson(join(root, entry.name, 'project.json'), '项目记录'))
      } catch (error) {
        corrupt.push({ id: entry.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { total, corrupt }
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
      stage: 'topic',
      createdAt: now,
      updatedAt: now,
      artifacts: {},
      history: [],
      receipts: [],
      scriptApproval: null,
    }
    await writeJson(join(root, 'project.json'), project)
    return projectSummary(project)
  }

  /** 删除按 id 精确执行，绝不回退成前缀或通配匹配。 */
  async remove(agent, request) {
    const input = object(request, '删除项目请求')
    const ids = Array.isArray(input.projectIds)
      ? [...new Set(input.projectIds.map((value) => projectId(value)))]
      : [projectId(input.projectId)]
    if (!ids.length) throw failure('STORY_ACCOUNT_INVALID_INPUT', '请至少选择一个要删除的项目。')
    if (ids.length > 50) throw failure('STORY_ACCOUNT_INVALID_INPUT', '单次最多删除 50 个项目。')
    const workspace = await workspaceForAgent(agent)
    const root = await projectsDirectory(workspace, false)
    const removed = []
    const missing = []
    for (const id of ids) {
      const target = root ? join(root, id) : null
      const info = target ? await lstat(target).catch(() => null) : null
      if (!info?.isDirectory() || info.isSymbolicLink()) { missing.push(id); continue }
      await rm(target, { recursive: true, force: true })
      removed.push(id)
    }
    return { removed, missing }
  }

  async get(agent, request) {
    const workspace = await workspaceForAgent(agent)
    const { root, project } = await readProject(workspace, projectId(object(request, '读取项目请求').projectId))
    const artifacts = {}
    for (const [stage, pointer] of Object.entries(project.artifacts)) {
      const artifact = await readArtifact(root, pointer)
      artifacts[stage] = { ...pointer, data: artifact.data, passed: artifact.data?.passed === true }
    }
    return { ...projectSummary(project), artifacts }
  }

  /** 已保存的稿件正文，用于相似度比对（语料是工作区里其它项目的稿件）。 */
  async scriptCorpus(agent, { excludeProjectId = null } = {}) {
    const workspace = await workspaceForAgent(agent)
    const root = await projectsDirectory(workspace, false)
    if (!root) return []
    const entries = await readdir(root, { withFileTypes: true })
    const corpus = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID.test(entry.name)) continue
      if (excludeProjectId && entry.name.toLowerCase() === excludeProjectId.toLowerCase()) continue
      try {
        const project = projectRecord(await readJson(join(root, entry.name, 'project.json'), '项目记录'))
        const pointer = project.artifacts.script
        if (!pointer) continue
        const body = (await readArtifact(root, pointer))?.data?.body
        if (typeof body !== 'string' || !body.trim()) continue
        corpus.push({ projectId: project.id, title: project.title, body })
      } catch (error) {
        if (error instanceof StoryStoreError) continue
        throw error
      }
    }
    return corpus
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
      if (project.revision !== expected) throw failure('STORY_ACCOUNT_REVISION_CONFLICT', '项目已被其他操作更新，请刷新后重试。')
      satisfied(project, stage)
      const data = stageData(stage, input.payload)
      await invalidateDownstream(project, stage, { root, workspace })
      const revision = project.revision + 1
      const artifactId = randomUUID()
      const createdAt = new Date().toISOString()
      const file = `artifacts/${revision}-${stage}-${artifactId}.json`
      const artifact = { schemaVersion: PROJECT_SCHEMA_VERSION, id: artifactId, projectId: project.id, stage, revision, createdAt, source: 'manual', data }
      await writeJson(join(root, file), artifact)
      const pointer = { id: artifactId, stage, revision, file, createdAt, ...(data.passed === true ? { passed: true } : {}) }
      project.artifacts[stage] = pointer
      project.revision = revision
      project.stage = stage
      project.updatedAt = createdAt
      project.history = [...project.history, { ...pointer }].slice(-100)
      const response = { project: projectSummary(project), artifact: pointer }
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
   * 受控任务写入阶段产物。刻意不暴露给浏览器网关：调用方无法伪造配音、
   * 字幕、成片或质检来源，也绕不过适配器与闸门的校验。
   */
  async commitProduced(agent, request) {
    const input = object(request, '自动阶段提交请求')
    const workspace = await workspaceForAgent(agent)
    const id = projectId(input.projectId)
    const key = idempotencyKey(input.idempotencyKey)
    const stage = stageName(input.stage)
    if (!PRODUCIBLE_STAGES.includes(stage)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '该阶段不支持自动产物提交。')
    const expected = expectedRevision(input.expectedRevision)
    const source = text(input.source, '自动产物来源', 120)
    if (!/^story-account\/[a-z0-9-]+$/u.test(source)) throw failure('STORY_ACCOUNT_INVALID_INPUT', '自动产物来源无效。')
    const writeKey = `${workspace}\u0000${id}`
    const previous = this.writes.get(writeKey) || Promise.resolve()
    const result = previous.then(async () => {
      const { root, project } = await readProject(workspace, id)
      const operation = `${stage}:${key}`
      const prior = project.receipts.find((receipt) => receipt.operation === operation)
      if (prior) return prior.result
      if (project.revision !== expected) throw failure('STORY_ACCOUNT_REVISION_CONFLICT', '项目已被其他操作更新，请刷新后重试。')
      satisfied(project, stage)
      const overrides = stage === 'qc' ? await readAntiPlasticOverrides(workspace, id) : []
      const data = producedStageData(stage, input.payload, overrides)
      await invalidateDownstream(project, stage, { root, workspace })
      const revision = project.revision + 1
      const artifactId = randomUUID()
      const createdAt = new Date().toISOString()
      const file = `artifacts/${revision}-${stage}-${artifactId}.json`
      const artifact = { schemaVersion: PROJECT_SCHEMA_VERSION, id: artifactId, projectId: project.id, stage, revision, createdAt, source, data }
      await writeJson(join(root, file), artifact)
      const pointer = { id: artifactId, stage, revision, file, createdAt, ...(data.passed === true ? { passed: true } : {}) }
      project.artifacts[stage] = pointer
      project.revision = revision
      project.stage = stage
      project.updatedAt = createdAt
      project.history = [...project.history, { ...pointer }].slice(-100)
      const response = { project: projectSummary(project), artifact: pointer }
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
   * 稿件确认闸门：把当前稿件版本标记为已确认。确认与 revision 绑定，任何后续
   * 稿件提交都会自动失效，所以不存在「确认了旧稿却拿新稿去配音」的空档。
   */
  async approveScript(agent, request) {
    const workspace = await workspaceForAgent(agent)
    const input = object(request, '确认稿件请求')
    const id = projectId(input.projectId)
    const writeKey = `${workspace}\u0000${id}`
    const previous = this.writes.get(writeKey) || Promise.resolve()
    const result = previous.then(async () => {
      const { root, project } = await readProject(workspace, id)
      const script = project.artifacts.script
      if (!script) throw failure('STORY_ACCOUNT_STAGE_BLOCKED', '当前项目还没有可确认的稿件。')
      project.scriptApproval = { revision: script.revision, approvedAt: new Date().toISOString(), source: input.source === 'automation' ? 'automation' : 'manual' }
      project.updatedAt = project.scriptApproval.approvedAt
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
   * 反塑料感硬闸的人工放行（带审计）。放行记录必须含操作者+理由，缺任一即拒。
   * 放行不是静默删除 blocker：原始 blocker 原样保留，放行记录单独持久化。
   */
  async overrideAntiPlastic(agent, request) {
    const input = object(request, '反塑料感放行请求')
    const workspace = await workspaceForAgent(agent)
    const pid = projectId(input.projectId)
    const blocker = text(input.blocker, '被放行的硬拦项', 300)
    const operator = typeof input.operator === 'string' && input.operator.trim() ? input.operator.trim() : null
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null
    if (!operator) throw failure('STORY_ACCOUNT_INVALID_INPUT', '人工放行必须记录操作者。')
    if (!reason) throw failure('STORY_ACCOUNT_INVALID_INPUT', '人工放行必须写明理由。')
    const items = await readAllOverrides(workspace)
    const record = { id: randomUUID(), projectId: pid, blocker, operator, reason, createdAt: new Date().toISOString() }
    await writeAntiPlasticOverrides(workspace, [...items, record])
    return record
  }

  /** 读取某项目已记录的反塑料感人工放行（供质检页展示「本条经人工放行」）。 */
  async listAntiPlasticOverrides(agent, request) {
    const input = object(request, '反塑料感放行记录查询')
    const workspace = await workspaceForAgent(agent)
    const pid = projectId(input.projectId)
    const items = await readAntiPlasticOverrides(workspace, pid)
    return { projectId: pid, overrides: items }
  }

  /** 反塑料感试运行：不落库，只回报告，供写稿页实时检查。 */
  checkScript({ body, topic = null } = {}) {
    if (typeof body !== 'string' || !body.trim()) throw failure('STORY_ACCOUNT_INVALID_INPUT', '口播稿不能为空。')
    return checkAntiPlastic({ body, topic })
  }
}
