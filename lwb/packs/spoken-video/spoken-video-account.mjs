/**
 * Pure helpers for agent-assisted account-profile completion: input parsing,
 * the DSH prompt, the structured output schema, and draft-polish
 * normalization. No I/O and no model calls — the host store composes these
 * helpers and supplies the model execution. User input is treated as a rough
 * draft: the AI may polish, expand or rewrite filled fields (keeping their
 * intent) and fills every missing one; the result is only a form suggestion,
 * saving still happens through createAccount/updateAccount by the human.
 */

import { hasProfile, parseProfile } from './spoken-video-topic.mjs'

export function fail(message) { return new Error(`账号定位完善：${message}`) }

function text(value, label, max) {
  if (typeof value !== 'string') throw fail(`${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > max) throw fail(`${label}长度必须在 1-${max} 之间。`)
  return result
}

function optionalText(value, label, max) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null
  return text(value, label, max)
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null
  const result = value.trim()
  if (!result) return null
  return result.length > max ? `${result.slice(0, max - 1)}…` : result
}

export const ACCOUNT_COMPLETION_FIELDS = Object.freeze(['name', 'positioning', 'audience', 'pillars', 'boundary'])
export const ACCOUNT_COMPLETION_LABELS = Object.freeze({ name: '账号名称', positioning: '账号定位', audience: '目标受众', pillars: '内容方向', boundary: '内容边界' })

/**
 * Validate the completion request. The payload shape matches
 * createAccount/updateAccount; at least one field must be present.
 */
export function parseAccountCompletionInput(request) {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
  const name = optionalText(input.name, '账号名称', 80)
  const profile = parseProfile(input)
  const parsed = { name, positioning: profile.positioning, audience: profile.audience, pillars: profile.pillars, boundary: profile.boundary }
  if (!name && !hasProfile(parsed)) throw fail('账号名称、账号定位、目标受众、内容方向、内容边界至少录入一项。')
  return parsed
}

export function fieldFilled(input, field) {
  return field === 'pillars' ? input.pillars.length > 0 : Boolean(input[field])
}

/** Build the DSH prompt for draft-polish account completion. */
export function buildAccountCompletionPrompt({ input }) {
  const sections = ['你是口播视频账号的定位顾问。用户给出的信息可能非常简略，把它当作草稿：基于草稿完善全部账号定位资料。只输出结构化结果。']
  const rules = [
    '用户已提供的字段是草稿：保留其核心意图，可以润色、扩写、规范化成完整表达，不要偏离原意。',
    '未提供的字段必须补齐。',
    'positioning（账号定位）用一两句话说明这个账号做什么内容、给谁看、有什么不同。',
    'audience（目标受众）描述具体人群和他们想被满足的需求。',
    'pillars（内容方向）给出 3-5 个能长期更新的方向，每个不超过 10 个字。',
    'boundary（内容边界）写明允许与禁止的内容，并补充常见风险红线，例如不做医疗与投资建议。',
    'name（账号名称）若用户已提供，保留原名或在其基础上微调；未提供时给出贴合定位、便于记忆的名称，避免夸大或绝对化用词。',
    '不得编造用户的真实情况、数据或背景，所有内容都应是合理假设与建议。',
  ]
  sections.push(rules.map((rule) => `- ${rule}`).join('\n'))
  const fields = ACCOUNT_COMPLETION_FIELDS.map((field) => ({ field, label: ACCOUNT_COMPLETION_LABELS[field], value: field === 'pillars' ? (input.pillars.length ? input.pillars.join('、') : null) : input[field] }))
  const filled = fields.filter((item) => item.value)
  const missing = fields.filter((item) => !item.value)
  if (filled.length) sections.push(`用户草稿（保留意图，可润色扩写）：\n${filled.map((item) => `- ${item.label}：${item.value}`).join('\n')}`)
  sections.push(`待补齐：\n${missing.map((item) => `- ${item.label}`).join('\n')}`)
  return sections.join('\n\n')
}

export const ACCOUNT_COMPLETION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', description: '账号名称' },
    positioning: { type: 'string', description: '账号定位' },
    audience: { type: 'string', description: '目标受众' },
    pillars: { type: 'array', items: { type: 'string' }, description: '内容方向' },
    boundary: { type: 'string', description: '内容边界' },
    summary: { type: 'string', description: '本次补全的整体说明' },
  },
  required: [],
})

/**
 * Normalize the DSH structured output into a full suggestion. The AI output
 * wins on every field it provides (truncated to the storage limits); user
 * input only backs up fields the AI left empty, so a missing AI name can
 * never blank the form. `filled` lists fields the AI contributed where the
 * user had nothing; `updated` lists fields where the AI polished or rewrote
 * the user's draft.
 */
export function normalizeAccountSuggestion(structured, input) {
  const raw = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : {}
  const pillars = Array.isArray(raw.pillars)
    ? [...new Set(raw.pillars.map((item) => cleanText(item, 60)).filter(Boolean))].slice(0, 8)
    : []
  const ai = {
    name: cleanText(raw.name, 80),
    positioning: cleanText(raw.positioning, 600),
    audience: cleanText(raw.audience, 300),
    pillars,
    boundary: cleanText(raw.boundary, 600),
  }
  const suggestion = {
    name: ai.name || input.name || null,
    positioning: ai.positioning || input.positioning || null,
    audience: ai.audience || input.audience || null,
    pillars: ai.pillars.length ? ai.pillars : [...input.pillars],
    boundary: ai.boundary || input.boundary || null,
  }
  const filled = ACCOUNT_COMPLETION_FIELDS.filter((field) => !fieldFilled(input, field) && fieldFilled(suggestion, field))
  const updated = ACCOUNT_COMPLETION_FIELDS.filter((field) => fieldFilled(input, field) && fieldFilled(ai, field) && !sameField(ai, input, field))
  return { suggestion, filled, updated, summary: cleanText(raw.summary, 300) }
}

function sameField(ai, input, field) {
  if (field === 'pillars') return ai.pillars.length === input.pillars.length && ai.pillars.every((item, index) => item === input.pillars[index])
  return ai[field] === input[field]
}
