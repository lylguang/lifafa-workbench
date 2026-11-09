// 数字一致性校验器：稿件里出现的「看起来像热度/星数」的大数字，
// 必须能在该稿引用的信号素材里原样找到。找不到 = 编造。
//
// 依据：docs/39-github-trending-account-script-optimization.md §4.2
// 「正文出现的 star 数与 sourceSnapshot 里 GitHub 信号数值的��致性（这是最硬的一条）」
//
// 规则：
//   - 只校验 >= 1000 的整数型数字（千分位或裸数字），因为小于 1000 的数字
//     往往是稿子自己的结构计数（"三个方法"），不是引用的事实。
//   - 归一化：去千分位逗号；"6.5万" → 65000；"1.2k" → 1200。
//   - 信号里出现的数字集合 = 信号文本里所有数字（同样归一化）加上 hotValue/rank。
//   - 稿件数字只要在信号数字集合里，就判为有据；否则判为疑似编造。

const THRESHOLD = 1000

/**
 * 年份不是引用事实，但**不能按数值区间判**：2088 也是 1900–2100 之间的合法
 * 星数，用区间会把它当成年份放过。所以只认「2026年」这种带年字的上下文。
 */
function yearNumbersIn(text) {
  const years = new Set()
  for (const m of String(text ?? '').matchAll(/(\d{4})\s*年/gu)) {
    const value = Number(m[1])
    if (value >= 1900 && value <= 2100) years.add(value)
  }
  return years
}

/**
 * 中文数字。
 *
 * 中文口播稿里「六万五」「两万五千三百」是自然表达，纯数字正则一个都抓不到，
 * 于是这一整类事实既判不了有据、也判不了编造——校验器对最可能的表述放弃了
 * 工作。这里把常见的位值读法读出来。
 *
 * 但**中文数字不参与「编造」判定**：「六万」与素材里的「65,243」并不是同一个
 * 数（口播里的「六万」是取整说法），拿严格相等去比就是把正常表达判成编造。
 * 所以中文数字只用来给阿拉伯数字做**跨写法匹配**（素材写「六万五」、正文写
 *「65,000」应当算对得上），正文里的中文数字一律记为「无法判定」而不是「编造」。
 */
const CHINESE_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CHINESE_SMALL_UNIT = { 十: 10, 百: 100, 千: 1000 }
const CHINESE_DIGIT_CHARS = new Set(Object.keys(CHINESE_DIGIT))
const CHINESE_SMALL_UNIT_CHARS = new Set(Object.keys(CHINESE_SMALL_UNIT))
const CHINESE_BIG_UNIT_CHARS = new Set(['万', '亿'])

function isChineseNumeralChar(ch) {
  return CHINESE_DIGIT_CHARS.has(ch) || CHINESE_SMALL_UNIT_CHARS.has(ch) || CHINESE_BIG_UNIT_CHARS.has(ch)
}

/**
 * 读一串中文数字。
 *
 * 返回 null 表示这串读不出精确值（「两百多」这种模糊说法就属于此类）。
 * 支持：六万五 → 65000、一万三 → 13000、二十亿 → 2000000000、三千 → 3000、
 * 两百五十 → 250。
 */
function parseChineseNumber(chunk) {
  let total = 0
  let section = 0
  let number = 0
  let sawAny = false
  let lastBigUnit = 0
  let index = 0
  while (index < chunk.length) {
    const ch = chunk[index]
    if (ch in CHINESE_DIGIT) { number = CHINESE_DIGIT[ch]; sawAny = true; index += 1; continue }
    if (ch in CHINESE_SMALL_UNIT) {
      const next = chunk[index + 1]
      // 「千」后面不跟数字时，它多半是别的词的一部分（千瓦、百十），不算数位。
      if (!next || !isChineseNumeralChar(next)) break
      section += (number === 0 ? 1 : number) * CHINESE_SMALL_UNIT[ch]
      number = 0
      sawAny = true
      index += 1
      continue
    }
    if (ch === '万' && chunk[index + 1] === '亿') {
      total += (section + number) * 10_000
      total *= 1_000_000
      section = 0; number = 0; lastBigUnit = 1_0000_0000_0000
      sawAny = true
      index += 2
      continue
    }
    if (ch === '万' || ch === '亿') {
      total += (section + number) * (ch === '万' ? 10_000 : 100_000_000)
      section = 0; number = 0; lastBigUnit = ch === '万' ? 10_000 : 100_000_000
      sawAny = true
      index += 1
      continue
    }
    break
  }
  if (!sawAny) return null
  if (number > 0) {
    // 口语里的省略量级：「六万五」= 65000、「一万三」= 13000。
    if (lastBigUnit === 10_000 && section === 0) total += number * 1000
    else if (lastBigUnit === 100_000_000 && section === 0) total += number * 10_000_000
    else total += number
  }
  total += section
  return total > 0 ? total : null
}

/** 从一段文本里抽出中文写出来的数量（读不出精确值的就跳过）。 */
function extractChineseNumbers(text) {
  const out = new Set()
  const source = String(text ?? '')
  let index = 0
  while (index < source.length) {
    if (!isChineseNumeralChar(source[index])) { index += 1; continue }
    const start = index
    while (index < source.length && isChineseNumeralChar(source[index])) index += 1
    const value = parseChineseNumber(source.slice(start, index))
    if (value != null) out.add(value)
  }
  return out
}

