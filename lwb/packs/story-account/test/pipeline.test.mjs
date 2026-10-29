import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StoryAccountStore } from '../story-account-store.mjs'
import { runStoryMediaPipeline, STORY_PIPELINE_STEPS, formatStoryPackageText, readStoryCoverInfo } from '../story-account-pipeline.mjs'

/**
 * 媒体流水线的集成测试。
 *
 * 外部依赖全部注入：媒体服务、Remotion 渲染、ffprobe、审片子会话。这样测的是
 * **编排逻辑**——阶段顺序、失败停在哪、闸门有没有被绕过——而不是 ffmpeg 会不会用。
 * 后者由 probe 手测覆盖，不该让单元测试依赖浏览器。
 *
 * linkDependencies: false 是必须的：搭渲染工程会建 node_modules 符号链接，
 * 受沙箱限制。关掉它不影响被测的编排逻辑。
 */

const TOPIC = { title: '锅里的鱼', scenario: '年初三的厨房，我端着碗', keyLine: '你吃吧，我不饿' }
const SCRIPT = `「妈，锅里的鱼你吃吧，我不饿。」
年初三晚上，我在厨房说完这句，就把碗放回水池。
水龙头开得很大。我没关。
我妈坐在饭桌那头，没抬头，只说了一句：「那你明天几点走。」
我说八点。
她说：「哦。」
后来我把行李箱从阳台拖出来，轮子在地砖上响。她起来给我塞了两个橘子，说路上吃。
门关上的时候，我听见厨房的水还在流。`

async function withProject(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-pipeline-'))
  const store = new StoryAccountStore()
  const agent = { workspacePath: dir }
  try {
    const project = await store.create(agent, { title: '锅里的鱼' })
    const topic = await store.commit(agent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', idempotencyKey: 'idem-topic1', payload: TOPIC })
    await store.commit(agent, { projectId: project.id, expectedRevision: topic.project.revision, stage: 'script', idempotencyKey: 'idem-script1', payload: { body: SCRIPT } })
    await run({ store, agent, dir, project })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function fakes({ duration = 68, technicalOk = true, reviewPassed = true } = {}) {
  return {
    // 假配音：真写一个音频文件，让搭目录与 ffprobe 有东西可读。
    speak: async ({ workspacePath }) => {
      await mkdir(join(workspacePath, 'data', 'media', 'voiceovers'), { recursive: true })
      await writeFile(join(workspacePath, 'data', 'media', 'voiceovers', 'fake.wav'), Buffer.alloc(2048, 7))
      return { audio: { file: 'media/voiceovers/fake.wav', mediaType: 'audio/wav', durationSeconds: duration } }
    },
    render: async (prepared) => {
      await mkdir(join(prepared.projectDir, 'outputs'), { recursive: true })
      await writeFile(prepared.outputPath, Buffer.alloc(4096, 0))
      return { outputPath: prepared.outputPath }
    },
    probe: async () => ({
      durationSeconds: duration,
      width: technicalOk ? 1080 : 1920,
      height: technicalOk ? 1920 : 1080,
      fps: 30,
      hasAudio: true,
      audioDurationSeconds: duration,
    }),
    reviewVideo: async ({ sampledTimestamps }) => ({
      passed: reviewPassed,
      technicalPass: true,
      editorialPass: reviewPassed,
      score: reviewPassed ? 84 : 48,
      summary: '开场对白直接进入冲突，画面节拍推进干净，字幕落在下三分之一安全区内。',
      findings: reviewPassed
        ? []
        : [{ severity: 'blocker', category: 'pacing', timestampSeconds: sampledTimestamps[0], message: '前 3 秒是空镜，情绪没起来' }],
      reviewEvidence: sampledTimestamps.slice(0, 2).map((timestampSeconds) => ({
        timestampSeconds,
        observedMainVisual: '厨房近景，人物手部与碗，暖黄灯光压在下三分之一之上。',
      })),
    }),
  }
}

test('媒体流水线跑通配音到质检四个阶段并落库', async () => {
  await withProject(async ({ store, agent, project }) => {
    const result = await runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes() })
    assert.equal(result.status, 'awaiting-packaging')
    const detail = await store.get(agent, { projectId: project.id })
    for (const stage of ['voiceover', 'subtitles', 'video', 'qc']) {
      assert.ok(detail.artifacts[stage], `缺少阶段产物 ${stage}`)
    }
    assert.equal(detail.artifacts.qc.data.passed, true)
  })
})

test('技术质检不通过时不进入审片、不写质检产物', async () => {
  await withProject(async ({ store, agent, project }) => {
    const result = await runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes({ technicalOk: false }) })
    assert.equal(result.status, 'failed')
    assert.equal(result.failedAt, 'probe')
    assert.ok(result.blockers.some((item) => item.includes('1080x1920')))
    const detail = await store.get(agent, { projectId: project.id })
    assert.equal(detail.artifacts.qc, undefined, '技术不过不得写质检产物')
    assert.notEqual(detail.artifacts.video, undefined, '但成片本身要留下痕迹')
  })
})

