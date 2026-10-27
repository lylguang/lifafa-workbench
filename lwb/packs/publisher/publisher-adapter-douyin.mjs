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
   * 封面。
   *
   * 三版实测才定位准，这里记下每一版的错在哪，避免再退回老写法：
   *  1. 第一版：页面根本没有「上传封面」标签页，找不到就整体跳过 —— 静默失败。
   *  2. 第二版：点开弹窗后用 `text=上传封面` 找上传按钮，但那一刻页面上匹配到
   *     的是别的东西，点空 → 退到隐藏 input 兜底 → 文件确实进去了，但绑定的是
   *     「截屏封面」通道，平台判为「请勿使用截屏当封面」直接拒收，而代码还报
   *     了 cover-applied。**误报比不报更坏。**
   *  3. 第三版（当前）：先用**精确文本 + 尺寸**确认封面方块、点开弹窗、等弹窗
   *     真的出现（弹窗标题「设置横封面/设置竖封面」出现才算开），再用实测到的
   *     class 前缀 `upload-tips-` 找那个黑色上传按钮。
   *
   * 抖音的 class 带构建哈希（upload-tips-KomyJM），会随版本变，所以只取稳定
   * 前缀，并始终保留文本兜底。
   */
  /** 封面区那两个灰色方块（横 4:3 / 竖 3:4），文本都是「选择封面」。 */
  coverBox: [
    'div[class^="cover-"]',
    'div[class*="filter-"]',
  ],
  /** 弹窗是否真的开出来了——用它替代盲等。 */
  coverDialogTitle: [
    'text=设置横封面',
    'text=设置竖封面',
  ],
  /** 弹窗顶部的横/竖封面切换标签。 */
  coverOrientationTab: [
    'text=设置横封面',
    'text=设置竖封面',
  ],
  /**
   * 自制声明。2026-10-11 真机探针校准：抖音把它做成**模态弹窗**
   * 「对作品内容添加声明」，不是页面内的内联下拉。
   *
   * 真机截图确认过选项的确切文案是「内容由AI生成」（选项依次为：内容由AI生成 /
   * 内容为个人观点或见解 / 内容为转载信息 / 内容含营销推广信息 / 虚构演绎，仅供娱乐 /
   * 无需添加自主声明）——注意平台用的是「自主声明」这个词，不是「作品声明」。
   */
  declaration: [
    'text=请选择自主声明',
    'text=对作品内容添加声明',
    '[class*="declare"] [class*="select"]',
    '[class*="declaration"] [class*="select"]',
    '[data-e2e="declare-select"]',
  ],
  /** 弹窗底部的「确定」：选完选项必须点它，否则模态不关，发布会一直卡在遮罩上。 */
  declarationConfirm: [
    '.dy-creator-semis-modal button:has-text("确定")',
    '[class*="semis"] button:has-text("确定")',
    '[class*="modal"] button:has-text("确定")',
    'text="确定"',
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
    // 2026-10-25 实测：抖音描述框硬上限就是 5 个话题，超出的会被平台弹
    // 「最多可添加5个话题」并拒收。旧上限 10 是凭空写的，实际做不到，
    // 多出来的那几个只会在正文里留下半截乱码。
    .slice(0, 5)
}

/**
 * 把话题标签真正写进抖音的描述框。
 *
 * 2026-10-25 用户实测反馈：描述里显示的还是占位符「#添加话题」，标签完全没生效。
 * 旧实现是 `insertText('\n#a #b …')` ——抖音把 `#` 当话题触发符，需要从建议
 * 列表里选中才会生成话题；一次性粘一串只会落在正文里，平台不认。
 *
 * 第一版改法（先打 ' #' 再点建议项）实测更糟：点不中就留下一堆空井号
 * `# #### ##`，把描述弄脏了。教训是**绝不能在没选中的情况下留下裸井号**。
 *
 * 现在逐个标签做「输入 # + 关键词 → 等建议列表 → 用键盘选中」：
 *   · 打出 `#标签` 让平台自己过滤出候选；
 *   · 等建议列表真的出现（有「#xxx 数字」形态的行）；
 *   · 出现就 ArrowDown + Enter 选中，变成话题 chip；
 *   · 没出现就把刚打的 `#标签` 用退格删掉，正文回到干净状态。
 * 每步都以「正文长度变化」校验，任何异常立即停止，绝不把正文写坏。
 *
 * 返回真正写进去的标签，调用方把「写了几个」记进发布记录。
 */
