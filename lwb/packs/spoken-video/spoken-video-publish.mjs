export const PUBLISH_IMAGE_PROVIDERS = Object.freeze(['bailian', 'scitiger', 'custom'])
export const PUBLISH_IMAGE_CREDENTIALS = Object.freeze({
  bailian: 'DASHSCOPE_API_KEY',
  scitiger: 'LWB_SPOKEN_VIDEO_CLOUD_IMAGE_API_KEY',
  // 自定义云端生图的密钥。与内置渠道一样只存 DSH 私有凭据库，不写进发布资料。
  custom: 'LWB_SPOKEN_VIDEO_CUSTOM_IMAGE_API_KEY',
})
/**
 * 自定义云端生图的请求/响应协议。
 *
 * `openai`：OpenAI 兼容的 /images/generations。自建中转、各家聚合服务都基本照抄了
 *   这套，所以它是默认值——填一个地址就能用的场景远多于需要异步轮询的场景。
 * `async-generic`：提交返回任务 id、再轮询取图的异步协议（百炼与 SciTiger 用的就是
 *   它）。字段名按 SciTiger 那套的常见形态去取，兼容面较广。
 *
 * 只做这两种是因为它们覆盖了绝大多数自建与中转服务；真要接一个别的协议，
 * 更好的做法是在桥接里加一个适配端点，而不是在这里无限加分支。
 */
export const CUSTOM_IMAGE_PROTOCOLS = Object.freeze(['openai', 'async-generic'])
export const PUBLISH_IMAGE_MODEL = 'wan2.7-image'
export const PUBLISH_PACKAGE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string' },
    copy: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    landscapePrompt: { type: 'string' },
    portraitPrompt: { type: 'string' },
    negativePrompt: { type: 'string' },
  },
  required: ['title', 'copy', 'description', 'tags', 'landscapePrompt', 'portraitPrompt', 'negativePrompt'],
  additionalProperties: false,
})

export class SpokenVideoPublishError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  throw new SpokenVideoPublishError(code, message)
}

function clipped(value, maximum) {
  const result = String(value || '').trim()
  return result.length > maximum ? result.slice(0, maximum) : result
}

