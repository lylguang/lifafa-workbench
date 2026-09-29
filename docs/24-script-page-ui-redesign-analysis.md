# 24 写稿模块 UI 重设计分析（对齐选题页：账号 Tab + 选题选择器抽屉 + 任务卡 + 稿件工作台）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> 状态：2026-09-06 分析设计完成 → 同日按推荐决策点（A1/B1/C1/D1/F1；E 按修正版落地，见 §7.1）实施完毕，`npm run test` **129/129 全绿**（127→+2），详见 §7 实施记录。浏览器实机验收待用户执行（工作台需重启并重新「加载」能力包）。
> 依据：`lwb/packs/spoken-video/client.js` 现状代码（TopicsPage 1007-1304 / ScriptPage 1316-1497 / sv-tp-* CSS 311-398）、`gateway.mjs`、`spoken-video-content-store.mjs`、`spoken-video-store.mjs`、`spoken-video-script.mjs`、本地真实数据（`.lwb/spoken-video/`）、[19 写稿模块分析](./19-script-module-analysis.md)、[23 选题模块重设计](./23-topic-module-account-tabs-analysis.md)。
>
> 用户设想：写稿页与选题模块保持一致——左侧任务配置、右侧写稿任务；按账号分 Tab（含「通用(无账号定位)」Tab）；每个账号下选择篇幅、输入额外要求（可选）、选择可写稿选题；可写稿选题要美观展示，且随使用会越来越多，考虑展示前 20 个 +「查看更多」抽屉（查看、筛选更多选题）。

## 0. 总判断

**方向成立**：写稿页是目前唯一停留在选题页 v2 改造之前旧形态的页面（旧 `sv-layout` 两栏、旧 `sv-item` 列表、旧 `sv-step/sv-dot` 步骤、无 Tab、无抽屉），把它对齐到选题页已验证的「左配置右任务 + 账号 Tab + 抽屉体系」是正确且低风险的——所有 UI 模式在选题页都有现成实现可复用。四点需要修正或补充后采纳：

1. **内联 20 条收缩为 6 条左右**（见 2.3）：左栏还要放篇幅、额外要求、生成模式与提交按钮，20 张卡约 1400px 高会把提交按钮顶出两屏外，配置卡失去「一屏完成配置」的意义；其余全量进「查看更多」抽屉（带搜索 + 状态筛选）。
2. **提案遗漏了「编辑器」的归属**（见 2.5）：写稿比选题重——AI 出稿后还有人工编辑、质检、保存、approve_draft 闸门。抽屉适合「看稿」，不适合「写长文」。在两栏下方增加全宽「稿件工作台」承载编辑器 + 质检 + 确认。
3. **有一个后端缺口**（见 3.1）：现有 `list` RPC 只返回项目摘要，无 angle、账号快照、信号数、稿件状态，前端拿不到按账号分组与美观卡片所需数据，逐项目 `get` 是 N+1。需新增 `listWritableTopics` 批量 RPC。
4. **写稿 executor 未接 DSH 事件流**（见 3.2）：`runScriptGeneration`（content-store.mjs:775-811）调用 executor 时没传 `onDshStarted/onDshEvent`（对照选题侧 703-709），写稿记录里没有 `dsh` 字段，前端无法展示与选题页同款的 DSH 实时轨迹。顺手补上。

## 1. 现状盘点

### 1.1 页面结构（client.js:1316-1497 ScriptPage）

- 旧 `sv-layout` 两栏（`minmax(0,1.35fr) minmax(270px,.85fr)`）：
  - 左栏：「可写稿选题」`sv-item` 纵列（每行仅标题 + 状态 tag + StageDots + 「版本 N」）→ 选中项目后的写稿表单（h3 标题、meta、账号 select + 绑定/更换按钮、信号依据 details 折叠、30000 字 textarea、字数统计、「质检 / 保存口播稿 / 确认稿件」三按钮）→ 质检报告卡 `qualityPanel`；
  - 右栏：AI 起稿面板 `genPanel`（四态机：待启动表单 / running 旧式步骤纵列 / completed details 折叠执行过程 + 180px 滚动预览 / failed）→「最近生成记录」`sv-item` 列表（最多 5 条，跨项目混排）。
- 可写稿选题来源：`projects.filter((p) => p.completedStages.includes('topic'))`（1318），无专用 RPC。
- 状态管理：`genId/gen` 单任务轮询（1.5s `scriptGenerationStatus`），首次进入吸附最近 30 分钟 running/completed 记录（1343-1357）。

### 1.2 与选题页（标杆）的差距清单

