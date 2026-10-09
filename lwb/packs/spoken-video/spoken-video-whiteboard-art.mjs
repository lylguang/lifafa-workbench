// 白板线稿生图客户端。
//
// 职责单一：把「一幕字幕」变成「一张符合白板视觉规范的线稿」。编排（分幕、
// 缺哪张、存到哪）在 media host；这里只管提示词组装与桥接调用。
//
// 生图走本机媒体桥接（默认 http://127.0.0.1:8199，Qwen-Image 文生图）。
// 桥接接口与云端 DashScope 同形状，方便将来切换云端；negative_prompt/seed
// 是本机桥接的扩展参数。
//
// 实测要点（2026-10-01）：Qwen-Image 按下面的规范前缀能稳定出「极简手绘线稿 +
// 暖米黄纸底 + 无文字」；但模板 cfg=1 下负面提示词不参与采样，防文字靠正面
// 约束 + 人工确认，不要依赖 negative_prompt。

const DEFAULT_BRIDGE_URL = process.env.LWB_WHITEBOARD_BRIDGE_URL || 'http://127.0.0.1:8199'

// 白板视觉规范（与白板包 SKILL.md 的「统一出图视觉规范」一致）。
// 英文书写：对模型更稳；场景内容保持中文原文（Qwen-Image 中文理解良好）。
const LINE_ART_STYLE_PREFIX = [
  'Minimal hand-drawn doodle illustration, restrained sketch style similar to Notion line-art diagrams.',
  'Warm beige paper background exactly #F5EBD7, thin dark-gray sketch lines, generous empty space, clean simple composition with few elements.',
  'Only small accents of red, orange or blue allowed. Flat 2D conceptual drawing, cartoonish, storyboard quality.',
  'STRICTLY FORBIDDEN: any text, letters, numbers, words, labels, captions, watermarks, signatures.',
  'No realism, no photographic detail, no 3D render, no complex background, no dense scenery.',
].join(' ')

const LINE_ART_NEGATIVE_PROMPT = [
  'text, letters, numbers, words, labels, captions, watermark, signature, typography',
  'realistic, photograph, 3d render, complex background, dense scenery, high saturation',
].join(', ')

/**
 * 组装一幕的线稿提示词。
 *
 * visual 是「旁白 → 画面视觉描述」转换后的英文短描述（由 DSH 分镜师生成）。
 * 绝不能把旁白原文直接喂给生图模型：Qwen-Image 是渲染文字的专家模型，给它
 * 长中文旁白，它会把旁白整段「手写」到画面上（2026-10-01 实测翻车）。英文
 * 视觉描述从源头断掉文字渲染的诱因。
 */
export function composeLineArtPrompt(visual) {
  const content = String(visual || '').trim()
  if (!content) throw new Error('线稿提示词缺少画面视觉描述。')
  return `${LINE_ART_STYLE_PREFIX}\n\nScene to draw (illustration only; the description is context, never words to write): ${content}`
}

export function lineArtNegativePrompt() {
  return LINE_ART_NEGATIVE_PROMPT
}

/**
 * 分镜师提示词：把每幕旁白转成「画什么」的英文视觉描述。
 * 关键约束：旁白只是理解语义的依据，输出必须是可绘制的画面，禁止照抄原文。
 */
export function buildLineArtPlanPrompt(scenes) {
  const list = scenes.map((scene) => {
    const span = `${Math.round(scene.startMs / 1000)}-${Math.round(scene.endMs / 1000)}s`
    return `Scene ${scene.index} [${span}]: ${scene.text}`
  }).join('\n')
  return [
    'You are the storyboard artist for a whiteboard hand-drawn animation.',
    'Below are narration scenes (in Chinese) with their time spans. For each scene, write a VISUAL description of what to draw:',
    '- Describe concrete subjects, their action or relation, and a simple layout (e.g. main subject on the left, small props on the right).',
    '- Write in English, 25-40 words per scene, specific and drawable, clean composition.',
    '- The narration is context to understand the meaning. NEVER copy, translate or quote the narration text.',
    '- The drawing must not contain any text, letters or numbers.',
    '',
    list,
  ].join('\n')
}

