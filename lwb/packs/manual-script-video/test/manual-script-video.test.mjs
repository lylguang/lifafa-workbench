import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateLwbPackManifest } from '../../../pack-sdk/index.mjs'
import { SpokenVideoProjectStore } from '../../spoken-video/spoken-video-store.mjs'
import { analyzeScriptQuality } from '../../spoken-video/spoken-video-script.mjs'
import { channelSnapshot, normalizeChannel } from '../manual-script-channel.mjs'
import { buildPolishPrompt, ManualPolishService, normalizePolish } from '../manual-script-polish.mjs'
import { buildTitlePrompt, fallbackTitleFromBody, generateTitle, normalizeGeneratedTitle, titleFromExecutorResult } from '../manual-script-title.mjs'
import { sharedCredentialRef } from '../index.mjs'
import { createAgentExecutor } from '../../spoken-video/index.mjs'

const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(PACK_DIR, 'lwb-pack.json'), 'utf8'))

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-manual-script-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'workspace')
  await mkdir(dir)
  return dir
}

function agent(cwd) { return { session: { header: { cwd } } } }

/** 建一篇带渠道的手写稿：选题落渠道、正文落稿件。 */
async function seedScript(cwd, { title = '一条街上的早餐摊', body = '早上六点，街角那家早餐摊就开门了。\n老板姓陈，五十多岁，每天四点半起床和面。\n这一做就是二十年。', channel = '城市观察' } = {}) {
  const store = new SpokenVideoProjectStore()
  const current = agent(cwd)
  const project = await store.create(current, { title })
  const topic = await store.commit(current, {
    projectId: project.id, expectedRevision: project.revision, stage: 'topic',
    payload: { title, angle: channel, account: channelSnapshot(channel) }, idempotencyKey: 'manual-topic-0001',
  })
  const script = await store.commit(current, {
    projectId: project.id, expectedRevision: topic.project.revision, stage: 'script',
    payload: { body }, idempotencyKey: 'manual-script-0001',
  })
  return { store, current, project: script.project }
}

test('清单通过校验，且菜单与客户端注册的四页一一对应', async () => {
  const normalized = validateLwbPackManifest(manifest)
  assert.equal(normalized.id, 'manual-script-video')
  assert.deepEqual(normalized.menus.map((menu) => menu.id), ['scripts', 'audio-captions', 'video-preview', 'publish'])

  const client = await readFile(join(PACK_DIR, 'client.js'), 'utf8')
  const registered = client.match(/pages:\s*\{([^}]*)\}/u)?.[1] || ''
  const pageIds = [...registered.matchAll(/'?([a-z-]+)'?\s*:/gu)].map((match) => match[1])
  assert.deepEqual(pageIds.sort(), ['audio-captions', 'publish', 'scripts', 'video-preview'])
  for (const menu of normalized.menus) {
    assert.ok(pageIds.includes(menu.id), `清单菜单 ${menu.id} 在客户端没有对应页面`)
  }
})

test('客户端不再残留口播包的前置模块页面', async () => {
  const client = await readFile(join(PACK_DIR, 'client.js'), 'utf8')
  for (const gone of ['positioning', 'signals', 'topics', 'content-schedule', 'pipeline']) {
    assert.ok(!new RegExp(`['"]${gone}['"]\\s*:`, 'u').test(client), `客户端不应注册 ${gone} 页面`)
  }
  // 账号定位是口播包的前置模块；本包只有「渠道」这一行可选信息。
  assert.ok(!client.includes('AccountPositioningPage'))
  assert.ok(!client.includes('listAccounts'))
  assert.ok(client.includes('listChannels'))
})

