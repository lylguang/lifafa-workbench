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
      if (body.parameters.size === '720*1280') return jsonResponse({ message: 'quota exhausted' }, 429)
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
      assert.match(String(url), /^https:\/\/cdn\.test\/(1280\*720|720\*1280)\.png$/u)
      const [width, height] = new URL(String(url)).pathname.slice(1, -4).split('*').map(Number)
      return imageResponse(png(width, height))
    },
  })
  const started = await host.startPackaging(currentAgent, { projectId: project.id, expectedRevision: project.revision })
  const finished = await waitForTask(host, currentAgent, started.id)
  assert.equal(finished.status, 'succeeded')
  assert.deepEqual(finished.coverErrors, { landscape: null, portrait: null })
  assert.deepEqual(sizes.sort(), ['1280*720', '720*1280'])
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.packaging.data.covers.landscape.width, 1280)
  assert.equal(detail.artifacts.packaging.data.covers.portrait.height, 1280)
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
