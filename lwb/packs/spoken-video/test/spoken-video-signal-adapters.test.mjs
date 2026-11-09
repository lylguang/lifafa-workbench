import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SIGNAL_SOURCES,
  SOURCE_KIND_OPTIONS,
  assertPublicHttpsUrl,
  dedupeCandidates,
  parseAiDailyReport,
  parseBaiduHotList,
  parseBilibiliPopular,
  parseDouyinHotList,
  parseFeed,
  parseGithubTrending,
  parseHuggingFaceDailyPapers,
  parsePublicHotList,
  parseToutiaoHotList,
  parseWeiboHotList,
  platformForSource,
} from '../spoken-video-signal-adapters.mjs'

test('parses each built-in public payload into normalized signals', () => {
  const baidu = parseBaiduHotList('<!--s-data:{"data":{"cards":[{"content":[{"query":"百度热点","desc":"热点摘要","url":"https://example.com/a","index":0,"hotScore":"1万"}]}]}}-->')
  assert.equal(baidu[0].title, '百度热点')
  assert.equal(baidu[0].hotValue, 10000)
  const toutiao = parseToutiaoHotList({ data: [{ Title: '头条热点', Label: '推荐', Url: 'https://example.com/b', HotValue: '20万' }] })
  assert.equal(toutiao[0].title, '头条热点')
  const feed = parseFeed('<rss><channel><item><title>RSS 线索</title><description>摘要</description><link>https://example.com/c</link></item></channel></rss>', 'https://example.com/feed')
  assert.equal(feed[0].title, 'RSS 线索')
  const papers = parseHuggingFaceDailyPapers([{ paper: { id: '1234.5678', title: 'Paper', summary: 'Abstract', authors: [{ name: 'Ada' }] }, upvotes: 8 }])
  assert.equal(papers[0].url, 'https://huggingface.co/papers/1234.5678')
  assert.equal(dedupeCandidates([{ title: 'A', url: 'https://example.com/a?utm_source=x' }, { title: 'A2', url: 'https://example.com/a' }]).length, 1)
})

test('refuses local and private network signal URLs', async () => {
  await assert.rejects(assertPublicHttpsUrl('http://example.com'), /公开 HTTPS/u)
  await assert.rejects(assertPublicHttpsUrl('https://127.0.0.1/feed'), /本机或私有网络/u)
  await assert.rejects(assertPublicHttpsUrl('https://example.com/feed', { resolveHostname: async () => [{ address: '10.0.0.1', family: 4 }] }), /公开网络地址/u)
})

test('does not expose the retired V2EX source and parses GitHub Trending and CDATA RSS', () => {
  assert.equal(SOURCE_KIND_OPTIONS.some((item) => item.id === 'v2ex-hot'), false)
  assert.equal(DEFAULT_SIGNAL_SOURCES.some((item) => item.id === 'v2ex'), false)
  const trending = parseGithubTrending('<article><h2><a href="/acme/project"> project </a></h2><p>Useful open source project</p><span itemprop="programmingLanguage">TypeScript</span><span>1,200 stars today</span></article>')
  assert.equal(trending[0].title, 'acme/project')
  assert.equal(trending[0].url, 'https://github.com/acme/project')
  assert.equal(trending[0].hotValue, 1200)

  const feed = parseFeed('<rss><channel><item><title><![CDATA[极客 <em>公园</em>]]></title><description><![CDATA[一段 <strong>多行</strong> 摘要]]></description><link>https://example.com/geek</link></item></channel></rss>', 'https://example.com/feed')
  assert.equal(feed[0].title, '极客 公园')
  assert.equal(feed[0].summary, '一段 多行 摘要')
})

