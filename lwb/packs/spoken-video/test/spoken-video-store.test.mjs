import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SpokenVideoProjectStore, SpokenVideoStoreError } from '../spoken-video-store.mjs'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-spoken-video-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'workspace')
  await mkdir(dir)
  return dir
}

function agent(cwd) { return { session: { header: { cwd } } } }
function request(project, stage, payload, suffix = stage) {
  return { projectId: project.id, expectedRevision: project.revision, stage, payload, idempotencyKey: `request-${suffix}-1234` }
}
/** Minimal host-produced packaging artifact accepted by publishPackaging(). */
function packagingPayload(overrides = {}) {
  return {
    mode: 'agent',
    taskId: '11111111-1111-4111-8111-111111111111',
    content: { title: 'AI 工作流的三个误区', copy: '先说结论：不要把工作流当作黑盒。', description: '三个常见误区与对策。', tags: ['AI', '工作流'] },
    prompts: { landscape: '横屏封面提示词', portrait: '竖屏封面提示词', negative: '水印' },
    covers: { landscape: null, portrait: null },
    imageProvider: null,
    coverErrors: {},
    generatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

test('persists an immutable automated video workflow ending at packaging', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await store.create(currentAgent, { title: 'AI 工作流的三个误区' })
  assert.equal((await store.list(currentAgent))[0].id, project.id)

  for (const [stage, payload] of [
    ['signals', { source: 'manual', text: '用户提到 AI 工作流预算失控。' }],
    ['topic', { title: 'AI 工作流的三个误区', angle: '预算与质量' }],
    ['script', { body: '先说结论：不要把工作流当作黑盒。' }],
    ['voiceover', { notes: '人工录制，语速 220 字/分钟。' }],
    ['subtitles', { srt: '1\n00:00:00,000 --> 00:00:02,000\n先说结论。' }],
  ]) {
    const result = await store.commit(currentAgent, request(project, stage, payload))
    project = result.project
    if (stage === 'script') project = await store.approveScript(currentAgent, { projectId: project.id })
  }
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'video', idempotencyKey: 'automated-video-0001', source: 'spoken-video/local-ffmpeg',
    payload: { mode: 'local-ffmpeg', renderer: 'local-ffmpeg', visualBrief: '竖屏，标题卡加关键句字幕。', sourceAudioFile: 'media/voiceovers/voice.wav', sourceSubtitleFile: 'media/subtitles/current.srt', video: { file: 'media/videos/video.mp4', mediaType: 'video/mp4', bytes: 4096, durationSeconds: 2, width: 1080, height: 1920, fps: 30, hasAudio: true } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'automated-qc-0001', source: 'spoken-video/ffprobe',
    payload: { mode: 'automatic', reportFile: 'media/qc/video.json', passed: true, technical: { passed: true, issues: [], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } } },
  })).project
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'packaging', idempotencyKey: 'automated-packaging-0001', source: 'spoken-video/publish-agent',
    payload: packagingPayload(),
  })).project
  // packaging is the terminal stage: ready-to-publish means the packaging
  // artifact exists; there is no approval/queue gate anymore.
  assert.equal(project.stage, 'packaging')
  assert.deepEqual(project.completedStages, ['signals', 'topic', 'script', 'voiceover', 'subtitles', 'video', 'qc', 'packaging'])
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.script.data.body, '先说结论：不要把工作流当作黑盒。')
  assert.equal(detail.artifacts.qc.passed, true)
  assert.equal(detail.artifacts.packaging.data.content.title, 'AI 工作流的三个误区')
  assert.match(await readFile(join(cwd, 'data', 'projects', project.id, 'project.json'), 'utf8'), /"packaging"/u)
})