test('渠道快照：同一个名字得到同一个 id，没填就没有渠道', () => {
  assert.equal(channelSnapshot(''), null)
  assert.equal(channelSnapshot('   '), null)
  const first = channelSnapshot('城市观察')
  const again = channelSnapshot(' 城市观察 ')
  assert.equal(first.id, again.id)
  assert.equal(first.name, '城市观察')
  assert.equal(first.revision, 1)
  assert.notEqual(first.id, channelSnapshot('职场观察').id)
  assert.match(first.id, /^[a-f0-9-]{36}$/u)
  assert.equal(normalizeChannel('城市观察'), '城市观察')
  assert.equal(normalizeChannel(''), null)
  assert.throws(() => normalizeChannel('x'.repeat(81)), /渠道名最长/u)
})

test('润色提示词守边界：不许添事实、不许改观点、篇幅随原稿', () => {
  const body = '早上六点，街角那家早餐摊就开门了。老板姓陈，五十多岁，每天四点半起床和面。'
  const prompt = buildPolishPrompt({ title: '一条街上的早餐摊', body, instructions: '开头更抓人', channel: '城市观察', tier: 'medium' })
  assert.match(prompt, /不得新增原稿没有的事实/u)
  assert.match(prompt, /不得删除原稿已有的信息点/u)
  assert.match(prompt, /只改表达/u)
  assert.match(prompt, new RegExp(`原稿约 ${body.replace(/\s+/gu, '').length} 字`, 'u'))
  assert.match(prompt, /用户额外要求/u)
  assert.match(prompt, /城市观察/u)
  // 提示词不能把「选题 / 信号」那套搬过来：这里的事实只来自用户原稿。
  assert.doesNotMatch(prompt, /信号来源/u)
  assert.doesNotMatch(prompt, /热点/u)
})

test('润色稿缺正文时判定为不可用', () => {
  assert.equal(normalizePolish({ script: '  ' }).usable, false)
  assert.equal(normalizePolish({}).usable, false)
  const normalized = normalizePolish({ script: '正文', changes: ['a', '', 'b'], warnings: [] })
  assert.equal(normalized.usable, true)
  assert.deepEqual(normalized.draft.changes, ['a', 'b'])
})

