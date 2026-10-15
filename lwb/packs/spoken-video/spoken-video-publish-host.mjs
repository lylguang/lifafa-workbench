import { executionEvent, executionTransition } from './spoken-video-execution.mjs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spokenVideoDataPath } from './spoken-video-paths.mjs'
import {
  buildPublishPrompt,
  extractPublishImageUrl,
  imageTaskId,
  imageTaskState,
  inspectPublishImage,
  normalizePublishResult,
  parseCustomImageConfig,
  customImageDefaults,
  CUSTOM_IMAGE_PRESET,
  customOpenAiImageRequest,
  customOpenAiImageUrl,
  coverImagePrompt,
  PUBLISH_IMAGE_PROVIDERS,
  PUBLISH_PACKAGE_SCHEMA,
  publishImageConfig,
  publishImageCredentialRef,
  publishImageRequest,
  SpokenVideoPublishError,
} from './spoken-video-publish.mjs'

/** 渠道的人话名，错误提示与界面共用一份，避免两处各写一遍。 */
const PROVIDER_LABEL = Object.freeze({
  bailian: '百炼 BYOK',
  scitiger: 'SciTiger 云端',
  custom: '自定义云端生图',
})
import { appendDshTrace, dshChildStarted, dshTrace, ensureDshTrace, projectDshSessionEvent } from './spoken-video-dsh-trace.mjs'
import { inspectCoverTitleZone } from './spoken-video-cover-text.mjs'

const PROJECT_ID = /^[a-f0-9-]{36}$/iu
const TASKS_FILE = 'publish-tasks.json'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_ASSET_BYTES = 80 * 1024 * 1024
const execFileAsync = promisify(execFile)

