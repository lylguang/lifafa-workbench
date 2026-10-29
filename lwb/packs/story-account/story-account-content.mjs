/**
 * 内容主机：账号定位、故事素材、选题生成与写稿生成。
 *
 * 这一层只做「编排」——所有模型调用都通过注入的 executor 走 DSH 子会话，
 * 纯逻辑（提示词、schema、校验、归一化）留在各自的纯模块里，可以脱离主机单测。
 *
 * 三个容易被忽略的设计点：
 *
 * 1) 生成任务是有状态的（排队/运行/成功/失败），因为一次选题生成可能要几十秒。
 *    状态保存在内存 Map 里，重启即丢——生成结果本身已经落在项目产物里，丢了
 *    状态不影响数据，只影响「正在看进度」的那一次体验。
 * 2) 账号定位以「快照」形式进入选题，选题再以快照形式进入稿件。后续改定位不会
 *    回写已完成的项目，这是刻意为之：一条片子用的是当时的定位。
 * 3) 选题与写稿之后都会做一次确定性校验，模型输出不合规时先尝试一次修复提示，
 *    仍不合规就如实失败，不把半成品塞进项目。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { storyAccountDataPath } from './story-account-paths.mjs'
import { mediaCredentialRef } from './story-account-credentials.mjs'
import {
  emptyProfile, hasProfile, parseProfile, parseCompletionInput, buildCompletionPrompt,
  COMPLETION_SCHEMA, normalizeCompletion, parseAccountSnapshot, profileLines,
} from './story-account-profile.mjs'
import { parseMaterial, normalizeMaterialFile, emptyMaterialFile, assembleMaterial } from './story-account-materials.mjs'
import {
  parseHarvestInput, buildHarvestPrompt, buildHarvestSteps, STORY_HARVEST_SCHEMA, normalizeHarvest, summarizeHarvest,
} from './story-account-harvest.mjs'
import { collectMaterialCandidates } from './story-account-harvest-sources.mjs'
import { parseTopicInput, buildTopicPrompt, STORY_CANDIDATES_SCHEMA, normalizeCandidates, buildTopicSteps } from './story-account-topic.mjs'
import { parseScriptGenerationInput, buildScriptPrompt, STORY_DRAFT_SCHEMA, normalizeDraft, analyzeScriptQuality, buildScriptSteps, normalizeTier } from './story-account-script.mjs'
import { buildStoryHookReference, STORY_THEMES, STORY_HOOKS, STORY_TRIGGERS } from './story-account-triggers.mjs'
import { MATERIAL_SOURCE_KINDS } from './story-account-materials.mjs'
import { runStoryMediaPipeline, buildStoryCover, readStoryCoverInfo, STORY_PIPELINE_STEPS } from './story-account-pipeline.mjs'
import { requestStoryVoicePreview, STORY_VOICE_RECIPES, STORY_VOICE_DEFAULT_RECIPE_ID } from './story-account-voice.mjs'
import { buildReviewPrompt, STORY_REVIEW_SCHEMA, mergeReview, buildTechnicalReport, runIndependentReview } from './story-account-qc.mjs'
import { DEFAULT_AUDIENCE } from './story-account-profile.mjs'

const UUID = /^[a-f0-9-]{36}$/iu
const GENERATION_LIMIT = 60

export class StoryContentError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function failure(code, message) { throw new StoryContentError(code, message) }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('STORY_ACCOUNT_INVALID_INPUT', `${label}必须是对象。`)
  return value
}

function uuid(value, label) {
  const text = String(value || '').trim()
  if (!UUID.test(text)) failure('STORY_ACCOUNT_INVALID_INPUT', `${label}无效。`)
  return text.toLowerCase()
}

function nowIso() { return new Date().toISOString() }

function clipped(value, maximum) {
  const text = String(value || '').trim()
  return text.length > maximum ? text.slice(0, maximum) : text
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > maximum) failure('STORY_ACCOUNT_INVALID_INPUT', `${label}长度不能超过 ${maximum}。`)
  return text
}

// 必填文本：空或超长都拒。generateCover / 凭据方法都靠它做输入校验。
function text(value, label, maximum) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > maximum) {
    throw failure('STORY_ACCOUNT_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  }
  return normalized
}

/* ------------------------------- 文件助手 ------------------------------- */

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    // 解析错误（SyntaxError / 文件损坏）必须显式上报，绝不能静默回退到 fallback
    // 把损坏数据替换成空白结构——那等于悄悄丢数据。
    if (error instanceof SyntaxError) throw failure('STORY_ACCOUNT_FILE_INVALID', `${path} 不是有效的 JSON，文件可能已损坏。`)
    throw error
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/* --------------------------------- 主机 --------------------------------- */

