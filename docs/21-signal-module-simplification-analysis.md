# 21 信号模块简化分析：去掉信号卡工程动作、来源设置与手动导入入口

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> 状态：2026-09-05 分析完成，方案待用户拍板（未动代码）。依据：`lwb/packs/spoken-video/client.js`、`spoken-video-content-store.mjs`、`spoken-video-signal-adapters.mjs`、`gateway.mjs`、测试与本地真实数据 `.lwb/spoken-video/signals.json`。
> 关联：[13 信号板设计](./13-signal-board.md)、[18 双链路分治方案](./18-signal-module-restructure-plan.md)、[20 信号页视觉美化](./20-signal-page-visual-polish-plan.md)。

## 0. 用户的三条设想

1. **信号抽屉（点来源卡弹出的面板）**：不需要「送入选题」；「打开链接 / 收藏 / 忽略」不要用单字缩略图标按钮（看不懂）。
2. **来源管理**：不需要「设置」功能——信号来源有哪些，是产品定义的事，不该开放给用户配置。
3. **信号页顶部命令条**：不需要「导入 AI 日报」——这是工程角度的功能，不是用户角度的功能。

**总判断：三条全部成立。** 它们指向同一个原则：**信号页是「情报浏览与评估」的用户界面，来源配置、数据导入、跨页投递都是工程/运维语义，应退出用户界面。** 逐条分析如下。

---

## 1. 现状盘点

### 1.1 信号抽屉里的动作（`client.js:446-477` row()）

每条信号卡片的动作区（`sv-sig-acts`）：

| 动作 | 呈现 | 实现 |
|---|---|---|
| 送入选题 | 主按钮（实色/描边） | `sendToTopics(item.id)`（`client.js:620`） |
| 原文 | 28px 单字方块「文」，仅 title 提示 | `<a>` 外链 |
| 收藏 | 单字方块「藏」 | `setSignalState → 'saved'` |
| 忽略 | 单字方块「略」 | `setSignalState → 'ignored'` |
| 恢复 | 单字方块「恢」 | `setSignalState → 'active'` |

单字方块是 [20 视觉方案](./20-signal-page-visual-polish-plan.md) 第 3 节刻意做的「主＝送入选题实色，次＝ghost 图标按钮」分层。上线后用户实测反馈：**看不出是什么意思**——「识别优于回忆」，单字 + tooltip 不达标。

**「送入选题」还带着一个从未被发现的 bug**：`client.js:620` 的实现是

```js
const sendToTopics = (signalId) => { topicHandoff.ids.push(signalId); if (openPackMenu) openPackMenu('topics') }
```

但 `SignalsPage` 的入参只有 `{ sessionId, openConversation }`，**`openPackMenu` 在整个模块里从未声明**（全仓只在 `dsh-bundle/client.js:1585` 的 props 对象里出现过）。所以每次点击：push 成功后读取未声明标识符 → 抛 `ReferenceError`，**从不跳转**。用户只有在点完之后自己手动切到选题页时，`TopicsPage` 挂载（`client.js:967-973`）才会消费 handoff 里的 id。也就是说，这个占据每张信号卡主按钮位的功能，从上线起就是一半坏的。

而选题页本身已经有完整的信号选择能力：`client.js:1099-1102` 「具体信号（可选 · 勾选）」列表，全量活跃信号带来源与评分，可多选，与标题/角度/信号源分层组装。**抽屉里的单条「送入选题」是重复且更弱的入口。**

收藏/忽略/恢复则不同：后端 `setSignalState`（`content-store.mjs:495`）+ 状态机 `active/saved/ignored`（`:59`）、抽屉筛选 chips、三格统计（今日新增/活跃/已收藏）都建立在它之上，是**真实的用户评估动作，保留**。

### 1.2 来源管理的「设置」（`client.js:667-684` renderSourceCard）

来源库每张卡的动作：`[手动导入(仅日报卡)] [采集] [启用/停用] [设置] [删除(仅自定义)]`。

「设置」打开的编辑表单（`client.js:743-760`）字段：标识、名称、类型（11 种 kind 下拉）、分组、URL / GitHub 仓库、采集间隔、单次上限、必须包含/排除关键词、标签、启用开关；「添加来源」（`:697`）还挂了一套 `discoverFeeds` RSS 发现表单（`:772-777`）。

