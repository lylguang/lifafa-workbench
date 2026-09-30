import { randomUUID } from 'node:crypto'
import { parseSuggestion, platformLabel } from './benchmark-store.mjs'
import { buildSuggestionsPrompt, buildTeardownPrompt, SUGGESTIONS_SCHEMA, TEARDOWN_SCHEMA } from './benchmark-agent.mjs'

const MAX_SUGGESTION_INPUTS = 8

export class BenchmarkHostError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  return new BenchmarkHostError(code, message)
}

/**
 * 编排层：把存储、AI 执行器与包级生命周期粘在一起。所有 AI 任务通过
 * scope.background 跟踪（卸载会等待结算），通过 AbortController 支持取消。
 */
export class BenchmarkHost {
  constructor({ store, background, teardownExecutor, topicsExecutor }) {
    this.#store = store
    this.#background = background
    this.#teardownExecutor = teardownExecutor
    this.#topicsExecutor = topicsExecutor
    this.#cancellations = new Map()
  }

  #store
  #background
  #teardownExecutor
  #topicsExecutor
  #cancellations

  async status() {
    const [accounts, teardowns, batches] = await Promise.all([
      this.#store.listAccounts(),
      this.#store.listTeardowns(),
      this.#store.listSuggestionBatches(),
    ])
    const completed = teardowns.filter((item) => item.status === 'completed').length
    const running = teardowns.filter((item) => item.status === 'analyzing').length
    return {
      accounts: accounts.length,
      teardowns: teardowns.length,
      teardownsCompleted: completed,
      teardownsRunning: running,
      suggestionBatches: batches.length,
    }
  }

  async listAccounts() {
    return this.#store.listAccounts()
  }

  async createAccount(request) {
    return this.#store.createAccount(request)
  }

  async updateAccount(request) {
    return this.#store.updateAccount(request)
  }

  async deleteAccount(request) {
    return this.#store.deleteAccount(request?.id)
  }

  async listTeardowns() {
    return this.#store.listTeardowns()
  }

  /** 落一条拆解记录并立即后台启动 AI 分析；status 通过 teardownStatus 轮询。 */
  async startTeardown(request) {
    const record = await this.#store.createTeardown(request)
    const controller = new AbortController()
    this.#cancellations.set(record.id, controller)
    this.#background((async () => {
      try {
        const analysis = await this.#teardownExecutor({
          prompt: buildTeardownPrompt({ input: record, platformLabelOf: platformLabel }),
          schema: TEARDOWN_SCHEMA,
          signal: controller.signal,
        })
        await this.#store.completeTeardown(record.id, analysis)
      } catch (error) {
        const message = controller.signal.aborted ? '拆解已取消。' : (error?.message || String(error))
        await this.#store.failTeardown(record.id, message).catch(() => {})
      } finally {
        this.#cancellations.delete(record.id)
      }
    })())
    return { teardownId: record.id }
  }

  async teardownStatus(request) {
    const record = await this.#store.getTeardown(request?.teardownId)
    return { id: record.id, status: record.status, error: record.error || null }
  }

  async deleteTeardown(request) {
    const controller = this.#cancellations.get(request?.id)
    if (controller) controller.abort(new Error('拆解已取消。'))
    return this.#store.deleteTeardown(request?.id)
  }

  /** 基于选中的拆解记录生成一批选题建议；批次落库，历史可回看。 */
  async startTopicSuggestions(request) {
    const ids = Array.isArray(request?.teardownIds) ? request.teardownIds : []
    if (!ids.length) throw fail('BENCHMARK_INVALID_INPUT', '请至少选择一条拆解记录。')
    if (ids.length > MAX_SUGGESTION_INPUTS) throw fail('BENCHMARK_INVALID_INPUT', `一次最多基于 ${MAX_SUGGESTION_INPUTS} 条拆解生成建议。`)
    const all = await this.#store.listTeardowns()
    const picked = ids.map((id) => {
      const found = all.find((item) => item.id === id)
      if (!found) throw fail('BENCHMARK_NOT_FOUND', '拆解记录不存在或已被删除。')
      if (found.status !== 'completed') throw fail('BENCHMARK_NOT_READY', `「${found.title}」还没有完成的拆解结果。`)
      return found
    })
    const batch = { id: randomUUID(), status: 'running', suggestions: null, error: null, inputs: picked.map((item) => ({ id: item.id, title: item.title })), createdAt: new Date().toISOString() }
    await this.#store.saveSuggestionsBatch(batch)
    const controller = new AbortController()
    this.#cancellations.set(batch.id, controller)
    this.#background((async () => {
      try {
        const output = await this.#topicsExecutor({
          prompt: buildSuggestionsPrompt({ teardowns: picked, platformLabelOf: platformLabel }),
          schema: SUGGESTIONS_SCHEMA,
          signal: controller.signal,
        })
        const suggestions = Array.isArray(output?.suggestions) ? output.suggestions.map((item, index) => parseSuggestion(item, `suggestions[${index}]`)) : []
        if (!suggestions.length) throw new Error('模型没有返回有效的选题建议。')
        await this.#store.updateSuggestionsBatch(batch.id, { status: 'completed', suggestions, completedAt: new Date().toISOString() })
      } catch (error) {
        const message = controller.signal.aborted ? '生成已取消。' : (error?.message || String(error))
        await this.#store.updateSuggestionsBatch(batch.id, { status: 'failed', error: String(message).slice(0, 600), completedAt: new Date().toISOString() }).catch(() => {})
      } finally {
        this.#cancellations.delete(batch.id)
      }
    })())
    return { batchId: batch.id }
  }

  async suggestionsStatus(request) {
    const batches = await this.#store.listSuggestionBatches()
    const found = batches.find((item) => item.id === request?.batchId)
    if (!found) throw fail('BENCHMARK_NOT_FOUND', '选题批次不存在。')
    return { id: found.id, status: found.status, error: found.error || null }
  }

  async listSuggestionBatches() {
    return this.#store.listSuggestionBatches()
  }

  /** 服务重启后，把遗留的 analyzing 记录标记为失败。 */
  async recoverStaleAnalyses() {
    await this.#store.markStaleAnalysesFailed()
    return { ok: true }
  }
}
