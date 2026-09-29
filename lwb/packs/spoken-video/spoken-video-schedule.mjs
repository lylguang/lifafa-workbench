import { AI_DAILY_PLATFORMS } from './spoken-video-signal-adapters.mjs'
import { normalizeVoiceoverRequest } from './spoken-video-media.mjs'
import { normalizeTier } from './spoken-video-script.mjs'

/**
 * Pure layer for the content-schedule module: the durable task shape, the
 * weekday/time due mathematics, the automation-depth vocabulary, and the
 * run/item status reduction. No I/O and no host services live here so the
 * scheduling rules stay unit-testable on their own.
 *
 * The schedule file is version 3. Version 2 only ever drove signal
 * collection; the zero-compatibility rule applies, so version 2 files are
 * rejected outright rather than migrated.
 */

export const SCHEDULE_SCHEMA = 3
export const SCHEDULE_FILE = 'schedules.json'

/** Limits mirror the topic input contract so a schedule can be replayed verbatim. */
export const SCHEDULE_SOURCE_LIMIT = 20
export const SCHEDULE_PLATFORM_LIMIT = 12
export const SCHEDULE_EXCLUDE_LIMIT = 300
export const SCHEDULE_ANGLE_MAX = 500
export const SCHEDULE_ITEM_LIMIT = 3
export const SCHEDULE_TASK_LIMIT = 50

const UUID = /^[a-f0-9-]{36}$/iu
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/u
const WEEKDAY_LABELS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
const ORIENTATIONS = Object.freeze(['portrait', 'landscape'])

/** How deep one unattended round runs. The depth IS the authorisation scope. */
export const SCHEDULE_DEPTHS = Object.freeze(['topic', 'script', 'video', 'packaging'])

export const DEPTH_LABEL = Object.freeze({
  topic: '选题',
  script: '写稿',
  video: '成片 + 质检',
  packaging: '发布资料',
})

/**
 * Ordered automation steps. `video` covers render + technical qc + editorial
 * review because the media host commits both artifacts atomically, and
 * `approve` is the script-confirmation gate that only the deeper depths cross.
 */
export const AUTOMATION_STEPS = Object.freeze(['topic', 'script', 'approve', 'voiceover', 'subtitles', 'video', 'packaging'])

export const STEP_LABEL = Object.freeze({
  topic: '选题',
  script: '写稿',
  approve: '确认稿件',
  voiceover: '配音',
  subtitles: '字幕',
  video: '成片质检',
  packaging: '发布资料',
})

export const DEPTH_STEPS = Object.freeze({
  topic: ['topic'],
  script: ['topic', 'script'],
  video: ['topic', 'script', 'approve', 'voiceover', 'subtitles', 'video'],
  packaging: ['topic', 'script', 'approve', 'voiceover', 'subtitles', 'video', 'packaging'],
})

/** Depths that auto-confirm the AI script instead of leaving it for a human. */
export const SCRIPT_APPROVING_DEPTHS = Object.freeze(['video', 'packaging'])

export const STEP_TIMEOUT_MS = Object.freeze({
  topic: 15 * 60_000,
  script: 15 * 60_000,
  approve: 60_000,
  voiceover: 10 * 60_000,
  subtitles: 10 * 60_000,
  video: 40 * 60_000,
  packaging: 15 * 60_000,
})

export const SCHEDULE_POLL_INTERVAL_MS = 2_000

export const RUN_STATUSES = Object.freeze(['running', 'completed', 'partial', 'failed', 'missed', 'cancelled'])
export const ITEM_STATUSES = Object.freeze(['running', 'completed', 'failed', 'cancelled'])
export const STAGE_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped'])

export class SpokenVideoScheduleError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) { throw new SpokenVideoScheduleError(code, message) }

function invalid(message) { fail('SPOKEN_VIDEO_SCHEDULE_INVALID_INPUT', message) }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}必须是对象。`)
  return value
}

function text(value, label, maximum, required = true) {
  if ((value === undefined || value === null) && !required) return null
  if (typeof value !== 'string') invalid(`${label}必须是文本。`)
  const result = value.trim()
  if (required && !result) invalid(`${label}不能为空。`)
  if (result.length > maximum) invalid(`${label}长度不能超过 ${maximum}。`)
  return required ? result : (result || null)
}

function bool(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') invalid(`${label}必须是布尔值。`)
  return value
}

function integer(value, label, minimum, maximum, fallback = null) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label}必须在 ${minimum}-${maximum} 之间。`)
  return value
}

