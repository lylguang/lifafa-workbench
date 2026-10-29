/**
 * 封面成图：底图 + 本地叠字。
 *
 * 分工与 spoken-video 一致但理由更硬：中文大字绝不交给生图模型。情感故事的封面
 * 就是「一句话压在情绪底图上」，字糊了整个封面的信息量就归零。所以：
 *
 *   底图 —— 生图模型出（只负责情绪与光），并要求预留标题区
 *   文字 —— ffmpeg drawtext 渲染，字体文件里本来就有标准字形，必定正确
 *
 * 不叠字的兜底也要留着：没装字体、底图尺寸不认识时，宁可交一张没字的底图给
 * 人工处理，也不要产出一张字压在人物脸上的图。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 中文字体候选，粗黑优先。找不到就返回 null，由调用方决定降级。 */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/Dengb.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
]

export const STORY_COVER_SIZE = Object.freeze({ width: 1080, height: 1440 })

export function pickStoryFont() {
  return FONT_CANDIDATES.find((file) => existsSync(file)) || null
}

/**
 * 封面版式。
 *
 * 竖屏 3:4（1080×1440）是抖音封面的原生比例：信息流里封面按这个比例裁，
 * 用 9:16 会被上下切掉标题。
 *
 * 字号由「目标每行字数」倒推，而不是只按高度给一个比例。2026 实测：按高度
 * 0.085 算出 116px，一行只装得下 8 个字——「离婚那天他给我发/了条微信让我把鱼
 * 吃完」这种从词中间劈开的折行，读起来是断的。所以按每行 10 字倒推，
 * 得到 92px，一行 10 字刚好装下。
 */
export function storyCoverLayout({ width = STORY_COVER_SIZE.width, height = STORY_COVER_SIZE.height } = {}) {
  const sideMargin = Math.round(width * 0.07)
  const usable = width - sideMargin * 2
  const TARGET_CHARS_PER_LINE = 10
  const byHeight = Math.round(height * 0.085)
  const byWidth = Math.floor(usable / TARGET_CHARS_PER_LINE)
  const fontSize = Math.max(28, Math.min(byHeight, byWidth))
  return {
    fontSize,
    sideMargin,
    targetCharsPerLine: TARGET_CHARS_PER_LINE,
    // 标题压在下三分之一：上三分之二留给情绪底图（脸、手、窗、锅），
    // 压在中间会盖住主体。
    bottom: Math.round(height * 0.16),
    lineGapRatio: 1.32,
    maxLines: 2,
    borderWidth: Math.max(2, Math.round(height * 0.005)),
    barHeightRatio: 0.30,
  }
}

/**
 * 折行时优先在标点处断；没有标点就在虚词处断。
 *
 * 中文没有空格，硬按字数切会把「发了」和「条微信」劈开。这里在窗口内从后往前
 * 找一个「断在这里仍然通顺」的位置：标点最优先，其次的/和/把/在/给/让/他/她
 * 这类虚词与代词之后。
 */
const SOFT_BREAK_AFTER = /[的了着过和与在是把被让给为对从又也才就都还更最然后而且所以但是因]|[他她我你它们这那哪]/u
/** 明确不能落在行首的字：量词、结构助词。断在它们前面读起来是断的。 */
const NEVER_LINE_START = /^[条个只件张份次回口天年月的了着过得地所之而且并或者以及]/u

export function wrapStoryHeadline(headline, maxCharsPerLine, maxLines = 2) {
  const text = String(headline || '').trim()
  if (!text) return []
  const chars = [...text]
  if (chars.length <= maxCharsPerLine) return [text]
  const lines = []
  let rest = text
  while (rest && lines.length < maxLines) {
    const available = [...rest]
    if (available.length <= maxCharsPerLine) { lines.push(rest); rest = ''; break }
    const window = available.slice(0, maxCharsPerLine + 1)
    const floor = Math.max(2, Math.floor(maxCharsPerLine * 0.6))

    // 候选断点统一成「切在这里，下一行从 cut 开始」的判定。
    // 一条硬规则贯穿所有候选：**断点后一个字不能是虚词/量词**。任何把它顶到
    // 行首的方案都直接作废，回退到等分再退一格。
    const acceptable = (cut) => cut >= floor && cut < available.length && !NEVER_LINE_START.test(available[cut] || '')

    let cut = 0
    // 1) 标点之后
    const punctuation = window.findLastIndex((char) => /[，,。.、；;！!？?：:\s]/u.test(char))
    if (punctuation >= floor && acceptable(punctuation + 1)) cut = punctuation + 1
    // 2) 虚词之后
    if (!cut) {
      for (let index = Math.min(window.length - 1, maxCharsPerLine); index >= floor; index -= 1) {
        if (SOFT_BREAK_AFTER.test(window[index]) && acceptable(index + 1)) { cut = index + 1; break }
      }
    }
    // 3) 等分，必要时往回让字
    if (!cut) {
      cut = Math.min(maxCharsPerLine, available.length - 1)
      while (cut > floor && NEVER_LINE_START.test(available[cut] || '')) cut -= 1
    }
    lines.push(available.slice(0, cut).join('').trim())
    rest = available.slice(cut).join('').trim()
  }
  // 两行仍装不下时，把剩下的全塞进最后一行，而不是丢掉——宁可让最后一行
  // 略长（上层会按实际字数压字号），也不能吞掉观众该看到的话。
  if (rest && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1]}${rest}`
  return lines.filter(Boolean)
}

/** ffmpeg drawtext 的转义：冒号、单引号、反斜杠、百分号都要挡掉。 */
export function escapeDrawText(text) {
  return String(text || '')
    .replace(/\\/gu, '\\\\\\\\')
    .replace(/'/gu, '\u2019')
    .replace(/:/gu, '\\:')
    .replace(/%/gu, '\\%')
}

/** 没有生图服务时的确定性封面：纯色底 + 大字，保证发布资料永远有封面可用。 */
export async function renderPlainStoryCover({ outputPath, headline, palette = { background: '#2A211E', accent: '#D98E63' }, size = STORY_COVER_SIZE }) {
  const font = pickStoryFont()
  const layout = storyCoverLayout(size)
  const lines = wrapStoryHeadline(headline, Math.max(4, Math.floor((size.width - layout.sideMargin * 2) / layout.fontSize)), layout.maxLines)
  const color = String(palette.background || '#2A211E').replace('#', '')
  if (!font || !lines.length) return { applied: false, reason: !font ? 'no-font' : 'no-headline' }
  const blockHeight = Math.round(lines.length * layout.fontSize * layout.lineGapRatio)
  const top = Math.round((size.height - blockHeight) / 2)
  const filters = lines.map((line, index) =>
    `drawtext=fontfile='${escapeFontPath(font)}':text='${escapeDrawText(line)}'`
    + `:fontcolor=white:fontsize=${layout.fontSize}`
    + `:x=(w-text_w)/2:y=${top + Math.round(index * layout.fontSize * layout.lineGapRatio)}`
    + `:borderw=${layout.borderWidth}:bordercolor=black@0.9`)
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x${color}:s=${size.width}x${size.height}`,
      '-vf', filters.join(','),
      '-frames:v', '1',
      outputPath,
    ], { windowsHide: true, timeout: 60_000 })
    return { applied: true, lines: lines.length, headline: lines.join(''), fontSize: layout.fontSize, size, background: 'solid' }
  } catch (error) {
    return { applied: false, reason: 'ffmpeg-failed', detail: String(error?.message || error).slice(0, 200) }
  }
}