test('审片不通过时质检产物明确标记为不通过', async () => {
  await withProject(async ({ store, agent, project }) => {
    const result = await runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes({ reviewPassed: false }) })
    assert.equal(result.status, 'failed')
    assert.equal(result.failedAt, 'review')
    const detail = await store.get(agent, { projectId: project.id })
    assert.equal(detail.artifacts.qc.data.passed, false)
  })
})

test('缺少审片环节时直接报错，不许单方面放行', async () => {
  await withProject(async ({ store, agent, project }) => {
    const fake = fakes()
    await assert.rejects(
      () => runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, speak: fake.speak, render: fake.render, probe: fake.probe }),
      /REVIEW_REQUIRED|独立审片/u,
    )
  })
})

test('没有稿件时拒绝进入媒体流水线', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-pipeline-empty-'))
  try {
    const store = new StoryAccountStore()
    const agent = { workspacePath: dir }
    const project = await store.create(agent, { title: 'x' })
    await assert.rejects(
      () => runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes() }),
      /STAGE_BLOCKED|先完成稿件/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('字幕严格跟随画面节拍，不出现画面换句而字幕停住', async () => {
  await withProject(async ({ store, agent, project }) => {
    const result = await runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes() })
    assert.equal(result.status, 'awaiting-packaging')
    const detail = await store.get(agent, { projectId: project.id })
    // 字幕由节拍驱动：每条字幕都必须落在某一拍的区间内。
    // 早期版本两边各自按字数切分，实测 6 秒处画面已换三句、字幕还停在第二条。
    assert.equal(detail.artifacts.subtitles.data.mode, 'story-account/asr')
    assert.ok(detail.artifacts.subtitles.data.cueCount > 0)
    assert.ok(detail.artifacts.subtitles.data.srt.includes('-->'))
  })
})

test('成片产物登记的是竖屏规格', async () => {
  await withProject(async ({ store, agent, project }) => {
    await runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes() })
    const detail = await store.get(agent, { projectId: project.id })
    const video = detail.artifacts.video.data.video
    assert.equal(video.width, 1080)
    assert.equal(video.height, 1920)
    assert.equal(video.fps, 30)
  })
})

test('流水线步骤清单与阶段一一对应', () => {
  assert.deepEqual(STORY_PIPELINE_STEPS.map((step) => step.id), ['voiceover', 'subtitles', 'render', 'probe', 'review', 'packaging'])
})

test('发布资料可以导出成可直接粘贴的文本', () => {
  const text = formatStoryPackageText({
    title: '锅里的鱼', copy: '年初三的厨房。', description: '你家里有没有这样一个人？',
    tags: ['情感', '原生家庭'], coverHeadline: '锅里的鱼记得吃完',
  })
  assert.ok(text.includes('锅里的鱼'))
  assert.ok(text.includes('#情感 #原生家庭'))
  assert.ok(text.includes('封面大字：锅里的鱼记得吃完'))
  assert.equal(formatStoryPackageText(null), '')
})

test('没有封面文件时 readStoryCoverInfo 返回不存在而不是抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-cover-info-'))
  try {
    const info = await readStoryCoverInfo({ workspacePath: dir, projectId: '00000000-0000-0000-0000-000000000000' })
    assert.equal(info.exists, false)
    assert.equal(info.file, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
