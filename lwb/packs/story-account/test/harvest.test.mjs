import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseHarvestInput, buildHarvestPrompt, buildHarvestSteps,
  normalizeHarvest, summarizeHarvest, STORY_HARVEST_SCHEMA,
} from '../story-account-harvest.mjs'
import { StoryAccountContent } from '../story-account-content.mjs'
import { StoryAccountStore } from '../story-account-store.mjs'

/**
 * 素材采集。
 *
 * 这一组用例守的核心不是「能不能调模型」，而是三条底线：
 * 1. 没有来源地址的素材必须丢——没有出处等于编造，编造是本赛道最贵的风险；
 * 2. 采集结果不自动入库，入库必须走 adoptHarvest 由人勾选；
 * 3. 一条都没找到不是失败，但要如实报告缺什么。
 */

const EXISTING = [{ title: '已有的素材', sourceUrl: 'https://example.com/old' }]

const RAW = {
  items: [
    {
      title: '年初三的厨房',
      content: '「妈，锅里的鱼你吃吧，我不饿。」',
      kind: 'news-comment',
      sourceUrl: 'https://example.com/a',
      note: '一句话就有人物关系',
      sceneHint: '年初三晚上，厨房，母女俩在饭桌两头',
      keyLineHint: '你吃吧，我不饿',
    },
  ],
  summary: '本轮找到 1 条',
  gaps: null,
}

test('采集请求没有必填项：留空就是「你看着办」', () => {
  const input = parseHarvestInput({})
  assert.equal(input.focus, null)
  assert.deepEqual(input.kinds, [])
  assert.ok(input.limit > 0)
})

test('采集请求拒绝未知来源类型', () => {
  assert.throws(() => parseHarvestInput({ kinds: ['vampire'] }), /来源类型/u)
})

test('采集请求限制来源类型数量与上限', () => {
  // 先去重再判上限：重复填同一个类型不该算超限。
  assert.equal(parseHarvestInput({ kinds: ['personal', 'personal', 'other'] }).kinds.length, 2)
  // 上限按来源类型总数收：全选是合法的，所以只能靠「塞一个未知的」来触发。
  assert.throws(
    () => parseHarvestInput({ kinds: ['personal', 'other', 'qa-answer', 'field-note', 'news-comment', 'bogus'] }),
    /无效/u,
  )
  assert.equal(parseHarvestInput({ kinds: ['personal', 'other', 'qa-answer', 'field-note', 'news-comment'] }).kinds.length, 5)
  assert.equal(parseHarvestInput({ limit: 999 }).limit, 12, '采集上限必须收敛，避免一次拉回过多')
  assert.equal(parseHarvestInput({ limit: 0 }).limit, 1)
})

test('没有来源地址的素材被丢弃，不入库', () => {
  const result = normalizeHarvest({
    items: [
      { title: '没出处的一条', content: '编的', kind: 'other', sourceUrl: null },
      { title: '地址不合法', content: '编的', kind: 'other', sourceUrl: 'ftp://x' },
      { title: '缺正文', content: '', kind: 'other', sourceUrl: 'https://example.com/x' },
      RAW.items[0],
    ],
  }, { existing: [] })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].title, '年初三的厨房')
  assert.equal(result.dropped, 3)
})

test('与已有素材按地址和标题去重', () => {
  const result = normalizeHarvest({
    items: [
      { title: '已有的素材', content: '重复', kind: 'other', sourceUrl: 'https://example.com/old' },
      { title: '换个标题', content: '同地址', kind: 'other', sourceUrl: 'https://example.com/old/' },
      RAW.items[0],
    ],
  }, { existing: EXISTING })
  assert.equal(result.items.length, 1)
  assert.equal(result.duplicate, 2)
})

test('缺场景或关键对白的素材标记为偏弱但仍可入库', () => {
  const result = normalizeHarvest({
    items: [{ title: '只有观点的素材', content: '大概就是说人要为自己活', kind: 'qa-answer', sourceUrl: 'https://example.com/b' }],
  }, { existing: [] })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].weak, true)
  assert.equal(result.weak, 1)
})

test('有场景与关键对白的素材不标偏弱', () => {
  const result = normalizeHarvest(RAW, { existing: [] })
  assert.equal(result.items[0].weak, false)
})

test('提示词要求必须给出处，并允许如实说找不到', () => {
  const prompt = buildHarvestPrompt({ input: parseHarvestInput({ focus: '婆媳之间关于钱' }), profile: null, existing: [] })
  assert.ok(prompt.includes('婆媳之间关于钱'))
  assert.ok(/来源地址|sourceUrl/u.test(prompt), '必须要求来源地址')
  assert.ok(/找不到|空的 items|gaps/u.test(prompt), '必须允许如实说找不到')
  assert.ok(/不要执行|不可信/u.test(prompt), '必须把素材当不可信数据')
})

test('提示词带上已有素材标题用于去重', () => {
  const prompt = buildHarvestPrompt({ input: parseHarvestInput({}), profile: null, existing: ['旧素材一', '旧素材二'] })
  assert.ok(prompt.includes('旧素材一'))
})

test('采集步骤覆盖确定范围、检索、核实', () => {
  assert.deepEqual(buildHarvestSteps().map((step) => step.id), ['scope', 'gather', 'verify'])
})

test('schema 要求每条都带 sourceUrl', () => {
  assert.deepEqual(STORY_HARVEST_SCHEMA.properties.items.items.required, ['title', 'content', 'kind', 'sourceUrl'])
})

