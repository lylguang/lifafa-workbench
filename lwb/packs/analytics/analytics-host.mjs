/**
 * 数据看板的服务端宿主（P2）。
 *
 * 把三块拼起来：本地聚合（档位 A）、采集调度（P2）、绑定。
 * 宿主本身不碰浏览器也不读文件——它只决定「谁在什么时候被问到什么」，
 * 让每块都能被离线单测替换成假件。
 */

import { join } from 'node:path'
import { AnalyticsLocalSource } from './analytics-local.mjs'
import { AnalyticsStore } from './analytics-store.mjs'
import { AnalyticsCollector, describeFailure } from './analytics-collector.mjs'
import { AnalyticsScheduler } from './analytics-scheduler.mjs'
import bilibili from './analytics-bilibili.mjs'
import douyin from './analytics-douyin.mjs'
import { bindByTitle, normalizeManualBinding } from './analytics-bind.mjs'

export class AnalyticsHost extends AnalyticsLocalSource {
  /**
   * @param {{workspacePath: string, publisher: object|null, spokenVideo: object|null,
   *          background?: Function, now?: () => Date}} options
   */
  constructor({ workspacePath, publisher = null, spokenVideo = null, background = null, now = () => new Date() } = {}) {
    super({ publisher, spokenVideo, store: null })
    this.workspacePath = workspacePath
    this.publisher = publisher
    this.now = now
    this.store = new AnalyticsStore({ dataRoot: join(workspacePath, 'data', 'metrics') })
    // 采集 adapter 按平台注册。抖音是主力账号所在平台（2026-10-29 接入），
    // 微信视频号暂无稳定数据页，暂不注册——未注册的平台会被采集器如实报成
    // ANALYTICS_COLLECTOR_UNSUPPORTED，而不是假装采到 0。
    this.adapters = new Map([
      [bilibili.id, bilibili],
      [douyin.id, douyin],
    ])
    this.background = typeof background === 'function' ? background : (work) => { void work() }
    this.collector = new AnalyticsCollector({ publisher, store: this.store, adapters: this.adapters, now })
    // 定时采集。排期只在宿主启动时开启，卸载时由 stop() 撤销（见 index.mjs 的 dispose）。
    this.scheduler = new AnalyticsScheduler({ collector: this.collector, background: this.background, now })
    this.scheduler.start()
  }

  /** 宿主卸载时停掉定时器，避免包被卸载后仍在后台敲采集。 */
  dispose() {
    this.scheduler.stop()
  }

  /** RPC 5：手动触发采集。已有 run 在跑时返回 alreadyRunning，不报错。 */
  async startCollection(request = {}) {
    // 采集前先把本地内容同步进 store。
    //
    // 内容级指标要按「本地内容 ↔ 平台作品」的对应关系落库，而 store 的
    // contents.json 只保存已绑定/已采集过的行；本地内容的真源是 publisher
    // 的发布记录（运行时投影，不落盘）。不同步的话采集器面对的是一张空表，
    // 标题匹配无从谈起——2026-10-29 实测：内容级指标恒为 0 条，账号级却正常。
    await this.#seedContents(request).catch(() => {})
    return this.collector.start({
      accountIds: request.accountIds,
      contentIds: request.contentIds,
      trigger: 'manual',
      background: this.background,
    })
  }