function uuid(value, label) {
  const result = text(value, label, 36)
  if (!UUID.test(result)) invalid(`${label}无效。`)
  return result.toLowerCase()
}

function optionalUuid(value, label) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null
  return uuid(value, label)
}

function sourceId(value) {
  if (typeof value !== 'string') invalid('信号来源标识必须是文本。')
  const result = value.trim()
  if (!SOURCE_ID.test(result)) invalid('信号来源标识无效。')
  return result
}

function idList(value, label, maximum) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label}最多包含 ${maximum} 项。`)
  return [...new Set(value.map((item) => (typeof item === 'string' ? item.trim() : invalid(`${label}项必须是文本。`))).filter(Boolean))]
}

function number(value, label, minimum, maximum, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid(`${label}必须在 ${minimum}-${maximum} 之间。`)
  return value
}

/* ------------------------------- time rules ------------------------------- */

/** ISO weekday: Monday is 1, Sunday is 7. */
export function isoWeekday(date) { return ((date.getDay() + 6) % 7) + 1 }

export function weekdayLabel(day) { return WEEKDAY_LABELS[day - 1] || String(day) }

export function weekdayLabels(days) {
  const list = [...(days || [])].sort((left, right) => left - right)
  if (list.length === 7) return '每天'
  if (list.length === 5 && list.every((day) => day <= 5)) return '工作日'
  if (list.length === 2 && list[0] === 6 && list[1] === 7) return '周末'
  return list.map(weekdayLabel).join('、')
}

export function validDays(value) {
  if (!Array.isArray(value) || !value.length || value.length > 7) invalid('执行日必须选择 1-7 天。')
  const days = [...new Set(value.map((item) => {
    if (!Number.isSafeInteger(item) || item < 1 || item > 7) invalid('执行日必须是 1-7 的整数（周一为 1）。')
    return item
  }))].sort((left, right) => left - right)
  return days
}

export function validTime(value) {
  const result = text(value, '执行时间', 5)
  if (!/^\d{2}:\d{2}$/u.test(result) || Number(result.slice(0, 2)) > 23 || Number(result.slice(3)) > 59) {
    invalid('执行时间必须使用有效 HH:MM 格式。')
  }
  return result
}

export function localMinute(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localDay(value) { return localMinute(value).slice(0, 10) }

function slotOn(date, time) {
  const [hour, minute] = time.split(':').map(Number)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0)
}

/**
 * Due when the schedule is enabled, today is one of its weekdays, the local
 * minute matches, and it has not already been stamped in this same minute.
 * The stamp is written before the round starts, so a thirty second tick
 * cannot start the same slot twice.
 */
export function scheduleDue(schedule, clock = new Date()) {
  if (!schedule?.enabled) return false
  if (!Array.isArray(schedule.days) || !schedule.days.includes(isoWeekday(clock))) return false
  if (!localMinute(clock).endsWith(schedule.time)) return false
  return !schedule.lastRunAt || localMinute(schedule.lastRunAt) !== localMinute(clock)
}

/** Next matching local slot strictly after `clock`, or null when disabled. */
export function nextRunAt(schedule, clock = new Date()) {
  if (!schedule?.enabled || !Array.isArray(schedule.days) || !schedule.days.length) return null
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() + offset)
    if (!schedule.days.includes(isoWeekday(day))) continue
    const candidate = slotOn(day, schedule.time)
    if (candidate > clock) return candidate.toISOString()
  }
  return null
}

/**
 * Whether today's slot has already passed without a run. Only consulted once
 * after startup: content is time sensitive, so a missed slot is logged for
 * the operator to act on and never backfilled automatically.
 */
export function missedSlot(schedule, clock = new Date()) {
  if (!schedule?.enabled) return false
  if (!Array.isArray(schedule.days) || !schedule.days.includes(isoWeekday(clock))) return false
  if (slotOn(clock, schedule.time) > clock) return false
  // Still inside the slot's own minute is not a miss: scheduleDue fires and the
  // round actually runs. Only a slot whose minute has fully elapsed counts,
  // otherwise a host that starts up exactly on the minute would log a miss and
  // run the round at the same time.
  if (localMinute(clock).endsWith(schedule.time)) return false
  return !schedule.lastRunAt || localDay(schedule.lastRunAt) !== localDay(clock)
}

/* ------------------------------ depth helpers ----------------------------- */

export function validDepth(value) {
  const depth = typeof value === 'string' ? value.trim() : ''
  if (!SCHEDULE_DEPTHS.includes(depth)) invalid('自动化深度无效。')
  return depth
}

/** Whether this depth crosses the script-confirmation gate on its own. */
export function approvesScript(depth) { return SCRIPT_APPROVING_DEPTHS.includes(depth) }

/** Steps one round walks, dropping the subtitle step when subtitles are off. */
export function stepsForRun(depth, subtitleEnabled = true) {
  return DEPTH_STEPS[validDepth(depth)].filter((step) => step !== 'subtitles' || subtitleEnabled)
}

export function finalStep(depth, subtitleEnabled = true) {
  const steps = stepsForRun(depth, subtitleEnabled)
  return steps[steps.length - 1]
}

/* --------------------------- request validation --------------------------- */

/**
 * Voice settings are validated by reusing the media normalizer, so the stored
 * value is already exactly what startVoiceover accepts and no second copy of
 * those rules can drift.
 */
function parseVoice(value) {
  if (value === undefined || value === null) return null
  try {
    return normalizeVoiceoverRequest(object(value, '音色设置'))
  } catch (error) {
    invalid(`音色设置无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseProduction(value) {
  const input = value === undefined || value === null ? {} : object(value, '生产参数')
  const orientation = input.orientation === undefined || input.orientation === null ? 'landscape' : String(input.orientation).trim()
  if (!ORIENTATIONS.includes(orientation)) invalid('视频方向只能是 portrait 或 landscape。')
  return {
    orientation,
    subtitleEnabled: bool(input.subtitleEnabled, '字幕开关', true),
    scriptTier: normalizeTier(input.scriptTier),
    voice: parseVoice(input.voice),
    visualBrief: text(input.visualBrief, '画面制作说明', 6000, false),
  }
}

