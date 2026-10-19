/**
 * 账号采集态闭环（RPC 2 的 P2 形态）——回答 Frontend 的问题：
 * `collectionStatus` 由谁算、怎么从 `never` 变成真实状态。
 *
 * 派生规则（不新增落盘字段，只读 store 既有数据）：
 *   expired（登录失效）> failed（最近一次 run 里该账号失败）> stale（快照超 24h）> ok（有新鲜快照）> never（从未采过）
 * `lastError` 走 describeFailure 的中文映射，绝不透传原始 error.message。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnalyticsHost } from '../analytics-host.mjs'

const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' }

function publisher(accounts) {
  return {
    listAccounts: async () => accounts,
    listJobs: async () => [],
    listAccountsPage: undefined,
  }
}

async function mkHost({ accounts = [], snapshots = [], runs = [] } = {}) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'an-host-states-'))
  const dataRoot = join(workspacePath, 'data', 'metrics')
  await mkdir(dataRoot, { recursive: true })
  if (snapshots.length) {
    const month = `${snapshots[0].collectedAt.slice(0, 7)}`
    await writeFile(join(dataRoot, `accounts-snapshots-${month}.json`), JSON.stringify({ schemaVersion: 1, snapshots }, null, 2))
  }
  if (runs.length) {
    await writeFile(join(dataRoot, 'runs.json'), JSON.stringify({ schemaVersion: 1, runs }, null, 2))
  }
  return new AnalyticsHost({
    workspacePath,
    publisher: publisher(accounts),
    spokenVideo: null,
    now: () => new Date('2026-06-15T00:00:00.000Z'),
  })
}

test('从未采集过的账号仍是 never，粉丝为 null', async () => {
  const host = await mkHost({ accounts: [{ id: 'a1', platform: 'bilibili', nickname: 'A' }] })
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].collectionStatus, 'never')
  assert.equal(res.items[0].lastCollectedAt, null)
  assert.equal(res.items[0].followers, null)
  assert.equal(res.items[0].followersNetGain, null)
})

test('有新鲜快照即 ok，lastCollectedAt 取快照时间', async () => {
  const host = await mkHost({
    accounts: [{ id: 'a1', platform: 'bilibili' }],
    snapshots: [{ accountId: 'a1', collectedAt: '2026-06-15T00:00:00.000Z', date: '2026-06-15', followers: 1200 }],
  })
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].collectionStatus, 'ok')
  assert.equal(res.items[0].lastCollectedAt, '2026-06-15T00:00:00.000Z')
  assert.equal(res.items[0].followers, 1200)
})

test('快照超过 24h 变 stale，超过一个月的快照也判 stale 而不是失效', async () => {
  const host = await mkHost({
    accounts: [{ id: 'a1', platform: 'bilibili' }],
    snapshots: [{ accountId: 'a1', collectedAt: '2026-06-10T00:00:00.000Z', date: '2026-06-10', followers: 1000 }],
  })
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].collectionStatus, 'stale')
})

test('登录过期的账号优先报 expired，而不是 failed 或 ok', async () => {
  const host = await mkHost({
    accounts: [{ id: 'a1', platform: 'bilibili', status: 'expired' }],
    snapshots: [{ accountId: 'a1', collectedAt: '2026-06-15T00:00:00.000Z', date: '2026-06-15', followers: 1000 }],
    runs: [{ runId: 'r1', startedAt: '2026-06-15T00:00:00.000Z', failures: [{ accountId: 'a1', code: 'PUBLISHER_ACCOUNT_BUSY' }] }],
  })
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].collectionStatus, 'expired')
})

test('最近一次 run 里失败即 failed，lastError 是中文文案而非原始错误', async () => {
  const host = await mkHost({
    accounts: [{ id: 'a1', platform: 'bilibili' }],
    runs: [{ runId: 'r1', startedAt: '2026-06-15T00:00:00.000Z', failures: [{ accountId: 'a1', code: 'PUBLISHER_ACCOUNT_BUSY' }] }],
  })
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].collectionStatus, 'failed')
  assert.equal(res.items[0].lastError, '账号正被其他任务占用，稍后重试')
  assert.ok(!/PUBLISHER_|Error:/.test(String(res.items[0].lastError)))
})

test('未知失败码不泄露内部信息', async () => {
  const host = await mkHost({
    accounts: [{ id: 'a1', platform: 'bilibili' }],
    runs: [{ runId: 'r1', startedAt: '2026-06-15T00:00:00.000Z', failures: [{ accountId: 'a1', code: 'WEIRD_INTERNAL_CODE' }] }],
  })
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].lastError, '采集失败，原因未记录')
})

test('失败只影响对应账号，其他账号不受牵连', async () => {
  const host = await mkHost({
    accounts: [{ id: 'a1', platform: 'bilibili' }, { id: 'a2', platform: 'bilibili' }],
    snapshots: [{ accountId: 'a2', collectedAt: '2026-06-15T00:00:00.000Z', date: '2026-06-15', followers: 5 }],
    runs: [{ runId: 'r1', startedAt: '2026-06-15T00:00:00.000Z', failures: [{ accountId: 'a1', code: 'PUBLISHER_ACCOUNT_TIMEOUT' }] }],
  })
  const res = await host.accounts(RANGE)
  const byId = Object.fromEntries(res.items.map((row) => [row.accountId, row]))
  assert.equal(byId.a1.collectionStatus, 'failed')
  assert.equal(byId.a2.collectionStatus, 'ok')
})

test('store 读失败时退化成 never，不让账号页整页报错', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'an-host-broken-'))
  const host = new AnalyticsHost({
    workspacePath,
    publisher: publisher([{ id: 'a1', platform: 'bilibili' }]),
    spokenVideo: null,
    now: () => new Date('2026-06-15T00:00:00.000Z'),
  })
  // 写坏分片文件，读取应当被 .catch 吞掉。
  const dataRoot = join(workspacePath, 'data', 'metrics')
  await mkdir(dataRoot, { recursive: true })
  await writeFile(join(dataRoot, 'accounts-snapshots-2026-06.json'), '{ not json')
  const res = await host.accounts(RANGE)
  assert.equal(res.items[0].collectionStatus, 'never')
})