| 选题页已有 | 写稿页现状 |
|---|---|
| 账号 Tab（`sv-tp-tabs`，含通用 tab、默认账号角标、per-tab 表单草稿 `formsByTab`） | 无 Tab；账号只是一个 select |
| 新式任务卡 `sv-tp-task`（状态色边框 + 步骤胶囊 `sv-tp-step` + 已确认绿框 `sv-tp-confirmed`） | 旧 `sv-item` 行 + 旧 `sv-step/sv-dot` 纵列 |
| 抽屉体系（执行摘要 / 候选 / 信号，粘性 footer `sv-tp-drawer-foot`） | 无抽屉；执行过程塞 details 折叠 |
| DSH 实时事件流 `dshTraceBlock`（1305+） | 无（后端未接，见 3.2） |
| 候选卡 `sv-tp-cand`（radio + 推荐徽章 + meta/core/why 三层文案） | 选题行信息密度极低；稿件预览只有纯文本 |
| 列表级轮询（anyRunning → 整列表刷新） | 单 genId 轮询 + 首次吸附逻辑 |
| `useSvConfirm` 二次确认（466-487） | 「确认稿件」「更换账号并重置下游产物」都是裸按钮 |
| 空态 CTA `sv-empty-cta` | 空态一行字 |

另：CSS 已存在未使用的 `.sv-approval-ritual`（112-113，红调仪式卡），本次可用于确认闸门区。

### 1.3 后端接缝与数据

| 事实 | 对本次重设计的意义 |
|---|---|
| `list` 返回 projectSummary（title/stage/revision/completedStages/scriptApproval.current/updatedAt） | 无 angle、账号快照、信号数、稿件字数 → 需新 RPC |
| topic 工件 data：`{title, angle, account:账号快照{id,name,revision,positioning,…}, source}`（store.mjs:222-227） | 账号分组 key = `account.id`；null → 通用组 |
| signals 工件 data：`{items[]}` | 信号数 = items.length |
| script 工件 data：`{body≤30000}`；`scriptApproval={approvedAt,revision}` 绑定 revision，稿件再 commit 自动失效（store.mjs:382-394, 569-589） | 稿件三态：未写稿 / 待确认（有稿未批）/ 已确认（current=true） |
| `listScriptGenerations` 返回完整记录数组（startedAt 倒序，最多留 40 条），记录含 projectId/projectTitle/mode/tier/instructions/account/steps/draft/quality/elapsedMs | 任务卡与两个抽屉的数据**全部现成**，只缺 `dsh` 字段 |
| `startScriptGeneration` 入参 `{projectId, mode, tier, instructions?}`；前置校验：项目必须已有 topic 工件、polish 必须已有保存稿（content-store.mjs:749-773） | 左栏表单契约零改动 |
| `analyzeScript` / `approveScript` / `commit` / `rebind`（commit stage=topic 重写账号快照，下游按 revision 失效，store.mjs:375-380） | 工作台动作零改动 |
| 篇幅档位 short 300-999 / medium 1000-2499 / long 2500+（script.mjs:13-17），默认 medium | 左栏分段选择器 |
| 写稿模块色 = violet `#7c3aed`（MODULE_CONTEXT client.js:448，`--sv-violet` 已在品牌变量中） | Tab/选中/主按钮 accent 用紫，区别于选题橙 |
| 本地真实数据：projects 5 个、topic-generations 5 条、signals 945 条 | 当前量级小，但「查看更多」抽屉为长期使用兜底 |

## 2. 新版页面设计

页面骨架 = `PackFrame`（Intro + PipelineStrip + HeroMini）→ `Notice` → `sv-split` 左右两栏 → **全宽稿件工作台** → 四个抽屉（选题浏览 / 执行摘要 / AI 稿件 / 确认对话框）。HeroMini 四格：可写稿选题 N / 待确认 N（橙）/ 已确认 N（绿）/ 生成状态（running 紫 / 空闲绿）。

### 2.1 账号 Tab ✅ 成立，直接复用选题页模式

- Tab 集合 = active 账号 +「通用（无账号定位）」固定末位；默认账号带角标点（同选题页 1117-1123）。
- 分组规则：项目 topic 工件 `account.id` 命中 active 账号 → 该 Tab；`account` 为 null → 通用 Tab；`account.id` 已归档/删除 → **不进任何 Tab 内联区**，仅在「查看更多」抽屉的「已归档账号」分组可见（卡上标注原账号名 + 已归档）。理由：Tab 集合与选题页保持一致（选题页只渲染 active 账号），归档账号的存量项目不丢失、可从抽屉进入工作台继续写稿。→ 决策点 A。
- 每个 Tab 独立表单草稿 `formsByTab`：`{ selectedTopicId, tier, instructions, mode }`，切换不互相污染（同选题页 1012/1048-1049）。
- 进入页面默认选中默认账号 Tab（无则通用），Tab 内默认选中第一个「待确认」项目（无则第一个「未写稿」项目，再无则不选）。

### 2.2 左栏 = 新建写稿任务卡（`sv-form`，violet accent）

自上而下：

