import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '../../../../vendor/deepseek-harness/packages/core/tools/lib/index.js'
import { scenePacingFindings } from '../spoken-video-scene-table.mjs'
import {
  buildVideoCreatorContinuationPrompt,
  buildVideoCreatorPrompt,
  buildVideoCreatorRepairPrompt,
  buildVideoEditorialRepairPrompt,
  buildVideoReviewerPrompt,
  normalizeVideoReview,
  subtitleSamplesAt,
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

/**
 * 审片必须用 read_image 直接看图，并禁止自制图像分析脚本。
 *
 * 2026-10-26 从会话事件流挖出的失控根因：审片模型有很强的 shell 偏好，
 * 提示词不指定工具时它会写 node 脚本把 PNG 转成 ASCII 字符画来「读」画面。
 * 实测失控会话写了 9 个自制脚本、跑 176 次 pwsh、只用 1 次 read_image，
 * 工具结果 271 万字符，触发 51 次上下文裁剪，单轮审片 82 分钟；
 * 正常会话则是 13 次 read_image、17 次调用、33k 字符。
 * 这条契约是那 84% 无效 token 的直接防线，不能被后续改文案时悄悄删掉。
 */
test('审片提示词强制 read_image 看图，并禁止自制图像解析脚本', () => {
  const prompt = buildVideoReviewerPrompt({
    runDir: '/tmp/video-agent/run-1',
    technicalReportFile: '/tmp/video-agent/run-1/outputs/technical-qc.json',
    frameFiles: ['/tmp/video-agent/run-1/outputs/frame-1.png'],
    timestamps: [0.5],
  })
  // 必须点名工具，而不只是说「查看图片」。
  assert.match(prompt, /必须用 read_image 工具/u)
  assert.match(prompt, /唯一能真正看到画面/u)
  // 必须明确禁止那条已知失控路径。
  assert.match(prompt, /禁止用 pwsh\/shell 处理图片/u)
  assert.match(prompt, /ASCII 字符画/u)
  assert.match(prompt, /色彩网格/u)
  assert.match(prompt, /失控/u)
  // 只允许读那几个输入文件，产出只有 structured_output。
  assert.match(prompt, /不要执行 shell 命令/u)
  assert.match(prompt, /不要新建临时脚本/u)
  assert.match(prompt, /只有最后那一次 structured_output 提交/u)
})

// ── 审片拿到的「此刻在念什么」必须是确定性事实 ───────────────────────────────
//
// 2026-10-27 实测事故：审片只拿到整篇稿件（无时间戳），于是自己估算
// 「38.27 秒大概在念稿件的哪一段」，断言那句在讲「铰链正上方」——
// 而该时刻的真实字幕是「不是官方通报，也不是实验室报告」。
// 这个假缺陷被判 major，触发一轮定向修复，整轮渲染+修复白跑。
// 字幕时间轴和帧率、时长一样是确定性事实，必须由代码算好交给模型。

test('subtitleSamplesAt 按时间轴取到该时刻正在念的那句', () => {
  const cues = [
    { startMs: 0, endMs: 2000, text: '第一句。' },
    { startMs: 2000, endMs: 5000, text: '第二句。' },
    { startMs: 6000, endMs: 8000, text: '第三句。' },
  ]
  const [a, b, gap, tail] = subtitleSamplesAt(cues, [1.2, 3.5, 5.5, 9])
  assert.equal(a.text, '第一句。')
  assert.equal(b.text, '第二句。')
  // 落在两句之间的停顿：给刚念完的上一句，并标记 previous。
  assert.equal(gap.text, '第二句。')
  assert.equal(gap.previous, true)
  // 片尾之后：仍然给最后一句并标记 previous，不凭空造句。
  assert.equal(tail.text, '第三句。')
  assert.equal(tail.previous, true)
})

test('审片提示词带上每个采样时刻的真实字幕，并禁止用稿件顺序推算', () => {
  const prompt = buildVideoReviewerPrompt({
    runDir: '/tmp/run',
    technicalReportFile: 'outputs/technical-qc.json',
    frameFiles: ['f1.png'],
    timestamps: [38.27],
    subtitleSamples: [{ timestampSeconds: 38.27, text: '不是官方通报，也不是实验室报告。' }],
  })
  assert.match(prompt, /每个采样时刻正在念的字幕/u, '必须把字幕事实交给审片')
  assert.match(prompt, /38\.27 秒：「不是官方通报，也不是实验室报告。」/u, '采样时刻与字幕文本要成对出现')
  assert.match(prompt, /不得用 inputs\/draft\.json 的段落顺序去推算/u, '必须禁止按稿件顺序猜时间')
})

test('导演提示词把横屏铺满宽度写成可检查的硬约束', () => {
  const prompt = buildVideoCreatorPrompt({ runDir: '/tmp/run' })
  assert.match(prompt, /左右边界各不超过画面宽度的 8%/u, '横屏留白要有量化上限')
  assert.match(prompt, /禁止把内容挤在左半边/u, '要直接点出被反复否决的具体形态')
})

// ── 场景节奏守卫 ────────────────────────────────────────────────────────────
//
// 阈值来自 41 条历史成片：单幕>30s 的 4 条里 3 条被审片否决（73/58/78 分）；
// 平均幕长 45.7s 那条是全库最低分。守卫在渲染前打回，走 creator repair 通道，
// 代价一次 LLM 往返——比渲染后被否决再进修复轮省 15–35 分钟。

test('scenePacingFindings 抓住单幕超长、整体拖沓与尾段失衡', () => {
  // 正常节奏：6–12s 均匀分布 → 无发现
  const healthy = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, start: i * 10, end: (i + 1) * 10 }))
  assert.deepEqual(scenePacingFindings(healthy), [])
  // 单幕超长：一条 38s 的幕（211s/38.2s 那条实测被否决）
  const withLong = [...healthy.slice(0, 10), { id: 's-long', start: 100, end: 138.2 }, ...healthy.slice(10).map((s) => ({ ...s, start: s.start + 38, end: s.end + 38 }))]
  const findings = scenePacingFindings(withLong)
  assert.ok(findings.some((text) => /38\.2 秒/.test(text)), '要点名超长那幕与秒数')
  assert.ok(findings.every((text) => /subtitles\.srt|校准/.test(text) || /SCENES/.test(text) || /拆/.test(text)), '发现必须可执行')
  // 整体拖沓：平均 45.7s（全库最低分那条的形态）
  const bloated = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, start: i * 45.7, end: (i + 1) * 45.7 }))
  assert.ok(scenePacingFindings(bloated).some((text) => /平均幕长 45\.7 秒/.test(text)))
  // 尾段拖沓：末 1/3 是开头 1/3 的 3 倍且超过 15s
  const tailDrag = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, start: i * 10, end: (i + 1) * 10 })).map((s, i) => i >= 6 ? { ...s, start: 60 + (i - 6) * 36, end: 60 + (i - 5) * 36 } : s)
  assert.ok(scenePacingFindings(tailDrag).some((text) => /前紧后松/.test(text)))
  // 健康的密集短幕不能误伤：58 幕 / 每幕 10s（622s/58 幕那条拿了 85 分）
  assert.deepEqual(scenePacingFindings(Array.from({ length: 58 }, (_, i) => ({ id: `s${i}`, start: i * 10.7, end: (i + 1) * 10.7 }))), [])
})

