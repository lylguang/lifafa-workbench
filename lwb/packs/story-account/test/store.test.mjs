import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoryAccountStore } from '../story-account-store.mjs'

/** 工作区与 store 的隔离测试：全部在临时目录里跑，不碰真实数据。 */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-account-'))
  try {
    await run({ store: new StoryAccountStore(), agent: { workspacePath: dir }, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const KEY = 'idem-0001'
const GOOD_TOPIC = { title: '锅里的鱼', scenario: '年初三的厨房，我端着碗', keyLine: '你吃吧，我不饿' }
const GOOD_SCRIPT = `「妈，锅里的鱼你吃吧，我不饿。」
年初三晚上，我在厨房说完这句，就把碗放回水池。
水龙头开得很大。我没关。
我妈坐在饭桌那头，没抬头，只说了一句：「那你明天几点走。」
我说八点。
她说：「哦。」
后来我把行李箱从阳台拖出来，轮子在地砖上响。她起来给我塞了两个橘子，说路上吃。
门关上的时候，我听见厨房的水还在流。`

test('create 建立可读的项目记录', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: '第一条故事' })
    assert.equal(project.title, '第一条故事')
    assert.equal(project.revision, 1)
    assert.deepEqual(project.completedStages, [])
  })
})

test('commit 选题后 revision 递增且产物可读回', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const committed = await store.commit(agent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    assert.equal(committed.project.revision, 2)
    assert.deepEqual(committed.project.completedStages, ['topic'])
    const detail = await store.get(agent, { projectId: project.id })
    assert.equal(detail.artifacts.topic.data.keyLine, GOOD_TOPIC.keyLine)
  })
})

test('幂等回执：同一幂等标识重复提交返回同一结果', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const first = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    const second = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    assert.equal(second.project.revision, first.project.revision)
    assert.equal(second.artifact.id, first.artifact.id)
  })
})

test('revision 不符时报冲突而不是覆盖', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    await assert.rejects(
      () => store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: 'idem-0002', payload: GOOD_TOPIC }),
      /REVISION_CONFLICT|已被其他操作更新/u,
    )
  })
})

test('没有选题时不能提交稿件', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    await assert.rejects(
      () => store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'script', idempotencyKey: KEY, payload: { body: GOOD_SCRIPT } }),
      /STAGE_BLOCKED|先完成/u,
    )
  })
})

test('反塑料感未通过的稿件被拒绝落库', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const topic = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    const bad = `${GOOD_SCRIPT}\n我终于明白了，这就是人生。`
    await assert.rejects(
      () => store.commit(agent, { projectId: project.id, expectedRevision: topic.project.revision, stage: 'script', idempotencyKey: 'idem-0003', payload: { body: bad } }),
      /SCRIPT_REJECTED|反塑料感/u,
    )
  })
})

test('合格稿件落库后带反塑料感报告', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const topic = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    const script = await store.commit(agent, { projectId: project.id, expectedRevision: topic.project.revision, stage: 'script', idempotencyKey: 'idem-0003', payload: { body: GOOD_SCRIPT, title: '锅里的鱼' } })
    assert.equal(script.project.completedStages.includes('script'), true)
    const detail = await store.get(agent, { projectId: project.id })
    assert.equal(detail.artifacts.script.data.antiPlastic.passed, true)
  })
})

test('后续阶段提交会让下游产物失效', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const topic = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    await store.commit(agent, { projectId: project.id, expectedRevision: topic.project.revision, stage: 'script', idempotencyKey: 'idem-0003', payload: { body: GOOD_SCRIPT } })
    const again = await store.commit(agent, { projectId: project.id, expectedRevision: 3, stage: 'topic', idempotencyKey: 'idem-0004', payload: { ...GOOD_TOPIC, title: '改写标题' } })
    // 重做选题必须把稿件一起作废，否则新选题会配上一篇旧稿子。
    assert.equal(again.project.completedStages.includes('script'), false)
  })
})

test('人工提交 video 阶段在依赖缺失时被拦', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    await assert.rejects(
      () => store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'video', idempotencyKey: KEY, payload: {} }),
      (error) => error.code === 'STORY_ACCOUNT_STAGE_BLOCKED' || error.code === 'STORY_ACCOUNT_STAGE_AUTOMATION_REQUIRED',
    )
  })
})

test('人工提交 video 阶段在依赖满足时被拒为自动化专用', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const topic = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    const script = await store.commit(agent, { projectId: project.id, expectedRevision: topic.project.revision, stage: 'script', idempotencyKey: 'idem-0003', payload: { body: GOOD_SCRIPT } })
    const voice = await store.commit(agent, {
      projectId: project.id,
      expectedRevision: script.project.revision,
      stage: 'voiceover',
      idempotencyKey: 'idem-0005',
      payload: { audio: { file: 'media/voiceovers/a.wav', mediaType: 'audio/wav' } },
    })
    await assert.rejects(
      () => store.commit(agent, { projectId: project.id, expectedRevision: voice.project.revision, stage: 'video', idempotencyKey: 'idem-0006', payload: {} }),
      /STAGE_AUTOMATION_REQUIRED|受控任务/u,
    )
  })
})