1. `sv-section-head`：「新建写稿任务」+ 右侧当前 Tab 名；
2. 账号 Tab 条（2.1）；
3. Tab 说明行（sv-tp-acct-note 同款）：「选题按确认时的账号定位分组；通用 Tab 收录未绑定账号的选题」；
4. **「可写稿选题 · N 个」区**：头右侧「查看更多 →」链接；内联前 6 张选题卡（2.3）；超过 6 张时底部虚线「还有 X 个 · 查看更多」；
5. **篇幅**：三选一分段控件（短 300-999 / 中 1000-2499 / 长 2500+），替代旧 select，字数区间直接可见；默认 medium；
6. **额外要求（可选，≤500 字）**：textarea（旧版是 input，500 字用单行输入体验差），placeholder「例如：更口语一点、多用例子」；
7. **生成模式**：胶囊二选一「新起稿 / 润色当前稿件」；润色在选中项目无已保存稿时禁用并提示（沿用后端校验语义）；
8. 提交行：`lwb-primary-button`「确认 · 交给 DSH 写稿」（与选题页提交按钮同文案节奏）。禁用条件：未选中选题 / anyRunning / busy；禁用原因用小字 note 说明。

### 2.3 选题卡（新组件 `sv-sc-topic`，内联 + 抽屉共用）

整卡可点的 radio 卡（`sv-tp-cand` 交互同款：点击只改选中，选择权在用户）：

- 头行：自绘 radio（选中紫心）+ 标题（topic.title，即项目标题）+ 右侧状态徽章：`未写稿`（灰）/ `待确认`（橙，fff7ed）/ `已确认`（绿，sv-stage 同款）；
- meta 行：`角度：{angle||未填写} · 信号 {n} 条 · {已存稿 X 字 ·} {相对时间}`；
- 已确认项目在 meta 行尾追加「可进入配音」提示（弱化色）。

内联排序：待确认 → 未写稿 → 已确认，组内按 updatedAt 倒序，取前 6。理由：写稿页的核心待办是「把待确认稿批掉」和「给未写稿选题出稿」，已确认项目再写稿是低频动作（改稿），沉底但不隐藏。→ 决策点 B。

### 2.4 「查看更多」抽屉（全部可写稿选题）

`sv-drawer`（640px）+ v2.5 结构（head / tools / scroll）：

- head：「全部可写稿选题 · {Tab 名}」+ 总数 + 关闭；
- tools：搜索框（标题 / 角度子串匹配，前端过滤）+ 状态 filter chips：全部 N / 未写稿 N / 待确认 N / 已确认 N（+ 存在归档账号选题时追加「已归档」chip）；
- scroll：粘性分组标题（本周 / 更早，按 updatedAt；归档账号选题固定末组），卡用 2.3 同款 `sv-sc-topic`；
- 选中即关抽屉（内联区同步高亮）；当前 Tab 无任何选题时空态给 `sv-empty-cta`「去选题页加入待写稿选题」（跳转 topics 菜单）。

数据一次拉全（`listWritableTopics` 返回全部），前端过滤分页；本地文件量级（项目数 ≪ 200）不需要虚拟滚动。

### 2.5 右栏 = 写稿任务列表 + 底部全宽「稿件工作台」

**右栏任务列表**（`sv-section`）：

- 头：「写稿任务」+「N 条记录 · M 运行中」；
- 记录卡升级为选题页 `sv-tp-task` 同款（状态色左边框：running 紫 / failed 红 / completed 常态；violet accent）：
  - 头行：projectTitle + meta（相对时间 · 账号名 · 新起稿/润色 · 篇幅档 · 耗时）+ 状态徽章（运行中 / 失败 / `质检 {score}`（≥80 绿、<80 橙））；
  - running：步骤胶囊 `sv-tp-step`（组装上下文 / DSH 生成稿件 / 校验整理 / 确定性质检）+「切换页面不会中断」note；
  - completed：虚线就绪条（`sv-tp-confirmed` 同款形态，绿）「AI 稿件就绪 · 正文 X 字 · 采用到编辑器后可修改保存」；
  - 操作行：「执行摘要」（plain）+「查看稿件」（completed 时主按钮）/「重试」（failed 时主按钮）；
- **不按 Tab 过滤**（与选题页一致：任务是全局流水，卡上标注账号名）；最多显示 12 条；→ 决策点 C。
- 轮询对齐选题页：`anyRunning`（列表存在 running）→ 1.5s 轮询 `listScriptGenerations` 整列表刷新；**删除单 genId 轮询与首次吸附逻辑**（`scriptGenerationStatus` RPC 前端不再使用；后端保留，零前端依赖）。

**底部全宽稿件工作台**（新组件，`sv-sc-bench`）——承载「写长文 + 质检 + 闸门」：

