import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const clientPath = new URL('../client.js', import.meta.url)

function classNames(source) {
  const names = new Set()
  for (const pattern of [/className:\s*'([^']+)'/gu, /className:\s*`([^`]+)`/gu]) {
    for (const match of source.matchAll(pattern)) {
      for (const name of match[1].match(/lwb-[A-Za-z0-9_-]+/gu) || []) names.add(name)
    }
  }
  return names
}

test('every current static LWB component class has a product style rule', async () => {
  const source = await readFile(clientPath, 'utf8')
  const css = source.match(/const css = `([\s\S]*?)`;/u)?.[1]
  assert.ok(css, 'client must define its product CSS')

  const missing = [...classNames(source)].filter((name) => {
    return !css.includes(`.${name}`)
  })
  assert.deepEqual(missing, [])
})

test('desktop hides controls reserved for the mobile navigation', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /\.lwb-mobile-nav-trigger,\.lwb-mobile-conversation-trigger,\.lwb-mobile-nav-backdrop\s*\{\s*display:none;/u)
  assert.match(source, /@media \(max-width:680px\)[\s\S]*?\.lwb-mobile-nav-trigger,\.lwb-mobile-conversation-trigger\s*\{[\s\S]*?display:grid;/u)
})

test('the browser shell restores UUID generation for plain-HTTP LAN previews', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function installLanCryptoCompatibility()')
  const end = source.indexOf('\n    const STORAGE_KEY', start)
  assert.ok(start >= 0 && end > start, 'browser shell must define the LAN crypto compatibility layer')
  const sandbox = { globalThis: { crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes } } } }
  const install = runInNewContext(`${source.slice(start, end)}; installLanCryptoCompatibility`, sandbox)
  install()
  const uuid = sandbox.globalThis.crypto.randomUUID()
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
})

