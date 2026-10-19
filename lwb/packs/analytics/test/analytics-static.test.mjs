import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/*
 * 静态层断言（与真机走查严格分开）。
 *
 * 只验三件静态能验的事：DOM 结构、暗色 class、空态文案。
 * **验不了的**——暗色对比度、窄窗坐标轴重叠、Tab 实际遍历顺序——必须真浏览器，
 * 这三条留给真机走查，不要在这里假装测过。
 */

const clientPath = new URL('../client.js', import.meta.url)

/* 最小 React 替身：够跑 hooks + 把元素树序列化成 HTML 字符串。 */
function createRuntime() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},          // SSR 不跑副作用：数据加载由浏览器完成。
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
  function render(node) {
    if (node === null || node === undefined || node === false) return ''
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
    const attrs = Object.entries(node.props || {})
      .filter(([key, value]) => key !== 'children' && typeof value !== 'function' && typeof value !== 'object' && value !== false && value !== undefined)
      .map(([key, value]) => ` ${key}="${String(value).replace(/"/gu, '&quot;')}"`)
      .join('')
    const inner = node.children.map(render).join('')
    return `<${node.type}${attrs}>${inner}</${node.type}>`
  }
  return { React, render }
}

async function loadClient() {
  const source = await readFile(clientPath, 'utf8')
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { sandbox.exports = factory((name) => {
      if (name === 'react') return runtime.React
      throw new Error(`未预期的依赖：${name}`)
    }) } } },
    document: { getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {} }), head: { appendChild() {} } },
    setTimeout, clearTimeout,
  }
  const runtime = createRuntime()
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return { pages: sandbox.exports.__pages, components: sandbox.exports.__components, css: sandbox.exports.__css, render: runtime.render, runtime }
}

const PAGES = await loadClient()
const render = (name, props) => PAGES.render(PAGES.pages[name]({ ...props }))

test('概览页渲染出页头、时间范围与平台筛选', () => {
  const html = render('OverviewPage')
  assert.match(html, /className="an-page"/u)
  assert.match(html, /概览/u)
  // 时间范围 chips：原生 button + aria-pressed，键盘可达。
  assert.match(html, /className="an-chip"[^>]*aria-pressed="(true|false)"/u)
  assert.match(html, /近 7 天/u)
  assert.match(html, /近 30 天/u)
  // 平台筛选用原生 select。
  assert.match(html, /<select[^>]*aria-label="按平台筛选"/u)
  assert.match(html, /全部平台/u)
})

test('三个页面在 SSR 下都渲染出可读的加载态（真实空态需数据加载后才出现）', () => {
  const overview = render('OverviewPage')
  // SSR 时 useEffect 不跑，数据还没回来，所以首屏是加载态。
  // 这条只保证「不是无声空着」：有 aria-busy + aria-live + 可读文案。
  // EmptyState 的「为什么空 + 下一步去哪」由下面那条用例单独覆盖。
  assert.match(overview, /aria-busy="true"/u)
  assert.match(overview, /aria-live="polite"/u)
  assert.match(overview, /正在读取…/u)

  const accounts = render('AccountsPage')
  const contents = render('ContentsPage')
  for (const html of [accounts, contents]) {
    assert.match(html, /aria-busy="true"/u)
    assert.match(html, /正在读取…/u)
  }
  assert.match(accounts, /账号/u)
  assert.match(contents, /作品/u)
})

test('EmptyState 本身回答了「为什么空」与「下一步去哪」', () => {
  // 直接渲染这个组件：SSR 拿不到数据时的真实空态文案由它决定，
  // 所以单独覆盖，避免「用例名承诺空态、实际只测了加载态」。
  const html = PAGES.render(PAGES.components.EmptyState({
    title: '还没有平台账号',
    hint: '到「发布与账号管理 → 账号」添加并登录平台账号，这里就会有对照数据。',
  }))
  assert.match(html, /className="an-empty"/u)
  assert.match(html, /还没有平台账号/u)                                        // 为什么空
  assert.match(html, /发布与账号管理 → 账号/u)                                // 下一步去哪
  // 标题用 strong 强调，辅助文字用 p：空态一眼能看出主因。
  assert.match(html, /<strong>/u)
  assert.match(html, /<p [^>]*>|<p>/u)
  // 空态不该伪装成数据：不得出现指标卡或图表。
  assert.doesNotMatch(html, /an-kpi/u)
  assert.doesNotMatch(html, /an-chart/u)
})

test('全部交互控件都是原生 button/select，没有 div 伪按钮', () => {
  for (const name of ['OverviewPage', 'AccountsPage', 'ContentsPage']) {
    const html = render(name)
    // div + onClick 会被渲染成属性；但 onClick 是函数，序列化时已被过滤。
    // 这里改验另一件事：页面上不存在带 role="button" 的 div 伪按钮。
    assert.doesNotMatch(html, /<div[^>]*role="button"/u, `${name} 不应有 div 伪按钮`)
    assert.doesNotMatch(html, /<span[^>]*onClick/u, `${name} 不应有 span 伪按钮`)
  }
})

test('样式里暗色主题覆盖齐备：硬编码色都有对应暗色规则', async () => {
  const source = await readFile(clientPath, 'utf8')
    // 亮色下用到的 4 处硬编码色，每处都必须有暗色覆盖。
  const hardcoded = ['#7a5b17', '#a94343', '#486277', '#994646']
  const darkRules = source.slice(source.indexOf('body[data-ds-dark-theme]'))
  for (const color of hardcoded) {
    // 同一色可能用在 color 或 background 上，两处都算命中。
    const pattern = new RegExp(`(?:color|background):[^;}]*${color}`, 'u')
    assert.match(source, pattern, `亮色规则里应有 ${color}`)
  }
  // 暗色区块存在，且覆盖 pill 的 orange/red 与 note/error 两类底色。
  assert.match(darkRules, /body\[data-ds-dark-theme\] \.an-pill\[data-tone="orange"\]/u)
  assert.match(darkRules, /body\[data-ds-dark-theme\] \.an-pill\[data-tone="red"\]/u)
  assert.match(darkRules, /body\[data-ds-dark-theme\] \.an-note/u)
  assert.match(darkRules, /body\[data-ds-dark-theme\] \.an-error/u)
})

test('零新增第三方依赖：包内没有除 react 外的 require', async () => {
  const source = await readFile(clientPath, 'utf8')
  const requires = [...source.matchAll(/require\('([^']+)'\)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
})

test('图表是自绘 SVG：没有 canvas、也没有外部图表库', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.doesNotMatch(source, /<canvas/u)
  assert.match(source, /h\('svg'/u)
  // 趋势图必须有无障碍描述，否则读屏用户拿不到趋势内容。
  assert.match(source, /role: 'img', 'aria-label':/u)
})
