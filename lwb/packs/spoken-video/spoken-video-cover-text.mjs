// 封面标题叠加：底图由生图模型出，**中文标题由程序叠上去**。
//
// 为什么不让 AI 直接写标题（2026-10-08 实测与调研）：通义万相等主流生图模型是
// 「画」字而不是「写」字，汉字会缺笔画或变成乱码——官方文档也明说中文只能生成为
// 图像像素、无法保证可编辑。所以分工是：底图留出干净的标题区，文字用 ffmpeg 的
// drawtext（libfreetype）渲染，字体文件里本来就有标准字形，输出必定正确。
//
// 为什么叠字是刚需：纯图形封面在信息流缩略图（3:4、拇指大小）里辨识度很低，
// 用户看不出这条视频讲什么。业界做知识类内容普遍走「大字 + 底图」路线。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

/** 中文字体候选，按「粗黑优先」排序；找不到就用系统里任何一个可用的。 */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyhbd.ttc',   // 微软雅黑 Bold
  'C:/Windows/Fonts/msyh.ttc',     // 微软雅黑
  'C:/Windows/Fonts/Dengb.ttf',    // 等线 Bold
  'C:/Windows/Fonts/simhei.ttf',   // 黑体
  'C:/Windows/Fonts/simsun.ttc',   // 宋体
]

export function pickCoverFont() {
  return FONT_CANDIDATES.find((file) => existsSync(file)) || null
}

/**
 * 从发布标题里取出适合压在封面上的短句。
 *
 * 封面字要少：信息流缩略图里 4-8 字最易读，太多就糊成一片。这里的策略是
 * 先按标点切句，再按语义边界（数字/英文/对比转折）切，最后按字数截断——
 * 不引入分词依赖，避免为一个封面挂一个中文分词库。
 */