test('invalidates downstream artifacts when an upstream script changes and rejects stale writes', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await store.create(currentAgent, { title: '选题' })
  for (const [stage, payload] of [
    ['topic', { title: '选题' }],
    ['script', { body: '第一版' }],
    ['voiceover', { notes: '第一版配音' }],
  ]) {
    project = (await store.commit(currentAgent, request(project, stage, payload))).project
    if (stage === 'script') project = await store.approveScript(currentAgent, { projectId: project.id })
  }
  await assert.rejects(
    store.commit(currentAgent, { ...request(project, 'subtitles', { srt: '字幕' }), expectedRevision: project.revision - 1 }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_REVISION_CONFLICT',
  )
  project = (await store.commit(currentAgent, request(project, 'script', { body: '第二版' }, 'script-revision-two'))).project
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.voiceover, undefined)
  assert.equal(detail.artifacts.script.data.body, '第二版')
})

test('requires a workspace-bound DSH agent and blocks unknown stages', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  await assert.rejects(store.create({ session: { header: {} } }, { title: '无工作区' }), /WORKSPACE_REQUIRED/u)
  const currentAgent = agent(cwd)
  const project = await store.create(currentAgent, { title: '选题' })
  // approval/queue no longer exist: they are rejected as invalid stage names.
  await assert.rejects(
    store.commit(currentAgent, request(project, 'queue', { destination: 'test' })),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_INVALID_INPUT',
  )
  await assert.rejects(
    store.commit(currentAgent, request(project, 'approval', { confirm: true })),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_INVALID_INPUT',
  )
})

async function projectWithScript(t, store, currentAgent) {
  let project = await store.create(currentAgent, { title: '稿件闸门' })
  project = (await store.commit(currentAgent, request(project, 'topic', { title: '稿件闸门' }))).project
  project = (await store.commit(currentAgent, request(project, 'script', { body: '这是一篇需要人工确认的口播稿。' }))).project
  return project
}

test('saved scripts can enter voiceover without a separate approval', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithScript(t, store, currentAgent)
  assert.equal(project.scriptApproval, null)
  const resumed = (await store.commit(currentAgent, request(project, 'voiceover', { notes: '配音说明' }, 'voiceover-ok'))).project
  assert.ok(resumed.completedStages.includes('voiceover'))
})

test('editing a saved script invalidates old media but allows new voiceover', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectWithScript(t, store, currentAgent)
  project = (await store.commit(currentAgent, request(project, 'voiceover', { notes: '第一版配音' }, 'voiceover-old'))).project
  project = (await store.commit(currentAgent, request(project, 'script', { body: '第二版已保存稿件。' }, 'script-v2'))).project
  assert.ok(!project.completedStages.includes('voiceover'))
  project = (await store.commit(currentAgent, request(project, 'voiceover', { notes: '第二版配音' }, 'voiceover-new'))).project
  assert.ok(project.completedStages.includes('voiceover'))
})

test('approveScript requires an existing script and listScriptCorpus excludes one project', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const empty = await store.create(currentAgent, { title: '无稿件' })
  await assert.rejects(store.approveScript(currentAgent, { projectId: empty.id }), /还没有口播稿/u)
  const withScript = await projectWithScript(t, store, currentAgent)
  const corpus = await store.listScriptCorpus(currentAgent, {})
  assert.equal(corpus.length, 1)
  assert.equal(corpus[0].projectId, withScript.id)
  assert.equal((await store.listScriptCorpus(currentAgent, { excludeProjectId: withScript.id })).length, 0)
})

test('lists saved scripts with text search and pagination for audio selection', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const approved = await store.approveScript(currentAgent, { projectId: (await projectWithScript(t, store, currentAgent)).id })
  await projectWithScript(t, store, currentAgent)

  const selected = await store.listScripts(currentAgent, { query: '人工确认', offset: 0, limit: 8 })
  assert.equal(selected.total, 2)
  const approvedItem = selected.items.find((item) => item.id === approved.id)
  assert.equal(approvedItem?.title, '稿件闸门')
  assert.equal(selected.items.every((item) => item.scriptChars > 0), true)
  assert.ok(approvedItem?.approvedAt)
  assert.deepEqual((await store.listScripts(currentAgent, { query: '未确认独有搜索词', offset: 0, limit: 8 })).items, [])
  assert.equal((await store.listScripts(currentAgent, { offset: 1, limit: 8 })).items.length, 1)

  const revised = (await store.commit(currentAgent, request(approved, 'script', { body: '改稿后旧确认必须失效。' }, 'approved-script-v2'))).project
  assert.equal(revised.scriptApproval.current, false)
  assert.equal((await store.listApprovedScripts(currentAgent)).total, 0)
})

