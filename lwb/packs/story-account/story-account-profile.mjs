/**
 * 账号定位：受众、题材、情绪边界。这是本包唯一的配置源——选题、写稿、成片、
 * 发布资料都读它，而不是各自带一份默认值。
 *
 * 与通用口播包的差异：那一份定位是「讲什么」，这一份还必须锁住「对谁讲」和
 * 「讲到哪条线为止」。情感故事最贵的失误不是不好看，是说错话——性别对立、
 * 煽动仇恨、编造真实人物，任何一条都会让账号在起量前被限流。
 */

const TEXT_LIMITS = Object.freeze({
  name: 80,
  positioning: 600,
  audience: 300,
  boundary: 600,
})

export class StoryAccountError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(message) { throw new StoryAccountError('STORY_ACCOUNT_INVALID_INPUT', `账号定位：${message}`) }

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail(`${label}必须是文本。`)
  const result = value.trim()
  if (!result) return null
  if (result.length > maximum) fail(`${label}长度必须在 1-${maximum} 之间。`)
  return result
}

/** 题材只接受库里的 id；不猜、不做模糊匹配——挑错题材比没有题材更糟。 */
function themeList(value, label, maximum) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`${label}必须是数组。`)
  if (value.length > maximum) fail(`${label}最多包含 ${maximum} 项。`)
  const themes = []
  for (const item of value) {
    if (typeof item !== 'string') fail(`${label}项必须是文本。`)
    const id = item.trim().toLowerCase()
    if (!id) continue
    if (!THEME_IDS.has(id)) fail(`未知题材：${item}。`)
    if (!themes.includes(id)) themes.push(id)
  }
  return themes
}

const THEME_IDS = new Set(['marriage', 'family-origin', 'midlife', 'late-love', 'kinship', 'unresolved'])

export const DEFAULT_AUDIENCE = '30-40 岁女性'

/** Empty profile: everything unset, one default that matters kept explicit. */
export function emptyProfile() {
  return {
    name: null,
    positioning: null,
    audience: DEFAULT_AUDIENCE,
    themes: [],
    boundary: null,
    updatedAt: null,
  }
}

/**
 * Validate a stored or submitted profile. Every field is optional; the audience
 * falls back to the pack's mandated default so a half-filled form still produces
 * a usable prompt rather than one addressed to nobody.
 */
export function parseProfile(request) {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
  const audience = optionalText(input.audience, '目标受众', TEXT_LIMITS.audience) || DEFAULT_AUDIENCE
  return {
    name: optionalText(input.name, '账号名称', TEXT_LIMITS.name),
    positioning: optionalText(input.positioning, '账号定位', TEXT_LIMITS.positioning),
    audience,
    themes: themeList(input.themes, '故事题材', 6),
    boundary: optionalText(input.boundary, '内容边界', TEXT_LIMITS.boundary),
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : null,
  }
}

export function hasProfile(profile) {
  return Boolean(profile && (profile.name || profile.positioning || profile.boundary || profile.themes?.length))
}

/**
 * A project never holds a live reference to an account: later edits must not
 * silently rewrite an already-confirmed topic. The snapshot is compact and
 * validated, and it is what the packaged publish data quotes back.
 */
export function parseAccountSnapshot(request) {
  if (request === undefined || request === null) return null
  if (typeof request !== 'object' || Array.isArray(request)) fail('账号快照必须是对象。')
  const id = typeof request.id === 'string' ? request.id.trim().toLowerCase() : ''
  if (!/^[a-f0-9-]{36}$/u.test(id)) fail('账号快照标识无效。')
  if (!Number.isSafeInteger(request.revision) || request.revision < 1) fail('账号快照版本无效。')
  const profile = parseProfile(request)
  return {
    id,
    name: profile.name || '未命名账号',
    revision: request.revision,
    positioning: profile.positioning,
    audience: profile.audience,
    themes: profile.themes,
    boundary: profile.boundary,
  }
}

/**
 * Compact account lines for every downstream prompt. Returns null when there is
 * nothing worth saying, so prompts do not grow an empty「账号约束：」section.
 */
export function profileLines(profile) {
  if (!hasProfile(profile)) return null
  const lines = []
  if (profile.name) lines.push(`账号名称：${profile.name}`)
  if (profile.positioning) lines.push(`账号定位：${profile.positioning}`)
  if (profile.audience) lines.push(`目标受众：${profile.audience}`)
  if (profile.themes?.length) lines.push(`可选题材：${profile.themes.join('、')}`)
  if (profile.boundary) lines.push(`内容边界：${profile.boundary}`)
  return lines.length ? lines : null
}

/* ---------------------------- 定位补全（AI 建议） ---------------------------- */

export const ACCOUNT_COMPLETION_FIELDS = Object.freeze(['name', 'positioning', 'audience', 'themes', 'boundary'])
export const ACCOUNT_COMPLETION_LABELS = Object.freeze({
  name: '账号名称',
  positioning: '账号定位',
  audience: '目标受众',
  themes: '故事题材',
  boundary: '内容边界',
})

function fieldFilled(input, field) {
  return field === 'themes' ? input.themes.length > 0 : Boolean(input[field])
}

export function fieldIsFilled(input, field) { return fieldFilled(input, field) }

