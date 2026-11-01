import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { useProcessScratch } from '../../../test-utils/scratch-temp.mjs'
import { PublisherStore } from '../publisher-store.mjs'
import { PublisherHost } from '../publisher-host.mjs'

const NOW = () => '2026-10-02T00:00:00.000Z'

async function withStore(run) {
  // 进程隔离的 scratch：每进程一份 unit-<pid> 子目录，退出只清自己那份，
  // 不会像共享目录那样按前缀误删别的进程的临时工作区。
  const base = useProcessScratch()
  const dir = await mkdtemp(join(base, 'lwb-publisher-login-'))
  try { await run(new PublisherStore({ workspacePath: dir }), dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

/* 真实抖音适配器只通过 page 的几个方法判断登录态（见 isLoggedIn）：
 *   - url() 命中 /login|passport|sso/ → 明确未登录
 *   - loggedIn 选择器命中 → 已登录
 *   - 否则看 loggedOut 是否命中、URL 是否 creator-micro
 *   - 连 page.locator 都调不动（页面没加载完 / 网络抖动）→ 抛错 = 不可达
 * 所以只要给不同的假 page，就能把「抛错 / 明确未登录 / 已登录」三种结果都逼出来，
 * 而不用真的开 Chrome、也不用碰真实站点。 */

function nonMatchingLocator() {
  return { first: () => ({ async waitFor() {}, async count() { return 0 }, async isVisible() { return false } }) }
}

// isLoggedIn 第一步就会 page.goto + waitForTimeout，再读 url()；这里都给成空操作，
// 让 URL 由我们提供的 url() 决定，避免真的去碰抖音站点。
function nav(page) {
  return { goto: async () => {}, waitForTimeout: async () => {}, ...page }
}

// 平台不可达：页面第一行 page.goto 就抛错（模拟页面根本没加载出来 / 网络抖动），
// 不是「已退出登录」。抛错发生在 firstMatch 的 try/catch 之外，isLoggedIn 会冒泡出来，
// checkAccount / confirmLogin 据此判断「暂无法确认」而非「未登录」。
function unreachablePage() {
  return {
    goto: async () => { throw new Error('net::ERR_CONNECTION_RESET') },
    waitForTimeout: async () => {},
    url: () => 'https://creator.douyin.com/creator-micro/home',
    locator: () => { throw new Error('net::ERR_CONNECTION_RESET') },
  }
}

// 明确未登录：URL 命中登录路径 → isLoggedIn 直接返回 false。
function loggedOutPage() {
  return nav({ url: () => 'https://creator.douyin.com/login', locator: nonMatchingLocator })
}

// 已登录：非登录 URL + creator-micro，且无登录墙命中。
function loggedInPage() {
  return nav({ url: () => 'https://creator.douyin.com/creator-micro/home', locator: nonMatchingLocator })
}

// 首次读到 false（页面还在跳转/扫码落地中），随后读到 true：模拟瞬时误判自愈。
function flipToLoggedInPage() {
  let n = 0
  return nav({
    url: () => (n++ === 0 ? 'https://creator.douyin.com/login' : 'https://creator.douyin.com/creator-micro/home'),
    locator: nonMatchingLocator,
  })
}

function fakeBrowser(pageInstance, { sessions = new Map() } = {}) {
  const closed = []
  const acquired = []
  return {
    closed,
    acquired,
    sessions,
    async status() { return { ready: true, playwright: 'test', executable: 'x', headless: false, openSessions: 0 } },
    isOpen() { return false },
    async acquire(account, options) {
      acquired.push({ id: account.id, headless: options?.headless })
      const session = { context: {}, accountId: account.id, headless: options?.headless }
      this.sessions.set(account.id, session)
      return session
    },
    async page() { return pageInstance },
    touch() {},
    async close(id) { closed.push(id); this.sessions.delete(id); return true },
    async closeAll() {},
  }
}

/* ----------------------------- 1. 异常 ≠ 未登录 ----------------------------- */

test('isLoggedIn 抛错时账号保留原状态、标 unreachable，绝不写 expired', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(unreachablePage()), workspacePath: dir, now: NOW })

    const result = await host.checkAccount(account.id)
    assert.equal(result.unreachable, true, 'isLoggedIn 抛错应判为不可达而非未登录')
    assert.equal(result.loggedIn, null, '不可达时 loggedIn 应为 null（不是 false）')

    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'active', '不可达时保留原状态，不写成 expired')
    assert.match(after.lastError || '', /暂无法确认/u, '不可达的 lastError 应是「暂无法确认」类文案')
    assert.ok(!/登录态已失效/u.test(after.lastError || ''), '不可达的 lastError 不应是「登录态已失效」')
  })
})

