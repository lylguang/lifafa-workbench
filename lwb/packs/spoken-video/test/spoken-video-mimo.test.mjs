/**
 * 小米 MiMo 接入的离线单测。
 *
 * 全部用注入的 fetch / 时钟 / 睡眠函数，**不打真实网络、不读环境变量、
 * 不需要 API Key**，因此在任何机器上都能跑。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildMimoBody,
  buildTaggedText,
  countInlineAudioTags,
  extractMimoAudio,
  MIMO_CLONE_MIME,
  MIMO_CLONE_TRANSCODE,
  MIMO_DEFAULT_VOICE,
  MIMO_INLINE_TAG_INNER,
  MIMO_MODEL_BY_MODE,
  MIMO_MODES,
  MimoClient,
  MimoError,
  MimoThrottle,
  mimoRequestOnce,
  MIMO_MIN_GAP_MS,
  MIMO_VOICES,
  readMimoErrorText,
} from '../spoken-video-media-mimo.mjs'
import { assertTotalAudioTags, MEDIA_PROVIDER_CREDENTIAL_REFS, MEDIA_PROVIDERS, mediaCredentialRef, mediaServiceConfig, normalizeSubtitleRequest, normalizeVoiceoverRequest, VOICE_SOURCES } from '../spoken-video-media.mjs'
import { buildMimoTimeline, isCredentialRejection, SpokenVideoMediaHost } from '../spoken-video-media-host.mjs'
import { SpokenVideoProjectStore } from '../spoken-video-store.mjs'
import { packCredentialRef } from '../../../dsh-bundle/pack-workspaces.mjs'

/** 造一个最小可用的 Response 替身。 */
function reply({ ok = true, status = 200, body = {}, text = null, headers = {} } = {}) {
  const raw = text ?? JSON.stringify(body)
  return {
    ok,
    status,
    headers: { get: (name) => (name in headers ? String(headers[name]) : null) },
    text: async () => raw,
  }
}

const okAudio = (data = 'UklGRg==') => reply({
  body: { choices: [{ message: { audio: { data } } }] },
})

// 三模式各造一个客户端，fetch 由用例注入。
const mkClient = (fetchImpl, extra = {}) => new MimoClient({
  apiKey: 'k', baseUrl: 'u', defaultVoice: '冰糖',
  throttle: new MimoThrottle({ minGapMs: 0, now: () => 0, sleep: async () => {} }),
  fetchImpl, ...extra,
})

test('默认音色不得随集群漂移：钉死「冰糖」，绝不回落到 mimo_default', () => {
  // mimo_default 在中国集群映射「冰糖」、其他集群映射 Mia。默认音色若取它，
  // 同一份配置在不同集群会发出不同声音且不报错——这类静默不一致最难排查。
  assert.equal(MIMO_DEFAULT_VOICE, '冰糖')
  assert.notEqual(MIMO_DEFAULT_VOICE, 'mimo_default')
  assert.equal(mediaServiceConfig({}).mimoDefaultVoice, '冰糖')
  // 即使构造时显式塞了 mimo_default 作为默认，resolveVoice 也必须不回落它。
  const client = mkClient(async () => okAudio(), { defaultVoice: 'mimo_default' })
  assert.equal(client.resolveVoice(null), '冰糖')
  assert.equal(client.resolveVoice(''), '冰糖')
  assert.equal(client.resolveVoice('  '), '冰糖')
  // 运维配了具体音色时仍然生效（不能把配置能力一起废掉）。
  const configured = mkClient(async () => okAudio(), { defaultVoice: '苏打' })
  assert.equal(configured.resolveVoice(null), '苏打')
  // 但用户显式选 mimo_default 时仍允许（那是用户的明确选择，不是隐式回落）。
  assert.equal(client.resolveVoice('mimo_default'), 'mimo_default')
})

test('MIMO_VOICES 是官方 9 个预置音色（中文 4 + 英文 4 + default）', () => {
  assert.deepEqual([...MIMO_VOICES], [
    'mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean',
  ])
  assert.equal(MIMO_VOICES.length, 9)
  assert.equal(mediaServiceConfig({}).mimoDefaultVoice, '冰糖')
  // mimo_default 有集群差异（中国→冰糖，其他→Mia），所以默认音色不能是它，
  // 且 resolveVoice 绝不回落到它。
  assert.notEqual(mediaServiceConfig({}).mimoDefaultVoice, 'mimo_default')
})

test('请求体：正文放 assistant、风格指令放 user（放反会被当成指令）', () => {
  const body = buildMimoBody({ model: 'mimo-v2.5-tts', text: '今天讲电池。', voice: '茉莉', style: '语速偏慢' })
  assert.equal(body.model, 'mimo-v2.5-tts')
  assert.deepEqual(body.messages, [
    { role: 'user', content: '语速偏慢' },
    { role: 'assistant', content: '今天讲电池。' },
  ])
  assert.deepEqual(body.audio, { format: 'wav', voice: '茉莉' })
})

test('无风格指令时不发空 user 消息（否则平台可能把空串当内容）', () => {
  const body = buildMimoBody({ model: 'm', text: '正文', voice: '冰糖', style: '   ' })
  assert.deepEqual(body.messages, [{ role: 'assistant', content: '正文' }])
})

test('鉴权头是 api-key 而非 Authorization: Bearer，且打到 /chat/completions', async () => {
  let seen = null
  await mimoRequestOnce({
    text: '正文', apiKey: 'sk-test', model: 'mimo-v2.5-tts', voice: '冰糖',
    baseUrl: 'https://api.xiaomimimo.com/v1/', fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers }
      return okAudio()
    },
  })
  assert.equal(seen.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(seen.headers['api-key'], 'sk-test')
  assert.equal(seen.headers.Authorization, undefined)
})

test('无 API Key 时报 CREDENTIAL_REQUIRED，且不发起任何请求', async () => {
  let called = false
  await assert.rejects(
    () => mimoRequestOnce({ text: 'x', apiKey: '', baseUrl: 'u', fetchImpl: async () => { called = true; return okAudio() } }),
    (error) => error instanceof MimoError && error.code === 'SPOKEN_VIDEO_MEDIA_CREDENTIAL_REQUIRED',
  )
  assert.equal(called, false)
})

test('音频解包：标准位置与容错位置都能取到 base64', () => {
  assert.equal(extractMimoAudio({ choices: [{ message: { audio: { data: 'UklGRg==' } } }] }).toString(), 'RIFF')
  assert.equal(extractMimoAudio({ choices: [{ message: { audio: { audio: 'UklGRg==' } } }] }).toString(), 'RIFF')
  assert.equal(extractMimoAudio({ audio: { data: 'UklGRg==' } }).toString(), 'RIFF')
})

test('响应里没有音频时报错，并把响应片段带进消息便于排查', () => {
  assert.throws(
    () => extractMimoAudio({ choices: [] }, '{"choices":[]}'),
    (error) => error instanceof MimoError && /未返回音频/.test(error.message) && /"choices"/.test(error.message),
  )
})

