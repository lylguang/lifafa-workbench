/**
 * Kuaishou (快手创作者服务平台) adapter.
 *
 * Same contract as the douyin adapter: every selector is a priority list so a
 * platform redesign degrades into a screenshot-and-error instead of a wrong
 * click. Verified live against the signed-out state only — the editor
 * selectors need one calibration pass after the first real login.
 *
 * Kuaishou-specific notes:
 *  - An unauthenticated visit to the publish URL stays on
 *    `cp.kuaishou.com/article/publish/video` but renders the marketing landing
 *    page with a 立即登录 button instead of the upload form (verified live), so
 *    the login check must look at the page, not just the URL.
 *  - The web form folds the caption and hashtags into one 作品描述 field.
 */

const ORIGIN = 'https://cp.kuaishou.com'
const UPLOAD_URL = `${ORIGIN}/article/publish/video`
const MANAGE_URL = `${ORIGIN}/article/manage/video`

const SELECTORS = {
  loggedIn: [
    '[class*="user-info"]',
    'img[class*="avatar"]',
    '[class*="avatar"]',
  ],
  loggedOut: [
    'text=立即登录',
    'text=扫码登录',
    'text=平台介绍',
  ],
  nickname: [
    '[class*="user-info"] [class*="name"]',
    '[class*="nickname"]',
    '[class*="userName"]',
  ],
  fileInput: [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
  ],
  uploadDone: [
    'textarea[placeholder*="描述"]',
    'text=作品描述',
    'text=封面',
  ],
  description: [
    'textarea[placeholder*="描述"]',
    'textarea[placeholder*="介绍"]',
    '[contenteditable="true"]',
  ],
  title: [
    'input[placeholder*="标题"]',
  ],
  submit: [
    'button:has-text("发布")',
    'button:has-text("发表")',
    '[class*="publish"] button',
  ],
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

export const kuaishouAdapter = {
  id: 'kuaishou',
  label: '快手',
  loginUrl: ORIGIN,
  uploadUrl: UPLOAD_URL,
  manageUrl: MANAGE_URL,

  /**
   * The signed-out publish URL keeps its address and renders the landing
   * page, so "am I on the login page" is answered by content, not URL.
   */
  async isLoggedIn(page) {
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    const loggedOut = await firstMatch(page, SELECTORS.loggedOut)
    if (loggedOut) return false
    const loggedIn = await firstMatch(page, SELECTORS.loggedIn, { timeout: 8000 })
    if (loggedIn) return true
    // Neither marker matched: treat the upload form's own fields as proof.
    const editor = await firstMatch(page, SELECTORS.uploadDone)
    return Boolean(editor)
  },

  async readIdentity(page) {
    const nickname = await textOf(page, SELECTORS.nickname)
    return { nickname, handle: null }
  },

  async publish(page, { videoPath, content, coverPaths = {}, submitMode, onStep = async () => {} }) {
    const title = String(content?.title || '').trim()
    const description = String(content?.description || content?.copy || '').trim()
    const tags = normalizeTags(content?.tags)

    await onStep('open', '打开快手上传页')
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    const landing = await firstMatch(page, SELECTORS.loggedOut)
    if (landing) {
      const error = new Error('快手登录态已失效，请在账号页重新扫码登录。')
      error.code = 'PUBLISHER_LOGIN_REQUIRED'
      throw error
    }

    await onStep('upload', '上传视频文件')
    const fileInput = await firstMatch(page, SELECTORS.fileInput, { timeout: 20_000 })
    if (!fileInput) {
      const error = new Error('未找到视频上传入口，快手页面结构可能已调整。')
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

    await onStep('metadata', '填写作品描述')
    const descriptionBox = await firstMatch(page, SELECTORS.description)
    if (descriptionBox) {
      const combined = [title, description].filter(Boolean).join('\n')
      await descriptionBox.click()
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
      } catch { /* the description already carries the title */ }
    }

    const coverPath = coverPaths.landscape || coverPaths.portrait || null
    if (coverPath) {
      await onStep('cover', '上传封面')
      try {
        const coverEntry = await firstMatch(page, ['text=设置封面', 'text=上传封面', 'text=编辑封面', '[class*="cover"] [class*="edit"]'])
        if (coverEntry) {
          await coverEntry.click()
          await page.waitForTimeout(1500)
          const coverInput = await firstMatch(page, ['input[type="file"][accept*="image"]', 'input[type="file"]'], { timeout: 8000 })
          if (coverInput) {
            await coverInput.setInputFiles(coverPath)
            await page.waitForTimeout(4000)
            const confirm = await firstMatch(page, ['button:has-text("确定")', 'button:has-text("完成")', 'button:has-text("确认")'])
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
    const submit = await firstMatch(page, SELECTORS.submit, { timeout: 15_000 })
    if (!submit) {
      const error = new Error('未找到发布按钮，请改为「发布前确认」模式人工提交。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await submit.click()

    await onStep('verify', '等待平台受理并读回作品状态')
    await page.waitForTimeout(8000)
    const url = page.url()
    return { submitted: true, remoteUrl: /manage/iu.test(url) ? MANAGE_URL : url }
  },
}

export default kuaishouAdapter
