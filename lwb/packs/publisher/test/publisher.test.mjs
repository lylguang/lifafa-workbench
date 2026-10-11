import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PublisherStore, defaultProfileDir, platformLabel, ADAPTER_PLATFORMS } from '../publisher-store.mjs'
import { PublisherHost } from '../publisher-host.mjs'
import { resolveBrowserExecutable } from '../publisher-browser.mjs'
import {
  DEFAULT_AI_DECLARATION,
  DOUYIN_TITLE_LIMIT,
  resolveDeclaration,
  truncateForDouyin,
  coverRatioWarning,
  pickCoverSlots,
  readCoverVerdict,
  waitForUploadComplete,
} from '../publisher-adapter-douyin.mjs'

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-publisher-'))
  try { await run(new PublisherStore({ workspacePath: dir }), dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

/** A browser stub: no Chrome, but the same surface the host uses. */
function stubBrowser() {
  const calls = { acquired: [], closed: [], screenshots: 0 }
  return {
    calls,
    sessions: new Map(),
    async status() { return { ready: true, playwright: '0.0.0-test', executable: 'C:/chrome.exe', headless: false, openSessions: 0 } },
    isOpen() { return false },
    async acquire(account, options) { calls.acquired.push({ id: account.id, headless: options?.headless }); return { context: {}, accountId: account.id } },
    async page() {
      return {
        async screenshot() { calls.screenshots += 1; return Buffer.from('png') },
      }
    },
    touch() {},
    async close(id) { calls.closed.push(id); return true },
    async closeAll() {},
  }
}

test('platform labels are stable and unknown platforms render as-is', () => {
  assert.equal(platformLabel('douyin'), '抖音')
  assert.equal(platformLabel('wechat'), '视频号')
  assert.equal(platformLabel('mystery'), 'mystery')
})

test('every adapter platform is one the store accepts, and an unadapted platform is refused clearly', async () => {
  // The adapter registry and the store's platform enum must not drift: an
  // adapter for a platform the store rejects can never be reached, and a
  // store platform without an adapter is dead UI copy.
  for (const platform of ADAPTER_PLATFORMS) {
    await withStore(async (store) => {
      const account = await store.createAccount({ platform, label: 'x' })
      assert.equal(account.platform, platform)
    })
  }
  // 视频号 is a known platform without an adapter yet: registering it works,
  // publishing through it must say so instead of failing deep in a browser.
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'wechat', label: '视频号·未适配' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: stubBrowser(), workspacePath: store.workspacePath })
    await assert.rejects(
      () => host.startPublish({ accountId: account.id, projectId: '11111111-2222-3333-4444-555555555555' }),
      /视频号的发布流程尚未实现/u,
    )
  })
})

test('an account is created expired and owns a private profile directory', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: '  AI工具解读·抖音  ' })
    assert.equal(account.label, 'AI工具解读·抖音')
    assert.equal(account.platform, 'douyin')
    // A fresh account has never been checked, so it must not claim to be usable.
    assert.equal(account.status, 'expired')
    assert.equal(account.profileDir, defaultProfileDir(account.id))
    assert.match(account.profileDir, /^chrome-profiles[\\/][a-f0-9-]{36}$/u)
    const listed = await store.listAccounts()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, account.id)
  })
})

test('unsupported platforms and malformed input are rejected', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.createAccount({ platform: 'myspace', label: 'x' }), /平台/u)
    await assert.rejects(() => store.createAccount({ platform: 'douyin', label: '   ' }), /账号备注名/u)
    await assert.rejects(() => store.getAccount('not-a-uuid'), /账号标识/u)
  })
})