/** 结构化输出 schema（DSH structured executor 消费）。 */
export const LINE_ART_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          visual: { type: 'string' },
        },
        required: ['index', 'visual'],
      },
    },
  },
  required: ['scenes'],
}

/** 校验并按分幕对齐 LLM 的视觉描述；缺幕补兜底描述，不阻塞生成。 */
export function normalizeLineArtPlan(value, scenes) {
  const byIndex = new Map()
  for (const entry of (Array.isArray(value?.scenes) ? value.scenes : [])) {
    const index = Number(entry?.index)
    const visual = String(entry?.visual || '').trim()
    if (Number.isSafeInteger(index) && visual) byIndex.set(index, visual.slice(0, 400))
  }
  return scenes.map((scene) => {
    // 调用方可能传 parse_srt 原始分幕（sceneIndex）或 plan items（index）
    const index = scene.sceneIndex ?? scene.index
    return {
      index,
      text: scene.text,
      // 兜底描述绝不能带旁白原文：Qwen-Image 见到中文长句会把它当手写内容画进图
      visual: byIndex.get(index) || 'one clear visual metaphor for the scene, a few simple doodle shapes, lots of empty paper space',
    }
  })
}

/** 按幕号固定种子：同幕重生成结果稳定，跨幕种子不同避免画面雷同。 */
export function lineArtSeed(sceneIndex) {
  const base = 20261001
  return (base + Number(sceneIndex || 1) * 7919) % (2 ** 31 - 1)
}

export function whiteboardBridgeUrl() {
  return DEFAULT_BRIDGE_URL
}

/** 生图引擎连通性：桥接 /health 的 imageEngine 字段。 */
export async function checkImageEngine(baseUrl = DEFAULT_BRIDGE_URL, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { reachable: false, up: false }
    const data = await response.json()
    return { reachable: true, up: data?.imageEngine === 'up' }
  } catch {
    return { reachable: false, up: false }
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('生图任务已取消。')) }, { once: true })
})

/**
 * 生成一张线稿，返回 PNG Buffer。
 * 提交 → 轮询（最长 5 分钟）→ 下载产物。所有网络错误原样抛出，由调用方包装。
 */
export async function generateLineArtImage({ baseUrl = DEFAULT_BRIDGE_URL, visual, sceneIndex = 1, width = 1328, height = 752, fetchImpl = fetch, signal, onStage } = {}) {
  const prompt = composeLineArtPrompt(visual)
  const body = {
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: {
      size: `${width}*${height}`,
      negative_prompt: LINE_ART_NEGATIVE_PROMPT,
      seed: lineArtSeed(sceneIndex),
    },
  }
  onStage?.('提交生图任务')
  const response = await fetchImpl(`${baseUrl}/api/v1/services/aigc/image-generation/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`生图服务返回 ${response.status}。`)
  const created = await response.json()
  const taskId = created?.output?.task_id
  if (!taskId) throw new Error('生图服务没有返回任务标识。')

  onStage?.('Qwen-Image 渲染中')
  let result = null
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(5000, signal)
    const poll = await fetchImpl(`${baseUrl}/api/v1/tasks/${taskId}`, { signal })
    if (!poll.ok) throw new Error(`生图任务查询返回 ${poll.status}。`)
    result = await poll.json()
    const state = result?.output?.task_status
    if (state === 'SUCCEEDED') break
    if (state === 'FAILED') throw new Error(result?.output?.message || '生图任务失败。')
  }
  const url = result?.output?.results?.[0]?.url
  if (!url) throw new Error('生图任务超时（超过 5 分钟）。')

  onStage?.('下载线稿')
  const file = await fetchImpl(url, { signal })
  if (!file.ok) throw new Error(`线稿下载返回 ${file.status}。`)
  return Buffer.from(await file.arrayBuffer())
}