/* --------------------------- 2. 明确未登录才改 expired --------------------------- */

test('isLoggedIn 明确返回 false 才写 expired 并提示重新扫码', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(loggedOutPage()), workspacePath: dir, now: NOW })

    const result = await host.checkAccount(account.id)
    assert.equal(result.loggedIn, false, '明确未登录应返回 false')

    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'expired', '只有明确的未登录结论才改 expired')
    assert.match(after.lastError || '', /重新扫码|登录态已失效/u, 'expired 应给出重新扫码文案')
  })
})

/* ------------------- 3. 源码防回归：抖音适配器不再用宽选择器 ------------------- */

test('抖音适配器源码里不再用 [class*="login"] 这类宽选择器误判登录态', async () => {
  const source = readFileSync(new URL('../publisher-adapter-douyin.mjs', import.meta.url), 'utf8')
  // 真实选择器只可能是 '...' 或 "..." 包裹的字符串；注释里用反引号提到它不算。
  assert.equal(
    /['"][class\*="login"]['"]/.test(source),
    false,
    '源码里不应再出现把 class 含 login 的元素当未登录信号的宽选择器（注释中的反引号提及除外）',
  )
})

/* ----------------- 4. 检测登录不一次定生死，且不动可见扫码会话 ----------------- */

test('confirmLogin 不再「一次 false 就写 expired」，且不会关掉还开着的扫码窗口', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })

    // 扫码窗口还开着：先放一个可见会话（headless:false）在浏览器里。
    const sessions = new Map()
    sessions.set(account.id, { context: { __closed: false }, accountId: account.id, headless: false })
    const browser = fakeBrowser(flipToLoggedInPage(), { sessions })

    const host = new PublisherHost({ store, browser, workspacePath: dir, now: NOW })
    const result = await host.confirmLogin(account.id)

    // 瞬时读到一次 false（页面跳转中）经重试自愈 → 成功，不应写 expired。
    assert.equal(result.loggedIn, true, '一次 false 后重试读到已登录，应判为成功而非 expired')
    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'active', '瞬时误判不应把账号标成 expired')

    // 复用可见会话（headless:false），而不是强制无头去抢那个窗口。
    assert.equal(browser.acquired[0]?.headless, false, '存在可见扫码会话时应复用（headless:false）')
    assert.equal(browser.closed.includes(account.id), false, '不应在扫码窗口还开着时关掉可见会话')
  })
})

test('confirmLogin 连续三次都读不到登录证据才判 expired（明确未登录仍会失效，区别于不可达）', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(loggedOutPage()), workspacePath: dir, now: NOW })

    const result = await host.confirmLogin(account.id)
    assert.equal(result.loggedIn, false, '三轮都明确未登录应判为未登录')
    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'expired', '三次都未登录才写 expired（区别于「一次 false 就定生死」）')
  })
})

/* ----------------- 5. 保活巡检：不可达不计入 expired、不动状态 ----------------- */