- 仅在选中某可写稿选题时出现；头行：「稿件工作台 · {标题}」+ 状态徽章（未写稿/待确认/已确认）+ 右侧 meta（账号快照名 vX · 信号依据 N 条 ▸（details 折叠，沿用现实现）·「更换账号定位」链接）；副行：角度 + 闸门文案「确认后进入配音；稿件再次修改会要求重新确认」；
- 主体两列（`minmax(0,1.5fr) minmax(0,1fr)`）：
  - 左：编辑器 textarea（minHeight 300px，沿用）+ 字数/预估口播时长（前端按 4.1 字/秒粗算，与质检口径一致）+ 操作行「质检（plain）/ 保存口播稿（主）/ 确认稿件 · 进入配音（绿主按钮）」；
  - 右：质检报告卡（现 `qualityPanel` 视觉升级：大分数 + verdict 徽章 + 字数/段落/查重统计 + 建议列表；无报告时显示占位说明「保存或点质检后出报告」）；
- **确认闸门仪式化**：「确认稿件」与「更换账号定位」都接入 `useSvConfirm` 二次确认（确认文案写明后果：前者=放行配音，稿件再修改需重新确认；后者=下游配音/字幕/视频产物按 revision 规则失效）。已确认状态下确认区切换为 `sv-approval-ritual` 绿态展示（确认时间 + 绑定 revision + 「可进入配音」），复用现有未启用样式。→ 决策点 D。

### 2.6 两个任务抽屉

1. **执行摘要抽屉**（选题页 summaryDrawer 同构）：输入回显（生成模式 / 篇幅 / 额外要求 / 账号快照 / 项目）→ 结果统计三格（质检分 / 正文字数 / 耗时）→ 执行步骤（sv-step 纵列）→ 失败信息 → `dshTraceBlock(record)`（依赖 3.2 后端补齐）。
2. **AI 稿件抽屉**（候选抽屉同构，粘性 footer）：head（项目标题 + 时间/模式/篇幅/耗时/质检分）→ 钩子 note → 正文独立滚动区（全文，替代现在的 180px 小窗）→ needsVerification / factCheckItems / safetyNotes 分节（橙调提示，「需要核实」优先展示）→ 质检建议列表 → DSH 轨迹折叠 → footer：「重新生成」（plain，沿用当前记录入参重发）+「采用到编辑器」（主按钮：`setBody(draft.script)` + 关抽屉 + **同步把工作台选中切到该记录的项目** + 滚动定位到工作台；采用只写编辑器不自动保存，保存仍走人工 commit）。
   - 任务卡「查看稿件」点击 = 切工作台选中 + 开抽屉，保证「采用」目标无歧义。

### 2.7 空态与边界

- 无任何可写稿选题：左栏选题区 `sv-empty-cta`「去选题页加入待写稿选题」；工作台不渲染；
- 当前 Tab 无选题：Tab 内空态文案 + 「查看更多」仍可进全量抽屉；
- anyRunning：左栏提交与表单禁用（同选题页单并发纪律），任务卡照常可看历史。

## 3. 后端改动（最小集）

### 3.1 新增 RPC `listWritableTopics`

- 归属：`SpokenVideoProjectStore`（读自身 projects + artifacts），gateway 一行转发 + `decorateRemote` 注册（`spokenVideo/listWritableTopics`，无入参或 `{}`）。
- 返回：所有 `completedStages.includes('topic')` 项目的选题卡数据，按 updatedAt 倒序：

```
[{ projectId, title, revision, updatedAt,
   angle, account: {id,name,revision}|null, accountActive: boolean,
   signalCount, scriptState: 'none'|'draft'|'approved', scriptChars,
   approvalRevision }]
```

- 实现要点：逐项目读 topic/signals/script 工件 JSON 只取统计（不返回 body）；`accountActive` 由账号库（content store）判定——为避免 projects store 反向依赖 content store，`accountActive` 的判定放前端（Tab 集合来自 `listAccounts`，快照 id 不在 active 集合即视为归档）或 gateway 层组合。**推荐前端判定**（数据都在，零耦合）。→ 实现时二选一，倾向前端。
- 测试：store 单测（分组字段正确性 / 无 topic 项目不出现 / scriptState 三态 / 空库）。

### 3.2 写稿 executor 接 DSH 事件流

- `runScriptGeneration`（content-store.mjs:780）调用 executor 时补传 `onDshStarted/onDshEvent`（选题侧 703-709 同款写法），记录落 `dsh: {childSessionId, parentSessionId, events[]}`；
- `scriptGenerationStatus` / `listScriptGenerations` 返回自然携带，前端 `dshTraceBlock` 直接复用；
- 测试：content-store 单测（fake executor 触发事件 → 记录含 dsh.events）。

### 3.3 零改动清单（明确不动）

`startScriptGeneration` 入参契约、`analyzeScript`、`approveScript`、`commit`、`rebind` 语义、篇幅档位、质检引擎、生成记录保留 40 条上限——全部不动。旧前端专用的 `scriptGenerationStatus` RPC 后端保留（零兼容原则下前端不再使用即可，不值得为删一行转发做回归）。

## 4. 前端改动与 CSS 策略

