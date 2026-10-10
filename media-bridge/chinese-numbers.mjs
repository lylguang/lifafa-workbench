// 阿拉伯数字 → 中文读法（口播配音用）
//
// LongCat-AudioDiT 遇到阿拉伯数字会按英文念：文案里的「GPT-6」出来是「GPT six」、
// 「50%」出来是「fifty percent」。中文口播必须在送进模型前换成汉字读法。
// 只改写送进 TTS 的文本：字幕仍用工作台原稿，屏幕上的阿拉伯数字不受影响。

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const SMALL_UNITS = ['', '十', '百', '千']
const GROUP_UNITS = ['', '万', '亿', '万亿']
// 「2」在日期单位前读二（二月、二号），在序数前缀后也读二（第 2 个、周 2）
const DATE_UNITS = new Set(['年', '月', '日', '号'])
const ORDINAL_PREFIX = new Set(['第', '周', '星', '期', '礼'])

/** 逐位读，用于年份、编号、手机号：2026 → 二零二六 */
export function digitsToChinese(digits) {
  let out = ''
  for (const ch of String(digits)) {
    const value = ch.charCodeAt(0) - 48
    out += value >= 0 && value <= 9 ? DIGITS[value] : ch
  }
  return out
}

/** 四位以内的整数段：1001 → 一千零一 */
function fourToChinese(group) {
  const str = String(group).replace(/^0+/, '')
  if (!str) return ''
  let out = ''
  let zeroPending = false
  for (let i = 0; i < str.length; i++) {
    const digit = str.charCodeAt(i) - 48
    if (digit === 0) { zeroPending = true; continue }
    if (zeroPending && out) out += '零'
    zeroPending = false
    out += DIGITS[digit] + SMALL_UNITS[str.length - 1 - i]
  }
  return out
}

/** 整数：100000 → 十万；10001 → 一万零一 */
export function intToChinese(value) {
  const str = String(value).replace(/^0+(?=\d)/, '')
  if (!str || str === '0') return '零'
  if (str.length > 16) return digitsToChinese(str) // 天文数字逐位读，不做万/亿分组
  const groups = []
  for (let end = str.length; end > 0; end -= 4) groups.unshift(str.slice(Math.max(0, end - 4), end))
  let out = ''
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (Number(group) === 0) {
      if (out && !out.endsWith('零')) out += '零'
      continue
    }
    // 该段高位缺位要补零：10001 → 一万零一
    if (out && Number(group) < 1000 && !out.endsWith('零')) out += '零'
    out += fourToChinese(group) + GROUP_UNITS[groups.length - 1 - i]
  }
  return out.replace(/零+$/, '').replace(/^一十/, '十') || '零'
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
const SHORT_TOKEN_RE = /^[a-z]{1,3}$/ // bf16、fp8、mp3、h264：小写短前缀是格式/精度标识，不转

/** 单个数字串 → 中文读法 */
function convertToken(token, { tail = '', prev = '', next = '' } = {}) {
  if (token.includes('.')) {
    const parts = token.split('.')
    // 版本号逐段读：3.14.3 → 三点一四点三
    if (parts.length > 2) return parts.map(digitsToChinese).join('点')
    return `${intToChinese(parts[0])}点${digitsToChinese(parts[1])}`
  }
  if (token.length > 1 && token[0] === '0') return digitsToChinese(token) // 编号：007 → 零零七
  if (token.length === 11 && token[0] === '1') return digitsToChinese(token) // 手机号
  if (token.length === 4 && tail === '年') return digitsToChinese(token) // 2026年 → 二零二六年
  if (token.length >= 3 && /[a-z]/.test(next)) return digitsToChinese(token) // 1080p → 一零八零p
  if (Number(token) === 2 && tail && !DATE_UNITS.has(tail) && !ORDINAL_PREFIX.has(prev)) return '两'
  return intToChinese(token)
}

