/**
 * 手动稿件成片 · 润色服务
 *
 * 「口播视频内容创作」的写稿是 AI 从选题和信号里起稿；这里的稿件是用户自己写的，
 * 所以这条链路的边界完全不同：
 *
 * - AI 是**编辑**，不是作者。它只改表达（口语化、节奏、朗读适配、标点、去黑话），
 *   不新增事实、不删除信息点、不改观点、不改结论。
 * - 用户稿件是唯一事实来源。原稿短就短，AI 不许为了凑篇幅扩写。
 *
 * 质检与口播包共用同一套确定性检查（同一个 analyzeScriptQuality），这样
 * 「手动稿」和「AI 稿」的分数是同一把尺，用户不会看到两套口径。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { analyzeScriptQuality, checkPlainLanguage } from '../spoken-video/spoken-video-script.mjs'
import { dshTrace } from '../spoken-video/spoken-video-dsh-trace.mjs'

const BODY_MAX = 30_000
const TITLE_MAX = 160
const INSTRUCTION_MAX = 500
const CHANNEL_MAX = 80
const TIER_IDS = new Set(['short', 'medium', 'long'])
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const RECORD_LIMIT = 60

function fail(message) { return new Error(`手动稿件：${message}`) }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label}必须是对象。`)
  return value
}
function text(value, label, max, required = true) {
  if ((value === undefined || value === null) && !required) return undefined
  if (typeof value !== 'string') throw fail(`${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > max) throw fail(`${label}长度必须在 1-${max} 之间。`)
  return result
}
function optionalText(value, label, max) {
  return value == null || (typeof value === 'string' && !value.trim()) ? null : text(value, label, max)
}
function uuid(value, label) {
  const result = text(value, label, 36)
  if (!/^[a-f0-9-]{36}$/iu.test(result)) throw fail(`${label}无效。`)
  return result.toLowerCase()
}
function now() { return new Date().toISOString() }
function elapsed(start, end) {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * 润色输出的结构化契约。
 *
 * 与口播包的写稿 schema 不同：这里没有 outline / factCheckItems / sourceBoundary
 * ——那些字段是为「AI 从零起稿」设计的（需要自己找事实、自己列待核实项）。
 * 用户自己写的稿子，事实由用户负责，AI 只需要交代**它改了什么**和**哪里需要人工确认**。
 */
export const MANUAL_POLISH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string', description: '稿件标题：保持用户原标题，除非原标题明显不通顺' },
    script: { type: 'string', description: '润色后的完整口播稿正文（纯正文，不要标题、不要 markdown）' },
    changes: { type: 'array', items: { type: 'string' }, description: '这次润色做了哪些改动，每条一句话，3-6 条' },
    warnings: { type: 'array', items: { type: 'string' }, description: '需要人工确认的地方（读起来可能变了原意、事实存疑等），没有就空数组' },
  },
  required: ['script'],
})

function cleanList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .map((item) => (item.length > maxChars ? `${item.slice(0, maxChars - 1)}…` : item))
    .slice(0, maxItems)
}

/** 把模型返回的结构化结果收敛成一份可保存、可展示的润色稿。 */
export function normalizePolish(structured) {
  const body = typeof structured?.script === 'string' ? structured.script.trim() : ''
  return {
    usable: Boolean(body) && body.length <= BODY_MAX,
    draft: {
      title: typeof structured?.title === 'string' && structured.title.trim() ? structured.title.trim().slice(0, TITLE_MAX) : null,
      script: body ? body.slice(0, BODY_MAX) : body,
      changes: cleanList(structured?.changes, 8, 200),
      warnings: cleanList(structured?.warnings, 8, 200),
    },
  }
}

/**
 * 润色提示词。
 *
 * 这里最重要的不是文笔，是**边界**。模型拿到用户原稿后最常见的三种越界：
 * 为了"更完整"补事实、为了"更顺"改观点、为了"更专业"加术语。
 * 所以铁律写在最前面，并且明确给出"不确定就照原样保留"这条退路。
 */