test('错误分级：4xx（除 429）不可重试，429 可重试且读 retry-after', async () => {
  for (const mode of MIMO_MODES) {
    await assert.rejects(
      () => mimoRequestOnce({
        text: 'x', apiKey: 'k', baseUrl: 'u', mode,
        voice: mode === 'clone' ? 'data:audio/wav;base64,UklGRg==' : (mode === 'design' ? null : '冰糖'),
        style: mode === 'design' ? '低沉男声' : '',
        fetchImpl: async () => reply({ ok: false, status: 400, text: '{"error":{"message":"参数错"}}' }),
      }),
      (error) => error.retryable === false && error.code === 'SPOKEN_VIDEO_MIMO_REQUEST_REJECTED' && error.status === 400,
      `模式 ${mode} 的 400 应不可重试`,
    )
    await assert.rejects(
      () => mimoRequestOnce({
        text: 'x', apiKey: 'k', baseUrl: 'u', mode,
        voice: mode === 'clone' ? 'data:audio/wav;base64,UklGRg==' : (mode === 'design' ? null : '冰糖'),
        style: mode === 'design' ? '低沉男声' : '',
        fetchImpl: async () => reply({ ok: false, status: 429, text: '{"error":{"message":"too many"}}', headers: { 'retry-after': 3 } }),
      }),
      (error) => error.retryable === true && error.code === 'SPOKEN_VIDEO_MIMO_THROTTLED' && error.retryAfterMs === 3000,
      `模式 ${mode} 的 429 应可重试`,
    )
  }
})

test('4xx 不重试是实测教训：400 连打会转成 429 掩盖真因（用调用次数钉住）', async () => {
  let calls = 0
  await assert.rejects(() => mimoRequestOnce({
    text: 'x', apiKey: 'k', baseUrl: 'u', voice: '冰糖',
    fetchImpl: async () => { calls += 1; return reply({ ok: false, status: 400, text: '{"error":{"message":"bad"}}' }) },
  }))
  assert.equal(calls, 1, '4xx 只应尝试一次')
})

test('5xx 视为可重试（服务端瞬时故障）', async () => {
  await assert.rejects(
    () => mimoRequestOnce({ text: 'x', apiKey: 'k', baseUrl: 'u', voice: '冰糖', fetchImpl: async () => reply({ ok: false, status: 503, text: 'oops' }) }),
    (error) => error.retryable === true && error.code === 'SPOKEN_VIDEO_MIMO_FAILED',
  )
})

test('网络异常归为可重试，并保留原始原因', async () => {
  await assert.rejects(
    () => mimoRequestOnce({ text: 'x', apiKey: 'k', baseUrl: 'u', voice: '冰糖', fetchImpl: async () => { throw new Error('ECONNRESET') } }),
    (error) => error instanceof MimoError && error.retryable === true && /ECONNRESET/.test(error.message),
  )
})

test('错误文案解析：平台中英混合结构都能取出可读原因', () => {
  assert.equal(readMimoErrorText('{"error":{"message":"invalid api key"}}'), 'invalid api key')
  assert.equal(readMimoErrorText('{"error":{"displayMsg":{"zh":"请求过于频繁"}}}'), '请求过于频繁')
  assert.equal(readMimoErrorText('{"message":"quota"}'), 'quota')
  assert.equal(readMimoErrorText('not json'), 'not json')
})

test('节流队列：请求串行，且相邻请求间隔不小于 minGapMs', async () => {
  let clock = 0
  const slept = []
  const throttle = new MimoThrottle({
    minGapMs: 2000,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
  })
  const order = []
  // 与 MimoClient.synthesize 的真实组合一致：先排队，再等间隔。
  const job = (n) => throttle.run(async () => {
    await throttle.waitForSlot()
    order.push(n)
    clock += 100
    return n
  })
  await Promise.all([job(1), job(2), job(3)])
  assert.deepEqual(order, [1, 2, 3], '必须串行，不能并发')
  // 3 次请求各等一次：含首次（lastStart 初值为 0，同样要等满一个间隔）
  assert.equal(slept.length, 3)
  assert.ok(slept.every((ms) => ms > 0 && ms <= MIMO_MIN_GAP_MS), `间隔都应在 (0, ${MIMO_MIN_GAP_MS}]，实际 ${slept}`)
})

test('节流队列失败摘链：一次抛错不会让后续排队请求跟着拒绝', async () => {
  const throttle = new MimoThrottle({ minGapMs: 0, now: () => 0, sleep: async () => {} })
  const failing = throttle.run(async () => { throw new Error('boom') })
  const following = throttle.run(async () => 'ok')
  await assert.rejects(failing)
  assert.equal(await following, 'ok')
})

test('并发模式：同时在飞的数量不超过 concurrency，且确实重叠执行', async () => {
  const throttle = new MimoThrottle({ minGapMs: 0, concurrency: 3, now: () => 0, sleep: async () => {} })
  let active = 0
  let peak = 0
  const job = () => throttle.run(async () => {
    active += 1
    peak = Math.max(peak, active)
    // 让出事件循环，制造真实的「多个请求同时在飞」窗口。
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
  })
  await Promise.all(Array.from({ length: 9 }, job))
  assert.equal(peak, 3, `并发上限应为 3，实际峰值 ${peak}`)
  assert.equal(active, 0, '结束后不应有残留占用')
})

test('并发模式：默认 concurrency=1 时行为与旧的完全串行一致', async () => {
  const throttle = new MimoThrottle({ minGapMs: 0, now: () => 0, sleep: async () => {} })
  const order = []
  const job = (n) => throttle.run(async () => {
    order.push(`start-${n}`)
    await new Promise((resolve) => setImmediate(resolve))
    order.push(`end-${n}`)
    return n
  })
  await Promise.all([job(1), job(2), job(3)])
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3'], '必须严格串行')
})

test('并发下起点间隔仍生效：任意两次请求开始时刻之差都不小于 minGapMs', async () => {
  let clock = 0
  const starts = []
  const throttle = new MimoThrottle({
    minGapMs: 2000,
    concurrency: 4,
    now: () => clock,
    // 真实时间由 sleep 推进；请求本身「耗时」也要推进时钟，否则测不出重叠。
    sleep: async (ms) => { clock += ms },
  })
  const job = () => throttle.run(async () => {
    starts.push(await throttle.waitForSlot())
    clock += 100
    await Promise.resolve()
  })
  await Promise.all(Array.from({ length: 6 }, job))
  starts.sort((a, b) => a - b)
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 2000, `第 ${i} 次与上一次起点间隔不足 2000ms：${starts[i - 1]} → ${starts[i]}`)
  }
})

test('取槽并发安全：多个请求同时 waitForSlot 不会算出同一个放行时刻', async () => {
  let clock = 0
  const starts = []
  const throttle = new MimoThrottle({
    minGapMs: 1000,
    concurrency: 8,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  // 8 个请求同时抢槽，不经过 run()，直接打 waitForSlot。
  await Promise.all(Array.from({ length: 8 }, async () => {
    starts.push(await throttle.waitForSlot())
  }))
  starts.sort((a, b) => a - b)
  const unique = new Set(starts)
  assert.equal(unique.size, starts.length, `放行时刻必须两两不同，实际 ${starts}`)
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 1000, `起点间隔不足：${starts}`)
  }
})

test('MimoClient 音色：空值落默认，非法音色明确报错并列出可选值', async () => {
  const client = new MimoClient({ apiKey: 'k', baseUrl: 'u', fetchImpl: async () => okAudio() })
  assert.equal(client.resolveVoice(null), '冰糖')
  assert.equal(client.resolveVoice('  茉莉 '), '茉莉')
  assert.throws(() => client.resolveVoice('自定义音色'), (error) => (
    error.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' && /茉莉/.test(error.message)
  ))
})

