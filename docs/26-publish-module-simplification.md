# 26 发布模块简化：视频货架 + 单一发布资料抽屉（连根删除批准/入队/导出）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> 状态：2026-09-11 实施完成，`npm run test` **202/202 全绿**（25 号文档基线 201：删 3 项、新增 4 项，详见 §5）。浏览器实机验收待用户执行（需重启工作台并重新「加载」能力包）。
> 前置：[25 发布 / 入队模块设计](./25-publish-module-analysis.md)。本文档记录**用户拍板的形态反转**——25 号建成的「包装任务面板 + 批准闸门 + 入队 + ZIP 导出」四段流程被判定过度设计，改为「看视频 → 一键生成/编辑发布资料」。

## 1. 用户判断与决策

用户的原话要点：模块做得复杂了。在账号底下直接展示上一模块生成的视频，可点击播放；下方一个「发布」按钮；点开抽屉，无发布信息则自动触发一次生成，有则展示详情并可「重新生成发布信息」。视频不需要点各种按钮切换状态——**已经有标题、描述、标签、封面等信息的，即认为可发布**。不需要「生成发布包」功能。封面在配置了生图的前提下可重生：能看之前的提示词、能改提示词后重生图、能触发重写提示词重生图、也能不用生图自己上传。

八个决策点（A-H）全部拍板，A/B/D/F 经显式选择，C/E/G/H 按建议默认：

| 编号 | 决策 | 结果 |
|---|---|---|
| A | 提示词重生图粒度 | **A1 两动作**：「重新生成发布信息」= 整体重跑 agent（文案+提示词+封面全新，二次确认明示覆盖手改内容）；「按此提示词生图」= 只重跑单方向生图，不动文案。不做「AI 只重写提示词」的轻量 agent |
| B | 可发布判定 | **有 packaging 工件即已就绪**（标题/文案/描述/标签齐全）；封面缺失只在卡片提示，不阻塞 |
| C | 列表范围 | 只显示 `qc.passed === true` 的成片（host 侧过滤，未过质检留在视频预览页） |
| D | 视频加载 | 卡片默认显示封面图（无封面显示规格占位），**点播放按钮才拉视频字节** |
| E | 自动触发失败 | 抽屉内显示错误 +「重试生成」按钮，不静默重试 |
| F | 存量数据 | 唯一走到 queue 的项目降级到 packaging（删 approval/queue 指针，保留资料与封面），不整体重置 |
| G | 保存方式 | 保留手动「保存」按钮（dirty 时可用），避免逐字 commit 刷 revision |
| H | 列表分页 | 简单分页每页 8，删「查看更多」抽屉 |

## 2. 删除清单（零兼容原则，连根删）

- **状态机 10→8 阶段**：`STAGES` 去掉 `approval`、`queue`；`REQUIRED_POINTERS` 删两项；`stageData` 删 approval/queue 手工分支；`satisfied` 只保留 packaging 的 qc 闸门（错误文案改为「质检未通过，不能生成发布资料。」）。
- **RPC 删 4 个**：`queuePackage`、`exportPublishPackage`、`readExport`、`listPublishTasks`（gateway 方法与 `decorateRemote` 同步删除）。
- **media-host 删 50 行**：`exportPublishPackage`（ZIP 打包、`publish-copy.txt`、manifest schemaVersion 2、双封面归档）与 `readExport` 整体移除；`mediaPath`/`#writeAt`/`extname`/`execFileAsync` 仍被其他媒体路径使用，保留。
- **publish-host 删 `queuePackage` 与 `listTasks`**：右栏任务面板消失后无列表级消费者；抽屉进度改由 `listItems` 返回的 task 摘要 + 单任务 `publishTask` 提供。`task()` 内联 `#recoverInterrupted`，重启后查询单任务同样能拿到显式 failed。
- **前端删整块**：右栏「发布包装任务」面板、任务卡、执行摘要抽屉、查看更多抽屉（含筛选 chips 与搜索）、粘性 footer 的批准/投递目标/入队/导出四段、`sv-pb-queue*`/`sv-pb-export*` CSS。
- **概念改名**：`packaging` 标签由「发布包装」改「发布资料」；菜单 `publish-queue`/「发布 / 入队」改 `publish`/「发布」；页面组件 `PublishQueuePageV3` → `PublishPageV4`；`lwb-pack.json` workflow 由 10 项缩为 8 项，tags 去「人工批准」加「发布资料」。
- **补漏：调度运行记录的 pipeline 标签**：`spoken-video-content-store.mjs` 的 `executeSchedule` 写 run 记录时硬编码了一份 10 阶段中文标签数组（含「发布包装 / 人工批准 / 入队」），前端 `run.pipeline.length ? run.pipeline : PIPELINE` 会优先用它，导致新的调度运行记录展示已不存在的阶段。已同步为 8 阶段（`… 质检 / 发布资料`）。此遗漏由并行会话（[27 内容安排模块分析](./27-content-schedule-module-analysis.md) §4）发现并指出；27 号的重设计会把该字段整体替换为 `items[].stages`，本次先修正标签避免中间态出现错误信息。

