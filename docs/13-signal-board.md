# 13 信号板设计（Signal Board）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

本文档定义口播视频能力包「信号」菜单的产品形态重构设计：从「混合信号流 + 运维 Tab」重构为「今日概览 + 来源卡片 + 详情抽屉」的信号板。参考实现为 `/Users/alanfu/Documents/projects/agent-teams/my-agent` 的双族信号模型。本文档只定义设计；实现顺序见第 11 节。

## 修订记录

- **2026-09-05（信号模块简化，见 [21 分析](./21-signal-module-simplification-analysis.md)）**：按「工程语义退出用户界面」原则实施三处简化——① 信号抽屉删除「送入选题」（该功能存在 `openPackMenu` 未声明的隐性 bug，从未真正跳转；选题页自带完整的「具体信号」勾选列表，成为信号→选题的唯一通道），信号卡动作改为可读文字按钮「原文 / 收藏 / 忽略 / 恢复」，删除单字缩略图标；② 来源管理删除「设置 / 添加来源 / 删除」与 RSS 发现，来源库变为只读产品目录，仅保留「采集 / 启用 / 停用」（启停用改用窄 RPC `setSourceEnabled`）；③ 命令条、来源库、空平台卡三处「导入 AI 日报」手动粘贴入口全部下线，`importAiDailyReport` RPC 连根删除，AI 日报链路完全自动化。连带删除：`createSource / updateSource / removeSource / discoverFeeds / sourceKinds` RPC、`builtIn` 字段、`topicHandoff` handoff 机制、适配器 `discoverFeeds`。
- **2026-09-04（schema 9）**：V2EX 热门主题在当前运行环境持续无法建立 HTTPS 连接，已从内置来源和来源类型中移除。schema 8 工作区会自动清理 V2EX 的来源、信号、采集记录及内容安排引用；仅依赖该来源的安排会删除，混合安排只移除该来源。
- **2026-09-02（双链路分治，见 [18 调整方案](18-signal-module-restructure-plan.md)）**：按"公开采集与 AI 日报两条独立链路不混排"原则重构：删除 `manual` 来源、人工录入表单与「录入信号」入口；删除 `PLATFORM_CONNECTOR_CATALOG` 与「平台情报」子 Tab（来源管理降为来源库 / 采集记录两 Tab）；删除 `captureSignal` / `connectorCatalog` RPC、`passiveSource` 概念与全部 schema 迁移函数；`ai-daily-import.maxItems` 50→200；`board().aiDaily.platforms` 改为按常量 5 平台（抖音 / B站 / 公众号 / 小红书 / 视频号）全量输出，无数据平台以占位卡呈现；孤儿信号静默丢弃而非抛错。本地数据一次性重置后重新采集。
- **2026-09-01（schema 8）**：AI 内容日报由「被动人工导入」升级为**内置拉取来源**——报告已公开发布在 `https://scitiger.cn/reports/daily.json`（符合公开 HTTPS + SSRF 防护策略），kind 改为 `ai-daily-json`，每 60 分钟自动采集，family 独立为「AI 内容日报」。真实报告存在超过 `Number.MAX_SAFE_INTEGER` 的 hot_value，`candidate()` 对热度做 clamp 防护。（其中"人工录入与手动导入保留为兜底入口"已于 2026-09-02 修订：人工录入已删除，仅保留手动粘贴导入。）

## 1. 背景与目标

### 1.1 现状问题

当前 `SignalsPage` 是单页四 Tab（信号流 / 来源库 / 平台情报 / 采集记录）：

- 首屏是 19 个来源混排的平铺信号流，无「今天」视角、无来源维度的一等入口；
- 抽屉只承担表单（人工录入 / AI 日报导入 / 来源设置），不承担详情浏览；
- AI 日报导入后平台维度丢失（全部落入 `ai-daily-import` 来源，平台仅残留在 tags），无法按平台成卡；
- host 侧 `listSignals` 只有过滤 + 排序，没有「按来源 × 今日」的聚合能力，卡片摘要无从产出；
- 信号 → 选题的闭环断裂：shell 页面 props 仅有 `openConversation/openPacks`，无法跨菜单跳转。

### 1.2 目标形态