- **CSS 泛化（零兼容重命名）**：`sv-tp-task / sv-tp-tabs / sv-tp-tab / sv-tp-step / sv-tp-cand / sv-tp-drawer-foot / sv-tp-confirmed` 等已跨页复用的类提升为共享名（`sv-task / sv-tabs / sv-tab / sv-step-pill / sv-pick / sv-drawer-foot / sv-done-note`），选题页引用同步改；accent 色参数化——页面根容器挂 `data-accent="orange|violet"`，active/选中/主按钮色由 CSS 变量 `--sv-accent / --sv-accent-soft / --sv-accent-line` 驱动（选题橙 `#f97316`、写稿紫 `#7c3aed`），暗色覆盖同步。
- 写稿页专属新类前缀 `sv-sc-*`：`sv-sc-topic`（选题卡）、`sv-sc-bench`（工作台）、`sv-sc-seg`（篇幅分段）、`sv-sc-ritual-ok`（已确认仪式区，基于现有 sv-approval-ritual 扩展绿态）。
- ScriptPage 整体重写（删除旧 sv-layout 结构、genId/gen 单任务状态机、首次吸附 effect、historyRows/projectRows 旧列表）；状态改为：`formsByTab / activeTab / writableTopics / history（列表级轮询）/ detail+body+report（工作台，沿用 useDetail/useCommit）/ 抽屉开关 ×3 / useSvConfirm`。
- 复用组件：`PackFrame / Intro / HeroMini / Notice / SignalDrawerBody 不用（写稿页无信号抽屉）/ dshTraceBlock / useSvConfirm / StageDots（选题卡不再用，工作台头可留）/ relativeTime`。

## 5. 决策点汇总（待用户拍板）

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| A | 归档账号的选题归属 | A1 抽屉「已归档」分组，不进 Tab；A2 归入通用 Tab 并标注原账号名 | **A1**（Tab 集合与选题页严格一致，语义干净） |
| B | 内联选题卡数量与排序 | B1 前 6 张，待确认→未写稿→已确认；B2 用户原案前 20 张 | **B1**（配置卡一屏可用；20 张把提交按钮顶出两屏） |
| C | 右栏任务列表是否按 Tab 过滤 | C1 全量（卡上标账号名）；C2 按当前 Tab 过滤 | **C1**（与选题页一致，任务是全局流水） |
| D | 确认闸门与换绑的二次确认 | D1 接入 useSvConfirm + 已确认仪式区；D2 维持裸按钮 | **D1**（approve_draft 是硬闸门，换绑会失效下游产物） |
| E | CSS 泛化重命名 sv-tp-* → 共享类 | E1 做；E2 写稿页直接借用 sv-tp-* 类名不改 | **E1**（零兼容原则：概念名要准，tp≠通用） |
| F | 工作台位置 | F1 两栏下方全宽；F2 塞进右栏任务列表下方 | **F1**（编辑器需要宽度与稳定位置，右栏任务卡是流水不适合常驻编辑区） |

## 6. 实施步骤与回归（拍板后执行）

1. 后端：`listWritableTopics`（store + gateway + 单测）→ executor 补 DSH 事件（content-store + 单测）；
2. 前端 CSS：泛化重命名 + accent 参数化 + 新 `sv-sc-*`（先改选题页引用，跑一次页面确认无回归）；
3. 前端 ScriptPage 重写：Tab + 选题区 + 查看更多抽屉 → 任务卡 + 列表级轮询 → 两个任务抽屉 → 工作台 + 闸门仪式；
4. 回归：`npm run test` 全绿（当前基线 127 项，预计 +4~6）；重启工作台（`node lwb/dsh-launcher.mjs --no-open --port 3080`）浏览器实机验收；
5. 文档：19 号文档头部加「UI 已按 24 号重设计」状态注记；MEMORY.md 增补写稿页新契约。

## 7. 实施记录（2026-09-06 落代码）

> **⚠ 本节 §7.3 的页面结构已被 §8 二次修订取代**（底部工作台删除、润色移入抽屉、换绑功能移除）。§7.1 CSS accent 参数化、§7.2 后端两项仍然有效。

回归结果：**129/129 全绿**（基线 127，新增 2 项：store 侧 `listWritableTopics` 分组/三态/快照/排序/revision 降级，content-store 侧写稿 DSH 轨迹落盘与脱敏）。决策点按 §5 推荐落地：A1、B1、C1、D1、F1；E 按修正版（见 7.1）。

### 7.1 CSS 策略修正（偏离原 E1「重命名 sv-tp-*」）

实施时发现原 E1 方案不可行且无收益，改为 **E1'：保留 `sv-tp-*` 类名作为跨页「任务套件」，仅做 accent 参数化**。原因与处置：