function endpoint(value, label) {
  let parsed
  try { parsed = new URL(String(value || '').trim()) } catch { fail('SPOKEN_VIDEO_PUBLISH_CONFIG_INVALID', `${label}必须是 HTTP(S) URL。`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('SPOKEN_VIDEO_PUBLISH_CONFIG_INVALID', `${label}无效。`)
  }
  return parsed.toString().replace(/\/$/u, '')
}

export function publishImageCredentialRef(provider) {
  const normalized = String(provider || '').trim().toLowerCase()
  if (!PUBLISH_IMAGE_PROVIDERS.includes(normalized)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '生图渠道无效。')
  return PUBLISH_IMAGE_CREDENTIALS[normalized]
}

/**
 * 解析并校验自定义云端生图的连接设置。
 *
 * 刻意不接受路径、查询串和账号密码：这些会被拼进请求地址，出现在日志和错误
 * 消息里就是凭据泄漏。地址必须是干净的 http(s) 根地址。
 */
export function parseCustomImageConfig(input = {}) {
  const baseUrl = endpoint(input.baseUrl, '自定义生图地址')
  const protocol = String(input.protocol || 'openai').trim().toLowerCase()
  if (!CUSTOM_IMAGE_PROTOCOLS.includes(protocol)) {
    fail('SPOKEN_VIDEO_PUBLISH_CONFIG_INVALID', '自定义生图协议无效，请选择 OpenAI 兼容或通用异步。')
  }
  return {
    provider: 'custom',
    baseUrl,
    protocol,
    // 空路径按协议给默认端点：OpenAI 兼容几乎一定是 /images/generations。
    path: String(input.path || (protocol === 'openai' ? '/images/generations' : '/api/v1/services/aigc/image-generation/generation')).trim() || null,
    model: clipped(input.model, 120) || PUBLISH_IMAGE_MODEL,
    // 密钥形态不是所有服务都要：自建可能不校验，但留空就发不出 Authorization。
    // 由调用方决定是否填写，这里不强制。
    authHeader: String(input.authHeader || 'bearer').trim().toLowerCase() || 'bearer',
  }
}

/** 自定义生图配置的默认值：新配时用它填充表单，而不是留空让人猜。 */
/**
 * 自定义生图的表单预填值。
 *
 * 默认指向萝卜Ai（TT Image 2.5）：它是少数把 OpenAI 图片协议原样暴露出来的
 * 服务商——base_url 换成它、填个 Key 就能用，不需要任何适配。选择 OpenAI 官方
 * 作默认反而更坑：官方 gpt-image 系**不支持 response_format=url**，而现有链路
 * 正是按 URL 取图再下载的，用官方会卡在这一步。
 */
export const CUSTOM_IMAGE_PRESET = Object.freeze({
  label: '萝卜Ai · TT Image 2.5',
  baseUrl: 'https://api.lk888.ai/v1',
  protocol: 'openai',
  path: '/images/generations',
  model: 'tt-image-2.5',
  authHeader: 'bearer',
  note: 'OpenAI 兼容协议，填 Key 即可用。同步出图，通常 20 秒~2 分钟。',
})

export function customImageDefaults(environment = process.env) {
  return parseCustomImageConfig({
    baseUrl: environment.LWB_SPOKEN_VIDEO_CUSTOM_IMAGE_BASE_URL || CUSTOM_IMAGE_PRESET.baseUrl,
    protocol: environment.LWB_SPOKEN_VIDEO_CUSTOM_IMAGE_PROTOCOL || CUSTOM_IMAGE_PRESET.protocol,
    path: environment.LWB_SPOKEN_VIDEO_CUSTOM_IMAGE_PATH || '',
    model: environment.LWB_SPOKEN_VIDEO_IMAGE_MODEL || CUSTOM_IMAGE_PRESET.model,
    authHeader: environment.LWB_SPOKEN_VIDEO_CUSTOM_IMAGE_AUTH_HEADER || CUSTOM_IMAGE_PRESET.authHeader,
  })
}

/** OpenAI 兼容的生图请求体。 */
export function customOpenAiImageRequest({ model, prompt, size, negativePrompt }) {
  return {
    model: clipped(model, 120) || PUBLISH_IMAGE_MODEL,
    prompt,
    n: 1,
    // OpenAI 只接受 `WIDTHxHEIGHT` 这种写法，不是百炼的 `1280*720`。
    size: String(size || '1280*720').replace('*', 'x'),
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    response_format: 'url',
  }
}

/** OpenAI 兼容响应的图片地址。返回 data URL 之外的普通 URL 即可，下载走同一条路。 */
export function customOpenAiImageUrl(value) {
  const first = Array.isArray(value?.data) ? value.data[0] : null
  const candidate = first?.url || first?.b64_json
  if (typeof candidate !== 'string' || !candidate.trim()) return null
  // b64_json 是裸 base64，包成 data URL 交给现有的下载/校验链路统一处理。
  return candidate.startsWith('data:') || /^https?:\/\//iu.test(candidate)
    ? candidate.trim()
    : `data:image/png;base64,${candidate.trim()}`
}

export function publishImageConfig(environment = process.env) {
  return {
    bailianBaseUrl: endpoint(environment.LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL || 'https://dashscope.aliyuncs.com', '百炼生图地址'),
    scitigerBaseUrl: endpoint(environment.LWB_SPOKEN_VIDEO_CLOUD_IMAGE_BASE_URL || environment.LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL || 'https://link.scitiger.cn', '云端生图地址'),
    model: clipped(environment.LWB_SPOKEN_VIDEO_IMAGE_MODEL || PUBLISH_IMAGE_MODEL, 120) || PUBLISH_IMAGE_MODEL,
  }
}

/**
 * 把视频标题压成适合印在封面上的短句。
 *
 * 2026-10-10 用户要求：封面提示词固定成「根据提供的主题做一张视频封面，主题：<短标题>」，
 * 所以这里只需要产出那个「短标题」本身。
 *
 * 为什么不直接用原标题：信息流缩略图很小，字数一多就必然缩小字号，而标题缩小
 * 就失去「一眼看清」的意义。20 字是个实测下来比较稳的上限——两行、每行十来个字，
 * 仍然能占据画面主体。
 *
 * 纯字符串处理，不调模型：省一次调用，也避免模型把标题改写成与视频标题不一致的
 * 说法（封面文字与视频标题对不上，用户一眼就能看出不对）。
 */
export function shortenCoverTitle(title, { maxLength = 20 } = {}) {
  const raw = String(title || '').trim()
  if (!raw) return ''
  if ([...raw].length <= maxLength) return raw

  // 超过上限时挑一句，而不是从头硬砍。
  //
  // 中文短视频标题的钩子经常在中段：「千万别再用这个方法做短视频了，效率提升
  // 10 倍，团队都在用」——按字数截前 20 字会得到「千万别再用这个方法做短视频了，
  // 效率提升」，信息点（10 倍）被砍掉，钩子（别再用）又太套路。
  // 而「效率提升 10 倍」才是真正让人点进去的那句。
  //
  // 打分规则很朴素：句子越长信息量越大，带数字的更值钱（具体数字比形容词有说服力），
  // 含结果/对比意味的词再加权。取分最高的那些句子，拼到字数上限为止。
  const parts = raw.split(/[，,。.；;！!？?、：:]/u).map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1) {
    // 打分只用来**选第一句**（封面只能承载一个视觉主体，多个主体会让画面失焦）。
    // 长度不参与打分，否则最长的句子必然胜出——「明年你的跨境运费和时效，就看
    // 这两条线」比「美英军机连夜调动」长，于是胜出，可它丢了主体，画面就不知道
    // 该画什么。
    const scored = parts.map((part, index) => {
      const hasNumber = /\d/u.test(part) ? 3 : 0
      const hasHook = /(提升|翻倍|增长|省下|降低|超过|倍|万|亿|免费|必看|揭秘|真相|居然|竟然)/u.test(part) ? 3 : 0
      return { part, index, score: hasNumber + hasHook }
    }).sort((left, right) => right.score - left.score || left.index - right.index)

    const picked = []
    let used = 0
    for (const { part } of scored) {
      const cost = [...part].length + (picked.length ? 1 : 0)
      if (used + cost > maxLength) continue
      picked.push(part)
      used += cost
    }
    if (picked.length) {
      // 按原文顺序读回去——挑选是为了选内容，语序仍要跟原标题一致。
      return parts.filter((part) => picked.includes(part)).join('，')
    }
  }

  // 没有可分句的（整句就是很长）：在空格或连接词处断开，读起来比硬砍自然。
  const head = [...raw].slice(0, maxLength).join('')
  const lastSpace = Math.max(head.lastIndexOf(' '), head.lastIndexOf('·'), head.lastIndexOf('：'))
  if (lastSpace >= Math.floor(maxLength * 0.5)) return head.slice(0, lastSpace)
  // 刻意不加分句号：封面标题带标点会显得像残句。
  return `${head}…`
}