test('login state is only written by the browser layer, never guessed', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const patched = await store.patchAccountState(account.id, {
      status: 'active', nickname: '小发', handle: 'lifafa', lastCheckedAt: '2026-10-02T00:00:00.000Z',
    })
    assert.equal(patched.status, 'active')
    assert.equal(patched.nickname, '小发')
    // Re-reading from disk must preserve it; the store cannot rely on memory.
    const reloaded = await store.getAccount(account.id)
    assert.equal(reloaded.status, 'active')
    assert.equal(reloaded.handle, 'lifafa')
    await assert.rejects(() => store.patchAccountState(account.id, { status: 'bogus' }), /账号状态/u)
  })
})

test('an account with an unfinished job cannot be deleted', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    await store.createJob({
      accountId: account.id, platform: 'douyin', projectId: '11111111-2222-3333-4444-555555555555',
      projectRevision: 3, submitMode: 'confirm',
    })
    await assert.rejects(() => store.deleteAccount(account.id), /未完成的发布任务/u)
  })
})

test('a project cannot be queued twice on the same account', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const job = { accountId: account.id, platform: 'douyin', projectId: '11111111-2222-3333-4444-555555555555', projectRevision: 1 }
    await store.createJob(job)
    await assert.rejects(() => store.createJob(job), /已有未完成的发布任务/u)
  })
})

test('jobs persist with their frozen snapshot and evidence list', async () => {
  await withStore(async (store, dir) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const job = await store.createJob({
      accountId: account.id, platform: 'douyin', projectId: '11111111-2222-3333-4444-555555555555',
      projectTitle: '标题', projectRevision: 7, submitMode: 'confirm',
      content: { title: 'T', copy: 'C', description: 'D', tags: ['a'] },
    })
    await store.mutateJob(job.id, (item) => { item.status = 'succeeded'; item.phase = 'done' })
    const evidence = await store.saveEvidence(job.id, 'step-open.png', Buffer.from('x'))
    await store.mutateJob(job.id, (item) => { item.proof.screenshots.push(evidence) })

    const raw = JSON.parse(await readFile(join(dir, 'data', 'jobs.json'), 'utf8'))
    assert.equal(raw.jobs[0].projectRevision, 7)
    assert.equal(raw.jobs[0].content.title, 'T')
    assert.deepEqual(raw.jobs[0].proof.screenshots, [evidence])
    const reloaded = await store.getJob(job.id)
    assert.equal(reloaded.status, 'succeeded')
  })
})

test('a corrupt row does not hide the rest of the file', async () => {
  await withStore(async (store, dir) => {
    const good = await store.createAccount({ platform: 'douyin', label: 'good' })
    const raw = JSON.parse(await readFile(join(dir, 'data', 'accounts.json'), 'utf8'))
    raw.accounts.unshift({ id: 'broken', platform: 'douyin', label: 'x' })
    await writeFile(join(dir, 'data', 'accounts.json'), JSON.stringify(raw))
    const listed = await store.listAccounts()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, good.id)
  })
})

test('settings default to confirm mode and clamp the window timer', async () => {
  await withStore(async (store) => {
    const defaults = await store.settings()
    assert.equal(defaults.submitMode, 'confirm')
    assert.equal(defaults.headless, false)
    const updated = await store.updateSettings({ submitMode: 'auto', keepWindowOpenMs: 99_999_999 })
    assert.equal(updated.submitMode, 'auto')
    assert.equal(updated.keepWindowOpenMs, 600_000)
    const fallback = await store.updateSettings({ submitMode: 'nonsense' })
    assert.equal(fallback.submitMode, 'confirm')
  })
})

test('resolveBrowserExecutable prefers an explicit override', () => {
  const found = resolveBrowserExecutable({ LWB_PUBLISHER_CHROME: 'C:/definitely/not/here.exe' })
  // The override does not exist, so it must fall through rather than trust it.
  assert.notEqual(found, 'C:/definitely/not/here.exe')
})

test('publishing is refused for an account that is not signed in', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const host = new PublisherHost({ store, browser: stubBrowser(), workspacePath: store.workspacePath })
    await assert.rejects(
      () => host.startPublish({ accountId: account.id, projectId: '11111111-2222-3333-4444-555555555555' }),
      /登录态已失效/u,
    )
  })
})

