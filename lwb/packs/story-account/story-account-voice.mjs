/**
 * 配音与字幕的媒体服务桥接。
 *
 * 与 spoken-video 复用同一套环境变量（`LWB_SPOKEN_VIDEO_TTS_BASE_URL` 等）——
 * 运维只需要配一次媒体服务，两个内容包都能用。刻意不另起一套变量名：
 * 两套 TTS 配置意味着两份密钥和两处可能配错的地方。
 *
 * 与通用包的分工差异：情感故事**不允许上传自定义音色**进流水线当默认。这条
 * 赛道的账号人设靠声音辨识，一个声音跑到底；中途换音色会被老观众立刻听出来，
 * 评论区第一条往往就是「换人了？」。所以这里把「音色锁定」做成请求级校验。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { mediaServiceConfig } from './story-account-media-config.mjs'

export const STORY_TTS_MAX_CHARS = 600
export const STORY_VOICE_MIN_RATE = 0.8
export const STORY_VOICE_MAX_RATE = 1.15

/** 情感故事只走本机桥接上的小米 MiMo：预置音色与音色设计两个模型。 */
export const STORY_VOICE_MODELS = Object.freeze(['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign'])

/**
 * 声音方案（音色 + 语气 + 语速打包成一份配方）。
 *
 * 之前界面上是「音色 / 模型 / 语气 / 语速」四个独立字段，用户要先理解
 * 三个 MiMo 模型的区别才敢填表；情感故事根本不需要那层复杂度——它要的是
 * 「这个故事用哪种声音念」。方案把四件事合成一张卡片，选中即配好。
 */
export const STORY_VOICE_RECIPES = Object.freeze([
  { id: 'warm-story', label: '温柔女声', hint: '情感共鸣 · 睡前故事', summary: '冰糖 · 温柔舒缓', model: 'mimo-v2.5-tts', voiceId: '冰糖', voiceName: '冰糖', style: '温柔舒缓，适合情感共鸣。', voiceDesign: '', rate: 0.92 },
  { id: 'calm-woman', label: '知性女声', hint: '深度解读 · 克制叙述', summary: '茉莉 · 清晰沉稳', model: 'mimo-v2.5-tts', voiceId: '茉莉', voiceName: '茉莉', style: '清晰沉稳，语速平缓克制。', voiceDesign: '', rate: 0.94 },
  { id: 'steady-man', label: '沉稳男声', hint: '观点表达 · 家庭纪实', summary: '白桦 · 干练利落', model: 'mimo-v2.5-tts', voiceId: '白桦', voiceName: '白桦', style: '沉稳有力，适合观点表达。', voiceDesign: '', rate: 0.94 },
  { id: 'narrator', label: '评书旁白', hint: '长辈口吻 · 岁月感', summary: '音色设计 · 评书旁白', model: 'mimo-v2.5-tts-voicedesign', voiceId: '', voiceName: '评书旁白', style: '', voiceDesign: '一位年迈的老先生，嗓音略带沙哑和沧桑感，语速缓慢而沉稳，像在讲一段很久以前的故事，语气从容，带岁月的智慧。', rate: 0.92 },
  { id: 'documentary', label: '纪录片旁白', hint: '中性客观 · 克制陈述', summary: '音色设计 · 纪录片旁白', model: 'mimo-v2.5-tts-voicedesign', voiceId: '', voiceName: '纪录片旁白', style: '', voiceDesign: '一位中性偏男性的旁白，声音低沉醇厚，语速平缓克制，语调平稳没有起伏，像在自然纪录片的镜头前做客观陈述。', rate: 0.9 },
])

export function storyVoiceRecipe(id) {
  return STORY_VOICE_RECIPES.find((recipe) => recipe.id === id) || null
}

/** 没指定声音时的默认方案：温柔女声（情感故事最常用的声线）。 */
export const STORY_VOICE_DEFAULT_RECIPE_ID = 'warm-story'

export class StoryVoiceError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
    this.message = message
  }
}

function fail(message) { throw new StoryVoiceError('STORY_VOICE_INVALID_INPUT', `配音：${message}`) }

/** 桥接内置音色表（与本机媒体桥接 builtin_voices 同源）。 */
export const STORY_BUILTIN_VOICES = Object.freeze(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])