  /**
   * 把本地内容投影写进 store（只写元数据）。
   *
   * 刻意**不写 remoteUrl**：发布记录里的地址是「作品管理页」，不是单个作品页，
   * 写进来会让 bound 变成 true——看起来已绑定、实际采集器拿到的是列表页，
   * 属于 analytics-bind.mjs 开头点名的「绑错比不绑更坏」。
   * 真正的 remoteId 由采集器从作品管理页的行链接里读出来。
   */
  async #seedContents(request = {}) {
    if (typeof this.contents !== 'function') return 0
    const to = new Date(this.now())
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000)
    const page = await this.contents({
      from: from.toISOString(),
      to: to.toISOString(),
      accountIds: request.accountIds,
      limit: 500,
    }).catch(() => null)
    const rows = (Array.isArray(page?.items) ? page.items : [])
      .filter((row) => row?.contentId && row?.title)
      .map((row) => ({
        contentId: row.contentId,
        title: row.title,
        platform: row.platform ?? null,
        accountId: row.accountId ?? null,
        publishedAt: row.publishedAt ?? null,
      }))
    if (!rows.length) return 0
    await this.store.saveContents(rows).catch(() => {})
    return rows.length
  }

  /** RPC 6：不传 runId 返回最近一次。 */
  async collectionStatus(request = {}) {
    return this.collector.status({ runId: request.runId })
  }

  /** RPC 7 */
  async collectionRuns(request = {}) {
    return this.collector.runs({ limit: request.limit })
  }

  /**
   * RPC 2 的 P2 形态：账号采集态从 `never` 变成真实状态。
   *
   * 派生只看两处既有数据，不新增落盘字段：
   * - store 里的账号快照 → 有快照且新鲜即 `ok`，超过 24h 即 `stale`；
   * - collector 最近一次 run 的 `failures` → 该账号本次失败即 `failed`，
   *   文案走 `describeFailure` 的中文映射，绝不透传 `error.message`。
   *
   * `expired` 优先于其它状态：登录失效时用户必须先重新登录，
   * 报「采集失败」会把原因指错方向。
   */
  async #accountCollectionStates() {
    const month = `${this.now().getFullYear()}-${String(this.now().getMonth() + 1).padStart(2, '0')}`
    // 直接问 publisher 要原始账号（基类行里不含 status），失败就退化成「全部非 expired」。
    const rawAccounts = await this.publisher?.listAccounts?.().catch(() => []) ?? []
    const expired = new Set((Array.isArray(rawAccounts) ? rawAccounts : []).filter((a) => a?.status === 'expired').map((a) => a.id))
    const [snapshots, runs] = await Promise.all([
      this.store.listAccountSnapshots([month]).catch(() => []),
      this.store.listRuns(1).catch(() => []),
    ])
    const newestByAccount = new Map()
    for (const row of Array.isArray(snapshots) ? snapshots : []) {
      const current = newestByAccount.get(row.accountId)
      if (!current || String(row.collectedAt) > String(current.collectedAt)) newestByAccount.set(row.accountId, row)
    }
    const latestRun = Array.isArray(runs) ? runs[0] : null
    const failedCodes = new Map()
    for (const failure of latestRun?.failures ?? []) {
      if (failure?.accountId && !failedCodes.has(failure.accountId)) failedCodes.set(failure.accountId, failure.code)
    }

    return (account) => {
      const snapshot = newestByAccount.get(account.id)
      const collectedAt = snapshot?.collectedAt ?? null
      const failedCode = failedCodes.get(account.id) ?? null
      let collectionStatus = 'never'
      if (expired.has(account.id)) collectionStatus = 'expired'
      else if (failedCode) collectionStatus = 'failed'
      else if (collectedAt) {
        const at = Date.parse(collectedAt)
        const reference = this.now().getTime()
        collectionStatus = Number.isNaN(at) || reference - at > 24 * 60 * 60 * 1000 ? 'stale' : 'ok'
      }
      return {
        lastCollectedAt: collectedAt,
        collectionStatus,
        lastError: failedCode ? describeFailure({ code: failedCode }).message : null,
      }
    }
  }

  /**
   * 账号列表（方案 §4.2-2）的 P2 形态。
   *
   * 相对 P1 的三处语义推进：粉丝/净增粉来自 store 的账号快照（不再恒 null），
   * `lastCollectedAt` 与 `collectionStatus` 来自最近一次采集（不再恒 never）。
   * 字段名与取值词表都没动，前端零改动即可跟随。
   */
  async accounts(request = {}) {
    const result = await super.accounts(request)
    const stateOf = await this.#accountCollectionStates()
    const month = `${this.now().getFullYear()}-${String(this.now().getMonth() + 1).padStart(2, '0')}`
    const snapshots = await this.store.listAccountSnapshots([month]).catch(() => [])
    const historyByAccount = new Map()
    for (const row of Array.isArray(snapshots) ? snapshots : []) {
      if (!row?.accountId) continue
      const list = historyByAccount.get(row.accountId) ?? []
      list.push(row)
      historyByAccount.set(row.accountId, list)
    }
    for (const list of historyByAccount.values()) list.sort((a, b) => String(a.collectedAt).localeCompare(String(b.collectedAt)))

    result.items = result.items.map((item) => {
      const state = stateOf({ id: item.accountId })
      const history = historyByAccount.get(item.accountId) ?? []
      // 口径函数说 current / netGain / baselineDate，契约 §4.2-2 的字段名是
      // followers / followersNetGain / baselineDate —— 这里只做改名，不改语义。
      const { current, netGain, baselineDate } = AnalyticsLocalSource.followersFromSnapshots(history)
      return { ...item, ...state, followers: current, followersNetGain: netGain, baselineDate }
    })
    return result
  }

  /** RPC 8：手动补录，作为 source=manual 的叠加记录，不覆盖采集原值。 */
  async updateContentMetrics(request = {}) {
    return this.store.recordManualMetrics(request.contentId, request.metrics, { note: request.note })
  }

  /** RPC 10：人工绑定单个作品。 */
  async bindContent(request = {}) {
    const binding = normalizeManualBinding(request)
    if (!binding) throw this.#invalid('至少提供作品链接或作品 id。')
    const content = await this.store.getContent(request.contentId)
    if (!content) throw this.#notFound('作品不存在。')
    await this.store.saveContents([{ ...content, ...binding }])
    return this.store.contentDetail(request.contentId)
  }

  /** RPC 11：按账号 + 标题批量匹配。同名多作品一律进待绑定，绝不静默绑错。 */
  async bindAll(request = {}) {
    const contents = await this.store.listContents()
    const scoped = contents.filter((row) => {
      if (row.bound) return false
      if (Array.isArray(request.accountIds) && request.accountIds.length) return request.accountIds.includes(row.accountId)
      return true
    })
    // 平台作品由调用方提供（从该账号的作品管理页读到的列表）。
    const works = Array.isArray(request.platformWorks) ? request.platformWorks : []
    const { matched, unmatched } = bindByTitle(scoped, works)
    for (const row of matched) await this.store.saveContents([row])
    return {
      matched: matched.length,
      unmatched: unmatched.length,
      unmatchedContentIds: unmatched.map((row) => row.contentId),
    }
  }

  #invalid(message) {
    const error = new Error(message)
    error.code = 'ANALYTICS_INVALID_INPUT'
    return error
  }

  #notFound(message) {
    const error = new Error(message)
    error.code = 'ANALYTICS_CONTENT_NOT_FOUND'
    return error
  }
}

export default AnalyticsHost