test('listWritableTopics feeds the script picker: topic-only projects, three script states, frozen account snapshot, newest first', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  // An empty workspace yields no topics.
  assert.deepEqual(await store.listWritableTopics(currentAgent), [])

  const account = {
    id: '19141371-91a0-4043-a3df-bc3add45676b', name: 'AI明白局', revision: 3,
    positioning: 'AI 工具垂类', audience: '开发者', pillars: ['工具判断'], boundary: '不荐股',
  }
  // A project that stopped before topic is never a writable topic.
  let preTopic = await store.create(currentAgent, { title: '仅信号' })
  preTopic = (await store.commit(currentAgent, request(preTopic, 'signals', { source: 'manual', text: '一条线索。' }, 'signals-only'))).project

  // (a) topic confirmed, no script yet.
  let noneProject = await store.create(currentAgent, { title: '待写稿' })
  noneProject = (await store.commit(currentAgent, request(noneProject, 'signals', { source: '百度热榜', text: '第一条信号。' }, 'n-signals'))).project
  noneProject = (await store.commit(currentAgent, request(noneProject, 'signals', { source: '百度热榜', text: '第二条信号。' }, 'n-signals-2'))).project
  noneProject = (await store.commit(currentAgent, request(noneProject, 'topic', { title: '待写稿', angle: '家长视角', account }, 'n-topic'))).project

  // (b) script saved but not approved.
  let draftProject = await store.create(currentAgent, { title: '有稿待确认' })
  draftProject = (await store.commit(currentAgent, request(draftProject, 'topic', { title: '有稿待确认' }, 'd-topic'))).project
  draftProject = (await store.commit(currentAgent, request(draftProject, 'script', { body: '这是 一段 需要 确认 的 稿件 正文。' }, 'd-script'))).project

  // (c) script saved and approved.
  let approvedProject = await store.create(currentAgent, { title: '已确认稿件' })
  approvedProject = (await store.commit(currentAgent, request(approvedProject, 'topic', { title: '已确认稿件' }, 'a-topic'))).project
  approvedProject = (await store.commit(currentAgent, request(approvedProject, 'script', { body: '已确认的稿件正文。' }, 'a-script'))).project
  await store.approveScript(currentAgent, { projectId: approvedProject.id })

  const topics = await store.listWritableTopics(currentAgent)
  assert.deepEqual(topics.map((item) => item.title), ['已确认稿件', '有稿待确认', '待写稿'], 'sorted by updatedAt desc, pre-topic project excluded')

  const byTitle = Object.fromEntries(topics.map((item) => [item.title, item]))
  const none = byTitle['待写稿']
  assert.equal(none.scriptState, 'none')
  assert.equal(none.scriptChars, 0)
  assert.equal(none.signalCount, 2)
  assert.equal(none.angle, '家长视角')
  assert.deepEqual(none.account, { id: account.id, name: 'AI明白局', revision: 3 }, 'carries the frozen snapshot, not the live account')
  assert.equal(none.approvalRevision, null)
  assert.equal(byTitle['有稿待确认'].scriptState, 'draft')
  assert.equal(byTitle['有稿待确认'].scriptChars, 14, 'whitespace-free character count')
  assert.equal(byTitle['有稿待确认'].account, null)
  const approved = byTitle['已确认稿件']
  assert.equal(approved.scriptState, 'approved')
  assert.equal(approved.approvalRevision, approved.revision)
  assert.ok(approved.approvedAt)

  // A later script revision demotes approved -> draft (approval is revision-bound).
  const revised = (await store.commit(currentAgent, request(approvedProject, 'script', { body: '改版后的稿件正文，需要重新确认。' }, 'a-script-v2'))).project
  const afterRevision = await store.listWritableTopics(currentAgent)
  const revisedCard = afterRevision.find((item) => item.title === '已确认稿件')
  assert.equal(revisedCard.scriptState, 'draft')
  assert.equal(revisedCard.approvalRevision, null)
  assert.equal(revisedCard.revision, revised.revision)
})

