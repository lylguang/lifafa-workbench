import { validateSrt } from './spoken-video-subtitles.mjs'
import { countInlineAudioTags } from './spoken-video-media-mimo.mjs'
import { measureNarrativeRhythm, measureSceneTimeline } from './spoken-video-rhythm.mjs'

export const MEDIA_OPERATION_TYPES = Object.freeze(['voiceover', 'subtitles', 'video', 'qc'])
export const MEDIA_OPERATION_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed'])
export const MEDIA_PROVIDERS = Object.freeze(['bailian', 'scitiger', 'legacy', 'mimo'])
export const MEDIA_CONNECTION_PROVIDERS = Object.freeze(['bailian', 'scitiger', 'mimo'])
export const VIDEO_ORIENTATIONS = Object.freeze(['portrait', 'landscape'])
export const MEDIA_PROVIDER_CREDENTIAL_REFS = Object.freeze({
  bailian: 'DASHSCOPE_API_KEY',
  scitiger: 'LWB_SPOKEN_VIDEO_SCITIGER_API_KEY',
  /**
   * 小米 MiMo：platform.xiaomimimo.com 创建的 sk-... key，免费、无需实名。
   *
   * **运行时真正生效的是用户在连接设置界面保存到本包命名空间的那一份**，
   * 不是团队凭据库里同名的共享条目——两者并存、互不覆盖，也不要当成同一份：
   *   · 界面保存 → pack-services.mjs:17 先做 `toLowerCase().replaceAll('_','-')`
   *     → packCredentialRef() 再拼上包前缀，最终条目形如
   *     `LWB_PACK_12_SPOKEN_VIDEO_18_XIAOMIMIMO_API_KEY`；
   *   · 团队共享条目 `XIAOMIMIMO_API_KEY` 是独立通道，只有直接读
   *     `$DSH_SECRET_XIAOMIMIMO_API_KEY`（脚本、冒烟、CI）才会用到。
   *
   * 包前缀是刻意的隔离设计（pack-services.test.mjs 有跨包互不可见的断言），
   * 不要为了让两边「收敛成一条」而绕过它——那会破坏包间隔离。
   * 撤销/轮换 Key 时注意区分这两条，别只撤其中一份就以为完事。
   */
  mimo: 'XIAOMIMIMO_API_KEY',
})
export const VOICE_SOURCES = Object.freeze(['system', 'preset', 'upload', 'reference', 'design'])
export const DEFAULT_VOICE_PROFILE = Object.freeze({
  id: 'tiffy-confident',
  name: 'Tiffy - 自信',
  file: 'assets/voices/tiffy-confident.mp3',
  mediaType: 'audio/mpeg',
})
export const DEFAULT_VIDEO_VISUAL_BRIEF = '由 AI 视觉导演根据稿件语义完成主题化 Remotion 画面。'
export const DEFAULT_VIDEO_BGM_VOLUME = 0.12

export class SpokenVideoMediaError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  return new SpokenVideoMediaError(code, message)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}必须是对象。`)
  return value
}

function text(value, label, maximum, required = true) {
  if ((value === undefined || value === null) && !required) return undefined
  if (typeof value !== 'string') throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > maximum) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return result
}

function number(value, label, minimum, maximum, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}必须在 ${minimum}-${maximum} 之间。`)
  return Number(value)
}

function optionalText(value, label, maximum) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
    ? null
    : text(value, label, maximum)
}

function oneOf(value, label, choices, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const result = text(value, label, 80).toLowerCase()
  if (!choices.includes(result)) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}不受支持。`)
  return result
}

function outputFormat(value, label, fallback = null) {
  const result = optionalText(value, label, 12)
  if (!result) return fallback
  const format = result.toLowerCase()
  if (!['wav', 'mp3', 'm4a', 'ogg'].includes(format)) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}只支持 wav、mp3、m4a 或 ogg。`)
  }
  return format
}

function endpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw fail('SPOKEN_VIDEO_MEDIA_CONFIG_INVALID', 'TTS 服务地址必须是 HTTP(S) URL。')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail('SPOKEN_VIDEO_MEDIA_CONFIG_INVALID', 'TTS 服务地址无效。')
  }
  return parsed.toString().replace(/\/$/u, '')
}

function websocketEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw fail('SPOKEN_VIDEO_MEDIA_CONFIG_INVALID', '百炼 ASR 地址必须是 WebSocket URL。')
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail('SPOKEN_VIDEO_MEDIA_CONFIG_INVALID', '百炼 ASR 地址无效。')
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
  return parsed.toString().replace(/\/$/u, '')
}

/** Loopback endpoints are this machine's own bridge: it serves any bearer token. */
export function isLoopbackEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

/** Reads only operator-owned environment configuration. Browser input never supplies an endpoint or credential. */
export function mediaServiceConfig(environment = process.env) {
  const baseUrl = endpoint(environment.LWB_SPOKEN_VIDEO_TTS_BASE_URL || environment.TTS_SERVICE_BASE_URL)
  const scitigerBaseUrl = endpoint(environment.LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL || environment.SCITIGER_BASE_URL || 'https://link.scitiger.cn')
  const bailianBaseUrl = endpoint(environment.LWB_SPOKEN_VIDEO_BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1')
  return {
    baseUrl,
    configured: Boolean(baseUrl),
    userId: optionalText(environment.LWB_SPOKEN_VIDEO_TTS_USER_ID || environment.TTS_USER_ID, 'TTS 用户标识', 120),
    provider: optionalText(environment.LWB_SPOKEN_VIDEO_TTS_PROVIDER || environment.TTS_PROVIDER, 'TTS 提供方', 80) || 'cosyvoice',
    outputFormat: outputFormat(environment.LWB_SPOKEN_VIDEO_TTS_OUTPUT_FORMAT || environment.TTS_OUTPUT_FORMAT, 'TTS 输出格式', 'wav'),
    bailianBaseUrl,
    bailianAsrWebSocketUrl: websocketEndpoint(environment.LWB_SPOKEN_VIDEO_BAILIAN_ASR_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
    bailianAsrModel: optionalText(environment.LWB_SPOKEN_VIDEO_BAILIAN_ASR_MODEL, '百炼 ASR 模型', 120) || 'qwen3-asr-flash-realtime',
    bailianModel: optionalText(environment.LWB_SPOKEN_VIDEO_BAILIAN_TTS_MODEL, '百炼 TTS 模型', 120) || 'qwen3-tts-flash',
    bailianDefaultVoice: optionalText(environment.LWB_SPOKEN_VIDEO_BAILIAN_DEFAULT_VOICE, '百炼默认音色', 80) || 'Cherry',
    bailianVoiceEnrollmentModel: optionalText(environment.LWB_SPOKEN_VIDEO_BAILIAN_VOICE_ENROLLMENT_MODEL, '百炼声音复刻模型', 120) || 'qwen-voice-enrollment',
    bailianVoiceCloneModel: optionalText(environment.LWB_SPOKEN_VIDEO_BAILIAN_VOICE_CLONE_MODEL, '百炼复刻 TTS 模型', 120) || 'qwen3-tts-vc-2026-01-22',
    scitigerBaseUrl,
    scitigerConfigured: Boolean(scitigerBaseUrl),
    // 小米 MiMo TTS。注意它是 chat/completions 形态（不是 /audio/speech），
    // 鉴权头是 api-key —— 见 spoken-video-media-mimo.mjs 头部说明。
    mimoBaseUrl: endpoint(environment.LWB_SPOKEN_VIDEO_MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1'),
    mimoModel: optionalText(environment.LWB_SPOKEN_VIDEO_MIMO_MODEL, '小米 MiMo TTS 模型', 120) || 'mimo-v2.5-tts',
    mimoDefaultVoice: optionalText(environment.LWB_SPOKEN_VIDEO_MIMO_DEFAULT_VOICE, '小米 MiMo 默认音色', 80) || '冰糖',
    mimoStyle: optionalText(environment.LWB_SPOKEN_VIDEO_MIMO_STYLE, '小米 MiMo 语气风格', 200) || '',
    // 相邻两次请求最小间隔（毫秒）。官方 RPM 100 看似宽裕，但分段连发实测会 429，
    // 串行 + 2 秒间隔把峰值压到 ~30 RPM。
    mimoMinGapMs: number(environment.LWB_SPOKEN_VIDEO_MIMO_MIN_GAP_MS, '小米 MiMo 请求间隔', 0, 60_000, 2000),
    // 音频标签由前端拼进正文发送（见 buildTaggedText），后端只做长度与形态校验。
    mimoMaxAudioTags: number(environment.LWB_SPOKEN_VIDEO_MIMO_MAX_AUDIO_TAGS, '小米 MiMo 音频标签数上限', 0, 20, 8),
  }
}

export function normalizeVoiceoverRequest(value) {
  const input = object(value ?? {}, '配音请求')
  const voiceSource = oneOf(input.voiceSource, '音色来源', VOICE_SOURCES, 'system')
  const voiceId = optionalText(input.voiceId, '音色标识', 160)
  if (voiceSource === 'preset' && !voiceId) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '指定预置音色时必须填写音色标识。')
  }
  const referenceInput = input.referenceAudio == null ? null : object(input.referenceAudio, '参考音频')
  const referenceAudio = referenceInput ? {
    id: optionalText(referenceInput.id, '参考音频标识', 64),
    file: optionalText(referenceInput.file, '参考音频文件', 280),
    name: optionalText(referenceInput.name, '参考音频名称', 255),
    mediaType: optionalText(referenceInput.mediaType, '参考音频类型', 80),
  } : null
  if (voiceSource === 'upload' && (!referenceAudio?.id || !referenceAudio.file || !referenceAudio.name || !referenceAudio.mediaType)) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '使用自定义音色时请先上传参考音频。')
  }
  // voicedesign：音色的唯一来源就是这句描述，缺了就没有音色可用。
  const voiceDesign = optionalText(input.voiceDesign, '音色描述', 500)
  if (voiceSource === 'design' && !voiceDesign) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音色设计模式需要填写音色描述。')
  }
  if (voiceSource !== 'design' && voiceDesign) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音色描述只在音色设计模式下有效。')
  }
  // 音频标签由前端拼进正文（用户要能在文本框里看见自己插的标签），后端只校验形态。
  // 正文本身不在本函数可见范围（稿件是项目里的 artifact），所以**内插标签的计数
  // 在 host 拿到正文时再做**（见 spoken-video-media-host.mjs 的 #mimoVoiceover），
  // 那里才能把两种括号形式的标签放进同一个上限里算。
  const audioTags = normalizeAudioTags(input.audioTags)
  // 桥接（SciTiger 端点）专属提示，仅当请求打到桥接时生效：channel 覆盖桥接的
  // 云端/本地开关，style 覆盖其预期风格；其他渠道原样忽略。
  const bridgeInput = input.bridge == null ? null : object(input.bridge, '桥接配音设置')
  return {
    provider: oneOf(input.provider, '生成方式', MEDIA_PROVIDERS, 'mimo'),
    voiceSource,
    voiceId,
    voiceName: optionalText(input.voiceName, '音色名称', 120)
      || (voiceSource === 'upload' ? referenceAudio.name : ['system', 'reference'].includes(voiceSource) ? DEFAULT_VOICE_PROFILE.name : null),
    referenceAudio: voiceSource === 'upload' ? referenceAudio : null,
    voiceDesign: voiceSource === 'design' ? voiceDesign : null,
    audioTags,
    outputFormat: outputFormat(input.outputFormat, '输出格式'),
    rate: number(input.rate, '语速', 0.5, 2, 1),
    volume: number(input.volume, '音量', 0, 2, 1),
    pitch: number(input.pitch, '音高', -12, 12, 0),
    bridge: bridgeInput ? {
      channel: oneOf(bridgeInput.channel, '桥接配音方式', ['cloud', 'local'], null),
      style: optionalText(bridgeInput.style, '桥接预期风格', 200),
    } : null,
  }
}