test('reads GitHub Trending total stars and forks without being fooled by SVG path digits', () => {
  // 真实结构：数字在 </svg> 之后，而 <path d="M8 .25a.75.75 ..."/> 里全是数字。
  // 曾经的实现取「锚点之后第一个数字串」，于是总 star 取到 3、fork 取到 3。
  const html = `<article class="Box-row">
<h2><a href="/cloudflare/security-audit-skill" class="Link">cloudflare / security-audit-skill</a></h2>
<p class="col-9 color-fg-muted my-1 pr-4">An extremely fast Python linter and code formatter, written in Rust.</p>
<div class="f6 color-fg-muted mt-2"><span itemprop="programmingLanguage">Rust</span>
<a href="/cloudflare/security-audit-skill/stargazers" class="Link--muted d-inline-block mr-3"><svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-star"><path d="M8 .25a.75.75 0 01.75.75v2.5a.75.75 0 01-1.5 0V1A.75.75 0 018 0.25zm0 5.5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 018 5.75z"></path></svg>65,243</a>
<a href="/cloudflare/security-audit-skill/forks" class="Link--muted d-inline-block mr-3"><svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-repo-forked"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75v-.878a2.25 2.25 0 011.5 0v.878a2.25 2.25 0 01-2.25 2.25h-1.5v2.128a2.251 2.251 0 11-1.5 0V8.5h-1.5A2.25 2.25 0 013.5 6.25v-.878a2.25 2.25 0 011.5 0z"></path></svg>4,236</a>
<span class="d-inline-block float-sm-right">Built by 2,088 stars today</span>
</div>
</article>`
  const [item] = parseGithubTrending(html)
  assert.equal(item.summary, 'An extremely fast Python linter and code formatter, written in Rust. · Rust · 65,243 star · 4,236 fork · 今日 +2,088')
  assert.equal(item.hotValue, 2088, 'hotValue 仍然是「stars today」的语义，下游按它算分排名')
  assert.match(item.summary, /65,243 star/u)
  assert.match(item.summary, /4,236 fork/u)
  // SVG path 里的数字（M8 .25a.75.75 …）绝不能成为计数：曾经取到总 star=3、fork=3。
  assert.equal(item.summary.includes('· 3 star'), false)
  assert.equal(item.summary.includes('· 3 fork'), false)
  assert.equal(item.summary.includes('65,243 star'), true)
  assert.equal(item.summary.includes('4,236 fork'), true)
})

test('drops a missing GitHub counter instead of writing zero or unknown', () => {
  // 只有 stargazers、没有 forks：省掉 fork 那一段，不写 0。
  const html = `<article><h2><a href="/acme/project">acme / project</a></h2><p>Useful project</p><span itemprop="programmingLanguage">TypeScript</span>
<a href="/acme/project/stargazers"><svg class="octicon octicon-star"><path d="M8 .25a.75.75 0 01.75.75"></path></svg>12,345</a>
<span>Built by 100 stars today</span></article>`
  const [item] = parseGithubTrending(html)
  assert.match(item.summary, /12,345 star/u)
  assert.doesNotMatch(item.summary, /fork/u)
  assert.doesNotMatch(item.summary, /0 fork/u)
  assert.equal(item.hotValue, 100)
})

test('a repository named like a counter path does not corrupt the counter', () => {
  // 仓库本身叫 forks：标题链接 href="/acme/forks" 曾被 `/forks` 命中，
  // 于是总 star 的数字被当成了 fork 数。
  const html = `<article><h2><a href="/acme/forks">acme / forks</a></h2><p>Tool</p><span itemprop="programmingLanguage">Go</span>
<a href="/acme/forks/stargazers"><svg class="octicon octicon-star"><path d="M8 .25a.75.75 0 01.75.75"></path></svg>65,243</a>
<a href="/acme/forks/forks"><svg class="octicon octicon-repo-forked"><path d="M5 5.372v.878c0 .414.336.75.75.75"></path></svg>4,236</a>
<span>Built by 2,088 stars today</span></article>`
  const [item] = parseGithubTrending(html)
  assert.match(item.summary, /65,243 star/u)
  assert.match(item.summary, /4,236 fork/u)
  assert.equal(item.summary.includes('65,243 fork'), false, 'fork 数不能被 star 数污染')
})

test('a counter anchor without an inline SVG does not read the next anchor', () => {
  // 目标锚点里没有 svg 时，旧的实现会跨过 `</a>` 去下一个锚点里找 `</svg>`，
  // 把别的数字当成计数。
  const html = `<article><h2><a href="/acme/project">acme / project</a></h2><p>Tool</p><span itemprop="programmingLanguage">Go</span>
<a href="/acme/project/stargazers">65,243</a>
<a href="/acme/project/network"><svg class="octicon"><path d="M8 .25a.75.75"></path></svg>9</a>
<a href="/acme/project/forks"><svg class="octicon octicon-repo-forked"><path d="M5 5.372v.878c0 .414"></path></svg>4,236</a>
<span>Built by 2,088 stars today</span></article>`
  const [item] = parseGithubTrending(html)
  assert.match(item.summary, /65,243 star/u, '总 star 必须取到本锚点里的数字')
  assert.equal(item.summary.includes('· 9 star'), false, '不能读到后面锚点的数字')
  assert.match(item.summary, /4,236 fork/u)
})

