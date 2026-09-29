# 25 发布 / 入队模块设计与实施记录（发布包装 Agent + 封面生图 + 单一生命线抽屉）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> **⚠️ 已被 [26 发布模块简化](./26-publish-module-simplification.md) 大幅取代（2026-09-11）**：本文档记录的 `approval` / `queue` 两个阶段、人工批准闸门、投递目标入队、ZIP 发布包导出（`exportPublishPackage` / `readExport`）、`queuePackage`、`listPublishTasks` 与右栏「发布包装任务」面板均已连根删除；菜单由「发布 / 入队」改为「发布」。仍有效的部分：`packaging` 工件 schema 与校验、发布包装 Agent 与 `buildPublishPrompt`、封面生图链路（百炼异步轮询 / SciTiger、`inspectPublishImage`、冻结到 `media/publish-covers/`）、`uploadCover` / `readAsset` / `updatePackaging`、封面生图连接配置与凭据边界、DSH 轨迹落盘、重启恢复置 failed。阅读本文档时请以 26 号为现状基准。
>
> 状态：2026-09-10 实施完成，`npm run test` **201/201 全绿**（基线 181，含修复 2 项既有红测试 + 新增 20 项 publish 专属测试）。浏览器实机验收待用户执行（需重启工作台并重新「加载」能力包）。
> 依据：`spoken-video-publish.mjs` / `spoken-video-publish-host.mjs`（当晚并行会话写入的未接线后端）、`spoken-video-store.mjs`（packaging 阶段改动）、[24 写稿页 UI 重设计](./24-script-page-ui-redesign-analysis.md)（形态基准）、[14 全链路](./14-spoken-video-full-pipeline.md)。

## 0. 起点：后端写好一半、接线全断

接手时的状态（梳理确认见当日记忆）：

- `spoken-video-publish.mjs`（纯函数层）与 `spoken-video-publish-host.mjs`（发布主机，399 行）已写完但 **untracked**；`spoken-video-store.mjs` 已把状态机改为 10 阶段（新增 `packaging`，`approval` 前置从 `qc` 改为 `packaging`）但未提交。
- **index.mjs 未实例化 Host、gateway.mjs 未注册任何发布 RPC、client.js 发布页仍是旧版**——旧页面点「人工批准」会直接报 `SPOKEN_VIDEO_STAGE_BLOCKED`（approval 需要 packaging 前置），线上路径已断。
- 回归 181 项中 2 项红（store/media 测试未提交 packaging 就走 approval）。

结论：不是从零设计，而是**把已写好的后端接线、按 24 号文档的终态形态重做前端、修复回归、补测试**。

## 1. 后端设计（已存在部分的确认 + 本次补齐）

### 1.1 阶段机与工件（store，已改，本次确认）

- `STAGES`：`signals→topic→script→voiceover→subtitles→video→qc→packaging→approval→queue`。
- `packaging` 只能经 `commitProduced` 写入（手工 `commit` 报 `SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED`），与 video/qc 同级——发布资料是受控产物，不允许浏览器直接伪造。
- `publishPackaging` 校验：`mode ∈ {agent, manual-update, cover-upload}`、content（title≤80/copy≤2000/description≤1000/tags 1-10 个去 # 去重）、prompts（landscape/portrait 必填、negative 可选）、covers（landscape/portrait 各自可空，file 限 `media/publish-covers/`，mediaType 限 png/jpeg/webp，≤20MiB、≤8192px）、imageProvider、coverErrors（横竖独立记错）、generatedAt。
- `satisfied`：packaging 与 approval 都要求 `qc.passed === true`；`invalidateDownstream` 语义不变——packaging 重生成会失效 approval/queue，**批准永远绑定当前资料版本**。

### 1.2 发布主机（publish-host，已写 + 本次补 3 处）

既有能力：`status/configureConnection/clearConnectionCredential/listItems/startPackaging/task/updatePackaging/uploadCover/readAsset/queuePackage`；任务持久化在 `.lwb/spoken-video/publish-tasks.json`（0600，串行写，上限 240 条）；封面冻结到项目 `media/publish-covers/`（wx 独占创建 + symlink/越界防护）；上传封面失败时回滚已冻结文件；`queuePackage` = approval + queue 两段 commit（confirm 硬闸门 + revision 链）。

本次补齐：

1. **`listTasks(agent)`**：任务列表 RPC（此前只有单任务 `task`），前端列表级轮询需要。
2. **DSH 轨迹**：`#run` 调 packageExecutor 时传 `onDshStarted/onDshEvent`，经 `projectDshSessionEvent` 脱敏后落 `task.dsh`（复用 `spoken-video-dsh-trace.mjs`，与选题/写稿同款；`taskSummary` 带出 dsh）。
3. **重启恢复去重**：`listItems` 内联的中断恢复逻辑抽为 `#recoverInterrupted`，`listTasks` 复用——重启后 queued/running 且不在内存 active 集合的任务显式置 failed（补 `phase: 'failed'`）。

