/**
 * 小米 MiMo TTS 客户端。
 *
 * 从 media-bridge/bridge.mjs 的 `mimoRequestOnce` / `withMimoSlot` 移植而来
 * （原实现是已跑通的，故这里连同它的两条踩坑注释一起搬过来）：
 *
 *  1. 官方形态不是 OpenAI 的 /v1/audio/speech，而是 /v1/chat/completions。
 *     待合成文本放 **assistant**、风格指令放 **user** —— 放反了会把正文
 *     当成指令、或把风格当成要念的内容。
 *  2. 鉴权头是 `api-key`，不是 `Authorization: Bearer`。
 *  3. 官方标注 RPM 100 / TPM 10M，但实测长文案分段连发仍会 429
 *     （2026-10-08：25 段第 1 段即 429，说明配额已被并发吃满）。
 *     因此全局串行队列 + 相邻请求最小间隔，把峰值压到 ~30 RPM。
 *
 * 声音复刻（voiceclone）与音色设计（voicedesign）见下方 MIMO_MODELS。
 *
 * 三个模型**互斥**，不可混用（官方明确）：
 *  · tts         仅支持预置音色 + 唱歌
 *  · voicedesign 仅支持「用文字描述设计音色」，user 消息必填
 *  · voiceclone  仅支持音频样本复刻
 * 因此调用方要按模式切换，而不是把三个模型当并列下拉。
 */

/**
 * 三种合成模式。
 *
 * `preset` 走预置音色表；`design` 用一句文字描述换一个新音色；
 * `clone` 上传一段音频复刻说话人。三者的音色来源互斥。
 */
export const MIMO_MODES = Object.freeze(['preset', 'design', 'clone'])

/** 模式 → 模型 id。显式指定，绝不让服务端按默认模型兜底。 */
export const MIMO_MODEL_BY_MODE = Object.freeze({
  preset: 'mimo-v2.5-tts',
  design: 'mimo-v2.5-tts-voicedesign',
  clone: 'mimo-v2.5-tts-voiceclone',
})

/**
 * 预置音色共 9 个（官方「预置音色」表）。
 *
 * mimo_default 有**集群差异**：中国集群映射「冰糖」，其他集群映射 Mia。
 * 所以永远显式传音色名，不要依赖 mimo_default 的隐式解析——
 * 否则同一份配置在不同集群会得到不同的声音，且没有任何报错。
 */
export const MIMO_VOICES = Object.freeze([
  'mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean',
])

/**
 * 默认音色固定「冰糖」，**刻意不用 mimo_default**。
 *
 * mimo_default 是集群相关的别名：中国集群映射「冰糖」，其他集群映射 Mia。
 * 若默认音色取它，同一份配置在不同集群会发出不同的声音，且**没有任何报错**——
 * 这类「静默不一致」比报错更难排查。所以这里钉死一个具体音色名，
 * 让集群差异永远不会影响到默认行为。
 */
export const MIMO_DEFAULT_VOICE = '冰糖'

/** 中国集群上 mimo_default 实际对应的音色名，供界面提示用。 */
export const MIMO_DEFAULT_VOICE_CN = '冰糖'

/** voicedesign 用：文字描述必填，这是该模型的唯一输入。 */
export const MIMO_DESIGN_MAX = 500

/** 官方限制：参考音频只认 wav/mp3，其余格式必须先转码，否则报 400。 */
export const MIMO_CLONE_MIME = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
})

/** 采样率 24kHz 单声道——与桥接里已验证的转码参数一致。 */
export const MIMO_CLONE_TRANSCODE = Object.freeze(['-ac', '1', '-ar', '24000'])

/** 相邻两次请求开始之间的最小间隔（毫秒）。 */
export const MIMO_MIN_GAP_MS = 2000

/** 单次请求超时。分段合成一段文本不该超过三分钟。 */
export const MIMO_TIMEOUT_MS = 180_000

