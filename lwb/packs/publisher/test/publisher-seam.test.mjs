import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { PublisherStore } from '../publisher-store.mjs'
import { PublisherHost } from '../publisher-host.mjs'

/**
 * Tests for the `withAccountPage` seam that lends an account's browser page to
 * the analytics collector (数据看板 §P2 前置).
 *
 * The Chrome profile under `chrome-profiles/<accountId>` is single-instance, so
 * the collector must borrow the publisher's session instead of opening its own.
 * These cover what QA froze as acceptance: exception passthrough, busy never
 * leaking, forced page close on timeout, `allowExpired` default, and the
 * evidence namespace staying clear of the publish tree.
 *
 * Everything runs offline: a stub browser replaces Chrome, and no test may
 * depend on ffmpeg, Python or Windows symlink permissions.
 */

async function withHost(run, { browser: override } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-seam-'))
  try {
    const store = new PublisherStore({ workspacePath: dir })
    const browser = override || stubBrowser()
    const host = new PublisherHost({ store, browser, workspacePath: dir })
    await run({ store, host, browser, dir })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

/** A browser stub with the same surface the host uses, plus call recording. */
function stubBrowser({ pageImpl } = {}) {
  const calls = { acquired: [], closed: [], touched: [] }
  const session = { context: { pages: () => [stubPage(pageImpl)] } }
  return {
    calls,
    sessions: new Map(),
    async status() { return { ready: true, playwright: '0.0.0-test', executable: 'C:/chrome.exe', headless: false, openSessions: 0 } },
    isOpen() { return false },
    async acquire(account) {
      calls.acquired.push({ id: account.id })
      session.context.pages = () => [stubPage(pageImpl)]
      // The real pool registers the live session here; evidence capture looks
      // the page up through `sessions`, so a stub that skips this returns null.
      this.sessions.set(account.id, session)
      return session
    },
    async page(sess) { return sess.context.pages()[0] },
    touch(id) { calls.touched.push(id) },
    async close(id) { calls.closed.push(id); this.sessions.delete(id); return true },
    async closeAll() {},
  }
}

function stubPage(pageImpl) {
  return {
    isClosed() { return false },
    setDefaultTimeout() {},
    async screenshot() { return Buffer.from('png-bytes') },
    ...(pageImpl || {}),
  }
}

async function activeAccount(store) {
  const account = await store.createAccount({ platform: 'bilibili', label: 'B站·主号' })
  return store.patchAccountState(account.id, { status: 'active' })
}

test('withAccountPage 借出的页面带齐账号、平台、context 与 signal，返回值原样透传', async () => {
  await withHost(async ({ store, host }) => {
    const account = await activeAccount(store)
    const result = await host.withAccountPage(account.id, async (loan) => {
      assert.equal(loan.accountId, account.id)
      assert.equal(loan.platform, 'bilibili')
      assert.equal(loan.status, 'active')
      assert.ok(loan.page, '必须给出可操作的 Page')
      assert.ok(loan.context, '必须给出 BrowserContext 以便开新标签/拦截请求')
      assert.ok(loan.signal instanceof AbortSignal, '必须给出 AbortSignal 以便超时中断')
      assert.equal(typeof loan.evidence, 'function', '必须给出证据留证入口')
      return { done: true }
    })
    assert.deepEqual(result, { done: true }, 'fn 的返回值必须原样透传')
  })
})

test('异常穿透保真：fn 抛出的调用方错误码不被改写，busy 仍被清干净', async () => {
  await withHost(async ({ store, host, browser }) => {
    const account = await activeAccount(store)
    // The collector's own selector failure must reach the caller byte-for-byte;
    // wrapping it in a PUBLISHER_* code would make a platform-page change look
    // like a publisher bug.
    const thrown = Object.assign(new Error('选择器没命中，已留存截图'), { code: 'ANALYTICS_COLLECTOR_SELECTOR_MISSING' })
    await assert.rejects(
      () => host.withAccountPage(account.id, async () => { throw thrown }),
      (error) => {
        assert.equal(error.code, 'ANALYTICS_COLLECTOR_SELECTOR_MISSING', '调用方错误码不得被改写')
        assert.equal(error.message, '选择器没命中，已留存截图')
        return true
      },
    )
    assert.equal(host.busy.has(account.id), false, '抛异常后不得残留 busy 标记')
    assert.ok(browser.calls.closed.includes(account.id), '借出的页面必须由 publisher 关闭')
  })
})

test('busy 不泄漏：抛异常、提前 return、正常完成三条路径都能立刻再次借到同一账号', async () => {
  await withHost(async ({ store, host }) => {
    const account = await activeAccount(store)
    // These are the only paths that could leave an account permanently "busy"
    // — the single worst failure this seam can have.
    await assert.rejects(() => host.withAccountPage(account.id, async () => { throw new Error('boom') }))
    await host.withAccountPage(account.id, async () => 'early-return')
    await host.withAccountPage(account.id, async () => 'normal')
    assert.equal(host.busy.has(account.id), false)
  })
})

test('busy 撞车快速失败：账号正被占用时抛 PUBLISHER_ACCOUNT_BUSY，不排队不等待', async () => {
  await withHost(async ({ store, host }) => {
    const account = await activeAccount(store)
    await host.withAccountPage(account.id, async () => {
      await assert.rejects(
        () => host.withAccountPage(account.id, async () => 'never-reached'),
        (error) => { assert.equal(error.code, 'PUBLISHER_ACCOUNT_BUSY'); return true },
      )
    })
  })
})

test('账号不存在抛 PUBLISHER_NOT_FOUND，不落 busy 标记', async () => {
  await withHost(async ({ store, host }) => {
    await assert.rejects(
      () => host.withAccountPage('00000000-0000-4000-8000-000000000000', async () => 'never'),
      (error) => { assert.equal(error.code, 'PUBLISHER_NOT_FOUND'); return true },
    )
  })
})

test('allowExpired 默认关闭：借已过期账号抛 PUBLISHER_ACCOUNT_EXPIRED 且不产生任何副作用', async () => {
  await withHost(async ({ store, host, browser }) => {
    const account = await store.createAccount({ platform: 'douyin', label: '抖音·过期' })
    await store.patchAccountState(account.id, { status: 'expired' })
    await assert.rejects(
      () => host.withAccountPage(account.id, async () => 'never'),
      (error) => { assert.equal(error.code, 'PUBLISHER_ACCOUNT_EXPIRED'); return true },
    )
    assert.equal(browser.calls.acquired.length, 0, '被拒的借用不得真的去开浏览器')
    assert.equal(host.busy.has(account.id), false)
  })
})

test('allowExpired:true 才借已过期账号，登录态探测由调用方自检后决定', async () => {
  await withHost(async ({ store, host }) => {
    const account = await store.createAccount({ platform: 'douyin', label: '抖音·过期' })
    await store.patchAccountState(account.id, { status: 'expired' })
    const status = await host.withAccountPage(account.id, async (loan) => loan.status, { allowExpired: true })
    assert.equal(status, 'expired', '允许借用后如实回传当时的账号状态快照，供调用方自检登录页')
  })
})

test('超时强杀：abort 后借出的页面被关闭、busy 清空，账号可立即再次借出', async () => {
  await withHost(async ({ store, host, browser }) => {
    const account = await activeAccount(store)
    let aborted = false
    // A page operation that never settles: the seam must not hang forever, and
    // the timeout path is the one most likely to skip its finally block.
    await assert.rejects(
      () => host.withAccountPage(account.id, (loan) => new Promise((resolve, reject) => {
        loan.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
      }), { timeoutMs: 40 }),
      () => true,
    )
    assert.equal(aborted, true, '到期必须 abort 信号')
    assert.ok(browser.calls.closed.includes(account.id), '超时后借出的页面必须被关闭')
    assert.equal(host.busy.has(account.id), false, '超时路径不得残留 busy 标记')
    const again = await host.withAccountPage(account.id, async () => 'reusable')
    assert.equal(again, 'reusable', '超时后账号必须仍可再次借出')
  })
})

test('evidence 落在 collection/ 命名空间，不与发布的 evidence/ 混用', async () => {
  await withHost(async ({ store, host, dir }) => {
    const account = await activeAccount(store)
    const relative = await host.withAccountPage(account.id, async (loan) => loan.evidence('overview'))
    assert.ok(relative, '证据必须留证成功')
    assert.equal(relative.relativePath.startsWith(`collection${sep}${account.id}${sep}`), true, `证据路径必须以 collection/<id>/ 开头，实际 ${relative.relativePath}`)
    assert.equal(relative.relativePath.includes(`evidence${sep}${account.id}`), false, '不得落进发布的 evidence/ 树')
    assert.equal(relative.mediaType, 'image/png')
    assert.equal(relative.bytes, Buffer.from('png-bytes').length, '回传字节数而不是裸 bytes')
    const info = await stat(join(dir, 'data', relative.relativePath))
    assert.ok(info.isFile(), '证据必须真的落盘')
  })
})

test('evidence 归属校验：伪造别人的采集标识取不到证据', async () => {
  await withHost(async ({ store, host }) => {
    const account = await activeAccount(store)
    const relative = await host.withAccountPage(account.id, async (loan) => loan.evidence('overview'))
    const stolen = relative.relativePath.replace(`collection${sep}${account.id}${sep}`, `collection${sep}00000000-0000-4000-8000-000000000000${sep}`)
    await assert.rejects(
      () => store.readCollectionEvidence('00000000-0000-4000-8000-000000000000', stolen),
      (error) => { assert.equal(error.code, 'PUBLISHER_NOT_FOUND'); return true },
    )
    const own = await store.readCollectionEvidence(account.id, relative.relativePath)
    assert.equal(own.data.toString(), 'png-bytes')
  })
})

test('非函数任务被拒，且不会留下 busy 标记', async () => {
  await withHost(async ({ store, host }) => {
    const account = await activeAccount(store)
    await assert.rejects(
      () => host.withAccountPage(account.id, 'not-a-function'),
      (error) => { assert.equal(error.code, 'PUBLISHER_INVALID_INPUT'); return true },
    )
    assert.equal(host.busy.has(account.id), false)
  })
})

test('复用现有 busy 判定：借阅期间该账号对发布链路同样显示为忙', async () => {
  await withHost(async ({ store, host }) => {
    const account = await activeAccount(store)
    // Two gates would drift apart: this is what proves the seam shares the one
    // `busy` set rather than adding a second lock of its own.
    await host.withAccountPage(account.id, async () => {
      await assert.rejects(
        () => host.checkAccount(account.id),
        (error) => { assert.equal(error.code, 'PUBLISHER_ACCOUNT_BUSY'); return true },
      )
    })
    const listed = await host.listAccounts()
    assert.equal(listed[0].busy, false, '借用结束后不得残留忙标记')
  })
})
