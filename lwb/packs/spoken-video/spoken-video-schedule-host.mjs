import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { spokenVideoDataPath } from './spoken-video-paths.mjs'
import {
  DEPTH_LABEL,
  emptyScheduleFile,
  emptyStages,
  finalStep,
  missedSlot,
  NO_PROGRESS_BUDGET_MS,
  parseScheduleRequest,
  reduceRunStatus,
  runView,
  SCHEDULE_FILE,
  SCHEDULE_POLL_INTERVAL_MS,
  SCHEDULE_TASK_LIMIT,
  scheduleDue,
  scheduleFile,
  scheduleView,
  scriptInputOf,
  SpokenVideoScheduleError,
  STEP_CEILING_MS,
  STEP_LABEL,
  STEP_TIMEOUT_MS,
  stepsForRun,
  videoTimeoutMs,
  voiceoverTimeoutMs,
  topicInputOf,
} from './spoken-video-schedule.mjs'
import {
  classifyFailure,
  CATEGORY_LABEL,
  EXTERNAL_DEPENDENCY_CATEGORIES,
  repairBackoffMs,
  STAGE_MAX_ATTEMPTS,
} from './spoken-video-failure.mjs'
import {
  canStartMore,
  emptyQueueFile,
  enqueue,
  nextRunnable,
  QUEUE_FILE,
  queueEntry,
  waitingWithPosition,
} from './spoken-video-queue.mjs'
import { ensureLocalBridge as ensureBridgeDefault, ensureLocalEngine as ensureEngineDefault, preflightSummary, runPreflight } from './spoken-video-runtime-preflight.mjs'
const TICK_INTERVAL_MS = 30_000
/**
 * 等外部依赖（桥接/引擎）恢复的上限。保活计划任务每 5 分钟一轮，两轮足够；
 * 超过说明不是「服务掉了」，继续等只会让整轮无限期挂着。
 */
const DEPENDENCY_WAIT_MS = 900_000
/**
 * 挂起轮次的最长等待。超时就判失败并清掉标记——不能让一轮永远占着 blocked
 * 躺在列表里，那比失败更难让人理解（「到底还在跑还是在等？」）。
 */
const BLOCKED_MAX_WAIT_MS = 6 * 60 * 60 * 1000
const LIVE = new Set(['queued', 'running'])
/** 故障档案保留条数。够看清趋势，又不会让文件无限涨。 */
const FAILURE_LIMIT = 500
/** 同一轮最多自动续跑几次，避免半夜无限重试。 */
const MAX_RESUMES = 3

function fail(code, message) { throw new SpokenVideoScheduleError(code, message) }
function invalid(message) { fail('SPOKEN_VIDEO_SCHEDULE_INVALID_INPUT', message) }
function stamp() { return new Date().toISOString() }
function elapsed(start, end) {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
function reasonOf(error) { return String(error?.message || error).slice(0, 500) }
function charsOf(body) { return [...String(body || '').replace(/\s+/g, '')].length }

/** 断点：已知做到 `reached`，下一步接哪一步。没做过就从第一步来。 */
function nextStepOf(steps, reached) {
  if (!reached) return null
  const index = steps.indexOf(reached)
  if (index === -1) return null
  return steps[index + 1] || null
}

async function workspaceFor(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '内容安排需要已加载的能力包专属工作区。')
  try {
    const workspace = await realpath(cwd)
    const info = await lstat(workspace)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid')
    return workspace
  } catch {
    fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '能力包专属工作区不可用，请重新加载能力包后重试。')
  }
}

async function rootFor(workspace, create = true) {
  const root = spokenVideoDataPath(workspace)
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_SCHEDULE_FILE_INVALID', '内容安排目录无效。')
    return root
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function readJsonFile(path, fallback) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_SCHEDULE_FILE_INVALID', '内容安排文件无效。')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback()
    if (error instanceof SyntaxError) fail('SPOKEN_VIDEO_SCHEDULE_FILE_INVALID', '内容安排文件不是有效 JSON。')
    throw error
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    // Windows：rename 的目标只要被任意句柄打开就会 EPERM（界面轮询会撞上写入窗口）；
    // 退避重试吸收，真故障仍抛出。失败时清掉临时文件，不在数据目录留下整份副本。
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break }
      catch (error) {
        if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= 6) throw error
        await new Promise((resolve) => setTimeout(resolve, [50, 120, 280, 600, 1200, 2400, 4000][attempt]))
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * Host for the content-schedule module: durable task records, the unattended
 * execution identity, and the stage orchestrator that replays the existing
 * production pipeline on a timer.
 *
 * Nothing here produces content. Every stage delegates to the host that
 * already owns it (content store for topic and script, media host for
 * voiceover/subtitles/render/qc, publish host for packaging) and polls that
 * host's own durable task record. This module owns only sequencing, timing,
 * the execution identity, and the run audit trail.
 *
 * Two deliberate boundaries:
 * - The `publish` depth is the only one that leaves the machine, and it stops
 *   at the platform's own submit button unless the task explicitly asked for
 *   auto-submit. A confirm-mode round reports `awaiting`, never `published`,
 *   because a person still has to finish it.
 * - Automation never widens a permission boundary. Delegated children already
 *   run with approval policy `never` under a workspace-write sandbox, exactly
 *   as they do when a person clicks the same button.
 */
export class SpokenVideoScheduleHost {
  constructor({
    ctx,
    context, executionStatus, background = (work) => work,
    content,
    projects,
    media,
    publish,
    workspacePath = context?.workspacePath,
    agents,
    agentDefaultModel,
    agentPresets,
    sessionTitle,
    presetId = 'standard',
    pollIntervalMs = SCHEDULE_POLL_INTERVAL_MS,
    tickIntervalMs = TICK_INTERVAL_MS,
    environment = process.env,
    now = stamp,
    ensureLocalEngine = null,
    ensureLocalBridge = null,
    dependencyWaitMs = DEPENDENCY_WAIT_MS,
    repairBackoff = repairBackoffMs,
  } = {}) {
    if (!content) throw new Error('SpokenVideoScheduleHost requires the content store.')
    if (!projects) throw new Error('SpokenVideoScheduleHost requires the project store.')
    if (!media) throw new Error('SpokenVideoScheduleHost requires the media host.')
    if (!publish) throw new Error('SpokenVideoScheduleHost requires the publish host.')
    this.context = context
    this.executionStatus = executionStatus
    this.background = background
    this.ctx = ctx || null
    this.content = content
    this.projects = projects
    this.media = media
    this.publish = publish
    this.workspacePath = workspacePath
    // The DSH services an unattended round needs are resolved lazily through
    // ctx.get rather than declared in the pack's `inject`. Cordis treats every
    // injected name as a hard dependency and keeps the whole plugin pending
    // until all of them exist, so declaring them would turn "automation is
    // unavailable here" into "the spoken-video pack never loads". An explicit
    // constructor argument still wins, which is what the tests inject.
    this.overrides = { agents, agentDefaultModel, agentPresets, sessionTitle }
    this.presetId = presetId
    // The defaults are the production cadence. A caller may pass anything
    // positive — the tests do, to keep a whole round under a second — but the
    // shipped wiring never overrides them, so a real host polls at 2s and
    // ticks at 30s.
    this.pollIntervalMs = Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 1 ? pollIntervalMs : SCHEDULE_POLL_INTERVAL_MS
    this.tickIntervalMs = Number.isSafeInteger(tickIntervalMs) && tickIntervalMs >= 1 ? tickIntervalMs : TICK_INTERVAL_MS
    this.now = now
    // 预检门槛（内存/磁盘/桥接地址）按实例读取，不直接摸全局——否则测试里
    // 临时抬高一个门槛会连带影响同一进程内其它测试的预检结果。
    this.environment = environment
    // 引擎自愈钩子。默认走 runtime-preflight 的真实实现；测试注入假实现，
    // 这样「预检拉起引擎」这条路径可以离线验证。
    this.ensureLocalEngine = ensureLocalEngine || ((kind, options) => ensureEngineDefault(kind, options))
    // 桥接自愈钩子。桥接（8199）是引擎（8188/8187）的上一层，桥接没了引擎拉不动，
    // 所以 #autoRepair 必须先救桥接再谈引擎——见该方法的注释与 2026-10-10 的事故。
    this.ensureLocalBridge = ensureLocalBridge || ((options) => ensureBridgeDefault(options))
    // 等依赖恢复的上限。生产 wiring 走 15 分钟默认值；测试会把它压到毫秒级，
    // 否则这条分支在单测里等于 15 分钟——挂起逻辑就永远测不到。
    this.dependencyWaitMs = Number.isSafeInteger(dependencyWaitMs) && dependencyWaitMs >= 0 ? dependencyWaitMs : DEPENDENCY_WAIT_MS
    // 退避阶梯同理：生产用 spoken-video-failure 的真实曲线（engine.down 是
    // 60s→180s→300s），测试注入一个恒为几毫秒的实现，否则一条重试链要跑几分钟。
    this.repairBackoff = typeof repairBackoff === 'function' ? repairBackoff : repairBackoffMs
    /** Per-workspace write serialization for schedules.json. */
    this.writes = new Map()
    /** Live rounds: runId -> { workspace, scheduleId, controller }. */
    this.active = new Map()
    /** Last phase message written per stage, so polling does not thrash the file. */
    this.phaseNotes = new Map()
    this.firstTick = true
  }