async function fillTopicTags(page, tags) {
  const applied = []
  const textLen = () => page.evaluate(() => {
    const el = document.activeElement
    return el && 'value' in el ? el.value.length : (el?.innerText || '').length
  }).catch(() => 0)

  // 抖音会在输入 `#` 后弹出建议浮层；浮层里按 Escape 关掉，避免它截获后续按键。
  const closeSuggest = async () => {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(250)
  }

  for (const tag of tags) {
    await page.keyboard.insertText(' ')
    const before = await textLen()
    // 只打 `#` 一个字符就等浮层：先确认「这个平台此刻会不会给建议」，
    // 会才继续打关键词。这样不会出现「打了半截关键词、浮层没来、又删不干净」
    // 的状态（2026-10-25 实测就是这么把 `#回本测算` 写成 `#回#本#副...` 的）。
    await page.keyboard.insertText('#')
    await page.waitForTimeout(800)
    const hasList = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div,li,span'))
        .filter((el) => el.offsetParent)
        .map((el) => (el.innerText || '').trim())
        .filter((t) => t.startsWith('#') && t.length > 2 && t.length < 40)
      return rows.length > 0
    }).catch(() => false)
    if (!hasList) {
      // 没有建议浮层：删掉这个 `#`，一个字符，绝不留下残留。
      await page.keyboard.press('Backspace').catch(() => {})
      await page.waitForTimeout(200)
      const after = await textLen()
      if (after > before) break
      continue
    }
    // 有建议：补全关键词让平台过滤出目标话题，再键盘选中。
    await page.keyboard.insertText(tag)
    await page.waitForTimeout(900)
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(250)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    const after = await textLen()
    // 选中成功后正文长度会明显变化（chip 替换了输入的文本）。
    if (after > before) applied.push(tag)
    else break
    await closeSuggest()
  }
  return applied
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

/**
 * 找出封面区那两个「选择封面」方块（横 4:3 在左、竖 3:4 在右）。
 *
 * 2026-10-11 真机定位到的整场 bug：竖槽里装的是横图。
 *
 * 原因有二，都在这里修掉：
 *  1. 之前用 `.first()` 打开弹窗，于是**两轮都进了同一个横封面弹窗**。弹窗内
 *     并没有「设置竖封面」标签（那一版只有「设置横封面」），于是竖封面那轮把横版图
 *     又传了一遍，竖槽里装的其实是横图。
 *  2. 后来按几何找方块，只找到 1 个：过滤写的是 `width > 100`，而实测两个方块
 *     尺寸差别很大——横封面 160×120，**竖封面只有 90 宽**（90×147）。竖封面那个
 *     直接被筛掉了，于是横封面正常、竖封面永远打不开。
 *
 * 现在按实测公共 class 找（`coverControl-` 前缀，两个方块各一个），再按 x 排序：
 * 左边是横封面，右边是竖封面。文字兜底保留，但去重要更严——父子元素常常共享
 * 同一个 textContent，只留最贴合尺寸的那个。
 */
/**
 * 从一组方块几何里挑出横竖两个入口，返回各自的槽位坐标。
 *
 * 抽成纯函数是为了能被直接测——上一版的整场 bug 就是「按几何找方块时只找到
 * 1 个」，而那种事只有真机能复现。这里把「两个方块尺寸差很多」这个实测事实固
 * 成断言：横封面 160×120、竖封面只有 90×147。任何把宽度下限抬到 100 以上的
 * 改动都会立刻在这里失败。
 */