const POLL_INTERVAL_MS = 1200
const MAX_POLL_MS = 15 * 60 * 1000

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * 情感故事的配音默认值。
 *
 * 语速刻意低于通用口播默认的 1.0：故事要留出「沉默的空间」，念得快会让所有
 * 细节糊成一句。0.92 是这类账号的常见听感——比日常说话慢一点，又不至于拖沓。
 */
export const STORY_VOICE_DEFAULT = Object.freeze({
  rate: 0.92,
  pitch: 0,
  volume: 1,
  outputFormat: 'wav',
})

/**
 * 校验并补全配音请求。语速上限比通用包窄，因为故事念太快直接毁稿。
 *
 * 只接受「内置音色 + 音色描述」两种声音来源：情感故事不开放上传参考音频，
 * 账号人设靠声音辨识，一个声音要跑到底。
 */
export function normalizeStoryVoiceRequest(value = {}) {
  const input = value && typeof value === 'object' ? value : {}
  const recipe = typeof input.recipeId === 'string' ? storyVoiceRecipe(input.recipeId) : null
  if (typeof input.recipeId === 'string' && input.recipeId.trim() && !recipe) {
    fail(`声音方案「${input.recipeId}」不存在。可选：${STORY_VOICE_RECIPES.map((item) => item.id).join('、')}。`)
  }
  const fallback = recipe || storyVoiceRecipe(STORY_VOICE_DEFAULT_RECIPE_ID)
  const model = STORY_VOICE_MODELS.includes(input.model) ? input.model : (fallback?.model || STORY_VOICE_MODELS[0])
  const voiceId = typeof input.voiceId === 'string' && input.voiceId.trim()
    ? input.voiceId.trim().slice(0, 160)
    : (fallback?.voiceId || '')
  const voiceName = typeof input.voiceName === 'string' && input.voiceName.trim()
    ? input.voiceName.trim().slice(0, 120)
    : (fallback?.voiceName || null)
  const voiceDesign = typeof input.voiceDesign === 'string' ? input.voiceDesign.trim().slice(0, 500) : (fallback?.voiceDesign || '')
  const style = typeof input.style === 'string' ? input.style.trim().slice(0, 200) : (fallback?.style || '')
  const rate = Number(input.rate ?? fallback?.rate ?? STORY_VOICE_DEFAULT.rate)
  if (!Number.isFinite(rate) || rate < STORY_VOICE_MIN_RATE || rate > STORY_VOICE_MAX_RATE) {
    fail(`语速必须在 ${STORY_VOICE_MIN_RATE} 到 ${STORY_VOICE_MAX_RATE} 之间（情感故事念快了会毁稿）。`)
  }
  const pitch = Number(input.pitch ?? STORY_VOICE_DEFAULT.pitch)
  if (!Number.isFinite(pitch) || pitch < -12 || pitch > 12) fail('音高必须在 -12 到 12 之间。')
  const volume = Number(input.volume ?? STORY_VOICE_DEFAULT.volume)
  if (!Number.isFinite(volume) || volume < 0 || volume > 2) fail('音量必须在 0 到 2 之间。')
  if (model === 'mimo-v2.5-tts') {
    if (!voiceId || !STORY_BUILTIN_VOICES.includes(voiceId)) {
      fail(`音色「${voiceId || '空'}」不在内置音色表里。可选：${STORY_BUILTIN_VOICES.join('、')}。`)
    }
  } else if (!voiceDesign) {
    fail('音色设计必须写音色描述（1~4 句：性别年龄、音色质感、情绪语气、语速节奏）。')
  }
  return {
    provider: 'mimo',
    model,
    recipeId: fallback?.id || null,
    voiceId: model === 'mimo-v2.5-tts' ? voiceId : null,
    voiceName,
    voiceDesign: model === 'mimo-v2.5-tts-voicedesign' ? voiceDesign : null,
    style: model === 'mimo-v2.5-tts' ? style : null,
    outputFormat: STORY_VOICE_DEFAULT.outputFormat,
    rate,
    pitch,
    volume,
  }
}

