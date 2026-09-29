import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeScriptQuality,
  buildScriptGenerationSteps,
  buildScriptPrompt,
  checkLength,
  checkSpokenDelivery,
  checkStructure,
  compareSimilarity,
  DEFAULT_SCRIPT_TIER,
  normalizeDraft,
  normalizeTier,
  parseScriptGenerationInput,
  SCRIPT_DRAFT_SCHEMA,
  SCRIPT_LENGTH_TIERS,
  summarizeScriptInput,
} from '../spoken-video-script.mjs'

const MEDIUM_BODY = [
  '新教材全面铺开，家长最该搞清楚的不是课本本身，而是评估标准变了。很多家长还在用旧教辅给孩子加码，其实方向已经偏了。今天这条，把变化讲清楚，再给你能马上落地的动作。',
  '过去一年，各地陆续更换义务教育教材。很多家长的第一反应是慌：旧教辅还能不能用？预习资料还对不对？培训班讲的还是不是考点？这些问题背后，其实都是同一个担心，就是孩子花的功夫会不会白费。这种焦虑很真实，但先把情绪放一放，变化其实是有明确脉络的。',
  '其实变化主要发生在三个层面。第一是内容编排，知识点的前后顺序调整了，原来先学的概念挪到了后面，原来靠后的应用题提前出现。第二是能力要求，死记硬背的比重明显下降，应用与表达的比重上升，题目更愿意让孩子把知识用起来，而不是背下来。第三是评估方式，过程性评价开始进入总评，课堂表现、作业质量、实践任务都可能算进最终成绩。',
  '这意味着什么？意味着继续用旧教辅刷题的孩子，可能越刷越偏。旧教辅练的是记忆和套路，新教材考的是理解和迁移。方向不一致的时候，投入越多，反而越容易固化错误的习惯。家长真正要做的，不是急着买新资料，而是先拿到新教材的目录，和孩子一起过一遍每个单元的核心问题，搞清楚这学期到底要解决什么。',
  '具体怎么做？给三个可以马上落地的动作。一是把旧教辅和新目录对照一遍，明显对不上的章节先停掉，别让孩子在过时的题型上耗时间。二是每个单元开始前，先和孩子聊十分钟这个单元在解决什么问题，让他带着目的去学，而不是被动听课。三是每周留半小时复盘，只问孩子这周学的东西能用在什么场景里，答不上来就说明还停在记忆层，没有进入理解层。',
  '还有一个容易被忽略的点，就是孩子的表达。新教材更看重能不能把想法讲清楚，所以平时可以多让孩子用自己的话复述一遍当天学的内容。复述不出来的地方，往往就是没真正消化的地方，比再做十道题更有价值。',
  '最后再提醒一句，别把换教材理解成加负。很多家长一听变化就想给孩子报班加练，其实恰恰相反。新教材把死记硬背的部分砍掉了，就是希望孩子有时间去琢磨为什么。与其加码刷题，不如把省下来的时间用在提问和讨论上。方向对了，慢一点也没关系；方向错了，跑得越快偏得越远。',
  '如果这条对你有帮助，转给同样在用旧教辅的家长。下一期，我会把新教材每个单元的核心问题整理成一张对照表，拿到手就能用。教材变化不可怕，可怕的是还用旧地图找新大陆。',
  '如果你的孩子正在用旧资料复习，先停下来核对一遍目录。这一步花不了多少时间，却能避免整个学期的方向性浪费。教材换了，思路也要跟着换，这才是新学年最该做的第一件事。',
].join('\n\n')

test('normalizeTier maps aliases and falls back to the default', () => {
  assert.equal(normalizeTier('long'), 'long')
  assert.equal(normalizeTier('  short '), 'short')
  assert.equal(normalizeTier(undefined), DEFAULT_SCRIPT_TIER)
  assert.equal(normalizeTier('巨型'), DEFAULT_SCRIPT_TIER)
})