/**
 * 音频标签形态校验。
 *
 * 官方是两套语法：开头 `(风格)`（由 audioTags 入参承载）与正文内插 `[音频标签]`
 * （用户直接写在文本里）。两套**共用同一个数量上限**——内插的那种不经过入参，
 * 若不单独清点就能无限贴，等于把正文变成一串标签，也是裸传给模型的形态。
 */
function normalizeAudioTags(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频标签必须是数组。')
  const list = value.map((item) => {
    const raw = String(item ?? '').trim()
    // 官方只承认 () / （） / [] 三种外层括号，其余（如【】）不当成标签壳。
    const TAG_SHELL = /^[(（\[［](.*)[)）\]］]$/u
    const inner = TAG_SHELL.test(raw) ? raw.replace(TAG_SHELL, '$1').trim() : raw
    if (!inner) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频标签不能为空。')
    if (inner.length > 40) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '单个音频标签不能超过 40 字。')
    // 标签内不得再带任何括号（含官方不认的【】），否则拼接后会与官方语法冲突、模型解析歧义。
    if (/[[\]［］()（）【】]/u.test(inner)) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频标签内不能包含括号。')
    return inner
  })
  if (list.length > MIMO_TOTAL_TAG_LIMIT) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `音频标签最多 ${MIMO_TOTAL_TAG_LIMIT} 个。`)
  }
  return list
}