test('publishing is refused when the sibling video pack is absent', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({ store, browser: stubBrowser(), spokenVideo: null, workspacePath: store.workspacePath })
    await assert.rejects(
      () => host.startPublish({ accountId: account.id, projectId: '11111111-2222-3333-4444-555555555555' }),
      /口播视频能力包未加载/u,
    )
  })
})

test('the qc gate and the packaging gate both block a publish', async () => {
  const projectId = '11111111-2222-3333-4444-555555555555'
  const scenario = (detail) => async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    await store.patchAccountState(account.id, { status: 'active' })
    const host = new PublisherHost({
      store, browser: stubBrowser(), workspacePath: store.workspacePath,
      spokenVideo: {
        projects: { async get() { return detail } },
        publish: { async listItems() { return { items: [] } } },
        context: async () => ({ workspacePath: store.workspacePath }),
      },
    })
    return host.startPublish({ accountId: account.id, projectId })
  }
  // qc not passed
  await withStore(async (store) => {
    await assert.rejects(scenario({ revision: 1, title: 't', artifacts: { qc: { data: { passed: false } } } })(store), /质检通过/u)
  })
  // qc passed but no packaging copy
  await withStore(async (store) => {
    await assert.rejects(
      scenario({ revision: 1, title: 't', artifacts: { qc: { data: { passed: true } }, video: { data: { video: { file: 'media/videos/a.mp4' } } } } })(store),
      /生成发布信息/u,
    )
  })
})

test('auto submit requires an explicit second confirmation', async () => {
  const projectId = '11111111-2222-3333-4444-555555555555'
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    await store.patchAccountState(account.id, { status: 'active' })
    await store.updateSettings({ submitMode: 'auto' })
    const host = new PublisherHost({
      store, browser: stubBrowser(), workspacePath: store.workspacePath,
      spokenVideo: {
        projects: { async get() { return { revision: 1, title: 't', artifacts: { qc: { data: { passed: true } }, packaging: { data: { content: { title: 'T', copy: 'C', description: 'D', tags: ['a'] } } }, video: { data: { video: { file: 'media/videos/a.mp4' } } } } } } },
        publish: { async listItems() { return { items: [] } } },
        context: async () => ({ workspacePath: store.workspacePath }),
      },
    })
    await assert.rejects(
      () => host.startPublish({ accountId: account.id, projectId, submitMode: 'auto' }),
      /二次确认/u,
    )
  })
})

test('an interrupted job is recovered as failed on load', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const job = await store.createJob({
      accountId: account.id, platform: 'douyin', projectId: '11111111-2222-3333-4444-555555555555', projectRevision: 1,
    })
    await store.mutateJob(job.id, (item) => { item.status = 'running'; item.phase = 'upload' })
    const host = new PublisherHost({ store, browser: stubBrowser(), workspacePath: store.workspacePath })
    await host.recoverInterrupted()
    const recovered = await store.getJob(job.id)
    assert.equal(recovered.status, 'failed')
    assert.match(recovered.error, /重启/u)
  })
})

test('cancelling a finished job is refused', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const job = await store.createJob({
      accountId: account.id, platform: 'douyin', projectId: '11111111-2222-3333-4444-555555555555', projectRevision: 1,
    })
    await store.mutateJob(job.id, (item) => { item.status = 'succeeded' })
    const host = new PublisherHost({ store, browser: stubBrowser(), workspacePath: store.workspacePath })
    await assert.rejects(() => host.cancelJob(job.id), /无需取消/u)
  })
})

test('evidence outside a job is not readable', async () => {
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: 'A' })
    const job = await store.createJob({
      accountId: account.id, platform: 'douyin', projectId: '11111111-2222-3333-4444-555555555555', projectRevision: 1,
    })
    const host = new PublisherHost({ store, browser: stubBrowser(), workspacePath: store.workspacePath })
    await assert.rejects(() => host.evidence({ jobId: job.id, name: 'evidence/other/secret.png' }), /不属于此任务/u)
  })
})