test('a topic can leave and re-enter the writing queue before writing begins', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await store.create(currentAgent, { title: '可撤回选题' })
  project = (await store.commit(currentAgent, request(project, 'topic', { title: '可撤回选题' }, 'queue-topic'))).project

  const withdrawn = await store.setTopicSelected(currentAgent, { projectId: project.id, selected: false })
  assert.equal(withdrawn.topicSelected, false)
  assert.deepEqual(await store.listWritableTopics(currentAgent), [])

  const restored = await store.setTopicSelected(currentAgent, { projectId: project.id, selected: true })
  assert.equal(restored.topicSelected, true)
  assert.deepEqual((await store.listWritableTopics(currentAgent)).map((item) => item.title), ['可撤回选题'])

  project = (await store.commit(currentAgent, request(restored, 'script', { body: '已经保存的口播稿不能被静默撤回。' }, 'queue-script'))).project
  await assert.rejects(
    store.setTopicSelected(currentAgent, { projectId: project.id, selected: false }),
    /已有稿件/u,
  )
})

test('remove deletes a project with all its artifacts and media, singly or in bulk', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const keep = await store.create(currentAgent, { title: '保留的项目' })
  let doomed = await store.create(currentAgent, { title: '待删除的项目' })
  doomed = (await store.commit(currentAgent, request(doomed, 'topic', { title: '待删除的项目' }, 'del-topic'))).project
  doomed = (await store.commit(currentAgent, request(doomed, 'script', { body: '这段稿件会随项目一起删除。' }, 'del-script'))).project

  // 素材目录里放一个文件，验证删除会连同媒体一起清掉，而不只是记录。
  const mediaFile = join(cwd, 'data', 'projects', doomed.id, 'media', 'voiceovers', 'clip.wav')
  await mkdir(join(cwd, 'data', 'projects', doomed.id, 'media', 'voiceovers'), { recursive: true })
  await writeFile(mediaFile, 'fake-audio')

  const result = await store.remove(currentAgent, { projectIds: [doomed.id] })
  assert.deepEqual(result.removed, [doomed.id])
  assert.deepEqual(result.missing, [])
  assert.deepEqual((await store.list(currentAgent)).map((item) => item.title), ['保留的项目'])
  await assert.rejects(readFile(mediaFile), /ENOENT/u)
  await assert.rejects(store.get(currentAgent, { projectId: doomed.id }), /不存在/u)

  // 重复删除同一 id 报告 missing，而不是抛错或误删别的项目。
  const again = await store.remove(currentAgent, { projectIds: [doomed.id] })
  assert.deepEqual(again.removed, [])
  assert.deepEqual(again.missing, [doomed.id])

  // 单个删除走 projectId 字段。
  const single = await store.remove(currentAgent, { projectId: keep.id })
  assert.deepEqual(single.removed, [keep.id])
  assert.deepEqual(await store.list(currentAgent), [])
})

test('remove refuses an empty selection and caps the batch size', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  await assert.rejects(store.remove(currentAgent, { projectIds: [] }), /至少选择一个/u)
  const tooMany = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
  await assert.rejects(store.remove(currentAgent, { projectIds: tooMany }), /最多删除 50 个/u)
})