test('a missing stars-today counter leaves hotValue empty instead of writing zero', () => {
  // `Number(null)` 是 0 且 0 是有限数，缺计数曾被钳成「热度数值：0」——
  // 那是一个凭空造出来的零。
  const html = `<article><h2><a href="/acme/project">acme / project</a></h2><p>Tool</p><span itemprop="programmingLanguage">Go</span>
<a href="/acme/project/stargazers"><svg class="octicon octicon-star"><path d="M8 .25a.75.75"></path></svg>12,345</a></article>`
  const [item] = parseGithubTrending(html)
  assert.equal(item.hotValue, null, '缺今日新增时 hotValue 必须是 null，不能是 0')
  assert.match(item.summary, /12,345 star/u)
  assert.doesNotMatch(item.summary, /今日/u)
})

test('parses direct public platform signals without treating them as connectors', () => {
  const douyin = parseDouyinHotList({ data: { word_list: [{ word: '抖音热榜话题', position: 1, hot_value: 123456, group_id: '123', video_count: 9, event_time: 1_700_000_000 }] } })
  assert.equal(douyin[0].title, '抖音热榜话题')
  assert.equal(douyin[0].hotValue, 123456)
  assert.match(douyin[0].url, /douyin\.com\/search/u)

  const bilibili = parseBilibiliPopular({ data: { list: [{ title: 'B站热门视频', bvid: 'BV1test', desc: '视频简介', pubdate: 1_700_000_000, tname: '知识', owner: { name: '创作者' }, stat: { view: 12_345, like: 200 } }] } })
  assert.equal(bilibili[0].url, 'https://www.bilibili.com/video/BV1test')
  assert.equal(bilibili[0].hotValue, 12345)

  const zhihu = parsePublicHotList({ code: 200, data: [{ title: '知乎热榜问题', extra: '42万', link: 'https://zhihu.test/question/1' }] })
  assert.equal(zhihu[0].hotValue, 420000)

  const weibo = parseWeiboHotList({ ok: 1, data: { realtime: [{ word: '微博热搜词', realpos: 1, num: 88_888 }] } })
  assert.equal(weibo[0].title, '微博热搜词')
  assert.equal(weibo[0].hotValue, 88888)
})

test('structures Hacker News style feed descriptions into hotValue and clean summary', () => {
  const description = '&lt;p&gt;Article URL: https://example.com/a&lt;/p&gt;&lt;p&gt;Comments URL: https://news.ycombinator.com/item?id=1&lt;/p&gt;&lt;p&gt;Points: 290&lt;/p&gt;&lt;p&gt;# Comments: 96&lt;/p&gt;'
  const [item] = parseFeed(`<rss><channel><item><title>Breaking X</title><description>${description}</description><link>https://news.ycombinator.com/item?id=1</link></item></channel></rss>`, 'https://hnrss.org/frontpage')
  assert.equal(item.hotValue, 290)
  assert.equal(item.summary.includes('Article URL'), false)
  assert.equal(item.summary.includes('Comments URL'), false)
  assert.equal(item.summary, '社区讨论 · 290 points · 96 评论')
  const [plain] = parseFeed('<rss><channel><item><title>普通订阅</title><description>正常摘要文本</description><link>https://example.com/d</link></item></channel></rss>', 'https://example.com/feed')
  assert.equal(plain.summary, '正常摘要文本')
  assert.equal(plain.hotValue, null)
})

test('clamps oversized hot values to safe integers', () => {
  const [item] = parseAiDailyReport({ items_by_platform: { douyin: [{ title: '超大热度', url: 'https://example.com/big', hot_value: 20260829120985508 }] } })
  assert.equal(item.hotValue, Number.MAX_SAFE_INTEGER)
})

test('keeps the platform dimension for board cards and AI daily imports', () => {
  assert.equal(platformForSource('douyin-hot', 'douyin-hot'), '抖音')
  assert.equal(platformForSource('bilibili-popular', 'bilibili-popular'), 'B站')
  assert.equal(platformForSource('zhihu-hot', 'public-hot-list'), '知乎')
  assert.equal(platformForSource('weibo-hot', 'weibo-hot'), '微博')
  assert.equal(platformForSource('baidu', 'baidu-hot'), null)
  const daily = parseAiDailyReport({ items_by_platform: { douyin: [{ title: '抖音信号', url: 'https://example.com/d1' }] }, trending_topics: [{ title: '趋势信号', platform: 'xiaohongshu' }] })
  assert.equal(daily.find((item) => item.title === '抖音信号').platform, '抖音')
  assert.equal(daily.find((item) => item.title === '趋势信号').platform, '小红书')
})
