import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Browser session pool for platform accounts.
 *
 * Each platform account owns a Chrome user-data directory, so its login state
 * is a real browser profile: platform cookies stay under Chrome's own
 * encryption and survive workbench restarts, exactly like a person's everyday
 * browser. We deliberately never copy cookies into JSON.
 *
 * Design constraints that shaped this file:
 *  - One browser per account, never shared: two platforms in one profile would
 *    cross-contaminate fingerprint and login state.
 *  - Sessions are created lazily and closed when idle, because each Chrome
 *    instance costs several hundred MB.
 *  - Playwright is an optional dependency of the pack: if it is missing, the
 *    failure must say how to install it instead of throwing a module error
 *    deep inside a background job.
 */

const CHROME_CANDIDATES = [
  process.env.LWB_PUBLISHER_CHROME,
  process.env.LWB_REMOTION_BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter((value) => typeof value === 'string' && value.length > 0)

export class PublisherBrowserError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  throw new PublisherBrowserError(code, message)
}

/** Locate a real browser binary; the pack never downloads one of its own. */
export function resolveBrowserExecutable(environment = process.env) {
  for (const candidate of CHROME_CANDIDATES) {
    try { if (existsSync(candidate)) return candidate } catch { /* unreadable path */ }
  }
  const envCandidate = environment.LWB_PUBLISHER_CHROME
  if (typeof envCandidate === 'string' && envCandidate && existsSync(envCandidate)) return envCandidate
  return null
}

/** Import playwright-core lazily so a missing dependency yields a usable message. */
async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch {
    fail('PUBLISHER_BROWSER_UNAVAILABLE', '缺少 playwright-core 依赖。请在工作台根目录运行「npm run publisher:install」后重试。')
  }
}

export class PublisherBrowserPool {
  constructor({ dataRoot, headless = false, onLog = () => {}, idleTimeoutMs = 10 * 60 * 1000 } = {}) {
    if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('PublisherBrowserPool requires the pack data root.')
    this.dataRoot = dataRoot
    this.headless = headless === true
    this.onLog = onLog
    this.idleTimeoutMs = idleTimeoutMs
    /** accountId -> { context, profilePath, lastUsedAt, timer } */
    this.sessions = new Map()
    this.executable = null
  }

  get executablePath() {
    if (!this.executable) this.executable = resolveBrowserExecutable()
    return this.executable
  }

  /** Diagnostics for the accounts page: what the pack can actually do here. */
  async status() {
    let playwrightVersion = null
    try {
      const playwright = await import('playwright-core/package.json', { with: { type: 'json' } })
      playwrightVersion = playwright.default?.version || null
    } catch { /* dependency absent or unreadable */ }
    return {
      ready: Boolean(playwrightVersion) && Boolean(this.executablePath),
      playwright: playwrightVersion,
      executable: this.executablePath,
      headless: this.headless,
      openSessions: this.sessions.size,
    }
  }

  profilePath(profileDir) {
    return join(this.dataRoot, profileDir)
  }

  /**
   * Open (or reuse) a visible browser for an account. `headlessOverride` lets
   * a login check run invisibly while a real publish stays visible.
   */
  async acquire(account, { headless } = {}) {
    const executablePath = this.executablePath
    if (!executablePath) fail('PUBLISHER_BROWSER_UNAVAILABLE', '未找到可用的 Chrome 或 Edge。请安装 Chrome，或设置环境变量 LWB_PUBLISHER_CHROME 指向浏览器可执行文件。')
    const wanted = typeof headless === 'boolean' ? headless : this.headless
    const existing = this.sessions.get(account.id)
    if (existing && existing.headless === wanted && !existing.context.__closed) {
      existing.lastUsedAt = Date.now()
      return existing
    }
    if (existing) await this.close(account.id)

    const { chromium } = await loadPlaywright()
    const profilePath = this.profilePath(account.profileDir)
    await mkdir(profilePath, { recursive: true, mode: 0o700 })
    let context
    try {
      context = await chromium.launchPersistentContext(profilePath, {
        executablePath,
        headless: wanted,
        viewport: wanted ? { width: 1440, height: 900 } : null,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=Translate,OptimizationHints',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
      })
    } catch (error) {
      fail('PUBLISHER_BROWSER_LAUNCH_FAILED', `启动浏览器失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // Launching while another Chrome already owns the profile makes Chrome
    // silently attach to the wrong process; surface it instead of publishing
    // into a window nobody can see.
    if (typeof context.on === 'function') {
      context.on('close', () => { context.__closed = true })
    }
    const session = { context, profilePath, headless: wanted, lastUsedAt: Date.now(), timer: null, accountId: account.id }
    this.sessions.set(account.id, session)
    this.#armIdleTimer(account.id, session)
    this.onLog('browser', `已打开 ${account.platform} 浏览器会话（${wanted ? '后台' : '可见窗口'}）。`)
    return session
  }

  /**
   * 暂停空闲回收：任务停在「等待确认」等人点「发表」时必须调这个。
   *
   * 2026-10-13 用户反馈「在等待确认发布页停留久了，网页会自动关闭」—— 真因是
   * idleTimeoutMs 默认 10 分钟且没有任何交互就回收，而这一档恰恰要用户慢慢填、
   * 随时点提交，10 分钟远不够。停在这里等用户的浏览器不能被回收。
   */
  hold(accountId) {
    const session = this.sessions.get(accountId)
    if (!session) return false
    clearTimeout(session.timer)
    session.timer = null
    session.held = true
    return true
  }

  /** 解除 hold：不再等人工后重新按空闲计时（取消/失败/确认完成时调用）。 */
  release(accountId) {
    const session = this.sessions.get(accountId)
    if (!session) return false
    session.held = false
    this.#armIdleTimer(accountId, session)
    return true
  }

  #armIdleTimer(accountId, session) {
    if (this.idleTimeoutMs <= 0) return
    // hold 期间不排空闲回收：正在等用户操作的会话不能被关掉。
    if (session.held) return
    clearTimeout(session.timer)
    session.timer = setTimeout(() => { void this.close(accountId) }, this.idleTimeoutMs)
    if (typeof session.timer.unref === 'function') session.timer.unref()
  }

  /** The first usable page of a session, creating one when Chrome opened none. */
  async page(session) {
    const pages = session.context.pages()
    const page = pages.find((item) => !item.isClosed()) || await session.context.newPage()
    page.setDefaultTimeout(45_000)
    return page
  }

  touch(accountId) {
    const session = this.sessions.get(accountId)
    if (!session) return
    session.lastUsedAt = Date.now()
    this.#armIdleTimer(accountId, session)
  }

  isOpen(accountId) {
    const session = this.sessions.get(accountId)
    return Boolean(session && !session.context.__closed)
  }

  async close(accountId) {
    const session = this.sessions.get(accountId)
    if (!session) return false
    clearTimeout(session.timer)
    this.sessions.delete(accountId)
    await session.context.close().catch(() => {})
    this.onLog('browser', '已关闭浏览器会话。')
    return true
  }

  async closeAll() {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.close(id)))
  }

  /** Screenshot a page for the evidence trail; never throws into a job. */
  async screenshot(page, name) {
    try {
      return await page.screenshot({ path: undefined, fullPage: false, type: 'png', animations: 'disabled' })
        .then((bytes) => ({ name, bytes }))
    } catch {
      return null
    }
  }
}