test('approveScript 与稿件版本绑定', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const topic = await store.commit(agent, { projectId: project.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    const script = await store.commit(agent, { projectId: project.id, expectedRevision: topic.project.revision, stage: 'script', idempotencyKey: 'idem-0003', payload: { body: GOOD_SCRIPT } })
    const approved = await store.approveScript(agent, { projectId: project.id })
    assert.equal(approved.scriptApproval.current, true)
    assert.equal(approved.scriptApproval.revision, script.project.revision)
  })
})

test('质检缺审片报告时拒绝提交', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    await assert.rejects(
      () => store.commitProduced(agent, {
        projectId: project.id,
        expectedRevision: 1,
        stage: 'qc',
        idempotencyKey: KEY,
        source: 'story-account/test',
        payload: {},
      }),
      /STAGE_BLOCKED|先完成/u,
    )
  })
})

test('自动产物来源必须带 story-account 前缀', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    await assert.rejects(
      () => store.commitProduced(agent, { projectId: project.id, expectedRevision: 1, stage: 'voiceover', idempotencyKey: KEY, source: 'spoken-video/tts', payload: {} }),
      /来源无效/u,
    )
  })
})

test('checkScript 只回报告不落库', async () => {
  await withStore(async ({ store }) => {
    const report = store.checkScript({ body: GOOD_SCRIPT })
    assert.equal(report.passed, true)
    assert.equal(report.artifactType, 'story_anti_plastic_report')
    assert.throws(() => store.checkScript({ body: '   ' }), /不能为空/u)
  })
})

test('remove 按 id 精确删除且报告缺失项', async () => {
  await withStore(async ({ store, agent }) => {
    const project = await store.create(agent, { title: 'x' })
    const result = await store.remove(agent, { projectIds: [project.id, '33333333-3333-3333-3333-333333333333'] })
    assert.deepEqual(result.removed, [project.id])
    assert.deepEqual(result.missing, ['33333333-3333-3333-3333-333333333333'])
    assert.deepEqual(await store.list(agent), [])
  })
})

test('list 按更新时间倒序', async () => {
  await withStore(async ({ store, agent }) => {
    const first = await store.create(agent, { title: 'a' })
    const second = await store.create(agent, { title: 'b' })
    await store.commit(agent, { projectId: first.id, expectedRevision: 1, stage: 'topic', idempotencyKey: KEY, payload: GOOD_TOPIC })
    const items = await store.list(agent)
    assert.equal(items[0].id, first.id)
    assert.equal(items.length, 2)
    assert.ok(items.some((item) => item.id === second.id))
  })
})

test('项目数据落在能力包专属工作区的 data/projects 下', async () => {
  await withStore(async ({ store, agent, dir }) => {
    const project = await store.create(agent, { title: 'x' })
    const raw = JSON.parse(await readFile(join(dir, 'data', 'projects', project.id, 'project.json'), 'utf8'))
    assert.equal(raw.id, project.id)
  })
})

test('缺少工作区时给出明确的错误码', async () => {
  const store = new StoryAccountStore()
  await assert.rejects(() => store.list({}), /WORKSPACE_REQUIRED|专属工作区/u)
})

test('写 JSON 走原子写，落盘后是有效文件且无残留临时文件', async () => {
  await withStore(async ({ store, agent, dir }) => {
    const project = await store.create(agent, { title: '原子写' })
    const file = join(dir, 'data', 'projects', project.id, 'project.json')
    const text = await readFile(file, 'utf8')
    assert.doesNotThrow(() => JSON.parse(text), '落盘文件应为有效 JSON')
    const siblings = await readdir(join(dir, 'data', 'projects', project.id))
    assert.ok(!siblings.some((name) => name.endsWith('.tmp')), '不应残留临时文件')
  })
})

test('verifyIntegrity 能揪出损坏的 project.json', async () => {
  await withStore(async ({ store, agent, dir }) => {
    const project = await store.create(agent, { title: '损坏检测' })
    const file = join(dir, 'data', 'projects', project.id, 'project.json')
    await writeFile(file, '{ 损坏的 json', 'utf8')
    const report = await store.verifyIntegrity(agent)
    assert.equal(report.total, 1)
    assert.equal(report.corrupt.length, 1)
    assert.equal(report.corrupt[0].id, project.id)
  })
})