/**
 * 封面生图提示词。
 *
 * 2026-10-25 用户反馈后重写。旧句式只有一句「根据提供的主题做一张视频封面，
 * 主题：<短标题>」——它出自 2026-10-10 的一次简化（当时用本机 Qwen-Image，
 * 模型对中文标题的审美足够好，规则越多越跑偏）。但生图模型已经换成
 * GPT 系列的 tt-image-2.5，白话短句对它的约束力明显不够，实测封面会出现
 * 主体偏小、留白过多、文字被裁等问题，比例也随模型自由发挥。
 *
 * 现在改成「一句话说清规格 + 分项要点」，只补模型确实会做错的部分，不再
 * 堆砌风格词（风格词正是让每张封面各不相同、且越来越跑偏的来源）：
 *   · 比例写死：模型对「画面比例」这类硬规格响应最好，必须显式给出；
 *   · 标题文字要求：主题文字是封面的信息主体，要求大、居视觉中心、不裁切；
 *   · 安全区：禁止把主体/文字贴边，避免平台侧裁切时切掉关键内容；
 *   · 画面结构：单一视觉主体 + 高对比，对应信息流缩略图只有拇指大小的现实。
 *
 * 仍然不写 negativePrompt：固定句式的正向约束已经够用，且部分中转端点对
 * negative_prompt 支持不一致，写了反而可能报错。
 */
