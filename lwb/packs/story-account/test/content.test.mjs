import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProfile, parseCompletionInput, normalizeCompletion, parseAccountSnapshot, profileLines, hasProfile, emptyProfile, DEFAULT_AUDIENCE } from '../story-account-profile.mjs'
import { parseMaterial, normalizeMaterialFile, assembleMaterial } from '../story-account-materials.mjs'
import { parseTopicInput, normalizeCandidates, buildTopicPrompt } from '../story-account-topic.mjs'
import { normalizeDraft, analyzeScriptQuality, parseScriptGenerationInput, normalizeTier } from '../story-account-script.mjs'
import { StoryAccountContent } from '../story-account-content.mjs'
import { storyAccountDataPath } from '../story-account-paths.mjs'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('parseProfile 默认受众锁定 30-40 岁女性', () => {
  assert.equal(parseProfile({}).audience, DEFAULT_AUDIENCE)
  assert.equal(emptyProfile().audience, DEFAULT_AUDIENCE)
})

test('parseProfile 拒绝未知题材', () => {
  assert.throws(() => parseProfile({ themes: ['vampire'] }), /未知题材/u)
})

test('parseProfile 去重并保留顺序', () => {
  const profile = parseProfile({ themes: ['marriage', 'midlife', 'marriage'] })
  assert.deepEqual(profile.themes, ['marriage', 'midlife'])
})

test('hasProfile 对空表单返回 false', () => {
  assert.equal(hasProfile(emptyProfile()), false)
  assert.equal(hasProfile(parseProfile({ name: '晚风里的故事' })), true)
})

test('parseAccountSnapshot 校验标识与版本', () => {
  const snapshot = parseAccountSnapshot({ id: '11111111-1111-1111-1111-111111111111', revision: 2, name: 'x', themes: ['marriage'] })
  assert.equal(snapshot.revision, 2)
  assert.deepEqual(snapshot.themes, ['marriage'])
  assert.throws(() => parseAccountSnapshot({ id: 'bad', revision: 1 }), /标识无效/u)
  assert.throws(() => parseAccountSnapshot({ id: '11111111-1111-1111-1111-111111111111', revision: 0 }), /版本无效/u)
})

test('profileLines 空定位返回 null', () => {
  assert.equal(profileLines(emptyProfile()), null)
  const lines = profileLines(parseProfile({ name: '晚风里的故事', themes: ['marriage'] }))
  assert.ok(lines.some((line) => line.includes('晚风里的故事')))
  assert.ok(lines.some((line) => line.includes('婚姻与离婚') === false))
})

test('parseCompletionInput 至少需要一项输入', () => {
  assert.throws(() => parseCompletionInput({}), /至少录入一项/u)
  const input = parseCompletionInput({ name: '晚风' })
  assert.equal(input.name, '晚风')
  assert.equal(input.audience, DEFAULT_AUDIENCE)
})

test('normalizeCompletion 丢弃未知题材，用户草稿兜底', () => {
  const input = parseCompletionInput({ name: '晚风' })
  const result = normalizeCompletion({ themes: ['marriage', 'nope'], boundary: '不写真人' }, input)
  assert.deepEqual(result.suggestion.themes, ['marriage'])
  assert.equal(result.suggestion.name, '晚风')
  assert.ok(result.filled.includes('boundary'))
})

test('normalizeCompletion 在 AI 名称缺失时不会清空用户草稿', () => {
  const input = parseCompletionInput({ name: '晚风' })
  const result = normalizeCompletion({ positioning: '讲成年女性的故事' }, input)
  assert.equal(result.suggestion.name, '晚风')
})

/* --------------------------------- 素材 --------------------------------- */

test('parseMaterial 拒绝非 HTTP 来源地址', () => {
  assert.throws(() => parseMaterial({ title: 't', content: 'c', sourceUrl: 'ftp://x' }), /HTTP/u)
})

test('parseMaterial 允许无来源地址', () => {
  const material = parseMaterial({ title: 't', content: 'c' })
  assert.equal(material.sourceUrl, null)
  assert.equal(material.kind, 'other')
})

test('normalizeMaterialFile 丢弃残缺记录而不是抛错', () => {
  const result = normalizeMaterialFile({ items: [{ id: 'a', title: 't', content: 'c' }, { id: 'b' }, null] })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].id, 'a')
})