test('MimoClient 合成走节流与默认音色，返回解码后的音频', async () => {
  let seenBody = null
  const client = new MimoClient({
    apiKey: 'k', baseUrl: 'u', model: 'mimo-v2.5-tts', defaultVoice: '苏打',
    throttle: new MimoThrottle({ minGapMs: 0, now: () => 0, sleep: async () => {} }),
    fetchImpl: async (_url, init) => { seenBody = JSON.parse(init.body); return okAudio() },
  })
  const audio = await client.synthesize({ text: '正文', style: '沉稳' })
  assert.equal(audio.toString(), 'RIFF')
  assert.deepEqual(seenBody.messages, [
    { role: 'user', content: '沉稳' },
    { role: 'assistant', content: '正文' },
  ])
  assert.equal(seenBody.audio.voice, '苏打')
})

test('凭据：mimo 走私有凭据库引用，不落到配置文件', () => {
  // 与团队凭据库条目同名：pack-services 会小写并把 _ 转成 -，
// 团队那条最终以小写连字符形态交给凭据服务，两边对得上。
  assert.equal(MEDIA_PROVIDER_CREDENTIAL_REFS.mimo, 'XIAOMIMIMO_API_KEY')
  assert.equal(mediaCredentialRef('mimo'), 'XIAOMIMIMO_API_KEY')
  // 引用名必须是 shell 标识符（pack-services.mjs:16 的校验），不能带点号或横线。
  assert.match(MEDIA_PROVIDER_CREDENTIAL_REFS.mimo, /^[A-Za-z_][A-Za-z0-9_]*$/u)
})

test('凭据状态提示：区分「没填」与「填错」，且不改动既有字段', async () => {
  const store = () => {
    const values = new Map()
    return {
      async resolve(ref) { const value = values.get(ref); return value ? { value, source: 'file' } : undefined },
      async describe(ref) { return { configured: values.has(ref), source: values.has(ref) ? 'file' : null, writable: true } },
      async set(ref, value) { values.set(ref, value) },
      async unset(ref) { values.delete(ref) },
    }
  }
  const mkHost = (credentials) => new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials,
    connectionSettings: { get: () => ({ provider: 'mimo' }), async update(next) { this.value = { provider: 'mimo', ...next } } },
  })

  // ① 没填
  const empty = mkHost(store())
  assert.equal((await empty.connection()).providers.mimo.credentialHint, 'missing')

  // ② 填了但还没被拒绝过
  const saved = mkHost(store())
  await saved.configureConnection({ provider: 'mimo', apiKey: 'sk-example' })
  const ok = await saved.connection()
  assert.equal(ok.providers.mimo.credentialHint, 'ok')
  // 契约冻结：既有字段名与语义不变，只多了一个可选字段。
  assert.equal(ok.providers.mimo.configured, true)
  assert.equal(ok.providers.mimo.source, 'file')
  assert.equal(ok.providers.mimo.writable, true)
  assert.deepEqual(Object.keys(ok.providers.mimo).sort(),
    ['configured', 'credentialHint', 'source', 'writable'])

  // ③ 被服务端以 401/403 拒绝：用注入的 fetch 走真实 401 响应，
  //    断言 MimoError 带上可判定的 status，且该 status 会被判为「凭据被拒」。
  const rejected = mkHost(store())
  await rejected.configureConnection({ provider: 'mimo', apiKey: 'sk-example' })
  const failing = new MimoClient({
    apiKey: 'sk-example', baseUrl: 'https://api.xiaomimimo.com/v1', defaultVoice: '冰糖',
    throttle: new MimoThrottle({ minGapMs: 0, now: () => 0, sleep: async () => {} }),
    fetchImpl: async () => new Response('{"error":{"message":"Invalid API Key"}}', {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }),
  })
  await assert.rejects(
    () => failing.synthesize({ text: '这是一次接入验证。' }),
    (error) => error.status === 401 && isCredentialRejection(error.status),
  )
  // 换新 Key 后状态应回到 ok，而不是继续停在失败态。
  await rejected.configureConnection({ provider: 'mimo', apiKey: 'sk-new' })
  assert.equal((await rejected.connection()).providers.mimo.credentialHint, 'ok')
  // 清空凭据后回到 missing，不残留 rejected。
  await rejected.clearConnectionCredential({ provider: 'mimo' })
  assert.equal((await rejected.connection()).providers.mimo.credentialHint, 'missing')
})

