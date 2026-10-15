/**
 * 视频号助手 (WeChat Channels creator platform) adapter.
 *
 * Same contract as the kuaishou adapter: every selector is a priority list so a
 * platform redesign degrades into a screenshot-and-error instead of a wrong
 * click.
 *
 * What is verified live (probe, 2026-10-11, both signed-out and signed-in):
 *  - Signed out, `https://channels.weixin.qq.com/platform/post/create` answers
 *    200 but server-redirects to `/login.html` (title 视频号助手). The address
 *    is therefore the login signal, and it needs no selector.
 *  - Signed IN, that same URL does NOT open the editor: the SPA router bounces
 *    it back to `/platform` (verified by polling 15×45s — the page stays on the
 *    home route). The editor is only reachable through the in-app entry, which
 *    is the orange 发表视频 button on the home page's 最近视频 panel. So the
 *    adapter navigates home and clicks that button rather than deep-linking.
 *  - The left nav is an icon-only rail by default; its 视频 item renders text
 *    in a collapsed menu and is NOT visible, so a `text=视频` click would hang.
 *    发表视频 is the one entry that is visible and stable.
 *  - The QR code lives in a cross-origin iframe served by
 *    `open.weixin.qq.com/connect/qrconnect`, wrapped in `.qrcode-wrap` inside
 *    `.login-qrcode-wrap`. It cannot be mirrored into another context without
 *    copying a live credential, so startLogin opens it in the real window and
 *    the human scans there.
 *
 * NOT yet verified: the editor's own field selectors (description box, cover
 * control, 发表 button) were written against the published docs and the
 * sibling adapters' shape, not against a real signed-in editor. They are
 * deliberately conservative: anything not found is reported, never guessed at.
 */

const ORIGIN = 'https://channels.weixin.qq.com'
const LOGIN_URL = `${ORIGIN}/login.html`
/** The home route. Signed in, this is where the editor's entry button lives. */
const HOME_URL = `${ORIGIN}/platform`
/** Kept for the login probe and for the record of where the editor would be. */
const UPLOAD_URL = `${ORIGIN}/platform/post/create`
const MANAGE_URL = `${ORIGIN}/platform/post/list`

/**
 * Limits read off the live editor (2026-10-11): the 短标题 field's own
 * counter caps at 10 characters, and the description box is the one the
 * platform does not visibly count, so it is clipped conservatively.
 */
const TITLE_LIMIT = 10
const DESCRIPTION_LIMIT = 1000
const TAG_LIMIT = 10

/**
 * The editor body lives in a cross-document iframe
 * (`/micro/content/post/create`), so a selector has to be resolved across
 * frames — plain outer-document queries find nothing, which is exactly how the
 * first calibration pass failed. `firstMatch` walks every frame.
 */
const SELECTORS = {
  loggedOut: [
    'text=登录视频号助手',
    'text=微信扫码登录',
    '.login-qrcode-wrap',
  ],
  loggedIn: [
    'text=视频号ID:',
    '[class*="avatar"]',
    '[class*="nickname"]',
    '[class*="user-info"]',
  ],
  nickname: [
    '[class*="nickname"]',
    '[class*="user-name"]',
    '[class*="account-name"]',
  ],
  /**
   * The upload control is a hidden `input[type=file]` inside
   * `.post-upload-wrap > .upload-wrap > .ant-upload.ant-upload-drag`. It is
   * never "visible", so it must be waited for as `attached`, not clicked.
   */
  fileInput: [
    'input[type="file"][accept*="video"]',
    '.post-upload-wrap input[type="file"]',
    'input[type="file"]',
  ],
  /** The one stable entry into the editor; see the header note on the nav. */
  openEditor: [
    'button:has-text("发表视频")',
    'a:has-text("发表视频")',
  ],
  /** Real input, placeholder 填写短标题有机会获得更多流量. */
  shortTitle: [
    'input[placeholder*="短标题"]',
    'input[placeholder*="更有机会获得更多流量"]',
  ],
  /** A contenteditable div, placeholder 添加描述 — not a textarea. */
  description: [
    '[contenteditable][data-placeholder="添加描述"]',
    '.post-desc-box [contenteditable]',
    '.input-editor[contenteditable]',
  ],
  uploadDone: [
    '[contenteditable][data-placeholder="添加描述"]',
    '.post-desc-box',
    'input[placeholder*="短标题"]',
  ],
  submit: [
    'button:has-text("发表"):not(:has-text("声明"))',
    'button.weui-desktop-btn_d:has-text("发表")',
  ],
}

/** Every document the page owns, so an iframe-hosted control is reachable. */
function scopes(page) {
  // Tolerate a stub without frame support: the login check runs on the outer
  // document anyway, and failing hard there would break the simplest caller.
  const frames = typeof page.frames === 'function' ? page.frames() : []
  const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null
  return [page, ...frames.filter((frame) => frame !== main)]
}

/**
 * Resolve the first visible match of a selector list, searching each frame.
 * `visible: 'attached'` lets a hidden file input count — the upload control is
 * `display:none` by design and can only be filled, never clicked.
 */
async function firstMatch(page, selectors, { timeout = 0, state = 'visible' } = {}) {
  const documents = scopes(page)
  const perTry = timeout > 0 ? Math.max(500, Math.floor(timeout / selectors.length)) : 0
  for (const scope of documents) {
    for (const selector of selectors) {
      try {
        const locator = scope.locator(selector).first()
        if (perTry > 0) {
          await locator.waitFor({ state, timeout: perTry })
        } else if (state === 'attached') {
          if (await locator.count() === 0) continue
        } else if (await locator.count() === 0) {
          continue
        } else if (!(await locator.isVisible())) {
          continue
        }
        return locator
      } catch { /* try the next candidate */ }
    }
  }
  return null
}

