/**
 * 反塑料感检查器 —— 本包最核心的一块。
 *
 * 要解决的问题：AI 写的情感故事读起来「合理但没有温度」。它不缺情节，缺的是
 * 毛边。观众说不出哪里不对，但会在第 8 秒划走——而平台只认完播率。
 *
 * 做法是把「人味」拆成可测量的几个维度，用确定性规则打分，而不是让模型自评。
 * 模型自评永远给 85 分以上，所以自评无效。
 *
 * 六项检查，每一项对应一个实测的翻车形态：
 *   bannedWords      套路词与升华句——AI 味的最大来源，命中即扣分（部分直接硬拦）
 *   aiCliches        「某种意义上」「不得不说」这类模型口癖
 *   dialogue         有没有一句人话对白；全篇旁白叙述是典型的 AI 结构
 *   concreteDetail   场景具体度（时间/地点/物品/数字），情感故事靠细节立住
 *   sentenceRhythm   句长是否均匀——均匀是 AI 特征，人的叙述有长有短
 *   ending           结尾是不是升华成道理；「我终于明白了」是最致命的收尾
 *
 * 设计原则：分数只用于提示与排序，**只有硬拦项拦截写稿落库**。软性问题进改写
 * 建议，因为「这句对白不够口语」是判断，不是事实，让机器一票否决会误杀好稿子。
 */

/** 硬拦：命中任意一条即判定不合格，必须重写。这些是「像 AI」的确定性证据。 */
export const HARD_BLOCKED = Object.freeze([
  { id: 'rebirth', name: '重生/穿越套路', re: /重生|穿越|夺舍|回到(?:那|这)一年/gu },
  { id: 'rich-family', name: '霸总/豪门套路', re: /霸总|总裁|豪门|富家(?:少爷|千金)|隐婚/gu },
  { id: 'melodrama', name: '狗血桥段', re: /车祸失忆|绝症|白血病|癌(?:症)?晚期|一尸两命|同归于尽/gu },
])

/**
 * 升华句：结尾把故事讲成道理。这是 AI 最爱的收尾方式，也是情感故事最不该有的
 * 收尾——观众要的是没说完的那一下，不是被总结。
 */
export const LIFTED_ENDINGS = Object.freeze([
  '我终于明白', '后来我才懂', '我这才明白', '我终于懂了', '我也就释怀了',
  '这就是人生', '人生就是这样', '原来爱是', '说到底', '所谓婚姻',
  '愿你', '希望每个人', '所以你要', '请记住', '你要相信',
])

/** 模型口癖：出现一次不致命，出现三次以上稿子就不可信了。 */
export const AI_CLICHES = Object.freeze([
  '某种意义上', '不得不说', '值得一提的是', '毋庸置疑', '总的来说', '综上所述',
  '不可否认', '令人深思', '无法言喻', '深深的触动', '久久不能平静', '内心受到了极大的震撼',
  '那一刻，仿佛', '空气中弥漫着', '五味杂陈', '百感交集',
])

/** 具体度锚点：情感故事靠这些立住场面。 */
const TIME_ANCHORS = /(?:凌晨|半夜|深夜|清晨|早上|中午|下午|傍晚|晚上|夜里|周末|周[一二三四五六日天]|过年|除夕|中秋节?|清明|那年|去年|今年|那天|那天晚上|\d{1,2}\s*点(?:半)?|\d{4}\s*年)/gu
const PLACE_ANCHORS = /(?:厨房|客厅|卧室|阳台|楼道|电梯|停车场|车里|医院|病房|菜市场|超市|便利店|银行|公司|办公室|教室|学校门口|火车站|高铁|机场|车站|饭桌|餐桌上|门口|楼下|巷子|老家|出租屋|公交|地铁)/gu
const OBJECT_ANCHORS = /(?:锅|碗|筷子|勺|信封|工资卡|银行卡|存折|钥匙|手机|微信|短信|转账|戒指|首饰|药|病历|单子|照片|相册|被子|拖鞋|饭盒|保温杯|伞|毛衣|围巾|行李箱|行李箱轮子|外卖|账单|水电费|房租|贷款|红包|彩礼|嫁妆)/gu
const NUMBER_ANCHORS = /\d+/gu

const SENTENCE_SPLIT = /[。！？!?…]+/u

function chars(value) { return Array.from(String(value || '')) }

function compact(value) { return String(value || '').replace(/\s+/g, '') }

function countMatches(text, pattern) {
  const found = String(text || '').match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
  return found ? found.length : 0
}

export function splitSentences(body) {
  return String(body || '')
    .split(SENTENCE_SPLIT)
    .map((sentence) => compact(sentence))
    .filter(Boolean)
}

