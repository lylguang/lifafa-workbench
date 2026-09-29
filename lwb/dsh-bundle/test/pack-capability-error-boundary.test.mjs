import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientPath = new URL('../client.js', import.meta.url)

test('capability component failures stay inside the workbench overlay', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('class CapabilityPageBoundary')
  const end = source.indexOf('\n    function MobileNavToggle', start)
  assert.ok(start >= 0 && end > start, 'capability boundary must precede the navigation components')
  const section = source.slice(start, end)

  assert.match(section, /static getDerivedStateFromError\(\) \{ return \{ failed: true \}; \}/u)
  assert.match(section, /copy\.capabilityPageFailed/u)
  assert.match(section, /h\(CapabilityPageBoundary, \{[\s\S]*?key: capabilityRoute\(pack\.id, menu\.id\)/u)
  assert.match(section, /onReturnToConversation: \(\) => showConversation\(\)/u)
  assert.match(section, /onViewPacks: \(\) => navTo\('packs'\)/u)
})
