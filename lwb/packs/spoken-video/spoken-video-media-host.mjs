import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { spokenVideoDataPath } from './spoken-video-paths.mjs'
import { guardSubtitleTimeline, decodePcmMono8k, speechIntervalsFromPcm } from './spoken-video-subtitle-align.mjs'
import { buildLineArtPlanPrompt, checkImageEngine, generateLineArtImage, LINE_ART_PLAN_SCHEMA, normalizeLineArtPlan, whiteboardBridgeUrl } from './spoken-video-whiteboard-art.mjs'
import { executionEvent, executionTransition } from './spoken-video-execution.mjs'
import WebSocket from 'ws'
import {
  buildTechnicalReport,
  DEFAULT_VOICE_PROFILE,
  isLoopbackEndpoint,
  MEDIA_OPERATION_STATES,
  MEDIA_OPERATION_TYPES,
  mediaServiceConfig,
  mediaCredentialRef,
  normalizeProbe,
  normalizeRenderRequest,
  normalizeSubtitleRequest,
  normalizeVoiceoverRequest,
  serviceData,
  serviceHeaders,
  subtitleResult,
  taskIdFromService,
  taskState,
  SpokenVideoMediaError,
} from './spoken-video-media.mjs'
import { appendDshSessionTrace, dshChildStarted, ensureDshTrace, projectDshSessionEvent, startDshTraceSession } from './spoken-video-dsh-trace.mjs'
import {
  evaluateAgentProjectComposition,
  evaluateAgentProjectFrames,
  inspectSpokenVideoAgentProject,
  prepareSpokenVideoAgentProject,
  remotionRendererAvailable,
  renderSpokenVideoAgentProject,
} from './spoken-video-remotion.mjs'
import { splitLongCues, validateSrt } from './spoken-video-subtitles.mjs'
import { buildVideoCreatorPrompt, buildVideoCreatorRepairPrompt, buildVideoEditorialRepairPrompt, buildVideoReviewerPrompt, normalizeVideoReview, VIDEO_REVIEW_SCHEMA } from './spoken-video-video-agent.mjs'

const execFilePromise = promisify(execFile)
async function execFileAsync(...args) {
  const result = execFilePromise(...args)
  // AbortError may reject before the child has exited. Keep the workspace
  // lease until close, so reset cannot race the child's final file writes.
  const closed = new Promise((resolvePromise) => result.child.once('close', resolvePromise))
  try { return await result } finally { await closed }
}
const PROJECT_ID = /^[a-f0-9-]{36}$/iu
const MAX_MEDIA_BYTES = 80 * 1024 * 1024
const MAX_VOICE_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_VIDEO_BGM_BYTES = 20 * 1024 * 1024
const AUDIO_UPLOAD_FORMATS = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
})
const POLL_INTERVAL_MS = 1_500
const MAX_POLL_MS = 15 * 60 * 1000
const BAILIAN_WAV_DOWNLOAD_ATTEMPTS = 2
const BAILIAN_TTS_SEGMENT_ATTEMPTS = 2
// A provider may report a job complete before its produced asset is actually
// retrievable from the CDN, so a first fetch can 404 on a perfectly good job.
const SCITIGER_DOWNLOAD_ATTEMPTS = 4
const SCITIGER_DOWNLOAD_BACKOFF_MS = 600
const BAILIAN_ASR_SAMPLE_RATE = 16_000
const BAILIAN_ASR_CHUNK_MS = 100
const BAILIAN_ASR_CHUNK_BYTES = BAILIAN_ASR_SAMPLE_RATE * 2 * BAILIAN_ASR_CHUNK_MS / 1_000
const VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS = 2
const PACK_ROOT = dirname(fileURLToPath(import.meta.url))
const DEFAULT_VOICE_FILE = join(PACK_ROOT, DEFAULT_VOICE_PROFILE.file)
const AUDIO_TASKS_FILE = 'audio-tasks.json'
const AUDIO_TASK_LIMIT = 240
const RUN_RECOVERY_GRACE_MS = 2_000

function fail(code, message) {
  throw new SpokenVideoMediaError(code, message)
}

function mediaErrorMessage(error) {
  return String(error instanceof Error ? error.message : error).replace(/^Error \[[A-Z0-9_]+\]\s*/u, '')
}

/**
 * 本地媒体桥接的地址。
 *
 * 此前这个地址以字面量散落在错误提示与代码注释里五六处，改端口或换部署方式时
 * 必然漏改——而漏改的那处只会以「打不开这个网址」的形式在用户面前出现。收敛
 * 到一处之后，改这一个函数就够。
 */
function localBridgeBase(environment = process.env) {
  const configured = environment.LWB_MEDIA_BRIDGE_URL || environment.LWB_LOCAL_BRIDGE_URL
  return String(configured || 'http://127.0.0.1:8199').replace(/\/+$/u, '')
}

/**
 * 从配音任务的「句级时间轴」（桥接合成时记录，见 bridge.mjs 的
 * splitTextSegmentsWithMeta 与拼接前的 ffprobe 段时长）生成精确 SRT。
 *
 * 这是字幕对齐的治本路径：配音是分段合成的，段边界是合成边界（ffprobe 实测），
 * 段间固定 0.2s 静音——每句话的起止在合成时就确定了，不需要 ASR 事后猜。
 * 此前让远程 ASR 给时间戳，实测滞后真实语音 4~6 秒（用户报「声音和字幕对不上」），
 * 守卫的锚点修正只能在锚点之间插值，句间仍有 1~3s 残差。
 *
 * 时间轴的句子文本是 speechText（数字已转中文），cue 文本用**原稿**：两者按
 * 「同一分句正则切出的句序号」配对——数字转换不增删句末标点，句数应当一致；
 * 不一致（原稿被手工改动等）返回 null，回退到 ASR+守卫路径。
 *
 * @returns {Promise<string|null>} SRT 字符串，拿不到时间轴或配对失败时 null。
 */

/**
 * 把若干语音 run 归并成与句子一一对应的组。
 *
 * 候选切点是 run 之间的每个间隙；要用 k−1 个把 n 个 run 切成 k 组。目标是让每组
 * 的**实际语音时长**正比于对应句子的发音字符数——TTS 各句语速接近，字数是最强的
 * 单一先验，而间隙大小不是（实测分布连续、无双峰）。
 *
 * 做法：动态规划。cost(第 j 组覆盖 run[a..b]) = |实际时长 − 该句期望时长|，
 * 期望时长按总语音时长 × 该句字数占比分配。段数很小（<8 句），O(k·n²) 完全够用。
 *
 * 返回 null 表示无法切出恰好 k 组（run 太少或句数异常），由调用方回退字符占比。
 */
export function groupRunsByCharWeight(runs, texts) {
  const n = runs.length
  const k = texts.length
  if (!n || !k || n < k) return null
  const weights = texts.map((t) => (String(t).match(/[^\s]/g) || []).length || 1)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const speechTotal = runs.reduce((sum, [f, t]) => sum + (t - f), 0)
  // cost[j][b] = 前 j+1 组恰好切到 run b 的最小代价
  const INF = Infinity
  const cost = Array.from({ length: k }, () => new Array(n).fill(INF))
  const from = Array.from({ length: k }, () => new Array(n).fill(-1))
  for (let b = 0; b < n; b += 1) {
    // 第 0 组只能从 run 0 开始
    const expected = (speechTotal * weights[0]) / weightSum
    const actual = runs[b][1] - runs[0][0]
    cost[0][b] = Math.abs(actual - expected)
    from[0][b] = -1
  }
  for (let j = 1; j < k; j += 1) {
    for (let b = j; b < n; b += 1) {
      for (let a = j - 1; a < b; a += 1) {
        if (cost[j - 1][a] === INF) continue
        const expected = (speechTotal * weights[j]) / weightSum
        const actual = runs[b][1] - runs[a][0]
        const total = cost[j - 1][a] + Math.abs(actual - expected)
        if (total < cost[j][b]) { cost[j][b] = total; from[j][b] = a }
      }
    }
  }
  if (cost[k - 1][n - 1] === INF) return null
  const cuts = []
  let b = n - 1
  for (let j = k - 1; j >= 1; j -= 1) {
    const a = from[j][b]
    if (a < 0) return null
    cuts.unshift(a)
    b = a
  }
  const groups = []
  for (let i = 0; i < k; i += 1) {
    const fromRun = i === 0 ? 0 : cuts[i - 1] + 1
    const toRun = i === k - 1 ? n - 1 : cuts[i]
    let start = runs[fromRun][0]
    let end = runs[toRun][1]
    for (let r = fromRun; r <= toRun; r += 1) { start = Math.min(start, runs[r][0]); end = Math.max(end, runs[r][1]) }
    groups.push([start, end])
  }
  return groups
}

async function segmentTimelineSrt(task, environment, fetchJson, { audioPath } = {}) {
  if (task.input?.provider !== 'scitiger') return null
  const bridgeTaskId = task.result?.taskId
  if (!bridgeTaskId) return null
  let timeline = null
  try {
    const body = await fetchJson(`${localBridgeBase(environment)}/admin/tasks`, '桥接任务列表')
    timeline = (Array.isArray(body?.tasks) ? body.tasks : []).find((t) => t.id === bridgeTaskId)?.segmentTimeline || null
  } catch { return null }
  if (!timeline?.segments?.length) return null

  // 段边界（ffprobe 实测）是地面真值，但段内句子按字符占比只对「连续语流」成立——
  // TTS 在句号处也停 0.2~0.3s，段内句间停顿会让后面的句子累积偏移 1~2s
  // （2026-10-11 首验：40 句里 18 句 onset 偏差 >0.4s，全部集中在段内第二句起）。
  // 所以段内必须用 VAD 语音段顺序配对句子：把段内的语音 run 按停顿大小归并成
  // 与句数相同的组，句起点 = 组内第一个语音 run 的起点（真实语音起点，误差 ≤0.1s）。
  let intervals = null
  if (audioPath) {
    try {
      const pcm = await decodePcmMono8k(audioPath)
      intervals = speechIntervalsFromPcm(pcm)
    } catch { intervals = null }
  }

  // 原稿按同一分句正则切句，与时间轴逐序号配对。
  const SENTENCE_SPLIT = /(?<=[。！？!?；;\n])/
  const source = String(task.source?.text || '').replace(/\s+/g, ' ')
  const sourceSentences = source.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean)
  const entries = timeline.segments.flatMap((seg) => seg.sentences || [])

// 逐段：把段内语音 runs 归并成与句数相同的组。
  //
  // 怎么选句界（2026-10-11 实测两次踩坑的结论）：
  //  · 「按 gap 从大到小取 k−1 个」是错的。实测全片 90 个间隙的中位数 0.33s、
  //    分布连续（0.10~0.88s）**没有双峰**——TTS 句末停顿和句内自然停顿同量级，
  //    纯按大小排序必然挑到句内停顿上。第一版就是这么错的：首句「宁德时代…藏着一句」
  //    中间有个 0.42s 自然停顿被当成句界，窗口被撑大到 8.26s，把第二句的前 1.6s
  //    吞了进去——用户在 7 秒听到的是第二句，画面和字幕却还停在第一句。
  //  · 正确的信号是**字数比例**：TTS 各句语速接近，某句该占多久 ≈ 它的发音字符占比。
  //    所以在所有候选切点里做动态规划，取「每组实际语音时长 ∝ 该句字数」偏差最小的切法。
  //    VAD 提供候选边界与真实起止，字数比例提供约束，两者互补。
  const sentenceWindows = []
  for (const seg of timeline.segments) {
    const segStart = seg.startMs / 1000
    const segEnd = (seg.startMs + seg.durMs) / 1000
    const sentences = seg.sentences || []
    const runs = (intervals || [])
      .filter(([f, t]) => t > segStart + 0.02 && f < segEnd - 0.02)
      .map(([f, t]) => [Math.max(f, segStart), Math.min(t, segEnd)])
    const grouped = intervals && runs.length >= sentences.length
      ? groupRunsByCharWeight(runs, sentences.map((sn) => sn.text))
      : null
    if (grouped) {
      for (const group of grouped) {
        sentenceWindows.push({ startMs: Math.round(group[0] * 1000), durMs: Math.round((group[1] - group[0]) * 1000) })
      }
      continue
    }
    // 回退：段内字符占比（无 VAD，或 runs 数与句数不匹配）
    for (const sn of sentences) {
      const segLen = Math.max(1, sn.end - sn.start || seg.end - seg.start)
      const segBase = Math.max(1, seg.end - seg.start)
      const relStart = (sn.start - seg.start) / segBase
      const relEnd = (sn.end - sn.start) / segBase
      sentenceWindows.push({ startMs: Math.round(segStart * 1000 + relStart * seg.durMs), durMs: Math.round(relEnd * seg.durMs) })
    }
  }

  // 每句一条 cue；**超长句在标点处二分**（字幕单行 ≤28 字、两行约 ≤42 字的规范）。
  //
  // 2026-10-11 修正的关键约束：二分只影响**排版**，不影响**时间边界**。
  // 此前每片按字数瓜分整句时长，而最终 end 取「下一 cue 开始 −0.06s」——于是第一句
  // （45 字、含一处自然停顿）没找到合适切点、保持单片时，它的 end 被下一句的 8.32s
  // 顶到 8.26s，**多显示了 0.4 秒**；而那 0.4 秒里音频已经在念第二句了
  // （用户在 7 秒听到「大部分人看到的是车」，画面与字幕却仍停在第一句）。
  //
  // 所以每片 end 必须夹在**本句真实语音窗口** [entry.start, entry.start+dur] 内：
  // 早于下一条 cue，但绝不超过本句语音末尾。
  const pronounced = (t) => (t.match(/[^\s]/g) || []).length || 1
  const cues = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = sentenceWindows[i]
    const text = sourceSentences[i]
    if (!text) return null
    const pieces = []
    if (pronounced(text) > 42) {
      // 找最接近中点的逗号/顿号切一刀；切不开就按中点硬切。
      const mid = Math.floor(text.length / 2)
      let cut = -1
      for (const p of ['，', '、', ',']) {
        const idx = text.lastIndexOf(p, mid + 6)
        if (idx > text.length * 0.3 && (cut < 0 || Math.abs(idx - mid) < Math.abs(cut - mid))) cut = idx + 1
      }
      if (cut > 0) { pieces.push(text.slice(0, cut), text.slice(cut)) } else { pieces.push(text) }
    } else {
      pieces.push(text)
    }
    const total = pieces.reduce((n, p) => n + pronounced(p), 0) || 1
    let offsetMs = entry.startMs
    for (const piece of pieces) {
      const dur = Math.round((pronounced(piece) / total) * entry.durMs)
      cues.push({ startMs: offsetMs, durMs: dur, sentenceEndMs: entry.startMs + entry.durMs, text: piece })
      offsetMs += dur
    }
  }
  const final = cues.map((cue, i) => {
    const next = cues[i + 1]
    // 结束时间 = 本句语音末尾与「下一句开始」里更早的那个，再抬到至少 0.45s。
    // · 不能晚于下一句开头 60ms：否则用户在 7 秒已听到第二句、字幕却还显示第一句。
    // · 不越过本句语音末尾：否则会出现「话还没说完字幕就没了」。
    //   （+350ms 放宽试过，反而让 34/40 句变成字幕滞后 0.3~0.5s，更糟。）
    // 下界固定 450ms，太短的字幕闪一下就没了。
    const latest = next ? next.startMs - 60 : Infinity
    const hardCap = cue.sentenceEndMs
    const rawEnd = Math.max(cue.startMs + 450, Math.min(latest, hardCap))
    return { start: cue.startMs / 1000, end: Math.min(rawEnd, cue.startMs + 30_000) / 1000, text: cue.text }
  })
  return buildSrt(final)
}

function buildSrt(cues) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const at = (seconds) => {
    const ms = Math.max(0, Math.round(seconds * 1000))
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`
  }
  return cues.map((c, i) => `${i + 1}\n${at(c.start)} --> ${at(c.end)}\n${c.text}`).join('\n\n') + '\n'
}

// 手动任务的默认标题取文稿第一行非空内容（截 24 字）：通篇都叫「手动输入文稿」
// 时，多条任务在列表里无法分辨（2026-10-02 用户在同步弹层里认不出自己要的那条）。
function manualTitleFromText(value) {
  const firstLine = String(value || '').split('\n').map((line) => line.trim()).find(Boolean) || ''
  if (!firstLine) return '手动输入文稿'
  const chars = [...firstLine]
  return chars.length <= 24 ? firstLine : `${chars.slice(0, 24).join('')}…`
}

// 静态预检通过后真实求值一遍入口工程：求值失败（TDZ、坏导入等运行时错误）归位成
// 可修复 finding 并入报告，让创作 Agent 在自己的修复环里修掉，而不是等渲染命令
// 失败把几十分钟的整轮报废。只在静态预检通过时调用，repairable 恒为真。
//
// 两道门依次跑：compositions 只验加载期（读 composition 元数据，不渲染任何一帧），
// 组件体里写在动画分支的坏引用它一律放行——2026-10-08 的 `a4 is not defined` 就是
// 这么漏到渲染才炸的。所以再跑一道抽帧门，每场景渲一帧把那段代码逼出来。
async function mergeRuntimeEvalFailure(report, workspace, signal) {
  const failure = await evaluateAgentProjectComposition(workspace, { signal })
    ?? await evaluateAgentProjectFrames(workspace, {
      signal,
      // 抽帧门退化时要如实上报：旧实现只认 F() 写法，遇到裸数字场景表会静默按
      // 5 秒均匀抽样，而报告仍显示通过——「门报 pass 但没按场景抽」只有这条线索。
      onCoverage: (coverage) => {
        report.frameCoverage = coverage
        if (coverage.mode === 'even') {
          report.warnings.push({
            code: 'frame-gate-even-sampling',
            file: 'src/CreativeVideo.tsx',
            line: 1,
            column: 1,
            message: '抽帧求值门未能读出场景边界，已退化为每 5 秒一帧：只能覆盖部分场景的组件体，「只有落到那段才求值」的坏引用可能被漏过。请让导演导出可解析的 SCENES 场景表。',
          })
        }
      },
    })
  if (!failure) return
  report.passed = false
  report.repairable = true
  report.findings.push(failure)
  report.failures.push(`${failure.file}:${failure.line}:${failure.column} ${failure.message}`)
}

/** Provider wording for a rejected credential, across the endpoints we call. */
const AUTH_FAILURE_DETAIL = /(?:invalid[ _-]*api[ _-]*key|incorrect api key|unauthorized|authentication failed|api[ _-]*key[ _-]*provided)/iu

function providerFailure(label, detail, endpoint = null, environment = process.env) {
  if (label.startsWith('SciTiger') && /(?:insufficient[ _-]*points|积分不足|余额不足)/iu.test(detail)) {
    return new SpokenVideoMediaError(
      'SPOKEN_VIDEO_MEDIA_INSUFFICIENT_POINTS',
      'SciTiger 账户积分不足，请充值后重试，或切换到百炼 BYOK。',
    )
  }
  // 认证失败不能只说"失败"：本机部署最常见的成因是渠道没指向本机桥接，
  // 请求落到了真云端，而那里没有有效 Key。给出可执行的下一步，而不是让
  // 用户去猜为什么"音色失败"。
  if (AUTH_FAILURE_DETAIL.test(detail)) {
    if (label.startsWith('SciTiger')) {
      return new SpokenVideoMediaError(
        'SPOKEN_VIDEO_MEDIA_CREDENTIAL_REJECTED',
        isLoopbackEndpoint(endpoint)
          ? `本机桥接拒绝了配音请求（${detail}）。请打开桥接配置中心 ${localBridgeBase(environment)}/ 检查配音方式与小米 API Key。`
          : `配音服务返回「${detail}」。当前渠道指向远端 SciTiger 云端，但本机部署应走本机桥接：请用「启动工作台.cmd」启动（它会把渠道指到 ${localBridgeBase(environment)}），或在「连接配置」里更新 SciTiger API Key。`,
      )
    }
    if (label.startsWith('百炼')) {
      return new SpokenVideoMediaError(
        'SPOKEN_VIDEO_MEDIA_CREDENTIAL_REJECTED',
        `百炼拒绝了当前 API Key（${detail}）。请在「连接配置」更新百炼 API Key，或把「配音服务」切换到本机桥接的云端/本地合成。`,
      )
    }
  }
  return new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}失败：${detail}`)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}必须是对象。`)
  return value
}

function text(value, label, maximum, options = {}) {
  if (typeof value !== 'string') fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}必须是文本。`)
  const result = options.trim === false ? value : value.trim()
  if (!result || result.length > maximum) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return result
}

function audioUploadFormat(name, mediaType, label) {
  const originalName = text(name, `${label}文件名`, 255)
  if (originalName.includes('/') || originalName.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(originalName)) {
    fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}文件名无效。`)
  }
  const extension = extname(originalName).slice(1).toLowerCase()
  if (!Object.hasOwn(AUDIO_UPLOAD_FORMATS, extension)) {
    fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}只支持 MP3、WAV、M4A 或 OGG。`)
  }
  const declaredType = typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : ''
  const aliases = {
    mp3: ['audio/mpeg', 'audio/mp3'],
    wav: ['audio/wav', 'audio/wave', 'audio/x-wav'],
    m4a: ['audio/mp4', 'audio/x-m4a'],
    ogg: ['audio/ogg', 'application/ogg'],
  }
  if (declaredType && !aliases[extension].includes(declaredType)) {
    fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}的文件扩展名与类型不一致。`)
  }
  return { originalName, extension, mediaType: AUDIO_UPLOAD_FORMATS[extension] }
}

function decodeAudioUpload(value, label, maximumBytes) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0) {
    fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}内容不是有效 Base64。`)
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const contentLength = value.length - padding
  if (!contentLength) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}内容为空。`)
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index)
    const valid = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b || code === 0x2f
    if (!valid) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}内容不是有效 Base64。`)
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}内容不是有效 Base64。`)
  }
  const estimatedBytes = value.length / 4 * 3 - padding
  if (estimatedBytes > maximumBytes) fail('SPOKEN_VIDEO_MEDIA_FILE_TOO_LARGE', `${label}不能超过 20 MiB。`)
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length !== estimatedBytes || bytes.toString('base64') !== value) {
    fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', `${label}内容不是规范 Base64。`)
  }
  return bytes
}

const voiceReferenceFormat = (name, mediaType) => audioUploadFormat(name, mediaType, '参考音频')
const decodeVoiceReference = (value) => decodeAudioUpload(value, '参考音频', MAX_VOICE_REFERENCE_BYTES)
const videoBgmFormat = (name, mediaType) => audioUploadFormat(name, mediaType, '背景音乐')
const decodeVideoBgm = (value) => decodeAudioUpload(value, '背景音乐', MAX_VIDEO_BGM_BYTES)

function projectId(value) {
  const result = text(value, '项目标识', 36).toLowerCase()
  if (!PROJECT_ID.test(result)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '项目标识无效。')
  return result
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '项目版本无效。')
  return value
}

function pathInside(root, candidate) {
  const candidateRelative = relative(root, candidate)
  return candidateRelative !== '' && !candidateRelative.startsWith(`..${sep}`) && candidateRelative !== '..' && !isAbsolute(candidateRelative)
}

function mediaPath(value, label) {
  const file = text(value, label, 280)
  if (!/^media\/[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(file)) {
    fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}无效。`)
  }
  return file
}

async function workspaceFor(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '媒体操作需要已加载的能力包专属工作区。')
  try {
    const workspace = await realpath(cwd)
    const info = await lstat(workspace)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid workspace')
    return workspace
  } catch {
    fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '能力包专属工作区不可用，请重新加载能力包后重试。')
  }
}

async function projectRootFor(agent, id) {
  const workspace = await workspaceFor(agent)
  const root = spokenVideoDataPath(workspace, 'projects', id)
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_NOT_FOUND', '口播项目不存在。')
  return root
}

async function audioTasksRootFor(agent) {
  const workspace = await workspaceFor(agent)
  const root = spokenVideoDataPath(workspace)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '音频任务目录无效。')
  return realpath(root)
}

async function safeMediaTarget(root, relativePath, label, createDirectories = false) {
  const parts = relativePath.split('/')
  const filename = parts.pop()
  const resolvedRoot = await realpath(root)
  let directory = resolvedRoot
  for (const segment of parts) {
    const candidate = join(directory, segment)
    let info = await lstat(candidate).catch(() => null)
    if (!info && createDirectories) {
      await mkdir(candidate, { mode: 0o700 })
      info = await lstat(candidate).catch(() => null)
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}路径无效。`)
    const resolved = await realpath(candidate)
    if (resolved !== resolvedRoot && !pathInside(resolvedRoot, resolved)) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}超出项目目录。`)
    directory = resolved
  }
  return join(directory, filename)
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    // Windows：rename 的目标只要被任意句柄打开就会 EPERM（界面轮询会撞上写入窗口）；
    // 退避重试吸收，真故障仍抛出。失败时清掉临时文件，不在数据目录留下整份副本。
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break }
      catch (error) {
        if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= 6) throw error
        await new Promise((resolve) => setTimeout(resolve, [50, 120, 280, 600, 1200, 2400, 4000][attempt]))
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function readJson(path, fallback) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '媒体任务记录无效。')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '媒体任务记录不是有效 JSON。')
    throw error
  }
}

function runsFile(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.runs)) return { schemaVersion: 1, runs: [] }
  return {
    schemaVersion: 1,
    runs: value.runs.filter((run) => run && typeof run === 'object' && MEDIA_OPERATION_TYPES.includes(run.type) && MEDIA_OPERATION_STATES.includes(run.status)).slice(-80),
  }
}

async function readRuns(root) {
  return runsFile(await readJson(join(root, 'media', 'runs.json'), { schemaVersion: 1, runs: [] }))
}

async function writeRuns(root, value) {
  await writeJson(join(root, 'media', 'runs.json'), runsFile(value))
}

function audioTasksFile(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) return { schemaVersion: 1, tasks: [] }
  return { schemaVersion: 1, tasks: value.tasks.filter((task) => task && typeof task === 'object' && typeof task.id === 'string').slice(-AUDIO_TASK_LIMIT) }
}

async function readAudioTasks(root) {
  return audioTasksFile(await readJson(join(root, AUDIO_TASKS_FILE), { schemaVersion: 1, tasks: [] }))
}

async function writeAudioTasks(root, value) {
  await writeJson(join(root, AUDIO_TASKS_FILE), audioTasksFile(value))
}

function runSummary(run) {
  return {
    id: run.id,
    type: run.type,
    status: run.status,
    projectId: run.projectId,
    expectedRevision: run.expectedRevision,
    createdAt: run.createdAt,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    phase: run.phase || null,
    error: run.error || null,
    result: run.result || null,
    pipeline: run.type === 'video' && run.pipeline && typeof run.pipeline === 'object' ? run.pipeline : null,
    input: run.input ? {
      provider: run.input.provider || null,
      voiceSource: run.input.voiceSource || null,
      voiceId: run.input.voiceId || null,
      voiceName: run.input.voiceName || null,
      rate: run.input.rate ?? null,
      volume: run.input.volume ?? null,
      language: run.input.language || null,
      visualBrief: run.input.visualBrief || null,
      renderer: run.input.renderer || null,
      orientation: run.input.orientation === 'landscape' ? 'landscape' : 'portrait',
      subtitleEnabled: run.input.subtitleEnabled !== false,
      backgroundMusic: run.input.backgroundMusic && typeof run.input.backgroundMusic === 'object' ? run.input.backgroundMusic : null,
      bgmVolume: Number.isFinite(run.input.bgmVolume) ? run.input.bgmVolume : null,
      videoTaskId: run.input.videoTaskId || null,
    } : null,
    // Video runs retain their source snapshot. Project artifacts can advance
    // after a task is submitted, while this record must stay inspectable.
    source: run.type === 'video' && run.source && typeof run.source === 'object' ? run.source : null,
    dsh: run.dsh && typeof run.dsh === 'object' ? {
      childSessionId: typeof run.dsh.childSessionId === 'string' ? run.dsh.childSessionId : null,
      parentSessionId: typeof run.dsh.parentSessionId === 'string' ? run.dsh.parentSessionId : null,
      events: Array.isArray(run.dsh.events) ? run.dsh.events : [],
      sessions: Array.isArray(run.dsh.sessions) ? run.dsh.sessions : [],
    } : null,
  }
}