test('remove never follows a symlinked project directory out of the workspace', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const outside = join(cwd, '..', `lwb-outside-${Date.now()}`)
  await mkdir(outside, { recursive: true })
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'project.json'), '{"schemaVersion":1,"id":"x","title":"外部"}')

  const linkId = '11111111-1111-4111-8111-111111111111'
  const projectsRoot = join(cwd, 'data', 'projects')
  await mkdir(projectsRoot, { recursive: true })
  try {
    await symlink(outside, join(projectsRoot, linkId), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('symlinks are unavailable in this environment')
    return
  }

  const result = await store.remove(currentAgent, { projectIds: [linkId] })
  assert.deepEqual(result.removed, [], '符号链接目录不能被当作项目删除')
  assert.deepEqual(result.missing, [linkId])
  // 外部目录必须原样保留。
  assert.equal(await readFile(join(outside, 'project.json'), 'utf8'), '{"schemaVersion":1,"id":"x","title":"外部"}')
})

test('pipelineOverview reports every project stage and its next page, aligned with work page gates', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)

  // 项目一：只确认选题 → 待写稿。
  let pending = await store.create(currentAgent, { title: '待写稿项目' })
  pending = (await store.commit(currentAgent, request(pending, 'signals', { source: 'manual', text: '信号' }))).project
  pending = (await store.commit(currentAgent, request(pending, 'topic', { title: '待写稿项目', angle: '角度' }))).project
  await store.setTopicSelected(currentAgent, { projectId: pending.id, selected: true })

  // 项目二：稿件已确认 → 待配音。
  let voiced = await store.create(currentAgent, { title: '待配音项目' })
  for (const [stage, payload] of [
    ['signals', { source: 'manual', text: '信号' }],
    ['topic', { title: '待配音项目', angle: null }],
    ['script', { body: '正文。' }],
  ]) {
    voiced = (await store.commit(currentAgent, request(voiced, stage, payload))).project
    if (stage === 'script') await store.approveScript(currentAgent, { projectId: voiced.id })
  }
  await store.setTopicSelected(currentAgent, { projectId: voiced.id, selected: true })

  // 项目三：配音字幕齐、未渲染 → 待视频制作；项目四：质检通过 → 可发布。
  let rendering = await store.create(currentAgent, { title: '待制作项目' })
  for (const [stage, payload] of [
    ['signals', { source: 'manual', text: '信号' }],
    ['topic', { title: '待制作项目', angle: null }],
    ['script', { body: '正文。' }],
    ['voiceover', { notes: '配音说明。' }],
    ['subtitles', { srt: '1\n00:00:00,000 --> 00:00:02,000\n正文。' }],
  ]) {
    const result = await store.commit(currentAgent, request(rendering, stage, payload))
    rendering = result.project
    if (stage === 'script') await store.approveScript(currentAgent, { projectId: rendering.id })
  }
  let publishing = await store.create(currentAgent, { title: '可发布项目' })
  for (const [stage, payload] of [
    ['signals', { source: 'manual', text: '信号' }],
    ['topic', { title: '可发布项目', angle: null }],
    ['script', { body: '正文。' }],
    ['voiceover', { notes: '配音说明。' }],
    ['subtitles', { srt: '1\n00:00:00,000 --> 00:00:02,000\n正文。' }],
  ]) {
    const result = await store.commit(currentAgent, request(publishing, stage, payload))
    publishing = result.project
    if (stage === 'script') await store.approveScript(currentAgent, { projectId: publishing.id })
  }
  const rendered = (await store.commitProduced(currentAgent, {
    projectId: publishing.id, expectedRevision: publishing.revision, stage: 'video', idempotencyKey: 'pipeline-video-0001', source: 'spoken-video/local-ffmpeg',
    payload: { mode: 'local-ffmpeg', renderer: 'local-ffmpeg', visualBrief: '竖屏。', sourceAudioFile: 'media/voiceovers/pipeline.wav', sourceSubtitleFile: 'media/subtitles/pipeline.srt', video: { file: 'media/videos/pipeline.mp4', mediaType: 'video/mp4', bytes: 4096, durationSeconds: 2, width: 1080, height: 1920, fps: 30, hasAudio: true } },
  })).project
  await store.commitProduced(currentAgent, {
    projectId: rendered.id, expectedRevision: rendered.revision, stage: 'qc', idempotencyKey: 'pipeline-qc-0001', source: 'spoken-video/ffprobe',
    payload: { mode: 'automatic', reportFile: 'media/qc/pipeline.json', passed: true, technical: { passed: true, issues: [], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } } },
  })

  const overview = await store.pipelineOverview(currentAgent)
  assert.equal(overview.total, 4)
  const stageOf = (title) => overview.items.find((item) => item.title === title)
  assert.equal(stageOf('待写稿项目').stage, 'script-pending')
  assert.equal(stageOf('待写稿项目').page, 'scripts')
  assert.equal(stageOf('待配音项目').stage, 'voiceover')
  assert.equal(stageOf('待配音项目').page, 'audio-captions')
  assert.equal(stageOf('待制作项目').stage, 'video')
  assert.equal(stageOf('待制作项目').page, 'video-preview')
  assert.equal(stageOf('可发布项目').stage, 'publish')
  assert.equal(stageOf('可发布项目').page, 'publish')
  // 阶段顺序：写稿组在最前，发布组在最后。
  assert.deepEqual(overview.items.map((item) => item.stage), ['script-pending', 'voiceover', 'video', 'publish'])
  // 阶段布尔量与闸门一致：已确认稿件的项目 script=true，未确认=false。
  assert.equal(stageOf('待写稿项目').stages.script, false)
  assert.equal(stageOf('待配音项目').stages.script, true)
  assert.equal(stageOf('可发布项目').stages.qc, true)
})

