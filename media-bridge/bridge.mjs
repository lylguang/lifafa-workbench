// 李发发工作台 · 本地媒体桥接服务
// 把工作台口播包的媒体接口适配到本机 ComfyUI 模型 + 小米 MiMo 云端 TTS：
//   · SciTiger 云端协议（工作台配音/字幕界面原生支持，API Key 随便填）：
//       音频上传 /api/v1/media/audio-uploads → TTS 任务 /api/v1/tts/jobs → 字幕任务 /api/v1/subtitle/jobs
//       配音: 小米 MiMo TTS（云端，官方限时免费；有参考音频走 voiceclone，否则走内置音色）
//       字幕: Qwen3-ASR-1.7B（本地 ComfyUI-CZX, 默认 127.0.0.1:8188）
//   · 兼容 TTS/ASR 服务协议（LWB_SPOKEN_VIDEO_TTS_BASE_URL 指向本服务时可用，保留兼容）
//   · 百炼(DashScope) 异步生图协议（LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL 指向本服务）：
//       封面: Qwen-Image-2.1 文生图（Qwen-Image 应用内置 ComfyUI, 默认 127.0.0.1:8187）
// 音色库：voices/<音色ID>.wav|.mp3 参考音频；可选同名 .txt 放转写文本，没有则自动 ASR 并缓存。
// 本地 LongCat 合成已不再走主流程，但配置项保留，便于免费期结束后切回。

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomInt, createHash } from 'node:crypto'
import { totalmem, freemem } from 'node:os'
import { normalizeSpeechNumbers } from './chinese-numbers.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(ROOT, 'data')
const VOICES_DIR = join(ROOT, 'voices')
const UPLOADS_DIR = join(DATA_DIR, 'uploads')
const IMAGES_DIR = join(DATA_DIR, 'images')
const TTS_DIR = join(DATA_DIR, 'tts')
for (const dir of [DATA_DIR, VOICES_DIR, UPLOADS_DIR, IMAGES_DIR, TTS_DIR]) mkdirSync(dir, { recursive: true })

// ffmpeg 的中间文件跟随 TEMP/TMP。系统盘吃紧时会把 C 盘写满，导致拼接/转码
// 失败，所以要把临时目录挪到空闲的非系统盘（除非调用方已显式指定别处）。
//
// 选盘规则与 lwb/dsh-launcher.mjs 的 resolveScratchRoot 一致：这里原来写死
// 'E:\lifa-scratch\temp'，客户机上没有 E 盘就会退回系统盘，等于没改。规则是
// "非系统盘中可用空间最大且不低于 20G 者 > 系统盘的 LOCALAPPDATA"，
// LWB_SCRATCH_ROOT 可显式指定。
if (!process.env.LWB_TEMP_DIR) {
  const current = process.env.TEMP || process.env.TMP || ''
  const systemDrive = (process.env.SystemDrive || 'C:').toLowerCase().replace(/\\?$/u, '')
  const normalized = current.replace(/\//gu, '\\').toLowerCase()
  const onSystemDrive = !current || normalized === systemDrive || normalized.startsWith(`${systemDrive}\\`)
  if (onSystemDrive) {
    const scratch = joinScratchRoot('temp')
    try {
      mkdirSync(scratch, { recursive: true })
      process.env.TEMP = scratch
      process.env.TMP = scratch
      process.env.LWB_TEMP_DIR = scratch
    } catch { /* 只读目录不应阻止桥接启动 */ }
  }
}

/**
 * 选一个空闲的非系统盘作为暂存根目录。与 dsh-launcher.mjs 的规则保持一致：
 * 两边算出不同结果，启动脚本与「打开工作台」就会找不到同一个文件。
 */
function joinScratchRoot(sub) {
  if (process.env.LWB_SCRATCH_ROOT) return join(process.env.LWB_SCRATCH_ROOT, sub)
  const systemDrive = (process.env.SystemDrive || 'C:').toLowerCase()
  const minFree = 20 * 1024 ** 3
  let best = null
  let bestFree = -1
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (root.toLowerCase() === `${systemDrive}\\`) continue
    if (!existsSync(root)) continue
    let free
    try {
      const stats = statfsSync(root, { bigint: true })
      free = Number(stats.bavail * stats.bsize)
    } catch { continue }
    if (free < minFree) continue
    if (free > bestFree) { bestFree = free; best = root }
  }
  if (best) return join(`${best}lifa-scratch`, sub)
  const fallback = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local') : null)
  return fallback ? join(fallback, 'lifa-scratch', sub) : join('lifa-scratch', sub)
}

const PORT = Number(process.env.LWB_MEDIA_BRIDGE_PORT || 8199)
const TTS_COMFY = process.env.LWB_BRIDGE_TTS_COMFY_URL || 'http://127.0.0.1:8188'
const IMAGE_COMFY = process.env.LWB_BRIDGE_IMAGE_COMFY_URL || 'http://127.0.0.1:8187'
const T2I_TEMPLATE = process.env.LWB_BRIDGE_T2I_WORKFLOW || 'E:\\Qwen-Image-2.1-Pose\\Qwen-Image-2.1\\work\\qwen-image-2.1-t2i.json'
const LONGCAT_MODEL = process.env.LWB_BRIDGE_LONGCAT_MODEL || 'LongCat-AudioDiT-3.5B-bf16'
const ASR_MODEL = process.env.LWB_BRIDGE_ASR_MODEL || 'Qwen3-ASR-1.7B'
const POLL_MS = 1500
const MAX_WAIT_MS = 20 * 60_000
const VOICE_EXTS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aiff']
const AUDIO_EXTS = ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aiff']

// 日志轮转：无人值守链路会连写几个月，不轮转会涨到几百 MB 把工作盘撑满
// （磁盘满过一次，直接表现为渲染失败，日志里还看不出是磁盘的问题）。
// 按 10 MB 切一份，保留 5 份历史，最旧的丢弃。
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_KEEP = 5
const BRIDGE_LOG = join(DATA_DIR, 'bridge.log')
function rotateLogIfNeeded() {
  let size = 0
  try { size = statSync(BRIDGE_LOG).size } catch { return }
  if (size < LOG_MAX_BYTES) return
  try {
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = `${BRIDGE_LOG}.${i}`
      if (existsSync(from)) renameSync(from, `${BRIDGE_LOG}.${i + 1}`)
    }
    renameSync(BRIDGE_LOG, `${BRIDGE_LOG}.1`)
  } catch (e) {
    console.error('日志轮转失败:', e?.message || e)
  }
}

const log = (...parts) => {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.log(line)
  try { appendFileSync(BRIDGE_LOG, line + '\n') } catch {}
  rotateLogIfNeeded()
}

// 进程级兜底：桥接是无人值守链路的一环，崩溃必须留下痕迹。
// 2026-10-02 凌晨桥接静默消失，日志停在最后一条正常记录上，第二天只能看到
// 定时任务报 "fetch failed"，查不出是桥接没了还是引擎没起。退出码交给
// LWBKeepAlive 计划任务在 5 分钟内拉起来。
process.on('uncaughtException', (error) => {
  log('未捕获异常，进程退出:', error?.stack || error?.message || String(error))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log('未处理的 Promise 拒绝:', reason?.stack || reason?.message || String(reason))
})

// ---------- 配置中心 ----------
const CONFIG_FILE = join(ROOT, 'config.json')
const SYSTEM_VOICE_FILE = process.env.LWB_BRIDGE_SYSTEM_VOICE_FILE || 'F:\\Users\\Administrator\\Desktop\\李发发工作台\\lifafa-workbench-main\\lwb\\packs\\spoken-video\\assets\\voices\\tiffy-confident.mp3'
const DEFAULT_CONFIG = {
  // 配音方式：'cloud' = 小米 MiMo 云端（默认，不占本机显存）；'local' = 本地 LongCat。
  // 两者互斥——选云端时本地配音模型不加载，显存/内存留给字幕和生图。
  ttsProvider: 'cloud',
  tts: { model: 'LongCat-AudioDiT-3.5B-bf16', steps: 16, guidance_strength: 4.0, guidance_method: 'apg', attention: 'auto', device: 'auto', dtype: 'auto' },
  // 小米 MiMo TTS：官方「限时免费」的云端合成，取代本地 LongCat。
  //   apiKey  — 小米账号在 platform.xiaomimimo.com 创建的 sk-... key（免费，无需实名认证）
  //   voice   — 无参考音频时用的内置音色：冰糖/茉莉/苏打/白桦/mimo_default
  //   style   — 可选的语气/节奏指令（放 user 角色，不会念出来）
  // 传了参考音频时自动走 mimo-v2.5-tts-voiceclone（声音复刻），忽略 voice。
  mimo: { apiKey: '', voice: '冰糖', style: '' },
  asr: { model: 'Qwen3-ASR-1.7B' },
  defaultVoice: '',
  // 数字按中文读法念：LongCat 遇到阿拉伯数字会读英文（GPT-6 → "GPT six"）。
  // 合成前把文案里的数字换成汉字，字幕仍用工作台原稿。
  chineseNumbers: true,
}
function loadConfig() {
  try {
    const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...saved,
      ttsProvider: saved.ttsProvider === 'local' ? 'local' : 'cloud',
      tts: { ...DEFAULT_CONFIG.tts, ...(saved.tts || {}) },
      mimo: { ...DEFAULT_CONFIG.mimo, ...(saved.mimo || {}) },
      asr: { ...DEFAULT_CONFIG.asr, ...(saved.asr || {}) },
    }
  } catch { return structuredClone(DEFAULT_CONFIG) }
}
/**
 * 写回配置前剥掉注释键。
 *
 * config.example.json 用 `$` 前缀的键做行内说明（JSON 规范把 `$` 留给实现自
 * 定义），而用户是从模板复制成 config.json 的——那些说明会跟着每次保存被搬进
 * 真实配置，越积越多，还容易被误当成有效配置项。
 */
function stripCommentKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$')) continue
    result[key] = item && typeof item === 'object' && !Array.isArray(item) ? stripCommentKeys(item) : item
  }
  return result
}
function saveConfig(cfg) { writeFileSync(CONFIG_FILE, JSON.stringify(stripCommentKeys(cfg), null, 2)) }
// 生效的 TTS 参数：全局配置 + 音色级覆盖（voices/<id>.json，{tts:{...}} 或直接字段）
function effectiveTtsConfig(voiceId) {
  const cfg = loadConfig()
  // mimo 必须一起带出来：配音主链路（runTts）从这里取 API Key，只返回 cfg.tts
  // 会让任务报"未配置 API Key"，而配置页的测试按钮却正常——两边读的不是同一个东西。
  const base = { ...cfg.tts, mimo: { ...cfg.mimo } }
  if (voiceId) {
    try {
      const per = JSON.parse(readFileSync(join(VOICES_DIR, `${voiceId}.json`), 'utf8'))
      Object.assign(base, per.tts || per)
    } catch {}
  }
  return base
}
const md5 = (buffer) => createHash('md5').update(buffer).digest('hex')
let systemVoiceHash = null
try { systemVoiceHash = md5(readFileSync(SYSTEM_VOICE_FILE)) } catch {}

// 参考音频资产按内容哈希复用：同一段音频重复上传时返回同一个 assetId，
// 从而命中 <assetId>.txt 转写缓存，避免同一段参考音频被反复送去 ASR。
const UPLOAD_HASH_FILE = join(DATA_DIR, 'upload-hashes.json')
function loadUploadHashes() {
  try { return JSON.parse(readFileSync(UPLOAD_HASH_FILE, 'utf8')) } catch { return {} }
}
function resolveUploadAssetId(buffer, ext) {
  const hash = md5(buffer)
  const table = loadUploadHashes()
  const known = table[hash]
  if (known && AUDIO_EXTS.some(e => existsSync(join(UPLOADS_DIR, `${known}.${e}`)))) {
    return { id: known, created: false }
  }
  const id = randomUUID().replaceAll('-', '')
  table[hash] = id
  try { writeFileSync(UPLOAD_HASH_FILE, JSON.stringify(table, null, 1)) } catch {}
  return { id, created: true }
}

// ---------- 任务存储 ----------
const tasks = new Map()
const TASKS_FILE = join(DATA_DIR, 'tasks.json')
try {
  for (const t of JSON.parse(readFileSync(TASKS_FILE, 'utf8'))) tasks.set(t.id, t)
} catch {}
// 上一次进程被杀（崩溃 / 重启 / 关机）时，running 状态的任务没人再去推进，
// 而 tasks.json 会把 queued/processing 原样带回来——于是它们永远停在那里，
// 界面上一直显示"进行中"，排查时极具误导性（2026-10-09 实测有两条任务已经
// 卡了十几个小时）。桥接重启就意味着执行者已经死了，这些任务必然不会完成，
// 一律置为 failed 并写明原因，让人能重新提交，而不是对着"进行中"干等。
const STALE_AFTER_RESTART = new Set(['queued', 'processing'])
const staleAtStartup = new Date().toISOString()
let staleCount = 0
for (const t of tasks.values()) {
  if (!STALE_AFTER_RESTART.has(t.status)) continue
  const wasProcessing = t.status === 'processing'
  t.status = 'failed'
  t.error_message = `桥接重启前该任务仍在「${wasProcessing ? '进行中' : '排队中'}」，执行进程已不存在，请重新提交。`
  t.updated = staleAtStartup
  staleCount++
}
if (staleCount > 0) {
  try { writeFileSync(TASKS_FILE, JSON.stringify([...tasks.values()].slice(-100), null, 1)) } catch {}
  console.log(`[startup] ${staleCount} 条任务因桥接重启被置为失败，请重新提交`)
}
let saveTimer = null
function persistTasks() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    // 只保留最近 100 条：任务列表是排查用的滚动窗口，留太多既撑大文件也让页面变慢。
    try { writeFileSync(TASKS_FILE, JSON.stringify([...tasks.values()].slice(-100), null, 1)) } catch {}
  }, 300)
}
function createTask(kind) {
  const id = `${kind}-${Date.now().toString(36)}-${randomInt(1000, 9999)}`
  const task = { id, kind, status: 'queued', created: new Date().toISOString(), error_message: null }
  tasks.set(id, task); persistTasks()
  return task
}
const setStatus = (task, status, patch = {}) => {
  task.status = status; Object.assign(task, patch)
  task.updated = new Date().toISOString(); persistTasks()
}