/** At least one field must carry a rough draft; otherwise there is nothing to complete. */
export function parseCompletionInput(request) {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
  const parsed = parseProfile(input)
  if (!parsed.name && !hasProfile(parsed)) fail('账号名称、账号定位、目标受众、故事题材、内容边界至少录入一项。')
  return parsed
}

/**
 * Prompt for draft-polish completion. The user's input is treated as a rough
 * draft: the model may polish or expand it, but must not invent facts about
 * the person behind the account, and the audience default must be preserved
 * unless the user deliberately changed it.
 */
export function buildCompletionPrompt({ input }) {
  const fields = ACCOUNT_COMPLETION_FIELDS.map((field) => ({
    field,
    label: ACCOUNT_COMPLETION_LABELS[field],
    value: field === 'themes' ? (input.themes.length ? input.themes.join('、') : null) : input[field],
  }))
  const filled = fields.filter((item) => item.value)
  const missing = fields.filter((item) => !item.value)
  const sections = [
    '你是情感故事号的账号定位顾问。用户给出的信息可能非常简略，把它当作草稿：基于草稿完善全部账号定位资料。只输出结构化结果。',
    [
      '- 用户已提供的字段是草稿：保留其核心意图，可以润色、扩写成完整表述，不要偏离原意。',
      '- 未提供的字段必须补齐。',
      '- positioning（账号定位）用一两句话说明这个号讲什么故事、给谁看、和别人有什么不一样。',
      '- audience（目标受众）必须是具体人群和她们想在故事里被满足的东西；默认就是「30-40 岁女性」，除非用户明确改了年龄或性别，否则不要改动它。',
      '- themes（故事题材）只能从这些 id 里挑 1-4 个：marriage（婚姻与离婚）、family-origin（原生家庭）、midlife（中年危机）、late-love（中年人的爱）、kinship（亲情细碎日常）、unresolved（意难平）。',
      '- boundary（内容边界）写明白允许与禁止的内容，并补上本赛道的常见红线：不煽动性别对立、不写真实可指认的人物、不做医疗与投资建议、不用未核实的统计数据。',
      '- name（账号名称）若用户已提供则保留或微调；未提供时给出贴合定位、便于记忆、不含夸大与绝对化用词的名字。',
      '- 不得编造用户的真实身份、职业、经历或数据；所有内容都应是合理假设与建议。',
    ].join('\n'),
  ]
  if (filled.length) sections.push(`用户草稿（保留意图，可润色扩写）：\n${filled.map((item) => `- ${item.label}：${item.value}`).join('\n')}`)
  if (missing.length) sections.push(`待补齐：\n${missing.map((item) => `- ${item.label}`).join('\n')}`)
  return sections.join('\n\n')
}

export const COMPLETION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', description: '账号名称' },
    positioning: { type: 'string', description: '账号定位' },
    audience: { type: 'string', description: '目标受众' },
    themes: { type: 'array', items: { type: 'string', enum: ['marriage', 'family-origin', 'midlife', 'late-love', 'kinship', 'unresolved'] }, description: '故事题材 id' },
    boundary: { type: 'string', description: '内容边界' },
    summary: { type: 'string', description: '本次补全的整体说明' },
  },
  required: [],
  additionalProperties: false,
})

function clipped(value, maximum) {
  if (typeof value !== 'string') return null
  const result = value.trim()
  if (!result) return null
  return result.length > maximum ? `${result.slice(0, maximum - 1)}…` : result
}

/**
 * Normalize the AI suggestion. The AI wins on every field it provides; the
 * user's draft only backs up fields the AI left empty, so a missing AI name can
 * never blank the form. Unknown theme ids are dropped rather than guessed.
 */
export function normalizeCompletion(structured, input) {
  const raw = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : {}
  const aiThemes = Array.isArray(raw.themes)
    ? raw.themes.map((item) => String(item || '').trim().toLowerCase()).filter((id) => THEME_IDS.has(id))
    : []
  const ai = {
    name: clipped(raw.name, TEXT_LIMITS.name),
    positioning: clipped(raw.positioning, TEXT_LIMITS.positioning),
    audience: clipped(raw.audience, TEXT_LIMITS.audience),
    themes: [...new Set(aiThemes)],
    boundary: clipped(raw.boundary, TEXT_LIMITS.boundary),
  }
  const suggestion = {
    name: ai.name || input.name || null,
    positioning: ai.positioning || input.positioning || null,
    audience: ai.audience || input.audience || DEFAULT_AUDIENCE,
    themes: ai.themes.length ? ai.themes : [...input.themes],
    boundary: ai.boundary || input.boundary || null,
  }
  const filled = ACCOUNT_COMPLETION_FIELDS.filter((field) => !fieldFilled(input, field) && fieldFilled(suggestion, field))
  const updated = ACCOUNT_COMPLETION_FIELDS.filter((field) => {
    if (!fieldFilled(input, field) || !fieldFilled(ai, field)) return false
    return field === 'themes'
      ? ai.themes.length !== input.themes.length || ai.themes.some((id, index) => id !== input.themes[index])
      : ai[field] !== input[field]
  })
  return { suggestion, filled, updated, summary: clipped(raw.summary, 300) }
}
