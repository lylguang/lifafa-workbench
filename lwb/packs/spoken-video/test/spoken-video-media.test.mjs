import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { buildTechnicalReport, DEFAULT_VIDEO_VISUAL_BRIEF, DEFAULT_VOICE_PROFILE, mediaServiceConfig, normalizeProbe, normalizeRenderRequest, normalizeVoiceoverRequest, subtitleResult } from '../spoken-video-media.mjs'
import { SpokenVideoProjectStore, SpokenVideoStoreError } from '../spoken-video-store.mjs'
import { SpokenVideoMediaHost, parseRemotionRenderProgress } from '../spoken-video-media-host.mjs'
import { remotionEncodingSettings, remotionRendererAvailable } from '../spoken-video-remotion.mjs'
import { buildLineArtPlanPrompt, composeLineArtPrompt, LINE_ART_PLAN_SCHEMA, lineArtSeed, normalizeLineArtPlan } from '../spoken-video-whiteboard-art.mjs'

function agent(cwd) { return { session: { header: { cwd } } } }

function credentialStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    async resolve(ref) {
      const value = values.get(ref)
      return value ? { value, source: 'file' } : undefined
    },
    async describe(ref) {
      return { configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true }
    },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
  }
}

function connectionSettings(provider = 'bailian') {
  let value = { provider }
  return {
    get: () => value,
    async update(next) { value = { ...value, ...next } },
  }
}

function mediaBinariesAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch { return false }
}

function withUnboundedBailianWavLengths(audio) {
  const result = Buffer.from(audio)
  result.writeUInt32LE(0x7fffffc7, 4)
  let offset = 12
  while (offset + 8 <= result.length) {
    const size = result.readUInt32LE(offset + 4)
    if (result.toString('ascii', offset, offset + 4) === 'data') {
      result.writeUInt32LE(0x7fffffc7, offset + 4)
      return result
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('测试 WAV 缺少 data 块。')
}

async function waitForOperation(host, currentAgent, projectId, operationId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = (await host.operations(currentAgent, { projectId })).find((item) => item.id === operationId)
    if (run?.status === 'succeeded' || run?.status === 'failed') return run
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`媒体任务 ${operationId} 在测试时未完成。`)
}

async function waitForAudioTask(host, currentAgent, taskId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const task = await host.audioTask(currentAgent, { taskId })
    if (task.status === 'succeeded' || task.status === 'failed') return task
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`音频任务 ${taskId} 在测试时未完成。`)
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-spoken-video-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return cwd
}

async function projectWithApprovedScript(currentAgent, store) {
  let project = await store.create(currentAgent, { title: '自动媒体产物' })
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title: '自动媒体产物' }, idempotencyKey: 'media-topic-0001' })).project
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'script', payload: { body: '这是已确认的口播稿，用于验证自动媒体产物。' }, idempotencyKey: 'media-script-0001' })).project
  return store.approveScript(currentAgent, { projectId: project.id })
}

async function projectWithSavedScript(currentAgent, store) {
  let project = await store.create(currentAgent, { title: '自动媒体产物' })
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title: '自动媒体产物' }, idempotencyKey: 'media-saved-topic-0001' })).project
  return (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'script', payload: { body: '这是已保存的口播稿，用于验证自动媒体产物。' }, idempotencyKey: 'media-saved-script-0001' })).project
}

async function projectWithApprovedSavedScript(currentAgent, store) {
  const project = await projectWithSavedScript(currentAgent, store)
  return store.approveScript(currentAgent, { projectId: project.id })
}

function agentWorkspaceFromPrompt(prompt) {
  const match = String(prompt).match(/任务工作目录：([^\n]+)/u)
  if (!match) throw new Error('测试未收到视频 Agent 工作目录。')
  return match[1].trim()
}

function testCreativeSource() {
  return `import React from "react";
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from "remotion";

export type SubtitleCue = {id: string; startMs: number; endMs: number; text: string};
export type CreativeVideoProps = {title: string; script: string; durationSeconds: number; orientation: "portrait" | "landscape"; subtitleEnabled: boolean; subtitles: SubtitleCue[]};

const palette = {paper: "#f5f2e9", ink: "#17242b", mint: "#2e8b78", coral: "#db6651", yellow: "#efbd4b"};
export const CreativeVideo: React.FC<CreativeVideoProps> = ({title, orientation}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const progress = frame / Math.max(1, durationInFrames - 1);
  const entered = interpolate(frame, [0, 12], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const portrait = orientation === "portrait";
  const bars = [0.28, 0.5, 0.76].map((target, index) => Math.max(0.04, Math.min(target, progress * (1.8 + index * 0.2))));
  return <AbsoluteFill style={{background: palette.paper, color: palette.ink, padding: portrait ? 92 : 76, fontFamily: "PingFang SC, sans-serif", overflow: "hidden"}}>
    <div style={{fontSize: portrait ? 30 : 26, fontWeight: 700, color: palette.mint}}>AI VISUAL DIRECTOR / REMOTION</div>
    <div style={{display: "grid", gridTemplateColumns: portrait ? "1fr" : "1fr 1fr", gap: 46, flex: 1, alignItems: "center", opacity: entered, transform: \`translateY(\${(1 - entered) * 24}px)\`}}>
      <section><h1 style={{fontSize: portrait ? 82 : 68, lineHeight: 1.12, margin: 0, letterSpacing: 0}}>{title}</h1><p style={{fontSize: portrait ? 32 : 28, lineHeight: 1.5}}>从原始信息到可验证结论，画面用流程、对比和数据变化建立叙事。</p></section>
      <section style={{display: "grid", gap: 28}}>{bars.map((value, index) => <div key={index}><div style={{display: "flex", justifyContent: "space-between", fontSize: 24}}><span>{["输入", "判断", "结果"][index]}</span><strong>{Math.round(value * 100)}</strong></div><div style={{height: 30, background: "#d7d5cd", marginTop: 9}}><div style={{height: "100%", width: \`\${value * 100}%\`, background: [palette.mint, palette.coral, palette.yellow][index]}} /></div></div>)}</section>
    </div>
    <div style={{height: 8, width: \`\${progress * 100}%\`, background: palette.coral}} />
  </AbsoluteFill>;
};
`
}

async function withTestVoiceover(cwd, store, currentAgent, project, name, idempotencyKey) {
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  const relativeFile = `media/voiceovers/${name}.wav`
  await mkdir(join(projectRoot, 'media', 'voiceovers'), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', join(projectRoot, relativeFile)], { stdio: 'ignore' })
  return (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey, source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: relativeFile, mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
}

/**
 * 字幕是视频制作的必经阶段：画面场景边界取自字幕时间轴，没有它画面对不上配音。
 * 这个 fixture 补一条最简字幕产物，供原本只准备配音的测试使用。
 */
async function withTestSubtitles(store, currentAgent, project, name, idempotencyKey) {
  const relativeFile = `media/subtitles/${name}.srt`
  const srt = '1\n00:00:00,000 --> 00:00:00,700\n这是测试字幕第一句。\n\n2\n00:00:00,700 --> 00:00:01,400\n这是测试字幕第二句。\n'
  return (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey, source: 'spoken-video/asr',
    payload: { mode: 'asr', sourceAudioFile: 'media/voiceovers/test.wav', srtFile: relativeFile, srt },
  })).project
}

async function fakeVideoCreator({ prompt, onDshStarted, onDshEvent }) {
  await onDshStarted({ childSessionId: 'creator-child-001', parentSessionId: 'video-parent-001' })
  await onDshEvent({ seq: 1, time: Date.now(), type: 'turn/start' })
  await writeFile(join(agentWorkspaceFromPrompt(prompt), 'src', 'CreativeVideo.tsx'), testCreativeSource())
  await onDshEvent({ seq: 2, time: Date.now(), type: 'turn/end', data: { reason: { kind: 'completed' } } })
  return { childSessionId: 'creator-child-001', output: 'completed' }
}

async function passingVideoReviewer({ prompt, onDshStarted, onDshEvent }) {
  await onDshStarted({ childSessionId: 'reviewer-child-001', parentSessionId: 'video-parent-001' })
  await onDshEvent({ seq: 1, time: Date.now(), type: 'turn/start' })
  const timestamps = [...String(prompt).matchAll(/- ([0-9.]+) 秒：/gu)].map((match) => Number(match[1]))
  return {
    passed: true, technicalPass: true, editorialPass: true, score: 88, summary: '构图、节奏与稿件语义一致。', findings: [],
    reviewEvidence: [
      { timestampSeconds: timestamps[0], observedMainVisual: '开场展示标题、流程标签和三组数据条。' },
      { timestampSeconds: timestamps.at(-1), observedMainVisual: '结尾数据条完成推进并形成清晰的结果收束。' },
    ],
  }
}

test('normalizes service configuration and rejects malformed generated subtitles', () => {
  const config = mediaServiceConfig({ LWB_SPOKEN_VIDEO_TTS_BASE_URL: 'http://127.0.0.1:8020/', LWB_SPOKEN_VIDEO_TTS_USER_ID: 'local-user' })
  assert.equal(config.baseUrl, 'http://127.0.0.1:8020')
  assert.equal(config.configured, true)
  assert.equal(mediaServiceConfig({ LWB_SPOKEN_VIDEO_TTS_OUTPUT_FORMAT: 'MP3' }).outputFormat, 'mp3')
  assert.equal(mediaServiceConfig({ LWB_SPOKEN_VIDEO_BAILIAN_ASR_WS_URL: 'wss://asr.example.com/realtime' }).bailianAsrWebSocketUrl, 'wss://asr.example.com/realtime')
  assert.throws(() => mediaServiceConfig({ LWB_SPOKEN_VIDEO_TTS_BASE_URL: 'file:///tmp/service' }), /CONFIG_INVALID/u)
  assert.throws(() => mediaServiceConfig({ LWB_SPOKEN_VIDEO_BAILIAN_ASR_WS_URL: 'file:///tmp/asr' }), /CONFIG_INVALID/u)
  assert.throws(() => mediaServiceConfig({ LWB_SPOKEN_VIDEO_TTS_OUTPUT_FORMAT: 'flac' }), /只支持 wav/u)
  assert.equal(subtitleResult({ subtitle_srt: '1\n00:00:00,000 --> 00:00:01,000\n你好' }).cueCount, 1)
  const structured = subtitleResult({
    subtitle_srt: '1\n00:00:00,000 --> 00:00:01,000\n旧字幕',
    status: 'completed',
    result: {
      subtitle_segments: [
        { index: 2, start_time: 1200, end_time: 2500, text: '第二条字幕' },
        { index: 1, start_time: 0, end_time: 600, text: '第一条字幕' },
      ],
    },
  })
  assert.equal(structured.cueCount, 2)
  assert.equal(structured.srt, '1\n00:00:00,000 --> 00:00:00,600\n第一条字幕\n\n2\n00:00:01,200 --> 00:00:02,500\n第二条字幕\n')
  assert.throws(() => subtitleResult({ subtitle_srt: '并不是 SRT' }), /SUBTITLES_INVALID/u)
})

test('defaults voiceover requests to the packaged Tiffy reference voice', () => {
  const request = normalizeVoiceoverRequest({ provider: 'scitiger' })
  assert.equal(request.voiceSource, 'system')
  assert.equal(request.voiceName, DEFAULT_VOICE_PROFILE.name)
  assert.equal(request.voiceId, null)
  assert.equal(Object.hasOwn(request, 'apiKey'), false)
  assert.throws(() => normalizeVoiceoverRequest({ voiceSource: 'upload' }), /请先上传参考音频/u)
  const uploaded = normalizeVoiceoverRequest({ voiceSource: 'upload', referenceAudio: { id: 'voice-reference', file: 'voice-references/reference.wav', name: '我的音色.wav', mediaType: 'audio/wav' } })
  assert.equal(uploaded.voiceName, '我的音色.wav')
  assert.equal(uploaded.referenceAudio.file, 'voice-references/reference.wav')
  assert.throws(() => normalizeVoiceoverRequest({ voiceSource: 'preset' }), /必须填写音色标识/u)
})

test('normalizes the bridge voiceover overrides and rejects unknown channels', () => {
  const without = normalizeVoiceoverRequest({})
  assert.equal(without.bridge, null)
  const bridged = normalizeVoiceoverRequest({ voiceSource: 'preset', voiceId: '茉莉', bridge: { channel: 'cloud', style: '  清晰沉稳。 ' } })
  assert.deepEqual(bridged.bridge, { channel: 'cloud', style: '清晰沉稳。' })
  const styleOnly = normalizeVoiceoverRequest({ bridge: { style: '轻快一点' } })
  assert.deepEqual(styleOnly.bridge, { channel: null, style: '轻快一点' })
  assert.throws(() => normalizeVoiceoverRequest({ bridge: { channel: 'both' } }), /桥接配音方式不受支持/u)
  assert.throws(() => normalizeVoiceoverRequest({ bridge: { style: 'x'.repeat(201) } }), /桥接预期风格/u)
})

test('allows an empty video brief and applies the protected default layout', () => {
  const request = normalizeRenderRequest({ visualBrief: '   ', subtitleEnabled: false })
  assert.equal(request.visualBrief, DEFAULT_VIDEO_VISUAL_BRIEF)
  assert.equal(request.renderer, 'remotion')
  assert.equal(request.orientation, 'landscape')
  assert.equal(request.subtitleEnabled, false)
  assert.equal(request.backgroundMusic, null)
  assert.equal(normalizeRenderRequest({ orientation: 'landscape' }).orientation, 'landscape')
  assert.equal(normalizeRenderRequest({ orientation: 'landscape', visualBrief: '默认信息型竖屏口播版式。' }).visualBrief, DEFAULT_VIDEO_VISUAL_BRIEF)
  assert.equal(normalizeRenderRequest({ visualBrief: '默认信息型口播版式。' }).visualBrief, DEFAULT_VIDEO_VISUAL_BRIEF)
  assert.throws(() => normalizeRenderRequest({ orientation: 'square' }), /视频方向不受支持/u)
  const backgroundMusic = { id: 'a'.repeat(32), file: `media/bgm-uploads/${'a'.repeat(32)}.mp3`, name: '轻音乐.mp3', mediaType: 'audio/mpeg', bytes: 1024, durationSeconds: 30 }
  const withBgm = normalizeRenderRequest({ backgroundMusic, bgmVolume: 0.18 })
  assert.deepEqual(withBgm.backgroundMusic, backgroundMusic)
  assert.equal(withBgm.bgmVolume, 0.18)
  assert.throws(() => normalizeRenderRequest({ backgroundMusic, renderer: 'local-ffmpeg' }), /仅支持 Remotion/u)
})