test('an over-long failure reason truncates instead of dropping the whole job record', async () => {
  // 2026-10-08 实测的真实故障：Playwright 的点击超时日志有 2019 字，超过 jobRecord
  // 里「失败原因」1000 字的上限 → optionalText 抛错 → #readJobs 的 try/catch 把**整条**
  // 任务静默丢弃 → getJob 报「发布任务不存在」，真因（按钮被弹窗挡住）彻底消失，
  // 定时任务只能报一句「重试 5 次仍读不到」，排查方向被带偏。
  await withStore(async (store) => {
    const account = await store.createAccount({ platform: 'douyin', label: '号', profileDir: 'C:/p', submitMode: 'auto' })
    const job = await store.createJob({
      accountId: account.id,
      platform: 'douyin',
      projectId: '11111111-2222-3333-4444-555555555555',
      projectRevision: 3,
      content: { title: '标题', copy: '文案', description: '描述', tags: ['标签'] },
      submitMode: 'auto',
      trigger: 'schedule',
    })
    const lines = Array.from({ length: 40 }, (_, i) => `  - waiting for element line ${i} of the playwright actionability log`).join('\n')
    const noisy = `locator.click: Timeout 45000ms exceeded.\nCall log:\n${lines}`
    assert.ok(noisy.length > 1000, 'the fixture must exceed the old cap')
    await store.mutateJob(job.id, (item) => { item.status = 'failed'; item.phase = 'failed'; item.error = noisy })

    // 关键：记录必须还在，且带着（截断后的）真实原因。
    const found = await store.getJob(job.id)
    assert.equal(found.status, 'failed')
    assert.match(found.error, /Timeout 45000ms exceeded/u, 'the real cause survives')
    assert.ok(found.error.length <= 1100, 'and it is clipped to the documented cap')
  })
})

/* --------------------------- 抖音适配器：发布前处理 --------------------------- */

test('douyin truncation cuts to the platform cap and reports it instead of silently clipping', async () => {
  // 2026-10-11 实机截图校准：抖音上传页标题角标是 `0/30`，超限时红字提示
  // 「标题内容仅支持30个字符」。上限取 30 —— 上一版的 55 是没核实过的猜测，
  // 会让 30 字以后的标题被平台自己砍掉，而记录里看不出发生过什么。
  assert.equal(DOUYIN_TITLE_LIMIT, 30)
  const long = 'A'.repeat(500)
  const cut = truncateForDouyin(long, DOUYIN_TITLE_LIMIT)
  assert.equal(cut.truncated, true)
  assert.equal(cut.text.length, 30)
  assert.equal(cut.text, long.slice(0, 30))

  const short = '短标题'
  const kept = truncateForDouyin(short, DOUYIN_TITLE_LIMIT)
  assert.equal(kept.truncated, false, '未超限的内容必须原样保留')
  assert.equal(kept.text, short)
})

test('douyin truncation counts code points, not UTF-16 units, so emoji is never cut in half', () => {
  // 纯 .length + slice 会把 emoji 算成 2 个单位，切在中间会留下半个代理对，
  // 粘进编辑器就是乱码。
  const emoji = '🎬'.repeat(40) // 40 个码点，80 个 UTF-16 单位
  const cut = truncateForDouyin(emoji, 10)
  assert.equal(cut.truncated, true)
  assert.equal([...cut.text].length, 10)
  assert.equal(cut.text, '🎬'.repeat(10))
  // 截完必须仍是完整码点，不能出现孤立代理项。
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(cut.text), '不得留下半个代理对')
})