/** 入参标签 + 正文内插标签的合计上限。 */
export const MIMO_TOTAL_TAG_LIMIT = 8

/**
 * 在拿到正文后做最终计数：入参标签与正文里用户手写的 [叹气] 这类内插标签
 * 共用同一个上限。内插的那种不经入参，不清点就能无限贴，且是裸传给模型的形态。
 *
 * 内插只认**成对且形态合法**的（≤40 字、内部无括号），`[1]` 这类中括号引用与孤立
 * 起始符一律放行——误判正常文案会让用户改稿时莫名被拒，比漏算一个标签更糟。
 * 前后端口径必须一致，见 countInlineAudioTags 的注释。
 */
export function assertTotalAudioTags(script, audioTags) {
  const inline = countInlineAudioTags(script)
  const total = (Array.isArray(audioTags) ? audioTags.length : 0) + inline
  if (total > MIMO_TOTAL_TAG_LIMIT) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `音频标签最多 ${MIMO_TOTAL_TAG_LIMIT} 个（当前 ${total} 个：入参 ${audioTags?.length ?? 0} 个，正文内插 ${inline} 个）。`)
  }
  return total
}

export function normalizeSubtitleRequest(value) {
  const input = object(value ?? {}, '字幕请求')
  return {
    provider: oneOf(input.provider, '生成方式', MEDIA_PROVIDERS, 'mimo'),
    language: optionalText(input.language, '字幕语言', 16) || 'zh',
    aiOptimize: input.aiOptimize === true,
  }
}

export function mediaCredentialRef(provider) {
  const normalized = oneOf(provider, '生成方式', MEDIA_CONNECTION_PROVIDERS, null)
  if (!normalized) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '该生成方式不支持保存 API Key。')
  return MEDIA_PROVIDER_CREDENTIAL_REFS[normalized]
}

