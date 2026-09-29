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
