export const PUBLISH_IMAGE_PROVIDERS = Object.freeze(['bailian', 'scitiger'])
export const PUBLISH_IMAGE_CREDENTIALS = Object.freeze({
  bailian: 'DASHSCOPE_API_KEY',
  scitiger: 'LWB_SPOKEN_VIDEO_CLOUD_IMAGE_API_KEY',
})
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

export function publishImageConfig(environment = process.env) {
  return {
    bailianBaseUrl: endpoint(environment.LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL || 'https://dashscope.aliyuncs.com', '百炼生图地址'),
    scitigerBaseUrl: endpoint(environment.LWB_SPOKEN_VIDEO_CLOUD_IMAGE_BASE_URL || environment.LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL || 'https://link.scitiger.cn', '云端生图地址'),
    model: clipped(environment.LWB_SPOKEN_VIDEO_IMAGE_MODEL || PUBLISH_IMAGE_MODEL, 120) || PUBLISH_IMAGE_MODEL,
  }
}

export function buildPublishPrompt({ project }) {
  const topic = project?.artifacts?.topic?.data || {}
  const script = project?.artifacts?.script?.data?.body || ''
  const video = project?.artifacts?.video?.data || {}
  const qc = project?.artifacts?.qc?.data || {}
  return [
    '你是短视频发布包装 Agent。根据已冻结的账号定位、稿件、成片规格和质检结论，生成可供人工确认的发布资料。',
    '标题要准确、有信息量，不得编造稿件之外的事实；视频文案适合随视频发布；描述用于平台详情；标签输出 3-10 个，不带 #。',
    '同时分别编写横屏 16:9 与竖屏 3:4 封面生图提示词。',
    // 封面分工：**AI 直接在图上写中文标题**。
    //
    // 2026-10-08 实测推翻了旧结论：本机 Qwen-Image（20B）写汉字完全正确、零乱码，
    // 横竖两版都一次成功。所以不再需要「底图留空 + 程序叠字」那套——那样产出的封面
    // 是「正确但没人会点」的：把文字、人物、纵深全禁掉，只剩抽象符号和图标。
    //
    // 现在的要求是把标题当**视觉主体**来写：巨大、倾斜、有描边、关键词着色，
    // 配实景摄影感的场景。信息流缩略图里「一眼看清讲什么」比画面精美重要得多。
    '【封面生图提示词的硬性要求】',
    '1. 风格：高品质商业海报封面，实景摄影质感，戏剧化的电影级光影。不要扁平图标风、不要极简示意图、不要抽象符号堆砌。',
    '2. 场景要**具象可辨**：用真实世界里能认出主题的实物与场景（如港口货柜与货轮、仓库货架、工厂车间、办公室与电脑屏、后市交易屏幕等），而不是箭头、柱状图、地球轮廓这类抽象图形。',
    '3. **必须有人物**：出现一到两位专业人士的侧后方身影或背影（商务人士、工程师、店主皆可），面部不可见或被背对，用来传递「正在处理这件事」的代入视角。人物要低调，不抢标题。',
    '4. 时间与色调：优先傍晚或夜间的**蓝调时刻**，深靛蓝主调配橙色暖色点缀（货柜、灯光、霓虹招牌等），形成互补色对比与纵深，不要灰白平光的平淡日光。',
    '5. **标题就是画面主体**：在画面上部（横屏左上、竖屏上半部）叠加超大号中文标题，占据画面显著面积，不要小字。',
    '6. 标题样式：超粗黑体（小标题体），字面纯白，带 6 像素左右深色硬描边加柔和投影，形成立体 pops 效果；整体**微微倾斜约 -4 度**，有手写海报的随性感，**不要端正平铺**。',
    '7. 标题必须**分两行**：第一行是较短的铺垫（含一个英文缩写或专有名词，如 WTO），第二行是**字号最大、最醒目**的核心悬念句。把关键词（如 WTO、GPT、AI）用高饱和亮橙色单独强调，其余文字白色，形成主次分明的视觉层级。',
    '8. 标题文字**必须与本条视频的真实标题完全一致**，逐字照写，不得改写、缩写或编造；字形必须清晰正确、不能出现错字乱码或扭曲。',
    '9. 标题之外不要再出现任何其他文字、字母、数字、水印或二维码。',
    '10. 竖屏 3:4 比横版更高更窄：标题占画面上半部约 45%-50%，场景元素集中在下半部（集装箱、桌面、人物背影），不要沿用横版的左右分栏构图。',
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
  const negative = clipped(value?.negativePrompt, 1000)
  const tags = [...new Set((Array.isArray(value?.tags) ? value.tags : [])
    .map((tag) => clipped(tag, 30).replace(/^#+/u, '').trim())
    .filter(Boolean))].slice(0, 10)
  if (!title || !copy || !description || !landscape || !portrait || tags.length < 1) {
    fail('SPOKEN_VIDEO_PUBLISH_AGENT_INVALID', '发布 Agent 返回的标题、文案、描述、标签或封面提示词不完整。')
  }
  return { content: { title, copy, description, tags }, prompts: { landscape, portrait, negative } }
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