export function normalizeRenderRequest(value) {
  const input = object(value ?? {}, '视频渲染请求')
  const renderer = optionalText(input.renderer, '渲染器', 40) || 'remotion'
  if (!['remotion', 'local-ffmpeg', 'whiteboard'].includes(renderer)) throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '渲染器只支持 remotion、local-ffmpeg 或 whiteboard。')
  const orientation = oneOf(input.orientation, '视频方向', VIDEO_ORIENTATIONS, 'landscape')
  const requestedBrief = optionalText(input.visualBrief, '画面制作说明', 6000)
  const backgroundMusicInput = input.backgroundMusic == null ? null : object(input.backgroundMusic, '背景音乐')
  const backgroundMusic = backgroundMusicInput ? {
    id: optionalText(backgroundMusicInput.id, '背景音乐标识', 64),
    file: optionalText(backgroundMusicInput.file, '背景音乐文件', 280),
    name: optionalText(backgroundMusicInput.name, '背景音乐名称', 255),
    mediaType: optionalText(backgroundMusicInput.mediaType, '背景音乐类型', 80),
    bytes: number(backgroundMusicInput.bytes, '背景音乐字节数', 1, 20 * 1024 * 1024, null),
    durationSeconds: number(backgroundMusicInput.durationSeconds, '背景音乐时长', 0.01, 36_000, null),
  } : null
  if (backgroundMusic && (!backgroundMusic.id || !backgroundMusic.file || !backgroundMusic.name || !backgroundMusic.mediaType)) {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '使用背景音乐时请先完成 BGM 上传。')
  }
  if (backgroundMusic && !/^media\/bgm-uploads\/[a-f0-9]{32}\.(?:mp3|wav|m4a|ogg)$/u.test(backgroundMusic.file)) {
    throw fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐引用无效。')
  }
  if (backgroundMusic && renderer !== 'remotion') {
    throw fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '背景音乐仅支持 Remotion 视频任务。')
  }
  return {
    visualBrief: ['默认信息型竖屏口播版式。', '默认信息型口播版式。'].includes(requestedBrief) ? DEFAULT_VIDEO_VISUAL_BRIEF : requestedBrief || DEFAULT_VIDEO_VISUAL_BRIEF,
    renderer,
    orientation,
    subtitleEnabled: input.subtitleEnabled !== false,
    backgroundMusic,
    bgmVolume: backgroundMusic ? number(input.bgmVolume, 'BGM 音量', 0, 0.5, DEFAULT_VIDEO_BGM_VOLUME) : null,
  }
}

export function serviceHeaders(config) {
  return {
    'Content-Type': 'application/json',
    ...(config.userId ? { 'X-User-Id': config.userId } : {}),
  }
}

export function serviceData(body, operation) {
  if (!body || body.code !== 200) {
    const detail = typeof body?.message === 'string' ? body.message : '服务没有返回成功结果'
    throw fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${operation}失败：${detail}`)
  }
  if (!body.data || typeof body.data !== 'object') throw fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${operation}没有返回有效数据。`)
  return body.data
}

export function taskIdFromService(data, operation) {
  return text(data?.task_id, `${operation}任务标识`, 200)
}