test('budgets Remotion encoding below the media limit and caps short-video bitrate', () => {
  const durationSeconds = 276.7
  const encoding = remotionEncodingSettings(durationSeconds)
  const videoBitrateBps = Number.parseInt(encoding.videoBitrate, 10) * 1000
  const audioBitrateBps = Number.parseInt(encoding.audioBitrate, 10) * 1000
  const estimatedBytes = (videoBitrateBps + audioBitrateBps + 64_000) * durationSeconds / 8

  assert.equal(encoding.codec, 'h264')
  assert.equal(encoding.x264Preset, 'medium')
  assert.equal(encoding.audioBitrate, '128k')
  assert.equal(videoBitrateBps >= 1_900_000 && videoBitrateBps <= 2_100_000, true)
  assert.equal(estimatedBytes <= encoding.targetBytes, true)
  assert.equal(encoding.targetBytes < 80 * 1024 * 1024, true)
  assert.equal(remotionEncodingSettings(1).videoBitrate, '8000k')
  assert.equal(remotionEncodingSettings(0).videoBitrate, '8000k')
  assert.equal(remotionEncodingSettings(Number.POSITIVE_INFINITY).videoBitrate, '8000k')
})

test('resolves provider credentials privately and keeps them out of media task records', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-private-key' }),
    fetch: async () => { throw new Error('test upstream is unavailable') },
  })
  const started = await host.startVoiceover(currentAgent, {
    projectId: project.id,
    expectedRevision: project.revision,
    provider: 'bailian',
    rate: 1,
    volume: 1,
  })
  const runsPath = join(cwd, 'data', 'projects', project.id, 'media', 'runs.json')
  assert.equal((await readFile(runsPath, 'utf8')).includes('sk-private-key'), false)
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.equal(String(finished.error).includes('sk-private-key'), false)
  const [task] = await host.listTasks(currentAgent)
  assert.equal(task.projectId, project.id)
  assert.equal(task.projectTitle, project.title)
  assert.equal(task.input.provider, 'bailian')
  assert.equal(JSON.stringify(task).includes('sk-private-key'), false)
})

test('audio task account filters apply before pagination and scope status counts', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const accountA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const accountB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const host = new SpokenVideoMediaHost({ projectsStore: { async list() {
    return [
      { id: 'project-a', account: { id: accountA } },
      { id: 'project-b', account: { id: accountB } },
      { id: 'project-general', account: null },
    ]
  } } })
  const task = (id, projectId, status, second) => ({
    id, status, createdAt: `2026-09-17T00:00:${String(second).padStart(2, '0')}Z`,
    source: { projectId, title: id, text: '测试口播稿' }, input: { provider: 'bailian' },
  })
  const tasks = [
    task('a-old', 'project-a', 'failed', 1),
    task('a-middle', 'project-a', 'succeeded', 3),
    task('a-new', 'project-a', 'succeeded', 5),
    task('b-old', 'project-b', 'failed', 2),
    task('b-new', 'project-b', 'succeeded', 6),
    task('general-project', 'project-general', 'succeeded', 4),
    task('manual', null, 'failed', 7),
    task('orphan', 'missing-project', 'failed', 8),
  ]
  await mkdir(join(cwd, 'data'), { recursive: true })
  await writeFile(join(cwd, 'data', 'audio-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks }))

  const first = await host.listAudioTasks(currentAgent, { accountId: accountA, limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), ['a-new', 'a-middle'])
  assert.equal(first.total, 3)
  assert.deepEqual(first.counts, { all: 3, queued: 0, running: 0, succeeded: 2, failed: 1 })
  const second = await host.listAudioTasks(currentAgent, { accountId: accountA, offset: 2, limit: 2 })
  assert.deepEqual(second.items.map((item) => item.id), ['a-old'])
  assert.equal(second.total, 3)
  const failed = await host.listAudioTasks(currentAgent, { accountId: accountA, status: 'failed' })
  assert.deepEqual(failed.items.map((item) => item.id), ['a-old'])
  assert.equal(failed.total, 1)
  assert.deepEqual(failed.counts, first.counts, 'status chips count the account, not just the selected status')
  const search = await host.listAudioTasks(currentAgent, { accountId: accountA, query: 'new' })
  assert.deepEqual(search.items.map((item) => item.id), ['a-new'])
  assert.equal(search.total, 1)
  assert.deepEqual(search.counts, first.counts)
  const other = await host.listAudioTasks(currentAgent, { accountId: accountB })
  assert.deepEqual(other.items.map((item) => item.id), ['b-new', 'b-old'])
  assert.equal(other.counts.all, 2)
  const general = await host.listAudioTasks(currentAgent, { general: true })
  assert.deepEqual(general.items.map((item) => item.id), ['orphan', 'manual', 'general-project'])
  assert.deepEqual(general.counts, { all: 3, queued: 0, running: 0, succeeded: 1, failed: 2 })
  const empty = await host.listAudioTasks(currentAgent, { accountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
  assert.equal(empty.total, 0)
  assert.equal(empty.counts.all, 0)
  assert.deepEqual(empty.items, [])
  assert.equal((await host.listAudioTasks(currentAgent)).total, tasks.length, 'unscoped callers retain all tasks')
  await assert.rejects(host.listAudioTasks(currentAgent, { accountId: 'invalid' }), /标识/u)
})

test('keeps standalone and saved-script audio task sources immutable, with task-level subtitle saves', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const secret = 'sk-audio-task-private'
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ DASHSCOPE_API_KEY: secret }),
    fetch: async () => { throw new Error('test upstream is unavailable') },
  })
  const manual = await host.startAudioTask(currentAgent, { subtitleEnabled: false, text: '这是用户直接输入的口播稿。', title: '手动稿', provider: 'bailian' })
  assert.equal(manual.source.kind, 'manual-text')
  assert.equal(manual.source.projectId, null)
  assert.equal(manual.source.text, '这是用户直接输入的口播稿。')
  assert.equal((await waitForAudioTask(host, currentAgent, manual.id)).status, 'failed')

  const approvedBody = (await store.get(currentAgent, { projectId: project.id })).artifacts.script.data.body
  const sourced = await host.startAudioTask(currentAgent, { subtitleEnabled: false, text: approvedBody, sourceProjectId: project.id, provider: 'bailian' })
  assert.equal(sourced.source.kind, 'saved-script')
  assert.equal(sourced.source.projectId, project.id)
  assert.equal(sourced.source.text, approvedBody)
  await waitForAudioTask(host, currentAgent, sourced.id)
  assert.equal(JSON.stringify(await host.listAudioTasks(currentAgent, {})).includes(secret), false)

  const root = join(cwd, 'data')
  await mkdir(join(root, 'audio-media', 'voiceovers'), { recursive: true })
  await writeFile(join(root, 'audio-media', 'voiceovers', 'finished.wav'), 'audio')
  await writeFile(join(root, 'audio-tasks.json'), JSON.stringify({
    schemaVersion: 1,
    tasks: [{
      id: 'finished-task', type: 'voiceover', status: 'succeeded', createdAt: new Date().toISOString(),
      source: { kind: 'manual-text', title: '独立音频', text: '独立音频对应的文稿。' }, input: { provider: 'bailian' },
      result: { audio: { file: 'audio-media/voiceovers/finished.wav', mediaType: 'audio/wav', bytes: 5 } }, subtitle: { status: 'idle' },
    }],
  }))
  const saved = await host.saveAudioTaskSubtitles(currentAgent, { taskId: 'finished-task', srt: '1\n00:00:00,000 --> 00:00:01,000\n校对后的字幕。' })
  assert.equal(saved.subtitle.status, 'succeeded')
  assert.equal(saved.subtitle.srt.includes('校对后的字幕。'), true)
  assert.equal(saved.subtitle.cueCount, 1)
  assert.equal(saved.source.text, '独立音频对应的文稿。')
})

test('persists connection credentials outside the media host and never exposes their values', async () => {
  const credentials = credentialStore()
  const settings = connectionSettings()
  const first = new SpokenVideoMediaHost({ projectsStore: new SpokenVideoProjectStore(), credentials, connectionSettings: settings })
  const saved = await first.configureConnection({ provider: 'scitiger', apiKey: 'sk-persisted-connection' })
  assert.equal(saved.provider, 'scitiger')
  assert.equal(saved.providers.scitiger.configured, true)
  assert.equal(JSON.stringify(saved).includes('sk-persisted-connection'), false)

  const restarted = new SpokenVideoMediaHost({ projectsStore: new SpokenVideoProjectStore(), credentials, connectionSettings: settings })
  const status = await restarted.status()
  assert.equal(status.connection.provider, 'scitiger')
  assert.equal(status.providers.scitiger.credential.configured, true)
  assert.equal(JSON.stringify(status).includes('sk-persisted-connection'), false)

  await restarted.clearConnectionCredential({ provider: 'scitiger' })
  assert.equal((await restarted.connection()).providers.scitiger.configured, false)
})

test('submits the packaged Tiffy reference audio to SciTiger before generating voiceover', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const outputFile = join(cwd, 'upstream.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  const referenceAudio = await readFile(new URL('../assets/voices/tiffy-confident.mp3', import.meta.url))
  const observed = { upload: null, submit: null, authorization: [] }
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-tiffy-reference' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        assert.equal(init.method, 'POST')
        observed.authorization.push(init.headers.Authorization)
        const file = init.body.get('file')
        assert.equal(file.type, 'audio/mpeg')
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), referenceAudio)
        observed.upload = true
        return new Response(JSON.stringify({ success: true, data: { assetId: 'asset_tiffy_reference' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs') {
        observed.authorization.push(init.headers.Authorization)
        observed.submit = JSON.parse(init.body)
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_tiffy_reference' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_tiffy_reference') {
        observed.authorization.push(init.headers.Authorization)
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/tiffy.wav' } } }))
      }
      if (parsed.hostname === 'media.test') {
        observed.authorization.push(init.headers.Authorization)
        return new Response(outputAudio)
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startVoiceover(currentAgent, {
    projectId: project.id,
    expectedRevision: project.revision,
    provider: 'scitiger',
  })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(observed.upload, true)
  assert.equal(observed.submit.reference_audio_asset_id, 'asset_tiffy_reference')
  assert.equal(Object.hasOwn(observed.submit, 'voice_source'), false)
  assert.deepEqual(observed.authorization, ['Bearer sk-tiffy-reference', 'Bearer sk-tiffy-reference', 'Bearer sk-tiffy-reference', 'Bearer sk-tiffy-reference'])
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.voiceover.data.voiceName, DEFAULT_VOICE_PROFILE.name)
  assert.equal(detail.artifacts.voiceover.data.provider, 'scitiger')
})

test('passes bridge builtin voices and per-task overrides to SciTiger without a reference upload', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const outputFile = join(cwd, 'upstream.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  const observed = { upload: false, submit: null }
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-bridge-builtin' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') { observed.upload = true; throw new Error('builtin voices must not upload a reference') }
      if (parsed.pathname === '/api/v1/tts/jobs') {
        observed.submit = JSON.parse(init.body)
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_bridge_builtin' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_bridge_builtin') {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/builtin.wav' } } }))
      }
      if (parsed.hostname === 'media.test') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startVoiceover(currentAgent, {
    projectId: project.id,
    expectedRevision: project.revision,
    provider: 'scitiger',
    voiceSource: 'preset',
    voiceId: '茉莉',
    voiceName: '茉莉',
    rate: 1.1,
    bridge: { channel: 'cloud', style: '清晰沉稳，适合知识讲解。' },
  })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(observed.upload, false)
  assert.equal(observed.submit.voice_source, 'preset')
  assert.equal(observed.submit.voice_id, '茉莉')
  assert.equal(observed.submit.tts_provider, 'cloud')
  assert.equal(observed.submit.style, '清晰沉稳，适合知识讲解。')
  assert.equal(observed.submit.voice_settings.rate, 1.1)
  assert.equal(Object.hasOwn(observed.submit, 'reference_audio_asset_id'), false)
})

test('maps SciTiger insufficient points to an actionable user-facing error', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-no-points' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        return new Response(JSON.stringify({ success: true, data: { asset_id: 'asset_no_points' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs') {
        return new Response(JSON.stringify({ success: false, message: 'Insufficient points' }))
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段积分不足时不会进入字幕阶段的测试文稿。',
    title: '积分不足测试',
    provider: 'scitiger',
    subtitleEnabled: true,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'failed')
  assert.equal(finished.error, 'SciTiger 账户积分不足，请充值后重试，或切换到百炼 BYOK。')
  assert.equal(finished.subtitle.status, 'idle')
  assert.ok(!finished.error.includes('SPOKEN_VIDEO_MEDIA'))
})

test('blames the channel, not the voice, when the bridge rejects the credential', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-wrong-cloud-key' }),
    // 远端云端：本机部署最典型的配置错误（没带 LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL 启动）。
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://link.scitiger.cn' },
    fetch: async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        return new Response(JSON.stringify({ success: false, message: 'Invalid API key' }), { status: 401 })
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段验证渠道误配提示的测试文稿。',
    title: '渠道误配测试',
    provider: 'scitiger',
    subtitleEnabled: false,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'failed')
  // 关键回归：错误里不能再出现音色名，否则用户会去查音色而不是查渠道。
  assert.ok(!finished.error.includes(DEFAULT_VOICE_PROFILE.name), `错误信息不应归咎音色：${finished.error}`)
  assert.match(finished.error, /Invalid API key/u)
  assert.match(finished.error, /启动工作台\.cmd/u)
  assert.match(finished.error, /127\.0\.0\.1:8199/u)
})

test('explains a bridge-side auth failure against the bridge config centre', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-any' }),
    // 本机桥接不校验 bearer，所以它的 401 只可能是桥接内部（小米 Key）的问题。
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
    fetch: async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/tts/jobs') {
        return new Response(JSON.stringify({ success: false, message: '小米 TTS 返回 401：Invalid API Key' }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段验证桥接内部认证失败的测试文稿。',
    title: '桥接认证测试',
    provider: 'scitiger',
    voiceSource: 'preset',
    voiceId: '茉莉',
    subtitleEnabled: false,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /本机桥接拒绝了配音请求/u)
  assert.match(finished.error, /桥接配置中心/u)
  assert.ok(!finished.error.includes(DEFAULT_VOICE_PROFILE.name))
})

test('reports which endpoint the SciTiger channel resolves to', async () => {
  const loopback = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore(),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
  })
  const localStatus = await loopback.status()
  assert.equal(localStatus.providers.scitiger.loopback, true)
  assert.equal(localStatus.providers.scitiger.label, '本机桥接')
  assert.equal(localStatus.providers.scitiger.endpoint, 'http://127.0.0.1:8199')

  const remote = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore(),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://link.scitiger.cn' },
  })
  const remoteStatus = await remote.status()
  assert.equal(remoteStatus.providers.scitiger.loopback, false)
  assert.equal(remoteStatus.providers.scitiger.label, 'SciTiger 云端')
  // 默认值（未设置环境变量）走远端，正是需要提示用户的那一种。
  const fallback = new SpokenVideoMediaHost({ projectsStore: new SpokenVideoProjectStore(), credentials: credentialStore(), environment: {} })
  assert.equal((await fallback.status()).providers.scitiger.loopback, false)
})