- **命名冲突**：`sv-tabs / sv-tab / sv-step / sv-dot / sv-cand` 在基础 CSS 中**已存在且被信号页等使用**（`sv-tabs/sv-tab` 是 SignalsPage 视图切换器，client.js:788/822）。把 `sv-tp-tabs` 重命名为 `sv-tabs` 会直接撞车、破坏信号页。
- **收益/风险比失衡**：重命名 ~40 个类只为把 `tp`（topic）改成中性名，属纯改名，却要改动**用户已满意的选题标杆页**全部引用，风险不对称。
- **落地做法**：
  - `sv-tp-*` 套件保留原名，注释改为「共享任务套件」，写稿页直接复用（它事实上成为跨模块任务套件）；
  - accent 参数化照做：`.sv-page` 挂默认橙变量 `--sv-accent/-soft/-line/-ink/-rgb`，`.sv-page[data-accent="violet"]` 覆盖为紫；`sv-tp-tab / sv-tp-task[data-status=running] / sv-tp-step[data-state=running] / sv-tp-cand[data-sel] / sv-tp-cand-radio / sv-tp-rec` 的硬编码橙全部改读 `var(--sv-accent*)`，暗色经 `--sv-accent-rgb` 自动重映射；`PackFrame` 新增 `accent` prop 透传 `data-accent`；写稿页传 `accent="violet"`。
  - 写稿专属新类前缀 `sv-sc-*`（与原计划一致）：`sv-sc-state`（未写稿/待确认/已确认三态徽章 + 暗色）、`sv-sc-archived`、`sv-sc-seg`（篇幅三分段）、`sv-sc-mode(s)`（生成模式胶囊）、`sv-sc-more`（查看更多虚线按钮）、`sv-sc-bench*`（工作台 head/title/sub/tools/body/editor/count/report）、`sv-sc-ritual*`（已确认绿态仪式区）、`sv-sc-gate-note`。
- 注：原计划 `sv-sc-topic`（选题卡）未单独建类——选题卡直接复用 `sv-tp-cand`（radio+标题+meta 三层），仅状态徽章用 `sv-sc-state`，避免与候选卡样式重复。

### 7.2 后端

- `spoken-video-store.mjs`：新增 `listWritableTopics(agent)`（紧邻 `listScriptCorpus` 前）。遍历 projects，仅取有 topic 工件者，读 topic/signals/script 工件**只取统计不取 body**，返回 `{projectId,title,revision,stage,updatedAt,angle,account:{id,name,revision}|null,signalCount,scriptState:'none'|'draft'|'approved',scriptChars,approvalRevision,approvedAt}`，按 updatedAt 倒序。`accountActive` **不在后端判定**（按 §3.1 倾向前端，零 projects↔content 反向耦合）。单条工件损坏走 `SpokenVideoStoreError` 跳过，与 `list` 同款容错。
- `gateway.mjs`：`listWritableTopics(agent)` 薄转发 + `decorateRemote` 注册（紧随 `list`）。
- `spoken-video-content-store.mjs`：写稿记录初始化加 `dsh: dshTrace()`；新增 `recordScriptDshStarted/recordScriptDshEvent`（选题侧 `recordTopicDsh*` 同款，走 `mutateScriptGeneration` 串行接缝）；`runScriptGeneration` 调 `scriptExecutor` 时补传 `onDshStarted/onDshEvent`。轨迹脱敏复用 `projectDshSessionEvent`（reasoning/工具入参不外泄）。

### 7.3 前端 ScriptPage 整体重写（client.js，约 367 行）

- **状态**：`topics`（listWritableTopics）/`accountLibrary`/`formsByTab`（per-tab `{tier,instructions,mode}`）/`activeTab`/`benchId`/`history`/抽屉开关 `openMore·openSummary·openDraft`/`moreFilter·moreQuery`/工作台 `body·report·scriptAccountId`/`useSvConfirm`/`benchRef`/`adoptRef`。删除旧 `sv-layout`、`genId/gen` 单任务状态机、首次 30 分钟吸附 effect、`historyRows/projectRows/stepView/qualityPanel/genPanel`。
- **数据加载**：首屏 `Promise.all([listAccounts, listWritableTopics, listScriptGenerations])`；`projects` 变化 → 重拉 topics（commit/approve 会改 scriptState）；`anyRunning`（列表级，非单任务）→ 1.5s 轮询 `listScriptGenerations` 并刷新 topics。
- **账号 Tab**：active 账号 + 通用（末位，带计数），默认账号带橙点；`tabOf` 按 topic.account.id 归组，归档账号 → `ARCHIVED_TAB`（不进 Tab，仅抽屉「已归档」组）。切 Tab 重置 bench 到该 Tab 首选题。
- **左栏配置卡**：Tab → 说明 → 可写稿选题区（内联前 6，超出显「还有 N 个·查看更多」）→ 篇幅三分段 → 额外要求 textarea → 生成模式胶囊（润色在无存稿时禁用）→ 提交「确认·交给 DSH 写稿」。
- **右栏任务卡**：复用 `sv-tp-task`（running 状态色边框 + `sv-tp-step` 胶囊；completed 且有稿 → `sv-tp-confirmed` 绿框「AI 稿件就绪·正文 X 字」；failed 红边框）。徽章 = 运行中/失败/`质检 N 分`(≥80 绿)。动作：执行摘要 / 查看稿件 / 重试。全量不按 Tab 过滤（卡上标账号名）。
- **三个抽屉**：①查看更多（搜索 + 状态 chips + 本周/更早/已归档分组，选中即关）；②执行摘要（输入回显 sv-tp-sumrow + 结果统计 sv-tp-sumgrid + 步骤 + dshTraceBlock）；③AI 稿件（钩子 + 全文滚动 + needsVerification/factCheck/safety/质检建议 + dshTrace + 粘性 footer 重新生成/采用到编辑器）。
- **全宽工作台** `sv-sc-bench`：头（标题 + 三态徽章 + 角度/闸门文案 + 账号快照 + 信号依据 details + 账号重绑 select/按钮）→ 两列（编辑器 + 字数/预估时长 + 质检/保存；右列质检报告卡）。已确认 → `sv-sc-ritual` 绿态仪式区（确认时间 + 绑定版本）；未确认 → 「确认稿件·进入配音」按钮 + 闸门说明。
- **闸门仪式化**：`approve` 与 `rebindAccount` 均接入 `useSvConfirm` 二次确认（换绑标 danger，文案写明下游产物失效）。
- **采用防覆盖**：跨项目采用时 `adoptRef` 暂存稿件，detail 重载的 reset-effect 优先消费 adoptRef，避免编辑器被存稿冲掉。