export function taskState(data, operation) {
  const status = text(data?.status, `${operation}任务状态`, 40).toLowerCase()
  if (!['queued', 'pending', 'processing', 'running', 'completed', 'failed', 'cancelled'].includes(status)) {
    throw fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${operation}返回了未知任务状态。`)
  }
  return status
}

export function subtitleResult(data) {
  const result = data?.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result : null
  const segments = Array.isArray(result?.subtitle_segments) && result.subtitle_segments.length
    ? result.subtitle_segments
    : Array.isArray(data?.subtitle_segments) && data.subtitle_segments.length
      ? data.subtitle_segments
      : null
  const raw = segments
    ? srtFromSubtitleSegments(segments)
    : typeof result?.subtitle_srt === 'string'
      ? result.subtitle_srt
      : typeof data?.subtitle_srt === 'string'
        ? data.subtitle_srt
        : typeof result?.subtitle_srt_base64 === 'string'
          ? Buffer.from(result.subtitle_srt_base64, 'base64').toString('utf8')
          : typeof data?.subtitle_srt_base64 === 'string'
            ? Buffer.from(data.subtitle_srt_base64, 'base64').toString('utf8')
            : ''
  const srt = raw.replace(/^\uFEFF/u, '').trim()
  const checked = validateSrt(srt)
  if (!srt || checked.errors.length) {
    const detail = checked.errors.length ? checked.errors.join(' ') : '服务没有返回字幕内容。'
    throw fail('SPOKEN_VIDEO_SUBTITLES_INVALID', `自动对齐字幕不可用：${detail}`)
  }
  return { srt: `${srt}\n`, cueCount: checked.cues.length }
}

function srtFromSubtitleSegments(segments) {
  const rows = segments.map((segment, position) => {
    const start = Number(segment?.start_time)
    const end = Number(segment?.end_time)
    const caption = typeof segment?.text === 'string' ? segment.text.trim() : ''
    const label = `第 ${position + 1} 条字幕`
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || !caption) {
      throw fail('SPOKEN_VIDEO_SUBTITLES_INVALID', `自动对齐字幕不可用：${label}时间或文本无效。`)
    }
    return { start: Math.round(start), end: Math.round(end), caption, position }
  }).sort((left, right) => left.start - right.start || left.end - right.end || left.position - right.position)
  return rows.map((row, index) => `${index + 1}\n${srtTimestamp(row.start)} --> ${srtTimestamp(row.end)}\n${row.caption}`).join('\n\n')
}

function srtTimestamp(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(total % 1_000).padStart(3, '0')}`
}

function fps(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parts = String(value || '').split('/').map(Number)
  return parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[1] !== 0 ? parts[0] / parts[1] : null
}

export function normalizeProbe(value) {
  const streams = Array.isArray(value?.streams) ? value.streams : []
  const video = streams.find((stream) => stream?.codec_type === 'video' && Number(stream?.disposition?.attached_pic || 0) !== 1) || null
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || null
  const duration = Number(value?.format?.duration || video?.duration || audio?.duration || 0)
  const sampleRate = Number(audio?.sample_rate || 0)
  const videoFps = video ? fps(video.avg_frame_rate || video.r_frame_rate) : null
  const declaredFrames = Number(video?.nb_frames || 0)
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: Number.isSafeInteger(video?.width) && video.width > 0 ? video.width : null,
    height: Number.isSafeInteger(video?.height) && video.height > 0 ? video.height : null,
    fps: videoFps,
    frameCount: Number.isSafeInteger(declaredFrames) && declaredFrames > 0 ? declaredFrames : videoFps && Number.isFinite(duration) && duration > 0 ? Math.round(videoFps * duration) : null,
    hasAudio: Boolean(audio),
    sampleRate: Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate : null,
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
  }
}

/**
 * 叙事节奏判据。
 *
 * 这些数字来自扫描 46 条历史成片的实测分布，不是拍脑袋定的：
 *   幕长   —— 历史成片从 6s 到 32s 都有，12-15s 是已能达到的水平，所以只卡「过短」和「过长」两端。
 *   字幕   —— 横屏单行 28 字上限，超出必须换行；两条以上就压字号，实测 37-42px 在预览里已偏小。
 *   钩子   —— 前 3 秒没有任何发言才是问题；前导静音（首 cue 较晚）不算空白片头。
 *
 * 阈值可按内容类型覆盖：{ longestSceneSeconds, minAverageSceneSeconds, maxOverTwoLines }。
 * 默认值只拦「明显不对」，不拦风格差异。
 */
export const DEFAULT_RHYTHM_THRESHOLDS = Object.freeze({
  /** 单幕超过这个秒数，提示语义是否真的只有一件事 */
  longestSceneSeconds: 45,
  /** 平均幕长低于这个值，说明分幕碎到无法形成完整画面 */
  minAverageSceneSeconds: 4,
  /** 允许超两行的字幕条数占比上限（0.25 = 最多四分之一） */
  maxOverTwoLinesRatio: 0.25,
})

/**
 * 把节奏指标变成 issue/warning 列表。
 *
 * 分级理由：技术问题（分辨率、帧率）会直接毁掉片子，必须 fail；
 * 节奏问题多数是「值得再看一眼」而不是「片子不能用」，默认走 warnings。
 * 只报一条进 issues——前 3 秒完全静默，因为那是最贵的三秒。
 */
