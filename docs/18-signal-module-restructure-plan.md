# 18 信号模块调整方案：双链路分治（无兼容版）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> 状态：**2026-09-02 已实施**。前置分析见 [16 信号模块梳理分析](./16-signal-module-analysis.md)。
> **修订（11:09）**：用户拍板——系统处于初步开发阶段，**不保留任何兼容性代码**，manual、平台情报等废弃概念连根删除，不做幂等修复、不做 UI 隐藏。
> **实施记录（12:00 后）**：净删全部完成（见第 6 节）；本地数据重置后触发全量采集，AI 日报 5 平台（抖音27 / B站22 / 公众号37 / 小红书40 / 视频号12）与远程报告一致；`npm run test`、`profile:check`、`pack:profile-check` 全绿；工作台服务已用新代码重启（端口 3080）。

## 0. 设计原则

1. **双链路分治**：公开热榜（自动采集）与 AI 内容日报（报告导入）是两条完全独立的信号链路，任何视图、分组、入口不得混排。抖音、B站双链路都有数据，但各归各链路成卡，不合并。
2. **单一口径**：对外只讲「自动采集 16 个公开来源 + AI 内容日报覆盖 5 个平台」。「平台情报 7」退役。
3. **零兼容**：系统早期，废弃概念（manual / 人工录入 / 平台情报 / passiveSource / ai-daily-import kind）直接从代码、数据、测试中删除，不留隐藏残留、不写迁移修复函数。本地存量测试数据一次性重置。V2EX 因运行环境持续不可达而移除时例外：schema 9 迁移会清理仍在使用中的工作区配置及其内容安排引用。

## 1. 目标信息架构

```text
信号页
├─ Hero（指挥中心）
│    动作只留三个：[采集 N 个来源] [导入 AI 日报] [来源管理]
├─ 信号板（默认视图）
│    ├─ 链路 A · 公开信号（按 family 分组）
│    │    公共热点 / 内容平台 / 科技与商业 / 开发者社区 / AI · 开源
│    └─ 链路 B · AI 内容日报（独立大分区）
│         分区头：来源状态 + 最近导入时间 + 「覆盖 5 个平台 · 每 60 分钟自动拉取」
│         平台子卡 ×5 全量渲染：抖音 / B站 / 公众号 / 小红书 / 视频号
│         无数据平台显示占位卡「今日暂无数据」
└─ 来源管理（二级视图，两个子 Tab）
     ├─ 来源库：18 个来源（17 自动采集 + ai-daily-import 报告导入，全部是普通来源卡）
     └─ 采集记录
```

## 2. 逐项调整

### 2.1 彻底删除清单（零兼容）

| # | 删除对象 | 位置 |
|---|---|---|
| R1 | `manual` 内置来源定义 | `adapters.mjs:120-122`（DEFAULT_SIGNAL_SOURCES） |
| R2 | `manual` / `ai-daily-import` kind 选项 | `adapters.mjs:46-47`（SOURCE_KIND_OPTIONS） |
| R3 | `PLATFORM_CONNECTOR_CATALOG` 目录 | `adapters.mjs:23-31` |
| R4 | `connectorCatalog` RPC | `content-store.mjs:407`、`gateway.mjs:30/:54` |
| R5 | `captureSignal` RPC（连 RPC 一起删，不只删入口） | `content-store.mjs`、`gateway.mjs:41/:65`、`client.js:225-233` |
| R6 | `passiveSource(kind)` 概念 | `content-store.mjs:102/:333/:375` 等；manual 删除后 ai-daily-json 是正常自动来源，"被动来源"概念整体消亡。`due()`、`sourceUrl()`、调度页过滤随之简化 |
| R7 | `deriveMissingPlatform` 的 ai-daily tags 启发式 | `content-store.mjs:169-173`；platform 在导入时已直接写入，启发式是迁移期产物。保留 `platformForSource`（内置平台来源仍需要） |
| R7b | `upgradeDailyImportSource` / `needsDailyImportRepair` | `content-store.mjs:154-168`；二者只为旧 `ai-daily-import` kind 迁移服务，数据重置后无存在意义，直接删除 |
| R8 | 客户端 manual / 平台情报全部渲染与状态分支 | `client.js:21/:29/:182/:211-215/:277/:287/:327/:360-388/:409/:414-422/:454` |
| R9 | `FAMILY_ORDER` 中「人工与导入」 | `client.js:29` |
| R10 | 文档中「平台情报 / 7 平台 / 人工录入」表述 | `docs/12:48`、`docs/13` 相关小节、`docs/16` 标记已由本方案实施 |

### 2.2 信号板