export function buildPolishPrompt({ title, body, instructions, channel, tier }) {
  const chars = Array.from(body.replace(/\s+/g, '')).length
  const plain = checkPlainLanguage(body)
  const sections = []
  sections.push([
    '你是口播稿件的润色编辑。下面这份稿件由用户自己写好，**它就是唯一的事实来源**。',
    '你的任务是让它「念出来更好听」，不是「重写一篇」。',
  ].join('\n'))

  const rules = [
    '【铁律，违反任何一条都算失败】',
    '1. 不得新增原稿没有的事实、数据、案例、人物、经历或结论。需要举例时，只能用原稿里已有的例子换个说法。',
    '2. 不得删除原稿已有的信息点，也不得改变原稿的观点、立场与判断。原稿说什么就是什么。',
    '3. 只改表达：口语化、句子节奏、朗读适配、标点与呼吸、去掉书面腔和行业黑话。',
    '4. 保留原稿的结构骨架与顺序。可以把开场第一句改得更抓人，但不得改变后面的论证与结论。',
    `5. 篇幅与原稿相当（±10%，原稿约 ${chars} 字）。原稿短就短，不要为了凑字数扩写，也不要压缩掉细节。`,
    '6. 不确定的写法照原样保留，不要"顺手修正"事实或数字。',
    '7. 不要输出标题、markdown、解释文字；script 字段只放正文。',
  ]
  if (tier) {
    const label = { short: '短篇（300-999 字）', medium: '中篇（1000-2499 字）', long: '长篇（2500 字以上）' }[tier]
    rules.push(`8. 稿件被标为${label}档。仍以原稿篇幅为准，不要为了凑档位扩写。`)
  }
  rules.push([
    '【朗读适配：与质检同一把尺】',
    '- 单句不超过 25 字（按句号/问号/叹号计）。更长的语义单元用逗号切开，给配音留呼吸位。',
    '- 数字后面要有标点或量词（如「10月17日，」），不要让数字和后面的词粘连。',
    '- 英文缩写或术语首次出现前后留标点，避免贴着汉字念。',
    '- 第一句不能出现「视频」「这期」「今天」这类元指代，直接进入内容本身。',
  ].join('\n'))
  if (plain.hits.length) {
    rules.push([
      '【原稿里检测到行业黑话，润色时必须逐处改掉（保留事实与结构，只换说法）】',
      plain.hits.map((item) => `- 「${item.term}」→ ${item.plain}${item.sentence ? `（原句：${item.sentence}）` : ''}`).join('\n'),
    ].join('\n'))
  }
  if (channel) rules.push(`【发布渠道】${channel}。语气与称呼按这个渠道的调性走，但不要加入原稿没有的信息。`)
  if (instructions) rules.push(`【用户额外要求】${instructions}`)
  sections.push(rules.join('\n'))

  sections.push([
    '【输出】',
    '- title：保持用户原标题；原标题通顺就原样返回。',
    '- script：润色后的完整正文。',
    '- changes：这次改了什么，3-6 条，每条一句话（例如「把两个长句拆开，给配音留呼吸」）。',
    '- warnings：需要人工确认的地方（例如「第二段的举例改写后可能偏离原意」）；没有就返回空数组。',
  ].join('\n'))

  sections.push(`【原稿标题】${title || '（未填写）'}`)
  sections.push(`【原稿正文】\n${body}`)
  return sections.join('\n\n')
}

function steps() {
  return [
    { id: 'read', label: '读取当前稿件', status: 'pending', detail: '' },
    { id: 'polish', label: 'AI 润色', status: 'pending', detail: '' },
    { id: 'quality', label: '确定性质检', status: 'pending', detail: '' },
    { id: 'save', label: '保存为当前稿件', status: 'pending', detail: '' },
  ]
}

async function readJson(path, fallback) {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink()) throw fail('数据文件无效。')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback()
    if (error instanceof SyntaxError) throw fail('数据文件不是有效 JSON。')
    throw error
  }
}