/** 稿件长度检查：超过 600 字合成会变慢，也说明稿子已经超出短视频容量。 */
export function checkScriptForVoice(body) {
  const text = String(body || '').trim()
  if (!text) fail('稿件为空，无法配音。')
  const count = [...text].length
  if (count > STORY_TTS_MAX_CHARS) {
    fail(`稿件 ${count} 字，超过 ${STORY_TTS_MAX_CHARS} 字上限：这个长度读出来会超过 3 分钟，短视频留不住人。`)
  }
  return { charCount: count, estimatedSeconds: Math.round((count / 4.2) * 10) / 10 }
}

/**
 * 起一个配音任务。
 *
 * 桥接不可达时抛 STORY_VOICE_UNAVAILABLE 而不是静默失败——「配音没生成」
 * 必须让上层看得见，否则流水线会卡在配音阶段且没有原因。
 *
 * 走的是本机媒体桥接的任务协议（POST /api/v1/tts/jobs → 轮询 → /audio-files/），
 * 不是自己拼一个合成端点：桥接只暴露这一套入口，早先打的 /v1/tts 是谁都不认
 * 的路径，返回 404 而错误信息里只有一个状态码，看不出打错了地址。
 */
export async function requestStoryVoiceover({ workspacePath, text, voice, signal, runId: runIdHint, environment = process.env }) {
  const config = mediaServiceConfig(environment)
  if (!config.endpointConfigured) {
    throw new StoryVoiceError('STORY_VOICE_UNAVAILABLE', '配音：未配置媒体桥接地址（LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL），或本机桥接未启动。请先用「启动工作台」把桥接指到 127.0.0.1:8199，或在连接配置里填写桥接地址。')
  }
  checkScriptForVoice(text)
  const request = normalizeStoryVoiceRequest(voice)
  const base = config.baseUrl.replace(/\/$/u, '')
  const submitted = await storyBridgeJson(`${base}/api/v1/tts/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      text: String(text).trim(),
      // voice_source=preset + 内置音色名 → 走小米 MiMo 预置音色，不查本机音色库。
      voice_source: 'preset',
      ...(request.voiceId ? { voice_id: request.voiceId } : {}),
      output_format: request.outputFormat,
      voice_settings: { rate: request.rate, volume: request.volume, pitch: request.pitch },
      tts_provider: 'cloud',
      mimo_model: request.model,
      ...(request.style ? { style: request.style } : {}),
      ...(request.voiceDesign ? { voice_design: request.voiceDesign } : {}),
    }),
  }, '配音提交')
  const jobId = submitted.job_id || submitted.task_id || submitted.id
  if (!jobId) throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', '配音提交没有返回任务标识。')
  const completed = await storyBridgePoll(`${base}/api/v1/tts/jobs/${encodeURIComponent(jobId)}`, signal)
  const audioUrl = completed.result?.audio_url || completed.audio_url || completed.result?.url || completed.url
  if (!audioUrl) throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', '配音没有返回音频地址。')
  const bytes = Buffer.from(await (await fetch(audioUrl, { signal })).arrayBuffer())
  if (!bytes.length) throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', '配音音频是空的。')
  const runId = String(runIdHint || `story-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9._-]/gu, '')
  const relative = `media/voiceovers/${runId}.${request.outputFormat}`
  await mkdir(join(workspacePath, 'data', 'media', 'voiceovers'), { recursive: true })
  await writeFile(join(workspacePath, 'data', relative), bytes)
  return {
    audio: {
      file: relative,
      mediaType: request.outputFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      durationSeconds: Number(completed.duration ?? completed.result?.duration) || null,
    },
    request,
    provider: request.provider,
  }
}

/** 桥接统一回包：{ success, data } 或 { code, data }。 */
function storyBridgeData(body, label) {
  if (body?.success === true && body.data && typeof body.data === 'object') return body.data
  if (body?.code === 200 && body.data && typeof body.data === 'object') return body.data
  const detail = typeof body?.message === 'string' ? body.message : '媒体服务没有返回有效数据'
  throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', `${label}失败：${detail}`)
}