test('douyin declaration defaults to 内容由AI生成, is overridable, and an explicit blank opts out', () => {
  // 本包成片全部是脚本+配音+AI 封面合成的，不声明属于对平台做不实陈述，
  // 所以默认就是「内容由AI生成」；真要发人工内容时能覆盖，显式空串则完全不碰该字段。
  assert.equal(resolveDeclaration({}), DEFAULT_AI_DECLARATION)
  assert.equal(resolveDeclaration(undefined), DEFAULT_AI_DECLARATION)
  assert.equal(resolveDeclaration({ declaration: null }), DEFAULT_AI_DECLARATION)
  assert.equal(resolveDeclaration({ declaration: '内容为原创拍摄' }), '内容为原创拍摄')
  assert.equal(resolveDeclaration({ declaration: '' }), '', '空串 = 明确要求不自动选声明')
})

test('douyin title/description limits are overridable per job', () => {
  // 上限不做成硬编码常量之外无法覆盖：抖音会调整上限，而本机没有联网通道去核实
  // 当前值，等哪次实测出准确数字，直接在任务内容里覆盖即可，不必再改代码。
  assert.equal(truncateForDouyin('A'.repeat(30), 20).text.length, 20)
  assert.equal(truncateForDouyin('A'.repeat(30), 40).truncated, false, '放宽上限后不该再裁')
})

test('douyin waits for the upload to finish before it treats the editor as ready', async () => {
  // 2026-10-11 实机截图：metadata 那张证据里上传才到 50%，而标题/正文已经写进去了。
  // 抖音上传期间会反复重渲染整个表单，刚写的内容被冲掉——表现是「标题莫名只剩
  // 开头 30 字」，看起来像平台在截断，实际是被后续重渲染覆盖了。
  // 所以必须在预览卡里的进度百分比消失之后才继续。
  const samples = [
    '视频上传中 50%\n剩余时间：3秒',
    '视频上传中 92%\n剩余时间：1秒',
    'ab71257ebe.mp4\n已上传：29.9MB/29.9MB',
  ]
  let call = 0
  const page = {
    evaluate: async () => {
      const text = samples[Math.min(call, samples.length - 1)]
      call += 1
      // 把 evaluate 的返回值构造成和真实页面一致：仍在传 → true。
      return /上传中/u.test(text) || (/\b\d{1,3}\s*%/u.test(text) && /剩余/u.test(text))
    },
    waitForTimeout: async () => {},
  }
  const finished = await waitForUploadComplete(page, { timeoutMs: 10_000, intervalMs: 1 })
  assert.equal(finished, true, '进度消失后必须返回已完成，而不是继续等')
  assert.ok(call >= 3, `至少轮询到第三次才判定完成（实际 ${call} 次）`)
})

test('douyin upload wait gives up instead of hanging forever when the page never settles', async () => {
  // 认不出进度标记时返回 false，让调用方记 upload-pending 继续往下走，
  // 而不是把发布任务永久卡住。
  const page = { evaluate: async () => true, waitForTimeout: async () => {} }
  const finished = await waitForUploadComplete(page, { timeoutMs: 30, intervalMs: 1 })
  assert.equal(finished, false)
})

test('douyin surfaces a cover problem the platform flagged, instead of claiming success', () => {
  // 2026-10-11 真机第四轮：封面文件确实进去了（横竖两个槽位都有缩略图），平台也
  // 不再说「截屏封面」，但右侧「封面优化建议」挂着两条「文字显示不全」——素材本身
  // 的标题字被裁切。第一版判据只认「封面不任」这类否决提示，于是照样报
  // cover-applied，而素材确实不合格，发布出去会掉流量。
  const clean = '设置封面\n自主声明 内容由AI生成'
  assert.equal(readCoverVerdict(clean), null, '没有提示时不得误报')

  const fatal = readCoverVerdict('封面不任\n封面存在1个问题，会导致作品流量减少')
  assert.ok(fatal, '明确的否决横幅必须报出来')
  assert.match(fatal, /封面/u)

  const advice = readCoverVerdict('封面优化建议\n横封面\n文字显示不全\n竖封面\n文字显示不全')
  assert.ok(advice, '优化建议里的具体问题也必须报出来，否则素材不合格会被当成成功')
  assert.match(advice, /文字显示不全/u)
})