## 3. 新增能力

### 3.1 按自定义提示词单方向重生封面（决策 A1 的第二动作）

- host 新增 `regenerateCover(agent, { projectId, expectedRevision, kind, prompt, negativePrompt })`：走任务化（复用 `#generateCover` 与任务文件），因为生图可能耗时数分钟，阻塞式 RPC 会卡住浏览器。
- 前置校验：生图连接必须 `enabled`（否则 `SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE`，引导去「⚙ 封面生图」）、revision 一致、qc 通过、packaging 已存在。
- `#runCover` 提交前重新读项目，把**用户改后的提示词与新冻结封面写进同一个 packaging revision**，`mode: 'cover-regenerate'`（store 白名单新增此 mode），`prompts[kind]` 与 `prompts.negative` 同步更新；另一方向的提示词与封面原样保留，文案字段完全不动。失败只落 `coverErrors[kind]`，不提交任何工件。
- gateway 注册 `regeneratePublishCover`。

### 3.2 提示词可查看可编辑

- `updatePackaging` 新增可选 `prompts` 入参（`promptsInput` 校验：横竖必填 ≤3000、negative 可选 ≤1000，缺省沿用现值），保存时随文案一起落库。
- 抽屉封面双卡内各嵌一个提示词 textarea + 共用的负面提示词 textarea；`dirty` 判定扩展为「文案或提示词任一与工件不符」。
- 「按此提示词生图」在 dirty 时**先 `updatePackaging` 提交再生图**（与写稿页「润色自动先保存」同款纪律），保证生图用的是眼前这版提示词。

### 3.3 视频货架与懒加载播放

- `listItems` 每项补 `orientation`（取自 video 工件），供卡片显示「竖屏 9:16 / 横屏 16:9」并决定优先展示哪一侧封面；过滤条件收紧为 `qc.passed === true`（决策 C）；不再返回 `approved`/`queued`/`destination`。
- 新增 `PublishVideoThumb`：默认渲染封面图（`readPublishAsset(kind)` 按方向优先）或规格占位，点圆形播放按钮才调 `readPublishAsset(kind:'video')` 取字节并切到 `<video controls autoPlay>`；`item.video.file` 变化时重置。抽屉顶部复用同一组件，实现「在这个模块就是直击观看所有生成的视频」。
- 卡片信息层级：缩略图 → 标题 + 状态徽章 → 账号 · 视频规格 → 封面就绪情况 · 标签数 · 相对时间 → 「发布」按钮；生成失败的卡片直接内联错误条。
- 徽章四态：`未生成`（灰）/ `生成中`（橙）/ `生成失败`（橙）/ `已就绪`（绿）——`publishStateOf` 不再读 approval/queue，只看 packaging 工件与最新任务状态。

