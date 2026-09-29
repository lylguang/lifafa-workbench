# 27 内容安排模块重设计分析（定时全自动流水线）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> 状态：**已实施并完成回归**（2026-09-15）。本文主体保留实施前分析与决策依据；实际落地见 §13。
> 前置依赖：**[26 发布模块简化](./26-publish-module-simplification.md)（状态机 10→8，删 approval/queue）已于同日由并行会话落地**（`npm run test` 202 全绿），本模块的实施前提已就绪——见 §10。
> 依据：`spoken-video-content-store.mjs`（现有 schedule 实现）、`spoken-video-media-host.mjs` / `spoken-video-publish-host.mjs`（各阶段 host 入口）、`spoken-video-store.mjs`（**8 阶段**状态机与闸门）、DSH `packages/core/agent`、`packages/subagent`、`packages/webhook`（无人值守建 agent 的官方先例）。

## 0. 一句话结论

内容安排从「定时采集信号」升级为「定时跑完信号→发布资料的自动化流水线」。**不需要新写任何生产能力**——六个阶段都已有可编程 host 入口和持久化任务记录，本模块的本质是**一个编排器 + 一套任务配置 UI + 一份运行审计**。真正的工程量在三处：无人值守时的执行身份、调度循环不能被长任务卡死、以及人工闸门如何被自动化明示授权。

## 1. 需求（用户描述 → 结构化）

| # | 需求 | 落地形态 |
|---|---|---|
| R1 | 区分不同账号，像其他模块那样 | 账号 Tab（`sv-tp-tabs`），任务归属一个账号或「通用」；Tab 决定新建表单上下文与右侧任务过滤 |
| R2 | 输入任务名称 | `name`，≤120 字 |
| R3 | 周一到周日多选 + 选择几点执行 | `days: [1..7]`（ISO 周一=1）+ `time: 'HH:MM'`；UI 给「每天/工作日」快捷 chip 与整点 chip |
| R4 | 信号选择和选题一样的 UI 效果 | **完全复用选题页的渠道卡组**：公开来源卡默认全选 + AI 日报按平台子卡 + 点渠道名开抽屉看信号并排除单条 |
| R5 | 右侧是定时任务 | `sv-tp-task` 卡列表，运行中置顶 + 实时阶段胶囊 + 1.5s 轮询 |
| R6 | 弹窗查看任务生成的视频，及每条视频从信号到发布的详细信息 | 宽抽屉（`sv-drawer-wide`）：运行历史 → 本轮视频列表 → 单条生命线 |
| R7 | 整体风格与其他模块保持一致 | `PackFrame` + `HeroMini` + accent + `useSvConfirm` + 既有类套件 |

隐含需求（用户未说但必须定，已在 §8 决策）：自动化跑到哪一步停、每轮出几条、错过时刻怎么办、无人值守用什么身份执行。

## 2. 现状核对（代码事实）

### 2.1 页面

`ContentSchedulePage`（client.js **2276-2300，仅 25 行**）是全包唯一没做过重设计的页面，仍用旧视觉（`sv-form` / `sv-item` / `sv-checks`），且拥有两处**孤立 CSS**：`.sv-sched-card`（client.js:137）与 `.sv-flow` 一族（client.js:16 内联 + 138-141 覆写）——后者全包只在 2286 行这一处使用，删页面即可连带删除。

> 行号基准：2026-09-11 并行会话完成发布简化后（client.js 3557 行注册表：`publish: PublishPageV4`）。开工前需重新核对，见 §11 并行开发风险。

### 2.2 数据模型

`.lwb/spoken-video/schedules.json`，`SCHEDULE_SCHEMA = 2`（content-store:52）：

```js
schedules: [{ id, name, enabled, time: 'HH:MM', sourceIds: [], createdAt, updatedAt, lastRunAt }]
runs:      [{ id, scheduleId, status: 'completed'|'partial'|'failed', triggeredAt, message, pipeline: [10 个中文标签], sourceRunIds: [] }]  // 上限 100
```

**缺失**：账号维度、周几、任何生产参数、编辑、删除。本机当前**该文件不存在**（从未创建过安排）。

`scheduleFile()`（content-store:333）在读盘时强校验：`sourceIds` 为空或含未知来源直接抛错——这意味着**信号来源被删除会让整个 schedules.json 读不出来**（V2EX 移除时的 schema 9 迁移就是为了清这个，见 docs/13 变更说明）。新模型必须沿用同样的清理纪律。

### 2.3 执行

```js
// content-store:1265
async executeSchedule(workspace, schedule, reason) {
  const runs = await this.collectWorkspace(workspace, schedule.sourceIds, reason)
  // …写一条 run 记录，message = 「已完成 N 个信号来源的采集，等待选题阶段消费。」
}
```

只做采集。run 里的 `pipeline` 数组是**纯装饰文本**（前端渲染成 `sv-flow` 小标签，client.js:2286），不驱动任何阶段。

> 顺带发现一处发布简化的遗漏：content-store:1267 写死的 `pipeline` 数组仍是 **10 阶段旧标签**（含「发布包装/人工批准/入队」），而 client.js 的 `PIPELINE` 常量已同步为 8 阶段（含「发布资料」）。前端有 `run.pipeline.length ? run.pipeline : PIPELINE` 兜底，所以旧 run 记录会显示过时标签。本模块重设计会把这个字段连根删除（换成 §6 的 `items[].stages`），不需要单独修。