// 造出「已完成 video、尚未 qc」的项目，供下面 userOverride 测试复用。
async function projectThroughVideo(store, currentAgent, title = '极简静态片') {
  let project = await store.create(currentAgent, { title })
  for (const [stage, payload] of [
    ['signals', { source: 'manual', text: 'x' }],
    ['topic', { title }],
    ['script', { body: '静态海报风格。' }],
    ['voiceover', { notes: 'n' }],
    ['subtitles', { srt: '1\n00:00:00,000 --> 00:00:02,000\n标题。' }],
  ]) {
    project = (await store.commit(currentAgent, request(project, stage, payload))).project
    if (stage === 'script') project = await store.approveScript(currentAgent, { projectId: project.id })
  }
  project = (await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'video',
    idempotencyKey: 'm0-video', source: 'spoken-video/local-ffmpeg',
    payload: { mode: 'local-ffmpeg', renderer: 'local-ffmpeg', visualBrief: 'v', sourceAudioFile: 'media/voiceovers/video.wav', sourceSubtitleFile: 'media/subtitles/video.srt',
      video: { file: 'media/videos/video.mp4', mediaType: 'video/mp4', bytes: 4096, durationSeconds: 30, width: 1920, height: 1080, fps: 30, hasAudio: true } },
  })).project
  return project
}

// 失败 QC 的 payload 模板：passed=false 且带一条 issues（主画面变化不足）。
function failingQcPayload(overrides = {}) {
  return {
    mode: 'automatic', reportFile: 'media/qc/v.json', passed: false,
    technical: { passed: false, issues: ['主画面变化不足：12 个采样帧中只有 1 种画面。'], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } },
    ...overrides,
  }
}

test('qc commit stores userOverride while keeping passed=false', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectThroughVideo(store, currentAgent)
  // 用原始 commit 响应里的 artifactPointer 断言：它不得伪装成「通过」
  const qcCommit = await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'm0-qc-release-01', source: 'spoken-video/ffprobe',
    payload: failingQcPayload({ userOverride: true }),
  })
  assert.equal(qcCommit.artifact.passed, undefined, 'artifactPointer 不得带 passed:true')
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.qc.data.passed, false, '判据没过的事实不被改写')
  assert.equal(detail.artifacts.qc.data.userOverride, true, '人工放行标记已落盘')
  assert.ok(detail.artifacts.qc.data.overrideAt, 'overrideAt 已记录')
  assert.equal(detail.artifacts.qc.data.overrideBy, 'spoken-video/ffprobe', 'overrideBy 记录提交来源')
})

