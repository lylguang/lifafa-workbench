const TIMECODE = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u

function timeToMs(value) {
  const match = TIMECODE.exec(String(value || '').trim())
  if (!match) return null
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4])
}

/** 解析 SRT 文本，返回 cues 与结构性错误列表。 */
export function parseSrt(srt) {
  const cues = []
  const errors = []
  const blocks = String(srt || '').replace(/\r\n/gu, '\n').split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
  if (!blocks.length) {
    errors.push('未包含任何字幕条目。')
    return { cues, errors }
  }
  blocks.forEach((block, position) => {
    const label = `第 ${position + 1} 条`
    const lines = block.split('\n')
    let offset = 0
    if (/^\d+$/u.test(String(lines[0] || '').trim())) offset = 1
    else errors.push(`${label}缺少数字序号。`)
    const [start, end] = String(lines[offset] || '').split('-->').map((part) => part?.trim())
    const startMs = timeToMs(start)
    const endMs = timeToMs(end)
    if (startMs === null || endMs === null) {
      errors.push(`${label}时间码格式无效，应为 00:00:00,000 --> 00:00:02,000。`)
      return
    }
    if (endMs <= startMs) {
      errors.push(`${label}结束时间必须晚于开始时间。`)
      return
    }
    const text = lines.slice(offset + 1).join('\n').trim()
    if (!text) {
      errors.push(`${label}缺少字幕文本。`)
      return
    }
    cues.push({ startMs, endMs, durationMs: endMs - startMs, text })
  })
  return { cues, errors }
}

/** 校验 SRT 的结构性错误。 */
export function validateSrt(srt) {
  const { cues, errors } = parseSrt(srt)
  return { cues, errors }
}

const DISPLAY_LIMIT = { landscape: 56, portrait: 44 }

/** 一条 cue 里的字数（不计空白），与质检口径一致。 */
export function cueChars(text) {
  return (String(text || '').match(/[^\s]/gu) || []).length
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

function toTimecode(ms) {
  const safe = Math.max(0, Math.round(Number(ms) || 0))
  const hours = Math.floor(safe / 3600000)
  const minutes = Math.floor((safe % 3600000) / 60000)
  const seconds = Math.floor((safe % 60000) / 1000)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(safe % 1000, 3)}`
}

/** 把 cues 序列化回 SRT 文本（序号从 1 连续编号）。 */
export function serializeSrt(cues) {
  return (cues || [])
    .map((cue, index) => `${index + 1}\n${toTimecode(cue.startMs)} --> ${toTimecode(cue.endMs)}\n${cue.text}`)
    .join('\n\n')
    .concat('\n')
}

/** 没有可用标点时按字数均分硬切，尽量不把词劈开。 */
function hardSplit(text, limit) {
  const chars = Array.from(String(text || ''))
  const parts = []
  let buffer = ''
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    buffer += char
    const next = chars[index + 1] || ''
    if (cueChars(buffer) >= limit && !(/[0-9A-Za-z]/u.test(char) && /[0-9A-Za-z]/u.test(next))) {
      parts.push(buffer.trim())
      buffer = ''
    }
  }
  if (buffer.trim()) parts.push(buffer.trim())
  return parts.filter(Boolean)
}

/** 把标点片段再按字数合并成不超过 limit 的组；仍超限的组继续硬切。 */
function balanceByChars(parts, limit) {
  const pieces = []
  let buffer = ''
  for (const part of parts) {
    if (buffer && cueChars(buffer + part) > limit) {
      pieces.push(buffer)
      buffer = part
    } else {
      buffer += part
    }
  }
  if (buffer) pieces.push(buffer)
  return pieces.flatMap((piece) => (cueChars(piece) > limit ? hardSplit(piece, limit) : [piece]))
}

/**
 * 把超过双行可读上限的 cue 拆开，时长按字数比例分摊。
 *
 * 2026-10-13：晚报自动任务连挂两次，真因是「成片未通过技术质检：1 条字幕超过
 * 56 字的双行可读上限」。查下来是**拆分的阈值和质检的阈值对不上**：段时序快
 * 路径里有 42 字的拆分，但这次没走那条路（该项目 audio-tasks 里没有配音任务、
 * 拿不到 segmentTimeline），字幕来自 ASR —— **ASR 产出多少字就是多少字，
 * 完全没有拆分**，于是质检数出一条 63 字的 cue，把整条流水线在最后一步卡死。
 *
 * 所以这里补一层与路径无关的兜底：不管字幕怎么来的，超限就拆。
 * 用法上注意拆分是**递归均衡**的：只切一刀时 63 字会变成 23/40，看着能过，
 * 但换个断句又会留下另一片超限，而那要跑一整轮 27 分钟才发现。
 */
export function splitLongCues(srt, { orientation = 'landscape' } = {}) {
  const limit = DISPLAY_LIMIT[orientation] || DISPLAY_LIMIT.landscape
  const { cues, errors } = parseSrt(srt)
  if (!cues.length) return { srt, split: 0, cues, errors }
  const out = []
  let split = 0
  for (const cue of cues) {
    if (cueChars(cue.text) <= limit) {
      out.push(cue)
      continue
    }
    const rest = String(cue.text)
    const parts = []
    let tail = rest
    const separators = /[，、；;]/gu
    while (parts.length < 12) {
      const match = separators.exec(tail)
      if (!match) break
      parts.push(tail.slice(0, match.index + 1))
      tail = tail.slice(match.index + 1)
    }
    if (tail) parts.push(tail)
    const pieces = parts.length >= 2 ? balanceByChars(parts, limit) : hardSplit(rest, limit)
    if (pieces.length < 2) {
      out.push(cue)
      continue
    }
    split += 1
    const weight = pieces.reduce((sum, piece) => sum + cueChars(piece), 0) || 1
    let cursor = cue.startMs
    pieces.forEach((piece, index) => {
      const isLast = index === pieces.length - 1
      const share = Math.max(1, Math.round((cueChars(piece) / weight) * cue.durationMs))
      const endMs = isLast ? cue.endMs : Math.min(cue.endMs, cursor + share)
      const startMs = cursor
      cursor = endMs
      out.push({ startMs, endMs: Math.max(startMs + 200, endMs), text: piece })
    })
  }
  return { srt: serializeSrt(out), split, cues: out, errors }
}
