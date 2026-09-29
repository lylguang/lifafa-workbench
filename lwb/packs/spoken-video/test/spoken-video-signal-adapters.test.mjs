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
