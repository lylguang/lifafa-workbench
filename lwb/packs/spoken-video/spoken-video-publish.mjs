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
    '同时分别编写横屏 16:9 与竖屏 9:16 封面生图提示词。封面需突出真实主题和标题信息，构图清楚，避免小字、平台水印、二维码和无关人物。',
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