function videoSourceSnapshot(detail, subtitleEnabled) {
  const script = detail?.artifacts?.script
  const voiceover = detail?.artifacts?.voiceover
  const subtitles = detail?.artifacts?.subtitles
  const body = typeof script?.data?.body === 'string' ? script.data.body : ''
  const audio = voiceover?.data?.audio && typeof voiceover.data.audio === 'object' ? voiceover.data.audio : null
  const srt = typeof subtitles?.data?.srt === 'string' ? subtitles.data.srt : null
  return {
    title: typeof detail?.title === 'string' ? detail.title : '未命名稿件',
    script: { revision: script?.revision || null, body },
    voiceover: {
      revision: voiceover?.revision || null,
      audio: audio ? {
        file: audio.file || null,
        mediaType: audio.mediaType || null,
        bytes: audio.bytes ?? null,
        durationSeconds: audio.durationSeconds ?? null,
      } : null,
    },
    subtitles: subtitleEnabled ? {
      revision: subtitles?.revision || null,
      srt,
      cueCount: subtitles?.data?.cueCount ?? null,
    } : null,
  }
}

function audioTaskSummary(task) {
  const subtitle = task.subtitle || { status: 'idle' }
  return {
    id: task.id,
    type: 'voiceover',
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    error: task.error || null,
    progress: task.progressInfo || null,
    projectSync: task.projectSync || null,
    projectSyncError: task.projectSyncError || null,
    subtitleSyncError: task.subtitleSyncError || null,
    source: {
      kind: task.source?.kind || 'manual-text',
      projectId: task.source?.projectId || null,
      projectTitle: task.source?.projectTitle || null,
      title: task.source?.title || '未命名文稿',
      text: task.source?.text || '',
    },
    input: task.input ? {
      provider: task.input.provider || null,
      voiceSource: task.input.voiceSource || null,
      voiceId: task.input.voiceId || null,
      voiceName: task.input.voiceName || null,
      // 桥接覆盖要随任务回传：任务卡要显示用的哪种合成，失败重试要原样重放。
      bridge: task.input.bridge || null,
      rate: task.input.rate ?? null,
      volume: task.input.volume ?? null,
      subtitleEnabled: task.input.subtitleEnabled === true,
    } : null,
    result: task.result || null,
    subtitle: {
      status: subtitle.status || 'idle',
      id: subtitle.id || null,
      createdAt: subtitle.createdAt || null,
      startedAt: subtitle.startedAt || null,
      completedAt: subtitle.completedAt || null,
      error: subtitle.error || null,
      cueCount: subtitle.current?.cueCount ?? null,
      currentVersionId: subtitle.current?.id || null,
      srt: subtitle.current?.srt || null,
    },
  }
}

function requestId() {
  return randomUUID().replace(/-/gu, '')
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function awaitWithin(promise, milliseconds, code, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new SpokenVideoMediaError(code, message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function mediaTypeForFormat(format) {
  return ({ wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg' })[format] || 'application/octet-stream'
}

function extensionForFormat(format) {
  return ({ wav: 'wav', mp3: 'mp3', m4a: 'm4a', ogg: 'ogg' })[format] || 'wav'
}

async function defaultVoiceReference() {
  const info = await lstat(DEFAULT_VOICE_FILE).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_MEDIA_BYTES) {
    fail('SPOKEN_VIDEO_MEDIA_NOT_CONFIGURED', `项目默认音色 ${DEFAULT_VOICE_PROFILE.name} 不可用。`)
  }
  const audio = await readFile(DEFAULT_VOICE_FILE)
  if (!audio.length || audio.length > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '项目默认音色文件无效。')
  return { ...DEFAULT_VOICE_PROFILE, path: DEFAULT_VOICE_FILE, audio }
}

function nested(value, path) {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = current[key]
  }
  return current
}

function stringAt(value, ...paths) {
  for (const path of paths) {
    const candidate = nested(value, path)
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

/**
 * Decide whether a failed asset download is worth retrying. A not-yet-available
 * asset surfaces as 404 (and occasionally 408/429/5xx); those resolve on their
 * own. Unreachable transport errors are also retried. Validation failures
 * (truncated or oversized payloads) are not, because they are not timing.
 */
function isTransientDownloadError(error) {
  if (error?.code === 'SPOKEN_VIDEO_MEDIA_SERVICE_UNREACHABLE') return true
  if (error?.code !== 'SPOKEN_VIDEO_MEDIA_SERVICE_FAILED') return false
  const status = /HTTP (\d{3})/u.exec(String(error.message || ''))
  if (!status) return false
  const code = Number(status[1])
  return code === 404 || code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599)
}

/**
 * 解析 Remotion CLI 的渲染进度输出，例如：
 *   "Rendered 5/8873, time remaining: 35m 52s"
 *   "Bundling 65%"
 * 返回结构化进度；无法识别时返回 null（不猜）。
 */
export function parseRemotionRenderProgress(message) {
  const text = String(message || '')
  const rendered = /Rendered\s+(\d+)\s*\/\s*(\d+)(?:,\s*time remaining:\s*([0-9]+(?:m\s*[0-9]+s?|s|h\s*[0-9]+m\s*[0-9]+s?)))?/u.exec(text)
  if (rendered) {
    const done = Number(rendered[1])
    const total = Number(rendered[2])
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
    return {
      stage: 'rendering',
      done,
      total,
      percent: Math.max(0, Math.min(100, Math.round((done / total) * 100))),
      remainingSeconds: parseDurationText(rendered[3]),
    }
  }
  const bundling = /Bundling\s+(\d+)%/u.exec(text)
  if (bundling) {
    const percent = Math.max(0, Math.min(100, Number(bundling[1])))
    return { stage: 'bundling', done: null, total: null, percent, remainingSeconds: null }
  }
  return null
}

/** 把 "35m 52s" / "1h 2m 3s" / "12s" 解析成秒。 */
function parseDurationText(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let seconds = 0
  let matched = false
  const hours = /(\d+)\s*h/u.exec(value)
  const minutes = /(\d+)\s*m/u.exec(value)
  const secs = /(\d+)\s*s/u.exec(value)
  if (hours) { seconds += Number(hours[1]) * 3600; matched = true }
  if (minutes) { seconds += Number(minutes[1]) * 60; matched = true }
  if (secs) { seconds += Number(secs[1]); matched = true }
  return matched ? seconds : null
}

function boundedHttpUrl(value, label) {  const raw = text(value, label, 4000)
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}不是有效 URL。`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}不受支持。`)
  }
  return parsed.toString()
}

function srtTime(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

function subtitleReferenceWeight(value) {
  let weight = 0
  for (const character of Array.from(String(value || ''))) {
    if (/\p{L}|\p{N}/u.test(character)) weight += 1
    else if (/\s/u.test(character)) weight += 0.15
    else weight += 0.35
  }
  return weight
}

function referenceBoundary(chars, desired, minimum, maximum) {
  const target = Math.max(minimum, Math.min(maximum, Math.round(desired)))
  const lower = Math.max(minimum, target - 36)
  const upper = Math.min(maximum, target + 36)
  let best = target
  let distance = Number.POSITIVE_INFINITY
  for (let index = lower; index <= upper; index += 1) {
    if (index !== 0 && index !== chars.length && !/[\s，。！？!?；;、：:,\n]/u.test(chars[index - 1])) continue
    const nextDistance = Math.abs(index - target)
    if (nextDistance < distance) { best = index; distance = nextDistance }
  }
  return best
}

/** Keep ASR timing anchors but use the authored script for terminology-safe subtitle text. */
function alignSentencesToReference(sentences, referenceText) {
  const reference = String(referenceText || '').replace(/\s+/gu, ' ').trim()
  const sourceChars = Array.from(reference)
  const usable = (sentences || []).filter((sentence) => sentence && typeof sentence.text === 'string' && sentence.text.trim() && Number.isFinite(sentence.begin) && Number.isFinite(sentence.end))
  if (!sourceChars.length || !usable.length) return sentences
  const sourceWeight = Math.max(1, subtitleReferenceWeight(reference))
  const sourceWeights = []
  let cumulativeSourceWeight = 0
  for (const character of sourceChars) {
    cumulativeSourceWeight += subtitleReferenceWeight(character)
    sourceWeights.push(cumulativeSourceWeight)
  }
  const sentenceWeights = usable.map((sentence) => Math.max(1, subtitleReferenceWeight(sentence.text)))
  const totalWeight = sentenceWeights.reduce((sum, value) => sum + value, 0)
  let consumedWeight = 0
  let sourceStart = 0
  return usable.map((sentence, index) => {
    consumedWeight += sentenceWeights[index]
    const remainingSentences = usable.length - index - 1
    const minimum = sourceStart + 1
    const maximum = Math.max(minimum, sourceChars.length - remainingSentences)
    let sourceEnd = sourceChars.length
    if (index !== usable.length - 1) {
      const desiredWeight = sourceWeight * consumedWeight / totalWeight
      const desired = sourceWeights.findIndex((value) => value >= desiredWeight) + 1
      sourceEnd = referenceBoundary(sourceChars, desired < 1 ? minimum : desired, minimum, maximum)
    }
    const text = sourceChars.slice(sourceStart, sourceEnd).join('').trim()
    sourceStart = sourceEnd
    return { ...sentence, text: text || sentence.text.trim() }
  })
}

function srtFromSentences(sentences) {
  const expanded = []
  for (const sentence of sentences || []) {
    if (!sentence || typeof sentence.text !== 'string' || !sentence.text.trim() || !Number.isFinite(sentence.begin) || !Number.isFinite(sentence.end)) continue
    const source = sentence.text.trim()
    // Realtime ASR returns VAD turns, which can span an entire paragraph. Split
    // locally at punctuation and then enforce video-readable limits.
    const clauses = source.match(/[^。！？!?；;，,、：:]+[。！？!?；;，,、：:]?/gu) || [source]
    const chunks = []
    for (const clause of clauses) {
      const chars = Array.from(clause.trim())
      for (let offset = 0; offset < chars.length; offset += 22) chunks.push(chars.slice(offset, offset + 22).join(''))
    }
    const totalChars = Math.max(1, Array.from(source).length)
    const duration = Math.max(1, sentence.end - sentence.begin)
    let cursor = 0
    for (const chunk of chunks) {
      const start = sentence.begin + Math.round(duration * cursor / totalChars)
      cursor += Array.from(chunk).length
      const end = sentence.begin + Math.round(duration * cursor / totalChars)
      expanded.push({ begin: start, end: Math.max(end, start + 250), text: chunk })
    }
  }
  const rows = expanded
    .filter((sentence) => sentence && typeof sentence.text === 'string' && sentence.text.trim() && Number.isFinite(sentence.begin) && Number.isFinite(sentence.end))
    .sort((left, right) => left.begin - right.begin)
    .map((sentence, index) => `${index + 1}\n${srtTime(sentence.begin)} --> ${srtTime(Math.max(sentence.end, sentence.begin + 250))}\n${sentence.text.trim()}`)
  if (!rows.length) fail('SPOKEN_VIDEO_SUBTITLES_INVALID', '百炼没有返回可用的最终识别结果。')
  return `${rows.join('\n\n')}\n`
}

/** Qwen TTS accepts at most 512 input tokens. Four hundred Unicode code points is intentionally conservative. */
function splitTtsText(value, maximum = 400) {
  const source = text(value, '配音文稿', 60_000)
  const sentences = source.match(/[^。！？!?；;…\n]+[。！？!?；;…]?|\n+/gu) || [source]
  const pieces = []
  let current = ''
  const flush = () => {
    const next = current.trim()
    if (next) pieces.push(next)
    current = ''
  }
  for (const sentence of sentences) {
    const normalized = sentence.trim()
    if (!normalized) continue
    const chars = Array.from(normalized)
    if (chars.length > maximum) {
      flush()
      for (let offset = 0; offset < chars.length; offset += maximum) pieces.push(chars.slice(offset, offset + maximum).join(''))
      continue
    }
    if (current && Array.from(current).length + chars.length > maximum) flush()
    current = `${current}${normalized}`
  }
  flush()
  if (!pieces.length) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '配音文稿为空。')
  return pieces
}

function wavSizeIsUnbounded(value) {
  // Some Bailian voice-clone WAVs retain a non-final size near the 2 GiB RIFF limit.
  return value === 0xffffffff || value >= 0x7fff0000
}

function wavContainerError(bytes, options = {}) {
  const allowUnboundedSize = options.allowUnboundedSize === true
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return '返回的不是有效 WAV 音频'
  }
  const riffSize = bytes.readUInt32LE(4)
  if (riffSize !== 0xffffffff && riffSize + 8 > bytes.length && !(allowUnboundedSize && wavSizeIsUnbounded(riffSize))) {
    return `RIFF 声明 ${riffSize + 8} 字节，实际仅下载 ${bytes.length} 字节`
  }
  let offset = 12
  let hasFormat = false
  let hasData = false
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const content = offset + 8
    const end = content + size
    if (end > bytes.length) {
      if (allowUnboundedSize && name === 'data' && wavSizeIsUnbounded(size) && content < bytes.length) {
        hasData = true
        break
      }
      return `${name.trim() || '未知'} 块声明 ${size} 字节，但文件在第 ${bytes.length} 字节结束`
    }
    if (name === 'fmt ' && size >= 16) hasFormat = true
    if (name === 'data' && size > 0) hasData = true
    offset = end + (size % 2)
  }
  if (!hasFormat) return '缺少有效的 fmt 格式块'
  if (!hasData) return '缺少非空的 data 音频块'
  return null
}

function repairUnboundedWavHeader(bytes) {
  const repaired = Buffer.from(bytes)
  const actualRiffSize = repaired.length - 8
  if (wavSizeIsUnbounded(repaired.readUInt32LE(4))) repaired.writeUInt32LE(actualRiffSize, 4)
  let offset = 12
  while (offset + 8 <= repaired.length) {
    const name = repaired.toString('ascii', offset, offset + 4)
    const size = repaired.readUInt32LE(offset + 4)
    const content = offset + 8
    const end = content + size
    if (end > repaired.length) {
      if (name === 'data' && wavSizeIsUnbounded(size) && content < repaired.length) {
        repaired.writeUInt32LE(repaired.length - content, offset + 4)
      }
      break
    }
    offset = end + (size % 2)
  }
  return repaired
}

function ffmpegConcatEntry(file) {
  return `file '${file.replace(/'/gu, "'\\''")}'`
}

function sendSocket(socket, data, options) {
  return new Promise((resolvePromise, reject) => {
    socket.send(data, options, (error) => error ? reject(error) : resolvePromise())
  })
}

async function sendRealtimePcm(socket, stream, failure) {
  let pending = Buffer.alloc(0)
  let nextSendAt = Date.now()
  const send = async (chunk) => {
    const wait = nextSendAt - Date.now()
    if (wait > 0) await Promise.race([delay(wait), failure])
    await Promise.race([
      sendSocket(socket, JSON.stringify({ type: 'input_audio_buffer.append', event_id: randomUUID(), audio: chunk.toString('base64') })),
      failure,
    ])
    nextSendAt = Math.max(nextSendAt + BAILIAN_ASR_CHUNK_MS, Date.now())
  }
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
    while (pending.length >= BAILIAN_ASR_CHUNK_BYTES) {
      await send(pending.subarray(0, BAILIAN_ASR_CHUNK_BYTES))
      pending = pending.subarray(BAILIAN_ASR_CHUNK_BYTES)
    }
  }
  if (pending.length) await send(pending)
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolvePromise) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise()
    }
    const timeout = setTimeout(() => {
      socket.terminate()
      done()
    }, 2_000)
    socket.once('close', done)
    socket.close()
  })
}

function waitForChild(child, label) {
  return new Promise((resolvePromise, reject) => {
    let stderr = ''
    let failure
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000) })
    child.once('error', (error) => { failure = commandError(error, label) })
    child.once('close', (code) => {
      if (failure) reject(failure)
      else if (code === 0) resolvePromise()
      else reject(new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_COMMAND_FAILED', `${label}失败：${stderr.trim() || `退出码 ${code}`}`))
    })
  })
}

function commandError(error, label) {
  const detail = typeof error?.stderr === 'string' ? error.stderr.trim().slice(-900) : error?.message || String(error)
  return new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_COMMAND_FAILED', `${label}失败：${detail}`)
}

function ffmpegSubtitleFilter(file) {
  const escaped = file.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:').replace(/'/gu, "\\'")
  // libass 默认 PlayRes 是 384x288，MarginV 按 288 的高度换算：原先的 180 等于
  // 距底 62%，字幕被顶到画面上半部；30 ≈ 距底 10%，才是常规的底部字幕位置。
  return `subtitles=filename='${escaped}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00131F32,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=30'`
}

function portableRelative(root, file) {
  return relative(root, file).split(sep).join('/')
}

/**
 * 从导演生成的 Remotion 工程里读出场景边界（审片抽帧用）。
 *
 * 唯一实现在 spoken-video-scene-table.mjs，抽帧门与漂移门也调它。此前这里有一份
 * 独立副本，两边覆盖范围不一致导致「门报 pass 但没按场景抽」（2026-10-15 实测 5 个
 * 项目命中 3/5），详见该文件头注。
 */
export { parseSceneSpans } from './spoken-video-scene-table.mjs'

/**
 * 审片抽帧的保底数量。
 *
 * 时长加权铺底至少取这么多帧（场景数足够时）。12 是实测选的：历史成片场景数
 * 中位 23、p90 约 40。注意这不是硬上限——场景特别多的片子会由最大空档约束
 * （REVIEW_MAX_GAP_SECONDS）继续补帧，直到盖住空档或到达 REVIEW_FRAME_HARD_LIMIT。
 */
export const REVIEW_FRAME_LIMIT = 12

/**
 * 相邻抽帧点的最大允许间距（秒）。
 *
 * 「抽样点都没问题」不等于「没抽样点的地方也没问题」——缺陷藏在空档里。
 * 2026-10-15 实测一条 39 场景的成片，12 帧铺底后 122.5s→202.8s 有 80 秒空档，
 * 全白幕恰好落在其中，审片（只看 12 帧）给了 82 分通过。25 秒的取值：
 * 历史成片时长中位约 6 分钟，12 帧铺底平均间距 30 秒——25 秒略紧于均值，
 * 所以短中片几乎不触发补帧，只有长片/多场景片子才按需增长。
 */
export const REVIEW_MAX_GAP_SECONDS = 25

/**
 * 抽帧的绝对上限（含空档补帧）。
 *
 * 存在的意义是给成本封顶：一条 30 分钟的片子若不加限制会补出 70+ 帧。
 * 审片耗时实测与帧数弱相关（6→12 帧只多 34 秒/轮），但 70 帧的图片 token
 * 仍会显著变贵；80 帧足以把最长历史成片（8.5 分钟）的空档压到 25 秒内。
 * store 侧的抽帧文件数校验跟随本值。
 */
export const REVIEW_FRAME_HARD_LIMIT = 24

/** 没有场景表时的盲选系数（按全片比例）。与 REVIEW_FRAME_LIMIT 对齐。 */
export const REVIEW_FRAME_LIMIT_FALLBACK = [0.03, 0.11, 0.2, 0.29, 0.38, 0.46, 0.55, 0.64, 0.72, 0.81, 0.9, 0.97]

/*
 * 曾经在这里加过一道「主画面非背景像素占比低于阈值即判空幕」的确定性闸门，
 * 已删除——实测证明它不成立（2026-10-13）。
 *
 * 做法是量每帧里与四角背景色不同的像素占比。样本取自那条 359 秒、23 幕的成片，
 * 每幕 60% 处各取一帧：整幕只剩页眉的空白幕是 6.3%，而一个内容完全正常、
 * 只是画面疏朗的「左卡→连线→右卡」示意图是 **3.0%**——空白幕的占比反而更高。
 * 两组分布整体重叠（3.0%-14.8%，中位 7.7%），任何单一阈值都必然误判。
 *
 * 结论：像素占比无法区分「空」与「疏朗」，这类判断只能交给看图的审片。
 * 所以真正的修复是让审片真的看到那一幕（提高抽帧密度、按时长加权采样），
 * 而不是加一个看起来更确定、实际上会误杀正常画面的阈值。
 */

/**
 * 审片抽帧时刻。
 *
 * 2026-10-10 改过。原来这里只按全片比例盲选 6 个点（3%/20%/40%/60%/80%/97%），
 * 完全不知道场景边界在哪——而场景边界就在同一份工程里写着。实测一条 460 秒、
 * 18 个场景的片子，6 帧里 4 帧落在场景的前 20%（入场动画期），于是审片看到的是
 * 「只有骨架」「内容没画出来」「像未完成」，而导演被要求去修这些并不存在的缺陷：
 *
 *   276.096s → honesty 场景的  5%  ← 两轮都被点「右半幅完全空白」
 *   368.128s → dev     场景的 16%  ← 被点「三条事项并未绘制出来」
 *    13.805s → deal    场景的 15%  ← 被点「卡内仅渲染出第一条要点」
 *
 * 6 帧里 4 帧天生有问题，而审片修复最多 2 轮（index.mjs 的 maxRepairs），
 * 于是每条片子必然在 2 轮后仍判失败——这就是 5 个历史案例全灭的原因。
 * 放宽超时只会让每次失败多烧 20 分钟渲染，治不了这个。
 *
 * 现在：拿到场景表就取「每帧落在某个场景的稳定期中段」，取不到才退回旧的比例盲选。
 * 取中段而不是场景起点，是因为入场动画一般在场景前 20-30% 结束。
 *
 * 2026-10-13 再改：帧数从固定 6 帧改成随场景数增长（上限 REVIEW_FRAME_LIMIT）。
 * 固定 6 帧在场景多于 6 个时必然漏看大部分场景——实测一条 359 秒、23 场景的
 * 成片，6 帧只覆盖 6 幕，17 幕共 290 秒没人看过，其中整幕空白（blocker）被放过。
 * 抽帧是审片唯一的证据来源，漏一幕就等于那一幕不存在。
 */
export function reviewTimestamps(durationSeconds, sceneSpans = null) {
  const duration = Math.max(0.2, Number(durationSeconds) || 0.2)
  const end = Math.max(0.05, duration - Math.min(0.12, duration * 0.05))
  const clamp = (value) => Math.min(end, Math.max(0, value))

  const spans = (Array.isArray(sceneSpans) ? sceneSpans : [])
    .filter((span) => Number.isFinite(span?.start) && Number.isFinite(span?.end) && span.end > span.start)
  if (spans.length >= 2) {
    // 抽帧策略（2026-10-15 定稿）：按时长加权铺底 + 最大空档约束。
    //
    // 三代演进：
    //   固定 6 帧 → 实测 23 场景只看 6 幕、17 幕 290 秒没人看（含整幕空白 blocker）
    //   时长加权 12 帧 → 覆盖翻倍，但 39 场景的片子上仍有 80 秒空档，空幕恰好漏过
    //   现在 → 在 12 帧的基础上再按「最大空档」补帧：任何相邻两帧间距超过
    //          REVIEW_MAX_GAP_SECONDS 就在中间插帧，直到盖住或到达绝对上限。
    //
    // 为什么不直接把上限提到 20：39 场景的片子 20 帧也盖不住，空档还在；
    // 而空档本身才是缺陷藏身的地方——「抽样点都没问题」不等于「没抽样点的地方
    // 也没问题」。约束空档是把「盖不住」变成「盖得住」，帧数随实际需要增长。
    //
    // 取每个场景的 60% 处（不是起点）：入场动画一般在场景前 20-30% 结束。
    const limit = Math.min(REVIEW_FRAME_LIMIT, spans.length)
    const first = spans[0].start
    const total = Math.max(0.01, spans[spans.length - 1].end - first)
    const pickedIndexes = []
    // 开头两幕强制入选。时长均分的第一个目标点在 15 秒开外，而实测两条相邻的
    // 场景（0.1-5.5s 的钩子、6.1-21.2s 的整幕空白）都落在那之前——按时长均分
    // 会同时漏掉开场钩子和整幕空白这两处最该看的地方。开头是缺陷最密集、
    // 也最影响留存的区间，所以显式给它留两个名额。
    for (let index = 0; index < Math.min(2, limit); index += 1) pickedIndexes.push(index)
    for (let i = pickedIndexes.length; i < limit; i += 1) {
      const target = first + (total * (i + 0.5)) / limit
      let index = spans.findIndex((span) => target >= span.start && target < span.end)
      if (index === -1) index = i * spans.length >= limit ? spans.length - 1 : 0
      if (pickedIndexes.includes(index)) {
        // 目标场景已被选过：就近找一个还没选过的，长场景优先（信息量大的更容易出问题）。
        const ordered = [...Array(spans.length).keys()]
          .filter((candidate) => !pickedIndexes.includes(candidate))
          .sort((a, b) => {
            const spanA = spans[b].end - spans[b].start
            const spanB = spans[a].end - spans[a].start
            const distanceA = Math.abs(a - index)
            const distanceB = Math.abs(b - index)
            // 先看距离，再看时长：距离决定「大致均匀」，时长决定「多看长幕」。
            return distanceA !== distanceB ? distanceA - distanceB : spanA - spanB
          })
        if (!ordered.length) break
        index = ordered[0]
      }
      pickedIndexes.push(index)
    }
    const picked = pickedIndexes.map((index) => {
      const span = spans[index]
      // 60% 处：入场动画早已结束，同时离下一场景切换还有余量，短场景也能落在中间。
      return clamp(span.start + (span.end - span.start) * 0.6)
    })
    // 最大空档约束：相邻抽帧点间距超阈值就在空档中点补帧，直到盖住。
    // 补帧落点也要避开入场动画：优先落在「空档中点」所在的场景 60% 处。
    const gapFilled = [...picked]
    for (let guard = 0; guard < REVIEW_FRAME_LIMIT; guard += 1) {
      const sorted = [...gapFilled].sort((a, b) => a - b)
      let worstGap = 0
      let worstAt = -1
      for (let i = 1; i < sorted.length; i += 1) {
        const gap = sorted[i] - sorted[i - 1]
        if (gap > worstGap) { worstGap = gap; worstAt = i - 1 }
      }
      if (worstGap <= REVIEW_MAX_GAP_SECONDS || gapFilled.length >= REVIEW_FRAME_HARD_LIMIT) break
      const mid = (sorted[worstAt] + sorted[worstAt + 1]) / 2
      // 补帧落点必须落在某个场景的稳定期（≥35% 相位）：抽帧对齐稳定期是既有契约
      // （审片把 60% 时刻的画面当作场景完成态），而空档里可能根本没有场景
      // （场景表在场景之间留了无人区，如 63.2s→428.5s）。
      // 做法：从空档中点向两侧扫，步长 0.5 秒，第一个「属于某场景且相位达标
      // 且未被抽过」的点入选；整个空档都找不到（两侧场景都已抽过或相位不符）
      // 就放弃这个空档——它已由两侧的抽帧点代表，强行塞点只会制造动画期误帧。
      let candidate = null
      for (let offset = 0; offset <= worstGap / 2; offset += 0.5) {
        for (const probe of [mid + offset, mid - offset]) {
          const span = spans.find((s) => probe >= s.start && probe < s.end)
          if (!span) continue
          const phase = (probe - span.start) / (span.end - span.start)
          if (phase >= 0.35 && !gapFilled.some((item) => Math.abs(item - probe) < 0.05)) { candidate = probe; break }
        }
        if (candidate != null) break
      }
      if (candidate == null) break
      gapFilled.push(Number(candidate.toFixed(3)))
    }
    const unique = [...new Set(gapFilled.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b)
    if (unique.length >= 2) return unique
  }

  // 没有可用场景表：退回旧的比例盲选（短视频另用一套系数）。
  const factors = duration < 2 ? [0.08, 0.32, 0.58, 0.86] : REVIEW_FRAME_LIMIT_FALLBACK
  return [...new Set(factors.map((factor) => clamp(duration * factor).toFixed(3)))].map(Number)
}

async function extractVideoReviewFrames(videoPath, outputDir, durationSeconds, signal, sceneSpans = null) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const timestamps = reviewTimestamps(durationSeconds, sceneSpans)
  const frameFiles = timestamps.map((_, index) => join(outputDir, `frame-${String(index + 1).padStart(2, '0')}.png`))
  const results = await Promise.allSettled(frameFiles.map(async (file, index) => {
    try {
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-ss', String(timestamps[index]), '-i', videoPath, '-frames:v', '1', file], { signal, maxBuffer: 1024 * 1024 * 4 })
      const info = await stat(file)
      if (!info.isFile() || info.size < 256) throw new Error('抽帧文件为空')
    } catch (error) {
      throw commandError(error, `成片抽帧（${timestamps[index]} 秒）`)
    }
  }))
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
  return { timestamps, frameFiles }
}

// 接触表：把成片均匀采样拼成一张 4 列网格图（帧数随时长 8–20 张，480px 宽），
// 供审片 Agent 一眼扫全片节奏与时序问题。逐帧 PNG 仍是精确证据，接触表是全局补充，
// 生成失败不阻塞审片（返回 null 即跳过）。
async function renderVideoContactSheet(videoPath, outputDir, durationSeconds, signal) {
  try {
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    const duration = Math.max(0.2, Number(durationSeconds) || 0.2)
    const count = Math.max(8, Math.min(20, Math.round(duration / 2.5) * 2))
    const cols = 4
    const rows = Math.ceil(count / cols)
    const file = join(outputDir, 'contact-sheet.png')
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-i', videoPath,
      '-vf', `fps=${count}/${duration.toFixed(3)},scale=480:-2,tile=${cols}x${rows}:padding=8:margin=8:color=0x404040`,
      '-frames:v', '1', file,
    ], { signal, maxBuffer: 1024 * 1024 * 4 })
    const info = await stat(file)
    if (!info.isFile() || info.size < 1024) throw new Error('接触表文件为空')
    return { file, count }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return null
  }
}