export function coverHeadline(title, maxChars = 12) {
  const text = String(title || '').trim()
  if (!text) return ''
  // 引号内容要在清洗前提取——「别再给 AI 甩一句『你换个攻略』」里的引号内
  // 本身就是一个完整钩子，比外层被切碎的「甩一句你换」好得多。
  const quoted = (text.match(/[「『""'']([^」』""'']{2,12})[」』""'']/u) || [])[1]
  // 去掉书名号/引号等包裹符，它们在封面上是噪音
  const cleaned = text.replace(/[《》「」『』""'']/gu, '').trim()
  // 优先用冒号/破折号/问号前的部分——「A：B」里 A 通常就是钩子
  const head = cleaned.split(/[：:—–]|（|\(|。|！|!|？|\?/u)[0].trim() || cleaned
  const source = head.length >= 4 ? head : cleaned
  if (source.length <= maxChars) return source
  // 逗号是中文标题里最好的语义边界
  const chunks = source.split(/[，,、]/u).map((c) => c.trim()).filter(Boolean)
  if (chunks.length > 1 && chunks[0].length <= maxChars) return chunks[0]
  // 首段仍超长：引号内那句话有时正好可用（「平台把成本压到『发1万单倒赔130』」），
  // 但只有它本身够长、脱离上下文也读得懂时才用——「你换个攻略」这种就不行。
  const quotedText = quoted ? quoted.trim() : ''
  if (quotedText.length >= 6 && quotedText.length <= maxChars) return quotedText
  // 仍超长：找语义边界（助词/连词/量词之后），避免把词组切在中间
  const chars = [...source]
  const BOUNDARY = /[的了和与在是就不也都还把被让给从对为单双满半第每又也就才]|[0-9]万[单次本]?/u
  for (let i = Math.min(chars.length, maxChars + 3); i >= 5; i -= 1) {
    if (BOUNDARY.test(chars[i - 1] || '')) return chars.slice(0, i).join('')
  }
  return chars.slice(0, maxChars).join('')
}

/**
 * 封面版式参数。数值来自短视频信息流的物理约束：缩略图只有拇指大小，
 * 字号必须占画面足够比例才读得清；顶部留白区要和 buildPublishPrompt 里
 * 要求生图模型预留的区域对齐，否则字会压在图形上。
 */
export function coverLayoutFor(kind, width, height) {
  const landscape = kind === 'landscape'
  const sideMargin = Math.round(width * 0.06)
  // 字号同时受两个约束，取更紧的那个：
  //  · 高占比才在缩略图里读得清（信息流里封面只有拇指大小）；
  //  · 一行至少要装得下 MIN_CHARS_PER_LINE 个中文字，否则标题会被截掉后半句。
  // 竖屏 3:4 是宽度受限的典型：1440 高但只有 1088 宽，纯按高度算字号会得到 98px，
  // 每行只装得下 9 个字（「苹果收紧 Mac 磁盘权限」就在这里断了，2026-10-08 实测）。
  // 所以宽度那条要按「每行目标字数」倒推字号，而不是只做上限——1088 宽装 12 个字
  // 需要 79px，比高度给的 98px 小，于是取 79。
  const MIN_CHARS_PER_LINE = 12
  const usable = width - sideMargin * 2
  const byHeight = Math.round(height * (landscape ? 0.082 : 0.068))
  const byWidth = Math.floor(usable / MIN_CHARS_PER_LINE)
  const fontSize = Math.max(24, Math.min(byHeight, byWidth))
  return {
    fontSize,
    // 与提示词里的预留区对齐：横屏顶部 18%，竖屏顶部 22%
    top: Math.round(height * (landscape ? 0.055 : 0.05)),
    sideMargin,
    lineGapRatio: 1.24,
    maxLines: 2,
    borderWidth: Math.max(2, Math.round(height * 0.006)),
  }
}

/**
 * 把标题折成最多 maxLines 行。
 *
 * 不能按字数硬折（2026-10-08 实测：「苹果收紧 Mac 磁盘权 / 限」把「权限」劈开、
 * 第二行只剩一个「限」字）。这里在不超过每行容量的前提下，优先在标点处断——
 * 逗号、顿号、空格、引号后都是自然的语义边界，实在找不到就从后往前找靠后的位置。
 * 单行放不下时才退化为硬折，保证不会溢出画面。
 */
export function wrapCoverHeadline(headline, maxCharsPerLine, maxLines) {
  const text = String(headline || '').trim()
  if (!text) return []
  const lines = []
  let rest = text
  // 断行后可以丢的：断点处的标点本身。**不要吞空格**——「Mac 磁盘」中间那个空格
  // 是词内分隔，吞掉拼回去就不是原串了（2026-10-08 实测踩过）。行首空格由末尾的
  // trim 统一处理，不影响显示。
  const LEADING_NOISE = /^[，,、；;：:。！!？?）)】」』]+/u
  // 语义边界：这些标点之后断行最自然；空格也算，但断点落在其后、空格留到下一行。
  const BOUNDARY = /[，,、；;：:。！!？?）)】」』\s]/u
  while (rest && lines.length < maxLines - 1) {
    if ([...rest].length <= maxCharsPerLine) break
    const take = Math.min([...rest].length, maxCharsPerLine)
    // 在容量内从后往前找最后一个边界；没有就硬折
    const head = [...rest].slice(0, take).join('')
    let cut = -1
    for (let i = head.length - 1; i >= Math.ceil(maxCharsPerLine * 0.5); i -= 1) {
      if (BOUNDARY.test(head[i - 1] || '')) { cut = i; break }
    }
    if (cut < 0) cut = take
    // 断点落在空白上时，空白跟着下一行走：留在本行末尾会让「Mac | 磁盘」拼回时
    // 变成「Mac磁盘」（2026-10-08 实测：两行拼起来必须等于原串）。
    let head1 = head.slice(0, cut)
    let tail = [...rest].slice(cut).join('')
    if (/\s$/u.test(head1)) { tail = head1.slice(-1) + tail; head1 = head1.slice(0, -1) }
    lines.push(head1)
    rest = tail.replace(LEADING_NOISE, '')
  }
  if (rest) lines.push(rest)
  return lines.slice(0, maxLines).map((line) => line.trim()).filter(Boolean)
}