  /** Lazy service lookup: an explicit injection wins, else read the live context. */
  #service(name) {
    const override = this.overrides[name]
    if (override) return override
    if (!this.ctx || typeof this.ctx.get !== 'function') return null
    try {
      return this.ctx.get(name) || null
    } catch {
      return null
    }
  }

  /* ------------------------------ file layer ------------------------------ */

  async serial(workspace, operation) {
    const previous = this.writes.get(workspace) || Promise.resolve()
    const result = previous.then(operation)
    const tail = result.catch(() => {})
    this.writes.set(workspace, tail)
    try {
      return await result
    } finally {
      if (this.writes.get(workspace) === tail) this.writes.delete(workspace)
    }
  }

  async paths(agent) {
    const workspace = await workspaceFor(agent)
    if (this.workspacePath && workspace !== this.workspacePath) fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '能力包工作区不匹配。')
    const root = await rootFor(workspace)
    if (!root) fail('SPOKEN_VIDEO_SCHEDULE_FILE_INVALID', '内容安排目录不可用。')
    return { workspace, root, file: join(root, SCHEDULE_FILE) }
  }

  async pathsForWorkspace(workspace) {
    const root = await rootFor(workspace, false)
    return root ? { workspace, root, file: join(root, SCHEDULE_FILE) } : null
  }

  /**
   * Reference sets used to self-heal the file on read. A deleted signal source
   * is dropped and a task left with nothing runnable — or whose account was
   * hard deleted — is disabled with an explicit reason, so a vanished
   * reference can never make the whole file unreadable.
   *
   * Platform accounts live in the publisher pack's own workspace, so they are
   * read through its host rather than from a file here. When that pack is not
   * loaded the answer is `null` — "cannot be judged" — so a task is NOT
   * disabled on disk just because the pack was unloaded; the round itself
   * fails with an actionable message if it reaches the publish step.
   */
  async references(paths) {
    const validSourceIds = new Set()
    const validAccountIds = new Set()
    let validPublishAccountIds = null
    try {
      const signals = await readJsonFile(join(paths.root, 'signals.json'), () => ({ sources: [] }))
      for (const source of Array.isArray(signals?.sources) ? signals.sources : []) {
        if (typeof source?.id === 'string') validSourceIds.add(source.id)
      }
    } catch { /* an unreadable signal pool must not block schedule reads */ }
    try {
      const profile = await readJsonFile(join(paths.root, 'topic-profile.json'), () => ({ accounts: [] }))
      for (const account of Array.isArray(profile?.accounts) ? profile.accounts : []) {
        if (typeof account?.id === 'string' && account.status === 'active') validAccountIds.add(account.id)
      }
    } catch { /* same */ }
    const publisher = this.#service('publisherHost')
    if (publisher?.listAccounts) {
      try {
        validPublishAccountIds = new Set()
        for (const account of await publisher.listAccounts()) {
          // Existence only. Whether an account is currently usable — signed in,
          // platform adapted — is a temporary condition the operator can fix,
          // so it is checked when the round runs and reported as a blocker on
          // the form, never by switching the task off on disk.
          if (typeof account?.id === 'string') validPublishAccountIds.add(account.id)
        }
      } catch { validPublishAccountIds = null /* unreadable: treat as unjudgeable, not as deleted */ }
    }
    return { validSourceIds, validAccountIds, validPublishAccountIds }
  }

  async readFile(paths) {
    const raw = await readJsonFile(paths.file, emptyScheduleFile)
    const result = scheduleFile(raw, await this.references(paths))
    if (result.changed) await writeJsonFile(paths.file, result.data)
    return result.data
  }

  async mutate(paths, operation) {
    return this.serial(paths.workspace, async () => {
      const data = await this.readFile(paths)
      const value = await operation(data)
      await writeJsonFile(paths.file, data)
      return value
    })
  }

  /* -------------------------------- queries ------------------------------- */

  /**
   * Readiness snapshot for the task form. A depth that renders video but has
   * no TTS credential, or no Remotion, should warn the operator when they save
   * the task rather than failing silently at three in the morning. Reads the
   * media and publish hosts' own status; no agent scope needed.
   */
  async runtimeStatus() {
    let media = null
    let publish = null
    try { media = await this.media.status() } catch { /* surfaced as unavailable below */ }
    try { publish = await this.publish.status() } catch { /* same */ }
    const provider = media?.connection?.provider || 'bailian'
    // `connection.providers[p]` IS the credential status ({ configured, source,
    // writable }) — it has no nested `.credential`. The audio page reads the very
    // same object through `providers[p].credential`, so both paths must agree.
    const ttsCredential = Boolean(media?.connection?.providers?.[provider]?.configured)
    const automationAvailable = this.context
      ? (await this.executionStatus?.())?.configured === true
      : this.#automationAvailable()
    const publishTargets = await this.#publishTargets()
    return {
      automationAvailable,
      remotion: media?.renderers?.remotion === true,
      tts: { configured: media?.ttsConfigured === true, provider, credential: ttsCredential },
      coverImage: publish?.configured === true,
      publish: publishTargets,
      // Deepest depth the current environment can actually reach end to end.
      blockers: this.#runtimeBlockers(media, publish, ttsCredential, automationAvailable, publishTargets),
    }
  }

  /** Platform accounts a round could actually deliver to, or the reason it cannot. */
  async #publishTargets() {
    const publisher = this.#service('publisherHost')
    if (!publisher?.listAccounts) {
      return { available: false, accounts: [], reason: '未加载「发布与账号管理」能力包，无法投递到平台。' }
    }
    try {
      const accounts = await publisher.listAccounts()
      const usable = accounts
        .filter((account) => account.adapterReady === true)
        .map((account) => ({
          id: account.id,
          label: account.label,
          platform: account.platform,
          platformLabel: account.platformLabel || account.platform,
          status: account.status,
        }))
      const signedIn = usable.filter((account) => account.status === 'active')
      return {
        available: signedIn.length > 0,
        accounts: usable,
        reason: signedIn.length > 0 ? null : '没有已登录的平台账号，请先在「发布与账号管理 → 账号」中扫码登录。',
      }
    } catch (error) {
      return { available: false, accounts: [], reason: `读取平台账号失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  #automationAvailable() {
    const agents = this.#service('agents')
    const agentPresets = this.#service('agentPresets')
    const agentDefaultModel = this.#service('agentDefaultModel')
    return Boolean(agents?.create && agentPresets?.mount && agentDefaultModel?.currentSelection)
  }

  #runtimeBlockers(media, publish, ttsCredential, automationAvailable, publishTargets) {
    const blockers = []
    if (!automationAvailable) blockers.push({ depth: 'topic', message: this.context ? 'DSH 尚未选择默认模型，请在“设置 → 系统设置 → 模型”中完成配置。' : '当前运行环境不提供 Agent 服务，自动化不可用。' })
    if (!media) blockers.push({ depth: 'video', message: '媒体服务不可用，无法配音或渲染。' })
    else {
      if (!ttsCredential && media?.providers?.legacy?.configured !== true) {
        blockers.push({ depth: 'video', message: '未配置 TTS 凭据，配音阶段会失败。' })
      }
      if (media.renderers?.remotion !== true) blockers.push({ depth: 'video', message: 'Remotion 不可用，无法渲染成片。' })
    }
    // Surfaced on the form so a publish task is not saved with no way to deliver.
    if (publishTargets && publishTargets.available !== true) {
      blockers.push({ depth: 'publish', message: publishTargets.reason || '没有可用的平台账号，投递阶段会失败。' })
    }
    return blockers
  }

  async listSchedules(agent) {
    const paths = await this.paths(agent)
    return this.serial(paths.workspace, async () => {
      const data = await this.readFile(paths)
      const runs = [...data.runs].sort((left, right) => String(right.triggeredAt).localeCompare(String(left.triggeredAt)))
      return {
        schedules: data.schedules
          .map((schedule) => scheduleView(schedule, runs))
          .sort((left, right) => String(left.time).localeCompare(String(right.time)) || left.name.localeCompare(right.name)),
        // Task cards only need active rounds and the most recent round. Full
        // history is fetched through the paginated listScheduleRuns endpoint.
        runs: runs.filter((run, index) => index === 0 || run.status === 'running').map((run) => runView(run, { withItems: false })),
      }
    })
  }

  async scheduleRun(agent, request) {
    const runId = String(request?.runId || '').trim()
    if (!runId) invalid('执行记录标识不能为空。')
    const paths = await this.paths(agent)
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const run = data.runs.find((item) => item.id === runId)
    if (!run) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '执行记录不存在。')
    const schedule = data.schedules.find((item) => item.id === run.scheduleId) || null
    return { run: runView(run), schedule: schedule ? scheduleView(schedule, data.runs) : null, active: this.active.has(runId) }
  }

  async listScheduleRuns(agent, request = {}) {
    const { scheduleId, accountId, general = false, status = 'all', trigger = 'all', query = '', offset = 0, limit = 8 } = request
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid('执行记录分页参数无效。')
    // `interrupted` 与 `blocked` 是断点续跑与开工前体检引入的终态，筛选器必须能
    // 单独选中它们——「哪些轮次被中断了、哪些被体检拦下了」正是要回答的问题。
    if (!['all', 'running', 'completed', 'partial', 'failed', 'missed', 'cancelled', 'interrupted', 'blocked'].includes(status)) invalid('执行状态筛选无效。')
    if (!['all', 'manual', 'automatic'].includes(trigger)) invalid('触发方式筛选无效。')
    if (typeof query !== 'string' || query.length > 160) invalid('搜索内容不能超过 160 字。')
    const paths = await this.paths(agent)
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const schedules = new Map(data.schedules.map((schedule) => [schedule.id, schedule]))
    const needle = query.trim().toLocaleLowerCase()
    const scoped = data.runs.filter((run) => {
      const schedule = schedules.get(run.scheduleId)
      return (!scheduleId || run.scheduleId === scheduleId) && (!accountId || schedule?.accountId === accountId) && (!general || !schedule?.accountId)
    })
    const matching = scoped.filter((run) => (status === 'all' || run.status === status) && (trigger === 'all' || run.trigger === trigger)
      && (!needle || [schedules.get(run.scheduleId)?.name, run.message, ...run.items.map((item) => item.title)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)))
      .sort((left, right) => String(right.triggeredAt).localeCompare(String(left.triggeredAt)) || right.id.localeCompare(left.id))
    const items = await Promise.all(matching.slice(offset, offset + limit).map(async (run) => ({
      id: run.id, scheduleId: run.scheduleId, scheduleName: schedules.get(run.scheduleId)?.name || '已删除任务',
      status: run.status, trigger: run.trigger, triggeredAt: run.triggeredAt, completedAt: run.completedAt,
      elapsedMs: run.elapsedMs, step: run.step, depthLabel: DEPTH_LABEL[run.depth] || null, message: run.message, error: run.error,
      // 分类与修复建议必须跟着走：失败弹窗的正文优先显示 remedy（"该做什么"），
      // 而不是笼统的 error。少了这两列，弹窗就退化成一句没用的报错。
      remedy: run.remedy, failureCategory: run.failureCategory, resumeCount: run.resumeCount,
      itemCount: run.items.length, completedCount: run.items.filter((item) => item.status === 'completed').length,
      items: await Promise.all(run.items.map(async (item) => {
        let project = null
        if (item.projectId && item.qcPassed) {
          try { project = await this.projects.get(agent, { projectId: item.projectId }) } catch { /* deleted projects leave their audit record readable */ }
        }
        return { projectId: item.projectId, title: item.title, status: item.status, qcPassed: item.qcPassed, scriptChars: item.scriptChars,
          orientation: item.orientation, video: project?.artifacts?.video?.data?.video || null,
          packaging: { covers: project?.artifacts?.packaging?.data?.covers || null } }
      })),
    })))
    return { items, total: matching.length, offset, limit, anyRunning: scoped.some((run) => run.status === 'running') }
  }

  /* -------------------------------- mutations ----------------------------- */

  async #validateTargets(agent, parsed) {
    if (parsed.accountId) {
      const library = await this.content.listAccounts(agent)
      const account = library.accounts.find((item) => item.id === parsed.accountId)
      if (!account || account.status !== 'active') invalid('所选账号定位不存在或已归档。')
    }
    const known = new Set((await this.content.sources(agent)).map((item) => item.id))
    const unknown = parsed.sources.sourceIds.filter((id) => !known.has(id))
    if (unknown.length) invalid(`包含不存在的信号来源：${unknown.join('、')}。`)
    if (!parsed.sources.sourceIds.length && !parsed.sources.platforms.length) {
      invalid('请至少选择一个参与渠道（公开来源或 AI 内容日报平台）。')
    }
  }

  async createSchedule(agent, request) {
    const parsed = parseScheduleRequest(request)
    const paths = await this.paths(agent)
    await this.#validateTargets(agent, parsed)
    const createdAt = this.now()
    const item = { ...parsed, id: randomUUID(), disabledReason: null, createdAt, updatedAt: createdAt, lastRunAt: null }
    return this.mutate(paths, (data) => {
      if (data.schedules.length >= SCHEDULE_TASK_LIMIT) invalid(`内容安排数量已达上限（${SCHEDULE_TASK_LIMIT} 个）。`)
      data.schedules.push(item)
      return scheduleView(item, data.runs)
    })
  }

  async updateSchedule(agent, request) {
    const parsed = parseScheduleRequest(request)
    const id = String(request?.scheduleId || '').trim().toLowerCase()
    if (!id) invalid('内容安排标识不能为空。')
    const paths = await this.paths(agent)
    await this.#validateTargets(agent, parsed)
    return this.mutate(paths, (data) => {
      const item = data.schedules.find((candidate) => candidate.id === id)
      if (!item) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '内容安排不存在。')
      Object.assign(item, parsed, { updatedAt: this.now() })
      if (item.enabled) item.disabledReason = null
      return scheduleView(item, data.runs)
    })
  }

  async setScheduleEnabled(agent, request) {
    const id = String(request?.scheduleId || '').trim().toLowerCase()
    if (!id) invalid('内容安排标识不能为空。')
    const enabled = request?.enabled === true
    const paths = await this.paths(agent)
    return this.mutate(paths, (data) => {
      const item = data.schedules.find((candidate) => candidate.id === id)
      if (!item) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '内容安排不存在。')
      if (enabled && item.disabledReason) fail('SPOKEN_VIDEO_SCHEDULE_DISABLED', item.disabledReason)
      item.enabled = enabled
      item.updatedAt = this.now()
      return scheduleView(item, data.runs)
    })
  }

  /**
   * Delete a task together with its history. The run audit trail is keyed by
   * schedule, and keeping orphan runs would resurrect a task the operator
   * deliberately removed.
   */
  async deleteSchedule(agent, request) {
    const id = String(request?.scheduleId || '').trim().toLowerCase()
    if (!id) invalid('内容安排标识不能为空。')
    const paths = await this.paths(agent)
    if ([...this.active.values()].some((run) => run.workspace === paths.workspace && run.scheduleId === id)) {
      fail('SPOKEN_VIDEO_SCHEDULE_BUSY', '该任务正在执行，请先停止本轮再删除。')
    }
    return this.mutate(paths, (data) => {
      const index = data.schedules.findIndex((candidate) => candidate.id === id)
      if (index === -1) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '内容安排不存在。')
      data.schedules.splice(index, 1)
      data.runs = data.runs.filter((run) => run.scheduleId !== id)
      return { deleted: id }
    })
  }

  /* ------------------------------ run control ----------------------------- */

  /** Start one round immediately. Fire and forget: returns the run id. */
  async runSchedule(agent, request) {
    const id = String(request?.scheduleId || '').trim().toLowerCase()
    if (!id) invalid('内容安排标识不能为空。')
    const paths = await this.paths(agent)
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const schedule = data.schedules.find((candidate) => candidate.id === id)
    if (!schedule) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '内容安排不存在。')
    if (schedule.disabledReason) fail('SPOKEN_VIDEO_SCHEDULE_DISABLED', schedule.disabledReason)
    return this.startRun(paths, schedule, 'manual')
  }

  /**
   * Stop the round from advancing. Already started stage tasks are not force
   * killed here: each keeps its own durable record and recovery, and the
   * artifacts they committed stay. Releasing the execution identity unwinds
   * its scoped children.
   */
  async cancelScheduleRun(agent, request) {
    const runId = String(request?.runId || '').trim()
    if (!runId) invalid('执行记录标识不能为空。')
    const paths = await this.paths(agent)
    const entry = this.active.get(runId)
    if (!entry || entry.workspace !== paths.workspace) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '该执行记录不在运行中。')
    entry.controller.abort(new Error('操作者停止了本轮自动化。'))
    return { cancelled: runId }
  }

  /**
   * 删除单轮执行记录。用户清失败轮次用：runs 没有容量上限也不会自动淘汰，
   * 失败的轮次会一直堆在「执行记录」里（内容安排本身可以删，但那是连任务一起删）。
   *
   * 删完必须修正 `schedule.lastRunAt`——它被删掉那轮的时间戳如果还留着，界面上
   * 「上次运行」会指向一条已经不存在的记录。回退到剩余最新的一轮，删空则置空。
   */
  async deleteScheduleRun(agent, request) {
    const runId = String(request?.runId || '').trim()
    if (!runId) invalid('执行记录标识不能为空。')
    const paths = await this.paths(agent)
    const activeEntry = this.active.get(runId)
    if (activeEntry && activeEntry.workspace === paths.workspace) {
      fail('SPOKEN_VIDEO_SCHEDULE_BUSY', '该轮正在执行，请先停止再删除。')
    }
    return this.mutate(paths, (data) => {
      const index = data.runs.findIndex((run) => run.id === runId)
      if (index === -1) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '执行记录不存在。')
      const [removed] = data.runs.splice(index, 1)
      const schedule = data.schedules.find((candidate) => candidate.id === removed.scheduleId)
      if (schedule && schedule.lastRunAt === removed.triggeredAt) {
        const latest = data.runs
          .filter((run) => run.scheduleId === schedule.id)
          .reduce((newest, run) => (!newest || String(run.triggeredAt) > String(newest.triggeredAt) ? run : newest), null)
        schedule.lastRunAt = latest ? latest.triggeredAt : null
      }
      return { deleted: runId, scheduleId: removed.scheduleId, lastRunAt: schedule ? schedule.lastRunAt : null }
    })
  }

  /**
   * Reserve the slot and start the round. The stamp and the running record are
   * written BEFORE any stage starts, so the next thirty second tick can never
   * launch the same slot twice even though a round takes many minutes.
   *
   * `resumeRunId` turns this into a checkpoint continuation: the existing run
   * record is reused (same id, same items, same refs) instead of a new round
   * being created, so the audit trail stays one continuous line rather than
   * "round 1 failed, round 2 started from scratch".
   */
  async startRun(paths, schedule, trigger, { queueId = null, resumeRunId = null } = {}) {
    // 串行执行：机器一次只扛得住一轮渲染，交错执行的失败在审计里没法读。
    // 现在这个判断由队列保证（#drainQueue 只在空闲时取一个），这里是最后一道防线。
    if ([...this.active.values()].some((run) => run.workspace === paths.workspace)) {
      fail('SPOKEN_VIDEO_SCHEDULE_BUSY', '本工作区已有一轮自动化在执行，请等待其结束。')
    }
    const triggeredAt = this.now()
    const steps = stepsForRun(schedule.depth, schedule.production.subtitleEnabled)
    const resume = resumeRunId ? await this.#resumePayload(paths, resumeRunId, schedule) : null
    const runId = resume ? resumeRunId : randomUUID()
    const record = resume || {
      id: runId,
      scheduleId: schedule.id,
      status: 'running',
      trigger: trigger === 'resume' ? 'automatic' : trigger,
      triggeredAt,
      completedAt: null,
      elapsedMs: null,
      sessionId: null,
      depth: schedule.depth,
      step: steps[0],
      message: `已启动，目标深度「${DEPTH_LABEL[schedule.depth]}」。`,
      error: null,
      remedy: null,
      failureCategory: null,
      resumeCount: 0,
      refs: { topicGenerationId: null, scriptGenerationIds: [], mediaRunIds: [], publishTaskIds: [], publishJobIds: [] },
      items: [],
    }
    await this.mutate(paths, (data) => {
      const item = data.schedules.find((candidate) => candidate.id === schedule.id)
      if (item) {
        item.lastRunAt = triggeredAt
        item.updatedAt = triggeredAt
      }
      if (resume) {
        // 续跑不重写 triggeredAt：那是本轮真实开始的时间，也是「这一轮跑了多久」
        // 的唯一依据。resumeCount 单独记续跑了几次。
        const index = data.runs.findIndex((candidate) => candidate.id === runId)
        if (index !== -1) {
          data.runs[index] = {
            ...record,
            status: 'running',
            completedAt: null,
            elapsedMs: null,
            resumeCount: (record.resumeCount || 0) + 1,
            message: `主机重启后从「${STEP_LABEL[record.resumedFromStep] || record.resumedFromStep || '断点'}」续跑（第 ${(record.resumeCount || 0) + 1} 次）。`,
          }
        }
      } else {
        data.runs.unshift(record)
      }
    })
    const controller = new AbortController()
    this.active.set(runId, { workspace: paths.workspace, scheduleId: schedule.id, controller, queueId })
    void this.background(this.#execute(paths, runId, schedule, controller.signal, resume)
      .catch(() => {})
      .finally(() => { this.active.delete(runId) }))
    return { runId, triggeredAt, resumed: Boolean(resume) }
  }

  /** 组装续跑载荷：保留 id / items / refs，只把状态拨回可继续。 */
  async #resumePayload(paths, runId, schedule) {
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const run = data.runs.find((item) => item.id === runId)
    if (!run) return null
    const steps = stepsForRun(schedule.depth, schedule.production.subtitleEnabled)
    const items = run.items.map((item) => ({
      ...item,
      status: item.status === 'completed' ? 'completed' : 'running',
      error: null,
      remedy: null,
      failureCategory: null,
      resumeFrom: item.status === 'completed' ? null : (item.resumeFrom || nextStepOf(steps, item.reachedStep)),
      stages: item.stages.map((stage) => (stage.status === 'done' ? stage : { ...stage, status: 'pending', completedAt: null, message: null })),
    }))
    const firstOpen = items.find((item) => item.status === 'running')
    return {
      ...run,
      status: 'running',
      completedAt: null,
      elapsedMs: null,
      error: null,
      remedy: null,
      failureCategory: null,
      step: firstOpen?.resumeFrom || run.step,
      resumedFromStep: firstOpen?.resumeFrom || run.step,
      items,
    }
  }

  /* --------------------------- execution identity ------------------------- */

  /**
   * An unattended round has no user session, but every host entry point
   * resolves its workspace from `agent.session.header.cwd` and every DSH step
   * needs a live parent agent. Create one root agent per round, following the
   * upstream webhook and headless precedents.
   *
   * The standard preset is mandatory rather than optional: delegated children
   * inherit the parent's scoped tool composition, and without it the video
   * director could not reach the file tools it needs to write its Remotion
   * project. A missing preset service therefore fails the round loudly instead
   * of producing a crippled pipeline.
   */
  async #acquireAgent(workspace, schedule, signal) {
    const agents = this.#service('agents')
    const agentPresets = this.#service('agentPresets')
    const agentDefaultModel = this.#service('agentDefaultModel')
    if (!agents || typeof agents.create !== 'function') {
      fail('SPOKEN_VIDEO_SCHEDULE_UNAVAILABLE', '当前运行环境不提供 Agent 服务，无法执行自动化任务。')
    }
    if (!agentPresets || typeof agentPresets.mount !== 'function') {
      fail('SPOKEN_VIDEO_SCHEDULE_UNAVAILABLE', '当前运行环境不提供 Agent 预设服务，无法执行自动化任务。')
    }
    if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') {
      fail('SPOKEN_VIDEO_SCHEDULE_UNAVAILABLE', '当前运行环境不提供默认模型服务，无法执行自动化任务。')
    }
    const selection = agentDefaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const preset = await agentPresets.resolve(this.presetId)
    const setup = async (agentCtx) => { await agentPresets.mount(agentCtx, preset.id) }
    // One identity per task, reused across rounds, so the sidebar gains a
    // single recognizable session per schedule instead of one per run.
    const sessionId = `sv-auto-${schedule.id}`
    let handle
    try {
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup, signal })
    } catch {
      handle = await agents.create({ sessionId, meta: { cwd: workspace, agentPreset: preset.id }, agentOptions, setup, signal })
    }
    try {
      this.#service('sessionTitle')?.rename(handle.agent.session, `自动化 · ${schedule.name}`)
    } catch { /* a title is presentation only; never fail a round over it */ }
    return handle
  }

  /* -------------------------------- polling ------------------------------- */

  /**
   * 等待。`category`/`attempt` 给了就按失败类别走退避阶梯，否则是轮询间隔。
   *
   * 2026-10-10 修的实际 bug：这里原来无条件用 pollIntervalMs（2 秒），而
   * `repairBackoffMs` 在整个包里只被 import 从未被调用——所以那套退避曲线
   * 一直是死代码，真实的重试间隔就是 2 秒。2 秒对「服务掉了」毫无意义：
   * 2026-10-10 18:13 那轮桥接整个进程没了，三次尝试在 38 秒里全打在死服务上，
   * 于是轮次失败，而 repairBackoffMs 精心设计的阶梯从未生效过。
   *
   * 阶梯本身走 this.repairBackoff，覆盖后测试才能把 60s/180s 压到毫秒级走完
   * 整条重试链路；生产 wiring 从不覆盖，仍然是 spoken-video-failure 的那一档。
   */
  async #sleep(signal, category = null, attempt = null) {
    const budget = attempt === null
      ? this.pollIntervalMs
      : this.repairBackoff(attempt, category)
    if (budget <= this.pollIntervalMs) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return }
        const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, this.pollIntervalMs)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      return
    }
    // 长等待要能被停止打断，所以拆成小段轮询而不是一个长 setTimeout。
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return }
        const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, this.pollIntervalMs)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /**
   * Poll until `isDone` accepts the value, the round is cancelled, or the stage
   * is judged dead. A timeout never kills the underlying task — it keeps its
   * own durable record and recovery — it only stops this round from waiting.
   *
   * 两个判据取代了原来的单一墙钟：
   *
   * - **停滞预算**：只要子任务的进展指纹还在变（updatedAt / 阶段名），就重新
   *   计时。原来的固定墙钟把「跑得慢」和「已经死了」当成同一件事，于是长稿件
   *   被误杀——2026-10-09 13:00 那轮 2113 字实际跑完、音频已落盘，却因为刚过
   *   10 分钟被判超时，整轮报废。
   * - **硬性上限**：指纹一直在变但永远不变完的任务（死循环）由它兜底。
   *
   * `fingerprint(value)` 可选，默认按对象序列化取值——子任务记录每轮都会带上
   * 自己的 updatedAt/阶段，这正是「还在动」的证据。
   *
   * `timeoutMs` 让调用方按稿件长度等实际工作量上浮等待上限；不传就用该阶段的
   * 默认停滞预算。
   */
  async #poll(step, signal, read, isDone, timeoutMs = null, fingerprint = null) {
    const stallBudget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : (NO_PROGRESS_BUDGET_MS[step] || STEP_TIMEOUT_MS[step])
    const ceiling = STEP_CEILING_MS[step] || Number.POSITIVE_INFINITY
    const startedAt = Date.now()
    let lastProgressAt = startedAt
    let lastMark = null
    const markOf = fingerprint || ((value) => {
      try { return JSON.stringify([value?.status ?? null, value?.updatedAt ?? value?.updated ?? null, value?.phase ?? null, value?.progress ?? null]) } catch { return null }
    })
    // 「暂时读不到」与「永远读不到」必须分开。写盘走「临时文件 + 原子 rename」，
    // rename 目标被任意句符打开就 EPERM 重试（见 writeJson）——落地前那一瞬读者会
    // 读到旧内容，这是 2026-10-08 11:17 那次 102ms 竞态的成因，重试几次即可。
    //
    // 但还有另一种「读不到」：记录被容量上限淘汰后，每次查询都报「不存在」——那是
    // 永久性的，重试到超时也没用（2026-10-08 15:47 白等了 15 分钟）。所以前几次按
    // 「可能是竞态」重试，超过预算就认定它不会自己好。
    //
    // 只对「查不到记录」这一类重试：其它错误（发布器点不到按钮、鉴权失败…）重试
    // 只会把真因藏起来——2026-10-08 23:19 那轮就吃过这个亏：发布任务真实错误是
    // 「点『发布』按钮超时 45 秒」，却被套上「写稿记录被挤出队列、请重新执行」，
    // 把排查方向带偏了整整一轮。
    const RETRYABLE = /不存在|丢失/u
    const BUDGET = 5
    let missed = 0
    for (;;) {
      signal.throwIfAborted()
      let value
      try {
        value = await read()
      } catch (error) {
        if (!RETRYABLE.test(String(error?.message || ''))) throw error
        missed += 1
        if (missed >= BUDGET) {
          throw new Error(`${error.message}（已重试 ${BUDGET} 次仍读不到记录；${STEP_LABEL[step]}阶段的记录有保留上限，并发任务可能已把它挤出去——请重新执行本轮。）`)
        }
        await this.#sleep(signal)
        continue
      }
      missed = 0
      if (isDone(value)) return value
      // 进展指纹变了就重新给满停滞预算。这是本次改造的核心：慢不等于死。
      const mark = markOf(value)
      if (mark !== null && mark !== lastMark) {
        lastMark = mark
        lastProgressAt = Date.now()
      }
      const now = Date.now()
      if (now - lastProgressAt > stallBudget) {
        fail('SPOKEN_VIDEO_SCHEDULE_NO_PROGRESS', `${STEP_LABEL[step]}已连续 ${Math.round(stallBudget / 60_000)} 分钟没有任何进展（任务可能已卡死），本轮将自动重试该阶段。`)
      }
      if (now - startedAt > ceiling) {
        fail('SPOKEN_VIDEO_SCHEDULE_TIMEOUT', `${STEP_LABEL[step]}超过 ${Math.round(ceiling / 60_000)} 分钟硬性上限仍未完成。`)
      }
      await this.#sleep(signal)
    }
  }

  /* ------------------------------- orchestrator ---------------------------- */

  async #execute(paths, runId, schedule, signal, resume = null) {
    let handle = null
    try {
      handle = this.context ? { agent: this.context, dispose: async () => {} } : await this.#acquireAgent(paths.workspace, schedule, signal)
      const agent = handle.agent
      await this.#patch(paths, runId, (run) => { run.sessionId = agent.id ? String(agent.id) : null })
      await this.#runRound(paths, runId, agent, schedule, signal, resume ? { topicGenerationId: resume.refs?.topicGenerationId || null } : null)
      await this.#settleAlert(paths, runId)
    } catch (error) {
      const cancelled = signal.aborted
      const failure = classifyFailure({ error })
      await this.#appendFailure(paths, {
        runId,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        step: failure.step,
        attempt: 1,
        category: failure.category,
        categoryLabel: CATEGORY_LABEL[failure.category] || '',
        signature: failure.signature,
        message: failure.message,
        remedy: failure.remedy,
        remedyTarget: failure.remedyTarget,
        code: failure.code,
        fatal: true,
      }).catch(() => {})
      await this.#patch(paths, runId, (run) => {
        run.status = cancelled ? 'cancelled' : 'failed'
        run.error = cancelled ? null : reasonOf(error)
        run.remedy = cancelled ? null : failure.remedy
        run.failureCategory = cancelled ? null : failure.category
        run.message = cancelled
          ? '本轮已按操作者要求停止，已完成的阶段产物保留。'
          : `自动化在「${STEP_LABEL[run.step] || run.step}」阶段失败：${failure.remedy}`
        run.completedAt = this.now()
        run.elapsedMs = elapsed(run.triggeredAt, run.completedAt)
        for (const item of run.items) {
          if (item.status !== 'running') continue
          item.status = cancelled ? 'cancelled' : 'failed'
          if (!cancelled && !item.error) {
            item.error = reasonOf(error)
            item.remedy = failure.remedy
            item.failureCategory = failure.category
          }
        }
      }).catch(() => {})
      await this.#settleAlert(paths, runId)
    } finally {
      if (handle) await handle.dispose().catch(() => {})
    }
  }

  /**
   * 轮次落到终态后发一条无人值守告警，供独立于浏览器的 Windows 计划任务播放。
   * 失败也发——那正是人最需要被叫醒的时刻。
   */
  async #settleAlert(paths, runId) {
    try {
      const run = await this.#patch(paths, runId, () => {})
      if (!run) return
      const data = await this.serial(paths.workspace, () => this.readFile(paths))
      const name = data.schedules.find((candidate) => candidate.id === run.scheduleId)?.name || '内容安排'
      const ok = run.status === 'completed'
      const label = ok ? '已完成' : run.status === 'partial' ? '部分完成' : run.status === 'cancelled' ? '已停止' : '失败'
      const minutes = run.elapsedMs ? `，耗时 ${Math.round(run.elapsedMs / 60_000)} 分钟` : ''
      await this.#alert(paths, {
        level: ok ? 'success' : 'error',
        title: `${name}：自动化${label}${minutes}`,
        detail: `${run.message || ''}${run.error ? `｜${run.error}` : ''}`.slice(0, 400),
      })
    } catch { /* 通知尽力而为 */ }
  }

  async #runRound(paths, runId, agent, schedule, signal, resume = null) {
    const steps = stepsForRun(schedule.depth, schedule.production.subtitleEnabled)
    const startedAt = this.now()

    // 续跑：topic 已经产出项目，不必重做一遍选题（那会生成一批新项目，与本轮无关）。
    // 复用原来的选题批次与已建的项目，只从真正断掉的那一步接着走。
    let generation = null
    let projects = null
    if (resume?.topicGenerationId) {
      try {
        generation = await this.content.topicGenerationStatus(agent, { id: resume.topicGenerationId })
        if (generation.status === 'completed') {
          projects = await this.#resumeProjects(paths, runId, generation)
        }
      } catch { generation = null }
    }

    // Topic generation also backfills today's missing channels, which is why a
    // separate collect step would be redundant.
    if (!projects) {
      await this.#patch(paths, runId, (run) => { run.step = 'topic' })
      const launched = await this.content.startTopicGeneration(agent, topicInputOf(schedule))
      await this.#patch(paths, runId, (run) => { run.refs.topicGenerationId = launched.id })
      generation = await this.#poll('topic', signal,
        () => this.content.topicGenerationStatus(agent, { id: launched.id }),
        (record) => !LIVE.has(record.status))
      if (generation.status !== 'completed') {
        // A failed round always carries the reason in `error`; the message stays
        // a one-line human summary for the task card.
        await this.#finish(paths, runId, startedAt, 'failed', 'topic', '选题生成未完成。', generation.error || '选题生成未正常结束。')
        return
      }
      projects = await this.#selectProjects(agent, generation, schedule.perRunLimit)
      if (!projects.length) {
        await this.#finish(paths, runId, startedAt, 'failed', 'topic', '本轮没有可用的选题候选。', '选题生成已完成，但没有返回可用候选；可调整选题角度或参与渠道后重试。')
        return
      }
    }

    const rest = steps.filter((step) => step !== 'topic')
    if (!resume) {
      const topicDoneAt = this.now()
      await this.#patch(paths, runId, (run) => {
        run.items = projects.map((project) => ({
          projectId: project.projectId,
          title: project.title,
          // A topic-only round is already finished here; leaving the item running
          // would strand it in a state no later pass ever revisits.
          status: rest.length ? 'running' : 'completed',
          reachedStep: 'topic',
          resumeFrom: null,
          signalCount: project.signalCount,
          scriptChars: null,
          scriptRevision: null,
          durationSeconds: null,
          orientation: rest.includes('video') ? schedule.production.orientation : null,
          qcPassed: false,
          coverState: null,
          publishState: null,
          publishAccount: null,
          publishUrl: null,
          error: null,
          stages: emptyStages(steps).map((stage) => (stage.step === 'topic'
            ? { ...stage, status: 'done', startedAt, completedAt: topicDoneAt, refId: generation.id, message: `候选「${project.title}」· 依据 ${project.signalCount} 条信号` }
            : stage)),
        }))
        run.message = rest.length
          ? `选题完成，本轮推进 ${projects.length} 条至「${DEPTH_LABEL[schedule.depth]}」。`
          : `选题完成，本轮产出 ${projects.length} 条待写稿选题。`
        if (!rest.length) {
          run.status = 'completed'
          run.step = 'topic'
          run.completedAt = this.now()
          run.elapsedMs = elapsed(startedAt, run.completedAt)
        }
      })
      if (!rest.length) return
    }

    // One project at a time: rendering saturates the machine, and interleaved
    // failures are far harder to read in the audit trail.
    const targets = resume
      ? (await this.#readItems(paths, runId))
        .map((item) => ({ projectId: item.projectId, resumeFrom: item.resumeFrom || nextStepOf(rest, item.reachedStep) }))
        .filter((item) => item.projectId)
      : projects.map((project) => ({ projectId: project.projectId, resumeFrom: null }))
    for (const target of targets) {
      if (signal.aborted) break
      await this.#runItem(paths, runId, agent, schedule, target.projectId, rest, signal, target.resumeFrom)
    }

    const cancelled = signal.aborted
    const items = await this.#readItems(paths, runId)
    const done = items.filter((item) => item.status === 'completed').length
    const status = reduceRunStatus(items, cancelled)
    const last = finalStep(schedule.depth, schedule.production.subtitleEnabled)

    // 依赖挂起优先于失败判定。#runItem 在外部依赖不可用且重试耗尽时会把条目标成
    // interrupted 并在轮次上打 blockedBy（见 #runItem 失败分支）。这时轮次不是
    // 「做完了但不好」，而是「等得起」——已完成阶段的产物全在盘上，#requeueBlocked
    // 会在依赖恢复后把这一轮原样续跑。所以不能落到 failed：那会让它看起来已经结束，
    // 而实际上只差一个没人点的按钮。
    const blockedRun = cancelled ? null : await this.#blockedBy(paths, runId)
    if (blockedRun) {
      await this.#finish(paths, runId, startedAt, 'blocked', blockedRun.step || last,
        `${STEP_LABEL[blockedRun.step] || blockedRun.step || last}等待外部服务恢复，已完成的阶段产物全部保留；恢复后本轮会自动续跑。`,
        null)
      await this.#patch(paths, runId, (run) => {
        run.blockedBy = blockedRun.blockedBy
        run.blockedAt = blockedRun.blockedAt || this.now()
        // 挂起不是终态：不给 completedAt / elapsedMs，否则续跑时这段等待时间
        // 就从审计里消失了，看起来像「没等过就成功了」。
        run.completedAt = null
        run.elapsedMs = null
      }).catch(() => {})
      return
    }

    // A confirm-mode round finishes its steps but leaves the platform's submit
    // button to a person. Saying "已发布" there would be a lie the audit trail
    // then repeats, so the closing message reports the handover instead.
    const awaiting = items.filter((item) => item.publishState === 'awaiting').length
    await this.#finish(paths, runId, startedAt, status, last,
      cancelled ? '本轮已按操作者要求停止，已完成的阶段产物保留。'
        : awaiting ? `本轮完成，${awaiting} 条已投递到平台并填好资料，等待在浏览器窗口确认发布。`
          : status === 'completed' ? `本轮完成，${done} 条已推进到「${DEPTH_LABEL[schedule.depth]}」。`
            : status === 'partial' ? `本轮部分完成：${done}/${items.length} 条推进到「${DEPTH_LABEL[schedule.depth]}」。`
              : '本轮全部失败，请展开各条查看原因。',
      cancelled ? null : items.find((item) => item.error)?.error || null)
  }

  /**
   * 续跑时的项目列表：直接读本轮已建的项目，不再重新选题（重新选会生成一批
   * 与本轮无关的新项目）。返回空数组表示这轮没有可继续的条目。
   */
  async #resumeProjects(paths, runId, generation) {
    const items = await this.#readItems(paths, runId)
    return items
      .filter((item) => item.projectId)
      .map((item) => ({ projectId: item.projectId, title: item.title }))
  }

  /**
   * The recommended candidate is already materialised into a project by the
   * content store. When the round wants more than one, take the following
   * candidates in the same recommendation order the topic page shows.
   */
  async #selectProjects(agent, generation, wanted) {
    const chosen = new Map()
    const candidates = [...(generation.candidates || [])]
    for (const candidate of candidates) {
      if (candidate?.selection?.state !== 'selected' || !candidate.selection.projectId) continue
      chosen.set(candidate.selection.projectId, {
        projectId: candidate.selection.projectId,
        title: candidate.title,
        signalCount: (candidate.signalIds || []).length,
      })
    }
    for (const candidate of candidates) {
      if (chosen.size >= wanted || !candidate?.id) continue
      if (candidate.selection?.projectId && chosen.has(candidate.selection.projectId)) continue
      try {
        await this.content.setTopicCandidateSelection(agent, { id: generation.id, candidateId: candidate.id, selected: true })
      } catch {
        continue
      }
      const fresh = await this.content.topicGenerationStatus(agent, { id: generation.id })
      const selected = (fresh.candidates || []).find((item) => item.id === candidate.id)
      if (selected?.selection?.projectId) {
        chosen.set(selected.selection.projectId, {
          projectId: selected.selection.projectId,
          title: selected.title,
          signalCount: (selected.signalIds || []).length,
        })
      }
    }
    return [...chosen.values()].slice(0, wanted)
  }

  /**
   * Drive one project through its steps.
   *
   * A stage that fails is classified first. Retryable failures (a dead local
   * engine, a rate limit, a stalled stage) are repaired and the *same stage* is
   * re-entered — never the whole round, so a 40-minute pipeline does not throw
   * away 40 minutes because the engine needed a restart at minute 35.
   * Non-retryable failures (a dead credential, a QC rejection) stop immediately
   * with the remedy attached, because retrying them only wastes time.
   */
  async #runItem(paths, runId, agent, schedule, projectId, steps, signal, resumeFrom = null) {
    // 续跑时跳过已完成阶段；每阶段开始前还会用 refId 复查一次子任务的真实状态，
    // 所以即使阶段被标记为 done 而产物其实没落盘，也会被重新做一遍。
    const startIndex = resumeFrom ? Math.max(0, steps.indexOf(resumeFrom)) : 0
    for (let index = startIndex; index < steps.length; index += 1) {
      const step = steps[index]
      signal.throwIfAborted()
      if (await this.#stageAlreadyDone(paths, agent, runId, projectId, step)) continue
      const maxAttempts = STAGE_MAX_ATTEMPTS[step] ?? 1
      for (let attempt = 1; ; attempt += 1) {
        await this.#setStage(paths, runId, projectId, step, { status: 'running', startedAt: this.now() })
        try {
          const note = await this.#runStep(step, agent, schedule, projectId, signal, paths, runId)
          await this.#setStage(paths, runId, projectId, step, {
            status: 'done',
            completedAt: this.now(),
            ...(note?.refId ? { refId: note.refId } : {}),
            ...(note?.message ? { message: note.message } : {}),
          })
          await this.#patchItem(paths, runId, projectId, (item) => {
            item.reachedStep = step
            item.error = null
            item.remedy = null
            item.failureCategory = null
          })
          break
        } catch (error) {
          const cancelled = signal.aborted
          const failure = classifyFailure({ error, step })
          const message = reasonOf(error)
          await this.#setStage(paths, runId, projectId, step, {
            status: cancelled ? 'skipped' : 'failed',
            completedAt: this.now(),
            message: cancelled ? '本轮已停止。' : message,
          })
          if (cancelled) {
            await this.#patchItem(paths, runId, projectId, (item) => {
              item.status = 'cancelled'
              item.error = null
            })
            return
          }
          await this.#recordStageFailure(paths, runId, projectId, step, failure, attempt)
          // 外部依赖挂起：如果这一轮整体是因为服务不在才走不完的，把它标成 blocked
          // 而不是 failed，交给 #requeueBlocked 在依赖恢复后续跑。判据是「失败分类属
          // 于外部依赖类」——代码 bug（code.defect）永远不该被当成「等会儿就好了」。
          const dependencyDown = EXTERNAL_DEPENDENCY_CATEGORIES.has(failure.category)
          if (failure.retryable && attempt < maxAttempts) {
            await this.#sleep(signal, failure.category, attempt)
            const repair = await this.#autoRepair(failure, step, signal)
            // 感知式重试：修复动作声称成功，但要确认依赖真的活了才值得再进本阶段。
            // 否则就是拿剩余的尝试次数去打一个还没起来的服务——2026-10-10 18:13 那次
            // 38 秒内三次全废，正是因为没人确认「桥接到底回来了没有」。
            if (repair && repair.bridge && repair.bridge.ok === false) {
              await this.#awaitDependency(paths, runId, projectId, step, repair.bridge, signal)
            }
            // 重入本阶段：setStage 会把它重新标成 running，审计里能看到重试痕迹。
            continue
          }
          await this.#patchItem(paths, runId, projectId, (item) => {
            item.status = dependencyDown && failure.retryable ? 'interrupted' : 'failed'
            item.error = message
            item.remedy = failure.remedy
            item.failureCategory = failure.category
            if (dependencyDown && failure.retryable) {
              item.resumeFrom = item.resumeFrom || step
              item.message = '等待外部服务恢复后自动续跑，已完成的阶段产物全部保留。'
            }
          })
          if (dependencyDown && failure.retryable) {
            // 轮次级挂起标记。#execute 收尾时读到它就不会把轮次判死。
            await this.#patch(paths, runId, (run) => {
              run.blockedBy = failure.category
              run.blockedAt = this.now()
              run.completedAt = null
              run.elapsedMs = null
              run.error = null
              run.remedy = failure.remedy
              run.failureCategory = failure.category
              run.message = `${STEP_LABEL[step] || step}等待外部服务恢复，已保留全部产物，恢复后自动续跑。`
            }).catch(() => {})
          }
          return
        }
      }
    }
    await this.#patchItem(paths, runId, projectId, (item) => { item.status = 'completed' })
  }

  /**
   * 等外部依赖恢复，不消耗尝试次数。
   *
   * 什么时候用：#autoRepair 已经尽力了但依赖仍然不可达（比如桥接拉不起来）。
   * 这时候「再试一次业务调用」是纯浪费——它必然以同样的 fetch failed 结束，
   * 而每一次浪费掉的尝试都在压缩最后的机会。正确的做法是停下来等：保活
   * （LWBKeepAlive，每 5 分钟一轮）把服务拉回来之后，这一轮自己接着走。
   *
   * 上限取 15 分钟：保活周期是 5 分钟，两轮足够；真超过这个数说明不是「服务
   * 掉了」而是别的问题，继续等只是让整轮无限期挂着。到点后返回 false，让调用
   * 方正常消耗一次尝试并最终判失败——宁可失败也不要永远不落地。
   *
   * 上限走 this.dependencyWaitMs 而不是模块常量，是为了让测试能把它压到毫秒级
   * 走完这条分支；生产 wiring 从不覆盖它，仍然是 15 分钟。
   */
  async #awaitDependency(paths, runId, projectId, step, bridgeFailure, signal) {
    const budget = this.dependencyWaitMs
    const deadline = Date.now() + budget
    await this.#patchItem(paths, runId, projectId, (item) => {
      item.message = `本地媒体桥接不可用，正在等待自动恢复（最多 ${Math.max(1, Math.round(budget / 60_000))} 分钟）…`
    }).catch(() => {})
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      await this.#sleep(signal)
      try {
        const probe = await this.ensureLocalBridge?.({ timeoutMs: 5000, signal })
        if (probe?.ok) {
          await this.#patchItem(paths, runId, projectId, (item) => { item.message = null }).catch(() => {})
          return true
        }
      } catch { /* 继续等 */ }
    }
    await this.#patchItem(paths, runId, projectId, (item) => {
      item.message = null
    }).catch(() => {})
    return false
  }

  /**
   * 幂等复查：阶段记录写着 done，但它指向的子任务是不是真的成功了？
   *
   * 续跑的正确性完全依赖这一步。断点续跑要跳过「已完成的阶段」，而唯一可信的
   * 判据是那个阶段的 refId 指向的子任务的真实终态——阶段记录是我们自己写的，
   * 也可能写着 done 而产物其实没落盘（比如写到一半主机挂了）。
   *
   * 查不到子任务时返回 false（宁可重做，不可假定成功）。重做的代价是一次
   * 配音或渲染；跳过的代价是交付一个坏产物。
   */
  /** 轮次是否处于「等外部依赖」状态；是则返回挂起详情，否则 null。 */
  async #blockedBy(paths, runId) {
    try {
      const run = await this.#patch(paths, runId, () => {})
      if (!run?.blockedBy) return null
      return {
        blockedBy: run.blockedBy,
        blockedAt: run.blockedAt,
        step: run.items.find((item) => item.resumeFrom)?.resumeFrom || run.step,
      }
    } catch {
      return null
    }
  }

  /**
   * 依赖挂起后的续跑：探到依赖已经回来了，就把 blocked 的轮次重新入队。
   *
   * 与 #requeueInterrupted 的区别：那一条处理「主机重启」，不关心外部服务；
   * 这一条处理「服务掉了」，所以入队前必须先探一次——否则每 30 秒的 tick 都会
   * 把同一轮塞进队列，在服务仍然没起来的情况下反复消耗它的重试次数。2026-10-10
   * 18:13 那轮的教训正是「没人确认服务到底回来没有」。
   *
   * 挂起上限 BLOCKED_MAX_WAIT_MS：真等不到（比如桥接被人手工停掉且不再启动）就
   * 判失败并清理标记，不能让一轮永远占着 blocked 状态在列表里躺着。
   */
  async #requeueBlocked(paths, data) {
    const clock = Date.now()
    const waiting = data.runs.filter((run) => run.status === 'blocked' && run.blockedBy)
    if (!waiting.length) return
    for (const run of waiting) {
      const blockedAt = Date.parse(run.blockedAt || run.triggeredAt || '') || clock
      if (clock - blockedAt > BLOCKED_MAX_WAIT_MS) {
        await this.#patch(paths, run.id, (record) => {
          record.status = 'failed'
          record.error = record.error || '等待外部服务恢复超时，本轮已结束。'
          record.blockedBy = null
          record.blockedAt = null
          record.completedAt = this.now()
          record.elapsedMs = elapsed(run.triggeredAt, record.completedAt)
        }).catch(() => {})
        continue
      }
      // 只有自己这一类依赖才探：engine.down 等价于「桥接或引擎不可达」。
      if (!EXTERNAL_DEPENDENCY_CATEGORIES.has(run.blockedBy)) continue
      const probe = await this.ensureLocalBridge?.({ timeoutMs: 5000 }).catch(() => null)
      if (!probe?.ok) continue
      const schedule = data.schedules.find((candidate) => candidate.id === run.scheduleId)
      if (!schedule || schedule.disabledReason) continue
      await this.serial(paths.workspace, async () => {
        const queue = await this.#readQueue(paths)
        if (queue.entries.some((item) => item.runId === run.id && item.status === 'waiting')) return
        const next = enqueue(queue.entries, {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          depth: run.depth,
          trigger: 'resume',
          resumeRunId: run.id,
        }, this.now())
        if (!next) return
        await writeJsonFile(join(paths.root, QUEUE_FILE), { schemaVersion: 1, entries: next })
      }).catch(() => {})
    }
  }

  async #stageAlreadyDone(paths, agent, runId, projectId, step) {    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const run = data.runs.find((item) => item.id === runId)
    const entry = run?.items.find((item) => item.projectId === projectId)?.stages.find((item) => item.step === step)
    if (entry?.status !== 'done' || !entry.refId) return false
    try {
      if (step === 'script') {
        const record = await this.content.scriptGenerationStatus(agent, { id: entry.refId })
        return record.status === 'completed'
      }
      if (step === 'topic') {
        const record = await this.content.topicGenerationStatus(agent, { id: entry.refId })
        return record.status === 'completed'
      }
      if (['voiceover', 'subtitles', 'video'].includes(step)) {
        const runs = await this.media.operations(agent, { projectId })
        const run2 = runs.find((item) => item.id === entry.refId)
        return run2?.status === 'succeeded'
      }
      if (step === 'packaging') {
        const task = await this.publish.task(agent, { taskId: entry.refId })
        return task.status === 'succeeded'
      }
      // `approve` 没有子任务，它只在自己的记录里留痕；`publish` 之后才需要
      // 人工介入，重入一次是幂等的（发布器自己按项目版本去重）。
      if (step === 'approve') return true
      return step === 'publish' ? Boolean(entry.completedAt) : false
    } catch {
      return false
    }
  }

  /** 一次失败尝试的完整留痕：分类、修法、完整错误全文。 */
  async #recordStageFailure(paths, runId, projectId, step, failure, attempt) {
    try {
      const data = await this.serial(paths.workspace, () => this.readFile(paths))
      const run = data.runs.find((item) => item.id === runId)
      const item = run?.items.find((candidate) => candidate.projectId === projectId)
      await this.#appendFailure(paths, {
        runId,
        scheduleId: run?.scheduleId || null,
        scheduleName: data.schedules.find((candidate) => candidate.id === run?.scheduleId)?.name || null,
        projectId,
        itemTitle: item?.title || null,
        step,
        attempt,
        category: failure.category,
        categoryLabel: CATEGORY_LABEL[failure.category] || '',
        signature: failure.signature,
        message: failure.message,
        remedy: failure.remedy,
        remedyTarget: failure.remedyTarget,
        code: failure.code,
      })
    } catch { /* 故障档案是排查辅助，写不进去不该让轮次失败 */ }
  }

  /**
   * 自动修复动作：把本地依赖拉回来。
   *
   * 分两层，因为它们是「负责拉起引擎的上一层」：
   *   ① 桥接（8199）不可达 → 先救桥接。桥接死了 ensureLocalEngine 只会返回
   *      bridge-unreachable，引擎在它之下无从谈起。2026-10-10 18:13 那次真实故障
   *      就是死在这个夹缝里：8199 整个进程没了，这里却反复去拉 8188，三次全废。
   *   ② 桥接活着但引擎（8188/8187）不在 → 拉引擎，这是原来的行为。
   *
   * 退避已经在调用方完成，这里只处理需要外部副作用的修复。任何一步失败都不抛：
   * 真正的判定交给下一次尝试，否则修复动作本身会把重试循环变成一个异常源。
   */
  async #autoRepair(failure, step, signal) {
    if (failure.autoRepair !== 'ensureEngine') return
    const kind = (step === 'packaging' || step === 'publish') ? 'image' : 'tts'
    const report = { bridge: null, engine: null }
    try {
      report.bridge = await this.ensureLocalBridge?.({ signal }) || null
    } catch (error) {
      report.bridge = { ok: false, reason: 'bridge-repair-threw', detail: String(error?.message || error) }
    }
    // 桥接没救回来就别再试引擎了——那注定是 bridge-unreachable，白等一轮。
    if (report.bridge && report.bridge.ok === false) return report
    try {
      report.engine = await this.ensureLocalEngine?.(kind, { reason: failure.category }) || null
    } catch { /* 修复失败不抛：真正的判定交给下一次尝试 */ }
    return report
  }

  /** Explicit dispatch: private methods are not reachable by computed name. */
  #runStep(step, agent, schedule, projectId, signal, paths, runId) {
    if (step === 'script') return this.#stageScript(agent, schedule, projectId, signal, paths, runId)
    if (step === 'approve') return this.#stageApprove(agent, projectId)
    if (step === 'voiceover') return this.#stageVoiceover(agent, schedule, projectId, 'voiceover', signal, paths, runId)
    if (step === 'subtitles') return this.#stageVoiceover(agent, schedule, projectId, 'subtitles', signal, paths, runId)
    if (step === 'video') return this.#stageVideo(agent, schedule, projectId, signal, paths, runId)
    if (step === 'packaging') return this.#stagePackaging(agent, projectId, signal, paths, runId)
    if (step === 'publish') return this.#stagePublish(schedule, projectId, signal, paths, runId)
    throw new Error(`未知的自动化阶段：${step}`)
  }

  /* --------------------------------- stages -------------------------------- */

  async #stageScript(agent, schedule, projectId, signal, paths, runId) {
    // 精确定位：优先续用「这个项目」已登记的写稿任务。refs.scriptGenerationIds
    // 是整轮共用的数组，不按项目分段——所以必须同时匹配项目，不能只取最后一条
    // （否则第二个项目会复用第一个项目的写稿任务，写到别的项目里去）。
    //
    // 历史 4 次「写稿生成记录不存在」就是靠"找最新一条同类记录"定位造成的：
    // 记录有 40 条保留上限，长任务跑到后段时前段记录已被挤出。
    const existing = await this.#stageRefForProject(paths, runId, projectId, 'script')
    if (existing) {
      const record = await this.content.scriptGenerationStatus(agent, { id: existing }).catch(() => null)
      if (record?.status === 'completed') {
        return this.#noteScript(agent, projectId, existing, paths, runId)
      }
    }
    const launched = await this.content.startScriptGeneration(agent, scriptInputOf(schedule, projectId))
    await this.#pushRef(paths, runId, 'scriptGenerationIds', launched.id)
    await this.#setStage(paths, runId, projectId, 'script', { refId: launched.id })
    const record = await this.#poll('script', signal,
      () => this.content.scriptGenerationStatus(agent, { id: launched.id }),
      (item) => !LIVE.has(item.status))
    if (record.status !== 'completed') throw new Error(record.error || '写稿生成未完成。')
    return this.#noteScript(agent, projectId, launched.id, paths, runId)
  }

  async #noteScript(agent, projectId, refId, paths, runId) {
    const detail = await this.projects.get(agent, { projectId })
    const revision = detail.artifacts?.script?.revision || null
    const chars = charsOf(detail.artifacts?.script?.data?.body)
    await this.#patchItem(paths, runId, projectId, (item) => {
      item.scriptChars = chars
      item.scriptRevision = revision
      item.title = detail.title || item.title
    })
    return { refId, message: `${chars} 字稿件已保存为版本 ${revision || '?'}` }
  }

  /**
   * 取「该项目、该阶段」已登记的子任务标识。
   *
   * 读的是 items[].stages 里的 refId，而不是 run.refs 那个扁平数组——后者是整轮
   * 共用的，一轮推三条时无法区分哪条属于哪个项目，按它复用会把一个项目的写稿
   * 任务接到另一个项目上。
   */
  async #stageRefForProject(paths, runId, projectId, step) {
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const run = data.runs.find((item) => item.id === runId)
    const item = run?.items.find((candidate) => candidate.projectId === projectId)
    const stage = item?.stages.find((candidate) => candidate.step === step)
    if (stage?.refId) return stage.refId
    return null
  }

  /**
   * The script-confirmation gate. Crossing it is exactly what the automation
   * depth authorises: the task form states that depths reaching video or
   * packaging confirm the AI script without a human reading it. The recorded
   * approval is revision bound, so a later edit invalidates it just as a human
   * confirmation would.
   */
  async #stageApprove(agent, projectId) {
    const summary = await this.projects.approveScript(agent, { projectId, source: 'automation' })
    return { message: `稿件版本 ${summary.scriptApproval?.revision || '?'} 已由自动化确认` }
  }

  /** The configured voiceover channel; the request normalizer would otherwise pin media runs to bailian. */
  async #mediaProvider() {
    try { return (await this.media.status())?.connection?.provider || 'bailian' } catch { return 'bailian' }
  }

  async #stageVoiceover(agent, schedule, projectId, step, signal, paths, runId) {
    const detail = await this.projects.get(agent, { projectId })
    const voice = schedule.production.voice
    const request = { projectId, expectedRevision: detail.revision }
    if (step === 'subtitles') {
      Object.assign(request, { language: 'zh', aiOptimize: true, provider: await this.#mediaProvider() })
    } else {
      // Follow the configured voiceover channel every round, preset or not:
      // bailian is cloud TTS, scitiger is the local bridge endpoint.
      const preset = { provider: await this.#mediaProvider(), voiceSource: voice?.voiceSource || 'system', rate: voice?.rate ?? 1, volume: voice?.volume ?? 1, pitch: voice?.pitch ?? 0 }
      if (voice?.voiceId) preset.voiceId = voice.voiceId
      if (voice?.voiceName) preset.voiceName = voice.voiceName
      if (voice?.bridge) preset.bridge = voice.bridge
      if (voice?.voiceSource === 'upload' && voice.referenceAudio) {
        preset.referenceAudio = await this.media.stageScheduleVoiceReference(agent, { projectId, reference: voice.referenceAudio })
      }
      Object.assign(request, preset)
    }
    const started = step === 'subtitles'
      ? await this.media.startSubtitles(agent, request)
      : await this.media.startVoiceover(agent, request)
    await this.#pushRef(paths, runId, 'mediaRunIds', started.id)
    await this.#setStage(paths, runId, projectId, step, { refId: started.id })
    // 配音与字幕的耗时随稿件长度增长（云端分段合成，每段一次往返）。固定 10 分钟上限
    // 会把长稿件误判成失败——2026-10-09 实测 2113 字（27 段）实际跑完、音频也落盘了，
    // 却因为刚过 10 分钟被判超时，整轮报废。这里按字数上浮等待上限。
    const scriptChars = charsOf(detail.artifacts?.script?.data?.body)
    const budget = ['voiceover', 'subtitles'].includes(step) ? voiceoverTimeoutMs(scriptChars) : null
    const done = await this.#pollMedia(agent, step, signal, paths, runId, projectId, started.id, budget)
    if (done.status !== 'succeeded') throw new Error(done.error || (step === 'subtitles' ? '字幕生成失败。' : '配音生成失败。'))
    const seconds = done.result?.audio?.durationSeconds
    return {
      refId: started.id,
      message: step === 'subtitles' ? '字幕已按真实音频时间轴生成' : seconds ? `配音 ${Math.round(seconds)} 秒` : '配音已生成',
    }
  }

  /** Render commits video and qc atomically, so this one stage covers both. */
  async #stageVideo(agent, schedule, projectId, signal, paths, runId) {
    const detail = await this.projects.get(agent, { projectId })
    const started = await this.media.startVideoRender(agent, {
      projectId,
      expectedRevision: detail.revision,
      orientation: schedule.production.orientation,
      subtitleEnabled: schedule.production.subtitleEnabled,
      ...(schedule.production.visualBrief ? { visualBrief: schedule.production.visualBrief } : {}),
    })
    await this.#pushRef(paths, runId, 'mediaRunIds', started.id)
    await this.#setStage(paths, runId, projectId, 'video', { refId: started.id })
    // 渲染耗时随镜头数增长。固定 40 分钟对长片不够，而过早上限会把「还在渲染」
    // 误判成失败——#poll 的停滞预算已经解决慢的问题，这里只按工作量上浮上限。
    const sceneHint = detail.artifacts?.script?.data?.body ? charsOf(detail.artifacts.script.data.body) / 90 : 0
    const done = await this.#pollMedia(agent, 'video', signal, paths, runId, projectId, started.id, videoTimeoutMs(Math.round(sceneHint)))
    if (done.status !== 'succeeded') throw new Error(done.error || '视频渲染或质检未通过。')
    const video = done.result?.video || {}
    await this.#patchItem(paths, runId, projectId, (item) => {
      item.durationSeconds = Number.isFinite(video.durationSeconds) ? video.durationSeconds : null
      if (video.width && video.height) item.orientation = video.height > video.width ? 'portrait' : 'landscape'
      item.qcPassed = true
    })
    return {
      refId: started.id,
      message: video.durationSeconds
        ? `成片 ${Math.round(video.durationSeconds)} 秒，技术质检与独立审片均通过`
        : '成片已通过技术质检与独立审片',
    }
  }

  async #stagePackaging(agent, projectId, signal, paths, runId) {
    const detail = await this.projects.get(agent, { projectId })
    const started = await this.publish.startPackaging(agent, { projectId, expectedRevision: detail.revision })
    await this.#pushRef(paths, runId, 'publishTaskIds', started.id)
    await this.#setStage(paths, runId, projectId, 'packaging', { refId: started.id })
    const done = await this.#poll('packaging', signal,
      () => this.publish.task(agent, { taskId: started.id }),
      (task) => !LIVE.has(task.status))
    if (done.status !== 'succeeded') throw new Error(done.error || '发布资料生成失败。')
    // Covers live on the committed artifact, not on the task summary.
    const packaged = await this.projects.get(agent, { projectId })
    const covers = packaged.artifacts?.packaging?.data?.covers || {}
    const errors = packaged.artifacts?.packaging?.data?.coverErrors || {}
    const landscape = Boolean(covers.landscape?.file)
    const portrait = Boolean(covers.portrait?.file)
    const coverState = !done.imageProvider ? 'disabled'
      : landscape && portrait ? 'both'
        : landscape || portrait ? 'partial'
          : 'none'
    await this.#patchItem(paths, runId, projectId, (item) => { item.coverState = coverState })
    const coverNote = coverState === 'disabled' ? '（未配置生图服务，封面需人工上传）'
      : coverState === 'both' ? '，横竖封面已生成'
        : `，封面${coverState === 'partial' ? '单侧' : ''}生成失败：${errors.landscape || errors.portrait || '未知原因'}`
    return { refId: started.id, message: `发布资料已生成${coverNote}` }
  }

  /**
   * Hand the finished cut to the publisher pack. This is the one step that
   * leaves the machine, so the default submit mode stops before the platform's
   * own submit button and the item is recorded as `awaiting` rather than
   * `submitted` — the round is not allowed to claim a publish that a person
   * still has to finish.
   *
   * The first account in the target list wins; a round sends one cut to one
   * account, matching how the manual publish page works. Fanning a single cut
   * out to several accounts is a deliberate product decision, not a default.
   */
  async #stagePublish(schedule, projectId, signal, paths, runId) {
    const target = schedule.publish
    if (!target || !target.accountIds.length) throw new Error('该任务未配置发布账号，无法投递到平台。')
    const publisher = this.#service('publisherHost')
    if (!publisher?.startPublish) throw new Error('未加载「发布与账号管理」能力包，无法投递到平台。')
    const accounts = await publisher.listAccounts()
    const account = target.accountIds
      .map((id) => accounts.find((item) => item.id === id))
      .find((item) => item && item.status === 'active' && item.adapterReady === true)
    if (!account) throw new Error('所选发布账号均不可用（未登录或平台未适配），请重新选择发布目标。')

    // The publisher owns the qc and packaging gates; a failure here is its
    // message, not a second copy of those rules.
    const job = await publisher.startPublish({
      projectId,
      accountId: account.id,
      submitMode: target.submitMode === 'auto' ? 'auto' : 'confirm',
      // Automation has already crossed every other confirmation gate by virtue
      // of the depth; this flag is what makes an unattended auto-submit legal.
      confirmAuto: target.submitMode === 'auto',
      trigger: 'schedule',
    })
    await this.#pushRef(paths, runId, 'publishJobIds', job.id)
    await this.#setStage(paths, runId, projectId, 'publish', { refId: job.id })
    const done = await this.#poll('publish', signal,
      () => publisher.job(job.id),
      (item) => !['queued', 'running'].includes(item.status))

    if (done.status === 'failed' || done.status === 'cancelled') {
      await this.#patchItem(paths, runId, projectId, (item) => {
        item.publishState = 'failed'
        item.publishAccount = account.label
      })
      throw new Error(done.error || '平台投递失败。')
    }
    // `awaiting-confirm` means the cut is uploaded and filled in, waiting for a
    // person to press submit in the browser window.
    const awaiting = done.status === 'awaiting-confirm'
    await this.#patchItem(paths, runId, projectId, (item) => {
      item.publishState = awaiting ? 'awaiting' : 'submitted'
      item.publishAccount = `${account.platformLabel || account.platform}·${account.label}`
      item.publishUrl = done.proof?.remoteUrl || null
    })
    return {
      refId: job.id,
      message: awaiting
        ? `已投递到${account.label}，视频与资料已填好，等待在浏览器窗口确认发布`
        : `已发布到${account.label}`,
    }
  }

  async #pollMedia(agent, step, signal, paths, runId, projectId, mediaRunId, timeoutMs = null) {
    return this.#poll(step, signal, async () => {
      const runs = await this.media.operations(agent, { projectId })
      const run = runs.find((item) => item.id === mediaRunId)
      if (!run) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '媒体任务记录丢失。')
      // Surface the media host's own fine-grained phase, but only write when
      // it actually changes so polling does not thrash schedules.json.
      if (run.phase) {
        const key = `${runId}:${projectId}:${step}`
        if (this.phaseNotes.get(key) !== run.phase) {
          this.phaseNotes.set(key, run.phase)
          await this.#setStage(paths, runId, projectId, step, { message: run.phase }).catch(() => {})
        }
      }
      return run
    }, (run) => !LIVE.has(run.status), timeoutMs)
  }

  /* ------------------------- failure ledger + alerts ------------------------ */

  /**
   * 故障档案与队列各自一个文件，刻意与 schedules.json 分开。
   *
   * schedules.json 是业务真相，任何一处写坏都会让整个内容安排页不可用；而故障档案
   * 只是排查辅助，写坏了最坏情况是丢掉历史，不该有能力拖垮主流程。所以读失败一律
   * 吞掉并回落成空档案。
   */
  async #readLedger(paths, name, fallback) {
    try {
      return await readJsonFile(join(paths.root, name), fallback)
    } catch {
      return fallback()
    }
  }

  async #appendFailure(paths, record) {
    const file = join(paths.root, 'failures.json')
    const fallback = emptyQueueFile
    const data = await this.#readLedger(paths, 'failures.json', fallback)
    const entries = Array.isArray(data.entries) ? data.entries : []
    const row = { id: randomUUID(), at: stamp(), ...record }
    entries.unshift(row)
    await writeJsonFile(file, { schemaVersion: 1, entries: entries.slice(0, FAILURE_LIMIT) })
    return row
  }

  /**
   * 失败聚类：把同类故障按签名折叠，界面上直接回答「上周为什么失败」。
   *
   * 这是「自己能找出原因」的落点——不靠人去翻日志，系统在失败的那一刻就已经
   * 知道原因与修法，这里只负责把它们按同一根因归拢。
   */
  async listFailures(agent, request = {}) {
    const paths = await this.paths(agent)
    const data = await this.#readLedger(paths, 'failures.json', emptyQueueFile)
    const entries = (Array.isArray(data.entries) ? data.entries : [])
      .filter((row) => (request.category ? row.category === request.category : true))
    const clusters = new Map()
    for (const row of entries) {
      const key = row.signature || row.message || '未知'
      const existing = clusters.get(key)
      if (existing) {
        existing.count += 1
        if (String(row.at) > String(existing.lastAt)) existing.lastAt = row.at
        continue
      }
      clusters.set(key, {
        signature: key,
        category: row.category || 'code.defect',
        categoryLabel: CATEGORY_LABEL[row.category] || CATEGORY_LABEL['code.defect'],
        remedy: row.remedy || '',
        remedyTarget: row.remedyTarget || null,
        count: 1,
        lastAt: row.at,
        steps: row.step ? [row.step] : [],
        sample: row.message || '',
      })
    }
    const list = [...clusters.values()].sort((left, right) => right.count - left.count)
    return {
      total: entries.length,
      clusters: list.slice(0, 50),
      recent: entries.slice(0, 50).map((row) => ({ ...row, categoryLabel: CATEGORY_LABEL[row.category] || '' })),
    }
  }

  /**
   * 无人值守告警落盘。前端有 WebAudio 提示音，但浏览器关掉、标签页被节流、
   * 或者人根本不在电脑前时都听不见；这份文件由独立于工作台的 Windows 计划
   * 任务读取并播放系统音，是唯一不依赖浏览器的通道。
   *
   * 写入失败绝不抛：一个通知通道坏了不该让已经成功的轮次变成失败。
   */
  async #alert(paths, { level, title, detail = '' }) {
    const file = join(paths.root, 'alerts.json')
    const fallback = emptyQueueFile
    try {
      const data = await this.#readLedger(paths, 'alerts.json', fallback)
      const entries = Array.isArray(data.entries) ? data.entries : []
      entries.unshift({ id: randomUUID(), level, title, detail, at: stamp(), read: false })
      await writeJsonFile(file, { schemaVersion: 1, entries: entries.slice(0, 50) })
    } catch { /* 通知是尽力而为 */ }
  }

  /* ------------------------------ run record ------------------------------ */

  async #readItems(paths, runId) {
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    return data.runs.find((run) => run.id === runId)?.items || []
  }

  async #patch(paths, runId, mutate) {
    return this.mutate(paths, (data) => {
      const run = data.runs.find((item) => item.id === runId)
      if (!run) return null
      mutate(run)
      return run
    })
  }

  async #patchItem(paths, runId, projectId, mutate) {
    return this.#patch(paths, runId, (run) => {
      const item = run.items.find((candidate) => candidate.projectId === projectId)
      if (item) mutate(item)
    })
  }

  async #setStage(paths, runId, projectId, step, patch) {
    return this.#patch(paths, runId, (run) => {
      run.step = step
      const item = run.items.find((candidate) => candidate.projectId === projectId)
      const stage = item?.stages.find((candidate) => candidate.step === step)
      if (!stage) return
      const { message, ...rest } = patch
      Object.assign(stage, rest)
      if (message) stage.message = String(message).slice(0, 500)
      if (stage.status === 'done' && !stage.completedAt) stage.completedAt = this.now()
    })
  }

  async #pushRef(paths, runId, key, value) {
    if (!value) return
    return this.#patch(paths, runId, (run) => {
      if (!run.refs[key].includes(value)) run.refs[key].push(value)
    })
  }

  async #finish(paths, runId, startedAt, status, step, message, error) {
    const completedAt = this.now()
    return this.#patch(paths, runId, (run) => {
      run.status = status
      if (step) run.step = step
      run.message = message
      run.error = error
      // blocked 不是终态：它是「等得起」。给了 completedAt/elapsedMs，续跑时
      // 这段等待就从审计里消失了，看起来像没等过就成功了；而且 #requeueBlocked
      // 判超时靠的正是 blockedAt，completedAt 在这里只会添乱。
      if (status !== 'blocked') {
        run.completedAt = completedAt
        run.elapsedMs = elapsed(startedAt, completedAt)
      }
      if (status !== 'blocked') {
        run.blockedBy = null
        run.blockedAt = null
      }
      for (const item of run.items) {
        // 挂起时不要把条目判成 failed：它会在列表里显示成红色失败，而实际上
        // 它只是「等得起」，续跑时会被 #requeueBlocked 捡回来接着跑。
        if (status !== 'blocked' && item.status === 'running') item.status = status === 'completed' ? 'completed' : 'failed'
        for (const stage of item.stages) {
          // 挂起时未完成的阶段保持原样（多数已被标 interrupted），标成 skipped
          // 会让续跑以为这些阶段「被判定为不需要」而不是「还没轮到」。
          if (status === 'blocked') continue
          if (stage.status === 'running' || stage.status === 'pending') stage.status = 'skipped'
        }
      }
      for (const key of [...this.phaseNotes.keys()]) {
        if (key.startsWith(`${runId}:`)) this.phaseNotes.delete(key)
      }
    })
  }

  /* -------------------------------- scheduler ------------------------------- */

  async #workspaces() {
    return this.workspacePath ? [this.workspacePath] : []
  }

  /**
   * One tick. Signal collection stays with the content store; this only looks
   * for automation slots.
   *
   * 三件事按顺序发生：
   *
   * 1. **补跑断掉的轮次**（工程包四-B）：主机重启后被标记为 interrupted 的轮次
   *    在这里排队续跑，从中断的阶段接着走，不从头再来。
   * 2. **把到期的任务入队**（工程包九）：同一分钟到期的多个任务全部入队，不再是
   *    「谁先抢到谁跑，另一个被 `.catch(() => {})` 静默吞掉」。
   * 3. **按队列逐个执行**：一次只跑一个。渲染会打满机器，交错执行的失败在审计里
   *    根本没法读——这是原来 `startRun` 直接拒绝第二个任务的原因，现在由队列表达。
   *
   * 轮次是 detached 的，所以一个二十分钟的流水线不会阻塞后续 tick；入队时写下的
   * 时间戳保证同一槽位不会被重复入队。
   */
  async tick() {
    const clock = new Date(this.now())
    const first = this.firstTick
    this.firstTick = false
    for (const workspace of await this.#workspaces()) {
      const paths = await this.pathsForWorkspace(workspace)
      if (!paths) continue
      let data
      try {
        data = await this.serial(workspace, async () => {
          const file = await this.readFile(paths)
          if (first && this.#recordMissed(file, clock)) await writeJsonFile(paths.file, file)
          return file
        })
      } catch {
        continue
      }

      // 1. 续跑中断的轮次（不占新槽位，只是把之前的活接着干完）
      await this.#requeueInterrupted(paths, data).catch(() => {})
      // 1b. 依赖恢复后续跑挂起的轮次。与上面那条的区别是入队前要先探一次依赖，
      // 否则每 30 秒都会把同一轮塞回队列，白白耗尽它的重试次数。
      await this.#requeueBlocked(paths, data).catch(() => {})

      // 2. 到期的任务全部入队
      const due = data.schedules.filter((schedule) => !schedule.disabledReason && scheduleDue(schedule, clock))
      if (due.length) {
        await this.serial(workspace, async () => {
          const current = await this.readFile(paths)
          const queued = await this.#readQueue(paths)
          let entries = queued.entries
          for (const schedule of due) {
            const next = enqueue(entries, {
              scheduleId: schedule.id,
              scheduleName: schedule.name,
              depth: schedule.depth,
              trigger: 'automatic',
              // 槽位身份 = 计划时间 + 当天。同一分钟内多次 tick 只入队一次。
              slotKey: `${schedule.id}@${clock.toISOString().slice(0, 16)}`,
            }, this.now())
            if (next) entries = next
          }
          await writeJsonFile(join(paths.root, QUEUE_FILE), { schemaVersion: 1, entries })
        }).catch(() => {})
      }

      // 3. 从队列里取一个来跑
      await this.#drainQueue(paths).catch(() => {})
    }
  }

  async #readQueue(paths) {
    const data = await readJsonFile(join(paths.root, QUEUE_FILE), emptyQueueFile).catch(() => emptyQueueFile())
    return { schemaVersion: 1, entries: Array.isArray(data?.entries) ? data.entries.map(queueEntry) : [] }
  }

  /**
   * 执行队列中的下一个任务。
   *
   * 同时只允许一轮在跑：`canStartMore` 看的是「队列里 active 的数量 + host 手里
   * 正在跑的轮次数量」。续跑轮次也计入后者，所以断点续跑与新任务不会互相踩。
   */
  async #drainQueue(paths) {
    if (!canStartMore(this.active.size, 1)) return
    let entry = null
    await this.serial(paths.workspace, async () => {
      const queue = await this.#readQueue(paths)
      const next = nextRunnable(queue.entries)
      if (!next) return
      // 入队时就该占位（避免下一个 tick 又取到同一个），执行失败再放回去。
      queue.entries = queue.entries.map((item) => (item.id === next.id
        ? { ...item, status: 'active', startedAt: this.now() }
        : item))
      await writeJsonFile(join(paths.root, QUEUE_FILE), queue)
      entry = next
    })
    if (!entry) return

    // 预检与真正启动都放到 detached 里跑。
    //
    // 2026-10-10 实测踩到：预检要对桥接与引擎做 HTTP 探测（单个探测 4 秒超时），
    // 之前它被 await 在 tick 的同步路径上——于是「tick 必须在 1 秒内返回」这个
    // 约定被打破（实测 3 秒）。更糟的是它拖慢的不只是这一轮，而是**整个调度器**：
    // 30 秒一次的 tick 里只要有一次预检慢，下一个槽位就整体延后。
    //
    // 队列条已经标了 active（上面写过盘），所以即便这里 detached，界面上也立刻
    // 看到「执行中 1 项」，不会以为它没跑。
    void this.background(this.#launchQueued(paths, entry).catch((error) => {
      const message = reasonOf(error)
      return this.#settleQueue(paths, entry.id, 'failed', message)
        .then(() => this.#alert(paths, { level: 'error', title: `${entry.scheduleName || '内容安排'}：任务未能启动`, detail: message }))
    }))
  }

  /**
   * 从队列取到一个条目后的真正启动流程：体检 → 开工。
   *
   * 独立于 tick 是为了让调度器永不被预检的网络探测拖住（见调用处注释）。
   */
  async #launchQueued(paths, entry) {
    try {
      const data = await this.serial(paths.workspace, () => this.readFile(paths))
      const schedule = data.schedules.find((candidate) => candidate.id === entry.scheduleId)
      if (!schedule) throw new Error('内容安排已被删除')
      if (schedule.disabledReason) throw new Error(schedule.disabledReason)

      // 开工前体检：不能修的依赖问题在这里就拦下，不烧掉一整轮
      const report = await runPreflight({
        steps: stepsForRun(schedule.depth, schedule.production.subtitleEnabled),
        mediaStatus: await this.media.status().catch(() => null),
        publishStatus: await this.publish.status().catch(() => null),
        ensureEngine: this.ensureLocalEngine,
        environment: this.environment,
      })
      if (!report.ok) {
        await this.#recordBlocked(paths, schedule, report)
        await this.#settleQueue(paths, entry.id, 'failed', preflightSummary(report))
        return
      }

      const started = await this.startRun(paths, schedule, entry.trigger, {
        queueId: entry.id,
        ...(entry.resumeRunId ? { resumeRunId: entry.resumeRunId } : {}),
      })
      await this.#settleQueue(paths, entry.id, 'done', started.runId)
    } catch (error) {
      // 只有「真的跑不起来」才记失败；启动成功后的失败由 #execute 负责。
      const message = reasonOf(error)
      const failure = classifyFailure({ error })
      await this.#settleQueue(paths, entry.id, 'failed', message)
      await this.#appendFailure(paths, {
        scheduleId: entry.scheduleId,
        scheduleName: entry.scheduleName,
        step: null,
        attempt: 1,
        category: failure.category,
        categoryLabel: CATEGORY_LABEL[failure.category] || '',
        signature: failure.signature,
        message: String(error?.message || error),
        remedy: failure.remedy,
        remedyTarget: failure.remedyTarget,
      }).catch(() => {})
      await this.#alert(paths, { level: 'error', title: `${entry.scheduleName || '内容安排'}：任务未能启动`, detail: message })
    }
  }

  async #settleQueue(paths, queueId, status, detail = null) {
    await this.serial(paths.workspace, async () => {
      const queue = await this.#readQueue(paths)
      queue.entries = queue.entries.map((item) => (item.id === queueId
        ? { ...item, status, finishedAt: this.now(), result: detail }
        : item))
      await writeJsonFile(join(paths.root, QUEUE_FILE), queue)
    }).catch(() => {})
  }

  /**
   * 体检未通过时不进入 running，而是记一条 blocked。理由很直接：一条 running
   * 记录会占住工作区的执行位，让人以为「正在跑」，而实际上第一秒就该失败。
   */
  async #recordBlocked(paths, schedule, report) {
    const at = this.now()
    const record = {
      id: randomUUID(),
      scheduleId: schedule.id,
      status: 'blocked',
      trigger: 'automatic',
      triggeredAt: at,
      completedAt: at,
      elapsedMs: 0,
      sessionId: null,
      depth: schedule.depth,
      step: null,
      message: `开工前体检未通过（${report.blockers.length} 项）：${report.blockers.map((item) => item.label).join('、')}`,
      error: preflightSummary(report),
      remedy: report.blockers[0]?.remedy || null,
      failureCategory: 'preflight.blocked',
      resumeCount: 0,
      refs: { topicGenerationId: null, scriptGenerationIds: [], mediaRunIds: [], publishTaskIds: [], publishJobIds: [] },
      items: [],
      preflight: report.checks,
    }
    await this.mutate(paths, (data) => {
      const item = data.schedules.find((candidate) => candidate.id === schedule.id)
      if (item) { item.lastRunAt = at; item.updatedAt = at }
      data.runs.unshift(record)
    })
    await this.#alert(paths, { level: 'error', title: `${schedule.name}：开工前体检未通过，未启动`, detail: preflightSummary(report) })
  }

  /**
   * 重启后把中断的轮次重新排上队。
   *
   * recoverInterrupted 负责把 running 改成 interrupted，这里负责让它们真的
   * 继续跑完。已经成功或已经失败的条目跳过——续跑只补没做完的活。
   */
  async #requeueInterrupted(paths, data) {
    const pending = data.runs.filter((run) => run.status === 'interrupted' && (run.resumeCount ?? 0) < MAX_RESUMES)
    for (const run of pending) {
      const schedule = data.schedules.find((candidate) => candidate.id === run.scheduleId)
      if (!schedule || schedule.disabledReason) continue
      await this.serial(paths.workspace, async () => {
        const queue = await this.#readQueue(paths)
        if (queue.entries.some((item) => item.runId === run.id && item.status === 'waiting')) return
        const next = enqueue(queue.entries, {
          scheduleId: run.scheduleId,
          scheduleName: schedule.name,
          depth: run.depth,
          trigger: 'resume',
          resumeRunId: run.id,
        }, this.now())
        if (!next) return
        await writeJsonFile(join(paths.root, QUEUE_FILE), { schemaVersion: 1, entries: next })
      }).catch(() => {})
    }
  }

  /** 队列视图：等待中的按执行顺序给位次，界面直接展示。 */
  async queueView(agent) {
    const paths = await this.paths(agent)
    const queue = await this.#readQueue(paths)
    const entries = queue.entries
    return {
      active: this.active.size,
      waiting: waitingWithPosition(entries),
      recent: entries
        .filter((entry) => entry.status === 'done' || entry.status === 'failed')
        .slice(0, 20),
    }
  }

  /**
   * 手动续跑一条中断的轮次。
   *
   * 调度器本来就会自动把中断轮次排上队，这个入口是给「我知道了，现在就跑」
   * 的人准备的——比如他刚把失效的 API Key 换好，不想再等下一个 30 秒 tick。
   */
  async resumeRun(agent, request) {
    const runId = String(request?.runId || '').trim()
    if (!runId) invalid('执行记录标识不能为空。')
    const paths = await this.paths(agent)
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const run = data.runs.find((item) => item.id === runId)
    if (!run) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '执行记录不存在。')
    if (run.status !== 'interrupted') fail('SPOKEN_VIDEO_SCHEDULE_BUSY', '只有被中断的轮次可以续跑。')
    if ((run.resumeCount ?? 0) >= MAX_RESUMES) fail('SPOKEN_VIDEO_SCHEDULE_BUSY', `该轮已续跑 ${MAX_RESUMES} 次仍未完成，请手动重新执行。`)
    const schedule = data.schedules.find((item) => item.id === run.scheduleId)
    if (!schedule) fail('SPOKEN_VIDEO_SCHEDULE_NOT_FOUND', '对应的内容安排已被删除。')
    if (schedule.disabledReason) fail('SPOKEN_VIDEO_SCHEDULE_DISABLED', schedule.disabledReason)
    if ([...this.active.values()].some((item) => item.workspace === paths.workspace)) {
      fail('SPOKEN_VIDEO_SCHEDULE_BUSY', '本工作区已有一轮自动化在执行，请等待其结束。')
    }
    // 直接开跑而不是入队：人已经明确要求现在执行，且 busy 检查已保证不会撞车。
    const started = await this.startRun(paths, schedule, 'resume', { resumeRunId: runId })
    return { runId: started.runId, resumed: true }
  }

  /**
   * 体检报告（只读，不修复）。给任务表单用：保存之前就告诉用户「按现在的配置，
   * 这个任务跑起来会卡在哪一步」，而不是等到半夜三点。
   */
  async preflightReport(agent, request = {}) {
    const paths = await this.paths(agent)
    const data = await this.serial(paths.workspace, () => this.readFile(paths))
    const schedule = request.scheduleId
      ? data.schedules.find((item) => item.id === request.scheduleId)
      : null
    const depth = request.depth || schedule?.depth || 'packaging'
    const report = await runPreflight({
      steps: stepsForRun(depth, schedule?.production?.subtitleEnabled !== false),
      mediaStatus: await this.media.status().catch(() => null),
      publishStatus: await this.publish.status().catch(() => null),
      // 只读报告不主动拉引擎：180 秒的等待不该发生在「打开表单」这种场合。
      ensureEngine: async () => ({ ok: false, detail: '体检报告模式不自动拉起引擎' }),
      environment: this.environment,
    })
    return { ...report, summary: preflightSummary(report) }
  }

  /**
   * Content is time sensitive, so a slot that passed while the host was down
   * is logged for the operator and never backfilled. Checked once per process
   * start; polling it every tick would spam records.
   *
   * Mutates `data` in place and reports whether anything changed. It must run
   * inside the caller's serial block: `mutate()` re-enters `serial()`, which is
   * not reentrant, so nesting it here would deadlock the scheduler.
   */
  #recordMissed(data, clock) {
    let changed = false
    for (const schedule of data.schedules) {
      if (!missedSlot(schedule, clock)) continue
      const at = this.now()
      data.runs.unshift({
        id: randomUUID(),
        scheduleId: schedule.id,
        status: 'missed',
        trigger: 'automatic',
        triggeredAt: at,
        completedAt: at,
        elapsedMs: 0,
        sessionId: null,
        depth: schedule.depth,
        step: null,
        message: `主机在 ${schedule.time} 未运行，已跳过本次执行；内容有时效性，不会自动补跑。需要时可在任务卡上「立即执行」。`,
        error: null,
        refs: { topicGenerationId: null, scriptGenerationIds: [], mediaRunIds: [], publishTaskIds: [] },
        items: [],
      })
      changed = true
    }
    return changed
  }

  /**
   * A restart drops every in-flight round along with its execution agent. Rather
   * than marking them failed — which threw away up to 40 minutes of finished
   * work — they become `interrupted` and keep every artifact, ref and stage
   * trail they had. `tick` then re-queues them and `startRun` continues from the
   * stage each item actually reached, after re-checking each stage's child task
   * (see #stageAlreadyDone) so nothing is assumed finished that isn't.
   *
   * `resumeCount` bounds the loop: a round that keeps getting interrupted is
   * stopped for good rather than retrying forever across unattended restarts.
   */
  async recoverInterrupted() {
    for (const workspace of await this.#workspaces()) {
      const paths = await this.pathsForWorkspace(workspace)
      if (!paths) continue
      await this.serial(workspace, async () => {
        const data = await this.readFile(paths)
        let changed = false
        for (const run of data.runs) {
          if (run.status !== 'running') continue
          const steps = run.depth ? stepsForRun(run.depth, true) : []
          run.status = 'interrupted'
          run.error = '主机在流水线完成前已重启。已完成的阶段产物保留，本轮将从中断处自动续跑。'
          run.message = '主机重启，本轮将在引擎就绪后自动续跑。'
          run.interruptedAt = this.now()
          run.completedAt = null
          run.elapsedMs = null
          for (const item of run.items) {
            if (item.status === 'completed') continue
            if (item.status === 'failed' || item.status === 'cancelled') continue
            item.status = 'interrupted'
            item.error = null
            item.resumeFrom = item.resumeFrom || nextStepOf(steps, item.reachedStep)
            // 未完成的阶段回退成 pending，续跑时才会被重新排上；done 的原样保留。
            for (const stage of item.stages) {
              if (stage.status === 'done') continue
              stage.status = 'pending'
              stage.completedAt = null
              stage.message = null
            }
          }
          changed = true
        }
        if (changed) await writeJsonFile(paths.file, data)
      }).catch(() => {})
    }
  }

  /**
   * Cancel every in-flight round. Used on pack unload so a detached round and
   * its execution identity cannot outlive the host that started it; each round
   * then settles as `cancelled` and disposes its agent in #execute's finally.
   */
  stopAll(reason = '内容安排模块已卸载，本轮自动化停止。') {
    for (const entry of this.active.values()) entry.controller.abort(new Error(reason))
  }

  startScheduler() {
    const tick = () => { void this.background(this.tick().catch(() => {})) }
    void this.background(this.recoverInterrupted().catch(() => {}))
    tick()
    const timer = setInterval(tick, this.tickIntervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      this.stopAll()
    }
  }
}