// ---------- ComfyUI 事件流（真实进度） ----------
// 以与提交相同的 client_id 连接 ComfyUI WebSocket，接收 progress/executing 事件，
// 映射到对应任务，供配置中心显示实时进度。
const promptIndex = new Map() // prompt_id -> task
function bindPrompt(task, promptId) { task.comfyPromptId = promptId; if (promptId) promptIndex.set(promptId, task) }
function handleComfyEvent(engine, msg) {
  try {
    const data = msg.data || {}
    const task = promptIndex.get(data.prompt_id)
    if (!task) return
    if (msg.type === 'progress' && data.max > 0) {
      task.progress = Math.min(99, Math.round((data.value / data.max) * 100))
      task.progressLabel = `${data.value}/${data.max}`
    } else if (msg.type === 'executing' && data.node) {
      task.progressLabel = `节点 ${data.node}`
    }
  } catch {}
}
function connectComfyWs(base, engine) {
  const connect = () => {
    let ws
    try { ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=lwb-media-bridge`) } catch { setTimeout(connect, 8000); return }
    ws.onmessage = (ev) => { if (typeof ev.data === 'string') { try { handleComfyEvent(engine, JSON.parse(ev.data)) } catch {} } }
    ws.onclose = () => setTimeout(connect, 8000)
    ws.onerror = () => { try { ws.close() } catch {} }
  }
  connect()
}

// 模型任务互斥执行：ComfyUI 同时加载 LongCat(7G) 与 Qwen3-ASR(4.4G) 会触发 Windows
// 内存提交上限（os error 1455），因此串行化所有模型任务。
let jobChain = Promise.resolve()
// 等待中的任务数（不含正在执行的）。只在真正排到队时递减，
// 这样日志里显示的才是真实积压量，而不是历史累计值。
let queueDepth = 0
function enqueueJob(label, fn) {
  queueDepth += 1
  log(`任务入队：${label}（当前队列长度 ${queueDepth - 1}）`)
  const run = jobChain.then(fn, fn)
  jobChain = run.then(() => {}, () => {})
  run.catch(() => {})
  return run.finally(() => { queueDepth = Math.max(0, queueDepth - 1) })
}

// 引擎没启动时 fetch 抛的是光秃秃的 "fetch failed"，工作台把它原样透给用户，
// 看不出该做什么。统一换成带端口和处置办法的提示。
// 注意：这条提示是「自动拉起也失败」时的兜底文案，正常路径不会走到这里。
function engineHint(base) {
  const port = (() => { try { return new URL(base).port || '' } catch { return '' } })()
  return port === '8187'
    ? `封面生图引擎未连接（ComfyUI ${port}）。请打开桥接配置中心 http://127.0.0.1:${PORT}/ 点「一键启动」。`
    : `配音/字幕引擎未连接（ComfyUI ${port}）。请打开桥接配置中心 http://127.0.0.1:${PORT}/ 点「一键启动」。`
}
async function comfyJson(base, path, init) {
  let res
  try {
    res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new Error(engineHint(base))
  }
  if (!res.ok) throw new Error(`ComfyUI ${path} HTTP ${res.status}`)
  return res.json()
}
async function comfyUpload(base, buffer, filename, contentType) {
  const form = new FormData()
  form.append('image', new Blob([buffer], { type: contentType }), filename)
  form.append('overwrite', 'true')
  let res
  try {
    res = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
  } catch {
    throw new Error(engineHint(base))
  }
  if (!res.ok) throw new Error(`ComfyUI 上传失败 HTTP ${res.status}`)
  const data = await res.json()
  return { name: data.name, subfolder: data.subfolder || '', type: data.type || 'input' }
}
async function comfyView(base, item) {
  const qs = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' })
  let res
  try {
    res = await fetch(`${base}/view?${qs}`, { signal: AbortSignal.timeout(120_000) })
  } catch {
    throw new Error(engineHint(base))
  }
  if (!res.ok) throw new Error(`ComfyUI 取文件失败 HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
async function submitPrompt(base, workflow) {
  const data = await comfyJson(base, '/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: 'lwb-media-bridge' }) })
  if (!data.prompt_id) throw new Error('ComfyUI 没有返回 prompt_id')
  return data.prompt_id
}
async function waitForHistory(base, promptId, label) {
  const started = Date.now()
  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS))
    let history
    try { history = await comfyJson(base, `/history/${promptId}`) } catch { continue }
    const entry = history?.[promptId]
    if (!entry) continue
    const statusStr = entry.status?.status_str
    if (statusStr === 'error') {
      const err = (entry.status?.messages || []).find(m => m[0] === 'execution_error')
      throw new Error(`ComfyUI 执行失败：${err?.[1]?.exception_message || err?.[1]?.node_type || '未知错误'}（${label}）`)
    }
    if (statusStr === 'success' && entry.outputs && Object.keys(entry.outputs).length) return entry.outputs
  }
  throw new Error(`ComfyUI 任务超时（${label}，${MAX_WAIT_MS / 60000} 分钟）`)
}
function pickOutput(outputs, kind) {
  for (const nodeOutput of Object.values(outputs)) {
    const list = kind === 'audio'
      ? (nodeOutput.audios || nodeOutput.audio)
      : (nodeOutput.images || nodeOutput.audio)
    if (Array.isArray(list) && list.length) return list[0]
  }
  throw new Error('ComfyUI 输出里没有媒体文件')
}
function extractText(outputs) {
  const found = []
  for (const nodeOutput of Object.values(outputs)) {
    for (const key of ['string', 'text', 'strings', 'transcript', 'result']) {
      const value = nodeOutput[key]
      if (typeof value === 'string' && value.trim()) found.push(value.trim())
      else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string' && v.trim()) found.push(v.trim())
    }
  }
  if (!found.length) throw new Error('无法从 ASR 输出提取文本')
  return found.sort((a, b) => b.length - a.length)[0]
}

// ---------- 音频后处理与探测 ----------
const ff = (args) => new Promise((resolve, reject) => execFile('ffprobe', args, { windowsHide: true }, (e, stdout) => e ? reject(e) : resolve(JSON.parse(stdout))))
async function audioDuration(file) {
  try {
    const info = await ff(['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file])
    const d = Number(info.format?.duration)
    if (Number.isFinite(d) && d > 0) return d
  } catch {}
  return null
}
function ffmpegTransform(input, output, { rate = 1, volume = 1 } = {}) {
  const filters = []
  if (Math.abs(volume - 1) > 0.02) filters.push(`volume=${volume}`)
  if (Math.abs(rate - 1) > 0.02) filters.push(`atempo=${Math.min(2, Math.max(0.5, rate))}`)
  return new Promise((resolve, reject) => {
    if (!filters.length) return resolve(output)
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', input, '-filter:a', filters.join(','), output], { windowsHide: true }, e => e ? reject(e) : resolve(output))
  })
}
function ffmpegConvert(input, output, format) {
  const args = ['-y', '-v', 'error', '-i', input]
  if (format === 'mp3') args.push('-b:a', '320k')
  else if (format === 'wav') args.push('-f', 'wav')
  args.push(output)
  return new Promise((resolve, reject) => execFile('ffmpeg', args, { windowsHide: true }, e => e ? reject(new Error(`音频转换失败：${e.message}`)) : resolve()))
}

// ---------- SRT 生成 ----------
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
  const mss = String(ms % 1000).padStart(3, '0')
  return `${h}:${m}:${s},${mss}`
}
function buildSrt(transcript, durationSec, opts = {}) {
  const maxChars = opts.max_chars || 22
  const minDur = opts.min_duration ?? 0.6
  const maxDur = opts.max_duration ?? 4
  const text = String(transcript || '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('ASR 结果为空，无法生成字幕')
  const sentences = text.split(/(?<=[。！？!?；;\n])/).map(s => s.trim()).filter(Boolean)
  const cues = []
  for (const sentence of sentences) {
    let rest = sentence
    while (rest.length > maxChars) {
      let cut = -1
      for (const p of ['，', ',', '、', ' ']) { const idx = rest.lastIndexOf(p, maxChars); if (idx > maxChars * 0.4) { cut = idx + 1; break } }
      if (cut <= 0) cut = maxChars
      cues.push(rest.slice(0, cut)); rest = rest.slice(cut)
    }
    if (rest) cues.push(rest)
  }
  if (!cues.length) throw new Error('ASR 结果为空，无法生成字幕')
  const total = durationSec && durationSec > 0 ? durationSec : cues.reduce((n, c) => n + c.length, 0) / 4.2
  let durations = cues.map(c => total * c.length / text.length)
  for (let iter = 0; iter < 6; iter++) {
    let clampedSum = 0; const free = []
    durations.forEach((d, i) => { if (d < minDur || d > maxDur) clampedSum += Math.min(maxDur, Math.max(minDur, d)); else free.push(i) })
    const freeSum = free.reduce((n, i) => n + durations[i], 0)
    const need = total - clampedSum
    if (!free.length || freeSum <= 0) break
    const scale = Math.max(0.05, need / freeSum)
    for (const i of free) durations[i] *= scale
    if (Math.abs(scale - 1) < 0.01) break
  }
  durations = durations.map(d => Math.min(maxDur * 1.5, Math.max(minDur, d)))
  let t = 0
  const out = []
  cues.forEach((cue, i) => {
    const start = t, end = Math.min(total, t + durations[i]); t = end
    const body = opts.punctuation_policy === 'strip_trailing' ? cue.replace(/[，。！？!?；;、]+$/u, '') : cue
    if (!body) return
    out.push(`${out.length + 1}\n${srtTime(start)} --> ${srtTime(Math.max(end, start + minDur))}\n${body}`)
  })
  return out.join('\n\n') + '\n'
}

// ---------- TTS / ASR ----------
const mapLanguage = (lang) => {
  const l = String(lang || '').toLowerCase()
  if (l.startsWith('zh')) return 'Chinese'
  if (l.startsWith('en')) return 'English'
  if (l.startsWith('yue')) return 'Cantonese'
  if (l.startsWith('ja')) return 'Japanese'
  return 'Auto'
}
async function transcribeBuffer(base, buffer, filename, contentType, language = 'Auto', model = ASR_MODEL) {
  const up = await comfyUpload(base, buffer, filename, contentType)
  const workflow = {
    '1': { class_type: 'LoadAudio', inputs: { audio: up.name } },
    '2': { class_type: 'Qwen3ASRLoader', inputs: { model_name: model } },
    '3': { class_type: 'Qwen3ASRTranscribe', inputs: { model: ['2', 0], audio: ['1', 0], language } },
    '4': { class_type: 'easy showAnything', inputs: { anything: ['3', 0] } },
  }
  const promptId = await submitPrompt(base, workflow)
  const outputs = await waitForHistory(base, promptId, 'ASR 转写')
  return extractText(outputs)
}
async function findVoice(voiceId) {
  for (const ext of VOICE_EXTS) {
    const path = join(VOICES_DIR, `${voiceId}${ext}`)
    if (existsSync(path)) return { path, ext, buffer: await readFile(path) }
  }
  return null
}
// 解析克隆参考：优先上传资产，其次音色库；返回 { buffer, ext, promptText, uploadName } 或 null
// 解析克隆参考：优先上传资产，其次音色库；返回 { buffer, ext, promptText, uploadName, voiceId } 或 null。
// 「系统默认音色」映射：工作台里选“系统音色”时传上来的是自带的 Tiffy 参考音频，
// 若其内容哈希与内置文件一致且配置了 defaultVoice，则自动替换为用户自己的默认音色。
async function resolveReference(base, { assetId, voiceId, task }) {
  if (assetId) {
    if (!/^[\w-]{8,64}$/.test(assetId)) throw new Error(`参考音频资产标识无效：${assetId}`)
    let asset = null
    for (const ext of AUDIO_EXTS) {
      const p = join(UPLOADS_DIR, `${assetId}.${ext}`)
      if (existsSync(p)) asset = { path: p, ext, buffer: await readFile(p) }
    }
    if (!asset) throw new Error(`参考音频资产不存在：${assetId}`)
    const cfg = loadConfig()
    if (systemVoiceHash && md5(asset.buffer) === systemVoiceHash && cfg.defaultVoice) {
      log(`检测到系统默认音色（Tiffy），已映射到音色库「${cfg.defaultVoice}」`)
      voiceId = cfg.defaultVoice; assetId = null
    } else {
      const txtPath = join(UPLOADS_DIR, `${assetId}.txt`)
      let promptText = existsSync(txtPath) ? (await readFile(txtPath, 'utf8')).trim() : ''
      if (!promptText) {
        log(`资产 ${assetId} 首次使用，自动转写参考音频…`)
        if (task) setStatus(task, 'processing', { stage: '转写参考音频' })
        // 转写走本机 ASR：引擎没开时先拉起来（配音可能走云端，但转写这一步不经过云端）。
        await ensureEngine('tts', { reason: '转写参考音频' })
        promptText = await transcribeBuffer(base, asset.buffer, `lwb_ref_${assetId}.${asset.ext}`, asset.ext === 'wav' ? 'audio/wav' : 'audio/mpeg', 'Auto', loadConfig().asr.model)
        try { writeFileSync(txtPath, promptText, 'utf8') } catch {}
      }
      return { buffer: asset.buffer, ext: asset.ext, promptText, uploadName: `lwb_ref_${assetId}.${asset.ext}`, voiceId: null }
    }
  }
  if (voiceId) {
    const voice = await findVoice(voiceId)
    if (!voice) throw new Error(`音色「${voiceId}」不存在：请把参考音频放到 voices/${voiceId}.wav（或 .mp3），或在配置页上传`)
    const txtPath = join(VOICES_DIR, `${voiceId}.txt`)
    let promptText = existsSync(txtPath) ? (await readFile(txtPath, 'utf8')).trim() : ''
    if (!promptText) {
      log(`音色 ${voiceId} 首次使用，自动转写参考音频…`)
      if (task) setStatus(task, 'processing', { stage: '转写参考音色' })
      await ensureEngine('tts', { reason: '转写参考音色' })
      promptText = await transcribeBuffer(base, voice.buffer, `lwb_ref_${voiceId}${voice.ext}`, voice.ext === '.wav' ? 'audio/wav' : 'audio/mpeg', 'Auto', loadConfig().asr.model)
      try { writeFileSync(txtPath, promptText, 'utf8') } catch {}
    }
    return { buffer: voice.buffer, ext: voice.ext.slice(1), promptText, uploadName: `lwb_ref_${voiceId}${voice.ext}`, voiceId }
  }
  return null
}
// 长文本切分：LongCat 单次合成长文会把语速压垮、发音损毁（实测 1134 字被压进 39 秒），
// 必须按句切成 ≤100 字的段分别合成再拼接，这也是口播 TTS 的标准做法。
function splitTextSegments(text, maxChars = 100) {
  const sentences = String(text || '').replace(/\s+/g, ' ').split(/(?<=[。！？!?；;\n])/).map(s => s.trim()).filter(Boolean)
  const chunks = []
  let buf = ''
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = '' }
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush()
      let rest = sentence
      while (rest.length > maxChars) {
        let cut = -1
        for (const p of ['，', ',', '、', '：', ':', ' ']) { const idx = rest.lastIndexOf(p, maxChars); if (idx > maxChars * 0.4) { cut = idx + 1; break } }
        if (cut <= 0) cut = maxChars
        chunks.push(rest.slice(0, cut)); rest = rest.slice(cut)
      }
      buf = rest
    } else if (buf.length + sentence.length > maxChars) {
      flush(); buf = sentence
    } else {
      buf += sentence
    }
  }
  flush()
  return chunks.filter(Boolean)
}

/**
 * 分段并记录段内每个句子的边界（字符区间，speechText 坐标系）。
 *
 * 2026-10-11 加：字幕对齐的治本改造。此前配音合成完，每句话的时间只能靠
 * ASR 事后猜——远程 ASR 的时间戳与真实音频脱节（实测滞后 4~6s），占比模型
 * 又有 ±3s 误差，用户实测「声音和底部字幕差 6 秒」。而配音本来就是分段
 * 合成的：每段音频单独落盘、段间固定 0.2s 静音拼接，段边界天然精确；
 * 段内句子边界用字符占比（段内无长停顿，误差 <0.4s）。
 *
 * 这里记下「每段含哪些句子、句子在段内的字符位置」，拼接时量出每段音频
 * 时长，两者相乘就是句级时间轴——零 ASR、零对齐算法。句子文本是
 * speechText（数字已转中文），字幕侧按句序号对应回原稿的句子。
 */
function splitTextSegmentsWithMeta(text, maxChars = 100) {
  const normalized = String(text || '').replace(/\s+/g, ' ')
  const rawSentences = normalized.split(/(?<=[。！？!?；;\n])/).map(s => s.trim()).filter(Boolean)
  // 每句在 normalized 里的 [start, end)
  const sentences = []
  let cursor = 0
  for (const sentence of rawSentences) {
    const start = normalized.indexOf(sentence, cursor)
    if (start < 0) continue
    sentences.push({ text: sentence, start, end: start + sentence.length })
    cursor = start + sentence.length
  }
  // 聚合成 ≤maxChars 的段，句子归属随聚合走
  const chunks = []
  let buf = null
  const flush = () => { if (buf) chunks.push(buf); buf = null }
  for (const sentence of sentences) {
    if (!buf) { buf = { text: sentence.text, start: sentence.start, end: sentence.end, sentences: [sentence] }; continue }
    if (sentence.end - buf.start > maxChars) { flush(); buf = { text: sentence.text, start: sentence.start, end: sentence.end, sentences: [sentence] }; continue }
    buf.text += sentence.text
    buf.end = sentence.end
    buf.sentences.push(sentence)
  }
  flush()
  return chunks.filter((c) => c.text)
}
const ffmpegRun = (args, label) => new Promise((resolve, reject) => execFile('ffmpeg', args, { windowsHide: true }, e => e ? reject(new Error(`${label}：${e.message}`)) : resolve()))

// ---------- 小米 MiMo TTS ----------
// 官方形态不是 OpenAI 的 /v1/audio/speech，而是 chat/completions：
//   · 待合成文本放 assistant，风格指令放 user（user 可选）
//   · 结果在 choices[0].message.audio.data（base64）
//   · 音色：mimo-v2.5-tts 用内置名；voiceclone 用 data:audio/xxx;base64,<参考音频>
// 三个 TTS 模型官方标注「限时免费」，RPM 100 / TPM 10M。
const MIMO_BASE = process.env.LWB_MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1'
// 内置中文音色（官方文档「预置音色」表）；voiceclone/voicedesign 走另外的模型，不用这张表。
const MIMO_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'mimo_default']

// MiMo 全局节流：所有 MiMo 请求（配音主链路、测试按钮、并发定时任务）在这里
// 串行排队，相邻两次请求开始至少间隔 MIMO_MIN_GAP_MS。官方限流 RPM 100 看似宽裕，
// 但长文案 25 段连发 + 多任务并发时实测会触发 429（2026-10-08，第 1/25 段即 429
// 说明配额已被并发任务吃满），串行化 + 2 秒间隔把峰值压到 ~30 RPM 以内。
let mimoChain = Promise.resolve()
let mimoLastStart = 0
const MIMO_MIN_GAP_MS = 2000
function withMimoSlot(fn) {
  const run = mimoChain.then(fn)
  // 失败也要摘链，否则一次请求抛错会让后续所有排队请求跟着拒绝
  mimoChain = run.then(() => {}, () => {})
  return run
}

async function mimoSynthesize(options) {
  // 整个请求（含排队等待）放进槽位：前一个响应回来之前不发下一个，
  // 排队等待不占用单次 180s 超时。
  return withMimoSlot(() => mimoRequestOnce(options))
}

async function mimoRequestOnce({ text, apiKey, model, voice, style, format = 'wav', timeoutMs = 180_000 }) {
  const messages = []
  // 风格指令放 user：控制语气/节奏，内容不会出现在合成语音里
  if (style && String(style).trim()) messages.push({ role: 'user', content: String(style).trim() })
  // 待合成文本必须放 assistant——放 user 会被当成指令而不是要念的内容
  messages.push({ role: 'assistant', content: text })
  const body = { model, messages, audio: { format, voice } }
  // 全局节流：距上次请求开始不足 MIMO_MIN_GAP_MS 时先等差额
  const waitMs = mimoLastStart + MIMO_MIN_GAP_MS - Date.now()
  if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs))
  mimoLastStart = Date.now()
  let res
  try {
    res = await fetch(`${MIMO_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(`小米 TTS 请求失败（网络/超时）：${e?.message || e}`)
  }
  const raw = await res.text()
  if (!res.ok) {
    let msg = raw.slice(0, 300)
    try { const j = JSON.parse(raw); msg = j?.error?.message || j?.error?.displayMsg?.zh || msg } catch {}
    const error = new Error(`小米 TTS 返回 ${res.status}：${msg}`)
    if (res.status === 429) {
      error.mimoThrottled = true
      const ra = Number(res.headers.get('retry-after'))
      if (Number.isFinite(ra) && ra > 0) error.retryAfterMs = ra * 1000
    }
    // 4xx（除 429）是请求本身有问题——参数错、鉴权错、载荷超限——重试多少次都一样，
    // 只会白白消耗限流配额，把真正的限流用户拖下水（实测 400 连打 4 次后转成 429，
    // 报错却只剩 429，把「参考音频格式错」这个真因掩盖掉了）。标记成不可重试。
    if (res.status >= 400 && res.status < 500 && res.status !== 429) error.mimoFatal = true
    throw error
  }
  let payload
  try { payload = JSON.parse(raw) } catch { throw new Error('小米 TTS 返回的不是 JSON') }
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (!data) throw new Error(`小米 TTS 未返回音频（响应：${raw.slice(0, 200)}）`)
  return Buffer.from(data, 'base64')
}

// 参考音频 → data URL（voiceclone 用）。官方限制：base64 后 ≤10MB，仅 mp3/wav。
// 2026-10-08 修复：音色库里存着 m4a/aac 参考音频（用户从手机录的），而本函数过去
// 把「非 mp3」一律标成 audio/wav——等于把 m4a 的字节谎报成 wav 格式，小米侧解析
// 失败返回 `400 Param Incorrect`。密集重试又打爆配额，退化成 429，看着像限流其实
// 是格式错。实测（音色 22.m4a）：原样必 400，转成 24kHz 单声道 wav 后 HTTP 200。
// 现在按真实格式给 mime，非 mp3/wav 一律先经 ffmpeg 转码再送。
function mimoVoiceMime(ext) {
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  return null // 需要转码
}
async function mimoVoiceDataUrl(reference) {
  let buffer = reference.buffer
  let mime = mimoVoiceMime(reference.ext)
  if (!mime) {
    // MiMo 声音复刻只认 mp3/wav；其余格式（m4a/aac/flac/ogg/aiff）先转 24kHz 单声道 wav。
    const src = join(TTS_DIR, `mimo_ref_${reference.voiceId || 'x'}_${Date.now()}.${reference.ext}`)
    const dst = `${src}.conv.wav`
    try {
      writeFileSync(src, buffer)
      await ffmpegConvert(src, dst, 'wav')
      buffer = readFileSync(dst)
      mime = 'audio/wav'
    } catch (e) {
      throw new Error(`参考音频是 .${reference.ext} 格式，小米声音复刻只支持 mp3/wav，自动转码失败：${e?.message || e}。请把音色文件转成 wav 或 mp3 后重试`)
    } finally {
      for (const f of [src, dst]) { try { rmSync(f, { force: true }) } catch {} }
    }
  }
  const b64 = buffer.toString('base64')
  if (b64.length > 10 * 1024 * 1024) throw new Error('小米声音复刻的参考音频过大（base64 后需 ≤10MB），请换更短的参考音频')
  return `data:${mime};base64,${b64}`
}

// ttsProvider / style / builtinVoice：工作台定时任务可按请求覆盖全局配置
//（不传则跟随 config.json）。builtinVoice = MiMo 内置音色名，仅云端可用。
async function runTts(task, { text, outputFormat, voiceSettings, assetId, voiceId, builtinVoice, ttsProvider, style }) {
  const base = TTS_COMFY
  setStatus(task, 'processing', { stage: '准备参考音频', progress: 0 })
  // 内置音色不需要参考音频：跳过解析，否则 voiceId 会误入音色库查找。
  const reference = builtinVoice ? null : await resolveReference(base, { assetId, voiceId, task })
  task.voiceId = reference?.voiceId || voiceId || null
  const cfg = effectiveTtsConfig(reference?.voiceId)
  // 数字读法：LongCat 见到阿拉伯数字会按英文念，合成前换成汉字。
  // 只改送进模型的文本，字幕仍按工作台原稿（reference_text）走，屏幕上不受影响。
  const speechText = loadConfig().chineseNumbers === false ? text : normalizeSpeechNumbers(text)
  if (speechText !== text) {
    const converted = (text.match(/\d/g) || []).length
    log(`配音 ${task.id} 数字转中文读法（${converted} 个阿拉伯数字）`)
    // 只留计数用于排查；改写全文会随任务记录（保留最近 500 条）一起膨胀
    task.digitsConverted = converted
  }
  const segments = splitTextSegmentsWithMeta(speechText)
  const multi = segments.length > 1
  const ext = outputFormat === 'mp3' ? 'mp3' : 'wav'
  const provider = ['cloud', 'local'].includes(ttsProvider) ? ttsProvider : loadConfig().ttsProvider
  task.ttsProvider = provider
  task.ttsProviderOverridden = ttsProvider && ttsProvider !== loadConfig().ttsProvider ? true : undefined
  setStatus(task, 'processing', { stage: multi ? `分段合成（共 ${segments.length} 段）` : (provider === 'cloud' ? '云端合成' : '本地合成'), progress: 0 })

  // 按「配音方式」开关分派：cloud = 小米云端（不占显存），local = 本地 LongCat。
  // 两者互斥，本地分支才需要 ComfyUI 上传/节点；云端把参考音频以 data URL 内联。
  const segFiles = []
  if (provider === 'cloud') {
    const mimo = cfg.mimo || {}
    if (!mimo.apiKey) throw new Error('当前配音方式为「云端合成」，但未配置小米 API Key：请到桥接配置中心 http://127.0.0.1:8199/ 填写，或把配音方式改为「本地合成」')
    // 有参考音频 → voiceclone（复刻音色）；否则 → 内置音色模型（按请求覆盖优先）
    const useClone = Boolean(reference?.buffer)
    const mimoModel = useClone ? 'mimo-v2.5-tts-voiceclone' : 'mimo-v2.5-tts'
    const mimoVoice = useClone ? await mimoVoiceDataUrl(reference) : (builtinVoice || mimo.voice || '冰糖')
    task.mimoModel = mimoModel
    task.mimoVoice = useClone ? `clone(${reference.voiceId || reference.uploadName || 'uploaded'})` : mimoVoice
    for (let i = 0; i < segments.length; i++) {
      // 云端偶发单段超时/限流：一段失败不能报废整单。429 是限流不是故障，
      // 单独对待——重试 6 次、退避 15s/30s/45s… 递增（尊重 Retry-After 响应头），
      // 桥接侧已有全局 2s 节流，这里兜底长退避；普通错误维持 3 次 5s/10s。
      let rawBuffer = null
      let lastError = null
      for (let attempt = 1; attempt <= 6 && !rawBuffer; attempt++) {
        try {
          rawBuffer = await mimoSynthesize({
            text: segments[i].text,
            apiKey: mimo.apiKey,
            model: mimoModel,
            voice: mimoVoice,
            style: style || mimo.style || '',
            format: 'wav',
          })
        } catch (error) {
          lastError = error
          // 参数/鉴权类错误重试无意义，且会把配额打爆让后续段跟着失败——立刻中止并
          // 把真因原样抛给用户（过去它被 4 次重试后的 429 掩盖，报错误导排查方向）。
          if (error.mimoFatal === true) {
            log(`TTS ${task.id} 第 ${i + 1}/${segments.length} 段遇到不可重试的错误（${error.message}），立即中止`)
            throw new Error(`第 ${i + 1}/${segments.length} 段云端合成被拒绝：${error.message}（这是请求参数或鉴权问题，重试无效，请按提示修正后重新提交）`)
          }
          const throttled = error.mimoThrottled === true
          const ceiling = throttled ? 6 : 3
          if (attempt < ceiling) {
            const retryAfterMs = Number(error.retryAfterMs) || 0
            const backoff = throttled ? Math.max(15000 * attempt, retryAfterMs) : 5000 * attempt
            log(`TTS ${task.id} 第 ${i + 1}/${segments.length} 段第 ${attempt} 次失败（${error.message}），${Math.round(backoff / 1000)}s 后重试`)
            setStatus(task, 'processing', { stage: `分段合成 ${i + 1}/${segments.length}（${throttled ? '云端限流' : '失败'}，${Math.round(backoff / 1000)}s 后重试）`, progress: Math.round((i / segments.length) * 90) })
            await new Promise((resolvePromise) => setTimeout(resolvePromise, backoff))
          }
        }
      }
      if (!rawBuffer) throw new Error(`第 ${i + 1}/${segments.length} 段云端合成失败（已重试）：${lastError?.message || lastError}`)
      const segWav = join(TTS_DIR, `${task.id}_s${i}.wav`)
      writeFileSync(segWav, rawBuffer)
      segFiles.push(segWav)
      if (multi) setStatus(task, 'processing', { stage: `分段合成 ${i + 1}/${segments.length}`, progress: Math.round(((i + 1) / segments.length) * 90) })
    }
  } else {
    // 本地 LongCat：走 ComfyUI 8188。选这条路径前必须先启动本地引擎。
    if (builtinVoice) throw new Error(`桥接内置音色「${builtinVoice}」只在云端（小米 MiMo）合成时可用；该任务选择了本地合成，请改配音方式为「云端」或改选音色库音色`)
    // 本地合成必须用 8188：没开就先拉起来（无人值守时没人会去点「一键启动」）。
    await ensureEngine('tts', { reason: '本地配音任务' })
    const ref = reference ? await comfyUpload(base, reference.buffer, reference.uploadName, reference.ext === 'wav' ? 'audio/wav' : 'audio/mpeg') : null
    for (let i = 0; i < segments.length; i++) {
      const saveNode = outputFormat === 'mp3'
        ? { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 0], filename_prefix: `lwb_tts/${task.id}_s${i}`, quality: '320k' } }
        : { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: `lwb_tts/${task.id}_s${i}` } }
      const ttsInputs = { model_path: cfg.model, text: segments[i].text, steps: cfg.steps, guidance_strength: cfg.guidance_strength, guidance_method: cfg.guidance_method, device: cfg.device, dtype: cfg.dtype, attention: cfg.attention, seed: randomInt(1, 2 ** 31 - 1), keep_model_loaded: true }
      const workflow = ref
        ? { '1': { class_type: 'LoadAudio', inputs: { audio: ref.name } }, '2': { class_type: 'LongCatVoiceCloneTTS', inputs: { ...ttsInputs, prompt_audio: ['1', 0], prompt_text: reference.promptText } }, '3': saveNode }
        : { '2': { class_type: 'LongCatTTS', inputs: ttsInputs }, '3': saveNode }
      const promptId = await submitPrompt(base, workflow)
      bindPrompt(task, promptId)
      const outputs = await waitForHistory(base, promptId, `本地合成第 ${i + 1}/${segments.length} 段`)
      const item = pickOutput(outputs, 'audio')
      const rawBuffer = await comfyView(base, item)
      const rawExt = extname(item.filename).slice(1).toLowerCase() || 'flac'
      const segWav = join(TTS_DIR, `${task.id}_s${i}.wav`)
      if (rawExt === 'wav') {
        writeFileSync(segWav, rawBuffer)
      } else {
        const rawFile = join(TTS_DIR, `${task.id}_s${i}_raw.${rawExt}`)
        writeFileSync(rawFile, rawBuffer)
        await ffmpegConvert(rawFile, segWav, 'wav')
        try { await import('node:fs/promises').then((fs) => fs.unlink(rawFile)) } catch {}
      }
      segFiles.push(segWav)
      if (multi) setStatus(task, 'processing', { stage: `分段合成 ${i + 1}/${segments.length}`, progress: Math.round(((i + 1) / segments.length) * 90) })
    }
  }

  setStatus(task, 'processing', { stage: '音频拼接', progress: 93 })
  let file = segFiles[0]
  // 段时长必须在拼接前量——段文件拼接完即删。这是句级字幕时间轴的地面真值：
  // 段边界 = 合成边界（精确），段间静音固定 0.2s。
  // 注意 execFile 是回调式的，必须包 Promise：直接 await 会拿到 ChildProcess，
  // 解构出 undefined 再被 `|| 0` 吞成全 0（2026-10-11 首跑实踩）。
  const segDurs = []
  for (let i = 0; i < segFiles.length; i++) {
    try {
      const stdout = await new Promise((resolve, reject) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', segFiles[i]], { windowsHide: true }, (error, out) => error ? reject(error) : resolve(out)))
      segDurs.push(Math.round(Number(String(stdout).trim()) * 1000) || 0)
    } catch { segDurs.push(0) }
  }
  if (multi) {
    const silence = join(TTS_DIR, `${task.id}_sil.wav`)
    await ffmpegRun(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.2', silence], '静音生成失败')
    const listFile = join(TTS_DIR, `${task.id}_list.txt`)
    const lines = []
    segFiles.forEach((f, i) => { lines.push(`file '${f.replace(/\\/g, '/')}'`); if (i < segFiles.length - 1) lines.push(`file '${silence.replace(/\\/g, '/')}'`) })
    writeFileSync(listFile, lines.join('\n'))
    const catFile = join(TTS_DIR, `${task.id}_cat.wav`)
    await ffmpegRun(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', catFile], '音频拼接失败')
    file = catFile
    for (const f of [...segFiles, silence, listFile]) { try { await import('node:fs/promises').then(fs => fs.unlink(f)) } catch {} }
  }
  if (ext === 'mp3') {
    const mp3 = join(TTS_DIR, `${task.id}.mp3`)
    await ffmpegConvert(file, mp3, 'mp3')
    file = mp3
  }
  setStatus(task, 'processing', { stage: '后处理', progress: 97 })
  let buffer = await readFile(file)
  const rate = Number(voiceSettings?.rate) || 1
  const volume = Number(voiceSettings?.volume) || 1
  if (Math.abs(volume - 1) > 0.02 || Math.abs(rate - 1) > 0.02) {
    const adjusted = join(TTS_DIR, `${task.id}_adj.${ext}`)
    await ffmpegTransform(file, adjusted, { rate, volume })
    file = adjusted
    buffer = await readFile(file)
  }
  // 以磁盘上真实存在的文件为准：
  // 分段拼接 / mp3 转码 / 语速音量调整会把 file 改指到 _cat / .mp3 / _adj，
  // 一旦中途异常或状态被并发覆盖，task.audioName 可能停在一个并不存在的
  // 裸文件名上，导致下游按 audio_url 下载时收到 404。这里回退到实际产物。
  const candidateFiles = [
    file,
    join(TTS_DIR, `${task.id}_adj.${ext}`),
    join(TTS_DIR, `${task.id}_cat.wav`),
    join(TTS_DIR, `${task.id}.${ext}`),
    join(TTS_DIR, `${task.id}.mp3`),
    join(TTS_DIR, `${task.id}_s0.wav`),
  ]
  const realFile = candidateFiles.find(f => f && existsSync(f)) || file
  if (realFile !== file) log(`配音 ${task.id} 产物回退：${file.split(/[\\/]/).pop()} 不存在，改用 ${realFile.split(/[\\/]/).pop()}`)
  task.audioFile = realFile
  task.audioName = realFile.split(/[\\/]/).pop()
  task.audioBytes = buffer.length
  task.contentType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'
  task.duration = await audioDuration(realFile)
  task.segments = segments.length

  // 句级时间轴：段边界（ffprobe 实测，精确）+ 段内句子按字符占比。
  // 语速调整会让整体时长缩放（ffmpeg atempo），时间轴同步缩放；音量不影响。
  // 字幕任务拿到这份记录就能直接产出精确 SRT，不再依赖 ASR 猜时间戳。
  {
    const rate = Number(voiceSettings?.rate) || 1
    const scale = Math.abs(rate - 1) > 0.02 ? 1 / rate : 1
    const GAP_MS = 200 // 与上方拼接的段间静音一致
    const timeline = []
    let cursorMs = 0
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]
      const durMs = Math.round((segDurs[i] || 0) * scale)
      const segLen = Math.max(1, seg.end - seg.start)
      const sentences = (seg.sentences || []).map((sn) => ({
        text: sn.text,
        startMs: Math.round(cursorMs + ((sn.start - seg.start) / segLen) * durMs),
        durMs: Math.round(((sn.end - sn.start) / segLen) * durMs),
      }))
      timeline.push({ index: i, text: seg.text, startMs: cursorMs, durMs, sentences })
      cursorMs += durMs + (i < segments.length - 1 ? GAP_MS : 0)
    }
    task.segmentTimeline = { gapMs: GAP_MS, scale, segments: timeline }
  }
}
async function runSubtitles(task, { audioBuffer, audioFormat, language, referenceText, subtitleOptions }) {
  if (!audioBuffer?.length) throw new Error('字幕请求没有音频数据')
  const base = TTS_COMFY
  // 字幕必须用本机引擎；引擎没开时先拉起来，别把失败留给无人值守的定时任务。
  setStatus(task, 'processing', { stage: '准备字幕引擎', progress: 0 })
  await ensureEngine('tts', { reason: '字幕任务' })
  setStatus(task, 'processing', { stage: '上传音频', progress: 0 })
  const up = await comfyUpload(base, audioBuffer, `lwb_asr_${task.id}.${audioFormat || 'wav'}`, audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav')
  const workflow = {
    '1': { class_type: 'LoadAudio', inputs: { audio: up.name } },
    '2': { class_type: 'Qwen3ASRLoader', inputs: { model_name: loadConfig().asr.model } },
    '3': { class_type: 'Qwen3ASRTranscribe', inputs: { model: ['2', 0], audio: ['1', 0], language: mapLanguage(language) } },
    '4': { class_type: 'easy showAnything', inputs: { anything: ['3', 0] } },
  }
  const promptId = await submitPrompt(base, workflow)
  bindPrompt(task, promptId)
  setStatus(task, 'processing', { stage: 'ASR 识别中', progress: 0 })
  const outputs = await waitForHistory(base, promptId, 'Qwen3-ASR 字幕')
  setStatus(task, 'processing', { stage: '生成字幕文件' })
  const transcript = extractText(outputs)
  const rawFile = join(TTS_DIR, `${task.id}_src.${audioFormat || 'wav'}`)
  writeFileSync(rawFile, audioBuffer)
  const duration = await audioDuration(rawFile)
  // 字幕文本优先采用工作台传入的原稿（reference_text）：ASR 会把品牌名/术语听错
  // （实测 GPT-6→"GPT四"、OpenCode 缺失），导致独立审片判定字幕与稿件不符。
  // 时间轴按各句字数占比分配到实际音频时长上，与百炼的参考文本对齐策略一致。
  const reference = String(referenceText || '').trim()
  task.subtitleSrt = buildSrt(reference || transcript, duration, subtitleOptions || {})
  // buildSrt 的时间轴是按字数占比估算的，而 TTS 的句间停顿/数字读法/重音并不均匀，
  // 实测 84 条字幕里 26 条在开口前 0.4~1.0s 就上屏。这里量出真实语音区间，把每条
  // 字幕的切换点吸附到最近的句间停顿上，让字幕跟随真实开口，而不是跟随估算。
  // 对齐失败必须显式记录：曾因 ESM 里误用 require 而静默退回估算时间轴，字幕整体
  // 提前 0.2~1.3 秒，直到用户看片才发现。
  let speechAligned = false
  try {
    const speech = await measureSpeechIntervals(rawFile, duration)
    if (speech?.length) {
      task.subtitleSrt = snapSrtToSpeech(task.subtitleSrt, speech, duration)
      speechAligned = true
    } else {
      log(`字幕语音对齐未生效（未测到语音区间），字幕时间轴为估算值，可能与配音不同步`)
    }
  } catch (e) {
    log(`字幕语音对齐失败（保留估算时间轴，可能与配音不同步）：${e?.message || e}`)
  }
  task.diagnostics = { provider: loadConfig().asr.model, engine: 'comfyui', alignment: reference ? 'reference-text' : 'asr', speechAligned, transcriptChars: transcript.length, referenceChars: reference.length }
}

// ---------- 字幕与真实语音对齐 ----------
// 用 ffmpeg silencedetect 量出语音区间（非静音段）。失败返回 null，调用方保留估算时间轴。
function measureSpeechIntervals(audioFile, totalDuration) {
  return new Promise((resolve) => {
    // spawn 在文件顶部已按 ESM 导入；此处若再 require 会抛 "require is not defined"，
    // 被上层 catch 吞掉后静默退回估算时间轴（实测导致字幕整体提前 0.2~1.3 秒）。
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', audioFile, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      try {
        const marks = []
        for (const m of err.matchAll(/silence_(start|end): ([\d.]+)/g)) marks.push({ t: m[1], v: parseFloat(m[2]) })
        const speech = []
        let cursor = 0
        for (const s of marks) {
          if (s.t === 'start') { if (s.v > cursor) speech.push([cursor, s.v]); cursor = null }
          else cursor = s.v
        }
        const total = Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : (marks.at(-1)?.v ?? 0)
        if (cursor !== null && cursor < total) speech.push([cursor, total])
        resolve(speech.length ? speech : null)
      } catch { resolve(null) }
    })
  })
}