### 2.4 调度循环（两个必须修的缺陷）

```js
// content-store:555
function scheduleDue(schedule, clock = new Date()) {
  return schedule.enabled
    && localMinute(clock).endsWith(schedule.time)                       // 本地分钟后缀匹配
    && (!schedule.lastRunAt || localMinute(schedule.lastRunAt) !== localMinute(clock))
}

// content-store:1291-1302
async tick() {
  for (const candidate of index.workspaces) {
    // 1) 采集到期来源：await this.collectWorkspace(...)
    // 2) 到期安排：for (const schedule of …) if (scheduleDue(schedule)) await this.executeSchedule(...)
  }
}
startScheduler() { setInterval(tick, 30_000) }   // index.mjs:174 由 ctx.effect 托管
```

- **缺陷 A（串行阻塞）**：`await executeSchedule` 在 tick 内串行。现状采集几秒就结束所以没暴露；换成 20 分钟的流水线后，**一条任务会卡死所有 workspace 的整个调度循环**（包括来源采集）。
- **缺陷 B（重复启动）**：`lastRunAt` 在 `executeSchedule` **结束时**才写。30s tick 在同一分钟内会命中两次 `scheduleDue`（`lastRunAt` 仍是上一轮的），现状靠「采集很快」侥幸不重复。长流水线必然重复启动。
  → 新设计必须**先原子写 `lastRunAt` + 落 `status:'running'` 的 run 记录，再启动流水线**。

### 2.5 docs/14 §3.7 的原始边界

> 调度继续只负责信号采集，不扩展到生产侧；生产节奏由人按项目驱动。若后续要"日更流水线"，再加生产编排，这是完整可用之后的事。

本需求正是这条被推迟的扩展。P0~P5 全部已完成，「完整可用之后」的条件已满足，S8 需同步撤销该边界表述。

本需求正是这条被推迟的扩展。P0~P5 全部已完成，「完整可用之后」的条件已满足，文档需同步撤销该边界。

## 3. 好消息：六个阶段全部已有可编程入口

编排器只需**按序调用 + 轮询**，不需要新写任何生产能力：

| 阶段 | host 入口 | 完成后的自动落库 | 轮询方式 |
|---|---|---|---|
| 采集 + 选题 | `content.startTopicGeneration(agent, input)` | **自带补采当天缺失渠道**（`prepareLatestTopicMaterial`，content-store:1004）；完成后**自动把推荐候选 `candidate[0]` 建项目并加入待写稿**（content-store:1109，`source:'recommended'`） | `topicGenerationStatus` / `listGenerations` |
| 写稿 | `content.startScriptGeneration(agent, input)` | 完成即自动 `commit(stage:'script')`（content-store:1165+），并存质检报告 | `scriptGenerationStatus` / `listScriptGenerations` |
| 确认稿件 | `projects.approveScript(agent, {projectId})` | 写 `project.scriptApproval{approvedAt,revision}` | 同步返回 |
| 配音 | `media.startVoiceover(agent, req)` | 成功 `commitProduced(stage:'voiceover')`（media-host:1949） | `operations(agent,{projectId})` |
| 字幕 | `media.startSubtitles(agent, req)` | 成功 `commitProduced(stage:'subtitles')`（media-host:1999） | 同上 |
| 成片 + 质检 | `media.startVideoRender(agent, req)` | 成功时**一次提交 video + qc**（media-host:2171/2189），含 ffprobe 技术门禁 + 主画面变化检测 + 独立 DSH 审片 | 同上（run.pipeline.phase 有细分阶段） |
| 发布资料 | `publish.startPackaging(agent, req)` | 成功 `commitProduced(stage:'packaging')`（publish-host:339），含文案标签 + 横竖封面 | `publish.task`（**注意 26 号简化已删 `listTasks`**，单任务轮询用 `task`） |

**推论 1**：独立的「采集」步骤是冗余的——选题启动时已经会补采当天缺失的渠道。新流水线起点直接是选题，`sourceIds` 语义与选题页完全一致（含 `platforms` AI 日报平台粒度、`excludeSignalIds`）。这也让「信号选择复用选题 UI」不只是视觉复用，而是**输入契约复用**。

**推论 2**：`executeSchedule` 现有的 `collectWorkspace` 调用可以整段删除。

**推论 3**：run 记录里那个装饰用的 `pipeline` 数组必须换成**真实阶段状态**，否则「弹窗看详细信息」无数据可展示。

## 4. 硬约束一：无人值守时手里没有 agent

### 4.1 问题

所有 host 方法首参都是 `agent`，工作区从 `agent.session.header.cwd` 解析（store:73、content-store:86、media-host、publish-host 四处各有一份同构实现）。AI 步骤还要 `subagents.start('spawn', { parent: agent, … })`，**parent 必须是活的 Agent 对象**（subagent-in-process-driver:108 → `parent.ctx.agents.create(...)`）。

定时 tick 手里只有一个 workspace 路径字符串（来自 `lwb/local/spoken-video-schedule-workspaces.json`）。

