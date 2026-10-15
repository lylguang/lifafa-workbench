import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep, relative } from 'node:path'
import {
  ADAPTER_PLATFORMS,
  platformLabel,
  PublisherStoreError,
} from './publisher-store.mjs'
import { PublisherBrowserError } from './publisher-browser.mjs'
import douyinAdapter from './publisher-adapter-douyin.mjs'
import bilibiliAdapter from './publisher-adapter-bilibili.mjs'
import kuaishouAdapter from './publisher-adapter-kuaishou.mjs'
import wechatAdapter from './publisher-adapter-wechat.mjs'

const ADAPTERS = new Map([
  [douyinAdapter.id, douyinAdapter],
  [bilibiliAdapter.id, bilibiliAdapter],
  [kuaishouAdapter.id, kuaishouAdapter],
  [wechatAdapter.id, wechatAdapter],
])

function fail(code, message) {
  throw new PublisherStoreError(code, message)
}

function adapterFor(platform) {
  const adapter = ADAPTERS.get(platform)
  if (!adapter) fail('PUBLISHER_ADAPTER_UNAVAILABLE', `${platformLabel(platform)}的发布流程尚未实现，当前可发布平台：${ADAPTER_PLATFORMS.map(platformLabel).join('、')}。`)
  return adapter
}

