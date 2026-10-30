import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { StoryAccountStore } from '../story-account-store.mjs'
import { runStoryMediaPipeline } from '../story-account-pipeline.mjs'
import { runIndependentReview } from '../story-account-qc.mjs'
import { StoryAccountContent } from '../story-account-content.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CONTENT_SRC = readFileSync(join(here, '..', 'story-account-content.mjs'), 'utf8')

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
  const dir = await mkdtemp(join(tmpdir(), 'story-review-'))
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

// 假外部服务：真写音频/成片文件，让目录结构与 ffprobe 有东西可读；配音/渲染/质检都不动真浏览器。
function fakes(reviewVideo) {
  return {
    speak: async ({ workspacePath }) => {
      await mkdir(join(workspacePath, 'data', 'media', 'voiceovers'), { recursive: true })
      await writeFile(join(workspacePath, 'data', 'media', 'voiceovers', 'fake.wav'), Buffer.alloc(2048, 7))
      return { audio: { file: 'media/voiceovers/fake.wav', mediaType: 'audio/wav', durationSeconds: 68 } }
    },
    render: async (prepared) => {
      await mkdir(join(prepared.projectDir, 'outputs'), { recursive: true })
      await writeFile(prepared.outputPath, Buffer.alloc(4096, 0))
      return { outputPath: prepared.outputPath }
    },
    probe: async () => ({ durationSeconds: 68, width: 1080, height: 1920, fps: 30, hasAudio: true, audioDurationSeconds: 68 }),
    reviewVideo,
  }
}

/* ------------------------- A. 防回归：不裸传私有方法 ------------------------- */

// 独立审片的私有方法 #reviewVideo 必须作为「绑定好的闭包」传出，不能裸传。
// 裸传会让流水线无接收者调用它 → this 为 undefined → 内部 this.reviewExecutor
// 抛「Cannot read properties of undefined」→ 独立审片这一步必崩（双闸门实际只剩一闸）。
test('story-account-content 不把私有方法当裸值传出（独立审片 this 绑定）', () => {
  // 通配：任何 `: this.#<私有>` 作为属性值（而非 `this.#x(...)` 调用）都不允许。
  assert.equal(
    /:\s*this\.#[A-Za-z_]\w*\s*[,}\n]/.test(CONTENT_SRC),
    false,
    '存在把私有方法作为裸值传出的写法，会丢失 this 绑定导致独立审片崩溃',
  )
  // 具体到本缺陷：reviewVideo 必须传 (request) => this.#reviewVideo(request)，不能裸传。
  assert.equal(
    /reviewVideo:\s*this\.#reviewVideo\b/.test(CONTENT_SRC),
    false,
    'reviewVideo 不能裸传 this.#reviewVideo，必须传绑定好的闭包',
  )
})

/* ------------------- B. 独立审片步骤被调用且参数正确 ------------------- */

test('独立审片步骤被流水线调用，且拿到 videoFile / sampledTimestamps / technicalReportFile', async () => {
  const calls = []
  const reviewVideo = async (request) => {
    calls.push(request)
    return {
      passed: true,
      technicalPass: true,
      editorialPass: true,
      score: 88,
      summary: '开场对白直接进入冲突，画面节拍推进干净。',
      findings: [],
      reviewEvidence: request.sampledTimestamps.slice(0, 2).map((timestampSeconds) => ({ timestampSeconds, observedMainVisual: '厨房近景，暖黄灯光压在下三分之一之上' })),
    }
  }
  await withProject(async ({ store, agent, project }) => {
    const result = await runStoryMediaPipeline({ store, agent, projectId: project.id, linkDependencies: false, ...fakes(reviewVideo) })
    assert.equal(calls.length, 1, '独立审片应当被调用恰好一次')
    const req = calls[0]
    assert.ok(typeof req.videoFile === 'string' && req.videoFile.length > 0, 'videoFile 应是成片相对路径')
    assert.ok(
      Array.isArray(req.sampledTimestamps) && req.sampledTimestamps.length >= 1 && req.sampledTimestamps.every(Number.isFinite),
      'sampledTimestamps 应是采样时间点数组',
    )
    assert.ok(typeof req.technicalReportFile === 'string' && /-technical\.json$/.test(req.technicalReportFile), 'technicalReportFile 应是技术质检报告路径')
    const detail = await store.get(agent, { projectId: project.id })
    assert.ok(typeof detail.artifacts.qc?.data?.reviewFile === 'string' && /-review\.json$/.test(detail.artifacts.qc.data.reviewFile), '应写出 -review.json 审片报告')
    void result
  })
})

/* --------------- C. 绑定机制：裸传丢 this（复现崩溃）/ 闭包绑定正常 --------------- */

// 复现并锁死缺陷机制：私有方法裸传 vs 绑定闭包。ffmpeg 无关的纯 this 绑定验证，
// 也是「把绑定改坏测试必须红」的翻红依据。
test('独立审片绑定：裸传私有方法会丢 this（复现崩溃），闭包绑定则正常', async () => {
  class Harness {
    #reviewVideo(request) {
      if (!this.reviewExecutor) throw new Error('no executor')
      return this.reviewExecutor(request)
    }
    passBare() { return this.#reviewVideo } // 复刻旧写法：裸传私有方法
    passClosure() { return (request) => this.#reviewVideo(request) } // 复刻修复写法：绑定闭包
    async invoke(fn) { return fn({ videoFile: 'media/videos/x.mp4' }) }
  }
  const h = new Harness()
  h.reviewExecutor = async (request) => ({ ok: true, request })

  // 裸传：流水线无接收者调用 → this 为 undefined → 内部 this.reviewExecutor 抛错。
  await assert.rejects(
    () => h.invoke(h.passBare()),
    /Cannot read properties of undefined \(reading 'reviewExecutor'\)/,
    '裸传私有方法应复现「Cannot read properties of undefined (reading \'reviewExecutor\')」',
  )
  // 闭包绑定：this 保留 → 正常走到执行器。
  const out = await h.invoke(h.passClosure())
  assert.equal(out.ok, true)
})

/* -------- D. 抽不到抽帧画面时审片判不通过，不静默放行 -------- */

test('独立审片抽不到抽帧画面时直接判不通过，不调用审片执行器', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-review-frames-'))
  try {
    let executorCalled = false
    const reviewExecutor = async () => {
      executorCalled = true
      return { passed: true, technicalPass: true, editorialPass: true, score: 90, summary: 't', findings: [], reviewEvidence: [] }
    }
    // sampledTimestamps 为空 → extractReviewFrames 抽不到任何帧 → 闸门按不通过处理。
    const result = await runIndependentReview({ reviewExecutor, workspacePath: dir, videoFile: 'media/videos/x.mp4', sampledTimestamps: [], durationSeconds: 10 })
    assert.equal(result.passed, false, '抽不到帧必须判不通过')
    assert.equal(executorCalled, false, '抽不到帧时不应调用审片执行器（不能静默放行）')
    assert.ok(result.findings.some((f) => /抽帧画面/.test(f.message)), '不通过结论应写明缺少抽帧证据')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