test('settings do not duplicate DSH theme or language controls', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.doesNotMatch(source, /function setAppearance\(/u)
  assert.doesNotMatch(source, /h\('option', \{ value: 'system' \}, copy\.system\)/u)
  assert.doesNotMatch(source, /services\.locale\.setLocale\(/u)
})

test('settings is the only primary navigation entry to native DSH runtime settings', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /function LwbRuntimeSettingsTrigger\(\)/u)
  assert.match(source, /systemSettings: '系统设置'/u)
  assert.match(source, /function SettingsPage\(\{ renderSlot \}\)/u)
  assert.match(source, /renderSlot\('sidebar\.settings', \{ wide: true \}\)/u)
  assert.doesNotMatch(source, /function LwbSidebar\(\{ collapsed, width, renderSlot \}\)/u)
  assert.doesNotMatch(source, /lwb-dsh-models-entry/u)
  assert.match(source, /ctx\.slots\.inject\('settings\.trigger', \(\) => ctx\.slots\.register\(\{[\s\S]*?name: 'settings\.trigger', priority: -10, registrant: 'lwb-workbench'/u)
  assert.match(source, /ctx\.slots\.inject\('shell\.overlay', \(\) => ctx\.slots\.register\(\{[\s\S]*?children: \{[\s\S]*?'sidebar\.settings': \{ kind: 'single', scope: 'root' \}/u)
  assert.match(source, /\.lwb-dsh-settings-launcher button\[aria-haspopup="dialog"\]/u)
})

test('LWB styles follow the DSH-owned theme runtime', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.doesNotMatch(source, /function setAppearance\(/u)
  assert.doesNotMatch(source, /services\.theme\.setTheme\(/u)
  assert.match(source, /body\[data-ds-dark-theme\] \{ --lwb-ink:/u)
  assert.match(source, /body\[data-ds-dark-theme\] \.lwb-sidebar \{ background:var\(--lwb-surface\); \}/u)
})

test('LWB interface observes the shared DSH locale state', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /function useLwbCopy\(\) \{[\s\S]*?useObservable\(services\?\.locale, \{ active: 'zh' \}\)[\s\S]*?locale\.active === 'en' \? LWB_COPY\.en : LWB_COPY\.zh/u)
  assert.match(source, /en: \{[\s\S]*?conversation: 'Conversation', packs: 'Capability Packs', settings: 'Settings'/u)

  for (const component of ['ConversationOverlay', 'LwbSidebar', 'SettingsPage', 'WorkbenchOverlay']) {
    const start = source.indexOf(`function ${component}(`)
    const end = source.indexOf('\n    function ', start + 1)
    assert.ok(start >= 0 && end > start, `${component} must be defined as a standalone component`)
    assert.match(source.slice(start, end), /const copy = useLwbCopy\(\);/u, `${component} must react to locale changes`)
  }
})

test('capability packs switch browser entries in place without reloading the page', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /class LwbPackClientRuntime/u)
  assert.match(source, /bootBundleFor\(packageName\) \{[\s\S]*?this\.modules\.manifest\?\.modules\?\.find\(\(candidate\) => candidate\.id === packageName\)/u)
  assert.match(source, /bundleFor\(pack\) \{[\s\S]*?this\.bundles\.get\(packageName\) \|\| this\.bootBundleFor\(packageName\)/u)
  assert.match(source, /await loadBundleScript\(bundle\.url\);/u)
  assert.match(source, /await this\.loader\.create\(\{ name: bundle\.id \}\);/u)
  assert.match(source, /async removeEntry\(entry\) \{\s*this\.loader\.remove\(entry\.id\);\s*while \(entry\.fiber\?\.inertia\) await entry\.fiber\.inertia;/u)
  assert.match(source, /for \(const entry of entries\) await this\.removeEntry\(entry\);/u)
  assert.match(source, /this\.bundles\.delete\(packageName\);/u)
  assert.match(source, /await lwbPackClientRuntime\.load\(pack, response\.value\?\.client\);/u)
  assert.match(source, /await refreshPackCatalog\(\{ retain: true \}\);/u)
  assert.doesNotMatch(source, /window\.location\.reload\(/u)
})

test('retained catalog refresh keeps current marketplace cards visible during a pack switch', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('async function refreshPackCatalog(options = {})')
  const end = source.indexOf('\n    class LwbPackClientRegistry', start)
  assert.ok(start >= 0 && end > start, 'client must define the retained catalog refresh')
  const refresh = source.slice(start, end)
  assert.match(refresh, /const retain = options\.retain === true;/u)
  assert.match(refresh, /if \(!retain\) \{[\s\S]*phase: 'pending'/u)
  assert.match(refresh, /if \(retain\) \{[\s\S]*phase: 'ready', packs: packCatalog\.packs/u)
})

test('capability routes carry the current pack and menu identity into shell chrome', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /function pageChrome\(page, selected, copy = currentLwbCopy\(\)\) \{[\s\S]*?title: selected\.pack\.name,[\s\S]*?hint: selected\.menu\.label,[\s\S]*?intro: selected\.pack\.description \|\| copy\.capabilityHint,[\s\S]*?ariaLabel: `\$\{selected\.pack\.name\} · \$\{selected\.menu\.label\}`/u)

  const start = source.indexOf('function WorkbenchOverlay({ renderSlot })')
  const end = source.indexOf('\n    function apply(ctx)', start)
  assert.ok(start >= 0 && end > start, 'workbench overlay must remain a standalone component')
  const overlay = source.slice(start, end)
  assert.match(overlay, /const catalog = usePackCatalog\(\);/u)
  assert.match(overlay, /const selected = state\.page === 'capability' \? capabilityAtRoute\(catalog\.packs, state\.capabilityPage\) : undefined;/u)
  assert.match(overlay, /const chrome = pageChrome\(state\.page, selected, copy\);/u)
  assert.match(overlay, /'aria-label': chrome\.ariaLabel/u)
  assert.match(overlay, /h\('b', null, chrome\.title\), h\('span', null, chrome\.hint\)/u)
  assert.match(overlay, /h\('h1', null, chrome\.title\), h\('p', null, chrome\.intro\)/u)
})

test('loaded capability menus stay nested inside independently collapsible pack groups', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function LwbSidebar({ collapsed, width })')
  const end = source.indexOf('\n    async function packOperation(', start)
  assert.ok(start >= 0 && end > start, 'client must define the grouped sidebar')
  const sidebar = source.slice(start, end)

  assert.match(sidebar, /const \[expandedPacks, setExpandedPacks\] = React\.useState/u)
  assert.match(sidebar, /className: 'lwb-cap-group'/u)
  assert.match(sidebar, /className: 'lwb-cap-toggle'/u)
  assert.match(sidebar, /'aria-expanded': wide \? expanded : undefined/u)
  assert.match(sidebar, /className: 'lwb-cap-menu' \}, pack\.menus\.map/u)
  assert.doesNotMatch(sidebar, /packs\.flatMap/u)
})

test('marketplace pins the production spoken-video pack to the first card', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function orderMarketplacePacks(packs)')
  const end = source.indexOf('\n    function PacksPage()', start)
  assert.ok(start >= 0 && end > start, 'client must define marketplace ordering')
  const orderMarketplacePacks = runInNewContext(`${source.slice(start, end)}; orderMarketplacePacks`)
  const input = [{ id: 'demo-a' }, { id: 'spoken-video' }, { id: 'demo-b' }]

  assert.deepEqual(Array.from(orderMarketplacePacks(input), (pack) => pack.id), ['spoken-video', 'demo-a', 'demo-b'])
  assert.deepEqual(input.map((pack) => pack.id), ['demo-a', 'spoken-video', 'demo-b'], 'ordering must not mutate the catalog snapshot')
  assert.match(source, /const packs = orderMarketplacePacks\(market\.packs\);/u)
})

test('capability pages use the available workbench canvas', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /\.lwb-page-capability\s*\{\s*width:100%;\s*max-width:none;/u)
  assert.match(source, /state\.page === 'capability' \? 'lwb-page lwb-page-capability' : 'lwb-page'/u)
})

test('new conversation delegates workspace selection to the DSH navigation service', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function createConversation(workspaceId)')
  const end = source.indexOf('\n    function ConversationOverlay({ renderSlot })', start)
  assert.ok(start >= 0 && end > start, 'client must define the conversation creation action')

  const action = source.slice(start, end)
  assert.match(action, /typeof services\?\.uiWorkspace\?\.startSession !== 'function'/u)
  assert.match(action, /services\.uiWorkspace\.startSession\(workspaceId\);/u)
  assert.doesNotMatch(action, /resolveWorkspaceForNewSession/u)
  assert.doesNotMatch(action, /sessions\?\.create/u)
  assert.match(source, /onClick: \(\) => createConversation\(workspace\.workspaceId\)/u)
  assert.match(source, /onClick: \(\) => ordinaryWorkspaces\.length \? createConversation\(\) : addWorkspace\(\)/u)
})