async function normalizedMainFrame(file, orientation, signal) {
  const crop = orientation === 'landscape' ? 'crop=iw:ih*0.80:0:0' : 'crop=iw*0.88:ih*0.70:0:0'
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${crop},scale=96:96,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { signal, encoding: 'buffer', maxBuffer: 1024 * 1024 })
    return Buffer.from(stdout)
  } catch (error) {
    throw commandError(error, '主画面变化检测')
  }
}

function frameDifference(left, right) {
  const length = Math.min(left.length, right.length)
  if (!length) return 0
  let difference = 0
  for (let index = 0; index < length; index += 1) difference += Math.abs(left[index] - right[index])
  return difference / length
}

async function measureVisualVariation(frameFiles, orientation, durationSeconds, signal) {
  const frames = await Promise.all(frameFiles.map((file) => normalizedMainFrame(file, orientation, signal)))
  const pairDifferences = frames.slice(1).map((frame, index) => Number(frameDifference(frames[index], frame).toFixed(3)))
  const hashes = new Set(frames.map((frame) => createHash('sha256').update(frame).digest('hex')))
  const meaningfulPairs = pairDifferences.filter((value) => value >= 1.5).length
  const averagePairDifference = pairDifferences.length ? pairDifferences.reduce((sum, value) => sum + value, 0) / pairDifferences.length : 0
  const assessed = Number(durationSeconds) >= 4
  const passed = !assessed || (hashes.size >= Math.min(3, frames.length) && (meaningfulPairs >= 2 || averagePairDifference >= 4))
  return {
    assessed,
    passed,
    sampledFrameCount: frames.length,
    distinctMainFrames: hashes.size,
    meaningfulPairs,
    averagePairDifference: Number(averagePairDifference.toFixed(3)),
    pairDifferences,
    crop: orientation === 'landscape' ? 'top 80%' : 'left 88%, top 70%',
    ...(assessed ? {} : { note: '成片短于 4 秒，仅记录变化数据，不启用变化阈值。' }),
  }
}

/**
 * Host-side media adapter. It owns provider calls and local binaries; the browser
 * only sees durable operation summaries and bounded media reads through the gateway.
 */
export class SpokenVideoMediaHost {
  constructor({ background = (work) => work, signal, projectsStore, credentials, connectionSettings, videoCreator, videoReviewer, lineArtPlanner, fetch = globalThis.fetch, environment = process.env } = {}) {
    if (!projectsStore) throw new Error('SpokenVideoMediaHost requires projectsStore.')
    this.background = background
    this.signal = signal
    this.projectsStore = projectsStore
    this.credentials = credentials || null
    this.connectionSettings = connectionSettings || null
    this.videoCreator = typeof videoCreator === 'function' ? videoCreator : null
    this.videoReviewer = typeof videoReviewer === 'function' ? videoReviewer : null
    this.lineArtPlanner = typeof lineArtPlanner === 'function' ? lineArtPlanner : null
    this.fetch = fetch
    this.environment = environment
    this.queues = new Map()
    this.runSecrets = new Map()
    this.activeRunIds = new Set()
    this.bailianReferenceVoices = new Map()
    this.bailianReferenceVoiceEnrollments = new Map()
    this.audioTaskWrites = new Map()
    this.runWrites = new Map()
    this.activeAudioTaskRuns = new Set()
  }

  async status() {
    const config = mediaServiceConfig(this.environment)
    const connection = await this.connection()
    const referenceVoiceConfigured = await defaultVoiceReference().then(() => true).catch(() => false)
    const remotionAvailable = await remotionRendererAvailable()
    // 把渠道实际指向哪里告诉界面：本机桥接 vs 远端云端。用户遇到
    // "Invalid API key" 时，第一眼就能看出请求打到了哪个地址。
    const scitigerLoopback = isLoopbackEndpoint(config.scitigerBaseUrl)
    return {
      ttsConfigured: true,
      ttsEndpoint: config.baseUrl ? new URL(config.baseUrl).origin : null,
      defaultVoice: { id: DEFAULT_VOICE_PROFILE.id, name: DEFAULT_VOICE_PROFILE.name },
      providers: {
        bailian: { configured: true, referenceVoiceConfigured, label: '使用自己的百炼账户', credential: connection.providers.bailian },
        scitiger: {
          configured: config.scitigerConfigured,
          referenceVoiceConfigured,
          label: scitigerLoopback ? '本机桥接' : 'SciTiger 云端',
          endpoint: config.scitigerBaseUrl,
          loopback: scitigerLoopback,
          credential: connection.providers.scitiger,
        },
        legacy: { configured: config.configured, referenceVoiceConfigured: false, label: '兼容 TTS 服务' },
      },
      connection,
      renderer: 'remotion',
      renderers: { remotion: remotionAvailable, 'local-ffmpeg': true, whiteboard: true },
      mediaReadLimitBytes: MAX_MEDIA_BYTES,
      voiceReferenceMaxBytes: MAX_VOICE_REFERENCE_BYTES,
      videoBgmMaxBytes: MAX_VIDEO_BGM_BYTES,
    }
  }

  async connection() {
    const provider = this.connectionSettings?.get?.().provider || 'bailian'
    return {
      provider,
      providers: {
        bailian: await this.#credentialStatus('bailian'),
        scitiger: await this.#credentialStatus('scitiger'),
      },
    }
  }

  /**
   * Snapshot of the bridge's voiceover settings for schedule forms: current
   * channel, configured builtin voice/style, default-voice mapping and the
   * local voice library. Safe fields only — never the MiMo API key. Fails
   * soft (available:false) so the form still works without the bridge.
   */
  async bridgeVoiceoverInfo() {
    const config = mediaServiceConfig(this.environment)
    if (!config.scitigerConfigured) return { available: false, reason: '未配置桥接（SciTiger）服务地址。' }
    try {
      const [infoBody, voicesBody] = await Promise.all([
        this.#externalJson(`${config.scitigerBaseUrl}/api/v1/tts/voiceover-info`, { signal: AbortSignal.timeout(4000) }, '桥接配音信息'),
        this.#externalJson(`${config.scitigerBaseUrl}/admin/voices`, { signal: AbortSignal.timeout(4000) }, '桥接音色库'),
      ])
      const info = this.#scitigerData(infoBody, '桥接配音信息')
      const voices = Array.isArray(voicesBody) ? voicesBody : []
      return {
        available: true,
        ttsProvider: info.tts_provider === 'local' ? 'local' : 'cloud',
        mimoVoice: typeof info.mimo_voice === 'string' && info.mimo_voice.trim() ? info.mimo_voice.trim() : null,
        mimoStyle: typeof info.mimo_style === 'string' && info.mimo_style.trim() ? info.mimo_style.trim() : null,
        mimoKeyConfigured: info.mimo_key_configured === true,
        defaultVoice: typeof info.default_voice === 'string' && info.default_voice.trim() ? info.default_voice.trim() : null,
        builtinVoices: Array.isArray(info.builtin_voices) ? info.builtin_voices.filter((voice) => typeof voice === 'string' && voice.trim()) : [],
        voices: voices
          .filter((voice) => voice && typeof voice.id === 'string' && voice.id.trim())
          .map((voice) => ({ id: voice.id.trim(), hasTxt: voice.hasTxt === true })),
      }
    } catch (error) {
      return { available: false, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 本地桥接与推理引擎的控制面板数据。
   *
   * 此前这些能力只在桥接自带的那个独立网页（127.0.0.1:8199）里：想看一眼显存
   * 占用、点一下「一键启动」、或者引擎挂了看日志，都得离开工作台跳到另一个
   * 页面——而且那个页面没有任何入口链接，只能靠人记住地址。
   *
   * 全部经桥接自己的 /admin 端点转发，不绕过它直接操作引擎：桥接才是引擎状态
   * 的唯一持有者（它记着 starting、做过空闲回收、知道端口对应哪个 PID）。这里
   * 只做「把结果搬进工作台」这一件事。
   *
   * 一律软失败：桥接不在时返回 available:false 与一句能照着做的话，绝不抛错——
   * 这个面板是可选的便利，不该让页面因为它挂掉。
   */
  async bridgeControl() {
    const base = localBridgeBase(this.environment)
    try {
      const health = await this.#externalJson(`${base}/health`, { signal: AbortSignal.timeout(4000) }, '本地媒体桥接')
      const engines = await this.#externalJson(`${base}/admin/engines`, { signal: AbortSignal.timeout(6000) }, '本地引擎状态')
      return {
        available: true,
        baseUrl: base,
        ttsProvider: typeof health.ttsProvider === 'string' ? health.ttsProvider : null,
        engines: (Array.isArray(engines.engines) ? engines.engines : []).map((engine) => ({
          kind: engine.kind,
          label: engine.label,
          port: engine.port,
          reachable: engine.reachable === true,
          starting: engine.starting === true,
          // 引擎没起来时 canLaunch=false 是有意义的：路径校验没过就别让用户点。
          canLaunch: engine.canLaunch !== false,
          lastError: engine.lastError || null,
          home: engine.home || null,
        })),
        gpu: engines.gpu ? {
          usedMiB: engines.gpu.usedMiB ?? null,
          totalMiB: engines.gpu.totalMiB ?? null,
          freeMiB: engines.gpu.freeMiB ?? null,
        } : null,
        memory: engines.memory ? {
          totalMiB: engines.memory.totalMiB ?? null,
          freeMiB: engines.memory.freeMiB ?? null,
        } : null,
      }
    } catch (error) {
      return { available: false, baseUrl: base, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 对本地引擎执行一个动作：launch / free / stop。
   *
   * launch 会被桥接转成一次「拉起 + 等待就绪」，本地模型冷启动要 30-180 秒，
   * 所以这里的超时给得比其它调用宽得多；否则按钮一点就报超时，而引擎其实
   * 正在正常启动。
   */
  async bridgeEngineAction(agent, request) {
    const input = object(request, '引擎操作')
    const kind = String(stringAt(input, ['kind']) ?? '').trim().toLowerCase()
    const action = String(stringAt(input, ['action']) ?? '').trim().toLowerCase()
    if (!['tts', 'image'].includes(kind)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '引擎类型无效。')
    if (!['launch', 'free', 'stop'].includes(action)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '引擎操作无效。')
    const base = localBridgeBase(this.environment)
    const label = `${action === 'launch' ? '启动' : action === 'free' ? '释放显存' : '停止'}${kind === 'tts' ? '字幕/配音' : '封面生图'}引擎`
    try {
      const body = await this.#externalJson(`${base}/admin/engines/${kind}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(action === 'launch' ? 200_000 : 30_000),
      }, label)
      return { ok: true, kind, action, detail: stringAt(body, ['message']) || null }
    } catch (error) {
      return { ok: false, kind, action, reason: mediaErrorMessage(error) }
    }
  }

  /** 桥接日志尾部。排查引擎问题时它比「重新启动一次」有用得多。 */
  async bridgeLogs(agent, request = {}) {
    const lines = Math.min(500, Math.max(20, Number(request?.lines) || 80))
    const base = localBridgeBase(this.environment)
    try {
      const body = await this.#externalJson(`${base}/admin/logs?lines=${lines}`, { signal: AbortSignal.timeout(6000) }, '桥接日志')
      return { available: true, lines: Array.isArray(body.lines) ? body.lines.map(String).slice(-lines) : [] }
    } catch (error) {
      return { available: false, reason: mediaErrorMessage(error) }
    }
  }

  /** 桥接近期的媒体任务。用于回答「它到底在忙什么」。 */
  async bridgeTasks() {
    const base = localBridgeBase(this.environment)
    try {
      const body = await this.#externalJson(`${base}/admin/tasks`, { signal: AbortSignal.timeout(6000) }, '桥接任务')
      return {
        available: true,
        tasks: (Array.isArray(body.tasks) ? body.tasks : []).slice(0, 30).map((task) => ({
          id: task.id, kind: task.kind, status: task.status,
          stage: task.stage || null, updated: task.updated || null,
          error_message: task.error_message || null,
        })),
      }
    } catch (error) {
      return { available: false, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 桥接配置（配音方式、本地合成参数、小米音色与语气、ASR 模型、默认音色）。
   *
   * **绝不回传 API Key。** 桥接的 /admin/config 会把整份 config.json 原样返回，
   * 其中 mimo.apiKey 是明文。这里只回「有没有配」，不回值本身——密钥经浏览器
   * 走一圈就等于泄漏到前端日志、devtools 与任何截屏里。要改就通过下面的
   * bridgeConfigUpdate 提交，桥接落盘后这里仍然只回报布尔值。
   */
  async bridgeConfig() {
    const base = localBridgeBase(this.environment)
    try {
      const body = await this.#externalJson(`${base}/admin/config`, { signal: AbortSignal.timeout(6000) }, '桥接配置')
      // 音色列表单独取：/admin/config 只回 config.json，里头没有音色名，
      // 「小米音色」和「默认音色」两个下拉就都空了（2026-10-11 实测 8199 的
      // /admin/config 确实没有 builtin_voices）。
      //  · builtinVoices 来自 /api/v1/tts/voiceover-info，与小米云端同源；
      //  · voices 来自 /admin/voices，是本机参考音频（音色库）。
      // 两个都是辅助信息，任一失败都不该让整份配置读不出来——取不到就留空数组，
      // 前端会回落到自己的兜底表。
      const [info, voices] = await Promise.all([
        this.#externalJson(`${base}/api/v1/tts/voiceover-info`, { signal: AbortSignal.timeout(4000) }, '桥接配音信息').catch(() => null),
        this.#externalJson(`${base}/admin/voices`, { signal: AbortSignal.timeout(4000) }, '桥接音色库').catch(() => null),
      ])
      return {
        available: true,
        ttsProvider: body.ttsProvider === 'local' ? 'local' : 'cloud',
        tts: body.tts && typeof body.tts === 'object' ? body.tts : {},
        asr: body.asr && typeof body.asr === 'object' ? body.asr : {},
        mimo: {
          // 只有布尔，没有值。
          apiKeyConfigured: typeof body.mimo?.apiKey === 'string' && Boolean(body.mimo.apiKey.trim()),
          voice: typeof body.mimo?.voice === 'string' ? body.mimo.voice : '',
          style: typeof body.mimo?.style === 'string' ? body.mimo.style : '',
          builtinVoices: Array.isArray(info?.builtin_voices)
            ? info.builtin_voices.filter((voice) => typeof voice === 'string' && voice.trim())
            : [],
        },
        voices: Array.isArray(voices)
          ? voices.filter((voice) => voice && typeof voice.id === 'string' && voice.id.trim()).map((voice) => ({ id: voice.id, ext: voice.ext || '', size: voice.size || 0 }))
          : [],
        defaultVoice: typeof body.defaultVoice === 'string' ? body.defaultVoice : '',
        chineseNumbers: body.chineseNumbers !== false,
      }
    } catch (error) {
      return { available: false, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 更新桥接配置。
   *
   * apiKey 传空字符串表示「不动它」——界面上那个框只在用户真的要换 Key 时才填，
   * 而每次保存都把空值提交过去会把已配好的密钥清掉。
   */
  async bridgeConfigUpdate(agent, request) {
    const input = object(request, '桥接配置')
    const base = localBridgeBase(this.environment)
    const patch = {}
    const provider = stringAt(input, ['ttsProvider'])
    if (provider === 'local' || provider === 'cloud') patch.ttsProvider = provider
    const defaultVoice = stringAt(input, ['defaultVoice'])
    if (defaultVoice !== null) patch.defaultVoice = defaultVoice
    if (typeof input.chineseNumbers === 'boolean') patch.chineseNumbers = input.chineseNumbers
    const voice = stringAt(input, ['mimo', 'voice'])
    const style = stringAt(input, ['mimo', 'style'])
    // 桥接把 style 当可选的语气指令，空串就是「用默认」，不是「清空风格」。
    const mimo = {}
    if (voice !== null) mimo.voice = voice
    if (style !== null) mimo.style = style
    const apiKey = stringAt(input, ['mimo', 'apiKey'])
    if (apiKey) mimo.apiKey = apiKey
    if (Object.keys(mimo).length) patch.mimo = mimo
    const asrModel = stringAt(input, ['asr', 'model'])
    if (asrModel) patch.asr = { model: asrModel }
    try {
      await this.#externalJson(`${base}/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10_000),
      }, '保存桥接配置')
      return this.bridgeConfig()
    } catch (error) {
      return { available: false, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 合成一小段试听音频，验证 Key、音色与语气是否真的可用。
   *
   * 这是唯一能证明「配置对了」的办法——Key 格式合法不代表它还有额度，而额度用尽
   * 时只有真正合成一次才会暴露。音频走桥接的 /audio-files/ 拿，不经工作台转发。
   */
  async bridgeVoiceTest(agent, request) {
    const input = request ? object(request, '试听请求') : {}
    const base = localBridgeBase(this.environment)
    const body = {}
    const voice = stringAt(input, ['voice'])
    const style = stringAt(input, ['style'])
    const apiKey = stringAt(input, ['apiKey'])
    if (voice) body.voice = voice
    if (style) body.style = style
    if (apiKey) body.apiKey = apiKey
    try {
      const result = await this.#externalJson(`${base}/admin/mimo-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // 真的去云端合成一段再回传，可能要几十秒。
        signal: AbortSignal.timeout(90_000),
      }, '小米语音试听')
      return {
        ok: result?.ok === true,
        bytes: result?.bytes ?? null,
        seconds: result?.seconds ?? null,
        audioUrl: result?.url ? `${base}${result.url}` : null,
        reason: result?.ok === true ? null : (result?.message || '试听失败'),
      }
    } catch (error) {
      return { ok: false, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 参考音色库。
   *
   * 音频本体由桥接提供（/voices-files/<name>），这里只列元信息。删除走桥接——
   * 它才知道一个音色对应哪几个文件（音频 + 转写文本 + 参数 json）。
   */
  async bridgeVoices() {
    const base = localBridgeBase(this.environment)
    try {
      const list = await this.#externalJson(`${base}/admin/voices`, { signal: AbortSignal.timeout(8000) }, '桥接音色库')
      return {
        available: true,
        baseUrl: base,
        voices: (Array.isArray(list) ? list : [])
          .filter((voice) => voice && typeof voice.id === 'string' && voice.id.trim())
          .map((voice) => ({
            id: voice.id.trim(),
            ext: voice.ext || '',
            size: voice.size ?? null,
            hasTxt: voice.hasTxt === true,
            hasJson: voice.hasJson === true,
            audioUrl: `${base}/voices-files/${encodeURIComponent(`${voice.id}.${voice.ext}`)}`,
          })),
      }
    } catch (error) {
      return { available: false, reason: mediaErrorMessage(error) }
    }
  }

  /**
   * 往音色库存一个参考音频。
   *
   * 2026-10-11 补。此前「参考音色库」面板只有试听和删除——上传被塞在新建配音
   * 任务的表单里（走 uploadVoiceReference，那条路传的是**这一次任务**的参考音频，
   * 不会进音色库）。于是逻辑是断的：想扩充音色库得先建一个配音任务，传进来的
   * 音色还只在那个任务里可见。音色库自己得能上传。
   *
   * 桥接侧接口就是它自带的那个配置网页在用的 POST /admin/voices（multipart），
   * 这里只是替用户点那个按钮，不新增任何桥接能力。
   *
   * @param {{ name: string, mediaType: string, data: string, id?: string }} request
   *   data 是音频的 base64（不含 data: 前缀），id 为空则用文件名当音色 id。
   */
  async bridgeVoiceUpload(agent, request) {
    const input = object(request, '参考音色上传')
    const name = String(stringAt(input, ['name']) ?? '').trim()
    const mediaType = String(stringAt(input, ['mediaType']) ?? '').trim() || 'audio/mpeg'
    const data = String(stringAt(input, ['data']) ?? '').trim()
    if (!name) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频文件名不能为空。')
    if (!data) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频内容不能为空。')
    // 音色 id 会拼进 voices/<id>.<ext>，必须挡住穿越字符。
    const id = String(stringAt(input, ['id']) ?? '').trim()
    if (id && !/^[A-Za-z0-9\u4e00-\u9fa5_-]{1,64}$/u.test(id)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音色标识只能包含中英文、数字、下划线和连字符。')
    // 扩展名由桥接校验，但这里先挡一道，能立刻给出人话而不是等它返回 400。
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aiff'].includes(ext)) {
      fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '不支持的音频格式，只接受 WAV / MP3 / M4A / FLAC / OGG / AIFF。')
    }
    let bytes
    try { bytes = Buffer.from(data, 'base64') } catch { fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频内容不是有效的 base64。') }
    if (!bytes.length) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音频内容为空。')
    // 桥接的 readBody 上限是 100 MiB，留出 multipart 开销后卡在 60 MiB。
    if (bytes.length > 60 * 1024 * 1024) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '参考音频不能超过 60 MiB。')
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mediaType }), name)
    if (id) form.append('id', id)
    const base = localBridgeBase(this.environment)
    try {
      // 直接用注入的 fetch 发 FormData，不能走 #externalJson——那个方法把响应体
      // 当 JSON 解析，而桥接上传成功返回的是 {code,id}，失败时返回 400 + 文本。
      // 这里自己判 ok，把桥接给的 message 原样带出去（它比我们的校验更能说明白）。
      const response = await this.fetch(`${base}/admin/voices`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30_000),
      })
      let result = null
      try { result = await response.json() } catch { /* 非 JSON 也算收到了 */ }
      if (!response.ok) {
        return { ok: false, reason: stringAt(result, ['message']) || `HTTP ${response.status}` }
      }
      const savedId = String(stringAt(result, ['id']) || id || name.replace(/\.[^.]+$/u, '')).trim()
      return { ok: true, id: savedId }
    } catch (error) {
      return { ok: false, reason: mediaErrorMessage(error) }
    }
  }

  async bridgeVoiceDelete(agent, request) {
    const input = object(request, '音色删除')
    const id = String(stringAt(input, ['id']) ?? '').trim()
    if (!id) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音色标识不能为空。')
    // 音色 id 会拼进删除路径，必须先挡住穿越字符——否则 ../ 能删到 voices/ 之外。
    if (!/^[A-Za-z0-9\u4e00-\u9fa5_-]{1,64}$/u.test(id)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '音色标识无效。')
    const base = localBridgeBase(this.environment)
    try {
      const result = await this.#externalJson(`${base}/admin/voices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(8000),
      }, '删除音色')
      return { ok: true, removed: result?.removed ?? 0 }
    } catch (error) {
      return { ok: false, reason: mediaErrorMessage(error) }
    }
  }

  async configureConnection(request) {
    const input = object(request, '连接设置')
    const ref = mediaCredentialRef(input.provider)
    const provider = input.provider.trim().toLowerCase()
    const apiKey = input.apiKey === undefined || input.apiKey === null || (typeof input.apiKey === 'string' && !input.apiKey.trim())
      ? null
      : text(input.apiKey, 'API Key', 512)
    if (!this.connectionSettings?.update) fail('SPOKEN_VIDEO_MEDIA_CONNECTION_UNAVAILABLE', '当前运行环境不支持保存连接设置。')
    if (apiKey) await this.#credentials().set(ref, apiKey)
    await this.connectionSettings.update({ provider })
    return this.connection()
  }

  async clearConnectionCredential(request) {
    const input = object(request, '连接设置')
    const ref = mediaCredentialRef(input.provider)
    await this.#credentials().unset(ref)
    return this.connection()
  }

  async uploadVoiceReference(agent, request) {
    const input = object(request, '参考音频上传请求')
    const format = voiceReferenceFormat(input.name, input.mediaType)
    const audio = decodeVoiceReference(input.data)
    const root = await audioTasksRootFor(agent)
    const id = requestId()
    const file = `voice-references/${id}.${format.extension}`
    const target = await safeMediaTarget(root, file, '参考音频', true)
    try {
      await writeFile(target, audio, { mode: 0o600, flag: 'wx' })
      let probe
      try { probe = await this.#probe(target) }
      catch { fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '上传的参考音频无法解码。') }
      if (!probe.hasAudio || !probe.durationSeconds || probe.videoCodec) {
        fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '上传的文件不是可播放的纯音频。')
      }
      return {
        id,
        file,
        name: format.originalName,
        mediaType: format.mediaType,
        bytes: audio.length,
        durationSeconds: probe.durationSeconds,
      }
    } catch (error) {
      await unlink(target).catch(() => {})
      throw error
    }
  }

  /**
   * Scheduled rounds voice brand-new projects, and media runs resolve
   * reference audio relative to the project root, while uploads land in the
   * shared audio-task workspace. Staging copies the preset's uploaded
   * reference into the project so startVoiceover can see it; overwrite (not
   * 'wx') keeps a retried stage idempotent.
   */
  async stageScheduleVoiceReference(agent, request) {
    const input = object(request, '任务音色参考请求')
    const id = projectId(input.projectId)
    const reference = object(input.reference, '任务音色参考音频')
    const uploaded = await this.#uploadedVoiceReference(await audioTasksRootFor(agent), reference, /^voice-references\/[a-f0-9]{32}\.(?:mp3|wav|m4a|ogg)$/u, '任务音色参考音频')
    const storedId = uploaded.file.slice('voice-references/'.length, uploaded.file.lastIndexOf('.'))
    if (uploaded.id !== storedId) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '任务音色参考音频标识与文件不匹配。')
    const projectRoot = await projectRootFor(agent, id)
    const extension = extname(uploaded.file).slice(1).toLowerCase()
    const file = `audio-media/references/${uploaded.id}.${extension}`
    const target = await safeMediaTarget(projectRoot, file, '任务音色参考音频', true)
    await writeFile(target, uploaded.audio, { mode: 0o600 })
    return { id: uploaded.id, file, name: uploaded.name, mediaType: uploaded.mediaType }
  }

  async uploadVideoBgm(agent, request) {
    const input = object(request, '背景音乐上传请求')
    const id = projectId(input.projectId)
    const format = videoBgmFormat(input.name, input.mediaType)
    const audio = decodeVideoBgm(input.data)
    const root = await projectRootFor(agent, id)
    const uploadId = requestId()
    const file = `media/bgm-uploads/${uploadId}.${format.extension}`
    const target = await safeMediaTarget(root, file, '背景音乐', true)
    try {
      await writeFile(target, audio, { mode: 0o600, flag: 'wx' })
      let probe
      try { probe = await this.#probe(target) }
      catch { fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '上传的背景音乐无法解码。') }
      if (!probe.hasAudio || !probe.durationSeconds || probe.videoCodec) {
        fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '上传的文件不是可播放的纯音频。')
      }
      return {
        id: uploadId,
        file,
        name: format.originalName,
        mediaType: format.mediaType,
        bytes: audio.length,
        durationSeconds: probe.durationSeconds,
      }
    } catch (error) {
      await unlink(target).catch(() => {})
      throw error
    }
  }

  async operations(agent, request) {
    const id = projectId(object(request, '媒体任务请求').projectId)
    const root = await projectRootFor(agent, id)
    const runs = await this.#recoverInterruptedRuns(root)
    return runs.runs.map(runSummary).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  }

  /** A compact cross-project media feed for the audio/caption workbench. */
  async listTasks(agent) {
    const projects = await this.projectsStore.list(agent)
    const taskGroups = await Promise.all(projects.map(async (project) => {
      const root = await projectRootFor(agent, project.id)
      const runs = await this.#recoverInterruptedRuns(root)
      return runs.runs.map((run) => ({ ...runSummary(run), projectTitle: project.title }))
    }))
    return taskGroups.flat()
      .filter((task) => task.type === 'voiceover' || task.type === 'subtitles')
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, 120)
  }