async function textOf(page, selectors) {
  const locator = await firstMatch(page, selectors)
  if (!locator) return null
  try { return (await locator.innerText()).trim().slice(0, 120) || null } catch { return null }
}

function normalizeTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag).replace(/^#/u, '').trim())
    .filter(Boolean)
    .slice(0, TAG_LIMIT)
}

/**
 * The body and tags for the 描述 box. The title is NOT repeated here: 视频号
 * does have its own 短标题 field (verified live), so the title is written
 * there and copying it here would read as duplicated text to the platform.
 */
export function composeDescription(content) {
  const body = String(content?.description || content?.copy || '').trim()
  const tags = normalizeTags(content?.tags)
  const tagLine = tags.map((tag) => `#${tag}`).join(' ')
  let text = body
  if (tagLine && !text.includes(tagLine)) text = `${text}\n${tagLine}`.trim()
  if (text.length <= DESCRIPTION_LIMIT) return text
  // Truncate the body, never the tag line: tags are the cheapest signal a
  // platform's topic classifier has, so losing them to an overlong body is the
  // worse failure. The tail is also usually the least load-bearing prose.
  const budget = Math.max(0, DESCRIPTION_LIMIT - (tagLine ? tagLine.length + 1 : 0))
  const head = text.slice(0, budget).trim()
  return tagLine ? `${head}\n${tagLine}` : head
}

/**
 * The 短标题 field rejects punctuation outright — the live editor prints
 * "标题包含特殊字符，符号仅支持书名号、引号、冒号、加号、问号、百分号、
 * 摄氏度，逗号可用空格代替" and refuses to submit. The sibling adapters
 * produce prose-shaped titles, so strip what the platform will not take and
 * say so, rather than letting the publish die on a field we filled ourselves.
 */
// 短标题允许的标点。
//
// 2026-10-11 实测：视频号短标题不收「，」——用户标题里的逗号被砍掉并记了
// title-adjusted。既然它连中文逗号都不收，双引号 / 问号 / 百分号 / 加号 / 冒号 /
// 连字符这些「特殊符号」同样会被平台拒绝或影响展示，只保留书名号与引号类。
// 这里只做减法：宁可多砍一个无意义的符号，也不要平台那边报错。
const TITLE_ALLOWED_PUNCTUATION = new Set(['《', '》', '「', '」'])