- 首屏 = **信号板**：今日概览条 + 按情报域分组的**来源卡片**；
- 卡片先展示**今天拿到的信号**（Top3 预览 + 今日新增数），点击卡片以**抽屉**展示该来源详情；
- AI 日报按平台拆子卡（AI 内容日报 · 抖音 / 小红书 / 公众号 / 视频号 / B站），带新鲜度徽章；
- 抽屉内信号可「送入选题」，一键跳转选题页并预选；
- 来源运维（来源库 / 平台情报 / 采集记录）降级为二级视图「来源管理」。

### 1.3 非目标

- 不改采集调度器、SSRF 防护、指纹去重、信号状态机（active/saved/ignored）、选题 artifact 写入逻辑；
- 不新增写路径 RPC（除既有来源/信号操作外），本轮只新增一个只读聚合 RPC；
- 不重写旧信号摘要文本（适配器清理只影响新采集）。

## 2. 参考模型（my-agent）

my-agent 的信号是两族：

1. **公开热信号**：`collectPublicHotSignals()` 产出 `hot_topics_*.json` artifact，按来源归一化（`title/snippet/url/rank/hot_value/source`）。LWB 适配器层已移植该族解析。
2. **社媒情报（AI 日报）**：`ai_daily_report_YYYY-MM-DD.json` 以 `items_by_platform` 按平台分组，信号带 engagement 与 pillar 命中，并派生 `topic_seeds`；带新鲜度语义 fresh ≤72h / recent ≤168h / stale >168h。

其消费方式值得对齐：选题候选持有 `hot_signal_refs / social_signal_refs`（依据可追溯），送模时来源平衡 + top-N。LWB 的「选题写入信号依据 artifact」已具备追溯写入，缺的是呈现层与平台维度。

## 3. 信息架构

```text
信号页（菜单 id: signals，默认视图 = 信号板）
├─ 今日概览条（命令条）
│    本地日期 · 今日新增 N · 今日已采集 x/y 来源 · 异常 M · 最近采集时间
│    动作：[采集全部] [来源管理]
├─ 卡片网格（按 family 分组：公共热点 / 内容平台 / 科技与商业 / 开发者社区 / AI / 开源）
│    ├─ 来源卡 ×N：百度热榜 / 今日头条 / 抖音热榜 / B站热门内容 / 知乎热榜 / 微博热搜 /
│    │              AI 论文日报 / 36氪 / InfoQ / IT之家 / 极客公园 / 爱范儿 / 少数派 /
│    │              掘金 / GitHub Trending / Hacker News
│    └─ AI 日报平台子卡：AI 内容日报 · 抖音 / 小红书 / 公众号 / 视频号 / B站 / 知乎（有数据才出现）
├─ 卡片点击 → 详情抽屉（右侧滑出，复用现有 sv-drawer 模式）
│    ├─ 来源头：名称 + 状态徽章 + [立即采集]
│    ├─ 今日新增（完整列表）
│    ├─ 更早（折叠分段，limit 分页）
│    └─ 信号行动作：原文 / 收藏 / 忽略 / 恢复
└─ 来源管理（二级视图，来源库只读目录 + 采集记录）
```

菜单标签仍为「信号」；页面内标题改为「信号板」。

## 4. 信号板（默认视图）

### 4.1 今日概览条

- 展示 host 本地日期（`YYYY-MM-DD 周X`）与 totals：今日新增、活跃总数、需处理异常、今日已采集来源数 / 可采集来源数、最近一次采集时间；
- 主动作：采集全部（沿用 `collectSources`）、导入 AI 日报、录入信号（沿用现有抽屉表单）、来源管理（切换二级视图）；
- 今日新增为 0 时显示说明文案：「今天暂无新信号 · 最近采集 {time}」，并突出「立即采集」。

### 4.2 来源卡片

粒度：**每来源一卡**，按 `family` 分组排列；组内按「今日新增 desc → 最近成功时间 desc」排序。

卡片字段：

| 区域 | 内容 |
|---|---|
| 头部 | 来源名称 + 状态徽章：正常 / 异常（红，附 lastError 一行）/ 已停用 / 未采集 / 今日已导入 |
| 今日行 | `今日新增 N · 活跃 M`；被动来源（人工录入）显示 `已录入 M` |
| 采集行 | `最近采集 {relative time}`；AI 日报子卡显示新鲜度徽章 fresh/recent/stale（阈值 72h/168h，与 my-agent 一致，基准为该平台最近一次导入时间） |
| 预览 | 今日 Top3 信号标题（score desc），带 `排名/热度` 前缀；今日为 0 时回退显示最近 3 条并标注 `previewScope: latest` |
| 角动作 | 轻量「采集」按钮（单来源 `collectSources`），不阻断整卡点击 |

