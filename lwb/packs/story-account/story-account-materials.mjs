/**
 * 故事素材层：把「真实素材」做成可追溯的一等公民。
 *
 * 为什么这一层是这个包和通用口播包最大的分野：
 * 通用包的素材是热点信号，事实由信号兜底。情感故事的事实兜底只有素材——
 * 一旦模型凭空编一个「我爸说你是女儿你多出点」，观众听不出来，但账号在用
 * 编造的具体细节冒充真实经历，这是本赛道最贵的一种风险。
 *
 * 所以素材不是「参考」，是**唯一事实来源**：每条素材带来源类型、可追溯地址
 * 与可信度；写稿时逐条注入，编造必须写进「无素材支撑」清单，质检层据此拦截。
 */

const SOURCE_KINDS = new Set(['news-comment', 'qa-answer', 'personal', 'field-note', 'other'])
const TEXT_MAX = 6000
const TITLE_MAX = 160

export class StoryMaterialError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(message) { throw new StoryMaterialError('STORY_MATERIAL_INVALID_INPUT', `故事素材：${message}`) }

function text(value, label, maximum) {
  if (typeof value !== 'string') fail(`${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > maximum) fail(`${label}长度必须在 1-${maximum} 之间。`)
  return result
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail(`${label}必须是文本。`)
  const result = value.trim()
  if (!result) return null
  if (result.length > maximum) fail(`${label}长度必须在 1-${maximum} 之间。`)
  return result
}

export const MATERIAL_SOURCE_KINDS = Object.freeze([
  { id: 'news-comment', label: '新闻 / 高赞评论' },
  { id: 'qa-answer', label: '问答平台高赞回答' },
  { id: 'personal', label: '本人经历' },
  { id: 'field-note', label: '身边人的事' },
  { id: 'other', label: '其他' },
])

/**
 * Parse a material submission. `sourceUrl` is optional but encouraged: it is the
 * only field that lets a later reviewer check whether the story was real, and
 * the publish prompt quotes the source list back for exactly that reason.
 */
export function parseMaterial(request) {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
  const kind = optionalText(input.kind, '素材来源类型', 32) || 'other'
  if (!SOURCE_KINDS.has(kind)) fail('素材来源类型无效。')
  const url = optionalText(input.sourceUrl, '素材来源地址', 500)
  if (url && !/^https?:\/\//iu.test(url)) fail('素材来源地址必须是 HTTP(S) 链接。')
  return {
    title: text(input.title, '素材标题', TITLE_MAX),
    content: text(input.content, '素材内容', TEXT_MAX),
    kind,
    sourceUrl: url,
    note: optionalText(input.note, '素材备注', 600),
    capturedAt: new Date().toISOString(),
  }
}

export function emptyMaterialFile() {
  return { schemaVersion: 1, items: [] }
}

/** Tolerate a missing or hand-edited file: unreadable records are dropped, not thrown. */
export function normalizeMaterialFile(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  return {
    schemaVersion: 1,
    items: items
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : null,
        title: typeof item.title === 'string' ? item.title : '',
        content: typeof item.content === 'string' ? item.content : '',
        kind: SOURCE_KINDS.has(item.kind) ? item.kind : 'other',
        sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : null,
        note: typeof item.note === 'string' ? item.note : null,
        capturedAt: typeof item.capturedAt === 'string' ? item.capturedAt : null,
        usedBy: Array.isArray(item.usedBy) ? item.usedBy.filter((id) => typeof id === 'string') : [],
      }))
      .filter((item) => item.id && item.title && item.content)
      .slice(-500),
  }
}

function compact(item) {
  return {
    id: item.id,
    title: item.title,
    content: item.content.slice(0, 1500),
    kind: item.kind,
    sourceUrl: item.sourceUrl,
  }
}

/**
 * Assemble the material layer for one topic run.
 *
 * Order matters: hand-picked materials first (the user pointing at a story is a
 * stronger signal than recency), then the most recent ones up to the cap. The
 * cap exists because prompt cost grows linearly and stale material drags the
 * model back to topics the audience has already seen.
 */
export function assembleMaterial({ pickedIds = [], items = [], limit = 8 } = {}) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const picked = []
  for (const id of pickedIds) {
    const item = byId.get(id)
    if (item && !picked.some((entry) => entry.id === id)) picked.push(item)
  }
  const rest = [...items]
    .filter((item) => !picked.some((entry) => entry.id === item.id))
    .sort((left, right) => String(right.capturedAt || '').localeCompare(String(left.capturedAt || '')))
  const selected = [...picked, ...rest].slice(0, Math.max(1, limit))
  return { materials: selected.map(compact), mode: picked.length ? 'picked+recent' : 'recent' }
}