export class MimoError extends Error {
  constructor(message, { code = 'SPOKEN_VIDEO_MIMO_FAILED', retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message)
    this.name = 'MimoError'
    this.code = code
    this.retryable = retryable
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * 全局节流队列。
 *
 * 桥接侧的教训直接照搬：所有 MiMo 请求在这里串行排队，前一个响应回来之前
 * 不发下一个。失败也必须摘链，否则一次请求抛错会让后面排队的请求跟着拒绝。
 */
export class MimoThrottle {
  constructor({ minGapMs = MIMO_MIN_GAP_MS, now = () => Date.now(), sleep = null } = {}) {
    this.minGapMs = minGapMs
    this.now = now
    this.sleep = sleep || ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (typeof timer.unref === 'function') timer.unref()
    }))
    this.chain = Promise.resolve()
    this.lastStart = 0
  }

  run(fn) {
    const next = this.chain.then(fn)
    this.chain = next.then(() => {}, () => {})
    return next
  }

  /** 距离上一个请求开始不足 minGapMs 时先等差额。排队等待不计入单次请求超时。 */
  async waitForSlot() {
    const waitMs = this.lastStart + this.minGapMs - this.now()
    if (waitMs > 0) await this.sleep(waitMs)
    this.lastStart = this.now()
  }
}

/**
 * 构造请求体。单独导出以便离线断言三件事：
 * 正文归 assistant、自然语言风格归 user、音频标签归正文文本内。
 *
 * @param mode     'preset' | 'design' | 'clone'
 * @param voice    预置音色名（preset）或参考音频的 data URL（clone）；design 不用
 * @param style    自然语言风格指令 → role=user
 * @param tags     音频标签数组 → 以 `(标签)` 开头拼进正文（见 buildTaggedText）
 */
