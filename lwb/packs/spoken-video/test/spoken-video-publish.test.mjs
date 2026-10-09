import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SpokenVideoProjectStore, SpokenVideoStoreError } from '../spoken-video-store.mjs'
import { SpokenVideoPublishHost } from '../spoken-video-publish-host.mjs'
import { SpokenVideoPublishError } from '../spoken-video-publish.mjs'
import {
  buildPublishPrompt,
  extractPublishImageUrl,
  imageTaskId,
  imageTaskState,
  inspectPublishImage,
  normalizePublishResult,
  publishImageConfig,
  publishImageCredentialRef,
  publishImageRequest,
} from '../spoken-video-publish.mjs'
import { coverHeadline, coverLayoutFor, wrapCoverHeadline } from '../spoken-video-cover-text.mjs'

function agent(cwd) { return { session: { header: { cwd } } } }

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-spoken-video-publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return cwd
}

function credentialStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    async resolve(ref) { const value = values.get(ref); return value ? { value, source: 'file' } : undefined },
    async describe(ref) { return { configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true } },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
  }
}

function connectionSettings(initial = {}) {
  let value = { ...initial }
  return { get: () => value, async update(next) { value = { ...value, ...next } } }
}

/** A structurally valid PNG header; inspectPublishImage parses dimensions only. */
function png(width, height) {
  const bytes = Buffer.alloc(33)
  bytes.write('89504e470d0a1a0a', 0, 'hex')
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 2
  return bytes
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body },
  }
}

function imageResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
  }
}

/** Drive a project from an empty record to a passed technical QC. */
async function projectAtQc(currentAgent, store, { title = '发布闸门测试' } = {}) {
  let project = await store.create(currentAgent, { title })
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'signals', payload: { source: 'manual', text: '用户反馈发布流程不透明。' }, idempotencyKey: 'publish-signals-0001' })).project
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title, angle: '发布流程' }, idempotencyKey: 'publish-topic-0001' })).project
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'script', payload: { body: '先说结论：发布必须有闸门。' }, idempotencyKey: 'publish-script-0001' })).project
  project = await store.approveScript(currentAgent, { projectId: project.id })
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'voiceover', idempotencyKey: 'publish-voice-0001', source: 'spoken-video/tts',
    payload: { mode: 'tts', provider: 'test', settings: { rate: 1, volume: 1, pitch: 0 }, audio: { file: 'media/voiceovers/publish.wav', mediaType: 'audio/wav', bytes: 4, durationSeconds: 1 } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', idempotencyKey: 'publish-subtitles-0001', source: 'spoken-video/asr',
    payload: { mode: 'asr', sourceAudioFile: 'media/voiceovers/publish.wav', srtFile: 'media/subtitles/publish.srt', srt: '1\n00:00:00,000 --> 00:00:01,000\n发布闸门。' },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'video', idempotencyKey: 'publish-video-0001', source: 'spoken-video/local-ffmpeg',
    payload: { mode: 'local-ffmpeg', renderer: 'local-ffmpeg', visualBrief: '竖屏标题卡。', sourceAudioFile: 'media/voiceovers/publish.wav', sourceSubtitleFile: 'media/subtitles/publish.srt', video: { file: 'media/videos/publish.mp4', mediaType: 'video/mp4', bytes: 1024, durationSeconds: 1, width: 1080, height: 1920, fps: 30, hasAudio: true } },
  })).project
  const projectRoot = join(currentAgent.session.header.cwd, 'data', 'projects', project.id)
  await mkdir(join(projectRoot, 'media', 'videos'), { recursive: true })
  await writeFile(join(projectRoot, 'media', 'videos', 'publish.mp4'), '0'.repeat(1024))
  return (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'publish-qc-0001', source: 'spoken-video/ffprobe',
    payload: { mode: 'automatic', reportFile: 'media/qc/publish.json', passed: true, technical: { passed: true, issues: [], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } } },
  })).project
}

/** A packaging agent result that satisfies PUBLISH_PACKAGE_SCHEMA. */
function packagingResult(overrides = {}) {
  return {
    title: '发布必须有闸门',
    copy: '随视频发布的文案：三个原因说明为什么发布要留人工确认。',
    description: '平台详情描述：口播视频发布流程拆解。',
    tags: ['发布', '工作流', '#闸门'],
    landscapePrompt: '横屏封面：深色背景 + 白色标题字。',
    portraitPrompt: '竖屏封面：人物半身 + 顶部标题。',
    negativePrompt: '水印、二维码、小字',
    ...overrides,
  }
}

function publishHost({ store, executor, credentials, settings, fetch, environment } = {}) {
  return new SpokenVideoPublishHost({
    projectsStore: store,
    credentials: credentials || null,
    connectionSettings: settings || null,
    packageExecutor: executor,
    fetch: fetch || (async () => { throw new Error('test upstream is unavailable') }),
    environment: environment || {},
    pollIntervalMs: 0,
    maxPollMs: 400,
  })
}

async function waitForTask(host, currentAgent, taskId) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const task = await host.task(currentAgent, { taskId })
    if (task.status === 'succeeded' || task.status === 'failed') return task
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error(`发布任务 ${taskId} 在测试时未完成。`)
}

/* ------------------------------ pure helpers ------------------------------ */

test('publish image config validates endpoints and keeps provider credential refs distinct', () => {
  assert.equal(publishImageCredentialRef('BAILIAN'), 'DASHSCOPE_API_KEY')
  assert.equal(publishImageCredentialRef('scitiger'), 'LWB_SPOKEN_VIDEO_CLOUD_IMAGE_API_KEY')
  assert.throws(() => publishImageCredentialRef('openai'), SpokenVideoPublishError)

  const defaults = publishImageConfig({})
  assert.equal(defaults.bailianBaseUrl, 'https://dashscope.aliyuncs.com')
  assert.equal(defaults.scitigerBaseUrl, 'https://link.scitiger.cn')
  assert.equal(defaults.model, 'wan2.7-image')

  const overridden = publishImageConfig({ LWB_SPOKEN_VIDEO_CLOUD_IMAGE_BASE_URL: 'https://example.com/', LWB_SPOKEN_VIDEO_IMAGE_MODEL: 'custom-model' })
  assert.equal(overridden.scitigerBaseUrl, 'https://example.com')
  assert.equal(overridden.model, 'custom-model')

  // `new URL()` only throws on a malformed value; a parsable non-HTTP scheme
  // is rejected by the protocol whitelist instead.
  assert.throws(() => publishImageConfig({ LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL: '不是地址' }), /HTTP\(S\) URL/u)
  assert.throws(() => publishImageConfig({ LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL: 'ftp://example.com' }), /百炼生图地址无效/u)
  assert.throws(() => publishImageConfig({ LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL: 'https://user:pass@example.com' }), /百炼生图地址无效/u)
})

