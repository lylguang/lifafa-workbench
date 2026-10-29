/**
 * 字幕：SRT 解析、校验、序列化与超长条目切分。
 *
 * 为什么单独一份而不复用通用包的：竖屏的可用字幕带宽比横屏窄得多，单行上限
 * 必须按短边算。通用包在竖屏下允许两行、每行 28 字，落到 1080 宽上字号会被
 * 迫缩到读不清。这里竖屏单行 16 字、横屏 28 字，是平台安全区实测值。
 */

const TIMECODE = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u

function timeToMs(value) {
  const match = TIMECODE.exec(String(value || '').trim())
  if (!match) return null
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4])
}

function msToTime(value) {
  const total = Math.max(0, Math.round(value))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/**
 * 解析 SRT。返回 cues 与结构性错误列表；有一条结构性错误就说明这份字幕不能
 * 拿去渲染（渲染侧会静默跳过坏块，观众看到的是字幕突然消失）。
 */
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

/** 单条字幕的字数（中文按字，英文按词折半）。 */
export function cueChars(text) {
  const raw = String(text || '').trim()
  if (!raw) return 0
  const han = (raw.match(/[\u4e00-\u9fff]/gu) || []).length
  const words = (raw.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/gu) || []).length
  return han + Math.ceil(words * 0.5)
}

export function srtMaxLineChars(orientation = 'portrait') {
  return orientation === 'landscape' ? 28 : 16
}

/**
 * 校验：除了结构，还给出统计量（条数、最长条目字数）。质检层要用到它们，
 * 所以这里一次性算完，避免上游再解析一遍。
 */
export function validateSrt(srt, { orientation = 'portrait' } = {}) {
  const { cues, errors } = parseSrt(srt)
  const maxLineChars = srtMaxLineChars(orientation)
  const lengths = cues.map((cue) => cueChars(cue.text.replace(/\n/gu, '')))
  const overLimit = cues.filter((cue, index) => lengths[index] > maxLineChars * 2)
  return {
    cues,
    errors,
    cueCount: cues.length,
    maxCueChars: lengths.length ? Math.max(...lengths) : 0,
    overLimitCount: overLimit.length,
    maxLineChars,
    // 超长条目只警告不报错：两行放得下的就让它放两行，硬切会把一句话切断。
    warnings: overLimit.length ? [`${overLimit.length} 条字幕超过两行容量（单行 ${maxLineChars} 字），渲染时会被迫缩小字号。`] : [],
  }
}

export function serializeSrt(cues) {
  return cues
    .map((cue, index) => `${index + 1}\n${msToTime(cue.startMs)} --> ${msToTime(cue.endMs)}\n${cue.text}`)
    .join('\n\n')
}

/**
 * 按标点把超长 cue 切成多条，时间按字数比例分配。
 *
 * 为什么按字数比例而不是均分：中文口播里停顿与字数是强相关的，均分会让后半句
 * 明显偏快。这是估算而非对齐——真正的对齐在配音阶段就有精确时间轴，这里只处理
 * 「导入了一份别人给的字幕」这种没有时间轴的兜底情形。
 */
export function splitLongCues(srt, { orientation = 'portrait' } = {}) {
  const maxLineChars = srtMaxLineChars(orientation)
  const limit = maxLineChars * 2
  const { cues, errors } = parseSrt(srt)
  if (errors.length) return { srt, cues, splitCount: 0, errors }
  const output = []
  let splitCount = 0
  for (const cue of cues) {
    const plain = cue.text.replace(/\n/gu, '')
    if (cueChars(plain) <= limit) { output.push(cue); continue }
    const sentences = plain.split(/(?<=[。！？!?…])/u).map((item) => item.trim()).filter(Boolean)
    const chunks = []
    let current = ''
    for (const sentence of sentences.length ? sentences : [plain]) {
      if (current && cueChars(current + sentence) > maxLineChars) { chunks.push(current); current = sentence } else current += sentence
    }
    if (current) chunks.push(current)
    const total = chunks.reduce((sum, chunk) => sum + Math.max(1, cueChars(chunk)), 0)
    let cursor = cue.startMs
    chunks.forEach((chunk, index) => {
      const weight = Math.max(1, cueChars(chunk)) / total
      const end = index === chunks.length - 1 ? cue.endMs : cursor + Math.round(cue.durationMs * weight)
      output.push({ startMs: cursor, endMs: end, durationMs: end - cursor, text: chunk })
      cursor = end
    })
    splitCount += 1
  }
  return { srt: serializeSrt(output), cues: output, splitCount, errors }
}