### 4.2 解法：造一个「执行身份」根 agent

DSH 官方在 webhook 场景有完全同构的先例（`packages/webhook/webhook/src/session.ts:118-186`），headless bundle 亦然（`bundle/headless/src/index.ts:177`）。照搬其形状：

```js
const selection = ctx.agentDefaultModel.currentSelection()
const preset = await ctx.agentPresets.resolve('standard')
const handle = await ctx.agents.create({
  sessionId: SessionId(sessionIdFor(schedule)),
  meta: { cwd: workspace, agentPreset: preset.id },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id) },
  signal,                                    // 绑定 pack 卸载 / 用户取消
})
// …用 handle.agent 作为 parent 跑完整条流水线…
await handle.dispose()                       // finally 里必须执行
```

要点：

- **`agents.create` 不要求 initiator 作用域**。`requireInitiator()` 只在 `agent-loop/src/tool-calls.ts` 用到；webhook 就是从非 agent 上下文直接创建的。所以从 `setInterval` 回调里建 agent 是合法路径。
- **必须挂 `standard` preset**。子代理的工具面来自父 agent 的 scoped ctx（`applyChildComposition`）。不挂 preset 的话视觉导演可能拿不到文件工具，写不了 `CreativeVideo.tsx`——今天手工渲染能用是因为父 agent 是用户会话（已挂 standard）。挂上之后自动化与手工路径的能力面完全一致。
- **权限不需要为自动化放开任何东西**。`captureDelegatedPolicyOverrides`（subagent/child-agent.ts:235-240）把子代理的 `approvalPolicy` 固定改写为 `'never'`、沙箱沿用父级 workspace-write。也就是说**今天手工点「生成视频」时视觉导演就已经是免审批 + workspace-write**，自动化只是换了个发起方，边界一寸未动。这是本方案能成立的关键前提。
- **inject 要加三个服务**：`agents`、`agentDefaultModel`（均在 `@deepseek-ai/dsh-base`）、`agentPresets`（在 `dsh-web-app`，LWB profile 已加载）。Cordis 只暴露 inject 里声明的服务，必须显式加。
- `dispose()` 是幂等的（`disposing ??=`），且 `signal` abort 会自动触发 teardown。pack 卸载（`ctx.effect` 回收）会 abort signal → 流水线中断 → run 记录靠重启恢复逻辑置 failed。

### 4.3 会话记录归属（D5，待确认）

`agents.create` 产生的 session 是**根会话**，会出现在侧边栏会话列表里（`origin` 未标 `subagent`；标了反而会被 `api/session-controller` 拒绝直接寻址，见 history.ts:243）。

| 方案 | 侧边栏 | 代价 |
|---|---|---|
| **A. 每条定时任务复用一条执行身份会话（推荐）** | 每条任务只多 1 条，且可点开看自动化全过程 | sessionId 固定为 `sv-auto-${schedule.id}`；首次 `create`，之后 `resume`；`resume` 失败（日志被删）则回退 `create` 新 id。根 agent 从不 `followup`，日志几乎不增长 |
| B. 每轮新建、跑完 dispose | 每轮多 1 条，日更一年 = 365 条 | 实现最简单，无 resume 分支 |

推荐 A：既是观感问题，也让「这轮自动化到底干了什么」有一个可回溯的会话入口（run 记录里存 `sessionId`，抽屉可跳过去看完整轨迹）。

## 5. 硬约束二：人工闸门如何被自动化明示授权

### 5.1 发布简化后只剩两道闸门

26 号发布简化已落地，状态机现为 **8 阶段**（`signals→topic→script→voiceover→subtitles→video→qc→packaging`），`approval`/`queue` 已连根删除。闸门随之收敛为两道：

| 闸门 | 后端是否强校验 | 说明 |
|---|---|---|
| `approve_draft`（确认稿件） | **否** | `satisfied()`（store:537）只查 `REQUIRED_POINTERS` 与 packaging 的 qc.passed，**不校验 `scriptApproval`**。目前只有前端在拦：配音页过滤 `project.scriptApproval?.current`（client.js:2463）。后端 `approveScript`（store:800）是个独立 RPC，编排器可直接调 |
| `packaging` 前置 qc 通过 | 是 | `satisfied()`：`qc.passed === true`，错误文案已改为「质检未通过，不能生成发布资料。」 |

**关键简化**：发布简化后，`packaging` 就是状态机终点（26 号决策 B「有 packaging 工件即已就绪」）。这意味着**自动化的终点 `depth=packaging` 天然等于「可发布」**，不再需要伪造 approval、也不存在「停在 packaging 还是 approval」的歧义——这正是 D2「先落地发布简化再做内容安排」的价值兑现。

### 5.2 决策：自动化深度 = 明示授权（D1 已拍板）

任务表单给「自动化深度」四档，**档位本身即授权范围**，不另设开关：