test('publish prompt binds the frozen account, script, video spec and QC verdict', () => {
  const prompt = buildPublishPrompt({
    project: {
      title: '项目标题',
      artifacts: {
        topic: { data: { title: '选题标题', account: { id: 'a', name: '账号甲' } } },
        script: { data: { body: '完整口播稿正文。' } },
        video: { data: { orientation: 'portrait', visualBrief: '竖屏' } },
        qc: { id: 'qc-1', data: { passed: true, review: { summary: '审片通过' } } },
      },
    },
  })
  assert.match(prompt, /短视频发布包装 Agent/u)
  assert.match(prompt, /账号甲/u)
  assert.match(prompt, /完整口播稿正文。/u)
  assert.match(prompt, /"orientation":"portrait"/u)
  assert.match(prompt, /"passed":true/u)
  assert.match(prompt, /3-10 个/u)
})

test('normalizePublishResult clips, de-duplicates tags and rejects incomplete output', () => {
  const normalized = normalizePublishResult(packagingResult())
  assert.deepEqual(normalized.content.tags, ['发布', '工作流', '闸门'])
  assert.equal(normalized.content.title, '发布必须有闸门')
  assert.equal(normalized.prompts.negative, '水印、二维码、小字')

  assert.equal(normalizePublishResult(packagingResult({ tags: ['a', 'a', '##b'] })).content.tags.join(','), 'a,b')
  assert.equal(normalizePublishResult(packagingResult({ tags: Array.from({ length: 20 }, (_, index) => `tag${index}`) })).content.tags.length, 10)
  assert.equal(normalizePublishResult(packagingResult({ title: 'x'.repeat(200) })).content.title.length, 80)

  for (const broken of [{ title: '' }, { copy: '' }, { description: '' }, { tags: [] }, { landscapePrompt: '' }, { portraitPrompt: '' }]) {
    assert.throws(() => normalizePublishResult(packagingResult(broken)), /不完整/u)
  }
})

test('image request, task id and url extraction follow the async generation contract', () => {
  const request = publishImageRequest({ model: 'wan2.7-image', prompt: '封面', negativePrompt: '水印', size: '1280*720' })
  assert.equal(request.parameters.size, '1280*720')
  assert.equal(request.parameters.n, 1)
  assert.equal(request.parameters.watermark, false)
  assert.equal(request.parameters.negative_prompt, '水印')
  assert.equal(request.input.messages[0].content[0].text, '封面')
  assert.equal('negative_prompt' in publishImageRequest({ model: 'm', prompt: 'p', negativePrompt: '', size: '1*1' }).parameters, false)

  assert.equal(imageTaskId({ output: { task_id: 'task-1' } }), 'task-1')
  assert.equal(imageTaskId({ taskId: 'task-2' }), 'task-2')
  assert.equal(imageTaskId({}), null)
  assert.equal(imageTaskState({ output: { task_status: 'pending' } }), 'PENDING')
  assert.equal(imageTaskState({ status: 'succeeded' }), 'SUCCEEDED')

  assert.equal(extractPublishImageUrl({ output: { choices: [{ message: { content: [{ image: 'https://cdn/a.png' }] } }] } }), 'https://cdn/a.png')
  assert.equal(extractPublishImageUrl({ output: { results: [{ url: 'https://cdn/b.png' }] } }), 'https://cdn/b.png')
  assert.equal(extractPublishImageUrl({ output: { images: ['https://cdn/c.png'] } }), 'https://cdn/c.png')
  assert.equal(extractPublishImageUrl({ output: {} }), null)
})

test('inspectPublishImage accepts PNG/JPEG/WebP dimensions and rejects unsafe bytes', () => {
  const wide = inspectPublishImage(png(1280, 720))
  assert.deepEqual({ mediaType: wide.mediaType, extension: wide.extension, width: wide.width, height: wide.height }, { mediaType: 'image/png', extension: 'png', width: 1280, height: 720 })
  assert.equal(inspectPublishImage(png(720, 1280)).height, 1280)
  assert.throws(() => inspectPublishImage(Buffer.from('not an image at all')), /PNG、JPEG 或静态 WebP/u)
  assert.throws(() => inspectPublishImage(png(9000, 100)), /8192/u)
})

/* --------------------------- host task lifecycle --------------------------- */

test('packaging requires a passed QC and a fresh revision', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await store.create(currentAgent, { title: '未质检' })
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title: '未质检' }, idempotencyKey: 'publish-gate-topic-1' })).project
  const host = publishHost({ store, executor: async () => packagingResult() })

  await assert.rejects(
    host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision }),
    (error) => error instanceof SpokenVideoPublishError && error.code === 'SPOKEN_VIDEO_STAGE_BLOCKED',
  )
  await assert.rejects(host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: 0 }), /项目版本无效/u)

  const queued = await projectAtQc(currentAgent, store)
  await assert.rejects(
    host.startPackaging(currentAgent, { projectId: queued.id, expectedRevision: queued.revision - 1 }),
    (error) => error instanceof SpokenVideoPublishError && error.code === 'SPOKEN_VIDEO_REVISION_CONFLICT',
  )
})