test('carries the bridge channel and style through an audio task and its retry', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const outputFile = join(cwd, 'bridge-override.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  const observed = { submit: null }
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-bridge-override' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'http://127.0.0.1:8199' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/tts/jobs' && init.method === 'POST') {
        observed.submit = JSON.parse(init.body)
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_bridge_override' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_bridge_override') {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'http://127.0.0.1:8199/audio-files/bridge-override.wav' } } }))
      }
      if (parsed.pathname === '/audio-files/bridge-override.wav') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段验证桥接覆盖参数落盘的测试文稿。',
    sourceProjectId: project.id,
    provider: 'scitiger',
    voiceSource: 'preset',
    voiceId: '茉莉',
    voiceName: '茉莉',
    bridge: { channel: 'local', style: '温柔舒缓，适合情感共鸣。' },
    subtitleEnabled: false,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(observed.submit.tts_provider, 'local')
  assert.equal(observed.submit.style, '温柔舒缓，适合情感共鸣。')
  // 冻结在任务里，失败重试才能原样重放。
  const stored = await host.audioTask(currentAgent, { taskId: started.id })
  assert.deepEqual(stored.input.bridge, { channel: 'local', style: '温柔舒缓，适合情感共鸣。' })
})

test('surfaces bridge segment stage/progress as execution events during long synthesis', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const outputFile = join(cwd, 'progress-output.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  let polls = 0
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-progress' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/tts/jobs') {
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_progress' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_progress') {
        polls += 1
        // 模拟排队 + 长文案分段合成：先排队，两次中间进度，最后完成。
        if (polls === 1) return new Response(JSON.stringify({ success: true, data: { status: 'queued', queue_ahead: 2 } }))
        if (polls === 2) return new Response(JSON.stringify({ success: true, data: { status: 'processing', stage: '分段合成 1/5', progress: 18 } }))
        if (polls === 3) return new Response(JSON.stringify({ success: true, data: { status: 'processing', stage: '分段合成 3/5', progress: 54 } }))
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/progress.wav' } } }))
      }
      if (parsed.hostname === 'media.test') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段验证分段进度透传到执行记录的测试文稿。',
    provider: 'scitiger',
    voiceSource: 'preset',
    voiceId: 'voice-progress',
    subtitleEnabled: false,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  // 卡片进度：最后一次回调的阶段/百分比要留在摘要里。
  assert.equal(finished.progress?.stage, '分段合成 3/5')
  assert.equal(finished.progress?.progress, 54)
  // 执行记录在原始落盘记录里（audioTask 摘要不带事件，详情抽屉走 executionDetail）。
  const rawTasks = JSON.parse(await readFile(join(cwd, 'data', 'audio-tasks.json'), 'utf8'))
  const raw = rawTasks.tasks.find((item) => item.id === started.id)
  const labels = (raw?.executionEvents || []).map((event) => event.label)
  assert.ok(labels.some((label) => label.includes('排队中（前面还有 2 个任务）')), labels.join(' | '))
  assert.ok(labels.some((label) => label.includes('分段合成 1/5') && label.includes('18%')), labels.join(' | '))
  assert.ok(labels.some((label) => label.includes('分段合成 3/5') && label.includes('54%')), labels.join(' | '))
})

test('retries a transient SciTiger audio download instead of failing the whole voiceover', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const referenceFile = join(cwd, 'transient-reference.wav')
  const outputFile = join(cwd, 'transient-output.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-ac', '1', '-ar', '16000', referenceFile], { stdio: 'ignore' })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.4', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  const project = await projectWithApprovedScript(currentAgent, store)
  const downloads = { count: 0 }
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-transient' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        return new Response(JSON.stringify({ success: true, data: { asset_id: 'asset_transient' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs') {
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_transient' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_transient') {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/transient.wav' } } }))
      }
      if (parsed.hostname === 'media.test') {
        downloads.count += 1
        // The provider reports the job complete before the asset is retrievable.
        if (downloads.count === 1) return new Response('not found', { status: 404 })
        return new Response(outputAudio)
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段用于验证下载重试的测试文稿。',
    sourceProjectId: project.id,
    provider: 'scitiger',
    subtitleEnabled: false,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(downloads.count > 1, true, 'a transient 404 must be retried')
})

test('reports a persistent SciTiger download failure with the HTTP status and attempt count', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const downloads = { count: 0 }
  const host = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-persistent' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        return new Response(JSON.stringify({ success: true, data: { asset_id: 'asset_persistent' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs') {
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_persistent' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_persistent') {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/persistent.wav' } } }))
      }
      if (parsed.hostname === 'media.test') {
        downloads.count += 1
        return new Response('not found', { status: 404 })
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段用于验证持续下载失败的测试文稿。',
    title: '持续下载失败测试',
    provider: 'scitiger',
    subtitleEnabled: false,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /SciTiger 配音下载失败/u)
  assert.match(finished.error, /HTTP 404/u)
  assert.match(finished.error, /已重试 \d+ 次/u)
  assert.equal(downloads.count > 1, true, 'a persistent failure must still be retried before reporting')
})

test('parses Remotion render progress into real frame counts and remaining time', async () => {
  // 这些字符串取自真实的 render.log。
  assert.deepEqual(parseRemotionRenderProgress('Rendered 4200/8873, time remaining: 35m 52s'), {
    stage: 'rendering', done: 4200, total: 8873, percent: 47, remainingSeconds: 2152,
  })
  assert.deepEqual(parseRemotionRenderProgress('Rendered 8873/8873, time remaining: 0s'), {
    stage: 'rendering', done: 8873, total: 8873, percent: 100, remainingSeconds: 0,
  })
  // 首帧时没有剩余时间，百分比为 0，但帧总数必须保留。
  assert.deepEqual(parseRemotionRenderProgress('Rendered 0/8873'), {
    stage: 'rendering', done: 0, total: 8873, percent: 0, remainingSeconds: null,
  })
  assert.deepEqual(parseRemotionRenderProgress('Bundling 65%'), {
    stage: 'bundling', done: null, total: null, percent: 65, remainingSeconds: null,
  })
  assert.deepEqual(parseRemotionRenderProgress('Rendered 5/8873, time remaining: 1h 2m 3s'), {
    stage: 'rendering', done: 5, total: 8873, percent: 0, remainingSeconds: 3723,
  })
  // 无进度的日志行必须返回 null，绝不猜测。
  for (const line of ['Getting composition', 'Composition          SpokenVideo', 'Codec                h264', '', 'Rendered 5/0']) {
    assert.equal(parseRemotionRenderProgress(line), null, line)
  }
  assert.equal(parseRemotionRenderProgress(undefined), null)
})

test('validates an uploaded reference audio and freezes it into the audio task', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const referenceFile = join(cwd, 'my-reference.wav')
  const outputFile = join(cwd, 'generated.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=520:duration=0.4', '-ac', '1', '-ar', '16000', referenceFile], { stdio: 'ignore' })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=420:duration=0.4', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const referenceAudio = await readFile(referenceFile)
  const outputAudio = await readFile(outputFile)
  const observed = { uploadedAudio: null, submit: null }
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-uploaded-reference' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        const file = init.body.get('file')
        assert.equal(file.type, 'audio/wav')
        observed.uploadedAudio = Buffer.from(await file.arrayBuffer())
        return new Response(JSON.stringify({ success: true, data: { asset_id: 'asset_uploaded_reference' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs') {
        observed.submit = JSON.parse(init.body)
        return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_uploaded_reference' } }))
      }
      if (parsed.pathname === '/api/v1/tts/jobs/tts_uploaded_reference') {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/uploaded-reference.wav' } } }))
      }
      if (parsed.hostname === 'media.test') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  })
  await assert.rejects(
    host.uploadVoiceReference(currentAgent, { name: 'not-audio.wav', mediaType: 'audio/wav', data: Buffer.from('not audio').toString('base64') }),
    /参考音频无法解码/u,
  )
  const uploaded = await host.uploadVoiceReference(currentAgent, {
    name: '我的参考音频.wav',
    mediaType: 'audio/wav',
    data: referenceAudio.toString('base64'),
  })
  assert.match(uploaded.file, /^voice-references\/[a-f0-9]{32}\.wav$/u)
  assert.equal(uploaded.name, '我的参考音频.wav')
  assert.equal(uploaded.bytes, referenceAudio.length)

  const started = await host.startAudioTask(currentAgent, { subtitleEnabled: false,
    title: '上传音色测试',
    text: '这是一次上传参考音频的配音测试。',
    provider: 'scitiger',
    voiceSource: 'upload',
    referenceAudio: uploaded,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.deepEqual(observed.uploadedAudio, referenceAudio)
  assert.equal(observed.submit.reference_audio_asset_id, 'asset_uploaded_reference')
  assert.equal(Object.hasOwn(observed.submit, 'voice_id'), false)
  assert.equal(finished.input.voiceName, '我的参考音频.wav')
  assert.equal(JSON.stringify(finished).includes('audio-media/references'), false)
  const frozen = join(cwd, 'data', 'audio-media', 'references', `${started.id}.wav`)
  assert.deepEqual(await readFile(frozen), referenceAudio)
})

test('converts completed SciTiger subtitle segments into SRT without downloading the subtitle URL', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)
  const audioRelativePath = 'media/voiceovers/scitiger.wav'
  const audioPath = join(cwd, 'data', 'projects', project.id, audioRelativePath)
  await mkdir(join(cwd, 'data', 'projects', project.id, 'media', 'voiceovers'), { recursive: true })
  await writeFile(audioPath, 'generated audio')
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-scitiger-subtitle-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'scitiger', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: audioRelativePath, mediaType: 'audio/wav', bytes: 15, durationSeconds: 2 } },
  })).project
  const requests = []
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-subtitle-segments' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      requests.push(parsed.toString())
      assert.equal(init.headers.Authorization, 'Bearer sk-subtitle-segments')
      if (parsed.pathname === '/api/v1/media/audio-uploads') {
        return new Response(JSON.stringify({ success: true, data: { asset_id: 'asset_subtitle_audio' } }))
      }
      if (parsed.pathname === '/api/v1/subtitle/jobs') {
        const payload = JSON.parse(init.body)
        assert.equal(payload.audio_asset_id, 'asset_subtitle_audio')
        return new Response(JSON.stringify({ success: true, data: { job_id: 'subtitle_segments_job' } }))
      }
      if (parsed.pathname === '/api/v1/subtitle/jobs/subtitle_segments_job') {
        return new Response(JSON.stringify({
          success: true,
          data: {
            status: 'completed',
            subtitle_segments: [
              { index: 2, start_time: 1300, end_time: 2300, text: '第二句字幕。' },
              { index: 1, start_time: 0, end_time: 700, text: '第一句字幕。' },
            ],
            result: { subtitle_url: 'https://media.test/subtitles.srt?signature=valid' },
          },
        }))
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startSubtitles(currentAgent, {
    projectId: project.id,
    expectedRevision: project.revision,
    provider: 'scitiger',
    language: 'zh',
  })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(requests.some((url) => url.includes('media.test')), false)
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.subtitles.data.cueCount, 2)
  assert.equal(detail.artifacts.subtitles.data.srt, '1\n00:00:00,000 --> 00:00:00,700\n第一句字幕。\n\n2\n00:00:01,300 --> 00:00:02,300\n第二句字幕。\n')
})

test('enrols the packaged reference voice through the active Bailian endpoint and reuses it after restart', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const outputFile = join(cwd, 'upstream.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  const observed = { enrollments: 0, tts: [] }
  const credentials = credentialStore({ DASHSCOPE_API_KEY: 'sk-bailian-reference' })
  const settings = connectionSettings()
  const hostOptions = {
    projectsStore: store,
    credentials,
    connectionSettings: settings,
    environment: { LWB_SPOKEN_VIDEO_BAILIAN_BASE_URL: 'https://workspace.test/api/v1' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.hostname === 'workspace.test' && parsed.pathname === '/api/v1/services/audio/tts/customization') {
        observed.enrollments += 1
        const payload = JSON.parse(init.body)
        assert.equal(init.headers.Authorization, 'Bearer sk-bailian-reference')
        assert.equal(payload.model, 'qwen-voice-enrollment')
        assert.equal(payload.input.target_model, 'qwen3-tts-vc-2026-01-22')
        assert.match(payload.input.preferred_name, /^lwb_tiffy_[a-f0-9]{6}$/u)
        assert.equal(payload.input.audio.data.startsWith('data:audio/mpeg;base64,'), true)
        assert.equal(payload.input.language, 'zh')
        return new Response(JSON.stringify({ output: { voice: 'tiffy-enrolled-voice' } }))
      }
      if (parsed.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
        const payload = JSON.parse(init.body)
        observed.tts.push(payload)
        assert.equal(init.headers.Authorization, 'Bearer sk-bailian-reference')
        return new Response(JSON.stringify({ request_id: `tts_${observed.tts.length}`, output: { audio: { url: 'https://media.test/tiffy.wav' } } }))
      }
      if (parsed.hostname === 'media.test') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  }
  let host = new SpokenVideoMediaHost(hostOptions)
  assert.equal((await host.status()).providers.bailian.referenceVoiceConfigured, true)
  for (let index = 0; index < 3; index += 1) {
    if (index === 2) host = new SpokenVideoMediaHost(hostOptions)
    const project = await projectWithApprovedScript(currentAgent, store)
    const started = await host.startVoiceover(currentAgent, {
      projectId: project.id,
      expectedRevision: project.revision,
      provider: 'bailian',
    })
    const finished = await waitForOperation(host, currentAgent, project.id, started.id)
    assert.equal(finished.status, 'succeeded', finished.error)
    const detail = await store.get(currentAgent, { projectId: project.id })
    assert.equal(detail.artifacts.voiceover.data.voiceId, 'tiffy-enrolled-voice')
  }
  assert.equal(observed.enrollments, 1)
  assert.equal(observed.tts.length, 3)
  assert.equal(observed.tts.every((payload) => payload.model === 'qwen3-tts-vc-2026-01-22' && payload.input.voice === 'tiffy-enrolled-voice'), true)
  assert.equal(JSON.stringify(settings.get()).includes('sk-bailian-reference'), false)
  assert.equal(Object.keys(settings.get().bailianReferenceVoices).length, 1)
})