export function pickCoverSlots(boxes) {
  const usable = (boxes || []).filter((b) => b && Number.isFinite(b.x) && Number.isFinite(b.y))
    .filter((b) => b.w >= 50 && b.w <= 400 && b.h >= 50 && b.h <= 260)
  // 父子元素会共享 textContent 而命中同一位置，按坐标去重。
  const unique = []
  for (const b of usable) {
    if (!unique.some((q) => Math.abs(q.x - b.x) < 2 && Math.abs(q.y - b.y) < 2)) unique.push(b)
  }
  unique.sort((a, b) => a.x - b.x)
  return { landscape: unique[0] || null, portrait: unique[1] || null, all: unique }
}

async function locateCoverBoxes(page) {
  const boxes = await page.evaluate(() => {
    const out = []
    // 主路径：实测 class 前缀（带构建哈希，所以只取前缀）——横竖两个方块各一个。
    const nodes = Array.from(document.querySelectorAll('div[class^="coverControl-"], div[class*="coverControl-"]'))
    // 兜底：文本精确等于「选择封面」。宽度下限放到 50，否则 90 宽的竖封面会被
    // 筛掉——这正是上一版只找到一个入口的原因。
    const byText = Array.from(document.querySelectorAll('div,span,button')).filter((el) => (el.textContent || '').trim() === '选择封面')
    for (const el of [...nodes, ...byText]) {
      if (!el || !el.offsetParent) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) })
    }
    return out
  }).catch(() => [])
  return pickCoverSlots(boxes)
}

/**
 * 打开封面弹窗并返回是否成功。
 *
 * 必须确认弹窗真的开出来了才能继续：第二版的整场失败就是「以为弹窗开了其实
 * 没开」，于是在主页面里找上传按钮，点空后退到隐藏 input 兜底，文件进了
 * 「截屏封面」通道被平台拒收，而代码还报成功。等待要有真实判据，不靠盲等。
 *
 * `point` 是事先量好的方块坐标（见 locateCoverBoxes）——不能在这里现找，因为
 * 传完第一个封面后第二个也可能已经不是占位方块了。
 */
async function openCoverDialog(page, point, { timeout = 12_000, expectTitle = null } = {}) {
  const deadline = Date.now() + timeout
  const titles = expectTitle
    ? [expectTitle]
    : ['text=设置横封面', 'text=设置竖封面']
  while (Date.now() < deadline) {
    if (point) {
      await page.mouse.click(point.x, point.y).catch(() => {})
    } else {
      const box = page.locator(SELECTORS.coverBox).first()
      if (await box.count().catch(() => 0)) await box.click().catch(() => {})
    }
    // 弹窗标题出现 = 真的开了。
    const title = await firstMatch(page, titles, { timeout: 4000 })
    if (title) return true
    await page.waitForTimeout(1200)
  }
  return false
}

/**
 * 在已打开的封面弹窗里上传一张图。
 *
 * 判据只有一个：filechooser 真的弹出来了。没弹出来就明确返回 false——
 * 绝不再退回隐藏 input 兜底，因为那条路会被平台判成「截屏封面」而拒收，
 * 却让调用方以为成功。第二版的误报就是这么来的。
 */

/**
 * 竖封面上传前，若弹窗确实是「双标签」形态且停在横封面，就切到竖封面。
 *
 * 2026-10-25 真机复现：带两个标签的弹窗默认停在「设置横封面」，竖图被塞进
 * 4:3 画布，最终竖槽里显示的是被裁切的横图（「3:4 不匹配、字被切掉」）。
 *
 * 设计原则是**绝不阻断上传**：找不到标签、认不出激活态、点击没生效——一律
 * 直接往下走，交给原逻辑上传。宁可回到「可能被裁」的旧行为，也不能像第一版
 * 那样因为切不到标签就放弃上传，把两封面都弄丢。
 */
