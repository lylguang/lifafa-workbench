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

test('内插标签只认成对且形态合法的：短引用/不成对放行，成对超 40 字不算', () => {
  // 口播稿里 [1] 这类中括号引用是真实场景。数起始符会误判成标签、白占配额，
  // 用户改稿时莫名被拒且不知道为什么——比漏算一个标签糟糕得多，故放行。
  assert.equal(countInlineAudioTags('据[1]研究显示[2]'), 0)
  // 不成对：官方语法里标签本就成对，更可能是笔误或正文标点，不替他拦
  assert.equal(countInlineAudioTags('这是[叹气一句'), 0)
  assert.equal(countInlineAudioTags('这是叹气]一句'), 0)
  // 成对但超 40 字：形态不合法，放行
  assert.equal(countInlineAudioTags(`[${'长'.repeat(41)}]`), 0)
  // 恰好 40 字：合法，计入
  assert.equal(countInlineAudioTags(`[${'长'.repeat(40)}]`), 1)
  // 标签内含括号（嵌套）：形态不合法，放行
  assert.equal(countInlineAudioTags('[叹(气)]'), 0)
  // 成对的短引用与真标签混排：只数形态合法的那个
  assert.equal(countInlineAudioTags('据[1]说[叹气]'), 1)
  // 端到端：短引用再多也不占配额，不该被拒
  assert.equal(assertTotalAudioTags('[1][2][3][4][5][6][7][8][9][10]', []), 0)
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