function pathInside(root, target) {
  const value = relative(root, target)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

/**
 * Publish orchestrator.
 *
 * It owns three things the browser and adapters must not: the gate that decides
 * whether a project may be published at all, the frozen snapshot of what was
 * published, and the evidence trail. The final cut and its publish copy are
 * read from the spoken-video pack's workspace, which is why this pack never
 * needs its own copy of the video library.
 */
export class PublisherHost {
  constructor({
    store,
    browser,
    spokenVideo = null,
    workspacePath,
    background = (work) => work,
    onLog = () => {},
    now = () => new Date().toISOString(),
  } = {}) {
    if (!store) throw new Error('PublisherHost requires a store.')
    if (!browser) throw new Error('PublisherHost requires a browser pool.')
    this.store = store
    this.browser = browser
    this.spokenVideo = spokenVideo
    this.workspacePath = workspacePath
    this.background = background
    this.onLog = onLog
    this.now = now
    /** jobId -> AbortController, so a running job can be cancelled. */
    this.active = new Map()
    /** Accounts currently opening or publishing; one browser per account. */
    this.busy = new Set()
  }

  /* ------------------------------ readiness ------------------------------ */

  async status() {
    const browser = await this.browser.status()
    let spokenVideoStatus = { available: false, reason: '口播视频能力包未加载。' }
    try {
      spokenVideoStatus = await this.#spokenVideoStatus()
    } catch (error) {
      spokenVideoStatus = { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const settings = await this.store.settings()
    const accounts = await this.store.listAccounts()
    const jobs = await this.store.listJobs()
    return {
      browser,
      spokenVideo: spokenVideoStatus,
      settings,
      adapters: ADAPTER_PLATFORMS,
      counts: {
        accounts: accounts.length,
        active: accounts.filter((item) => item.status === 'active').length,
        running: jobs.filter((job) => ['queued', 'running', 'awaiting-confirm'].includes(job.status)).length,
      },
    }
  }

  /** Probe the sibling pack lazily; a missing pack must not break this one. */
  async #spokenVideoStatus() {
    const publish = this.spokenVideo?.publish
    if (!publish) return { available: false, reason: '口播视频能力包未加载。' }
    return { available: true, reason: null }
  }

  /* ------------------------------- accounts ------------------------------- */

  async listAccounts() {
    const accounts = await this.store.listAccounts()
    return accounts.map((account) => ({
      ...account,
      platformLabel: platformLabel(account.platform),
      adapterReady: ADAPTERS.has(account.platform),
      sessionOpen: this.browser.isOpen(account.id),
      busy: this.busy.has(account.id),
    }))
  }

  async createAccount(request) {
    const account = await this.store.createAccount(request)
    return { ...account, platformLabel: platformLabel(account.platform), adapterReady: ADAPTERS.has(account.platform) }
  }

  async updateAccount(id, request) {
    return this.store.updateAccount(id, request)
  }

  async deleteAccount(id) {
    await this.browser.close(id)
    const removed = await this.store.deleteAccount(id)
    await this.store.removeProfile(removed.profileDir)
    return { id: removed.id }
  }

  /**
   * Open the platform's login page in a visible window and wait for the human
   * to scan. The QR code stays inside that window: forwarding a screenshot of
   * it would copy a live login credential into another context, which is not a
   * trade worth making for convenience.
   */
  async startLogin(id) {
    const account = await this.store.getAccount(id)
    if (this.busy.has(account.id)) fail('PUBLISHER_ACCOUNT_BUSY', '该账号正在执行其他操作，请稍候。')
    const adapter = ADAPTERS.get(account.platform) || null
    const loginUrl = adapter?.loginUrl || null
    this.busy.add(account.id)
    try {
      const session = await this.browser.acquire(account, { headless: false })
      const page = await this.browser.page(session)
      if (loginUrl) await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
      this.onLog('login', `已打开${platformLabel(account.platform)}登录窗口，请用手机扫码。`)
      return { accountId: account.id, opened: true, message: '登录窗口已打开，请在该窗口中扫码登录。' }
    } finally {
      this.busy.delete(account.id)
    }
  }

  /** After the human scans, capture the resulting login state. */
  async confirmLogin(id) {
    const account = await this.store.getAccount(id)
    const adapter = adapterFor(account.platform)
    if (this.busy.has(account.id)) fail('PUBLISHER_ACCOUNT_BUSY', '该账号正在执行其他操作，请稍候。')
    this.busy.add(account.id)
    try {
      const session = await this.browser.acquire(account, { headless: true })
      const page = await this.browser.page(session)
      const loggedIn = await adapter.isLoggedIn(page)
      this.browser.touch(account.id)
      if (!loggedIn) {
        const updated = await this.store.patchAccountState(account.id, {
          status: 'expired', lastCheckedAt: this.now(), lastError: '未能确认登录状态，请确认已在窗口中完成扫码。',
        })
        return { ...updated, loggedIn: false, message: '仍未检测到登录。请确认已在窗口中完成扫码，再点一次「检测登录」。' }
      }
      const identity = await adapter.readIdentity(page).catch(() => ({ nickname: null, handle: null }))
      const updated = await this.store.patchAccountState(account.id, {
        status: 'active',
        nickname: identity.nickname,
        handle: identity.handle,
        lastCheckedAt: this.now(),
        lastLoginAt: this.now(),
        lastError: null,
      })
      this.onLog('login', `账号已就绪：${identity.nickname || updated.label}`)
      return { ...updated, loggedIn: true, message: `登录成功${identity.nickname ? `：${identity.nickname}` : ''}` }
    } finally {
      this.busy.delete(account.id)
    }
  }

  /** Re-check an existing account without opening a visible window. */
  async checkAccount(id) {
    const account = await this.store.getAccount(id)
    const adapter = adapterFor(account.platform)
    if (this.busy.has(account.id)) fail('PUBLISHER_ACCOUNT_BUSY', '该账号正在执行其他操作，请稍候。')
    this.busy.add(account.id)
    try {
      const session = await this.browser.acquire(account, { headless: true })
      const page = await this.browser.page(session)
      const loggedIn = await adapter.isLoggedIn(page).catch(() => false)
      this.browser.touch(account.id)
      if (!loggedIn) {
        const updated = await this.store.patchAccountState(account.id, {
          status: 'expired', lastCheckedAt: this.now(), lastError: '登录态已失效，请重新扫码登录。',
        })
        return { ...updated, loggedIn: false }
      }
      const identity = await adapter.readIdentity(page).catch(() => ({ nickname: null, handle: null }))
      const updated = await this.store.patchAccountState(account.id, {
        status: 'active', nickname: identity.nickname, handle: identity.handle, lastCheckedAt: this.now(), lastError: null,
      })
      return { ...updated, loggedIn: true }
    } finally {
      this.busy.delete(account.id)
    }
  }

  /** Close an account's browser window without touching its login state. */
  async closeSession(id) {
    const closed = await this.browser.close(id)
    return { closed }
  }

  /* ------------------------------ shelf read ------------------------------ */

  /**
   * The publish shelf is the spoken-video project list filtered to projects
   * that passed qc, joined with their packaging copy. The sibling pack is
   * reached lazily through the live context; when it is absent the shelf is
   * simply empty and says so.
   */
  async listShelf() {
    const publish = this.spokenVideo?.publish
    if (!publish?.listItems) return { items: [], available: false, reason: '口播视频能力包未加载，无法读取成片货架。' }
    const context = await this.#spokenVideoContext()
    let result
    try {
      result = await publish.listItems(context, {})
    } catch (error) {
      return { items: [], available: false, reason: `读取成片失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const items = []
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      const packaging = item.packaging || null
      const accounts = await this.store.listAccounts()
      items.push({
        projectId: item.id,
        title: item.title || item.projectTitle || null,
        revision: item.revision,
        updatedAt: item.updatedAt,
        account: item.account || null,
        orientation: item.orientation || null,
        video: item.video || null,
        packaging: packaging ? {
          content: packaging.content || null,
          covers: packaging.covers || null,
          generatedAt: packaging.generatedAt || null,
        } : null,
        ready: Boolean(packaging?.content),
        alreadyQueued: accounts.length > 0 ? await this.#hasOpenJob(item.id) : false,
      })
    }
    return { items, available: true, reason: null, total: items.length }
  }

  async #hasOpenJob(projectId) {
    const jobs = await this.store.listJobs()
    return jobs.some((job) => job.projectId === projectId && ['queued', 'running', 'awaiting-confirm'].includes(job.status))
  }

  /** A data context for the sibling pack's workspace. */
  async #spokenVideoContext() {
    const context = this.spokenVideo?.context
    if (typeof context !== 'function') fail('PUBLISHER_SPOKEN_VIDEO_UNAVAILABLE', '口播视频能力包的上下文不可用。')
    return context()
  }

  /**
   * Resolve the final cut's absolute path. The video path returned by the shelf
   * is project-relative, so it is re-validated against the project directory
   * before anything hands it to a browser upload.
   */
  async #projectVideoPath(projectId, detail, context) {
    const root = typeof context?.workspacePath === 'string' ? join(context.workspacePath, 'data', 'projects', projectId) : null
    if (!root) fail('PUBLISHER_SPOKEN_VIDEO_UNAVAILABLE', '无法定位口播项目目录。')
    const info = await lstat(root).catch(() => null)
    if (!info?.isDirectory()) fail('PUBLISHER_NOT_FOUND', '口播项目目录不存在。')
    const projectRoot = await realpath(root)
    const file = detail.artifacts?.video?.data?.video?.file
    if (typeof file !== 'string' || !file) fail('PUBLISHER_STAGE_BLOCKED', '该项目没有可发布的成片。')
    const target = resolve(projectRoot, file)
    if (!pathInside(projectRoot, target)) fail('PUBLISHER_INVALID_INPUT', '成片路径越界。')
    const video = await lstat(target).catch(() => null)
    if (!video?.isFile()) fail('PUBLISHER_NOT_FOUND', '成片文件不存在，可能已被清理。')
    const coverPath = (kind) => {
      const covers = detail.artifacts?.packaging?.data?.covers
      const entry = covers?.[kind]
      if (!entry?.file) return null
      const candidate = resolve(projectRoot, entry.file)
      return pathInside(projectRoot, candidate) ? candidate : null
    }
    return { videoPath: target, projectRoot, coverPaths: { landscape: coverPath('landscape'), portrait: coverPath('portrait') } }
  }

  /* -------------------------------- publish ------------------------------- */

  async startPublish(request) {
    const input = request && typeof request === 'object' ? request : {}
    const account = await this.store.getAccount(input.accountId)
    adapterFor(account.platform)
    if (account.status !== 'active') fail('PUBLISHER_LOGIN_REQUIRED', `${account.label} 的登录态已失效，请先重新登录。`)
    if (this.busy.has(account.id)) fail('PUBLISHER_ACCOUNT_BUSY', '该账号正在执行其他操作，请稍候。')

    const projects = this.spokenVideo?.projects
    const publish = this.spokenVideo?.publish
    if (!projects?.get || !publish?.listItems) fail('PUBLISHER_SPOKEN_VIDEO_UNAVAILABLE', '口播视频能力包未加载，无法发布它的成片。')
    const context = await this.#spokenVideoContext()
    const projectId = String(input.projectId || '').trim()
    const detail = await projects.get(context, { projectId })

    // The same gate the publish module enforces, restated here because this
    // pack can also be triggered by automation, where nobody is watching.
    if (detail.artifacts?.qc?.data?.passed !== true) fail('PUBLISHER_STAGE_BLOCKED', '只有质检通过的成片才能发布。')
    const content = detail.artifacts?.packaging?.data?.content
    if (!content) fail('PUBLISHER_STAGE_BLOCKED', '请先在「发布」页生成发布信息（标题、文案、标签、封面）。')

    const settings = await this.store.settings()
    const submitMode = input.submitMode === 'auto' ? 'auto' : (settings.submitMode === 'auto' && input.submitMode !== 'confirm' ? 'auto' : 'confirm')
    if (submitMode === 'auto' && input.confirmAuto !== true) {
      fail('PUBLISHER_CONFIRM_REQUIRED', '自动提交需要二次确认：请在界面上明确勾选后再提交。')
    }
    const { videoPath, coverPaths } = await this.#projectVideoPath(projectId, detail, context)
    const job = await this.store.createJob({
      accountId: account.id,
      platform: account.platform,
      accountLabel: account.label,
      projectId,
      projectTitle: detail.title,
      projectRevision: detail.revision,
      submitMode,
      trigger: input.trigger === 'schedule' ? 'schedule' : 'manual',
      media: {
        file: detail.artifacts.video.data.video.file,
        bytes: detail.artifacts.video.data.video.bytes ?? null,
        durationSeconds: detail.artifacts.video.data.video.durationSeconds ?? null,
        orientation: detail.artifacts.video.data.orientation || null,
        coverFiles: Object.fromEntries(Object.entries(coverPaths).filter(([, value]) => Boolean(value))),
      },
      content: {
        title: content.title, copy: content.copy, description: content.description, tags: [...content.tags],
      },
    })
    const controller = new AbortController()
    this.active.set(job.id, controller)
    void this.background(this.#run(account, job.id, { videoPath, coverPaths, signal: controller.signal })
      .finally(() => this.active.delete(job.id)))
    return job
  }

  async listJobs() {
    const jobs = await this.store.listJobs()
    return jobs.map((job) => ({
      ...job,
      platformLabel: platformLabel(job.platform),
      cancellable: ['queued', 'running', 'awaiting-confirm'].includes(job.status),
    }))
  }

  async job(id) {
    const job = await this.store.getJob(id)
    return { ...job, platformLabel: platformLabel(job.platform), cancellable: ['queued', 'running', 'awaiting-confirm'].includes(job.status) }
  }

  /**
   * 用户在平台页面点完「发表」后回来自认。
   *
   * 2026-10-13 反馈：点完发表，卡片还一直显示「待确认」。真因是这一档之后**本来
   * 就没有任何回读逻辑** —— 自动化不知道平台那边已经提交，只能一直停在原地，
   * 于是任务永远不会自己走到 succeeded（PHASE_FLOW 里的 submit/verify 两步没有
   * 任何代码会推进）。这里给一个人工回执入口，把状态收尾。
   *
   * 不关浏览器：用户可能还要在那个窗口里做别的事，只解除 hold 让它重新按空闲计时。
   */
  async confirmSubmitted(id, request = {}) {
    const job = await this.store.getJob(id)
    if (job.status !== 'awaiting-confirm') fail('PUBLISHER_JOB_NOT_CONFIRMABLE', '该任务当前不处于等待确认状态。')
    const remoteUrl = String((request && typeof request === 'object' ? request.remoteUrl : '') || '').trim()
    await this.store.mutateJob(job.id, (item) => {
      item.status = 'succeeded'
      item.phase = 'done'
      item.completedAt = this.now()
      item.proof.submittedAt = this.now()
      if (remoteUrl) item.proof.remoteUrl = remoteUrl
    })
    // 不关浏览器（用户可能还要用），只解除 hold 让空闲回收重新生效。
    this.browser.release(job.accountId)
    this.onLog('publish', '用户已确认发布完成。')
    return this.job(job.id)
  }

  async cancelJob(id) {
    const job = await this.store.getJob(id)
    if (!['queued', 'running', 'awaiting-confirm'].includes(job.status)) fail('PUBLISHER_JOB_NOT_CANCELLABLE', '该任务已结束，无需取消。')
    const controller = this.active.get(job.id)
    controller?.abort(new Error('用户取消了发布任务。'))
    await this.store.mutateJob(job.id, (item) => {
      item.status = 'cancelled'
      item.phase = 'cancelled'
      item.completedAt = this.now()
    })
    await this.browser.close(job.accountId)
    return this.job(job.id)
  }

  /** Read an evidence screenshot back as base64 for the records page. */
  async evidence(request) {
    const input = request && typeof request === 'object' ? request : {}
    const job = await this.store.getJob(input.jobId)
    const name = String(input.name || '').trim()
    const allowed = job.proof.screenshots.includes(name) || job.proof.screenshots.some((item) => item.endsWith(name))
    if (!allowed) fail('PUBLISHER_NOT_FOUND', '该证据不属于此任务。')
    const file = await this.store.readEvidence(name)
    return { name, bytes: file.bytes, data: file.data.toString('base64') }
  }

  /* ------------------------------- internals ------------------------------ */

  async #run(account, jobId, { videoPath, coverPaths, signal }) {
    const adapter = adapterFor(account.platform)
    const step = async (phase, detail) => {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('发布任务已取消。')
      await this.store.mutateJob(jobId, (item) => { item.status = 'running'; item.phase = phase })
      this.onLog('publish', `${platformLabel(account.platform)}：${detail}`)
      await this.#capture(account, jobId, `step-${phase}`)
    }
    try {
      await this.store.mutateJob(jobId, (item) => { item.status = 'running'; item.phase = 'open' })
      this.busy.add(account.id)
      const session = await this.browser.acquire(account, { headless: account.status === 'active' && (await this.store.settings()).headless })
      const page = await this.browser.page(session)
      if (signal) {
        signal.addEventListener('abort', () => { void this.browser.close(account.id) }, { once: true })
      }
      const result = await adapter.publish(page, {
        videoPath,
        content: (await this.store.getJob(jobId)).content,
        coverPaths,
        submitMode: (await this.store.getJob(jobId)).submitMode,
        onStep: async (phase, detail) => { await step(phase, detail) },
      })
      if (result.submitted) {
        await this.store.mutateJob(jobId, (item) => {
          item.status = 'succeeded'
          item.phase = 'done'
          item.completedAt = this.now()
          item.proof.remoteUrl = result.remoteUrl
          item.proof.submittedAt = this.now()
        })
        await this.#capture(account, jobId, 'step-done')
      } else {
        await this.store.mutateJob(jobId, (item) => {
          item.status = 'awaiting-confirm'
          item.phase = 'awaiting-confirm'
        })
        await this.#capture(account, jobId, 'step-awaiting-confirm')
        // 停在这里等人点「发表」：暂停浏览器的空闲回收。默认 10 分钟没交互就把
        // 会话关掉，而这一档恰恰要用户慢慢填、随时提交（2026-10-13 反馈「停留久了
        // 网页会自动关闭」）。用户点「我已发布」或取消时再 release。
        this.browser.hold(account.id)
      }
      this.onLog('publish', result.submitted ? '发布已提交。' : '已停在发布前，等待人工确认。')
    } catch (error) {
      const code = error?.code || 'PUBLISHER_JOB_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      await this.store.mutateJob(jobId, (item) => {
        item.status = 'failed'
        item.phase = 'failed'
        item.error = message
        item.completedAt = this.now()
      }).catch(() => {})
      await this.#capture(account, jobId, 'step-failed').catch(() => {})
      // A dead login invalidates the account everywhere, not just this job.
      if (code === 'PUBLISHER_LOGIN_REQUIRED') {
        await this.store.patchAccountState(account.id, { status: 'expired', lastCheckedAt: this.now(), lastError: message }).catch(() => {})
      }
      this.onLog('publish', `发布失败：${message}`)
    } finally {
      this.busy.delete(account.id)
    }
  }

  /** Screenshot the account's page as evidence; a failure here is not fatal. */
  async #capture(account, jobId, name) {
    try {
      const session = this.browser.sessions.get(account.id)
      if (!session) return null
      const page = session.context.pages().find((item) => !item.isClosed())
      if (!page) return null
      const bytes = await page.screenshot({ type: 'png', animations: 'disabled' })
      const relative = await this.store.saveEvidence(jobId, `${name}-${Date.now()}.png`, bytes)
      await this.store.mutateJob(jobId, (item) => {
        if (!item.proof.screenshots.includes(relative)) item.proof.screenshots.push(relative)
      })
      return relative
    } catch { return null }
  }

  /** Reset jobs left live by a previous process; one-shot, called on load. */
  async recoverInterrupted() {
    const jobs = await this.store.listJobs()
    for (const job of jobs) {
      if (!['queued', 'running'].includes(job.status)) continue
      await this.store.mutateJob(job.id, (item) => {
        item.status = 'failed'
        item.phase = 'failed'
        item.error = '应用重启中断了发布任务，请重试。'
        item.completedAt = this.now()
      }).catch(() => {})
    }
    return true
  }

  async shutdown() {
    for (const controller of this.active.values()) controller.abort(new Error('发布能力包已停止。'))
    this.active.clear()
    await this.browser.closeAll()
  }
}

export { PublisherStoreError, PublisherBrowserError }
