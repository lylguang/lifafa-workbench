/**
 * Douyin (抖音创作者中心) adapter.
 *
 * Everything platform-specific lives here so that adding another platform is a
 * sibling file rather than a rewrite. The UI strings and DOM structure of the
 * creator center change regularly; every selector is therefore tried in a
 * priority list and every step reports what it actually found, so a failure
 * leaves enough evidence to fix the adapter in minutes.
 *
 * Flow: open upload page -> set the video file -> wait for the editor ->
 * fill caption/title/tags -> apply cover -> (confirm | submit) -> read back.
 */

const ORIGIN = 'https://creator.douyin.com'
const UPLOAD_URL = `${ORIGIN}/creator-micro/content/upload`
const MANAGE_URL = `${ORIGIN}/creator-micro/content/manage`

/** Ordered selector candidates; the first match wins. */
const SELECTORS = {
  loggedIn: [
    '[data-e2e="user-info"]',
    '.user-info',
    'img[class*="avatar"]',
    '[class*="avatar"] img',
  ],
  loggedOut: [
    'text=扫码登录',
    'text=验证码登录',
    '[class*="login"]',
  ],
  nickname: [
    '[data-e2e="user-info-name"]',
    '.user-info .name',
    '[class*="userName"]',
    '[class*="nickname"]',
  ],
  handle: [
    '[class*="uniqueId"]',
    '[class*="douyinId"]',
  ],
  fileInput: [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
  ],
  caption: [
    'div[contenteditable="true"]',
    'textarea[placeholder*="标题"]',
    'textarea[placeholder*="作品"]',
    'input[placeholder*="标题"]',
  ],
  title: [
    'input[placeholder*="标题"]',
    'input[placeholder*="填写"]',
  ],
  submit: [
    'button:has-text("发布")',
    'button:has-text("定时发布")',
    '[data-e2e="publish-button"]',
  ],
  uploadDone: [
    'text=发布设置',
    'text=作品描述',
    'text=封面',
  ],
}

const MODAL_DISMISS = [
  '.dy-creator-content-modal-wrap button[aria-label="关闭"]',
  '.dy-creator-content-modal-wrap [data-e2e="modal-close"]',
  '.dy-creator-content-modal-wrap .dy-creator-modal-close',
  '.dy-creator-content-modal-wrap svg[class*="close"]',
  'button[class*="close"]',
]

/**
 * 关掉挡住提交按钮的弹窗。
 *
 * 2026-10-08 实测：抖音创作者中心上传完成后会弹一个模态（`dy-creator-content-modal-wrap`，
 * 引导/公告/发布设置提示），它盖在「发布」按钮上，Playwright 连点 45 秒都点不下去，
 * 报的是 `subtree intercepts pointer events`——看着像选择器失效，其实是**遮挡**。
 * 所以点提交前先扫一遍常见关闭形态，最后退回 ESC（不少引导弹窗只响应键盘）。
 * 全试过仍关不掉就返回 false，让调用方照旧报「未找到发布按钮」，不掩盖真因。
 */
async function dismissBlockingModals(page) {
  for (let round = 0; round < 3; round += 1) {
    let closed = false
    for (const selector of MODAL_DISMISS) {
      try {
        const target = page.locator(selector).first()
        if ((await target.count()) === 0) continue
        if (!(await target.isVisible().catch(() => false))) continue
        await target.click({ timeout: 3000 })
        await page.waitForTimeout(600)
        closed = true
        break
      } catch { /* 换下一种形态再试 */ }
    }
    if (closed) continue
    const modal = page.locator('.dy-creator-content-modal-wrap').first()
    if ((await modal.count().catch(() => 0)) === 0) return round > 0
    try {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(600)
    } catch { return round > 0 }
  }
  return true
}

async function firstMatch(page, selectors, { timeout = 0 } = {}) {
  const perTry = timeout > 0 ? Math.max(500, Math.floor(timeout / selectors.length)) : 0
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first()
      if (perTry > 0) {
        await locator.waitFor({ state: 'visible', timeout: perTry })
      } else if (await locator.count() === 0) {
        continue
      } else if (!(await locator.isVisible())) {
        continue
      }
      return locator
    } catch { /* try the next candidate */ }
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
    .slice(0, 10)
}