### 3.4 自动触发一次生成（决策 E）

- 打开抽屉且无 packaging 时自动 `startPackaging`，用 `autoTriggered` ref 按 `projectId:revision` 去重，**同一版本只自动触发一次**；失败后不循环重试，改为空态里显示错误 +「重试生成」。
- 轮询只在「当前打开的项目有 queued/running 任务」时启动（1.5s），刷新 items + detail + projects；不再有页面级 anyRunning 轮询。

## 4. 前端形态

单栏：`PackFrame`（accent 红、hero 四格：可发布成片 / 发布资料就绪 / 待生成 / 封面生图渠道）→ 账号 Tab（active 账号 + 通用 + 已归档计数徽标）→ `sv-pb-shelf` 自适应网格（`minmax(300px,1fr)`，每页 8）→ 分页条（复用 `sv-audio-pagebar`）。已归档账号项目排在最后一页尾部、仅供查看。

抽屉（`sv-drawer-wide` 860px，唯一生命线）：成片播放区 → 发布资料表单（标题/文案/描述/标签 chips）→ 封面双卡（预览 + 提示词编辑 + 按提示词生图 + 上传替换）→ 负面提示词 → 最近一次生成（状态/时间/生图渠道 + `dshTraceBlock`）。粘性 footer 仅两键：「重新生成发布信息」（plain，二次确认）+「保存」（primary，dirty 且有标签时可用）。dirty 时关抽屉弹「放弃未保存的修改？」。

新增 CSS：`sv-pb-shelf` / `sv-pb-card` / `sv-pb-thumb`（含 `sv-pb-play` 圆形播放键、`sv-pb-thumb-empty` 占位）/ `sv-pb-card-head|title|meta|foot` / `sv-pb-prompt`；沿用 25 号的 `sv-pb-covers|cover|form|field|tags|tag` 与 `sv-sc-*`、`sv-tp-*` 套件。

## 5. 测试（202 项）

- 删除：`queuePackage enforces the confirm gate...`、`the exported bundle carries the packaged copy...`（media 侧同名导出测试与 `zipAvailable` 一并删）。
- 改写：store 主流程测试改为「packaging 即终态」，断言 `completedStages` 恰好 8 项；workspace 边界测试改断言 approval/queue 现为 `SPOKEN_VIDEO_INVALID_INPUT`（阶段名不存在）；media 侧 approval 提交断言同步改为 `INVALID_INPUT`；`listItems` 测试改为「视频货架」语义（packaging 存在即就绪、不含 approval/queue、未过 qc 的项目不上架）；重启恢复测试改用 `task()` 查询。
- 新增：`a project that never reached QC stays off the publish shelf`；`regenerateCover reuses a hand-edited prompt for one direction and keeps the copy intact`（含未启用生图/无 packaging/方向非法三种拒绝、只请求单方向尺寸 `1280*720`、文案与另一方向封面保持原样、revision 冲突拒绝）；`regenerateCover failure lands in coverErrors and leaves the artifact untouched`。
- 新增前端契约测试 `publish page is a flat video shelf with one lifecycle drawer and no release gates`：断言无 `sv-split`/moreDrawer/summaryDrawer、有 `sv-pb-shelf` 与分页、视频懒加载走 `readPublishAsset(kind:'video')`、自动触发用 `autoTriggered`、按提示词生图 RPC 参数正确且 dirty 时先保存、并显式反证「人工批准/加入发布队列/生成发布包/下载发布包/`stage:'approval'`/`stage:'queue'`/`exportPublishPackage`/`readExport`/`queuePackage`/`listPublishTasks`/`destination`」均不出现。
- 既有前端契约测试中 `VideoPreviewPageV2` 的段边界由 `PublishQueuePageV3` 改为 `const PUBLISH_STATE_LABEL`。
- `package.json` 的 `check` 脚本补上此前遗漏的 `spoken-video-publish.mjs` 与 `spoken-video-publish-host.mjs` 语法检查（25 号实施时的遗漏）。