| 深度 | 跑到哪 | 是否自动确认稿件 | 停下时的状态 |
|---|---|---|---|
| `topic` | 选题 + 建项目 + 加入待写稿 | — | 待写稿，人去写稿页 |
| `script` | + AI 写稿 + 自动存版本 + 质检报告 | **否** | 稿件已存未确认，人去写稿页确认 |
| `video` | + 配音 + 字幕 + 渲染 + 技术质检 + 独立审片 | **是** | 成片就绪（qc 通过），人去视频页预览 |
| `packaging` | + 发布资料（标题/文案/描述/标签 + 横竖封面） | **是** | **资料就绪 = 可发布**，人去发布页核对 |

- 选 `video` / `packaging` 时，表单上显示橙色警示条：**「将自动确认 AI 稿件，不再人工过稿」**，保存时二次确认（`useSvConfirm`）复述这句。
- 想保留人工把关就选 `script` 档——跑完停在稿件，人确认后可在写稿页手工继续。
- 自动确认 = 编排器调 `approveScript(agent, { projectId })`，工件与人工确认完全同构（`scriptApproval.revision` 绑定当前稿件版本，后续稿件更新自动失效）。审计上无法区分人/机确认——**建议给 `approveScript` 加一个 `source: 'automation'|'manual'` 入参并写进 `scriptApproval`**，让「这条稿是机器确认的」可追溯。这是一处小的后端增强，值得做。

### 5.3 发布动作永不进自动化

`packaging` 是状态机终点，也是自动化终点。发布简化后「资料齐 = 可发布」，人在发布页（`PublishPageV4`）核对后自行复制到平台。**队列消费端（publish-manager 直连）依然刻意不做**——「永不直发」是权限边界，不是未完成项（[26 发布简化](./26-publish-module-simplification.md)）。注意：26 号删除的是 `approval`/`queue` 两个**状态机阶段**，「永不直发」这条**产品边界**依然成立，自动化不得越界。

## 6. 数据模型：`schedules.json` schemaVersion 3

按**零兼容原则**（2026-09-02 拍板）：废弃字段连根删除，不写迁移函数，本机该文件当前不存在，无存量数据负担。

```js
{
  schemaVersion: 3,
  schedules: [{
    id, name,                     // name ≤120
    enabled,
    accountId,                    // uuid | null（null = 通用，无账号定位）
    days: [1..7],                 // ISO 周一=1 … 周日=7，1~7 个，去重排序
    time: 'HH:MM',
    angle,                        // 选题角度，选填 ≤500，与选题页同契约
    sources: {
      sourceIds: [],              // 公开来源 + 'ai-daily-import'，≤20（SOURCE_LIMIT）
      platforms: [],              // AI 日报平台粒度，≤12（PLATFORM_LIMIT）
      excludeSignalIds: [],       // 长期排除，≤300（EXCLUDE_LIMIT）
    },
    depth: 'topic'|'script'|'video'|'packaging',
    perRunLimit: 1..3,            // 每轮最多几条视频
    production: {
      orientation: 'portrait'|'landscape',
      subtitleEnabled: true,
      scriptTier: 'short'|'medium'|'long',
      voice: { provider, voiceSource, voiceId, voiceName, rate, volume } | null,  // null = 用默认音色
      visualBrief,                // 选填，画面制作说明 ≤6000；空则用 DEFAULT_VIDEO_VISUAL_BRIEF
    },
    createdAt, updatedAt,
    lastRunAt,                    // 启动时即写，防重复触发（修 §2.4 缺陷 B）
  }],
  runs: [{                        // 上限 100（沿用现状）
    id, scheduleId,
    status: 'running'|'completed'|'partial'|'failed'|'missed'|'cancelled',
    trigger: 'automatic'|'manual',
    triggeredAt, completedAt, elapsedMs,
    sessionId,                    // 执行身份会话，供抽屉跳转看轨迹
    depth,                        // 冻结本轮的深度（schedule 后续被编辑不影响历史）
    stage,                        // 当前/终止阶段：collect|topic|script|voiceover|subtitles|video|qc|packaging
    message, error,
    refs: { topicGenerationId, scriptGenerationIds: [], mediaRunIds: [], publishTaskIds: [] },
    items: [{                     // 本轮产出的每条视频
      projectId, title,
      status: 'completed'|'failed'|'stopped',
      reachedStage,               // 走到哪一步
      signalCount, scriptChars, scriptRevision,
      videoTaskId, durationSeconds, orientation, qcPassed,
      packagingTaskId, coverState: 'both'|'partial'|'none'|'disabled',
      error,
      stages: [{ stage, status, startedAt, completedAt, refId, message }],   // 生命线数据源
    }],
  }],
}
```

设计要点：

- **`sources` 与选题页输入契约同构**，直接喂给 `startTopicGeneration`，不需要转换层。
- **`depth` 冻结进 run**：schedule 被编辑后历史 run 仍能正确解释「当时为什么停在这」。
- **`items[].stages` 是抽屉生命线的唯一数据源**，替代现状那个装饰用的 `pipeline` 数组。
- **`refs` 存各阶段任务 id**，抽屉可跳到选题执行摘要 / 写稿任务 / 媒体 run / 发布任务，不需要重复存轨迹（各模块已有自己的 DSH trace 落盘）。
- **读盘清理纪律**：沿用 `scheduleFile(value, validSources)` 模式，但要放宽——来源被删不应让整份文件读不出来，而是从 `sources.sourceIds` 里剔除并标记；账号被硬删除（`deleteAccount`）应把 `accountId` 置 null 或把任务停用，不能抛错。这是现状的一个真实脆弱点，趁重设计一起修。

