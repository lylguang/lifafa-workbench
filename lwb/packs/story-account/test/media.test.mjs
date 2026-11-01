import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { storyCoverLayout, wrapStoryHeadline, escapeDrawText, STORY_COVER_SIZE, pickStoryFont } from '../story-account-cover.mjs'
import { buildProportionalCues, checkScriptForVoice, normalizeStoryVoiceRequest, STORY_VOICE_DEFAULT, STORY_TTS_MAX_CHARS } from '../story-account-voice.mjs'
import { requestStoryVoiceover, requestStoryVoicePreview, STORY_VOICE_RECIPES, STORY_BUILTIN_VOICES, STORY_VOICE_DEFAULT_RECIPE_ID } from '../story-account-voice.mjs'
import { buildStoryBeats, normalizeStoryPalette, STORY_PALETTES, STORY_RENDER_SPEC } from '../story-account-render.mjs'
import { useRoomyTempScratch } from '../../../test-utils/scratch-temp.mjs'

// 配音预览与封面合成会写真实字节；系统盘快满的机器上这些写入会失败，门就红在环境上。
// 选址口径与 launcher 一致，理由见 ../../../test-utils/scratch-temp.mjs。
useRoomyTempScratch()

/* --------------------------------- 封面 --------------------------------- */

test('封面是竖屏 3:4，符合信息流裁切', () => {
  assert.equal(STORY_COVER_SIZE.width, 1080)
  assert.equal(STORY_COVER_SIZE.height, 1440)
})

test('封面字号按目标每行字数倒推，一行至少装 10 字', () => {
  const layout = storyCoverLayout()
  const perLine = Math.floor((STORY_COVER_SIZE.width - layout.sideMargin * 2) / layout.fontSize)
  assert.ok(perLine >= 10, `一行只有 ${perLine} 字`)
})

test('封面大字折行后一字不丢', () => {
  const layout = storyCoverLayout()
  const perLine = Math.floor((STORY_COVER_SIZE.width - layout.sideMargin * 2) / layout.fontSize)
  for (const headline of [
    '锅里的鱼记得吃完',
    '离婚那天他给我发了条微信让我把鱼吃完',
    '最后我还是没有回头看她一眼',
    '床垫上那个凹痕他一直没有收拾',
  ]) {
    const lines = wrapStoryHeadline(headline, perLine, 2)
    assert.equal(lines.join(''), headline, `${headline} 折行丢字`)
  }
})

test('封面折行不会把结构助词顶到行首', () => {
  const lines = wrapStoryHeadline('离婚那天他给我发了条微信让我把鱼吃完', 10, 2)
  for (const line of lines.slice(1)) {
    assert.ok(!/^[了着过得地所]|^[条个只件张份次回]/u.test(line), `行首是虚词或量词：${line}`)
  }
})

test('短标题不折行', () => {
  assert.deepEqual(wrapStoryHeadline('我不饿', 10, 2), ['我不饿'])
  assert.deepEqual(wrapStoryHeadline('', 10, 2), [])
})

test('drawtext 转义挡住冒号与百分号', () => {
  const escaped = escapeDrawText("他问:'走不走' 100%")
  // ffmpeg 的 filtergraph 用冒号分隔参数、用百分号做时间格式，两者都必须转义。
  assert.ok(escaped.includes('\\%'), `未转义百分号：${escaped}`)
  assert.ok(/\\:/u.test(escaped) || !escaped.includes(':'), `未转义冒号：${escaped}`)
  assert.ok(!escaped.includes("'"), '单引号必须换掉，否则会截断 filtergraph')
})

test('封面字体探测不抛错', () => {
  const font = pickStoryFont()
  assert.equal(font === null || typeof font === 'string', true)
})

/* --------------------------------- 配音 --------------------------------- */

test('情感故事默认语速慢于日常说话', () => {
  assert.ok(STORY_VOICE_DEFAULT.rate < 1)
  assert.ok(STORY_VOICE_DEFAULT.rate >= 0.8)
})

test('语速超上限被拒绝：念快了会毁稿', () => {
  assert.throws(() => normalizeStoryVoiceRequest({ rate: 1.5 }), /语速/u)
  assert.throws(() => normalizeStoryVoiceRequest({ rate: 0.5 }), /语速/u)
  assert.equal(normalizeStoryVoiceRequest({ rate: 1.1 }).rate, 1.1)
})

test('空稿件不能配音', () => {
  assert.throws(() => checkScriptForVoice('   '), /稿件为空/u)
})

test('超长稿件被拒绝，并说明为什么', () => {
  assert.throws(() => checkScriptForVoice('鱼'.repeat(STORY_TTS_MAX_CHARS + 1)), /上限/u)
  const ok = checkScriptForVoice('鱼'.repeat(120))
  assert.equal(ok.charCount, 120)
  assert.ok(ok.estimatedSeconds > 0)
})