/** ffmpeg 的 filter 参数里 `:`、'`'、`\` 都有特殊含义，必须转义。 */
function escapeDrawtext(value) {
  return String(value)
    .replace(/\\/gu, '\\\\\\\\')
    .replace(/'/gu, "’")
    .replace(/:/gu, '\\:')
    .replace(/%/gu, '\\%')
}

/**
 * 字体文件路径要单独转义：盘符的冒号必须写成 `C\:`，而 Windows 路径里的
 * 反斜杠是**字面量**、不能当转义符消掉。走通用 escapeDrawtext 会把
 * `C:\Windows` 变成 `C:\Windows`（反斜杠被吃），ffmpeg 报
 * "No option name near '/Windows/Fonts/...'"。这里只转义冒号，分隔符换正斜杠。
 */
function escapeFontPath(file) {
  return String(file).replace(/\\/gu, '/').replace(/:/gu, '\\:')
}

/**
 * 探测标题区是否已被底图占用。
 *
 * 为什么需要（2026-10-08 实测）：提示词已经要求生图模型「顶部 18% 留空」，但模型
 * 并不总是照做——实际出过时钟图标和「昨天/今天」标签穿进标题区，和叠加的标题叠在
 * 一起，既看不清字也看不清图。这里用 ffmpeg 把标题区单独导出成一张小图，统计它
 * 的**局部对比度**：留空区应当是平滑的纯色（相邻像素差很小），一旦有图标、文字或
 * 明显边界，对比度就会升高。
 *
 * 阈值取 12（0-255 的平均绝对差）。纯色渐变通常 < 6，图标/文字边缘会 > 20。
 */
export async function titleZoneBusy(inputPath, { kind, width, height }) {
  const layout = coverLayoutFor(kind, width, height)
  const zoneHeight = Math.max(8, Math.round(height * (kind === 'landscape' ? 0.18 : 0.22)))
  try {
    // scale 到 64px 宽只为省算力；边缘检测滤镜放大细节差异，再取信号平均。
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-i', inputPath,
      '-vf', `crop=${width}:${zoneHeight}:0:0,scale=64:-1,edgedetect=low=0.1:high=0.5,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      '-frames:v', '1', '-f', 'null', '-'], { timeout: 30_000, windowsHide: true })
    const match = String(stderr).match(/lavfi\.signalstats\.YAVG=([\d.]+)/u)
    if (!match) return null
    const value = Number(match[1])
    if (!Number.isFinite(value)) return null
    return { busy: value > 12, edgeEnergy: Number(value.toFixed(1)), zoneHeight, zoneTop: layout.top }
  } catch {
    return null // 探测不了就当没占用，不因此放弃叠字
  }
}

/**
 * 检标题区里有没有画上标题。
 *
 * 现在标题由 AI 直接写进封面（2026-10-08 实测本机 Qwen-Image 写汉字零乱码，
 * 横竖两版一次成功），所以这里不做叠字，只做质检：AI 没写、或写得太小看不清时，
 * 标题区会是一片纯色，边缘检测的能量就极低。检出这种情况就该重生封面。
 *
 * 检查范围取顶部 45%——艺术字标题带描边和倾斜，实际占画面上半部近一半，只看顶部
 * 18% 会漏判（2026-10-08 实测：箭头穿进顶部 18% 时旧阈值报 busy=false）。
 */
export async function inspectCoverTitleZone(inputPath, { width, height, kind }) {
  const landscape = kind === 'landscape'
  const zoneHeight = Math.max(8, Math.round(height * (landscape ? 0.42 : 0.5)))
  try {
    // scale 到 96px 宽只为省算力；edgedetect 放大笔画与描边的边缘，再取平均信号强度。
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-i', inputPath,
      '-vf', `crop=${width}:${zoneHeight}:0:0,scale=96:-1,edgedetect=low=0.1:high=0.4,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      '-frames:v', '1', '-f', 'null', '-'], { timeout: 30_000, windowsHide: true })
    const match = String(stderr).match(/lavfi\.signalstats\.YAVG=([\d.]+)/u)
    if (!match) return null
    const value = Number(match[1])
    if (!Number.isFinite(value)) return null
    // 阈值 18。实测四张真实封面的能量分布（2026-10-08）：
    //   AI 写的艺术字标题（粗体 + 6px 描边 + 投影）→ 28 ~ 30
    //   工整白字标题 → 9.8
    //   完全没写标题的纯底图（夜空 + 集装箱 + 货轮 + 箭头）→ 7.7
    // 纯底图本身就有货轮桅杆、集装箱边缘这些硬边，所以能量不是 0；取 18 能把
    // 「有标题」与「无标题但画面本身很繁复」分开。低于 18 只记事件提示重生，不阻断。
    return { busy: value > 18, edgeEnergy: Number(value.toFixed(2)), zoneHeight }
  } catch {
    return null // 探测不了不阻塞流程，交给人工判断
  }
}