export function splitParagraphs(body) {
  return String(body || '').split(/\n\s*\n|\r?\n/).map((item) => item.trim()).filter(Boolean)
}

/**
 * 对白检出：中文引号、直角引号、或「某人说：」后面的直接引语。
 * 不追求语法完备——漏检一句的代价是多给一条建议，误检的代价是放过一篇纯旁白。
 */
export function findDialogue(body) {
  const text = String(body || '')
  const quoted = [...text.matchAll(/[「“"]([^」”"]{2,80})[」”"]/gu)].map((match) => match[1].trim())
  const reported = [...text.matchAll(/(?:说|问|答|回|骂|喊|嘟囔|嘀咕|小声|念)(?:了|着)?(?:一句|一句：|：)[「“"]?([^。！？!?」”"]{2,60})/gu)].map((match) => match[1].trim())
  const merged = [...new Set([...quoted, ...reported].filter(Boolean))]
  return { count: merged.length, lines: merged.slice(0, 8) }
}

/** 口语度粗判：对白里出现书面语连接词就说明它不像人说的话。 */
function dialogueNaturalness(lines) {
  const written = /(?:因此|从而|然而|此外|并且|以及|鉴于|基于|综上所述)/u
  const unnatural = lines.filter((line) => written.test(line))
  return { total: lines.length, unnatural: unnatural.length }
}

/**
 * 句子节奏均匀度。
 *
 * 人的叙述句长分布是偏斜的：有一两句很短（三五个字），也有个别长句。AI 的分布
 * 集中在中段。这里用「短句占比」与「句长标准差」两个量一起判断——只看标准差会
 * 把「整篇都是 12 字」当成均匀，只看短句占比会把「整篇碎句」当成节奏好。
 */
export function measureSentenceRhythm(body) {
  const lengths = splitSentences(body).map((sentence) => chars(sentence).length)
  if (!lengths.length) return { sentenceCount: 0, average: 0, standardDeviation: 0, shortRatio: 0, uniform: false, tooChoppy: false }
  const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
  const variance = lengths.reduce((sum, value) => sum + (value - average) ** 2, 0) / lengths.length
  const standardDeviation = Math.sqrt(variance)
  const shortRatio = lengths.filter((value) => value <= 8).length / lengths.length
  const longRatio = lengths.filter((value) => value >= 30).length / lengths.length
  return {
    sentenceCount: lengths.length,
    average: Math.round(average * 100) / 100,
    standardDeviation: Math.round(standardDeviation * 100) / 100,
    shortRatio: Math.round(shortRatio * 1000) / 1000,
    longRatio: Math.round(longRatio * 1000) / 1000,
    // 均匀 = 句长集中且几乎没有短句。这是 AI 最典型的节奏指纹。
    uniform: lengths.length >= 8 && standardDeviation < 4.5 && shortRatio < 0.12,
    // 反过来，短句过多会让整篇显得喘不上气，同样不像人在讲。
    tooChoppy: lengths.length >= 8 && shortRatio > 0.62,
  }
}

export function measureConcreteness(body) {
  const text = String(body || '')
  return {
    timeAnchors: countMatches(text, TIME_ANCHORS),
    placeAnchors: countMatches(text, PLACE_ANCHORS),
    objectAnchors: countMatches(text, OBJECT_ANCHORS),
    numbers: countMatches(text, NUMBER_ANCHORS),
  }
}

function detectLiftedEnding(body) {
  const paragraphs = splitParagraphs(body)
  const tail = paragraphs.length ? paragraphs[paragraphs.length - 1] : String(body || '')
  const lastTwo = paragraphs.slice(-2).join('')
  const hits = []
  for (const phrase of LIFTED_ENDINGS) {
    if (tail.includes(phrase) || lastTwo.includes(phrase)) hits.push(phrase)
  }
  return hits
}

function countCliches(body) {
  const text = String(body || '')
  const hits = []
  for (const phrase of AI_CLICHES) {
    const times = text.split(phrase).length - 1
    if (times > 0) hits.push({ phrase, times })
  }
  return hits
}

function bannedHits(body) {
  const text = String(body || '')
  const hits = []
  for (const rule of HARD_BLOCKED) {
    const found = text.match(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`))
    if (found) hits.push({ id: rule.id, name: rule.name, words: [...new Set(found)] })
  }
  return hits
}

/**
 * 反塑料感报告。
 *
 * 返回值里 `blocking` 是硬拦项（必须重写），`score` 是 0-100 的可读性分，
 * `suggestions` 是可选的改写建议。落库只拦 blocking，分数与建议只用于提示。
 */
export function checkAntiPlastic({ body = '', topic = null } = {}) {
  const text = String(body || '')
  const sentences = splitSentences(text)
  const charCount = chars(compact(text)).length
  const blocking = []
  const suggestions = []

  const banned = bannedHits(text)
  for (const hit of banned) blocking.push(`出现${hit.name}（${hit.words.join('、')}）：这类套路会让故事瞬间失去可信度，必须重写。`)

  const dialogue = findDialogue(text)
  const naturalness = dialogueNaturalness(dialogue.lines)
  if (charCount >= 120 && dialogue.count === 0) {
    blocking.push('全篇没有一句人物对白：情感故事必须由人物开口说话，纯旁白叙述是典型的 AI 结构。')
  } else if (naturalness.unnatural > 0) {
    suggestions.push(`有 ${naturalness.unnatural} 句对白带书面语连接词（因此/然而/并且等），改成口语。`)
  }

  const lifted = detectLiftedEnding(text)
  for (const phrase of lifted) {
    blocking.push(`结尾出现升华句「${phrase}」：把故事讲成道理会直接消解情绪，收在一个未完成的动作上。`)
  }

  const cliches = countCliches(text)
  const clicheTotal = cliches.reduce((sum, item) => sum + item.times, 0)
  if (clicheTotal >= 3) {
    blocking.push(`AI 口癖出现 ${clicheTotal} 处（${cliches.map((item) => item.phrase).join('、')}）：整篇已经不像人在讲。`)
  } else if (clicheTotal > 0) {
    suggestions.push(`清除 ${clicheTotal} 处 AI 口癖：${cliches.map((item) => item.phrase).join('、')}。`)
  }

  const rhythm = measureSentenceRhythm(text)
  if (rhythm.uniform) {
    blocking.push(`句长过于均匀（标准差 ${rhythm.standardDeviation}，短句占比 ${Math.round(rhythm.shortRatio * 100)}%）：人的叙述一定有长有短，这是 AI 最典型的节奏指纹。`)
  } else if (rhythm.tooChoppy) {
    suggestions.push(`短句占 ${Math.round(rhythm.shortRatio * 100)}%，整体过碎，需要放进两三句稍长的叙述做缓冲。`)
  }

  const concrete = measureConcreteness(text)
  const anchorTotal = concrete.timeAnchors + concrete.placeAnchors + concrete.objectAnchors
  if (charCount >= 200) {
    if (anchorTotal === 0) {
      blocking.push('全篇没有任何具体时间、地点或物件：故事没有落进可感知的场面，观众无法代入。')
    } else if (anchorTotal < 3) {
      suggestions.push(`具体锚点只有 ${anchorTotal} 个（时间 ${concrete.timeAnchors} / 地点 ${concrete.placeAnchors} / 物件 ${concrete.objectAnchors}），建议补到 5 个以上。`)
    }
    if (concrete.numbers === 0) suggestions.push('全篇没有具体数字：年龄、年数、金额这类真实数字能显著提升可信度。')
  }

  if (sentences.length >= 6) {
    const longest = Math.max(...sentences.map((sentence) => chars(sentence).length))
    if (longest >= 60) suggestions.push(`有 ${longest} 字的长句，口播时容易断气，拆成两三句。`)
  }

  const score = scoreAntiPlastic({ blocking, suggestions, clicheTotal, anchorTotal, rhythm, dialogue })

  return {
    artifactType: 'story_anti_plastic_report',
    reportVersion: '1.0.0',
    deterministic: true,
    charCount,
    sentenceCount: rhythm.sentenceCount,
    blocking,
    suggestions,
    passed: blocking.length === 0,
    score,
    checks: {
      banned,
      dialogue: { count: dialogue.count, lines: dialogue.lines, unnaturalLines: naturalness.unnatural },
      cliches,
      rhythm,
      concrete,
      liftedEndings: lifted,
      expectedHook: topic?.hook || null,
      expectedTheme: topic?.theme || null,
    },
  }
}

/**
 * 分项打分。
 *
 * 权重按「修一篇稿子的收益」排：场面具体度最能救完播率，所以给最高的 30；
 * 结尾与节奏其次；口癖最好修且影响观感，给 15。硬拦项不在这里扣分——它们已经
 * 直接判定不合格，再扣一次会让两条不同问题得到同一个分数，反而不利于排序。
 */
function scoreAntiPlastic({ blocking, clicheTotal, anchorTotal, rhythm, dialogue }) {
  if (blocking.length) return 0
  let score = 100
  score -= Math.min(30, clicheTotal * 8)
  if (anchorTotal < 5) score -= Math.min(30, (5 - anchorTotal) * 7)
  if (rhythm.tooChoppy) score -= 12
  if (dialogue.count === 0) score -= 20
  else if (dialogue.count === 1) score -= 6
  if (rhythm.sentenceCount < 6) score -= 8
  return Math.max(0, Math.min(100, Math.round(score)))
}