// 前一个字符决定这段数字是不是标识符的一部分（URL、路径、模型名、精度标识），是就整段不碰
function shouldSkip(prev, next, before) {
  if (next && /[/\\_@=&]/.test(next)) return true
  if (!prev) return false
  if (/[/\\_@=&:%％.]/.test(prev)) return true // 127.0.0.1、端口号、时刻、小数点后段
  if (prev === '-') return !/[A-Z]/.test(before.slice(-2, -1)) // GPT-6 转；mp-3 不转
  if (/[A-Za-z]/.test(prev)) {
    if (/[A-Z]/.test(prev)) return false // 全大写前缀是型号：V4.1、GPT-4o 转
    return SHORT_TOKEN_RE.test(/[A-Za-z]+$/.exec(before)?.[0] ?? '') // bf16、mp3 不转；Qwen3 转
  }
  return false
}

const TOKEN_RE = /([ \t\u3000]?)(\d+(?:\.\d+)*)([ \t\u3000]*(?:[%％]|[\u4e00-\u9fff])?)/g

/**
 * 把文案里的阿拉伯数字改写成中文读法，供 TTS 合成使用。
 * 没有数字时原样返回，可以安全地在每次合成前调用。
 */
export function normalizeSpeechNumbers(input) {
  let text = String(input ?? '')
  if (/[０-９]/.test(text)) text = text.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  if (!/\d/.test(text)) return text

  // 只吃横向空白，不跨行：跨行会吃掉段落换行，也会把「200\n- 300」这类列表项误判成区间
  const HS = '[ \\t\\u3000]'
  // 负号：紧跟汉字或空格后的 -50 读负，行首的列表项「- 3」不受影响
  text = text.replace(/(?<=[\u4e00-\u9fff ])-(?=\d)/g, '负')
  // 带连字符的日期：2026-09-28 → 二零二六年九月二十八日
  text = text.replace(new RegExp(`(?<!\\d)${HS}*(\\d{4})-(\\d{1,2})-(\\d{1,2})(?!\\d)${HS}*`, 'g'),
    (_, y, m, d) => `${digitsToChinese(y)}年${intToChinese(m)}月${intToChinese(d)}日`)
  // 时刻：10:30 → 十点三十分
  text = text.replace(new RegExp(`(?<!\\d)${HS}*(\\d{1,2}):(\\d{2})(?!\\d)${HS}*`, 'g'),
    (_, h, m) => `${intToChinese(h)}点${m === '00' ? '整' : `${intToChinese(m)}分`}`)
  // 区间：3-5 天 → 三到五天
  text = text.replace(new RegExp(`(?<![\\dA-Za-z.])${HS}*(\\d+(?:\\.\\d+)?)${HS}*[-~—]${HS}*(\\d+(?:\\.\\d+)?)(?![\\dA-Za-z])${HS}*`, 'g'),
    (_, a, b) => `${convertToken(a)}到${convertToken(b)}`)

  text = text.replace(TOKEN_RE, (match, lead, digits, tail, offset, whole) => {
    const start = offset + lead.length
    const before = whole.slice(0, start)
    // 取前一个非空白字符：「第 2 个」要按序数读成二，不能按量词读成两
    const prev = before.trimEnd().slice(-1)
    const next = whole[start + digits.length] ?? ''
    if (IPV4_RE.test(digits) || shouldSkip(prev, next, before)) return match
    const tailChar = tail.replace(/[ \t\u3000]/g, '')
    if (tailChar === '%' || tailChar === '％') return `百分之${convertToken(digits)}`
    // lead 一并吞掉：中文里数字与前后词之间不留空格，免得读出停顿
    return `${convertToken(digits, { tail: tailChar, prev, next })}${tailChar || tail}`
  })
  // 型号里的连字符去掉：GPT-6 → GPT六，免得模型在连字符处停顿
  return text.replace(/(?<=[A-Z])-(?=[\u4e00-\u9fff])/g, '').replace(/(?<=[\u4e00-\u9fff])-(?=[A-Z])/g, '')
}

export default normalizeSpeechNumbers