test('enrols an uploaded reference audio before Bailian synthesis', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const referenceFile = join(cwd, 'bailian-reference.wav')
  const outputFile = join(cwd, 'bailian-output.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=510:duration=0.4', '-ac', '1', '-ar', '16000', referenceFile], { stdio: 'ignore' })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=610:duration=0.4', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const referenceAudio = await readFile(referenceFile)
  const outputAudio = await readFile(outputFile)
  const observed = { enrollment: null, synthesis: null }
  const host = new SpokenVideoMediaHost({
    projectsStore: new SpokenVideoProjectStore(),
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-bailian-uploaded-reference' }),
    environment: { LWB_SPOKEN_VIDEO_BAILIAN_BASE_URL: 'https://workspace.test/api/v1' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/services/audio/tts/customization') {
        observed.enrollment = JSON.parse(init.body)
        return new Response(JSON.stringify({ output: { voice: 'uploaded-enrolled-voice' } }))
      }
      if (parsed.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
        observed.synthesis = JSON.parse(init.body)
        return new Response(JSON.stringify({ request_id: 'tts_uploaded_bailian', output: { audio: { url: 'https://media.test/uploaded-bailian.wav' } } }))
      }
      if (parsed.hostname === 'media.test') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const uploaded = await host.uploadVoiceReference(currentAgent, {
    name: '百炼参考.wav', mediaType: 'audio/wav', data: referenceAudio.toString('base64'),
  })
  const started = await host.startAudioTask(currentAgent, { subtitleEnabled: false,
    title: '百炼上传音色测试', text: '这是百炼上传音色测试。', provider: 'bailian', voiceSource: 'upload', referenceAudio: uploaded,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.match(observed.enrollment.input.preferred_name, /^lwb_voice_[a-f0-9]{6}$/u)
  const encoded = observed.enrollment.input.audio.data.replace(/^data:audio\/wav;base64,/u, '')
  assert.deepEqual(Buffer.from(encoded, 'base64'), referenceAudio)
  assert.equal(observed.synthesis.model, 'qwen3-tts-vc-2026-01-22')
  assert.equal(observed.synthesis.input.voice, 'uploaded-enrolled-voice')
  assert.equal(finished.result.voiceId, 'uploaded-enrolled-voice')
})

test('accepts Bailian WAVs with an unbounded RIFF size, retries incomplete segments, normalizes, and merges through ffmpeg', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const firstFile = join(cwd, 'first.wav')
  const secondFile = join(cwd, 'second.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-ac', '1', '-ar', '16000', firstFile], { stdio: 'ignore' })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.25', '-ac', '2', '-ar', '22050', secondFile], { stdio: 'ignore' })
  const firstAudio = await readFile(firstFile)
  const secondAudio = await readFile(secondFile)
  const firstBailianAudio = withUnboundedBailianWavLengths(firstAudio)
  const requests = { tts: 0, firstDownloads: 0, secondDownloads: 0 }
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-bailian-segmented' }),
    environment: { LWB_SPOKEN_VIDEO_BAILIAN_BASE_URL: 'https://workspace.test/api/v1' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.hostname === 'workspace.test' && parsed.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
        requests.tts += 1
        const payload = JSON.parse(init.body)
        assert.equal(payload.model, 'qwen3-tts-flash')
        assert.equal(payload.input.voice, 'test-voice')
        assert.equal(payload.input.text.length <= 400, true)
        return new Response(JSON.stringify({
          request_id: `tts_segment_${requests.tts}`,
          output: { audio: { url: `https://media.test/segment-${requests.tts}.wav` } },
        }))
      }
      if (parsed.hostname === 'media.test' && parsed.pathname === '/segment-1.wav') {
        requests.firstDownloads += 1
        const audio = requests.firstDownloads === 1 ? firstBailianAudio.subarray(0, 78) : firstBailianAudio
        return new Response(audio, { headers: { 'content-length': String(audio.length), 'content-type': 'audio/wav' } })
      }
      if (parsed.hostname === 'media.test' && parsed.pathname === '/segment-2.wav') {
        requests.secondDownloads += 1
        return new Response(secondAudio, { headers: { 'content-length': String(secondAudio.length), 'content-type': 'audio/wav' } })
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  let project = await projectWithSavedScript(currentAgent, store)
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'script', payload: { body: '甲'.repeat(401) }, idempotencyKey: 'segmented-script-001' })).project
  const task = await host.startAudioTask(currentAgent, { subtitleEnabled: false,
    sourceProjectId: project.id,
    text: '甲'.repeat(401),
    provider: 'bailian',
    voiceSource: 'preset',
    voiceId: 'test-voice',
  })
  const finished = await waitForAudioTask(host, currentAgent, task.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(finished.projectSyncError, null)
  assert.ok(finished.projectSync, 'completion must include automatic project sync')
  assert.ok((await store.get(currentAgent, { projectId: project.id })).completedStages.includes('voiceover'))
  const { executionDetail } = await import('../spoken-video-execution.mjs')
  const execution = await executionDetail({ workspacePath: cwd }, { kind: 'audio', id: task.id })
  assert.ok(execution.record.executionEvents.some((event) => event.label.includes('配音服务已返回')), 'provider completion remains inspectable')
  assert.equal(execution.assets[0].file, finished.result.audio.file)
  assert.equal(requests.tts, 2)
  assert.equal(requests.firstDownloads, 2)
  assert.equal(requests.secondDownloads, 1)
  const audioPath = join(cwd, 'data', finished.result.audio.file)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', audioPath], { encoding: 'utf8' }))
  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio')
  assert.equal(audioStream.codec_name, 'pcm_s16le')
  assert.equal(audioStream.sample_rate, '24000')
  assert.equal(audioStream.channels, 1)
  assert.equal(Number(probe.format.duration) > 0.45, true)
})

test('uses the documented Bailian realtime ASR event flow to produce timestamped subtitles', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const server = new WebSocketServer({ port: 0 })
  await new Promise((resolvePromise) => server.once('listening', resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  const port = server.address().port
  const observed = { authorization: null, model: null, session: null, appends: 0, audioBytes: 0, appendBytes: [], appendAt: [] }
  server.on('connection', (socket, request) => {
    const requestUrl = new URL(request.url, `ws://127.0.0.1:${port}`)
    observed.authorization = request.headers.authorization || null
    observed.model = requestUrl.searchParams.get('model')
    let speechStarted = false
    socket.on('message', (raw) => {
      const event = JSON.parse(String(raw))
      if (event.type === 'session.update') {
        observed.session = event.session
        socket.send(JSON.stringify({ type: 'session.updated' }))
      } else if (event.type === 'input_audio_buffer.append') {
        const bytes = Buffer.from(event.audio, 'base64')
        observed.appends += 1
        observed.audioBytes += bytes.length
        observed.appendBytes.push(bytes.length)
        observed.appendAt.push(Date.now())
        if (!speechStarted) {
          speechStarted = true
          socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'item-1', audio_start_ms: 0 }))
        }
      } else if (event.type === 'session.finish') {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-1', audio_end_ms: 500 }))
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: '实时字幕测试。' }))
        socket.send(JSON.stringify({ type: 'session.finished' }))
      }
    })
  })

  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)
  const audioRelativePath = 'media/voiceovers/realtime.wav'
  const audioPath = join(cwd, 'data', 'projects', project.id, audioRelativePath)
  await mkdir(join(cwd, 'data', 'projects', project.id, 'media', 'voiceovers'), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ac', '1', '-ar', '16000', audioPath], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-realtime-asr-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'bailian', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: audioRelativePath, mediaType: 'audio/wav', bytes: 16_000, durationSeconds: 0.5 } },
  })).project
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-realtime-test' }),
    environment: { LWB_SPOKEN_VIDEO_BAILIAN_ASR_WS_URL: `ws://127.0.0.1:${port}/api-ws/v1/realtime` },
  })
  const started = await host.startSubtitles(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, provider: 'bailian', language: 'zh',
  })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(observed.authorization, 'Bearer sk-realtime-test')
  assert.equal(observed.model, 'qwen3-asr-flash-realtime')
  assert.deepEqual(observed.session, {
    input_audio_format: 'pcm', sample_rate: 16000, input_audio_transcription: { language: 'zh' }, turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 400 },
  })
  assert.equal(observed.appends > 0, true)
  assert.equal(observed.audioBytes > 0, true)
  assert.equal(observed.appends >= 4, true, '500 ms of PCM is streamed in real-time-sized chunks')
  assert.equal(Math.max(...observed.appendBytes) <= 3_200, true)
  assert.equal(observed.appendAt.at(-1) - observed.appendAt[0] >= 250, true, 'audio chunks are paced instead of burst-sent')
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.match(detail.artifacts.subtitles.data.srt, /00:00:00,000 --> 00:00:00,250/u)
  assert.match(detail.artifacts.subtitles.data.srt, /00:00:00,238 --> 00:00:00,500/u)
  assert.match(detail.artifacts.subtitles.data.srt, /这是已确认的口播稿，/u)
  assert.match(detail.artifacts.subtitles.data.srt, /用于验证自动媒体产物。/u)
  assert.doesNotMatch(detail.artifacts.subtitles.data.srt, /实时字幕测试/u)
})

test('preserves a Bailian ASR service error when the WebSocket closes during audio streaming', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const server = new WebSocketServer({ port: 0 })
  await new Promise((resolvePromise) => server.once('listening', resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  const port = server.address().port
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const event = JSON.parse(String(raw))
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      else if (event.type === 'input_audio_buffer.append') {
        socket.send(JSON.stringify({ type: 'error', error: { message: '音频流被服务端拒绝' } }))
        socket.close(1008, 'stream rejected')
      }
    })
  })

  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)
  const audioRelativePath = 'media/voiceovers/realtime-close.wav'
  const audioPath = join(cwd, 'data', 'projects', project.id, audioRelativePath)
  await mkdir(join(cwd, 'data', 'projects', project.id, 'media', 'voiceovers'), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '1', '-ar', '16000', audioPath], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-realtime-close-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'bailian', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: audioRelativePath, mediaType: 'audio/wav', bytes: 160_000, durationSeconds: 5 } },
  })).project
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-realtime-close' }),
    environment: { LWB_SPOKEN_VIDEO_BAILIAN_ASR_WS_URL: `ws://127.0.0.1:${port}/api-ws/v1/realtime` },
  })
  const started = await host.startSubtitles(currentAgent, { projectId: project.id, expectedRevision: project.revision, provider: 'bailian', language: 'zh' })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /音频流被服务端拒绝/u)
  assert.doesNotMatch(finished.error, /readyState|WebSocket is not open/u)
})

test('builds the deterministic technical release gate from ffprobe data', () => {
  const video = normalizeProbe({ format: { duration: '12.2' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '22050' }] })
  const audio = normalizeProbe({ format: { duration: '12.0' }, streams: [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '44100' }] })
  assert.equal(video.sampleRate, 22050)
  assert.equal(audio.sampleRate, 44100)
  const passed = buildTechnicalReport({ video, audio, subtitles: { cueCount: 4 } })
  assert.equal(passed.passed, true)
  const landscape = buildTechnicalReport({ video: { ...video, width: 1920, height: 1080 }, audio, subtitles: { cueCount: 4 }, orientation: 'landscape' })
  assert.equal(landscape.passed, true)
  const failed = buildTechnicalReport({ video: { ...video, width: 1920, height: 1080, hasAudio: false }, audio, subtitles: { cueCount: 0 } })
  assert.equal(failed.passed, false)
  assert.equal(failed.issues.length >= 3, true)
  assert.deepEqual(failed.warnings, [])
  const noCaptions = buildTechnicalReport({ video, audio, subtitles: null, subtitleEnabled: false })
  assert.equal(noCaptions.passed, true)
  assert.equal(noCaptions.subtitles.enabled, false)
})

test('treats an attached album cover as audio metadata, not a real video stream', () => {
  const audio = normalizeProbe({
    format: { duration: '199.56' },
    streams: [
      { codec_type: 'audio', codec_name: 'mp3', sample_rate: '48000', duration: '199.56', disposition: { attached_pic: 0 } },
      { codec_type: 'video', codec_name: 'mjpeg', width: 360, height: 360, disposition: { attached_pic: 1 } },
    ],
  })
  assert.equal(audio.hasAudio, true)
  assert.equal(audio.durationSeconds, 199.56)
  assert.equal(audio.videoCodec, null)
  assert.equal(audio.width, null)

  const actualVideo = normalizeProbe({
    format: { duration: '10' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', width: 360, height: 360, disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', disposition: { attached_pic: 0 } },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' },
    ],
  })
  assert.equal(actualVideo.videoCodec, 'h264')
  assert.equal(actualVideo.width, 1920)
})

test('allows media production from a saved script without approval and renders without subtitles', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithSavedScript(currentAgent, store)
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  const audioDirectory = join(projectRoot, 'media', 'voiceovers')
  const audioFile = join(audioDirectory, 'no-captions.wav')
  await mkdir(audioDirectory, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', audioFile], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-no-captions-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/no-captions.wav', mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  const render = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, subtitleEnabled: false, orientation: 'landscape', renderer: 'local-ffmpeg' })
  const rendered = await waitForOperation(host, currentAgent, project.id, render.id)
  assert.equal(rendered.status, 'succeeded', rendered.error)
  const renderedProject = await store.get(currentAgent, { projectId: project.id })
  assert.equal(renderedProject.artifacts.video.data.subtitleEnabled, false)
  assert.equal(renderedProject.artifacts.video.data.orientation, 'landscape')
  assert.equal(renderedProject.artifacts.video.data.video.width, 1920)
  assert.equal(renderedProject.artifacts.video.data.video.height, 1080)
  assert.equal(renderedProject.artifacts.video.data.sourceSubtitleFile, null)
  assert.equal(renderedProject.artifacts.video.data.visualBrief, DEFAULT_VIDEO_VISUAL_BRIEF)
  const qc = await host.startTechnicalQc(currentAgent, { projectId: project.id, expectedRevision: renderedProject.revision })
  const checked = await waitForOperation(host, currentAgent, project.id, qc.id)
  assert.equal(checked.status, 'succeeded', checked.error)
  assert.equal((await store.get(currentAgent, { projectId: project.id })).artifacts.qc.data.passed, true)
})

test('lists video renders as independent frozen tasks and reads their bound media', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  const audioPath = join(projectRoot, 'media', 'voiceovers', 'frozen.wav')
  await mkdir(join(projectRoot, 'media', 'voiceovers'), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', audioPath], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'frozen-task-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/frozen.wav', mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, visualBrief: '冻结的任务说明。', subtitleEnabled: false, renderer: 'local-ffmpeg' })
  assert.equal(started.source.script.body.includes('已保存的口播稿'), true)
  assert.equal(started.source.voiceover.audio.file, 'media/voiceovers/frozen.wav')
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  const listing = await host.listVideoTasks(currentAgent, { status: 'succeeded', query: '冻结的任务说明。', limit: 8 })
  assert.equal(listing.total, 1)
  assert.equal(listing.items[0].id, started.id)
  assert.equal(listing.items[0].source.script.body.includes('已保存的口播稿'), true)
  const [video, voiceover] = await Promise.all([
    host.readVideoTaskMedia(currentAgent, { projectId: project.id, taskId: started.id, stage: 'video' }),
    host.readVideoTaskMedia(currentAgent, { projectId: project.id, taskId: started.id, stage: 'voiceover' }),
  ])
  assert.equal(video.mediaType, 'video/mp4')
  assert.equal(video.bytes > 1024, true)
  assert.equal(voiceover.mediaType, 'audio/wav')
  await assert.rejects(
    host.readVideoTaskMedia(currentAgent, { projectId: project.id, taskId: started.id, stage: 'subtitles' }),
    /只可读取任务配音、背景音乐或成片预览/u,
  )
})