对应后端链路：`createSource / updateSource / removeSource / discoverFeeds / sourceKinds` 五个 RPC（`gateway.mjs:30-37`、`content-store.mjs:425-484`）+ `SOURCE_KIND_OPTIONS`（`adapters.mjs:22-34`）。

**真实数据核查**：`.lwb/spoken-video/signals.json`（schemaVersion 9）里 17 个来源**全部 `builtIn: true`，没有任何自定义来源**；`DEFAULT_SIGNAL_SOURCES`（`adapters.mjs:36-105`）就是产品内置的完整目录。来源库说明文案「自定义 RSS、Atom 与 GitHub Releases 可随时加入」描述的是一个**从未被使用过的能力**。

一个必须点破的耦合：**卡片上的「启用/停用」复用的正是 `updateSource` RPC**（只传 `enabled` 字段，`client.js:679`）。删「设置」时这条链路要单独处置（见 3.3）。

### 1.3 「导入 AI 日报」入口（共 3 处，同一个粘贴 JSON 表单）

| # | 位置 | 触发 |
|---|---|---|
| 1 | 顶部命令条次按钮（`client.js:732`） | 打开 ai-daily 抽屉 |
| 2 | 来源库日报卡「手动导入」（`:677`） | 同上 |
| 3 | 空平台子卡点击兜底（`:648`，`totalCount=0` 时） | 同上 |

而 `ai-daily-import` 在 2026-09-01 之后已经是**全自动来源**：`kind: 'ai-daily-json'`，每 60 分钟自动拉取 `https://scitiger.cn/reports/daily.json`（`adapters.mjs:101-104`）。本地数据里该链路正常，945 条信号全部 active。手动粘贴 JSON 是「报告不可达时的兜底 + 开发调试通道」——纯工程语义，却以三个入口的密度暴露在用户界面里。

---

## 2. 逐条判断

### 2.1 删「送入选题」✅ 成立

- 选题页自带更强的信号选择（多选 + 来源维度 + 与标题/角度组合）；抽屉单条投递是重复入口；
- 该功能现状即坏（`openPackMenu` 未定义，从不跳转），修它反而要引入跨页导航耦合；
- 它长期霸占每张信号卡的主按钮位，挤掉了真正该被看见的评估动作。

连带删除：`topicHandoff`（`:307`）、`sendToTopics`、`SignalDrawerBody` 的 `sendToTopics` prop、`TopicsPage` 挂载时的 handoff 消费（`:972`）。选题页的「具体信号」勾选列表原样保留，成为信号→选题的**唯一**通道。

### 2.2 缩略图标改可读文字按钮 ✅ 成立

单字方块改为文字迷你按钮：**[原文] [收藏] [忽略] [恢复]**（描边/ghost 文字样式，沿用 `sv-outline-mini` 或新文字按钮类），按状态显隐逻辑不变。

删掉「送入选题」后，卡片动作区不再有主/次分层问题——**四个评估动作天然平级**，一行文字按钮从左到右排开即可。信号卡的第一交互本来就是阅读标题与摘要，动作行不需要视觉主角。

### 2.3 来源管理删「设置」✅ 成立（需划定边界）

- 17 个来源全部内置、零自定义来源使用记录；来源目录是产品定义，不是用户配置；
- 表单里的字段（采集间隔 / 单次上限 / 关键词过滤 / kind 选择）全是工程参数，普通用户既看不懂也没必要碰；
- 与项目「零兼容」惯例一致：废弃概念连根删除。

**边界要划清的是两个相邻动作**（决策点，见第 5 节）：

| 动作 | 性质 | 建议 |
|---|---|---|
| 采集 / 立即采集 | 用户动作（「给我最新内容」） | **保留**（卡片 + 抽屉头都有） |
| 启用 / 停用 | 半运维，但对应真实用户诉求（「我不想看微博」） | **建议保留**，后端换成专用窄 RPC |
| 设置（编辑表单） | 工程配置 | **删除** |
| 添加来源 + RSS 发现 | 工程配置 | **删除** |
| 删除来源 | 只服务自定义来源 | 随自定义来源消亡**自然删除** |

删除后来源库变成**只读产品目录**：每来源一卡，展示名称/类型/频率/状态/最近采集，动作只剩 `[采集] [启用/停用]`。说明文案同步改写（不再提「自定义可随时加入」）。