export function evaluateRhythm(rhythm, thresholds = DEFAULT_RHYTHM_THRESHOLDS) {
  const issues = []
  const warnings = []
  if (!rhythm) return { issues, warnings }

  if (rhythm.hook?.silentHook) {
    issues.push('前 3 秒没有任何发言内容：配音前导静音期间画面全空，等于放弃留存闸门。')
  }

  if (rhythm.scenes) {
    if (rhythm.scenes.longestSceneSeconds > thresholds.longestSceneSeconds) {
      warnings.push(
        `最长场景 ${rhythm.scenes.longestSceneSeconds}s（${rhythm.scenes.longestSceneId}）超过 ${thresholds.longestSceneSeconds}s：确认它真的只讲一件事，否则拆成相邻短场景。`,
      )
    }
    if (rhythm.scenes.averageSceneSeconds < thresholds.minAverageSceneSeconds) {
      warnings.push(
        `平均幕长 ${rhythm.scenes.averageSceneSeconds}s 过短：分幕过碎会让每个场景来不及成画。`,
      )
    }
  }

  const subtitles = rhythm.subtitles
  if (subtitles?.cueCount) {
    const ratio = subtitles.overTwoLines / subtitles.cueCount
    if (ratio > thresholds.maxOverTwoLinesRatio) {
      warnings.push(
        `${subtitles.overTwoLines}/${subtitles.cueCount} 条字幕超出两行：过长会被迫缩小字号，移动端可读性下降。`,
      )
    }
  }

  return { issues, warnings }
}

/** Deterministic release gate for media topology and subtitle availability. */
export function buildTechnicalReport({
  video,
  audio,
  subtitles,
  subtitleEnabled = true,
  orientation = 'portrait',
  // 叙事节奏：可选。缺 cues 或 sceneSource 时自动降级为 null，指标缺失不拦截发布。
  cues = null,
  sceneSource = null,
  rhythmThresholds = DEFAULT_RHYTHM_THRESHOLDS,
}) {
  const issues = []
  const warnings = []
  const landscape = orientation === 'landscape'
  const expectedWidth = landscape ? 1920 : 1080
  const expectedHeight = landscape ? 1080 : 1920
  if (!video?.durationSeconds) issues.push('视频没有可识别的时长。')
  if (video?.width !== expectedWidth || video?.height !== expectedHeight) issues.push(`视频必须为 ${expectedWidth}x${expectedHeight} ${landscape ? '横屏' : '竖屏'}。`)
  if (!video?.fps || Math.abs(video.fps - 30) > 0.1) issues.push('视频必须为 30fps。')
  if (!video?.hasAudio) issues.push('视频缺少音轨。')
  if (audio?.durationSeconds && video?.durationSeconds && Math.abs(audio.durationSeconds - video.durationSeconds) > 2) {
    issues.push('视频与配音时长差超过 2 秒。')
  }
  if (subtitleEnabled && !subtitles?.cueCount) issues.push('视频没有可用字幕。')

  // 叙事节奏指标。全部输入可选：SCENES 表解析不出来、字幕 cue 没带过来时
  // rhythm 为 null，只是不报节奏问题，绝不因为「测不了」而拦截发布。
  const sceneTimeline = sceneSource ? measureSceneTimeline(sceneSource) : null
  const rhythm = cues || sceneSource
    ? measureNarrativeRhythm({
        sceneTimeline,
        cues: Array.isArray(cues) ? cues : [],
        durationSeconds: video?.durationSeconds || null,
        orientation,
      })
    : null
  if (rhythm) {
    const judged = evaluateRhythm(rhythm, rhythmThresholds)
    issues.push(...judged.issues)
    warnings.push(...judged.warnings)
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    video,
    audio,
    subtitles: { enabled: subtitleEnabled, cueCount: subtitles?.cueCount || 0, warnings },
    rhythm,
  }
}