test('commits host-produced media through the existing revision and downstream gates', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)

  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'cosyvoice', taskId: 'task-voice-1', voiceId: 'voice-1', voiceName: '测试音色', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/run-1.wav', mediaType: 'audio/wav', bytes: 4096, durationSeconds: 2 } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey: 'media-subtitle-0001', source: 'spoken-video/asr',
    payload: { mode: 'asr', taskId: 'task-subtitle-1', sourceAudioFile: 'media/voiceovers/run-1.wav', srtFile: 'media/subtitles/run-1.srt', srt: '1\n00:00:00,000 --> 00:00:02,000\n自动对齐字幕。' },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'video', idempotencyKey: 'media-video-0001', source: 'spoken-video/local-ffmpeg',
    payload: { mode: 'local-ffmpeg', renderer: 'local-ffmpeg', visualBrief: '竖屏口播视频。', sourceAudioFile: 'media/voiceovers/run-1.wav', sourceSubtitleFile: 'media/subtitles/run-1.srt', video: { file: 'media/videos/run-1.mp4', mediaType: 'video/mp4', bytes: 4096, durationSeconds: 2, width: 1080, height: 1920, fps: 30, hasAudio: true } },
  })).project
  await assert.rejects(
    store.commitProduced(currentAgent, {
      projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'media-qc-inconsistent-0001', source: 'spoken-video/ffprobe',
      payload: { mode: 'automatic', reportFile: 'media/qc/inconsistent.json', passed: true, technical: { passed: false, issues: ['视频缺少音轨。'], warnings: [], video: { hasAudio: false }, audio: {}, subtitles: { cueCount: 1 } } },
    }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_QC_FAILED',
  )
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'media-qc-0001', source: 'spoken-video/ffprobe',
    payload: { mode: 'automatic', reportFile: 'media/qc/run-1.json', passed: false, technical: { passed: false, issues: ['视频缺少音轨。'], warnings: [], video: { hasAudio: false }, audio: {}, subtitles: { cueCount: 1 } } },
  })).project
  await assert.rejects(
    store.commit(currentAgent, {
      projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'media-manual-qc-override-0001',
      payload: { checks: { script: true, voiceover: true, subtitles: true, video: true }, notes: '不应覆盖自动失败。' },
    }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED',
  )
  await assert.rejects(
    store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'approval', payload: { confirm: true }, idempotencyKey: 'media-approval-0001' }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_INVALID_INPUT',
  )
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.voiceover.data.audio.file, 'media/voiceovers/run-1.wav')
  assert.equal(detail.artifacts.subtitles.data.mode, 'asr')
  assert.equal(detail.artifacts.qc.passed, false)
})

test('rejects manual video production and manual technical-qc submissions', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithSavedScript(currentAgent, store)
  await assert.rejects(
    store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'video', idempotencyKey: 'manual-video-block-0001', payload: { visualBrief: '外部制作说明。' } }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED',
  )
  await assert.rejects(
    store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'manual-qc-block-0001', payload: { checks: { script: true, voiceover: true, video: true } } }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED',
  )
})

test('marks media runs interrupted by a host restart as failed', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await store.create(currentAgent, { title: '恢复媒体任务' })
  const mediaRoot = join(cwd, 'data', 'projects', project.id, 'media')
  await mkdir(mediaRoot, { recursive: true })
  await writeFile(join(mediaRoot, 'runs.json'), `${JSON.stringify({ schemaVersion: 1, runs: [{ id: 'interrupted-1', type: 'voiceover', status: 'running', projectId: project.id, expectedRevision: project.revision, createdAt: new Date(Date.now() - 5_000).toISOString() }] })}\n`)
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  const [run] = await host.operations(currentAgent, { projectId: project.id })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /主机在任务完成前已重启/u)
})

test('refuses preview media reached through a symlinked project directory', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-preview-link-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'cosyvoice', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/run-1.wav', mediaType: 'audio/wav', bytes: 4, durationSeconds: 1 } },
  })).project
  const root = join(cwd, 'data', 'projects', project.id)
  const external = join(cwd, 'outside-media')
  await mkdir(join(root, 'media'), { recursive: true })
  await mkdir(external)
  await writeFile(join(external, 'run-1.wav'), 'fake')
  await symlink(external, join(root, 'media', 'voiceovers'))
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  await assert.rejects(host.readMedia(currentAgent, { projectId: project.id, stage: 'voiceover' }), /路径无效/u)
})

test('defaults a local render to landscape and passes ffprobe technical qc', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  const audioDirectory = join(projectRoot, 'media', 'voiceovers')
  const audioFile = join(audioDirectory, 'render.wav')
  await mkdir(audioDirectory, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', audioFile], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-render-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/render.wav', mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey: 'media-render-subtitles-0001', source: 'spoken-video/asr',
    payload: { mode: 'asr', sourceAudioFile: 'media/voiceovers/render.wav', srtFile: 'media/subtitles/render.srt', srt: '1\n00:00:00,000 --> 00:00:01,000\nRender test' },
  })).project
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  const render = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, visualBrief: '测试渲染。', renderer: 'local-ffmpeg' })
  const rendered = await waitForOperation(host, currentAgent, project.id, render.id)
  assert.equal(rendered.status, 'succeeded', rendered.error)
  const renderedProject = await store.get(currentAgent, { projectId: project.id })
  assert.equal(renderedProject.artifacts.video.data.video.width, 1920)
  assert.equal(renderedProject.artifacts.video.data.video.height, 1080)
  // 关键回归：渲染必须自带技术质检产物。发布页只列 qc 通过的项目，
  // 缺 qc 的成片会被静默隐藏（这正是白板成片看不到的根因）。
  assert.equal(renderedProject.artifacts.qc?.data?.passed, true, '渲染任务必须内联提交 qc 产物')
  assert.equal(renderedProject.completedStages.includes('qc'), true)
  const qc = await host.startTechnicalQc(currentAgent, { projectId: project.id, expectedRevision: renderedProject.revision })
  const qcRun = await waitForOperation(host, currentAgent, project.id, qc.id)
  assert.equal(qcRun.status, 'succeeded', qcRun.error)
  const checkedProject = await store.get(currentAgent, { projectId: project.id })
  assert.equal(checkedProject.artifacts.qc.data.passed, true)
})

test('composeLineArtPrompt bakes the visual spec and rejects empty scenes', () => {
  const prompt = composeLineArtPrompt('a small monkey sitting on a rockery holding a banana')
  assert.match(prompt, /#F5EBD7/u)
  assert.match(prompt, /STRICTLY FORBIDDEN/u)
  assert.match(prompt, /never words to write/u)
  assert.throws(() => composeLineArtPrompt('   '), /画面视觉描述/u)
})

test('buildLineArtPlanPrompt forbids quoting narration and lists every scene', () => {
  const prompt = buildLineArtPlanPrompt([
    { index: 1, startMs: 0, endMs: 30_000, text: '第一幕旁白' },
    { index: 2, startMs: 30_000, endMs: 60_000, text: '第二幕旁白' },
  ])
  assert.match(prompt, /NEVER copy/u)
  assert.match(prompt, /Scene 1 \[0-30s\]: 第一幕旁白/u)
  assert.match(prompt, /Scene 2 \[30-60s\]: 第二幕旁白/u)
})

test('normalizeLineArtPlan aligns by scene index and falls back for missing entries', () => {
  const bySceneIndex = [{ sceneIndex: 1, text: '一' }, { sceneIndex: 2, text: '二' }, { sceneIndex: 3, text: '三' }]
  const byIndex = [{ index: 1, text: '一' }, { index: 2, text: '二' }, { index: 3, text: '三' }]
  for (const scenes of [bySceneIndex, byIndex]) {
    const plan = normalizeLineArtPlan({ scenes: [{ index: 2, visual: 'a dog running' }, { index: 99, visual: 'ignored' }] }, scenes)
    assert.equal(plan.length, 3)
    assert.doesNotMatch(plan[0].visual, /一/u, 'fallback must not embed narration text')
    assert.equal(plan[0].index, 1)
    assert.equal(plan[1].visual, 'a dog running')
    assert.match(plan[2].visual, /visual metaphor/u)
  }
  assert.equal(LINE_ART_PLAN_SCHEMA.properties.scenes.items.required.join(','), 'index,visual')
})

test('lineArtSeed is deterministic per scene and differs across scenes', () => {
  assert.equal(lineArtSeed(1), lineArtSeed(1))
  assert.notEqual(lineArtSeed(1), lineArtSeed(2))
  assert.ok(lineArtSeed(1) > 0 && lineArtSeed(1) < 2 ** 31 - 1)
})

test('whiteboard line art plan refuses projects without subtitles', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  await assert.rejects(
    () => host.whiteboardLineArtPlan(currentAgent, { projectId: project.id }),
    /必须先完成配音与字幕/u,
  )
})

test('renders a whiteboard video with voiceover audio and passes technical qc', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedScript(currentAgent, store)
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  // 配音 1 秒；字幕覆盖 0-0.9 秒，单幕
  const audioDirectory = join(projectRoot, 'media', 'voiceovers')
  const audioFile = join(audioDirectory, 'whiteboard.wav')
  await mkdir(audioDirectory, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', audioFile], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'whiteboard-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/whiteboard.wav', mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey: 'whiteboard-subtitles-0001', source: 'spoken-video/asr',
    payload: { mode: 'asr', sourceAudioFile: 'media/voiceovers/whiteboard.wav', srtFile: 'media/subtitles/whiteboard.srt', srt: '1\n00:00:00,000 --> 00:00:00,900\n白板渲染测试' },
  })).project

  // 缺线稿：任务应失败并明确提示线稿约定
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  const missingLineArt = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, visualBrief: '白板测试。', renderer: 'whiteboard' })
  const missingRun = await waitForOperation(host, currentAgent, project.id, missingLineArt.id)
  assert.equal(missingRun.status, 'failed')
  assert.match(missingRun.error, /media\/whiteboard/u)

  // 放一张带墨迹的 16:9 纸底线稿：自动骨架标注 → 渲染 → 合成音轨
  const lineArtDirectory = join(projectRoot, 'media', 'whiteboard')
  await mkdir(lineArtDirectory, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0xF5EBD7:s=1672x941:d=1', '-vf', 'drawbox=x=120:y=140:w=560:h=620:color=0x303030@1:t=6,drawbox=x=900:y=200:w=620:h=480:color=0x404040@1:t=4,drawbox=x=758:y=120:w=4:h=700:color=0x303030@1:t=fill', '-frames:v', '1', join(lineArtDirectory, 'scene-01.png')], { stdio: 'ignore' })

  const render = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, visualBrief: '白板测试。', renderer: 'whiteboard' })
  const rendered = await waitForOperation(host, currentAgent, project.id, render.id, 300_000)
  assert.equal(rendered.status, 'succeeded', rendered.error)
  const renderedProject = await store.get(currentAgent, { projectId: project.id })
  const video = renderedProject.artifacts.video.data
  assert.equal(video.renderer, 'whiteboard')
  assert.equal(video.video.width, 1920)
  assert.equal(video.video.height, 1080)
  assert.equal(video.video.hasAudio, true)
  assert.equal(video.whiteboard.scenes, 1)
  // 关键回归：白板渲染没有独立审片阶段，技术质检必须在渲染内联完成并提交。
  // 缺 qc 时发布页（只列 qc.passed 的项目）会看不到这条成片。
  assert.equal(renderedProject.artifacts.qc?.data?.passed, true, '白板渲染必须内联提交 qc 产物')
  assert.equal(renderedProject.artifacts.qc.data.mode, 'automatic')

  const qc = await host.startTechnicalQc(currentAgent, { projectId: project.id, expectedRevision: renderedProject.revision })
  const qcRun = await waitForOperation(host, currentAgent, project.id, qc.id)
  assert.equal(qcRun.status, 'succeeded', qcRun.error)
  const checkedProject = await store.get(currentAgent, { projectId: project.id })
  assert.equal(checkedProject.artifacts.qc.data.passed, true, JSON.stringify(checkedProject.artifacts.qc.data.issues))
})

test('runs the DSH Remotion creator, deterministic QC, and independent reviewer before committing', async (t) => {
  if (!mediaBinariesAvailable() || !await remotionRendererAvailable()) { t.skip('ffmpeg, ffprobe, or Remotion is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  const audioDirectory = join(projectRoot, 'media', 'voiceovers')
  const audioFile = join(audioDirectory, 'remotion.wav')
  await mkdir(audioDirectory, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', audioFile], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-remotion-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/remotion.wav', mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey: 'media-remotion-subtitles-0001', source: 'spoken-video/asr',
    payload: { mode: 'asr', sourceAudioFile: 'media/voiceovers/remotion.wav', srtFile: 'media/subtitles/remotion.srt', srt: '1\n00:00:00,000 --> 00:00:01,000\nRemotion 渲染测试。' },
  })).project
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    videoCreator: fakeVideoCreator,
    videoReviewer: passingVideoReviewer,
  })
  const bgmSource = join(cwd, 'test-bgm.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=0.4', '-c:a', 'pcm_s16le', bgmSource], { stdio: 'ignore' })
  const backgroundMusic = await host.uploadVideoBgm(currentAgent, {
    projectId: project.id,
    name: '测试背景音乐.wav',
    mediaType: 'audio/wav',
    data: (await readFile(bgmSource)).toString('base64'),
  })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, visualBrief: '清晰、克制的信息视觉。', orientation: 'landscape', renderer: 'remotion', backgroundMusic, bgmVolume: 0.16 })
  assert.equal(started.input.backgroundMusic.name, '测试背景音乐.wav')
  assert.equal(started.input.bgmVolume, 0.16)
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  const rendered = await store.get(currentAgent, { projectId: project.id })
  assert.equal(rendered.artifacts.video.data.renderer, 'remotion', JSON.stringify(rendered.artifacts.video.data.fallback || null))
  assert.equal(rendered.artifacts.video.data.orientation, 'landscape')
  assert.equal(rendered.artifacts.video.data.video.width, 1920)
  assert.equal(rendered.artifacts.video.data.video.height, 1080)
  assert.equal(rendered.artifacts.video.data.video.frameCount > 0, true)
  assert.match(rendered.artifacts.video.data.remotion.projectDir, /^media\/video-agent\//u)
  assert.equal(rendered.artifacts.video.data.remotion.preflight.passed, true)
  assert.equal(rendered.artifacts.video.data.backgroundMusic.name, '测试背景音乐.wav')
  assert.equal(rendered.artifacts.video.data.bgmVolume, 0.16)
  assert.equal(rendered.artifacts.qc.data.passed, true)
  assert.equal(rendered.artifacts.qc.data.technical.subtitles.maxTextChars, 14)
  assert.equal(rendered.artifacts.qc.data.technical.subtitles.displayLimit, 56)
  assert.equal(rendered.artifacts.qc.data.technical.subtitles.longCueCount, 0)
  assert.equal(rendered.artifacts.qc.data.review.score, 88)
  const [operation] = await host.operations(currentAgent, { projectId: project.id })
  assert.equal(operation.phase, 'completed')
  assert.equal(operation.pipeline.engine, 'dsh-remotion-ai-director')
  assert.deepEqual(operation.dsh.sessions.map((session) => session.role), ['creator', 'reviewer'])
  assert.equal(operation.result.qc.review.passed, true)
  const props = JSON.parse(await readFile(join(projectRoot, rendered.artifacts.video.data.remotion.propsFile), 'utf8'))
  assert.match(props.bgmFileName, /^background-music\.wav$/u)
  assert.equal(props.bgmVolume, 0.16)
  const bgmPreview = await host.readVideoTaskMedia(currentAgent, { projectId: project.id, taskId: started.id, stage: 'bgm' })
  assert.equal(bgmPreview.mediaType, 'audio/wav')
  assert.equal(bgmPreview.bytes, backgroundMusic.bytes)
})