## 6. 存量数据处理

`.lwb/spoken-video/projects/48466fb1…/project.json`：`stage` 由 `queue` 改为 `packaging`，`artifacts` 删除 `approval`、`queue` 两个指针（revision 不动，history/receipts 保留审计痕迹）。packaging 工件与 `media/publish-covers/` 下的封面原样保留，该项目在新页面直接以「已就绪」出现。其余 14 个项目无 packaging，不受影响。

## 7. 已知边界与遗留

- **浏览器实机验收未做**：需重启工作台（旧进程加载的是旧代码快照）并重新「加载」能力包，`lwb/local/packs.json` 里的菜单快照才会刷新为「发布」。重点验收：卡片播放（首次点击拉字节的延迟）、自动触发生成、按提示词生图（需配置百炼或 SciTiger Key）、上传封面、重新生成发布信息的覆盖确认、分页与已归档项目展示。
- 队列消费端（publish-manager 直连）依旧刻意不做——「永不直发」是权限边界。但本次连**入队这一层审计记录也一并删除了**：发布与否不再留痕在项目状态机里，只有 packaging 工件的 `generatedAt` 与任务文件历史。若日后需要「哪些视频已经发过」的台账，需要重新设计（建议独立于生产状态机的发布记录文件）。
- `queuePackage` 删除后，`commit` RPC 对 approval/queue 会返回 `SPOKEN_VIDEO_INVALID_INPUT`（阶段名无效），无兼容层。
- 生图轮询上限仍为 15 分钟/侧；单方向重生任务同样受此约束，超时落 `coverErrors`。
- 归档账号项目在最后一页尾部只读展示，不可作任何新建目标（与写稿页同款约束）。

## 8. 回归命令

`npm run test`（check + profile:check + pack:profile-check + file:test，202 项）。

## 9. 规模与并行开发记录

可测量的净变化（对比 25 号实施完成时的工作区状态，非 git HEAD——HEAD 早于发布模块，diff 会混入前一日的增量）：

| 文件 | 变化 |
|---|---|
| client.js 发布页组件 | 486 → 406 行（**净减 80 行**）；同时新增了视频货架卡片与懒加载播放组件，即功能面变宽而代码变少 |
| spoken-video-media-host.mjs | **净减 50 行**（`exportPublishPackage` + `readExport` 整体移除） |
| spoken-video-publish-host.mjs | 447 → 509 行（**净增 62 行**）；删 `queuePackage`/`listTasks` 约 18 行，增 `regenerateCover`/`#runCover`/`promptsInput` 约 80 行 |
| gateway.mjs | RPC 数 11 → 8（删 `queuePackage`/`exportPublishPackage`/`readExport`/`listPublishTasks`，增 `regeneratePublishCover`） |
| spoken-video-store.mjs | 状态机 10 → 8 阶段；删 approval/queue 的前置表、payload 分支与闸门，mode 白名单增 `cover-regenerate` |
| 测试 | publish 20 → 21 项（删 2：queuePackage 闸门、ZIP 导出；增 3：未过 qc 不上架、按提示词单方向重生、重生失败不落工件）；client 5 → 6 项（增发布页契约测试）；全套件 201 → 202 |

**并行会话（2026-09-11 同日）**：本次实施期间另一会话在写 [27 内容安排模块分析](./27-content-schedule-module-analysis.md)，该文档以 26 号为前置依赖（其 D2 决策明确「先落地发布简化再做内容安排」），并引用了 store/publish-host 的具体行号。§2 的 content-store pipeline 标签补漏即由其发现。两边改动无文件冲突（27 号本轮只写文档）；若 27 号进入实施会重写 `executeSchedule` 与 schedules schema，届时本次的标签修正会随该字段一起被替换，属预期。注意 27 号引用的行号可能因本次后续编辑而漂移。