export class StoryAccountContent {
  constructor({ workspacePath, topicExecutor, scriptExecutor, profileExecutor, packageExecutor, reviewExecutor, harvestExecutor, sourceCollector, credentials, fetch: fetcher }) {
    this.workspacePath = workspacePath
    this.topicExecutor = topicExecutor
    this.scriptExecutor = scriptExecutor
    this.profileExecutor = profileExecutor
    // 发布资料与独立审片各用一份执行器：两者都要跟写稿的上下文隔离，
    // 否则审片会继承「作者视角」，看见的就不是观众看见的东西了。
    this.packageExecutor = packageExecutor || scriptExecutor
    this.reviewExecutor = reviewExecutor || topicExecutor
    // 采集用独立执行器：它要检索外部内容，与写稿/审片的上下文应当分开。
    this.harvestExecutor = harvestExecutor || topicExecutor
    // 真实采集源：出处由这里保证，不靠模型给链接。
    // 默认不启用——采集是要联网的，宿主没显式配就不该在后台偷偷发请求；
    // 没配时退回「模型自己找」的老路（那条路给出的出处常常不可核对）。
    this.sourceCollector = sourceCollector || null
    // 私有凭据库：密钥由宿主凭据服务按 ref 名存取，本包只持有服务句柄，永不持有密钥值。
    this.credentials = credentials || null
    this.fetch = fetcher
    this.topicGenerations = new Map()
    this.scriptGenerations = new Map()
    this.mediaGenerations = new Map()
    this.coverGenerations = new Map()
    this.harvestGenerations = new Map()
  }

  /* ------------------------------ 路径与读写 ------------------------------ */

  #contentPath(...segments) { return storyAccountDataPath(this.workspacePath, ...segments) }
  #profilePath() { return this.#contentPath('account.json') }
  #accountsPath() { return this.#contentPath('accounts.json') }
  #materialsPath() { return this.#contentPath('materials.json') }

  /* ------------------------------- 账号定位 ------------------------------- */