test('rejects overlong subtitles during deterministic QC before independent review', async (t) => {
  if (!mediaBinariesAvailable() || !await remotionRendererAvailable()) { t.skip('ffmpeg, ffprobe, or Remotion is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  const projectRoot = join(cwd, 'data', 'projects', project.id)
  const audioDirectory = join(projectRoot, 'media', 'voiceovers')
  const audioFile = join(audioDirectory, 'long-subtitle.wav')
  await mkdir(audioDirectory, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', audioFile], { stdio: 'ignore' })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-long-subtitle-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/long-subtitle.wav', mediaType: 'audio/wav', bytes: 88_278, durationSeconds: 1 } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey: 'media-long-subtitle-captions-0001', source: 'spoken-video/asr',
    payload: { mode: 'asr', sourceAudioFile: 'media/voiceovers/long-subtitle.wav', srtFile: 'media/subtitles/long-subtitle.srt', srt: `1\n00:00:00,000 --> 00:00:01,000\n${'这是一条需要在技术质检阶段被拦截的超长字幕'.repeat(3)}` },
  })).project
  let reviewerCalled = false
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    videoCreator: fakeVideoCreator,
    videoReviewer: async () => { reviewerCalled = true; return passingVideoReviewer() },
  })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, orientation: 'portrait', renderer: 'remotion' })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /字幕超过 44 字/u)
  assert.equal(finished.pipeline.technical.subtitles.longCueCount, 1)
  assert.equal(finished.pipeline.technical.subtitles.maxTextChars > 44, true)
  assert.equal(reviewerCalled, false)
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.video, undefined)
  assert.equal(detail.artifacts.qc, undefined)
})

test('fails a Remotion task without a creator and does not commit a fallback video', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithSavedScript(currentAgent, store)
  const host = new SpokenVideoMediaHost({ projectsStore: store, videoReviewer: passingVideoReviewer })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, renderer: 'remotion', subtitleEnabled: false })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /视频创作 Agent/u)
  assert.equal((await store.get(currentAgent, { projectId: project.id })).artifacts.video, undefined)
})

test('rejects an unchanged Agent placeholder before rendering and never commits video', async (t) => {
  if (!mediaBinariesAvailable() || !await remotionRendererAvailable()) { t.skip('ffmpeg, ffprobe, or Remotion is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  project = await withTestVoiceover(cwd, store, currentAgent, project, 'placeholder', 'placeholder-voice-0001')
  project = await withTestSubtitles(store, currentAgent, project, 'placeholder', 'placeholder-voice-0001-subtitles')
  const host = new SpokenVideoMediaHost({ projectsStore: store, videoCreator: async () => ({ output: 'done' }), videoReviewer: passingVideoReviewer })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, renderer: 'remotion', subtitleEnabled: false })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /占位画面/u)
  assert.equal((await store.get(currentAgent, { projectId: project.id })).artifacts.video, undefined)
})

test('rejects creator changes to protected Remotion files before rendering', async (t) => {
  if (!mediaBinariesAvailable() || !await remotionRendererAvailable()) { t.skip('ffmpeg, ffprobe, or Remotion is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  project = await withTestVoiceover(cwd, store, currentAgent, project, 'protected', 'protected-voice-0001')
  project = await withTestSubtitles(store, currentAgent, project, 'protected', 'protected-voice-0001-subtitles')
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    videoCreator: async ({ prompt }) => {
      const runDir = agentWorkspaceFromPrompt(prompt)
      await writeFile(join(runDir, 'src', 'CreativeVideo.tsx'), testCreativeSource())
      await writeFile(join(runDir, 'src', 'Root.tsx'), '// forbidden mutation\n')
      return { output: 'done' }
    },
    videoReviewer: passingVideoReviewer,
  })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, renderer: 'remotion', subtitleEnabled: false })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /受保护文件 src\/Root\.tsx/u)
  assert.equal((await store.get(currentAgent, { projectId: project.id })).artifacts.video, undefined)
})

test('fails an independently rejected video without committing video or QC artifacts', async (t) => {
  if (!mediaBinariesAvailable() || !await remotionRendererAvailable()) { t.skip('ffmpeg, ffprobe, or Remotion is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  project = await withTestVoiceover(cwd, store, currentAgent, project, 'review-fail', 'review-fail-voice-0001')
  project = await withTestSubtitles(store, currentAgent, project, 'review-fail', 'review-fail-voice-0001-subtitles')
  let creatorCalls = 0
  let reviewerCalls = 0
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    videoCreator: async (input) => { creatorCalls += 1; return fakeVideoCreator(input) },
    videoReviewer: async ({ prompt }) => {
      reviewerCalls += 1
      const timestamps = [...String(prompt).matchAll(/^- ([0-9.]+) 秒：/gmu)].map((match) => Number(match[1]))
      return {
        passed: false, technicalPass: true, editorialPass: false, score: 52, summary: '画面叙事与稿件关联不足。',
        findings: [{ severity: 'major', category: 'relevance', timestampSeconds: timestamps[0], message: '开场主画面没有建立稿件提出的问题。' }],
        reviewEvidence: [
          { timestampSeconds: timestamps[0], observedMainVisual: '开场只有通用图表，没有呈现稿件中的具体问题。' },
          { timestampSeconds: timestamps.at(-1), observedMainVisual: '结尾仍是相同图表结构，缺少与结论对应的收束。' },
        ],
      }
    },
  })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, renderer: 'remotion', subtitleEnabled: false })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /未通过独立审片/u)
  assert.match(finished.error, /2 次定向修复/u)
  assert.equal(finished.pipeline.review.passed, false)
  assert.equal(finished.pipeline.editorialRepair.attempts, 2)
  assert.equal(finished.pipeline.editorialRepair.history.length, 3)
  assert.equal(creatorCalls, 3)
  assert.equal(reviewerCalls, 3)
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.video, undefined)
  assert.equal(detail.artifacts.qc, undefined)
})

test('repairs an editorial rejection, rerenders, and commits only the passing revision', async (t) => {
  if (!mediaBinariesAvailable() || !await remotionRendererAvailable()) { t.skip('ffmpeg, ffprobe, or Remotion is unavailable in this environment'); return }
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithApprovedSavedScript(currentAgent, store)
  project = await withTestVoiceover(cwd, store, currentAgent, project, 'review-repair', 'review-repair-voice-0001')
  project = await withTestSubtitles(store, currentAgent, project, 'review-repair', 'review-repair-voice-0001-subtitles')
  let creatorCalls = 0
  let reviewerCalls = 0
  let repairPrompt = ''
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    videoCreator: async (input) => {
      creatorCalls += 1
      if (creatorCalls > 1) repairPrompt = input.prompt
      return fakeVideoCreator(input)
    },
    videoReviewer: async (input) => {
      reviewerCalls += 1
      if (reviewerCalls > 1) return passingVideoReviewer(input)
      await input.onDshStarted({ childSessionId: 'reviewer-child-initial', parentSessionId: 'video-parent-001' })
      await input.onDshEvent({ seq: 1, time: Date.now(), type: 'turn/start' })
      const timestamps = [...String(input.prompt).matchAll(/^- ([0-9.]+) 秒：/gmu)].map((match) => Number(match[1]))
      return {
        passed: false, technicalPass: true, editorialPass: false, score: 60, summary: '主体集中在上半部，画面下方留白过大。',
        findings: [{ severity: 'major', category: 'composition', timestampSeconds: timestamps[0], message: '需要重新分配主体尺度和垂直构图。' }],
        reviewEvidence: [
          { timestampSeconds: timestamps[0], observedMainVisual: '开场主体只占据画面上半部，底部没有有效视觉信息。' },
          { timestampSeconds: timestamps.at(-1), observedMainVisual: '结尾沿用相同结构，没有形成独立的视觉收束。' },
        ],
      }
    },
  })
  const started = await host.startVideoRender(currentAgent, { projectId: project.id, expectedRevision: project.revision, renderer: 'remotion', subtitleEnabled: false })
  const finished = await waitForOperation(host, currentAgent, project.id, started.id, 180_000)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(creatorCalls, 2)
  assert.equal(reviewerCalls, 2)
  assert.match(repairPrompt, /主体集中在上半部/u)
  assert.match(repairPrompt, /重新分配主体尺度和垂直构图/u)
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.video.data.remotion.editorialRepair.attempts, 1)
  assert.equal(detail.artifacts.video.data.remotion.editorialRepair.history.length, 2)
  assert.equal(detail.artifacts.qc.data.review.passed, true)
  assert.deepEqual(finished.dsh.sessions.map((session) => session.role), ['creator', 'reviewer', 'creator-repair-1', 'reviewer-2'])
})

test('rejects an unsafe automatic media path before it becomes an artifact', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  await assert.rejects(
    store.commitProduced(currentAgent, {
      projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'media-unsafe-0001', source: 'spoken-video/tts',
      payload: { mode: 'tts', provider: 'cosyvoice', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: '../outside.wav', mediaType: 'audio/wav', bytes: 10, durationSeconds: 1 } },
    }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_FILE_INVALID',
  )
})