test('只有 401/403 算「凭据被拒」：400/429/5xx 不该让用户去换 Key', () => {
  for (const status of [401, 403]) assert.equal(isCredentialRejection(status), true)
  for (const status of [400, 402, 404, 429, 500, 502, 503, null, undefined]) {
    assert.equal(isCredentialRejection(status), false, `${status} 不应被判为凭据被拒`)
  }
})
  test('三种模式映射到三个互斥模型，且未知模式直接报错', async () => {
  assert.deepEqual(MIMO_MODES, ['preset', 'design', 'clone'])
  assert.equal(MIMO_MODEL_BY_MODE.preset, 'mimo-v2.5-tts')
  assert.equal(MIMO_MODEL_BY_MODE.design, 'mimo-v2.5-tts-voicedesign')
  assert.equal(MIMO_MODEL_BY_MODE.clone, 'mimo-v2.5-tts-voiceclone')
  const client = mkClient(async () => okAudio())
  for (const mode of MIMO_MODES) assert.equal(client.resolveModel(mode), MIMO_MODEL_BY_MODE[mode])
  assert.throws(() => client.resolveModel('sing'), (e) => e.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT')
  // synthesize 是异步的：未知模式要等得到rejection，不是同步抛。
  await assert.rejects(() => client.synthesize({ text: 'x', mode: 'sing' }),
    (e) => e.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT')
})

test('模式互斥：preset 只收预置音色、clone 只收音频、design 必须有描述', () => {
  // design 缺描述 → 报错（该模型的 user 消息必填）
  assert.throws(() => buildMimoBody({ mode: 'design', model: 'm', text: '正文', voice: null, style: '' }),
    (e) => e.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' && /音色描述/.test(e.message))
  // design 不接受音色名（混用即错）
  assert.throws(() => buildMimoBody({ mode: 'design', model: 'm', text: '正文', voice: '冰糖', style: '低沉' }),
    (e) => e.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' && /不接受音色名/.test(e.message))
  // design 正常路径：描述进 user，正文进 assistant，音色为null
  const designed = buildMimoBody({ mode: 'design', model: 'm', text: '正文', voice: null, style: '低沉男声' })
  assert.deepEqual(designed.messages, [
    { role: 'user', content: '低沉男声' },
    { role: 'assistant', content: '正文' },
  ])
  assert.equal(designed.audio.voice, null)
  // clone 必须是 data URL，不能是音色名
  assert.throws(() => buildMimoBody({ mode: 'clone', model: 'm', text: '正文', voice: '冰糖', style: '' }),
    (e) => e.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT' && /参考音频/.test(e.message))
  // preset 拒绝非预置音色
  assert.throws(() => buildMimoBody({ mode: 'preset', model: 'm', text: '正文', voice: '自定义', style: '' }),
    (e) => e.code === 'SPOKEN_VIDEO_MEDIA_INVALID_INPUT')
})

test('音频标签拼进正文（不是单独字段），以 (标签) 开头', () => {
  // 无标签：正文原样
  assert.equal(buildTaggedText('今天讲电池。', []), '今天讲电池。')
  assert.equal(buildTaggedText('今天讲电池。', ['', '  ']), '今天讲电池。')
  // 有标签：括号开头，然后正文
  assert.equal(buildTaggedText('今天讲电池。', ['叹气', '东北话']), '(叹气，东北话)今天讲电池。')
  // 标签随正文进 assistant，而不是另起字段
  const body = buildMimoBody({ mode: 'preset', model: 'm', text: '正文', voice: '冰糖', style: '沉稳', tags: ['叹气'] })
  assert.deepEqual(body.messages, [
    { role: 'user', content: '沉稳' },
    { role: 'assistant', content: '(叹气)正文' },
  ])
  assert.equal(body.audio.voice, '冰糖')
  // 唱歌等标签只对 tts 有意义，但那是模型侧的事，请求体不拦
  assert.equal(buildTaggedText('唱一句。', ['唱歌']), '(唱歌)唱一句。')
})

test('voicedesign 把描述放进 user；clone 把音频 data URL 放进 audio.voice', async () => {
  let seen = null
  const client = mkClient(async (_url, init) => { seen = JSON.parse(init.body); return okAudio() })
  await client.synthesize({ text: '正文', mode: 'design', style: '低沉磁性的男声' })
  assert.equal(seen.model, 'mimo-v2.5-tts-voicedesign')
  assert.deepEqual(seen.messages, [
    { role: 'user', content: '低沉磁性的男声' },
    { role: 'assistant', content: '正文' },
  ])

  await client.synthesize({ text: '正文', mode: 'clone', referenceDataUrl: 'data:audio/wav;base64,UklGRg==' })
  assert.equal(seen.model, 'mimo-v2.5-tts-voiceclone')
  assert.equal(seen.audio.voice, 'data:audio/wav;base64,UklGRg==')
  // clone 不该带预置音色名
  assert.equal(seen.audio.voice.includes('冰糖'), false)
})

test('参考音频只认 wav/mp3，其余格式走转码参数（官方限制，其它格式会 400）', () => {
  assert.deepEqual({ ...MIMO_CLONE_MIME }, { wav: 'audio/wav', mp3: 'audio/mpeg' })
  assert.equal(Object.hasOwn(MIMO_CLONE_MIME, 'm4a'), false)
  assert.equal(Object.hasOwn(MIMO_CLONE_MIME, 'aac'), false)
  // 转码目标：24kHz 单声道（与桥接已验证参数一致）
  assert.deepEqual([...MIMO_CLONE_TRANSCODE], ['-ac', '1', '-ar', '24000'])
})

test('读回路径不丢音色参数：设计描述与音频标签要随任务回传', () => {
  // 这四项（voiceDesign/audioTags）在三模式下是「音色本身」，任何一处读回漏掉，
  // 用户重试或采纳进项目时就会变成另一种声音——所以逐处钉住。
  const parsed = normalizeVoiceoverRequest({ voiceSource: 'design', voiceDesign: '低沉磁性的男声', audioTags: ['[叹气]'] })
  assert.equal(parsed.voiceDesign, '低沉磁性的男声')
  assert.deepEqual(parsed.audioTags, ['叹气'])

  // 执行记录（run）与配音任务（task）两处回读的白名单都要含新字段。
  // 这里用源码断言是因为那两处是纯对象字面量、没有可注入的观察点；
  // 断言的是「字段名还写在白名单里」，防止后人复制粘贴时漏掉。
  const source = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  // voiceDesign 在 host 源码里出现于 run/task 两处回读 + 采纳进项目，共 ≥3 次。
  assert.ok(source.split('voiceDesign').length - 1 >= 3, 'voiceDesign 至少要在 run/task/采纳 三处读回')
  assert.ok(source.split('audioTags').length - 1 >= 3, 'audioTags 至少要在 run/task/采纳 三处读回')
  // 排期侧也要带，否则定时生成会退回默认音色。
  const scheduleHost = readFileSync(new URL('../spoken-video-schedule-host.mjs', import.meta.url), 'utf8')
  assert.match(scheduleHost, /preset\.voiceDesign = voice\.voiceDesign/u)
  assert.match(scheduleHost, /preset\.audioTags = voice\.audioTags/u)
  // store 落盘白名单同样要收。
  const store = readFileSync(new URL('../spoken-video-store.mjs', import.meta.url), 'utf8')
  assert.match(store, /voiceDesign: optionalText\(input\.voiceDesign/u)
  assert.match(store, /audioTags: normalizeAudioTagList\(input\.audioTags\)/u)
})

test('标签是两套语法：开头 (风格) 由入参拼，正文 [音频标签] 由用户内插', () => {
  // 官方：`(风格)` 放正文开头（支持 ()/（）/[] 三种括号）；`[音频标签]` 放正文任意位置。
  // buildTaggedText 只拼开头那一段；正文里的方括号标签是用户自己写的，不经入参。
  assert.equal(buildTaggedText('正文', ['叹气']), '(叹气)正文')
  // 用户内插的方括号标签原样留在正文里，不被本函数改动
  assert.equal(buildTaggedText('这是[哽咽]一句。', []), '这是[哽咽]一句。')
  assert.equal(buildTaggedText('这是[哽咽]一句。', ['东北话']), '(东北话)这是[哽咽]一句。')
  // 内插标签要能数出来，且半角/全角都算
  assert.equal(countInlineAudioTags('这是[叹气]一句[哽咽]'), 2)
  assert.equal(countInlineAudioTags('这是［叹气］一句'), 1)
  assert.equal(countInlineAudioTags('没有标签'), 0)
})

test('两类标签同口径计数：入参 + 正文内插共用一个上限（防止裸传滥用）', () => {
  // 单独 8 个内插标签：刚好到上限
  assert.equal(assertTotalAudioTags('[a][b][c][d][e][f][g][h]', []), 8)
  // 入参 2 + 内插 7 = 9 → 超限。内插那种不经入参，不清点就能无限贴。
  assert.throws(() => assertTotalAudioTags('[a][b][c][d][e][f][g]', ['x', 'y']),
    (e) => /音频标签最多 8 个/.test(e.message) && /正文内插 7 个/.test(e.message))
  // 入参 8 + 内插 1 = 9 → 同样超限
  assert.throws(() => assertTotalAudioTags('[a]', Array(8).fill('x')), /音频标签最多 8 个/u)
  // 只有一种时按其数量计
  assert.equal(assertTotalAudioTags('普通正文', ['x', 'y']), 2)
  assert.equal(assertTotalAudioTags('[a][b]', []), 2)
})

test('内插标签逐条对齐前端 voice-mimo-only.test.mjs 的同一批字符串', () => {
  // 这批与前端那条用例断言的一一对应：两边跑同一批才叫口径一致。
  assert.equal(countInlineAudioTags('正文'), 0)
  assert.equal(countInlineAudioTags('[叹气]正文'), 1)
  assert.equal(countInlineAudioTags('[叹气][哽咽]正文'), 2)
  assert.equal(countInlineAudioTags('［叹气］正文'), 1, '全角方括号也要计数')
  assert.equal(countInlineAudioTags('(唱歌)歌词'), 0, '圆括号风格不占正文配额')
  // 不成对：官方语法里标签本就成对，更可能是笔误或正文标点，不替他拦
  assert.equal(countInlineAudioTags('这是[叹气一句'), 0)
  assert.equal(countInlineAudioTags('这是叹气]一句'), 0)
  assert.equal(countInlineAudioTags('只有左括号['), 0)
  assert.equal(countInlineAudioTags('只有全角［'), 0)
  assert.equal(countInlineAudioTags('缺右括号 [叹气'), 0, '不成对的不算标签')
  assert.equal(countInlineAudioTags(`[${'长'.repeat(41)}]`), 0, '超 40 字不算标签')
  assert.equal(countInlineAudioTags(`[${'长'.repeat(40)}]`), 1, '恰好 40 字仍算标签')
  assert.equal(countInlineAudioTags('[]'), 0)
  // 纯数字引用不占配额（Chief 裁决 A，与 HEAD 844eb86 同口径）。
  // 理由：口播稿里写 [1] 引用来源是真实场景，算成标签的话用户写够 9 处就被拒，
  // 而错误文案指向「音频标签」，他看着自己的引用不知道为什么被拒——必然发生；
  // 反过来「用户真想用 [5] 当标签」在官方标签表里不存在。代价方向不对称。
  assert.equal(countInlineAudioTags('见[1]。'), 0, '纯数字引用不算标签')
  assert.equal(countInlineAudioTags('见 [1] 与 [2] 的说法'), 0)
  assert.equal(countInlineAudioTags('［１］'), 0, '全角数字同样豁免')
  assert.equal(assertTotalAudioTags('[1][2][3][4][5][6][7][8][9][10]', []), 0,
    '连引 10 处文献不该占配额')
  // 引用与真标签混排：只数后者
  assert.equal(assertTotalAudioTags('据[1]说[叹气]又[2]', []), 1)
})

test('字符类回归：候选正则取到的内容若含任何括号，一律不算标签', () => {
  // 旧正则把 `［【】()（）` 写进了排除类，真正该挡的 `]` 反而漏掉——
  // `[a]b]` 会被当成标签、内容读成 `a]b`。两道判定缺一不可。
  // 修好后只取第一个成对标签 `[a]`，后面的 `b]` 是正文，不并进去。
  assert.equal(countInlineAudioTags('[a]b]'), 1, '只取 [a]，b] 是正文')
  assert.equal(countInlineAudioTags('[a[b]]'), 0, '内层再带方括号不算标签')
  assert.equal(countInlineAudioTags('[叹(气)]'), 0, '内层圆括号不算标签')
  assert.equal(countInlineAudioTags('[叹（气）]'), 0)
  assert.equal(countInlineAudioTags('[叹［气］]'), 0)
  // 【】也算括号（2026-10-21 裁决）：它在中文正文里同样是括号、同样会出现嵌套。
  // 此前后端漏了它、前端有它，`[叹【气】]` 一直是前端 0 / 后端 1 的静默分叉，
  // 靠联调用例才暴露。字符集唯一真源在 MIMO_INLINE_TAG_INNER。
  assert.equal(countInlineAudioTags('[叹【气】]'), 0, '内层【】同样不算标签')
  // 边界：正文后面跟着裸右方括号，不应被并进上一个标签
  assert.equal(countInlineAudioTags('[叹气]是]'), 1, '只取第一个成对标签')
  // 候选被判废后，正则仍推进到 match 末尾，继续找下一对——
  // 与前端 svAudioTagSlots 的 re.lastIndex 同一语义，故跨文件同形。
  // 这条曾被我误判为「两处实现不同」，实测证明等价，钉住它免得再被推翻一次。
  assert.equal(countInlineAudioTags('这是[叹气一句[哽咽]'), 0, '候选内含左方括号，整体不算标签')
  assert.equal(countInlineAudioTags('[a[b] [叹气]'), 1, '无效候选跳过后继续找下一对')
  assert.equal(countInlineAudioTags('[叹(气)] [叹气]'), 1, '内层不合格的候选不影响后续')
  // 端到端：这些形态都不占配额，不该被超限拒
  assert.equal(assertTotalAudioTags('[a[b] [叹(气)] [叹［气］]', []), 0)
})

test('标签形态校验：三种括号都接受，但标签内不得再带括号', () => {
  // 官方接受半角 ()、全角 （）与 [] 作为标签外层
  assert.deepEqual(normalizeVoiceoverRequest({ audioTags: ['(叹气)', '（哽咽）', '[沉默片刻]'] }).audioTags,
    ['叹气', '哽咽', '沉默片刻'])
  assert.deepEqual(normalizeVoiceoverRequest({ audioTags: ['叹气'] }).audioTags, ['叹气'])
  // 标签内不得再带括号（否则拼接后与官方语法冲突）
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: ['a[b]'] }), /不能包含括号/u)
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: ['a(b)'] }), /不能包含括号/u)
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: ['【a】'] }), /不能包含括号/u)
})