test('checkLength classifies tiers with soft tolerance and duration estimate', () => {
  const ok = checkLength(MEDIUM_BODY, 'medium')
  assert.equal(ok.status, 'ok')
  assert.equal(ok.lengthTier, 'medium')
  assert.equal(ok.rewriteRequired, false)
  assert.ok(ok.scriptChars >= SCRIPT_LENGTH_TIERS.medium.min, 'sample sits above medium floor')
  assert.ok(ok.estimatedDurationSeconds > ok.estimatedDurationRangeSeconds.fast)
  const tiny = checkLength('太短了。', 'medium')
  assert.equal(tiny.status, 'too_short')
  assert.equal(tiny.rewriteRequired, true)
  assert.ok(tiny.warnings.length > 0)
})

test('checkStructure reports paragraphs, average length and opening', () => {
  const structure = checkStructure(MEDIUM_BODY)
  assert.equal(structure.paragraphCount, 9)
  assert.ok(structure.averageParagraphLength > 20)
  assert.ok(structure.openingLength >= 12)
  assert.deepEqual(structure.warnings, [])
  const weak = checkStructure('短。\n短。')
  assert.ok(weak.warnings.includes('段落过少，口播稿建议至少 3 段推进'))
})

test('checkSpokenDelivery counts written-language signals without blocking', () => {
  const body = '这是第一、第二、第三、第四，不是A而是B，不是C而是D，不是E而是F。' + 'a'.repeat(0) + 'ABC DEF GHI JKL MNO'.toLowerCase()
  const diagnostic = checkSpokenDelivery('这个句子非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长，超过六十个字用来触发长句统计。')
  assert.equal(diagnostic.longSentenceCount, 1)
  assert.ok(diagnostic.advisories.some((item) => item.includes('超长句')))
  const numbered = checkSpokenDelivery(body)
  assert.ok(numbered.numberedMarkerCount >= 3)
})

test('compareSimilarity detects near-duplicate corpus entries', () => {
  const corpus = [
    { projectId: 'p1', title: '新教材全面铺开家长该知道什么', body: MEDIUM_BODY },
    { projectId: 'p2', title: '完全不相关的另一篇', body: '量子计算的工程化落地还需要很长时间，涉及纠错码、低温制冷与软件栈的多层协同。' },
  ]
  const similarity = compareSimilarity({ title: '新教材全面铺开家长该知道什么', body: MEDIUM_BODY }, corpus)
  assert.equal(similarity.comparedRecords, 2)
  assert.ok(similarity.titleSimilarity.max >= 0.8)
  assert.ok(similarity.ngramJaccard.max >= 0.5)
  assert.ok(similarity.longestCommonSubstring.maxLength > 100)
  assert.equal(similarity.topMatches[0].projectId, 'p1')
})

test('analyzeScriptQuality blocks nothing but caps score for duplicates', () => {
  const corpus = [{ projectId: 'p1', title: '新教材全面铺开家长该知道什么', body: MEDIUM_BODY }]
  const report = analyzeScriptQuality({ title: '新教材全面铺开家长该知道什么', body: MEDIUM_BODY, tier: 'medium', corpus })
  assert.equal(report.verdict, 'rewrite')
  assert.equal(report.originalityRisk, 'high')
  assert.ok(report.qualityScore <= 79, `duplicate must stay capped, got ${report.qualityScore}`)
  assert.ok(report.rewriteReasons.length > 0)
  assert.ok(report.recommendations.length > 0)
})

test('analyzeScriptQuality passes an original manuscript', () => {
  const corpus = [{ projectId: 'p1', title: '完全不相关的另一篇', body: '量子计算的工程化落地还需要很长时间。' }]
  const report = analyzeScriptQuality({ title: '新教材全面铺开，家长最该搞清楚的是什么', body: MEDIUM_BODY, tier: 'medium', corpus })
  assert.equal(report.verdict, 'pass')
  assert.equal(report.originalityRisk, 'low')
  assert.equal(report.rewriteRequired, false)
  assert.ok(report.qualityScore > 79, `original manuscript should pass, got ${report.qualityScore}`)
  assert.equal(report.scoreBreakdown.caps.length, 0)
})

