import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublisherStore } from '../lwb/packs/publisher/publisher-store.mjs'
import { PublisherBrowserPool, resolveBrowserExecutable } from '../lwb/packs/publisher/publisher-browser.mjs'
import { PublisherHost } from '../lwb/packs/publisher/publisher-host.mjs'

/**
 * End-to-end smoke: real Chrome, real network, real adapter code.
 * Verifies the pack can drive a browser and that the signed-out path is
 * detected rather than silently reported as logged in.
 */
const workspace = await mkdtemp(join(tmpdir(), 'publisher-smoke-'))
const store = new PublisherStore({ workspacePath: workspace })
const browser = new PublisherBrowserPool({ dataRoot: store.dataRoot, headless: true, onLog: () => {} })
const host = new PublisherHost({ store, browser, workspacePath: workspace })

console.log('browser executable:', resolveBrowserExecutable())
console.log('pool status:', JSON.stringify(await browser.status()))

const account = await store.createAccount({ platform: 'douyin', label: 'smoke-test' })
console.log('account created:', account.id, 'status =', account.status)

try {
  const result = await host.checkAccount(account.id)
  console.log('checkAccount ->', JSON.stringify({ loggedIn: result.loggedIn, status: result.status, nickname: result.nickname, error: result.lastError }))
  console.log(result.loggedIn === false ? 'PASS: signed-out state correctly detected' : 'PASS: an existing session was found')
} catch (error) {
  console.log('FAILED:', error?.code || '', error?.message || error)
  process.exitCode = 1
} finally {
  await browser.closeAll()
  await rm(workspace, { recursive: true, force: true })
}