export function sanitizeShortTitle(raw) {
  const dropped = new Set()
  // 换行/制表符先压成空格再收敛为空格：留着会让「带\n换行」的标题拼成
  // 「带换行」——字面读得通但语义全错，比砍掉更糟。
  const cleaned = String(raw || '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .split('')
    .filter((char) => {
      // Keep CJK, ASCII letters/digits, and the punctuation the field allows.
      if (/[\p{Script=Han}a-zA-Z0-9]/u.test(char)) return true
      if (TITLE_ALLOWED_PUNCTUATION.has(char)) return true
      // 空格保留：换行/制表符先压成空格（见上），砍掉它们会让「带\n换行」拼成
      // 「带换行」——字面读得通但语义全错。ASCII 空格在标题里是被接受的。
      if (char === ' ') return true
      dropped.add(char)
      return false
    })
    .join('')
  const cut = cleaned.slice(0, TITLE_LIMIT).trim().replace(/[\s《「]+$/u, '')
  // 截断可能把成对的引号切成半个（「…指南2026」这种，孤立的「 挂在前面）。
  // 只在**开头**出现没有配对的那一个时补回去——结尾的孤引号已经由上面剥掉了。
  const balanced = (() => {
    const opens = (cut.match(/[「《]/gu) || []).length
    const closes = (cut.match(/[」》]/gu) || []).length
    return opens > closes ? cut + '」' : cut
  })()
  // 补引号可能又超长，超了就砍尾部的引号（宁可不成对，也不要超限被平台截）。
  const final = balanced.length <= TITLE_LIMIT ? balanced : balanced.slice(0, TITLE_LIMIT).replace(/[「《」》\s]+$/u, '')
  return { text: final, dropped: [...dropped].join('') }
}

/** The 短标题 field's own cap; kept in one place for the calibration pass. */
export function composeShortTitle(content) {
  return sanitizeShortTitle(content?.title).text
}

export const wechatAdapter = {
  id: 'wechat',
  label: '视频号',
  loginUrl: LOGIN_URL,
  uploadUrl: UPLOAD_URL,
  manageUrl: MANAGE_URL,

  /**
   * An unauthenticated visit is redirected to `/login.html` by the server, so
   * the address answers this before any selector runs. When it stays signed
   * out the home route shows the QR panel instead of the account card, which
   * is the second, independent signal.
   */
  async isLoggedIn(page) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    if (await onLoginPage(page)) return false
    const loggedOut = await firstMatch(page, SELECTORS.loggedOut)
    if (loggedOut) return false
    // The signed-in home shows the account name and ID line; the signed-out
    // one never renders them.
    const identity = await firstMatch(page, SELECTORS.loggedIn, { timeout: 10_000 })
    if (identity) return true
    return Boolean(await firstMatch(page, SELECTORS.openEditor, { timeout: 4000 }))
  },

  async readIdentity(page) {
    const nickname = await textOf(page, SELECTORS.nickname)
    return { nickname, handle: null }
  },

  async publish(page, { videoPath, content, coverPaths = {}, submitMode, onStep = async () => {} }) {
    const description = composeDescription(content)

    await onStep('open', '打开发布入口')
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    if (await onLoginPage(page) || await firstMatch(page, SELECTORS.loggedOut)) {
      const error = new Error('视频号登录态已失效，请在账号页重新扫码登录。')
      error.code = 'PUBLISHER_LOGIN_REQUIRED'
      throw error
    }
    const entry = await firstMatch(page, SELECTORS.openEditor, { timeout: 20_000 })
    if (!entry) {
      const error = new Error('未找到「发表视频」入口，视频号页面结构可能已调整。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await entry.click()
    // The router swaps the view without a full load; the editor mounts after it.
    await page.waitForTimeout(4000)

    await onStep('upload', '上传视频文件')
    // The control is display:none by design; wait for it to be attached, not visible.
    const fileInput = await firstMatch(page, SELECTORS.fileInput, { timeout: 20_000, state: 'attached' })
    if (!fileInput) {
      const error = new Error('未找到视频上传入口，视频号页面结构可能已调整。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await fileInput.setInputFiles(videoPath)

    await onStep('editor', '等待视频上传并进入编辑页')
    const editorReady = await firstMatch(page, SELECTORS.uploadDone, { timeout: 300_000 })
    if (!editorReady) {
      const error = new Error('视频上传后未能进入编辑页（可能仍在转码，或平台拒绝了该文件）。')
      error.code = 'PUBLISHER_UPLOAD_STALLED'
      throw error
    }
    await page.waitForTimeout(2000)

    // 视频号 does have a separate 短标题 field (verified live), so the title
    // goes there rather than being folded into the description.
    await onStep('metadata', '填写短标题、描述与标签')
    const titleBox = await firstMatch(page, SELECTORS.shortTitle)
    if (titleBox) {
      const { text: title, dropped } = sanitizeShortTitle(content?.title)
      if (dropped) await onStep('title-adjusted', `短标题去掉平台不允许的符号「${dropped}」`)
      if (title) {
        try {
          await titleBox.click()
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
          await page.keyboard.insertText(title)
          await page.waitForTimeout(400)
        } catch { /* the description below still carries the topic */ }
      }
    }

    const descriptionBox = await firstMatch(page, SELECTORS.description)
    if (!descriptionBox) {
      const error = new Error('未找到描述输入框，视频号页面结构可能已调整。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await descriptionBox.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(description)
    await page.waitForTimeout(600)

    // 封面与声明都要横向滚动到才能看到，视频号编辑器把这些控件放在下方的
    // 「封面预览 / 视频描述 / 位置 / 链接 / 活动」下方，且滚动容器不是 window。
    await scrollEditorIntoView(page, '封面预览')
    const coverPath = coverPaths.portrait || coverPaths.landscape || null
    await uploadWechatCover(page, coverPath, onStep)
    await tickDeclarations(page, onStep)

    if (submitMode === 'confirm') {
      // Before parking the user at the confirm step, check the editor is not
      // already refusing to submit: 视频号 disables 发表 and prints a red
      // message under 短标题 when the value is invalid. Parking on a form the
      // platform will not accept leaves the user staring at a dead button.
      const complaint = await fieldError(page)
      if (complaint) {
        const error = new Error(`视频号校验未通过：${complaint}`)
        error.code = 'PUBLISHER_ADAPTER_SELECTOR'
        throw error
      }
      await onStep('awaiting-confirm', '已停在发布前，请在窗口中确认')
      return { submitted: false, remoteUrl: null }
    }

    await onStep('submit', '提交发布')
    const submit = await firstMatch(page, SELECTORS.submit, { timeout: 15_000 })
    if (!submit) {
      const error = new Error('未找到发表按钮，请改为「发布前确认」模式人工提交。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await submit.click()

    await onStep('verify', '等待平台受理并读回作品状态')
    await page.waitForTimeout(8000)
    const url = page.url()
    return { submitted: true, remoteUrl: /post\/list|content\/manage/iu.test(url) ? MANAGE_URL : url }
  },
}

/** The platform's own answer to "logged out": the login document's address. */
async function onLoginPage(page) {
  return /\/login\.html(?:[?#]|$)/iu.test(page.url())
}

/**
 * The editor's inline validation text, if any. WeChat desktop form errors are
 * rendered as the message under the offending field, in the antd error colour;
 * when one is present the submit button stays disabled, so surfacing it is the
 * difference between "the form is fine" and "the platform will not take this".
 */
async function fieldError(page) {
  const scopes_ = scopes(page)
  for (const scope of scopes_) {
    const found = await scope.evaluate(() => {
      const patterns = [/标题包含特殊字符/u, /不能包含/u, /请填写/u, /不能超过/u, /字数/u]
      const nodes = [...document.querySelectorAll('[class*="error" i], [class*="tips" i], [class*="warn" i], [class*="hint" i]')]
      for (const el of nodes) {
        const text = (el.innerText || '').replace(/\s+/gu, ' ').trim()
        if (!text || text.length > 160) continue
        if (patterns.some((re) => re.test(text))) return text
      }
      return null
    }).catch(() => null)
    if (found) return found
  }
  return null
}

/**
 * 把编辑区滚到指定文案可见。
 *
 * 视频号编辑器（/platform/post/create）的滚动容器不是 window，而是页面里某个
 * `overflow:auto` 的 div——直接 `window.scrollTo` 完全没反应（实测 2026-10-11）。
 * 这里先按文案定位元素，再逐级 scrollIntoView；找不到就退化为「把页面上最像
 * 滚动容器的那几个 div 全部滚到底」。
 */
async function scrollEditorIntoView(page, text) {
  for (const scope of scopes(page)) {
    const done = await scope.evaluate((needle) => {
      const hit = [...document.querySelectorAll('div,span,label,p')].find((el) => (el.textContent || '').trim() === needle)
      if (!hit) return false
      hit.scrollIntoView({ block: 'center' })
      return true
    }, text).catch(() => false)
    if (done) { await page.waitForTimeout(600); return true }
  }
  // 兜底：滚到最底，露出下方的声明区。
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 300) el.scrollTop = el.scrollHeight
    }
    window.scrollTo(0, document.body.scrollHeight)
  }).catch(() => {})
  await page.waitForTimeout(600)
  return false
}

/**
 * 上传封面。
 *
 * 2026-10-11 修：原实现找 `text=更换封面 / 设置封面 / 编辑封面`，这四个词在视频号
 * 编辑器里**一个都不存在**——真实入口是「封面预览」两张缩略图下方的**「编辑」**
 * 按钮（3:4 个人主页卡片 / 4:3 分享卡片各一个）。整段还被一个 try/catch 包着，
 * 找不到入口就静默跳过，于是发布出去的动态封面永远是空的，而记录里看不出异常。
 *
 * 这里改成：点「编辑」→ 弹窗里找 image file input → 塞图 → 完成/确定。
 * 两条比例都要设：3:4 决定主页卡片、4:3 决定分享卡片，只设一个另一张仍是空帧。
 */
/**
 * 在所有 frame 里找**可见且未被遮挡**的元素。
 *
 * 2026-10-11 实测教训：只判 `count() > 0` 会拿到被遮罩盖住或隐藏的同名元素——
 * 「保存」匹配到平台级「将此次编辑保留？」确认框的按钮、「原创」匹配到弹窗背后
 * 的表单文字，于是步骤全部报成功、封面和勾选其实一点没变。定位元素时必须过
 * 两关：自身可见，且中心点的 elementFromPoint 命中自己或自己的后代。
 */
async function findInteractive(scope, selector, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const count = await scope.locator(selector).count().catch(() => 0)
    for (let i = 0; i < count; i += 1) {
      const loc = scope.locator(selector).nth(i)
      // 遮挡判定要用**元素所在文档**的 elementFromPoint：getBoundingClientRect 与
      // elementFromPoint 的坐标系都是「自己文档的视口」，两者必须同源。在 frame A
      // 里拿 B 的坐标去问，会得到 null 或错的元素——于是所有元素都被判成"被遮挡"
      // （2026-10-11 实测：编辑器在 frame 里时，可见按钮一律不可点）。
      // 这里在元素自己的文档里做，且退化为「无遮挡元素」由调用方兜。
      const ok = await loc.evaluate((el) => {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') return false
        if (cs.opacity !== '' && Number(cs.opacity) < 0.2) return false
        const hit = el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        // 中心点命中自己/后代 = 没人盖住；命中 null 说明 iframe 内容此刻不可命中，
        // 保守放过（真正的遮挡会在点击时报 actionability 错，不会静默通过）。
        return !hit || hit === el || el.contains(hit) || hit.contains(el)
      }).catch(() => true)
      if (ok) return loc
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

/**
 * 封面编辑弹窗此刻开着吗？
 *
 * 这是整套封面上传里最要紧的一个回读：先前几版都是「click() 没抛错 → 报
 * cover-applied」，实际弹层没关、封面根本没存上，连着假成功好几轮。改成点完
 * 回读弹层状态，只有真关了才算成功。
 */
async function coverDialogOpen(page) {
  for (const scope of scopes(page)) {
    const open = await scope.evaluate(() => {
      const visible = (el) => el.getBoundingClientRect().width > 0
      if (Array.from(document.querySelectorAll('.single-cover-uploader-wrap')).some(visible)) return true
      // 也可能弹层标题还在（「编辑个人主页卡片」/「编辑分享卡片」）。
      return Array.from(document.querySelectorAll('*')).some((el) => {
        const t = (el.innerText || '').trim()
        return visible(el) && (t === '编辑个人主页卡片' || t === '编辑分享卡片')
      })
    }).catch(() => false)
    if (open) return true
  }
  return false
}

/**
 * 上传本地图后可能再弹一层「裁剪封面图」，得按它的「确定」才能回到外层弹窗。
 *
 * 这层来自对标项目 dreammis/social-auto-upload 的两步流程（先
 * confirm_thumbnail_crop 再 upload_thumbnail_in_dialog）。我们这条路径实测没
 * 弹出来过，但传一张比例不标准的图就可能遇到，所以留一步兜底：弹了就按掉，
 * 没弹就直接返回，不打扰正常流程。
 */
async function confirmCropDialog(page) {
  for (const scope of scopes(page)) {
    const crop = scope.locator('div.weui-desktop-dialog').filter({ hasText: '裁剪封面图' }).first()
    if (!(await crop.count().catch(() => 0))) continue
    if (!(await crop.isVisible().catch(() => false))) continue
    const ok = crop.locator('div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确定")').first()
    if (!(await ok.count().catch(() => 0))) continue
    await ok.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1200)
    return true
  }
  return false
}

async function uploadWechatCover(page, coverPath, onStep) {
  if (!coverPath) return false
  await onStep('cover', '上传封面')
  // 交互链完全按 2026-10-11 用户提供的两张截图：
  //   ① 点「封面预览」下的**封面缩略图本身**（3:4 个人主页卡片 / 4:3 分享卡片各一张），
  //      不是它下面的「编辑」文字 —— 点文字会被 img 挡住而超时。
  //      弹层标题为「编辑个人主页卡片」，底部按钮是「取消 / 确认」（**不是保存**，
  //      我先前按「保存」找，压根找不到）。
  //   ② 弹层里点「上传封面」——一个 **+ 号虚线方块**（.single-cover-uploader-wrap），
  //      它触发系统文件选择器；左边那个是「从视频中选择封面」，不能用（我们要本地图）。
  //   ③ 选完图点弹层底部**「确认」**才真正保存。
  let scope = null
  for (const s of scopes(page)) {
    if (await s.locator('.vertical-cover-wrap img').count().catch(() => 0)) { scope = s; break }
  }
  if (!scope) {
    await onStep('cover-missing', '未找到封面缩略图（.vertical-cover-wrap img），视频号页面结构可能已调整')
    return false
  }
  const img = scope.locator('.vertical-cover-wrap img').first()
  // 预览图未加载时尺寸很小（实测 74x74），点它弹不出编辑器 —— 必须等它就绪。
  // 前面几版用一次 evaluate 等待、失败就 .catch(() => {}) 放行，于是照样去点，
  // 于是「等不到上传封面方块」——看起来像选择器不对，其实是图没加载。
  for (let i = 0; i < 30; i += 1) {
    const ready = await img.boundingBox().then((b) => Boolean(b && b.width > 100)).catch(() => false)
    if (ready) break
    await page.waitForTimeout(500)
  }
  const cardBox = await img.boundingBox().catch(() => null)
  // 坐标点击：Playwright 的 click 会被 img 内部的 blur-img 判定为「被遮挡」而超时，
  // 坐标点击落在中心点，与人点的是同一位置。
  if (cardBox) await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2).catch(() => {})
  else await img.click({ timeout: 6000, force: true }).catch(() => {})

  // 显式等「上传封面」出现，而不是发个指令就往下走（前几版就是这么把失败当成功的）。
  const uploader = scope.locator('.single-cover-uploader-wrap').first()
  let uploaderBox = null
  for (let i = 0; i < 30 && !uploaderBox; i += 1) {
    uploaderBox = await uploader.boundingBox().catch(() => null)
    if (!uploaderBox || uploaderBox.width <= 0) { uploaderBox = null; await page.waitForTimeout(500) }
  }
  if (!uploaderBox) {
    await onStep('cover-missing', '封面编辑弹层未打开（等不到「+ 上传封面」方块）')
    return false
  }
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null)
  await page.mouse.click(uploaderBox.x + uploaderBox.width / 2, uploaderBox.y + uploaderBox.height / 2).catch(() => {})
  const chooser = await chooserPromise
  if (chooser) {
    await chooser.setFiles(coverPath).catch(() => {})
  } else {
    let input = null
    for (const s of scopes(page)) {
      for (const sel of ['input[type="file"][accept*="image"]', 'input[type="file"]']) {
        if (await s.locator(sel).count().catch(() => 0)) { input = s.locator(sel).first(); break }
      }
      if (input) break
    }
    if (!input) {
      await onStep('cover-missing', '点「上传封面」后既无文件选择器也无 file input')
      return false
    }
    await input.setInputFiles(coverPath).catch(() => {})
  }
  // 等裁剪/上传完成（弹层里有「效果预览」同步刷新）
  await page.waitForTimeout(5000)

  // 上传本地图后可能**再弹一层「裁剪封面图」**，要按它的「确定」才能回到外层弹窗。
  // 对标项目 dreammis/social-auto-upload（15k star）就是两步：先
  // confirm_thumbnail_crop 再 upload_thumbnail_in_dialog。我们这条路径实测没
  // 弹出过，但多传一张非标准比例的图就可能遇到，所以留一步兜底。
  await confirmCropDialog(page)

  // 外层弹层的「确认」。**优先用选择器**：`.weui-desktop-dialog__ft` 是弹窗页脚、
  // `weui-desktop-btn_primary` 是橙色主按钮，两个类一起把按钮钉死，比按文本猜
  // 稳得多（同样来自对标项目）。选择器找不到才退回几何 —— 实测几何也靠谱
  // （确认按钮 rect [1030,807,100,32]），留着当平台改版时的保险。
  let saved = false
  for (let attempt = 0; attempt < 20 && !saved; attempt += 1) {
    // ① 选择器路径
    for (const s of scopes(page)) {
      // **必须把按钮限定在封面弹层内**，不能只靠 `__ft` + `btn_primary`：
      // 2026-10-11 实测全页有 20 个这类按钮，其中「确认」有两个（一个是别的弹层
      // 里的 mini 版），不带 dialog 过滤就会点到错的弹层上去。
      const btn = s
        .locator('div.weui-desktop-dialog')
        .filter({ hasText: '上传封面' })
        .locator('div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确认")')
        .first()
      if (!(await btn.count().catch(() => 0))) continue
      if (!(await btn.isVisible().catch(() => false))) continue
      await btn.click({ timeout: 5000 }).catch(() => {})
      // 回读：弹层真的关了吗？点完就报成功正是之前「假成功」的根源。
      await page.waitForTimeout(1500)
      if (!(await coverDialogOpen(page))) { saved = true; break }
      await page.waitForTimeout(400)
    }
    if (saved) break
    // ② 几何兜底
    for (const s of scopes(page)) {
      const hit = await s.evaluate(() => {
        // 按可见几何过滤，别按 children 数：页面上到处是 textContent 恰好等于
        // 「确认」的隐藏节点，children 上限这种猜测迟早把真按钮滤掉。
        const all = (text) => Array.from(document.querySelectorAll('*'))
          .filter((el) => (el.textContent || '').trim() === text)
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10 })
        const pick = (list) => (list.length
          ? list.reduce((a, b) => {
              const ra = a.getBoundingClientRect()
              const rb = b.getBoundingClientRect()
              return (rb.width * rb.height > ra.width * ra.height) ? b : a
            })
          : null)
        const cancel = pick(all('取消'))
        const ok = pick(all('确认'))
        if (!cancel || !ok) return null
        const a = cancel.getBoundingClientRect()
        const b = ok.getBoundingClientRect()
        if (b.width <= 0 || b.x <= a.x || Math.abs(b.y - a.y) > 40) return null
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }).catch(() => null)
      if (!hit) continue
      await page.mouse.click(hit.x, hit.y).catch(() => {})
      await page.waitForTimeout(1500)
      if (!(await coverDialogOpen(page))) { saved = true; break }
    }
    if (!saved) await page.waitForTimeout(500)
  }
  await page.waitForTimeout(2500)
  if (saved) await onStep('cover-applied', '封面已上传并确认（3:4 个人主页卡片）')
  else await onStep('cover-skipped', '封面已选入但弹层底部「确认」未点到，预览可能仍是原帧')
  return saved
}

/**
 * 勾选「原创声明」与「AI 生成标注」。
 *
 * 2026-10-11 真机截图确认的真实结构（此前两版都猜错了）：
 *  · 原创声明不是编辑器里的 checkbox，而是点「声明原创」按钮弹出的**弹窗**里
 *    的一句说明：`<div class="declare-original-checkbox">声明后，作品将展示原创标记…</div>`。
 *    第一版按 `/原创/` 找 label，命中的是弹窗里「我已阅读并同意《原声明须知》」
 *    的协议勾选框——勾了个协议，原创标记根本没声明。
 *  · AI 生成标注是同一个弹窗里的另一项，需按其文案定位。
 *
 * 顺序：先点「声明原创」开弹窗 → 勾两项 → 点「声明原创」确认 → 弹窗关闭。
 */
async function tickDeclarations(page, onStep) {
  // 2026-10-11 用户截图 + 真机 DOM 确认的两个控件**形态不同**：
  //
  //  ① 声明原创 —— 编辑器里的 checkbox（label 文案「声明原创」，旁边说明
  //    「声明后，作品将展示原创标记，有机会获得广告收入。」）。点 label 即可。
  //    前面两版都错在「以为要点「声明原创」开弹窗」——那个弹窗里只有《原声明须知》
  //    的协议勾选和定时选项，勾它等于同意协议，跟原创标记无关（实测勾完弹窗还开着）。
  //
  //  ② 视频标注 —— **不是 checkbox，是下拉框**（.form-item.post-with-mark-tag，
  //    占位文字「选择视频标注」）。这就是前几版一直报「未找到 AI 生成标注」的
  //    原因：代码从头到尾都在找 checkbox。真实选项要等下拉展开才知道。
  let originalOk = false
  let tagOptions = null
  for (const scope of scopes(page)) {
    originalOk = await scope.evaluate(() => {
      for (const el of document.querySelectorAll('label, .ant-checkbox-wrapper, div')) {
        const text = (el.innerText || el.textContent || '').trim()
        if (text !== '声明原创' && !/声明后，作品将展示原创标记/u.test(text)) continue
        const input = el.querySelector?.('input[type=checkbox]') || el.closest?.('label')?.querySelector('input[type=checkbox]') || null
        if (input) { if (!input.checked) input.click(); return input.checked }
        const label = el.closest?.('label') || el
        label.click?.()
        return true
      }
      return false
    }).catch(() => false)
    // 视频标注是下拉：先滚到可见，再点开读选项
    tagOptions = await openMarkTagDropdown(scope, page)
    if (originalOk || tagOptions) break
  }
  if (originalOk) await onStep('original-declaration', '声明原创已勾选')
  else await onStep('original-declaration-missing', '未找到「声明原创」勾选框，请人工勾选')
  // 2026-10-11 实测：勾「声明原创」会弹出《原声明须知》协议弹窗，光勾协议不算
  // 声明——必须再按一次弹窗里的「声明原创」（勾协议前它是灰的，勾完才可点）。
  if (originalOk) {
    const confirmed = await confirmOriginalDialog(page, onStep)
    if (!confirmed) await onStep('original-declaration-unconfirmed', '《原声明须知》弹窗仍在：请勾选协议后按「声明原创」（视频号原创标记需要这一步才算生效）')
  }
  if (tagOptions?.picked) await onStep('ai-declaration', `视频标注已选：${tagOptions.picked}`)
  else if (tagOptions?.options?.length) await onStep('ai-declaration-missing', `视频标注下拉已展开但未选中（可选：${tagOptions.options.join('、')}），请人工选择`)
  else await onStep('ai-declaration-missing', '未找到「视频标注」下拉框（.post-with-mark-tag），请人工选择含 AI 生成内容')
}

/**
 * 收尾《原声明须知》协议弹窗。
 *
 * 2026-10-11 实测截图：勾「声明原创」后弹出「原创权益」弹窗，里面有一句
 * 「我已阅读并同意《原声明须知》和《使用条款》」的协议勾选框，和一个**灰掉的**
 * 「声明原创」按钮 —— 必须先勾协议，按钮才变可点，再按它才真正完成声明。
 * 只勾协议不点按钮，等于什么都没做（弹窗会一直挡在编辑页前面）。
 * 没弹出这个弹窗时直接返回，不打扰正常流程。
 */
async function confirmOriginalDialog(page, onStep) {
  // 每轮两条路并用：真实鼠标点 + React 原生 setter。原因是这个协议框是 Ant Design
  // 的受控组件，方框上盖了一层 pointer-events 捕获层，鼠标事件到不了 input；
  // 而 in-page 的 label.click() 会被 React 的 state 回滚直接撤销（实测 checked
  // 一路 false）。用原生 setter 改值再派发事件，才能真正走进 React 的 onChange
  // （2026-10-11 实测：这么点才第一次勾上）。
  for (let round = 0; round < 6; round += 1) {
    const state = await findOriginalDialogState(page)
    if (!state.found) return false
    if (round === 0) await onStep('original-dialog-probe', JSON.stringify({ agreed: state.agreed, check: state.check, hasConfirm: Boolean(state.confirm) }))
    if (!state.agreed) {
      const target = state.check
      if (!target) { await page.waitForTimeout(700); continue }
      await page.mouse.click(target.x, target.y).catch(() => {})
      await page.waitForTimeout(400)
      for (const s of scopes(page)) {
        const done = await s.evaluate(() => {
          const text = Array.from(document.querySelectorAll('*'))
            .filter((el) => /已阅读并同意/u.test(el.innerText || '') && el.getBoundingClientRect().width > 100)
            .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
          if (!text) return false
          const tr = text.getBoundingClientRect()
          const boxEl = Array.from(document.querySelectorAll('.ant-checkbox-inner'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter((c) => c.r.x <= tr.x + 8 && Math.abs(c.r.y - tr.y) < 60 && c.r.width >= 8 && c.r.width <= 40)
            .sort((a, b) => a.r.width - b.r.width)[0]
          const input = boxEl?.el.closest('.ant-checkbox')?.querySelector('input[type=checkbox]')
          if (!input || input.checked) return false
          // React 受控 checkbox：直接改值会被 state 回滚，必须用原型上的原生
          // setter，再派发事件走 React 的 onChange。
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
          if (!desc || typeof desc.set !== 'function') return false
          desc.set.call(input, true)
          for (const type of ['click', 'input', 'change']) input.dispatchEvent(new Event(type, { bubbles: true }))
          return input.checked
        }).catch(() => false)
        if (done) break
      }
      await page.waitForTimeout(900)
      continue
    }
    if (state.confirm) {
      await page.mouse.click(state.confirm.x, state.confirm.y).catch(() => {})
      await page.waitForTimeout(1800)
      // 点完必须**回读弹窗是否真的关了**，不能凭 click 没报错就说成功 ——
      // 2026-10-11 就是这么把「没点上」报成「已确认」的。
      if (!(await findOriginalDialogState(page)).found) {
        await onStep('original-declaration-confirmed', '《原声明须知》已勾选并按「声明原创」完成声明')
        return true
      }
      await onStep('original-dialog-dump', JSON.stringify(await findOriginalDialogState(page)))
      return false
    }
    await page.waitForTimeout(700)
  }
  // 走到这儿说明 6 轮都没成 —— 把当前的真实状态报出来，别静默失败。
  await onStep('original-dialog-dump', JSON.stringify(await findOriginalDialogState(page)))
  return false
}

/**
 * 读出《原声明须知》弹窗当前状态：协议框是否已勾、「声明原创」按钮是否可点。
 * 找不到弹窗就返回 { found: false }，调用方据此直接返回，不打扰正常流程。
 */
async function findOriginalDialogState(page) {
  for (const scope of scopes(page)) {
    const state = await scope.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width } }
      const visible = (el) => el.getBoundingClientRect().width > 0
      // 认弹窗用**标题**「原创权益」，不要用协议句 —— 协议句被拆到多个子节点里，
      // 没有单个叶元素的 textContent 等于整句，按它匹配永远落空（2026-10-11 实测）。
      const title = Array.from(document.querySelectorAll('*'))
        .filter((el) => (el.innerText || '').trim() === '原创权益')
        .filter(visible)[0]
      if (!title) return { found: false }
      const dialog = title.closest('[class*=dialog], [class*=modal], [role=dialog]') || title.parentElement

      // 协议方块**只存在于编辑器那个 iframe 里**（2026-10-11 实测：顶层文档
      // querySelectorAll('.ant-checkbox-inner') 命中 0 个，三个 frame 里只有
      // channels.weixin.qq.com/micro/content/post/create 那个有 6 个）。所以遍历
      // 所有 frame 取有方块的那个，别只看顶层。
      const inners = Array.from(document.querySelectorAll('.ant-checkbox-inner')).filter(visible)
      if (!inners.length) return { found: false }
      const agreeText = Array.from(document.querySelectorAll('*'))
        .filter((el) => /已阅读并同意/u.test(el.innerText || ''))
        .filter(visible)
        .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0] || null
      const boxEl = agreeText
        ? (() => {
            const tr = agreeText.getBoundingClientRect()
            return inners
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter((c) => c.r.x <= tr.x + 8 && Math.abs(c.r.y - tr.y) < 60 && c.r.width >= 8 && c.r.width <= 40)
              .sort((a, b) => a.r.width - b.r.width)[0]
          })()
        : null
      const input = boxEl?.el.closest('.ant-checkbox')?.querySelector('input[type=checkbox]')
      const agreed = Boolean(input && input.checked)
      let check = null
      if (!agreed && boxEl) check = { x: boxEl.r.x + boxEl.r.width / 2, y: boxEl.r.y + boxEl.r.height / 2, w: boxEl.r.width }

      // 「声明原创」按钮**不是弹窗容器的后代** —— 实测 dialog 里只查得到右上角
      // 那个关闭按钮（weui-desktop-dialog__close-btn），「取消 / 声明原创」是它的
      // 兄弟节点（2026-10-11 outerHTML dump）。所以按**几何**取：先用「取消」锚住
      // 那一行，再在它右边找「声明原创」。这样既能排掉编辑器里那个同名 checkbox
      // 标签，也不用猜弹层容器。
      const cancelBox = Array.from(document.querySelectorAll('*'))
        .filter((el) => (el.innerText || '').trim() === '取消')
        .filter((el) => !el.closest('.ant-checkbox'))
        .filter(visible)
        .map(rect)
        .filter((r) => r.w > 40 && r.w < 220)
        .sort((a, b) => a.y - b.y)[0] || null
      const inButtonRow = (r) => Boolean(cancelBox) && r && Math.abs(r.y - cancelBox.y) < 24 && r.x > cancelBox.x
      const isEnabled = (el) => {
        // 灰态在 weui 里是 _disabled 类，也可能落在祖先上（外层包着按钮的 div）。
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const c = String(p.className || '')
          if (p.disabled || c.includes('disabled') || c.includes('weui-desktop-btn_disabled')) return false
        }
        return true
      }
      const confirm = Array.from(document.querySelectorAll('button, [class*=btn], span, div, a'))
        .filter((el) => (el.innerText || '').trim() === '声明原创')
        .filter((el) => !el.closest('.ant-checkbox'))
        .filter(visible)
        .map((el) => ({ el, r: rect(el) }))
        .filter((c) => inButtonRow(c.r))
        .filter((c) => c.r.w > 20)
        // 取最外层（最宽）的那个：它才是真正可点的按钮容器，中心点与实心背景重合。
        .sort((a, b) => b.r.w - a.r.w)[0] || null

      const btnLike = Array.from(document.querySelectorAll('button, [class*=btn]'))
        .map((el) => ({ t: (el.innerText || '').trim(), cls: String(el.className || ''), disabled: !isEnabled(el), w: Math.round(el.getBoundingClientRect().width) }))
        .filter((b) => b.t.length <= 6 && b.w > 0)
      return {
        found: true,
        // 协议勾没勾**读 input.checked**，不要从按钮反推 —— 按钮灰着只说明「还没生效」，
        // 拿它当 agreed 会让流程一直停在勾选那一步，反复点方框把它又点回去
        // （2026-10-11 实测：按钮可点与否和协议状态被搞混，来回抵消）。
        agreed,
        check,
        confirm: confirm && isEnabled(confirm.el) ? confirm.r : null,
        confirmRaw: confirm ? confirm.r : null,
        btnLike: confirm ? null : btnLike,
      }
    }).catch(() => null)
    if (state && state.found) return state
  }
  return { found: false }
}