// 2026-10-22：variation 降级为记录项，但它仍是失败提示与人工放行的数据来源，
// 所以落盘后的字段一个都不能少。这条测试就是 schema 的守卫：谁删字段谁红。
test('qc commit keeps every variation field even though variation is now advisory', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectThroughVideo(store, currentAgent)
  await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'm0-qc-variation-01', source: 'spoken-video/ffprobe',
    payload: {
      mode: 'automatic', reportFile: 'media/qc/v.json', passed: false,
      technical: {
        passed: false, issues: ['成片有 24/24 张画面没有任何内容。'], warnings: ['画面变化量偏少（记录项）。'],
        video: {}, audio: {}, subtitles: { cueCount: 1 },
        variation: {
          assessed: true, passed: false, advisory: true,
          sampledFrameCount: 24, distinctMainFrames: 1, meaningfulPairs: 0,
          averagePairDifference: 0, pairDifferences: Array.from({ length: 23 }, () => 0),
          crop: 'top 80%', note: '画面变化量为记录项，不参与质检否决。',
        },
      },
    },
  })
  const detail = await store.get(currentAgent, { projectId: project.id })
  const variation = detail.artifacts.qc.data.technical.variation
  assert.ok(variation, 'variation 块必须落盘')
  // 五个必需字段一个都不能少——它们是失败提示与人工放行的数据来源。
  assert.equal(variation.distinctMainFrames, 1, 'distinctMainFrames 必须保留')
  assert.equal(variation.meaningfulPairs, 0, 'meaningfulPairs 必须保留')
  assert.equal(variation.averagePairDifference, 0, 'averagePairDifference 必须保留')
  assert.equal(variation.pairDifferences.length, 23, 'pairDifferences 必须保留')
  assert.equal(variation.crop, 'top 80%', 'crop 必须保留')
  // 降级语义标记也要落盘：它是「这条只记录、不否决」的凭据。
  assert.equal(variation.advisory, true, 'advisory 标记必须落盘')
  assert.equal(variation.passed, false, 'passed 仍如实反映变化量是否够，不改写事实')
  // 记录项不能变成否决线：warnings 里可以写，但 issues 才是拦截依据。
  assert.equal(detail.artifacts.qc.data.technical.issues.length, 1, 'issues 不因 variation 而增加')
})

test('qc commit rejects userOverride when there are no issues', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await projectThroughVideo(store, currentAgent)
  await assert.rejects(
    store.commitProduced(currentAgent, {
      projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'm0-qc-noissues-01', source: 'spoken-video/ffprobe',
      payload: { mode: 'automatic', reportFile: 'media/qc/v.json', passed: true, technical: { passed: true, issues: [], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } }, userOverride: true },
    }),
    /没有质检问题，不需要人工放行。/u,
  )
})

/**
 * 审片否决也能人工放行。
 *
 * 2026-10-26 实测的缺口：成片已渲染完（30MB）、**技术质检通过**、审片判了
 * 3 处排版 major，整轮判死。因为提交动作在审片之后，盘上的成片从未进过
 * `media/videos/`，项目里查不到，用户只看到「全部失败」——**没有任何放行出口**。
 * 后端守卫原来只认「技术质检 issues」，而这里 technical.issues 是空的。
 *
 * 这两条用例锁住：技术质检过 + 审片不过，也必须能放行；而两者都过时仍然拒绝
 * （无病放行）。
 */