  /**
   * Video workbench feed. A row represents one render submission, rather than
   * the project's mutable video stage, so history, retries, and previews are
   * all attached to a durable task.
   */
  async listVideoTasks(agent, request = {}) {
    const input = object(request, '视频任务列表请求')
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    const status = typeof input.status === 'string' && ['all', 'active', 'terminal', 'queued', 'running', 'succeeded', 'failed'].includes(input.status) ? input.status : 'all'
    const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? projectId(input.accountId) : null
    const generalOnly = input.general === true
    const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0
    const limit = Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50 ? input.limit : 6
    const projects = await this.projectsStore.list(agent)
    const groups = await Promise.all(projects.map(async (project) => {
      const root = await projectRootFor(agent, project.id)
      const runs = await this.#recoverInterruptedRuns(root)
      const qualityByVideoTaskId = new Map(runs.runs
        .filter((run) => run.type === 'qc' && typeof run.input?.videoTaskId === 'string')
        .map((run) => [run.input.videoTaskId, runSummary(run)]))
      return runs.runs
        .filter((run) => run.type === 'video')
        .map((run) => {
          const integratedQc = run.result?.qc && typeof run.result.qc === 'object' ? {
            id: `${run.id}-integrated-qc`, type: 'qc', status: run.result.qc.passed === true ? 'succeeded' : 'failed',
            createdAt: run.completedAt || run.createdAt, completedAt: run.completedAt || null, result: run.result.qc,
          } : null
          return { ...runSummary(run), projectTitle: project.title, account: project.account || null, projectRevision: project.revision, qc: qualityByVideoTaskId.get(run.id) || integratedQc }
        })
    }))
    const all = groups.flat()
    const scoped = all
      .filter((task) => !accountId || task.account?.id === accountId)
      .filter((task) => !generalOnly || !task.account)
    const filtered = scoped
      .filter((task) => status === 'all' || (status === 'active' ? ['queued', 'running'].includes(task.status) : status === 'terminal' ? ['succeeded', 'failed'].includes(task.status) : task.status === status))
      .filter((task) => !query || `${task.projectTitle}\n${task.source?.script?.body || ''}\n${task.input?.visualBrief || ''}`.toLowerCase().includes(query))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      counts: {
        all: scoped.length,
        queued: scoped.filter((task) => task.status === 'queued').length,
        running: scoped.filter((task) => task.status === 'running').length,
        succeeded: scoped.filter((task) => task.status === 'succeeded').length,
        failed: scoped.filter((task) => task.status === 'failed').length,
      },
    }
  }

  /**
   * 删除已结束的媒体任务（配音/字幕与视频）及其磁盘产物。
   *
   * 为什么需要它：两个记录文件都是滚动数组——配音保留末 240 条、每个项目的视频
   * runs 保留末 80 条，写入时还会再截一次（`audioTasksFile` / `runsFile` 的
   * `.slice`）。失败的条目会被一路保留直到被新记录挤下去，用户既没法清理占空间的
   * 失败产物，也只能一条条点「重试」。
   *
   * 只允许删终态（succeeded / failed）：queued 与 running 正在写产物，删掉会让
   * 正在跑的流程落空。`this.activeRunIds` 是进程内的真实运行态，与落盘的 status
   * 可能短暂不一致（刚启动还没落盘），所以两边都要查。
   */
  async deleteTasks(agent, request) {
    const input = object(request, '删除媒体任务请求')
    const taskType = text(input.taskType, '任务类型', 16)
    if (taskType !== 'audio' && taskType !== 'video') fail('SPOKEN_VIDEO_MEDIA_TASK_TYPE_INVALID', '任务类型只能是 audio 或 video。')
    const rawIds = Array.isArray(input.ids) ? input.ids : [input.id]
    const ids = [...new Set(rawIds.map((value) => text(value, '任务标识', 64)))]
    if (!ids.length) fail('SPOKEN_VIDEO_MEDIA_TASK_ID_INVALID', '没有选中要删除的任务。')
    if (ids.length > 50) fail('SPOKEN_VIDEO_MEDIA_TASK_TOO_MANY', '单次最多删除 50 个任务。')
    return taskType === 'audio' ? this.#deleteAudioTasks(agent, ids) : this.#deleteVideoTasks(agent, ids)
  }

  async #deleteAudioTasks(agent, ids) {
    const root = await audioTasksRootFor(agent)
    const wanted = new Set(ids)
    const collected = []
    await this.#mutateAudioTaskFile(root, (file) => {
      // 运行中先拦下：正在写产物的条目删了会让流程落空，且用户通常想先看到结果。
      const running = file.tasks.filter((task) => wanted.has(task.id) && ['queued', 'running'].includes(task.status))
      if (running.length) {
        fail('SPOKEN_VIDEO_MEDIA_BUSY', `任务「${running[0].source?.title || running[0].id}」还在${running[0].status === 'queued' ? '排队' : '进行中'}，请等它结束或先停止再删除。`)
      }
      const kept = file.tasks.filter((task) => !wanted.has(task.id))
      for (const task of file.tasks) if (wanted.has(task.id)) collected.push(task)
      return { ...file, tasks: kept }
    })
    await this.#removeAudioArtifacts(root, collected)
    const removed = collected.map((task) => task.id)
    return { removed, missing: ids.filter((id) => !removed.includes(id)) }
  }

  /**
   * 清理配音任务产物：配音音频、字幕、该任务上传的参考音频。
   * 逐个文件独立删除并吞掉「本来就不存在」——产物可能已被上一轮重试或人工清理，
   * 那不该让整次删除失败。
   */
  async #removeAudioArtifacts(root, tasks) {
    for (const task of tasks) {
      const files = new Set()
      // 配音音频按 taskId 命名，格式随请求（wav/mp3/m4a/ogg）——用户可能在重试时
      // 改过格式，旧格式的残留同样要清，所以四种变体一起删，不只删记录里那一个。
      for (const extension of ['wav', 'mp3', 'm4a', 'ogg']) {
        files.add(`audio-media/voiceovers/${task.id}.${extension}`)
      }
      // 调过语速/音量时还会留一份中间源文件。
      files.add(`audio-media/voiceovers/${task.id}.source.wav`)
      // 记录里登记的产物路径优先，它才是真正写出来的那个。
      for (const value of [task.result?.audioFile, task.subtitle?.current?.file]) {
        if (typeof value !== 'string' || !value) continue
        try { files.add(this.#audioTaskRelativePath(value, '音频任务媒体')) } catch { /* 越界的路径不碰 */ }
      }
      for (const relative of files) {
        try {
          const target = await safeMediaTarget(root, relative, '音频任务媒体')
          await unlink(target).catch(() => {})
        } catch { /* 路径不合法时跳过，不影响其余文件 */ }
      }
    }
  }

  async #deleteVideoTasks(agent, ids) {
    const wanted = new Set(ids)
    const projects = await this.projectsStore.list(agent)
    const removed = []
    const missing = []
    for (const project of projects) {
      const root = await projectRootFor(agent, project.id)
      const collected = []
      await this.#mutateRunsFile(root, (file) => {
        const hits = file.runs.filter((run) => wanted.has(run.id))
        if (hits.some((run) => ['queued', 'running'].includes(run.status) || this.activeRunIds.has(run.id))) {
          fail('SPOKEN_VIDEO_MEDIA_BUSY', '选中的任务还在排队或进行中，请等它结束或先停止再删除。')
        }
        for (const run of hits) collected.push(run)
        return { ...file, runs: file.runs.filter((run) => !wanted.has(run.id)) }
      })
      await this.#removeVideoArtifacts(root, collected)
      for (const run of collected) {
        removed.push(run.id)
        // 视频任务可能挂着独立的质检任务，删掉它否则它会变成指向空任务的孤儿。
        await this.#removeQcRuns(root, run.id)
      }
    }
    for (const id of ids) if (!removed.includes(id)) missing.push(id)
    return { removed, missing }
  }

  /**
   * 删除渲染产物，成片（`media/videos/<runId>.mp4`，动辄几百 MB）才是占空间的大头，
   * 工作区（`media/video-agent/<runId>`，含 inputs/public/outputs 与 webpack 缓存）
   * 与白板中间目录一并清掉。字幕成片侧的 `media/videos/<runId>.srt` 同理。
   */
  async #removeVideoArtifacts(root, runs) {
    for (const run of runs) {
      if (run.type !== 'video') continue
      const files = [`media/videos/${run.id}.mp4`, `media/videos/${run.id}.srt`]
      for (const relative of files) {
        try {
          const target = await safeMediaTarget(root, relative, '视频任务媒体')
          await unlink(target).catch(() => {})
        } catch { /* 路径不合法时跳过 */ }
      }
      for (const relative of [`media/video-agent/${run.id}`, `media/videos/${run.id}-whiteboard`]) {
        try {
          const target = await safeMediaTarget(root, relative, '视频任务媒体')
          await rm(target, { recursive: true, force: true })
        } catch { /* 目录不存在或路径不合法时跳过 */ }
      }
    }
  }

  /** 连带删除挂在某视频任务上的独立质检记录（`input.videoTaskId` 指向它）。 */
  async #removeQcRuns(root, videoTaskId) {
    await this.#mutateRunsFile(root, (file) => {
      const kept = file.runs.filter((run) => !(run.type === 'qc' && run.input?.videoTaskId === videoTaskId))
      return kept.length === file.runs.length ? file : { ...file, runs: kept }
    })
  }

  async #mutateRunsFile(root, mutate) {
    const previous = this.runWrites.get(root) || Promise.resolve()
    const work = previous.then(async () => {
      const file = await readRuns(root)
      const next = runsFile(mutate(file))
      await writeRuns(root, next)
      return next
    })
    const tail = work.catch(() => {})
    this.runWrites.set(root, tail)
    try { return await work } finally { if (this.runWrites.get(root) === tail) this.runWrites.delete(root) }
  }

  async listAudioTasks(agent, request = {}) {
    const input = object(request, '音频任务列表请求')
    const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? projectId(input.accountId) : null
    const generalOnly = input.general === true
    const root = await audioTasksRootFor(agent)
    const tasks = await readAudioTasks(root)
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    const status = typeof input.status === 'string' && ['all', 'active', 'terminal', 'queued', 'running', 'succeeded', 'failed'].includes(input.status) ? input.status : 'all'
    const provider = typeof input.provider === 'string' && ['all', 'bailian', 'scitiger', 'legacy'].includes(input.provider) ? input.provider : 'all'
    const recovered = await this.#recoverInterruptedAudioTasks(root, tasks)
    const projects = accountId || generalOnly ? await this.projectsStore.list(agent) : []
    const accountsByProject = new Map(projects.map((project) => [project.id, project.account?.id || null]))
    const scoped = recovered.tasks.filter((task) => {
      const taskAccountId = accountsByProject.get(task.source?.projectId) || null
      return (!accountId || taskAccountId === accountId) && (!generalOnly || !taskAccountId)
    })
    const filtered = scoped
      .filter((task) => status === 'all' || (status === 'active' ? ['queued', 'running'].includes(task.status) : status === 'terminal' ? ['succeeded', 'failed'].includes(task.status) : task.status === status))
      .filter((task) => provider === 'all' || task.input?.provider === provider)
      .filter((task) => !query || `${task.source?.title || ''}\n${task.source?.text || ''}`.toLowerCase().includes(query))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0
    const limit = Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50 ? input.limit : 8
    return {
      items: filtered.slice(offset, offset + limit).map(audioTaskSummary),
      total: filtered.length,
      counts: {
        all: scoped.length,
        queued: scoped.filter((task) => task.status === 'queued').length,
        running: scoped.filter((task) => task.status === 'running').length,
        succeeded: scoped.filter((task) => task.status === 'succeeded').length,
        failed: scoped.filter((task) => task.status === 'failed').length,
      },
    }
  }

  async audioTask(agent, request) {
    const id = text(object(request, '读取音频任务请求').taskId, '音频任务标识', 64)
    const root = await audioTasksRootFor(agent)
    const task = (await this.#recoverInterruptedAudioTasks(root)).tasks.find((item) => item.id === id)
    if (!task) fail('SPOKEN_VIDEO_NOT_FOUND', '音频任务不存在。')
    return audioTaskSummary(task)
  }

  async startAudioTask(agent, request) {
    const input = object(request, '新建配音任务请求')
    const textSnapshot = text(input.text, '文本内容', 60_000)
    const sourceProjectId = typeof input.sourceProjectId === 'string' && input.sourceProjectId.trim() ? projectId(input.sourceProjectId) : null
    let source = { kind: 'manual-text', projectId: null, projectTitle: null, title: typeof input.title === 'string' && input.title.trim() ? text(input.title, '文稿标题', 160) : manualTitleFromText(textSnapshot), text: textSnapshot }
    let project = null
    if (sourceProjectId) {
      project = await this.projectsStore.get(agent, { projectId: sourceProjectId })
      const scriptBody = project.artifacts?.script?.data?.body
      if (typeof scriptBody !== 'string' || !scriptBody.trim()) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '所选项目没有可用稿件，不能载入配音。')
      source = { kind: scriptBody.trim() === textSnapshot.trim() ? 'saved-script' : 'edited-script-copy', projectId: project.id, projectTitle: project.title, title: project.title, text: textSnapshot, scriptRevision: project.artifacts.script.revision }
    }
    if (input.subtitleEnabled != null && typeof input.subtitleEnabled !== 'boolean') fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '生成字幕开关必须是布尔值。')
    let data = { ...normalizeVoiceoverRequest(input), subtitleEnabled: input.subtitleEnabled !== false }
    const root = await audioTasksRootFor(agent)
    const now = new Date().toISOString()
    const id = requestId()
    if (data.voiceSource === 'upload') {
      data = { ...data, referenceAudio: await this.#freezeVoiceReference(root, id, data.referenceAudio) }
    }
    const task = { id, type: 'voiceover', status: 'queued', createdAt: now, source, input: data, projectRevision: project?.revision || null, subtitle: { status: 'idle' } }
    // 纯手动任务的「生成后自动采纳」：提交时指定目标项目，配音+字幕都成功后由
    // 执行尾部自动采纳进该项目（复用 syncAudioTask 的语义与校验），视频页立即可见。
    const autoAdoptProjectId = !sourceProjectId && typeof input.autoAdoptProjectId === 'string' && input.autoAdoptProjectId.trim() ? input.autoAdoptProjectId.trim() : null
    if (autoAdoptProjectId) {
      // 提交时就校验项目可用（有不同稿件立即报错，不浪费一次配音）。
      const target = await this.projectsStore.get(agent, { projectId: projectId(autoAdoptProjectId) })
      if (target.artifacts?.script?.data?.body && target.artifacts.script.data.body.trim() !== textSnapshot.trim()) {
        fail('SPOKEN_VIDEO_STAGE_BLOCKED', `「${target.title}」已有不同稿件，不能自动放进（会覆盖稿件）。请改选其他项目或不放。`)
      }
      task.autoAdoptProjectId = autoAdoptProjectId
    }
    await this.#mutateAudioTaskFile(root, (file) => ({ ...file, tasks: [...file.tasks, task].slice(-AUDIO_TASK_LIMIT) }))
    this.activeAudioTaskRuns.add(`${task.id}:voiceover`)
    void this.background(this.#runAudioTask(agent, root, task.id).finally(() => this.activeAudioTaskRuns.delete(`${task.id}:voiceover`)))
    return audioTaskSummary(task)
  }

  /** Reuse completed local media; never calls a model or media provider. */
  async syncAudioTask(agent, request) {
    const input = object(request, '同步配音结果请求')
    const id = text(input.taskId, '音频任务标识', 64)
    const targetProjectId = typeof input.targetProjectId === 'string' && input.targetProjectId.trim() ? projectId(input.targetProjectId) : null
    const root = await audioTasksRootFor(agent)
    let task = (await readAudioTasks(root)).tasks.find((item) => item.id === id)
    if (!task) fail('SPOKEN_VIDEO_NOT_FOUND', '音频任务不存在。')
    if (task.status !== 'succeeded' || !task.result?.audio?.file) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先完成配音。')
    if (['queued', 'running'].includes(task.subtitle?.status)) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '字幕仍在生成，请完成后再同步。')
    // 手动任务没有项目归属：允许用户指定目标项目，把音频+字幕「采纳」为该项目
    // 的当前配音版本。项目还没有稿件时，先把任务文稿落成 topic+script（手动路径，
    // 幂等键防重试重复提交）；已有稿件但与任务文稿不同时不静默覆盖——覆盖稿件是
    // 另一个决定，请走项目内「生成配音」或新建项目。项目任务不受影响。
    if (!task.source?.projectId && targetProjectId) {
      const detail = await this.projectsStore.get(agent, { projectId: targetProjectId })
      if (detail.artifacts?.script?.data?.body && detail.artifacts.script.data.body.trim() !== task.source.text?.trim()) {
        fail('SPOKEN_VIDEO_STAGE_BLOCKED', `「${detail.title}」已有不同稿件。采纳会覆盖稿件与配音，请改用项目内「生成配音」，或新建一个项目后再同步本条音频。`)
      }
      let current = detail
      if (!detail.artifacts?.topic) {
        await this.projectsStore.commit(agent, {
          projectId: targetProjectId, expectedRevision: current.revision, stage: 'topic', idempotencyKey: `audio-task-${task.id}-topic`,
          payload: { title: task.source.title || '手动配音采纳', source: 'manual' },
        })
        current = await this.projectsStore.get(agent, { projectId: targetProjectId })
      }
      if (!current.artifacts?.script) {
        await this.projectsStore.commit(agent, {
          projectId: targetProjectId, expectedRevision: current.revision, stage: 'script', idempotencyKey: `audio-task-${task.id}-script`,
          payload: { body: task.source.text || '' },
        })
        current = await this.projectsStore.get(agent, { projectId: targetProjectId })
      }
      task = await this.#adoptAudioTaskIntoProject(agent, root, task, targetProjectId)
    }
    const synced = await this.#syncAudioTaskProject(agent, task)
    if (synced) await this.#syncAudioTaskSubtitles(agent, synced)
    return this.audioTask(agent, { taskId: id })
  }

  /** 把无项目任务「采纳」进目标项目：稿件缺失时补 topic+script（幂等），已有不同稿件则拒绝。 */
  async #adoptAudioTaskIntoProject(agent, root, task, targetProjectId) {
    const detail = await this.projectsStore.get(agent, { projectId: targetProjectId })
    if (detail.artifacts?.script?.data?.body && detail.artifacts.script.data.body.trim() !== task.source.text?.trim()) {
      fail('SPOKEN_VIDEO_STAGE_BLOCKED', `「${detail.title}」已有不同稿件。采纳会覆盖稿件与配音，请改用项目内「生成配音」，或新建一个项目后再同步本条音频。`)
    }
    let current = detail
    if (!detail.artifacts?.topic) {
      await this.projectsStore.commit(agent, {
        projectId: targetProjectId, expectedRevision: current.revision, stage: 'topic', idempotencyKey: `audio-task-${task.id}-topic`,
        payload: { title: task.source.title || '手动配音采纳', source: 'manual' },
      })
      current = await this.projectsStore.get(agent, { projectId: targetProjectId })
    }
    if (!current.artifacts?.script) {
      await this.projectsStore.commit(agent, {
        projectId: targetProjectId, expectedRevision: current.revision, stage: 'script', idempotencyKey: `audio-task-${task.id}-script`,
        payload: { body: task.source.text || '' },
      })
      current = await this.projectsStore.get(agent, { projectId: targetProjectId })
    }
    return this.#mutateAudioTask(root, task.id, (current2) => ({
      ...current2,
      source: { ...current2.source, kind: 'adopted-by-project', projectId: targetProjectId, projectTitle: current.title, scriptRevision: current.artifacts.script.revision },
    }))
  }

  async startAudioTaskSubtitles(agent, request) {
    const input = object(request, '生成字幕请求')
    const taskId = text(input.taskId, '音频任务标识', 64)
    const data = normalizeSubtitleRequest(input)
    const root = await audioTasksRootFor(agent)
    const current = (await this.#recoverInterruptedAudioTasks(root)).tasks.find((task) => task.id === taskId)
    if (!current) fail('SPOKEN_VIDEO_NOT_FOUND', '音频任务不存在。')
    if (current.status !== 'succeeded' || !current.result?.audio?.file) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请等待配音生成完成后再生成字幕。')
    if (current.subtitle?.status === 'queued' || current.subtitle?.status === 'running') return audioTaskSummary(current)
    const subtitleId = requestId()
    const started = await this.#mutateAudioTask(root, taskId, (task) => ({
      ...task,
      subtitle: { ...(task.subtitle || {}), id: subtitleId, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, completedAt: null, error: null, input: data },
    }))
    this.activeAudioTaskRuns.add(`${taskId}:subtitles`)
    void this.background(this.#runAudioTaskSubtitles(agent, root, taskId, subtitleId).finally(() => this.activeAudioTaskRuns.delete(`${taskId}:subtitles`)))
    return audioTaskSummary(started)
  }

  async saveAudioTaskSubtitles(agent, request) {
    const input = object(request, '保存字幕请求')
    const taskId = text(input.taskId, '音频任务标识', 64)
    const rawSrt = text(input.srt, '字幕内容', 30_000, { trim: false })
    const checked = subtitleResult({ subtitle_srt: rawSrt })
    const srt = checked.srt
    const root = await audioTasksRootFor(agent)
    const current = (await this.#recoverInterruptedAudioTasks(root)).tasks.find((task) => task.id === taskId)
    if (!current) fail('SPOKEN_VIDEO_NOT_FOUND', '音频任务不存在。')
    if (!current.result?.audio?.file) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '当前音频任务没有可用音频。')
    const versionId = requestId()
    const file = `audio-media/subtitles/${taskId}-${versionId}.srt`
    await this.#writeAudioTaskFile(root, file, srt)
    const updated = await this.#mutateAudioTask(root, taskId, (task) => ({
      ...task,
      subtitle: {
        ...(task.subtitle || {}), status: 'succeeded', id: versionId, completedAt: new Date().toISOString(), error: null,
        current: { id: versionId, file, srt, cueCount: checked.cueCount, mode: 'manual', createdAt: new Date().toISOString() },
      },
    }))
    await this.#syncAudioTaskSubtitles(agent, updated)
    return this.audioTask(agent, { taskId })
  }

  async readAudioTaskMedia(agent, request) {
    const input = object(request, '读取音频任务媒体请求')
    const taskId = text(input.taskId, '音频任务标识', 64)
    const root = await audioTasksRootFor(agent)
    const task = (await this.#recoverInterruptedAudioTasks(root)).tasks.find((item) => item.id === taskId)
    if (!task?.result?.audio?.file || !task.result.audio.mediaType) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '当前音频任务没有可预览媒体。')
    const file = await this.#audioTaskFile(root, task.result.audio.file, '音频任务媒体')
    const info = await stat(file)
    if (info.size > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_TOO_LARGE', '媒体文件超过浏览器预览的 80 MiB 限制。')
    return { file: task.result.audio.file, mediaType: task.result.audio.mediaType, bytes: info.size, data: (await readFile(file)).toString('base64') }
  }

  async readVideoTaskMedia(agent, request) {
    const input = object(request, '读取视频任务媒体请求')
    const id = projectId(input.projectId)
    const taskId = text(input.taskId, '视频任务标识', 64)
    const stage = text(input.stage, '视频任务媒体阶段', 20)
    if (!['voiceover', 'bgm', 'video'].includes(stage)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '只可读取任务配音、背景音乐或成片预览。')
    const root = await projectRootFor(agent, id)
    const run = (await this.#recoverInterruptedRuns(root)).runs.find((item) => item.id === taskId && item.type === 'video')
    if (!run) fail('SPOKEN_VIDEO_NOT_FOUND', '视频任务不存在。')
    const descriptor = stage === 'voiceover'
      ? run.source?.voiceover?.audio
      : stage === 'bgm'
        ? run.input?.backgroundMusic
        : run.status === 'succeeded' ? { ...(run.result?.video || {}), mediaType: 'video/mp4' } : null
    if (!descriptor?.file || !descriptor?.mediaType) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '该视频任务没有可预览的媒体。')
    const file = await this.#file(root, descriptor.file, '视频任务媒体')
    const info = await stat(file)
    if (info.size > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_TOO_LARGE', '媒体文件超过浏览器预览的 80 MiB 限制。')
    return { file: descriptor.file, mediaType: descriptor.mediaType, bytes: info.size, data: (await readFile(file)).toString('base64') }
  }

  async startVoiceover(agent, request) {
    return this.#start(agent, 'voiceover', request, (input) => normalizeVoiceoverRequest(input))
  }

  async startSubtitles(agent, request) {
    return this.#start(agent, 'subtitles', request, (input) => normalizeSubtitleRequest(input))
  }

  async startVideoRender(agent, request) {
    return this.#start(agent, 'video', request, async (input, { root }) => {
      const data = normalizeRenderRequest(input)
      if (data.backgroundMusic) await this.#videoBgm(root, data.backgroundMusic)
      return data
    })
  }

  async startTechnicalQc(agent, request) {
    return this.#start(agent, 'qc', request, (input) => ({
      videoTaskId: input.videoTaskId === undefined || input.videoTaskId === null || !String(input.videoTaskId).trim()
        ? null
        : text(input.videoTaskId, '视频任务标识', 64),
    }))
  }

  async #start(agent, type, request, parseInput) {
    const input = object(request, '媒体任务请求')
    const id = projectId(input.projectId)
    const revision = expectedRevision(input.expectedRevision)
    const root = await projectRootFor(agent, id)
    const detail = await this.projectsStore.get(agent, { projectId: id })
    if (detail.revision !== revision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已被其他操作更新，请刷新后重试。')
    const data = await parseInput(input, { root, detail })
    const runs = await readRuns(root)
    const active = runs.runs.find((run) => run.type === type && ['queued', 'running'].includes(run.status) && run.expectedRevision === revision && (type !== 'video' || (
      (run.input?.orientation === 'landscape' ? 'landscape' : 'portrait') === data.orientation
      && run.input?.renderer === data.renderer
      && (run.input?.subtitleEnabled !== false) === data.subtitleEnabled
      && (run.input?.backgroundMusic?.file || null) === (data.backgroundMusic?.file || null)
      && (run.input?.bgmVolume ?? null) === data.bgmVolume
      && run.input?.visualBrief === data.visualBrief
    )))
    if (active) return { ...runSummary(active), reused: true }
    const now = new Date().toISOString()
    const run = {
      id: requestId(), type, status: 'queued', projectId: id, expectedRevision: revision, createdAt: now, input: data,
      source: videoSourceSnapshot(detail, data.subtitleEnabled),
    }
    runs.runs = [...runs.runs, run].slice(-80)
    await writeRuns(root, runs)
    // Mark before scheduling so an immediate status poll cannot mistake this process for a restart.
    this.activeRunIds.add(run.id)
    const queueKey = `${root}\u0000${type}`
    const previous = this.queues.get(queueKey) || Promise.resolve()
    const work = this.background(previous.then(() => this.#run(agent, root, run)).catch(() => {}))
    this.queues.set(queueKey, work)
    void work.finally(() => {
      this.activeRunIds.delete(run.id)
      if (this.queues.get(queueKey) === work) this.queues.delete(queueKey)
    })
    return { ...runSummary(run), reused: false }
  }

  async #mutateAudioTaskFile(root, mutate) {
    const previous = this.audioTaskWrites.get(root) || Promise.resolve()
    const result = previous.then(async () => {
      const file = await readAudioTasks(root)
      const next = audioTasksFile(mutate(file))
      await writeAudioTasks(root, next)
      return next
    })
    const tail = result.catch(() => {})
    this.audioTaskWrites.set(root, tail)
    try { return await result } finally { if (this.audioTaskWrites.get(root) === tail) this.audioTaskWrites.delete(root) }
  }

  async #mutateAudioTask(root, taskId, mutate) {
    let changed = null
    await this.#mutateAudioTaskFile(root, (file) => {
      const index = file.tasks.findIndex((task) => task.id === taskId)
      if (index < 0) fail('SPOKEN_VIDEO_NOT_FOUND', '音频任务不存在。')
      const before = structuredClone(file.tasks[index])
      const task = mutate(file.tasks[index])
      executionTransition(before, task, '配音服务')
      changed = task
      const tasks = [...file.tasks]
      tasks[index] = task
      return { ...file, tasks }
    })
    return changed
  }

  async #recoverInterruptedAudioTasks(root, tasks = null) {
    const file = tasks || await readAudioTasks(root)
    let changed = false
    const recovered = file.tasks.map((task) => {
      let next = task
      if (['queued', 'running'].includes(task.status) && !this.activeAudioTaskRuns.has(`${task.id}:voiceover`)) {
        changed = true
        next = { ...next, status: 'failed', completedAt: new Date().toISOString(), error: '媒体主机在任务完成前已重启。请重新提交配音任务。' }
      }
      if (['queued', 'running'].includes(next.subtitle?.status) && !this.activeAudioTaskRuns.has(`${task.id}:subtitles`)) {
        changed = true
        next = { ...next, subtitle: { ...next.subtitle, status: 'failed', completedAt: new Date().toISOString(), error: '媒体主机在字幕完成前已重启。请重新生成字幕。' } }
      }
      return next
    })
    if (!changed) return file
    const next = { ...file, tasks: recovered }
    await writeAudioTasks(root, next)
    return next
  }

  async #uploadedVoiceReference(root, reference, pattern, label) {
    const input = object(reference, label)
    const file = text(input.file, `${label}文件`, 280)
    if (!pattern.test(file)) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}引用无效。`)
    const format = voiceReferenceFormat(input.name, input.mediaType)
    if (extname(file).slice(1).toLowerCase() !== format.extension) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}引用与文件类型不一致。`)
    const target = await safeMediaTarget(root, file, label)
    const info = await lstat(target).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_VOICE_REFERENCE_BYTES) {
      fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}不存在、无效或超过 20 MiB。`)
    }
    const audio = await readFile(target)
    let probe
    try { probe = await this.#probe(target) }
    catch { fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}无法解码。`) }
    if (!probe.hasAudio || !probe.durationSeconds || probe.videoCodec) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}不是可播放的纯音频。`)
    return {
      id: text(input.id, `${label}标识`, 64),
      file,
      path: target,
      name: format.originalName,
      mediaType: format.mediaType,
      audio,
    }
  }

  async #freezeVoiceReference(root, taskId, reference) {
    const uploaded = await this.#uploadedVoiceReference(root, reference, /^voice-references\/[a-f0-9]{32}\.(?:mp3|wav|m4a|ogg)$/u, '上传的参考音频')
    const storedId = uploaded.file.slice('voice-references/'.length, uploaded.file.lastIndexOf('.'))
    if (uploaded.id !== storedId) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '上传的参考音频标识与文件不匹配。')
    const extension = extname(uploaded.file).slice(1).toLowerCase()
    const file = `audio-media/references/${taskId}.${extension}`
    await this.#writeAudioTaskFile(root, file, uploaded.audio)
    return { id: uploaded.id, file, name: uploaded.name, mediaType: uploaded.mediaType }
  }

  async #voiceReference(root, input) {
    if (input.voiceSource !== 'upload') return defaultVoiceReference()
    return this.#uploadedVoiceReference(root, input.referenceAudio, /^audio-media\/references\/[a-f0-9]{32}\.(?:mp3|wav|m4a|ogg)$/u, '任务参考音频')
  }

  #audioTaskRelativePath(file, label) {
    const value = text(file, label, 280)
    if (!/^audio-media\/(?:voiceovers|subtitles|references)\/[A-Za-z0-9][A-Za-z0-9._-]{0,230}$/u.test(value)) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}无效。`)
    return value
  }

  async #audioTaskFile(root, file, label) {
    const relativePath = this.#audioTaskRelativePath(file, label)
    const target = await safeMediaTarget(root, relativePath, label)
    const info = await lstat(target).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}不存在或无效。`)
    return target
  }

  async #writeAudioTaskFile(root, relativePath, content) {
    const normalized = this.#audioTaskRelativePath(relativePath, '音频任务媒体')
    const target = await safeMediaTarget(root, normalized, '音频任务媒体', true)
    try { await writeFile(target, content, { mode: 0o600, flag: 'wx' }) }
    catch (error) { if (error?.code === 'EEXIST') fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '音频任务媒体文件已存在。'); throw error }
    return target
  }

  async #writeAudioTaskVoiceover(root, taskId, bytes, format, settings, applySettings) {
    const relativePath = `audio-media/voiceovers/${taskId}.${extensionForFormat(format)}`
    if (!applySettings || (settings.rate === 1 && settings.volume === 1)) {
      const output = await this.#writeAudioTaskFile(root, relativePath, bytes)
      return { relativePath, output, bytes: bytes.length }
    }
    const sourcePath = `audio-media/voiceovers/${taskId}.source.wav`
    const source = await this.#writeAudioTaskFile(root, sourcePath, bytes)
    const output = await safeMediaTarget(root, relativePath, '音频任务媒体', true)
    try {
      await execFileAsync('ffmpeg', ['-y', '-i', source, '-filter:a', `atempo=${settings.rate},volume=${settings.volume}`, output], { signal: this.signal, maxBuffer: 1024 * 1024 * 4 })
      await chmod(output, 0o600)
      const info = await stat(output)
      if (!info.isFile() || info.size < 1 || info.size > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '处理后的配音文件无效或超出 80 MiB 限制。')
      return { relativePath, output, bytes: info.size }
    } catch (error) {
      if (error instanceof SpokenVideoMediaError) throw error
      throw commandError(error, '配音参数处理')
    } finally { await unlink(source).catch(() => {}) }
  }

  async #runAudioTask(agent, root, taskId) {
    let task = await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, status: 'running', startedAt: new Date().toISOString(), error: null }))
    try {
      await this.#prepareRunCredentials(task)
      let generated
      let outputFormat = task.input.outputFormat || 'wav'
      if (task.input.provider === 'bailian') {
        generated = await this.#bailianVoiceover(root, task, task.source.text, task.input)
        outputFormat = 'wav'
      } else if (task.input.provider === 'scitiger') {
        generated = await this.#scitigerVoiceover(root, task, task.source.text, task.input)
      } else {
        const config = this.#legacyConfig()
        outputFormat = task.input.outputFormat || config.outputFormat
        const submitted = serviceData(await this.#json(config, '/api/v1/tts/synthesize', {
          method: 'POST', body: JSON.stringify({ text: task.source.text, provider: config.provider, output_format: outputFormat, voice_settings: { rate: task.input.rate, volume: task.input.volume, pitch: task.input.pitch }, interval_silence: 200, max_text_tokens_per_segment: 120, ...(task.input.voiceId ? { voice_id: task.input.voiceId } : {}) }),
        }), 'TTS 提交')
        const externalTaskId = taskIdFromService(submitted, 'TTS')
        const completed = await this.#poll(config, `/api/v1/tts/tasks/${encodeURIComponent(externalTaskId)}`, 'TTS')
        generated = { provider: 'legacy', taskId: externalTaskId, voiceId: task.input.voiceId || null, audio: await this.#download(`${config.baseUrl}/api/v1/tts/tasks/${encodeURIComponent(externalTaskId)}/audio`, '兼容服务配音', serviceHeaders(config)), durationSeconds: Number(completed.duration) || null }
      }
      await this.#audioEvent(root, task.id, '配音服务已返回，处理并检测音频', { provider: generated.provider, taskId: generated.taskId || null })
      const written = await this.#writeAudioTaskVoiceover(root, task.id, generated.audio, outputFormat, task.input, generated.provider === 'bailian')
      const probe = await this.#probe(written.output)
      const audio = { file: written.relativePath, mediaType: mediaTypeForFormat(outputFormat), bytes: written.bytes, durationSeconds: probe.durationSeconds || generated.durationSeconds || null, sampleRate: probe.sampleRate }
      task = await this.#mutateAudioTask(root, task.id, (current) => ({ ...current, result: { audio, provider: generated.provider, taskId: generated.taskId || null, voiceId: generated.voiceId || current.input.voiceId || null } }))
      await this.#syncAudioTaskProject(agent, task, { replace: true })
      // autoAdopt 任务把「落 succeeded」推迟到采纳之后：对用户「生成=已在项目里」
      // 是一个原子事实，轮询者不应看到「成功但未同步」的中间态。
      if (!task.autoAdoptProjectId) await this.#mutateAudioTask(root, task.id, (current) => ({ ...current, status: 'succeeded', completedAt: new Date().toISOString() }))
    } catch (error) {
      const message = mediaErrorMessage(error)
      await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, status: 'failed', completedAt: new Date().toISOString(), error: message.slice(0, 2000) }))
      return
    } finally { this.runSecrets.delete(taskId) }
    // 「生成后自动放进项目」：在状态落 succeeded 之前完成采纳——对用户这是一个
    // 原子动作（生成=进项目）。字幕提交放它后面（异步），字幕完成时的补挂会接上。
    if (task.autoAdoptProjectId && !task.source?.projectId) {
      try {
        task = await this.#adoptAudioTaskIntoProject(agent, root, task, task.autoAdoptProjectId)
        const synced = await this.#syncAudioTaskProject(agent, task, { replace: true })
        if (!synced) throw new Error((await readAudioTasks(root)).tasks.find((item) => item.id === taskId)?.projectSyncError || '原因未知')
      } catch (error) {
        // 采纳失败不吞掉配音成果：任务仍成功，错误写 projectSyncError 供手动重试。
        await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, projectSyncError: `自动放进项目失败（音频已保留）：${String(error?.message || error).slice(0, 400)}` }))
      }
      await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, status: 'succeeded', completedAt: new Date().toISOString() }))
    }
    // Audio is already durable and successful. Subtitle submission and execution
    // have their own failure boundary, so ASR cannot invalidate usable audio.
    if (task.input.subtitleEnabled) {
      try {
        await this.startAudioTaskSubtitles(agent, { taskId, provider: task.input.provider, language: 'zh', aiOptimize: true })
      } catch (error) {
        await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, subtitle: { ...current.subtitle, status: 'failed', completedAt: new Date().toISOString(), error: String(error?.message || error).slice(0, 2000) } }))
      }
    }
    // 字幕若已先完成（mock/缓存路径可能秒完），主动补挂一次；仍在跑则由完成时的补挂接手。
    if (task.source?.projectId) {
      try {
        task = await this.#mutateAudioTask(root, taskId, (current) => current)
        if (task.subtitle?.current?.srt) await this.#syncAudioTaskSubtitles(agent, task)
      } catch { /* 补挂失败已由 #syncAudioTaskSubtitles 落 subtitleSyncError */ }
    }
  }

  async #syncAudioTaskProject(agent, task, { replace = false } = {}) {
    if (!task.source?.projectId || !task.result?.audio?.file) return
    try {
      const detail = await this.projectsStore.get(agent, { projectId: task.source.projectId })
      if (detail.artifacts?.script?.data?.body?.trim() !== task.source.text?.trim() || detail.artifacts?.script?.revision !== task.source.scriptRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '配音文本与当前稿件版本不一致，音频已保留，请按当前稿件生成配音。')
      const sourceRoot = await audioTasksRootFor(agent)
      const projectRoot = await projectRootFor(agent, detail.id)
      const extension = extname(task.result.audio.file) || '.wav'
      const projectFile = `media/voiceovers/${task.id}${extension}`
      const voice = detail.artifacts?.voiceover
      if (voice?.data?.audio?.file !== projectFile && (task.projectSync || (voice && (!replace || voice.revision > task.projectRevision)))) {
        fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已使用其他配音版本，本次音频已保留，未覆盖当前版本。')
      }
      const sourceFile = await this.#audioTaskFile(sourceRoot, task.result.audio.file, '音频任务媒体')
      await this.#writeSyncedMedia(projectRoot, projectFile, await readFile(sourceFile))
      const committed = voice?.data?.audio?.file === projectFile ? { project: detail } : await this.projectsStore.commitProduced(agent, {
        projectId: detail.id, expectedRevision: detail.revision, stage: 'voiceover', idempotencyKey: `audio-task-${task.id}`, source: 'spoken-video/tts',
        payload: { mode: 'tts', provider: task.result.provider, taskId: task.result.taskId, voiceId: task.result.voiceId, voiceName: task.input.voiceName, settings: { rate: task.input.rate, volume: task.input.volume, pitch: task.input.pitch }, audio: { ...task.result.audio, file: projectFile } },
      })
      return await this.#mutateAudioTask(sourceRoot, task.id, (current) => ({ ...current, projectSyncError: null, projectSync: { projectId: detail.id, revision: committed.project.revision, voiceFile: projectFile } }))
    } catch (error) {
      await this.#mutateAudioTask(await audioTasksRootFor(agent), task.id, (current) => ({ ...current, projectSyncError: `音频已生成，同步项目失败：${String(error?.message || error).slice(0, 500)}` }))
    }
  }

  async #runAudioTaskSubtitles(agent, root, taskId, subtitleId) {
    let task = await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, subtitle: { ...(current.subtitle || {}), status: 'running', startedAt: new Date().toISOString(), error: null } }))
    try {
      await this.#prepareRunCredentials({ id: subtitleId, type: 'subtitles', input: task.subtitle.input })
      const audioPath = await this.#audioTaskFile(root, task.result.audio.file, '配音文件')
      const audio = await readFile(audioPath)
      const input = task.subtitle.input
      let result
      // 治本快路径：配音任务在桥接侧记录了句级时间轴（合成时段边界 ffprobe 实测，
      // 句在段内按字符占比），有它就直接产出精确 SRT、跳过 ASR——时间不靠猜。
      // 拿不到（旧任务 / 非桥接 provider / 原稿与时间轴句数对不上）才走 ASR+守卫。
      let viaTimeline = false
      if (input.provider === 'scitiger') {
        try {
          const timelineSrt = await segmentTimelineSrt(task, this.environment, (url, label) => this.#externalJson(url, { signal: AbortSignal.timeout(8000) }, label))
          if (timelineSrt) {
            result = { taskId: `segments-${task.id}`, subtitle: subtitleResult({ subtitle_srt: timelineSrt }), diagnostics: { provider: 'bridge-segment-timeline' } }
            viaTimeline = true
          }
        } catch { /* 快路径失败不阻塞：落回 ASR 路径 */ }
      }
      if (!viaTimeline && input.provider === 'bailian') {
        const generated = await this.#bailianSubtitles({ id: subtitleId }, audioPath, input.language, task.source.text)
        result = { taskId: generated.taskId, subtitle: subtitleResult({ subtitle_srt: generated.srt }), diagnostics: { provider: 'bailian-realtime-asr', alignment: generated.referenceAligned ? 'reference-text' : 'asr' } }
      }
      if (!viaTimeline && input.provider === 'scitiger') {
        result = await this.#scitigerSubtitles({ id: subtitleId }, audio, audioPath, task.source.text, input)
      } else if (!viaTimeline) {
        const config = this.#legacyConfig()
        const submitted = serviceData(await this.#json(config, '/api/v1/subtitles/generate', { method: 'POST', body: JSON.stringify({ audio_base64: audio.toString('base64'), audio_format: extname(audioPath).slice(1) || 'wav', language: input.language, reference_text: task.source.text, return_diagnostics: true, subtitle_options: { max_chars: 22, min_duration: 0.6, max_duration: 4, punctuation_policy: 'strip_trailing', ai_optimize: input.aiOptimize } }) }), '字幕对齐提交')
        const externalTaskId = taskIdFromService(submitted, '字幕对齐')
        const completed = await this.#poll(config, `/api/v1/subtitles/tasks/${encodeURIComponent(externalTaskId)}`, '字幕对齐')
        result = { taskId: externalTaskId, subtitle: subtitleResult(completed), diagnostics: completed.diagnostics || null }
      }
      // 与视频路径同源的对齐守卫：云端 ASR 的时间轴可能与真实音频脱节（文本全对、
      // 时间轴滞后 4-10 秒且各段不均匀，实测 2026-10-01《牡丹亭》）。守卫把 cue 与
      // 音频的实际语音分布对齐，漂移成立就改用重对齐后的 SRT。
      //
      // 这里原先没有守卫，是「配音 / 字幕」页产出的字幕唯一会绕过对齐的路径——而
      // 白板成片的场景切场与烧录字幕都从这份 SRT 推导，于是错位被原样带进成片。
      // 守卫任何异常都只记录，绝不阻塞字幕产出。
      let alignmentGuard
      try {
        const guarded = await guardSubtitleTimeline({ audioPath, srt: result.subtitle.srt, language: input.language, signal: this.signal })
        alignmentGuard = guarded.guard
        if (guarded.applied) result.subtitle = { ...result.subtitle, srt: guarded.srt, cueCount: guarded.guard?.cueCount ?? result.subtitle.cueCount }
      } catch (error) {
        alignmentGuard = { applied: false, method: 'none', reason: `对齐守卫异常：${error?.message || error}` }
      }
      result.diagnostics = { ...(result.diagnostics || {}), alignmentGuard }
      await this.#audioEvent(root, task.id, '识别完成，校验并保存时间轴', { taskId: result.taskId, cueCount: result.subtitle.cueCount, diagnostics: result.diagnostics })
      const file = `audio-media/subtitles/${task.id}-${subtitleId}.srt`
      await this.#writeAudioTaskFile(root, file, result.subtitle.srt)
      task = await this.#mutateAudioTask(root, task.id, (current) => ({ ...current, subtitle: { ...(current.subtitle || {}), error: null, current: { id: subtitleId, file, srt: result.subtitle.srt, cueCount: result.subtitle.cueCount, mode: 'asr', taskId: result.taskId, diagnostics: result.diagnostics || null, createdAt: new Date().toISOString() } } }))
      await this.#syncAudioTaskSubtitles(agent, task)
      await this.#mutateAudioTask(root, task.id, (current) => ({ ...current, subtitle: { ...current.subtitle, status: 'succeeded', completedAt: new Date().toISOString() } }))
    } catch (error) {
      const message = mediaErrorMessage(error)
      await this.#mutateAudioTask(root, taskId, (current) => ({ ...current, subtitle: { ...(current.subtitle || {}), status: 'failed', completedAt: new Date().toISOString(), error: message.slice(0, 2000) } }))
    } finally { this.runSecrets.delete(subtitleId) }
  }

  async #syncAudioTaskSubtitles(agent, task) {
    if (!task.subtitle?.current?.srt || !task.source?.projectId) return
    // 自动采纳与字幕完成是两条并行的后台链：字幕先完成时 projectSync 可能还没写入，
    // 主动补挂与完成补挂也可能相撞（revision 冲突）。短退避重试吞掉这类时序差，
    // 真正的冲突（稿件/配音被换掉）重试也不会好，照常落 subtitleSyncError。
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#syncAudioTaskSubtitlesOnce(agent, task)
        return
      } catch (error) {
        if (attempt >= 4) {
          await this.#mutateAudioTask(await audioTasksRootFor(agent), task.id, (current) => ({ ...current, subtitleSyncError: `字幕已保存，同步项目失败：${String(error?.message || error).slice(0, 500)}` }))
          return
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 400 * attempt))
      }
    }
  }

  async #syncAudioTaskSubtitlesOnce(agent, task) {
    if (!task.subtitle?.current?.srt || !task.source?.projectId) return
    try {
      if (!task.projectSync) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '配音尚未同步到项目，请先同步配音结果。')
      const detail = await this.projectsStore.get(agent, { projectId: task.source.projectId })
      if (detail.artifacts?.voiceover?.data?.audio?.file !== task.projectSync.voiceFile || detail.artifacts?.script?.revision !== task.source.scriptRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目配音或稿件已更新，字幕已保留，未覆盖当前版本。')
      const projectRoot = await projectRootFor(agent, detail.id)
      const projectFile = `media/subtitles/${task.id}-${task.subtitle.current.id}.srt`
      if (detail.artifacts?.subtitles?.data?.srtFile !== projectFile) {
        await this.#writeSyncedMedia(projectRoot, projectFile, task.subtitle.current.srt)
        await this.projectsStore.commitProduced(agent, {
        projectId: detail.id, expectedRevision: detail.revision, stage: 'subtitles', idempotencyKey: `audio-subtitle-${task.subtitle.current.id}`, source: 'spoken-video/asr',
        payload: { mode: task.subtitle.current.mode, taskId: task.subtitle.current.taskId || null, sourceAudioFile: task.projectSync.voiceFile, srtFile: projectFile, srt: task.subtitle.current.srt, cueCount: task.subtitle.current.cueCount },
        })
      }
      await this.#mutateAudioTask(await audioTasksRootFor(agent), task.id, (current) => ({ ...current, subtitleSyncError: null }))
    } catch (error) {
      throw error
    }
  }

  async #mutateRun(root, runId, mutator) {
    const previous = this.runWrites.get(root) || Promise.resolve()
    const work = previous.then(async () => {
      const file = await readRuns(root)
      const index = file.runs.findIndex((run) => run.id === runId)
      if (index < 0) throw new Error('媒体任务记录丢失。')
      const before = structuredClone(file.runs[index])
      const next = mutator(file.runs[index])
      executionTransition(before, next, next.type === 'voiceover' ? '配音服务' : next.type === 'subtitles' ? '字幕服务' : '本地制作')
      file.runs[index] = next
      await writeRuns(root, file)
      return next
    })
    const tail = work.catch(() => {})
    this.runWrites.set(root, tail)
    try { return await work } finally { if (this.runWrites.get(root) === tail) this.runWrites.delete(root) }
  }

  async #audioEvent(root, id, label, detail = null) {
    return this.#mutateAudioTask(root, id, (task) => { executionEvent(task, label, { actor: '媒体处理', detail }); return task })
  }
  async #runEvent(root, id, label, detail = null) {
    return this.#mutateRun(root, id, (run) => { executionEvent(run, label, { actor: '媒体处理', detail }); return run })
  }

  async #recoverInterruptedRuns(root) {
    const runs = await readRuns(root)
    let changed = false
    const nowMs = Date.now()
    const recovered = runs.runs.map((run) => {
      const queueKey = `${root}\u0000${run.type}`
      const submittedAtMs = Date.parse(run.startedAt || run.createdAt || '')
      // A run is durably written before its Promise chain enters the queue. Give that
      // handoff a short window so an immediate status poll cannot look like a restart.
      const stillEnteringQueue = Number.isFinite(submittedAtMs) && nowMs - submittedAtMs < RUN_RECOVERY_GRACE_MS
      if (['queued', 'running'].includes(run.status) && !stillEnteringQueue && !this.queues.has(queueKey) && !this.activeRunIds.has(run.id)) {
        changed = true
        return {
          ...run,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: '媒体主机在任务完成前已重启。请在当前项目版本上重新提交任务。',
        }
      }
      return run
    })
    if (!changed) return runs
    const next = { ...runs, runs: recovered }
    await writeRuns(root, next)
    return next
  }

  async #run(agent, root, queued) {
    const run = await this.#mutateRun(root, queued.id, (current) => ({ ...current, status: 'running', startedAt: new Date().toISOString() }))
    try {
      await this.#prepareRunCredentials(run)
      let result
      if (run.type === 'voiceover') result = await this.#generateVoiceover(agent, root, run)
      else if (run.type === 'subtitles') result = await this.#generateSubtitles(agent, root, run)
      else if (run.type === 'video') result = await this.#renderVideo(agent, root, run)
      else result = await this.#technicalQc(agent, root, run)
      await this.#mutateRun(root, run.id, (current) => ({ ...current, status: 'succeeded', completedAt: new Date().toISOString(), result }))
    } catch (error) {
      const message = mediaErrorMessage(error)
      await this.#mutateRun(root, run.id, (current) => {
        const completedAt = new Date().toISOString()
        const pipeline = current.type === 'video' && current.pipeline && typeof current.pipeline === 'object'
          ? { ...current.pipeline, phase: 'failed', completedAt, error: message.slice(0, 2000), stages: { ...(current.pipeline.stages || {}), ...(current.phase ? { [current.phase]: { ...(current.pipeline.stages?.[current.phase] || {}), status: 'failed', completedAt, error: message.slice(0, 1000) } } : {}) } }
          : current.pipeline
        return { ...current, status: 'failed', phase: current.type === 'video' ? 'failed' : current.phase, completedAt, error: message.slice(0, 2000), ...(pipeline ? { pipeline } : {}) }
      })
    } finally {
      this.runSecrets.delete(run.id)
    }
  }

  #legacyConfig() {
    const config = mediaServiceConfig(this.environment)
    if (!config.configured) fail('SPOKEN_VIDEO_MEDIA_NOT_CONFIGURED', '未配置兼容 TTS/ASR 服务。设置 LWB_SPOKEN_VIDEO_TTS_BASE_URL 后重试，或选择百炼 BYOK / SciTiger 云端。')
    return config
  }

  #apiKey(run, provider) {
    const apiKey = this.runSecrets.get(run.id)?.apiKey
    if (!apiKey) fail('SPOKEN_VIDEO_MEDIA_CREDENTIAL_REQUIRED', `${provider}尚未保存 API Key。请在连接设置中保存后重试。`)
    return apiKey
  }

  #credentials() {
    if (!this.credentials || typeof this.credentials.resolve !== 'function') {
      fail('SPOKEN_VIDEO_MEDIA_CONNECTION_UNAVAILABLE', '当前运行环境不提供私有凭据服务。')
    }
    return this.credentials
  }

  async #credentialStatus(provider) {
    const ref = mediaCredentialRef(provider)
    const credentials = this.#credentials()
    if (typeof credentials.describe !== 'function') {
      fail('SPOKEN_VIDEO_MEDIA_CONNECTION_UNAVAILABLE', '当前运行环境不支持读取连接状态。')
    }
    const status = await credentials.describe(ref)
    return { configured: status.configured === true, source: status.source || null, writable: status.writable === true }
  }

  async #prepareRunCredentials(run) {
    if (!['voiceover', 'subtitles'].includes(run.type)) return
    const provider = run.input?.provider
    if (provider === 'legacy') return
    const ref = mediaCredentialRef(provider)
    const resolved = await this.#credentials().resolve(ref)
    if (!resolved?.value) {
      const label = provider === 'bailian' ? '百炼 BYOK' : 'SciTiger 云端'
      fail('SPOKEN_VIDEO_MEDIA_CREDENTIAL_REQUIRED', `${label}尚未保存 API Key。请在连接设置中保存后重试。`)
    }
    this.runSecrets.set(run.id, { apiKey: resolved.value })
  }

  async #externalJson(url, init, label) {
    let response
    try {
      response = await this.fetch(url, init)
    } catch (error) {
      throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_UNREACHABLE', `${label}不可访问：${error instanceof Error ? error.message : String(error)}`)
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}返回了无效 JSON。`)
    }
    if (!response.ok) {
      const detail = stringAt(body, ['message'], ['error', 'message']) || `HTTP ${response.status}`
      throw providerFailure(label, detail, url, this.environment)
    }
    return body
  }

  async #downloadData(url, label, headers = {}) {
    let response
    try {
      response = await this.fetch(boundedHttpUrl(url, label), { method: 'GET', headers })
    } catch (error) {
      throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_UNREACHABLE', `${label}下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}下载失败（HTTP ${response.status}）。`)
    const contentLengthHeader = response.headers.get('content-length')
    const declaredBytes = contentLengthHeader && /^\d+$/u.test(contentLengthHeader) ? Number(contentLengthHeader) : null
    if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > MAX_MEDIA_BYTES)) {
      fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}声明的文件大小无效或超出 80 MiB 限制。`)
    }
    let bytes
    try {
      bytes = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}下载内容不完整：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}为空或超出 80 MiB 限制。`)
    if (declaredBytes !== null && declaredBytes !== bytes.length) {
      fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}下载长度不完整（声明 ${declaredBytes} 字节，实际 ${bytes.length} 字节）。`)
    }
    return { bytes, declaredBytes, contentType: response.headers.get('content-type') || null }
  }

  async #download(url, label, headers = {}) {
    return (await this.#downloadData(url, label, headers)).bytes
  }

  /**
   * Download a provider-produced asset with bounded retries. Only transient
   * conditions are retried: a missing asset (404/408/429/5xx) or a transport
   * error. A definitive client-side rejection (400/401/403) fails immediately,
   * because retrying a credential or request problem only wastes time.
   */
  async #downloadWithRetry(url, label, headers = {}, attempts = SCITIGER_DOWNLOAD_ATTEMPTS) {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#download(url, label, headers)
      } catch (error) {
        lastError = error
        if (!isTransientDownloadError(error) || attempt === attempts) break
        await delay(SCITIGER_DOWNLOAD_BACKOFF_MS * attempt)
      }
    }
    const reason = mediaErrorMessage(lastError)
    throw new SpokenVideoMediaError(
      lastError?.code || 'SPOKEN_VIDEO_MEDIA_SERVICE_FAILED',
      `${reason}（已重试 ${attempts} 次）`,
    )
  }

  async #normalizeBailianWav(source, output, label) {
    try {
      await execFileAsync('ffmpeg', ['-v', 'error', '-xerror', '-y', '-i', source, '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output], { signal: this.signal, maxBuffer: 1024 * 1024 * 4 })
      await chmod(output, 0o600)
      const audio = await readFile(output)
      const containerError = wavContainerError(audio)
      if (containerError) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}标准化后 WAV 校验失败：${containerError}。`)
      const probe = await this.#probe(output)
      if (!probe.hasAudio || !probe.durationSeconds) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}标准化后 WAV 不含可播放的音频流。`)
      return { bytes: audio.length, probe }
    } catch (error) {
      if (error instanceof SpokenVideoMediaError) throw error
      throw commandError(error, `${label}音频标准化`)
    }
  }

  async #downloadBailianWav(url, source, output, details) {
    const label = `百炼 TTS 第 ${details.index}/${details.total} 段配音`
    let lastError = null
    for (let attempt = 1; attempt <= BAILIAN_WAV_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const downloaded = await this.#downloadData(url, label)
        const containerError = wavContainerError(downloaded.bytes, { allowUnboundedSize: true })
        if (containerError) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label} WAV 校验失败：${containerError}。`)
        const sourceAudio = repairUnboundedWavHeader(downloaded.bytes)
        const repairedError = wavContainerError(sourceAudio)
        if (repairedError) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label} WAV 长度修复后校验失败：${repairedError}。`)
        await writeFile(source, sourceAudio, { mode: 0o600 })
        const probe = await this.#probe(source)
        if (!probe.hasAudio || !probe.durationSeconds) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label} WAV 不含可播放的音频流。`)
        return this.#normalizeBailianWav(source, output, label)
      } catch (error) {
        lastError = error
        await unlink(source).catch(() => {})
        await unlink(output).catch(() => {})
        if (attempt < BAILIAN_WAV_DOWNLOAD_ATTEMPTS) await delay(250 * attempt)
      }
    }
    if (lastError?.code === 'SPOKEN_VIDEO_MEDIA_SERVICE_UNREACHABLE') throw lastError
    const reason = lastError instanceof Error ? lastError.message : String(lastError)
    throw new SpokenVideoMediaError(
      'SPOKEN_VIDEO_MEDIA_FILE_INVALID',
      `${label}下载或校验失败（已重试 ${BAILIAN_WAV_DOWNLOAD_ATTEMPTS} 次${details.requestId ? `，请求 ${details.requestId}` : ''}）：${reason}`,
    )
  }

  async #bailianTtsSegment(config, apiKey, model, voice, segment, details, source, output) {
    let lastError = null
    for (let attempt = 1; attempt <= BAILIAN_TTS_SEGMENT_ATTEMPTS; attempt += 1) {
      const body = await this.#externalJson(`${config.bailianBaseUrl}/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: { text: segment, voice, language_type: 'Chinese' } }),
        signal: AbortSignal.timeout(MAX_POLL_MS),
      }, `百炼 TTS 第 ${details.index}/${details.total} 段`)
      const audioUrl = stringAt(body, ['output', 'audio', 'url'])
      if (!audioUrl) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `百炼 TTS 第 ${details.index}/${details.total} 段没有返回完整音频地址。`)
      const requestId = stringAt(body, ['request_id'])
      try {
        const downloaded = await this.#downloadBailianWav(audioUrl, source, output, { ...details, requestId })
        return { ...downloaded, requestId }
      } catch (error) {
        if (error?.code && error.code !== 'SPOKEN_VIDEO_MEDIA_FILE_INVALID') throw error
        lastError = error
        if (attempt < BAILIAN_TTS_SEGMENT_ATTEMPTS) await delay(500 * attempt)
      }
    }
    if (lastError?.code && lastError.code !== 'SPOKEN_VIDEO_MEDIA_FILE_INVALID') throw lastError
    const reason = lastError instanceof Error ? lastError.message : String(lastError)
    throw new SpokenVideoMediaError(
      'SPOKEN_VIDEO_MEDIA_FILE_INVALID',
      `百炼 TTS 第 ${details.index}/${details.total} 段在重新合成后仍无有效 WAV：${reason}`,
    )
  }

  async #concatBailianWavSegments(directory, chunks) {
    if (chunks.length === 1) return readFile(chunks[0].file)
    const manifest = join(directory, 'concat.txt')
    const output = join(directory, 'merged.wav')
    await writeFile(manifest, `${chunks.map((chunk) => ffmpegConcatEntry(chunk.file)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      await execFileAsync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-map', '0:a:0', '-c:a', 'pcm_s16le', output], { signal: this.signal, maxBuffer: 1024 * 1024 * 4 })
      await chmod(output, 0o600)
      const audio = await readFile(output)
      if (!audio.length || audio.length > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '百炼 TTS 合并后的 WAV 为空或超出 80 MiB 限制。')
      const containerError = wavContainerError(audio)
      if (containerError) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `百炼 TTS 合并后的 WAV 校验失败：${containerError}。`)
      const probe = await this.#probe(output)
      if (!probe.hasAudio || !probe.durationSeconds) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '百炼 TTS 合并后的 WAV 不含可播放的音频流。')
      return audio
    } catch (error) {
      if (error instanceof SpokenVideoMediaError) throw error
      throw commandError(error, '百炼 TTS 分段音频合并')
    }
  }

  async #bailianVoiceover(root, run, script, input) {
    const config = mediaServiceConfig(this.environment)
    const apiKey = this.#apiKey(run, '百炼 BYOK')
    const usesReference = ['system', 'reference', 'upload'].includes(input.voiceSource)
    const reference = usesReference ? await this.#voiceReference(root, input) : null
    const voice = reference
      ? await this.#bailianReferenceVoice(config, apiKey, reference)
      : input.voiceSource === 'preset' && input.voiceId
        ? input.voiceId
        : config.bailianDefaultVoice
    const model = reference ? config.bailianVoiceCloneModel : config.bailianModel
    const segments = splitTtsText(script)
    const directory = await mkdtemp(join(tmpdir(), 'lwb-spoken-video-bailian-'))
    const chunks = []
    const taskIds = []
    try {
      for (const [offset, segment] of segments.entries()) {
        const index = offset + 1
        const file = join(directory, `segment-${String(index).padStart(3, '0')}.wav`)
        const source = join(directory, `segment-${String(index).padStart(3, '0')}.source.wav`)
        const chunk = await this.#bailianTtsSegment(config, apiKey, model, voice, segment, { index, total: segments.length }, source, file)
        chunks.push({ ...chunk, file })
        if (chunk.requestId) taskIds.push(chunk.requestId)
      }
      return { provider: 'bailian', taskId: taskIds.at(-1) || null, voiceId: voice, audio: await this.#concatBailianWavSegments(directory, chunks) }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  #storedBailianReferenceVoices() {
    const values = this.connectionSettings?.get?.().bailianReferenceVoices
    if (!values || typeof values !== 'object' || Array.isArray(values)) return {}
    return Object.fromEntries(Object.entries(values).filter(([key, voice]) => /^[a-f0-9]{64}$/u.test(key) && typeof voice === 'string' && voice.trim()))
  }

  async #storeBailianReferenceVoice(cacheKey, voice) {
    if (!this.connectionSettings?.update) return
    const entries = Object.entries(this.#storedBailianReferenceVoices()).filter(([key]) => key !== cacheKey)
    const referenceVoices = Object.fromEntries([...entries.slice(-15), [cacheKey, voice]])
    await this.connectionSettings.update({ bailianReferenceVoices: referenceVoices })
  }

  async #bailianReferenceVoice(config, apiKey, reference) {
    const cacheKey = createHash('sha256')
      .update(`${config.bailianBaseUrl}\u0000${apiKey}\u0000${config.bailianVoiceCloneModel}\u0000${reference.id}\u0000`)
      .update(reference.audio)
      .digest('hex')
    const cached = this.bailianReferenceVoices.get(cacheKey)
    if (cached) return cached
    const saved = this.#storedBailianReferenceVoices()[cacheKey]
    if (saved) {
      this.bailianReferenceVoices.set(cacheKey, saved)
      return saved
    }
    const inFlight = this.bailianReferenceVoiceEnrollments.get(cacheKey)
    if (inFlight) return inFlight
    const enrollment = this.#enrollBailianReferenceVoice(cacheKey, config, apiKey, reference)
    this.bailianReferenceVoiceEnrollments.set(cacheKey, enrollment)
    try {
      return await enrollment
    } finally {
      this.bailianReferenceVoiceEnrollments.delete(cacheKey)
    }
  }

  async #enrollBailianReferenceVoice(cacheKey, config, apiKey, reference) {
    const body = await this.#externalJson(`${config.bailianBaseUrl}/services/audio/tts/customization`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.bailianVoiceEnrollmentModel,
        input: {
          action: 'create',
          target_model: config.bailianVoiceCloneModel,
          preferred_name: `${reference.id === DEFAULT_VOICE_PROFILE.id ? 'lwb_tiffy' : 'lwb_voice'}_${cacheKey.slice(0, 6)}`,
          audio: { data: `data:${reference.mediaType};base64,${reference.audio.toString('base64')}` },
          language: 'zh',
        },
      }),
      signal: AbortSignal.timeout(MAX_POLL_MS),
    }, '百炼参考音色复刻')
    const voice = stringAt(body, ['output', 'voice'])
    if (!voice) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', '百炼参考音色复刻没有返回有效结果。')
    this.bailianReferenceVoices.set(cacheKey, voice)
    await this.#storeBailianReferenceVoice(cacheKey, voice)
    return voice
  }

  #scitigerHeaders(run, json = true) {
    return {
      Authorization: `Bearer ${this.#apiKey(run, 'SciTiger 云端')}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  #scitigerData(body, label, endpoint = null) {
    if (body?.success === true && body.data && typeof body.data === 'object') return body.data
    if (body?.code === 200 && body.data && typeof body.data === 'object') return body.data
    const detail = stringAt(body, ['message'], ['error', 'message']) || `${label}没有返回有效数据。`
    throw providerFailure(label, detail, endpoint, this.environment)
  }

  /** SciTiger replies share one error shape; resolve the endpoint so auth failures can be explained. */
  #scitigerResponse(body, label) {
    return this.#scitigerData(body, label, mediaServiceConfig(this.environment).scitigerBaseUrl)
  }

  async #scitigerJson(run, path, init, label) {
    const config = mediaServiceConfig(this.environment)
    if (!config.scitigerConfigured) fail('SPOKEN_VIDEO_MEDIA_NOT_CONFIGURED', '未配置 SciTiger 云端地址。')
    const { json = true, headers = {}, ...request } = init
    return this.#externalJson(`${config.scitigerBaseUrl}${path}`, { ...request, headers: { ...this.#scitigerHeaders(run, json), ...headers } }, label)
  }

  async #scitigerPoll(run, path, label, onProgress = null) {
    const started = Date.now()
    let lastProgressKey = ''
    while (Date.now() - started < MAX_POLL_MS) {
      const data = this.#scitigerResponse(await this.#scitigerJson(run, path, { method: 'GET' }, `${label}状态查询`), `${label}状态查询`)
      const state = String(data.status || data.job_status || '').trim().toLowerCase()
      if (['completed', 'succeeded', 'success'].includes(state)) return data
      if (['failed', 'cancelled', 'canceled'].includes(state)) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}任务${state}：${stringAt(data, ['error_message'], ['error', 'message']) || '没有返回原因'}`)
      if (!['queued', 'pending', 'processing', 'running', 'in_progress'].includes(state)) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}返回了未知任务状态。`)
      // 桥接会随轮询返回 stage/progress（如「分段合成 2/5 · 36%」）与 queue_ahead
      // （入队快照）；仅在变化时回调，长文案分段合成要好几分钟，不透传进度会被当成卡死。
      if (onProgress) {
        const stage = typeof data.stage === 'string' && data.stage.trim() ? data.stage.trim() : null
        const rawProgress = Number(data.progress)
        const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, Math.round(rawProgress))) : null
        const rawAhead = Number(data.queue_ahead)
        const queueAhead = Number.isFinite(rawAhead) ? Math.max(0, Math.round(rawAhead)) : null
        const key = `${stage ?? ''}@${progress ?? ''}@${queueAhead ?? ''}`
        if (key !== lastProgressKey) {
          lastProgressKey = key
          await Promise.resolve(onProgress({ stage, progress, queueAhead })).catch(() => {})
        }
      }
      await delay(POLL_INTERVAL_MS)
    }
    fail('SPOKEN_VIDEO_MEDIA_SERVICE_TIMEOUT', `${label}任务在 ${MAX_POLL_MS / 60_000} 分钟内未完成。`)
  }

  async #scitigerVoiceover(root, run, script, input) {
    const reference = ['system', 'reference', 'upload'].includes(input.voiceSource) ? await this.#voiceReference(root, input) : null
    const submitted = this.#scitigerResponse(await this.#scitigerJson(run, '/api/v1/tts/jobs', {
      method: 'POST',
      body: JSON.stringify({
        text: script,
        // 上传标签是给桥接日志看的，用参考音频的名字会让失败信息变成
        // 「Tiffy - 自信失败：…」，把渠道/凭证问题误报成音色问题。
        ...(reference ? { reference_audio_asset_id: await this.#scitigerUploadAudio(run, reference.audio, reference.path, 'SciTiger 参考音频上传') } : { voice_source: input.voiceSource, ...(input.voiceId ? { voice_id: input.voiceId } : {}) }),
        output_format: input.outputFormat || 'wav',
        voice_settings: { rate: input.rate, volume: input.volume, pitch: input.pitch },
        ...(input.bridge?.channel ? { tts_provider: input.bridge.channel } : {}),
        ...(input.bridge?.style ? { style: input.bridge.style } : {}),
      }),
    }, 'SciTiger TTS 提交'), 'SciTiger TTS 提交')
    const taskId = stringAt(submitted, ['job_id'], ['task_id'], ['id'])
    if (!taskId) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', 'SciTiger TTS 没有返回任务标识。')
    const completed = await this.#scitigerPoll(run, `/api/v1/tts/jobs/${encodeURIComponent(taskId)}`, 'SciTiger TTS', async ({ stage, progress, queueAhead }) => {
      const queued = !stage && Number.isFinite(queueAhead) && queueAhead > 0
      const stageText = queued ? `排队中（前面还有 ${queueAhead} 个任务）` : (stage || '处理中')
      const label = queued ? stageText : `配音进行中：${stageText}${progress == null ? '' : ` · ${progress}%`}`
      await this.#mutateAudioTask(root, run.id, (task) => {
        // 卡片要一眼看到「分段合成 3/5 · 54%」，执行记录要留下完整轨迹，一次落盘。
        task.progressInfo = { stage: stageText, progress: queued || progress == null ? null : progress, updatedAt: new Date().toISOString() }
        executionEvent(task, label, { actor: '媒体处理' })
        return task
      })
    })
    const audioUrl = stringAt(completed, ['result', 'audio_url'], ['audio_url'], ['result', 'url'], ['url'])
    if (!audioUrl) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', 'SciTiger TTS 没有返回完整音频地址。')
    return { provider: 'scitiger', taskId, voiceId: input.voiceId || null, voiceName: reference?.name || input.voiceName || null, audio: await this.#downloadWithRetry(audioUrl, 'SciTiger 配音', this.#scitigerHeaders(run, false)) }
  }

  async #bailianSubtitles(run, audioPath, language, referenceText) {
    this.signal?.throwIfAborted()
    const config = mediaServiceConfig(this.environment)
    const apiKey = this.#apiKey(run, '百炼 BYOK')
    const endpoint = new URL(config.bailianAsrWebSocketUrl)
    endpoint.searchParams.set('model', config.bailianAsrModel)
    const taskId = `asr_${randomUUID()}`
    const sentences = []
    const speech = new Map()
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'spoken-video-media-host/1.0' },
      handshakeTimeout: 30_000,
      perMessageDeflate: false,
    })
    let readyResolve
    let readyReject
    let finishedResolve
    let finishedReject
    let socketFailureReject
    let completed = false
    let socketError = null
    const ready = new Promise((resolvePromise, reject) => { readyResolve = resolvePromise; readyReject = reject })
    const finished = new Promise((resolvePromise, reject) => { finishedResolve = resolvePromise; finishedReject = reject })
    const socketFailed = new Promise((_, reject) => { socketFailureReject = reject })
    // Attach observers immediately so an early handshake or API error cannot become an unhandled rejection.
    void ready.catch(() => {})
    void finished.catch(() => {})
    void socketFailed.catch(() => {})
    const failSocket = (error) => {
      if (socketError) return socketError
      const failure = error instanceof SpokenVideoMediaError
        ? error
        : new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `百炼实时 ASR 失败：${error instanceof Error ? error.message : String(error)}`)
      socketError = failure
      readyReject(failure)
      finishedReject(failure)
      socketFailureReject(failure)
      return failure
    }
    socket.once('error', failSocket)
    const closedEarly = (code, reason) => {
      if (completed) return
      const detail = Buffer.isBuffer(reason) ? reason.toString('utf8').trim() : String(reason || '').trim()
      failSocket(new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `百炼实时 ASR 连接提前关闭（${code}${detail ? `：${detail}` : ''}）。`))
    }
    socket.once('close', closedEarly)
    const abortSocket = () => { failSocket(this.signal.reason); socket.terminate() }
    this.signal?.addEventListener('abort', abortSocket, { once: true })
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return
      let event
      try { event = JSON.parse(String(raw)) } catch { return }
      if (event?.type === 'error') {
        failSocket(new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `百炼实时 ASR 失败：${event?.error?.message || event?.error?.code || '未知原因'}`))
      } else if (event?.type === 'session.updated') {
        readyResolve()
      } else if (event?.type === 'input_audio_buffer.speech_started' && typeof event.item_id === 'string') {
        speech.set(event.item_id, { begin: Number(event.audio_start_ms), end: null })
      } else if (event?.type === 'input_audio_buffer.speech_stopped' && typeof event.item_id === 'string') {
        const entry = speech.get(event.item_id) || { begin: null, end: null }
        entry.end = Number(event.audio_end_ms)
        speech.set(event.item_id, entry)
      } else if (event?.type === 'conversation.item.input_audio_transcription.completed') {
        const entry = speech.get(event.item_id)
        if (entry && typeof event.transcript === 'string' && event.transcript.trim() && Number.isFinite(entry.begin) && Number.isFinite(entry.end)) {
          sentences.push({ begin: entry.begin, end: entry.end, text: event.transcript })
        }
      } else if (event?.type === 'conversation.item.input_audio_transcription.failed') {
        failSocket(new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `百炼实时 ASR 识别失败：${event?.error?.message || event?.error?.code || '未知原因'}`))
      } else if (event?.type === 'session.finished') {
        completed = true
        finishedResolve()
      }
    })
    try {
      await new Promise((resolvePromise, reject) => {
        socket.once('open', resolvePromise)
        socket.once('error', reject)
      })
      await Promise.race([
        sendSocket(socket, JSON.stringify({
          type: 'session.update',
          event_id: randomUUID(),
          session: {
            input_audio_format: 'pcm',
            sample_rate: BAILIAN_ASR_SAMPLE_RATE,
            input_audio_transcription: { language },
            turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 400 },
          },
        })),
        socketFailed,
      ])
      await awaitWithin(ready, 30_000, 'SPOKEN_VIDEO_MEDIA_SERVICE_TIMEOUT', '百炼实时 ASR 没有在 30 秒内启动。')
      const conversion = spawn('ffmpeg', ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', String(BAILIAN_ASR_SAMPLE_RATE), '-f', 's16le', 'pipe:1'], { signal: this.signal, stdio: ['ignore', 'pipe', 'pipe'] })
      const conversionDone = waitForChild(conversion, '百炼 ASR 音频转换')
      void conversionDone.catch(() => {})
      try {
        await sendRealtimePcm(socket, conversion.stdout, socketFailed)
        await conversionDone
      } finally {
        if (conversion.exitCode === null && conversion.signalCode === null) conversion.kill()
        await conversionDone.catch(() => {})
      }
      await Promise.race([sendSocket(socket, JSON.stringify({ type: 'session.finish', event_id: randomUUID() })), socketFailed])
      await awaitWithin(finished, MAX_POLL_MS, 'SPOKEN_VIDEO_MEDIA_SERVICE_TIMEOUT', '百炼实时 ASR 在限定时间内未完成。')
      return { taskId, srt: srtFromSentences(alignSentencesToReference(sentences, referenceText)), referenceAligned: Boolean(String(referenceText || '').trim()) }
    } finally {
      this.signal?.removeEventListener('abort', abortSocket)
      await closeSocket(socket)
      socket.removeListener('error', failSocket)
      socket.removeListener('close', closedEarly)
    }
  }

  async #scitigerUploadAudio(run, audio, audioPath, label = 'SciTiger 音频上传') {
    const extension = extname(audioPath).slice(1).toLowerCase() || 'wav'
    const form = new FormData()
    form.append('file', new Blob([audio], { type: mediaTypeForFormat(extension) }), `audio.${extension}`)
    const body = await this.#scitigerJson(run, '/api/v1/media/audio-uploads', { method: 'POST', body: form, json: false }, label)
    const data = this.#scitigerResponse(body, label)
    const assetId = stringAt(data, ['asset_id'], ['assetId'])
    if (!assetId) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}没有返回资产标识。`)
    return assetId
  }

  async #scitigerSubtitles(run, audio, audioPath, script, input) {
    const assetId = await this.#scitigerUploadAudio(run, audio, audioPath)
    const submitted = this.#scitigerResponse(await this.#scitigerJson(run, '/api/v1/subtitle/jobs', {
      method: 'POST',
      body: JSON.stringify({
        audio_asset_id: assetId,
        audio_format: extname(audioPath).slice(1) || 'wav',
        language: input.language,
        reference_text: script,
        subtitle_options: { max_chars: 22, min_duration: 0.6, max_duration: 4, punctuation_policy: 'strip_trailing', ai_optimize: input.aiOptimize },
      }),
    }, 'SciTiger 字幕提交'), 'SciTiger 字幕提交')
    const taskId = stringAt(submitted, ['job_id'], ['task_id'], ['id'])
    if (!taskId) fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', 'SciTiger 字幕没有返回任务标识。')
    const completed = await this.#scitigerPoll(run, `/api/v1/subtitle/jobs/${encodeURIComponent(taskId)}`, 'SciTiger 字幕')
    return { taskId, subtitle: subtitleResult(completed), assetId }
  }

  async #json(config, path, init) {
    let response
    try {
      response = await this.fetch(`${config.baseUrl}${path}`, { ...init, headers: { ...serviceHeaders(config), ...(init?.headers || {}) } })
    } catch (error) {
      throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_UNREACHABLE', `无法连接媒体服务：${error instanceof Error ? error.message : String(error)}`)
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', '媒体服务返回了无效 JSON。')
    }
    if (!response.ok) throw new SpokenVideoMediaError('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `媒体服务请求失败（HTTP ${response.status}）。`)
    return body
  }

  async #poll(config, path, label) {
    const started = Date.now()
    while (Date.now() - started < MAX_POLL_MS) {
      const data = serviceData(await this.#json(config, path, { method: 'GET' }), `${label}状态查询`)
      const state = taskState(data, label)
      if (state === 'completed') return data
      if (['failed', 'cancelled'].includes(state)) {
        const reason = typeof data.error_message === 'string' ? `：${data.error_message}` : ''
        fail('SPOKEN_VIDEO_MEDIA_SERVICE_FAILED', `${label}任务${state}${reason}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
    fail('SPOKEN_VIDEO_MEDIA_SERVICE_TIMEOUT', `${label}任务在 ${MAX_POLL_MS / 60_000} 分钟内未完成。`)
  }

  async #videoBgm(root, descriptor) {
    const input = object(descriptor, '背景音乐')
    const file = text(input.file, '背景音乐文件', 280)
    if (!/^media\/bgm-uploads\/[a-f0-9]{32}\.(?:mp3|wav|m4a|ogg)$/u.test(file)) {
      fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐引用无效。')
    }
    const storedId = file.slice('media/bgm-uploads/'.length, file.lastIndexOf('.'))
    if (text(input.id, '背景音乐标识', 64) !== storedId) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐标识与文件不匹配。')
    const format = videoBgmFormat(input.name, input.mediaType)
    if (extname(file).slice(1).toLowerCase() !== format.extension) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐引用与文件类型不一致。')
    const target = await this.#file(root, file, '背景音乐')
    const info = await lstat(target)
    if (info.size < 1 || info.size > MAX_VIDEO_BGM_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐为空或超过 20 MiB。')
    let probe
    try { probe = await this.#probe(target) }
    catch { fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐无法解码。') }
    if (!probe.hasAudio || !probe.durationSeconds || probe.videoCodec) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '背景音乐不是可播放的纯音频。')
    return target
  }

  async #file(root, file, label) {
    const normalized = mediaPath(file, label)
    const target = await safeMediaTarget(root, normalized, label)
    const info = await lstat(target).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', `${label}不存在或无效。`)
    return target
  }

  async #writeAt(root, relativePath, content, label) {
    const target = await safeMediaTarget(root, relativePath, label, true)
    try {
      await writeFile(target, content, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '媒体文件已存在。')
      throw error
    }
    return target
  }

  async #write(root, relativePath, content) {
    return this.#writeAt(root, mediaPath(relativePath, '媒体文件'), content, '媒体文件')
  }

  async #writeSyncedMedia(root, relativePath, content) {
    const target = await safeMediaTarget(root, mediaPath(relativePath, '同步媒体文件'), '同步媒体文件', true)
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    try { await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }) }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || !(await readFile(target)).equals(bytes)) {
        fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '已有媒体文件与任务产物不一致，未覆盖原文件。')
      }
    }
    return target
  }

  async #writeVoiceoverAudio(root, runId, bytes, outputFormat, settings, applySettings) {
    const relativePath = `media/voiceovers/${runId}.${extensionForFormat(outputFormat)}`
    if (!applySettings || (settings.rate === 1 && settings.volume === 1)) {
      return { relativePath, output: await this.#write(root, relativePath, bytes), bytes: bytes.length }
    }
    const sourcePath = `media/voiceovers/${runId}.source.wav`
    const source = await this.#write(root, sourcePath, bytes)
    const output = await safeMediaTarget(root, relativePath, '配音文件', true)
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', source, '-filter:a', `atempo=${settings.rate},volume=${settings.volume}`,
        output,
      ], { signal: this.signal, maxBuffer: 1024 * 1024 * 4 })
      await chmod(output, 0o600)
      const info = await stat(output)
      if (!info.isFile() || info.size < 1 || info.size > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '处理后的配音文件无效或超出 80 MiB 限制。')
      return { relativePath, output, bytes: info.size }
    } catch (error) {
      if (error instanceof SpokenVideoMediaError) throw error
      throw commandError(error, '配音参数处理')
    } finally {
      await unlink(source).catch(() => {})
    }
  }

  async #probe(path) {
    try {
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,sample_rate,nb_frames:stream_disposition=attached_pic', '-of', 'json', path], { signal: this.signal, maxBuffer: 1024 * 1024 })
      return normalizeProbe(JSON.parse(stdout))
    } catch (error) {
      throw commandError(error, 'ffprobe')
    }
  }

  async #generateVoiceover(agent, root, run) {
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    const script = detail.artifacts?.script?.data?.body
    if (detail.revision !== run.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '稿件已更新，已取消旧版本的配音任务。')
    if (typeof script !== 'string' || !script.trim()) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '当前项目没有可用稿件，不能生成配音。')
    const input = run.input
    let generated
    let outputFormat = input.outputFormat || 'wav'
    if (input.provider === 'bailian') {
      generated = await this.#bailianVoiceover(root, run, script, input)
      outputFormat = 'wav'
    } else if (input.provider === 'scitiger') {
      generated = await this.#scitigerVoiceover(root, run, script, input)
    } else {
      const config = this.#legacyConfig()
      outputFormat = input.outputFormat || config.outputFormat
      const payload = {
        text: script,
        provider: config.provider,
        output_format: outputFormat,
        voice_settings: { rate: input.rate, volume: input.volume, pitch: input.pitch },
        interval_silence: 200,
        max_text_tokens_per_segment: 120,
        ...(input.voiceId ? { voice_id: input.voiceId } : {}),
      }
      const submitted = serviceData(await this.#json(config, '/api/v1/tts/synthesize', { method: 'POST', body: JSON.stringify(payload) }), 'TTS 提交')
      const taskId = taskIdFromService(submitted, 'TTS')
      const completed = await this.#poll(config, `/api/v1/tts/tasks/${encodeURIComponent(taskId)}`, 'TTS')
      generated = {
        provider: 'legacy', taskId, voiceId: input.voiceId || null,
        audio: await this.#download(`${config.baseUrl}/api/v1/tts/tasks/${encodeURIComponent(taskId)}/audio`, '兼容服务配音', serviceHeaders(config)),
        durationSeconds: Number(completed.duration) || null,
      }
    }
    await this.#runEvent(root, run.id, '配音服务已返回，处理并检测音频', { provider: generated.provider, taskId: generated.taskId })
    const written = await this.#writeVoiceoverAudio(root, run.id, generated.audio, outputFormat, input, generated.provider === 'bailian')
    const { relativePath, output } = written
    const probe = await this.#probe(output)
    await this.#mutateRun(root, run.id, (current) => ({ ...current, result: { audio: { file: relativePath, mediaType: mediaTypeForFormat(outputFormat), bytes: written.bytes, durationSeconds: probe.durationSeconds, sampleRate: probe.sampleRate }, taskId: generated.taskId } }))
    const committed = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId,
      expectedRevision: run.expectedRevision,
      stage: 'voiceover',
      idempotencyKey: `media-${run.id}`,
      source: 'spoken-video/tts',
      payload: {
        mode: 'tts', provider: generated.provider, taskId: generated.taskId, voiceId: generated.voiceId || input.voiceId, voiceName: input.voiceName,
        settings: { rate: input.rate, volume: input.volume, pitch: input.pitch },
        audio: { file: relativePath, mediaType: mediaTypeForFormat(outputFormat), bytes: written.bytes, durationSeconds: probe.durationSeconds || generated.durationSeconds || null, sampleRate: probe.sampleRate },
      },
    })
    return { project: committed.project, artifact: committed.artifact, audio: { file: relativePath, durationSeconds: probe.durationSeconds, bytes: written.bytes, sampleRate: probe.sampleRate }, taskId: generated.taskId }
  }

  async #generateSubtitles(agent, root, run) {
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    if (detail.revision !== run.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '上游已更新，已取消旧版本的字幕任务。')
    const script = detail.artifacts?.script?.data?.body
    const voiceover = detail.artifacts?.voiceover?.data
    if (typeof script !== 'string' || !voiceover?.audio?.file) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '缺少已完成配音，不能生成字幕。')
    const audioPath = await this.#file(root, voiceover.audio.file, '配音文件')
    const audio = await readFile(audioPath)
    if (!audio.length || audio.length > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '配音文件为空或超出字幕服务上传限制。')
    let result
    // 治本快路径（2026-10-11）：配音任务在桥接侧记录了句级时间轴（合成时段边界
    // ffprobe 实测 + 段内句按字符占比），有它就直接产出精确 SRT、跳过 ASR——
    // 此前远程 ASR 的时间戳滞后真实语音 4~6s（用户报「声音和字幕对不上」），
    // 守卫的锚点修正只能在锚点间插值，句间仍有 1~3s 残差。拿不到时间轴
    // （旧配音 / 非桥接 provider / 原稿句数与时间轴对不上）才走 ASR+守卫。
    let viaTimeline = false
    if (run.input.provider === 'scitiger') {
      try {
        const timelineSrt = await segmentTimelineSrt({ input: run.input, source: { text: script }, result: { taskId: detail.artifacts?.voiceover?.data?.taskId } }, this.environment, (url, label) => this.#externalJson(url, { signal: AbortSignal.timeout(8000) }, label), { audioPath })
        if (timelineSrt) {
          result = { taskId: `segments-${run.id}`, subtitle: subtitleResult({ subtitle_srt: timelineSrt }), diagnostics: { provider: 'bridge-segment-timeline' } }
          viaTimeline = true
        }
      } catch { /* 快路径失败不阻塞：落回 ASR 路径 */ }
    }
    if (!viaTimeline && run.input.provider === 'bailian') {
      const generated = await this.#bailianSubtitles(run, audioPath, run.input.language, script)
      result = { taskId: generated.taskId, subtitle: subtitleResult({ subtitle_srt: generated.srt }), diagnostics: { provider: 'bailian-realtime-asr', alignment: generated.referenceAligned ? 'reference-text' : 'asr' } }
    } else if (!viaTimeline && run.input.provider === 'scitiger') {
      result = await this.#scitigerSubtitles(run, audio, audioPath, script, run.input)
    } else if (!viaTimeline) {
      const config = this.#legacyConfig()
      const submitted = serviceData(await this.#json(config, '/api/v1/subtitles/generate', {
        method: 'POST',
        body: JSON.stringify({
          audio_base64: audio.toString('base64'),
          audio_format: extname(audioPath).slice(1) || 'wav',
          language: run.input.language,
          reference_text: script,
          return_diagnostics: true,
          subtitle_options: { max_chars: 22, min_duration: 0.6, max_duration: 4, punctuation_policy: 'strip_trailing', ai_optimize: run.input.aiOptimize },
        }),
      }), '字幕对齐提交')
      const taskId = taskIdFromService(submitted, '字幕对齐')
      const completed = await this.#poll(config, `/api/v1/subtitles/tasks/${encodeURIComponent(taskId)}`, '字幕对齐')
      result = { taskId, subtitle: subtitleResult(completed), diagnostics: completed.diagnostics || null }
    }
    const { taskId, subtitle } = result
    // 云端 ASR 的时间轴可能与真实音频脱节（实测滞后 4-6 秒且各段不均匀，文本却全对）。
    // 守卫把 cue 与音频语音分布对齐：漂移成立就改用重对齐后的 SRT；守卫自身异常只记录，不阻塞字幕产出。
    //
    // 但**快路径产物必须跳过守卫修正**（2026-10-11 实测教训）：段时序 SRT 的句起点
    // 就是真实语音起点（VAD 吸附，逐句验证 onset 误差 0.00s）。守卫的占比估计假设
    // 连续语流，与句级精确 SRT 在句间停顿处必然分歧（mean >2s）→ 判「漂移」→ 用
    // 占比估计把精确字幕**改回错误的时间轴**——守卫把地面真值修掉了。快路径的
    // VAD 精化本身就是验证，不需要再被一个估计模型"修正"。
    let alignmentGuard
    if (viaTimeline) {
      alignmentGuard = { applied: false, method: 'none', verdict: 'ground-truth', reason: '句级时间轴来自合成段边界（地面真值），跳过占比修正。' }
    } else {
      try {
        const guarded = await guardSubtitleTimeline({ audioPath, srt: subtitle.srt, language: run.input.language, signal: this.signal })
        alignmentGuard = guarded.guard
        if (guarded.applied) subtitle.srt = guarded.srt
      } catch (error) {
        alignmentGuard = { applied: false, method: 'none', reason: `对齐守卫异常：${error?.message || error}` }
      }
    }
    result.diagnostics = { ...(result.diagnostics || {}), alignmentGuard }
    const relativePath = `media/subtitles/${run.id}.srt`
    await this.#write(root, relativePath, subtitle.srt)
    await this.#mutateRun(root, run.id, (current) => { executionEvent(current, '识别完成，时间轴字幕已保存', { actor: '字幕服务', detail: { taskId, cueCount: subtitle.cueCount } }); return { ...current, result: { taskId, srt: subtitle.srt, srtFile: relativePath, cueCount: subtitle.cueCount, diagnostics: result.diagnostics || null } } })
    const committed = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId,
      expectedRevision: run.expectedRevision,
      stage: 'subtitles',
      idempotencyKey: `media-${run.id}`,
      source: 'spoken-video/asr',
      payload: {
        mode: 'asr', taskId, sourceAudioFile: voiceover.audio.file, srt: subtitle.srt, srtFile: relativePath,
        cueCount: subtitle.cueCount, diagnostics: result.diagnostics || null,
      },
    })
    return { project: committed.project, artifact: committed.artifact, cueCount: subtitle.cueCount, taskId }
  }

  async #renderVideo(agent, root, run) {
    if (run.input.renderer === 'local-ffmpeg') return this.#renderLegacyVideo(agent, root, run)
    if (run.input.renderer === 'whiteboard') return this.#renderWhiteboardVideo(agent, root, run)
    return this.#renderAiDirectorVideo(agent, root, run)
  }

  async #setVideoPhase(root, runId, phase, details = {}) {
    return this.#mutateRun(root, runId, (current) => {
      const now = new Date().toISOString()
      const previousPhase = current.phase
      const previousPipeline = current.pipeline && typeof current.pipeline === 'object' ? current.pipeline : {}
      const stages = { ...(previousPipeline.stages || {}) }
      if (previousPhase && previousPhase !== phase && stages[previousPhase]?.status === 'running') {
        stages[previousPhase] = { ...stages[previousPhase], status: 'succeeded', completedAt: now }
      }
      if (phase !== 'completed') stages[phase] = { ...(stages[phase] || {}), status: 'running', startedAt: stages[phase]?.startedAt || now }
      return {
        ...current,
        phase,
        pipeline: {
          schemaVersion: 1,
          engine: 'dsh-remotion-ai-director',
          startedAt: previousPipeline.startedAt || now,
          ...previousPipeline,
          ...details,
          phase,
          stages,
          ...(phase === 'completed' ? { completedAt: now } : {}),
        },
      }
    })
  }

  /**
   * 记录真实渲染进度。与 #setVideoPhase 分开，因为进度可能每几秒更新一次，
   * 而阶段切换是低频事件；这里只写 pipeline.render 一个字段，避免误动阶段状态。
   */
  async #setVideoRenderProgress(root, runId, parsed) {
    return this.#mutateRun(root, runId, (current) => {
      if (current.phase !== 'rendering' && current.status !== 'running') return current
      const previous = current.pipeline && typeof current.pipeline === 'object' ? current.pipeline : {}
      const render = previous.render && typeof previous.render === 'object' ? previous.render : {}
      // 只在进度前进时写入，避免乱序输出把百分比推回去。
      if (Number.isFinite(render.percent) && Number.isFinite(parsed.percent) && parsed.percent < render.percent && parsed.stage === render.stage) return current
      return {
        ...current,
        pipeline: {
          ...previous,
          render: { ...parsed, updatedAt: new Date().toISOString() },
        },
      }
    })
  }

  async #renderLegacyVideo(agent, root, run) {
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    if (detail.revision !== run.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '上游已更新，已取消旧版本的视频渲染任务。')
    const voiceover = detail.artifacts?.voiceover?.data
    const subtitles = detail.artifacts?.subtitles?.data || null
    const subtitleEnabled = run.input.subtitleEnabled !== false
    const orientation = run.input.orientation === 'landscape' ? 'landscape' : 'portrait'
    if (!voiceover?.audio?.file || (subtitleEnabled && typeof subtitles?.srt !== 'string')) fail('SPOKEN_VIDEO_STAGE_BLOCKED', subtitleEnabled ? '必须先完成配音与字幕，才能渲染视频。' : '必须先完成配音，才能渲染视频。')
    const audioPath = await this.#file(root, voiceover.audio.file, '配音文件')
    const videoFile = `media/videos/${run.id}.mp4`
    const videoPath = resolve(root, videoFile)
    await mkdir(dirname(videoPath), { recursive: true, mode: 0o700 })
    const audioProbe = await this.#probe(audioPath)
    await this.#renderLocalFfmpeg(root, run, audioPath, subtitles, subtitleEnabled, videoPath)
    const info = await stat(videoPath)
    if (!info.isFile() || info.size < 1024) fail('SPOKEN_VIDEO_MEDIA_COMMAND_FAILED', '视频渲染没有生成有效文件。')
    const probe = await this.#probe(videoPath)
    const committed = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId,
      expectedRevision: run.expectedRevision,
      stage: 'video',
      idempotencyKey: `media-${run.id}`,
      source: 'spoken-video/local-ffmpeg',
      payload: {
        mode: 'local-ffmpeg', renderer: 'local-ffmpeg', orientation, visualBrief: run.input.visualBrief, subtitleEnabled, sourceAudioFile: voiceover.audio.file, sourceSubtitleFile: subtitleEnabled ? subtitles.srtFile || null : null,
        video: { file: videoFile, mediaType: 'video/mp4', bytes: info.size, durationSeconds: probe.durationSeconds, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio },
      },
    })
    // 与白板路径同理：本地渲染没有独立审片阶段，技术质检必须内联提交，
    // 否则成片不会出现在发布页。
    const qc = await this.#commitInlineTechnicalQc(agent, run, committed, { audioPath, subtitles, subtitleEnabled, orientation })
    return { project: qc.project, artifact: committed.artifact, video: { file: videoFile, ...probe, bytes: info.size }, qc: { passed: true, artifact: qc.artifact, technical: qc.technical } }
  }

  // ── 白板手绘渲染器：确定性管线，复用白板能力包自带的本地引擎 ──
  //
  // 字幕时间轴是白板动画「第几秒画哪个元素」的唯一依据（startMs 查表），所以与
  // Remotion 路径同理：即使不烧录字幕，也必须有字幕产物，否则直接拒绝。
  // 线稿约定：项目 media/whiteboard/ 下每幕一张 scene-*.png（16:9，暖米黄纸底）。
  // 同名 .annotation.json 可省略——缺省时按字幕 cue 自动生成标注骨架（startMs 精确
  // 对齐字幕，区域为等分占位；精调可在白板包预览台完成或手工放置标注文件）。
  //
  // 成片必须补配音音轨：白板引擎只输出无声视频流，音频在这里用 ffmpeg 合成，
  // 同时把画面规格化到 QC 要求的 1920x1080 / 1080x1920、30fps。

  // ── 白板线稿生成：按字幕分幕出线稿，落到 media/whiteboard/ 供渲染消费 ──
  //
  // 设计取舍：生成是「可失败的资产准备」，不塞进渲染 run——一张废图不值得
  // 重跑 7 分钟渲染。前端拿到 plan 后批量/单张触发生成，缩略图人工确认后再
  // 提交视频任务（对应白板 skill 的「线稿确认关卡」）。
  // 文件命名 scene-NN-story.png：与渲染分支的幕号匹配约定一致。

  #lineArtJobs = new Map()

  /**
   * 线稿分镜师（DSH 结构化执行器）：把每幕旁白转成「画什么」的英文视觉描述。
   * 旁白原文绝不能直接喂给生图模型——Qwen-Image 会把长中文旁白整段手写到
   * 画面上（2026-10-01 实测）。缺执行器时明确报错，而不是退化到翻车路径。
   */
  #requireLineArtPlanner() {
    if (typeof this.lineArtPlanner !== 'function') {
      throw fail('SPOKEN_VIDEO_WHITEBOARD_PLANNER_UNAVAILABLE', '线稿分镜师未配置（需要 DSH 模型支持），无法把旁白转成画面描述。请检查模型配置后重试。')
    }
    return this.lineArtPlanner
  }

  /**
   * 线稿缩略图（320px JPEG base64）。plan 一次带回全部缩略图，浏览器不用拉
   * 几 MB 的原图。压好的缩略图缓存在 media/whiteboard/.thumbs/，按源图 mtime
   * 判断是否需要重压。
   */
  async #lineArtThumb(engineRoot, python, lineArtDir, fileName) {
    const source = join(lineArtDir, fileName)
    const thumbDir = join(lineArtDir, '.thumbs')
    const target = join(thumbDir, `${fileName.replace(/\.[^.]+$/u, '')}.thumb.jpg`)
    try {
      const [sourceInfo, targetInfo] = await Promise.all([stat(source), stat(target).catch(() => null)])
      if (targetInfo && targetInfo.mtimeMs >= sourceInfo.mtimeMs) {
        const cached = await readFile(target)
        return `data:image/jpeg;base64,${cached.toString('base64')}`
      }
    } catch { /* 缓存不可用则重压 */ }
    await mkdir(join(lineArtDir, '.thumbs'), { recursive: true, mode: 0o700 })
    const script = "import sys; from PIL import Image; im = Image.open(sys.argv[1]); im.thumbnail((320, 320)); im.convert('RGB').save(sys.argv[2], 'JPEG', quality=70)"
    await execFilePromise(python, ['-c', script, source, target], { timeout: 30_000 })
    const thumb = await readFile(target)
    return `data:image/jpeg;base64,${thumb.toString('base64')}`
  }

  /** 视觉描述缓存文件路径与版本键。 */
  async #lineArtDescriptionCache(agent, root, projectId) {
    const detail = await this.projectsStore.get(agent, { projectId })
    const key = `${detail.artifacts?.script?.revision || 0}-${detail.artifacts?.subtitles?.revision || 0}`
    return { file: resolve(root, 'media', 'whiteboard', 'descriptions.json'), key }
  }

  /**
   * 旁白 → 视觉描述。缓存命中直接用；稿件或字幕更新后自动重算。
   * 返回 Map<幕号, 英文视觉描述>。
   */
  async #ensureLineArtDescriptions(agent, root, projectId, scenes) {
    const planner = this.#requireLineArtPlanner()
    const { file, key } = await this.#lineArtDescriptionCache(agent, root, projectId)
    let cached = null
    try {
      cached = JSON.parse(await readFile(file, 'utf8'))
    } catch { /* 无缓存或损坏，重新生成 */ }
    if (cached?.key === key && Array.isArray(cached?.scenes)) {
      return normalizeLineArtPlan(cached, scenes)
        .reduce((map, item) => map.set(item.index, item.visual), new Map())
    }

    const raw = await planner({
      prompt: buildLineArtPlanPrompt(scenes),
      schema: LINE_ART_PLAN_SCHEMA,
      agent,
    })
    const normalized = normalizeLineArtPlan(raw, scenes)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify({ key, generatedAt: new Date().toISOString(), scenes: normalized }, null, 2)}\n`, { mode: 0o600 })
    return normalized.reduce((map, item) => map.set(item.index, item.visual), new Map())
  }

  #sceneImageName(index) {
    return `scene-${String(index).padStart(2, '0')}-story.png`
  }

  /** 幕号 → 线稿文件名。接受 scene-NN.png 与 scene-NN-*.png 两种手工命名。 */
  async #matchSceneImages(lineArtDir, sceneCount) {
    let names = []
    try { names = await readdir(lineArtDir) } catch { names = [] }
    const images = []
    const missing = []
    for (let index = 1; index <= sceneCount; index++) {
      const nn = String(index).padStart(2, '0')
      const exact = names.find((name) => new RegExp(`^scene-${nn}\\.(png|jpe?g)$`, 'iu').test(name))
      const prefixed = names.find((name) => new RegExp(`^scene-${nn}-[^/]*\\.(png|jpe?g)$`, 'iu').test(name))
      const found = exact || prefixed
      if (found) images.push(found)
      else missing.push(index)
    }
    if (missing.length) {
      throw new Error(`media/whiteboard/ 缺少第 ${missing.join('、')} 幕的线稿（scene-${String(missing[0]).padStart(2, '0')}*.png，16:9 暖米黄纸底，画面不要出现文字）。`)
    }
    return images
  }

  /** 分幕规划 + 现有线稿清单 + 生图引擎状态。确定性只读，给前端画面板。 */
  async whiteboardLineArtPlan(agent, request) {
    const { root, subtitles } = await this.#whiteboardSubtitleContext(agent, request)
    const engineRoot = this.#whiteboardEngineRoot()
    const python = await this.#whiteboardPython(engineRoot)
    // 分幕只读字幕内容，写到系统临时目录，用完即删，不进项目媒体目录
    const planSrt = join(tmpdir(), `lwb-wb-plan-${randomUUID()}.srt`)
    await writeFile(planSrt, subtitles.srt, { mode: 0o600 })
    let parsed
    try {
      parsed = await this.#runWhiteboardScript(engineRoot, python, 'parse_srt.py', [planSrt])
    } finally {
      await unlink(planSrt).catch(() => {})
    }
    let scenes = null
    try { scenes = JSON.parse(parsed.stdout).scenes }
    catch { throw fail('SPOKEN_VIDEO_WHITEBOARD_FAILED', '字幕分幕输出无法解析。') }
    if (!Array.isArray(scenes) || scenes.length === 0) throw fail('SPOKEN_VIDEO_WHITEBOARD_FAILED', '字幕没有解析出任何分幕。')

    const lineArtDir = resolve(root, 'media/whiteboard')
    let names = []
    try { names = await readdir(lineArtDir) } catch { names = [] }
    const items = []
    for (const scene of scenes) {
      const index = scene.sceneIndex
      const nn = String(index).padStart(2, '0')
      const found = names.find((name) => new RegExp(`^scene-${nn}(-[^/]*)?\\.(png|jpe?g)$`, 'iu').test(name))
      let bytes = null
      if (found) bytes = (await stat(join(lineArtDir, found))).size
      items.push({
        index,
        startMs: scene.startMs,
        endMs: scene.endMs,
        durationMs: scene.sceneDurationMs,
        text: scene.text,
        file: found ? `media/whiteboard/${found}` : null,
        fileName: found || null,
        bytes,
        thumb: found ? await this.#lineArtThumb(engineRoot, python, lineArtDir, found) : null,
      })
    }
    const engine = await checkImageEngine(whiteboardBridgeUrl())
    const generated = items.filter((item) => item.file).length
    return {
      scenes: items,
      total: items.length,
      generated,
      missing: items.length - generated,
      lineArtDir: 'media/whiteboard',
      engine,
      job: this.#lineArtJobs.get(`${request.projectId}`) || null,
    }
  }

  /** 取该项目的字幕产物；没有就直接给出可操作的报错。 */
  async #whiteboardSubtitleContext(agent, request) {
    const projectId = request?.projectId
    if (!projectId) throw fail('SPOKEN_VIDEO_INVALID_INPUT', '缺少项目标识。')
    const root = await projectRootFor(agent, projectId)
    const detail = await this.projectsStore.get(agent, { projectId })
    const subtitles = detail.artifacts?.subtitles?.data || null
    if (typeof subtitles?.srt !== 'string' || !subtitles.srt.trim()) {
      throw fail('SPOKEN_VIDEO_STAGE_BLOCKED', '必须先完成配音与字幕，才能准备白板线稿：出场时间与画面内容都来自字幕时间轴。请在「配音与字幕」生成字幕后重试。')
    }
    return { root, subtitles, detail }
  }

  /**
   * 批量生成缺失幕的线稿（后台任务）。scenes 指定幕号列表；缺省生成全部缺失幕。
   * force=true 时连同已有线稿一起重新生成（覆盖 scene-NN-story.png，手工放置的
   * 其他命名文件不受影响）。
   */
  async startWhiteboardLineArt(agent, request) {
    const projectId = request?.projectId
    if (!projectId) throw fail('SPOKEN_VIDEO_INVALID_INPUT', '缺少项目标识。')
    const existing = this.#lineArtJobs.get(projectId)
    if (existing && existing.phase === 'running') return { jobId: existing.jobId, reused: true, ...existing }

    const { root } = await this.#whiteboardSubtitleContext(agent, request)
    const plan = await this.whiteboardLineArtPlan(agent, { projectId })
    const wanted = Array.isArray(request.scenes) && request.scenes.length
      ? plan.scenes.filter((item) => request.scenes.includes(item.index))
      : plan.scenes.filter((item) => !item.file || request.force)
    const targets = request.force ? wanted : wanted.filter((item) => !item.file)
    if (!targets.length) {
      return { jobId: null, reused: false, skipped: true, total: 0, message: '线稿已齐全，没有需要生成的幕。' }
    }

    const engine = await checkImageEngine(whiteboardBridgeUrl())
    if (!engine.reachable) {
      throw fail('SPOKEN_VIDEO_WHITEBOARD_ENV', '本地媒体桥接未运行，无法生成线稿。请启动本地媒体桥接后重试。')
    }
    if (!engine.up) {
      throw fail('SPOKEN_VIDEO_WHITEBOARD_ENV', '生图引擎未连接。请打开桥接配置中心（${localBridgeBase(this.environment)}）点「一键启动」，引擎就绪后再生成线稿。')
    }

    // 旁白 → 视觉描述：结果缓存在 media/whiteboard/descriptions.json，键含稿件
    // 与字幕的产物版本，任一更新都会自动重算。缺描述时先调分镜师（一次 LLM
    // 调用出全部幕），生图只消费视觉描述，不消费旁白原文。
    const descriptions = await this.#ensureLineArtDescriptions(agent, root, projectId, plan.scenes)

    const lineArtDir = resolve(root, 'media/whiteboard')
    await mkdir(lineArtDir, { recursive: true, mode: 0o700 })
    const jobId = `lineart-${Date.now().toString(36)}`
    const job = { jobId, projectId, phase: 'running', done: 0, total: targets.length, current: targets[0].index, failures: [], startedAt: new Date().toISOString() }
    this.#lineArtJobs.set(projectId, job)

    const work = (async () => {
      for (const item of targets) {
        if (this.signal?.aborted) throw fail('SPOKEN_VIDEO_MEDIA_CANCELLED', '线稿生成已取消。')
        job.current = item.index
        try {
          const buffer = await generateLineArtImage({
            visual: descriptions.get(item.index) || item.visual,
            sceneIndex: item.index,
            signal: this.signal,
            onStage: (stage) => { job.stage = stage },
          })
          const fileName = this.#sceneImageName(item.index)
          await writeFile(resolve(lineArtDir, fileName), buffer)
          job.done += 1
          job.results = [...(job.results || []), { index: item.index, fileName: `media/whiteboard/${fileName}`, bytes: buffer.length }]
        } catch (error) {
          if (this.signal?.aborted) throw error
          job.failures.push({ index: item.index, error: String(error?.message || error).slice(0, 300) })
        }
      }
      job.phase = job.failures.length && job.done === 0 ? 'failed' : 'completed'
      job.completedAt = new Date().toISOString()
    })().catch((error) => {
      job.phase = this.signal?.aborted ? 'cancelled' : 'failed'
      job.error = String(error?.message || error).slice(0, 500)
    }).finally(() => {
      if (this.#lineArtJobs.get(projectId) === job) setTimeout(() => this.#lineArtJobs.delete(projectId), 10 * 60 * 1000)
    })
    this.background ? this.background(work) : void work
    return { jobId, reused: false, total: targets.length, scenes: targets.map((item) => item.index) }
  }

  whiteboardLineArtStatus(agent, request) {
    const job = this.#lineArtJobs.get(request?.projectId)
    return job || { phase: 'idle' }
  }

  #whiteboardEngineRoot() {
    return process.env.LWB_WHITEBOARD_ENGINE_ROOT
      || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'whiteboard', 'engine')
  }

  async #whiteboardPython(engineRoot) {
    const venvPython = process.platform === 'win32'
      ? join(engineRoot, '.venv', 'Scripts', 'python.exe')
      : join(engineRoot, '.venv', 'bin', 'python')
    const candidates = [venvPython, process.platform === 'win32' ? 'python' : 'python3']
    const probe = 'import cv2, numpy, PIL; print("WHITEBOARD_DEPS_OK")'
    for (const python of candidates) {
      try {
        const { stdout } = await execFilePromise(python, ['-c', probe], { timeout: 30_000 })
        if (stdout.includes('WHITEBOARD_DEPS_OK')) return python
      } catch { /* 该解释器不可用，尝试下一个 */ }
    }
    throw fail('SPOKEN_VIDEO_WHITEBOARD_ENV', '白板渲染需要具备 OpenCV/NumPy/Pillow 的 Python 解释器；请在「白板手绘动画」包内先执行一次「准备环境」。')
  }

  async #runWhiteboardScript(engineRoot, python, script, args) {
    try {
      return await execFilePromise(python, [join(engineRoot, 'scripts', script), ...args], {
        cwd: engineRoot,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60 * 60 * 1000,
      })
    } catch (error) {
      throw commandError(error, `白板引擎 ${script}`)
    }
  }

  async #renderWhiteboardVideo(agent, root, run) {
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    if (detail.revision !== run.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '上游已更新，已取消旧版本的视频渲染任务。')
    const voiceover = detail.artifacts?.voiceover?.data
    const subtitles = detail.artifacts?.subtitles?.data || null
    const subtitleEnabled = run.input.subtitleEnabled !== false
    const orientation = run.input.orientation === 'landscape' ? 'landscape' : 'portrait'
    if (!voiceover?.audio?.file || (subtitleEnabled && typeof subtitles?.srt !== 'string')) fail('SPOKEN_VIDEO_STAGE_BLOCKED', subtitleEnabled ? '必须先完成配音与字幕，才能渲染白板视频。' : '必须先完成配音，才能渲染白板视频。')

    // 线稿：按幕号精确匹配 scene-NN*.png（两位序号）。自动生成的线稿走
    // startWhiteboardLineArt 落到同一目录，两边命名约定一致。
    const lineArtDir = resolve(root, 'media/whiteboard')
    const audioPath = await this.#file(root, voiceover.audio.file, '配音文件')
    const audioProbe = await this.#probe(audioPath)
    const srtFile = `media/videos/${run.id}.srt`
    const srtPath = await this.#write(root, srtFile, subtitles.srt)

    const engineRoot = this.#whiteboardEngineRoot()
    const python = await this.#whiteboardPython(engineRoot)
    const workDir = `media/videos/${run.id}-whiteboard`
    const workPath = resolve(root, workDir)
    await mkdir(workPath, { recursive: true, mode: 0o700 })

    // 分幕：parse_srt 动态规划分幕，stdout JSON 取 scenes
    const parsed = await this.#runWhiteboardScript(engineRoot, python, 'parse_srt.py', [srtPath])
    let scenes = null
    try { scenes = JSON.parse(parsed.stdout).scenes }
    catch { throw fail('SPOKEN_VIDEO_WHITEBOARD_FAILED', '白板引擎字幕分幕输出无法解析。') }
    if (!Array.isArray(scenes) || scenes.length === 0) fail('SPOKEN_VIDEO_WHITEBOARD_FAILED', '字幕没有解析出任何分幕。')

    let images
    try { images = await this.#matchSceneImages(lineArtDir, scenes.length) }
    catch (error) { throw fail('SPOKEN_VIDEO_STAGE_BLOCKED', error.message) }

    const sceneFiles = []
    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index]
      const image = images[index]
      const imagePath = join(lineArtDir, image)
      const imageProbe = await this.#probe(imagePath)
      if (!imageProbe.width || !imageProbe.height) fail('SPOKEN_VIDEO_WHITEBOARD_FAILED', `无法读取线稿尺寸：${image}`)

      // 标注：优先用线稿同名 .annotation.json；没有则按字幕时间轴自动生成骨架
      const annotationName = image.replace(/\.[^.]+$/u, '.annotation.json')
      let annotationPath = join(lineArtDir, annotationName)
      try { await stat(annotationPath) }
      catch {
        annotationPath = join(workPath, annotationName)
        await this.#runWhiteboardScript(engineRoot, python, 'plan_timeline.py', [
          srtPath, '--scene', String(index + 1),
          '--elements', '场景铺垫', '核心主体', '结果反应',
          '--width', String(imageProbe.width), '--height', String(imageProbe.height),
          '--output', annotationPath,
        ])
      }

      // 末幕时长对齐配音结尾：字幕通常在最后一句语音处结束，配音尾部可能还有
      // 静音；把差值补进末幕，保证成片与配音时长差落在 QC 的 2 秒线内。
      const sceneDurationMs = index === scenes.length - 1 && audioProbe?.durationSeconds
        ? Math.max(scene.sceneDurationMs, Math.round(audioProbe.durationSeconds * 1000) - scene.startMs)
        : scene.sceneDurationMs

      const sceneFile = join(workPath, `scene-${String(index + 1).padStart(2, '0')}.mp4`)
      await this.#runWhiteboardScript(engineRoot, python, 'render_stream_whiteboard.py', [
        imagePath, annotationPath, sceneFile,
        '--fps', '30',
        '--total-ms', String(sceneDurationMs),
        '--cap-long-edge', orientation === 'landscape' ? '1080' : '720',
      ])
      sceneFiles.push(sceneFile)
    }

    // 多幕合并成无声全片
    let silentVideo = sceneFiles[0]
    if (sceneFiles.length > 1) {
      silentVideo = join(workPath, 'merged.mp4')
      await this.#runWhiteboardScript(engineRoot, python, 'merge_scenes.py', ['--inputs', ...sceneFiles, '--output', silentVideo])
    }

    // 合成：规格化尺寸（pad 色用白板纸底，避免黑边）+ 配音音轨 + 可选字幕烧录。
    // 多幕的"画不完"超时会逐幕累积，成片可能比配音长数秒（实测 3.5s，超过 QC
    // 的 2 秒线）：先克隆尾帧补足，再精确截到配音时长——尾部本就是凝视段，
    // 截掉无损，成片与配音的时长差因此恒为 0。
    const videoFile = `media/videos/${run.id}.mp4`
    const videoPath = resolve(root, videoFile)
    const target = orientation === 'landscape' ? '1920:1080' : '1080:1920'
    const scalePad = `scale=${target}:force_original_aspect_ratio=decrease,pad=${target}:(ow-iw)/2:(oh-ih)/2:color=0xF6F1E3,tpad=stop_mode=clone:stop_duration=10`
    const vf = subtitleEnabled ? `${scalePad},${ffmpegSubtitleFilter(resolve(root, srtFile))}` : scalePad
    const audioDuration = audioProbe?.durationSeconds
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', silentVideo, '-i', audioPath, '-vf', vf,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
        ...(audioDuration ? ['-t', String(audioDuration)] : []),
        videoPath,
      ], { signal: this.signal, maxBuffer: 1024 * 1024 * 4 })
    } catch (error) {
      throw commandError(error, '白板视频合成')
    }

    const info = await stat(videoPath)
    if (!info.isFile() || info.size < 1024) fail('SPOKEN_VIDEO_MEDIA_COMMAND_FAILED', '视频渲染没有生成有效文件。')
    const probe = await this.#probe(videoPath)
    const committed = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId,
      expectedRevision: run.expectedRevision,
      stage: 'video',
      idempotencyKey: `media-${run.id}`,
      source: 'spoken-video/whiteboard',
      payload: {
        mode: 'whiteboard', renderer: 'whiteboard', orientation, visualBrief: run.input.visualBrief, subtitleEnabled, sourceAudioFile: voiceover.audio.file, sourceSubtitleFile: subtitleEnabled ? subtitles.srtFile || null : null,
        video: { file: videoFile, mediaType: 'video/mp4', bytes: info.size, durationSeconds: probe.durationSeconds, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio },
        whiteboard: { scenes: scenes.length, lineArtDir: 'media/whiteboard' },
      },
    })
    // 白板路径没有独立审片阶段，技术质检在这里内联完成并提交 qc 产物；
    // 否则成片没有 qc 兄弟产物，发布页（只列 qc.passed 的项目）会看不到它。
    const qc = await this.#commitInlineTechnicalQc(agent, run, committed, { audioPath, subtitles, subtitleEnabled, orientation })
    return { project: qc.project, artifact: committed.artifact, video: { file: videoFile, ...probe, bytes: info.size }, qc: { passed: true, artifact: qc.artifact, technical: qc.technical } }
  }

  async #renderAiDirectorVideo(agent, root, run) {
    if (!this.videoCreator) fail('SPOKEN_VIDEO_VIDEO_AGENT_UNAVAILABLE', '当前 DSH 环境未提供视频创作 Agent，任务已终止。')
    if (!this.videoReviewer) fail('SPOKEN_VIDEO_VIDEO_REVIEWER_UNAVAILABLE', '当前 DSH 环境未提供独立视频审核 Agent，任务已终止。')
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    if (detail.revision !== run.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '上游已更新，已取消旧版本的视频制作任务。')
    const script = detail.artifacts?.script?.data?.body || ''
    const voiceover = detail.artifacts?.voiceover?.data
    const subtitles = detail.artifacts?.subtitles?.data || null
    const subtitleEnabled = run.input.subtitleEnabled !== false
    const orientation = run.input.orientation === 'landscape' ? 'landscape' : 'portrait'
    // 字幕时间轴是画面与语音对齐的唯一依据：创作 Agent 拿不到它就只能按稿件段落猜秒数，
    // 实测会整体错位 2-3 个章节。所以即使用户关掉了「烧录字幕」，也必须先有字幕产物。
    const hasTimeline = typeof subtitles?.srt === 'string' && subtitles.srt.trim().length > 0
    if (!script || !voiceover?.audio?.file) {
      fail('SPOKEN_VIDEO_STAGE_BLOCKED', '必须先完成稿件与配音，才能制作视频。')
    }
    if (!hasTimeline) {
      fail('SPOKEN_VIDEO_STAGE_BLOCKED', '必须先完成字幕（语音对齐），才能制作视频：画面场景边界取自字幕时间轴，没有它画面对不上配音。请在「配音与字幕」里生成字幕后重试。')
    }

    await this.#setVideoPhase(root, run.id, 'preparing')
    const audioPath = await this.#file(root, voiceover.audio.file, '配音文件')
    const bgmPath = run.input.backgroundMusic ? await this.#videoBgm(root, run.input.backgroundMusic) : null
    const audioProbe = await this.#probe(audioPath)
    const durationSeconds = audioProbe.durationSeconds || voiceover.audio.durationSeconds || 1
    // cues 永远按字幕时间轴构建（不再随 subtitleEnabled 置空）：它是画面分节的依据，
    // 而 subtitleEnabled 只决定「字幕条是否烧进画面」。
    //
    // 进渲染前先按显示上限把超长 cue 拆开（2026-10-13）：ASR 路径产出的字幕不做
    // 任何拆分，曾出现一条 63 字的 cue 直接把整条流水线卡在「成片未通过技术质检」，
    // 自动任务白跑 27 分钟。这里是路径无关的兜底，拆完顺带把 SRT 落回磁盘，
    // 让后续所有阶段（画面分节、烧录、成片）都用同一份。
    //
    // 注意：这里**只**改局部的 cues，不改 subtitles 本体 —— 它是 const，
    // 而渲染/烧录读的是 cues，拆完已经一致了。（2026-10-13 首次写成给 subtitles
    // 赋值，直接把渲染打成 "Assignment to constant variable"。）
    const splitResult = splitLongCues(subtitles.srt, { orientation })
    const cues = splitResult.cues.map((cue, index) => ({ id: `srt-${index + 1}`, startMs: cue.startMs, endMs: cue.endMs, text: cue.text }))
    const workspace = await prepareSpokenVideoAgentProject({
      projectRoot: root, runId: run.id, title: detail.title, script, audioPath, durationSeconds,
      subtitles: cues, subtitleSrt: subtitleEnabled ? subtitles.srt : '', subtitleEnabled, orientation, visualBrief: run.input.visualBrief,
      bgmPath, backgroundMusic: run.input.backgroundMusic, bgmVolume: run.input.bgmVolume,
    })
    await this.#setVideoPhase(root, run.id, 'directing', { workspaceDir: workspace.relativeProjectDir })
    await this.videoCreator({
      prompt: buildVideoCreatorPrompt({ runDir: workspace.projectDir }),
      agent,
      validate: async () => {
        this.signal?.throwIfAborted()
        const report = await inspectSpokenVideoAgentProject(workspace)
        if (report.passed) await mergeRuntimeEvalFailure(report, workspace, this.signal)
        await this.#setVideoPhase(root, run.id, 'preflight', { preflight: { passed: report.passed, failures: report.failures, findings: report.findings, creativeBytes: report.creativeBytes } })
        return report
      },
      repairPrompt: (input) => buildVideoCreatorRepairPrompt({ runDir: workspace.projectDir, ...input }),
      maxRepairs: 2,
      onDshRepair: async ({ attempt, maximum, failures }) => {
        await this.#runEvent(root, run.id, `工程预检修复 ${attempt}/${maximum}`, failures.join('\n'))
        await this.#setVideoPhase(root, run.id, 'directing', { repair: { attempt, maximum, failures } })
      },
      onDshStarted: (started) => this.#recordRunDshStarted(root, run.id, 'creator', '视觉导演', started),
      onDshEvent: (event) => this.#recordRunDshEvent(root, run.id, 'creator', event),
      onDshContinuation: ({ attempt, maximum }) => this.#setVideoPhase(root, run.id, 'directing', {
        continuation: { reason: 'max-tokens', attempt, maximum },
      }),
    })

    await this.#setVideoPhase(root, run.id, 'preflight')
    const inspected = await inspectSpokenVideoAgentProject(workspace)
    const preflight = { passed: inspected.passed, failures: inspected.failures, findings: inspected.findings, creativeBytes: inspected.creativeBytes }
    await this.#setVideoPhase(root, run.id, 'preflight', { preflight })
    if (!inspected.passed) fail('SPOKEN_VIDEO_VIDEO_AGENT_INVALID', `视频 Agent 产物未通过渲染前检查：${inspected.failures.join(' ')}`)

    const subtitleDisplayLimit = orientation === 'landscape' ? 56 : 44
    const subtitleLengths = cues.map((cue) => Array.from(cue.text).length)
    const maxSubtitleChars = subtitleLengths.length ? Math.max(...subtitleLengths) : 0
    const longSubtitleCount = subtitleLengths.filter((length) => length > subtitleDisplayLimit).length
    const subtitleIssues = subtitleEnabled && longSubtitleCount ? [`${longSubtitleCount} 条字幕超过 ${subtitleDisplayLimit} 字的双行可读上限。`] : []
    const editorialRepairHistory = []
    const renderAndReview = async (repairAttempt) => {
      const attemptNumber = repairAttempt + 1
      await this.#setVideoPhase(root, run.id, 'rendering', {
        editorialRepair: { attempts: repairAttempt, maxAttempts: VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS, history: editorialRepairHistory },
      })
      const renderedPath = await renderSpokenVideoAgentProject(workspace, {
        signal: this.signal,
        onProgress: (message) => {
          this.#runEvent(root, run.id, repairAttempt ? `修复后渲染 ${repairAttempt}/${VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS}` : '渲染输出', message)
          // Remotion 会打印 "Rendered 5/8873, time remaining: 35m 52s"。
          // 这是真实进度而非估算，抽出来供任务列表显示。
          const parsed = parseRemotionRenderProgress(message)
          if (parsed) void this.#setVideoRenderProgress(root, run.id, parsed)
        },
      })
      const renderedInfo = await stat(renderedPath)
      if (!renderedInfo.isFile() || renderedInfo.size < 1024) fail('SPOKEN_VIDEO_MEDIA_COMMAND_FAILED', 'Remotion 没有生成有效成片。')
      if (renderedInfo.size > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_TOO_LARGE', 'Remotion 成片超过 80 MiB，无法提交或在工作台预览。请缩短稿件后重新生成。')
      const videoProbe = await this.#probe(renderedPath)

      await this.#setVideoPhase(root, run.id, 'technical-qc')
      const reviewFramesDir = join(workspace.projectDir, 'outputs', 'review-frames', `attempt-${attemptNumber}`)
      // 抽帧前先读导演写的场景表：按场景中段取帧，而不是按全片比例盲选。
      // 盲选会让大部分抽帧落在场景的入场动画期，审片看到的是「只有骨架」
      // 「内容没画出来」这类并不存在的缺陷，然后要求导演去修——2026-10-10 统计的
      // 5 个审片失败案例全部由此而来（6 帧里 4 帧撞动画期，修复上限只有 2 轮）。
      // 读不到就退回盲选，不因此阻断流水线。
      const sceneSpans = await readFile(join(workspace.projectDir, 'src', 'CreativeVideo.tsx'), 'utf8')
        .then((source) => parseSceneSpans(source))
        .catch(() => [])
      const sampled = await extractVideoReviewFrames(renderedPath, reviewFramesDir, videoProbe.durationSeconds || durationSeconds, this.signal, sceneSpans)
      const contactSheet = await renderVideoContactSheet(renderedPath, reviewFramesDir, videoProbe.durationSeconds || durationSeconds, this.signal)
      const variation = await measureVisualVariation(sampled.frameFiles, orientation, videoProbe.durationSeconds || durationSeconds, this.signal)
      const topology = buildTechnicalReport({ video: videoProbe, audio: audioProbe, subtitles, subtitleEnabled, orientation })
      const variationIssues = variation.passed ? [] : ['主画面变化不足，成片可能退化为静态画面或少量文字卡片。']
      const technical = {
        ...topology,
        passed: topology.passed && variation.passed && subtitleIssues.length === 0,
        issues: [...topology.issues, ...variationIssues, ...subtitleIssues],
        subtitles: { ...topology.subtitles, maxTextChars: maxSubtitleChars, displayLimit: subtitleDisplayLimit, longCueCount: longSubtitleCount },
        variation,
        sampledFrames: sampled.frameFiles.map((file) => portableRelative(root, file)),
        sampledTimestamps: sampled.timestamps,
        contactSheet: contactSheet ? portableRelative(root, contactSheet.file) : null,
      }
      const technicalReportPath = join(workspace.projectDir, 'outputs', `technical-qc-attempt-${attemptNumber}.json`)
      const canonicalTechnicalReportPath = join(workspace.projectDir, 'outputs', 'technical-qc.json')
      const technicalReport = { generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, attempt: attemptNumber, ...technical }
      await Promise.all([writeJson(technicalReportPath, technicalReport), writeJson(canonicalTechnicalReportPath, technicalReport)])
      await this.#setVideoPhase(root, run.id, 'technical-qc', { technical, technicalReportFile: portableRelative(root, technicalReportPath) })
      if (!technical.passed) fail('SPOKEN_VIDEO_VIDEO_TECHNICAL_QC_FAILED', `成片未通过技术质检：${technical.issues.join(' ')}`)

      await this.#setVideoPhase(root, run.id, 'editorial-review')
      const reviewerRole = repairAttempt ? `reviewer-${attemptNumber}` : 'reviewer'
      const rawReview = await this.videoReviewer({
        prompt: buildVideoReviewerPrompt({ runDir: workspace.projectDir, technicalReportFile: technicalReportPath, frameFiles: sampled.frameFiles, timestamps: sampled.timestamps, contactSheetFile: contactSheet?.file ?? null }),
        schema: VIDEO_REVIEW_SCHEMA,
        agent,
        onDshStarted: (started) => this.#recordRunDshStarted(root, run.id, reviewerRole, repairAttempt ? `独立复审 ${repairAttempt}/${VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS}` : '独立审片', started),
        onDshEvent: (event) => this.#recordRunDshEvent(root, run.id, reviewerRole, event),
      })
      const review = normalizeVideoReview(rawReview, { technicalPassed: technical.passed, sampledTimestamps: sampled.timestamps })
      const reviewReportPath = join(workspace.projectDir, 'outputs', `editorial-review-attempt-${attemptNumber}.json`)
      const canonicalReviewReportPath = join(workspace.projectDir, 'outputs', 'editorial-review.json')
      const reviewReport = { generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, attempt: attemptNumber, ...review }
      await Promise.all([writeJson(reviewReportPath, reviewReport), writeJson(canonicalReviewReportPath, reviewReport)])
      editorialRepairHistory.push({ attempt: repairAttempt, passed: review.passed, score: review.score, summary: review.summary, reviewReportFile: portableRelative(root, reviewReportPath) })
      await this.#setVideoPhase(root, run.id, 'editorial-review', {
        review,
        reviewReportFile: portableRelative(root, reviewReportPath),
        editorialRepair: { attempts: repairAttempt, maxAttempts: VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS, history: editorialRepairHistory },
      })
      return { renderedPath, renderedInfo, videoProbe, technical, sampled, contactSheet, review, reviewReportPath }
    }

    let reviewed = await renderAndReview(0)
    for (let attempt = 1; !reviewed.review.passed && attempt <= VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      await this.#runEvent(root, run.id, `独立审片定向修复 ${attempt}/${VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS}`, {
        score: reviewed.review.score,
        summary: reviewed.review.summary,
        findings: reviewed.review.findings,
      })
      await this.#setVideoPhase(root, run.id, 'editorial-repair', {
        editorialRepair: { attempts: attempt, maxAttempts: VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS, history: editorialRepairHistory },
      })
      const creatorRole = `creator-repair-${attempt}`
      await this.videoCreator({
        prompt: buildVideoEditorialRepairPrompt({
          runDir: workspace.projectDir,
          review: reviewed.review,
          frameFiles: reviewed.sampled.frameFiles,
          timestamps: reviewed.sampled.timestamps,
          contactSheetFile: reviewed.contactSheet?.file ?? null,
          attempt,
          maximum: VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS,
        }),
        agent,
        validate: async () => {
          this.signal?.throwIfAborted()
          const report = await inspectSpokenVideoAgentProject(workspace)
          if (report.passed) await mergeRuntimeEvalFailure(report, workspace, this.signal)
          await this.#setVideoPhase(root, run.id, 'preflight', { preflight: { passed: report.passed, failures: report.failures, findings: report.findings, creativeBytes: report.creativeBytes } })
          return report
        },
        repairPrompt: (input) => buildVideoCreatorRepairPrompt({ runDir: workspace.projectDir, ...input }),
        maxRepairs: 1,
        onDshRepair: async ({ failures }) => this.#runEvent(root, run.id, `审片修复后的工程预检修复 ${attempt}/${VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS}`, failures.join('\n')),
        onDshStarted: (started) => this.#recordRunDshStarted(root, run.id, creatorRole, `视觉定向修复 ${attempt}/${VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS}`, started),
        onDshEvent: (event) => this.#recordRunDshEvent(root, run.id, creatorRole, event),
        onDshContinuation: ({ attempt: continuationAttempt, maximum }) => this.#setVideoPhase(root, run.id, 'editorial-repair', {
          continuation: { reason: 'max-tokens', attempt: continuationAttempt, maximum },
        }),
      })
      const repaired = await inspectSpokenVideoAgentProject(workspace)
      if (!repaired.passed) fail('SPOKEN_VIDEO_VIDEO_AGENT_INVALID', `审片定向修复未通过渲染前检查：${repaired.failures.join(' ')}`)
      preflight.passed = repaired.passed
      preflight.failures = repaired.failures
      preflight.findings = repaired.findings
      preflight.creativeBytes = repaired.creativeBytes
      reviewed = await renderAndReview(attempt)
    }
    const { renderedPath, renderedInfo, videoProbe, technical, sampled, review, reviewReportPath } = reviewed
    if (!review.passed) fail('SPOKEN_VIDEO_VIDEO_EDITORIAL_REVIEW_FAILED', `成片经过 ${VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS} 次定向修复后仍未通过独立审片：${review.summary}`)

    await this.#setVideoPhase(root, run.id, 'committing')
    const videoFile = `media/videos/${run.id}.mp4`
    const videoPath = resolve(root, videoFile)
    await mkdir(dirname(videoPath), { recursive: true, mode: 0o700 })
    await copyFile(renderedPath, videoPath)
    const reportFile = `media/qc/${run.id}.json`
    const reviewFile = `media/qc/${run.id}-editorial.json`
    await this.#write(root, reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, technical, review }, null, 2)}\n`)
    await this.#write(root, reviewFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, ...review }, null, 2)}\n`)
    const videoCommit = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId, expectedRevision: run.expectedRevision, stage: 'video', idempotencyKey: `media-${run.id}`, source: 'spoken-video/remotion-agent',
      payload: {
        mode: 'ai-director', renderer: 'remotion', orientation, visualBrief: run.input.visualBrief, subtitleEnabled,
        sourceAudioFile: voiceover.audio.file, sourceSubtitleFile: subtitleEnabled ? subtitles.srtFile || null : null,
        sourceBgmFile: run.input.backgroundMusic?.file || null,
        backgroundMusic: run.input.backgroundMusic,
        bgmVolume: run.input.bgmVolume,
        remotion: {
          projectDir: workspace.relativeProjectDir,
          propsFile: `${workspace.relativeProjectDir}/public/task-props.json`,
          entryFile: `${workspace.relativeProjectDir}/src/index.ts`,
          creativeFile: `${workspace.relativeProjectDir}/src/CreativeVideo.tsx`,
          preflight,
          editorialRepair: { attempts: editorialRepairHistory.length - 1, maxAttempts: VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS, history: editorialRepairHistory },
        },
        video: { file: videoFile, mediaType: 'video/mp4', bytes: renderedInfo.size, durationSeconds: videoProbe.durationSeconds, width: videoProbe.width, height: videoProbe.height, fps: videoProbe.fps, frameCount: videoProbe.frameCount, hasAudio: videoProbe.hasAudio },
      },
    })
    const qcCommit = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId, expectedRevision: videoCommit.project.revision, stage: 'qc', idempotencyKey: `media-${run.id}-qc`, source: 'spoken-video/ai-review',
      payload: { mode: 'ai-director', reportFile, reviewFile, passed: true, technical, review, sampledFrames: technical.sampledFrames, contactSheet: technical.contactSheet },
    })
    await this.#setVideoPhase(root, run.id, 'completed', { committedRevision: qcCommit.project.revision })
    return {
      project: qcCommit.project,
      artifact: videoCommit.artifact,
      video: { file: videoFile, ...videoProbe, bytes: renderedInfo.size },
      qc: { passed: true, artifact: qcCommit.artifact, technical, review, reportFile, reviewFile },
      remotion: {
        projectDir: workspace.relativeProjectDir,
        creativeFile: `${workspace.relativeProjectDir}/src/CreativeVideo.tsx`,
        preflight,
        editorialRepair: { attempts: editorialRepairHistory.length - 1, maxAttempts: VIDEO_EDITORIAL_REPAIR_MAX_ATTEMPTS, history: editorialRepairHistory },
      },
    }
  }

  async #renderLocalFfmpeg(root, run, audioPath, subtitles, subtitleEnabled, videoPath) {
    const subtitleFile = subtitleEnabled ? `media/videos/${run.id}.srt` : null
    const subtitlePath = subtitleEnabled ? await this.#write(root, subtitleFile, subtitles.srt) : null
    const dimensions = run.input.orientation === 'landscape' ? '1920x1080' : '1080x1920'
    try {
      const ffmpegArgs = [
        '-y', '-f', 'lavfi', '-i', `color=c=0x102235:s=${dimensions}:r=30`, '-i', audioPath,
        ...(subtitleEnabled ? ['-vf', ffmpegSubtitleFilter(subtitlePath)] : []), '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', videoPath,
      ]
      await execFileAsync('ffmpeg', ffmpegArgs, { signal: this.signal, maxBuffer: 1024 * 1024 * 4 })
    } catch (error) {
      throw commandError(error, '本机视频渲染')
    }
  }

  async #recordRunDshStarted(root, runId, role, label, started) {
    const childSessionId = typeof started?.childSessionId === 'string' ? started.childSessionId : null
    if (!childSessionId) return
    await this.#mutateRun(root, runId, (run) => {
      const trace = ensureDshTrace(run)
      startDshTraceSession(trace, { role, label, childSessionId, parentSessionId: typeof started.parentSessionId === 'string' ? started.parentSessionId : null })
      appendDshSessionTrace(trace, role, dshChildStarted(new Date().toISOString()))
      return run
    })
  }

  async #recordRunDshEvent(root, runId, role, event) {
    const projected = projectDshSessionEvent(event, new Date().toISOString())
    if (!projected) return
    await this.#mutateRun(root, runId, (run) => {
      appendDshSessionTrace(ensureDshTrace(run), role, projected)
      return run
    })
  }

  async #technicalQc(agent, root, run) {
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    if (detail.revision !== run.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '视频已更新，已取消旧版本的技术质检。')
    const voiceover = detail.artifacts?.voiceover?.data
    const subtitles = detail.artifacts?.subtitles?.data || null
    const video = detail.artifacts?.video?.data
    const subtitleEnabled = video.subtitleEnabled !== false
    if (!voiceover?.audio?.file || !video?.video?.file || (subtitleEnabled && !subtitles?.cueCount)) fail('SPOKEN_VIDEO_STAGE_BLOCKED', subtitleEnabled ? '缺少视频、配音或字幕，不能进行技术质检。' : '缺少视频或配音，不能进行技术质检。')
    const [audioProbe, videoProbe] = await Promise.all([
      this.#probe(await this.#file(root, voiceover.audio.file, '配音文件')),
      this.#probe(await this.#file(root, video.video.file, '视频文件')),
    ])
    const technical = buildTechnicalReport({ video: videoProbe, audio: audioProbe, subtitles, subtitleEnabled, orientation: video.orientation })
    const reportFile = `media/qc/${run.id}.json`
    await this.#write(root, reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: run.projectId, ...technical }, null, 2)}\n`)
    const committed = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId,
      expectedRevision: run.expectedRevision,
      stage: 'qc',
      idempotencyKey: `media-${run.id}`,
      source: 'spoken-video/ffprobe',
      payload: { mode: 'automatic', reportFile, technical, passed: technical.passed },
    })
    return { project: committed.project, artifact: committed.artifact, technical }
  }

  /**
   * Deterministic technical QC run inline by the renderers that have no
   * editorial-review stage (whiteboard, local-ffmpeg).
   *
   * Without this the video artifact lands with no `qc` sibling, and the publish
   * shelf — which only lists projects whose `qc.passed === true` — silently
   * hides a finished cut. The Remotion path commits its own richer QC
   * (technical + independent review), so it does not come through here.
   *
   * QC runs against the committed video artifact rather than the freshly probed
   * file so the report describes exactly what downstream stages will read.
   */
  async #commitInlineTechnicalQc(agent, run, committedVideo, { audioPath, subtitles, subtitleEnabled, orientation }) {
    const detail = await this.projectsStore.get(agent, { projectId: run.projectId })
    const video = detail.artifacts?.video?.data
    if (!video?.video?.file) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '缺少视频产物，不能进行技术质检。')
    const [audioProbe, videoProbe] = await Promise.all([
      this.#probe(audioPath),
      this.#probe(await this.#file(await projectRootFor(agent, run.projectId), video.video.file, '视频文件')),
    ])
    const technical = buildTechnicalReport({ video: videoProbe, audio: audioProbe, subtitles, subtitleEnabled, orientation })
    const root = await projectRootFor(agent, run.projectId)
    const reportFile = `media/qc/${run.id}.json`
    await this.#write(root, reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, ...technical }, null, 2)}\n`)
    const committed = await this.projectsStore.commitProduced(agent, {
      projectId: run.projectId,
      expectedRevision: committedVideo.project.revision,
      stage: 'qc',
      idempotencyKey: `media-${run.id}-qc`,
      source: 'spoken-video/ffprobe',
      payload: { mode: 'automatic', reportFile, technical, passed: technical.passed },
    })
    if (!technical.passed) {
      fail('SPOKEN_VIDEO_VIDEO_TECHNICAL_QC_FAILED', `成片未通过技术质检：${technical.issues.join(' ')}`)
    }
    return { project: committed.project, artifact: committed.artifact, technical }
  }

  async readMedia(agent, request) {
    const input = object(request, '读取媒体请求')
    const id = projectId(input.projectId)
    const stage = text(input.stage, '媒体阶段', 20)
    if (!['voiceover', 'video'].includes(stage)) fail('SPOKEN_VIDEO_MEDIA_INVALID_INPUT', '只可读取配音或视频预览。')
    const detail = await this.projectsStore.get(agent, { projectId: id })
    const root = await projectRootFor(agent, id)
    const data = detail.artifacts?.[stage]?.data
    const descriptor = stage === 'voiceover' ? data?.audio : data?.video
    if (!descriptor?.file || !descriptor?.mediaType) fail('SPOKEN_VIDEO_MEDIA_FILE_INVALID', '当前阶段没有可预览媒体。')
    const file = await this.#file(root, descriptor.file, '预览媒体')
    const info = await stat(file)
    if (info.size > MAX_MEDIA_BYTES) fail('SPOKEN_VIDEO_MEDIA_FILE_TOO_LARGE', '媒体文件超过浏览器预览的 80 MiB 限制。')
    return { file: descriptor.file, mediaType: descriptor.mediaType, bytes: info.size, data: (await readFile(file)).toString('base64') }
  }
}