export function coverImagePrompt(shortTitle, kind = 'landscape') {
  const spec = kind === 'portrait'
    ? '画面比例必须是 3:4（宽:高 = 3:4，推荐 1080x1440 像素）'
    : '画面比例必须是 4:3（宽:高 = 4:3，推荐 1440x1080 像素）'
  return [
    `生成一张${kind === 'portrait' ? '竖版' : '横版'}短视频封面图，${spec}，严格按此比例构图，不要生成其他比例。`,
    `画面主体文字：${shortTitle}`,
    '文字要求：主体文字要大而醒目，占画面主要位置，使用清晰的无修饰中文黑体，笔画完整，不得裁切、变形、被其他元素遮挡，不得出现错别字或乱码。',
    '构图要求：整幅画面只有一个明确视觉主体，主体与文字集中在画面中央区域，四周留出至少 6% 的安全边距，任何文字和关键图形都不要贴边。',
    '画面要求：高对比度、层次分明，色彩饱满，背景简洁不抢主体；不要使用大面积纯白或纯黑背景，不要出现细碎密集的小字和繁杂装饰。',
    '用途：这是手机信息流里以缩略图形式展示的封面，必须保证缩小到拇指大小时仍能一眼看清主体和文字。',
  ].join('\n')
}

export function buildPublishPrompt({ project }) {
  const topic = project?.artifacts?.topic?.data || {}
  const script = project?.artifacts?.script?.data?.body || ''
  const video = project?.artifacts?.video?.data || {}
  const qc = project?.artifacts?.qc?.data || {}
  return [
    '你是短视频发布包装 Agent。根据已冻结的账号定位、稿件、成片规格和质检结论，生成可供人工确认的发布资料。',
    '标题要准确、有信息量，不得编造稿件之外的事实；视频文案适合随视频发布；描述用于平台详情；标签输出 3-10 个，不带 #。',
    // 评论区互动：完播之外，评论是第二分发信号。引导必须具体、低门槛、与内容直接相关。
    '【互动引导】描述的最后要加一行向观众抛出的具体问题，规则：',
    '  - 问题必须与本条内容直接相关、观众一句话就能答（如「你们家乡管它叫什么」「你老家有这个讲究吗」「你听过哪个版本」），账号定位为讲述类时优先征集「家乡版本/老讲究」；',
    '  - 禁止空泛的「你怎么看」「评论区聊聊」；禁止抽奖、转发有礼、关注才告知结局式诱导；',
    '  - 故事类内容不得在标题或文案里剧透结局，用悬念缺口代替结论；',
    '  - 视频文案（copy）以稿件内容本身为主，不加互动话术——互动引导只在描述区，避免每条视频都像在讨评论。',
    // 封面提示词：**由程序按固定模板生成，Agent 只负责给短标题**。
    //
    // 2026-10-25 用户反馈后调整：生图模型换成 GPT 系列（tt-image-2.5）后，
    // 纯白话短句约束不住它，封面出现比例不对、主体偏小等问题。现在提示词
    // 里写死了 4:3 / 3:4 比例、文字大小、安全边距等硬规格——这些由代码保证，
    // 不再依赖 Agent 自由发挥。
    //
    // 所以这里 Agent 的任务收窄成：产出一个合格的封面短标题。提示词两个字段
    // 仍要求非空（schema 校验），但内容不会被直接使用。
    '【封面生图提示词】',
    '横竖两版提示词都由程序按固定模板生成（横版 4:3、竖版 3:4，并已包含文字大小与安全边距要求），你不需要写句式，只需要两个字段都填非空值。',
    '真正决定封面效果的是你给的「短标题」，要求：不超过 20 个字；保留视频标题里的核心专有名词与数字（如 WTO、GPT、AI、50%）；',
    '不要写成完整句子、不要加标点结尾、不要出现「视频」「封面」这类词。',
  // 封面三要素只作**取舍判据**，不是新增格式要求。
  '封面短标题的三个要素：观众视角（谁会点）、具体数字（多具体）、一句话结论（看完知道什么）。三个不必齐全，但**没有数字**时从原标题里找一个真实数字补上（专有名词和数字都要保留），**没有结论**时压缩成一个判断句。不要为了凑要素编造数字——稿件里没有就用专有名词替代。',
    '横屏与竖屏用同一个短标题。',
    '不要输出 negativePrompt（留空即可）。',
    '只返回 schema 要求的结构化结果，不输出 Markdown 或额外说明。',
    `项目标题：${project?.title || topic.title || '未命名'}`,
    `账号快照：${JSON.stringify(topic.account || null)}`,
    `视频方向与视觉方案：${JSON.stringify({ orientation: video.orientation || null, visualBrief: video.visualBrief || null, visualPlan: video.visualPlan || null })}`,
    `质检身份与结论：${JSON.stringify({ artifactId: project?.artifacts?.qc?.id || null, passed: qc.passed === true, summary: qc.review?.summary || null })}`,
    `完整口播稿：\n${script}`,
  ].join('\n\n')
}