test('voiceSource 枚举扩回 upload 并新增 design', () => {
  assert.deepEqual([...VOICE_SOURCES].sort(), ['design', 'preset', 'reference', 'system', 'upload'])
  // design 必填描述
  assert.throws(() => normalizeVoiceoverRequest({ voiceSource: 'design' }), /音色描述/u)
  assert.equal(normalizeVoiceoverRequest({ voiceSource: 'design', voiceDesign: '低沉男声' }).voiceDesign, '低沉男声')
  // 描述不能用在别的模式上（防止前端误传）
  assert.throws(() => normalizeVoiceoverRequest({ voiceSource: 'preset', voiceId: '冰糖', voiceDesign: '低沉' }), /只在音色设计模式下有效/u)
  // upload 仍需完整参考音频
  assert.throws(() => normalizeVoiceoverRequest({ voiceSource: 'upload' }), /请先上传参考音频/u)
})

test('音频标签入参校验：去外层括号、数量与长度受限', () => {
  assert.deepEqual(normalizeVoiceoverRequest({ audioTags: ['[叹气]', '[东北话]'] }).audioTags, ['叹气', '东北话'])
  assert.deepEqual(normalizeVoiceoverRequest({}).audioTags, [])
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: '叹气' }), /必须是数组/u)
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: Array(9).fill('叹气') }), /最多 8 个/u)
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: ['[]'] }), /不能为空/u)
  assert.throws(() => normalizeVoiceoverRequest({ audioTags: ['x'.repeat(41)] }), /不能超过 40 字/u)
})
  test('凭据引用经包命名空间规范化后落到本包条目（防漂移）', () => {
  // pack-services.mjs:17：ref.toLowerCase().replaceAll('_','-')，再由
  // packCredentialRef 加上包命名空间。这里钉住规范化算法本身，避免
  // 「代码改了引用名、实际落到另一条凭据」这类静默漂移。
  const normalize = (ref) => ref.toLowerCase().replaceAll('_', '-')
  const ref = MEDIA_PROVIDER_CREDENTIAL_REFS.mimo
  assert.equal(normalize(ref), 'xiaomimimo-api-key')
  // 界面保存的那份会带包前缀（packCredentialRef），团队条目是独立通道：
// 两者并存不是 bug，也不要试图收敛成一条。见 media.mjs 里的注释。
  assert.equal(packCredentialRef('spoken-video', normalize(ref)),
    'LWB_PACK_12_SPOKEN_VIDEO_18_XIAOMIMIMO_API_KEY')
})