### 7.4 已知边界与遗留

- **空态 CTA 无跳转**：能力包页面仅拿到 `{sessionId, openConversation}`，无编程式菜单跳转接缝，故「还没有可写稿选题」空态用 `sv-empty-cta` 文案引导用户去选题页，非按钮跳转（诚实降级，非缺陷）。
- **浏览器实机验收未做**（同 9/5/9/6 端口与会话约束）：用户需重启工作台（旧进程不含本次代码）并在页面点「加载」能力包后验收。建议重点看：写稿页紫色 accent 是否与选题橙区分、Tab 切换 bench 联动、AI 稿件抽屉采用到编辑器、确认闸门二次确认、DSH 轨迹是否出现（需真实跑一次写稿生成）。
- `scriptGenerationStatus` RPC 后端保留、前端已不用（列表级轮询替代），符合零兼容「不值得为删一行转发做回归」。

## 8. 二次修订（2026-09-06 晚，用户指出界面逻辑问题后重构）

### 8.1 用户指出的两个缺陷（均成立）

1. **「润色当前稿件」放错位置**：润色是对*已有稿件*的操作，却混在左栏「新建写稿任务」的「生成模式」里，语义错位。
2. **「采用到编辑器 → 确认进入配音」操作割裂**：AI 稿件抽屉采用后要关抽屉、滚到底部工作台、再点确认，一个连续动作被切成三段。

根因诊断：§2.5/§7.3 的底部工作台持有**独立选中态 `benchId`**，与任务抽屉的 `openDraft` 是两套选择逻辑。上一轮为防止跨项目采用时编辑器被存稿覆盖而加的 `adoptRef` 补丁，正是设计错位的信号——**需要打补丁防覆盖，说明这两块本该合并**。这与选题模块「已确认选题并入任务列表」的理由同源：同一生命线不该拆区块。

### 8.2 重构后的结构（左配置 / 右任务 + 单一抽屉生命线）

- **左栏只做「新建」**：删除「生成模式」选择器（`sv-sc-mode`/`sv-sc-modes` CSS 与 JSX 连根删除），提交永远是新起稿；篇幅 + 额外要求保留；选题卡点击 = 选为**新建目标**（per-tab `form.targetId`），已有稿件的卡额外给「打开稿件 →」入口。
- **「查看稿件」抽屉 = 稿件完整生命线**（新 `sv-drawer-wide` 加宽至 860px 容纳编辑器）：头部（标题 + 三态徽章 + 未保存标记 + 账号快照/角度/版本 + 信号依据折叠）→ 运行中步骤胶囊 / 最新 AI 稿件卡（钩子 + 需要核实 + 执行摘要 + 载入到编辑器）→ **可直接编辑的正文** + 字数/预估口播时长 + 质检按钮 → **润色控件**（`sv-sc-polish`：篇幅 mini 三选 + 润色要求输入 + 「润色/保存并润色」+「重新起稿」）→ 质检报告 → **粘性 footer**（保存口播稿 / 确认稿件·进入配音；已确认态换成绿态仪式条 `sv-sc-ritual`，含确认时间与绑定版本）。
- **底部全宽工作台整体删除**：`benchId`/`benchRef`/`adoptRef` 与 `sv-sc-bench*` 全套移除，页面只剩 `openProject` 一个选中态（抽屉即工作台）。
- **确认闸门**保留 `useSvConfirm` 二次确认；确认按钮加 `sv-sc-approve` 绿色样式，与紫色生成动作明确区分；有未保存修改（`dirty`）时确认按钮禁用。
- **关闭抽屉防丢失**：`closeDraft` 在 `dirty` 时弹二次确认「放弃未保存的修改？」。
- **任务卡**「查看稿件」（有稿时主按钮）/「打开稿件」（无稿时 plain）均开同一抽屉；重试保留。

