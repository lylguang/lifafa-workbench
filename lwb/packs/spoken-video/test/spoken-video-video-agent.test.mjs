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
  assert.doesNotMatch(prompt, /contact-sheet/u)
})

test('editorial repair prompt carries the contact sheet so repairs see the whole-film rhythm', () => {
  const prompt = buildVideoEditorialRepairPrompt({
    runDir: '/tmp/video-agent/run-1',
    attempt: 1,
    maximum: 2,
    frameFiles: ['/tmp/video-agent/run-1/outputs/frame-1.png'],
    timestamps: [12.5],
    contactSheetFile: '/tmp/video-agent/run-1/outputs/review-frames/attempt-1/contact-sheet.png',
    review: { score: 62, summary: '节奏前紧后松。', findings: [], reviewEvidence: [] },
  })
  assert.match(prompt, /接触表/u)
  assert.match(prompt, /contact-sheet\.png/u)
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
  // 无接触表时允许出现通用指引（"若有接触表"），但不得给出任何具体接触表路径。
  assert.doesNotMatch(prompt, /contact-sheet/u)
  assert.doesNotThrow(() => assertObjectJsonSchema(VIDEO_REVIEW_SCHEMA))
})

test('reviewer prompt includes the contact sheet for pacing overview and points back to full frames', () => {
  const prompt = buildVideoReviewerPrompt({
    runDir: '/tmp/video-agent/run-1',
    technicalReportFile: '/tmp/video-agent/run-1/outputs/technical-qc.json',
    frameFiles: ['/tmp/video-agent/run-1/outputs/frame-1.png'],
    timestamps: [0.5],
    contactSheetFile: '/tmp/video-agent/run-1/outputs/review-frames/attempt-1/contact-sheet.png',
  })
  assert.match(prompt, /接触表/u)
  assert.match(prompt, /4 列网格/u)
  assert.match(prompt, /只用于发现整体节奏与版式重复问题/u)
  assert.match(prompt, /精确判断仍以下面的逐帧图片为准/u)
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

// 2026-10-10 加：审片要靠机器解析 SCENES 表才能把抽帧对齐到场景稳定期，而解析器只认
// 一种写法。这两条把「格式要求」和「审片不再有入场动画免责」钉住——提示词里的这两段
// 是解析率能达到 100% 的前提，改丢了覆盖率就悄悄退回 22%。
test('creator prompt pins the SCENES table to the one shape the sampler can parse', () => {
  const prompt = buildVideoCreatorPrompt({ runDir: '/tmp/video-agent/run-1' })
  // 必须给出可照抄的样例，含 id/start/end 三个字段，且明说单位是秒。
  assert.match(prompt, /\{\s*id:\s*"s01-hook",\s*start:\s*3\.34,\s*end:\s*38\.86\s*\}/u)
  assert.match(prompt, /秒的小数/u, '必须说明 start/end 的单位是秒，否则模型会写帧数')
  // 这四种写法解析器读不出来，必须逐个点名禁止。
  assert.match(prompt, /不要引入 `dur`|`dur`\/`duration` 代替 `end`/u, '必须禁止用 dur 代替 end')
  assert.match(prompt, /不要用 `name` 代替 `id`/u, '必须禁止用 name 代替 id')
  assert.match(prompt, /展开运算符/u, '必须禁止 ...SC.s1 这类展开写法')
  assert.match(prompt, /start:\s*F\(3\.34\)/u, '必须点名禁止 start: F(x) 这种表达式')
})

test('creator prompt tells the director that review samples the scene midpoint', () => {
  const prompt = buildVideoCreatorPrompt({ runDir: '/tmp/video-agent/run-1' })
  // 抽帧现在取场景 60% 处，入场动画必须在那之前走完——这条是审片能过的前提。
  assert.match(prompt, /60% 时刻/u)
  assert.match(prompt, /前 40% 内完成/u)
  // 旧的「20%、35% 两个时刻自检」与「前 1/3」已经和 60% 对不上，必须换掉而不是并存。
  assert.doesNotMatch(prompt, /20%、35%/u, '旧的自检时刻与现在的 60% 冲突，留着会让模型困惑')
  assert.doesNotMatch(prompt, /前 1\/3 内完成/u, '旧的前 1/3 与前 40% 冲突')
})

test('reviewer prompt no longer excuses empty frames as entrance animation', () => {
  // 抽帧已对齐场景 60%，「可能是入场动画、请勿当缺陷」这条免责会让审片放过真实缺陷。
  const prompt = buildVideoReviewerPrompt({
    runDir: '/tmp/run', technicalReportFile: '/tmp/qc.json',
    frameFiles: ['/tmp/a.png'], timestamps: [10], contactSheetFile: '/tmp/sheet.png',
  })
  assert.doesNotMatch(prompt, /属于入场节奏问题而非内容缺失/u, '旧的入场动画免责必须删除')
  assert.match(prompt, /不要归因为"入场动画未完成"/u, '要明确告诉审片：60% 时刻还空就是真缺陷')
  // 接触表仍是均匀采样、仍可能落在动画期，保留这条局限说明。
  assert.match(prompt, /可能落在场景的入场动画期/u)
  assert.match(prompt, /不要只凭接触表下结论/u)
})