## 7. 编排器设计

### 7.1 模块边界

`spoken-video-content-store.mjs` 已 1303 行，不该再塞。**把 schedule 整块从 content-store 连根移出**：

| 移到新文件 | 内容 |
|---|---|
| `spoken-video-schedule.mjs`（纯函数层，可单测） | `daysOf` / `scheduleDue` / `validDays` / `nextRunAt` / 深度→阶段序列映射 / run 与 item 的状态归约 / 文件 schema 校验 |
| `spoken-video-schedule-host.mjs`（host 层） | 文件读写、执行身份 agent 生命周期、阶段编排、tick、重启恢复 |

content-store 的 `tick()` **只保留来源采集**（`due` 判定 + `collectWorkspace`）。边界干净：content-store = 信号域，schedule-host = 编排域。

要移出的现有代码：`SCHEDULE_SCHEMA`、`migrateScheduleFile`、`scheduleFile`、`readScheduleFile`、`emptyScheduleFile`、`validTime`、`scheduleDue`、`listSchedules`、`createSchedule`、`setScheduleEnabled`、`executeSchedule`、`runSchedule`，以及 `tick()` 里的 schedule 分支。

### 7.2 一轮流水线的执行序

```
startRun(schedule, trigger)
  ├─ 原子写：lastRunAt = now，run 记录 status='running'        ← 必须在启动前，修缺陷 B
  ├─ 建执行身份 agent（create / resume）
  ├─ 阶段 1 选题：startTopicGeneration({ accountId, angle, ...sources })
  │            轮询 topicGenerationStatus 直到 completed/failed
  │            取 record.candidates 里 selection.state==='selected' 的项目（推荐候选已自动建项目）
  │            → 得到 items[0..perRunLimit-1]；选题失败 = 整轮 failed，直接结束
  └─ for each item（串行，不并行）:
       ├─ depth ≥ script    : startScriptGeneration({ projectId, mode:'draft', tier, instructions:angle })
       │                      轮询 → 失败则 item.status='failed'，continue 下一条
       ├─ depth ≥ video     : approveScript({ projectId, source:'automation' })   ← 闸门，见 §5.2
       │                      startVoiceover → 轮询 operations
       │                      startSubtitles（subtitleEnabled 时）→ 轮询
       │                      startVideoRender → 轮询（run.pipeline.phase 有细分：directing/preflight/rendering/technical-qc/editorial-review/committing）
       │                      成功即含 qc；失败则 item.status='failed'，continue
       └─ depth ≥ packaging : startPackaging → 轮询 publish.task
                              单侧封面失败只记 coverState='partial'，item 仍算 completed（publish-host 既有语义）
  ├─ 归约整轮 status：全成 completed / 有成有败 partial / 全败 failed
  ├─ 写 completedAt / elapsedMs / message
  └─ finally: handle.dispose()
```

关键纪律：

- **轮内 items 串行**。Remotion 渲染吃满 CPU，并行会互相拖慢且难排错。
- **单条 item 失败不中断整轮**（记 failed 后继续下一条），整轮记 `partial`。与 publish-host「单侧封面失败不失败任务」的既有容错哲学一致。
- **每阶段有超时**：选题/写稿/发布资料各 15 分钟，配音 10 分钟，字幕 10 分钟，渲染 40 分钟（Remotion 内部上限 30 分钟 + 余量）。超时 = 该 item failed，不杀底层任务（底层有自己的记录）。
- **阶段间重读项目 revision**。每个 host 入口都要 `expectedRevision`，编排器必须在上一步完成后重新 `get()` 取最新 revision，不能沿用旧值（否则必然 `REVISION_CONFLICT`）。
- **取消**：`cancelScheduleRun` = abort 执行身份的 signal → 流水线在下一个 await 点抛出 → run 记 `cancelled`。底层已启动的任务不被杀（它们有自己的持久记录与恢复逻辑），只是不再往下推进。

### 7.3 tick 改造（修缺陷 A）

```js
// 到期判定：加 days
function scheduleDue(schedule, clock) {
  return schedule.enabled
    && schedule.days.includes(isoWeekday(clock))          // ((getDay()+6)%7)+1
    && localMinute(clock).endsWith(schedule.time)
    && localMinute(schedule.lastRunAt) !== localMinute(clock)
}

// tick 内：fire-and-forget + 在飞保护
for (const schedule of data.schedules) {
  if (!scheduleDue(schedule, now)) continue
  const key = `${workspace}\u0000${schedule.id}`
  if (this.automationRuns.has(key)) continue
  void this.startRun(workspace, schedule, 'automatic')    // 不 await！
}
```

`startRun` 第一件事就是在串行队列里写 `lastRunAt` + run 记录并把自己加入 `automationRuns`，`finally` 里移除。这样 30s tick 的第二次命中会被 `lastRunAt` 同分钟判定和在飞集合双重挡住。

**workspace 级并发**：同一 workspace 同时只允许一条 automation run（`automationRuns` 按 workspace 计数）。理由是资源可预测性——两条任务同时渲染会把机器打死。不同 workspace 之间可以并行。