export function buildMimoBody({ mode = 'preset', model, text, voice, style, tags = [], format = 'wav' }) {
  if (!MIMO_MODES.includes(mode)) {
    throw new MimoError(`未知的 MiMo 合成模式：${mode}`, { code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' })
  }
  // 音色来源互斥：design 不接受音色名，clone 只接受音频，preset 只接受内置名。
  if (mode === 'preset' && !MIMO_VOICES.includes(voice)) {
    throw new MimoError(`音色「${voice}」不在小米 MiMo 预置音色表中。可选：${MIMO_VOICES.join('、')}`, {
      code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT',
    })
  }
  if (mode === 'clone' && !String(voice || '').startsWith('data:audio/')) {
    throw new MimoError('声音克隆需要一段参考音频。', { code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' })
  }
  if (mode === 'design' && !String(style || '').trim()) {
    // voicedesign 的 user 消息必填：没有描述就没有音色可设计。
    throw new MimoError('音色设计需要一句音色描述。', { code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' })
  }
  if (mode === 'design' && voice) {
    // 混用即错：design 的音色来自描述，再带一个预置音色名会让人以为它在生效。
    throw new MimoError('音色设计模式不接受音色名，音色由描述决定。', { code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' })
  }

  const messages = []
  const trimmedStyle = String(style || '').trim()
  // 风格指令放 user：控制语气/节奏，内容不会出现在合成语音里。
  // voicedesign 下这句描述就是音色的定义来源，必填（上面已校验）。
  if (trimmedStyle) messages.push({ role: 'user', content: trimmedStyle })
  // 正文必须放 assistant —— 放 user 会被当成指令而不是要念的内容。
  messages.push({ role: 'assistant', content: buildTaggedText(text, tags) })
  return { model, messages, audio: { format, voice } }
}

/**
 * 把开头的 `(风格)` 标签拼到正文前。
 *
 * 官方语法是**两套、位置不同**：
 *  · `(风格)` —— 放在**正文开头**，多个风格写进同一对括号、分隔符不限；
 *    官方同时接受半角 `()`、全角 `（）` 与 `[]`，唱歌必须用它：`(唱歌)歌词`。
 *    这一段由本函数拼接，所以它对应 `audioTags` 数组里的**风格**项。
 *  · `[音频标签]` —— 放在**正文任意位置**做细粒度控制（叹气/哽咽/深吸气…），
 *    它属于用户正文的一部分，**不由本函数拼接**：用户直接写在文本框里，
 *    看得见、改得动，与「所见即所得」的约定一致。
 *
 * 所以本函数只处理开头那一段；正文里的方括号标签由 {@link countInlineAudioTags}
 * 单独清点，纳入同一套上限校验——它们同样是裸传给模型的形态，一样要防滥用。
 */
export function buildTaggedText(text, tags = []) {
  const body = String(text ?? '')
  const usable = (Array.isArray(tags) ? tags : []).map((t) => String(t || '').trim()).filter(Boolean)
  if (!usable.length) return body
  // 官方支持半角/全角/方括号三种括号，这里统一用半角圆括号输出。
  return `(${usable.join('，')})${body}`
}

/**
 * 内插标签的候选匹配：成对 + 非空 + ≤40 字。
 *
 * 与前端 svAudioTagSlots **逐字同形**（2026-10-20）。正则只管取候选，
 * 含不含括号交给下面那道后置检查——两道都不可省：
 *  · 排除类里若写进 `［【】()（）`，真正该挡的 `]` 反而漏掉，`[a]b]` 会当成
 *    标签、内容读成 `a]b`；
 *  · 光靠正则排除也不够：`[a[b]` 这类在别处可能匹配成功，而前端是匹配后再判内层，
 *    两边只差一道就会分叉。故按前端同序：先取候选，再判内层。
 */
const MIMO_INLINE_TAG_SHELL = /[[［]([^\]］]{1,40})[\]］]/gu;

/**
 * 标签内层不得出现的字符集——出现即判为普通文本、不占配额。
 *
 * **这是全项目唯一真源。** 前端 `client.js` 的 `svAudioTagSlots` 由于拿不到
 * ESM import，只能手抄一份字面量；因此联调用例里有一条断言**逐字比对两边
 * 这个字符集的字面量相等**，而不只是比对计数结果——计数相等有偶然性。
 *
 * 含 `【】`：它在中文正文里同样是括号、同样会出现嵌套，与 `()`/`［］` 同判。
 * 2026-10-21 的漂移就出在这里：前端写进了 `【】`、后端漏了，靠 `[叹【气】]`
 * 这一个输入才把计数差异暴露出来。
 */
export const MIMO_INLINE_TAG_INNER = /[[\]［］()（）【】]/u;

/** 纯数字内容是引用编号（`[1]`、`[12]`），不是标签。官方标签也没有纯数字形态。 */
const MIMO_INLINE_TAG_DIGITS_ONLY = /^[0-9０-９]+$/u;

/**
 * 数出正文里内插的 `[音频标签]` 个数。
 *
 * 这些标签用户直接写在文本里，不会经过 audioTags 入参，若不单独清点就能无限贴，
 * 把整篇正文变成一串标签、也会打爆请求。所以和 audioTags 共用同一个上限。
 *
 * 判定规则（前后端必须逐字一致，见前端 svAudioTagSlots）：
 * **成对 + 内容非空 + ≤40 字 + 内层不含任何括号**才算一个内插标签。
 *
 * 为什么只认成对的、不数孤立起始符：
 *  · 口播稿里`[1]`、`[2]` 这类中括号引用是**真实场景**（引用来源、括号补充说明）。
 *    数起始符会把正常文案误判成标签、白占配额，用户改稿时突然被拒且**完全不知道
 *    为什么被拒**——这个失败模式比「漏算一个标签」糟糕得多。
 *  · 官方语法里标签本就成对；不成对的更可能是用户笔误或正文标点，
 *    **不该由我们替他拦**，原样当普通文本放行。
 *  · 成对但**内容是纯数字**的按引用编号放行（`[1]`/`[12]`）：官方标签没有纯数字形态，
 *    而它恰好是上面那条最常见的误判来源。
 */
export function countInlineAudioTags(text) {
  const body = String(text ?? '')
  let count = 0
  for (const match of body.matchAll(MIMO_INLINE_TAG_SHELL)) {
    // 第二道：正则取到的候选，内层仍含括号就不是标签。
    if (MIMO_INLINE_TAG_INNER.test(match[1])) continue
    // 第三道：纯数字是文献引用编号，不占配额。
    if (MIMO_INLINE_TAG_DIGITS_ONLY.test(match[1])) continue
    count += 1
  }
  return count
}

/**
 * 把响应体解成音频 Buffer。
 *
 * 音频在 choices[0].message.audio.data（base64）。容错读多个位置是因为
 * 平台偶尔会把字段挪到顶层，遇到时宁可多读一次也不要报「未返回音频」。
 */
export function extractMimoAudio(payload, rawText = '') {
  const data = payload?.choices?.[0]?.message?.audio?.data
    ?? payload?.choices?.[0]?.message?.audio?.audio
    ?? payload?.audio?.data
  if (typeof data === 'string' && data) return Buffer.from(data, 'base64')
  throw new MimoError(`小米 TTS 未返回音频（响应：${String(rawText).slice(0, 200)}）`)
}

/** 从错误响应里挖出可读原因；平台错误文案可能是中英混合。 */
export function readMimoErrorText(rawText) {
  try {
    const json = JSON.parse(rawText)
    return json?.error?.message || json?.error?.displayMsg?.zh || json?.message || String(rawText).slice(0, 300)
  } catch {
    return String(rawText).slice(0, 300)
  }
}

/**
 * 单次 MiMo 请求（不含节流排队）。
 *
 * 错误分级沿用桥接的教训：**4xx（除 429）不可重试**。实测 400 连打 4 次
 * 会转成 429，报错只剩 429，把「参数错/音频格式错」这个真因掩盖掉；
 * 盲目重试不仅无用，还会耗尽限流配额、拖垮真正在限流的用户。
 */
export async function mimoRequestOnce({
  text,
  apiKey,
  model,
  mode = 'preset',
  voice,
  style,
  tags = [],
  format = 'wav',
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = MIMO_TIMEOUT_MS,
}) {
  if (!apiKey) {
    throw new MimoError('尚未保存小米 MiMo API Key。请在连接设置中保存后重试。', {
      code: 'SPOKEN_VIDEO_MEDIA_CREDENTIAL_REQUIRED',
    })
  }
  const body = buildMimoBody({ mode, model, text, voice, style, tags, format })

  let response
  try {
    response = await fetchImpl(`${String(baseUrl).replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new MimoError(`小米 TTS 请求失败（网络/超时）：${error?.message || error}`, { retryable: true })
  }

  const rawText = await response.text()
  if (!response.ok) {
    const retryAfterHeader = Number(response.headers?.get?.('retry-after'))
    if (response.status === 429) {
      throw new MimoError(`小米 TTS 请求过于频繁（429）：${readMimoErrorText(rawText)}`, {
        code: 'SPOKEN_VIDEO_MIMO_THROTTLED',
        retryable: true,
        status: 429,
        retryAfterMs: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null,
      })
    }
    // 参数错、鉴权错、载荷超限：重试多少次都一样，只会白白消耗限流配额。
    const fatal = response.status >= 400 && response.status < 500
    throw new MimoError(`小米 TTS 返回 ${response.status}：${readMimoErrorText(rawText)}`, {
      code: fatal ? 'SPOKEN_VIDEO_MIMO_REQUEST_REJECTED' : 'SPOKEN_VIDEO_MIMO_FAILED',
      retryable: !fatal,
      status: response.status,
    })
  }

  let payload
  try {
    payload = JSON.parse(rawText)
  } catch {
    throw new MimoError('小米 TTS 返回的不是 JSON。')
  }
  return extractMimoAudio(payload, rawText)
}

/**
 * 带节流的合成入口。生产代码用这个，mimoRequestOnce 仅供单测直接调用。
 */
export class MimoClient {
  constructor({ apiKey = null, baseUrl, model = 'mimo-v2.5-tts', defaultVoice = '冰糖', throttle = null, fetchImpl = fetch, timeoutMs = MIMO_TIMEOUT_MS } = {}) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.model = model
    this.defaultVoice = defaultVoice
    this.throttle = throttle || new MimoThrottle()
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  /** voiceId 为空时用配置的默认音色；始终校验在官方 9 个预置音色内。 */
  resolveVoice(voiceId) {
    // 优先用运维配置的默认音色；但**绝不回落到 mimo_default**——它在中国集群映射
    // 「冰糖」、其他集群映射 Mia，隐式依赖它会让同一份配置在不同集群发出不同的
    // 声音且没有任何报错，这类静默不一致比报错更难排查。
    const configured = String(this.defaultVoice || '').trim()
    const fallback = configured && configured !== 'mimo_default' ? configured : MIMO_DEFAULT_VOICE
    const voice = String(voiceId || '').trim() || fallback
    if (!MIMO_VOICES.includes(voice)) {
      throw new MimoError(`音色「${voice}」不在小米 MiMo 预置音色表中。可选：${MIMO_VOICES.join('、')}`, {
        code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT',
      })
    }
    return voice
  }

  /** 按模式解析模型。显式返回，绝不默默退回默认模型。 */
  resolveModel(mode) {
    if (!MIMO_MODES.includes(mode)) {
      throw new MimoError(`未知的 MiMo 合成模式：${mode}`, { code: 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' })
    }
    return MIMO_MODEL_BY_MODE[mode]
  }

  async synthesize({ text, mode = 'preset', voiceId = null, style = '', tags = [], format = 'wav', apiKey = null, referenceDataUrl = null }) {
    const key = apiKey || this.apiKey
    // 三模式的音色来源互斥，各自解析：clone 用音频、design 不用音色名。
    const voice = mode === 'clone' ? referenceDataUrl : (mode === 'design' ? null : this.resolveVoice(voiceId))
    const model = this.resolveModel(mode)
    return this.throttle.run(() => this.throttle.waitForSlot().then(() => mimoRequestOnce({
      text,
      apiKey: key,
      model,
      mode,
      voice,
      style,
      tags,
      format,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    })))
  }
}

export default MimoClient