test('保活巡检：平台不可达的账号不计入 expired、不动状态', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(unreachablePage()), workspacePath: dir, now: NOW })

    const summary = await host.keepAliveActiveAccounts()
    assert.equal(summary.checked, 1)
    assert.equal(summary.active, 0, '不可达不计为在线')
    assert.equal(summary.expired, 0, '不可达不计入 expired')

    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'active', '不可达的账号状态保持原样')
  })
})

test('保活巡检：只有明确未登录的账号才计入 expired（与不可达区分开）', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(loggedOutPage()), workspacePath: dir, now: NOW })

    const summary = await host.keepAliveActiveAccounts()
    assert.equal(summary.checked, 1)
    assert.equal(summary.expired, 1, '明确未登录应计为需要重新登录')
    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'expired', '明确未登录才会改 expired，证明不可达那条不是「巡检永不失效」')
  })
})

/* ---------------- 6. 结构化口径：unreadable 绝不能被写成 expired ---------------- */

test('confirmLogin 读不到登录状态时返回 loginCheck:unreadable，绝不写成 expired', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(unreachablePage()), workspacePath: dir, now: NOW })

    const result = await host.confirmLogin(account.id)
    assert.equal(result.loginCheck, 'unreadable', '读不到应结构化标记为 unreadable')
    assert.equal(result.unreachable, true, 'unreadable 应同时保留 unreachable 兼容布尔')
    assert.equal(result.loggedIn, null, 'unreadable 时 loggedIn 为 null（不是 false）')

    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'active', 'unreadable 绝不写成 expired，原状态保留')
    assert.ok(!/扫码后仍未检测到登录/u.test(after.lastError || ''), 'unreadable 的 lastError 不应是「扫码后仍未检测到登录」这种已明确未登录的文案')
  })
})

test('confirmLogin 明确未登录时 loginCheck:expired 且只给原因句（无引导）', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(loggedOutPage()), workspacePath: dir, now: NOW })

    const result = await host.confirmLogin(account.id)
    assert.equal(result.loginCheck, 'expired', '三次都明确未登录应标记 expired')
    assert.equal(result.loggedIn, false)
    assert.equal(result.message, '扫码后仍未检测到登录', '消息只给原因句，不含「请重新扫码」之类的引导')
    assert.ok(!/请|重新扫码|再点一次/u.test(result.message), '原因句不应夹带下一步引导')
    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'expired')
    assert.equal(after.lastError, '扫码后仍未检测到登录')
  })
})

/* ---------------- 7. 账号库坏行：可见提示 + 计数，不被静默吞掉 ---------------- */

test('账号库坏行（非 UUID 标识）被忽略时给出可见提示与计数，而非静默消失', async () => {
  await withStore(async (store, dir) => {
    const good = await store.createAccount({ platform: 'douyin', label: '好账号' })
    // 手工塞一条坏记录：id 不是 UUID，accountRecord 的 identifier() 会抛。
    const brokenId = 'not-a-uuid'
    const accountsFile = join(dir, 'data', 'accounts.json')
    const existing = JSON.parse(await readFile(accountsFile, 'utf8'))
    existing.accounts.push({
      id: brokenId, platform: 'douyin', label: '坏账号', status: 'expired',
      profileDir: `chrome-profiles/${brokenId}`, createdAt: NOW(), updatedAt: NOW(),
    })
    await writeFile(accountsFile, JSON.stringify(existing), 'utf8')

    const notices = []
    const logs = []
    const noticedStore = new PublisherStore({
      workspacePath: dir,
      onNotice: (kind, message) => notices.push({ kind, message }),
      onLog: (kind, message) => logs.push({ kind, message }),
    })
    const accounts = await noticedStore.listAccounts()
    assert.equal(accounts.length, 1, '坏行不应出现在列表里，但应被计数而非静默消失')
    assert.equal(accounts[0].id, good.id, '好账号仍在')

    const notice = notices.find((entry) => /损坏|忽略/u.test(entry.message))
    assert.ok(notice, '应有一条用户可见提示提到损坏记录')
    assert.match(notice.message, /1 条记录已损坏/u, '提示应含被丢弃的行数')
    assert.ok(notice.message.includes(brokenId), '提示应点名被丢弃的标识')

    const log = logs.find((entry) => /已忽略|损坏/u.test(entry.message))
    assert.ok(log, '应有一条日志提到损坏记录')
    assert.match(log.message, /已忽略 1 条损坏的账号记录/u, '日志应含被丢弃的行数')
  })
})

