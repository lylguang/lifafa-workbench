/**
 * 发布资料：标题、文案、标签、封面标题与评论引导。
 *
 * 情感故事号的发布资料比知识类更要克制，两条硬约束：
 *
 * 1) 标题不许剧透结局。「离婚那天他给我发了条微信」是钩子；「离婚那天他发的
 *    微信让我哭了一夜」是结论——结论一旦给出，点击动机就没了。
 * 2) 诱导互动要低门槛且具体。情感号的评论是第二分发信号，但「关注看结局」
 *    这类话术在抖音会被判诱导，且观众反感，所以只允许开放式提问。
 *
 * 封面标题走的是和通用包相反的路线：那边是生成生图提示词交给模型写字（中文
 * 常常糊），这边直接产出 8-14 字的封面大字，由本地 ffmpeg 叠上去——情感故事
 * 的封面靠「一句话 + 情绪底图」，字必须清楚，不能交给生图模型碰运气。
 */

export const STORY_PACKAGE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string', description: '发布标题，不超过 30 字，不剧透结局' },
    copy: { type: 'string', description: '视频文案，以故事内容为主' },
    description: { type: 'string', description: '平台描述，含一行开放式提问' },
    tags: { type: 'array', items: { type: 'string' }, description: '3-8 个标签，不带 #' },
    coverHeadline: { type: 'string', description: '封面大字，8-14 字' },
    coverMood: { type: 'string', description: '封面底图情绪描述，一句话' },
  },
  required: ['title', 'copy', 'description', 'tags', 'coverHeadline', 'coverMood'],
  additionalProperties: false,
})

export const COVER_HEADLINE_MIN = 6
export const COVER_HEADLINE_MAX = 14
const TAG_MAX = 30

export class StoryPublishError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(message) { throw new StoryPublishError('STORY_PUBLISH_AGENT_INVALID', `发布资料：${message}`) }

function clipped(value, maximum) {
  const text = String(value || '').trim()
  return text.length > maximum ? text.slice(0, maximum) : text
}

/**
 * 发布资料提示词。
 *
 * 把反塑料感结论与素材来源一起注入：模型看到「本篇有 3 处无素材支撑的细节」时
 * 会自然收敛，这比单独一句「不要编造」有用得多。
 */
export function buildPackagePrompt({ topic, script, antiPlastic = null, quality = null, profile = null, materials = [] }) {
  return [
    '你是情感故事号的发布编辑。根据已冻结的选题、稿件与质检结论，生成面向抖音的发布资料。只输出结构化结果。',
    [
      '- title：不超过 30 字。必须是钩子，不是结论：可以用一句对白、一个反常的动作、一个具体场景开头，但**不得剧透结局**，也不得用「看完哭了」这类替观众下结论的说法。',
      '- copy（视频文案）：以稿件内容本身为主，不加互动话术，不要出现「点赞关注」这类词。',
      '- description（平台描述）：一两句氛围性表达 + 结尾一行开放式提问。提问必须与本条故事直接相关、观众一句话能答（例如「你会怎么选」「你妈也这样吗」），禁止「你怎么看」这类空问题，禁止抽奖、转发有礼、关注才告知结局这类诱导。',
      `- tags：3-8 个，不带 #，混合大流量词（如 情感故事）与精准词（如 原生家庭）。`,
      `- coverHeadline：封面大字，${COVER_HEADLINE_MIN}-${COVER_HEADLINE_MAX} 字，是留给观众的第一句话，要能独立成立；不要写成完整句子，不加标点。`,
      '- coverMood：一句话描述封面底图的情绪与场景（例如「厨房里熄灭的灶台，暖黄灯光」），用于生图或选图。',
      '- 不得编造稿件之外的事实与数字；不得把故事说成真人真事，也不得暗示是真人真事。',
    ].join('\n'),
    `项目标题：${topic?.title || '未命名'}`,
    `选题场景与关键对白：${JSON.stringify({ scenario: topic?.scenario || null, keyLine: topic?.keyLine || null, theme: topic?.theme || null })}`,
    `账号快照：${JSON.stringify(profile || null)}`,
    `素材来源：${JSON.stringify((materials || []).map((item) => ({ title: item.title, kind: item.kind, sourceUrl: item.sourceUrl || null })))}`,
    `质检结论：${JSON.stringify({
      antiPlasticPassed: antiPlastic?.passed ?? null,
      antiPlasticBlocking: antiPlastic?.blocking || [],
      qualityScore: quality?.qualityScore ?? null,
      unsupportedDetails: script?.unsupportedDetails || [],
    })}`,
    `稿件标题：${script?.title || '未命名'}`,
    `完整口播稿：\n${script?.body || ''}`,
  ].join('\n\n')
}

/**
 * 归一化与校验。
 *
 * coverHeadline 超长不截断成一句残话，而是走 shortenCoverHeadline 的挑句逻辑：
 * 封面大字被硬砍会读不通，比多几个字更伤。标题超 30 字则直接报错让模型重来——
 * 抖音标题超出后会被截断，截断位置不可控。
 */
export function normalizePackage(value) {
  const title = clipped(value?.title, 40)
  const copy = clipped(value?.copy, 2000)
  const description = clipped(value?.description, 1000)
  const coverMood = clipped(value?.coverMood, 200)
  const tags = [...new Set((Array.isArray(value?.tags) ? value.tags : [])
    .map((tag) => clipped(tag, TAG_MAX).replace(/^#+/u, '').trim())
    .filter(Boolean))].slice(0, 8)
  if (!title || !copy || !description || !coverMood || tags.length < 1) {
    fail('模型返回的标题、文案、描述、标签或封面情绪不完整。')
  }
  if ([...title].length > 30) fail(`发布标题 ${[...title].length} 字，超过 30 字上限。`)
  const coverHeadline = shortenCoverHeadline(value?.coverHeadline)
  if (!coverHeadline) fail('封面大字为空。')
  return { title, copy, description, tags, coverHeadline, coverMood }
}

/**
 * 把封面大字收进 6-14 字。
 *
 * 优先按标点切句挑信息量最高的一句；没有标点就在连接词处断开。刻意不补省略号
 * ——封面大字带省略号会显得像残句，情感号尤其忌讳。
 */
export function shortenCoverHeadline(value, { min = COVER_HEADLINE_MIN, maximum = COVER_HEADLINE_MAX } = {}) {
  const raw = String(value || '').trim().replace(/[「」“”"'《》]/gu, '')
  if (!raw) return ''
  const length = [...raw].length
  if (length >= min && length <= maximum) return raw
  if (length <= maximum) return raw

  const parts = raw.split(/[，,。.；;！!？?、：:\s]+/u).map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1) {
    const scored = parts.map((part, index) => {
      const hasNumber = /\d/u.test(part) ? 3 : 0
      const hasQuarrel = /(?:离婚|分手|吵|哭|没说话|删了|拉黑|搬走|走人|去世|住院|裁员)/u.test(part) ? 3 : 0
      const fits = [...part].length <= maximum ? 2 : 0
      return { part, index, score: hasNumber + hasQuarrel + fits }
    }).sort((left, right) => right.score - left.score || left.index - right.index)
    const picked = scored.find((item) => {
      const size = [...item.part].length
      return size >= min && size <= maximum
    })
    if (picked) return picked.part
    const longestFitting = scored
      .filter((item) => [...item.part].length <= maximum)
      .sort((left, right) => [...right.part].length - [...left.part].length)[0]
    if (longestFitting) return longestFitting.part
  }
  return [...raw].slice(0, maximum).join('')
}