test('a successful run commits an immutable packaging artifact and records the DSH trace', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const events = []
  const host = publishHost({
    store,
    executor: async ({ prompt, schema, onDshStarted, onDshEvent }) => {
      assert.match(prompt, /短视频发布包装 Agent/u)
      assert.equal(schema.required.includes('title'), true)
      await onDshStarted({ childSessionId: 'child-1', parentSessionId: 'parent-1' })
      await onDshEvent({ seq: 1, type: 'turn/start', time: Date.now() })
      await onDshEvent({ seq: 2, type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
      events.push('ran')
      return packagingResult()
    },
  })

  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  assert.equal(started.status, 'queued')
  assert.equal(started.phase, 'agent')
  assert.equal(started.imageProvider, null)

  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded', finished.error || 'packaging task failed')
  assert.equal(finished.phase, 'ready')
  assert.deepEqual(events, ['ran'])
  assert.equal(finished.dsh.childSessionId, 'child-1')
  assert.ok(finished.dsh.events.some((event) => event.label === 'DSH 已接收生成任务'))
  assert.ok(finished.dsh.events.some((event) => event.label === 'DSH 已完成生成'))

  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.packaging.data.mode, 'agent')
  assert.deepEqual(detail.artifacts.packaging.data.content.tags, ['发布', '工作流', '闸门'])
  assert.equal(detail.artifacts.packaging.data.covers.landscape, null)
  // The task summary is deliberately minimal (resultRevision stays in the
  // durable task file), so verify the commit landed on the current revision.
  assert.equal(detail.artifacts.packaging.revision, detail.revision)
  assert.equal(detail.completedStages.includes('packaging'), true)

  // The agent run is idempotent per task, and the task summary carries the trace.
  const listed = (await host.listItems(currentAgent, {})).items.find((item) => item.id === project.id).task
  assert.equal(listed.status, 'succeeded')
  assert.equal(listed.dsh.childSessionId, 'child-1')
})

test('an unavailable agent or unusable model output fails the task without committing', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)

  const noExecutor = publishHost({ store })
  const missing = await noExecutor.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  const missingResult = await waitForTask(noExecutor, currentAgent, missing.id)
  assert.equal(missingResult.status, 'failed')
  assert.match(missingResult.error, /不提供发布包装 Agent/u)

  const broken = publishHost({ store, executor: async () => packagingResult({ title: '' }) })
  const brokenTask = await broken.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  const brokenResult = await waitForTask(broken, currentAgent, brokenTask.id)
  assert.equal(brokenResult.status, 'failed')
  assert.match(brokenResult.error, /不完整/u)

  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.packaging, undefined)
})

test('a stale revision detected mid-run cancels the task instead of overwriting newer work', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({
    store,
    executor: async () => {
      // Simulate the user editing the script while packaging is in flight.
      await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'script', payload: { body: '并行修改后的稿件。' }, idempotencyKey: 'publish-race-script-1' })
      return packagingResult()
    },
  })
  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /项目已更新/u)
})

test('configured credentials generate covers even when the legacy enabled switch is false', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const requested = []
  const fetchMock = async (url, init = {}) => {
    const parsed = new URL(String(url))
    requested.push(`${init.method || 'GET'} ${parsed.pathname}`)
    if (init.method === 'POST') {
      assert.equal(parsed.origin, 'https://dashscope.aliyuncs.com')
      assert.equal(parsed.pathname, '/api/v1/services/aigc/image-generation/generation')
      assert.equal(init.headers['X-DashScope-Async'], 'enable')
      const body = JSON.parse(init.body)
      // The portrait request is rejected upstream; landscape succeeds.
      if (body.parameters.size === '1080*1440') return jsonResponse({ message: 'quota exhausted' }, 429)
      return jsonResponse({ output: { task_id: 'cover-1', task_status: 'PENDING' } })
    }
    if (parsed.pathname.startsWith('/api/v1/tasks/')) {
      return jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.test/cover.png' }] } })
    }
    return imageResponse(png(1280, 720))
  }
  const host = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-test' }),
    settings: connectionSettings({ enabled: false, provider: 'bailian', model: 'wan2.7-image' }),
    fetch: fetchMock,
  })

  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  assert.deepEqual(started.imageProvider, { provider: 'bailian', model: 'wan2.7-image' })
  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.coverErrors.landscape, null)
  assert.match(finished.coverErrors.portrait, /quota exhausted/u)
  assert.equal(requested.some((entry) => entry.startsWith('GET /api/v1/tasks/')), true)

  const detail = await store.get(currentAgent, { projectId: project.id })
  const landscape = detail.artifacts.packaging.data.covers.landscape
  assert.match(landscape.file, /^media\/publish-covers\/landscape-[a-f0-9-]+\.png$/u)
  assert.equal(landscape.mediaType, 'image/png')
  assert.deepEqual([landscape.width, landscape.height], [1280, 720])
  assert.equal(landscape.source, 'generated')
  assert.equal(detail.artifacts.packaging.data.covers.portrait, null)
  assert.equal(detail.artifacts.packaging.data.imageProvider.provider, 'bailian')

  // The frozen cover is readable back through the guarded asset endpoint.
  const asset = await host.readAsset(currentAgent, { projectId: project.id, kind: 'landscape' })
  assert.equal(asset.mediaType, 'image/png')
  assert.equal(Buffer.from(asset.data, 'base64').length, 33)
  await assert.rejects(host.readAsset(currentAgent, { projectId: project.id, kind: 'portrait' }), /没有可读取的发布媒体/u)
})

test('SciTiger covers use synchronous multimodal generation without the DashScope async header', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const sizes = []
  const host = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({ LWB_SPOKEN_VIDEO_CLOUD_IMAGE_API_KEY: 'sk-cloud-test' }),
    settings: connectionSettings({ enabled: true, provider: 'scitiger' }),
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') {
        assert.equal(String(url), 'https://link.scitiger.cn/api/v1/services/aigc/multimodal-generation/generation')
        assert.equal(init.headers['X-DashScope-Async'], undefined)
        assert.equal(init.headers.Authorization, 'Bearer sk-cloud-test')
        const size = JSON.parse(init.body).parameters.size
        sizes.push(size)
        return jsonResponse({ output: { choices: [{ message: { content: [{ image: `https://cdn.test/${size}.png` }] } }] } })
      }
      assert.match(String(url), /^https:\/\/cdn\.test\/(1280\*720|1080\*1440)\.png$/u)
      const [width, height] = new URL(String(url)).pathname.slice(1, -4).split('*').map(Number)
      return imageResponse(png(width, height))
    },
  })
  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded')
  assert.deepEqual(finished.coverErrors, { landscape: null, portrait: null })
  assert.deepEqual(sizes.sort(), ['1080*1440', '1280*720'])
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.packaging.data.covers.landscape.width, 1280)
  assert.equal(detail.artifacts.packaging.data.covers.portrait.height, 1440)
})

