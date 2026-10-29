/**
 * 配音/字幕媒体服务的环境配置读取（story-account 包内副本）。
 *
 * 之前 `story-account-voice.mjs` 用相对路径 `../spoken-video/spoken-video-media.mjs`
 * 跨包 import，story-account 单独安装/单独加载时该路径会解析失败。这里改为在本
 * 包内读取，消除跨包相对路径依赖。
 *
 * 刻意与 spoken-video 的 `mediaServiceConfig` 保持**同一套环境变量名**
 * （LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL 等）——运维只需配一次媒体服务，两个内容
 * 包都能用，不另起一套变量名（两套 TTS 配置意味着两份密钥和两处可能配错的地方）。
 *
 * 注意：这是对 spoken-video 那份实现的镜像，应逐步收口到包注册/公共模块，让两包
 * 复用同一份实现，而不是各持一份。修改媒体服务配置语义时，两边都要同步。
 */

export class StoryAccountMediaConfigError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  return new StoryAccountMediaConfigError(code, message)
}

function text(value, label, maximum, required = true) {
  if ((value === undefined || value === null) && !required) return undefined
  if (typeof value !== 'string') throw fail('STORY_ACCOUNT_MEDIA_INVALID_INPUT', `${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > maximum) throw fail('STORY_ACCOUNT_MEDIA_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return result
}

function optionalText(value, label, maximum) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
    ? null
    : text(value, label, maximum)
}

function outputFormat(value, label, fallback = null) {
  const result = optionalText(value, label, 12)
  if (!result) return fallback
  const format = result.toLowerCase()
  if (!['wav', 'mp3', 'm4a', 'ogg'].includes(format)) {
    throw fail('STORY_ACCOUNT_MEDIA_INVALID_INPUT', `${label}只支持 wav、mp3、m4a 或 ogg。`)
  }
  return format
}

function endpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw fail('STORY_ACCOUNT_MEDIA_CONFIG_INVALID', 'TTS 服务地址必须是 HTTP(S) URL。')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail('STORY_ACCOUNT_MEDIA_CONFIG_INVALID', 'TTS 服务地址无效。')
  }
  return parsed.toString().replace(/\/$/u, '')
}

/**
 * 读取媒体服务配置。返回值与 spoken-video 的 `mediaServiceConfig` 同形，
 * story-account 当前只用到 `baseUrl` 与 `configured`。
 */
export function mediaServiceConfig(environment = process.env) {
  // 与 spoken-video 的 mediaServiceConfig 保持同一份语义：endpointConfigured 表示
  // 「显式」配置了桥接地址（默认回退到本机桥接占位时不算），configured /
  // scitigerConfigured 仍表示桥接地址可用（默认占位也算），以兼容宿主的可用性
  // 判断与鉴权流程。服务可达性由宿主运行时探测，不在此处臆断。
  const explicitBridge = environment.LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL || environment.SCITIGER_BASE_URL
  const bridgeBaseUrl = endpoint(explicitBridge || 'http://127.0.0.1:8199')
  const endpointConfigured = Boolean(explicitBridge)
  // 校验 TTS 兼容服务地址：本包实际只用桥接地址，但误填成非 HTTP(S) 值（如 file://）
  // 仍应尽早报配置错误，而不是静默忽略。
  endpoint(environment.LWB_SPOKEN_VIDEO_TTS_BASE_URL || environment.TTS_SERVICE_BASE_URL)
  return {
    baseUrl: bridgeBaseUrl,
    endpointConfigured,
    configured: Boolean(bridgeBaseUrl),
    userId: optionalText(environment.LWB_SPOKEN_VIDEO_TTS_USER_ID || environment.TTS_USER_ID, 'TTS 用户标识', 120),
    provider: optionalText(environment.LWB_SPOKEN_VIDEO_TTS_PROVIDER || environment.TTS_PROVIDER, 'TTS 提供方', 80) || 'bridge',
    outputFormat: outputFormat(environment.LWB_SPOKEN_VIDEO_TTS_OUTPUT_FORMAT || environment.TTS_OUTPUT_FORMAT, 'TTS 输出格式', 'wav'),
    bridgeBaseUrl,
    scitigerBaseUrl: bridgeBaseUrl,
    scitigerConfigured: Boolean(bridgeBaseUrl),
  }
}