function parseSources(value) {
  const input = value === undefined || value === null ? {} : object(value, '信号来源选择')
  const platforms = idList(input.platforms, 'AI 日报平台选择', SCHEDULE_PLATFORM_LIMIT)
    .filter((platform) => AI_DAILY_PLATFORMS.includes(platform))
  return {
    sourceIds: idList(input.sourceIds, '信号源选择', SCHEDULE_SOURCE_LIMIT).map(sourceId),
    platforms,
    excludeSignalIds: idList(input.excludeSignalIds, '排除信号', SCHEDULE_EXCLUDE_LIMIT).map((id) => uuid(id, '信号标识')),
  }
}

/**
 * Validate one create/update request into the stored shape. `accountId` may be
 * null for the general (no positioning) tab.
 */
export function parseScheduleRequest(request) {
  const input = object(request, '内容安排请求')
  return {
    name: text(input.name, '内容安排名称', 120),
    enabled: bool(input.enabled, '内容安排启用状态', true),
    accountId: optionalUuid(input.accountId, '账号定位标识'),
    days: validDays(input.days),
    time: validTime(input.time),
    angle: text(input.angle, '选题角度', SCHEDULE_ANGLE_MAX, false),
    sources: parseSources(input.sources),
    depth: validDepth(input.depth),
    perRunLimit: integer(input.perRunLimit, '每轮视频上限', 1, SCHEDULE_ITEM_LIMIT, 1),
    production: parseProduction(input.production),
  }
}

/** The topic-generation input this schedule replays, verbatim. */
export function topicInputOf(schedule) {
  const sourceIds = [...schedule.sources.sourceIds]
  return {
    ...(schedule.angle ? { angle: schedule.angle } : {}),
    ...(schedule.accountId ? { accountId: schedule.accountId } : {}),
    ...(sourceIds.length ? { sourceIds } : {}),
    ...(schedule.sources.platforms.length ? { platforms: schedule.sources.platforms } : {}),
    ...(schedule.sources.excludeSignalIds.length ? { excludeSignalIds: schedule.sources.excludeSignalIds } : {}),
  }
}

export function scriptInputOf(schedule, projectId) {
  return {
    projectId,
    mode: 'new',
    tier: schedule.production.scriptTier,
    ...(schedule.angle ? { instructions: schedule.angle } : {}),
  }
}

/* ------------------------------ file schema ------------------------------- */