test('a missing selected-provider credential skips automatic covers without failing packaging', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({}),
    settings: connectionSettings({ enabled: true, provider: 'scitiger', model: 'wan2.7-image' }),
  })
  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  assert.equal(started.imageProvider, null)
  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded')
  assert.deepEqual(finished.coverErrors, { landscape: null, portrait: null })

  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.packaging.data.covers.landscape, null)
  assert.equal(detail.artifacts.packaging.data.imageProvider, null)
  assert.equal(JSON.stringify(detail.artifacts.packaging.data).includes('sk-'), false)
})

test('cover generation stops at a terminal task state and reports an unreachable service', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-test' }),
    settings: connectionSettings({ enabled: true, provider: 'bailian' }),
    fetch: async () => jsonResponse({ output: { task_id: 'cover-x', task_status: 'FAILED' } }),
  })
  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded')
  assert.match(finished.coverErrors.landscape, /封面生成任务失败/u)

  const unreachable = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-test' }),
    settings: connectionSettings({ enabled: true, provider: 'bailian' }),
  })
  const detail = await store.get(currentAgent, { projectId: project.id })
  const retried = await unreachable.startPackaging(currentAgent, { projectId: project.id, expectedRevision: detail.revision })
  const retryResult = await waitForTask(unreachable, currentAgent, retried.id)
  assert.match(retryResult.coverErrors.portrait, /不可访问/u)
})

test('a host restart marks in-flight packaging tasks failed and keeps history readable', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const neverSettles = publishHost({ store, executor: () => new Promise(() => {}) })
  const started = await neverSettles.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  assert.equal(started.status, 'queued')

  // A second host instance models the process after a restart: nothing is active.
  const restarted = publishHost({ store, executor: async () => packagingResult() })
  const listed = await restarted.task(currentAgent, { taskId: started.id })
  assert.equal(listed.status, 'failed')
  assert.match(listed.error, /应用重启中断/u)
  assert.ok(listed.completedAt)

  // The same recovery is visible through the item listing used by the page.
  const items = await restarted.listItems(currentAgent, {})
  assert.equal(items.items.find((item) => item.id === project.id).task.status, 'failed')
})

test('listItems is a flat video shelf scoped by account and reports publish readiness', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const general = await projectAtQc(currentAgent, store, { title: '通用项目' })
  const host = publishHost({ store, executor: async () => packagingResult() })
  const all = await host.listItems(currentAgent, {})
  assert.equal(all.items.length, 1)
  assert.equal(all.items[0].qcPassed, true)
  assert.equal(all.items[0].packaging, null)
  assert.equal(all.items[0].task, null)
  assert.equal(all.items[0].video.file, 'media/videos/publish.mp4')
  assert.equal(all.items[0].orientation, 'portrait')

  const started = await host.startPackaging(currentAgent, { projectId: general.id, expectedRevision: general.revision })
  await waitForTask(host, currentAgent, started.id)

  // Having a packaging artifact is the whole readiness contract: no approval
  // or queue stage exists anymore.
  const packaged = await host.listItems(currentAgent, {})
  assert.equal(packaged.items[0].packaging.content.title, '发布必须有闸门')
  assert.equal(packaged.items[0].completedStages.includes('packaging'), true)
  assert.equal(packaged.items[0].completedStages.includes('approval'), false)
  assert.equal(packaged.items[0].completedStages.includes('queue'), false)
  assert.equal(packaged.items[0].task.status, 'succeeded')

  const generalOnly = await host.listItems(currentAgent, { general: true })
  assert.equal(generalOnly.items.length, 1)
  const scoped = await host.listItems(currentAgent, { accountId: '11111111-1111-4111-8111-111111111111' })
  assert.equal(scoped.items.length, 0)
  await assert.rejects(host.listItems(currentAgent, { accountId: 'not-a-uuid' }), /项目标识无效/u)
})

test('a project that never reached QC stays off the publish shelf', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await store.create(currentAgent, { title: '未成片' })
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title: '未成片' }, idempotencyKey: 'publish-shelf-topic-1' })).project
  const host = publishHost({ store, executor: async () => packagingResult() })
  assert.equal((await host.listItems(currentAgent, {})).items.length, 0)
})