test('字幕按标点切分且时间单调递增', () => {
  const body = '「妈，锅里的鱼你吃吧，我不饿。」年初三晚上，我在厨房说完这句，就把碗放回水池。水龙头开得很大。我没关。'
  const { cues, aligned } = buildProportionalCues({ body, durationSeconds: 20 })
  assert.equal(aligned, false, '降级路径必须标记未对齐')
  assert.ok(cues.length >= 4)
  for (let index = 1; index < cues.length; index += 1) {
    assert.ok(cues[index].startMs >= cues[index - 1].startMs)
    assert.ok(cues[index].endMs > cues[index].startMs)
  }
  assert.equal(cues[0].startMs, 0)
})

test('字幕切分不产出只有标点的条目', () => {
  const { cues } = buildProportionalCues({ body: '「妈，锅里的鱼你吃吧，我不饿。」年初三晚上，我在厨房说完这句。', durationSeconds: 18 })
  for (const cue of cues) {
    assert.ok(/[\u4e00-\u9fa5A-Za-z0-9]/u.test(cue.text), `纯标点字幕：${JSON.stringify(cue.text)}`)
  }
})

test('空稿件的字幕为空而不是抛错', () => {
  const result = buildProportionalCues({ body: '', durationSeconds: 10 })
  assert.deepEqual(result.cues, [])
  assert.equal(result.charCount, 0)
})

/* -------------------------------- 画布节拍 ------------------------------- */

const SCRIPT = [
  '「妈，锅里的鱼你吃吧，我不饿。」',
  '年初三晚上，我在厨房说完这句，就把碗放回水池。',
  '水龙头开得很大。我没关。',
  '我妈坐在饭桌那头，没抬头，只说了一句：「那你明天几点走。」',
].join('\n')

test('画面节拍拼接后还原原文', () => {
  const beats = buildStoryBeats({ body: SCRIPT, durationSeconds: 30 })
  assert.equal(beats.map((beat) => beat.text).join(''), SCRIPT.replace(/\n/gu, ''))
})

test('画面节拍不把成对引号拆开', () => {
  const beats = buildStoryBeats({ body: SCRIPT, durationSeconds: 30 })
  for (const beat of beats) {
    assert.ok(!['」', '』', '”', '）', '》'].includes(beat.text), `孤立收尾标点：${beat.text}`)
  }
})

test('画面节拍百分比从 0 单调走到 1', () => {
  const beats = buildStoryBeats({ body: SCRIPT, durationSeconds: 30 })
  assert.equal(beats[0].startPercent, 0)
  assert.ok(Math.abs(beats[beats.length - 1].endPercent - 1) < 1e-9)
  for (let index = 1; index < beats.length; index += 1) {
    assert.ok(beats[index].startPercent >= beats[index - 1].endPercent - 1e-12)
  }
})

test('空稿件不能切节拍', () => {
  assert.throws(() => buildStoryBeats({ body: '   ', durationSeconds: 10 }), /没有可切分/u)
})

test('渲染规格就是抖音竖屏要求', () => {
  assert.equal(STORY_RENDER_SPEC.width, 1080)
  assert.equal(STORY_RENDER_SPEC.height, 1920)
  assert.equal(STORY_RENDER_SPEC.fps, 30)
})

test('未知调色板回落到默认而不是报错', () => {
  assert.equal(normalizeStoryPalette('nope').key, 'dusk')
  for (const key of Object.keys(STORY_PALETTES)) {
    assert.equal(normalizeStoryPalette(key).key, key)
  }
})

/* -------------------------------- 声音方案 ------------------------------- */

test('不选声音方案时默认用温柔女声', () => {
  const request = normalizeStoryVoiceRequest({})
  assert.equal(request.recipeId, STORY_VOICE_DEFAULT_RECIPE_ID)
  assert.equal(request.model, 'mimo-v2.5-tts')
  assert.equal(request.voiceId, '冰糖')
  assert.ok(request.rate < 1)
})

test('声音方案把音色、语气与语速一次配齐', () => {
  for (const recipe of STORY_VOICE_RECIPES) {
    const request = normalizeStoryVoiceRequest({ recipeId: recipe.id })
    assert.equal(request.recipeId, recipe.id)
    assert.equal(request.model, recipe.model)
    assert.equal(request.rate, recipe.rate)
    if (recipe.model === 'mimo-v2.5-tts') {
      assert.ok(STORY_BUILTIN_VOICES.includes(request.voiceId))
      assert.equal(request.voiceDesign, null)
    } else {
      assert.ok(request.voiceDesign, `${recipe.id} 缺音色描述`)
      assert.equal(request.voiceId, null)
    }
  }
})

