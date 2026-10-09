/**
 * Bilibili (B站投稿) adapter.
 *
 * Same contract as the douyin adapter: every selector is a priority list so a
 * platform redesign degrades into a screenshot-and-error instead of a wrong
 * click, and the flow is verified against the signed-out state only — the
 * editor selectors need one live calibration pass after the first real login.
 *
 * Bilibili-specific constraints that shape this file:
 *  - The upload URL redirects to `passport.bilibili.com/login` when signed
 *    out, which makes the login check a pure URL test (verified live).
 *  - 分区 (content partition) is a required field with no default. Auto mode
 *    must fail BEFORE uploading rather than waste a multi-hundred-MB transfer
 *    on a submission the platform will reject; confirm mode leaves it to the
 *    person who is already looking at the window.
 *  - 创作声明 (content declaration) is a second required dropdown the 2026-10
 *    editor introduced. Same policy as partition: configurable through
 *    `content.declaration`, otherwise confirm-mode leaves it to the human and
 *    auto-mode fails before wasting the upload.
 *
 * 2026-10-02 live calibration (first real logged-in publish):
 *  - The file inputs carry EXTENSION-style accept lists (".mp4,.flv,...") and
 *    are hidden but enabled — accept*="video" never matches, and waiting for
 *    visibility dead-ends. setInputFiles does not need visibility.
 *  - Selecting a file enters the editor IMMEDIATELY while bytes are still
 *    uploading ("上传中…" chip). The editor must not be treated as "done";
 *    the real gate is the "上传完成" marker.
 *  - The 简介 box is a Quill editor (div.ql-editor[contenteditable]), not a
 *    textarea — no textarea exists on the page at all.
 *  - The editor pre-fills the file name as the title; the title fill below
 *    replaces it wholesale (verified).
 *  - Local un-submitted sessions persist ("本地浏览器存在N个未提交的视频").
 *    A human starting fresh discards them ("不用了"); keeping them would merge
 *    stale videos into this submission.
 */

const ORIGIN = 'https://member.bilibili.com'
const UPLOAD_URL = `${ORIGIN}/platform/upload/video/frame`
const MANAGE_URL = `${ORIGIN}/platform/upload-manager/article`

const SELECTORS = {
  loggedIn: [
    '.avatar',
    'img[class*="avatar"]',
    '[class*="header-entry-mini"]',
    '.bp-img-avatar',
  ],
  loggedOut: [
    'text=扫码登录',
    'text=密码登录',
    'text=账号登录',
  ],
  nickname: [
    '.nickname',
    '[class*="nickname"]',
    '[class*="user-name"]',
  ],
  // 本地遗留的未提交会话会混进本次投稿，真人会点「不用了」丢弃。
  recoveryDismiss: [
    'button:has-text("不用了")',
    'text=不用了',
  ],
  fileInput: [
    // 2026-10 实测：accept 是扩展名列表（.mp4,.flv,...）且 input 隐藏但可用。
    'input[type="file"][accept*=".mp4"]',
    'input[type="file"][accept*="video"]',
    'input[type="file"]:not([accept*=".txt"])',
    'input[type="file"]',
  ],
  uploadTrigger: [
    // 真人路径：点可见的「上传视频」按钮（或拖拽区），拦截 fileChooser。
    'text=上传视频',
    'text=点击上传',
  ],
  uploadDone: [
    'text=上传完成',
    'input[placeholder*="标题"]',
    'text=填写标题',
    'text=基本设置',
  ],
  uploadComplete: [
    // 字节级完成标记（文件 chip 与文件行各一个，出现即传输结束）。
    'text=上传完成',
    'text=上传成功',
  ],
  promoDismiss: [
    // 「批量上传将生成多条动态…」之类的推广弹窗，真人会点暂不/关闭。
    'button:has-text("暂不设置")',
    'text=暂不设置',
    'button:has-text("以后再说")',
    'text=以后再说',
  ],
  title: [
    'input[placeholder*="标题"]',
    '.video-title input',
  ],
  // 2026-10 实测：简介是 Quill 编辑器，页面上没有任何 textarea。
  description: [
    'div[contenteditable="true"]:below(:text("简介"))',
    '[class*="introduction"] .ql-editor',
    '[class*="description"] .ql-editor',
    '.ql-editor[contenteditable="true"]',
    'textarea[placeholder*="简介"]',
    'textarea[placeholder*="填写"]',
  ],
  tags: [
    'input[placeholder*="标签"]',
    'input[placeholder*="回车"]',
  ],
  declaration: [
    'text=请选择符合您视频内容的创作声明',
    '[class*="declaration"] [class*="select"]',
  ],
  partition: [
    'text=请选择分区',
    '[class*="partition"] [class*="select"]',
  ],
  coverAdd: [
    'text=添加封面',
    'text=上传封面',
    'text=修改封面',
  ],
  submit: [
    // 2026-10 实测：新版编辑器的提交按钮是 div/span 里的「立即投稿」，不是 button。
    'text=立即投稿',
    'button:has-text("投稿")',
    '[class*="submit"] button',
  ],
  submitted: [
    'text=投稿成功',
    'text=稿件投递成功',
    'text=提交成功',
  ],
}