test('汇总文案如实报告丢弃与偏弱数量', () => {
  const text = summarizeHarvest(normalizeHarvest({
    items: [
      { title: '没出处', content: 'x', kind: 'other', sourceUrl: null },
      { title: '弱素材', content: 'y', kind: 'other', sourceUrl: 'https://example.com/c' },
    ],
  }, { existing: [] }))
  assert.ok(text.includes('找到 1 条'))
  assert.ok(text.includes('偏弱'))
  assert.ok(text.includes('丢弃 1 条'))
  assert.equal(summarizeHarvest(null), '还没有采集过。')
})

test('一条都没找到不是失败，但要给出 gaps', () => {
  const result = normalizeHarvest({ items: [], gaps: '缺身边人的真实经历，建议去问答平台找' }, { existing: [] })
  assert.equal(result.admitted, 0)
  assert.equal(result.gaps, '缺身边人的真实经历，建议去问答平台找')
  const text = summarizeHarvest(result)
  assert.ok(text.includes('没有找到'))
})

/* ------------------------------ 编排与入库 ------------------------------ */

async function withContent(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-harvest-'))
  try {
    const store = new StoryAccountStore()
    const agent = { workspacePath: dir }
    const content = new StoryAccountContent({ workspacePath: dir })
    content.attachProjects(store, agent)
    await run({ content, dir, agent })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('采集会把 agent 交给执行器', async () => {
  await withContent(async ({ content }) => {
    const seen = []
    content.harvestExecutor = async (request) => { seen.push(request); return { items: [] } }
    await content.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(seen.length >= 1)
    assert.ok(seen[0].agent, '采集同样必须带 agent')
  })
})

test('采集结果不自动入库，必须走 adoptHarvest', async () => {
  await withContent(async ({ content }) => {
    content.harvestExecutor = async () => RAW
    const created = await content.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 60))
    const record = await content.materialHarvestStatus({ id: created.id })
    assert.equal(record.status, 'success')
    assert.equal(record.items.length, 1)
    // 关键：采集完素材库仍然是空的。
    const materials = await content.listMaterials()
    assert.equal(materials.items.length, 0, '采集结果不得自动入库')

    const adopted = await content.adoptHarvest({ id: created.id, indexes: [0] })
    assert.equal(adopted.count, 1)
    const after = await content.listMaterials()
    assert.equal(after.items.length, 1)
    assert.equal(after.items[0].sourceUrl, 'https://example.com/a')
  })
})

test('采纳时仍会拦截没有来源地址的条目', async () => {
  await withContent(async ({ content }) => {
    content.harvestExecutor = async () => ({ items: [{ title: '没出处', content: 'x', kind: 'other', sourceUrl: null }] })
    const created = await content.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 60))
    // 采集侧已经丢掉了，采纳时应当报「没有选中」。
    await assert.rejects(() => content.adoptHarvest({ id: created.id, indexes: [0] }), /没有选中|来源地址/u)
  })
})

test('采集状态查不到时给出明确错误', async () => {
  await withContent(async ({ content }) => {
    await assert.rejects(
      () => content.materialHarvestStatus({ id: '11111111-1111-1111-1111-111111111111' }),
      /采集记录不存在/u,
    )
  })
})

test('没有采集执行器时把失败写进采集记录', async () => {
  await withContent(async ({ content }) => {
    content.harvestExecutor = null
    // 采集与其他生成任务一致：立即返回记录、后台跑，失败落在记录里由轮询看到，
    // 而不是让 start 本身 reject——否则界面上点一下就弹错，看不到进度。
    const created = await content.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 40))
    const record = await content.materialHarvestStatus({ id: created.id })
    assert.equal(record.status, 'failed')
    assert.match(record.error, /模型执行接缝|采集/u)
  })
})

test('默认不联网：未配置真实采集源时采集不发起任何网络请求', async () => {
  await withContent(async ({ dir }) => {
    let fetchCalls = 0
    const countingFetch = async () => { fetchCalls += 1; throw new Error('不应在默认配置下发起网络请求') }
    const counted = new StoryAccountContent({ workspacePath: dir, fetch: countingFetch })
    counted.attachProjects(new StoryAccountStore(), { workspacePath: dir })
    // 默认（不注入 sourceCollector）必须等价于「默认不启用」：采集只走 agent 自检索。
    assert.equal(counted.sourceCollector, null, '默认不应持有真实采集源')
    counted.harvestExecutor = async () => RAW
    const created = await counted.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 60))
    const record = await counted.materialHarvestStatus({ id: created.id })
    assert.equal(record.status, 'success')
    assert.equal(fetchCalls, 0, '默认配置下采集过程不应发起任何网络请求')
  })
})

test('用户启用真实采集源后才发起网络请求', async () => {
  await withContent(async ({ dir }) => {
    let fetchCalls = 0
    const countingFetch = async () => { fetchCalls += 1; return undefined }
    const sourceCollector = async ({ fetch }) => { await fetch('https://example.com/collect'); return { items: [], sources: [] } }
    const counted = new StoryAccountContent({ workspacePath: dir, fetch: countingFetch, sourceCollector })
    counted.attachProjects(new StoryAccountStore(), { workspacePath: dir })
    counted.harvestExecutor = async () => RAW
    const created = await counted.startMaterialHarvest({})
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(fetchCalls > 0, '启用真实采集源后应向外部站点发起请求')
  })
})