async function writeJson(path, value) {
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

async function workspaceFor(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw fail('需要已加载的能力包专属工作区。')
  return cwd
}

/**
 * 润色服务。
 *
 * 一次只跑一个润色任务（同一工作区串行）：润色要读稿件正文再改写，
 * 两个任务同时改同一篇稿件必然打架；用户也不会同时润色两篇。
 */
export class ManualPolishService {
  constructor(options = {}) {
    this.background = options.background || ((work) => work)
    this.executor = typeof options.executor === 'function' ? options.executor : null
    this.projectsStore = options.projectsStore || null
    this.now = options.now || now
    this.writes = new Map()
    this.queues = new Map()
    this.running = new Set()
  }

  async serial(workspace, operation) {
    const previous = this.writes.get(workspace) || Promise.resolve()
    const result = previous.then(operation)
    const tail = result.catch(() => {})
    this.writes.set(workspace, tail)
    try { return await result } finally { if (this.writes.get(workspace) === tail) this.writes.delete(workspace) }
  }

  async paths(agent) {
    const workspace = await workspaceFor(agent)
    return { workspace, records: join(workspace, 'data', 'manual-polish.json') }
  }

  async readRecords(path) {
    const data = await readJson(path, () => ({ records: [] }))
    return { records: Array.isArray(data?.records) ? data.records : [] }
  }

  async mutate(path, id, mutate) {
    return this.serial(path, async () => {
      const data = await this.readRecords(path)
      const record = data.records.find((item) => item.id === id)
      if (!record) return null
      mutate(record)
      await writeJson(path, data)
      return record
    })
  }

  /** 确定性质检：与口播包同一把尺，用户看到的分数口径一致。 */
  async analyze(agent, request) {
    const input = object(request ?? {}, '质检请求')
    const body = text(input.body, '稿件正文', BODY_MAX)
    const tier = TIER_IDS.has(input.tier) ? input.tier : 'medium'
    const title = optionalText(input.title, '稿件标题', TITLE_MAX) || ''
    const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? uuid(input.projectId, '项目标识') : null
    const corpus = this.projectsStore
      ? await this.projectsStore.listScriptCorpus(agent, { excludeProjectId: projectId }).catch(() => [])
      : []
    return analyzeScriptQuality({ title, body, tier, corpus })
  }

  async list(agent) {
    const { records } = await this.paths(agent)
    const data = await this.readRecords(records)
    return [...data.records].sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
  }

  async status(agent, request) {
    const input = object(request ?? {}, '润色状态请求')
    const id = uuid(input.id, '润色任务标识')
    const { records } = await this.paths(agent)
    const data = await this.readRecords(records)
    const record = data.records.find((item) => item.id === id)
    if (!record) throw fail('润色任务不存在。')
    return record
  }

  /**
   * 提交一次润色。
   *
   * 立刻返回任务 id，正文改写交给后台 DSH 任务；完成后自动保存为当前稿件版本。
   */
  async start(agent, request) {
    const input = object(request ?? {}, '润色请求')
    const projectId = uuid(input.projectId, '项目标识')
    const instructions = optionalText(input.instructions, '润色要求', INSTRUCTION_MAX)
    const channel = optionalText(input.channel, '发布渠道', CHANNEL_MAX)
    const tier = TIER_IDS.has(input.tier) ? input.tier : 'medium'
    if (!this.projectsStore) throw fail('润色需要项目存储。')
    if (typeof this.executor !== 'function') throw fail('润色执行器未接入。')

    const { workspace, records } = await this.paths(agent)
    const detail = await this.projectsStore.get(agent, { projectId })
    const body = detail.artifacts?.script?.data?.body
    if (typeof body !== 'string' || !body.trim()) throw fail('当前稿件还没有正文，无法润色。')
    if (Number.isSafeInteger(input.expectedRevision) && input.expectedRevision !== detail.revision) {
      throw fail('稿件已被其他操作更新，请刷新后重试。')
    }
    const active = (await this.readRecords(records)).records
      .find((item) => item.projectId === projectId && ACTIVE_STATUSES.has(item.status))
    if (active) throw fail('这个稿件已有一轮润色在进行，请等它结束。')

    const title = detail.title || ''
    const prompt = buildPolishPrompt({ title, body, instructions, channel, tier })
    const id = randomUUID()
    const startedAt = this.now()
    const record = {
      id,
      projectId,
      projectTitle: detail.title,
      status: 'queued',
      startedAt,
      queuedAt: startedAt,
      completedAt: null,
      elapsedMs: null,
      tier,
      instructions,
      channel,
      steps: steps(),
      expectedRevision: detail.revision,
      scriptRevision: null,
      appliedAt: null,
      sourceSnapshot: { title, body, revision: detail.revision },
      result: null,
      quality: null,
      dsh: dshTrace(),
      error: null,
    }
    await this.serial(workspace, async () => {
      const data = await this.readRecords(records)
      if (data.records.some((item) => item.projectId === projectId && ACTIVE_STATUSES.has(item.status))) {
        throw fail('这个稿件已有一轮润色在进行，请等它结束。')
      }
      data.records = [...data.records, record].slice(-RECORD_LIMIT)
      await writeJson(records, data)
    })
    this.enqueue(workspace, { records, id, prompt, agent, projectId, title })
    return { id }
  }

  enqueue(workspace, job) {
    const queue = this.queues.get(workspace) || []
    queue.push(job)
    this.queues.set(workspace, queue)
    this.drain(workspace)
  }

  drain(workspace) {
    if (this.running.has(workspace)) return
    const queue = this.queues.get(workspace) || []
    const job = queue.shift()
    if (!job) { this.queues.delete(workspace); return }
    this.running.add(workspace)
    this.background(this.run(job).catch(() => {}).finally(() => {
      this.running.delete(workspace)
      this.drain(workspace)
    }))
  }

  async run({ records, id, prompt, agent, projectId, title }) {
    await this.mutate(records, id, (record) => {
      record.status = 'running'
      record.startedAt = record.startedAt || this.now()
      record.steps[0].status = 'done'
      record.steps[0].detail = `已读取当前稿件（${Array.from(record.sourceSnapshot.body.replace(/\s+/g, '')).length} 字）`
      record.steps[1].status = 'running'
    })
    let structured
    try {
      structured = await this.executor({
        prompt,
        schema: MANUAL_POLISH_SCHEMA,
        agent,
        onDshStarted: (run) => { void this.mutate(records, id, (record) => { record.dsh = { ...(record.dsh || {}), ...run } }).catch(() => {}) },
        onDshEvent: (event) => { void this.mutate(records, id, (record) => { record.dsh = { ...(record.dsh || {}), lastEvent: event } }).catch(() => {}) },
      })
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500)
      await this.mutate(records, id, (record) => {
        record.status = 'failed'
        record.steps[1].status = 'error'
        record.steps[1].detail = message
        record.error = message
        record.completedAt = this.now()
        record.elapsedMs = elapsed(record.startedAt, record.completedAt)
      })
      return
    }
    const normalized = normalizePolish(structured)
    if (!normalized.usable) {
      await this.mutate(records, id, (record) => {
        record.status = 'failed'
        record.steps[1].status = 'error'
        record.steps[1].detail = '模型未返回可用的稿件正文'
        record.error = '模型未返回可用的稿件正文。'
        record.completedAt = this.now()
        record.elapsedMs = elapsed(record.startedAt, record.completedAt)
      })
      return
    }
    const polished = normalized.draft.script
    await this.mutate(records, id, (record) => {
      record.steps[1].status = 'done'
      record.steps[1].detail = `返回 ${Array.from(polished.replace(/\s+/g, '')).length} 字润色稿`
      record.steps[2].status = 'running'
    })

    // 质检是建议性的：失败不能把一次成功的润色判死。
    let quality = null
    try {
      const corpus = this.projectsStore ? await this.projectsStore.listScriptCorpus(agent, { excludeProjectId: projectId }).catch(() => []) : []
      quality = analyzeScriptQuality({ title: normalized.draft.title || title || '', body: polished, tier: 'medium', corpus })
    } catch (_) { /* advisory only */ }
    await this.mutate(records, id, (record) => {
      record.steps[2].status = quality ? 'done' : 'error'
      record.steps[2].detail = quality ? `质检 ${quality.qualityScore} 分（${quality.verdict}）` : '质检不可用'
      record.quality = quality
      record.steps[3].status = 'running'
      record.steps[3].detail = '正在保存为当前稿件版本'
    })

    let committed
    try {
      const current = await this.projectsStore.get(agent, { projectId })
      committed = await this.projectsStore.commit(agent, {
        projectId,
        expectedRevision: current.revision,
        stage: 'script',
        payload: { body: polished },
        idempotencyKey: `manual-polish-${id}`,
      })
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500)
      await this.mutate(records, id, (record) => {
        record.status = 'failed'
        record.steps[3].status = 'error'
        record.steps[3].detail = `保存失败：${message}`
        record.error = `润色完成，但未能保存为当前稿件：${message}`
        record.completedAt = this.now()
        record.elapsedMs = elapsed(record.startedAt, record.completedAt)
      })
      return
    }
    await this.mutate(records, id, (record) => {
      record.status = 'succeeded'
      record.steps[3].status = 'done'
      record.steps[3].detail = `已保存为项目版本 ${committed.project.revision}`
      record.result = { ...normalized.draft, script: polished }
      record.scriptRevision = committed.artifact.revision
      record.appliedAt = this.now()
      record.completedAt = record.appliedAt
      record.elapsedMs = elapsed(record.startedAt, record.completedAt)
    })
  }
}
