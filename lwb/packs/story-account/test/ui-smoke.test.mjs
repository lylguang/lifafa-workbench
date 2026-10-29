import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 页面渲染冒烟。
 *
 * `node --check` 只做语法解析，抓不到运行时崩溃。真实案例：CandidateCard 用了
 * 未声明的 index（调用点传了但签名没接），语法检查全绿，而一点开选题候选就
 * ReferenceError 白屏。同理，空状态下候选列表为空，那行代码根本不会执行——
 * 所以既要渲染空状态，也要校验「有数据时组件要读的字段确实存在」。
 *
 * 这是**崩溃验收**，不是视觉验收；视觉仍要在浏览器里看。
 */

function makeReact() {
  let hooks = 0
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => {
      const name = typeof type === 'string' ? type : (type?.name || 'Anonymous')
      if (typeof type === 'function') {
        try {
          return type({ ...(props || {}), children })
        } catch (error) {
          throw new Error(`组件 ${name} 渲染崩溃：${error.message}`)
        }
      }
      return { _tag: name, props: props || {}, children: children.flat(6).filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState: (initial) => { hooks += 1; return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    useMemo: (fn) => fn(),
  }
  return { React, hooks: () => hooks }
}

async function loadPages() {
  const { React } = makeReact()
  const win = { __ModuleLoader__: { load: (entry) => { win.__entry = entry } }, setTimeout: () => 0, clearTimeout: () => {} }
  const doc = { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} } }
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const runner = new Function('window', 'document', 'React', `${source}\nreturn window.__entry;`)
  const entry = runner(win, doc, React)
  const captured = {}
  const ctx = {
    get: (name) => (name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : null),
    effect: (fn) => fn(),
    lwbPackClient: { register: (payload) => { captured.pages = payload.pages } },
  }
  const mod = entry.factory((name) => (name === 'react' ? React : {}))
  await mod.apply(ctx)
  return captured.pages
}

test('九个页面在空状态下都能渲染，不因未声明变量崩溃', async () => {
  const pages = await loadPages()
  assert.ok(pages, 'apply 必须注册页面')
  const names = Object.keys(pages)
  assert.equal(names.length, 9)
  const { React, hooks } = makeReact()
  for (const name of names) {
    // 每个页面都要能渲染出组件树；崩溃会以 throw 的形式冒出来。
    const tree = React.createElement(pages[name], {})
    assert.ok(tree, `${name} 渲染结果为空`)
  }
})

test('页面注册覆盖了 manifest 声明的全部功能页', async () => {
  const pages = await loadPages()
  const manifest = JSON.parse(await readFile(join(here, '..', 'lwb-pack.json'), 'utf8'))
  for (const menu of manifest.menus) {
    assert.ok(pages[menu.id], `菜单 ${menu.id} 没有对应页面`)
  }
})

/* ------------------------------------------------------------------------
 * 空状态渲染证明不了「有数据时不崩」——候选卡片只有在拿到候选之后才会渲染，
 * 而那正是之前 index 未声明的地方。所以这里校验「组件要读的字段确实存在」。
 * ---------------------------------------------------------------------- */

test('候选卡片要读的字段在归一化后确实存在', async () => {
  const { normalizeCandidates } = await import('../story-account-topic.mjs')
  const candidate = normalizeCandidates({
    candidates: [{
      title: '锅里的鱼', theme: 'family-origin', hook: 'key-line', emotion: 'loss',
      scenario: '年初三晚上，厨房', keyLine: '你吃吧，我不饿',
      materialIds: ['m1'], reason: '素材里有现成原话', confidence: 'high',
    }],
  }, { materials: [{ id: 'm1' }] }).candidates[0]
  // CandidateCard 直接读这些字段；缺一个就会显示成 undefined 或崩溃。
  assert.ok(candidate.title)
  assert.ok(candidate.scenario)
  assert.ok(candidate.keyLine)
  assert.ok(candidate.reason, '推荐理由缺失会让卡片显示空行')
  assert.ok(['high', 'medium', 'low'].includes(candidate.confidence), '依据强度必须是三个枚举之一')
  assert.ok(Array.isArray(candidate.materialIds))
})

test('候选缺 confidence 时按素材引用数补一个，不让界面留空', async () => {
  const { normalizeCandidates } = await import('../story-account-topic.mjs')
  const withRefs = normalizeCandidates({ candidates: [{ title: 'a', scenario: 's', keyLine: 'k', materialIds: ['m1', 'm2'] }] }, { materials: [{ id: 'm1' }, { id: 'm2' }] }).candidates[0]
  const noRefs = normalizeCandidates({ candidates: [{ title: 'a', scenario: 's', keyLine: 'k', materialIds: [] }] }, { materials: [] }).candidates[0]
  assert.equal(withRefs.confidence, 'high')
  assert.equal(noRefs.confidence, 'low')
})

test('采集结果要读的字段在归一化后确实存在', async () => {
  const { normalizeHarvest } = await import('../story-account-harvest.mjs')
  const item = normalizeHarvest({
    items: [{ title: 'x', content: 'y', kind: 'other', sourceUrl: 'https://a.com/b', sceneHint: 's', keyLineHint: 'k', note: 'n' }],
  }, { existing: [] }).items[0]
  // MaterialsPage 直接读 weak / sceneHint / keyLineHint / sourceUrl / note。
  assert.equal(typeof item.weak, 'boolean', 'weak 缺失会让「偏弱」标签判断出错')
  assert.ok(item.sourceUrl)
  assert.ok(item.sceneHint)
  assert.ok(item.keyLineHint)
  assert.equal(item.note, 'n')
})

/* ------------------------------------------------------------------------
 * 切 tab 不能把生成任务弄丢。
 *
 * 每个菜单页是独立组件，切 tab 会卸载旧页面。此前任务记录存在页面 state 里，
 * 一卸载就只剩主机侧还在跑——界面上看不到进度，也拿不回生成结果。
 * 现在任务放在模块级缓存里，由 useLiveTask 负责恢复与续轮询。
 * ---------------------------------------------------------------------- */

test('生成任务放在模块级缓存里，页面卸载后仍能取回', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /const liveTasks = new Map\(\)/u, '缺少模块级任务缓存')
  assert.match(source, /function useLiveTask\(/u, '缺少任务恢复钩子')
  // 四个后台任务都必须走这条路径，一个都不能留在页面 state 里。
  for (const [kind, status] of [
    ['topic', 'topicGenerationStatus'],
    ['script', 'scriptGenerationStatus'],
    ['media', 'mediaPipelineStatus'],
    ['harvest', 'materialHarvestStatus'],
  ]) {
    assert.match(source, new RegExp(`useLiveTask\\('${kind}', '${status}'`, 'u'), `${kind} 任务没有跨页存活`)
  }
})

test('写稿正文按项目缓存，切走再切回不丢未保存的稿子', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /const scriptDrafts = new Map\(\)/u)
  assert.match(source, /function useScriptDraft\(/u)
})