生图链路（已写，确认语义）：启用时横竖封面并行生成（`Promise.all`），**单侧失败只记 coverErrors 不失败整个任务**（资料仍可人工补封面）；百炼走异步任务轮询（`X-DashScope-Async`，PENDING→SUCCEEDED，FAILED/CANCELED 即败），15 分钟上限；下载后 `inspectPublishImage` 校验格式与尺寸再冻结。

### 1.3 装配与 RPC（index.mjs / gateway.mjs，本次新增）

- index.mjs：新增 `PUBLISH_CONNECTION_NS`（`lwb-spoken-video-publish`：enabled/provider/model），**与媒体连接设置分离**——关封面不影响 TTS/渲染配置。实例化 `SpokenVideoPublishHost`（packageExecutor = `createStructuredExecutor(ctx, subagents, 'spoken-video-publish')`，支持 `config.publishExecutor` 测试注入），provide `spokenVideoPublish`。
- gateway.mjs：inject 加 `spokenVideoPublish`；注册 11 个 RPC：`publishStatus / configurePublishConnection / clearPublishConnectionCredential`（remoteStatic，无 agent）+ `listPublishItems / listPublishTasks / startPackaging / publishTask / updatePackaging / uploadPublishCover / readPublishAsset / queuePackage`（agent 域）。命名规则：与 media 域 `mediaStatus/configureMediaConnection` 对仗，publish 前缀避免与未来平台直发概念混淆。

### 1.4 导出发布包升级（media-host，本次新增）

`exportPublishPackage` 此前只打包 MP4 + SRT + manifest。queue 前置 approval、approval 前置 packaging，**已入队项目必有 packaging 工件**，故导出直接整合：

- `publish-copy.txt`：标题/视频文案/描述/标签（`#tag` 形式）纯文本，人工粘贴到平台即用。
- 封面图：`cover-landscape.png / cover-portrait.jpg`（按冻结文件实际扩展名），缺失则跳过。
- manifest 升级 `schemaVersion: 2`：`files` 增加 publishCopy/coverLandscape/coverPortrait，新增 `packaging` 节（content/covers/mode/generatedAt）。

凭据边界：发布 bailian 复用 `DASHSCOPE_API_KEY`（与媒体同一把百炼钥匙，合理——同一账户），scitiger 用独立的 `LWB_SPOKEN_VIDEO_CLOUD_IMAGE_API_KEY`（云端生图与云端 TTS 是不同服务）。密钥只经 `credentials.resolve` 在请求头使用，任务文件、工件、日志、status 返回均不含密钥（测试断言覆盖）。

## 2. 前端设计（PublishQueuePageV3，按 24 号终态形态）

### 2.1 形态决策

- **对齐写稿页终态而非旧发布页**：左栏「可发布项目」（账号 Tab + 内联前 6 + 查看更多抽屉）/ 右栏「发布包装任务」（`sv-tp-task` 卡 + 列表级轮询）/ **单一「发布资料」宽抽屉承载完整生命线**。
- **不做双选中态**（24 号 §8 教训）：项目卡点击 = 打开抽屉，抽屉即工作台——AI 资料卡 → 可编辑表单 → 封面 → 批准闸门 → 入队 → 导出，一条线走完，无 benchId/adoptRef 类补丁。
- accent 红（`data-accent="red"`，模块色 `#ef4444` 与菜单 tone 一致），复用 `sv-tp-*` 任务套件与 `sv-sc-*` 抽屉骨架；发布专属类前缀 `sv-pb-*`（covers/cover/form/field/tags/tag/queue/export）。
- 旧 V1 `PublishQueuePage`（死代码）与 V2 一并删除；`STAGES/LABEL/PIPELINE/PIPELINE_TONES` 补 `packaging: '发布包装'`（流水线全景条随之显示 10 阶段）。

### 2.2 生命线抽屉（sv-drawer-wide 860px）

头部：标题 + 状态徽章（未包装 灰 / 待批准 橙 / 已批准·已入队 绿，复用 `sv-sc-state`）+ 未保存标记 + 账号/版本/文案字数 meta。

- **无 packaging**：空态 + 「生成发布包装」按钮（qc 未过禁用并提示）；任务运行中显示阶段步骤胶囊（生成发布资料 → 生成封面 → 就绪）。
- **有 packaging**：发布资料表单（标题/视频文案/视频描述/标签 chips 编辑器，回车添加、点 × 移除、≤10 个）→ 封面双卡（横 16:9 / 竖 9:16，预览 `readPublishAsset` 拉取的冻结图，AI 生成/人工上传来源标注，单侧生成失败显示错误并给「上传封面」兜底）→ DSH 轨迹（dshTraceBlock）→ 已入队时导出区。
- **粘性 footer 闸门**（与写稿页「确认稿件·进入配音」同构）：
  - packaged：`保存资料`（plain，dirty 时可用）+ `人工批准`（绿 `sv-sc-approve`，**dirty 或无标签时禁用**——先保存再批准，杜绝「批准的不是眼前这版」，24 号 §8.4 同款纪律）；
  - approved：投递目标输入 + `加入发布队列`（绿）；
  - queued：绿仪式条（目标 + 版本）；
  - 批准与入队都走 `useSvConfirm` 二次确认，文案写明后果；dirty 时关抽屉/切项目弹「放弃未保存的修改？」。