// 把估算出来的字幕切换点吸附到真实语音边界：切换点落在离估算位置最近的句间停顿里，
// 且停在停顿结束前 0.12s——字幕在下句开口前一点点出现，而不是提前半秒多。
// 停顿按顺序消费（不允许两条边界吸到同一个停顿）；吸不到的边界保持估算值；
// 吸附后过短的字幕并入相邻条目（丢条目等于丢文案）。
function snapSrtToSpeech(srtText, speech, totalDuration) {
  if (!Array.isArray(speech) || speech.length < 2) return srtText
  const LEAD = 0.12      // 字幕比开口略早出现
  const WINDOW = 1.2     // 估算边界 1.2s 内的停顿才算同一个句间停顿
  const MIN_DUR = 0.6
  const parse = (ts) => { const m = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(ts); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : null }
  const blocks = srtText.trim().split(/\n\n+/)
  const cues = []
  for (const b of blocks) {
    const rows = b.split('\n')
    const tRow = rows.find((r) => r.includes(' --> '))
    if (!tRow) continue
    const [a, z] = tRow.split(' --> ')
    const start = parse(a); const end = parse(z)
    if (start === null || end === null) continue
    cues.push({ start, end, text: rows.filter((r) => r !== tRow && !/^\d+$/.test(r.trim())).join('\n') })
  }
  if (cues.length < 2) return srtText
  // 停顿区间 = 相邻语音段之间的空隙（含开头的静音）
  const pauses = []
  let prev = 0
  for (const [a, b] of speech) { if (a - prev > 0.02) pauses.push([prev, a]); prev = b }
  // 边界：cue0 的起点，以及每条 cue 的终点（相邻字幕共享一个切换点）
  const bounds = [cues[0].start, ...cues.map((c) => c.end)]
  let lastPause = -1
  const snapped = bounds.map((t, i) => {
    if (i === bounds.length - 1) return t
    let best = -1; let bestD = Infinity
    for (let p = Math.max(0, lastPause + 1); p < pauses.length; p++) {
      const [a, b] = pauses[p]
      const d = t < a ? a - t : t > b ? t - b : 0
      if (d < bestD) { bestD = d; best = p }
      if (a > t + WINDOW) break
    }
    if (best < 0 || bestD > WINDOW) return t
    lastPause = best
    const [pa, pb] = pauses[best]
    // 停顿足够长：字幕在下句开口前 LEAD 出现；太短就停在停顿中点，避免闪烁
    return pb - pa > LEAD * 2 ? pb - LEAD : (pa + pb) / 2
  })
  for (let i = 1; i < snapped.length; i++) if (snapped[i] < snapped[i - 1]) snapped[i] = snapped[i - 1]
  // 重建字幕；过短的并入相邻条目（保留全部文案）
  const merged = []
  for (let i = 0; i < cues.length; i++) {
    const start = snapped[i]
    const end = i === cues.length - 1 ? Math.min(totalDuration || cues[i].end, Math.max(start + MIN_DUR, cues[i].end)) : snapped[i + 1]
    const last = merged[merged.length - 1]
    if (last && (end - start < MIN_DUR || !cues[i].text)) { last.end = Math.max(last.end, end); last.text += cues[i].text; continue }
    if (last && start < last.end + 0.05) last.end = start
    merged.push({ start, end, text: cues[i].text })
  }
  if (!merged.length) return srtText
  return merged.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(Math.max(c.end, c.start + MIN_DUR))}\n${c.text}`).join('\n\n') + '\n'
}

// ---------- 生图（DashScope 兼容） ----------
function patchT2i(template, prompt, width, height, { negativePrompt, seed } = {}) {
  const workflow = JSON.parse(JSON.stringify(template))
  let patched = { prompt: 0, latent: 0, seed: 0, negative: 0 }
  for (const node of Object.values(workflow)) {
    const ct = node.class_type
    if (/^TextEncodeQwenImage/.test(ct) && typeof node.inputs?.prompt === 'string' && node.inputs.prompt.length > 20) {
      node.inputs.prompt = prompt; patched.prompt++
      // 负面提示词可选传入。注意模板 cfg=1 时负面条件通常不参与采样，
      // 这里只做透传，不承诺生效；防文字主要靠正面提示词约束。
      if (typeof negativePrompt === 'string' && negativePrompt.trim() && 'negative_prompt' in node.inputs) {
        node.inputs.negative_prompt = negativePrompt.trim(); patched.negative++
      }
    }
    if (ct === 'EmptyLatentImage' || ct === 'EmptySD3LatentImage') {
      node.inputs.width = width; node.inputs.height = height; node.inputs.batch_size = 1; patched.latent++
    }
    if (ct === 'KSampler' || ct === 'KSamplerAdvanced') {
      // seed 可选：白板线稿按幕号固定种子以保证跨幕风格一致；不传则随机
      node.inputs.seed = Number.isSafeInteger(seed) && seed > 0
        ? seed % (2 ** 31 - 1)
        : randomInt(0, 2 ** 31 - 1)
      patched.seed++
    }
  }
  if (!patched.prompt || !patched.latent) throw new Error('t2i 工作流模板不完整（找不到提示词/画布节点）')
  return workflow
}
async function runImage(task, { prompt, width, height, negativePrompt, seed }) {
  const base = IMAGE_COMFY
  // 生图同样要 8187；封面是定时任务的一步，没人值守时也必须自己把引擎拉起来。
  setStatus(task, 'processing', { stage: '准备生图引擎', progress: 0 })
  await ensureEngine('image', { reason: '封面生图任务' })
  setStatus(task, 'processing', { stage: '加载工作流模板', progress: 0 })
  const template = JSON.parse(await readFile(T2I_TEMPLATE, 'utf8'))
  const workflow = patchT2i(template, prompt, width, height, { negativePrompt, seed })
  const promptId = await submitPrompt(base, workflow)
  bindPrompt(task, promptId)
  setStatus(task, 'processing', { stage: 'Qwen-Image 渲染中', progress: 0 })
  const outputs = await waitForHistory(base, promptId, 'Qwen-Image 生图')
  const item = pickOutput(outputs, 'image')
  setStatus(task, 'processing', { stage: '下载产物' })
  const buffer = await comfyView(base, item)
  const name = `${task.id}.png`
  writeFileSync(join(IMAGES_DIR, name), buffer)
  task.imageFile = name
  task.imageBytes = buffer.length
}

// ---------- HTTP 服务 ----------
const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length })
  res.end(buf)
}
const readBody = (req, limit = 200 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0
  req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return } chunks.push(c) })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})
const parseJson = (buf) => { try { return JSON.parse(buf.toString('utf8')) } catch { return null } }
const scitigerOk = (data) => ({ success: true, data })
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  if (!m) return null
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`)
  const parts = []
  let start = buffer.indexOf(boundary)
  while (start !== -1) {
    const end = buffer.indexOf(boundary, start + boundary.length)
    if (end === -1) break
    const part = buffer.slice(start + boundary.length + 2, end - 2)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('utf8')
      parts.push({
        name: /name="([^"]*)"/i.exec(headers)?.[1],
        filename: /filename="([^"]*)"/i.exec(headers)?.[1],
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1],
        data: part.slice(headerEnd + 4),
      })
    }
    start = end
  }
  return parts
}
async function checkEngine(base) {
  try { await comfyJson(base, '/system_stats'); return 'up' } catch { return 'down' }
}