/**
 * 给封面底图叠加中文标题。
 *
 * **已停用**（2026-10-08）：标题改由 AI 直接写进封面，效果更好且实测零乱码，
 * 程序叠字会盖住 AI 写的艺术字。保留本函数仅作历史参考与兜底测试，新流程走
 * `inspectCoverTitleZone` 质检。调用点见 spoken-video-publish-host.mjs 的
 * `#overlayCoverTitle`（已改为只质检、不叠字）。
 */
export async function overlayCoverHeadline(inputPath, outputPath, { kind, title, width, height, onZoneBusy }) {
  const font = pickCoverFont()
  const layout = coverLayoutFor(kind, width, height)
  const perLine = Math.max(4, Math.floor((width - layout.sideMargin * 2) / layout.fontSize))
  // 截断上限跟着版式走：两行就能装 perLine*2 个字，硬编码 12 会把钩子后半句切掉
  // （2026-10-08 实测：「同一个 AI 昨天还行、今天犯傻」只剩「同一个 AI 昨天还行」，
  // 真正有信息量的「今天犯傻」丢了）。上限再留一点余量，避免行尾只剩一两个字。
  const capacity = Math.max(6, perLine * layout.maxLines - 2)
  const headline = coverHeadline(title, capacity)
  if (!font || !headline) return { applied: false, reason: !font ? 'no-font' : 'no-headline' }

  const lines = wrapCoverHeadline(headline, perLine, layout.maxLines)
  if (!lines.length) return { applied: false, reason: 'no-headline' }

  // 先探标题区是否被底图占用。生图模型不总听「顶部留空」的话，实际出过时钟图标
  // 穿进标题位。检出来了照样叠字（半透明色条会盖住一部分），但把结果报给调用方，
  // 让人知道这张底图不合格、值得重生。
  const zone = await titleZoneBusy(inputPath, { kind, width, height })
  if (zone?.busy && typeof onZoneBusy === 'function') onZoneBusy(zone)

  // 每行一个 drawtext，用 y 递增排出多行。这版 ffmpeg（8.0）**没有 shadoww**，
  // 所以可读性靠两层：底部半透明色条（drawbox）+ 文字描边（borderw）。
  // 2026-10-08 实测：加了 shadoww 会直接报 "Option not found" 并让整张图失败。
  const filters = []
  const barHeight = Math.round(layout.fontSize * layout.lineGapRatio * lines.length)
  filters.push(
    `drawbox=x=0:y=0:w=${width}:h=${barHeight}:color=black@0.38:t=fill`,
  )
  lines.forEach((line, index) => {
    filters.push(
      `drawtext=fontfile='${escapeFontPath(font)}':text='${escapeDrawtext(line)}'`
      + `:fontcolor=white:fontsize=${layout.fontSize}`
      + `:x=${layout.sideMargin}:y=${layout.top + Math.round(index * layout.fontSize * layout.lineGapRatio)}`
      + `:borderw=${layout.borderWidth}:bordercolor=black@0.9`,
    )
  })

  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
      '-vf', filters.join(','), '-frames:v', '1', outputPath], { timeout: 60_000, windowsHide: true })
    return { applied: true, headline, lines: lines.length, fontSize: layout.fontSize, titleZoneBusy: Boolean(zone?.busy), titleZone: zone || null }
  } catch {
    return { applied: false, reason: 'ffmpeg-failed' }
  }
}

/** 探测图片尺寸，避免把 width/height 当成已知——调用方未必有 ffprobe。 */
export async function readImageSize(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { timeout: 20_000, windowsHide: true })
    const [w, h] = String(stdout).trim().split('x').map(Number)
    return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null
  } catch {
    return null
  }
}