### 2.4 顶部删「导入 AI 日报」✅ 成立

- 自动采集链路在位且健康，手动粘贴是调试兜底，不是用户流程；
- 与 [18 双链路分治] 原则一致：链路 B 应完全自动、无运维痕迹；
- 三处入口全部下线（命令条 / 来源库日报卡 / 空平台卡兜底）。

**连带决策**：`importAiDailyReport` RPC 是否一起删？建议**零兼容删除**，理由：它是纯手动导入的载体，留着就是留复活入口；`ai-daily-json` 自动采集走的是 `collectSignalSource`，不依赖它。代价是测试改造（该 RPC 目前被 7 处测试用作播种），改法见 3.4。

空平台子卡（`totalCount=0`）的点击行为改为**无动作**（卡片已显示「今日暂无数据」占位，不需要再导向任何地方）。

---

## 3. 删除与改造清单（零兼容，按项目惯例）

### 3.1 客户端 `client.js`

| # | 对象 | 位置 |
|---|---|---|
| C1 | `topicHandoff` 与 `sendToTopics` | `:307`、`:620` |
| C2 | 信号卡「送入选题」主按钮；`文/藏/略/恢` 单字方块改文字按钮 | `:467-474` |
| C3 | `SignalDrawerBody` 的 `sendToTopics` prop | `:410`、`:765` |
| C4 | `TopicsPage` handoff 消费分支 | `:972` |
| C5 | editor 状态机：`editor` / `startCreate` / `startEdit` / `saveSource` / `feedSite` / `feeds` / `discover` / `kinds` | `:546-548`、`:593-618`、`:561`（refresh 里的 `sourceKinds` 调用） |
| C6 | 来源设置抽屉（source drawer）与 RSS 发现表单 | `:743-777` |
| C7 | 来源卡「设置」「删除」按钮、「添加来源」按钮、说明文案 | `:680-681`、`:694-697` |
| C8 | 三处 AI 日报导入：命令条按钮 / 日报卡「手动导入」/ 空平台卡兜底 + `ai-daily` 抽屉表单 + `reportJson` 状态 + `importReport` | `:732`、`:677`、`:648`、`:737-742`、`:549`、`:584-592` |

### 3.2 网关 `gateway.mjs`

删 6 个 RPC：`createSource`、`removeSource`、`discoverFeeds`、`sourceKinds`、`importAiDailyReport`，以及 `updateSource`（由 3.3 的窄 RPC 替代）。

### 3.3 存储 `spoken-video-content-store.mjs`

| # | 对象 | 说明 |
|---|---|---|
| S1 | `createSource` / `removeSource` / `discoverFeeds` / `sourceKinds()` / `importAiDailyReport` | 删除 |
| S2 | `updateSource` | **替换为 `setSourceEnabled(sourceId, enabled)`**：只允许翻转启用状态，其余字段不可写。启用/停用是保留的用户动作，但不能继续借道全量编辑 RPC |
| S3 | `source()` 校验与 `SIGNAL_SOURCE_KINDS` | **不动**。注意 `SOURCE_KIND_OPTIONS` 仍是 `sourceKind()` 校验内置来源数据的 kind 白名单（`content-store.mjs:133-137`），数据加载依赖它——只删 UI 与 RPC 暴露，不删常量本身 |
| S4 | `builtIn` 字段 | 自定义来源消亡后 `builtIn` 恒为 true，可顺手删除该字段及 `removeSource` 的「内置来源不能删除」分支（已随 S1 删除）；`sourceSummary` / `buildBoard` 里的透出同步清理 |

### 3.4 测试 `test/spoken-video-content-store.test.mjs`

- 来源 CRUD 用例（`:27-53` 等 5 处）整体删除——它们测的正是被删能力；
- 7 处 `importAiDailyReport` 播种改为**走自动链路播种**：测试 fetcher 返回 AI 日报 JSON，调用 `collectSources({ sourceIds: ['ai-daily-import'] })`——与被删除功能的真实产品形态一致；
- `:42-44` 非法 kind 拒绝用例失去宿主（`createSource` 已删），可直接删除；
- 新增用例：① `setSourceEnabled` 只改启用状态、其余字段不变；② 信号卡动作相关状态机（已有，保持）。

### 3.5 文档

