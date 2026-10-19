/**
 * 定时采集调度。
 *
 * 只负责「什么时候调一次采集」，采集本身完全甩给 AnalyticsCollector。调度器不认账号、
 * 不认浏览器，因此不需要随平台数量增长而改动。
 *
 * 为什么用 setTimeout 递归而不是「每晚算一次时钟差」：宿主可能被挂起或休眠，按墙钟对齐
 * 会在恢复后补跑一整晚错过的采集（用户没要求的批量请求）；递归每次都从上次真正触发起算，
 * 休眠只会顺延一次。
 */

import { COLLECTION_BUDGET } from './analytics-collector.mjs'

export class AnalyticsScheduler {
  /**
   * @param {{collector: object, intervalMs?: number, background?: Function,
   *          now?: () => Date, setTimeout?: Function, clearTimeout?: Function}} options
   */
  constructor({
    collector,
    intervalMs = 24 * 60 * 60 * 1000,
    background = null,
    now = () => new Date(),
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
  } = {}) {
    this.collector = collector
    this.intervalMs = intervalMs
    this.background = typeof background === 'function' ? background : (work) => { void work() }
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.timer = null
    this.running = false
    this.lastStartedAt = null
    this.lastRunId = null
  }

  /** 开始排期。幂等：重复调用不会排出两条链。 */
  start() {
    if (this.running) return false
    this.running = true
    this.#schedule()
    return true
  }

  stop() {
    this.running = false
    // 用 !== null 而不是真值判断：句柄 0 是合法的，if (this.timer) 会漏掉它。
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    return true
  }

  #schedule() {
    if (!this.running) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.background(() => this.#fire())
    }, this.intervalMs)
    // 定时器不该拖住宿主退出（测试注入的假时钟返回数字，没有 unref）。
    const handle = this.timer
    if (handle && typeof handle.unref === 'function') handle.unref()
  }

  async #fire() {
    // 上一次采集还没跑完就跳过这一轮，而不是并发发起第二个 run
    // （collector 都会返回 alreadyRunning，那时我们仍应重新排期）。
    try {
      const result = await this.collector.start({
        trigger: 'schedule',
        background: this.background,
      })
      this.lastStartedAt = this.now().toISOString()
      this.lastRunId = result?.runId ?? null
    } catch {
      // 调度失败不外抛：没人盯着这个 Promise，抛了只会变成 unhandledRejection。
      // 账号级的失败原因由 collector 写进 run.failures，UI 从 collectionRuns 看见。
    } finally {
      this.#schedule()
    }
  }

  /** 排期状态，供宿主启动时打印一行日志。 */
  describe() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      lastStartedAt: this.lastStartedAt,
      lastRunId: this.lastRunId,
      budget: COLLECTION_BUDGET,
    }
  }
}

export default AnalyticsScheduler