async function ensurePortraitTabIfSwitcherPresent(page) {
  try {
    const state = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('div,span,button')) {
        if (!el.offsetParent) continue
        const label = (el.innerText || el.textContent || '').trim().replace(/\s+/g, '')
        if (label !== '设置横封面' && label !== '设置竖封面') continue
        const r = el.getBoundingClientRect()
        if (r.width < 20 || r.height < 10) continue
        const bg = getComputedStyle(el).backgroundColor || ''
        const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)'
        out.push({ label, x: r.x + r.width / 2, y: r.y + r.height / 2, hasBg })
      }
      return out
    })
    // 必须**两种标签都在**才算双标签形态；只有一个说明是单标签弹窗，不用切。
    const hasBoth = state.some((t) => t.label === '设置横封面') && state.some((t) => t.label === '设置竖封面')
    if (!hasBoth) return false
    const active = state.find((t) => t.hasBg)
    // 已经停在竖封面，或者认不出激活态，就不动。
    if (!active || active.label === '设置竖封面') return false
    const target = state.find((t) => t.label === '设置竖封面' && !t.hasBg)
    if (!target) return false
    await page.mouse.click(target.x, target.y).catch(() => {})
    await page.waitForTimeout(1200)
    return true
  } catch {
    // 任何异常都当作「不需要切」，继续原流程。
    return false
  }
}

/**
 * 封面上传顺序（**竖先横后**）。
 *
 * 2026-10-11 用户实测发现：先传横封面再传竖封面时，横封面会跟着竖封面变换，
 * 结果横槽里装的不是我们传的那张图。所以顺序本身就是修复的一部分，必须是
 * 有序列表，不能退化成对象或集合。抽成导出函数是为了让测试能直接锁住这个
 * 顺序——之前「竖槽里装的是横图」就是靠测试才发现的。
 */
export function coverUploadPlan(coverBoxes) {
  return [
    ['portrait', '竖封面 3:4', coverBoxes.portrait],
    ['landscape', '横封面 4:3', coverBoxes.landscape],
  ]
}

/**
 * 在已打开的封面弹窗里上传一张图。
 *
 * 判据只有一个：filechooser 真的弹出来了。没弹出来就明确返回 false——
 * 绝不再退回隐藏 input 兜底，因为那条路会被平台判成「截屏封面」而拒收，
 * 却让调用方以为成功。第二版的误报就是这么来的。
 *
 * `kind` 决定上传前要停在哪个标签页。2026-10-25 之前这里刻意不切标签
 * （当时的弹窗只有一个标签，切了也没用），但现在弹窗是横/竖两个标签并存、
 * 且默认停在横封面——不切就会把竖图塞进横画布，这正是「3:4 不匹配、字被裁」
 * 的成因。
 */
async function uploadCoverInDialog(page, coverPath, kind = null) {
  if (kind === 'portrait') {
    // 只对**竖封面**做一次「尽力而为」的标签切换。
    //
    // 2026-10-25 两轮真机实测：抖音弹窗有两种形态且不固定——
    //   A. 顶部有「设置横封面 / 设置竖封面」两个标签，默认停在横封面。
    //      此时竖图会被塞进 4:3 画布，最终竖槽里是裁坏的横图（用户看到的
    //      「3:4 不匹配、字被切」就是这个）。
    //   B. 只有一个「设置横封面」标题，但弹窗内容其实是竖通道。
    // 所以这里**只在明确看到两个标签、且激活的是横封面时**才切换到竖，
    // 其余情况一律按原逻辑直接上传——绝不因为切换失败就放弃上传，
    // 那会把一个本来能用的封面弄丢（第一版就是这么丢的）。
    await ensurePortraitTabIfSwitcherPresent(page)
  }
  // 监听必须在点击之前：系统选择器一闪而过，顺序反了必然接不到。
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null)
  const point = await clickCoverUploadButton(page)
  if (!point) return false
  const chooser = await chooserPromise
  if (!chooser) return false
  await chooser.setFiles(coverPath)
  // 实测：塞入后顶部会弹「上传成功」，画面中央换成新封面。等它落定。
  await page.waitForTimeout(4000)
  return true
}

/**
 * 点弹窗里那个黑色「上传封面」按钮。
 *
 * 不能用选择器 + .first()：实测页面上 `[class*="upload-tips-"]` 与
 * 「上传封面」这两个条件在弹窗外也有命中（「AI生成封面」那块），
 * .first() 取到的不是弹窗里那个真正的按钮，于是点了空气、filechooser
 * 等不到 8 秒，最后报 cover-skipped。
 *
 * 独立探针里用「文本精确匹配 + 坐标点击」是能命中的（实测 class
 * upload-tips-KomyJM，坐标 833,602，filechooser 触发成功），所以这里沿用同一手法：
 * 逐个找出文本正好是「上传封面」且可见的元素，从后往前点——弹窗是后渲染的，
 * 排在后面的才是弹窗里的那个。
 */