// ---------- 引擎检测与一键启动 ----------
// TTS/字幕引擎（ComfyUI 8188）平时不常驻，工作台报 "SciTiger TTS 任务 failed：fetch failed"
// 往往就是它没开。这里把「是否连着」做成可查询状态，并允许从配置中心一键拉起。
// 2026-10-08：原 ComfyUI-CZX（E:\ComfyUI-CZX）已被用户删除，字幕/配音引擎迁到
// WalkingwithAI-Studio 自带的 ComfyUI（模型与节点已核对齐全：Qwen3-ASR-1.7B、
// LongCat-AudioDiT-3.5B-bf16、Qwen3ASR/LongCat/easy-use 节点包）。
const COMFY_TTS_HOME = process.env.LWB_BRIDGE_TTS_COMFY_HOME || 'E:\\WalkingwithAI-Studio-V260829\\engine\\ComfyUI'
const COMFY_TTS_PYTHON = process.env.LWB_BRIDGE_TTS_COMFY_PYTHON || 'E:\\WalkingwithAI-Studio-V260829\\runtime\\walkingwithai\\python.exe'
// 生图引擎是 Qwen-Image 自带的 ComfyUI：脚本在 <root>/ComfyUI/main.py，
// 实测以 `python -s ComfyUI/main.py --disable-auto-launch --listen --port 8187` 运行。
// （它外面还套了个 Gradio 封装 app.py，但那不是 8187 的实际服务进程，不要用那个启动。）
const COMFY_IMAGE_HOME = process.env.LWB_BRIDGE_IMAGE_COMFY_HOME || 'E:\\Qwen-Image-2.1-Pose\\Qwen-Image-2.1'
const COMFY_IMAGE_PYTHON = process.env.LWB_BRIDGE_IMAGE_COMFY_PYTHON || 'E:\\Qwen-Image-2.1-Pose\\Qwen-Image-2.1\\py312\\python.exe'
const COMFY_IMAGE_SCRIPT = process.env.LWB_BRIDGE_IMAGE_COMFY_SCRIPT || 'ComfyUI\\main.py'
// 启动后要等模型/自定义节点加载完才算「连上」；期间给页面一个「启动中」状态，
// 免得用户反复点按钮。
const ENGINE_BOOT_TIMEOUT_MS = 180_000
// 启动前的显存门槛。8188 的占用取决于配音方式：云端时只加载 ASR（实测 4.2G），
// 本地合成才需要 LongCat 的 7G——按最坏情况一律要 7.5G 会把「云端配音 + 字幕」
// 这种常见组合误判成显存不足，用户点了「一键启动」也起不来（2026-10-02 实测：
// llama-server 占着 12G，只剩 2G 时仍成功启动了 8188 并跑完 ASR）。
const ENGINE_VRAM_NEED_MIB = { tts: 4_500, ttsLocal: 7_500, image: 8_500 }
function engineVramNeed(kind) {
  if (kind !== 'tts') return ENGINE_VRAM_NEED_MIB[kind]
  return loadConfig().ttsProvider === 'local' ? ENGINE_VRAM_NEED_MIB.ttsLocal : ENGINE_VRAM_NEED_MIB.tts
}
const engineState = {
  tts: { starting: false, startedAt: null, lastError: null, lastLaunchedAt: null },
  image: { starting: false, startedAt: null, lastError: null, lastLaunchedAt: null },
}
function engineBase(kind) { return kind === 'image' ? IMAGE_COMFY : TTS_COMFY }
function engineSpec(kind) {
  return kind === 'image'
    ? { label: '封面生图引擎', home: COMFY_IMAGE_HOME, python: COMFY_IMAGE_PYTHON, script: COMFY_IMAGE_SCRIPT, port: new URL(IMAGE_COMFY).port || '8187', args: ['-s', COMFY_IMAGE_SCRIPT, '--disable-auto-launch', '--listen'] }
    // 8188 现在只服务字幕（ASR）与「本地合成」模式下的 LongCat；配音默认走云端，不经过它。
    // 启动参数对齐 WalkingwithAI start.py 的官方方式（-X utf8 -s）。
    : { label: '字幕引擎', home: COMFY_TTS_HOME, python: COMFY_TTS_PYTHON, script: 'main.py', port: new URL(TTS_COMFY).port || '8188', args: ['-X', 'utf8', '-s', 'main.py'] }
}
async function engineStatus(kind) {
  const spec = engineSpec(kind)
  const state = engineState[kind]
  const reachable = await checkEngine(engineBase(kind))
  if (reachable === 'up') {
    if (state.starting) log(`${spec.label}已就绪（端口 ${spec.port}）`)
    state.starting = false
    state.startedAt = null
  } else if (state.starting && state.startedAt && Date.now() - state.startedAt > ENGINE_BOOT_TIMEOUT_MS) {
    state.starting = false
    state.lastError = `启动超时（超过 ${Math.round(ENGINE_BOOT_TIMEOUT_MS / 1000)} 秒仍未响应），请检查 ComfyUI 窗口里的报错`
  }
  return {
    kind,
    label: spec.label,
    port: spec.port,
    reachable: reachable === 'up',
    starting: state.starting,
    canLaunch: Boolean(spec.home && spec.python),
    home: spec.home,
    lastError: state.lastError,
    lastLaunchedAt: state.lastLaunchedAt,
  }
}
// 显存诊断：LongCat(7G) 与 Qwen-Image 抢同一块 16G 卡，加载模型时显存不足会让
// ComfyUI 进程直接消失（表现为「启动后又连不上」），日志停在 Loading 那一行。
// 这里把占用情况读出来，让用户在点「一键启动」前就知道有冲突。
function nvidiaSmi(args) {
  return new Promise((resolve) => {
    execFile('nvidia-smi', args, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error || !stdout) return resolve(null)
      resolve(String(stdout).trim())
    })
  })
}
async function gpuDiagnostics() {
  const raw = await nvidiaSmi(['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'])
  if (!raw) return null
  const [usedMiB, totalMiB] = raw.split('\n')[0].split(',').map((n) => Number(n.trim()))
  if (!Number.isFinite(usedMiB) || !Number.isFinite(totalMiB)) return null
  const appsRaw = await nvidiaSmi(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'])
  const holders = appsRaw
    ? appsRaw.split('\n').map((line) => line.split(',').map((s) => s.trim())).filter((p) => p.length >= 2).map((p) => ({ pid: p[0], name: (p[1] || '').split(/[\\/]/).pop(), memoryMiB: Number(p[2]) || null })).slice(0, 8)
    : []
  return { usedMiB, totalMiB, freeMiB: Math.max(0, totalMiB - usedMiB), holders }
}

// 内存诊断：LongCat 的加载器会先在 CPU 上构造完整模型骨架（实测 RSS 从 0.7GB
// 涨到 15.6GB），再 load_file 映射 7GB 权重。这两步叠加要求 20GB+ 空闲内存，
// 不够时 Windows 直接杀掉进程——表现就是「8188 起来了、一提交任务就消失」，
// 日志停在 `Safetensors has no format metadata` 那一行，没有任何报错。
// 这里把内存余量也报出来，让用户在启动引擎前就能判断能不能跑。
function memoryDiagnostics() {
  const totalBytes = Number(totalmem())
  const freeBytes = Number(freemem())
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return null
  return {
    totalMiB: Math.round(totalBytes / 1024 ** 2),
    freeMiB: Math.round(freeBytes / 1024 ** 2),
  }
}
// 跑一次任务的内存门槛。23G 是 LongCat 的数字（模型骨架 ~15.6G + 权重映射 ~7G）；
// 云端配音时 8188 只加载 Qwen3-ASR-1.7B（bf16 约 3.4G），按 23G 卡会把字幕任务
// 直接拦掉——而字幕正是当前唯一依赖 8188 的环节。
const ENGINE_RAM_NEED_MIB = { tts: 8_000, ttsLocal: 23_000, image: 10_000 }
function engineRamNeed(kind) {
  if (kind !== 'tts') return ENGINE_RAM_NEED_MIB[kind]
  return loadConfig().ttsProvider === 'local' ? ENGINE_RAM_NEED_MIB.ttsLocal : ENGINE_RAM_NEED_MIB.tts
}
function launchEngine(kind) {
  const spec = engineSpec(kind)
  const state = engineState[kind]
  if (!spec.home || !spec.python) {
    throw new Error(`${spec.label}没有配置启动路径，请手动启动 ComfyUI（端口 ${spec.port}）`)
  }
  const scriptPath = join(spec.home, spec.script)
  for (const [file, label] of [[spec.python, 'python 可执行文件'], [scriptPath, spec.script]]) {
    if (!existsSync(file)) throw new Error(`${spec.label}的${label}不存在：${file}`)
  }
  state.starting = true
  state.startedAt = Date.now()
  state.lastError = null
  state.lastLaunchedAt = new Date().toISOString()
  // spec.args 是「除端口外」的完整参数；端口统一由这里追加，避免各引擎写法不一致。
  const args = [...spec.args, '--port', spec.port]
  // detached + 不继承 stdio：ComfyUI 是长驻服务，桥接重启不应该把它带走。
  const child = spawn(spec.python, args, {
    cwd: spec.home,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  log(`已请求启动${spec.label}（端口 ${spec.port}）：${spec.python} ${args.join(' ')}`)
  return spec
}

// 按需拉起引擎：定时任务是无人值守的，引擎没开时只报「请点一键启动」等于把失败
// 留给用户，而那条错误要到第二天早上才被人看到（2026-10-02 实测：09:00 自动轮与
// 09:58 手动轮都因 8188 未运行而失败，配音却因走云端而成功，更让人以为流程是通的）。
// 任务提交前先确保引擎在线：没起就拉起并等就绪；同一种引擎的并发请求共用一次启动。
const engineBootWaiters = new Map()
async function ensureEngine(kind, { reason = '' } = {}) {
  const spec = engineSpec(kind)
  const base = engineBase(kind)
  // 每次使用都把空闲回收的计时推后。放在最前面是关键：引擎已就绪时下面会直接
  // return，那条路径同样需要被 touch 到——「已经热着」正是最容易长期挂住显存
  // 的那种状态。
  touchEngine(kind)
  if (await checkEngine(base) === 'up') return
  const pending = engineBootWaiters.get(kind)
  if (pending) {
    log(`${spec.label}正在启动中，等待就绪${reason ? `（${reason}）` : ''}`)
    return pending
  }
  const state = engineState[kind]
  // 可能已有人在拉起（配置中心点了「一键启动」，或另一个任务先到）：
  // 这时只能等，不能再 spawn 一个——两个 ComfyUI 会抢同一个端口，先起来的
  // 那个反而连不上。engineState.starting 由 launchEngine 置位。
  const alreadyStarting = Boolean(state.starting)
  const wait = (async () => {
    if (alreadyStarting) {
      log(`${spec.label}已有人在启动，等待就绪${reason ? `（${reason}）` : ''}`)
    } else {
      // 内存不足时进程会被系统杀掉，等满 180 秒也等不到——不如立刻报出真实原因。
      const memory = memoryDiagnostics()
      const ramNeed = engineRamNeed(kind)
      if (memory && memory.freeMiB < ramNeed) {
        throw new Error(`${spec.label}无法自动启动：加载模型需要约 ${(ramNeed / 1024).toFixed(0)} GB 空闲内存，当前只剩 ${(memory.freeMiB / 1024).toFixed(1)} GB。请关闭占内存的程序（本地大模型、浏览器等）后重试`)
      }
      // launchEngine 会校验路径并把「启动中」写进 engineState，配置中心能看到同一状态。
      launchEngine(kind)
    }
    // 从最初的启动时刻算起，别因为后来者的等待把预算重新计时。
    const started = Number(state.startedAt) || Date.now()
    while (Date.now() - started < ENGINE_BOOT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 3000))
      if (await checkEngine(base) === 'up') {
        log(`${spec.label}已就绪（用时 ${Math.round((Date.now() - started) / 1000)} 秒）${reason ? `，${reason}` : ''}`)
        return
      }
    }
    throw new Error(`${spec.label}自动启动超时（超过 ${Math.round(ENGINE_BOOT_TIMEOUT_MS / 1000)} 秒仍未响应）。请到配置中心 http://127.0.0.1:${PORT}/ 手动点「一键启动」，并查看 ComfyUI 窗口里的报错`)
  })().finally(() => { engineBootWaiters.delete(kind) })
  engineBootWaiters.set(kind, wait)
  return wait
}

// 释放显存：让 ComfyUI 卸载已加载的模型但保持进程运行。
// LongCat(7G)/Qwen-Image(8G) 会一直占着卡，而配音与生图共用一块 16G 显存；
// 想切到另一个任务前先释放，比反复重启引擎快得多（省掉 30-40 秒启动时间）。
// 引擎空闲自动回收：分两级，先卸模型归还显存，再久一点把进程也停掉。
//
// 为什么必须做：Qwen-Image 常驻时占 5.8 GB 内存 + 大部分 16G 卡的显存，而这台
// 机器同时还要跑配音、渲染、封面。2026-10-09 实测空闲内存一度只剩 4.8 GB——
// 那不是「本地声音生成」的问题（配音本来就走云端），而是封面生图引擎一直挂着。
// 一天里 5 个定时任务错开跑，剩下的大部分时间这 5.8 GB 都是白占的。
//
// 两级的分工很重要：
//   - /free 卸模型只还显存，ComfyUI 进程本身仍占着 5.8 GB 内存；
//   - 真正把内存还给系统必须停进程，代价是下次要等 30-40 秒启动。
// 所以先做便宜的（/free），只有长时间空闲才做贵的（停进程）。定时任务间隔
// 通常在两小时量级，两级阈值都远小于它，不会影响无人值守的连续出片。
const IDLE_RELEASE_MS = {
  image: Number(process.env.LWB_BRIDGE_IMAGE_IDLE_MS || 5 * 60_000),
  tts: Number(process.env.LWB_BRIDGE_TTS_IDLE_MS || 10 * 60_000),
}
/** 卸载模型后仍持续空闲这么久，就把进程也停掉，把内存还给系统。 */
const IDLE_STOP_MS = {
  image: Number(process.env.LWB_BRIDGE_IMAGE_IDLE_STOP_MS || 20 * 60_000),
  tts: Number(process.env.LWB_BRIDGE_TTS_IDLE_STOP_MS || 30 * 60_000),
}
const idleReleaseTimers = new Map()
const idleStopTimers = new Map()

function cancelIdleRelease(kind) {
  const release = idleReleaseTimers.get(kind)
  if (release) { clearTimeout(release); idleReleaseTimers.delete(kind) }
  const stop = idleStopTimers.get(kind)
  if (stop) { clearTimeout(stop); idleStopTimers.delete(kind) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 记一次引擎使用，把两级回收的计时都往后推。
 *
 * 正在跑的引擎绝不能被回收，所以先取消既有计时。每次任务开始前调用——
 * 放在 ensureEngine 最前面，因为「已经热着」正是最容易长期挂住显存的那种状态。
 */
function touchEngine(kind) {
  cancelIdleRelease(kind)
  scheduleIdleRelease(kind)
  scheduleIdleStop(kind)
}

function scheduleIdleRelease(kind) {
  const budget = IDLE_RELEASE_MS[kind]
  if (!Number.isFinite(budget) || budget <= 0) return
  const timer = setTimeout(async () => {
    idleReleaseTimers.delete(kind)
    // 到点时先看还在不在忙：空闲窗口可能比任务间隔短，那时重新计时而不是
    // 把正在用的引擎卸了。
    if (await isEngineBusy(kind)) {
      log(`${engineSpec(kind).label}仍在执行任务，推迟自动释放`)
      scheduleIdleRelease(kind)
      return
    }
    try {
      await freeEngineVram(kind)
      log(`${engineSpec(kind).label}空闲 ${Math.round(budget / 60_000)} 分钟，已自动释放显存（下次需要时会自动重新加载）`)
    } catch (error) {
      log(`${engineSpec(kind).label}自动释放失败：${error?.message || error}`)
    }
  }, budget)
  timer.unref?.()
  idleReleaseTimers.set(kind, timer)
}

function scheduleIdleStop(kind) {
  const budget = IDLE_STOP_MS[kind]
  if (!Number.isFinite(budget) || budget <= 0) return
  const timer = setTimeout(async () => {
    idleStopTimers.delete(kind)
    if (await isEngineBusy(kind)) { scheduleIdleStop(kind); return }
    try {
      const result = await stopEngine(kind)
      if (result?.stopped) {
        const memory = memoryDiagnostics()
        log(`${engineSpec(kind).label}长时间空闲，已停止进程并归还内存${memory ? `（系统空闲内存升至 ${(memory.freeMiB / 1024).toFixed(1)} GB）` : ''}；下次任务会自动重新拉起`)
      }
    } catch (error) {
      log(`${engineSpec(kind).label}自动停止失败：${error?.message || error}`)
    }
  }, budget)
  timer.unref?.()
  idleStopTimers.set(kind, timer)
}

/** 该引擎端口上是否还有排队或在跑的任务。 */
async function isEngineBusy(kind) {
  const base = engineBase(kind)
  try {
    const res = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return true
    const body = await res.json()
    return (Array.isArray(body?.queue_running) && body.queue_running.length > 0)
      || (Array.isArray(body?.queue_pending) && body.queue_pending.length > 0)
  } catch {
    // 探测不到就当它忙着：宁可少释放一次，也不要在跑一半时把模型卸了。
    return true
  }
}

async function freeEngineVram(kind) {
  const spec = engineSpec(kind)
  const base = engineBase(kind)
  // ComfyUI 的 /free 是标准接口：unload_models 卸模型、free_memory 归还缓存。
  // 它成功时返回空响应体，所以不能用 comfyJson（那个要求 JSON）。
  let res
  try {
    res = await fetch(`${base}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new Error(`${spec.label}释放显存失败：${engineHint(base)}`)
  }
  if (!res.ok) throw new Error(`${spec.label}释放显存失败：ComfyUI /free HTTP ${res.status}`)
  // 卸载是异步的，等读数稳定，免得页面显示释放前的旧数字。
  await new Promise((r) => setTimeout(r, 1500))
  const gpu = await gpuDiagnostics()
  log(`${spec.label}已释放显存${gpu ? `（当前剩余 ${(gpu.freeMiB / 1024).toFixed(1)} GB）` : ''}`)
  return gpu
}

// 关闭引擎：只结束该端口对应的 ComfyUI 进程，不碰用户自己开的其它程序。
// 用端口反查 PID 而不是记 spawn 的句柄——引擎可能是用户手动启动的，桥接没有句柄。
async function findEnginePids(port) {
  const raw = await new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000 }, (error, stdout) => resolve(error ? '' : String(stdout)))
  })
  const pids = new Set()
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
    if (m && m[1] === String(port)) pids.add(Number(m[2]))
  }
  return [...pids].filter((pid) => Number.isFinite(pid) && pid > 0)
}
async function stopEngine(kind) {
  const spec = engineSpec(kind)
  const state = engineState[kind]
  if (state.starting) { state.starting = false; state.startedAt = null }
  const pids = await findEnginePids(spec.port)
  if (!pids.length) {
    const stillUp = await checkEngine(engineBase(kind))
    if (stillUp === 'up') throw new Error(`没找到监听 ${spec.port} 的进程，但端口仍在响应，请手动检查`)
    return { stopped: 0 }
  }
  // 先温和结束，给它机会自己清理；不响应再强杀。
  for (const pid of pids) {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid)], { windowsHide: true, timeout: 8000 }, () => resolve())
    })
  }
  await new Promise((r) => setTimeout(r, 2500))
  let remaining = await findEnginePids(spec.port)
  for (const pid of remaining) {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 8000 }, () => resolve())
    })
  }
  if (remaining.length) await new Promise((r) => setTimeout(r, 1500))
  remaining = await findEnginePids(spec.port)
  const stopped = pids.length - remaining.length
  if (remaining.length) throw new Error(`${spec.label}仍有进程占用端口 ${spec.port}（PID ${remaining.join('、')}），请手动结束`)
  state.lastError = null
  log(`已关闭${spec.label}（端口 ${spec.port}，结束 ${stopped} 个进程）`)
  return { stopped }
}

// ---------- 配置中心页面 ----------
function renderAdminPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>媒体桥接 · 控制台</title>
<style>
:root{
  --bg:#f2f4f7; --surface:#fff; --surface2:#f8f9fb;
  --line:#e4e7ec; --line2:#eef0f4;
  --ink:#101828; --ink2:#475467; --ink3:#98a2b3;
  --brand:#2563eb; --brand-soft:#eff4ff; --brand-line:#c7d7fe;
  --ok:#067647; --ok-soft:#ecfdf3; --warn:#b54708; --warn-soft:#fffaeb;
  --err:#b42318; --err-soft:#fef3f2;
  --r:10px; --r-sm:7px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:400 13.5px/1.55 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
  -webkit-font-smoothing:antialiased;
}
/* ============ 顶栏（吸顶，通栏背景） ============ */
.topbar{
  position:sticky;top:0;z-index:20;
  background:rgba(255,255,255,.86);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--line);
}
.topbar-in{
  max-width:1200px;margin:0 auto;padding:0 24px;
  height:56px;display:flex;align-items:center;gap:14px;
}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:14.5px;letter-spacing:-.01em}
.brand .logo{
  width:26px;height:26px;border-radius:8px;flex:0 0 auto;
  background:linear-gradient(135deg,#2563eb,#4f7ffb);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;
}
.topbar .grow{flex:1}
.topbar .addr{color:var(--ink3);font-size:12px}
/* ============ 内容容器：最大宽度约束 ============ */
.wrap{max-width:1200px;margin:0 auto;padding:22px 24px 56px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 336px;gap:20px;align-items:start}
@media(max-width:1080px){.grid{grid-template-columns:minmax(0,1fr)}}
/* ============ 卡片 ============ */
.card{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r);
  margin-bottom:16px;overflow:hidden;
}
.card-head{
  display:flex;align-items:center;gap:9px;
  padding:13px 18px;border-bottom:1px solid var(--line2);background:var(--surface);
}
.card-head h2{margin:0;font-size:13.5px;font-weight:650;letter-spacing:-.01em}
.card-head .grow{flex:1}
.card-body{padding:16px 18px}
.card-body.tight{padding:12px 18px}
/* ============ 表单：标签左置 ============ */
.form{display:grid;grid-template-columns:104px minmax(0,1fr);gap:13px 14px;align-items:center}
.form .lbl{font-size:13px;color:var(--ink2);text-align:right;padding-top:1px}
.form .ctl{min-width:0}
.form .full{grid-column:2}
.form .span2{grid-column:1/-1}
.form .hint{font-size:12px;color:var(--ink3);line-height:1.5}
.form .hint.err{color:var(--err)}
.form .hint.ok{color:var(--ok)}
@media(max-width:640px){
  .form{grid-template-columns:minmax(0,1fr);gap:6px}
  .form .lbl{text-align:left}
  .form .full,.form .span2{grid-column:1/-1}
}
/* 控件 */
input[type=text],input[type=password],input[type=number],select,textarea{
  width:100%;padding:7px 10px;font:inherit;color:var(--ink);
  background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);
  transition:border-color .12s,box-shadow .12s;
}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft);
}
input::placeholder{color:var(--ink3)}
select{cursor:pointer;appearance:none;
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2398a2b3' d='M6 8.5L1.5 4h9z'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;
}
.row{display:flex;gap:9px;align-items:center}
.row>.grow{flex:1;min-width:0}
.row>button{flex:0 0 auto}
/* 按钮 */
button{
  font:inherit;font-weight:600;cursor:pointer;white-space:nowrap;
  padding:7px 14px;border-radius:var(--r-sm);border:1px solid transparent;
  background:var(--brand);color:#fff;transition:background .12s,box-shadow .12s;
}
button:hover{background:#1d4fd8}
button:active{box-shadow:inset 0 1px 2px rgba(0,0,0,.12)}
button:disabled{opacity:.45;cursor:not-allowed;background:var(--brand)}
button.sec{background:#fff;color:var(--ink2);border-color:var(--line)}
button.sec:hover{background:var(--surface2);border-color:#d0d5dd}
button.danger{background:#fff;color:var(--err);border-color:#fecdc9}
button.danger:hover{background:var(--err-soft)}
button.sm{padding:5px 11px;font-size:12.5px}
button.icon{padding:6px 9px;background:transparent;color:var(--ink3);border-color:transparent}
button.icon:hover{background:var(--surface2);color:var(--ink2)}
/* 徽标 */
.badge{
  display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;
  padding:2px 8px;border-radius:6px;font-size:11.5px;font-weight:650;letter-spacing:.01em;
  background:var(--surface2);color:var(--ink2);border:1px solid var(--line);
  white-space:nowrap;
}
.badge.ok{background:var(--ok-soft);color:var(--ok);border-color:#abefc6}
.badge.err{background:var(--err-soft);color:var(--err);border-color:#fecdca}
.badge.warn{background:var(--warn-soft);color:var(--warn);border-color:#fedf89}
.badge.brand{background:var(--brand-soft);color:var(--brand);border-color:var(--brand-line)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
/* 提示条 */
.notice{
  display:flex;gap:9px;align-items:flex-start;
  padding:10px 12px;border-radius:var(--r-sm);font-size:12.5px;line-height:1.55;
  background:var(--warn-soft);border:1px solid #fedf89;color:var(--warn);
}
.notice.info{background:var(--brand-soft);border-color:var(--brand-line);color:#1e40af}
.notice .grow{flex:1;min-width:0}
/* ============ 引擎状态 ============ */
.eng{
  border:1px solid var(--line);border-radius:var(--r-sm);
  padding:11px 13px;margin-bottom:9px;background:var(--surface);
}
.eng:last-child{margin-bottom:0}
.eng-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.eng-name{font-weight:650;font-size:13px}
.eng-port{color:var(--ink3);font-size:11.5px;font-variant-numeric:tabular-nums}
.eng-serves{color:var(--ink3);font-size:11.5px;margin-top:4px}
.eng-acts{display:flex;gap:7px;margin-top:10px}
.eng-err{
  margin-top:8px;padding:7px 9px;border-radius:6px;font-size:12px;line-height:1.5;
  background:var(--err-soft);color:var(--err);
}
.meters{display:grid;gap:7px;padding:11px 13px;background:var(--surface2);border-radius:var(--r-sm);margin-bottom:11px}
.meter{display:flex;align-items:baseline;gap:7px;font-size:12px}
.meter .k{color:var(--ink3);width:38px;flex:0 0 auto}
.meter .v{font-weight:650;font-variant-numeric:tabular-nums}
.meter .v.low{color:var(--warn)}
.meter .sub{color:var(--ink3);font-size:11.5px}
/* ============ 任务表 ============ */
/* ============ 配音方式开关 ============ */
.provider{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:700px){.provider{grid-template-columns:1fr}}
.popt{
  display:flex;gap:10px;align-items:flex-start;cursor:pointer;
  padding:12px 13px;border:1px solid var(--line);border-radius:var(--r-sm);
  background:var(--surface);transition:border-color .12s,background .12s,box-shadow .12s;
}
.popt:hover{background:var(--surface2)}
.popt input[type=radio]{
  width:16px;height:16px;margin:2px 0 0;flex:0 0 auto;
  accent-color:var(--brand);cursor:pointer;
}
.popt .pbody{display:flex;flex-direction:column;gap:3px;min-width:0}
.popt .ptitle{font-weight:650;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.popt .pdesc{font-size:12px;color:var(--ink3);line-height:1.5}
/* 选中态：蓝色描边 + 柔光；未选中的整块降饱和，让选择结果一眼可见 */
.popt:has(input:checked){border-color:var(--brand);background:var(--brand-soft);box-shadow:0 0 0 3px rgba(37,99,235,.08)}
.popt:not(:has(input:checked)) .ptitle{color:var(--ink2)}
/* 置灰的区块（另一种方式的参数） */
.off{opacity:.45;pointer-events:none;filter:grayscale(.5)}
.off input,.off select{background:var(--surface2)}
.seg{display:inline-flex;background:var(--surface2);border:1px solid var(--line);border-radius:var(--r-sm);padding:2px}
.seg button{
  background:transparent;color:var(--ink2);font-size:12.5px;font-weight:600;
  padding:5px 11px;border-radius:5px;border:none;
}
.seg button:hover{background:transparent;color:var(--ink)}
.seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.08)}
.tablewrap{border:1px solid var(--line);border-radius:var(--r-sm);overflow:auto;max-height:360px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
thead th{
  position:sticky;top:0;z-index:1;
  background:var(--surface2);border-bottom:1px solid var(--line);
  padding:8px 10px;text-align:left;font-size:11.5px;font-weight:650;color:var(--ink2);
}
tbody td{padding:9px 10px;border-bottom:1px solid var(--line2);vertical-align:middle;font-size:12.5px}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--surface2)}
.mono{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--ink3)}
.empty{padding:28px 16px;text-align:center;color:var(--ink3);font-size:12.5px}
.bar{height:5px;background:var(--line2);border-radius:3px;overflow:hidden;margin-bottom:4px}
.bar>i{display:block;height:100%;background:var(--brand);transition:width .4s}
.bar.ind>i{width:35%;animation:slide 1.3s infinite linear;background:linear-gradient(90deg,var(--brand),#93c5fd,var(--brand))}
@keyframes slide{0%{margin-left:-35%}100%{margin-left:105%}}
.pct{font-size:11.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
audio{height:30px;max-width:100%;vertical-align:middle;display:block}
/* ============ 音色 ============ */
.voice{border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 13px;margin-bottom:9px;background:var(--surface)}
.voice:last-child{margin-bottom:0}
.voice-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.voice-id{font-weight:650;font-size:13px;word-break:break-all}
.voice-sz{color:var(--ink3);font-size:11.5px;font-variant-numeric:tabular-nums}
.voice-acts{display:flex;gap:9px;align-items:center;margin-top:10px}
.voice-acts .grow{flex:1;min-width:0}
@media(max-width:700px){.voice-acts{flex-wrap:wrap}.voice-acts audio{width:100%}}
/* ============ 折叠 ============ */
details{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);margin-bottom:16px}
details>summary{
  cursor:pointer;padding:13px 18px;font-size:13.5px;font-weight:650;
  list-style:none;display:flex;align-items:center;gap:9px;user-select:none;
}
details>summary::-webkit-details-marker{display:none}
details>summary::before{
  content:'';width:0;height:0;flex:0 0 auto;
  border-left:5px solid var(--ink3);border-top:4px solid transparent;border-bottom:4px solid transparent;
  transition:transform .15s;
}
details[open]>summary::before{transform:rotate(90deg)}
details>summary:hover{background:var(--surface2)}
details .dbody{padding:0 18px 16px;border-top:1px solid var(--line2);padding-top:14px}
/* ============ 日志 ============ */
pre.log{
  margin:0;padding:12px 14px;border-radius:var(--r-sm);
  background:#101828;color:#d0d5dd;font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;
  font-size:11.5px;line-height:1.65;max-height:280px;overflow:auto;
  white-space:pre-wrap;word-break:break-word;
}
/* ============ 其它 ============ */
.muted{color:var(--ink3)}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12.5px}
.kv .k{color:var(--ink3)}
.tips{font-size:12.5px;color:var(--ink2);line-height:1.75}
.tips b{color:var(--ink);font-weight:600}
.tips .li{display:flex;gap:8px;margin-bottom:6px}
.tips .li::before{content:'';width:3px;height:3px;border-radius:50%;background:var(--ink3);flex:0 0 auto;margin-top:8px}
#toast{
  position:fixed;left:50%;bottom:26px;transform:translate(-50%,8px);
  background:#101828;color:#fff;padding:9px 16px;border-radius:var(--r-sm);
  font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:60;
  box-shadow:0 8px 24px rgba(16,24,40,.18);
}
</style></head><body>

<header class="topbar"><div class="topbar-in">
  <div class="brand"><span class="logo">桥</span>媒体桥接</div>
  <span id="topTts" class="badge"><i class="dot"></i>配音 · 检查中</span>
  <span id="topImg" class="badge"><i class="dot"></i>生图 · 检查中</span>
  <span class="grow"></span>
  <span class="addr">127.0.0.1:${PORT}</span>
  <button class="sec sm" onclick="refreshAll()">刷新</button>
</div></header>

<div class="wrap"><div class="grid">

<!-- ============ 左栏 ============ -->
<div>

  <section class="card">
    <div class="card-head">
      <h2>配音</h2>
      <span class="grow"></span>
      <span class="muted" style="font-size:12px">选一种合成方式</span>
    </div>
    <div class="card-body">
      <!-- 配音方式开关：两种方式互斥，选一种后另一种的参数置灰 -->
      <div class="provider" id="providerSwitch">
        <label class="popt" data-p="cloud">
          <input type="radio" name="ttsProvider" value="cloud" id="pCloud">
          <span class="pbody">
            <span class="ptitle">云端合成 <span class="badge brand">小米 MiMo TTS</span></span>
            <span class="pdesc">不占用本机显存，需要联网。官方标注限时免费。</span>
          </span>
        </label>
        <label class="popt" data-p="local">
          <input type="radio" name="ttsProvider" value="local" id="pLocal">
          <span class="pbody">
            <span class="ptitle">本地合成 <span class="badge">LongCat</span></span>
            <span class="pdesc">离线可用，需要启动本地引擎并占用约 23GB 内存。</span>
          </span>
        </label>
      </div>

      <!-- 云端参数 -->
      <div id="cloudSection" style="margin-top:18px">
        <div id="mimoNotice" class="notice" style="display:none;margin-bottom:14px">
          <span>⚠</span><span class="grow">尚未配置 API Key，云端合成会失败。请在 <b>platform.xiaomimimo.com</b> 用小米账号创建（免费、无需实名认证），填入下方并保存。</span>
        </div>
        <div class="form">
          <span class="lbl">API Key</span>
          <div class="ctl row">
            <input id="cMimoKey" type="password" class="grow" placeholder="sk-..." autocomplete="off">
            <button class="sec" onclick="testMimo()">测试合成</button>
          </div>
          <span class="full hint" id="cMimoKeyHint"></span>

          <span class="lbl">内置音色</span>
          <div class="ctl">
            <select id="cMimoVoice">${['冰糖', '茉莉', '苏打', '白桦', 'mimo_default'].map((v) => `<option>${v}</option>`).join('')}</select>
          </div>

          <span class="lbl">语气风格</span>
          <div class="ctl"><input id="cMimoStyle" type="text" placeholder="可选，例如：清晰沉稳，适合知识讲解，语速适中"></div>
          <span class="full hint">音色库或上传了参考音频时，自动改用声音复刻，内置音色不生效。</span>
        </div>
      </div>

      <!-- 本地参数：仅在选「本地合成」时可编辑 -->
      <div id="localSection" style="margin-top:18px;display:none">
        <div class="notice info" style="margin-bottom:14px">
          <span>ℹ</span><span class="grow">本地合成需要「字幕引擎」（8188）在线。选此项后本机会加载 LongCat 模型，约占用 23GB 内存。</span>
        </div>
        <div class="form">
          <span class="lbl">TTS 模型</span>
          <div class="ctl">
            <select id="cModel">
              <option value="LongCat-AudioDiT-3.5B-bf16">3.5B-bf16（已装，推荐）</option>
              <option value="LongCat-AudioDiT-3.5B">3.5B（需联网下载）</option>
              <option value="LongCat-AudioDiT-3.5B-fp8 (auto download)">3.5B-fp8（需联网下载，更快）</option>
              <option value="LongCat-AudioDiT-1B (auto download)">1B（需联网下载，最快，音质略低）</option>
            </select>
          </div>
          <span class="lbl">步数</span>
          <div class="ctl"><select id="cSteps">${[4, 8, 12, 16, 24, 32, 48].map((n) => `<option>${n}</option>`).join('')}</select></div>
          <span class="lbl">引导强度</span>
          <div class="ctl"><input id="cGuidance" type="number" min="0" max="10" step="0.5"></div>
          <span class="lbl">引导方式</span>
          <div class="ctl"><select id="cMethod"><option value="apg">apg（克隆更稳）</option><option value="cfg">cfg</option></select></div>
          <span class="lbl">注意力</span>
          <div class="ctl">
            <select id="cAttn">
              <option value="auto">auto</option><option value="sdpa">sdpa</option>
              <option value="sage_attention">sage</option><option value="flash_attention">flash</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 两种方式共用 -->
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line2)">
        <div class="form">
          <span class="lbl">默认音色映射</span>
          <div class="ctl"><select id="cDefault"></select></div>
          <span class="full hint">工作台里选「Tiffy - 自信（系统默认）」时实际使用的音色。</span>

          <span class="lbl">数字读法</span>
          <div class="ctl">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="checkbox" id="cNumbers" style="width:15px;height:15px;accent-color:var(--brand);cursor:pointer">
              <span>按中文读法合成</span>
            </label>
          </div>
          <span class="full hint">把「GPT-6」「50%」这类阿拉伯数字换成汉字读法。字幕仍按原稿显示数字。</span>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:12px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line2)">
        <button onclick="saveConfig()">保存配置</button>
        <span class="hint" id="cMimoTest"></span>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>字幕</h2>
      <span class="badge">本地 ComfyUI</span>
      <span class="grow"></span>
      <span class="muted" style="font-size:12px">语音识别 ASR</span>
    </div>
    <div class="card-body">
      <div class="form">
        <span class="lbl">ASR 模型</span>
        <div class="ctl">
          <select id="cAsr">
            <option value="Qwen3-ASR-1.7B">Qwen3-ASR-1.7B（已装，推荐）</option>
            <option value="Qwen3-ASR-0.6B">Qwen3-ASR-0.6B（需联网下载）</option>
          </select>
        </div>
        <span class="full hint">字幕在本机 8188 引擎上识别，需要引擎在线；配音走云端，与此无关。</span>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>音色库</h2>
      <span class="grow"></span>
      <span class="muted" style="font-size:12px" id="voiceCount"></span>
    </div>
    <div class="card-body">
      <div class="form">
        <span class="lbl">参考音频</span>
        <div class="ctl"><input type="file" id="vFile" accept=".wav,.mp3,.m4a,.flac,.ogg,.aiff"></div>
        <span class="lbl">音色 ID</span>
        <div class="ctl row">
          <input id="vId" type="text" class="grow" placeholder="留空则取文件名">
          <button class="sec" onclick="uploadVoice()">上传</button>
        </div>
        <span class="full hint">建议 8~15 秒干净人声。转写文本可另存 voices/ID.txt，否则首次使用时自动识别。</span>
      </div>
      <div id="voiceList" style="margin-top:16px"></div>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><h2>使用提示</h2></div>
    <div class="card-body tight">
      <div class="tips">
        <div class="li">工作台里配音/字幕渠道选「SciTiger 云端」，API Key 随便填；封面选「百炼」+ 随便填 Key。</div>
        <div class="li">配音选<b>云端合成</b>时不占用本机显存；选<b>本地合成</b>时需启动「字幕引擎」并占用约 23GB 内存。</div>
        <div class="li">字幕识别始终在本机引擎上跑；与封面生图共用 16G 显存。</div>
        <div class="li">封面生图（Qwen-Image）开着时跑字幕可能报 <b>os error 1455</b>，那是显存不够，先释放生图引擎。</div>
        <div class="li">日志：<b>data/bridge.log</b>　产物：<b>data/tts</b>、<b>data/images</b></div>
      </div>
    </div>
  </section>

</div>
<!-- ============ 右栏 ============ -->
<div class="col-status">

  <section class="card">
    <div class="card-head">
      <h2>引擎状态</h2>
      <span class="grow"></span>
      <button class="icon sm" onclick="loadEngines()" title="刷新">↻</button>
    </div>
    <div class="card-body tight">
      <div class="hint" id="engineHint" style="margin-bottom:10px;font-size:12px;color:var(--ink3);line-height:1.5"></div>
      <div id="engineList"><div class="muted" style="padding:8px 0">检测中…</div></div>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>任务队列</h2>
      <span class="grow"></span>
      <span class="muted" style="font-size:11.5px" id="queueInfo"></span>
    </div>
    <div class="card-body tight">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:11px">
        <div class="seg" id="taskSeg">
          <button data-f="all" class="on" onclick="setTaskFilter('all')">全部</button>
          <button data-f="active" onclick="setTaskFilter('active')">进行中</button>
          <button data-f="failed" onclick="setTaskFilter('failed')">失败</button>
        </div>
        <span class="grow" style="flex:1"></span>
        <button class="sec sm" onclick="clearFinished()">清空已结束</button>
      </div>
      <div class="tablewrap">
        <table>
          <colgroup><col style="width:33%"><col style="width:22%"><col></colgroup>
          <thead><tr><th>任务</th><th>状态</th><th>结果</th></tr></thead>
          <tbody id="taskBody"></tbody>
        </table>
      </div>
      <div class="muted" style="margin-top:9px;font-size:11.5px">保留最近 100 条 · 每 2 秒刷新</div>
    </div>
  </section>

  <details>
    <summary>运行日志</summary>
    <div class="dbody">
      <pre class="log" id="logBox">展开后自动加载…</pre>
      <div style="margin-top:11px"><button class="sec sm" onclick="loadLogs()">刷新日志</button></div>
    </div>
  </details>

</div>
</div></div>

<div id="toast"></div>
<script>
var $=function(id){return document.getElementById(id)}
function toast(t){var e=$('toast');e.textContent=t;e.style.opacity=1;e.style.transform='translate(-50%,0)';setTimeout(function(){e.style.opacity=0;e.style.transform='translate(-50%,8px)'},2400)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
var esc2=esc
async function jf(url,opt){var r=await fetch(url,opt);if(!r.ok){var m='';try{m=(await r.json()).message||''}catch(_){}throw new Error(m||('HTTP '+r.status))}return r.json()}
function setBadge(el,label,state){
  var cls=state==='ok'?'ok':(state==='err'?'err':'')
  el.className='badge'+(cls?' '+cls:'')
  el.innerHTML='<i class="dot"></i>'+label
}

/* ---------- 状态 ---------- */
async function loadStatus(){
  try{
    var h=await jf('/health')
    // 顶栏按「能力」而不是「引擎」显示：配音走云端时，本地引擎离线不影响配音，
    // 所以配音徽标看的是「方式是否就绪」，不再等同于 8188 是否在线。
    var cloud=h.ttsProvider!=='local'
    setBadge($('topTts'),'配音 · '+(cloud?'云端':'本地'),cloud?'ok':'')
    var asrOk=h.ttsEngine==='up'
    setBadge($('topImg'),(cloud?'字幕 · ':'字幕引擎 · ')+(asrOk?'在线':'离线'),asrOk?'ok':'err')
  }catch(e){ setBadge($('topTts'),'配音 · 未知',''); setBadge($('topImg'),'字幕 · 未知','') }
}

/* 本地引擎的用途说明随配音方式变化：云端模式下 8188 只为字幕服务 */
function updateEngineHint(){
  var el=$('engineHint'); if(!el) return
  // 云端模式下 8188 只需要 ASR，但 LongCat 一旦被加载过就会驻留占显存（keep_model_loaded），
  // 所以这里明确提示可以「释放显存」——否则用户会以为配音走云端了显存就该空着。
  el.textContent=currentProvider()==='local'
    ? '本地合成已启用：8188 同时提供配音与字幕，加载 LongCat 约需 23GB 内存。'
    : '云端合成：8188 只为字幕识别服务。若它之前加载过 LongCat，可点「释放显存」腾出空间。'
}

/* ---------- 引擎 ---------- */
async function loadEngines(){
  try{
    var d=await jf('/admin/engines'), box=$('engineList'), html=''
    var gb=function(v){return (v/1024).toFixed(1)}
    if(d.gpu||d.memory){
      html+='<div class="meters">'
      if(d.gpu){
        var gl=d.gpu.freeMiB<8000
        html+='<div class="meter"><span class="k">显存</span><span class="v'+(gl?' low':'')+'">'+gb(d.gpu.freeMiB)+' GB 可用</span>'+
              '<span class="sub">已用 '+gb(d.gpu.usedMiB)+' / '+gb(d.gpu.totalMiB)+' GB</span></div>'
      }
      if(d.memory){
        var ml=d.memory.freeMiB<23000
        html+='<div class="meter"><span class="k">内存</span><span class="v'+(ml?' low':'')+'">'+gb(d.memory.freeMiB)+' GB 可用</span>'+
              '<span class="sub">共 '+gb(d.memory.totalMiB)+' GB</span></div>'
      }
      html+='</div>'
    }
    d.engines.forEach(function(e){
      var st=e.reachable?'<span class="badge ok"><i class="dot"></i>已连接</span>'
            :(e.starting?'<span class="badge warn"><i class="dot"></i>启动中</span>'
            :'<span class="badge err"><i class="dot"></i>未连接</span>')
      var k='data-kind="'+esc(e.kind)+'"', acts=''
      if(e.reachable){
        acts='<button class="sec sm" '+k+' onclick="freeEngine(this.dataset.kind)">释放显存</button>'+
             '<button class="danger sm" '+k+' onclick="stopEngine(this.dataset.kind)">关闭</button>'
      }else if(e.starting){
        acts='<button class="sec sm" disabled>启动中…</button>'
      }else{
        acts=e.canLaunch?'<button class="sm" '+k+' onclick="launchEngine(this.dataset.kind)">一键启动</button>'
                         :'<button class="sec sm" disabled>未配置路径</button>'
      }
      // 标注该引擎当前为哪些能力服务：8188 的用途随配音方式变化，光看「已连接」不够。
      var serves = e.kind === 'image'
        ? '封面生图'
        : (currentProvider() === 'local' ? '字幕 + 本地配音' : '仅字幕')
      html+='<div class="eng"><div class="eng-top"><span class="eng-name">'+esc(e.label)+'</span>'+st+
            '<span class="grow" style="flex:1"></span><span class="eng-port">:'+esc(e.port)+'</span></div>'+
            '<div class="eng-serves">服务于：'+esc(serves)+'</div>'+
            '<div class="eng-acts">'+acts+'</div>'+
            (e.lastError?'<div class="eng-err">'+esc(e.lastError)+'</div>':'')+'</div>'
    })
    box.innerHTML=html
    if(d.engines.some(function(e){return e.starting})) setTimeout(loadEngines,2000)
  }catch(e){ $('engineList').innerHTML='<div class="empty">检测失败：'+esc(e.message)+'</div>' }
}
async function launchEngine(kind){
  try{
    var r=await jf('/admin/engines/'+kind+'/launch',{method:'POST'})
    if(r.blocked) toast(r.message)
    else if(r.warning) toast(r.warning)
    else toast(r.alreadyRunning?'引擎已在运行':(r.alreadyStarting?'正在启动中':'已发送启动请求，模型加载需一点时间'))
    loadEngines(); loadStatus()
  }catch(e){ toast('启动失败：'+e.message) }
}
async function freeEngine(kind){
  var n={tts:'配音/字幕引擎',image:'封面生图引擎'}
  if(!confirm('释放'+(n[kind]||'引擎')+'的显存？\\n\\n模型会被卸载、显存归还，进程保持运行。下次合成需重新加载（约 30-60 秒）。')) return
  toast('正在释放显存…')
  try{ var r=await jf('/admin/engines/'+kind+'/free',{method:'POST'}); toast(r.message||'已释放'); loadEngines() }
  catch(e){ toast('释放失败：'+e.message) }
}
async function stopEngine(kind){
  var n={tts:'配音/字幕引擎',image:'封面生图引擎'}
  if(!confirm('关闭'+(n[kind]||'引擎')+'？\\n\\n会结束该进程（端口 '+(kind==='tts'?'8188':'8187')+'），下次使用需重新启动。')) return
  toast('正在关闭…')
  try{ var r=await jf('/admin/engines/'+kind+'/stop',{method:'POST'}); toast(r.stopped?('已关闭（'+r.stopped+' 个进程）'):'没有运行中的进程'); loadEngines(); loadStatus() }
  catch(e){ toast('关闭失败：'+e.message) }
}

/* ---------- 配置 ---------- */
/* 配音方式开关：切换时只切区块显隐与置灰，保存仍由「保存配置」统一提交 */
function currentProvider(){
  var el=document.querySelector('input[name=ttsProvider]:checked')
  return el?el.value:'cloud'
}
function applyProviderUI(p){
  var cloud=p==='cloud'
  $('cloudSection').style.display=cloud?'':'none'
  $('localSection').style.display=cloud?'none':''
  // 未选中的那一半参数置灰，避免误改；已选中的保持可编辑
  $('cloudSection').classList.toggle('off',!cloud)
  $('localSection').classList.toggle('off',cloud)
  document.querySelectorAll('.popt').forEach(function(o){
    o.classList.toggle('sel',o.dataset.p===p)
  })
  updateEngineHint()
  // 引擎卡片的「服务于」随模式变，重画一次
  if($('engineList')) loadEngines()
}
async function loadConfig(){
  var c=await jf('/admin/config')
  $('cModel').value=c.tts.model; $('cSteps').value=c.tts.steps
  $('cGuidance').value=c.tts.guidance_strength; $('cMethod').value=c.tts.guidance_method; $('cAttn').value=c.tts.attention
  $('cAsr').value=c.asr.model; $('cNumbers').checked=c.chineseNumbers!==false
  $('cMimoKey').value=c.mimo.apiKey||''; $('cMimoVoice').value=c.mimo.voice||'冰糖'; $('cMimoStyle').value=c.mimo.style||''
  var p=c.ttsProvider==='local'?'local':'cloud'
  $('pCloud').checked=p==='cloud'; $('pLocal').checked=p==='local'
  applyProviderUI(p)
  var has=!!(c.mimo.apiKey||'').trim()
  var hint=$('cMimoKeyHint')
  hint.textContent=has?'已配置，可点「测试合成」验证':'未配置'
  hint.className='full hint'+(has?' ok':' err')
  $('mimoNotice').style.display=(p==='cloud'&&!has)?'flex':'none'
  var sel=$('cDefault'), vs=await jf('/admin/voices')
  sel.innerHTML='<option value="">不替换（用自带 Tiffy 参考音）</option>'+vs.map(function(v){
    return '<option '+(v.id===c.defaultVoice?'selected':'')+' value="'+esc(v.id)+'">'+esc(v.id)+'</option>'
  }).join('')
}
async function saveConfig(){
  var body={
    ttsProvider:currentProvider(),
    tts:{model:$('cModel').value,steps:Number($('cSteps').value),guidance_strength:Number($('cGuidance').value),
         guidance_method:$('cMethod').value,attention:$('cAttn').value},
    mimo:{apiKey:$('cMimoKey').value.trim(),voice:$('cMimoVoice').value,style:$('cMimoStyle').value.trim()},
    asr:{model:$('cAsr').value}, defaultVoice:$('cDefault').value, chineseNumbers:$('cNumbers').checked
  }
  await jf('/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  toast('配置已保存'); loadConfig(); loadStatus()
}
async function testMimo(){
  var el=$('cMimoTest'); el.textContent='合成中…'; el.className='hint'
  try{
    var r=await jf('/admin/mimo-test',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({apiKey:$('cMimoKey').value.trim(),voice:$('cMimoVoice').value,style:$('cMimoStyle').value.trim()})})
    if(r.ok){ el.className='hint ok'; el.innerHTML='✓ 成功 '+r.bytes+' 字节 / '+(r.seconds||'?')+' 秒' }
    else { el.className='hint err'; el.textContent='✗ '+esc(r.message||'失败') }
  }catch(e){ el.className='hint err'; el.textContent='✗ '+e.message }
}

/* ---------- 音色 ---------- */
async function loadVoices(){
  try{
    var vs=await jf('/admin/voices'), box=$('voiceList')
    $('voiceCount').textContent=vs.length?vs.length+' 个':''
    if(!vs.length){ box.innerHTML='<div class="empty">还没有音色。上传一段参考音频即可创建。</div>'; return }
    box.innerHTML=vs.map(function(v){
      var id=esc(v.id), arg="'"+String(v.id).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")+"'"
      return '<div class="voice"><div class="voice-top"><span class="voice-id">'+id+'</span>'+
        '<span class="badge '+(v.hasTxt?'ok':'')+'">'+(v.hasTxt?'已转写':'未转写')+'</span>'+
        '<span class="voice-sz">'+(v.size/1024/1024).toFixed(1)+' MB</span>'+
        '<span class="grow" style="flex:1"></span>'+
        '<button class="danger sm" onclick="delVoice('+arg+')">删除</button></div>'+
        '<div class="voice-acts"><audio controls preload="none" src="/voices-files/'+encodeURIComponent(v.id)+'.'+esc(v.ext)+'"></audio>'+
        '<span class="grow"><input type="text" placeholder="试音文字（留空用默认）" id="test-'+id+'"></span>'+
        '<button class="sec sm" onclick="testVoice('+arg+')">试合成</button></div>'+
        '<div id="play-'+id+'"></div></div>'
    }).join('')
  }catch(e){ $('voiceList').innerHTML='<div class="empty">读取失败：'+esc(e.message)+'</div>' }
}
async function uploadVoice(){
  var f=$('vFile').files[0]
  if(!f) return toast('先选择音频文件')
  var fd=new FormData(); fd.append('file',f)
  if($('vId').value.trim()) fd.append('id',$('vId').value.trim())
  try{ await jf('/admin/voices',{method:'POST',body:fd}); toast('已上传'); $('vFile').value=''; $('vId').value=''; loadVoices(); loadConfig() }
  catch(e){ toast('上传失败：'+e.message) }
}
async function delVoice(id){
  if(!confirm('删除音色「'+id+'」？')) return
  try{ await jf('/admin/voices/'+encodeURIComponent(id),{method:'DELETE'}); toast('已删除'); loadVoices(); loadConfig() }
  catch(e){ toast('删除失败：'+e.message) }
}
async function testVoice(id){
  var text=$('test-'+id).value||'你好，这是音色测试。', p=$('play-'+id)
  p.innerHTML='<div class="hint" style="margin-top:8px">合成中…（首次调用云端约需数秒）</div>'
  try{
    var s=await jf('/api/v1/tts/jobs',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:text,voice_id:id,output_format:'mp3'})})
    var jid=s.data.job_id
    for(var i=0;i<80;i++){
      await new Promise(function(r){setTimeout(r,3000)})
      var d=(await jf('/api/v1/tts/jobs/'+jid)).data
      if(d.status==='completed'){ p.innerHTML='<div style="margin-top:8px"><audio controls src="'+d.result.audio_url+'"></audio></div>'; return }
      if(d.status==='failed'){ p.innerHTML='<div class="hint err" style="margin-top:8px">失败：'+esc(d.error_message||'')+'</div>'; return }
    }
    p.innerHTML='<div class="hint" style="margin-top:8px">超时</div>'
  }catch(e){ p.innerHTML='<div class="hint err" style="margin-top:8px">失败：'+esc(e.message)+'</div>' }
}

/* ---------- 任务 ---------- */
var KIND={tts:'配音',asr:'字幕',image:'生图'}
var taskFilter='all', lastTasks=[]
function setTaskFilter(f){
  taskFilter=f
  var bs=$('taskSeg').querySelectorAll('button')
  for(var i=0;i<bs.length;i++) bs[i].className=(bs[i].dataset.f===f?'on':'')
  renderTasks()
}
function chip(st){
  var m={queued:['排队',''],processing:['执行中','warn'],completed:['完成','ok'],failed:['失败','err']}
  var v=m[st]||[st,'']
  return '<span class="badge'+(v[1]?' '+v[1]:'')+'"><i class="dot"></i>'+esc(v[0])+'</span>'
}
function renderTasks(){
  var list=lastTasks.filter(function(k){
    if(taskFilter==='all') return true
    if(taskFilter==='failed') return k.status==='failed'
    return k.status==='processing'||k.status==='queued'
  })
  var tb=$('taskBody')
  if(!list.length){ tb.innerHTML='<tr><td colspan="3"><div class="empty">'+(lastTasks.length?'该筛选下没有任务':'还没有任务')+'</div></td></tr>'; return }
  tb.innerHTML=list.map(function(k){
    var prog=''
    if(k.status==='processing'){
      prog=k.progress!=null
        ? '<div class="bar"><i style="width:'+k.progress+'%"></i></div><span class="pct">'+k.progress+'% '+esc(k.progressLabel||k.stage||'')+'</span>'
        : '<div class="bar ind"><i></i></div><span class="pct">'+esc(k.stage||'执行中')+'</span>'
    }else if(k.status==='queued'){ prog='<span class="pct">等待引擎</span>' }
    else{
      var s=0
      if(k.created&&k.updated) s=Math.max(0,Math.round((new Date(k.updated).getTime()-new Date(k.created).getTime())/1000))
      prog='<span class="pct">'+(k.duration?('合成 '+Number(k.duration).toFixed(1)+'s'):(s+'s'))+'</span>'
    }
    var res=''
    if(k.status==='failed') res='<span class="hint err" title="'+esc(k.error_message||'')+'">'+esc(String(k.error_message||'').slice(0,42))+'</span>'
    else if(k.audioName) res='<audio controls preload="none" src="/audio-files/'+esc(k.audioName)+'"></audio>'
    else if(k.imageFile) res='<a href="/img-files/'+esc(k.imageFile)+'" target="_blank"><img src="/img-files/'+esc(k.imageFile)+'" style="height:36px;border-radius:5px;display:block"></a>'
    else if(k.hasSrt) res='<a href="/srt-files/'+esc(k.id)+'.srt" style="font-size:12.5px">下载 SRT</a>'
    else res='<span class="muted">—</span>'
    var t=(KIND[k.kind]||esc(k.kind))+'<br><span class="mono" title="'+esc(k.id)+'">'+esc(String(k.id).replace(/^(tts|asr|image)-/,'').slice(0,11))+'</span>'
    if(k.digitsConverted) t+='<br><span class="mono" title="合成前已把阿拉伯数字换成中文读法">数字转中文 '+k.digitsConverted+'</span>'
    return '<tr><td>'+t+'</td><td>'+chip(k.status)+'</td><td>'+prog+res+'</td></tr>'
  }).join('')
}
async function loadTasks(){
  try{
    var d=await jf('/admin/tasks')
    var q=[]
    if(d.ttsQueue) q.push('配音 '+d.ttsQueue.running+'/'+d.ttsQueue.pending)
    if(d.imageQueue) q.push('生图 '+d.imageQueue.running+'/'+d.imageQueue.pending)
    $('queueInfo').textContent=q.length?(q.join(' · ')+'（运行/排队）'):'引擎离线'
    lastTasks=d.tasks||[]
    renderTasks()
  }catch(e){}
}
async function clearFinished(){
  if(!confirm('清空已完成与失败的任务记录？\\n\\n只删除历史列表，不影响已生成的文件。')) return
  try{ await jf('/admin/tasks/clear',{method:'POST'}); toast('已清空'); loadTasks() }
  catch(e){ toast('清空失败：'+e.message) }
}

/* ---------- 日志 ---------- */
async function loadLogs(){
  try{
    var d=await jf('/admin/logs?lines=60')
    $('logBox').textContent=(d.lines||[]).join('\\n')||'（暂无日志）'
    $('logBox').scrollTop=$('logBox').scrollHeight
  }catch(e){ $('logBox').textContent='读取失败：'+e.message }
}

/* ---------- 启动 ---------- */
function refreshAll(){ loadStatus(); loadEngines(); loadTasks(); loadConfig(); loadVoices() }
// 切换配音方式：立刻更新区块显隐与引擎说明，但不自动保存——由「保存配置」统一提交，
// 避免用户点错一下就把线上配置改了。
document.querySelectorAll('input[name=ttsProvider]').forEach(function(r){
  r.addEventListener('change',function(){ applyProviderUI(currentProvider()) })
})
loadStatus(); loadConfig(); loadVoices(); loadEngines(); loadTasks()
setInterval(loadStatus,15000); setInterval(loadEngines,15000); setInterval(loadTasks,2000)
document.querySelectorAll('details').forEach(function(d){
  d.addEventListener('toggle',function(){ if(d.open&&d.querySelector('#logBox')) loadLogs() })
})
</script></body></html>`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const path = url.pathname
  let m
  try {
    if (req.method === 'GET' && path === '/health') {
      // ttsProvider 一起返回：页面据此显示「配音：云端 / 字幕：本地」，避免误解引擎状态。
      return json(res, 200, {
        service: 'lwb-media-bridge',
        ttsEngine: await checkEngine(TTS_COMFY),
        imageEngine: await checkEngine(IMAGE_COMFY),
        ttsProvider: loadConfig().ttsProvider,
      })
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(renderAdminPage())
    }

    // ---- 引擎连接检测与一键启动 ----
    if (req.method === 'GET' && path === '/admin/engines') {
      const engines = await Promise.all(['tts', 'image'].map(engineStatus))
      return json(res, 200, { engines, gpu: await gpuDiagnostics(), memory: memoryDiagnostics() })
    }
    m = path.match(/^\/admin\/engines\/(tts|image)\/launch$/)
    if (req.method === 'POST' && m) {
      const kind = m[1]
      const current = await engineStatus(kind)
      if (current.reachable) return json(res, 200, { ok: true, alreadyRunning: true, engine: current })
      if (current.starting) return json(res, 200, { ok: true, alreadyStarting: true, engine: current })
      // 显存余量只作提示，不作拦截：Windows 的 WDDM 允许各进程让出显存，
      // 实测只剩 2.0 GB 时 8188 依然能启动并跑完 ASR（llama-server 从 12.1G 降到 9.9G）。
      // 按门槛硬拦会把本来能跑的任务判死——无人值守时尤其致命，因为没人能来点按钮。
      const gpu = await gpuDiagnostics()
      const memory = memoryDiagnostics()
      const vramNeed = engineVramNeed(kind)
      let warning = null
      if (gpu && gpu.freeMiB < vramNeed) {
        const need = (vramNeed / 1024).toFixed(1)
        const free = (gpu.freeMiB / 1024).toFixed(1)
        const holders = gpu.holders.filter((h) => h.name).map((h) => h.name).slice(0, 4).join('、')
        warning = `显存偏紧：${current.label}约需 ${need} GB，当前可用 ${free} GB${holders ? `（占用：${holders}）` : ''}。仍会尝试启动，若加载失败请先关闭占显存的程序。`
      }
      // 内存不足则真的会失败：LongCat 加载时先构造 15.6G 模型骨架再映射 7G 权重，
      // 不够时进程会被系统直接杀掉，表现和「引擎没启动」一模一样。这条继续拦。
      const ramNeed = engineRamNeed(kind)
      if (memory && memory.freeMiB < ramNeed) {
        const need = (ramNeed / 1024).toFixed(0)
        const free = (memory.freeMiB / 1024).toFixed(1)
        return json(res, 200, {
          ok: false,
          blocked: true,
          message: `内存不足，暂未启动：${current.label}加载模型需要约 ${need} GB 空闲内存，当前只剩 ${free} GB。请先关闭占内存的程序（浏览器、本地大模型等）后重试。`,
          gpu,
          memory,
          engine: current,
        })
      }
      try {
        launchEngine(kind)
      } catch (error) {
        return json(res, 500, { ok: false, message: error.message })
      }
      return json(res, 200, { ok: true, warning, engine: await engineStatus(kind), gpu, memory })
    }
    m = path.match(/^\/admin\/engines\/(tts|image)\/free$/)
    if (req.method === 'POST' && m) {
      const kind = m[1]
      const current = await engineStatus(kind)
      if (!current.reachable) return json(res, 200, { ok: false, message: `${current.label}未连接，无需释放显存`, engine: current })
      try {
        const gpu = await freeEngineVram(kind)
        return json(res, 200, { ok: true, gpu, message: '已请求卸载模型并释放显存' })
      } catch (error) {
        return json(res, 500, { ok: false, message: error.message })
      }
    }
    m = path.match(/^\/admin\/engines\/(tts|image)\/stop$/)
    if (req.method === 'POST' && m) {
      const kind = m[1]
      try {
        const result = await stopEngine(kind)
        return json(res, 200, { ok: true, stopped: result.stopped, engine: await engineStatus(kind), gpu: await gpuDiagnostics() })
      } catch (error) {
        return json(res, 500, { ok: false, message: error.message, engine: await engineStatus(kind) })
      }
    }

    // ---- 配置中心 API ----
    if (req.method === 'GET' && path === '/admin/config') return json(res, 200, loadConfig())
    if (req.method === 'POST' && path === '/admin/config') {
      const body = parseJson(await readBody(req, 1024 * 1024))
      if (!body || typeof body !== 'object') return json(res, 400, { code: 400, message: '无效的配置' })
      const cfg = loadConfig()
      if (body.ttsProvider === 'cloud' || body.ttsProvider === 'local') cfg.ttsProvider = body.ttsProvider
      if (body.tts && typeof body.tts === 'object') Object.assign(cfg.tts, body.tts)
      if (body.mimo && typeof body.mimo === 'object') {
        if (typeof body.mimo.apiKey === 'string') cfg.mimo.apiKey = body.mimo.apiKey.trim()
        if (typeof body.mimo.voice === 'string') cfg.mimo.voice = body.mimo.voice.trim()
        if (typeof body.mimo.style === 'string') cfg.mimo.style = body.mimo.style.trim()
      }
      if (body.asr && typeof body.asr === 'object') Object.assign(cfg.asr, body.asr)
      if (typeof body.defaultVoice === 'string') cfg.defaultVoice = body.defaultVoice.trim()
      if (typeof body.chineseNumbers === 'boolean') cfg.chineseNumbers = body.chineseNumbers
      saveConfig(cfg)
      log(`配置已更新：配音方式=${cfg.ttsProvider === 'local' ? '本地合成' : '云端合成'} 小米 key=${cfg.mimo.apiKey ? '已配置' : '未配置'} 音色=${cfg.mimo.voice} 风格=${cfg.mimo.style || '（默认）'} asr=${cfg.asr.model} 默认音色=${cfg.defaultVoice || '（不替换）'} 数字中文读法=${cfg.chineseNumbers === false ? '关' : '开'}`)
      return json(res, 200, cfg)
    }
    // 测试小米 TTS：合成一小段并回传音频，用于验证 key/音色/风格是否可用
    if (req.method === 'POST' && path === '/admin/mimo-test') {
      const body = parseJson(await readBody(req, 64 * 1024)) || {}
      const apiKey = String(body.apiKey || '').trim() || loadConfig().mimo.apiKey
      if (!apiKey) return json(res, 400, { ok: false, message: '缺少 API Key' })
      const voice = String(body.voice || '').trim() || loadConfig().mimo.voice || '冰糖'
      try {
        const buffer = await mimoSynthesize({
          text: '这是一段小米语音合成测试。',
          apiKey,
          model: 'mimo-v2.5-tts',
          voice,
          style: String(body.style || '').trim(),
          format: 'wav',
          timeoutMs: 60_000,
        })
        const name = `mimo-test-${Date.now()}.wav`
        const file = join(TTS_DIR, name)
        writeFileSync(file, buffer)
        let seconds = null
        try { seconds = Number((await audioDuration(file)).toFixed(2)) } catch {}
        log(`小米 TTS 测试成功：音色=${voice} 字节=${buffer.length}`)
        return json(res, 200, { ok: true, bytes: buffer.length, seconds, url: `/audio-files/${name}` })
      } catch (e) {
        log(`小米 TTS 测试失败：${e?.message || e}`)
        return json(res, 200, { ok: false, message: String(e?.message || e).slice(0, 300) })
      }
    }
    if (req.method === 'GET' && path === '/admin/voices') {
      const voices = []
      for (const ext of VOICE_EXTS) {
        try {
          const names = await import('node:fs/promises').then(fs => fs.readdir(VOICES_DIR))
          for (const name of names) {
            if (!name.endsWith(ext)) continue
            const id = name.slice(0, -ext.length)
            if (voices.some(v => v.id === id)) continue
            const info = await import('node:fs/promises').then(fs => fs.stat(join(VOICES_DIR, name)))
            voices.push({ id, ext: ext.slice(1), size: info.size, hasTxt: existsSync(join(VOICES_DIR, `${id}.txt`)), hasJson: existsSync(join(VOICES_DIR, `${id}.json`)) })
          }
        } catch {}
      }
      voices.sort((a, b) => a.id.localeCompare(b.id, 'zh'))
      return json(res, 200, voices)
    }
    if (req.method === 'POST' && path === '/admin/voices') {
      const body = await readBody(req, 100 * 1024 * 1024)
      const parts = parseMultipart(body, req.headers['content-type'])
      const file = parts?.find(p => p.filename || p.name === 'file')
      if (!file?.data?.length) return json(res, 400, { code: 400, message: '没有收到音频文件' })
      const rawExt = extname(file.filename || '').slice(1).toLowerCase()
      if (!VOICE_EXTS.includes(`.${rawExt}`)) return json(res, 400, { code: 400, message: `不支持的格式 .${rawExt}（支持 ${VOICE_EXTS.join(' ')}）` })
      const idField = parts.find(p => p.name === 'id')?.data?.toString('utf8').trim()
      const id = (idField || extname(file.filename || '').slice(0, -rawExt - 1) || `voice-${Date.now().toString(36)}`).replace(/[\\/:*?"<>|]/g, '')
      if (!id) return json(res, 400, { code: 400, message: '音色 ID 无效' })
      writeFileSync(join(VOICES_DIR, `${id}.${rawExt}`), file.data)
      log(`音色已保存：${id}.${rawExt}（${file.data.length} 字节）`)
      return json(res, 200, { code: 200, id })
    }
    m = path.match(/^\/admin\/voices\/(.+)$/)
    if (req.method === 'DELETE' && m) {
      const id = decodeURIComponent(m[1])
      let removed = 0
      for (const suffix of [...VOICE_EXTS, '.txt', '.json']) {
        const p = join(VOICES_DIR, `${id}${suffix}`)
        if (existsSync(p)) { await import('node:fs/promises').then(fs => fs.unlink(p)); removed++ }
      }
      if (!removed) return json(res, 404, { code: 404, message: '音色不存在' })
      log(`音色已删除：${id}`)
      return json(res, 200, { code: 200, removed })
    }
    m = path.match(/^\/voices-files\/(.+)$/)
    if (req.method === 'GET' && m) {
      const name = decodeURIComponent(m[1])
      if (!name.startsWith('.') && !name.includes('/') && !name.includes('\\')) {
        const file = join(VOICES_DIR, name)
        if (existsSync(file)) {
          const buf = await readFile(file)
          const ext = extname(name).slice(1).toLowerCase()
          res.writeHead(200, { 'Content-Type': ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg', 'Content-Length': buf.length })
          return res.end(buf)
        }
      }
      return json(res, 404, { code: 404, message: '文件不存在' })
    }

    if (req.method === 'GET' && path === '/admin/tasks') {
      const queueInfo = async (base) => {
        try {
          const q = await comfyJson(base, '/prompt')
          return { running: q.queue_running?.length ?? 0, pending: q.queue_pending?.length ?? 0 }
        } catch { return null }
      }
      const recent = [...tasks.values()]
        .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
        .slice(0, 100)
        .map(t => ({
          id: t.id, kind: t.kind, status: t.status, stage: t.stage || null,
          progress: t.progress ?? null, progressLabel: t.progressLabel || null,
          created: t.created, updated: t.updated, duration: t.duration ?? null,
          error_message: t.error_message, voiceId: t.voiceId || null,
          audioName: t.audioName || null, imageFile: t.imageFile || null,
          hasSrt: typeof t.subtitleSrt === 'string' && t.subtitleSrt.length > 0,
          digitsConverted: t.digitsConverted ?? null,
          // 句级时间轴（配音合成时记录）：字幕任务拿它直接产出精确 SRT，
          // 不用 ASR 猜时间戳。只在配音任务上有；undefined 时下游走旧路径。
          segmentTimeline: t.segmentTimeline || null,
        }))
      return json(res, 200, { tasks: recent, ttsQueue: await queueInfo(TTS_COMFY), imageQueue: await queueInfo(IMAGE_COMFY) })
    }
    // 清空已结束的任务记录（只删历史列表，不动已生成的文件）
    if (req.method === 'POST' && path === '/admin/tasks/clear') {
      let removed = 0
      for (const [id, t] of [...tasks.entries()]) {
        if (t.status === 'completed' || t.status === 'failed') { tasks.delete(id); removed += 1 }
      }
      persistTasks()
      log(`已清空 ${removed} 条已结束的任务记录`)
      return json(res, 200, { removed })
    }
    // 运行日志尾部（控制台折叠区）
    if (req.method === 'GET' && path === '/admin/logs') {
      const want = Math.min(500, Math.max(1, Number(url.searchParams.get('lines')) || 60))
      let lines = []
      try {
        const text = readFileSync(join(DATA_DIR, 'bridge.log'), 'utf8')
        lines = text.split(/\r?\n/).filter(Boolean).slice(-want)
      } catch {}
      return json(res, 200, { lines })
    }
    m = path.match(/^\/srt-files\/([\w-]+)\.srt$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task?.subtitleSrt) return json(res, 404, { code: 404, message: '字幕不存在' })
      const buf = Buffer.from(task.subtitleSrt, 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/x-subrip; charset=utf-8', 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${m[1]}.srt"` })
      return res.end(buf)
    }

    // ---- SciTiger 兼容协议（工作台配音/字幕界面选「SciTiger 云端」） ----
    if (req.method === 'POST' && path === '/api/v1/media/audio-uploads') {
      const body = await readBody(req)
      const parts = parseMultipart(body, req.headers['content-type'])
      const file = parts?.find(p => p.filename || p.name === 'file')
      if (!file?.data?.length) return json(res, 400, { success: false, message: '没有收到音频文件' })
      const ext = (extname(file.filename || '').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'wav')
      const safeExt = AUDIO_EXTS.includes(ext) ? ext : 'wav'
      // 工作台每次配音都会重新上传同一段参考音频（例如系统默认音色 Tiffy），
      // 若按新 UUID 存盘，转写缓存 <assetId>.txt 永远命不中，同一段音频会被
      // 反复送去 ASR（实测同一文件重复转写 12 次）。按内容哈希复用资产，
      // 命中同一 assetId 即命中转写缓存。
      const assetId = resolveUploadAssetId(file.data, safeExt)
      if (!assetId.created) {
        log(`音频已上传：${assetId.id}.${safeExt}（${file.data.length} 字节，内容与已有资产一致，复用转写缓存）`)
        return json(res, 200, scitigerOk({ asset_id: assetId.id, filename: file.filename || `audio.${safeExt}` }))
      }
      writeFileSync(join(UPLOADS_DIR, `${assetId.id}.${safeExt}`), file.data)
      log(`音频已上传：${assetId.id}.${safeExt}（${file.data.length} 字节）`)
      return json(res, 200, scitigerOk({ asset_id: assetId.id, filename: file.filename || `audio.${safeExt}` }))
    }
    if (req.method === 'POST' && path === '/api/v1/tts/jobs') {
      const body = parseJson(await readBody(req))
      if (!body?.text?.trim()) return json(res, 400, { success: false, message: 'text 不能为空' })
      const task = createTask('tts')
      // 入队前的作业数（含正在运行的那个）：工作台用它显示「排队中（前面还有 N 个任务）」。
      task.queueAhead = Math.max(0, queueDepth - 1)
      // voice_source=preset 且 voice_id 命中 MiMo 内置音色表 → 内置音色模式（无参考音频）；
      // 否则 voice_id 仍按音色库 ID 查找。tts_provider / style 为按请求覆盖，缺省跟随全局配置。
      const presetVoice = body.voice_source === 'preset' && typeof body.voice_id === 'string' ? body.voice_id.trim() : ''
      const builtinVoice = presetVoice && MIMO_VOICES.includes(presetVoice) ? presetVoice : null
      const input = {
        text: body.text, outputFormat: body.output_format === 'mp3' ? 'mp3' : 'wav',
        voiceSettings: body.voice_settings || {},
        assetId: body.reference_audio_asset_id || null,
        voiceId: !builtinVoice && presetVoice ? presetVoice : (body.voice_id || null),
        builtinVoice,
        ttsProvider: body.tts_provider === 'cloud' || body.tts_provider === 'local' ? body.tts_provider : null,
        style: typeof body.style === 'string' ? body.style.trim().slice(0, 200) : '',
      }
      enqueueJob(`TTS ${task.id}`, () => runTts(task, input)).then(() => setStatus(task, 'completed')).catch(e => { log('TTS 失败:', e.message); setStatus(task, 'failed', { error_message: e.message }) })
      return json(res, 200, scitigerOk({ job_id: task.id, status: task.status }))
    }
    // 给工作台等调用方的安全信息端点：不含 API Key 本体。
    if (req.method === 'GET' && path === '/api/v1/tts/voiceover-info') {
      const cfg = loadConfig()
      return json(res, 200, scitigerOk({
        tts_provider: cfg.ttsProvider,
        mimo_voice: cfg.mimo?.voice || null,
        mimo_style: cfg.mimo?.style || null,
        mimo_key_configured: Boolean(cfg.mimo?.apiKey),
        default_voice: cfg.defaultVoice || null,
        builtin_voices: MIMO_VOICES,
      }))
    }
    if (req.method === 'POST' && path === '/api/v1/subtitle/jobs') {
      const body = parseJson(await readBody(req))
      const assetId = body?.audio_asset_id
      let audioBuffer = null
      if (assetId && /^[\w-]{8,64}$/.test(assetId)) {
        for (const ext of AUDIO_EXTS) {
          const p = join(UPLOADS_DIR, `${assetId}.${ext}`)
          if (existsSync(p)) { audioBuffer = await readFile(p); break }
        }
      }
      if (!audioBuffer) return json(res, 400, { success: false, message: '音频资产不存在或尚未上传' })
      const task = createTask('asr')
      enqueueJob(`ASR ${task.id}`, () => runSubtitles(task, {
        audioBuffer, audioFormat: body.audio_format || 'wav', language: body.language || 'zh',
        referenceText: body.reference_text || '', subtitleOptions: body.subtitle_options || {},
      })).then(() => setStatus(task, 'completed')).catch(e => { log('字幕失败:', e.message); setStatus(task, 'failed', { error_message: e.message }) })
      return json(res, 200, scitigerOk({ job_id: task.id, status: task.status }))
    }
    m = path.match(/^\/api\/v1\/tts\/jobs\/([\w-]+)$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task) return json(res, 404, { success: false, message: '任务不存在' })
      // stage/progress 必须透出：工作台靠它在任务卡片上显示「分段合成 2/5 · 36%」，
      // 长文案分段合成要好几分钟，没有进度会被用户当成卡死。
      const data = { job_id: task.id, task_id: task.id, status: task.status, duration: task.duration ?? null, error_message: task.error_message, stage: task.stage ?? null, progress: Number.isFinite(task.progress) ? task.progress : null, queue_ahead: Number.isFinite(task.queueAhead) ? task.queueAhead : null }
      if (task.status === 'completed' && task.audioName) {
        // 只有产物确实存在时才交出下载地址；否则明确报告，避免下游拿到 404。
        const audioFile = task.audioFile && existsSync(task.audioFile)
          ? task.audioFile
          : [join(TTS_DIR, task.audioName), join(TTS_DIR, `${task.id}_adj.wav`), join(TTS_DIR, `${task.id}_cat.wav`)].find(f => existsSync(f))
        if (audioFile) {
          const name = audioFile.split(/[\\/]/).pop()
          if (name !== task.audioName) { task.audioName = name; task.audioFile = audioFile; persistTasks() }
          data.result = { audio_url: `http://${req.headers.host}/audio-files/${name}`, duration: task.duration ?? null }
        } else {
          data.status = 'failed'
          data.error_message = `配音产物文件丢失：${task.audioName}`
          task.status = 'failed'; task.error_message = data.error_message; persistTasks()
        }
      }
      return json(res, 200, scitigerOk(data))
    }
    m = path.match(/^\/api\/v1\/subtitle\/jobs\/([\w-]+)$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task) return json(res, 404, { success: false, message: '任务不存在' })
      return json(res, 200, scitigerOk({ job_id: task.id, task_id: task.id, status: task.status, subtitle_srt: task.subtitleSrt ?? null, diagnostics: task.diagnostics ?? null, error_message: task.error_message }))
    }
    m = path.match(/^\/audio-files\/([\w.-]+)$/)
    if (req.method === 'GET' && m) {
      let file = join(TTS_DIR, m[1])
      if (!existsSync(file)) {
        // 兼容旧任务记录：语速/音量调整后的实际文件带 _adj 后缀
        const adj = join(TTS_DIR, m[1].replace(/\.(\w+)$/, '_adj.$1'))
        if (existsSync(adj)) file = adj
      }
      if (!existsSync(file)) return json(res, 404, { success: false, message: '音频不存在' })
      const buf = await readFile(file)
      res.writeHead(200, { 'Content-Type': m[1].endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', 'Content-Length': buf.length })
      return res.end(buf)
    }

    // ---- 兼容 TTS/ASR 服务协议（保留） ----
    if (req.method === 'POST' && path === '/api/v1/tts/synthesize') {
      const body = parseJson(await readBody(req))
      if (!body?.text?.trim()) return json(res, 400, { code: 400, message: 'text 不能为空' })
      const task = createTask('tts')
      enqueueJob(`TTS ${task.id}`, () => runTts(task, {
        text: body.text, outputFormat: body.output_format === 'mp3' ? 'mp3' : 'wav',
        voiceSettings: body.voice_settings || {},
        voiceId: typeof body.voice_id === 'string' && body.voice_id.trim() ? body.voice_id.trim() : null,
      })).then(() => setStatus(task, 'completed')).catch(e => { log('TTS 失败:', e.message); setStatus(task, 'failed', { error_message: e.message }) })
      return json(res, 200, { code: 200, data: { task_id: task.id } })
    }
    m = path.match(/^\/api\/v1\/tts\/tasks\/([\w-]+)\/audio$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task?.audioFile || !existsSync(task.audioFile)) return json(res, 404, { code: 404, message: '任务或音频不存在' })
      const buf = await readFile(task.audioFile)
      res.writeHead(200, { 'Content-Type': task.contentType, 'Content-Length': buf.length })
      return res.end(buf)
    }
    m = path.match(/^\/api\/v1\/tts\/tasks\/([\w-]+)$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task) return json(res, 404, { code: 404, message: '任务不存在' })
      return json(res, 200, { code: 200, data: { task_id: task.id, status: task.status, duration: task.duration ?? null, error_message: task.error_message } })
    }
    if (req.method === 'POST' && path === '/api/v1/subtitles/generate') {
      const body = parseJson(await readBody(req))
      if (!body?.audio_base64) return json(res, 400, { code: 400, message: 'audio_base64 不能为空' })
      const task = createTask('asr')
      enqueueJob(`ASR ${task.id}`, () => runSubtitles(task, {
        audioBuffer: Buffer.from(body.audio_base64, 'base64'), audioFormat: body.audio_format || 'wav', language: body.language || 'zh',
        referenceText: body.reference_text || '', subtitleOptions: body.subtitle_options || {},
      })).then(() => setStatus(task, 'completed')).catch(e => { log('字幕失败:', e.message); setStatus(task, 'failed', { error_message: e.message }) })
      return json(res, 200, { code: 200, data: { task_id: task.id } })
    }
    m = path.match(/^\/api\/v1\/subtitles\/tasks\/([\w-]+)$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task) return json(res, 404, { code: 404, message: '任务不存在' })
      return json(res, 200, { code: 200, data: { task_id: task.id, status: task.status, subtitle_srt: task.subtitleSrt ?? null, diagnostics: task.diagnostics ?? null, error_message: task.error_message } })
    }

    // ---- DashScope 生图协议 ----
    if (req.method === 'POST' && path === '/api/v1/services/aigc/image-generation/generation') {
      const body = parseJson(await readBody(req))
      const prompt = body?.input?.messages?.[0]?.content?.map(c => c?.text).filter(Boolean).join('\n')
      if (!prompt?.trim()) return json(res, 400, { code: 'InvalidParameter', message: '没有解析到生图提示词' })
      const size = String(body?.parameters?.size || '1328*752')
      const [w, h] = size.split('*').map(n => Math.round(Number(n) / 16) * 16)
      const task = createTask('image')
      const negativePrompt = typeof body?.parameters?.negative_prompt === 'string' ? body.parameters.negative_prompt : undefined
      const seed = Number.isSafeInteger(body?.parameters?.seed) ? body.parameters.seed : undefined
      enqueueJob(`生图 ${task.id}`, () => runImage(task, { prompt, width: w || 1328, height: h || 752, negativePrompt, seed })).then(() => setStatus(task, 'completed')).catch(e => { log('生图失败:', e.message); setStatus(task, 'failed', { error_message: e.message }) })
      return json(res, 200, { output: { task_id: task.id, task_status: 'PENDING' }, request_id: randomUUID() })
    }
    m = path.match(/^\/api\/v1\/tasks\/([\w-]+)$/)
    if (req.method === 'GET' && m) {
      const task = tasks.get(m[1])
      if (!task) return json(res, 200, { output: { task_status: 'PENDING' }, request_id: randomUUID() })
      if (task.status === 'completed') {
        return json(res, 200, {
          output: { task_status: 'SUCCEEDED', results: [{ url: `http://${req.headers.host}/img-files/${task.imageFile}` }] },
          usage: { image_count: 1 }, request_id: randomUUID(),
        })
      }
      if (task.status === 'failed') return json(res, 200, { output: { task_status: 'FAILED', message: task.error_message }, request_id: randomUUID() })
      return json(res, 200, { output: { task_status: task.status === 'queued' ? 'PENDING' : 'RUNNING' }, request_id: randomUUID() })
    }
    m = path.match(/^\/img-files\/([\w.-]+)$/)
    if (req.method === 'GET' && m && existsSync(join(IMAGES_DIR, m[1]))) {
      const buf = await readFile(join(IMAGES_DIR, m[1]))
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length })
      return res.end(buf)
    }

    json(res, 404, { code: 404, message: `未知路径 ${req.method} ${path}` })
  } catch (error) {
    log('请求处理异常:', error.message)
    json(res, 500, { code: 500, message: error.message })
  }
})

connectComfyWs(TTS_COMFY, 'tts')
connectComfyWs(IMAGE_COMFY, 'image')
server.listen(PORT, '127.0.0.1', () => log(`本地媒体桥接已启动：http://127.0.0.1:${PORT}（TTS/字幕 -> ${TTS_COMFY}，生图 -> ${IMAGE_COMFY}）`))