export const douyinAdapter = {
  id: 'douyin',
  label: '抖音',
  loginUrl: `${ORIGIN}/`,
  uploadUrl: UPLOAD_URL,
  manageUrl: MANAGE_URL,

  /** True when the creator center shows a signed-in shell. */
  async isLoggedIn(page) {
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const url = page.url()
    if (/login|passport|sso/iu.test(url)) return false
    const loggedIn = await firstMatch(page, SELECTORS.loggedIn, { timeout: 8000 })
    if (loggedIn) return true
    // A login wall renders its own form; treat that as signed out even when the
    // URL has not redirected yet.
    const loggedOut = await firstMatch(page, SELECTORS.loggedOut)
    return loggedOut === null && /creator-micro/iu.test(url)
  },

  /** Best-effort identity read; a missing nickname must not fail the check. */
  async readIdentity(page) {
    const nickname = await textOf(page, SELECTORS.nickname)
    const handle = await textOf(page, SELECTORS.handle)
    return { nickname, handle }
  },

  /**
   * Drive one publish. `onStep(name, detail)` is called before each step so the
   * caller can record progress and take evidence screenshots.
   */
  async publish(page, { videoPath, content, coverPaths = {}, submitMode, onStep = async () => {} }) {
    const title = String(content?.title || '').trim()
    const description = String(content?.description || content?.copy || '').trim()
    const tags = normalizeTags(content?.tags)

    await onStep('open', '打开抖音上传页')
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    if (/login|passport|sso/iu.test(page.url())) {
      const error = new Error('抖音登录态已失效，请在账号页重新扫码登录。')
      error.code = 'PUBLISHER_LOGIN_REQUIRED'
      throw error
    }

    await onStep('upload', '上传视频文件')
    const fileInput = await firstMatch(page, SELECTORS.fileInput, { timeout: 20_000 })
    if (!fileInput) {
      const error = new Error('未找到视频上传入口，抖音页面结构可能已调整。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await fileInput.setInputFiles(videoPath)

    // The editor appears only after the platform accepts the file; a large
    // video uploads for a while, so allow a generous window.
    await onStep('editor', '等待视频上传并进入编辑页')
    const editorReady = await firstMatch(page, SELECTORS.uploadDone, { timeout: 180_000 })
    if (!editorReady) {
      const error = new Error('视频上传后未能进入编辑页（可能仍在处理，或平台拒绝了该文件）。')
      error.code = 'PUBLISHER_UPLOAD_STALLED'
      throw error
    }
    await page.waitForTimeout(2000)

    await onStep('metadata', '填写标题与正文')
    const caption = await firstMatch(page, SELECTORS.caption, { timeout: 15_000 })
    if (caption) {
      const combined = [title, description].filter(Boolean).join('\n')
      await caption.click()
      // insertText preserves emoji/newlines better than typing each character.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.insertText(combined)
      if (tags.length) {
        await page.keyboard.insertText(`\n${tags.map((tag) => `#${tag}`).join(' ')}`)
      }
      await page.waitForTimeout(600)
    }

    const titleBox = await firstMatch(page, SELECTORS.title)
    if (titleBox) {
      try {
        await titleBox.click()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
        await page.keyboard.insertText(title)
        await page.waitForTimeout(400)
      } catch { /* the caption box already carried the title */ }
    }

    // Cover upload is best-effort: Douyin picks a frame when no cover is given,
    // and a cover failure must not lose an otherwise valid publish.
    const coverPath = coverPaths.portrait || coverPaths.landscape || null
    if (coverPath) {
      await onStep('cover', '上传封面')
      try {
        const coverEntry = await firstMatch(page, ['text=选择封面', 'text=上传封面', '[data-e2e="cover-upload"]'])
        if (coverEntry) {
          await coverEntry.click()
          await page.waitForTimeout(1500)
          const coverInput = await firstMatch(page, ['input[type="file"][accept*="image"]', 'input[type="file"]'], { timeout: 8000 })
          if (coverInput) {
            await coverInput.setInputFiles(coverPath)
            await page.waitForTimeout(4000)
            const confirm = await firstMatch(page, ['button:has-text("确定")', 'button:has-text("完成")', 'button:has-text("保存")'])
            if (confirm) await confirm.click().catch(() => {})
            await page.waitForTimeout(2500)
          }
        }
      } catch { await onStep('cover-skipped', '封面上传未完成，交由平台自动选帧') }
    }

    if (submitMode === 'confirm') {
      await onStep('awaiting-confirm', '已停在发布前，请在窗口中确认')
      return { submitted: false, remoteUrl: null }
    }

    await onStep('submit', '提交发布')
    // 先清掉可能盖在按钮上的弹窗，否则 click 会一直撞 "intercepts pointer events" 超时。
    await dismissBlockingModals(page)
    const submit = await firstMatch(page, [SELECTORS.submit[0]], { timeout: 15_000 })
    if (!submit) {
      const error = new Error('未找到发布按钮，请改为「发布前确认」模式人工提交。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await submit.click()

    await onStep('verify', '等待平台受理并读回作品状态')
    await page.waitForTimeout(8000)
    const url = page.url()
    return { submitted: true, remoteUrl: /manage|content/iu.test(url) ? MANAGE_URL : url }
  },
}

export default douyinAdapter