test('regenerateCover reuses a hand-edited prompt for one direction and keeps the copy intact', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const sizes = []
  const fetchMock = async (url, init = {}) => {
    const parsed = new URL(String(url))
    if (init.method === 'POST') {
      assert.equal(parsed.pathname, '/api/v1/services/aigc/image-generation/generation')
      assert.equal(init.headers['X-DashScope-Async'], 'enable')
      sizes.push(JSON.parse(init.body).parameters.size)
      return jsonResponse({ output: { task_id: 'cover-regenerate', task_status: 'PENDING' } })
    }
    if (parsed.pathname === '/api/v1/tasks/cover-regenerate') {
      assert.equal(init.method, 'GET')
      assert.equal(init.headers.Authorization, 'Bearer sk-test')
      return jsonResponse({ output: { results: [{ url: 'https://cdn.test/cover.png' }] } })
    }
    return imageResponse(png(1280, 720))
  }
  const host = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-test' }),
    settings: connectionSettings({ enabled: true, provider: 'bailian', model: 'wan2.7-image' }),
    fetch: fetchMock,
  })

  // Requires a configured image connection and an existing packaging artifact.
  const bare = publishHost({ store, executor: async () => packagingResult() })
  await assert.rejects(
    bare.regenerateCover(currentAgent, { projectId: project.id, expectedRevision: project.revision, kind: 'landscape', prompt: '新提示词' }),
    (error) => error instanceof SpokenVideoPublishError && error.code === 'SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE' && /保存当前渠道的 API Key/u.test(error.message),
  )
  await assert.rejects(
    host.regenerateCover(currentAgent, { projectId: project.id, expectedRevision: project.revision, kind: 'landscape', prompt: '新提示词' }),
    (error) => error instanceof SpokenVideoPublishError && error.code === 'SPOKEN_VIDEO_STAGE_BLOCKED',
  )
  await assert.rejects(
    host.regenerateCover(currentAgent, { projectId: project.id, expectedRevision: project.revision, kind: 'square', prompt: '新提示词' }),
    /封面方向无效/u,
  )

  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  await waitForTask(host, currentAgent, started.id)
  let detail = await store.get(currentAgent, { projectId: project.id })
  // A human edit to the copy must survive the cover regeneration untouched.
  await host.updatePackaging(currentAgent, {
    projectId: project.id, expectedRevision: detail.revision,
    content: { title: '人工标题', copy: '人工文案', description: '人工描述', tags: ['人工'] },
  })
  detail = await store.get(currentAgent, { projectId: project.id })

  sizes.length = 0
  const beforePortrait = detail.artifacts.packaging.data.covers.portrait
  const coverTask = await host.regenerateCover(currentAgent, {
    projectId: project.id, expectedRevision: detail.revision, kind: 'landscape',
    prompt: '手改后的横屏提示词', negativePrompt: '手改负面',
  })
  assert.equal(coverTask.status, 'queued')
  assert.equal(coverTask.phase, 'covers')
  assert.equal(coverTask.coverKind, 'landscape')
  const finished = await waitForTask(host, currentAgent, coverTask.id)
  assert.equal(finished.status, 'succeeded')
  assert.deepEqual(sizes, ['1280*720'], 'only the requested direction is generated')

  const fresh = await store.get(currentAgent, { projectId: project.id })
  const packaging = fresh.artifacts.packaging.data
  assert.equal(packaging.mode, 'cover-regenerate')
  assert.equal(packaging.content.title, '人工标题', 'the copy is preserved')
  assert.deepEqual(packaging.content.tags, ['人工'])
  assert.equal(packaging.prompts.landscape, '手改后的横屏提示词')
  assert.equal(packaging.prompts.negative, '手改负面')
  assert.equal(packaging.prompts.portrait, '竖屏封面：人物半身 + 顶部标题。', 'the other direction keeps its prompt')
  assert.match(packaging.covers.landscape.file, /^media\/publish-covers\/landscape-[a-f0-9-]+\.png$/u)
  assert.equal(packaging.covers.landscape.source, 'generated')
  assert.equal(packaging.covers.portrait.file, beforePortrait.file, 'the other direction keeps its frozen cover')
  assert.equal(packaging.coverErrors.landscape, null)

  await assert.rejects(
    host.regenerateCover(currentAgent, { projectId: project.id, expectedRevision: fresh.revision - 1, kind: 'landscape', prompt: 'x' }),
    (error) => error instanceof SpokenVideoPublishError && error.code === 'SPOKEN_VIDEO_REVISION_CONFLICT',
  )
})

test('regenerateCover failure lands in coverErrors and leaves the artifact untouched', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({
    store,
    executor: async () => packagingResult(),
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-test' }),
    settings: connectionSettings({ enabled: true, provider: 'bailian' }),
    fetch: async () => jsonResponse({ output: { task_id: 'cover-x', task_status: 'FAILED' } }),
  })
  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  await waitForTask(host, currentAgent, started.id)
  const detail = await store.get(currentAgent, { projectId: project.id })

  const coverTask = await host.regenerateCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'portrait', prompt: '会失败的提示词' })
  const finished = await waitForTask(host, currentAgent, coverTask.id)
  assert.equal(finished.status, 'failed')
  assert.match(finished.coverErrors.portrait, /封面生成任务失败/u)

  const fresh = await store.get(currentAgent, { projectId: project.id })
  assert.equal(fresh.revision, detail.revision, 'a failed cover run commits nothing')
  assert.equal(fresh.artifacts.packaging.data.mode, 'agent')
})

test('updatePackaging rewrites only the human-editable content fields', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({ store, executor: async () => packagingResult() })
  await assert.rejects(
    host.updatePackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision, content: { title: '新标题', copy: '新文案', description: '新描述', tags: ['新'] } }),
    /请先生成发布信息/u,
  )

  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  await waitForTask(host, currentAgent, started.id)
  const detail = await store.get(currentAgent, { projectId: project.id })
  const updated = await host.updatePackaging(currentAgent, {
    projectId: project.id,
    expectedRevision: detail.revision,
    content: { title: '人工改过的标题', copy: '人工改过的文案', description: '人工改过的描述', tags: ['#人工', '审核'] },
  })
  assert.equal(updated.project.revision, detail.revision + 1)

  const fresh = await store.get(currentAgent, { projectId: project.id })
  assert.equal(fresh.artifacts.packaging.data.mode, 'manual-update')
  assert.deepEqual(fresh.artifacts.packaging.data.content.tags, ['人工', '审核'])
  assert.equal(fresh.artifacts.packaging.data.prompts.landscape, '横屏封面：深色背景 + 白色标题字。')

  await assert.rejects(
    host.updatePackaging(currentAgent, { projectId: project.id, expectedRevision: fresh.revision, content: { title: '无标签', copy: '文案', description: '描述', tags: [] } }),
    /至少需要一个发布标签/u,
  )
  await assert.rejects(
    host.updatePackaging(currentAgent, { projectId: project.id, expectedRevision: fresh.revision, content: { title: 'x'.repeat(81), copy: '文案', description: '描述', tags: ['a'] } }),
    /发布标题/u,
  )
})