- **导出**：入队后抽屉内「生成发布包」→ `exportPublishPackage` + `readExport` → 「下载发布包（N MiB）」+ manifest 摘要（目标/文件清单）。

### 2.3 任务卡与轮询

- `listPublishTasks` 列表级轮询（anyRunning → 1.5s），任务卡显示账号、封面渠道（百炼/SciTiger/未启用）、阶段步骤胶囊、失败原因、封面单侧失败提示；动作 = 执行摘要（抽屉：状态/阶段/完成时间/coverErrors/DSH 轨迹）/ 查看发布资料（开生命线抽屉）/ 重试（failed 时，用 item 当前 revision 重发）。
- 切换页面不中断生成（host 内存 active + 任务文件持久化；重启中断显式 failed 可重试）。

### 2.4 封面生图配置抽屉

复用 `sv-media-config-drawer` 形态：启用开关 + 渠道二选一（百炼 BYOK / SciTiger 云端，显示各自凭据状态）+ API Key（password 输入，不回显）+ 模型名（可选覆盖）。入口 = 页头「⚙ 封面生图」。文案明确：**关闭后包装仍生成文案资料，只是不自动生成封面**。

### 2.5 数据流

- 项目列表：`listPublishItems`（host 侧组合：qc 通过的项目 + 最新任务摘要 + packaging/video/queue 状态），支持 `accountId/general/queueOnly` 过滤；前端按 `account.id` 归 Tab（active 账号 + 通用 + 归档只在抽屉可见，与写稿页 A1 决策一致）。
- 详情：`get`（useDetail），packaging 工件变更（revision 变化）触发编辑器重载；**封面预览按 `covers.*.file` 变化拉取**，编辑资料不会重拉封面。
- 批准/入队走通用 `commit` RPC（stage=approval/queue），保存资料走 `updatePackaging`（后端强制 mode=manual-update、保留 prompts/covers）。

## 3. 测试（新增 20 项，spoken-video-publish.test.mjs）

- 纯函数层 5 项：config 端点/凭据引用校验、prompt 绑定冻结上下文、normalize 截断/去重/去#/不完整拒绝、生图请求与异步任务解析、图片格式与尺寸防御。
- 主机层 13 项：闸门（qc 未过/版本冲突拒绝）、成功链路（工件不可变 + DSH 轨迹落盘 + listTasks 可见）、执行器缺失/输出不可用失败不提交、**运行中项目被并行修改 → REVISION_CONFLICT 取消不覆盖**、封面生成（单侧 429 只记错、异步轮询、冻结文件路径/尺寸/来源）、凭据缺失按方向报错且不泄漏、终态 FAILED 与网络不可达、重启恢复置 failed、listItems 账号/queueOnly 过滤、queuePackage confirm 闸门与前置、updatePackaging 只改 content、uploadCover 方向/格式/Base64 校验 + 冲突回滚不留孤儿文件、readAsset 白名单、连接配置私有性。
- 导出 1 项：ZIP 含 publish-copy.txt + 双封面 + manifest v2（unzip -l 实测）。
- 修复既有 2 项红测试：store/media 在 approval 前补 packaging `commitProduced`；media 导出用例同时升级断言（publishCopy/manifest.packaging/文案内容）。
- client.test 的 VideoPreviewPageV2 段边界从 `PublishQueuePageV2` 同步改为 `PublishQueuePageV3`。

## 4. 已知边界与遗留

- **浏览器实机验收未做**：需重启工作台（旧进程不含本次代码）并重新加载能力包。重点验收：红色 accent、包装任务实时轨迹（需真实跑一次包装）、封面生图（需配置百炼或 SciTiger 云端 Key）、上传封面、批准/入队二次确认、导出包内容。
- `queuePackage` RPC 已注册但前端批准/入队走的是通用 `commit`（语义等价、复用 useCommit 的刷新链）；`queuePackage` 保留为一次性双段提交的服务端入口，两者不冲突（幂等键不同但闸门一致）。
- 归档账号项目仅可在「查看更多」抽屉打开查看，不可作新建目标（与写稿页同款约束）。
- 队列消费端（publish-manager 直连）仍刻意不做——「永不直发」是权限边界，非未完成项。
- 生图轮询上限 15 分钟/侧，超时记 coverErrors，任务不失败。

## 5. 回归命令

`npm run test`（check + profile:check + pack:profile-check + file:test，201 项）。
