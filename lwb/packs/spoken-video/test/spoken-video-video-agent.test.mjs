import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '../../../../vendor/deepseek-harness/packages/core/tools/lib/index.js'
import {
  buildVideoCreatorContinuationPrompt,
  buildVideoCreatorPrompt,
  buildVideoEditorialRepairPrompt,
  buildVideoReviewerPrompt,
  normalizeVideoReview,
  VIDEO_REVIEW_SCHEMA,
} from '../spoken-video-video-agent.mjs'

test('creator prompt assigns direct Remotion ownership without API keys or fallback output', () => {
  const prompt = buildVideoCreatorPrompt({ runDir: '/tmp/video-agent/run-1' })
  assert.match(prompt, /直接完成可渲染的 Remotion 创意工程/u)
  assert.match(prompt, /只允许修改 src\/CreativeVideo\.tsx/u)
  assert.match(prompt, /不得修改 Root\.tsx/u)
  assert.match(prompt, /可选 BGM 混音由受保护外壳负责/u)
  assert.match(prompt, /不依赖.*额外 API Key/u)
  assert.match(prompt, /必须尽快调用文件工具/u)
  assert.match(prompt, /工作进度以文件为准/u)
  assert.match(prompt, /至少检查开头、中段、结尾三个代表帧/u)
  assert.match(prompt, /不同语义段没有退化为同一套卡片版式/u)
  assert.match(prompt, /不要改换其他启动方式重试/u)
  assert.match(prompt, /不要自建替代渲染或预览工具/u)
  assert.doesNotMatch(prompt, /HyperFrames/u)
  assert.doesNotMatch(prompt, /降级|fallback/iu)
})

test('editorial repair prompt stops retrying a sandbox-denied render instead of rebuilding a preview path', () => {
  const prompt = buildVideoEditorialRepairPrompt({
    runDir: '/tmp/video-agent/run-1',
    attempt: 1,
    maximum: 2,
    frameFiles: ['/tmp/video-agent/run-1/outputs/frame-1.png'],
    timestamps: [12.5],
    review: { score: 62, summary: '主体集中在上半部。', findings: [], reviewEvidence: [] },
  })
  assert.match(prompt, /不要改换启动方式重试/u)
  assert.match(prompt, /不要自建替代渲染或预览工具/u)
})

test('creator continuation prompt resumes the existing file instead of restarting analysis', () => {
  const prompt = buildVideoCreatorContinuationPrompt({ attempt: 1, maximum: 2 })
  assert.match(prompt, /同一视频创作会话/u)
  assert.match(prompt, /1\/2/u)
  assert.match(prompt, /不要重新读取全部资料/u)
  assert.match(prompt, /检查 src\/CreativeVideo\.tsx/u)
  assert.match(prompt, /立即从现有进度继续写入/u)
})

test('editorial repair prompt is evidence-bound and keeps the protected shell intact', () => {
  const prompt = buildVideoEditorialRepairPrompt({
    runDir: '/tmp/video-agent/run-1',
    attempt: 1,
    maximum: 2,
    frameFiles: ['/tmp/video-agent/run-1/outputs/frame-1.png'],
    timestamps: [12.5],
    review: {
      score: 62,
      summary: '主体集中在上半部，重复使用同一种卡片版式。',
      findings: [{ severity: 'major', category: 'composition', timestampSeconds: 12.5, message: '下半部大面积空白。' }],
      reviewEvidence: [{ timestampSeconds: 12.5, observedMainVisual: '标题和卡片全部压在画面顶部。' }],
    },
  })
  assert.match(prompt, /定向视觉修复（1\/2）/u)
  assert.match(prompt, /12\.5 秒/u)
  assert.match(prompt, /下半部大面积空白/u)
  assert.match(prompt, /只允许修改 src\/CreativeVideo\.tsx/u)
  assert.match(prompt, /不得修改字幕/u)
  assert.match(prompt, /不要删除有问题的内容/u)
  assert.match(prompt, /不要自行渲染完整成片/u)
})

test('reviewer prompt is independent, evidence-bound, and read-only', () => {
  const prompt = buildVideoReviewerPrompt({
    runDir: '/tmp/video-agent/run-1',
    technicalReportFile: '/tmp/video-agent/run-1/outputs/technical-qc.json',
    frameFiles: ['/tmp/video-agent/run-1/outputs/frame-1.png', '/tmp/video-agent/run-1/outputs/frame-2.png'],
    timestamps: [0.5, 4.5],
  })
  assert.match(prompt, /相互独立/u)
  assert.match(prompt, /不得修改任何文件/u)
  assert.match(prompt, /0\.5 秒/u)
  assert.match(prompt, /4\.5 秒/u)
  assert.match(prompt, /有界定向修复/u)
  assert.doesNotThrow(() => assertObjectJsonSchema(VIDEO_REVIEW_SCHEMA))
})

test('normalizes review evidence to sampled frames and enforces every release gate', () => {
  const accepted = normalizeVideoReview({
    passed: true,
    technicalPass: true,
    editorialPass: true,
    score: 82,
    summary: '画面与稿件一致。',
    findings: [{ severity: 'minor', category: 'pacing', timestampSeconds: 5, message: '中段可稍快。' }],
    reviewEvidence: [
      { timestampSeconds: 0.4, observedMainVisual: '开场展示主题对象和清晰的问题关系。' },
      { timestampSeconds: 9.7, observedMainVisual: '结尾展示趋势收束和明确的行动结论。' },
    ],
  }, { technicalPassed: true, sampledTimestamps: [0.5, 5, 10] })
  assert.equal(accepted.passed, true)
  assert.deepEqual(accepted.reviewEvidence.map((item) => item.timestampSeconds), [0.5, 10])

  assert.equal(normalizeVideoReview({ ...accepted, passed: true, technicalPass: true, editorialPass: true }, { technicalPassed: false, sampledTimestamps: [0.5, 10] }).passed, false)
  assert.equal(normalizeVideoReview({ ...accepted, passed: true, technicalPass: true, editorialPass: true, score: 69 }, { technicalPassed: true, sampledTimestamps: [0.5, 10] }).passed, false)
  assert.equal(normalizeVideoReview({ ...accepted, passed: true, technicalPass: true, editorialPass: true, score: 101 }, { technicalPassed: true, sampledTimestamps: [0.5, 10] }).passed, false)
  assert.equal(normalizeVideoReview({ ...accepted, passed: true, technicalPass: true, editorialPass: true, findings: [{ severity: 'major', category: 'composition', message: '主体构图不可用。' }] }, { technicalPassed: true, sampledTimestamps: [0.5, 10] }).passed, false)
  const invalidTimestamp = normalizeVideoReview({
    ...accepted,
    passed: true,
    technicalPass: true,
    editorialPass: true,
    reviewEvidence: [
      { timestampSeconds: -1, observedMainVisual: '负数时间点不能作为有效的抽帧审核证据。' },
      { timestampSeconds: 10, observedMainVisual: '结尾展示趋势收束和明确的行动结论。' },
    ],
  }, { technicalPassed: true, sampledTimestamps: [0.5, 10] })
  assert.equal(invalidTimestamp.passed, false)
  assert.equal(invalidTimestamp.reviewEvidence.length, 1)
})
