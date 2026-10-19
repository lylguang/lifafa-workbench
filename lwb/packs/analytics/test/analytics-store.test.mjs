import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalyticsStore } from '../analytics-store.mjs'
import { bindByTitle, matchTitle, normalizeManualBinding, normalizeTitle, remoteIdFromUrl } from '../analytics-bind.mjs'

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'analytics-store-'))
  try {
    await run(new AnalyticsStore({ dataRoot: dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('账号快照按月分片，且同一自然日同账号只保留最后一次', async () => {
  await withStore(async (store) => {
    // 同一本地自然日的两次采集（10:00 与 22:00 本地时间），后一次覆盖前一次。
    const morning = new Date(2026, 2, 1, 10, 0, 0)
    const evening = new Date(2026, 2, 1, 22, 0, 0)
    await store.saveAccountSnapshot({ accountId: 'a1', platform: 'bilibili', date: morning.toISOString(), followers: 100 })
    await store.saveAccountSnapshot({ accountId: 'a1', platform: 'bilibili', date: evening.toISOString(), followers: 150 })
    const rows = await store.listAccountSnapshots(['2026-03'])
    assert.equal(rows.length, 1, '同日覆盖而非追加')
    assert.equal(rows[0].followers, 150)
  })
})

test('跨本地自然日的两次采集分属两天，都保留（时区按本地日切分）', async () => {
  await withStore(async (store) => {
    // UTC 22:00 在 UTC+8 已是次日 06:00：按本地日切分才算「两天」，
    // 这正是快照分桶必须用本地时区而不是 UTC 的原因。
    await store.saveAccountSnapshot({ accountId: 'a1', date: '2026-03-01T10:00:00Z', followers: 100 })
    await store.saveAccountSnapshot({ accountId: 'a1', date: '2026-03-01T22:00:00Z', followers: 150 })
    const rows = await store.listAccountSnapshots(['2026-03'])
    assert.equal(rows.length, 2, '本地日不同就都留')
  })
})

test('跨月分片各自独立，历史不丢', async () => {
  await withStore(async (store) => {
    await store.saveAccountSnapshot({ accountId: 'a1', date: '2026-02-15T10:00:00Z', followers: 80 })
    await store.saveAccountSnapshot({ accountId: 'a1', date: '2026-03-15T10:00:00Z', followers: 120 })
    assert.equal((await store.listAccountSnapshots(['2026-02']))[0].followers, 80)
    assert.equal((await store.listAccountSnapshots(['2026-03']))[0].followers, 120)
  })
})

test('内容元数据与绑定关系持久化，bound 由 remoteId/remoteUrl 推导', async () => {
  await withStore(async (store) => {
    await store.saveContents([{ contentId: 'j1', title: 'A', accountId: 'a1', platform: 'bilibili' }])
    let row = await store.getContent('j1')
    assert.equal(row.bound, false, '没绑定就是 false')
    await store.saveContents([{ contentId: 'j1', remoteId: 'BV1xx', remoteUrl: 'https://www.bilibili.com/video/BV1xx' }])
    row = await store.getContent('j1')
    assert.equal(row.bound, true)
    assert.equal(row.remoteId, 'BV1xx')
  })
})

test('一次误清不抹掉已确认的绑定关系', async () => {
  await withStore(async (store) => {
    await store.saveContents([{ contentId: 'j1', remoteId: 'BV1', remoteUrl: 'https://www.bilibili.com/video/BV1' }])
    await store.saveContents([{ contentId: 'j1', title: '新标题' }])
    const row = await store.getContent('j1')
    assert.equal(row.remoteId, 'BV1', '绑定只增不减')
    assert.equal(row.title, '新标题')
  })
})

test('作品最新值 manual 无条件优先于 collector', async () => {
  await withStore(async (store) => {
    await store.saveContents([{ contentId: 'j1', title: 'A' }])
    await store.saveContentMetrics({ contentId: 'j1', date: '2026-03-01', collectedAt: '2026-03-01T10:00:00Z', metrics: { views: 100 } })
    await store.saveContentMetrics({ contentId: 'j1', date: '2026-03-02', collectedAt: '2026-03-02T10:00:00Z', metrics: { views: 200 } })
    let detail = await store.contentDetail('j1')
    assert.equal(detail.metrics.views, 200, '同为 collector 时取最新')
    // 手动补录一条更早时间的记录，也应压过采集值（§4.2-8 manual 优先）
    await store.saveContentMetrics({ contentId: 'j1', date: '2026-03-03', collectedAt: '2026-03-03T10:00:00Z', metrics: { views: 5 }, source: 'manual' })
    detail = await store.contentDetail('j1')
    assert.equal(detail.metrics.views, 5)
    assert.equal(detail.source, 'manual')
  })
})

test('missing 指标保持 null，不被回填成 0', async () => {
  await withStore(async (store) => {
    await store.saveContents([{ contentId: 'j1', title: 'A' }])
    await store.saveContentMetrics({ contentId: 'j1', date: '2026-03-01', metrics: { views: 10 } })
    const detail = await store.contentDetail('j1')
    assert.equal(detail.metrics.views, 10)
    assert.equal(detail.metrics.likes, null, '没采集到的字段是 null')
  })
})

test('标题归一：全角、话题标签、装饰符号差异不影响匹配', () => {
  assert.equal(normalizeTitle('【实测】B站标题！！'), normalizeTitle('实测B站标题'))
  assert.equal(normalizeTitle('标题 #话题 tag'), normalizeTitle('标题'))
})

test('标题重复时不自动绑定，一律判为歧义进待绑定', () => {
  const candidates = [
    { title: '同名视频', remoteId: 'A', remoteUrl: 'https://www.bilibili.com/video/A' },
    { title: '同名视频', remoteId: 'B', remoteUrl: 'https://www.bilibili.com/video/B' },
  ]
  const result = matchTitle('同名视频', candidates)
  assert.equal(result.status, 'ambiguous', '同名多条绝不自动选一条')
  assert.equal(result.candidates.length, 2)
})

test('唯一匹配才绑定，且绑定带策略标记', () => {
  const works = [{ title: '目标视频', remoteId: 'BV1', remoteUrl: 'https://www.bilibili.com/video/BV1' }]
  const { matched, unmatched } = bindByTitle([{ contentId: 'j1', title: '目标视频', accountId: 'a1' }], works)
  assert.equal(matched.length, 1)
  assert.equal(matched[0].remoteId, 'BV1')
  assert.equal(matched[0].bindStrategy, 'title-match')
  assert.equal(unmatched.length, 0)
})

test('无匹配与歧义都进待绑定，不静默绑错', () => {
  const works = [{ title: '别的视频', remoteId: 'BV2' }]
  const { matched, unmatched } = bindByTitle([
    { contentId: 'j1', title: '找不到的视频' },
    { contentId: 'j2', title: '别的视频' },
  ], works)
  assert.equal(matched.length, 1, '唯一匹配的 j2 绑定成功')
  assert.equal(unmatched.length, 1)
  assert.equal(unmatched[0].contentId, 'j1')
  assert.equal(unmatched[0].reason, 'no-match')
})

test('人工绑定校验：至少给一个标识，URL 必须是 http(s)', () => {
  assert.equal(normalizeManualBinding({}), null)
  assert.equal(normalizeManualBinding({ remoteUrl: 'javascript:alert(1)' }), null)
  const ok = normalizeManualBinding({ remoteUrl: 'https://www.bilibili.com/video/BV1' })
  assert.equal(ok.remoteId, 'BV1', '能从 URL 抠出 id')
})

test('从作品 URL 抠平台 id，抠不出返回 null', () => {
  assert.equal(remoteIdFromUrl('https://www.bilibili.com/video/BV1xx411c7mD'), 'BV1xx411c7mD')
  assert.equal(remoteIdFromUrl('https://example.com/manage'), null)
})