### 7.4 错过执行（D4 已拍板：不补跑，只记 missed）

内容有时效性，昨天的信号今天出片意义不大。实现：

- **只在服务启动后第一次 tick** 做 missed 检查（挂在现有 `recoverInterruptedTopicGenerations` 同一位置），避免每 30s 重复记录。
- 判定：`enabled && days 含今天 && 今天 time 已过 && lastRunAt 不在今天` → 追加一条 `status:'missed'` 的 run，message 写明「主机在该时刻未运行，已跳过；可在任务卡上手动执行」。
- 用户自己决定要不要点「立即执行」。

### 7.5 重启恢复

沿用 publish-host `#recoverInterrupted`（publish-host:268）的成熟模式：进程重启后，把 `status:'running'` 但不在内存 `automationRuns` 集合里的 run 显式置 `failed`，message「主机在流水线完成前已重启」。

**不试图接管子任务**——选题/写稿/媒体/发布各有自己的持久记录与恢复逻辑（`recoverInterruptedTopicGenerations`、`#recoverInterruptedRuns`、`#recoverInterruptedAudioTasks`、`#recoverInterrupted`）。编排 run 只标记自身失败；抽屉里能看到各阶段任务的真实终态。

## 8. 决策记录（2026-09-11 拍板）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 稿件闸门怎么过 | **深度选项明示授权**。四档深度（选题/写稿/成片+质检/发布资料），选后两档时 UI 明示「将自动确认 AI 稿件，不再人工过稿」，保存时二次确认。不另设独立开关 |
| D2 | 与发布简化的顺序 | **先落地发布简化（10→8，删 approval/queue），再做内容安排**。✅ **已由并行会话于 2026-09-11 落地**（26 号文档，202 项测试全绿），前提就绪。自动化终点天然就是 packaging，两模块语义一致，不返工 |
| D3 | 详情容器 | **宽抽屉**（`sv-drawer-wide`），沿用写稿页/发布页的生命线形态，不引入 modal |
| D4 | 错过执行时刻 | **不补跑，只记 missed 日志**。抽屉可见，人自行决定手动执行 |
| D5 | 执行身份会话归属 | **待确认**，推荐「每条定时任务复用一条会话」（§4.3 方案 A）：侧边栏每任务只多 1 条，且可点开看自动化全过程 |
| D6 | accent 色 | **待定**，推荐新增 `sky`（`#0ea5e9`，与 `MODULE_CONTEXT['内容安排']` 一致）。现有 accent：orange 选题 / violet 写稿 / pink 配音 / red 发布；blue 会撞信号页 `#3b82f6`。菜单 tone 仍填 `blue`（tone 白名单只有 blue/green/orange/pink/red/violet）。注意 26 号已把发布菜单改名为「发布」/`publish` |

## 9. 前端设计

### 9.1 页面形态（对齐选题页，不对齐旧内容安排页）

```
PackFrame(title:'内容安排', accent:'sky', hero)
├─ HeroMini 4 格：启用中任务 / 下次执行 / 本轮产出 / 最近结果
├─ 账号 Tab（sv-tp-tabs，含「通用」Tab）
├─ sv-layout 左右分栏
│  ├─ 左「新建自动化任务」（sv-form）
│  │   ├─ 任务名称
│  │   ├─ 执行日：周一~周日 chip 多选 + 「每天」「工作日」快捷
│  │   ├─ 执行时刻：整点 chip + time input（允许 21:30）
│  │   ├─ 选题角度（选填，同选题页）
│  │   ├─ 参与渠道（默认全选）：公开来源卡 sv-tp-srcgrid + AI 日报平台子卡
│  │   │   └─ 点渠道名 → 信号抽屉（看今日新增/更早、排除单条）← 需从选题页抽出复用
│  │   ├─ 自动化深度：四档 chip（video/packaging 档下方显示橙色警示条）
│  │   ├─ 每轮最多 N 条 + 横竖屏 + 篇幅档 + 音色（可折叠「高级」）
│  │   └─ 保存任务（useSvConfirm 二次确认，深度 ≥video 时复述自动确认稿件）
│  └─ 右「定时任务」
│      ├─ 运行中置顶组（sv-tp-task + sv-tp-steps 实时阶段胶囊，1.5s 轮询）
│      └─ 任务卡组：启用/停用徽章、账号、执行日时刻、深度、最近结果
│          动作 = 运行详情 / 立即执行 / 编辑 / 停用·启用 / 删除
└─ 运行详情宽抽屉（sv-drawer-wide 860px）
    ├─ 运行历史（左列 chip 或顶部横向）
    ├─ 本轮概览：耗时、阶段、子代理会话数、产出条数、错误
    ├─ 视频条目列表：封面缩略 + 标题 + 一行摘要（信号 N → 稿件 N 字 → 成片 Ns · 质检 · 资料）+ 状态徽章
    │   └─ 点「生命线」展开单条：信号 → 选题 → 稿件 → 配音字幕 → 成片 → 质检 → 发布资料
    │       每段带 refId 与「跳到该模块」按钮（openPackMenu）
    └─ 粘性 footer：停止本轮（运行中）/ 重试失败阶段 / 打开执行会话
```