test('provider 注册：mimo 在白名单内，默认值已切到 mimo', () => {
  assert.ok(MEDIA_PROVIDERS.includes('mimo'))
  assert.equal(mediaServiceConfig({}).mimoModel, 'mimo-v2.5-tts')
  assert.equal(normalizeVoiceoverRequest({ text: '正文' }).provider, 'mimo')
  assert.equal(normalizeSubtitleRequest({}).provider, 'mimo')
})

test('MiMo 配置走环境变量且有安全默认（不需要 Key 也能构造配置）', () => {
  const config = mediaServiceConfig({})
  assert.equal(config.mimoBaseUrl, 'https://api.xiaomimimo.com/v1')
  assert.equal(config.mimoMinGapMs, 2000)
  const overridden = mediaServiceConfig({ LWB_SPOKEN_VIDEO_MIMO_DEFAULT_VOICE: '白桦' })
  assert.equal(overridden.mimoDefaultVoice, '白桦')
})

test('时间轴：段边界用实测时长，段间静音计入累计游标', () => {
  const timeline = buildMimoTimeline({ segments: ['第一段。', '第二段。'], durations: [2, 3] })
  assert.equal(timeline.segments.length, 2)
  assert.equal(timeline.segments[0].startMs, 0)
  assert.equal(timeline.segments[0].durMs, 2000)
  // 第二段起点 = 首段时长 + 段间 200ms 静音
  assert.equal(timeline.segments[1].startMs, 2200)
  assert.equal(timeline.segments[1].durMs, 3000)
})

test('时间轴：段内句子按字符占比分配，起止单调不倒退', () => {
  const timeline = buildMimoTimeline({ segments: ['今天讲电池。行业在变。'], durations: [4] })
  const sentences = timeline.segments[0].sentences
  assert.deepEqual(sentences.map((s) => s.text), ['今天讲电池。', '行业在变。'])
  let previous = -1
  for (const sentence of sentences) {
    assert.ok(sentence.start >= previous)
    assert.ok(sentence.end > sentence.start)
    previous = sentence.end
  }
})

test('时间轴：语速调整按时长 1/rate 同步缩放', () => {
  const normal = buildMimoTimeline({ segments: ['一。'], durations: [2] })
  const fast = buildMimoTimeline({ segments: ['一。'], durations: [2], rate: 2 })
  assert.equal(normal.segments[0].durMs, 2000)
  assert.equal(fast.segments[0].durMs, 1000)
  assert.equal(fast.scale, 0.5)
})

test('时间轴：任何缺少实测时长的输入都返回 null，绝不按字数猜时间', () => {
  assert.equal(buildMimoTimeline({ segments: [], durations: [] }), null)
  assert.equal(buildMimoTimeline({ segments: ['一。'], durations: [] }), null)
  assert.equal(buildMimoTimeline({ segments: ['一。'], durations: [1, 2] }), null)
  assert.equal(buildMimoTimeline({ segments: ['一。'], durations: [0] }), null)
  assert.equal(buildMimoTimeline({ segments: ['一。'], durations: ['abc'] }), null)
})

/**
 * 跨文件同形：后端 countInlineAudioTags 与前端 svAudioTagSlots 跑同一批字符串。
 *
 * 为什么要这条：2026-10-20 今晚两次事故的根子都是「只读源码就推断对方行为」——
 * 我读前端代码后断言它与后端「实现细节不同」，实测 14/14 全部同形，判断错了。
 * 光靠两边各自钉期望值挡不住：期望值写死，就变成各自钉住「自己以为的行为」。
 *
 * 这里改为**逐条比对两函数的实际返回值**，不写死期望值。
 *
 * 为什么不直接 import 前端包：client.js 有 6600 行且依赖整个前端运行时，
 * 拖进后端单测会又慢又脆。改为**从源码里把函数原样抽出来执行**——
 * 执行的是前端真实代码，不是复述它的逻辑。前端零感知，也不碰它的文件。
 */
test('跨文件同形：countInlineAudioTags 与前端 svAudioTagSlots 逐条返回一致', () => {
  const clientPath = new URL('../client.js', import.meta.url)
  const src = readFileSync(clientPath, 'utf8')

  // 抽取失败必须显式报错，绝不静默跳过——一次 SKIP 伪装成通过，
  // 恰好是今晚已经吃过一次的亏（那批 flaky 就是这么藏起来的）。
  const start = src.indexOf('function svAudioTagSlots')
  assert.ok(start > 0, 'client.js 里找不到 svAudioTagSlots，抽取失败——不许静默跳过')
  const end = src.indexOf('\n    }', start)
  assert.ok(end > start, 'svAudioTagSlots 函数体没有正常收尾，抽取失败')
  const body = src.slice(start, end + 6)

  let frontSlots
  assert.doesNotThrow(() => {
    frontSlots = new Function(`${body}; return svAudioTagSlots`)()
  }, '抽出的 svAudioTagSlots 无法执行——前端实现可能已改动')
  assert.equal(typeof frontSlots, 'function', '抽出的不是函数')

  const long41 = `[${'长'.repeat(41)}]`
  const long40 = `[${'长'.repeat(40)}]`
  const cases = [
    // —— 边界形态（Chief 点名要求全覆盖）——
    '[叹【气】]',          // 内层含【】：2026-10-21 漂移就靠这一条暴露
    '[叹［气］]',          // 内层含全角方括号
    '[叹(气)]',            // 内层含半角圆括号
    '[叹[气]]',            // 内层含半角方括号
    '［１］',               // 全角纯数字：曾是 0/1 分叉点
    '[1]',
    '见 [1] 与 [2] 的说法',
    '见[1]。',
    long40,                // 恰好 40 字：算标签
    long41,                // 41 字：不算标签（上限按码点算，不是 UTF-16 单元）
    '[]',
    '[叹气]',
    '[叹气][哽咽]正文',
    '［叹气］正文',         // 全角外层括号
    // —— 不成对放行 ——
    '这是[叹气一句',
    '这是叹气]一句',
    '只有左括号[',
    '只有全角［',
    // —— 匹配推进语义 ——
    '[a[b] [叹气]',       // 无效候选跳过后继续找下一对
    '这是[叹气一句[哽咽]', // 候选内含左方括号，整体不算
    '[a[b] 叹气]',
    '[叹(气)] [叹气]',     // 内层不合格的候选不影响后续
    '[叹气]是]',           // 裸收括号是正文，不并进上一个标签
    // —— 圆括号风格不占正文配额 ——
    '(唱歌)歌词',
    '正文',
  ]
  for (const text of cases) {
    assert.equal(countInlineAudioTags(text), frontSlots(text).used,
      `前后端口径分叉于 ${JSON.stringify(text)}`)
  }
})

/*
 * 内层字符集的**字面量**必须两边一致。
 *
 * 只比计数结果不够硬：计数相等有偶然性——2026-10-21 的 `【】` 漂移，就是靠
 * `[叹【气】]` 这一个输入才偶然暴露的，手挑的几个用例恰好没覆盖到的话它会一直潜伏。
 * 这条直接从两边源码里抠出字符集字面量逐字比较，与输入无关，漂一个字符就红。
 */