### 8.3 「更换账号定位」连根移除（用户拍板）

用户质疑该功能存在的必要性，结论是**直接删除**而非挪位：

- 它是历史遗留——账号体系 9/4 才加，当时选题页尚无账号 Tab，故写稿页给了「事后绑定」兜底入口；9/5 选题页改为按 Tab 确认后，账号归属在**确认选题那一刻**即已决定。
- 写稿页再改绑属于**越权**：换绑 = `commit stage=topic` 重写选题工件，`invalidateDownstream`（store.mjs:377-380）会删除稿件及配音/字幕/视频/质检/批准/入队**全部下游产物**——等于在编辑器旁放一个删稿按钮。
- 选题页对「选错账号」的既有答案就是**重新生成**（候选抽屉已确认态文案「如需更换请重新生成」），无需第二条路径。
- 已删除：`scriptAccountId` 状态、`rebindAccount` 函数、账号 select 与绑定/更换按钮、相关说明文案。写稿页从此**不再写 topic 工件**，各模块只管自己的阶段，边界更干净。`accountLibrary` 保留（Tab 渲染与 `accountActive` 判定仍需要）。

### 8.4 润色一致性：自动先保存再润色（用户拍板）

后端润色（`startScriptGeneration mode=polish`）读的是**已保存**稿件（`detail.artifacts.script.data.body`），不是抽屉里未保存的编辑文字。若不管，用户会以为在润色眼前的文字、实际润色的是旧版本——**静默出错，必须堵住**。

落地：抽屉内点「润色」时，若 `dirty` 则先 `commit stage=script` 再发起润色（一次点击、内部串行），按钮文案随之变为「保存并润色」，`title` 提示同步说明；润色区下方常驻一行说明。篇幅档位（`draftTier`）同时用于质检判分，避免「按 A 档写、按 B 档判分」。

### 8.5 AI 稿件载入的新鲜度规则

`draftNewer` 判据：`latestDraft.completedAt > detail.artifacts.script.createdAt`（无存稿则恒真）。满足则自动载入编辑器，否则不覆盖。效果：

- 刚生成/刚润色完 → 稿件自动出现在编辑器，无需额外点击（消除「采用」这一段割裂）；
- 打开一个已存稿、AI 稿件较旧的项目 → 显示已保存稿件，不会被旧草稿覆盖；
- 用户正在输入（`dirty`）→ 永不被自动覆盖；手动「载入到编辑器」按钮仍在，供显式取用。

### 8.6 验证与已知边界

**自身验证全绿**：store 8/8、script 14/14、content-store 写稿 DSH 轨迹用例通过、`node --check client.js` 通过、类名样式覆盖校验通过（78 个引用类名无缺失，`sv-sc-count` 死样式已删）。

**⚠ 本轮存在并发编辑（非本次改动，需用户知晓）**：实施期间另一进程同时在改 `spoken-video-topic.mjs` / `spoken-video-content-store.mjs` / 两个测试文件与本文档 §2.4/§2.7 措辞——`assembleMaterial` 的 `mode` 由 `open-pool` 改为 `latest-batches`、素材池上限 60→80、新增 `prepareLatestTopicMaterial` 与 `setTopicSelected`/`topicSelected`「待写稿队列」概念。这些**不属于本次写稿页重构**：

- 实施过程中一度出现 1 项失败（`migrates one legacy profile into an account library…`，失败点在并发新增的 `prepareLatestTopicMaterial`），**该进程随后自行修复**；本次定稿时全套件 **136/136 全绿**（写稿重构自身范围：store 8/8、script 14/14、content-store 写稿 DSH 轨迹用例通过）。
- `listWritableTopics` 已被并发工作扩展为过滤 `topicSelected`（移出待写稿队列的选题不再出现）。该行为与写稿页重构**兼容**——前端不感知此字段，选题卡数据契约未变；executor 的 DSH 接线在并发编辑后仍在新行号 1147-1148 完好。
- 提醒：两条线并行改同一文件（尤其 `client.js`、`content-store.mjs`）有相互覆盖风险，后续宜串行。

**遗留边界**：

- **已归档账号的选题**在「查看更多」抽屉中为**仅可打开稿件**，不可选作新建目标——它没有归属 Tab，选中后左栏无法呈现，会造成「选了却看不见」的静默丢失。分组标题已写明该约束。
- **空态 CTA 无跳转**：能力包页面仅拿到 `{sessionId, openConversation}`，无编程式菜单跳转接缝，空态仍用文案引导（诚实降级）。
- **浏览器实机验收未做**：需重启工作台（旧进程不含本次代码）并在页面点「加载」能力包。重点验收：紫色 accent、抽屉内编辑/润色/质检/确认一条线走完、`dirty` 时确认禁用与关闭拦截、AI 稿件自动载入、DSH 轨迹（需真实跑一次写稿生成）。