async function clickCoverUploadButton(page) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
const points = await page.evaluate(() => {
  const hits = Array.from(document.querySelectorAll('div,span,button,label'))
    .filter((el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, '') === '上传封面')
    .filter((el) => el.offsetParent)
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
    })
    // 只要看起来像个按钮的（不是一整行文字），且在视口内。
    .filter((p) => p.w > 20 && p.w < 200 && p.h > 20 && p.h < 120 && p.y > 0 && p.y < 2000)
  return hits
}).catch(() => [])
// 弹窗后渲染，DOM 里排在后面。
for (const point of [...points].reverse()) {
  await page.mouse.click(point.x, point.y).catch(() => {})
  await page.waitForTimeout(900)
  return point
}
await page.waitForTimeout(800)
  }
  return null
}

/**
 * 从页面文本里判断平台对封面下了什么结论。抽成纯函数是为了能直接测——
 * 它必须在浏览器上下文里跑，塞进 evaluate 就没法在不启动 Chrome 的情况下验。
 *
 * 两类来源都要读：
 *  · 「设置封面」区的橙色横幅（实测文案：「封面不任」「封面存在1个问题，会导致
 *    作品流量减少」「截屏封面」「请勿使用截屏当封面」）；
 *  · 右侧「封面优化建议」列表（横/竖封面各自的问题，如「文字显示不全」）。
 *
 * 第二类不能漏：第一轮真机跑出来只有这一条提示，文件传进去了、平台也不再否决，
 * 但素材上的大字标题被裁切，发布出去会掉流量。只认否决类提示就会静默通过。
 */
export function readCoverVerdict(pageText) {
  const t = String(pageText || '')
  const fatal = /封面不任|截屏封面|请勿使用截屏当封面|封面存在\s*\d+\s*个问题/u.exec(t)
  if (fatal) return fatal[0]
  const problem = /文字显示不全|主体不完整|文字被裁|画面模糊|分辨率过低/u.exec(t)
  // 这些词只出现在封面建议里，不会误伤别的提示。
  return problem ? `封面优化建议：${problem[0]}` : null
}

/**
 * 校验封面素材的比例是否符合抖音要求。
 *
 * 2026-10-11 实测得到的一个硬约束：**「文字显示不全」这类提示读不到**——
 * 抖音把它直接画在封面缩略图上（canvas / 图片），不在 DOM 里。探针实测：
 * body.innerHTML 有 180 万字符、body.innerText 只有 991 字符，
 * 用 `*` 遍历所有元素查 `文字显示不全` 得到 nodeCount = 0。
 * 所以任何基于页面文本的判据都抓不到它，只能靠人看截图。
 *
 * 而这一条提示的成因是素材本身：封面上的大字标题顶到边缘、超出安全区，
 * 抖音识别后裁切显示。自动化能替它做的最有用的事，是在上传前就检查比例是否
 * 对得上槽位——比例错了平台会直接判「封面不任」，而比例对了仍可能被裁，
 * 这部分交给封面生图那一层去修（缩小标题字号 / 留出安全边距）。
 */