### 9.2 复用与新增

**直接复用**：`PackFrame`（含 `accent` prop）、`HeroMini`、`sv-tp-tabs` / `sv-tp-tab` / `sv-tp-tab-dot`、`sv-tp-srcgrid` / `sv-tp-src` / `sv-tp-src-check`、`sv-tp-task` 全族、`sv-tp-steps` / `sv-tp-step`、`sv-tp-exclbar`、`sv-drawer` / `sv-drawer-wide` / `sv-drawer-head` / `sv-drawer-list` / `sv-tp-drawer-foot`、`sv-sc-state`（状态徽章，加 tone）、`useSvConfirm`、`relativeTime` / `formatTime`、`openPackMenu`。

**需要抽出复用**：选题页的信号抽屉（drawer kind `'signals'`）目前是 TopicsPage 内部 state + 渲染逻辑，内容安排页要复用必须**抽成独立组件**（如 `SourceSignalsDrawer`）。这是一项实打实的重构工作量，不是复制粘贴。

**新增类**（前缀 `sv-as-*`，automation schedule）：`sv-as-days` / `sv-as-day`（周几 chip）、`sv-as-hours` / `sv-as-hour`（整点 chip）、`sv-as-depth` / `sv-as-depth-opt`（深度档）、`sv-as-warn`（自动确认警示条）、`sv-as-run`（运行历史项）、`sv-as-item` / `sv-as-thumb`（视频条目）、`sv-as-life` / `sv-as-life-stage`（生命线）、`sv-as-adv`（高级设置折叠）。

**删除**：`.sv-sched-card`（孤立类）、`.sv-flow` 一族（client.js:16 内联 + 138-141 覆写，全包仅旧内容安排页 2286 行使用）、旧 `ContentSchedulePage` 整段、run 里装饰用的 `pipeline` 字段渲染。

### 9.3 RPC（gateway 新增/改造）

| RPC | 说明 |
|---|---|
| `listSchedules` | 返回 `{ schedules, runs }`，runs 带 limit/分页 |
| `createSchedule` | 改造：接受 §6 全字段 |
| `updateSchedule` | **新增**（现状无编辑，只能删了重建） |
| `deleteSchedule` | **新增** |
| `setScheduleEnabled` | 保留 |
| `runSchedule` | 保留语义（立即执行一次），改为 fire-and-forget 返回 runId |
| `cancelScheduleRun` | **新增**（停止本轮） |
| `scheduleRun` | **新增**：单轮详情（含 items 生命线），抽屉数据源 |
| `scheduleRuntimeStatus` | **新增**，remoteStatic：媒体连接是否就绪、Remotion 是否可用、生图是否启用 |

`scheduleRuntimeStatus` 的价值：depth=video 但 TTS 凭据没配、或 Remotion 不可用时，**保存任务时就该警告**，而不是等到半夜跑失败。数据来自现成的 `media.status()`（`renderers.remotion`、`providers.*.credential`）与 `publish.status()`（生图 enabled）。

## 10. 实施顺序

**S0（发布模块简化）已由并行会话于 2026-09-11 落地**（[26 号文档](./26-publish-module-simplification.md)，`npm run test` 202 全绿）：状态机已改 8 阶段、`approval`/`queue`/`queuePackage`/`exportPublishPackage`/`readExport`/`listPublishTasks` 已删、新增 `regenerateCover`、发布页已是 `PublishPageV4`。**本模块的前提已就绪，从 S1 起步。**

| 步 | 内容 | 依赖 |
|---|---|---|
| ~~S0~~ | ~~发布模块简化落地~~ | ✅ 已完成（26 号） |
| S1 | schedule 整块从 content-store 移出到 `spoken-video-schedule.mjs` + `spoken-video-schedule-host.mjs`；schemaVersion 3；补 `updateSchedule`/`deleteSchedule` | — |
| S2 | 执行身份 agent（inject 加 `agents`/`agentDefaultModel`/`agentPresets`；create/resume/dispose；signal 绑定 pack 卸载）。**先做最小验证**，见 §11 第一条风险 | S1 |
| S3 | tick 改造（fire-and-forget + 在飞保护 + days 判定 + 启动前写 lastRunAt）+ missed 检查 + 重启恢复 | S1 |
| S4 | 编排器（阶段序列 + 轮询 + 超时 + items 串行 + partial 归约 + 取消） | S2 S3 |
| S5 | `approveScript` 加 `source` 入参（审计区分人/机确认） | — |
| S6 | 前端：抽 `SourceSignalsDrawer` → 重做 `ContentSchedulePage` → 运行详情抽屉；删 `.sv-sched-card` 与 `.sv-flow` 一族 | S1（RPC 形状） |
| S7 | 测试 `spoken-video-schedule.test.mjs`（纯函数层：days/due/nextRunAt/深度序列/归约；host 层：闸门、超时、partial、重启恢复、取消、清理纪律）+ 同步 client.test 页面段边界 | S4 S6 |
| S8 | 文档：docs/12 菜单描述、docs/14 §3.7 撤销「不扩展到生产侧」、docs/README 索引、`lwb-pack.json` 的 `content-schedule` 菜单项与 workflow 字段 | S7 |