function stageRecord(value) {
  const item = object(value, '阶段记录')
  const status = text(item.status, '阶段状态', 16)
  if (!STAGE_STATUSES.includes(status)) invalid('阶段状态无效。')
  return {
    step: text(item.step, '阶段标识', 24),
    status,
    startedAt: text(item.startedAt, '阶段开始时间', 64, false),
    completedAt: text(item.completedAt, '阶段结束时间', 64, false),
    refId: text(item.refId, '阶段任务标识', 64, false),
    message: text(item.message, '阶段信息', 500, false),
  }
}

function itemRecord(value) {
  const item = object(value, '视频条目')
  const status = text(item.status, '条目状态', 16)
  if (!ITEM_STATUSES.includes(status)) invalid('条目状态无效。')
  return {
    projectId: optionalUuid(item.projectId, '项目标识'),
    title: text(item.title, '条目标题', 160, false),
    status,
    reachedStep: text(item.reachedStep, '到达阶段', 24, false),
    signalCount: integer(item.signalCount, '信号数', 0, 100_000, null),
    scriptChars: integer(item.scriptChars, '稿件字数', 0, 100_000, null),
    scriptRevision: integer(item.scriptRevision, '稿件版本', 1, 1_000_000, null),
    durationSeconds: number(item.durationSeconds, '成片时长', 0, 36_000, null),
    orientation: ORIENTATIONS.includes(item.orientation) ? item.orientation : null,
    qcPassed: bool(item.qcPassed, '质检结论', false),
    coverState: ['both', 'partial', 'none', 'disabled'].includes(item.coverState) ? item.coverState : null,
    error: text(item.error, '条目错误', 500, false),
    stages: Array.isArray(item.stages) ? item.stages.map(stageRecord).slice(0, AUTOMATION_STEPS.length) : [],
  }
}

function runRecord(value) {
  const item = object(value, '执行记录')
  const status = text(item.status, '执行状态', 16)
  if (!RUN_STATUSES.includes(status)) invalid('执行状态无效。')
  const trigger = text(item.trigger, '触发方式', 16)
  if (!['automatic', 'manual'].includes(trigger)) invalid('触发方式无效。')
  return {
    id: uuid(item.id, '执行标识'),
    scheduleId: uuid(item.scheduleId, '内容安排标识'),
    status,
    trigger,
    triggeredAt: text(item.triggeredAt, '触发时间', 64),
    completedAt: text(item.completedAt, '完成时间', 64, false),
    // A run recovered after a long host outage can legitimately span more
    // than 24 hours. Keep the real audit duration instead of making the
    // recovered record unreadable on the next process start.
    elapsedMs: integer(item.elapsedMs, '执行耗时', 0, Number.MAX_SAFE_INTEGER, null),
    sessionId: text(item.sessionId, '执行会话标识', 120, false),
    depth: SCHEDULE_DEPTHS.includes(item.depth) ? item.depth : null,
    step: text(item.step, '当前阶段', 24, false),
    message: text(item.message, '执行信息', 500, false),
    error: text(item.error, '执行错误', 500, false),
    refs: {
      topicGenerationId: text(item.refs?.topicGenerationId, '选题任务标识', 64, false),
      scriptGenerationIds: idList(item.refs?.scriptGenerationIds, '写稿任务标识', SCHEDULE_ITEM_LIMIT * 2).slice(0, SCHEDULE_ITEM_LIMIT * 2),
      mediaRunIds: idList(item.refs?.mediaRunIds, '媒体任务标识', SCHEDULE_ITEM_LIMIT * 8).slice(0, SCHEDULE_ITEM_LIMIT * 8),
      publishTaskIds: idList(item.refs?.publishTaskIds, '发布任务标识', SCHEDULE_ITEM_LIMIT * 2).slice(0, SCHEDULE_ITEM_LIMIT * 2),
    },
    items: Array.isArray(item.items) ? item.items.map(itemRecord).slice(0, SCHEDULE_ITEM_LIMIT) : [],
  }
}

function scheduleRecord(value) {
  const item = object(value, '内容安排')
  const createdAt = text(item.createdAt, '创建时间', 64)
  return {
    id: uuid(item.id, '内容安排标识'),
    ...parseScheduleRequest(item),
    disabledReason: text(item.disabledReason, '停用原因', 300, false),
    createdAt,
    updatedAt: text(item.updatedAt, '更新时间', 64),
    lastRunAt: text(item.lastRunAt, '最近执行时间', 64, false),
  }
}