整卡可点击 → 抽屉。键盘可达：卡片为 `<button>`。

AI 日报平台子卡：来源固定为 `ai-daily-import`，但按信号 `platform` 分组渲染多张子卡；无 platform 的导入信号归入「AI 内容日报 · 其他」。平台子卡点击 → 抽屉以 `sourceIds:['ai-daily-import'] + platform` 过滤。

### 4.3 空态与异常

- 无会话：沿用 `NeedSession`；
- 全部来源未采集（新工作区）：概览条提示「尚未采集」，卡片全部显示「未采集」，引导「采集全部」；
- 来源异常：卡片红色徽章 + 错误摘要一行；概览条异常计数可点击 → 来源管理 · 采集记录。

## 5. 详情抽屉

- 打开时按 `sourceId`（+ 可选 platform）请求 `listSignals`（limit 200），客户端用 board 返回的今日起止瞬间切分「今日新增 / 更早」两段；
- 信号行：标题、meta 行（来源 · 排名 · 热度格式化 · 评分 · 时间 · tags）、摘要（两行截断）；动作：原文（外链）、收藏、忽略、恢复（沿用 `setSignalState`）、**送入选题**；
- 来源头动作：立即采集、设置（打开现有来源设置抽屉，嵌套替换内容）、启用/停用；内置来源不显示删除；
- 「送入选题」：把信号 id 写入 pack 级模块内 handoff 数组，调用核心新回调 `openPackMenu('topics')`；TopicsPage 挂载时消费 handoff 并预勾选，消费后清空；
- 抽屉内保留 ESC / 背景点击关闭，`role="dialog" aria-modal`（沿用现有实现）。

## 6. 来源管理（二级视图）

整合现有三个 Tab 为子 Tab：来源库（含添加/编辑/发现 RSS）、平台情报（connector 目录与导入入口）、采集记录（runs 列表）。内容基本沿用现有实现，仅容器降级；入口在概览条与抽屉来源头。

## 7. 数据模型与迁移

### 7.1 signals.json schema 6 → 7

`signal` 增加可选字段 `platform`（string ≤32，可 null）。迁移为**纯增量**：

- 内置平台来源映射：`douyin-hot→抖音`、`bilibili-popular→B站`、`zhihu-hot→知乎`、`weibo-hot→微博`；
- `ai-daily-import`：`tags[0]==='AI日报'` 时取 `tags[1]`（缺失或为「社媒」时 null）；
- 其余来源 `platform=null`；
- 新采集时适配器直接写入 platform（内置平台来源与 `parseAiDailyReport` 归一化平台）。

validator 对未知 platform 做长度/类型校验；旧文件读取时自动迁移并回写（沿用现有 `needsMigration` 模式）。

### 7.2 「今天」语义

- 统一使用 **host 本地日历日**（与调度器 `localMinute` 一致）；
- board 返回 `today: { date, startIso, endIso }`（本地日边界对应的 UTC 瞬间），客户端用其切分预览与抽屉分段，保证单一事实源；
- 「今日已采集来源」= 主动来源中 `health.lastSuccessAt` 或 `lastAttemptAt` 落入今日的数量。

## 8. 接口设计

### 8.1 新增只读 RPC `spokenVideo/board`

一次请求产出整板数据，避免客户端 N 次 `listSignals`：

```json
{
  "today": { "date": "2026-09-01", "startIso": "2026-08-31T16:00:00.000Z", "endIso": "2026-09-01T16:00:00.000Z" },
  "totals": { "todayNew": 0, "active": 356, "saved": 0, "ignored": 0, "errorSources": 1, "collectableSources": 17, "collectedToday": 0, "lastCollectAt": "..." },
  "sources": [
    {
      "id": "baidu", "name": "百度热榜", "family": "公共热点", "kind": "baidu-hot",
      "enabled": true, "builtIn": true, "platform": null,
      "status": "ready", "lastError": null, "lastSuccessAt": "...", "intervalMinutes": 30,
      "todayCount": 0, "activeCount": 37, "savedCount": 0,
      "previewScope": "latest",
      "preview": [ { "id": "...", "title": "...", "rank": 1, "hotValue": 123456, "score": 84, "capturedAt": "...", "url": "...", "state": "active" } ]
    }
  ],
  "aiDaily": {
    "sourceId": "ai-daily-import",
    "platforms": [
      { "platform": "抖音", "todayCount": 0, "totalCount": 12, "lastImportedAt": "...", "freshness": "fresh", "preview": [ { "...": "同 preview 信号精简字段" } ] }
    ]
  }
}
```