| 文档 | 改动 |
|---|---|
| `docs/13` | 抽屉动作行去掉「送入选题」；概览条动作去掉「导入 AI 日报」；`§10` handoff 段落标记删除 |
| `docs/17` | 「送入选题预选」相关表述（`:88/:150/:175`）改为「选题页勾选是唯一信号入口」 |
| `docs/18/20` | 历史实施记录不改写，新增本文档引用即可 |
| `docs/README.md` | 补 20、21 两行索引 |

---

## 4. 改后形态

```text
信号页
├─ 命令条：信号板 · live │ 统计 │ [采集 N 个来源] [来源管理]   ← 删「导入 AI 日报」
├─ 信号板
│    ├─ 链路 A 分组来源卡（点击 → 信号抽屉）
│    └─ 链路 B AI 内容日报 5 平台卡（空卡仅作占位，不再导向导入表单）
├─ 信号抽屉
│    来源头：glyph + 名称 + 状态 + [立即采集] + 关闭          ← 无设置入口
│    工具行：全部 / 今日 / 已收藏 / 已忽略 + 搜索
│    信号卡动作：[原文] [收藏] [忽略] [恢复]（文字按钮）       ← 删「送入选题」
└─ 来源管理（只读产品目录）
     ├─ 来源库：17 个内置来源卡，动作仅 [采集] [启用/停用]    ← 删 设置/添加/删除
     └─ 采集记录
```

信号→选题唯一通道：选题页「具体信号」勾选列表。

> 修订（2026-09-05，选题模块重设计）：上文「信号→选题唯一通道 = 选题页具体信号勾选列表」**已被取代**。选题页改为账号 Tab + 来源卡（默认全选），945 条平铺勾选列表退役；新通道 = 整源参与（来源卡勾选）+ 在信号抽屉内按来源/平台排除单条信号（`excludeSignalIds`，仅本次生效）。信号抽屉的「忽略」仍是跨选题的全局动作，与「本次排除」语义分离。本文其余结论（删「送入选题」、文字按钮、来源库只读）不受影响。详见 [23 选题模块重设计分析](./23-topic-module-account-tabs-analysis.md)。

---

## 5. 待拍板的决策点

| # | 问题 | 建议 |
|---|---|---|
| A | 「启用/停用」保留还是也删？ | **保留**（用户级诉求「不想看某来源」），后端改窄 RPC |
| B | 来源卡/抽屉的「采集」保留吗？ | **保留**，是唯一剩下的用户级来源动作 |
| C | `importAiDailyReport` RPC 连根删（含测试改造）还是留 RPC 只删 UI？ | **连根删**（零兼容惯例；留 RPC = 留复活种子） |
| D | 删「送入选题」后信号卡动作行是否还需要主按钮？ | 不需要，四个文字按钮平级 |
| E | 空平台子卡点击行为 | 无动作（保留占位文案） |
| F | `SOURCE_KIND_OPTIONS` 常量 | 保留为内部校验白名单，仅不再对外暴露 |

## 6. 实施顺序（批准后）

1. 后端：content-store（S1-S4）→ gateway 删 RPC → adapters 不动；
2. 测试：按 3.4 改造，`npm run file:test` 绿；
3. 客户端：C1-C8 一次重构 → `npm run check`；
4. 回归：`npm run test` + `pack:profile-check`；重启工作台服务浏览器验收（命令条两按钮 / 抽屉文字动作 / 来源库只读卡）；
5. 文档：按 3.5 同步。

## 7. 关键位置索引（备忘）

| 关注点 | 文件:行 |
|---|---|
| 信号卡动作区（送入选题 + 单字方块） | `client.js:467-474` |
| `sendToTopics`（含 openPackMenu bug） | `client.js:620` |
| handoff 消费 | `client.js:972` |
| 来源卡动作（设置/删除） | `client.js:676-682` |
| 来源设置抽屉 + RSS 发现 | `client.js:743-777` |
| 三处导入入口 | `client.js:732`、`:677`、`:648` |
| 来源 CRUD RPC | `content-store.mjs:428-454`、`gateway.mjs:33-37` |
| `importAiDailyReport` | `content-store.mjs:496-513`、`gateway.mjs:41` |
| `SOURCE_KIND_OPTIONS`（保留，仅内部校验） | `adapters.mjs:22-34`、`content-store.mjs:133-137` |