async function storyBridgeJson(url, init, label) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new StoryVoiceError('STORY_VOICE_UNAVAILABLE', `配音：媒体服务不可访问（${error instanceof Error ? error.message : String(error)}）。`)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`
    throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', `配音失败：媒体服务返回 ${response.status}（${detail}）。请求 ${label}：${url}`)
  }
  return storyBridgeData(body, label)
}

async function storyBridgePoll(url, signal) {
  const started = Date.now()
  while (Date.now() - started < MAX_POLL_MS) {
    const data = await storyBridgeJson(url, { method: 'GET', signal }, '配音状态查询')
    const state = String(data.status || '').trim().toLowerCase()
    if (['completed', 'succeeded', 'success'].includes(state)) return data
    if (['failed', 'cancelled', 'canceled'].includes(state)) {
      throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', `配音任务失败：${data.error_message || '媒体服务没有返回原因'}`)
    }
    if (!['queued', 'pending', 'processing', 'running', 'in_progress'].includes(state)) {
      throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', `配音返回了未知任务状态：${state || '空'}`)
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new StoryVoiceError('STORY_VOICE_SERVICE_TIMEOUT', `配音任务在 ${MAX_POLL_MS / 60_000} 分钟内未完成。`)
}

/**
 * 试听一段声音。
 *
 * 走桥接自带的试合成端点（/admin/mimo-test）：真去云端合一段再回传音频地址，
 * 不新增协议。与正式配音的区别只在「不落盘、不进流水线」。
 */
export async function requestStoryVoicePreview({ recipeId, model, voiceId, style, voiceDesign, environment = process.env }) {
  const config = mediaServiceConfig(environment)
  if (!config.endpointConfigured) {
    throw new StoryVoiceError('STORY_VOICE_UNAVAILABLE', '试听：未配置媒体桥接地址（LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL），或本机桥接未启动。请先用「启动工作台」把桥接指到 127.0.0.1:8199，或在连接配置里填写桥接地址。')
  }
  const recipe = storyVoiceRecipe(recipeId)
  const fallback = recipe || storyVoiceRecipe(STORY_VOICE_DEFAULT_RECIPE_ID)
  const targetModel = STORY_VOICE_MODELS.includes(model) ? model : fallback.model
  const body = { model: targetModel }
  if (targetModel === 'mimo-v2.5-tts') {
    body.voice = typeof voiceId === 'string' && voiceId.trim() ? voiceId.trim() : fallback.voiceId
    body.style = typeof style === 'string' ? style : fallback.style
  } else {
    body.voiceDesign = typeof voiceDesign === 'string' && voiceDesign.trim() ? voiceDesign.trim() : fallback.voiceDesign
  }
  const base = config.baseUrl.replace(/\/$/u, '')
  let response
  try {
    response = await fetch(`${base}/admin/mimo-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
  } catch (error) {
    throw new StoryVoiceError('STORY_VOICE_UNAVAILABLE', `试听：媒体服务不可访问（${error instanceof Error ? error.message : String(error)}）。`)
  }
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', `试听失败：媒体服务返回 ${response.status}（${result?.message || '无原因'}）。`)
  }
  if (result?.ok !== true) {
    throw new StoryVoiceError('STORY_VOICE_SERVICE_FAILED', `试听失败：${result?.message || '媒体服务没有返回原因'}`)
  }
  return {
    ok: true,
    seconds: Number(result.seconds) || null,
    // 用 URL 解析而非字符串拼接：result.url 可能是绝对地址（http/https 开头），
    // 拼接会得到「base+绝对地址」这种无效串；new URL(relative, base) 在相对时
    // 正确拼 base、在绝对时直接采用，二者都安全。
    audioUrl: result.url ? new URL(result.url, base).toString() : null,
  }
}