  /**
   * 单个默认定位 + 多个具名账号。
   *
   * 为什么两种都要：单账号的人只想填一次表单（profile），做矩阵的人需要按账号
   * 分别冻结定位（accounts）。两者读同一份 parseProfile，所以校验规则不会分叉。
   */
  async getProfile() {
    const raw = await readJson(this.#profilePath(), null)
    return raw ? parseProfile(raw) : emptyProfile()
  }

  async setProfile(request) {
    const profile = parseProfile(request)
    const saved = { ...profile, updatedAt: nowIso() }
    await writeJsonAtomic(this.#profilePath(), saved)
    return saved
  }

  async listAccounts() {
    const raw = await readJson(this.#accountsPath(), { schemaVersion: 1, items: [], defaultId: null })
    const items = Array.isArray(raw?.items) ? raw.items : []
    return { items, defaultId: typeof raw?.defaultId === 'string' ? raw.defaultId : null }
  }

  async #writeAccounts(data) { await writeJsonAtomic(this.#accountsPath(), { schemaVersion: 1, ...data }) }

  async createAccount(request) {
    const input = object(request, '创建账号请求')
    const profile = parseProfile(input)
    if (!hasProfile(profile)) failure('STORY_ACCOUNT_INVALID_INPUT', '账号至少需要填写账号名称或账号定位。')
    const data = await this.listAccounts()
    if (data.items.length >= 20) failure('STORY_ACCOUNT_INVALID_INPUT', '最多保存 20 个账号。')
    const account = {
      id: randomUUID(),
      name: profile.name || '未命名账号',
      revision: 1,
      positioning: profile.positioning,
      audience: profile.audience,
      themes: profile.themes,
      boundary: profile.boundary,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    const items = [account, ...data.items]
    await this.#writeAccounts({ items, defaultId: data.defaultId || account.id })
    return account
  }

  async #mutateAccount(id, mutate) {
    const data = await this.listAccounts()
    const target = uuid(id, '账号标识')
    const index = data.items.findIndex((item) => item.id === target)
    if (index < 0) failure('STORY_ACCOUNT_NOT_FOUND', '账号不存在。')
    const items = [...data.items]
    items[index] = mutate(items[index])
    await this.#writeAccounts({ items, defaultId: data.defaultId })
    return items[index]
  }

  async updateAccount(request) {
    const input = object(request, '更新账号请求')
    return this.#mutateAccount(input.id, (current) => {
      const profile = parseProfile(input)
      return {
        ...current,
        name: profile.name || current.name,
        positioning: profile.positioning,
        audience: profile.audience,
        themes: profile.themes,
        boundary: profile.boundary,
        // revision 递增：已经冻结进项目的快照不会跟着变，这里只影响后续新建的选题。
        revision: current.revision + 1,
        updatedAt: nowIso(),
      }
    })
  }

  async deleteAccount(request) {
    const input = object(request, '删除账号请求')
    const target = uuid(input.id, '账号标识')
    const data = await this.listAccounts()
    const items = data.items.filter((item) => item.id !== target)
    if (items.length === data.items.length) failure('STORY_ACCOUNT_NOT_FOUND', '账号不存在。')
    await this.#writeAccounts({ items, defaultId: data.defaultId === target ? (items[0]?.id || null) : data.defaultId })
    return { removed: target }
  }

  async setDefaultAccount(request) {
    const input = object(request, '设置默认账号请求')
    const target = uuid(input.id, '账号标识')
    const data = await this.listAccounts()
    if (!data.items.some((item) => item.id === target)) failure('STORY_ACCOUNT_NOT_FOUND', '账号不存在。')
    await this.#writeAccounts({ items: data.items, defaultId: target })
    return { defaultId: target }
  }

  /**
   * 定位补全：把用户的粗略草稿补成完整表单。只返回建议，不落库——
   * 定位是人对账号的判断，机器给的是草稿，保存必须由人点。
   */
  async suggestProfile(request) {
    if (!this.profileExecutor) failure('STORY_ACCOUNT_EXECUTOR_UNAVAILABLE', '当前环境不提供模型执行接缝，无法补全账号定位。')
    const input = parseCompletionInput(request)
    const structured = await this.profileExecutor({
      // agent 必须传：不传的话 subagents.start 拿不到父会话，DSH 内部读
      // agent.options 时会直接抛 "Cannot read properties of undefined"。
      // 传的是 { workspacePath }，执行器会自行用 withAgent 换成真父会话。
      agent: this.workspaceAgent,
      prompt: buildCompletionPrompt({ input }),
      schema: COMPLETION_SCHEMA,
    })
    return normalizeCompletion(structured, input)
  }

  /** 解析本次选题要用的账号快照：显式传入优先，否则用默认账号，再否则用单账号定位。 */
  async resolveAccount(accountId) {
    const data = await this.listAccounts()
    const target = accountId ? uuid(accountId, '账号标识') : data.defaultId
    if (target) {
      const found = data.items.find((item) => item.id === target)
      if (found) return parseAccountSnapshot(found)
    }
    const single = await this.getProfile()
    return hasProfile(single) ? { ...parseAccountSnapshot({ ...single, id: '00000000-0000-0000-0000-000000000000', revision: 1, name: single.name || '默认定位' }) } : null
  }

  /* -------------------------------- 素材 -------------------------------- */

  async listMaterials() {
    const raw = await readJson(this.#materialsPath(), emptyMaterialFile())
    return normalizeMaterialFile(raw)
  }

  async addMaterial(request) {
    const material = parseMaterial(request)
    const data = await this.listMaterials()
    const item = { id: randomUUID(), ...material, usedBy: [] }
    const items = [...data.items, item].slice(-500)
    await writeJsonAtomic(this.#materialsPath(), { schemaVersion: 1, items })
    return item
  }

  async deleteMaterial(request) {
    const input = object(request, '删除素材请求')
    const target = uuid(input.id, '素材标识')
    const data = await this.listMaterials()
    const items = data.items.filter((item) => item.id !== target)
    if (items.length === data.items.length) failure('STORY_ACCOUNT_NOT_FOUND', '素材不存在。')
    await writeJsonAtomic(this.#materialsPath(), { schemaVersion: 1, items })
    return { removed: target }
  }

  /* ------------------------------ 素材采集 ------------------------------ */

  /**
   * 让 agent 主动去找素材。
   *
   * 与所有其他生成任务同一套骨架：立即返回记录，后台跑，前端轮询。
   * 采集要检索、要读页面，比一次模型调用慢得多，所以更必须异步。
   *
   * 结果**不自动入库**：入库必须走 adoptHarvest，由人勾选确认。原因是素材是本包
   * 唯一事实来源，自动入库等于让模型产出的内容不经任何人过目就流进成片。
   */
  async startMaterialHarvest(request) {
    const input = parseHarvestInput(request)
    const id = randomUUID()
    const record = {
      id,
      kind: 'harvest',
      status: 'queued',
      error: null,
      steps: this.#steps(buildHarvestSteps()),
      items: [],
      summary: null,
      gaps: null,
      counts: null,
      sources: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.#record(this.harvestGenerations, id, record)
    void this.#runMaterialHarvest(id, input, request)
    return { id, status: 'queued', steps: record.steps }
  }

  async #runMaterialHarvest(id, input, request) {
    const record = this.harvestGenerations.get(id)
    if (!record) return
    record.status = 'running'
    record.updatedAt = nowIso()
    try {
      if (!this.harvestExecutor) failure('STORY_ACCOUNT_EXECUTOR_UNAVAILABLE', '当前环境不提供模型执行接缝，无法采集素材。')
      this.#setStep(record, 'scope', 'running')
      const account = await this.resolveAccount(request?.accountId)
      const existing = await this.listMaterials()
      this.#setStep(record, 'scope', 'done', `已有 ${existing.items.length} 条，避开重复`)

      // 先真实抓一轮：出处由采集层保证，agent 只做筛选与提炼。
      // 这一步失败不终止整轮——它只是退回「模型自己找」的旧路径。
      let candidates = []
      let sourceReport = []
      if (this.sourceCollector) {
        try {
          const collected = await this.sourceCollector({ limit: input.limit * 3, fetch: this.fetch })
          candidates = Array.isArray(collected?.items) ? collected.items : []
          sourceReport = Array.isArray(collected?.sources) ? collected.sources : []
        } catch (error) {
          sourceReport = [{ id: 'collection', name: '真实采集源', status: 'error', count: 0, error: String(error?.message || error).slice(0, 200) }]
        }
      }
      record.sources = sourceReport
      if (candidates.length) {
        this.#setStep(record, 'gather', 'running', `已真实抓取 ${candidates.length} 条候选素材`)
      }

      this.#setStep(record, 'gather', 'running')
      const structured = await this.harvestExecutor({
        agent: this.workspaceAgent,
        prompt: buildHarvestPrompt({
          input,
          profile: account,
          existing: existing.items.map((item) => item.title),
          candidates,
        }),
        schema: STORY_HARVEST_SCHEMA,
      })
      this.#setStep(record, 'gather', 'done', candidates.length ? `从 ${candidates.length} 条真实素材里筛出候选` : '由 agent 自行检索')

      this.#setStep(record, 'verify', 'running')
      const normalized = normalizeHarvest(structured, { existing: existing.items })
      record.items = normalized.items
      record.summary = normalized.summary
      record.gaps = normalized.gaps
      record.counts = { admitted: normalized.admitted, dropped: normalized.dropped, duplicate: normalized.duplicate, weak: normalized.weak }
      // 一条都没找到不是失败：agent 如实说「找不到」比交一份编造的强。
      // 但要把 gaps 顶到界面上，让人知道下一步该去哪补。
      this.#setStep(record, 'verify', 'done', summarizeHarvest(normalized))
      record.status = 'success'
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      const running = record.steps.find((step) => step.status === 'running')
      if (running) { running.status = 'failed'; running.detail = record.error }
    } finally {
      record.updatedAt = nowIso()
    }
  }

  async materialHarvestStatus(request) {
    const id = uuid(object(request, '素材采集状态请求').id, '任务标识')
    const record = this.harvestGenerations.get(id)
    if (!record) failure('STORY_ACCOUNT_NOT_FOUND', '素材采集记录不存在或已过期。')
    return record
  }

  /**
   * 采纳采集结果：把勾选的条目写入素材库。
   *
   * 这是采集与素材库之间唯一的入口，且必须由人发起。写入前再核一次来源地址与
   * 必填字段——采集侧已经核过，但这里是入库前最后一道，值得再核一次。
   */
  async adoptHarvest(request) {
    const id = uuid(object(request, '采纳素材请求').id, '任务标识')
    const record = this.harvestGenerations.get(id)
    if (!record) failure('STORY_ACCOUNT_NOT_FOUND', '素材采集记录不存在或已过期。')
    const wanted = Array.isArray(request?.indexes) ? [...new Set(request.indexes.filter((item) => Number.isSafeInteger(item)))] : null
    const chosen = wanted === null ? record.items : wanted.map((index) => record.items[index]).filter(Boolean)
    if (!chosen.length) failure('STORY_ACCOUNT_INVALID_INPUT', '没有选中任何素材。')

    const data = await this.listMaterials()
    const items = [...data.items]
    const added = []
    for (const item of chosen) {
      // 入库前再核一次：来源地址是这条素材以后唯一能被核对的东西。
      if (!item?.title || !item?.content || !/^https?:\/\//iu.test(String(item.sourceUrl || ''))) continue
      const record_ = {
        id: randomUUID(),
        title: item.title,
        content: item.content,
        kind: item.kind || 'other',
        sourceUrl: item.sourceUrl,
        note: item.note || null,
        capturedAt: new Date().toISOString(),
        usedBy: [],
      }
      items.push(record_)
      added.push(record_)
    }
    if (!added.length) failure('STORY_ACCOUNT_INVALID_INPUT', '选中的素材都缺少来源地址，未入库。')
    await writeJsonAtomic(this.#materialsPath(), { schemaVersion: 1, items: items.slice(-500) })
    return { added, count: added.length }
  }

  /** 素材被某条选题引用后记一次，发不上用场的素材一眼能看出来。 */
  async #markMaterialsUsed(materialIds, projectId) {
    if (!materialIds?.length) return
    const data = await this.listMaterials()
    const ids = new Set(materialIds)
    const items = data.items.map((item) => (ids.has(item.id) && !item.usedBy.includes(projectId)
      ? { ...item, usedBy: [...item.usedBy, projectId].slice(-20) }
      : item))
    await writeJsonAtomic(this.#materialsPath(), { schemaVersion: 1, items })
  }

  /* --------------------------- 生成任务通用骨架 --------------------------- */

  #record(store, id, record) {
    store.set(id, record)
    // 生成记录只用于看进度，按插入顺序裁掉最早的，避免长期占用内存。
    if (store.size > GENERATION_LIMIT) {
      const oldest = store.keys().next().value
      if (oldest) store.delete(oldest)
    }
  }

  #steps(steps) { return steps.map((step) => ({ ...step })) }

  #setStep(record, id, status, detail = null) {
    const step = record.steps.find((item) => item.id === id)
    if (step) {
      step.status = status
      step.detail = detail
    }
    record.updatedAt = nowIso()
  }

  /* -------------------------------- 选题 -------------------------------- */

  async startTopicGeneration(request) {
    const input = parseTopicInput(request)
    const id = randomUUID()
    const record = {
      id,
      kind: 'topic',
      status: 'queued',
      step: null,
      error: null,
      steps: this.#steps(buildTopicSteps()),
      candidates: [],
      summary: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.#record(this.topicGenerations, id, record)
    void this.#runTopicGeneration(id, input, request)
    return { id, status: 'queued', steps: record.steps }
  }

  async #runTopicGeneration(id, input, request) {
    const record = this.topicGenerations.get(id)
    if (!record) return
    record.status = 'running'
    record.updatedAt = nowIso()
    try {
      if (!this.topicExecutor) failure('STORY_ACCOUNT_EXECUTOR_UNAVAILABLE', '当前环境不提供模型执行接缝，无法生成选题。')
      this.#setStep(record, 'assemble', 'running')
      const materialFile = await this.listMaterials()
      const material = assembleMaterial({ pickedIds: input.materialIds, items: materialFile.items })
      const account = await this.resolveAccount(request?.accountId)
      const recentTitles = Array.isArray(request?.avoidTitles) ? request.avoidTitles : []
      this.#setStep(record, 'assemble', 'done', `素材 ${material.materials.length} 条`)

      this.#setStep(record, 'generate', 'running')
      const structured = await this.topicExecutor({
        agent: this.workspaceAgent,
        prompt: buildTopicPrompt({ input, material, profile: account, recentTitles }),
        schema: STORY_CANDIDATES_SCHEMA,
      })
      this.#setStep(record, 'generate', 'done')

      this.#setStep(record, 'normalize', 'running')
      const normalized = normalizeCandidates(structured, material)
      if (!normalized.candidates.length) {
        failure('STORY_ACCOUNT_GENERATION_REJECTED', '生成的候选都缺少具体场景或关键对白，已全部丢弃。请补充素材后重试。')
      }
      if (account) record.account = account
      record.candidates = normalized.candidates
      record.summary = normalized.summary
      this.#setStep(record, 'normalize', 'done', `${normalized.candidates.length} 个可用候选`)
      record.status = 'success'
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      const running = record.steps.find((step) => step.status === 'running')
      if (running) { running.status = 'failed'; running.detail = record.error }
    } finally {
      record.updatedAt = nowIso()
    }
  }

  async topicGenerationStatus(request) {
    const id = uuid(object(request, '选题生成状态请求').id, '生成标识')
    const record = this.topicGenerations.get(id)
    if (!record) failure('STORY_ACCOUNT_NOT_FOUND', '选题生成记录不存在或已过期。')
    return record
  }

  async listGenerations() {
    const sort = (map) => [...map.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20)
    return {
      topics: sort(this.topicGenerations),
      scripts: sort(this.scriptGenerations),
      media: sort(this.mediaGenerations),
      covers: sort(this.coverGenerations),
      harvests: sort(this.harvestGenerations),
    }
  }

  /* ------------------------------ 媒体流水线 ------------------------------ */

  /**
   * 起一条媒体流水线任务（配音 → 字幕 → 渲染 → 质检 → 审片）。
   *
   * 与选题/写稿的生成记录同一套骨架：立即返回记录，后台跑，前端轮询状态。
   * 差别在于这条链会真的调用 ffmpeg 与 Remotion，一次要几十秒到几分钟，
   * 所以更要异步——把浏览器卡住等渲染是不可接受的。
   */
  async startMediaPipeline(request) {
    if (!this.projectsStore) failure('STORY_ACCOUNT_NOT_READY', '项目存储尚未就绪。')
    const input = object(request, '媒体流水线请求')
    const projectId = uuid(input.projectId, '项目标识')
    const id = randomUUID()
    const record = {
      id,
      kind: 'media',
      projectId,
      status: 'queued',
      error: null,
      steps: this.#steps(STORY_PIPELINE_STEPS.map((step) => ({ ...step, status: 'pending', detail: null }))),
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.#record(this.mediaGenerations, id, record)
    this.#runMediaPipeline(id, { projectId, voice: input.voice, palette: input.palette, subtitleMaxChars: input.subtitleMaxChars })
      .catch((error) => {
        record.status = 'failed'
        record.error = error instanceof Error ? error.message : String(error)
        record.updatedAt = nowIso()
      })
    return record
  }

  async mediaPipelineStatus(request) {
    const id = uuid(object(request, '媒体流水线状态请求').id, '任务标识')
    const record = this.mediaGenerations.get(id)
    if (!record) failure('STORY_ACCOUNT_NOT_FOUND', '媒体流水线记录不存在或已过期。')
    return record
  }

  async #runMediaPipeline(id, input) {
    const record = this.mediaGenerations.get(id)
    if (!record) return
    record.status = 'running'
    record.updatedAt = nowIso()
    try {
      const result = await runStoryMediaPipeline({
        store: this.projectsStore,
        agent: this.workspaceAgent,
        projectId: input.projectId,
        voice: input.voice,
        palette: input.palette,
        subtitleMaxChars: input.subtitleMaxChars,
        reviewVideo: this.#reviewVideo,
      })
      record.result = result
      record.steps = result.steps
      record.status = result.status === 'failed' ? 'failed' : 'success'
      if (result.status === 'failed') record.error = (result.blockers || []).join(' ') || '流水线未通过。'
      record.updatedAt = nowIso()
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      const running = record.steps.find((step) => step.status === 'running')
      if (running) { running.status = 'failed'; running.detail = record.error }
      record.updatedAt = nowIso()
    }
  }

  /**
   * 独立审片子会话。
   *
   * 刻意用**一份全新的执行器**、并只喂画面证据与受众描述，不把写稿上下文
   * 带进来。作者视角会本能地为自己的作品辩护；双闸门要的恰恰是不带感情的
   * 那双眼睛。
   */
  async #reviewVideo({ workspacePath, videoFile, sampledTimestamps = [], topic, script, technicalReportFile = null, durationSeconds = null }) {
    if (!this.reviewExecutor) failure('STORY_ACCOUNT_NOT_READY', '缺少独立审片执行器。')
    // 独立审片会话现在真的会去抽帧、把画面证据交给子会话看图，并据此判通过。
    // 之前这里不抽帧、还垫一份「技术恒过」，是 P0 假闸门的来源。
    return runIndependentReview({
      reviewExecutor: (args) => this.reviewExecutor({ agent: this.workspaceAgent, ...args }),
      workspacePath,
      videoFile,
      sampledTimestamps,
      topic,
      script,
      technicalReportFile,
      durationSeconds,
    })
  }

  /* ------------------------------ 媒体凭据 ------------------------------ */

  /**
   * 媒体服务凭据状态。本包不持有密钥本身，密钥在宿主的私有凭据库里，按 ref 名存取。
   * 这里的 ref 与通用口播包（spoken-video）逐字节一致，因为用的是同一套后端密钥。
   * 返回里永远不含密钥值。
   */
  async getMediaCredentialStatus(request) {
    const input = object(request, '凭据状态请求')
    const provider = text(input.provider, '生成方式', 32)
    const ref = mediaCredentialRef(provider)
    const service = this.#credentialService()
    if (typeof service.describe !== 'function') throw new StoryContentError('STORY_ACCOUNT_CREDENTIAL_UNAVAILABLE', '当前环境不支持读取连接状态。')
    const status = await service.describe(ref)
    return { provider, configured: status?.configured === true, source: status?.source || null, writable: status?.writable === true }
  }

  /** 保存 API Key：只写进私有凭据库，永不回传。 */
  async saveMediaCredential(request) {
    const input = object(request, '保存凭据请求')
    const provider = text(input.provider, '生成方式', 32)
    const ref = mediaCredentialRef(provider)
    const apiKey = input.apiKey === undefined || input.apiKey === null || (typeof input.apiKey === 'string' && !input.apiKey.trim())
      ? null
      : text(input.apiKey, 'API Key', 512)
    if (!apiKey) throw new StoryContentError('STORY_ACCOUNT_INVALID_INPUT', '保存 API Key 不能为空。')
    await this.#credentialService().set(ref, apiKey)
    return { provider, configured: true }
  }

  /** 清除 API Key。 */
  async clearMediaCredential(request) {
    const input = object(request, '清除凭据请求')
    const provider = text(input.provider, '生成方式', 32)
    const ref = mediaCredentialRef(provider)
    await this.#credentialService().unset(ref)
    return { provider, configured: false }
  }

  #credentialService() {
    if (!this.credentials || typeof this.credentials.resolve !== 'function') {
      throw new StoryContentError('STORY_ACCOUNT_CREDENTIAL_UNAVAILABLE', '当前环境不提供私有凭据服务。')
    }
    return this.credentials
  }

  /* -------------------------------- 封面 -------------------------------- */

  /**
   * 生成封面：立即返回任务标识与状态，渲染（ffmpeg 可能几十秒）在后台跑，
   * 由 coverStatus 轮询。不再同步等 ffmpeg 跑完才返回。
   */
  async generateCover(request) {
    const input = object(request, '封面请求')
    const projectId = uuid(input.projectId, '项目标识')
    const headline = text(input.headline, '封面大字', 40)
    const id = randomUUID()
    const record = { id, kind: 'cover', projectId, status: 'queued', error: null, cover: null, createdAt: nowIso(), updatedAt: nowIso() }
    this.#record(this.coverGenerations, id, record)
    void this.#runCoverGeneration(id, { projectId, headline, palette: input.palette })
    return { id, status: 'queued', projectId, createdAt: record.createdAt }
  }

  async #runCoverGeneration(id, { projectId, headline, palette }) {
    const record = this.coverGenerations.get(id)
    if (!record) return
    record.status = 'running'
    record.updatedAt = nowIso()
    try {
      const cover = await buildStoryCover({ workspacePath: this.workspacePath, projectId, headline, palette })
      record.cover = cover
      record.status = cover.applied ? 'success' : 'failed'
      if (!cover.applied) record.error = `封面没有生成：${cover.reason}`
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
    }
    record.updatedAt = nowIso()
  }

  /**
   * 封面任务状态：有内存任务记录时直接返回（含进行中/成功/失败与失败原因），
   * 任务记录丢了（如重启）则回退到落盘文件，保证发布页永远能看到封面是否就绪。
   */
  async coverStatus(request) {
    const input = object(request, '封面状态请求')
    const id = input.id ? uuid(input.id, '任务标识') : null
    if (id && this.coverGenerations.has(id)) {
      const record = this.coverGenerations.get(id)
      return { id: record.id, projectId: record.projectId, status: record.status, error: record.error, cover: record.cover }
    }
    // 兜底：内存任务记录丢了就从落盘文件读，保留「封面是否生成」的事实。
    return readStoryCoverInfo({ workspacePath: this.workspacePath, projectId: uuid(input.projectId, '项目标识') })
  }

  /* -------------------------------- 写稿 -------------------------------- */

  async startScriptGeneration(request) {
    const input = parseScriptGenerationInput(request)
    const id = randomUUID()
    const record = {
      id,
      kind: 'script',
      projectId: input.projectId,
      status: 'queued',
      error: null,
      steps: this.#steps(buildScriptSteps()),
      draft: null,
      quality: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.#record(this.scriptGenerations, id, record)
    void this.#runScriptGeneration(id, input)
    return { id, status: 'queued', steps: record.steps }
  }

  async #runScriptGeneration(id, input) {
    const record = this.scriptGenerations.get(id)
    if (!record) return
    record.status = 'running'
    record.updatedAt = nowIso()
    try {
      if (!this.scriptExecutor) failure('STORY_ACCOUNT_EXECUTOR_UNAVAILABLE', '当前环境不提供模型执行接缝，无法生成稿件。')
      this.#setStep(record, 'assemble', 'running')
      // 选题与素材都从项目产物里取——写稿依据的是冻结下来的那一版，不是当前表单。
      const project = await this.projectsStore.get(this.workspaceAgent, { projectId: input.projectId })
      const topic = project.artifacts.topic?.data
      if (!topic) failure('STORY_ACCOUNT_STAGE_BLOCKED', '项目还没有选题，无法写稿。')
      const topicMaterials = Array.isArray(topic.materialIds) ? topic.materialIds : []
      const materialFile = await this.listMaterials()
      const material = assembleMaterial({ pickedIds: topicMaterials, items: materialFile.items })
      this.#setStep(record, 'assemble', 'done', `素材 ${material.materials.length} 条`)

      this.#setStep(record, 'generate', 'running')
      const structured = await this.scriptExecutor({
        agent: this.workspaceAgent,
        prompt: buildScriptPrompt({
          input,
          topic,
          materials: material.materials,
          profile: topic.account || null,
          currentBody: input.mode === 'polish' ? project.artifacts.script?.data?.body || null : null,
          hookReference: buildStoryHookReference(),
        }),
        schema: STORY_DRAFT_SCHEMA,
      })
      this.#setStep(record, 'generate', 'done')

      this.#setStep(record, 'normalize', 'running')
      const normalized = normalizeDraft(structured)
      if (!normalized.usable) failure('STORY_ACCOUNT_GENERATION_REJECTED', '模型没有返回可用的稿件正文。')
      this.#setStep(record, 'normalize', 'done')

      this.#setStep(record, 'quality', 'running')
      const corpus = await this.projectsStore.scriptCorpus(this.workspaceAgent, { excludeProjectId: input.projectId })
      const quality = analyzeScriptQuality({
        title: normalized.draft.title || topic.title,
        body: normalized.draft.script,
        tier: input.tier,
        topic,
        corpus,
      })
      record.quality = quality
      // 质检不通过不抛错：稿子要回给用户看、要能看到具体哪几条不过，而不是一个
      // 红叉。落库那一步会再拦一次（store.commit 里的反塑料感硬闸门）。
      this.#setStep(record, 'quality', quality.passed ? 'done' : 'failed', quality.passed ? '通过' : `${quality.blockers.length} 条硬拦项`)

      record.draft = { ...normalized.draft, materialIds: normalized.draft.materialIds.filter((materialId) => material.materials.some((item) => item.id === materialId)) }
      record.status = 'success'
      record.updatedAt = nowIso()
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      const running = record.steps.find((step) => step.status === 'running')
      if (running) { running.status = 'failed'; running.detail = record.error }
      record.updatedAt = nowIso()
    }
  }

  async scriptGenerationStatus(request) {
    const id = uuid(object(request, '写稿生成状态请求').id, '生成标识')
    const record = this.scriptGenerations.get(id)
    if (!record) failure('STORY_ACCOUNT_NOT_FOUND', '写稿生成记录不存在或已过期。')
    return record
  }

  /* -------------------------------- 目录 -------------------------------- */

  async overview() {
    const materials = await this.listMaterials()
    const profile = await this.getProfile()
    return {
      profile,
      materialCount: materials.items.length,
      materialWithSource: materials.items.filter((item) => item.sourceUrl).length,
      themes: STORY_THEMES.map((theme) => ({ id: theme.id, name: theme.name })),
      hooks: STORY_HOOKS.map((hook) => ({ id: hook.id, name: hook.name })),
      triggers: STORY_TRIGGERS.map((trigger) => ({ id: trigger.id, name: trigger.name })),
      sourceKinds: MATERIAL_SOURCE_KINDS.map((kind) => ({ id: kind.id, label: kind.label })),
    }
  }

  catalog() {
    return {
      themes: STORY_THEMES,
      hooks: STORY_HOOKS,
      triggers: STORY_TRIGGERS,
      sourceKinds: MATERIAL_SOURCE_KINDS,
      tiers: [
        { id: 'short', label: '快节奏', seconds: '45-60' },
        { id: 'standard', label: '标准', seconds: '60-80' },
        { id: 'long', label: '慢叙述', seconds: '80-110' },
      ],
      defaultTier: normalizeTier(null),
      // 声音方案：界面直接渲染成卡片，用户选一张即配好音色/语气/语速。
      voiceRecipes: STORY_VOICE_RECIPES.map((recipe) => ({
        id: recipe.id,
        label: recipe.label,
        hint: recipe.hint,
        summary: recipe.summary,
        rate: recipe.rate,
      })),
      defaultVoiceRecipeId: STORY_VOICE_DEFAULT_RECIPE_ID,
    }
  }

  /* -------------------------------- 试听 -------------------------------- */

  /**
   * 试听某个声音方案：真去云端合一段再回传音频地址。
   *
   * 界面上的「试听」必须能证明这声音真的可用——音色名写对了但 Key 没额度、
   * 描述写得不对，只有真合成一次才会暴露。
   */
  async previewVoice(request) {
    const input = request ? object(request, '试听请求') : {}
    return requestStoryVoicePreview({
      recipeId: optionalText(input.recipeId, '声音方案', 60),
      model: optionalText(input.model, '合成模型', 60),
      voiceId: optionalText(input.voiceId, '音色标识', 160),
      style: optionalText(input.style, '语气', 200),
      voiceDesign: optionalText(input.voiceDesign, '音色描述', 500),
    })
  }

  /** 供提示词预览与调试使用：把账号定位拼成下游提示词读的那几行。 */
  profilePreview(profile) { return profileLines(profile) || [] }

  /** store 由 index 注入，避免两处各建一份导致写入串行化失效。 */
  attachProjects(store, agent) {
    this.projectsStore = store
    this.workspaceAgent = agent
  }
}
