import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { normalizeRemoteSettingsMode } from '../remote-settings-gateway.mjs'

const clientPath = new URL('../client.js', import.meta.url)

function view() {
  return { namespaces: [{ ns: 'lwb-workbench', value: { state: {} } }], writable: true, hasDocument: true }
}

async function controllerHarness({ mode, status, loopback = false, officialView, legacyApi = true } = {}) {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function warnRemoteSettingsCompatibility')
  const end = source.indexOf('const css = `', start)
  assert.ok(start >= 0 && end > start, 'remote settings compatibility controller must be present')
  const script = `
    let services;
    let runtimeApi;
    let remoteSettingsCompatibilityWarning = false;
    ${source.slice(start, end)}
    ({ configure(value) { services = value.services; runtimeApi = value.runtimeApi; }, refreshRemoteSettingsCompatibility, getWarning: () => remoteSettingsCompatibilityWarning });
  `
  const warnings = []
  const calls = { policy: 0, describe: 0, set: 0 }
  const mirror = {
    store: { set(value) { calls.set++; mirror.snapshot = value } },
    snapshot: { status: status || 'unavailable', view: officialView, error: null },
    getSnapshot() { return this.snapshot },
    async ensure() {},
  }
  const api = runInNewContext(script, {
    console: { warn: (message) => warnings.push(message) },
  })
  api.configure({
    services: {
      remote: { $host: { isLoopback: loopback } },
      settingsScope: { describe: () => mirror },
      connection: { rpc: { call: async (_path, method) => {
        if (method === 'lwbRemoteSettings/policy') {
          calls.policy++
          return { ok: true, value: { mode } }
        }
        assert.equal(method, 'settings/describe')
        calls.describe++
        return { ok: true, value: view() }
      } } },
    },
    runtimeApi: legacyApi ? { settings: { describe: async () => {
      calls.describe++
      return { result: { ok: true, value: view() } }
    } } } : { settings: {} },
  })
  await api.refreshRemoteSettingsCompatibility()
  return { mirror, calls, warnings, warningFlag: api.getWarning() }
}

test('remote settings policy normalizes unknown values to auto', () => {
  assert.equal(normalizeRemoteSettingsMode('auto'), 'auto')
  assert.equal(normalizeRemoteSettingsMode('compat'), 'compat')
  assert.equal(normalizeRemoteSettingsMode('disabled'), 'disabled')
  assert.equal(normalizeRemoteSettingsMode('future-value'), 'auto')
  assert.equal(normalizeRemoteSettingsMode(undefined), 'auto')
})

test('auto mode leaves an official settings mirror untouched', async () => {
  const result = await controllerHarness({ mode: 'auto', status: 'ready', officialView: view() })
  assert.equal(result.calls.policy, 1)
  assert.equal(result.calls.describe, 0)
  assert.equal(result.calls.set, 0)
  assert.deepEqual(result.warnings, [])
})

test('auto mode seeds the mirror only after terminal unavailability', async () => {
  const result = await controllerHarness({ mode: 'auto', status: 'unavailable' })
  assert.equal(result.calls.describe, 1)
  assert.equal(result.calls.set, 1)
  assert.equal(result.mirror.snapshot.status, 'ready')
  assert.deepEqual(result.mirror.snapshot.view, view())
})

test('compat mode explicitly bridges an unavailable mirror', async () => {
  const result = await controllerHarness({ mode: 'compat', status: 'unavailable' })
  assert.equal(result.calls.describe, 1)
  assert.equal(result.calls.set, 1)
})

test('compatibility falls back to the authenticated generic RPC when legacy API is absent', async () => {
  const result = await controllerHarness({ mode: 'auto', status: 'unavailable', legacyApi: false })
  assert.equal(result.calls.describe, 1)
  assert.equal(result.calls.set, 1)
})

test('disabled mode and loopback pages never use the compatibility read', async () => {
  const disabled = await controllerHarness({ mode: 'disabled', status: 'unavailable' })
  assert.equal(disabled.calls.describe, 0)
  assert.equal(disabled.calls.set, 0)
  const loopback = await controllerHarness({ mode: 'compat', status: 'unavailable', loopback: true })
  assert.equal(loopback.calls.policy, 0)
  assert.equal(loopback.calls.describe, 0)
  assert.equal(loopback.calls.set, 0)
})

test('compatibility code never assigns the DSH loopback fact', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.doesNotMatch(source, /isLoopback\s*=(?![=])/u)
})

test('host policy is passed from the profile config to the gateway', async () => {
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(source, /ctx\.plugin\(LwbRemoteSettingsGateway,\s*\{\s*mode: normalizeRemoteSettingsMode\(config\.remoteSettings\?\.mode\)/u)
})