/**
 * 竖屏字幕对齐：把稿件按标点切成口播节奏的短句，再按字数比例分配时间。
 *
 * 这不是「伪时间轴」——真正的对齐要 ASR 时间戳。这里做的是**降级路径**：
 * 媒体服务的字幕接口可用时走真对齐；不可用时按字数比例切，并在结果里
 * 明确标记 `aligned: false`，让人知道这份字幕是估出来的，需要听一遍再发。
 * 把降级结果伪装成精确结果，比没有字幕更糟。
 *
 * 切分必须保住成对引号：「…我不饿。」切开后剩一个孤零零的 `」` 落在下一条
 * 字幕开头，观众会看到一条只有引号的字幕（与 story-account-render.mjs 的
 * 分镜切分是同一个坑，两处都要守）。
 *
 * **和画面节拍对齐**：传入 beats 时，每条字幕严格落在某一拍的区间内，且使用
 * 该拍的文字。第一版两边各自切分，结果是画面 1.7 秒一句、字幕 2.4 秒一条，
 * 到第 6 秒画面已经换了三句、字幕才显示第二条——实测抽帧能看到画面被截在
 * 半句上。字幕是观众读的东西，必须跟着画面走。
 */
export function buildProportionalCues({ body, durationSeconds, maxChars = 16, beats = null }) {
  const total = Math.max(1, Number(durationSeconds) || 1)
  const totalMs = Math.round(total * 1000)
  const toMs = (percent) => Math.round(percent * total * 1000)

  // 有节拍时：一拍一条字幕，超长的拍拆成连续的几条，共用这一拍的区间。
  if (Array.isArray(beats) && beats.length) {
    const cues = []
    let index = 0
    for (const [beatIndex, beat] of beats.entries()) {
      const startMs = toMs(beat.startPercent)
      // 最后一拍必须吃满到尾帧：用 endPercent 算会和进度 1.0 差一帧，
      // 出现「画面还在上一拍、字幕已经没了」的尾巴。
      const endMs = beatIndex === beats.length - 1 ? totalMs : toMs(beat.endPercent)
      const chars = [...String(beat.text || '')]
      const chunks = []
      for (let offset = 0; offset < chars.length; offset += maxChars) {
        chunks.push(chars.slice(offset, offset + maxChars).join(''))
      }
      if (!chunks.length) continue
      const weights = chunks.map((chunk) => Math.max(1, [...chunk.replace(/[，。！？、；：,.!?;:]/gu, '')].length))
      const sum = weights.reduce((left, right) => left + right, 0)
      let cursorMs = startMs
      chunks.forEach((chunk, chunkIndex) => {
        const span = Math.max(1, Math.round(((endMs - startMs) * weights[chunkIndex]) / sum))
        const chunkEnd = chunkIndex === chunks.length - 1 ? endMs : Math.min(endMs, cursorMs + span)
        cues.push({ id: `cue-${index + 1}`, startMs: cursorMs, endMs: Math.max(cursorMs + 200, chunkEnd), text: chunk })
        cursorMs = chunkEnd
        index += 1
      })
    }
    return { cues, aligned: true, charCount: cues.reduce((sum, cue) => sum + [...cue.text].length, 0), drivenByBeats: true }
  }

  const text = String(body || '').replace(/\s+/gu, ' ').trim()
  if (!text) return { cues: [], aligned: false, charCount: 0, drivenByBeats: false }
  const sentences = text
    .split(/(?<=[。！？!?；;])(?![」』”’）)》\]])/u)
    .map((item) => item.trim())
    .filter(Boolean)
  const pieces = []
  for (const sentence of sentences) {
    const chars = [...sentence]
    for (let cursor = 0; cursor < chars.length; cursor += maxChars) {
      pieces.push(chars.slice(cursor, cursor + maxChars).join(''))
    }
  }
  // 上一条只剩收尾标点的碎片并回上一条，避免出现只有「」」」的独立字幕。
  const merged = []
  for (const piece of pieces) {
    if (/^[」』”’）)》\]，。！？、；：]+$/u.test(piece) && merged.length) merged[merged.length - 1] += piece
    else merged.push(piece)
  }
  const weights = merged.map((piece) => Math.max(1, [...piece.replace(/[，。！？、；：,.!?;:]/gu, '')].length))
  const sum = weights.reduce((left, right) => left + right, 0)
  let cursor = 0
  const cues = merged.map((piece, index) => {
    const startMs = Math.round((cursor / sum) * totalMs)
    cursor += weights[index]
    const endMs = Math.round((cursor / sum) * totalMs)
    return { id: `cue-${index + 1}`, startMs, endMs: Math.max(startMs + 200, endMs), text: piece }
  })
  return { cues, aligned: false, charCount: [...text].length, drivenByBeats: false }
}