/**
 * 中文数量单位。
 *
 * 只认「万 / 亿 / 万亿」这类中文量词。`k` / `M` 不收：英文里 `10 min`、
 * `5 km`、`24 kWh`、`1,200 members` 里的字母紧跟数字，把它们当成千/兆
 * 会把完全正常的句子判成编造——而这个校验已经接到生产链路上。
 * 中文稿子里「六万五」这类纯中文数字同样不收（见 README 注释的盲区说明），
 * 抓不到就当抓不到，不能猜。
 */
const UNIT_MULTIPLIERS = [
  { pattern: /万亿/u, multiplier: 1_0000_0000_0000 },
  { pattern: /亿/u, multiplier: 100_000_000 },
  { pattern: /万/u, multiplier: 10_000 },
]

function normalizeNumber(raw) {
  const text = String(raw ?? '').replace(/,/g, '').trim()
  if (!text) return null
  let multiplier = 1
  for (const unit of UNIT_MULTIPLIERS) {
    if (unit.pattern.test(text)) { multiplier = unit.multiplier; break }
  }
  const value = Number(text.replace(/[^\d.]/g, ''))
  return Number.isFinite(value) ? Math.round(value * multiplier) : null
}

/**
 * 日期、IP、版本号里的数字不是「引用的事实」。
 *
 * 「2026-11-08」「192.168.1.1」「v1.2.3」里的数字段都 >= 1000，
 * 不排掉就会把正常正文判成编造——而这个校验已经接到生产链路上，
 * 误报会直接出现在用户的质检建议里，所以必须先排掉。
 */
function structuralNumbersIn(text) {
  const source = String(text ?? '')
  const out = new Set()
  for (const m of source.matchAll(/\d{1,4}[-/.]\d{1,4}(?:[-/.]\d{1,4})+/g)) {
    for (const part of m[0].split(/[-/.]/u)) {
      const n = Number(part)
      if (Number.isFinite(n)) out.add(n)
    }
  }
  return out
}

/**
 * 从一段文本里抽出所有「可被引用的数字」，统一成整数集合。
 *
 * `includeChinese` 控制中文数字是否计入。信号侧要计（素材写「六万五」，
 * 正文写「65,000」应当算对得上）；正文侧不计（口播里的「六万」是取整说法，
 * 拿它跟素材的精确值比会误判成编造）。
 */
export function extractNumbers(text, { includeChinese = true } = {}) {
  const out = new Set()
  const source = String(text ?? '')
  const structural = structuralNumbersIn(source)
  // 千分位形式：65,243
  for (const m of source.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g)) {
    const n = normalizeNumber(m[0])
    if (n != null) out.add(n)
  }
  // 万/亿形式：6.5万 / 1.2亿 / 2.8万亿（万亿必须排在万前面，否则只匹配到「万」）
  for (const m of source.matchAll(/\d+(?:\.\d+)?\s*万亿|\d+(?:\.\d+)?\s*[万亿]/gu)) {
    const n = normalizeNumber(m[0])
    if (n != null) out.add(n)
  }
  // 裸整数（不含上面已覆盖的形态）：仅取 >= 1000 且不带小数
  // 句末的「12000.」必须算进 12000，所以小数点只有在后面还跟着数字时才算小数点。
  for (const m of source.matchAll(/(?<![\d.,])\d{4,}(?!\d)(?!(?:[.,]\d))/gu)) {
    const n = Number(m[0])
    if (Number.isFinite(n)) out.add(n)
  }
  for (const n of structural) out.delete(n)
  if (includeChinese) {
    for (const n of extractChineseNumbers(source)) out.add(n)
  }
  return out
}

/**
 * @param {string} body 稿件正文
 * @param {Array<{text?:string, hotValue?:number|null, rank?:number|null, summary?:string, title?:string}>} signals 引用到的信号
 * @returns {{consistent:boolean, cited:number[], unsupported:number[], signalNumbers:number[]}}
 */
export function checkNumberConsistency(body, signals = []) {
  const signalNumbers = new Set()
  for (const signal of signals || []) {
    for (const n of extractNumbers(signal.text)) signalNumbers.add(n)
    for (const n of extractNumbers(signal.summary)) signalNumbers.add(n)
    for (const n of extractNumbers(signal.title)) signalNumbers.add(n)
    if (Number.isFinite(signal.hotValue)) signalNumbers.add(Math.round(signal.hotValue))
    if (Number.isFinite(signal.rank)) signalNumbers.add(Math.round(signal.rank))
  }
  const bodyYears = yearNumbersIn(body)
  // 正文侧不收中文数字（见 extractNumbers 的 includeChinese 说明）。
  const bodyNumbers = [...extractNumbers(body, { includeChinese: false })]
    .filter((n) => n >= THRESHOLD && !bodyYears.has(n))
    .sort((a, b) => a - b)
  const cited = bodyNumbers.filter((n) => signalNumbers.has(n))
  const unsupported = bodyNumbers.filter((n) => !signalNumbers.has(n))
  return { consistent: unsupported.length === 0, cited, unsupported, signalNumbers: [...signalNumbers].sort((a, b) => a - b) }
}