test('uploadCover validates orientation and format, freezes the file and rolls back on conflict', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({ store, executor: async () => packagingResult() })

  await assert.rejects(
    host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: project.revision, kind: 'landscape', data: png(1280, 720).toString('base64') }),
    /请先生成发布信息/u,
  )

  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  await waitForTask(host, currentAgent, started.id)
  const detail = await store.get(currentAgent, { projectId: project.id })

  await assert.rejects(
    host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'landscape', data: png(720, 1280).toString('base64') }),
    /横屏封面宽度必须大于高度/u,
  )
  await assert.rejects(
    host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'square', data: png(100, 100).toString('base64') }),
    /封面方向无效/u,
  )
  await assert.rejects(
    host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'portrait', data: 'not base64!' }),
    /不是有效 Base64/u,
  )
  await assert.rejects(
    host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'portrait', data: Buffer.from('plain bytes').toString('base64') }),
    /PNG、JPEG 或静态 WebP/u,
  )

  const uploaded = await host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'portrait', data: png(720, 1280).toString('base64') })
  assert.equal(uploaded.project.revision, detail.revision + 1)
  const frozen = await store.get(currentAgent, { projectId: project.id })
  assert.match(frozen.artifacts.packaging.data.covers.portrait.file, /^media\/publish-covers\/portrait-[a-f0-9-]+\.png$/u)
  assert.equal(frozen.artifacts.packaging.data.covers.portrait.source, 'upload')
  assert.equal(frozen.artifacts.packaging.data.mode, 'cover-upload')
  const onDisk = await readFile(join(cwd, 'data', 'projects', project.id, frozen.artifacts.packaging.data.covers.portrait.file))
  assert.equal(onDisk.length, 33)

  // A stale revision must not leave an orphan cover file behind.
  await assert.rejects(
    host.uploadCover(currentAgent, { projectId: project.id, expectedRevision: detail.revision, kind: 'landscape', data: png(1280, 720).toString('base64') }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_REVISION_CONFLICT',
  )
  const afterRollback = await store.get(currentAgent, { projectId: project.id })
  assert.equal(afterRollback.artifacts.packaging.data.covers.landscape, null)
  assert.equal(afterRollback.revision, frozen.revision)
})

test('readAsset guards the media type whitelist and path traversal', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)
  const host = publishHost({ store, executor: async () => packagingResult() })

  const video = await host.readAsset(currentAgent, { projectId: project.id, kind: 'video' })
  assert.equal(video.file, 'media/videos/publish.mp4')
  assert.equal(video.mediaType, 'video/mp4')
  assert.equal(video.bytes, 1024)

  await assert.rejects(host.readAsset(currentAgent, { projectId: project.id, kind: 'audio' }), /发布媒体类型无效/u)
  await assert.rejects(host.readAsset(currentAgent, { projectId: project.id, kind: 'landscape' }), /没有可读取的发布媒体/u)
})

test('the selected provider credential is the only cover-generation availability gate', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const credentials = credentialStore({})
  const settings = connectionSettings({ enabled: false })
  const host = publishHost({ store, credentials, settings })

  const initial = await host.status()
  assert.equal(initial.enabled, false)
  assert.equal(initial.configured, false)
  assert.equal(initial.provider, 'bailian')
  assert.equal(initial.providers.bailian.credential.configured, false)
  assert.equal(initial.imageMaxBytes, 20 * 1024 * 1024)

  const configured = await host.configureConnection({ provider: 'scitiger', model: 'wan2.7-image', apiKey: 'sk-secret-cloud' })
  assert.equal(configured.enabled, true)
  assert.equal(configured.configured, true)
  assert.equal(configured.provider, 'scitiger')
  assert.equal(configured.model, 'wan2.7-image')
  assert.equal(configured.providers.scitiger.credential.configured, true)
  assert.equal(JSON.stringify(configured).includes('sk-secret-cloud'), false)
  assert.equal(settings.get().enabled, false, 'the legacy switch is preserved but ignored')

  await assert.rejects(host.configureConnection({ provider: 'openai' }), /生图渠道无效/u)
  const cleared = await host.clearConnectionCredential({ provider: 'scitiger' })
  assert.equal(cleared.configured, false)
  assert.equal(cleared.providers.scitiger.credential.configured, false)

  // Without a settings service the host reports the boundary instead of guessing.
  const bare = new SpokenVideoPublishHost({ projectsStore: store })
  const bareStatus = await bare.status()
  assert.equal(bareStatus.enabled, false)
  assert.equal(bareStatus.providers.bailian.credential.configured, false)
  await assert.rejects(bare.configureConnection({ provider: 'bailian' }), /不支持保存生图设置/u)
})

test('publish thumbnails are small real frames and failed extraction can recover', async (t) => {
  const { execFileSync } = await import('node:child_process')
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) }
  catch { t.skip('ffmpeg is unavailable'); return }
  const cwd = await workspace(t)
  const currentAgent = agent(cwd)
  const store = new SpokenVideoProjectStore()
  const project = await projectAtQc(currentAgent, store)
  const host = new SpokenVideoPublishHost({ projectsStore: store })
  const request = { projectId: project.id, kind: 'thumbnail' }
  await assert.rejects(host.readAsset(currentAgent, request), /ffmpeg/u, 'invalid video does not produce a fake thumbnail')
  const file = join(cwd, 'data', 'projects', project.id, 'media/videos/publish.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:d=0.1', '-pix_fmt', 'yuv420p', file])
  const [first, second] = await Promise.all([host.readAsset(currentAgent, request), host.readAsset(currentAgent, request)])
  assert.equal(first.mediaType, 'image/jpeg')
  assert.deepEqual(first, second, 'concurrent requests reuse one frame')
  const image = inspectPublishImage(Buffer.from(first.data, 'base64'))
  assert.ok(image.width <= 480 && image.height <= 480)
  assert.ok(image.height > image.width, 'portrait aspect ratio is preserved')
  assert.equal((await host.readAsset(currentAgent, { projectId: project.id, kind: 'video' })).mediaType, 'video/mp4')
  await assert.rejects(host.readAsset(currentAgent, { projectId: project.id, kind: '../../outside' }), /类型无效/u)
})

