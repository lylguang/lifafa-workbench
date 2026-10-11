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
   * 封面入口。抖音的封面区默认是「推荐封面」标签页，本地上传藏在
   * 「上传封面」/「自定义」这类子标签里，点开后才出现文件选择器——
   * 只点「选择封面」会停在推荐帧列表上，什么都不上传。
   */
  coverTab: [
    'text=上传封面',
    'text=自定义封面',
    '[data-e2e="cover-upload-tab"]',
    '[class*="cover"] [class*="upload"]',
  ],
  /**
   * 合成内容声明（自制声明）。抖音把它做成必填的下拉/单选，不选就发不出去。
   */
  declaration: [
    '[data-e2e="declare-select"]',
    '[class*="declare"] [class*="select"]',
    '[class*="declaration"] [class*="select"]',
    'text=请选择符合作品内容的声明',
    'text=作品声明',
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
 * 字数上限。
 *
 * 抖音对标题与作品描述都有硬上限，超限的表现不是截断而是**整个作品被退回**
 * （标题留空或描述装不下时提交按钮直接不可用），自动化在这里会撞上一句看不
 * 出所以然的「发布失败」。所以在进页面之前就自己裁到上限以内。
 *
 * 为什么不写死成某次实测的精确值：抖音会调整上限，而这里没有任何联网通道去
 * 核实当前值（WebSearch 在本机不可用），凭记忆写一个数字有相当概率是错的，
 * 那比不写更糟——错数字会静默裁掉本不该裁的内容。取略保守的值既能挡住绝大多数
 * 超限，又不至于误伤；上限可通过 content.titleLimit / content.descriptionLimit
 * 覆盖，等哪次实测出准确值再往上调即可。
 */
const TITLE_LIMIT = 55
const DESCRIPTION_LIMIT = 1000

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
    // 2026-10-11 修：原实现只找 input[type=file] 并在最外层 try 里静默兜底。
    // 抖音的封面上传是「点入口 → 系统文件选择器」，那个 input 常常在页面里根本
    // 不存在或不可见，于是每次都走 catch 分支静默跳过——发布记录里只留下一句
    // 「封面上传未完成」，而作品其实发出去了、只是封面是平台随手选的那帧。
    // 改成与 B 站同路径：点击前先挂 filechooser 监听，走真人点选同一条路；
    // 监听不到再退回隐藏 input。抖音封面默认停在「推荐封面」标签，
    // 必须先切到上传/自定义标签，否则点了也不会弹选择器。
    const coverPath = coverPaths.portrait || coverPaths.landscape || null
    if (coverPath) {
      await onStep('cover', '上传封面')
      let covered = false
      try {
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null)
        // 先切到「上传封面 / 自定义」标签页，否则停在推荐帧列表上等于没点。
        const coverTab = await firstMatch(page, SELECTORS.coverTab)
        if (coverTab) {
          await coverTab.click().catch(() => {})
          await page.waitForTimeout(1200)
        }
        const coverEntry = await firstMatch(page, ['text=选择封面', 'text=上传封面', '[data-e2e="cover-upload"]'])
        if (coverEntry) {
          await coverEntry.click().catch(() => {})
          await page.waitForTimeout(1200)
        }
        const chooser = await chooserPromise
        if (chooser) {
          await chooser.setFiles(coverPath)
          covered = true
        } else {
          // 没有弹系统选择器时，页面上多半有个隐藏的 input 可以直接塞。
          const coverInput = await firstMatch(page, ['input[type="file"][accept*="image"]', 'input[type="file"]'], { timeout: 6000 })
          if (coverInput) {
            await coverInput.setInputFiles(coverPath)
            covered = true
          }
        }
        if (covered) {
          await page.waitForTimeout(4000)
          // 弹窗的「完成」常常是 div 假按钮，button: 选择器永远数 0，
          // 所以用带引号的精确文本匹配，并以按钮消失为准最多补点几次。
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const confirm = await firstMatch(page, ['text="完成"', 'text="确定"', 'text="确认"', 'text="保存"'])
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
        await onStep('cover-skipped', '封面未自动设置（平台未弹出文件选择器），请在窗口中人工选择，或采用平台推荐封面')
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