test('analyzeScriptQuality flags out-of-range length via caps', () => {
  const report = analyzeScriptQuality({ title: '太短的稿子', body: '只有一句话。', tier: 'medium', corpus: [] })
  assert.equal(report.checks.length.status, 'too_short')
  assert.ok(report.scoreBreakdown.caps.some((cap) => cap.reason === '正文长度超出档位区间'))
})

test('parseScriptGenerationInput validates mode, tier and instructions', () => {
  const projectId = '19141371-91a0-4043-a3df-bc3add45676b'
  assert.deepEqual(parseScriptGenerationInput({ projectId }), { projectId, mode: 'new', tier: DEFAULT_SCRIPT_TIER, instructions: null })
  const polish = parseScriptGenerationInput({ projectId, mode: 'polish', tier: 'LONG', instructions: '更口语一点' })
  assert.deepEqual(polish, { projectId, mode: 'polish', tier: 'long', instructions: '更口语一点' })
  assert.throws(() => parseScriptGenerationInput({ projectId: 'nope' }), /项目标识无效/u)
  assert.throws(() => parseScriptGenerationInput({ projectId, mode: 'rewrite' }), /生成模式/u)
  assert.throws(() => parseScriptGenerationInput({ projectId, instructions: 'x'.repeat(501) }), /长度必须在 1-500/u)
})

test('buildScriptPrompt carries contract, discipline and material', () => {
  const input = { projectId: 'p', mode: 'new', tier: 'medium', instructions: null }
  const prompt = buildScriptPrompt({
    input,
    topic: { title: '新教材全面铺开', angle: '家长视角' },
    signals: [{ text: '教材更换新闻', source: '百度热榜' }],
    profile: { positioning: '教育垂类' },
  })
  assert.ok(prompt.includes('1000-2499'))
  assert.ok(prompt.includes('家长视角'))
  assert.ok(prompt.includes('教材更换新闻'))
  assert.ok(prompt.includes('百度热榜'))
  assert.ok(prompt.includes('教育垂类'))
  assert.ok(prompt.includes('不要编造'))
  const polish = buildScriptPrompt({
    input: { ...input, mode: 'polish' },
    topic: { title: '选题' },
    signals: [],
    profile: null,
    currentBody: '当前稿件正文。',
  })
  assert.ok(polish.includes('润色'))
  assert.ok(polish.includes('当前稿件正文'))
  assert.ok(polish.includes('信号素材：无'))
})

test('normalizeDraft trims fields and reports usability', () => {
  const structured = {
    title: '标题',
    script: '正文',
    outline: ['一', '', '  ', '二'],
    factCheckItems: ['核实项'],
    needsVerification: ['待定'],
    safetyNotes: 'not-a-list',
  }
  const result = normalizeDraft(structured)
  assert.equal(result.usable, true)
  assert.equal(result.draft.script, '正文')
  assert.deepEqual(result.draft.outline, ['一', '二'])
  assert.deepEqual(result.draft.safetyNotes, [])
  assert.equal(normalizeDraft(undefined).usable, false)
  assert.equal(normalizeDraft({ script: '   ' }).usable, false)
})

test('generation steps expose the five audited phases', () => {
  const steps = buildScriptGenerationSteps()
  assert.deepEqual(steps.map((step) => step.id), ['assemble', 'generate', 'normalize', 'quality', 'apply'])
  assert.ok(steps.every((step) => step.status === 'pending'))
})

test('draft schema stays an object-rooted supported subset', () => {
  assert.equal(SCRIPT_DRAFT_SCHEMA.type, 'object')
  assert.deepEqual(SCRIPT_DRAFT_SCHEMA.required, ['script'])
  assert.equal(SCRIPT_DRAFT_SCHEMA.properties.outline.items.type, 'string')
})

test('summarizeScriptInput describes mode, tier and basis', () => {
  const summary = summarizeScriptInput(
    { mode: 'new', tier: 'medium' },
    { artifacts: { signals: { data: { items: [{}, {}] } } } },
  )
  assert.equal(summary, '新起稿 · 中篇 · 2 条信号依据')
})
