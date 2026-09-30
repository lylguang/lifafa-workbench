/**
 * 拆解与选题启发的结构化输出契约。字段定义同时是提示词的输出说明与
 * normalizeTeardownAnalysis 的入库校验依据，三处保持一致。
 */
export const TEARDOWN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'hookType', 'hookQuote', 'structure', 'pacing', 'titleFormulas', 'commentInsight', 'reusable', 'viralityScore'],
  properties: {
    summary: { type: 'string', description: '这条内容为什么值得学，一句话概括' },
    hookType: { type: 'string', description: '开头钩子类型，如悬念反问/身份代入/反常识断言' },
    hookQuote: { type: 'string', description: '钩子原句摘录' },
    structure: {
      type: 'array',
      description: '内容结构分段，按出现顺序',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segment', 'purpose'],
        properties: { segment: { type: 'string', description: '段落主题' }, purpose: { type: 'string', description: '这一段在整体中的作用' } },
      },
    },
    pacing: { type: 'string', description: '节奏与信息密度分析' },
    titleFormulas: { type: 'array', description: '可复用的标题公式（模板形式）', items: { type: 'string' } },
    commentInsight: { type: 'string', description: '目标受众画像与评论区情绪洞察' },
    reusable: { type: 'array', description: '可以直接搬走的可执行清单', items: { type: 'string' } },
    viralityScore: { type: 'integer', description: '传播力评分 0-100' },
  },
})

export const SUGGESTIONS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      description: '5-8 条选题建议',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'angle', 'rationale', 'basedOn'],
        properties: {
          title: { type: 'string', description: '建议的选题标题' },
          angle: { type: 'string', description: '切入角度与内容形式' },
          rationale: { type: 'string', description: '为什么值得做：来自哪些拆解结论' },
          basedOn: { type: 'array', description: '依据的拆解记录标题', items: { type: 'string' } },
        },
      },
    },
  },
})

function formatStats(stats) {
  if (!stats) return ''
  const labels = { views: '播放/阅读', likes: '点赞', comments: '评论', favorites: '收藏' }
  const parts = Object.entries(labels)
    .filter(([key]) => Number.isFinite(stats[key]))
    .map(([key, label]) => `${label} ${stats[key]}`)
  return parts.length ? `\n数据表现：${parts.join('，')}` : ''
}

export function buildTeardownPrompt({ input, platformLabelOf }) {
  const platform = platformLabelOf(input.platform) || '未知平台'
  return [
    '你是资深短视频与图文内容操盘手。下面是一条对标账号的爆款内容，请拆解它为什么能火，输出供创作者复用的方法论。',
    '',
    `平台：${platform}`,
    `标题：${input.title}`,
    input.url ? `链接：${input.url}` : null,
    formatStats(input.stats),
    '',
    '文案原文：',
    input.content,
    '',
    '要求：',
    '- 只依据给出的原文与数据拆解，不编造没有出现的细节；数据缺失就少谈数据。',
    '- structure 按内容实际出现顺序分段（3-8 段），说明每段在整体中的作用。',
    '- titleFormulas 给出模板化的标题公式（例如「数字+反常识结论｜谁+意外结果」），不要照抄原标题。',
    '- reusable 给出可以直接搬走执行的动作清单（3-6 条），每条以动词开头。',
    '- commentInsight 基于内容推断目标受众与评论区可能的情绪，注明这是推断。',
    '- 语言：中文。不要输出 JSON 之外的任何解释。',
  ].filter((line) => line !== null).join('\n')
}

export function buildSuggestionsPrompt({ teardowns, platformLabelOf }) {
  const blocks = teardowns.map((item, index) => [
    `【拆解 ${index + 1}】${item.title}（${platformLabelOf(item.platform) || '未知平台'}）`,
    item.analysis?.summary ? `概括：${item.analysis.summary}` : null,
    item.analysis?.hookType ? `钩子：${item.analysis.hookType}${item.analysis.hookQuote ? `｜原句：${item.analysis.hookQuote}` : ''}` : null,
    item.analysis?.titleFormulas?.length ? `标题公式：${item.analysis.titleFormulas.join('；')}` : null,
    item.analysis?.reusable?.length ? `可复用：${item.analysis.reusable.join('；')}` : null,
    `传播力：${item.analysis?.viralityScore ?? '未评分'}/100`,
  ].filter(Boolean).join('\n'))
  return [
    '你是内容策略顾问。以下是基于对标爆款内容的若干拆解结论，请结合它们为创作者生成下一阶段可直接执行的选题建议。',
    '',
    blocks.join('\n\n'),
    '',
    '要求：',
    '- 生成 5-8 条选题建议，每条必须能追溯到至少一条拆解结论，并在 rationale 中明确指出依据。',
    '- basedOn 填写依据的拆解记录标题（从上面原文照抄），不要编造。',
    '- 建议要具体到「可以直接开写」的程度：有明确的切入角度和内容形式，不要空泛的方向。',
    '- 语言：中文。不要输出 JSON 之外的任何解释。',
  ].join('\n')
}

export function messageFromPrompt(prompt) {
  // spawn 的 prompt 用与 DSH 原生一致的内容数组；createUserMessage 留给会话内 followup。
  return [{ type: 'text', text: prompt }]
}

/**
 * 一次性结构化执行器：在包的专属 Agent 里 spawn 一个结构化子代理，
 * 返回其 structured 输出。所有模型、凭据与审批边界留在 DSH 内。
 */
export function createStructuredExecutor(ctx, subagents, scope, label) {
  return async function execute({ prompt, schema, signal }) {
    if (!subagents || typeof subagents.start !== 'function') {
      throw new Error('当前环境不提供子代理执行接缝，无法执行生成任务。')
    }
    return await scope.withAgent(async (parent) => {
      const runSignal = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal
      const run = await subagents.start('spawn', {
        label,
        prompt: messageFromPrompt(prompt),
        parent,
        signal: runSignal,
        outputSchema: schema,
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') {
          const detail = result.diagnostic ? `：${result.diagnostic}` : ''
          throw new Error(`生成未正常结束（${result.stopReason}）${detail}`)
        }
        return result.structured
      } finally {
        await run.dispose().catch(() => {})
      }
    })
  }
}