async function savedAudioFixture(t, { subtitle = true } = {}) {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithSavedScript(currentAgent, store)
  const detail = await store.get(currentAgent, { projectId: project.id })
  const root = join(cwd, 'data')
  await mkdir(join(root, 'audio-media', 'voiceovers'), { recursive: true })
  await writeFile(join(root, 'audio-media', 'voiceovers', 'saved-audio.wav'), 'audio')
  const task = {
    id: 'saved-audio', type: 'voiceover', status: 'succeeded', createdAt: new Date().toISOString(),
    source: { kind: 'saved-script', projectId: project.id, title: project.title, text: detail.artifacts.script.data.body, scriptRevision: detail.artifacts.script.revision },
    input: { provider: 'bailian', rate: 1, volume: 1, pitch: 0 }, projectRevision: project.revision,
    result: { provider: 'bailian', audio: { file: 'audio-media/voiceovers/saved-audio.wav', mediaType: 'audio/wav', bytes: 5, durationSeconds: 1 } },
    subtitle: subtitle ? { status: 'succeeded', current: { id: 'subtitle-one', mode: 'asr', srt: '1\n00:00:00,000 --> 00:00:01,000\n已有字幕。', cueCount: 1 } } : { status: 'idle' },
  }
  await writeFile(join(root, 'audio-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [task] }))
  const host = new SpokenVideoMediaHost({ projectsStore: store, fetch: async () => { assert.fail('sync must not call a media provider') } })
  return { cwd, root, store, currentAgent, project, task, host }
}

test('recovers completed audio and subtitles into an unapproved saved project without regeneration', async (t) => {
  const { root, store, currentAgent, project, task, host } = await savedAudioFixture(t)
  // A previous failed commit may already have copied the immutable media file.
  const orphanDirectory = join(root, 'projects', project.id, 'media', 'voiceovers')
  await mkdir(orphanDirectory, { recursive: true })
  await writeFile(join(orphanDirectory, `${task.id}.wav`), 'audio')
  const synced = await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.equal(synced.status, 'succeeded')
  assert.equal(synced.projectSyncError, null)
  assert.equal(synced.subtitleSyncError, null)
  let detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.scriptApproval, null)
  assert.ok(detail.completedStages.includes('voiceover'))
  assert.ok(detail.completedStages.includes('subtitles'))
  assert.equal(detail.artifacts.subtitles.data.sourceAudioFile, detail.artifacts.voiceover.data.audio.file)
  const revision = detail.revision
  const repeated = await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.equal(repeated.projectSyncError, null)
  assert.equal(repeated.subtitleSyncError, null)
  assert.equal((await store.get(currentAgent, { projectId: project.id })).revision, revision, 'repeated recovery must not invalidate downstream work')
  const updated = await host.saveAudioTaskSubtitles(currentAgent, { taskId: task.id, srt: '1\n00:00:00,000 --> 00:00:01,000\n校对后的字幕。' })
  assert.equal(updated.subtitleSyncError, null)
  detail = await store.get(currentAgent, { projectId: project.id })
  assert.match(detail.artifacts.subtitles.data.srt, /校对后的字幕/u)
  await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.equal((await store.get(currentAgent, { projectId: project.id })).revision, detail.revision)
})

test('sync preserves independent audio and reports changed scripts or newer voiceovers', async (t) => {
  const { store, currentAgent, project, task, host } = await savedAudioFixture(t, { subtitle: false })
  await host.syncAudioTask(currentAgent, { taskId: task.id })
  let detail = await store.get(currentAgent, { projectId: project.id })
  detail = (await store.commit(currentAgent, { projectId: detail.id, expectedRevision: detail.revision, stage: 'voiceover', idempotencyKey: 'newer-voice-version', payload: { notes: '其他配音' } })).project
  const stale = await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.match(stale.projectSyncError, /其他配音版本/u)
  assert.equal(stale.status, 'succeeded')
  assert.equal((await store.get(currentAgent, { projectId: project.id })).revision, detail.revision)
  detail = (await store.commit(currentAgent, { projectId: detail.id, expectedRevision: detail.revision, stage: 'script', idempotencyKey: 'changed-script-version', payload: { body: '修改后的新稿件。' } })).project
  const changed = await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.match(changed.projectSyncError, /当前稿件版本不一致/u)
  assert.ok(!(await store.get(currentAgent, { projectId: project.id })).completedStages.includes('voiceover'))
})

test('missing audio produces a visible recoverable sync error without marking generation failed', async (t) => {
  const { root, host, currentAgent, task, store, project } = await savedAudioFixture(t)
  const file = join(root, task.result.audio.file)
  await rm(file)
  const failed = await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.equal(failed.status, 'succeeded')
  assert.match(failed.projectSyncError, /同步项目失败/u)
  assert.equal(failed.projectSync, null)
  assert.ok(!(await store.get(currentAgent, { projectId: project.id })).completedStages.includes('voiceover'))
  await writeFile(file, 'audio')
  const retried = await host.syncAudioTask(currentAgent, { taskId: task.id })
  assert.equal(retried.projectSyncError, null)
  assert.equal(retried.subtitleSyncError, null)
  assert.ok((await store.get(currentAgent, { projectId: project.id })).completedStages.includes('subtitles'))
})

test('audio tasks default to automatic subtitles, isolate ASR failures, and allow opting out', async (t) => {
  if (!mediaBinariesAvailable()) { t.skip('ffmpeg or ffprobe is unavailable'); return }
  const cwd = await workspace(t)
  const voiceFile = join(cwd, 'auto-subtitle.wav')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', voiceFile])
  const audio = await readFile(voiceFile)
  const currentAgent = agent(cwd)
  for (const scenario of ['success', 'asr-failure', 'submission-failure', 'opt-out']) {
    const store = new SpokenVideoProjectStore()
    const project = await projectWithApprovedScript(currentAgent, store)
    const work = []
    let asrCalls = 0
    const host = new SpokenVideoMediaHost({
      projectsStore: store, pollIntervalMs: 1,
      background: (promise) => { work.push(promise); return promise },
      environment: { LWB_SPOKEN_VIDEO_TTS_BASE_URL: 'https://fixture.test' },
      fetch: async (url) => {
        const path = new URL(String(url)).pathname
        if (path === '/api/v1/tts/synthesize') return new Response(JSON.stringify({ code: 200, data: { task_id: 'voice' } }))
        if (path === '/api/v1/tts/tasks/voice') return new Response(JSON.stringify({ code: 200, data: { status: 'completed', duration: 1 } }))
        if (path === '/api/v1/tts/tasks/voice/audio') return new Response(audio)
        if (path === '/api/v1/subtitles/generate') {
          asrCalls += 1
          if (scenario === 'asr-failure') throw new Error('fixture ASR unavailable')
          return new Response(JSON.stringify({ code: 200, data: { task_id: 'subtitle' } }))
        }
        if (path === '/api/v1/subtitles/tasks/subtitle') return new Response(JSON.stringify({ code: 200, data: { status: 'completed', subtitle_srt: '1\n00:00:00,000 --> 00:00:01,000\n自动生成字幕。' } }))
        throw new Error(`unexpected fixture request ${path}`)
      },
    })
    if (scenario === 'submission-failure') host.startAudioTaskSubtitles = async () => { throw new Error('fixture subtitle submission failed') }
    const started = await host.startAudioTask(currentAgent, { text: (await store.get(currentAgent, { projectId: project.id })).artifacts.script.data.body, sourceProjectId: project.id, provider: 'legacy', ...(scenario === 'opt-out' ? { subtitleEnabled: false } : {}) })
    // Drain voiceover plus any work it schedules; no background writes survive cleanup.
    for (let index = 0; index < work.length; index += 1) await work[index]
    const finished = await host.audioTask(currentAgent, { taskId: started.id })
    assert.equal(finished.status, 'succeeded', `${scenario}: ${finished.error}`)
    assert.equal(finished.error, null)
    assert.deepEqual(Buffer.from((await host.readAudioTaskMedia(currentAgent, { taskId: started.id })).data, 'base64'), audio)
    assert.ok(finished.projectSync, `${scenario}: audio still syncs into the project`)
    assert.equal(finished.subtitle.status, scenario === 'success' ? 'succeeded' : scenario === 'opt-out' ? 'idle' : 'failed')
    if (scenario === 'success') {
      assert.equal(asrCalls, 1)
      assert.equal(finished.subtitle.cueCount, 1)
      assert.ok((await store.get(currentAgent, { projectId: project.id })).completedStages.includes('subtitles'))
    } else if (scenario === 'opt-out') assert.equal(asrCalls, 0)
    else assert.match(finished.subtitle.error, /fixture/u)
  }
})

test('both subtitle paths run the timeline guard, so a drifting cloud SRT cannot reach the video', async () => {
  // 回归（2026-10-01《牡丹亭》）：守卫原先只装在视频路径 #generateSubtitles 上，
  // 「配音 / 字幕」页走的 #runAudioTaskSubtitles 完全没有守卫。于是配音页产出的
  // 漂移 SRT 会原样落进项目，而白板成片的场景切场与烧录字幕都从这份 SRT 推导——
  // 实测字幕比语音滞后 6~10 秒。这条不变量必须在两条路径上都成立。
  const source = await readFile(new URL('../spoken-video-media-host.mjs', import.meta.url), 'utf8')
  const videoPath = source.slice(source.indexOf('async #generateSubtitles('), source.indexOf('async #renderVideo('))
  const audioPath = source.slice(source.indexOf('async #runAudioTaskSubtitles('), source.indexOf('async #syncAudioTaskSubtitles('))
  assert.ok(videoPath.length > 0 && audioPath.length > 0, '两条字幕路径都必须存在')
  assert.match(videoPath, /guardSubtitleTimeline\(\{ audioPath, srt:/u, '视频路径必须运行对齐守卫')
  assert.match(audioPath, /guardSubtitleTimeline\(\{ audioPath, srt:/u, '配音页路径必须运行对齐守卫')
  // 守卫结论要写进 diagnostics，否则线上无从判断这次是否修正过。
  assert.match(audioPath, /result\.diagnostics = \{ \.\.\.\(result\.diagnostics \|\| \{\}\), alignmentGuard \}/u)
})

test('the guard corrects a subtitle track that lags the speech', async (t) => {
  // 端到端跑真实守卫（含 VAD），输入复刻《牡丹亭》的漂移特征：文本全对、时间轴整体
  // 滞后数秒。断言它判 corrected 并把 cue 拉回真实发声位置。
  const { guardSubtitleTimeline, parseSrt } = await import('../spoken-video-subtitle-align.mjs')
  const { mkdtemp: mk, writeFile: wf, rm: rmrf } = await import('node:fs/promises')
  const { tmpdir: td } = await import('node:os')
  const dir = await mk(join(td(), 'lwb-align-'))
  t.after(() => rmrf(dir, { recursive: true, force: true }))
  const audioPath = join(dir, 'voice.wav')
  await wf(audioPath, 'placeholder')

  // 合成 PCM：8 段语音（每段 2s，句间静音 1.5s）→ 真实开口时刻 0/3.5/7/10.5/14/17.5/21/24.5s。
  // 守卫要求至少 6 条 cue 才评估，这里用 8 条贴近真实口播密度。
  const SR = 8000
  const truth = [0, 3.5, 7, 10.5, 14, 17.5, 21, 24.5]
  const pcm = new Float32Array(28 * SR)
  for (const start of truth) {
    for (let i = Math.round(start * SR); i < Math.round((start + 2) * SR) && i < pcm.length; i++) {
      pcm[i] = 0.35 * Math.sin((i / SR) * 2 * Math.PI * 220) * (0.6 + 0.4 * Math.sin((i / SR) * 30))
    }
  }
  // 原始 SRT 每条都比真实开口晚 5 秒。
  const lagging = truth.map((s, i) => `${i + 1}\n${srtStamp(s + 5)} --> ${srtStamp(s + 7)}\n第 ${i + 1} 句话。`).join('\n\n') + '\n'

  const result = await guardSubtitleTimeline({
    audioPath, srt: lagging, language: 'zh',
    // decodePcm 的契约是直接返回 Float32Array（宿主用 ffmpeg 解 8k 单声道）。
    decodePcm: async () => pcm,
    probeAvailable: async () => false,
  })
  assert.equal(result.applied, true, `滞后的 SRT 必须被修正：${result.guard?.reason}`)
  assert.equal(result.guard.verdict, 'corrected')
  const corrected = parseSrt(result.srt)
  assert.equal(corrected.length, truth.length, '修正不得改变 cue 条数')
  // 修正后每条都应落回真实开口附近。此处 ASR 不可用、走纯 VAD 占比模型，
  // 文档标注其固有误差约 1.5s（实测稳定偏 -1.5s），因此容差取 1.6s；
  // 关键是它把原本 5s 的滞后压回秒级，且不再单调漂移。
  for (let i = 0; i < truth.length; i++) {
    assert.ok(Math.abs(corrected[i].start - truth[i]) <= 1.6,
      `第 ${i + 1} 条应从 ${truth[i] + 5}s 修正到 ~${truth[i]}s，实际 ${corrected[i].start.toFixed(2)}s`)
  }
  // 修正必须整体前移（原 SRT 滞后），而不是原地不动。
  assert.ok(corrected[corrected.length - 1].start < truth[truth.length - 1] + 5,
    '修正后末条必须明显前移')
})

/** SRT 时间戳（HH:MM:SS,mmm）。 */
function srtStamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`
}

test('manual audio without a project can be adopted into an empty project on demand', async (t) => {
  const { cwd, root, store, currentAgent, task, host } = await savedAudioFixture(t)
  // 把任务改成无项目手动任务（模拟「新建配音任务」直贴文案）。
  const manual = { ...task, id: 'manual-adopt', source: { kind: 'manual-text', projectId: null, title: '手动输入文稿', text: '这是手动粘贴的口播文稿，用于验证采纳链路。' }, projectSync: null, projectRevision: null }
  await writeFile(join(root, 'audio-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [task, manual] }))
  // 目标项目只有 topic，没有稿件。
  let target = await store.create(currentAgent, { title: '采纳目标' })
  target = (await store.commit(currentAgent, { projectId: target.id, expectedRevision: target.revision, stage: 'topic', payload: { title: '采纳目标' }, idempotencyKey: 'adopt-topic-0001' })).project
  const synced = await host.syncAudioTask(currentAgent, { taskId: 'manual-adopt', targetProjectId: target.id })
  assert.equal(synced.status, 'succeeded', synced.projectSyncError || synced.error)
  assert.equal(synced.projectSyncError, null, synced.projectSyncError)
  const detail = await store.get(currentAgent, { projectId: target.id })
  assert.match(detail.artifacts.script.data.body, /手动粘贴的口播文稿/u, '任务文稿应登记为项目稿件')
  assert.ok(detail.completedStages.includes('voiceover'), '配音应挂到项目')
  assert.ok(detail.completedStages.includes('subtitles'), '字幕应挂到项目')
  assert.equal(synced.projectSync.projectId, target.id)
})

test('adopting into a project with a different script is rejected, not overwritten', async (t) => {
  const { root, store, currentAgent, project, task, host } = await savedAudioFixture(t)
  const manual = { ...task, id: 'manual-conflict', source: { kind: 'manual-text', projectId: null, title: '手动输入文稿', text: '与项目稿件完全不同的一段文本。' }, projectSync: null, projectRevision: null }
  await writeFile(join(root, 'audio-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [task, manual] }))
  await assert.rejects(
    host.syncAudioTask(currentAgent, { taskId: 'manual-conflict', targetProjectId: project.id }),
    /已有不同稿件/u,
  )
})

test('autoAdoptProjectId: manual voiceover lands in the chosen project right after synthesis', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  // 目标项目只有 topic，没有稿件（自动采纳要补 topic 之后的稿件）。
  let target = await store.create(currentAgent, { title: '自动放目标' })
  target = (await store.commit(currentAgent, { projectId: target.id, expectedRevision: target.revision, stage: 'topic', payload: { title: '自动放目标' }, idempotencyKey: 'auto-topic-0001' })).project
  const outputFile = join(cwd, 'auto-adopt.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-ac', '1', '-ar', '16000', outputFile], { stdio: 'ignore' })
  const outputAudio = await readFile(outputFile)
  let polls = 0
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_SCITIGER_API_KEY: 'sk-auto' }),
    environment: { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://scitiger.test' },
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/media/audio-uploads') return new Response(JSON.stringify({ success: true, data: { asset_id: 'asset_auto' } }))
      if (parsed.pathname === '/api/v1/tts/jobs' && init.method === 'POST') return new Response(JSON.stringify({ success: true, data: { job_id: 'tts_auto' } }))
      if (parsed.pathname === '/api/v1/tts/jobs/tts_auto') {
        polls += 1
        if (polls === 1) return new Response(JSON.stringify({ success: true, data: { status: 'processing', stage: '分段合成 1/2', progress: 45 } }))
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', result: { audio_url: 'https://media.test/auto.wav' } } }))
      }
      if (parsed.pathname === '/api/v1/subtitle/jobs' && init.method === 'POST') return new Response(JSON.stringify({ success: true, data: { job_id: 'asr_auto' } }))
      if (parsed.pathname === '/api/v1/subtitle/jobs/asr_auto') {
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', subtitle_srt: '1\n00:00:00,000 --> 00:00:01,000\n自动采纳字幕。' } }))
      }
      if (parsed.hostname === 'media.test') return new Response(outputAudio)
      throw new Error(`unexpected request: ${url}`)
    },
  })
  const started = await host.startAudioTask(currentAgent, {
    text: '这是一段验证生成后自动放进项目的测试文稿。',
    title: '自动放进项目',
    provider: 'scitiger',
    voiceSource: 'preset',
    voiceId: 'voice-auto',
    subtitleEnabled: true,
    autoAdoptProjectId: target.id,
  })
  const finished = await waitForAudioTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error)
  assert.equal(finished.projectSyncError, null, finished.projectSyncError)
  assert.equal(finished.projectSync?.projectId, target.id, '应自动挂到目标项目')
  if (!finished.projectSync) {
    const rawDebug = JSON.parse(await readFile(join(cwd, 'data', 'audio-tasks.json'), 'utf8')).tasks.find((item) => item.id === started.id)
    console.log('DEBUG raw task:', JSON.stringify({ autoAdopt: rawDebug?.autoAdoptProjectId, kind: rawDebug?.source?.kind, err: rawDebug?.projectSyncError, events: (rawDebug?.executionEvents || []).map((e) => e.label) }, null, 1))
  }
  const detail = await store.get(currentAgent, { projectId: target.id })
  assert.match(detail.artifacts.script.data.body, /自动放进项目/u, '任务文稿应登记为项目稿件')
  assert.ok(detail.completedStages.includes('voiceover'))
  // 字幕是异步任务，完成时由 #syncAudioTaskSubtitles 自动补挂；轮询等待。
  const subtitleDeadline = Date.now() + 15_000
  let subtitleSynced = false
  while (Date.now() < subtitleDeadline) {
    const current = await store.get(currentAgent, { projectId: target.id })
    if (current.completedStages.includes('subtitles')) { subtitleSynced = true; break }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  if (!subtitleSynced) {
    const rawDebug = JSON.parse(await readFile(join(cwd, 'data', 'audio-tasks.json'), 'utf8')).tasks.find((item) => item.id === started.id)
    console.log('DEBUG task full:', JSON.stringify(rawDebug, null, 1).slice(0, 3000))
  }
  assert.ok(subtitleSynced, '字幕应在完成后自动补挂到项目')
})

test('autoAdoptProjectId rejects a project with a different script before wasting a synthesis', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithSavedScript(currentAgent, store)
  await assert.rejects(
    host_startAudioTask_reject(store, currentAgent, project.id),
    /已有不同稿件/u,
  )
})
async function host_startAudioTask_reject(store, agent, projectId) {
  const host = new SpokenVideoMediaHost({ projectsStore: store })
  return host.startAudioTask(agent, {
    text: '与项目稿件完全不同的一段文本。',
    provider: 'scitiger', voiceSource: 'preset', voiceId: 'v', autoAdoptProjectId: projectId, subtitleEnabled: false,
  })
}

test('deleting a terminal audio task drops its record and its artifacts', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({ projectsStore: { async list() { return [] } } })
  const tasks = [
    { id: 'keep', status: 'succeeded', createdAt: '2026-10-08T00:00:01Z', source: { title: '留着', text: 'x' } },
    { id: 'gone', status: 'failed', createdAt: '2026-10-08T00:00:02Z', source: { title: '删掉', text: 'x' } },
  ]
  await mkdir(join(cwd, 'data', 'audio-media', 'voiceovers'), { recursive: true })
  await mkdir(join(cwd, 'data', 'audio-media', 'subtitles'), { recursive: true })
  await writeFile(join(cwd, 'data', 'audio-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks }))
  const voice = join(cwd, 'data', 'audio-media', 'voiceovers', 'gone.wav')
  const leftover = join(cwd, 'data', 'audio-media', 'voiceovers', 'gone.source.wav')
  const kept = join(cwd, 'data', 'audio-media', 'voiceovers', 'keep.wav')
  await writeFile(voice, 'audio')
  await writeFile(leftover, 'source')
  await writeFile(kept, 'keep')

  const result = await host.deleteTasks(currentAgent, { taskType: 'audio', ids: ['gone'] })
  assert.deepEqual(result.removed, ['gone'])
  assert.deepEqual(result.missing, [])

  const left = JSON.parse(await readFile(join(cwd, 'data', 'audio-tasks.json'), 'utf8'))
  assert.deepEqual(left.tasks.map((item) => item.id), ['keep'], 'only the targeted record is removed')
  assert.equal(existsSync(voice), false, 'the voiceover file is cleaned up')
  assert.equal(existsSync(leftover), false, 'the rate/volume intermediate source is cleaned up too')
  assert.equal(existsSync(kept), true, 'another task keeps its own audio')
})

test('a queued or running audio task cannot be deleted', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({ projectsStore: { async list() { return [] } } })
  await mkdir(join(cwd, 'data'), { recursive: true })
  await writeFile(join(cwd, 'data', 'audio-tasks.json'), JSON.stringify({
    schemaVersion: 1,
    tasks: [
      { id: 'live', status: 'running', createdAt: '2026-10-08T00:00:01Z', source: { title: '正在跑', text: 'x' } },
      { id: 'waiting', status: 'queued', createdAt: '2026-10-08T00:00:02Z', source: { title: '排队中', text: 'x' } },
      { id: 'done', status: 'failed', createdAt: '2026-10-08T00:00:03Z', source: { title: '已结束', text: 'x' } },
    ],
  }))

  // Running is refused on its own; queued is refused even when selected alongside a
  // deletable one, so a batch click can never half-apply.
  await assert.rejects(host.deleteTasks(currentAgent, { taskType: 'audio', ids: ['live'] }), /进行中/u)
  await assert.rejects(host.deleteTasks(currentAgent, { taskType: 'audio', ids: ['done', 'waiting'] }), /排队/u)
  const untouched = JSON.parse(await readFile(join(cwd, 'data', 'audio-tasks.json'), 'utf8'))
  assert.deepEqual(untouched.tasks.map((item) => item.id), ['live', 'waiting', 'done'], 'a rejected batch writes nothing')

  const ok = await host.deleteTasks(currentAgent, { taskType: 'audio', ids: ['done'] })
  assert.deepEqual(ok.removed, ['done'])
})

test('deleting an absent audio task reports it as missing instead of failing', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({ projectsStore: { async list() { return [] } } })
  await mkdir(join(cwd, 'data'), { recursive: true })
  await writeFile(join(cwd, 'data', 'audio-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [] }))
  const result = await host.deleteTasks(currentAgent, { taskType: 'audio', ids: ['never-existed'] })
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.missing, ['never-existed'])
})

test('deleting a video task removes the render workspace, the finished file and its qc run', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const projectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [{ id: projectId, title: '项目' }] } },
  })
  const media = join(cwd, 'data', 'projects', projectId, 'media')
  await mkdir(join(media, 'video-agent', 'v-run', 'outputs'), { recursive: true })
  await mkdir(join(media, 'videos'), { recursive: true })
  await writeFile(join(media, 'videos', 'v-run.mp4'), 'movie')
  await writeFile(join(media, 'videos', 'other.mp4'), 'keep')
  await writeFile(join(media, 'video-agent', 'v-run', 'outputs', 'final.mp4'), 'work')
  await writeFile(join(media, 'runs.json'), JSON.stringify({
    schemaVersion: 1,
    runs: [
      { id: 'v-run', type: 'video', status: 'failed', createdAt: '2026-10-08T00:00:01Z' },
      { id: 'v-other', type: 'video', status: 'succeeded', createdAt: '2026-10-08T00:00:02Z' },
      { id: 'q-run', type: 'qc', status: 'succeeded', createdAt: '2026-10-08T00:00:03Z', input: { videoTaskId: 'v-run' } },
      { id: 'q-keep', type: 'qc', status: 'succeeded', createdAt: '2026-10-08T00:00:04Z', input: { videoTaskId: 'v-other' } },
    ],
  }))

  const result = await host.deleteTasks(currentAgent, { taskType: 'video', ids: ['v-run'] })
  assert.deepEqual(result.removed, ['v-run'])

  const runs = JSON.parse(await readFile(join(media, 'runs.json'), 'utf8'))
  assert.deepEqual(runs.runs.map((run) => run.id), ['v-other', 'q-keep'], 'the qc run hanging off the deleted video goes with it')
  assert.equal(existsSync(join(media, 'videos', 'v-run.mp4')), false, 'the finished mp4 is cleaned up')
  assert.equal(existsSync(join(media, 'video-agent', 'v-run')), false, 'the render workspace is cleaned up')
  assert.equal(existsSync(join(media, 'videos', 'other.mp4')), true, 'another task keeps its file')
})

test('a running video task cannot be deleted', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const projectId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [{ id: projectId, title: '项目' }] } },
  })
  const media = join(cwd, 'data', 'projects', projectId, 'media')
  await mkdir(media, { recursive: true })
  await writeFile(join(media, 'runs.json'), JSON.stringify({
    schemaVersion: 1,
    runs: [{ id: 'v-live', type: 'video', status: 'running', createdAt: '2026-10-08T00:00:01Z' }],
  }))
  await assert.rejects(host.deleteTasks(currentAgent, { taskType: 'video', ids: ['v-live'] }), /排队|进行中/u)
  const runs = JSON.parse(await readFile(join(media, 'runs.json'), 'utf8'))
  assert.equal(runs.runs.length, 1, 'the running record stays')
})

test('deleteTasks rejects an unknown task type and an oversized batch', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({ projectsStore: { async list() { return [] } } })
  await assert.rejects(host.deleteTasks(currentAgent, { taskType: 'subtitle', ids: ['a'] }), /audio 或 video/u)
  const many = Array.from({ length: 51 }, (_, index) => `id-${index}`)
  await assert.rejects(host.deleteTasks(currentAgent, { taskType: 'audio', ids: many }), /最多删除 50/u)
})

/* ---------------------- 本地引擎控制面板（桥接内嵌） ---------------------- */

// 这几条锁的是「host 方法签名必须是 (agent, ...)」这条约定。
// 2026-10-10 实测踩过：bridgeEngineAction 写成 (request) 时，gateway 按
// (context, request) 调用，request 实际接到的是 context，真正的请求体被丢弃——
// 表现是「引擎类型无效」，而 context 上当然没有 kind 字段。签名少写一个
// agent，参数就整体错位一位，而 554 条测试没有一条能发现它。
test('the bridge control panel reads engine state through the bridge', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const calls = []
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    environment: { LWB_MEDIA_BRIDGE_URL: 'http://127.0.0.1:8199/' },
    fetch: async (url, init = {}) => {
      calls.push(String(url))
      if (String(url).endsWith('/health')) {
        return { ok: true, json: async () => ({ service: 'lwb-media-bridge', ttsProvider: 'cloud' }) }
      }
      return {
        ok: true,
        json: async () => ({
          engines: [
            { kind: 'tts', label: '字幕引擎', port: '8188', reachable: true, starting: false, canLaunch: true },
            { kind: 'image', label: '封面生图引擎', port: '8187', reachable: false, starting: true, canLaunch: true },
          ],
          gpu: { usedMiB: 9000, totalMiB: 16000, freeMiB: 7000 },
          memory: { totalMiB: 64000, freeMiB: 12000 },
        }),
      }
    },
  })
  const state = await host.bridgeControl(currentAgent)
  assert.equal(state.available, true)
  assert.equal(state.baseUrl, 'http://127.0.0.1:8199', '尾斜杠被去掉，拼接路径才不会出双斜杠')
  assert.deepEqual(state.engines.map((e) => e.kind), ['tts', 'image'])
  assert.equal(state.engines[0].reachable, true)
  assert.equal(state.engines[1].reachable, false)
  assert.equal(state.engines[1].starting, true, '「启动中」要单独读出来，否则界面会把启动中的引擎显示成「未运行」')
  assert.equal(state.gpu.freeMiB, 7000)
  assert.equal(state.memory.totalMiB, 64000)
  assert.ok(calls.length >= 2 && calls.every((url) => url.startsWith('http://127.0.0.1:8199/')), '全部走桥接，不绕过它直接碰引擎')
})

test('an engine action reaches the bridge with the kind and action it was given', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const seen = []
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    environment: { LWB_MEDIA_BRIDGE_URL: 'http://127.0.0.1:8199' },
    fetch: async (url, init = {}) => {
      seen.push({ url: String(url), method: init.method || 'GET' })
      return { ok: true, json: async () => ({ message: '已释放' }) }
    },
  })
  const result = await host.bridgeEngineAction(currentAgent, { kind: 'image', action: 'free' })
  assert.equal(result.ok, true)
  assert.equal(result.detail, '已释放')
  assert.equal(seen[0].url, 'http://127.0.0.1:8199/admin/engines/image/free')
  assert.equal(seen[0].method, 'POST')
})

test('an unknown engine action is rejected before any request goes out', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  let called = false
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) } },
  })
  // 白名单拦截必须在发请求之前：把「重启」传成 action 若漏出去，桥接会照单执行。
  await assert.rejects(host.bridgeEngineAction(currentAgent, { kind: 'image', action: 'reboot' }), /引擎操作无效/u)
  await assert.rejects(host.bridgeEngineAction(currentAgent, { kind: 'gpu', action: 'free' }), /引擎类型无效/u)
  assert.equal(called, false, '非法参数不该触达桥接')
})

test('the bridge panel fails soft so a missing bridge never breaks the page', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    fetch: async () => { throw new Error('ECONNREFUSED') },
  })
  // 面板是便利设施，桥接不在时它只能「显示不可用」，绝不能让整个页面报错。
  const state = await host.bridgeControl(currentAgent)
  assert.equal(state.available, false)
  assert.ok(state.reason, '要给出能照着做的一句话')
  const logs = await host.bridgeLogs(currentAgent, { lines: 20 })
  assert.equal(logs.available, false)
  const tasks = await host.bridgeTasks(currentAgent)
  assert.equal(tasks.available, false)
})

/* ------------------ 桥接配置与音色库（密钥与路径安全） ------------------ */

test('the bridge config never hands the MiMo API key back to the browser', async (t) => {
  // 桥接的 /admin/config 会把整份 config.json 原样返回，其中 mimo.apiKey 是明文。
  // 经工作台走一圈就等于把它送进前端日志、devtools 与任何一次截屏——所以这里
  // 只回「有没有配」，绝不回值本身。
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz012345'
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    environment: { LWB_MEDIA_BRIDGE_URL: 'http://127.0.0.1:8199' },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ttsProvider: 'cloud',
        tts: { model: 'LongCat-AudioDiT-3.5B-bf16' },
        asr: { model: 'Qwen3-ASR-1.7B' },
        mimo: { apiKey: secret, voice: '茉莉', style: '沉稳' },
        defaultVoice: '22',
        chineseNumbers: true,
      }),
    }),
  })
  const config = await host.bridgeConfig(currentAgent)
  assert.equal(config.available, true)
  assert.equal(config.mimo.apiKeyConfigured, true, '只回布尔，不回值')
  assert.equal(config.mimo.apiKey, undefined, '密钥字段必须不存在')
  assert.equal(JSON.stringify(config).includes(secret), false, '序列化后也不能带出密钥')
  assert.equal(config.mimo.voice, '茉莉', '非敏感字段照常返回')
})

test('saving the bridge config leaves an untouched API key alone', async (t) => {
  // 界面上的 Key 输入框只在用户真要换时才填。保存其它字段时若把空串提交过去，
  // 桥接的 config.mimo.apiKey = '' 会把已配好的密钥清掉——那是最难察觉的一种
  // 破坏：下次合成才报「未配置 API Key」。
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const bodies = []
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    environment: { LWB_MEDIA_BRIDGE_URL: 'http://127.0.0.1:8199' },
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') bodies.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ ttsProvider: 'cloud', mimo: { voice: '茉莉', style: '' }, defaultVoice: '', chineseNumbers: true }) }
    },
  })
  await host.bridgeConfigUpdate(currentAgent, { ttsProvider: 'cloud', mimo: { voice: '茉莉', style: '' } })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].mimo.apiKey, undefined, '没填 Key 就不该把 apiKey 放进补丁')
  // 真要换 Key 时才带，且带的是新值。
  await host.bridgeConfigUpdate(currentAgent, { mimo: { apiKey: 'sk-new-key' } })
  assert.equal(bodies[1].mimo.apiKey, 'sk-new-key')
})

test('a voice id that could escape the voices directory is rejected before any request', async (t) => {
  // 音色 id 会拼进 DELETE /admin/voices/<id>。不校验的话 "../" 能删到 voices/
  // 之外去——桥接那边只挡了音轨文件的存在性，没挡路径穿越。
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  let called = false
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) } },
  })
  for (const bad of ['../config', 'a/b', 'a\b', '', '   ', 'x'.repeat(65)]) {
    await assert.rejects(host.bridgeVoiceDelete(currentAgent, { id: bad }), /音色/u)
  }
  assert.equal(called, false, '非法 id 不得触达桥接')
  // 正常的中文 id 必须能通过。
  const ok = await host.bridgeVoiceDelete(currentAgent, { id: '测试音色' })
  assert.equal(ok.ok, true)
})

test('the voice library lists metadata and playable URLs without proxying audio', async (t) => {
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const urls = []
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: credentialStore(),
    environment: { LWB_MEDIA_BRIDGE_URL: 'http://127.0.0.1:8199' },
    fetch: async (url) => {
      urls.push(String(url))
      return {
        ok: true,
        json: async () => [
          { id: '22', ext: 'm4a', size: 900, hasTxt: true, hasJson: false },
          { id: 'voice-mul6jh28', ext: 'mp3', size: 1200, hasTxt: true, hasJson: true },
        ],
      }
    },
  })
  const library = await host.bridgeVoices(currentAgent)
  assert.equal(library.available, true)
  assert.equal(library.voices.length, 2)
  assert.deepEqual(library.voices[0], { id: '22', ext: 'm4a', size: 900, hasTxt: true, hasJson: false, audioUrl: 'http://127.0.0.1:8199/voices-files/22.m4a' })
  // 音频本体由浏览器直接向桥接取，不经工作台转发——大文件过一次进程没有意义。
  assert.ok(urls.every((url) => url.endsWith('/admin/voices')))
})