test('autoStartPackaging fills in the publish copy and leaves the cover renderer alone', async (t) => {
  // 2026-10-08：刚渲染完的成片在发布页显示「未生成」，用户以为白跑了。视频页现在会
  // 自动补一次文案，但**不生成封面**——封面要跑两次生图，而 16G 卡上封面生图与 LongCat
  // 不能同时驻留，渲染刚结束时显存还被占着，自动生封面大概率失败、留一堆「封面待补」。
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectAtQc(currentAgent, store)

  const executed = []
  const host = publishHost({
    store,
    executor: async () => { executed.push('agent'); return packagingResult({ title: '自动生成的标题' }) },
    settings: { get: () => ({ enabled: true, provider: 'bailian', model: 'wanx' }) },
    // 封面渲染器一旦被调用就让测试失败——这正是要守住的行为。
    fetch: async () => { executed.push('cover'); throw new Error('封面渲染器不应被调用') },
  })

  const result = await host.autoStartPackaging(currentAgent, { projectId: project.id })
  assert.ok(result.started, 'a qc-passed cut without packaging starts copy generation on its own')
  const task = await waitForTask(host, currentAgent, result.started)
  assert.equal(task.status, 'succeeded', task.error || '')

  assert.deepEqual(executed, ['agent'], 'the agent ran and the cover renderer never did')
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.packaging.data.content.title, '自动生成的标题')
  assert.equal(detail.artifacts.packaging.data.covers.landscape, null, 'no cover was produced')
  assert.equal(detail.artifacts.packaging.data.covers.portrait, null, 'no cover was produced')

  // 幂等：已经有资料了就不再来第二次。
  const again = await host.autoStartPackaging(currentAgent, { projectId: project.id })
  assert.equal(again.skipped, 'already-packaged')
  assert.deepEqual(executed, ['agent'], 'the second call did not re-run the agent')
})

test('autoStartPackaging leaves cuts that are not publishable yet alone', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  // 只有 topic 的项目：没过质检，也不该被自动生成发布资料。
  const project = await store.create(currentAgent, { title: '还没质检' })
  await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title: '还没质检' }, idempotencyKey: 'auto-packaging-gate' })

  let executorCalls = 0
  const host = publishHost({ store, executor: async () => { executorCalls += 1; return packagingResult() } })

  assert.equal((await host.autoStartPackaging(currentAgent, { projectId: project.id })).skipped, 'qc-not-passed')
  assert.equal(executorCalls, 0, 'the agent was never asked for an unpublishable cut')
})

test('cover headline extraction prefers semantic boundaries over a hard cut', () => {
  // 封面字要少（缩略图里 4-8 字才读得清），但按字数硬截会把词组切坏
  //（「别再给 AI 甩一句『你换个攻略』」会变成「甩一句你换」）。这里钉住断句策略。
  assert.equal(coverHeadline('同一个 AI 昨天还行、今天犯傻'), '同一个 AI 昨天还行')
  // 冒号前的部分通常是钩子
  assert.equal(coverHeadline('高速服务区充电排到99号：国庆开电车出门，到底卡在哪一步'), '高速服务区充电排到99号')
  // 引号里的数字完整保留，不被切成「发1万」
  assert.equal(coverHeadline('平台把成本压到「发1万单倒赔130」：河北电商这套玩法能不能学'), '发1万单倒赔130')
  // 书名号、引号是噪音，去掉后不影响可读性
  assert.equal(coverHeadline('杜丽娘为一场梦死去，又为一张画还魂：《牡丹亭》讲了什么'), '杜丽娘为一场梦死去')
  // 引号内容太短、脱离上下文读不懂时不能用（「你换个攻略」只有 5 字）
  assert.notEqual(coverHeadline('别再给 AI 甩一句「你换个攻略」：国庆自驾七天'), '你换个攻略')
  // 空标题不炸
  assert.equal(coverHeadline(''), '')
  assert.equal(coverHeadline(null), '')
})

test('cover layout keeps the headline inside the platform safe area', () => {
  // 抖音/小红书按 3:4 展示，9:16 封面上下会被裁约 25%；所以字必须落在顶部预留区里，
  // 且不能大到压住底图主体。字号比例来自缩略图可读性（拇指大小下字高需占两位数百分比）。
  const landscape = coverLayoutFor('landscape', 1280, 720)
  const portrait = coverLayoutFor('portrait', 720, 1280)
  for (const layout of [landscape, portrait]) {
    assert.ok(layout.fontSize > 40, 'the headline must stay readable when the thumbnail is thumb-sized')
    assert.ok(layout.top < 200, 'the headline sits in the reserved top band, not over the artwork')
    assert.ok(layout.sideMargin > 0, 'it keeps a margin from both edges')
  }
  // 竖屏可视区域更窄，字号应更保守
  assert.ok(portrait.fontSize / 1280 < landscape.fontSize / 720, 'portrait uses a relatively smaller headline')
})

test('headline wrapping respects the per-line budget and the line cap', () => {
  assert.deepEqual(wrapCoverHeadline('一二三四五六七八九十', 5, 2), ['一二三四五', '六七八九十'])
  // 超出行数上限的部分被丢掉，不该无限换行
  assert.equal(wrapCoverHeadline('一二三四五六七八九十十一十二', 4, 2).length, 2)
  assert.deepEqual(wrapCoverHeadline('', 5, 2), [])
})

test('the prompt asks the image model to leave a clean title band', () => {
  // 标题是程序叠的，底图必须留出位置且不含任何伪文字——否则叠完字会出现
  // 「真标题 + 残留的示意横线」这种像乱码的东西（2026-10-08 实测过）。
  const prompt = buildPublishPrompt({ project: { title: '测试', artifacts: {} } })
  assert.match(prompt, /留出一块\*\*纯色、低频、无任何图形元素\*\*的横向区域/u)
  assert.match(prompt, /横屏占顶部 18%，竖屏占顶部 22%/u)
  assert.match(prompt, /不要出现任何文字、字母、数字、标点/u)
  assert.match(prompt, /示意性横线/u)
  assert.match(prompt, /中部 60% 高度以内/u)
  // 9:16 在信息流被裁是既有事实，得写进裁切安全区要求
  assert.match(prompt, /3:4 展示/u)
})

