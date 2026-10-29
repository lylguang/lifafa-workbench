/**
 * 采集器核心（P2）。
 *
 * 负责编排「一次采集 run」：按账号串行调度、预算与重试、把 publisher 抛出的
 * 错误码翻成人话、驱动 run 状态机。平台选择器不在这里——那是各平台 adapter
 * 的事，这里只调度和记账。
 *
 * 三条来自实战的硬约束（都不写在方案里，是踩出来的）：
 *  1. 账号永远串行。同账号并发会让 Chrome profile 锁打架，也让平台风控更敏感。
 *  2. 120s 是**单次页面操作**上限，300s 是**单账号总墙钟**预算。创作者中心
 *     首屏本身就要几十秒，砍到 90s 会把「页面慢」误判成「采集失败」，制造假失败。
 *  3. `PUBLISHER_ACCOUNT_BUSY` 是「别人在用」，不是「账号坏了」。文案必须区分，
 *     否则用户看到「失败」会以为账号坏了而白折腾。
 */

import { randomUUID } from 'node:crypto'
import { localDateKey } from './analytics-metrics.mjs'

/** 与 Frontend/QA 收敛的重试与预算（见 P2 前置签名）。 */
export const COLLECTION_BUDGET = Object.freeze({
  pageTimeoutMs: 120_000,
  accountBudgetMs: 300_000,
  maxAttempts: 2,
  busyBackoffMs: 5_000,
  busyMaxBackoffMs: 10_000,
  normalBackoffMs: 3_000,
})

/**
 * code → 中文文案。`lastError` 一律走这张表，**绝不透传 error.message**：
 * 页面上的东西不能出现 PUBLISHER_ / Error: / 堆栈 / 内部类名。
 * retryable 决定采集方是退避重试还是直接记失败。
 */
export const COLLECTION_MESSAGES = Object.freeze({
  PUBLISHER_ACCOUNT_BUSY: { retryable: true, message: '账号正被其他任务占用，稍后重试' },
  PUBLISHER_ACCOUNT_TIMEOUT: { retryable: true, message: '采集超时，该平台响应过慢' },
  PUBLISHER_ACCOUNT_EXPIRED: { retryable: false, message: '登录状态已过期，请重新登录后采集' },
  PUBLISHER_LOGIN_REQUIRED: { retryable: false, message: '登录状态已失效，请重新登录后采集' },
  PUBLISHER_BROWSER_UNAVAILABLE: { retryable: false, message: '未找到可用浏览器，无法采集' },
  PUBLISHER_BROWSER_LAUNCH_FAILED: { retryable: false, message: '浏览器启动失败，无法采集' },
  PUBLISHER_NOT_FOUND: { retryable: false, message: '账号不存在' },
  ANALYTICS_COLLECTOR_SELECTOR_MISSING: { retryable: false, message: '平台页面结构已变化，暂时无法采集（已留存截图）' },
  ANALYTICS_COLLECTOR_ABORTED: { retryable: false, message: '采集已取消' },
})

const UNKNOWN_MESSAGE = { retryable: false, message: '采集失败，原因未记录' }

/** 把任意错误收敛成 { code, message, retryable }，绝不把原始异常带出去。 */
export function describeFailure(error) {
  const code = typeof error?.code === 'string' && COLLECTION_MESSAGES[error.code] ? error.code : null
  if (code) return { code, ...COLLECTION_MESSAGES[code] }
  return { code: 'ANALYTICS_COLLECTOR_FAILED', retryable: false, ...UNKNOWN_MESSAGE }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (!Number.isFinite(ms) || ms <= 0) return resolve()
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return resolve() }
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    }
  })
}

export class CollectorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CollectorError'
    this.code = code
  }
}

export class AnalyticsCollector {
  /**
   * @param {{publisher: object|null, store: object, adapters: Map<string, object>,
   *          now?: () => Date, sleep?: (ms, signal) => Promise<void>}} options
   *   publisher 需实现 withAccountPage(accountId, fn, options)（P2 服务缝）。
   *   adapters: platform -> { collectAccount(lease), collectContent?(lease) }
   */
  constructor({ publisher = null, store = null, adapters = new Map(), now = () => new Date(), sleep = delay } = {}) {
    if (!store) throw new Error('AnalyticsCollector requires a store.')
    this.publisher = publisher
    this.store = store
    this.adapters = adapters instanceof Map ? adapters : new Map(Object.entries(adapters || {}))
    this.now = now
    this.sleep = sleep
    /** 当前 run；同一时刻只允许一个（startCollection 撞上就返回它，见 RPC 5）。 */
    this.current = null
  }