test('douyin warns when a cover is wildly off the slot ratio, before uploading it', () => {
  // 实测：比例明显不符的平台会直接判「封面不任」，而那种失败在发布记录里看不出
  // 是素材问题。这里在上传前就量一次，把话说清楚。
  //
  // 关键：容差必须放宽。2026-10-11 真机实测，项目里的横封面 1280x720（16:9）
  // 与竖封面 1088x1440 平台都照收——「横封面4:3 / 竖封面3:4」是抖音展示时的框，
  // 不是素材硬要求。严抠 4:3 会对正常素材误报，那比不报更糟。
  assert.equal(coverRatioWarning(1280, 720, 'landscape'), null, '16:9 横封面实测可用')
  assert.equal(coverRatioWarning(1088, 1440, 'portrait'), null, '1088x1440 竖封面实测可用')
  assert.ok(coverRatioWarning(1088, 1440, 'landscape'), '把竖版塞进横槽必须报警')
  assert.match(coverRatioWarning(1088, 1440, 'landscape'), /封面不任/u)
  assert.ok(coverRatioWarning(1920, 200, 'landscape'), '极端长条必须报警')
  assert.equal(coverRatioWarning(0, 0, 'landscape'), null, '量不到尺寸不该误报')
  assert.equal(coverRatioWarning(undefined, undefined, 'portrait'), null)
})

test('douyin finds both cover slots even though the portrait box is far narrower', () => {
  // 2026-10-11 实测几何：横封面方块 160x120，**竖封面只有 90 宽**（90x147）。
  // 上一版按 `width > 100` 过滤，竖封面方块直接被筛掉，于是只找到一个入口，
  // 横封面正常、竖封面永远打不开——这就是用户看到的「竖槽里装的是横图」。
  // 任何把宽度下限抬过 100 的改动都会让这个用例失败。
  const boxes = [
    { x: 438, y: 509, w: 160, h: 120 },  // 横封面
    { x: 571, y: 522, w: 90, h: 147 },   // 竖封面，明显更窄
  ]
  const slots = pickCoverSlots(boxes)
  assert.ok(slots.landscape, '横封面入口必须找到')
  assert.ok(slots.portrait, '竖封面入口必须找到，哪怕它只有 90 宽')
  assert.equal(slots.all.length, 2)
  // 按 x 排序：左横右竖。这是抖音的实际排布。
  assert.ok(slots.landscape.x < slots.portrait.x, '左边是横封面，右边是竖封面')
})

test('douyin cover slot detection collapses the parent/child duplicates it really gets', () => {
  // 实测 DOM 里同一位置会有三层元素命中（coverControl- / cover-Jg3T4p / filter-k_CjvJ），
  // 去重要按坐标，否则一个方块会被当成三个、竖槽直接落到错误位置。
  const dupes = [
    { x: 438, y: 509, w: 160, h: 147 },
    { x: 438, y: 509, w: 160, h: 120 },
    { x: 438, y: 509, w: 160, h: 120 },
    { x: 571, y: 522, w: 90, h: 147 },
  ]
  const slots = pickCoverSlots(dupes)
  assert.equal(slots.all.length, 2, '同坐标的三层元素必须折叠成一个')
  assert.ok(slots.landscape && slots.portrait)
})

test('douyin reports a missing cover slot instead of silently reusing the other one', () => {
  // 只有横封面时（素材缺一张），竖槽必须是 null，让调用方明确报「没找到入口」，
  // 而不是退回去复用横封面入口再把横图传一遍。
  const slots = pickCoverSlots([{ x: 438, y: 509, w: 160, h: 120 }])
  assert.ok(slots.landscape)
  assert.equal(slots.portrait, null, '缺竖封面时必须返回 null，不许拿横封面的坐标顶替')
})