export function coverRatioWarning(width, height, kind) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const ratio = width / height
  const want = kind === 'portrait' ? 3 / 4 : 4 / 3
  // 容差按**相对偏差**算，不按绝对差值。
  //
  // 2026-10-25 改了这里的判据：原来是绝对差值 ±0.45，结果 1000x1000（1.00）
  // 对横版 4:3（1.33）只差 0.33，落在容差内，等于这条检查完全失效——正方形
  // 素材也会被放行。改成相对偏差 8%：
  //   · 4:3 目标 1.3333，容许 1.227–1.440（1440x1080 = 1.3333 ✅）
  //   · 3:4 目标 0.7500，容许 0.690–0.810（1080x1440 = 0.7500 ✅）
  //   · 16:9 的 1.7778 会对横版报警（超出 33%）——这正是要拦的那类
  //   · 正方形 1.0 会对横版报警（低 25%）
  //
  // 为什么可以收紧了：封面生图那一层现在严格按 4:3 / 3:4 出图，并在服务端做
  // 过比例兜底裁切（#fitCoverAspect），正常产物必然落在容差内。以前那 0.45
  // 是为了容忍「平台照收 16:9」的历史素材，现在素材已经统一，宽容差只剩副作用。
  const tolerance = 0.08
  if (Math.abs(ratio - want) / want <= tolerance) return null
  const dir = ratio > want ? '过宽' : '过高'
  return `${kind === 'portrait' ? '竖封面 3:4' : '横封面 4:3'}素材比例偏离：${width}×${height}（${ratio.toFixed(2)}，目标 ${want.toFixed(2)}）${dir}，抖音可能判「封面不任」`
}

/**
 * 量一张图片的像素尺寸。
 *
 * 走浏览器的 Image 解码器（而不是自己解析 PNG/JPEG 头），省掉一套格式解析，
 * 也顺带覆盖 WebP 等格式。失败就抛，由调用方决定要不要当问题处理。
 */
async function probeImageSize(page, imagePath) {
  const dataUrl = await toDataUrl(imagePath)
  return page.evaluate((url) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('图片无法解码'))
    img.src = url
  }), dataUrl)
}

