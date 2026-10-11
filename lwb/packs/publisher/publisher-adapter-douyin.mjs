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
  /**
   * 封面。两段式：先点封面区的「选择封面」打开弹窗，**再在弹窗内部**找上传入口。
   *
   * 2026-10-11 实测截图纠正了上一版的两个错误假设：
   *  1. 页面上没有「上传封面」「自定义封面」这类标签页，封面区就是两个
   *     「选择封面」按钮（横封面 4:3 / 竖封面 3:4）。先去找标签页是白找。
   *  2. 真正的文件选择入口在**弹窗内部**——弹窗底部有个「+上传封面」按钮，
   *     不点它就不会弹系统文件选择器，input[type=file] 也不会被激活。
   * 上一版因为找不到标签页而直接跳过点「选择封面」，于是 filechooser 永远等不到，
   * 8 秒超时后走兜底也找不到 input，最后静默跳过——发布记录里连 cover-skipped
   * 都没留下（截图停在 step-cover 就再无下文），看起来像根本没试过。
   */
  coverOpen: [
    'text=选择封面',
    '[data-e2e="cover-upload"]',
    '[class*="cover"] [class*="select"]',
  ],
  /** 只在封面弹窗内匹配，避免误点页面别处的同名元素。 */
  coverUploadInDialog: [
    '.dy-creator-video-beautify-modal text=上传封面',
    '[class*="modal"] text=上传封面',
    '[class*="modal"] [class*="upload"]',
    'text=上传封面',
    '[data-e2e="cover-upload-input"]',
  ],
  /**
   * 自制声明（2026-10-11 实测截图校准）。抖音的字段标签是「自主声明」，
   * 占位符是「请选择自主声明」——上一版按「作品声明」匹配，一个都点不到，
   * 于是每次都落到「声明没选上」分支。
   */
  declaration: [
    'text=请选择自主声明',
    '[class*="declare"] [class*="select"]',
    '[class*="declaration"] [class*="select"]',
    '[class*="semis"] [class*="select"]',
    '[data-e2e="declare-select"]',
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

/**
 * 等视频真正上传完。
 *
 * 判据是右侧预览卡里的进度百分比（截图里是「59%」「50%」）和「上传中」字样
 * 都消失。抖音上传期间会反复重渲染整个表单，此时写进去的标题/正文会被冲掉，
 * 所以这里必须等到稳定再填。轮询而不是等固定秒数：大文件要传好几分钟，
 * 固定等待要么白等要么不等够。
 *
 * 认不出进度标记（页面改版）时返回 false 而不是无限等住——调用方会记一个
 * upload-pending 的阶段继续往下走，至少不把发布卡死。
 */
export async function waitForUploadComplete(page, { timeoutMs = 15 * 60_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stillUploading = await page.evaluate(() => {
      // 只看文件预览卡附近：页面上别处也有百分比（「检测中87%」之类），
      // 全文匹配会永远等下去。
      const cards = document.querySelectorAll('[class*="preview"], [class*="video-info"], [class*="upload"], [class*="player"]')
      for (const card of cards) {
        const text = card.innerText || ''
        if (/\b\d{1,3}\s*%/u.test(text) && /上传中|剩余/u.test(text)) return true
      }
      // 预览卡没渲染出来时退回全文，但必须同时出现「上传中」，
      // 否则「检测中 87%」这类文案会被误判成还在传视频。
      const all = document.body?.innerText || ''
      if (/上传中/u.test(all)) return true
      const fileRow = /[\w-]{6,}\.mp4/u.exec(all)
      if (fileRow && /\b\d{1,3}\s*%/u.test(all)) return true
      return false
    }).catch(() => false)
    if (!stillUploading) return true
    await page.waitForTimeout(intervalMs)
  }
  return false
}

/**
 * 在已展开的下拉/单选面板里按文本挑一项。
 *
 * 平台把选项渲染成一堆 div 而不是原生 option/label，所以逐个候选读 innerText 比
 * 等 role="option" 可靠。两遍扫描：先精确匹配再退包含匹配——面板里常有
 * 「内容由 AI 生成」之外的说明性文案，包含匹配容易点错行。
 */
async function pickOptionByText(page, wanted, { timeout = 6000 } = {}) {
  const wantedText = String(wanted || '').trim()
  if (!wantedText) return false
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const candidates = page.locator('[role="option"], [class*="option"], [class*="dropdown"] [class*="item"], [class*="popover"] [class*="item"], [class*="select"] [class*="option"], [class*="radio"], li')
    const total = Math.min(await candidates.count(), 150)
    for (const exact of [true, false]) {
      for (let i = 0; i < total; i += 1) {
        const text = (await candidates.nth(i).innerText().catch(() => '')).trim().replace(/\s+/gu, ' ')
        if (!text || text.length > 40) continue
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

function normalizeTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag).replace(/^#/u, '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

/**
 * 字数上限。**两个数字都来自 2026-10-11 的实机截图，不是猜的**：
 * 抖音创作者中心上传页的输入框右下角自带角标，标题是 `0/30`、作品描述是
 * `0/1000`，超限时角标变红并弹「标题内容仅支持30个字符」。
 *
 * 超限的表现不是被截断而是平台自己把输入框里的字砍到上限——所以必须自己
 * 先裁，而且要在发布记录里留下「裁了多少」，否则只剩一个没有线索的短标题。
 *
 * 上限可通过 content.titleLimit / content.descriptionLimit 覆盖：抖音会调整，
 * 而这里没有联网通道核实，硬编码只是当前的实测快照。
 */
const TITLE_LIMIT = 30
const DESCRIPTION_LIMIT = 1000

// 导出给测试锁住实测值：这两个数字一旦被「顺手改成 55」之类改回去，
// 回归测试会立刻失败，而不是等到下一次真机发布才发现标题又被砍短。
export const DOUYIN_TITLE_LIMIT = TITLE_LIMIT
export const DOUYIN_DESCRIPTION_LIMIT = DESCRIPTION_LIMIT

/**
 * 自制声明的默认值。
 *
 * 本包产出的每条成片都是脚本 + 合成配音 + AI 封面，不声明属于对平台做不实陈述，
 * 所以默认就是「内容由AI生成」。任务内容里显式给了 declaration 就用任务的值；
 * 显式给空字符串表示「这个字段别碰」（留给人手动选，或平台当前没有该控件）。
 */
export const DEFAULT_AI_DECLARATION = '内容由AI生成'

export function resolveDeclaration(content) {
  const raw = content?.declaration
  if (raw === null || raw === undefined) return DEFAULT_AI_DECLARATION
  return String(raw).trim()
}

/**
 * 按「平台计数方式」截断。
 *
 * 平台对中文按字符计、对英文按词计，纯 JS 的 .length 会把 emoji 和代理对算成
 * 2 个字符，可能裁得比平台更早；而 String.slice 截在代理对中间会留下半个字符，
 * 粘进编辑器就是乱码。所以用 [...text] 按码点切，再对行尾空白收口。
 */
export function truncateForDouyin(text, limit) {
  const value = String(text ?? '')
  const points = [...value]
  if (points.length <= limit) return { text: value, truncated: false }
  const cut = points.slice(0, limit).join('').replace(/\s+$/u, '')
  return { text: cut, truncated: true }
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
    const titleLimit = Number(content?.titleLimit) > 0 ? Number(content.titleLimit) : TITLE_LIMIT
    const descriptionLimit = Number(content?.descriptionLimit) > 0 ? Number(content.descriptionLimit) : DESCRIPTION_LIMIT

    const rawTitle = String(content?.title || '').trim()
    const rawDescription = String(content?.description || content?.copy || '').trim()
    const tags = normalizeTags(content?.tags)
    // 自制声明默认「内容由 AI 生成」：本包的成片全部是脚本+配音+AI 封面合成的，
    // 不声明属于内容与实际不符。真要发人工制作的内容时，用 content.declaration
    // 显式覆盖即可（传空字符串则完全不动这个字段）。
    const declaration = resolveDeclaration(content)

    const titleCut = truncateForDouyin(rawTitle, titleLimit)
    const descriptionCut = truncateForDouyin(rawDescription, descriptionLimit)
    const title = titleCut.text
    const description = descriptionCut.text

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

    // 2026-10-11 实测修正：这个门原本形同虚设。SELECTORS.uploadDone 匹配的
    // 「发布设置 / 作品描述 / 封面」这些字在上传**刚开始**（截图里只有 50%）就
    // 已经渲染在页面上了，所以两秒后代码就去写标题和正文，随后平台把整个表单
    // 重渲染一遍，刚写进去的内容被冲掉——表现是「标题莫名其妙只剩开头 30 字」。
    // 真正的完成信号是右侧预览卡里那个进度百分比（59% / 50% / …）消失，
    // 且「上传中」字样不再出现。
    await onStep('editor', '等待视频上传并进入编辑页')
    const editorReady = await firstMatch(page, SELECTORS.uploadDone, { timeout: 180_000 })
    if (!editorReady) {
      const error = new Error('视频上传后未能进入编辑页（可能仍在处理，或平台拒绝了该文件）。')
      error.code = 'PUBLISHER_UPLOAD_STALLED'
      throw error
    }
    const uploadFinished = await waitForUploadComplete(page)
    if (!uploadFinished) {
      await onStep('upload-pending', '视频仍在上传，先填写可编辑的字段（平台可能会在上传完成后重渲染表单）')
    } else {
      await onStep('upload-complete', '视频上传完成')
    }

    await onStep('metadata', '填写标题与正文')
    // 超限是被平台退回、不是被平台截断，所以在这里就把话说清楚，
    // 让发布记录里留下「裁了多少」，而不是只看到一个没有线索的失败。
    if (titleCut.truncated) {
      await onStep('title-truncated', `标题超出抖音上限 ${titleLimit} 字，已自动截到上限（原文 ${[...rawTitle].length} 字）`)
    }
    if (descriptionCut.truncated) {
      await onStep('description-truncated', `作品描述超出抖音上限 ${descriptionLimit} 字，已自动截到上限（原文 ${[...rawDescription].length} 字）`)
    }
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
    //
    // 两段式（2026-10-11 实测截图修正）：先点封面区「选择封面」打开弹窗，
    // 再在弹窗内点「上传封面」。必须先挂 filechooser 监听再点那个按钮，
    // 否则系统选择器一闪而过就再也接不到了——点击与监听之间只隔一次点击，
    // 顺序反了必然失败。接不到选择器才退回隐藏 input。
    const coverPath = coverPaths.portrait || coverPaths.landscape || null
    if (coverPath) {
      await onStep('cover', '打开封面设置')
      let covered = false
      try {
        const coverOpen = await firstMatch(page, SELECTORS.coverOpen)
        if (!coverOpen) {
          await onStep('cover-missing', '页面里没有「选择封面」入口（抖音页面结构可能已调整）')
        } else {
          await coverOpen.click().catch(() => {})
          // 弹窗要等渲染出来：里面的「上传封面」按钮此刻还不存在。
          await page.waitForTimeout(1500)
          await onStep('cover-dialog', '封面弹窗已打开')

          // 关键顺序：监听挂在点击之前。
          const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null)
          const uploadBtn = await firstMatch(page, SELECTORS.coverUploadInDialog)
          if (uploadBtn) {
            await uploadBtn.click().catch(() => {})
          }
          const chooser = await chooserPromise
          if (chooser) {
            await chooser.setFiles(coverPath)
            covered = true
          } else {
            const coverInput = await firstMatch(page, ['input[type="file"][accept*="image"]', 'input[type="file"]'], { timeout: 5000 })
            if (coverInput) {
              await coverInput.setInputFiles(coverPath)
              covered = true
            }
          }
        }
        if (covered) {
          await page.waitForTimeout(4000)
          // 弹窗底部是「完成 / 设置竖封面」这类按钮，常常是 div 假按钮，
          // button: 选择器永远数 0，所以用带引号的精确文本匹配。
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const confirm = await firstMatch(page, ['text="完成"', 'text="设置竖封面"', 'text="设置横封面"'])
            if (!confirm) break
            await confirm.click().catch(() => {})
            await page.waitForTimeout(2500)
          }
          await onStep('cover-applied', '封面已上传')
        } else {
          await page.keyboard.press('Escape').catch(() => {})
        }
      } catch { covered = false }
      if (!covered) {
        await onStep('cover-skipped', '封面未自动设置（弹窗内没有可用的上传入口），请在窗口中人工选择，或采用平台推荐封面')
      }
    }

    /**
     * 自制声明：抖音必填，不选会挡住提交。
     *
     * 与 B 站分区/创作声明同一策略——自动模式选不出来就报错，绝不静默发一个
     * 声明缺失的作品（那等于对平台做了不实陈述）。发布前确认模式只提示，
     * 让人在窗口里自己点。
     */
    await onStep('declaration', '选择自制声明（内容由AI生成）')
    let declarationSelected = true
    const declarationTrigger = await firstMatch(page, SELECTORS.declaration)
    if (declarationTrigger) {
      await declarationTrigger.click().catch(() => {})
      await page.waitForTimeout(1000)
      declarationSelected = await pickOptionByText(page, declaration)
    }
    if (!declarationSelected && submitMode === 'auto') {
      const error = new Error(`抖音「自制声明」未能自动选择「${declaration}」；该字段必填，请在任务内容里配置 declaration，或改用「发布前确认」模式人工选择。`)
      error.code = 'PUBLISHER_DECLARATION_REQUIRED'
      throw error
    }
    if (!declarationSelected) {
      await onStep('declaration-manual', `自制声明未自动选择，请在窗口中人工选择「${declaration}」`)
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
