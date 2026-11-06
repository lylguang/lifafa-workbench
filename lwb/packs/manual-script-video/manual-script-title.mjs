/**
 * 手动稿件成片 · 标题生成
 *
 * 标题在保存后不可改（改标题会作废已生成的配音与成片），所以用户留空标题时，
 * 由 AI 在落库前按正文起一个，而不是事后补。这里是**起名**，不是润色：
 * 只看正文、只出标题，不碰正文一个字。
 *
 * AI 起名失败不阻断保存——退回用正文第一句话兜底，保证「保存」永远走得通。
 */

const TITLE_MAX = 160
const BODY_SAMPLE_MAX = 4000

/** 把模型返回收敛成可用标题；拿不到就返回 null，由调用方兜底。 */
export function normalizeGeneratedTitle(structured) {
  const title = typeof structured?.title === 'string' ? structured.title.trim() : ''
  if (!title) return null
  return title.slice(0, TITLE_MAX)
}

/**
 * 从执行器结果里提取标题。
 *
 * 标题天然是一行文字，走的是**非结构化**执行器：模型的文本回答就是结果，
 * 不要求它调 structured_output——实测部分模型（如 minimax-m3.1-flash）起完
 * 标题后用纯文本收尾，结构化通道会把这种回答判成失败。这里同时兼容结构化
 * 返回（{title}），测试与自定义执行器两种形态都能进。
 */
export function titleFromExecutorResult(result) {
  if (typeof result?.title === 'string' && result.title.trim()) return normalizeGeneratedTitle(result)
  const blocks = Array.isArray(result?.output) ? result.output : []
  const text = blocks
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
  if (!text) return null
  // 多行时取第一行有内容的；去掉包裹用的引号与书名号，句末标点不留。
  const line = text.split(/\r?\n/).find((item) => item.trim())?.trim() || ''
  const stripped = line.replace(/^[「『《"'“”#*\-—·\s]+|[》」』。．.!?！？…\s]+$/gu, '').trim()
  if (!stripped) return null
  return stripped.slice(0, TITLE_MAX)
}

/** 保存兜底：正文第一句（≤40 字）。AI 不可用时不让「保存」卡死。 */
export function fallbackTitleFromBody(body) {
  const firstLine = String(body || '').split(/\r?\n/).find((line) => line.trim()) || ''
  const sentence = firstLine.split(/(?<=[。！？!?…])/)[0] || firstLine
  const plain = sentence.replace(/^[\s「『"''""#*\-—·]+/u, '').trim()
  if (!plain) return '未命名稿件'
  return plain.length > 40 ? `${plain.slice(0, 39)}…` : plain
}

/** 标题生成提示词。 */
export function buildTitlePrompt({ body, channel }) {
  const sample = body.length > BODY_SAMPLE_MAX ? body.slice(0, BODY_SAMPLE_MAX) : body
  const sections = []
  sections.push([
    '你是口播稿件的标题编辑。根据下面的稿件正文，起一个适合口播视频的标题。',
    '标题会被用户直接使用，也可能念出来，所以要求：',
  ].join('\n'))
  sections.push([
    '【要求】',
    '- 一句话说清这条片子讲什么，不超过 30 个字。',
    '- 用正文里已有的信息，不要新增事实、不要起悬念式标题党。',
    '- 说人话：不要行业黑话，不要书面腔，不要书名号、引号、句号。',
    '- 直接给出标题本身，不要解释、不要前缀（比如「标题：」）。',
  ].join('\n'))
  if (channel) sections.push(`【发布渠道】${channel}（语气参考，不改变内容）`)
  sections.push(`【稿件正文】\n${sample}`)
  return sections.join('\n\n')
}

/** 拼装一次标题生成的完整输入；executor 不可用时返回 null（调用方走兜底）。 */
export async function generateTitle(executor, agent, { body, channel }) {
  if (typeof executor !== 'function') return null
  try {
    const result = await executor({
      prompt: buildTitlePrompt({ body, channel }),
      agent,
    })
    return titleFromExecutorResult(result)
  } catch (_) {
    return null
  }
}