async function toDataUrl(filePath) {
  const { readFile } = await import('node:fs/promises')
  const { extname } = await import('node:path')
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extname(filePath).toLowerCase()]
  if (!mime) throw new Error(`不支持的封面格式：${extname(filePath)}`)
  const bytes = await readFile(filePath)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function readCoverRejection(page) {
  // 必须读 innerHTML 而不是 innerText：抖音把「封面优化建议」渲染成一个弹窗，
  // 那段文案不在 body.innerText 里（实测用 innerText 读不到，代码照样报了
  // cover-applied，而页面明明挂着两条「文字显示不全」）。innerHTML 能覆盖到
  // DOM 里已挂载的全部文案，代价是体积大——但只在传完封面后调一次，可以接受。
  const html = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '')
  return readCoverVerdict(html.replace(/<[^>]*>/gu, ' '))
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
        // 话题必须走「输入 # → 选中建议」的交互才会变成平台话题；
        // 直接粘贴一串 `#xx` 只会是普通文本，发布后一个话题都不生效。
        const appliedTags = await fillTopicTags(page, tags)
        if (appliedTags.length < tags.length) {
          await onStep('tags-partial', `话题只写入了 ${appliedTags.length}/${tags.length} 个（其余没等到平台建议列表），描述正文未受影响`)
        }
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
    // 2026-10-11 三轮真机探针后的最终形态。要点：
    //  · 弹窗默认进「设置横封面」，竖封面靠弹窗内标签切，不是靠第二个方块
    //    （上一版循环点同一个 first() 方块，第二轮必然落空）。
    //  · 横槽用 landscape、竖槽用 portrait，不能混用——比例不符平台会判
    //    「封面不任：封面存在1个问题，会导致作品流量减少」。
    //  · 只认 filechooser，拒绝隐藏 input 兜底（那条路会被判成截屏封面）。
    //  · 上传后回读平台的拒绝横幅，拒了就说拒了，不报成功。
    const coverApplied = []
    const coverRejected = []
    // 2026-10-11 真机定位的最后一个 bug：竖槽里装的是横图。
    //
    // 原因：之前两轮都调 openCoverDialog(page)，而它内部用 .first() 打开弹窗，
    // 于是**两轮进的都是同一个横封面弹窗**。竖封面那轮试图在弹窗内切
    // 「设置竖封面」标签，可实测那一版弹窗只有「设置横封面」一个标签，找不到，
    // 于是照常上传——把**横版图又传了一遍**，竖槽里装的就是横图。
    //
    // 正确做法：横竖封面是主页面上**两个独立的方块**（左横右竖），各自点开后
    // 弹窗直接就是对应通道，无需切标签。而传完第一个之后该方块会变成缩略图、
    // 「选择封面」文字消失，所以两个坐标必须在动手之前一次性量好。
    const coverBoxes = await locateCoverBoxes(page)
    if (!coverBoxes.landscape || !coverBoxes.portrait) {
      await onStep('cover-boxes', `封面区只找到 ${coverBoxes.all.length} 个入口（预期 2 个：横 4:3 / 竖 3:4）`)
    }
    // **顺序有语义：必须先竖后横**（2026-10-11 用户实测发现）。
    // 先横后竖时，竖封面一传上去，横封面会被它带偏/重算，结果横槽里装的
    // 不是我们传的那张图。用户原话：「如果先上传横封面，再上传竖封面，
    // 横封面会根据竖封面来变换」。所以这里是有序数组，不能用对象或集合——
    // 顺序就是修复的一部分。
    //
    // 注意这跟下面按 x 排序取坐标是两件事：locateCoverBoxes 用 x 排序是为了
    // 分辨哪个方块是横、哪个是竖（左边横右边竖，实测横 160×120、竖 90×147）；
    // 而这里的 plan 顺序只管上传先后。刻意不按弹窗标题区分横竖：实测点开
    // **竖**封面那个方块，弹窗标题仍然是「设置横封面」——抖音不区分，点哪个
    // 方块决定的是它自己的通道。用标题去要求「设置竖封面」会把竖封面那轮
    // 直接判失败（这个错我犯过一次）。
    // **顺序有语义：必须先竖后横**，理由与锚定方式见 coverUploadPlan()。
    //
    // 别和下面按 x 排序取坐标混淆：locateCoverBoxes 用 x 排序是为了分辨哪个
    // 方块是横、哪个是竖（左边横右边竖，实测横 160×120、竖 90×147）；这里
    // 的 plan 顺序只管上传先后。
    const plan = coverUploadPlan(coverBoxes)
    for (const [kind, ratioLabel, boxPoint] of plan) {
      const coverPath = coverPaths[kind]
      if (!coverPath) continue
      // 上传前先查比例。比例错了平台会直接判「封面不任」，而那种情况在
      // 发布记录里看不出是素材问题——所以在这里就把话说清楚。
      try {
        const size = await probeImageSize(page, coverPath)
        const warning = coverRatioWarning(size.width, size.height, kind)
        if (warning) await onStep('cover-ratio-warning', warning)
      } catch { /* 量不到尺寸不算失败，平台自己会判 */ }
      await onStep('cover', `打开封面设置（${ratioLabel}）`)
      let covered = false
      try {
        const opened = await openCoverDialog(page, boxPoint)
        if (!opened) {
          await onStep('cover-missing', `${ratioLabel}弹窗未能打开（抖音页面结构可能已调整）`)
        } else {
          await onStep('cover-dialog', `${ratioLabel}弹窗已打开`)
          covered = await uploadCoverInDialog(page, coverPath, kind)
          if (!covered) await onStep('cover-tab', `${ratioLabel}无法切到目标标签页，已放弃本次上传以免写进错误槽位`)
        }
        if (covered) {
          // 弹窗底部「完成」常是 div 假按钮，用精确文本匹配。
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const confirm = await firstMatch(page, ['text="完成"'])
            if (!confirm) break
            await confirm.click().catch(() => {})
            await page.waitForTimeout(2500)
          }
          const rejection = await readCoverRejection(page)
          if (rejection) {
            coverRejected.push(`${ratioLabel}：${rejection}`)
            await onStep('cover-rejected', `${ratioLabel}被平台拒绝（${rejection}）——文件传进去了但不合格`)
          } else {
            coverApplied.push(ratioLabel)
            await onStep('cover-applied', `${ratioLabel}已上传`)
          }
        } else {
          await page.keyboard.press('Escape').catch(() => {})
        }
      } catch (error) {
        covered = false
        await onStep('cover-error', `${ratioLabel}上传异常：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!covered) {
        await onStep('cover-skipped', `${ratioLabel}未自动设置（未捕获到文件选择器），请在窗口中人工选择，或采用平台推荐封面`)
      }
    }
    // 横封面上传完成后，抖音会自动「基于横封面生成竖封面」，把我们刚传的竖封面
    // 覆盖掉——2026-10-25 实测，封面区就挂着「已基于横封面为你生成竖封面」气泡，
    // 竖槽里于是变成被竖槽比例裁切的横图（用户看到的「3:4 不匹配、字被切掉」）。
    //
    // 修法：所有封面传完之后，如果竖封面是成功过的，**再补传一次竖封面**，让它
    // 成为最后一次写入。补传失败不影响主流程（横封面和已上传的竖封面仍在）。
    if (coverPaths.portrait && coverApplied.some((label) => label.includes('竖封面'))) {
      try {
        await onStep('cover-reassert', '重新覆盖竖封面，避免被平台按横封面自动重算')
        const again = await locateCoverBoxes(page)
        const point = again.portrait || coverBoxes.portrait
        if (point) {
          const opened = await openCoverDialog(page, point)
          if (opened) {
            const ok = await uploadCoverInDialog(page, coverPaths.portrait, 'portrait')
            if (ok) {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                const confirm = await firstMatch(page, ['text="完成"'])
                if (!confirm) break
                await confirm.click().catch(() => {})
                await page.waitForTimeout(2500)
              }
              await onStep('cover-reasserted', '竖封面已重新覆盖')
            }
          }
        }
      } catch {
        // 补传是增强，失败不回滚前面已成功的封面。
        await onStep('cover-reassert-skipped', '竖封面补传未成功，保留平台当前结果')
      }
    }
    if (coverApplied.length) {
      await onStep('cover-summary', `封面已设置：${coverApplied.join('、')}`)
    }
    if (coverRejected.length) {
      await onStep('cover-reject-summary', `平台拒绝了以下封面：${coverRejected.join('；')}。建议重新生成封面，或在窗口中人工调整。`)
    }

    /**
     * 自制声明：抖音必填，不选会挡住提交。
     *
     * 与 B 站分区/创作声明同一策略——自动模式选不出来就报错，绝不静默发一个
     * 声明缺失的作品（那等于对平台做了不实陈述）。发布前确认模式只提示，
     * 让人在窗口里自己点。
     */
    await onStep('declaration', '选择自制声明（内容由AI生成）')
    /**
     * 回读声明是否真的设置成功。判据：页面出现「作者声明：内容由AI生成」——
     * 2026-10-24 真机验证：选完并确认后，声明控件区域会显示这行字。
     * 之前的代码只信 pickOptionByText 的返回值，而它可能点错行或点空；
     * trigger 找不到时还直接把 declarationSelected 初始化成 true，造成
     * 「没选也报已选」，用户在窗口里看到声明空着，发布出去对平台做了不实陈述。
     */
    const declarationApplied = async () => page.evaluate((wanted) => {
      const text = document.body?.innerText || ''
      return text.includes(`作者声明：${wanted}`) || text.includes(`作者声明:${wanted}`)
    }, declaration).catch(() => false)
    let declarationSelected = false
    for (let attempt = 0; attempt < 3 && !declarationSelected; attempt += 1) {
      if (await declarationApplied()) { declarationSelected = true; break }
      const declarationTrigger = await firstMatch(page, SELECTORS.declaration)
      if (!declarationTrigger) break
      await declarationTrigger.click().catch(() => {})
      await page.waitForTimeout(1000)
      if (await pickOptionByText(page, declaration)) {
        // 选完必须关掉模态：真机截图里选项已经填上了（预览区显示
        // 「作者声明：内容由AI生成」），但弹窗仍盖在页面上——不点确定，
        // 后面的封面与提交都会被这层遮罩挡住。
        const confirm = await firstMatch(page, SELECTORS.declarationConfirm)
        if (confirm) {
          await confirm.click().catch(() => {})
          await page.waitForTimeout(1500)
        }
        declarationSelected = await declarationApplied()
      }
    }
    if (declarationSelected) {
      await onStep('declaration-confirmed', '自制声明已保存（页面已显示作者声明）')
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