test('未知声音方案被拒绝并列出可选项', () => {
  assert.throws(() => normalizeStoryVoiceRequest({ recipeId: 'nope' }), /声音方案/u)
})

test('音色设计缺描述时被拒绝：没有描述就合成不出声音', () => {
  assert.throws(() => normalizeStoryVoiceRequest({ model: 'mimo-v2.5-tts-voicedesign', voiceDesign: '' }), /音色描述/u)
})

test('不在内置音色表里的音色被拒绝', () => {
  assert.throws(() => normalizeStoryVoiceRequest({ model: 'mimo-v2.5-tts', voiceId: '不存在的音色' }), /内置音色表/u)
})

/* ------------------------------ 配音调用协议 ---------------------------- */

async function withFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try { await run() } finally { globalThis.fetch = original }
}

test('配音走桥接任务协议，不会打到不存在的 /v1/tts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-voice-'))
  const seen = []
  try {
    await withFetch(async (url, init = {}) => {
      seen.push({ url: String(url), method: init.method || 'GET' })
      if (String(url).endsWith('/api/v1/tts/jobs') && (init.method || 'GET') === 'POST') {
        return new Response(JSON.stringify({ success: true, data: { job_id: 'job-1', status: 'queued' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).includes('/api/v1/tts/jobs/job-1')) {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', duration: 12.5, result: { audio_url: 'http://127.0.0.1:8199/audio-files/job-1.wav' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).includes('/audio-files/')) {
        return new Response(Buffer.alloc(2048, 3), { status: 200 })
      }
      throw new Error(`未预期的请求：${url}`)
    }, async () => {
      const result = await requestStoryVoiceover({
        workspacePath: dir,
        text: '「妈，锅里的鱼你吃吧，我不饿。」',
        voice: { recipeId: 'warm-story' },
        runId: 'run-test',
        environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
      })
      assert.equal(result.audio.file, 'media/voiceovers/run-test.wav')
      assert.equal(result.audio.durationSeconds, 12.5)
      const info = await stat(join(dir, 'data', 'media', 'voiceovers', 'run-test.wav'))
      assert.ok(info.size > 0, '音频必须真的落盘')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  assert.ok(seen.every((item) => !item.url.endsWith('/v1/tts')), '不能请求 /v1/tts：媒体服务没有这个端点')
  assert.ok(seen.some((item) => item.method === 'POST' && item.url.endsWith('/api/v1/tts/jobs')))
})

test('配音失败时报出真实端点，不再只给一个 404', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-voice-'))
  try {
    await withFetch(async () => new Response(JSON.stringify({ success: false, message: '没有这个端点' }), { status: 404, headers: { 'content-type': 'application/json' } }), async () => {
      await assert.rejects(
        requestStoryVoiceover({
          workspacePath: dir,
          text: '测试稿',
          voice: {},
          environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
        }),
        /\/api\/v1\/tts\/jobs/u,
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('试听走桥接试合成端点并回传音频地址', async () => {
  await withFetch(async (url) => {
    assert.ok(String(url).endsWith('/admin/mimo-test'), `试听端点不对：${url}`)
    return new Response(JSON.stringify({ ok: true, seconds: 3.2, url: '/audio-files/mimo-test-1.wav' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    const result = await requestStoryVoicePreview({
      recipeId: 'warm-story',
      environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
    })
    assert.equal(result.ok, true)
    assert.equal(result.audioUrl, 'http://127.0.0.1:8199/audio-files/mimo-test-1.wav')
  })
})

test('试听回传绝对地址时不会被拼成 base+绝对地址', async () => {
  await withFetch(async (url) => {
    assert.ok(String(url).endsWith('/admin/mimo-test'), `试听端点不对：${url}`)
    return new Response(JSON.stringify({ ok: true, seconds: 2.1, url: 'https://cdn.example.com/audio/mimo-test-9.wav' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    const result = await requestStoryVoicePreview({
      recipeId: 'warm-story',
      environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
    })
    assert.equal(result.ok, true)
    assert.equal(result.audioUrl, 'https://cdn.example.com/audio/mimo-test-9.wav', '绝对地址应原样保留，不能拼上 base')
  })
})

test('未显式配置桥接地址时试听直接报「未配置」，不再打到桥接', async () => {
  // 对应 #1：endpointConfigured 为 false（仅靠默认回退）时，应就地报「未配置」
  // 而不是把请求发到默认桥接后才因连不上而报晦涩错误。
  await assert.rejects(
    requestStoryVoicePreview({ recipeId: 'warm-story', environment: {} }),
    (err) => err && err.code === 'STORY_VOICE_UNAVAILABLE',
    '未配置桥接时应报 STORY_VOICE_UNAVAILABLE',
  )
})