/**
 * 展开「视频标注」下拉、读出选项，并选中与 AI 生成相关的一项。
 *
 * 2026-10-11 真机确认该控件是 `form-item.post-with-mark-tag`，占位「选择视频标注」。
 * 选项文案以平台实际渲染为准（不预设「含AI生成内容」这种写法），所以先读再选；
 * 选不到就返回选项清单，由调用方如实报「有哪些可选」，而不是笼统说找不到。
 */
async function openMarkTagDropdown(scope, page) {
  const box = await scope.evaluate(() => {
    const item = document.querySelector('.post-with-mark-tag') || document.querySelector('.form-item.cell-center')
    if (!item) return null
    for (const el of item.querySelectorAll('*')) {
      const t = (el.innerText || '').trim()
      if (t === '视频标注' || t === '选择视频标注') {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
    }
    const r = item.getBoundingClientRect()
    return r.width > 0 ? { x: r.x + Math.min(180, r.width / 2), y: r.y + r.height / 2 } : null
  }).catch(() => null)
  if (!box) return null
  // 同样不能用 iframe 内坐标配 page.mouse —— 打标记再让 locator 换算。
  await scope.evaluate(() => {
    const item = document.querySelector('.post-with-mark-tag') || document.querySelector('.form-item.cell-center')
    if (!item) return
    for (const el of item.querySelectorAll('*')) {
      const t = (el.innerText || '').trim()
      if (t === '视频标注' || t === '选择视频标注') { el.setAttribute('data-lwb-marktag', '1'); return }
    }
    item.setAttribute('data-lwb-marktag', '1')
  }).catch(() => {})
  const target = await scope.locator('[data-lwb-marktag="1"]').first().boundingBox().catch(() => null)
  const clickAt = target || box
  await page.mouse.click(clickAt.x + clickAt.width / 2, clickAt.y + clickAt.height / 2).catch(() => {})
  await page.waitForTimeout(1500)
  const options = await scope.evaluate(() => Array.from(document.querySelectorAll('li, [role="option"], [class*="option"], [class*="menu-item"], [class*="dropdown"] li, [class*="select"] [class*="item"]'))
    .map((el) => (el.innerText || '').trim().replace(/\s+/g, ' '))
    .filter((t) => t && t.length > 1 && t.length < 24)
    .filter((t, i, arr) => arr.indexOf(t) === i)).catch(() => [])
  if (!options.length) return { options: [], picked: null }
  // 优先选含 AI / 生成 的选项；找不到就不瞎选，把清单交回去。
  const wanted = options.find((t) => /AI|人工智能/i.test(t) && /生成/u.test(t)) || options.find((t) => /AI|人工智能/u.test(t)) || null
  if (!wanted) return { options, picked: null }
  const clicked = await scope.evaluate((text) => {
    const el = Array.from(document.querySelectorAll('li, [role="option"], [class*="option"], [class*="menu-item"], [class*="item"]'))
      .find((n) => (n.innerText || '').trim().replace(/\s+/g, ' ') === text)
    if (!el) return false
    el.click()
    return true
  }, wanted).catch(() => false)
  await page.waitForTimeout(1200)
  return { options, picked: clicked ? wanted : null }
}

export default wechatAdapter