| # | 调整 | 说明 |
|---|---|---|
| B1 | 链路 A 分组卡 | 删 manual 后 `boardSources` 即全部自动来源（含 ai-daily-import 本体？否——见 B2） |
| B2 | ai-daily-import 不进链路 A 分组 | 维持现有 `client.js:274` 的过滤逻辑（有平台子卡时不重复出父卡），它只在链路 B 出现 |
| B3 | 链路 B 固定 5 平台 | 新增常量 `AI_DAILY_PLATFORMS = ['抖音','B站','公众号','小红书','视频号']`（adapters）；`buildBoard` 的 `aiDaily.platforms` 改为**按常量全量输出**：有数据填数据，无数据输出占位（`todayCount:0`、`totalCount:0`、`freshness:'none'`） |
| B4 | 分区文案 | 「AI 内容日报 · 报告导入 · 覆盖 5 个平台 · 每 60 分钟自动拉取」，手动粘贴导入作为分区头次级入口保留 |
| B5 | hero 动作 | 删「录入信号」，保留 [采集全部] [导入 AI 日报] [来源管理] |

### 2.3 来源管理

| # | 调整 | 说明 |
|---|---|---|
| A1 | 删「平台情报」子 Tab | Tab 降为 [来源库] [采集记录] |
| A2 | ai-daily-import 变成普通来源卡 | passive 概念删除后，它在来源库中与其他来源一致：显示 URL、间隔、采集按钮、启用/停用；描述行标注「覆盖：抖音 / B站 / 公众号 / 小红书 / 视频号」 |
| A3 | 手动粘贴导入入口 | 收敛到两处：信号板链路 B 分区头、来源库该来源卡的动作区（复用同一 `ai-daily` 抽屉） |

### 2.4 后端数据

| # | 调整 | 说明 |
|---|---|---|
| D1 | `maxItems: 50 → 200` | `adapters.mjs:124`；覆盖 5 平台全量（当前报告约 158 条） |
| D2 | 不写迁移修复函数 | 存量 `maxItems=50` 不靠代码修复，靠 D3 重置解决 |
| D3 | 重置本地数据 | 实施时把 `.lwb/spoken-video/signals.json` 移为 `.bak`（一次性文件备份，非代码兼容），由系统按新默认重建，随后「采集全部」恢复数据 |
| D4 | 孤儿信号防御 | `signalFile` 对"引用不存在来源"的信号由抛错改为静默丢弃（1 行，防残余数据炸库，不是兼容逻辑） |
| D5 | `importAiDailyReport` 保留 | 手动粘贴兜底入口，写入同一 `ai-daily-import` 来源 |

### 2.5 测试

| # | 调整 | 说明 |
|---|---|---|
| T1 | `captureSignal` 夹具替换 | 7 处引用（`test:44/100/119/151/169/213` 等）改用 `importAiDailyReport` 喂最小报告 JSON 播种 |
| T2 | 删平台情报断言 | `test:85` |
| T3 | 新增用例 | ① maxItems=200 时 5 平台全量入库；② `board().aiDaily.platforms` 恒为 5 项（无数据平台为占位）；③ 孤儿信号被丢弃不抛错 |

## 3. 明确不做的事

- 不保留 `manual` 数据、不做 UI 隐藏式降级；
- 不保留 `captureSignal` RPC；
- 不写 `upgradeDailyImportSource` 式的幂等修复（该函数本身只服务旧 kind 迁移，随 schema 简化一并评估删除）；
- 不升 schema 版本号、不写 v8→v9 迁移（直接重置本地文件）；
- 不给「平台情报」留任何转世形态。

## 4. 实施顺序

1. **后端**：adapters（R1-R3、D1、AI_DAILY_PLATFORMS）→ content-store（R4-R7、D2-D4、B3）→ gateway（R4/R5）
2. **测试**：T1-T3，`npm run file:test` 通过
3. **数据**：备份并重置本地 `signals.json`（D3）
4. **客户端**：R8-R9、B1-B5、A1-A3 一次重构 `SignalsPage` → `npm run check`
5. **回归**：`npm run test` + `pack:profile-check`；启动后「采集全部」，截图验收信号板双链路 / 来源管理两 Tab / 无废弃入口残留
6. **文档**：R10

## 5. 改动文件清单

| 文件 | 改动 |
|---|---|
| `spoken-video-signal-adapters.mjs` | R1/R2/R3；D1；新增 `AI_DAILY_PLATFORMS` |
| `spoken-video-content-store.mjs` | R4-R7；B3（board 全量平台）；D4 |
| `gateway.mjs` | 删 `connectorCatalog` / `captureSignal` 两个 RPC |
| `client.js` | R8/R9；B1-B5；A1-A3 |
| `test/spoken-video-content-store.test.mjs` | T1-T3 |
| `.lwb/spoken-video/signals.json` | 重置（备份为 .bak） |
| `docs/12、13、16` | R10 口径同步 |