export function emptyScheduleFile() { return { schemaVersion: SCHEDULE_SCHEMA, schedules: [], runs: [] } }

/**
 * Normalize the stored file. Config records are strict except for references
 * that can vanish underneath them: a deleted signal source is dropped rather
 * than fatal, and a task left with nothing runnable — or whose account was
 * hard deleted — is disabled with an explicit reason instead of throwing and
 * making the whole file unreadable. History records that fail validation are
 * dropped individually for the same reason.
 *
 * @returns the normalized file plus whether it differs from what was read.
 */
export function scheduleFile(value, { validSourceIds = new Set(), validAccountIds = new Set() } = {}) {
  if (value?.schemaVersion !== SCHEDULE_SCHEMA || !Array.isArray(value.schedules) || !Array.isArray(value.runs)) {
    fail('SPOKEN_VIDEO_SCHEDULE_FILE_UNSUPPORTED', '内容安排文件版本不受支持，请删除后重新创建内容安排。')
  }
  let changed = false
  const schedules = value.schedules.map((raw) => {
    const item = scheduleRecord(raw)
    const sourceIds = item.sources.sourceIds.filter((id) => validSourceIds.has(id))
    const droppedSources = sourceIds.length !== item.sources.sourceIds.length
    if (droppedSources) changed = true
    const accountMissing = Boolean(item.accountId) && !validAccountIds.has(item.accountId)
    if (accountMissing) changed = true
    let disabledReason = item.disabledReason
    let enabled = item.enabled
    if (accountMissing) {
      enabled = false
      disabledReason = `账号定位「${item.accountId}」已被删除，请重新选择账号后启用。`
    } else if (!sourceIds.length) {
      enabled = false
      disabledReason = '所选信号来源均已被删除，请重新选择参与渠道后启用。'
    } else if (!item.enabled && !disabledReason) {
      disabledReason = null
    }
    if (enabled !== item.enabled || disabledReason !== item.disabledReason) changed = true
    return { ...item, enabled, disabledReason, sources: { ...item.sources, sourceIds } }
  })
  const runs = []
  for (const raw of value.runs) {
    try {
      runs.push(runRecord(raw))
    } catch {
      changed = true
    }
  }
  return { changed, data: { schemaVersion: SCHEDULE_SCHEMA, schedules, runs } }
}

/* --------------------------- status reduction ----------------------------- */

export function reduceRunStatus(items, cancelled = false) {
  if (cancelled) return 'cancelled'
  if (!items.length) return 'failed'
  const done = items.filter((item) => item.status === 'completed').length
  if (done === items.length) return 'completed'
  return done ? 'partial' : 'failed'
}

export function emptyStages(steps) {
  return steps.map((step) => ({ step, status: 'pending', startedAt: null, completedAt: null, refId: null, message: null }))
}

/** Compact per-schedule view for the task cards, including the latest run. */
export function scheduleView(schedule, runs) {
  const latest = runs.find((run) => run.scheduleId === schedule.id) || null
  return {
    ...schedule,
    sources: { ...schedule.sources, sourceIds: [...schedule.sources.sourceIds], platforms: [...schedule.sources.platforms], excludeSignalIds: [...schedule.sources.excludeSignalIds] },
    daysLabel: weekdayLabels(schedule.days),
    depthLabel: DEPTH_LABEL[schedule.depth],
    nextRunAt: nextRunAt(schedule),
    approvesScript: approvesScript(schedule.depth),
    latestRun: latest
      ? { id: latest.id, status: latest.status, trigger: latest.trigger, triggeredAt: latest.triggeredAt, completedAt: latest.completedAt, step: latest.step, message: latest.message, error: latest.error, itemCount: latest.items.length }
      : null,
  }
}

/** Compact run view for the history list; items keep their stage trail. */
export function runView(run, { withItems = true } = {}) {
  return {
    ...run,
    itemCount: run.items.length,
    refs: { ...run.refs, scriptGenerationIds: [...run.refs.scriptGenerationIds], mediaRunIds: [...run.refs.mediaRunIds], publishTaskIds: [...run.refs.publishTaskIds] },
    depthLabel: run.depth ? DEPTH_LABEL[run.depth] : null,
    items: withItems ? run.items.map((item) => ({ ...item, stages: item.stages.map((stage) => ({ ...stage })) })) : [],
  }
}