function fail(code, message) { throw new SpokenVideoPublishError(code, message) }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', `${label}必须是对象。`)
  return value
}
function text(value, label, maximum) {
  if (typeof value !== 'string') fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', `${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > maximum) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return result
}
function projectId(value) {
  const result = text(value, '项目标识', 36).toLowerCase()
  if (!PROJECT_ID.test(result)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '项目标识无效。')
  return result
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '项目版本无效。')
  return value
}
function base64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '封面内容不是有效 Base64。')
  }
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) {
    fail(bytes.length > MAX_IMAGE_BYTES ? 'SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE' : 'SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', bytes.length > MAX_IMAGE_BYTES ? '封面不能超过 20 MiB。' : '封面内容不是规范 Base64。')
  }
  return bytes
}
function pathInside(root, target) {
  const value = relative(root, target)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
async function workspaceFor(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '发布任务需要已加载的能力包专属工作区。')
  try {
    const workspace = await realpath(cwd)
    const info = await lstat(workspace)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid')
    return workspace
  } catch { fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '能力包专属工作区不可用，请重新加载能力包后重试。') }
}
async function publishRootFor(agent) {
  const workspace = await workspaceFor(agent)
  const root = spokenVideoDataPath(workspace)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布任务目录无效。')
  return realpath(root)
}
async function projectRootFor(agent, id) {
  const root = join(await publishRootFor(agent), 'projects', id)
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_NOT_FOUND', '口播项目不存在。')
  return realpath(root)
}
async function safeTarget(root, file, createParent = false) {
  if (!/^media\/(?:publish-covers|videos)\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(file)) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体路径无效。')
  const target = resolve(root, file)
  if (!pathInside(root, target)) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体路径越界。')
  if (createParent) await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const parent = await realpath(dirname(target))
  if (!pathInside(root, parent)) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体目录越界。')
  const existing = await lstat(target).catch(() => null)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体文件无效。')
  return target
}
async function readTasks(root) {
  const file = join(root, TASKS_FILE)
  const info = await lstat(file).catch(() => null)
  if (!info) return { schemaVersion: 1, tasks: [] }
  if (!info.isFile() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布任务文件无效。')
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    return { schemaVersion: 1, tasks: Array.isArray(value?.tasks) ? value.tasks.slice(0, 240) : [] }
  } catch { fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布任务文件不是有效 JSON。') }
}
async function writeTasks(root, data) {
  const target = join(root, TASKS_FILE)
  const temporary = join(root, `.${randomUUID()}.publish.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, tasks: data.tasks.slice(0, 240) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    // Windows：rename 的目标只要被任意句柄打开就会 EPERM（界面轮询会撞上写入窗口）；
    // 退避重试吸收，真故障仍抛出。失败时清掉临时文件，不在数据目录留下整份副本。
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break }
      catch (error) {
        if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= 6) throw error
        await new Promise((resolve) => setTimeout(resolve, [50, 120, 280, 600, 1200, 2400, 4000][attempt]))
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
function contentInput(value) {
  const input = object(value, '发布内容')
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((tag) => text(tag, '发布标签', 30).replace(/^#/u, '')))].slice(0, 10) : []
  if (!tags.length) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '至少需要一个发布标签。')
  return { title: text(input.title, '发布标题', 80), copy: text(input.copy, '视频文案', 2000), description: text(input.description, '视频描述', 1000), tags }
}
function promptsInput(value, current) {
  if (value === undefined || value === null) return current
  const input = object(value, '封面提示词')
  return {
    landscape: text(input.landscape ?? current.landscape, '横屏封面提示词', 3000),
    portrait: text(input.portrait ?? current.portrait, '竖屏封面提示词', 3000),
    negative: typeof input.negative === 'string' ? input.negative.slice(0, 1000) : (current.negative || ''),
  }
}
function taskSummary(task) {
  return { id: task.id, projectId: task.projectId, projectTitle: task.projectTitle, account: task.account || null, status: task.status, phase: task.phase || null, coverKind: task.coverKind || null, error: task.error || null, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt || null, imageProvider: task.imageProvider || null, coverErrors: task.coverErrors || {}, dsh: task.dsh || dshTrace() }
}
function boundedUrl(value, label) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}返回的地址无效。`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}返回的地址无效。`)
  return url
}

export class SpokenVideoPublishHost {
  constructor({ background = (work) => work, projectsStore, credentials, connectionSettings, packageExecutor, fetch = globalThis.fetch, environment = process.env, pollIntervalMs = 1500, maxPollMs = 15 * 60 * 1000 } = {}) {
    if (!projectsStore) throw new Error('SpokenVideoPublishHost requires projectsStore.')
    this.background = background
    this.projectsStore = projectsStore
    this.credentials = credentials || null
    this.connectionSettings = connectionSettings || null
    this.packageExecutor = typeof packageExecutor === 'function' ? packageExecutor : null
    this.fetch = fetch
    this.environment = environment
    this.pollIntervalMs = pollIntervalMs
    this.maxPollMs = maxPollMs
    this.writes = new Map()
    this.thumbnails = new Map()
    this.thumbnailWorkers = [Promise.resolve(), Promise.resolve()]
    this.thumbnailWorkerIndex = 0
    this.active = new Set()
  }

  async #serial(root, callback) {
    const previous = this.writes.get(root) || Promise.resolve()
    const result = previous.then(callback)
    const tail = result.catch(() => {})
    this.writes.set(root, tail)
    try { return await result } finally { if (this.writes.get(root) === tail) this.writes.delete(root) }
  }

  #credentials() {
    if (!this.credentials?.resolve) fail('SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE', '当前环境不提供私有凭据服务。')
    return this.credentials
  }

  async #credentialStatus(provider) {
    if (!this.credentials?.describe) return { configured: false, source: null, writable: false }
    const status = await this.credentials.describe(publishImageCredentialRef(provider))
    return { configured: status?.configured === true, source: status?.source || null, writable: status?.writable === true }
  }

  async status() {
    const settings = this.connectionSettings?.get?.() || {}
    const provider = PUBLISH_IMAGE_PROVIDERS.includes(settings.provider) ? settings.provider : 'bailian'
    const providers = {
      bailian: { label: PROVIDER_LABEL.bailian, credential: await this.#credentialStatus('bailian') },
      scitiger: { label: PROVIDER_LABEL.scitiger, credential: await this.#credentialStatus('scitiger') },
      // 自定义渠道的「可用」不看密钥：自建服务可能完全不校验，密钥留空也能用。
      custom: { label: PROVIDER_LABEL.custom, credential: await this.#credentialStatus('custom'), custom: true },
    }
    // 自定义渠道的地址要**连默认值一起算**：customImageDefaults 里本来就带一份
    // 可用的预设（baseUrl / protocol / path），从没打开过「自定义生图」表单的用户
    // 也就没保存过 customImage——此时只看 settings.customImage 会一律判成「缺少
    // 服务地址」，尽管默认地址一直都在、Key 也存着（2026-10-12 用户报这个错，
    // 而同一条视频的封面此前用同一个 custom 渠道成功生成过，说明地址当时可用、
    // 只是判断口径与实际可用性脱节）。
    const defaults = customImageDefaults(this.environment)
    const effectiveCustom = settings.customImage?.baseUrl ? settings.customImage : defaults
    const configured = provider === 'custom'
      ? Boolean(effectiveCustom?.baseUrl)
      : providers[provider].credential.configured === true
    return {
      // `enabled` remains as a compatibility alias for existing consumers. A
      // saved credential is now the single source of truth for availability.
      enabled: configured,
      configured,
      provider,
      model: typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : publishImageConfig(this.environment).model,
      providers,
      // 界面用它预填自定义表单；没配过时给一份能直接改的默认值，而不是空表单。
      customDefaults: defaults,
      // 把预设的展示信息一并给前端：填 Key 前用户就该知道这是哪家服务、怎么用。
      customPreset: { ...CUSTOM_IMAGE_PRESET },
      // 回传**生效中**的那份配置（保存值优先、否则默认值），让前端显示的地址与
      // 实际发请求用的地址一致——否则界面显示「未配置」、实际却能跑。
      custom: settings.customImage || null,
      customEffective: effectiveCustom,
      imageMaxBytes: MAX_IMAGE_BYTES,
    }
  }

  async configureConnection(request) {
    const input = object(request, '生图配置')
    const provider = text(input.provider || 'bailian', '生图渠道', 40).toLowerCase()
    if (!PUBLISH_IMAGE_PROVIDERS.includes(provider)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '生图渠道无效。')
    const ref = publishImageCredentialRef(provider)
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? text(input.apiKey, 'API Key', 512) : null
    if (!this.connectionSettings?.update) fail('SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE', '当前环境不支持保存生图设置。')
    if (apiKey) await this.#credentials().set(ref, apiKey)
    const patch = { provider, model: text(input.model || publishImageConfig(this.environment).model, '生图模型', 120) }
    // 自定义渠道必须带一个能用的地址，否则「已配置」是假的。地址取值顺序：
    // 表单填的 → 已保存的 → 预设默认值。**默认值这一级不能省**：只想换个 Key 的
    // 用户不会去填地址，缺了它就会在保存时报「自定义生图地址无效」——
    // 而默认地址本来就是可用的（2026-10-12 用户只填了 Key 就撞上这个）。
    if (provider === 'custom') {
      const saved = this.connectionSettings.get?.()?.customImage
      const defaults = customImageDefaults(this.environment)
      patch.customImage = parseCustomImageConfig({
        baseUrl: input.custom?.baseUrl ?? input.baseUrl ?? saved?.baseUrl ?? defaults?.baseUrl,
        protocol: input.custom?.protocol ?? saved?.protocol ?? defaults?.protocol,
        path: input.custom?.path ?? saved?.path,
        model: patch.model,
        authHeader: input.custom?.authHeader ?? saved?.authHeader,
      })
    }
    await this.connectionSettings.update(patch)
    return this.status()
  }

  async clearConnectionCredential(request) {
    const provider = text(object(request, '生图配置').provider, '生图渠道', 40).toLowerCase()
    await this.#credentials().unset(publishImageCredentialRef(provider))
    return this.status()
  }

  /**
   * The publish page is a flat video shelf grouped by account: every project
   * whose technical qc passed shows up, whether or not publish info exists yet.
   */
  async listItems(agent, request = {}) {
    const input = object(request, '发布列表请求')
    const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? projectId(input.accountId) : null
    const generalOnly = input.general === true
    const root = await publishRootFor(agent)
    const tasks = await this.#recoverInterrupted(root)
    const latest = new Map()
    for (const task of [...tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) if (!latest.has(task.projectId)) latest.set(task.projectId, task)
    const projects = await this.projectsStore.list(agent)
    const eligible = projects.filter((project) => project.completedStages.includes('qc'))
      .filter((project) => !accountId || project.account?.id === accountId)
      .filter((project) => !generalOnly || !project.account)
    const items = []
    for (const project of eligible) {
      const task = latest.get(project.id) || null
      const detail = await this.projectsStore.get(agent, { projectId: project.id })
      // Decision C: the shelf only shows QC-passed final cuts; failed or
      // missing QC keeps the project on the video workbench instead.
      if (detail.artifacts?.qc?.data?.passed !== true) continue
      items.push({
        ...project,
        task: task ? taskSummary(task) : null,
        packaging: detail.artifacts?.packaging?.data || null,
        video: detail.artifacts?.video?.data?.video || null,
        orientation: detail.artifacts?.video?.data?.orientation || null,
        qcPassed: true,
      })
    }
    return { items: items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), total: items.length }
  }

  async startPackaging(agent, request) {
    const input = object(request, '发布包装任务请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const detail = await this.projectsStore.get(agent, { projectId: id })
    if (detail.revision !== expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，请刷新后重试。')
    if (detail.artifacts?.qc?.data?.passed !== true) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '只有质检通过的成片才能加入发布工作队列。')
    const root = await publishRootFor(agent)
    const settings = await this.status()
    // 只要文案标签、不生成封面。封面要跑两次生图（各几十秒），而 16G 卡上封面生图与
    // LongCat 不能同时驻留——渲染刚结束、显存还被 TTS 模型占着时自动生封面大概率失败，
    // 留下一堆「封面待补」。文案标签是跑完就该有的必需品，封面留给用户在发布页手动补。
    const skipCovers = input.skipCovers === true
    const task = {
      id: randomUUID(), projectId: id, projectTitle: detail.title, account: detail.account || null,
      status: 'queued', phase: 'agent', error: null, expectedRevision, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      sourceSnapshot: { script: detail.artifacts?.script?.data, topic: detail.artifacts?.topic?.data, video: detail.artifacts?.video?.data },
      // 自定义渠道的地址/协议要随任务一起冻结：用户中途改了配置，不该让已在跑的
      // 这一轮中途换服务。冻结的是**生效中**的那份（保存值优先、否则用预设默认值）
      // ——status().custom 若只回 settings.customImage，从没保存过配置的用户会
      // 冻结一个空地址进去，跑到生图那步才报「缺少服务地址」（2026-10-12 实踩）。
      imageProvider: skipCovers ? null : (settings.configured ? { provider: settings.provider, model: settings.model, ...(settings.provider === 'custom' ? { custom: settings.customEffective || settings.custom } : {}) } : null),
      skipCovers: skipCovers || undefined,
      coverErrors: {},
      dsh: dshTrace(),
    }
    await this.#serial(root, async () => { const data = await readTasks(root); data.tasks.unshift(task); await writeTasks(root, data) })
    this.active.add(task.id)
    void this.background(this.#run(agent, root, task.id).finally(() => this.active.delete(task.id)))
    return taskSummary(task)
  }

  /**
   * 成片通过质检后自动补一份发布文案（不含封面）。
   *
   * 为什么要有这个：发布资料原先只在用户点开发布页抽屉时才生成（client.js 里的
   * autoTriggered effect），于是「视频跑完 → 打开发布页 → 显示未生成」成了常态，
   * 用户第一反应是白跑了（2026-10-08 反馈：刚跑完的成片在发布页找不到）。
   *
   * 只做文案标签：封面吃显存，且渲染刚结束时容易抢不到（见 startPackaging 的
   * skipCovers 说明）。已有 packaging、已在跑、没过质检的一律跳过，避免重复消耗。
   */
  async autoStartPackaging(agent, request) {
    const input = object(request, '自动发布资料请求')
    const id = projectId(input.projectId)
    const detail = await this.projectsStore.get(agent, { projectId: id })
    if (detail.artifacts?.packaging) return { skipped: 'already-packaged' }
    if (detail.artifacts?.qc?.data?.passed !== true) return { skipped: 'qc-not-passed' }
    // 版本号是提交的前提；拿不到就等下一轮，不在这里跟人抢项目。
    if (!Number.isSafeInteger(detail.revision) || detail.revision < 1) return { skipped: 'no-revision' }
    const root = await publishRootFor(agent)
    const tasks = await this.#recoverInterrupted(root)
    if (tasks.some((task) => task.projectId === id && ['queued', 'running'].includes(task.status))) return { skipped: 'already-running' }
    const task = await this.startPackaging(agent, { projectId: id, expectedRevision: detail.revision, skipCovers: true })
    return { started: task.id }
  }

  async task(agent, request) {
    const id = text(object(request, '发布任务请求').taskId, '发布任务标识', 64)
    const tasks = await this.#recoverInterrupted(await publishRootFor(agent))
    const task = tasks.find((item) => item.id === id)
    if (!task) fail('SPOKEN_VIDEO_NOT_FOUND', '发布任务不存在。')
    return taskSummary(task)
  }

  /**
   * Recover tasks left in a live state by a previous process. A restart drops
   * every in-flight agent run and cover poll, so they can never resume; mark
   * them failed once and let the user retry rather than showing a stuck task.
   */
  async #recoverInterrupted(root) {
    const data = await readTasks(root)
    let changed = false
    const now = new Date().toISOString()
    for (const task of data.tasks) {
      if (['queued', 'running'].includes(task.status) && !this.active.has(task.id)) {
        task.status = 'failed'; task.phase = 'failed'; task.error = '应用重启中断了发布包装任务，请重试。'; task.updatedAt = now; task.completedAt = now; changed = true
      }
    }
    if (changed) await this.#serial(root, () => writeTasks(root, data))
    return data.tasks
  }

  async #mutateTask(root, id, mutate) {
    return this.#serial(root, async () => {
      const data = await readTasks(root)
      const task = data.tasks.find((item) => item.id === id)
      if (!task) fail('SPOKEN_VIDEO_NOT_FOUND', '发布任务不存在。')
      const before = structuredClone(task)
      await mutate(task)
      executionTransition(before, task, task.coverKind ? '封面生图服务' : '发布资料处理')
      task.updatedAt = new Date().toISOString()
      await writeTasks(root, data)
      return task
    })
  }

  /** DSH trace lands in the task file through the same serial write seam, so
   *  the publish page can show the packaging agent's live progress. */
  async #recordTaskDshStarted(root, taskId, run) {
    const childSessionId = typeof run?.childSessionId === 'string' ? run.childSessionId : null
    if (!childSessionId) return null
    return this.#mutateTask(root, taskId, (task) => {
      const trace = ensureDshTrace(task)
      trace.childSessionId = childSessionId
      trace.parentSessionId = typeof run.parentSessionId === 'string' ? run.parentSessionId : null
      appendDshTrace(trace, dshChildStarted(new Date().toISOString()))
    })
  }

  async #recordTaskDshEvent(root, taskId, event) {
    const projected = projectDshSessionEvent(event, new Date().toISOString())
    if (!projected) return null
    return this.#mutateTask(root, taskId, (task) => {
      appendDshTrace(ensureDshTrace(task), projected)
    })
  }

  async #run(agent, root, taskId) {
    let task
    try {
      task = await this.#mutateTask(root, taskId, (item) => { item.status = 'running'; item.phase = 'agent' })
      if (!this.packageExecutor) fail('SPOKEN_VIDEO_PUBLISH_AGENT_UNAVAILABLE', '当前环境不提供发布包装 Agent。')
      const detail = await this.projectsStore.get(agent, { projectId: task.projectId })
      if (detail.revision !== task.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，旧版本发布任务已取消。')
      const generated = normalizePublishResult(await this.packageExecutor({
        prompt: buildPublishPrompt({ project: detail }),
        schema: PUBLISH_PACKAGE_SCHEMA,
        agent,
        onDshStarted: (run) => this.#recordTaskDshStarted(root, taskId, run),
        onDshEvent: (event) => this.#recordTaskDshEvent(root, taskId, event),
      }))
      // 用户手改过的提示词要保住。
      //
      // 固定句式只在「从没被人工编辑过」时套用——否则「重新生成发布信息」会把
      // 用户在发布页手写的提示词悄悄换掉，而他完全不知情（2026-10-10 实测踩到：
      // 手改的横屏提示词被固定句式覆盖）。
      //
      // 判据是与**本轮生成的固定句式**不同。不能拿上一轮的句式去比：上一轮存的
      // 正是那个句式，拿它比会得出「没手改」的相反结论（第一版就是这么写错的，
      // 判据恒为假，手改内容照被覆盖）。
      const previous = detail.artifacts?.packaging?.data?.prompts || {}
      const fixed = coverImagePrompt(generated.coverTitle)
      const prompts = { ...generated.prompts }
      for (const kind of ['landscape', 'portrait']) {
        if (previous[kind] && previous[kind] !== fixed) prompts[kind] = previous[kind]
      }
      const result = { ...generated, prompts }

      await this.#mutateTask(root, taskId, (item) => { item.result = result; executionEvent(item, '发布文案与封面提示词已生成', { actor: 'DSH' }) })
      const covers = { landscape: null, portrait: null }
      const coverErrors = { landscape: null, portrait: null }
      if (task.imageProvider) {
        await this.#mutateTask(root, taskId, (item) => { item.phase = 'covers' })
        await Promise.all(['landscape', 'portrait'].map(async (kind) => {
          try {
            covers[kind] = await this.#generateCover(agent, task, kind, result.prompts[kind], result.prompts.negative)
            await this.#mutateTask(root, taskId, (item) => { item.result = { ...generated, covers: { ...(item.result?.covers || {}), [kind]: covers[kind] } }; executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面已生成`, { actor: '封面生图服务', detail: covers[kind] }) })
          }
          catch (error) { coverErrors[kind] = error instanceof Error ? error.message : String(error); await this.#mutateTask(root, taskId, (item) => { executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面生成失败`, { actor: '封面生图服务', status: 'error', detail: coverErrors[kind] }) }) }
        }))
      }
      const current = await this.projectsStore.get(agent, { projectId: task.projectId })
      if (current.revision !== task.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，旧版本发布任务已取消。')
      const committed = await this.projectsStore.commitProduced(agent, {
        projectId: task.projectId, expectedRevision: task.expectedRevision, stage: 'packaging', idempotencyKey: `publish-${task.id}`, source: 'spoken-video/publish-agent',
        payload: { mode: 'agent', taskId: task.id, ...result, covers, imageProvider: task.imageProvider, coverErrors, generatedAt: new Date().toISOString() },
      })
      await this.#mutateTask(root, taskId, (item) => { item.status = 'succeeded'; item.phase = 'ready'; item.completedAt = new Date().toISOString(); item.coverErrors = coverErrors; item.result = { ...result, covers, coverErrors }; item.resultRevision = committed.project.revision })
    } catch (error) {
      await this.#mutateTask(root, taskId, (item) => { item.status = 'failed'; item.phase = 'failed'; item.error = error instanceof Error ? error.message : String(error); item.completedAt = new Date().toISOString() }).catch(() => {})
    }
  }

  async #json(url, init, label) {
    let response
    try { response = await this.fetch(url, init) } catch (error) { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_UNREACHABLE', `${label}不可访问：${error instanceof Error ? error.message : String(error)}`) }
    let body
    try { body = await response.json() } catch { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}返回了无效 JSON。`) }
    if (!response.ok) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}失败：${body?.message || body?.error?.message || `HTTP ${response.status}`}`)
    return body
  }

  /**
   * 按当前渠道生成一张封面。
   *
   * 三条渠道共用同一条「提交 →（异步时）轮询 → 下载 → 校验」的流水线，只有请求
   * 构造、认证头和地址解析三处不同——把它们做成三份拷贝正是日后改一处漏两处的
   * 起点。自定义渠道走 OpenAI 兼容或通用异步协议，字段差异都收敛在
   * buildCustomCoverRequest 这一个函数里。
   */
  async #generateCover(agent, task, kind, prompt, negativePrompt) {
    const provider = task.imageProvider.provider
    const resolved = await this.#credentials().resolve(publishImageCredentialRef(provider))
    const label = PROVIDER_LABEL[provider] || '封面生成服务'
    if (!resolved?.value && provider !== 'custom') fail('SPOKEN_VIDEO_PUBLISH_CREDENTIAL_REQUIRED', `${label}尚未保存 API Key。`)
    // 竖版用 3:4 而不是 9:16：抖音、小红书的信息流封面都按 3:4 展示，9:16 生成的
    // 上下会被裁掉约 25%，主体很容易被切到。按展示形态生成，主体天然落在必留区里。
    const size = kind === 'landscape' ? '1280*720' : '1080*1440'
    let result
    let pollUrl = null
    if (provider === 'custom') {
      // 地址兜底：任务冻结的是「生效中」的那份，但历史任务可能冻的是空值
      // （修好 status/冻结口径之前提交的）。这时用预设默认地址兜住，而不是
      // 让整轮生图失败——封面可以后补，跑不完的任务代价更大。
      const custom = task.imageProvider.custom?.baseUrl
        ? task.imageProvider.custom
        : customImageDefaults(this.environment)
      if (!custom?.baseUrl) fail('SPOKEN_VIDEO_PUBLISH_CONFIG_INVALID', '自定义生图缺少服务地址，请在「封面生图」里补全配置。')
      const authHeaders = resolved?.value
        ? { Authorization: custom.authHeader === 'bearer' ? `Bearer ${resolved.value}` : resolved.value }
        : {}
      const submitUrl = `${custom.baseUrl}${custom.path || ''}`
      if (custom.protocol === 'openai') {
        try {
          result = await this.#json(submitUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify(customOpenAiImageRequest({ model: task.imageProvider.model, prompt, size, negativePrompt })),
            // OpenAI 兼容的生图端点是**同步阻塞**的：请求一直挂到出图为止，常见
            // 1~3 分钟，4K / 高画质更久。不给上限的话 fetch 会无限期挂住，而封面
            // 生成又在 detached 任务里跑——用户看到的是「进行中」永远不变。
            signal: AbortSignal.timeout(300_000),
          }, label)
        } catch (error) {
          // 三类要分开，不能一律说「不可访问」：
          //   - 超时/断连：按次计费下任务多半仍在服务端跑完并已结算，**必须**劝用户
          //     别重复提交，否则付两次钱；
          //   - 服务端明确报错（4xx，如「模型不存在」「Key 无效」）：根本没扣费，
          //     重试是安全的，而且必须让人看见原始原因——套上「不可访问」会把
          //     「模型名写错了」说成「网络不通」，用户会往错的方向查
          //     （2026-10-10 实测踩过：模型名是测试残留的假值，报错却是「不可访问」，
          //     而 Key 与地址其实都对）。
          const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
          const code = typeof error?.code === 'string' ? error.code : ''
          const rejected = code === 'SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED'
          if (rejected) throw error
          fail('SPOKEN_VIDEO_PUBLISH_SERVICE_UNREACHABLE', timedOut
            ? `${label}等待超过 5 分钟仍未返回。该服务是同步出图，任务多半仍在服务端继续并已计费——请先到服务商后台确认，不要重复提交（会重复付费）。`
            : `${label}不可访问：${error instanceof Error ? error.message : String(error)}。若这是超时或断连，任务可能仍在服务端继续并已计费，请先到服务商后台确认。`)
        }
      } else {
        result = await this.#json(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify(publishImageRequest({ model: task.imageProvider.model, prompt, negativePrompt, size })),
          // 异步协议只是提交，应当很快返回；给它 60 秒足够，超出说明服务端有问题。
          signal: AbortSignal.timeout(60_000),
        }, label)
        const taskId = imageTaskId(result)
        // 通用异步协议的取图地址：优先用服务自己回的，回了相对路径就按 baseUrl 拼。
        if (taskId) {
          pollUrl = /^\//u.test(String(result?.output?.task_url || ''))
            ? `${custom.baseUrl}${result.output.task_url}`
            : `${custom.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`
        }
      }
      const url = customOpenAiImageUrl(result) || extractPublishImageUrl(result)
      if (url) result = { ...result, output: { ...(result?.output || {}), choices: [{ message: { content: [{ url }] } }] } }
    } else {
      const config = publishImageConfig(this.environment)
      const baseUrl = provider === 'bailian' ? config.bailianBaseUrl : config.scitigerBaseUrl
      // DashScope's async image API uses a different route from synchronous multimodal generation.
      const generationPath = provider === 'bailian' ? 'image-generation/generation' : 'multimodal-generation/generation'
      const body = publishImageRequest({ model: task.imageProvider.model, prompt, negativePrompt, size })
      result = await this.#json(`${baseUrl}/api/v1/services/aigc/${generationPath}`, { method: 'POST', headers: { Authorization: `Bearer ${resolved.value}`, 'Content-Type': 'application/json', ...(provider === 'bailian' ? { 'X-DashScope-Async': 'enable' } : {}) }, body: JSON.stringify(body) }, label)
      const taskId = imageTaskId(result)
      if (taskId) pollUrl = `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`
    }
    const remoteTaskId = imageTaskId(result)
    await this.#mutateTask(await publishRootFor(agent), task.id, (item) => { executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面请求已提交`, { actor: '封面生图服务', detail: { taskId: remoteTaskId || null, provider, model: task.imageProvider.model, prompt, negativePrompt } }) })
    if (!extractPublishImageUrl(result) && remoteTaskId && pollUrl) {
      const deadline = Date.now() + this.maxPollMs
      const authHeaders = resolved?.value
        ? { Authorization: provider === 'custom' && task.imageProvider.custom?.authHeader !== 'bearer' ? resolved.value : `Bearer ${resolved.value}` }
        : {}
      while (Date.now() < deadline) {
        if (this.pollIntervalMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, this.pollIntervalMs))
        result = await this.#json(pollUrl, { method: 'GET', headers: authHeaders }, '封面生成任务')
        const state = imageTaskState(result)
        if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(state)) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', '封面生成任务失败。')
        // 自定义的通用异步协议未必用百炼那套 choices 结构，取图地址要再解一次。
        const customUrl = provider === 'custom' ? customOpenAiImageUrl(result) : null
        if (customUrl) {
          result = { ...result, output: { ...(result?.output || {}), choices: [{ message: { content: [{ url: customUrl }] } }] } }
          break
        }
        if (extractPublishImageUrl(result)) break
      }
    }
    const url = extractPublishImageUrl(result)
    if (!url) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', '封面生成服务未返回图片。')
    // data URL 是自建/中转服务常见的返回形态（OpenAI 的 b64_json、以及不少国产
    // 服务）：图片就在响应里，没有第二个地址可下。这里直接解 base64；其余情况
    // 仍走「再发一次 GET 下载」的原有路径。
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      const meta = url.slice(5, comma)
      const isBase64 = /;base64$/iu.test(meta)
      const payload = url.slice(comma + 1)
      let bytes
      try {
        bytes = isBase64
          ? Buffer.from(payload, 'base64')
          : Buffer.from(decodeURIComponent(payload), 'utf8')
      } catch {
        fail('SPOKEN_VIDEO_PUBLISH_IMAGE_INVALID', '封面生图服务返回的内联图片无法解码。')
      }
      if (!bytes.length) fail('SPOKEN_VIDEO_PUBLISH_IMAGE_INVALID', '封面生图服务返回了空的内联图片。')
      if (bytes.length > MAX_IMAGE_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '生成的封面超过 20 MiB。')
      const inlineInspected = inspectPublishImage(bytes)
      const inlineTitled = await this.#overlayCoverTitle(agent, task, kind, bytes, inlineInspected)
      return this.#freezeCover(agent, task.projectId, kind, inlineTitled.bytes, inlineTitled.inspected, 'generated')
    }
    let response
    try { response = await this.fetch(boundedUrl(url, '封面生成服务'), { method: 'GET' }) } catch (error) { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_UNREACHABLE', `生成的封面无法下载：${error instanceof Error ? error.message : String(error)}`) }
    if (!response.ok) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `生成的封面下载失败：HTTP ${response.status}`)
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '生成的封面超过 20 MiB。')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '生成的封面超过 20 MiB。')
    const inspected = inspectPublishImage(bytes)
    // 叠中文标题：底图由生图模型出（它写汉字必然乱码），标题由 ffmpeg drawtext 渲染。
    // 失败不阻断——底图本身已是可用封面，标题只是增强。
    const titled = await this.#overlayCoverTitle(agent, task, kind, bytes, inspected)
    return this.#freezeCover(agent, task.projectId, kind, titled.bytes, titled.inspected, 'generated')
  }

  /**
   * 给封面底图叠加发布标题。返回 { bytes, inspected }——叠字成功就用带字版本，
   * 失败（缺字体、ffmpeg 报错、标题为空）原样返回底图，绝不因此让发布资料失败。
   */
  /**
   * 质检 AI 写进封面的标题是否合格。
   *
   * 2026-10-08 实测推翻了旧方案：本机 Qwen-Image 直接写中文标题零乱码，横竖两版
   * 都一次成功，所以**不再用程序叠字**（叠上去会盖住 AI 写的艺术字标题）。这里只做
   * 检查：标题区必须有明显的内容（对比度足够高）且不是纯色空��——那说明模型没把标题
   * 画进去，或者画得太小看不清。检出不合格就记一条事件，让调用方换 seed 重生。
   */
  async #overlayCoverTitle(agent, task, kind, bytes, inspected) {
    let title = null
    try {
      const detail = await this.projectsStore.get(agent, { projectId: task.projectId })
      title = detail?.artifacts?.packaging?.data?.content?.title || null
    } catch { title = null }
    if (!title) title = task.result?.content?.title || task.sourceSnapshot?.title || null
    if (!title) return { bytes, inspected }
    const width = inspected.width
    const height = inspected.height
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { bytes, inspected }
    const scratch = await mkdtemp(join(tmpdir(), 'lwb-cover-'))
    const source = join(scratch, 'base.png')
    try {
      await writeFile(source, bytes)
      // 标题区（顶部 45%）应该有大量笔画边缘；纯色留白说明模型没写字。
      const zone = await inspectCoverTitleZone(source, { width, height, kind })
      if (!zone || !zone.busy) {
        await this.#mutateTask(await publishRootFor(agent), task.id, (item) => {
          executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面上未见清晰标题`, { actor: '封面质检', status: 'error', detail: '标题区几乎是纯色，可能 AI 没把标题画进去或画得太小——建议重生这张封面。' })
        }).catch(() => {})
      }
      return { bytes, inspected }
    } catch {
      return { bytes, inspected }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  }

  async #freezeCover(agent, id, kind, bytes, inspected, source) {
    const root = await projectRootFor(agent, id)
    const file = `media/publish-covers/${kind}-${randomUUID()}.${inspected.extension}`
    const target = await safeTarget(root, file, true)
    try { await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }) } catch (error) { await unlink(target).catch(() => {}); throw error }
    return { file, mediaType: inspected.mediaType, bytes: inspected.bytes, width: inspected.width, height: inspected.height, source }
  }

  async updatePackaging(agent, request) {
    const input = object(request, '更新发布内容请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const detail = await this.projectsStore.get(agent, { projectId: id })
    const current = detail.artifacts?.packaging?.data
    if (!current) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先生成发布信息。')
    return this.projectsStore.commitProduced(agent, { projectId: id, expectedRevision, stage: 'packaging', idempotencyKey: `publish-edit-${randomUUID()}`, source: 'spoken-video/publish-editor', payload: { ...current, mode: 'manual-update', content: contentInput(input.content), prompts: promptsInput(input.prompts, current.prompts), generatedAt: new Date().toISOString() } })
  }

  async uploadCover(agent, request) {
    const input = object(request, '上传封面请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const kind = text(input.kind, '封面方向', 20).toLowerCase()
    if (!['landscape', 'portrait'].includes(kind)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '封面方向无效。')
    const bytes = base64(input.data)
    const inspected = inspectPublishImage(bytes)
    if ((kind === 'landscape' && inspected.width <= inspected.height) || (kind === 'portrait' && inspected.height <= inspected.width)) fail('SPOKEN_VIDEO_PUBLISH_IMAGE_INVALID', kind === 'landscape' ? '横屏封面宽度必须大于高度。' : '竖屏封面高度必须大于宽度。')
    const detail = await this.projectsStore.get(agent, { projectId: id })
    const current = detail.artifacts?.packaging?.data
    if (!current) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先生成发布信息，再上传封面。')
    const cover = await this.#freezeCover(agent, id, kind, bytes, inspected, 'upload')
    try {
      return await this.projectsStore.commitProduced(agent, { projectId: id, expectedRevision, stage: 'packaging', idempotencyKey: `publish-cover-${randomUUID()}`, source: 'spoken-video/publish-upload', payload: { ...current, mode: 'cover-upload', covers: { ...current.covers, [kind]: cover }, coverErrors: { ...current.coverErrors, [kind]: null }, generatedAt: new Date().toISOString() } })
    } catch (error) {
      const root = await projectRootFor(agent, id)
      await unlink(await safeTarget(root, cover.file)).catch(() => {})
      throw error
    }
  }

  async readAsset(agent, request) {
    const input = object(request, '读取发布媒体请求')
    const id = projectId(input.projectId)
    const kind = text(input.kind, '发布媒体类型', 20).toLowerCase()
    const detail = await this.projectsStore.get(agent, { projectId: id })
    let descriptor
    if (kind === 'video' || kind === 'thumbnail') descriptor = detail.artifacts?.video?.data?.video
    else if (['landscape', 'portrait'].includes(kind)) descriptor = detail.artifacts?.packaging?.data?.covers?.[kind]
    else fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '发布媒体类型无效。')
    if (!descriptor?.file || !descriptor?.mediaType) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '当前没有可读取的发布媒体。')
    const root = await projectRootFor(agent, id)
    const file = await safeTarget(root, descriptor.file)
    const info = await stat(file)
    if (kind === 'thumbnail') {
      // Small on-demand first frame; never transfer an entire video just to
      // draw a history row. The file signature invalidates replaced media.
      const key = `${file}:${info.size}:${info.mtimeMs}`
      let pending = this.thumbnails.get(key)
      if (!pending) {
        const worker = this.thumbnailWorkerIndex++ % this.thumbnailWorkers.length
        pending = this.thumbnailWorkers[worker].then(() => execFileAsync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }))
          .then(({ stdout }) => {
            if (!stdout.length) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '无法提取视频缩略图。')
            return { mediaType: 'image/jpeg', bytes: stdout.length, data: stdout.toString('base64') }
          }).catch((error) => { this.thumbnails.delete(key); throw error })
        this.thumbnailWorkers[worker] = pending.catch(() => {})
        if (this.thumbnails.size >= 100) this.thumbnails.delete(this.thumbnails.keys().next().value)
        this.thumbnails.set(key, pending)
      }
      return pending
    }
    if (info.size > MAX_ASSET_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '发布媒体超过浏览器读取的 80 MiB 限制。')
    return { file: descriptor.file, mediaType: descriptor.mediaType, bytes: info.size, data: (await readFile(file)).toString('base64') }
  }

  /**
   * Regenerate one cover direction from a (possibly hand-edited) prompt without
   * touching the publish copy. Runs as a task so the drawer can poll: image
   * providers may take minutes, and a blocking RPC would stall the browser.
   */
  async regenerateCover(agent, request) {
    const input = object(request, '重新生成封面请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const kind = text(input.kind, '封面方向', 20).toLowerCase()
    if (!['landscape', 'portrait'].includes(kind)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '封面方向无效。')
    const prompt = text(input.prompt, '封面提示词', 3000)
    const negativePrompt = typeof input.negativePrompt === 'string' ? input.negativePrompt.slice(0, 1000) : ''
    const settings = await this.status()
    if (settings.configured !== true) fail('SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE', '请先在「封面生图」里保存当前渠道的 API Key。')
    const detail = await this.projectsStore.get(agent, { projectId: id })
    if (detail.revision !== expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，请刷新后重试。')
    if (detail.artifacts?.qc?.data?.passed !== true) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '只有质检通过的成片才能生成封面。')
    if (!detail.artifacts?.packaging?.data) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先生成发布信息，再单独重生封面。')
    const root = await publishRootFor(agent)
    const task = {
      id: randomUUID(), projectId: id, projectTitle: detail.title, account: detail.account || null,
      status: 'queued', phase: 'covers', coverKind: kind, prompt, negativePrompt, error: null, expectedRevision,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      imageProvider: { provider: settings.provider, model: settings.model }, coverErrors: {},
      dsh: dshTrace(),
    }
    await this.#serial(root, async () => { const data = await readTasks(root); data.tasks.unshift(task); await writeTasks(root, data) })
    this.active.add(task.id)
    void this.background(this.#runCover(agent, root, task.id).finally(() => this.active.delete(task.id)))
    return taskSummary(task)
  }

  async #runCover(agent, root, taskId) {
    try {
      const task = await this.#mutateTask(root, taskId, (item) => { item.status = 'running' })
      const kind = task.coverKind
      const cover = await this.#generateCover(agent, task, kind, task.prompt, task.negativePrompt)
      await this.#mutateTask(root, taskId, (item) => { item.result = { covers: { [kind]: cover }, prompts: { [kind]: task.prompt, negative: task.negativePrompt } }; executionEvent(item, '封面已生成', { actor: '封面生图服务', detail: cover }) })
      // Re-read right before committing: the prompt and the frozen cover land in
      // one packaging revision, so the copy the user edited stays intact.
      const fresh = await this.projectsStore.get(agent, { projectId: task.projectId })
      if (fresh.revision !== task.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，旧版本封面任务已取消。')
      const current = fresh.artifacts?.packaging?.data
      if (!current) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '发布信息已不存在，无法重生封面。')
      const committed = await this.projectsStore.commitProduced(agent, {
        projectId: task.projectId, expectedRevision: task.expectedRevision, stage: 'packaging', idempotencyKey: `publish-cover-${task.id}`, source: 'spoken-video/publish-agent',
        payload: {
          ...current, mode: 'cover-regenerate',
          prompts: { ...current.prompts, [kind]: task.prompt, negative: task.negativePrompt },
          covers: { ...current.covers, [kind]: cover },
          coverErrors: { ...current.coverErrors, [kind]: null },
          imageProvider: task.imageProvider, generatedAt: new Date().toISOString(),
        },
      })
      await this.#mutateTask(root, taskId, (item) => { item.status = 'succeeded'; item.phase = 'ready'; item.completedAt = new Date().toISOString(); item.resultRevision = committed.project.revision })
    } catch (error) {
      await this.#mutateTask(root, taskId, (item) => {
        item.status = 'failed'; item.phase = 'failed'; item.error = error instanceof Error ? error.message : String(error); item.completedAt = new Date().toISOString()
        item.coverErrors = { ...item.coverErrors, [item.coverKind]: item.error }
      }).catch(() => {})
    }
  }
}