test('内层括号字符集：前后端源码里的字面量逐字相同（唯一真源在后端）', () => {
  const expected = MIMO_INLINE_TAG_INNER.source
  assert.equal(expected, '[[\\]［］()（）【】]',
    '后端字符集本身变了——请同步更新本断言，并确认前端也跟着改')

  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function svAudioTagSlots')
  assert.ok(start > 0, 'client.js 里找不到 svAudioTagSlots，抽取失败——不许静默跳过')
  const end = src.indexOf('\n    }', start)
  const body = src.slice(start, end + 6)

  // 前端写法是 `!/正则/.test(...)`，从函数体里抠出「含括号」那条正则的字符集。
  const found = body.match(/!\/\[(\[.*?)\]\//u)
  assert.ok(found, '前端 svAudioTagSlots 里找不到内层字符集正则，抽取失败')
  const frontSource = `[${found[1]}]`

  assert.equal(frontSource, expected,
    `前后端内层字符集漂移了：后端 ${expected} / 前端 ${frontSource}`)
})
/*
 * 回归：音频任务的 MiMo 分段进度事件必须写进 audio-tasks.json。
 *
 * 线上故障现场：任务 eb2145ce… 用音色设计合成，17.5 秒后报
 * 「媒体任务记录丢失。」，而 executionEvents 里只有「开始执行」和「执行失败」
 * 两条——**没有任何 MiMo 分段记录**。
 *
 * 根因：#mimoVoiceover 被两条路径共用（音频任务 #runAudioTask、视频运行
 * #generateVoiceover），它内部却写死了 #runEvent → #mutateRun，而后者只在
 * media/runs.json 里找 id。音频任务的 id 只存在于 audio-tasks.json，
 * 于是第一次写进度事件就抛「媒体任务记录丢失。」——合成已经成功了，
 * 却被这条记账语句炸掉整个任务。
 *
 * 断言直接钉「音频任务路径跑完 MiMo 合成不失败」，而不是钉某行源码怎么写，
 * 因为下次换实现时真正要保住的仍然是这个行为。
 */
test('音频任务的 MiMo 分段进度写进 audio-tasks.json，不因「媒体任务记录丢失」而失败', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const cwd = await mkdtemp(join(tmpdir(), 'lwb-voiceover-progress-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))

  // 0.1 秒 24kHz 单声道静音 wav。
  //
  // 以前这里用的是一段 44 字节的最小 wav，它的 data chunk 长度为 0——
  // ffprobe 读不出 duration，normalizeProbe 返回 durationSeconds=null，
  // 于是任务在探测那一步就 fail 了，**根本走不到写进度事件那行**。
  // 断言里的 probeBlocked 分支只兜 EPERM/spawn，兜不住「探测成功但时长为 0」，
  // 结果这条用例长期没测到它声称要测的东西。换成真正有数据的 wav 才有效。
  const wav = (() => {
    const samples = 2400 // 24kHz × 0.1s
    const buffer = Buffer.alloc(44 + samples * 2)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + samples * 2, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)   // PCM
    buffer.writeUInt16LE(1, 22)   // 单声道
    buffer.writeUInt32LE(24_000, 24)
    buffer.writeUInt32LE(48_000, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(samples * 2, 40)
    return buffer // 静音即全零，Buffer.alloc 已清零
  })()
  const audioReply = {
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] }),
  }

  const agent = { id: 'test', workspacePath: cwd, cwd }
  // 记录 fetch 次数：>0 才说明真的走到了 MiMo 合成（而不是在更早就被拦下）。
  const fetchCalls = { count: 0 }
  const host = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: { resolve: async () => ({ value: 'sk-test-mimo' }), describe: async () => ({ configured: true, writable: true }) },
    fetch: async () => { fetchCalls.count += 1; return audioReply },
  })

  // 用音色设计模式（与线上失败任务同一条路径），正文短到只分一段，
  // 这样第 1 段的进度事件就是必踩的那一行。
  const started = await host.startAudioTask(agent, {
    subtitleEnabled: false,
    text: '这是用来验证音频任务进度记录的一句话。',
    title: '进度事件回归',
    provider: 'mimo',
    voiceSource: 'design',
    voiceDesign: '三十岁出头的男声，中音区，音色清爽不厚重。',
  })

  // 等任务跑到终态。
  let task = null
  for (let i = 0; i < 200; i += 1) {
    const list = await host.listAudioTasks(agent, {})
    task = (list.items || list.tasks || []).find((item) => item.id === started.id)
    if (task && ['succeeded', 'failed'].includes(task.status)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  assert.ok(task, '任务应当能被读回')
  // 核心断言：不能因记账失败。合成本身是成功的（fetch 返回了合法 wav）。
  assert.notEqual(task.error && String(task.error).includes('媒体任务记录丢失'), true,
    '音频任务不应在写进度事件时抛「媒体任务记录丢失」')
  const { readFile } = await import('node:fs/promises')
  const onDisk = JSON.parse(await readFile(join(cwd, 'data', 'audio-tasks.json'), 'utf8'))
  const stored = onDisk.tasks.find((item) => item.id === started.id)
  assert.ok(stored, '任务应当落盘')
  const labels = (stored.executionEvents || []).map((event) => event.label)
  // 走到 MiMo 合成这一步本身证明 fetch 被调用过、模式正确地送进去了。
  assert.equal(fetchCalls.count > 0, true, 'MiMo 合成应当被实际调用')
  // 进度事件写在 #probe 之后。受限沙箱禁止子进程，ffprobe 会 EPERM，
  // 那种环境里事件确实还没写——此时只要求错误是环境限制而非记账失败。
  // 能跑 ffprobe 的机器上则必须有分段进度，证明事件落进了 audio-tasks.json。
  const probeBlocked = /EPERM|spawn/iu.test(String(task.error || ''))
  if (probeBlocked) {
    assert.equal(task.status, 'failed')
    assert.equal(typeof stored.executionEvents, 'object', '执行事件结构必须还在')
  } else {
    assert.ok(labels.some((label) => label.includes('小米 MiMo 配音合成')), `缺 MiMo 分段进度：${labels.join(' / ')}`)
  }
})

/*
 * 上一条在禁止子进程的沙箱里跑不到进度事件那一行（ffprobe 先 EPERM），
 * 所以这里再补一条**不依赖子进程**的结构断言，钉住真正的病灶：
 * #mimoVoiceover 的进度事件必须走按存储分发的 #progressEvent，
 * 不能写死 #runEvent（runs.json）——那正是线上「媒体任务记录丢失」的成因。
 */