async function firstMatch(page, selectors, { timeout = 0, visible = true } = {}) {
  const perTry = timeout > 0 ? Math.max(500, Math.floor(timeout / selectors.length)) : 0
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first()
      if (perTry > 0) {
        await locator.waitFor({ state: visible ? 'visible' : 'attached', timeout: perTry })
      } else if (await locator.count() === 0) {
        continue
      } else if (visible && !(await locator.isVisible())) {
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

/** 真人节奏：动作之间留 0.25–0.7s 的自然停顿，不做机械连击。 */
function pause(page, min = 250, max = 700) {
  return page.waitForTimeout(min + Math.floor(Math.random() * (max - min)))
}

/** 真人点击：先滚动进视野，鼠标移过去，稍作停顿再点。 */
async function humanClick(locator, page) {
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  await locator.hover().catch(() => {})
  await pause(page, 200, 500)
  await locator.click()
}

/**
 * 打开下拉后按文本挑选项：B 站新版下拉的面板 DOM 没有稳定 class，
 * 只能在可见文本里精确匹配。返回是否选中。
 */
async function pickOptionByText(page, wanted, { timeout = 6000 } = {}) {
  const wantedText = String(wanted || '').trim()
  if (!wantedText) return false
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const candidates = page.locator('[role="option"], [class*="option"], [class*="dropdown"] [class*="item"], [class*="popover"] [class*="item"], [class*="menu"] [class*="item"], li')
    const total = Math.min(await candidates.count(), 120)
    // 两遍扫描：先精确匹配，找不到再退包含匹配——导航栏的 li 也在候选里，
    // 精确优先能避免点到同名/包含同名文本的无关元素。
    for (const exact of [true, false]) {
      for (let i = 0; i < total; i++) {
        const text = (await candidates.nth(i).innerText().catch(() => '')).trim().replace(/\s+/gu, ' ')
        if (!text || text.length > 30) continue
        if (text === wantedText || (!exact && text.includes(wantedText))) {
          await candidates.nth(i).click().catch(() => {})
          return true
        }
      }
    }
    await page.waitForTimeout(400)
  }
  return false
}

/** 关掉平台推广弹窗（存在才点，点了不等待）。 */
async function dismissPrompts(page, onStep, labels) {
  const dismiss = await firstMatch(page, SELECTORS.promoDismiss)
  if (dismiss) {
    await dismiss.click().catch(() => {})
    if (onStep) await onStep('promo-dismissed', labels || '已关闭平台推广弹窗')
    await pause(page)
    return true
  }
  return false
}

function normalizeTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag).replace(/^#/u, '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

export const bilibiliAdapter = {
  id: 'bilibili',
  label: 'B站',
  loginUrl: 'https://passport.bilibili.com/login',
  uploadUrl: UPLOAD_URL,
  manageUrl: MANAGE_URL,

  /** Signed-out visits are redirected to passport, so the URL decides. */
  async isLoggedIn(page) {
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    if (/passport\.bilibili\.com|login/iu.test(page.url())) return false
    const loggedIn = await firstMatch(page, SELECTORS.loggedIn, { timeout: 8000 })
    if (loggedIn) return true
    const loggedOut = await firstMatch(page, SELECTORS.loggedOut)
    return loggedOut === null && /member\.bilibili\.com/iu.test(page.url())
  },

  async readIdentity(page) {
    const nickname = await textOf(page, SELECTORS.nickname)
    return { nickname, handle: null }
  },

  async publish(page, { videoPath, content, coverPaths = {}, submitMode, onStep = async () => {} }) {
    const title = String(content?.title || '').trim()
    const description = String(content?.description || content?.copy || '').trim()
    const tags = normalizeTags(content?.tags)
    const declaration = String(content?.declaration || '').trim()
    const partition = String(content?.partition || '').trim()

    await onStep('open', '打开 B 站投稿页')
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    if (/passport\.bilibili\.com|login/iu.test(page.url())) {
      const error = new Error('B 站登录态已失效，请在账号页重新扫码登录。')
      error.code = 'PUBLISHER_LOGIN_REQUIRED'
      throw error
    }
    // 本地遗留的未提交会话必须丢弃，否则恢复后旧视频会混进本次投稿。
    const stale = await firstMatch(page, SELECTORS.recoveryDismiss)
    if (stale) {
      await stale.click().catch(() => {})
      await onStep('recovery-discarded', '已丢弃本地遗留的未提交会话')
      await page.waitForTimeout(1500)
    }

    await onStep('upload', '上传视频文件（点击上传按钮，与真人同一路径）')
    // 真人路径：点可见的上传按钮，拦截文件选择器；拦截不到再退回隐藏 input。
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null)
    const trigger = await firstMatch(page, SELECTORS.uploadTrigger)
    let uploaded = false
    if (trigger) {
      await trigger.click().catch(() => {})
      const chooser = await chooserPromise
      if (chooser) {
        await chooser.setFiles(videoPath)
        uploaded = true
      }
    }
    if (!uploaded) {
      const fileInput = await firstMatch(page, SELECTORS.fileInput, { timeout: 20_000, visible: false })
      if (!fileInput) {
        const error = new Error('未找到视频上传入口，B 站页面结构可能已调整。')
        error.code = 'PUBLISHER_ADAPTER_SELECTOR'
        throw error
      }
      await fileInput.setInputFiles(videoPath)
    }

    await onStep('editor', '等待进入发布编辑页')
    const editorReady = await firstMatch(page, SELECTORS.uploadDone, { timeout: 120_000 })
    if (!editorReady) {
      const error = new Error('视频上传后未能进入编辑页（可能仍在转码，或平台拒绝了该文件）。')
      error.code = 'PUBLISHER_UPLOAD_STALLED'
      throw error
    }
    await page.waitForTimeout(2000)
    await dismissPrompts(page, onStep)

    await onStep('metadata', '填写标题与简介')
    const titleBox = await firstMatch(page, SELECTORS.title)
    if (titleBox) {
      // 新编辑器会用文件名预填标题，必须整体替换。
      await humanClick(titleBox, page)
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.insertText(title)
      await pause(page)
    }
    const descriptionBox = await firstMatch(page, SELECTORS.description)
    if (descriptionBox) {
      await humanClick(descriptionBox, page)
      await page.keyboard.insertText(description)
      await pause(page)
    }

    // Bilibili tags are committed per tag, not inline hashtags. 平台会在上传完成时
    // 自动加推荐标签占掉名额（2026-10 实测 3 个），撞上限会弹 toast——见好就收。
    if (tags.length) {
      await onStep('tags', '添加标签')
      const tagInput = await firstMatch(page, SELECTORS.tags)
      if (tagInput) {
        let added = 0
        for (const tag of tags) {
          await humanClick(tagInput, page)
          await page.keyboard.insertText(tag)
          await pause(page, 300, 600)
          await page.keyboard.press('Enter')
          await pause(page, 300, 600)
          const capped = await firstMatch(page, ['text=允许添加的标签已经达到上限', 'text=标签已经达到上限', 'text=达到上限'], { timeout: 1200 })
          if (capped) {
            const skipped = tags.length - added - 1
            await onStep('tags-capped', `平台标签名额已满（含平台自动推荐），本条剩余 ${skipped} 个标签未添加`)
            break
          }
          added += 1
        }
      }
    }

    await onStep('declaration', '选择创作声明')
    // 占位符消失 = 已有值（平台可能预选）。有占位符且配置了声明才去点开挑选。
    const declarationTrigger = await firstMatch(page, SELECTORS.declaration)
    let declarationSelected = declarationTrigger === null
    if (declarationTrigger && declaration) {
      await humanClick(declarationTrigger, page)
      declarationSelected = await pickOptionByText(page, declaration)
      await pause(page)
    }
    if (!declarationSelected && submitMode === 'auto') {
      const error = new Error('B 站创作声明未能自动选择；该字段必填，请在任务内容里配置 declaration，或改用「发布前确认」模式人工选择。')
      error.code = 'PUBLISHER_DECLARATION_REQUIRED'
      throw error
    }
    if (!declarationSelected) {
      await onStep('declaration-manual', '创作声明未自动选择（必填），请在窗口中人工选择')
    }

    await onStep('partition', '选择内容分区')
    // 2026-10 实测：平台经常按内容自动预选分区（占位符消失），这时不要误报。
    const partitionTrigger = await firstMatch(page, SELECTORS.partition)
    let partitionSelected = partitionTrigger === null
    if (partitionSelected) {
      await onStep('partition-prefilled', '分区已被平台自动预选')
    } else if (partition) {
      await humanClick(partitionTrigger, page)
      partitionSelected = await pickOptionByText(page, partition)
      await pause(page)
    }
    if (!partitionSelected && submitMode === 'auto') {
      const error = new Error('B 站分区未能自动选择；分区是必填项，请在任务内容里配置 partition（如「人工智能」），或改用「发布前确认」模式人工选择，避免白传一次大文件。')
      error.code = 'PUBLISHER_PARTITION_REQUIRED'
      throw error
    }
    if (!partitionSelected) {
      await onStep('partition-manual', '分区未自动选中，请在窗口中人工选择')
    }

    const coverPath = coverPaths.landscape || coverPaths.portrait || null
    if (coverPath) {
      await onStep('cover', '上传封面（与真人同路径：添加封面 → 本地上传）')
      let covered = false
      try {
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null)
        const coverEntry = await firstMatch(page, SELECTORS.coverAdd)
        if (coverEntry) {
          await humanClick(coverEntry, page)
          const dialogUpload = await firstMatch(page, ['text=本地上传', 'text=上传封面'], { timeout: 3500 })
          if (dialogUpload) await dialogUpload.click().catch(() => {})
          const chooser = await chooserPromise
          if (chooser) {
            await chooser.setFiles(coverPath)
            covered = true
          } else {
            const coverInput = await firstMatch(page, ['input[type="file"][accept*="image"]', 'input[type="file"]'], { timeout: 6000, visible: false })
            if (coverInput) {
              await coverInput.setInputFiles(coverPath)
              covered = true
            }
          }
          if (covered) {
            await page.waitForTimeout(4000)
            // 弹窗里的「完成」也是 div 假按钮（button: 选择器永远数 0，2026-10 实测），
            // 必须用带引号的精确文本匹配；以按钮消失（弹窗关闭）为准，最多补点两次。
            for (let attempt = 0; attempt < 3; attempt++) {
              const confirm = await firstMatch(page, ['text="完成"', 'text="确定"', 'text="确认"'])
              if (!confirm) break
              await confirm.click().catch(() => {})
              await page.waitForTimeout(2500)
            }
          } else {
            await page.keyboard.press('Escape').catch(() => {})
          }
        }
      } catch { covered = false }
      if (!covered) await onStep('cover-skipped', '封面未自动设置，请在窗口中人工选择（或采用平台推荐封面）')
    }

    // 字节级完成门：编辑器骨架在选完文件瞬间就出现，不能用它判断「传完了」。
    await onStep('uploading', '等待视频传输完成')
    const doneMark = await firstMatch(page, SELECTORS.uploadComplete, { timeout: 600_000 })
    if (!doneMark) {
      const error = new Error('视频传输超过 10 分钟仍未完成（可能网络中断，或平台拒绝该文件）。')
      error.code = 'PUBLISHER_UPLOAD_STALLED'
      throw error
    }

    if (submitMode === 'confirm') {
      await onStep('awaiting-confirm', '已停在投稿前，请在窗口中确认（注意创作声明与分区）')
      return { submitted: false, remoteUrl: null }
    }

    await onStep('submit', '提交投稿')
    const submit = await firstMatch(page, SELECTORS.submit, { timeout: 15_000 })
    if (!submit) {
      const error = new Error('未找到投稿按钮，请改为「发布前确认」模式人工提交。')
      error.code = 'PUBLISHER_ADAPTER_SELECTOR'
      throw error
    }
    await humanClick(submit, page)

    await onStep('verify', '等待平台受理并读回稿件状态')
    const accepted = await firstMatch(page, SELECTORS.submitted, { timeout: 30_000 })
    const url = page.url()
    return { submitted: true, remoteUrl: accepted || /upload-manager|manage/iu.test(url) ? MANAGE_URL : url }
  },
}

export default bilibiliAdapter