- `sources` 含被动来源（manual 以「人工录入」小卡呈现）；`aiDaily.platforms` 仅含有信号的平台；
- preview 信号为精简投影（id/title/rank/hotValue/score/capturedAt/url/state/platform/tags），完整对象仍由 `listSignals` 提供；
- 实现位于 `SpokenVideoContentStore.board(agent)`，走现有 `serial()` 读路径；gateway 增加一个 `@Remote` 方法。

### 8.2 既有 RPC 不变

`listSignals` 增加可选 `platform` 过滤参数（向后兼容），供抽屉按平台子卡过滤；其余写路径 RPC 全部保留。

### 8.3 核心扩展：`openPackMenu`

`lwb/dsh-bundle/client.js` 的 `CapabilityPage` 向页面 props 增加：

```js
openPackMenu: (menuId) => { if (pack.menus.some((item) => item.id === menuId)) navTo('capability', capabilityRoute(pack.id, menuId)) }
```

约十几行核心改动；pack 不能 import 核心，仍通过 props 消费。docs/12 的「核心只传入公开 pack/menu 信息、当前 Session id 与基础导航回调」表述同步更新（导航回调从两个变三个）。

### 8.4 选题预选手 handoff

pack client 模块级 `const topicHandoff = { ids: [] }`：抽屉「送入选题」push 信号 id 后 `openPackMenu('topics')`；`TopicsPage` 挂载时 `selected = [...new Set(topicHandoff.ids)]` 并清空。handoff 不持久化，刷新即失。

## 9. 适配器质量清理

只影响新采集：

- `parseFeed` 对 Hacker News 式 description（`Article URL: … Comments URL: … Points: N # Comments: M`）做结构化：`Points→hotValue`、`# Comments→tags 或 meta`，summary 仅保留描述性文本，空则回退默认摘要；
- 客户端共享热度格式化（`123456→12.3万`、`3200→3200`），卡片与抽屉共用；
- 为以上两条补 `spoken-video-signal-adapters.test.mjs` 用例。

## 10. 客户端实现要点

- 组件拆分（均在 `client.js`，CSS 沿用 `sv-` 命名空间）：`SignalBoardPage`（概览条 + 分组卡片网格）、`SourceCard`、`AiDailyPlatformCard`、`SignalDrawer`（详情）、`SourceAdminView`（二级视图，搬移现有来源库/平台情报/采集记录）、复用现有表单抽屉；
- 卡片网格 `repeat(auto-fill, minmax(280px,1fr))`；分组标题沿用 `sv-section-head`；
- 请求编排：挂载与操作后只调 `board()`；抽屉打开时按需 `listSignals`；收藏/忽略后局部更新 + 后台 `board()` 刷新；
- 现有 `sv-drawer` 背景/动效复用；新类名需自带样式（pack 样式不受核心样式契约测试约束）。

## 11. 实施顺序与测试

1. **host store**：schema 7 迁移 + `platform` validator + `board()` + `listSignals.platform` 过滤；测试：v6→v7 迁移 fixture（含 ai-daily tags 推导）、board 聚合（注入 `now` 固定时钟）、今日本地边界跨日用例（`spoken-video-content-store.test.mjs`）；
2. **adapters**：HN/RSS 摘要结构化 + 内置平台来源写入 platform；测试补用例；
3. **核心**：`openPackMenu` props + docs/12 表述更新；`npm run check` 与现有 pack 测试全绿；
4. **client**：按第 10 节重构 `SignalsPage`，TopicsPage 消费 handoff 预选；
5. **回归**：`npm run test`、`pack:profile-check`，启动后截图核对信号板 / 抽屉 / 来源管理三态（含「今日 0 条」空态，即当前真实数据状态）。

## 12. 风险与兼容性

- 迁移纯增量，`platform` 可 null，旧客户端忽略新字段；board 为只读，不影响写路径与调度器；
- 平台推导为启发式（tags[1]），推导失败归「其他」，不阻塞；
- 今日 0 条是常态空态（当前数据即如此），预览回退 latest 且明确标注，避免「空板」观感；
- `openPackMenu` 为唯一核心改动，需保持未加载 pack 时 shell 行为不变（props 仅在 CapabilityPage 渲染时构造）。