export function normalizePublishResult(value) {
  const title = clipped(value?.title, 80)
  const copy = clipped(value?.copy, 2000)
  const description = clipped(value?.description, 1000)
  const landscape = clipped(value?.landscapePrompt, 3000)
  const portrait = clipped(value?.portraitPrompt, 3000)
  // negativePrompt 不再往下传：固定句式里没有「不要什么」，画面交给模型自己的审美。
  // Agent 仍然需要返回非空值（下面校验），但它的内容不再影响出图。
  const tags = [...new Set((Array.isArray(value?.tags) ? value.tags : [])
    .map((tag) => clipped(tag, 30).replace(/^#+/u, '').trim())
    .filter(Boolean))].slice(0, 10)
  if (!title || !copy || !description || !landscape || !portrait || tags.length < 1) {
    fail('SPOKEN_VIDEO_PUBLISH_AGENT_INVALID', '发布 Agent 返回的标题、文案、描述、标签或封面提示词不完整。')
  }
  // 提示词不再直接采用 Agent 返回的内容——统一按固定句式重写，主题取封面短标题。
  //
  // 为什么不信任 Agent 给的提示词：句式是固定的，而模型总会「顺手」加些修饰
  // （风格词、场景描述）。一旦把这些自由发挥带进生图请求，每张封面都会长得
  // 不一样，而且比例、主体大小都会失控。这里保证规格约束一定成立，而不是
  // 指望模型听话。Agent 返回的两版提示词仍要求非空（上面已校验），作为
  // 「它确实思考过封面」的信号。
  //
  // 横竖两版必须分别生成：比例是硬约束，横版写 4:3、竖版写 3:4，不能共用一句。
  const shortTitle = shortenCoverTitle(title)
  return {
    content: { title, copy, description, tags },
    prompts: {
      landscape: coverImagePrompt(shortTitle, 'landscape'),
      portrait: coverImagePrompt(shortTitle, 'portrait'),
      negative: '',
    },
    coverTitle: shortTitle,
  }
}

export function publishImageRequest({ model, prompt, negativePrompt, size }) {
  return {
    model: clipped(model, 120) || PUBLISH_IMAGE_MODEL,
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: {
      size,
      n: 1,
      prompt_extend: true,
      watermark: false,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    },
  }
}

/**
 * 通用异步协议的提交体。
 *
 * 2026-10-26 实测：聚合服务（lk888）的 `/v1/media/generate` 要的是**顶层
 * prompt**，不是百炼那套 `input.messages[].content[].text`——后者会被判
 * 「缺少必要参数 prompt」，任务根本建不起来：
 *   {"code":400,"data":{"详情":"缺少必要参数 prompt（可放在请求体顶层，也可放在 params 里）"}}
 *
 * 它同时接受 `size` 写成 `1280x720` 或 `1280*720` 两种，两种都实测通过。
 *
 * 所以这里单独给一套扁平体：既有 `input.messages`（百炼/SciTiger 认），也有
 * 顶层 `prompt` 与 `params`（聚合服务认）。多写的字段对认不认它们的服务都是
 * 无害的，而少写任何一个都会让其中一族直接失败。
 */
export function customAsyncImageRequest({ model, prompt, negativePrompt, size }) {
  return {
    model: clipped(model, 120) || PUBLISH_IMAGE_MODEL,
    prompt,
    params: { size, n: 1, ...(negativePrompt ? { negative_prompt: negativePrompt } : {}) },
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: {
      size,
      n: 1,
      prompt_extend: true,
      watermark: false,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    },
  }
}

export function imageTaskId(value) {
  // 2026-10-26：多认一种聚合服务的形态——它把任务 id 放在 `data.task_id`
  // （或 `data.task_ids[0]`），而不是百炼那套的 `output.task_id`。
  // 2026-10-26 实测 lk888 的 `/v1/media/generate` 就是这个形态：
  //   {"code":200,"data":{"task_id":190654098,"task_ids":[190654098]},"msg":"任务创建成功"}
  // 少认这一处，提交会被当成「没拿到任务 id」，封面就永远等不到图。
  const nested = value?.data
  return clipped(
    value?.output?.task_id || value?.output?.taskId || value?.task_id || value?.taskId
    || nested?.task_id || nested?.taskId || (Array.isArray(nested?.task_ids) ? nested.task_ids[0] : null),
    200,
  ) || null
}

export function imageTaskState(value) {
  // 同上：聚合服务用 `state`（running/success/failed）而不是 `status`，
  // 且把它放在顶层或 `data` 里。
  //
  // 2026-10-26 修正取值顺序：**先读英文的 `state`，再读 `status`**。
  // 实测 lk888 的响应里 `status` 是中文（"处理中"/"已完成"），而失败判定
  // 比的是英文状态名（FAILED/CANCELED/…）。先读 status 会读到 "处理中"，
  // 于是失败态永远认不出来——任务失败时只能一路等到轮询超时。
  const nested = value?.data
  return clipped(
    value?.output?.task_status || value?.output?.taskStatus || value?.task_status
    || value?.state || nested?.state
    || value?.status || nested?.status || nested?.task_status,
    40,
  ).toUpperCase() || null
}

export function extractPublishImageUrl(value) {
  const choices = Array.isArray(value?.output?.choices) ? value.output.choices : []
  for (const choice of choices) {
    const content = Array.isArray(choice?.message?.content) ? choice.message.content : []
    for (const item of content) {
      const candidate = typeof item?.image === 'string' ? item.image : typeof item?.url === 'string' ? item.url : null
      if (candidate?.trim()) return candidate.trim()
    }
  }
  // 2026-10-26：聚合服务的完成态把图放在 `result_url`（单张）或
  // `result_urls`（多张）里，位置在顶层或 `data` 下。实测 lk888：
  //   {"state":"success","is_final":true,"result_type":"image","result_url":"https://...png","result_urls":["https://...png"]}
  for (const source of [value, value?.data]) {
    if (!source || typeof source !== 'object') continue
    const single = typeof source.result_url === 'string' ? source.result_url : null
    if (single?.trim()) return single.trim()
    const list = Array.isArray(source.result_urls) ? source.result_urls : []
    const first = list.find((item) => typeof item === 'string' && item.trim())
    if (first) return first.trim()
  }
  for (const key of ['results', 'images']) {
    const items = Array.isArray(value?.output?.[key]) ? value.output[key] : []
    for (const item of items) {
      const candidate = typeof item === 'string' ? item : typeof item?.url === 'string' ? item.url : typeof item?.image === 'string' ? item.image : null
      if (candidate?.trim()) return candidate.trim()
    }
  }
  return null
}

function jpegDimensions(bytes) {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    if (marker === 0xd9 || marker === 0xda) break
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) break
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}

function webpDimensions(bytes) {
  const type = bytes.toString('ascii', 12, 16)
  if (type === 'VP8X' && bytes.length >= 30) {
    if ((bytes[20] & 0x02) !== 0) fail('SPOKEN_VIDEO_PUBLISH_IMAGE_INVALID', '不支持动态 WebP 封面。')
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
  }
  if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return null
}

export function inspectPublishImage(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  let mediaType = null
  let extension = null
  let dimensions = null
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mediaType = 'image/png'; extension = 'png'; dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    mediaType = 'image/jpeg'; extension = 'jpg'; dimensions = jpegDimensions(bytes)
  } else if (bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mediaType = 'image/webp'; extension = 'webp'; dimensions = webpDimensions(bytes)
  }
  if (!mediaType || !dimensions?.width || !dimensions?.height || dimensions.width > 8192 || dimensions.height > 8192) {
    fail('SPOKEN_VIDEO_PUBLISH_IMAGE_INVALID', '封面只支持有效的 PNG、JPEG 或静态 WebP，且尺寸不能超过 8192x8192。')
  }
  return { mediaType, extension, width: dimensions.width, height: dimensions.height, bytes: bytes.length }
}