回归命令：`npm run test`（check + profile:check + pack:profile-check + file:test，**当前基线 202 项**）。注意 `npm run check` 里逐个列了 `node --check <file>`，**新增两个 .mjs 必须加进 check 脚本**（`package.json` 的 `check` 字段）。

**并行开发纪律**：本次梳理过程中，并行会话正在改 `spoken-video-store.mjs`/`client.js`/`gateway.mjs`/`publish-host`（发布简化），已造成行号漂移与 docs/26 编号冲突（本文档因此从 26 让位到 27）。S1 开工前必须重读这几个文件确认最新状态，`Edit` 会因外部修改而失效。

## 11. 风险与开放问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 执行身份 agent 是**新接缝**，包此前从未在 host 侧建过 agent | 建不起来则整个模块不成立 | **S2 单独做一个最小验证**：先只跑 depth=topic 一档，确认 `agents.create` + `agentPresets.mount('standard')` + `subagents.start({parent})` 在 setInterval 回调里能走通，再往下做 |
| `agentPresets` 只在 `dsh-web-app` bundle，不在 `dsh-base` | 若将来 profile 换基座，inject 会失败 | inject 缺失时降级为不挂 preset 并明确报错「当前运行环境不提供 agent 预设服务，无法执行自动化」，不要静默跑出残废流水线 |
| 一轮 = 5 个 DSH 子代理会话 + TTS + ASR + 可能生图，Remotion 渲染上限 30 分钟 | 6 个账号日更是很大开销 | `perRunLimit` 默认 1、轮内串行、workspace 级单飞、深度可选。UI 上明示预估耗时 |
| 无人值守时失败没人看见 | 静默失败比失败更糟 | run 记录 + HeroMini「最近结果」+ 任务卡失败摘要 + missed 记录。抽屉里每阶段有 message |
| 自动化与人工同时操作同一项目 | `REVISION_CONFLICT` | 每阶段前重读 revision；冲突则该 item failed 并记录，不重试覆盖人工成果 |
| 定时任务在**别的 workspace** 也会跑（schedulerIndex 现有 2 个 workspace） | 意外在非本项目目录建 agent、写数据 | 保持现状语义（per-workspace 数据隔离），但要确认执行身份的 `meta.cwd` 用的是该 workspace 而非 `process.cwd()` |
| 侧边栏多出执行身份会话（D5） | 观感 | 方案 A 每任务只多 1 条；名字用 `sessionTitle.rename` 设为「自动化 · <任务名>」，一眼可辨 |

## 12. 验收标准

在一台只装了 LWB 的本机上：

1. 能为某账号建一条「周一~周五 21:00、竖屏、深度到发布资料、每轮 1 条」的任务，保存时看到自动确认稿件的明示警示；
2. 到点后无人值守自动跑完：补采当天渠道 → 选题 → 建项目 → AI 写稿 → 自动确认 → 配音 → 字幕 → 渲染 → 技术质检 + 独立审片 → 发布资料（含横竖封面）；
3. 运行详情抽屉能看到本轮那条视频的完整生命线，每段可跳到对应模块页；
4. 任一步失败时整轮记 `partial`、该条记 `failed` 并写明原因，其余条继续；
5. 关掉电脑错过 21:00，第二天开机能在抽屉里看到一条 `missed` 记录，并可手动「立即执行」；
6. 运行中点「停止本轮」，run 记 `cancelled`，已完成的阶段产物保留；
7. 主机重启后，中断的 run 显式 `failed`，不出现永久 running；
8. 自动化全程**不产生任何平台发布动作**，终点是 packaging；
9. `npm run test` 全绿。

关联文档：[12 场景能力包](./12-capability-packs.md)、[14 全链路推进](./14-spoken-video-full-pipeline.md)、[17 选题模块](./17-topic-module-analysis.md)、[23 选题账号 Tab 化](./23-topic-module-account-tabs-analysis.md)、[24 写稿页 UI 重设计](./24-script-page-ui-redesign-analysis.md)、[25 发布模块](./25-publish-module-analysis.md)。

## 13. 实施记录（2026-09-15）

- S1-S8 已落地：schema 3 纯逻辑层与主机编排器、独立执行身份、非阻塞 tick、工作区单飞、missed/取消/重启恢复、完整阶段编排、自动确认来源审计、内容安排页面与 RPC、测试和文档均已接入。
- D5 采用每条安排复用固定会话 `sv-auto-<scheduleId>`；D6 采用 `sky` accent。页面支持运行历史、条目生命线、阶段跳转和运行时依赖预检。
- 重启恢复允许记录超过 24 小时的真实 `elapsedMs`，避免恢复后记录在下一次读取时被 schema 丢弃。
- 项目状态机重新落实 `approve_draft` 后端硬闸门：未确认稿件及改稿后失效的确认均不能进入配音；内容安排的成片/发布资料深度先以 `source: 'automation'` 确认，再进入媒体阶段。
- 自动化边界保持不变：最深只生成 `packaging` 发布资料，不执行平台发布。
- 完整回归 `npm test`：240/240 通过（含宿主与能力包 profile、ffmpeg/ffprobe 媒体链路、Remotion 创作和独立审片测试）。