/* ---------------- 8. 批量巡检：本轮 unreadable 计数随结果返回 ---------------- */

test('保活巡检：本轮有不可达账号时把 unreadable 计数随结果返回', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(unreachablePage()), workspacePath: dir, now: NOW })

    const summary = await host.keepAliveActiveAccounts()
    assert.equal(summary.checked, 1)
    assert.equal(summary.unreadable, 1, '本轮不可达的账号应计入 unreadable')
    assert.equal(summary.expired, 0, '不可达不计入 expired')
    assert.equal(summary.active, 0, '不可达不计为在线')

    const after = await store.getAccount(account.id)
    assert.equal(after.status, 'active', '不可达的账号状态保持原样')
  })
})

/* -------- 9. loginCheck 落在账号记录上 + status() 带出本轮计数 -------- */

test('loginCheck 写进账号记录：三种检测结果都能从 listAccounts 读到，界面不用嗅探措辞', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })

    await new PublisherHost({ store, browser: fakeBrowser(unreachablePage()), workspacePath: dir, now: NOW }).checkAccount(account.id)
    assert.equal((await store.listAccounts())[0].loginCheck, 'unreadable', '读不到时记录上应带 loginCheck:unreadable')

    await new PublisherHost({ store, browser: fakeBrowser(loggedOutPage()), workspacePath: dir, now: NOW }).checkAccount(account.id)
    assert.equal((await store.listAccounts())[0].loginCheck, 'expired', '明确未登录时记录上应带 loginCheck:expired')

    await new PublisherHost({ store, browser: fakeBrowser(loggedInPage()), workspacePath: dir, now: NOW }).checkAccount(account.id)
    assert.equal((await store.listAccounts())[0].loginCheck, 'active', '读到已登录时记录上应带 loginCheck:active')
  })
})

test('老账号记录没有 loginCheck 时降级为 null，界面退回读 lastError 也不会被判成无效', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    const accountsFile = join(dir, 'data', 'accounts.json')
    const existing = JSON.parse(await readFile(accountsFile, 'utf8'))
    // 这个版本存的就是加字段之前的记录：完全没有 loginCheck。
    existing.accounts = existing.accounts.map((item) => ({ id: item.id, platform: item.platform, label: item.label, status: item.status, profileDir: item.profileDir, createdAt: item.createdAt, updatedAt: item.updatedAt }))
    await writeFile(accountsFile, JSON.stringify(existing), 'utf8')

    const [legacy] = await store.listAccounts()
    assert.equal(legacy.id, account.id, '没有 loginCheck 的老记录不该被当成坏行丢掉')
    assert.equal(legacy.loginCheck, null, '缺字段降级为 null（界面退回前缀兜底）')
  })
})

test('status() 带出本轮 unreadable 计数与上次巡检摘要，界面才有「N 个本轮没读到」可说', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: '测试号' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: fakeBrowser(unreachablePage()), workspacePath: dir, now: NOW })

    assert.equal((await host.status()).loginScan, null, '第一次巡检前不该有摘要')

    await host.keepAliveActiveAccounts()
    const status = await host.status()
    assert.equal(status.counts.unreadable, 1, 'status 应给出当前 loginCheck=unreadable 的账号数')
    assert.equal(status.loginScan.unreadable, 1, 'status 应带上上次巡检的 unreadable 计数')
    assert.equal(status.loginScan.checked, 1)
    assert.equal(status.counts.active, 1, '不可达的账号状态仍是 active，可用数不该掉')
  })
})