test('润色完成后保存为当前稿件版本，并留下改了什么', async (t) => {
  const cwd = await workspace(t)
  const { store, current, project } = await seedScript(cwd)
  const polished = '早上六点，街角那家早餐摊就开门了。\n老板姓陈，五十多岁，每天四点半起床和面。\n这一做，就是二十年。'
  const service = new ManualPolishService({
    projectsStore: store,
    background: (promise) => { void promise },
    executor: async () => ({ title: '一条街上的早餐摊', script: polished, changes: ['把第二句拆开，给配音留呼吸'], warnings: [] }),
  })
  const started = await service.start(current, { projectId: project.id, expectedRevision: project.revision })
  assert.ok(started.id)

  // 等后台任务落地：轮询记录状态，最多 50 次。
  let record = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    record = await service.status(current, { id: started.id })
    if (record.status === 'succeeded' || record.status === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(record.status, 'succeeded', record.error || '润色未完成')
  assert.deepEqual(record.result.changes, ['把第二句拆开，给配音留呼吸'])
  assert.equal(record.steps.filter((step) => step.status === 'done').length, 4)

  const detail = await store.get(current, { projectId: project.id })
  assert.equal(detail.artifacts.script.data.body, polished)
  assert.equal(detail.revision, project.revision + 1)
})

test('润色拒绝没有正文的稿件，也不接受过期的版本号', async (t) => {
  const cwd = await workspace(t)
  const { store, current, project } = await seedScript(cwd)
  const service = new ManualPolishService({ projectsStore: store, background: (promise) => { void promise }, executor: async () => ({ script: 'x' }) })
  const empty = await store.create(current, { title: '空稿' })
  await assert.rejects(() => service.start(current, { projectId: empty.id }), /还没有正文/u)

  await assert.rejects(() => service.start(current, { projectId: project.id, expectedRevision: project.revision + 5 }), /稿件已被其他操作更新/u)
})

test('标题生成：AI 起名收敛、失败兜底正文第一句', async () => {
  // 模型返回收敛：去空白、截断到 160。
  assert.equal(normalizeGeneratedTitle({ title: '  街角的早餐摊  ' }), '街角的早餐摊')
  assert.equal(normalizeGeneratedTitle({ title: 'x'.repeat(200) }).length, 160)
  assert.equal(normalizeGeneratedTitle({}), null)
  assert.equal(normalizeGeneratedTitle({ title: '   ' }), null)

  // 兜底：取正文第一个有内容的句子，超长截断。
  assert.equal(fallbackTitleFromBody('早上六点，街角那家早餐摊就开门了。\n老板姓陈。'), '早上六点，街角那家早餐摊就开门了。')
  assert.equal(fallbackTitleFromBody('第一句没有句号'), '第一句没有句号')
  assert.equal(fallbackTitleFromBody(`${'长'.repeat(50)}。第二句`), `${'长'.repeat(39)}…`)
  assert.equal(fallbackTitleFromBody('   '), '未命名稿件')
  assert.equal(fallbackTitleFromBody(''), '未命名稿件')

  // 提示词守住边界：只出标题、不超 30 字、不新增事实。
  const prompt = buildTitlePrompt({ body: '正文内容', channel: '城市观察' })
  assert.match(prompt, /不超过 30 个字/u)
  assert.match(prompt, /不要新增事实/u)
  assert.match(prompt, /城市观察/u)
  assert.match(prompt, /正文内容/u)
  // 长正文只采样前 4000 字。
  const longPrompt = buildTitlePrompt({ body: '字'.repeat(6000) })
  assert.ok(longPrompt.includes('【稿件正文】'))
  assert.ok(longPrompt.length < 6000)

  // executor 可用：拿到 AI 标题。
  const body = '早上六点，街角那家早餐摊就开门了。'
  assert.equal(await generateTitle(async () => ({ title: 'AI 起的标题' }), {}, { body, channel: '' }), 'AI 起的标题')
  // executor 抛错：返回 null（调用方兜底），不抛出。
  assert.equal(await generateTitle(async () => { throw new Error('额度不足') }, {}, { body, channel: '' }), null)
  // executor 缺失：返回 null。
  assert.equal(await generateTitle(null, {}, { body, channel: '' }), null)

  // 非结构化返回（真实场景）：模型用纯文本收尾，output 是内容块数组。
  // 2026-11-04 实测 minimax-m3.1-flash 起完标题后不调 structured_output，
  // 结构化通道把这种回答判成失败——这正是改走非结构化执行器的原因。
  assert.equal(
    titleFromExecutorResult({ output: [{ type: 'text', text: '凌晨四点批发市场，菜贩老周和货车上的孙女座椅' }], stopReason: 'completed' }),
    '凌晨四点批发市场，菜贩老周和货车上的孙女座椅',
  )
  // 带引号、书名号、句末标点、前缀的都要清掉。
  assert.equal(titleFromExecutorResult({ output: [{ type: 'text', text: '《街角的早餐摊》' }] }), '街角的早餐摊')
  assert.equal(titleFromExecutorResult({ output: [{ type: 'text', text: '标题：街角的早餐摊。' }] }), '标题：街角的早餐摊')
  assert.equal(titleFromExecutorResult({ output: [{ type: 'text', text: '「街角的早餐摊」' }] }), '街角的早餐摊')
  // 多行取第一行有内容的。
  assert.equal(titleFromExecutorResult({ output: [{ type: 'text', text: '街角的早餐摊\n——一个关于坚持的故事' }] }), '街角的早餐摊')
  // 超长截断到 160。
  assert.equal(titleFromExecutorResult({ output: [{ type: 'text', text: '长'.repeat(200) }] }).length, 160)
  // 空输出与纯标点：返回 null 走兜底。
  assert.equal(titleFromExecutorResult({ output: [] }), null)
  assert.equal(titleFromExecutorResult({}), null)
  assert.equal(titleFromExecutorResult({ output: [{ type: 'text', text: '。' }] }), null)
})

test('确定性质检与口播包同一把尺', async (t) => {  const cwd = await workspace(t)
  const { store, current, project } = await seedScript(cwd)
  const service = new ManualPolishService({ projectsStore: store, background: (promise) => { void promise }, executor: async () => ({ script: 'x' }) })
  const body = '早上六点，街角那家早餐摊就开门了。\n老板姓陈，五十多岁，每天四点半起床和面。\n这一做就是二十年。'
  const report = await service.analyze(current, { body, title: '一条街上的早餐摊', tier: 'medium', projectId: project.id })
  const baseline = analyzeScriptQuality({ title: '一条街上的早餐摊', body, tier: 'medium', corpus: [] })
  assert.equal(report.qualityScore, baseline.qualityScore)
  assert.equal(report.verdict, baseline.verdict)
  assert.equal(report.deterministic, true)
})

test('视频任务进度：AI 导演环节的细进度取自 DSH 会话事件，双心跳取更晚', async () => {
  // client.js 是浏览器 bundle，没有纯导出可引；这里用正则从源码里确认关键
  // 事实链存在，防止未来重构悄悄把导演细进度拆掉（与既有测试同一套路）。
  const client = await readFile(join(PACK_DIR, 'client.js'), 'utf8')

  // 1) 进度计算读取 DSH 会话事件流，并找 role=creator 的导演子会话。
  assert.ok(client.includes("session.role === 'creator'"), '进度计算必须从 dsh.sessions 里找 creator 导演会话')
  assert.ok(/^\s+director,$/m.test(client), 'videoTaskProgress 必须把导演细进度挂到返回值上')

  // 2) 导演事件与渲染心跳合并成双心跳：render.updatedAt 与事件流取更晚。
  assert.ok(client.includes('heartbeatCandidates'), '沉默判定必须合并渲染心跳与导演事件心跳')
  assert.ok(client.includes('Math.max(...heartbeatCandidates)'), '双心跳必须取更晚的一条')

  // 3) 组件层：导演环节渲染细进度块（统计徽章 + 最近动作时间线），
  //    且只在 directing 阶段显示。
  assert.ok(client.includes('sv-vprogress-director'), '进度组件必须渲染导演细进度块')
  assert.ok(client.includes("progress.phase === 'directing' ? progress.director : null"), '导演细进度只在 AI 导演阶段显示')
  assert.ok(client.includes('模型往返'), '导演细进度必须显示模型往返计数')
  assert.ok(client.includes('工具调用'), '导演细进度必须显示工具调用计数')
  assert.ok(client.includes('最近动作'), '导演细进度必须提供最近动作时间线开关')

  // 4) 当前动作要进主提示行：有实时动作时用「AI 导演：…」模板。
  assert.ok(client.includes('`AI 导演：${director.label}`'), '导演有实时动作时提示行必须显示它正在做什么')
})

test('AI 导演细进度与口播包同一把尺，事件心跳初值不能吞掉事件', async () => {
  const manual = (await readFile(join(PACK_DIR, 'client.js'), 'utf8')).replace(/\r\n/g, '\n')
  const spoken = (await readFile(join(PACK_DIR, '..', 'spoken-video', 'client.js'), 'utf8')).replace(/\r\n/g, '\n')
  const cut = (source) => source.slice(source.indexOf('function videoTaskProgress('), source.indexOf('function videoTaskDurationSeconds('))
  assert.ok(cut(manual).length > 1000, '进度计算必须仍可抽取')
  assert.equal(cut(manual), cut(spoken), '两个包的视频任务进度计算必须逐字一致')
  // reduce 的初值不能用 NaN：at > NaN 恒为 false，会让整条 DSH 事件心跳失效，
  // 导演/审片阶段的「最后一次后台动作」又退回成只有渲染阶段才有。
  assert.ok(manual.includes('}, -Infinity);'), '事件心跳的 reduce 初值必须是 -Infinity')
})

test('执行器的子会话落在声明的包工作区：packId 决定 withAgent 归属', async () => {
  // 2026-11-04 事故：手动稿包的导演子会话被关进口播包工作区（共享执行器
  // 工厂默认 forPack(口播包 id)），沙箱拒写任务目录（EPERM），导演白干 35 分钟。
  // 这个测试钉住：不传 packId 归口播包，传了 packId 必须归声明的包。
  const requested = []
  const makeScope = (id) => ({
    signal: new AbortController().signal,
    context: async () => ({ workspacePath: `W:\\${id}` }),
    withAgent: async (operation) => {
      requested.push(id)
      // 真实 withAgent 返回的 parent 没有 workspacePath（cwd 在 session.header 里），
      // 所以执行器不会再递归进 withAgent。这里保持同一形状。
      return operation({ id: `agent-${id}`, session: { header: { cwd: `W:\\${id}` } } })
    },
  })
  const scopes = new Map([
    ['spoken-video', makeScope('spoken-video')],
    ['manual-script-video', makeScope('manual-script-video')],
  ])
  const ctx = {
    on() { return () => {} },
    lwbPackServices: { forPack: (id) => { if (!scopes.has(id)) throw new Error('unknown pack ' + id); return scopes.get(id) } },
  }
  const subagents = { async start() { throw new Error('不应到达 spawn：withAgent 后才 spawn，这里只验证归属') } }

  // 默认（不传 packId）：归口播包。
  const plain = createAgentExecutor(ctx, subagents, 't-plain')
  await assert.rejects(() => plain({ prompt: 'x', agent: { workspacePath: 'W:\\any' } }))
  assert.deepEqual(requested, ['spoken-video'])

  // 显式传 packId：归声明的包（手动稿包的关键修法）。
  requested.length = 0
  const owned = createAgentExecutor(ctx, subagents, 't-owned', { packId: 'manual-script-video' })
  await assert.rejects(() => owned({ prompt: 'x', agent: { workspacePath: 'W:\\any' } }))
  assert.deepEqual(requested, ['manual-script-video'])
})

test('媒体凭据与口播包共用同一份命名空间', () => {
  assert.equal(sharedCredentialRef('DASHSCOPE_API_KEY'), sharedCredentialRef('dashscope-api-key'))
  assert.match(sharedCredentialRef('XIAOMIMIMO_API_KEY'), /^LWB_PACK_12_SPOKEN_VIDEO_18_XIAOMIMIMO_API_KEY$/u)
  assert.throws(() => sharedCredentialRef(''), /凭据引用无效/u)
})

test('followExecution keeps the strict codec contract and guards the payload before dispatch', async () => {
  const client = await readFile(join(PACK_DIR, 'client.js'), 'utf8')

  // DSH alpha.2 起 Typert strict codec 的契约是 `create: () => TypertSchema`：
  // registry 的 validateCodec() 与 loader 的 requireStrictCodec() 都会拒绝
  // 只带 `schema` 的 strict codec，client entry 直接 failed（web boot: N entries did not activate）。
  assert.match(client, /codec: \{ mode: 'strict', typeSymbol: '@scitiger-ai\/lwb-manual-script-video#ExecutionRequest', create: \(\) => executionRequestSchema\(\) \}/u)
  assert.doesNotMatch(client, /codec: \{ mode: 'strict', typeSymbol: '@scitiger-ai\/lwb-manual-script-video#ExecutionRequest', schema:/u)

  // alpha.2 的 Gateway client 面删掉了 parseInput()，浏览器侧不再有上游替我们校验入参。
  // 因此调用点必须自己跑同一份 schema，保持「入参非法时调用前就失败」的业务行为。
  assert.match(client, /executionRequestSchema\(\)\.parse\(sessionRequest\);/u)
  assert.match(client, /executionRemote\.followExecution\(sessionRequest, signal\)/u)

  // schema 工厂必须惰性物化并缓存：create() 契约要的是工厂，重复物化会得到不同对象。
  assert.match(client, /let executionRequestSchemaValue = null/u)
  assert.match(client, /if \(executionRequestSchemaValue === null\)/u)
})