test('regenerateCover reuses the saved title when the task itself carries none', async () => {
  // 2026-10-08 实测漏掉：叠字只从 task.result.content.title / task.sourceSnapshot.title 取，
  // 而「重生封面」任务只带封面提示词、**不带发布文案**——于是叠字被静默跳过，
  // 新提示词生出了干净的底图却还是没有标题。修法是回项目读已保存的 packaging。
  const source = await readFile(join(import.meta.dirname, '..', 'spoken-video-publish-host.mjs'), 'utf8')
  assert.ok(source.includes('title = detail?.artifacts?.packaging?.data?.content?.title || null'),
    "the cover overlay must read the title from the project saved packaging")
  assert.ok(source.includes('if (!title) title = task.result?.content?.title'),
    "and keep the in-task title as a later fallback")})
test('the portrait cover is generated at 3:4 so nothing important falls outside the feed crop', async () => {
  // 抖音、小红书的信息流封面都按 3:4 展示。9:16 生成的图上下会被裁掉约 25%，
  // 主体很容易被切到——按展示形态生成，主体天然落在必留区里。
  const source = await readFile(new URL('../spoken-video-publish-host.mjs', import.meta.url), 'utf8')
  assert.match(source, /size: kind === 'landscape' \? '1280\*720' : '1080\*1440'/u)
  const prompt = buildPublishPrompt({ project: { title: '测试', artifacts: {} } })
  assert.match(prompt, /竖屏 3:4/u, 'the packaging agent is told to compose for 3:4')
  assert.match(prompt, /竖屏 3:4 比 9:16 更"方"/u, 'and that 3:4 needs a different layout than 9:16')
  // 竖屏别再沿用横版的左右分栏——3:4 更方，左右并排会挤。
  assert.match(prompt, /竖版请改为上下分层或单主体居中，不要沿用横版的左右分栏/u)
})

test('a busy title zone is reported instead of silently stacking text over artwork', async () => {
  // 2026-10-08 实测：提示词已经要求「顶部 18% 留空」，但生图模型没照做，时钟图标和
  // 「昨天/今天」标签穿进了标题位，和叠加的标题糊在一起。检出来要报给人知道。
  const cover = await readFile(new URL('../spoken-video-cover-text.mjs', import.meta.url), 'utf8')
  assert.match(cover, /export async function titleZoneBusy\(/u)
  assert.match(cover, /edgedetect=low=0\.1:high=0\.5/u)
  assert.match(cover, /if \(zone\?\.busy && typeof onZoneBusy === 'function'\) onZoneBusy\(zone\)/u)
  assert.match(cover, /titleZoneBusy: Boolean\(zone\?\.busy\)/u)
})

test('the headline is truncated to what the layout can actually hold', async () => {
  // 两行版式装得下 perLine*2 个字，硬编码 12 会把钩子后半句切掉：实测
  // 「同一个 AI 昨天还行、今天犯傻」只剩前半句，真正有信息量的「今天犯傻」丢了。
  const cover = await readFile(new URL('../spoken-video-cover-text.mjs', import.meta.url), 'utf8')
  assert.match(cover, /const capacity = Math\.max\(6, perLine \* layout\.maxLines - 2\)/u)
  assert.match(cover, /coverHeadline\(title, capacity\)/u)
  const landscape = coverLayoutFor('landscape', 1280, 720)
  const perLine = Math.max(4, Math.floor((1280 - landscape.sideMargin * 2) / landscape.fontSize))
  assert.ok(perLine * landscape.maxLines - 2 > 12, `a two-line 1280x720 cover holds more than the old fixed 12 (got ${perLine * landscape.maxLines - 2})`)
})

test('the cover font size respects the column width, not just the canvas height', () => {
  // 2026-10-08 实测：竖屏 3:4 是 1088x1440，按高度算字号得 98px，每行只装 9 个字，
  // 「苹果收紧 Mac 磁盘权限」在「限」字前被劈开、标题后半句全丢。改成宽度也参与决定：
  // 每行至少要装得下 MIN_CHARS_PER_LINE 个中文字。
  const portrait = coverLayoutFor('portrait', 1088, 1440)
  const landscape = coverLayoutFor('landscape', 1280, 720)
  const perLinePortrait = Math.max(4, Math.floor((1088 - portrait.sideMargin * 2) / portrait.fontSize))
  const perLineLandscape = Math.max(4, Math.floor((1280 - landscape.sideMargin * 2) / landscape.fontSize))
  assert.ok(perLinePortrait >= 12, `the portrait cover must fit 12 chars per line (got ${perLinePortrait} at ${portrait.fontSize}px)`)
  assert.ok(perLineLandscape >= 12, `the landscape cover must fit 12 chars per line (got ${perLineLandscape} at ${landscape.fontSize}px)`)
  // 字号也不能小到读不清——缩略图里字号要占画面足够比例。
  assert.ok(portrait.fontSize / 1440 > 0.05, 'the portrait headline stays large relative to the canvas')
  assert.ok(landscape.fontSize / 720 > 0.07, 'the landscape headline stays large relative to the canvas')
})

test('the headline wraps at punctuation instead of orphaning a trailing character', () => {
  // 硬折会把「权限」劈成「权」+「限」，第二行只剩一个字，在缩略图里很怪。
  const portrait = coverLayoutFor('portrait', 1088, 1440)
  const perLine = Math.max(4, Math.floor((1088 - portrait.sideMargin * 2) / portrait.fontSize))
  const lines = wrapCoverHeadline('苹果收紧 Mac 磁盘权限，你的 AI 工具还能跑吗', perLine, 2)
  assert.ok(lines.length >= 2, 'a long title wraps onto two lines')
  for (const [index, line] of lines.entries()) {
    assert.ok([...line].length >= 4, `line ${index + 1} should not orphan one or two characters: ${JSON.stringify(lines)}`)
  }
  // 行首空格会被 trim（渲染时本来就看不见），所以按「非空白字符完全一致」来断言。
  const strip = (value) => [...String(value)].filter((ch) => ch.trim() !== '').join('')
  assert.equal(strip(lines.join('')), strip('苹果收紧 Mac 磁盘权限，你的 AI 工具还能跑吗'), 'wrapping must not drop characters')
})