test('assembleMaterial 优先使用手工指定的素材', () => {
  const items = [
    { id: 'a', title: 'a', content: 'x', kind: 'other', sourceUrl: null, capturedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', title: 'b', content: 'y', kind: 'other', sourceUrl: null, capturedAt: '2026-02-01T00:00:00.000Z' },
  ]
  const material = assembleMaterial({ pickedIds: ['a'], items })
  assert.equal(material.materials[0].id, 'a')
  assert.equal(material.mode, 'picked+recent')
})

/* --------------------------------- 选题 --------------------------------- */

test('parseTopicInput 允许完全空请求', () => {
  const input = parseTopicInput({})
  assert.equal(input.angle, null)
  assert.deepEqual(input.materialIds, [])
})

test('normalizeCandidates 丢弃缺场景或关键对白的候选', () => {
  const material = { materials: [{ id: 'm1' }] }
  const result = normalizeCandidates({
    candidates: [
      { title: '有场景没对白', scenario: '厨房，晚上', keyLine: '' },
      { title: '完整', scenario: '年初三的厨房，我端着碗', keyLine: '你吃吧，我不饿', materialIds: ['m1', 'ghost'] },
    ],
  }, material)
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(result.candidates[0].materialIds, ['m1'])
})

test('normalizeCandidates 把未知的钩子与题材置空而不是猜', () => {
  const result = normalizeCandidates({ candidates: [{ title: 't', scenario: 's', keyLine: 'k', hook: 'nope', theme: 'nope' }] })
  assert.equal(result.candidates[0].hook, null)
  assert.equal(result.candidates[0].theme, null)
})

test('buildTopicPrompt 带素材时要求 materialIds 从素材中选', () => {
  const prompt = buildTopicPrompt({
    input: parseTopicInput({}),
    material: { materials: [{ id: 'm1', kind: 'news-comment', title: 'A', content: 'B' }] },
    profile: parseProfile({ themes: ['marriage'] }),
    recentTitles: ['旧标题'],
  })
  assert.ok(prompt.includes('id=m1'))
  assert.ok(prompt.includes('旧标题'))
  assert.ok(prompt.includes('婚姻与离婚'))
})

/* --------------------------------- 写稿 --------------------------------- */

test('normalizeDraft 剥掉正文开头的内部标注', () => {
  const result = normalizeDraft({ script: '钩子=key-line 题材=marriage\n「妈，我不饿。」\n年初三的厨房里。' })
  assert.ok(result.draft.script.startsWith('「妈，我不饿。」'))
})

test('normalizeDraft 对空正文给出不可用标记', () => {
  assert.equal(normalizeDraft({ script: '   ' }).usable, false)
})

test('parseScriptGenerationInput 校验模式与项目标识', () => {
  const id = '22222222-2222-2222-2222-222222222222'
  assert.equal(parseScriptGenerationInput({ projectId: id }).mode, 'new')
  assert.throws(() => parseScriptGenerationInput({ projectId: 'bad' }), /项目标识无效/u)
  assert.throws(() => parseScriptGenerationInput({ projectId: id, mode: 'rewrite' }), /new 或 polish/u)
})

test('normalizeTier 对未知档位回落到标准', () => {
  assert.equal(normalizeTier('weird'), 'standard')
  assert.equal(normalizeTier('short'), 'short')
})

test('analyzeScriptQuality 对含套路词的稿件判不合格', () => {
  const report = analyzeScriptQuality({ body: '重生之后我在厨房看见了那口锅。'.repeat(10) })
  assert.equal(report.passed, false)
  assert.equal(report.qualityScore, 0)
  assert.ok(report.blockers.some((item) => item.includes('套路')))
})

test('analyzeScriptQuality 对过短稿件判不合格', () => {
  const report = analyzeScriptQuality({ body: '两句话。太短。' })
  assert.equal(report.passed, false)
  assert.ok(report.blockers.some((item) => item.includes('低于下限')))
})

test('analyzeScriptQuality 检出与已有稿件的重复', () => {
  const body = '「妈，锅里的鱼你吃吧，我不饿。」年初三晚上，我在厨房说完这句，就把碗放回水池。水龙头开得很大。我没关。'
  const report = analyzeScriptQuality({ body, corpus: [{ projectId: 'x', title: '旧稿', body }] })
  assert.ok(report.duplicate)
  assert.ok(report.blockers.some((item) => item.includes('重复')))
})

test('accounts.json 损坏时显式报错，不静默回退到空账号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-content-corrupt-'))
  await mkdir(join(dir, 'data'), { recursive: true })
  const content = new StoryAccountContent({ workspacePath: dir })
  const file = storyAccountDataPath(dir, 'accounts.json')
  await writeFile(file, '{ 这不是合法的 json', 'utf8')
  await assert.rejects(() => content.listAccounts(), /不是有效的 JSON|损坏/u)
})
