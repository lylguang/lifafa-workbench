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

/** 封面生图提示词的固定句式。短标题由标题优化那一步给出。 */
export function coverImagePrompt(shortTitle) {
  return `根据提供的主题做一张视频封面，主题：${shortTitle}`
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
    // 封面提示词：**固定句式，只填主题**。
    //
    // 2026-10-10 用户简化：此前十条规则（风格/场景/人物/色调/标题样式/分行…）让
    // 模型自由发挥，结果每张封面长得都不一样，而且规则越多越容易跑偏。实测
    // tt-image-2.5 本身对中文标题的渲染已经很好（零乱码、关键词可着色），不需要
    // 用提示词去反复约束它。
    //
    // 现在只给一句固定前缀 + 一个主题，画面怎么画交给模型自己的审美——这反而
    // 更稳，也让人一眼看懂提示词在说什么。
    '【封面生图提示词】',
    '固定句式，逐字照写，只把 <短标题> 替换成本条视频的封面短标题：',
    '根据提供的主题做一张视频封面，主题：<短标题>',
    '<短标题> 要求：不超过 20 个字；保留视频标题里的核心专有名词与数字（如 WTO、GPT、AI、50%）；',
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
  // （风格词、场景描述）。2026-10-10 用户要求逐字照写成「根据提供的主题做一张
  // 视频封面，主题：<短标题>」，那就在这里保证它一定成立，而不是指望模型听话。
  // Agent 返回的两版提示词仍要求非空（上面已校验），作为「它确实思考过封面」的信号。
  const shortTitle = shortenCoverTitle(title)
  const prompt = coverImagePrompt(shortTitle)
  return {
    content: { title, copy, description, tags },
    prompts: { landscape: prompt, portrait: prompt, negative: '' },
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

export function imageTaskId(value) {
  return clipped(value?.output?.task_id || value?.output?.taskId || value?.task_id || value?.taskId, 200) || null
}

export function imageTaskState(value) {
  return clipped(value?.output?.task_status || value?.output?.taskStatus || value?.task_status || value?.status, 40).toUpperCase() || null
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