  #hasPublisher() {
    return Boolean(this.publisher && typeof this.publisher.withAccountPage === 'function')
  }

  /**
   * 启动一次采集（RPC 5）。
   * 已有 run 在跑时**不报错**，返回当前 runId + alreadyRunning —— 双击「立即采集」
   * 是最常见的触发方式，让它报错只会把界面搞成红色。
   */
  async start({ accountIds, contentIds, trigger = 'manual', background = null } = {}) {
    if (this.current && this.current.running) {
      return { runId: this.current.runId, alreadyRunning: true }
    }
    const accounts = await this.#resolveAccounts(accountIds)
    const runId = `run_${randomUUID()}`
    const run = {
      runId,
      trigger: trigger === 'schedule' ? 'schedule' : 'manual',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      running: true,
      total: accounts.length,
      done: 0,
      current: null,
      failures: [],
      contentIds: Array.isArray(contentIds) ? contentIds : null,
    }
    // 取消信号挂在 run 上：RPC 6 的 current 与 collectAccount 的退避都靠它感知中止。
    run.signal = new AbortController()
    this.current = run
    await this.store.saveRun(publicRun(run))
    const drive = async () => {
      try {
        for (const account of accounts) {
          if (!run.running) break
          run.current = { accountId: account.id, platform: account.platform, startedAt: this.now().toISOString() }
          await this.#collectAccount(run, account, contentIds)
          run.done += 1
          run.current = null
          await this.store.saveRun(publicRun(run))
        }
      } finally {
        run.running = false
        run.current = null
        run.finishedAt = this.now().toISOString()
        await this.store.saveRun(publicRun(run))
        this.current = null
      }
    }
    // background 给了就跑后台（生产调度），否则直接 await（离线测试方便断言）。
    if (typeof background === 'function') background(() => drive())
    else await drive()
    return { runId, alreadyRunning: false }
  }

  async #resolveAccounts(accountIds) {
    if (!this.#hasPublisher()) return []
    const accounts = await this.publisher.listAccounts?.().catch(() => [])
    const all = Array.isArray(accounts) ? accounts : []
    const wanted = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds) : null
    return all.filter((account) => {
      // expired 账号不派发：采集撞到登录页只会拿到一个登录页，跳过并提示用户重新登录。
      if (account.status !== 'active') return false
      return wanted ? wanted.has(account.id) : true
    })
  }

  /** 单账号采集：预算内重试，超预算即放弃转下一个（§2 频控 + 已收敛的 300s/2 次）。 */
  async #collectAccount(run, account, contentIds) {
    const adapter = this.adapters.get(account.platform)
    if (!adapter) {
      run.failures.push({ accountId: account.id, code: 'ANALYTICS_COLLECTOR_UNSUPPORTED', message: `${account.platform} 尚未接入采集` })
      return
    }
    if (!this.#hasPublisher()) {
      run.failures.push({ accountId: account.id, code: 'PUBLISHER_BROWSER_UNAVAILABLE', message: COLLECTION_MESSAGES.PUBLISHER_BROWSER_UNAVAILABLE.message })
      return
    }

    const startedAt = this.now().getTime()
    let attempt = 0
    let last = null
    while (attempt < COLLECTION_BUDGET.maxAttempts) {
      attempt += 1
      const remaining = COLLECTION_BUDGET.accountBudgetMs - (this.now().getTime() - startedAt)
      if (remaining <= 0) break
      // 单次页面操作不许超过账号剩余预算，否则 300s 的墙钟封顶形同虚设。
      const timeoutMs = Math.min(COLLECTION_BUDGET.pageTimeoutMs, remaining)
      try {
        // 硬上限：withAccountPage 内部只给「借用任务」设了超时，
        // 浏览器获取/关闭这两步没有上限——实测一个掉登录的账号能把整轮采集
        // 卡成永久 running（done 0/1、没有失败、没有产物，而且此后每次采集
        // 都被 alreadyRunning 挡住）。这里对整段加一道兜底。
        await Promise.race([
          this.publisher.withAccountPage(account.id, async (lease) => {
          await adapter.collectAccount(lease, {
            runId: run.runId,
            contentIds,
            store: this.store,
            budget: { timeoutMs, remainingMs: remaining },
          })
          // 内容级指标（每条作品的播放/点赞/评论）在同一个租约里顺手采掉。
          //
          // 2026-10-29 修：adapter 契约里声明了 collectContents，但采集器从来没调过它——
          // 于是 bilibili adapter 的 collectContents 一直是死代码，看板的播放/互动
          // 永远是 null，用户看到的是「采集成功但没数据」。
          // 复用同一个 page 实例，不额外开浏览器、不重复过登录态。
          if (typeof adapter.collectContents === 'function') {
            try {
              await adapter.collectContents(lease, {
                runId: run.runId,
                contentIds,
                store: this.store,
                budget: { timeoutMs, remainingMs: remaining },
              })
            } catch (error) {
              // 账号级已经成功，作品级失败不该把整次采集判死：记一条可读失败，
              // 保留已采到的账号快照（部分数据好过没有，且失败原因可见）。
              const failure = describeFailure(error)
              run.failures.push({ accountId: account.id, code: failure.code, message: `作品数据：${failure.message}` })
              await this.store.saveRun(publicRun(run)).catch(() => {})
            }
          }
          }, { timeoutMs, headless: true }),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new CollectorError('PUBLISHER_ACCOUNT_TIMEOUT', '采集超时，该平台响应过慢')), COLLECTION_BUDGET.accountBudgetMs)
            timer.unref?.()
          }),
        ])
        return
      } catch (error) {
        const failure = describeFailure(error)
        last = failure
        if (!failure.retryable) break
        // BUSY 是「别人在用」，退避更短；其余瞬时错误给正常退避。
        const backoff = failure.code === 'PUBLISHER_ACCOUNT_BUSY'
          ? COLLECTION_BUDGET.busyBackoffMs
          : COLLECTION_BUDGET.normalBackoffMs
        // 重试前先确认还剩得下这次退避，否则会超出账号总预算（300s 封顶形同虚设）。
        if (this.now().getTime() - startedAt + backoff >= COLLECTION_BUDGET.accountBudgetMs) break
        await this.sleep(backoff, run.signal)
        if (run.signal?.aborted) break
      }
    }
    run.failures.push({ accountId: account.id, code: last?.code || 'ANALYTICS_COLLECTOR_FAILED', message: last?.message || COLLECTION_MESSAGES.ANALYTICS_COLLECTOR_ABORTED.message })
  }

  /** RPC 6：不传 runId 返回最近一次。 */
  async status({ runId } = {}) {
    if (runId && this.current?.runId === runId) return publicRun(this.current)
    const runs = await this.store.listRuns(1)
    const latest = runs[0]
    if (this.current) return publicRun(this.current)
    if (!latest) return { runId: null, running: false, current: null, done: 0, total: 0, failures: [] }
    return { ...latest, running: false, current: null }
  }

  /** RPC 7。 */
  async runs({ limit = 20 } = {}) {
    const items = await this.store.listRuns(limit)
    return { items: items.map((run) => ({ ...run, running: Boolean(this.current?.runId === run.runId && this.current.running) })) }
  }

  /** 取消当前 run（供关页/停用场景；不取消也不报错）。 */
  cancel() {
    if (this.current && this.current.running) {
      this.current.running = false
      this.current.signal?.abort?.()
      return true
    }
    return false
  }
}

function publicRun(run) {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    running: Boolean(run.running),
    total: run.total,
    done: run.done,
    current: run.current ?? null,
    failures: run.failures ?? [],
    trigger: run.trigger,
  }
}

export default AnalyticsCollector

/**
 * 把「待执行的工作」展开成 Promise，交给宿主 background 托管。
 *
 * 宿主注入的 background 收的是 **Promise**（lwbPackServices 内部
 * `Promise.resolve(promise)` 后加入 pending 集合）；而采集器与调度器按
 * thunk 风格传 `() => work()`。直接把 thunk 递过去，`Promise.resolve` 只会
 * 把函数本身当成结果，work 永远不会执行——2026-10-29 实测：采集一开始就
 * 永久 running（done 0/1、无失败、无产物，此后每次采集都被 alreadyRunning 挡住），
 * 看起来像「看板坏了」，实际是一行契约不匹配。
 */
export function toBackgroundWork(work) {
  return typeof work === 'function' ? work() : work
}