test('修复提示词要求节奏/版式类问题改 SCENES 表，并带上审片点名帧', () => {
  const editorial = buildVideoEditorialRepairPrompt({
    runDir: '/tmp/run', review: { score: 61, findings: [{ severity: 'major', timestampSeconds: 294.9, message: '柱图与字幕错位' }], reviewEvidence: [] },
    frameFiles: ['a.png'], timestamps: [295], findingFrames: { timestamps: [294.9], frameFiles: ['findings/finding-01.png'] },
    attempt: 1, maximum: 2,
  })
  assert.match(editorial, /审片点名时间点的精确帧/u, '要带上 findings 时间点的证据帧')
  assert.match(editorial, /294\.9 秒：.*finding-01\.png/u, '证据帧与时间点成对出现')
  assert.match(editorial, /必须直接调整 SCENES 表/u, '节奏类问题必须指向场景表')

  const creator = buildVideoCreatorRepairPrompt({
    runDir: '/tmp/run', attempt: 1, maximum: 2,
    report: { failures: ['scene-pacing: 第 3 幕（s03）长 38.2 秒，超过 30 秒上限。'], findings: [], passed: false, creativeBytes: 100 },
  })
  assert.match(creator, /scene-pacing/u, '守卫失败清单要原样进修复提示词')
  assert.match(creator, /必须通过调整 SCENES 表解决/u)
})

test('creator prompt carries the expanded sound kit and the motion grammar it can copy', () => {
  // 2026-11-01：音效从 3 枚扩到 10 枚、密度改成按分钟计，并要求场景过渡与入场分层。
  // 这些内容只活在提示词里——一旦被改掉，Agent 会静默退回「三枚音效 + 整幕淡入」，
  // 而产物本身不会报错。所以逐项钉死。
  const prompt = buildVideoCreatorPrompt({ runDir: '/tmp/video-agent/run-2' })
  for (const name of ['whoosh', 'pop', 'ding', 'riser', 'impact', 'tick', 'swoosh-up', 'paper', 'blip', 'swell']) {
    assert.match(prompt, new RegExp(`sfx/${name}\.wav|${name}\.wav`, 'u'), `提示词必须介绍 ${name}.wav`)
  }
  assert.match(prompt, /每分钟 6–10 处/u, '音效密度必须按分钟给，而不是全片封顶 12 处')
  assert.match(prompt, /motion-grammar\.tsx/u, '必须告诉 Agent 去哪复制过渡/入场基元')
  assert.match(prompt, /SceneBridge/u)
  assert.match(prompt, /Stagger/u)
  assert.match(prompt, /整屏淡入/u, '必须显式禁止整幕整体淡入')
})

test('creator prompt tells the director the narration is already loudness-normalised', () => {
  // 旁白从 -21.4 归一化到 -14 LUFS 之后，音效的相对关系变了：
  // 旧提示词里的 0.3–0.4 会偏弱、0.6–0.8 又会与语音抢。这条规则必须跟着响度改动一起走。
  const prompt = buildVideoCreatorPrompt({ runDir: '/tmp/video-agent/run-3' })
  assert.match(prompt, /旁白响度已经归一化/u)
  assert.match(prompt, /-14 LUFS/u)
  assert.match(prompt, /0\.35–0\.5/u, '普通音效音量带必须与归一化后的旁白匹配')
})