test('qc commit allows userOverride when technical passed but editorial review failed', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectThroughVideo(store, currentAgent)
  const qcCommit = await store.commitProduced(currentAgent, {
    projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'm0-qc-editorial-release-01', source: 'spoken-video/remotion-agent',
    payload: {
      mode: 'ai-director', reportFile: 'media/qc/v.json', passed: false,
      // 技术质检是过的：issues 为空。整条不过是因为审片。
      technical: { passed: true, issues: [], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } },
      review: {
        passed: false, technicalPass: true, editorialPass: false, evidencePassed: true, score: 79,
        summary: '构图与可读性合格，但若干帧主画面与同屏字幕错配。',
        findings: [{ severity: 'major', category: 'relevance', message: '196.62s 右侧清单第 5 条被结算条压住。' }],
        reviewEvidence: [
          { timestampSeconds: 8.594, observedMainVisual: '开场标题页，大字标题与印章。' },
          { timestampSeconds: 196.62, observedMainVisual: '成本账：左收益栏、右五条清单。' },
        ],
      },
      userOverride: true,
    },
  })
  assert.equal(qcCommit.artifact.passed, undefined, 'artifactPointer 不得带 passed:true')
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.qc.data.passed, false, '整条没通过的事实不被改写')
  assert.equal(detail.artifacts.qc.data.userOverride, true, '放行标记已落盘')
  assert.equal(detail.artifacts.qc.data.technical.passed, true, '技术质检的结论保持原样')
  assert.equal(detail.artifacts.qc.data.review.passed, false, '审片结论保持原样')
})

test('qc commit still rejects userOverride when both gates passed', async (t) => {
  // 反向锁：两道门都过了还放行就是无病放行，必须拒绝——否则「放行」会变成
  // 一个可以随手点掉的开关，失去「我看过缺陷、我认可」的含义。
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectThroughVideo(store, currentAgent)
  await assert.rejects(
    store.commitProduced(currentAgent, {
      projectId: project.id, expectedRevision: project.revision, stage: 'qc', idempotencyKey: 'm0-qc-bothpassed-01', source: 'spoken-video/remotion-agent',
      payload: {
        mode: 'ai-director', reportFile: 'media/qc/v.json', passed: true,
        technical: { passed: true, issues: [], warnings: [], video: {}, audio: {}, subtitles: { cueCount: 1 } },
        review: {
          passed: true, technicalPass: true, editorialPass: true, evidencePassed: true, score: 88,
          summary: '全部通过。',
          findings: [],
          reviewEvidence: [
            { timestampSeconds: 8.594, observedMainVisual: '开场标题页。' },
            { timestampSeconds: 60, observedMainVisual: '流程示意图。' },
          ],
        },
        userOverride: true,
      },
    }),
    /没有质检问题，不需要人工放行。/u,
  )
})

test('packaging gate: blocked without release, allowed with userOverride (two-project)', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)

  // 项目 A：失败 QC，不放行 → 打包被挡
  let a = await projectThroughVideo(store, currentAgent, '极简静态片-A')
  a = (await store.commitProduced(currentAgent, {
    projectId: a.id, expectedRevision: a.revision, stage: 'qc', idempotencyKey: 'm0-qc-projecta-01', source: 'spoken-video/ffprobe',
    payload: failingQcPayload(),
  })).project
  await assert.rejects(
    store.commitProduced(currentAgent, {
      projectId: a.id, expectedRevision: a.revision, stage: 'packaging', idempotencyKey: 'm0-pkg-projecta-01', source: 'spoken-video/publish-agent', payload: packagingPayload(),
    }),
    /质检未通过且未人工放行/u,
  )

  // 项目 B：失败 QC，但人工放行 → 打包放行
  let b = await projectThroughVideo(store, currentAgent, '极简静态片-B')
  b = (await store.commitProduced(currentAgent, {
    projectId: b.id, expectedRevision: b.revision, stage: 'qc', idempotencyKey: 'm0-qc-projectb-01', source: 'spoken-video/ffprobe',
    payload: failingQcPayload({ userOverride: true }),
  })).project
  const after = (await store.commitProduced(currentAgent, {
    projectId: b.id, expectedRevision: b.revision, stage: 'packaging', idempotencyKey: 'm0-pkg-projectb-01', source: 'spoken-video/publish-agent', payload: packagingPayload(),
  })).project
  assert.equal(after.stage, 'packaging', '人工放行后打包准入放行')
})