test('#mimoVoiceover 的进度事件按存储分发，不写死 runs.json', async () => {
  const source = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async #mimoVoiceover(')
  assert.ok(start > 0, '#mimoVoiceover 必须还在')
  // 截到下一个方法定义为止。
  const nextMethod = source.indexOf('\n  async #', start + 10)
  const body = source.slice(start, nextMethod > 0 ? nextMethod : undefined)

  assert.match(body, /#progressEvent\(root, run, /u, '#mimoVoiceover 必须用按存储分发的 #progressEvent')
  assert.doesNotMatch(body, /#runEvent\(/u, '#mimoVoiceover 不得写死 #runEvent：音频任务的 id 不在 runs.json 里')

  // 分发器本身两种都要能写。
  assert.match(source, /async #progressEvent\(root, record, label, detail = null\)/u)
  assert.match(source, /const inAudioTasks = \(await readAudioTasks\(root\)\)\.tasks\.some\(\(task\) => task\.id === record\.id\)/u)
  assert.match(source, /\? this\.#audioEvent\(root, record\.id, label, detail\)/u)
  assert.match(source, /: this\.#runEvent\(root, record\.id, label, detail\)/u)
})

/**
 * 并发配音不改变成片：拼接顺序必须严格按段序，与完成先后无关。
 *
 * 这是「配音改并发」唯一真正的风险点——如果按完成顺序 push，某段网络慢
 * 就会让整篇语序错乱。这里用乱序完成的 worker 直接验证 mapWithConcurrency
 * 的保序契约（它是 #bailianVoiceover / #mimoVoiceover 共用的底座）。
 */
test('并发合成保序：完成顺序打乱，结果仍按输入索引排列', async () => {
  const source = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  // 取出 mapWithConcurrency 的实现体，在测试里独立求值，避免依赖宿主类。
  const start = source.indexOf('async function mapWithConcurrency(')
  assert.ok(start > 0, 'mapWithConcurrency 必须存在')
  // 先统一换行符再切片：仓库里 core.autocrlf=true，任何一次 checkout/stash
  // 都可能把文件变成 CRLF，按 '\n}\n' 找函数结尾会直接找不到（2026-11-06 实测：
  // 换行符一变，函数体切出来是空的，测试报「不是一个完整函数」）。
  const body = source.replace(/\r\n/g, '\n')
  const end = body.indexOf('\n}\n', start)
  assert.ok(end > start, 'mapWithConcurrency 必须是一个完整函数')
  const factory = new Function(`${body.slice(start, end + 3)}\nreturn mapWithConcurrency`)
  const mapWithConcurrency = factory()

  const items = ['a', 'b', 'c', 'd', 'e', 'f']
  // 故意让越靠前的段越慢：若按完成顺序收集，结果会完全反过来。
  const results = await mapWithConcurrency(items, 3, async (item, index) => {
    await new Promise((resolve) => setTimeout(resolve, (items.length - index) * 5))
    return `${item}${index}`
  })
  assert.deepEqual(results, ['a0', 'b1', 'c2', 'd3', 'e4', 'f5'], '结果必须按输入顺序，而不是完成顺序')
})

test('并发合成失败语义：任一分支抛错即整体失败，且不再启动后续条目', async () => {
  const source = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async function mapWithConcurrency(')
  const body = source.replace(/\r\n/g, '\n')
  const end = body.indexOf('\n}\n', start)
  const factory = new Function(`${body.slice(start, end + 3)}\nreturn mapWithConcurrency`)
  const mapWithConcurrency = factory()

  const started = []
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
      started.push(item)
      if (item === 2) throw new Error('第 2 段失败')
      return item
    }),
    /第 2 段失败/u,
  )
  assert.ok(started.length < 8, `失败后不应再启动全部条目，实际启动了 ${started.length} 个`)
})

test('配音并发度：配置项存在、有上限，且两个 voiceover 路径都真的用了它', async () => {
  const media = readFileSync(new URL('../spoken-video-media.mjs', import.meta.url), 'utf8')
  assert.match(media, /ttsConcurrency:\s*number\(environment\.LWB_SPOKEN_VIDEO_TTS_CONCURRENCY/u, '必须有独立的配音并发配置项')
  assert.match(media, /'配音并发数',\s*1,\s*8,\s*4/u, '并发上限应为 8，默认 4')

  const host = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  const bailian = host.slice(host.indexOf('async #bailianVoiceover('))
  const bailianBody = bailian.slice(0, bailian.indexOf('\n  /**', 1))
  assert.match(bailianBody, /mapWithConcurrency\(segments, config\.ttsConcurrency/u, '百炼配音必须走限并发')

  const mimo = host.slice(host.indexOf('async #mimoVoiceover('))
  const mimoBody = mimo.slice(0, mimo.indexOf('\n  /**', 1))
  // MiMo 配音的并发度：clone 串行、其余走配置值。锁的是「按模式分流」这个
  // 事实本身，具体取值见下面那条专门的回归用例。
  assert.match(mimoBody, /mapWithConcurrency\(segments, concurrency/u, 'MiMo 配音必须走按模式分流的并发度')
  // 音色/模式必须在循环外解析：并发时每段若各自解析，可能拿到不同音色。
  assert.match(mimoBody, /const mode = input\.voiceSource === 'upload'/u, '模式必须在并发循环外解析')
  assert.match(mimoBody, /const referenceDataUrl = mode === 'clone'/u, '参考音频必须在并发循环外解析')
})

/**
 * 声音克隆必须串行合成。
 *
 * 2026-10-26 线上实测：两条成片（燃气聚能环、AI自动炒股）的配音连续 8 次
 * 失败，报「小米 TTS 请求过于频繁（429）：Too many requests」。逐变量复现后
 * 结论明确：
 *   · preset 模式 4 路并发 → 4 段全 200
 *   · clone 模式 4 路并发 → 只有第 1 段 200，其余全部 429
 *   · clone 模式**串行**、起点间隔仍 2 秒 → 4 段全 200
 *
 * 即 MiMo 对 voiceclone 的限流按**同时在飞的请求数**算（复刻每次要带约 700KB
 * 参考音频，服务端算重请求），官方标的 RPM 100 只对预置音色成立。
 */
test('声音克隆（clone）串行合成，预置音色仍走配置的并发度', async () => {
  const host = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  const mimo = host.slice(host.indexOf('async #mimoVoiceover('))
  const mimoBody = mimo.slice(0, mimo.indexOf('\n  /**', 1))
  // clone → 1；其余 → 配置值。
  assert.match(mimoBody, /const concurrency = mode === 'clone' \? 1 : config\.ttsConcurrency/u,
    'clone 模式必须串行（concurrency=1），其余模式沿用配置的并发度')
  // 前提是 mode 在循环外已经算好——否则这里拿到的 mode 恒为空。
  const modeAt = mimoBody.indexOf("const mode = input.voiceSource === 'upload'")
  const concAt = mimoBody.indexOf('const concurrency = mode ===')
  assert.ok(modeAt >= 0 && concAt > modeAt, 'mode 必须先于 concurrency 求出')
})

test('MiMo 单段重试：429 退避按限流类型给足，段级尝试次数不少于 3 次', async () => {
  // 2026-10-26 实测：clone 被 429 时，原来固定 3 秒的退避**不够**——服务端对
  // 复刻请求的限流窗口更长，3 秒后重试仍是 429，每段白白烧掉一次机会，
  // 整轮配音全灭（连续 8 次任务失败）。实测串行 + 15 秒间隔下 4 段全 200。
  const host = readFileSync(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  const mimo = host.slice(host.indexOf('async #mimoVoiceover('))
  const mimoBody = mimo.slice(0, mimo.indexOf('\n  /**', 1))
  assert.match(mimoBody, /error\.status === 429/u, '429 必须单独处理')
  assert.match(mimoBody, /retryAfterMs/u, '必须优先采用服务端给的 Retry-After')
  assert.match(mimoBody, /15_000/u, '429 的退避下限必须是 15 秒')
  assert.match(mimoBody, /const maxAttempts = 3/u, '段级尝试次数必须不少于 3 次')
})
