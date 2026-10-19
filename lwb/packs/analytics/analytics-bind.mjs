/**
 * 内容 ↔ 平台作品绑定（P2）。
 *
 * 现状缺口：发布 adapter 提交成功返回的 remoteUrl 通常是**创作者管理页**
 * （`MANAGE_URL`），不是作品详情页，拿不到作品 id。于是「本地内容」和「平台作品」
 * 之间的对应关系没有依据，采集器也就无从下手。
 *
 * P2 的主路径是**按账号 + 标题反查**，但这条路径有个致命风险：标题会重复、
 * 也会被作者事后改。所以这里的唯一原则是：
 *
 *   **宁可进待绑定，也不能静默绑错。**
 *
 * 一次绑错比一次不绑的代价高一个量级——绑错会让采集器此后每天把 A 作品的数据
 * 记到 B 作品头上，而用户完全看不出来。定稿 §2.1 与 §4.3-6 都点了这一条。
 */

/** 标题归一：全角转半角、去话题标签、去装饰符号、压空白、小写。 */
export function normalizeTitle(value) {
  return String(value ?? '')
    // 全角标点与字母数字 → 半角，让「ＡＢ」与「AB」等价。
    .replace(/[！-～]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/gu, '')
    .replace(/#[^#\s]{0,30}/gu, '')
    // 装饰符逐个列出——写成 `~～` 会被当成字符区间，范围顺序错了直接语法报错。
    .replace(/[【】[\]（）()《》「」『』|｜·・~"'`,.。.!！?？:：;；—\-_]/gu, '')
    .toLowerCase()
    .slice(0, 120)
}

/**
 * 在候选作品里找与目标标题匹配的那一个。
 *
 * @returns {{status:'matched', remoteId, remoteUrl}
 *          |{status:'ambiguous', candidates}
 *          |{status:'unmatched'}}
 *   ambiguous = 同一标题命中多条。**这是最容易绑错的场景**，绝不自动选一条。
 */
export function matchTitle(targetTitle, candidates) {
  const wanted = normalizeTitle(targetTitle)
  if (!wanted) return { status: 'unmatched', candidates: [] }
  const hits = (candidates || []).filter((candidate) => normalizeTitle(candidate?.title) === wanted)
  if (!hits.length) return { status: 'unmatched', candidates: [] }
  if (hits.length > 1) {
    // 标题重复：把候选交回人工，绝不「挑一个看起来最像的」。
    return { status: 'ambiguous', candidates: hits.map((hit) => ({ remoteId: hit.remoteId, remoteUrl: hit.remoteUrl, title: hit.title })) }
  }
  const only = hits[0]
  if (!only?.remoteId && !only?.remoteUrl) return { status: 'unmatched', candidates: [] }
  return { status: 'matched', remoteId: only.remoteId ?? null, remoteUrl: only.remoteUrl ?? null }
}

/**
 * 批量绑定（RPC 11）。
 *
 * @param contents 本地已发布作品（含 contentId/title/accountId/platform）
 * @param platformWorks 平台作品列表（该账号作品管理页读到的，含 title/remoteId/remoteUrl）
 * @returns {{matched: object[], unmatched: object[]}} matched 项带绑定理由
 */
export function bindByTitle(contents, platformWorks) {
  const matched = []
  const unmatched = []
  for (const content of contents || []) {
    // 只在同一账号的作品里找。候选没带 accountId 时**不能直接排除**——
    // 从某账号的作品管理页读到的列表天然就属于该账号，字段缺失是常态而非「别的账号」。
    const scoped = (platformWorks || []).filter((work) => !content.accountId || !work.accountId || work.accountId === content.accountId)
    const result = matchTitle(content.title, scoped)
    if (result.status === 'matched') {
      matched.push({ ...content, remoteId: result.remoteId, remoteUrl: result.remoteUrl, bindStrategy: 'title-match' })
    } else {
      // 歧义与无匹配都进待绑定：前者还需要人工挑，后者需要人工找。
      unmatched.push({ ...content, reason: result.status === 'ambiguous' ? 'title-ambiguous' : 'no-match', candidates: result.candidates ?? [] })
    }
  }
  return { matched, unmatched }
}

/**
 * 人工绑定（RPC 10）。校验给进来的地址是不是一个能指向单个作品的链接——
 * 传管理页回来等于没绑，采集器会拿着它去列表页空转。
 */
export function normalizeManualBinding({ remoteUrl, remoteId }) {
  const id = typeof remoteId === 'string' ? remoteId.trim() : ''
  const url = typeof remoteUrl === 'string' ? remoteUrl.trim() : ''
  if (!id && !url) return null
  if (url) {
    let parsed
    try { parsed = new URL(url) }
    catch { return null }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  }
  // 只给了作品页链接时，从链接里抠平台 id——抠不出就只留 URL，
  // 采集器照样能用（它本来就走页面），不强求一定有 id。
  return { remoteId: id || remoteIdFromUrl(url), remoteUrl: url || null }
}

/** 从作品详情 URL 里抠出平台 id（如 bilibili 的 av 号），抠不出就返回 null 而不是瞎猜。 */
export function remoteIdFromUrl(url) {
  try {
    const parsed = new URL(String(url))
    const match = /\/(?:video|works|note)\/([A-Za-z0-9]+)/u.exec(parsed.pathname)
    if (match) return match[1]
    const query = parsed.searchParams.get('id') || parsed.searchParams.get('bvid')
    return query || null
  } catch {
    return null
  }
}
