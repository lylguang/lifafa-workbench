import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoryAccountStore } from '../story-account-store.mjs'
import { buildTechnicalReport } from '../story-account-qc.mjs'

/** 工作区与 store 的隔离测试：全部在临时目录里跑，不碰真实数据。 */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-override-'))
  try {
    await run({ store: new StoryAccountStore(), agent: { workspacePath: dir }, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const GOOD_VIDEO = { durationSeconds: 66, width: 1080, height: 1920, fps: 30, hasAudio: true }

function goodTechnical() {
  return buildTechnicalReport({
    video: GOOD_VIDEO,
    audio: { durationSeconds: 66 },
    subtitles: { cueCount: 30, maxCueChars: 14 },
    subtitleEnabled: true,
  })
}

function qcPayload(antiPlastic) {
  return {
    mode: 'automation',
    reportFile: 'media/qc/tech.json',
    technical: goodTechnical(),
    review: {
      reviewer: '独立审片', editorialPass: true, score: 82, passed: true, summary: '开场直接进入冲突，画面在全片内有推进。',
      reviewEvidence: [
        { timestampSeconds: 3, observedMainVisual: '厨房近景，人物手部与碗，暖黄灯光' },
        { timestampSeconds: 40, observedMainVisual: '饭桌对面空椅子，字幕落在下半屏安全区内' },
      ],
      findings: [],
    },
    antiPlastic,
  }
}

const PROJECT_TITLE = '锅里的鱼'

// 把项目推进到「竖屏成片」已完成，满足质检闸门的阶段依赖，但不跑真实媒体流水线。
// 这样能直接验证 commitProduced 在 qc 阶段从磁盘读出人工放行并喂给 finalGate 的真实链路。
async function stageToVideo(dir, projectId) {
  const file = join(dir, 'data', 'projects', projectId, 'project.json')
  const project = JSON.parse(await readFile(file, 'utf8'))
  // 注入一个「竖屏成片」阶段指针，满足质检闸门的阶段依赖（不跑真实媒体流水线）。
  // 指针形状必须与 store 的 projectRecord 校验一致：id/stage/revision/file/createdAt。
  project.artifacts.video = { id: 'staged-video', stage: 'video', revision: 1, file: 'artifacts/1-video-staged.json', createdAt: new Date().toISOString() }
  project.completedStages = ['topic', 'script', 'voiceover', 'video']
  await writeFile(file, JSON.stringify(project, null, 2))
}

/* --------------------------- 放行校验：必须带操作者+理由 --------------------------- */

test('放行缺少操作者被拒', async () => {
  await withStore(async ({ store, agent }) => {
    const created = await store.create(agent, { title: PROJECT_TITLE })
    await assert.rejects(
      () => store.overrideAntiPlastic(agent, { projectId: created.id, blocker: '结尾出现升华句', reason: '客户要求保留' }),
      /STORY_ACCOUNT_INVALID_INPUT|操作者/u,
    )
  })
})

test('放行缺少理由被拒', async () => {
  await withStore(async ({ store, agent }) => {
    const created = await store.create(agent, { title: PROJECT_TITLE })
    await assert.rejects(
      () => store.overrideAntiPlastic(agent, { projectId: created.id, blocker: '结尾出现升华句', operator: '张三' }),
      /STORY_ACCOUNT_INVALID_INPUT|理由/u,
    )
  })
})

test('放行记录含操作者/理由/时间并持久化', async () => {
  await withStore(async ({ store, agent }) => {
    const created = await store.create(agent, { title: PROJECT_TITLE })
    const record = await store.overrideAntiPlastic(agent, {
      projectId: created.id,
      blocker: '结尾出现升华句',
      operator: '张三',
      reason: '客户要求保留升华句以强化情绪',
    })
    assert.equal(record.projectId, created.id)
    assert.equal(record.blocker, '结尾出现升华句')
    assert.equal(record.operator, '张三')
    assert.equal(record.reason, '客户要求保留升华句以强化情绪')
    assert.ok(record.id && record.createdAt)
    const listed = await store.listAntiPlasticOverrides(agent, { projectId: created.id })
    assert.deepEqual(listed.overrides, [record])
  })
})

// commitProduced 只回指针（含 file），质检数据写在产物文件里。读回来才能断言行为。
async function qcData(dir, projectId, pointer) {
  const file = join(dir, 'data', 'projects', projectId, pointer.file)
  const artifact = JSON.parse(await readFile(file, 'utf8'))
  return artifact.data
}

/* --------------------- commitProduced(qc) 从磁盘读出放行并喂给 finalGate --------------------- */

test('被放行的硬拦项不再卡 finalGate，但其余硬拦项仍卡', async () => {
  await withStore(async ({ store, agent, dir }) => {
    const created = await store.create(agent, { title: PROJECT_TITLE })
    const projectId = created.id
    await stageToVideo(dir, projectId)

    const antiPlastic = { passed: false, blocking: ['A：结尾出现升华句', 'B：结尾出现口号式对白'], reasons: ['a', 'b'] }
    const first = await store.commitProduced(agent, {
      projectId, expectedRevision: 1, stage: 'qc',
      idempotencyKey: 'idem-qc-0001', source: 'story-account/test', payload: qcPayload(antiPlastic),
    })
    const firstData = await qcData(dir, projectId, first.artifact)
    assert.equal(firstData.passed, false, '两条硬拦项时质检不通过')
    assert.ok(firstData.blockers.some((item) => item.includes('A：') && item.includes('升华')))
    assert.ok(firstData.blockers.some((item) => item.includes('B：') && item.includes('口号')))

    // 只放行 A：commitProduced 在 qc 阶段从磁盘读出放行记录并喂给 finalGate。
    await store.overrideAntiPlastic(agent, { projectId, blocker: 'A：结尾出现升华句', operator: '张三', reason: '客户要求保留' })
    const second = await store.commitProduced(agent, {
      projectId, expectedRevision: first.project.revision, stage: 'qc',
      idempotencyKey: 'idem-qc-0002', source: 'story-account/test', payload: qcPayload(antiPlastic),
    })
    const secondData = await qcData(dir, projectId, second.artifact)
    assert.equal(secondData.passed, false, '仍有未放行的硬拦项，质检仍不通过')
    assert.ok(!secondData.blockers.some((item) => item.includes('A：')), '已放行的 A 不应再出现在 blockers')
    assert.ok(secondData.blockers.some((item) => item.includes('B：')), '未放行的 B 仍在 blockers')

    // 放行 B 后全部通过。
    await store.overrideAntiPlastic(agent, { projectId, blocker: 'B：结尾出现口号式对白', operator: '李四', reason: '经编审确认可接受' })
    const third = await store.commitProduced(agent, {
      projectId, expectedRevision: second.project.revision, stage: 'qc',
      idempotencyKey: 'idem-qc-0003', source: 'story-account/test', payload: qcPayload(antiPlastic),
    })
    const thirdData = await qcData(dir, projectId, third.artifact)
    assert.equal(thirdData.passed, true, '全部硬拦项放行后质检通过')
    assert.deepEqual(thirdData.blockers, [])
  })
})

test('放行不是静默删除：原始 blocker 与放行记录都保留在产物里', async () => {
  await withStore(async ({ store, agent, dir }) => {
    const created = await store.create(agent, { title: PROJECT_TITLE })
    const projectId = created.id
    await stageToVideo(dir, projectId)
    const antiPlastic = { passed: false, blocking: ['A：结尾出现升华句'], reasons: ['a'] }
    await store.overrideAntiPlastic(agent, { projectId, blocker: 'A：结尾出现升华句', operator: '张三', reason: '客户要求保留' })
    const result = await store.commitProduced(agent, {
      projectId, expectedRevision: 1, stage: 'qc',
      idempotencyKey: 'idem-qc-0001', source: 'story-account/test', payload: qcPayload(antiPlastic),
    })
    const data = await qcData(dir, projectId, result.artifact)
    // 原始 blocking 原样保留（审计可见），放行记录单列，便于质检页展示「本条经人工放行」。
    assert.deepEqual(data.antiPlastic.blocking, ['A：结尾出现升华句'], '原始 blocker 不应被静默删除')
    assert.equal(data.antiPlasticOverrides.length, 1, '放行记录应单列在 antiPlasticOverrides')
    assert.equal(data.antiPlasticOverrides[0].operator, '张三')
  })
})
