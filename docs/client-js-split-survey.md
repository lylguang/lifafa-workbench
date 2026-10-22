# client.js 拆分勘察报告

> 勘察日期：2026-10-21。勘察阶段**未修改任何代码**，本文所有数字均为实测。
> 结论：**暂缓拆分，视频功能先交付**；样式拆分（第 1 步）推迟到视频等待反馈改完之后。
>
> **基线**：commit `de0a13b` + 未提交的动画改动（+123/−3，工作区 6,831 行）。复现命令：
> `git show de0a13b:lwb/packs/spoken-video/client.js | wc -l`（HEAD 6,711 行）。
>
> **阅读顺序建议**：先看 §6（两条真实踩到的坑）——它们比数据更容易传染；
> §7 是数据勘误表，记录本文自身被修正过的四个数。

## 0. 统计口径（先声明，避免再对不上账）

| 指标 | 口径 | 数值 |
|---|---|---|
| 行数 | `client.js` 的换行符数（`\r\n` 计 1 行，等价 `wc -l`） | **6,831 行**（HEAD 为 6,711 行，工作区改动 +123/−3） |
| 字节 | UTF-8 字节数 | **593,647 B** |
| 锚点 | 测试里 `.indexOf(` 的调用次数 | **93 处**（分布在 6 个测试文件） |
| 锚点（字面量） | `indexOf('...')` 的字面量参数出现次数 | 91 次，去重后 **49 个唯一字符串** |

> 此前出现的 6,782 / 6,636 / 66 / 62 / 96 等数字，均是口径混用（含/不含 CRLF、含/不含重复锚点、不同时点的文件状态）所致。**以本表为准。**

## 1. 顶层结构

`client.js` 是单个 IIFE，包在 `window.__ModuleLoader__.load({ factory })` 里（:1），**无 ESM import/export**，全部靠闭包共享。尾部 `:6830` 是 `exports.inject` / `exports.apply` / `exports.__voice`。

| 区块 | 行号 | 行数 | 占全文 |
|---|---|---|---|
| CSS（`css` 模板 :117 + `productCss` :120，接续到 :… ） | 117–120 起 | ~1,126 行 | **138,807 B = 23.4%** |
| 状态与共享工具（通知、`useSvConfirm`、`remote`、`PackFrame`、`useProjects`/`useDetail`/`useCommit`、执行详情） | 121–1945 | 1,825 | 26.7% |
| SignalsPage | 1946–2116 | 171 | 2.5% |
| AccountPositioningPage | 2117–2312 | 196 | 2.9% |
| TopicsPage | 2313–2698 | 386 | 5.7% |
| ScriptPage | 2699–3320 | 622 | 9.1% |
| AudioCaptionsPage / VideoPreviewPage（旧壳） | 3321–3358 | 38 | 0.6% |
| MiMo 常量区（音色/模式/标签/克隆） | 3359–3940 | 582 | 8.5% |
| PipelineBoardPage | 3959–4069 | 111 | 1.6% |
| ContentSchedulePage | 4070–5109 | 1,040 | 15.2% |
| **LegacyAudioCaptionsPageV2（死代码）** | 5110–5356 | 247 | 3.6% |
| AudioCaptionsPageV2 | 5357–5886 | 530 | 7.8% |
| VideoPreviewPageV2 | 5887–6255 | 369 | 5.4% |
| PublishPageV4 | 6256–6806 | 551 | 8.1% |
| `apply()` + 注册 + `exports` | 6807–6831 | 25 | 0.4% |

**依赖关系**：全书共用一个闭包。模块级可变状态只有三个（`connection` / `executionRemote` / `executionStreams`，:6808 赋值）和四个跨页交接变量（`scriptsHandoff` / `publishHandoff` / `pipelineHandoff` / `audioCaptionsHandoff`）。其余页面依赖那 1,825 行的共享工具层。**没有显式依赖声明。**

## 2. 依赖源码字符串的测试（拆分风险清单）

只有 6 个测试文件读 `client.js`。`spoken-video-render.test.mjs` 虽提及 `client.js` 但无 `indexOf`，不受影响。

| 测试文件 | `indexOf` 调用 | 断行风险 |
|---|---|---|
| `spoken-video-client.test.mjs` | 68 | **高**（35 用例 / 333 条断言：289 条针对切片，44 条针对全文） |
| `voice-mimo-only.test.mjs` | 16 | **高**（整文件灌入 vm 假 `__ModuleLoader__`） |
| `spoken-video-mimo.test.mjs` | 6 | 中 |
| `execution-transcript.test.mjs` | 2 | 中 |
| `client-lifecycle.test.mjs` | 1 | 中（唯一真执行切片的测试） |
| `spoken-video-render.test.mjs` | 0 | 低 |

### 2.1 完整锚点清单（测试文件:行号 → 锚定字符串")

| 测试文件 | 行号 | 锚定字符串 | 拆分后需改成 |
|---|---|---|---|
| client-lifecycle | 8 | `    async function apply(ctx)` | 若 `apply` 独立成 `src/entry.mjs`，改为直接 `readFile('src/entry.mjs')`，不再切片 |
| execution-transcript | 9 | `    function executionChunks(` | 改为读 `src/shared/execution.mjs` 全文 |
| execution-transcript | 10 | `    function ExecutionSession(` | 同上（终点锚点可删） |
| spoken-video-client | 10 | `function actionKey(` | 搬 `src/shared/util.mjs` 后读该文件 |
| spoken-video-client | 11 | `\n    function sourceName(` | 同上 |
| spoken-video-client | 23/677 | `function TopicsPage(` | 搬 `src/pages/topics.mjs` 后读该文件 |
| spoken-video-client | 24/678 | `\n    function ScriptPage(` | 改为「读 pages/scripts.mjs 到文件末尾」 |
| spoken-video-client | 42/184/665/811 | `function ScriptPage(` | 同上 |
| spoken-video-client | 43/185/812 | `\n    function AudioCaptionsPage` | 同上 |
| spoken-video-client | 54/106/721 | `function AudioCaptionsPageV2(` | 搬 `src/pages/audio.mjs` |
| spoken-video-client | 55/107/722 | `\n    function VideoPreviewPageV2(` | 同上 |
| spoken-video-client | 198/559 | `function VideoPreviewPageV2(` | 搬 `src/pages/video.mjs` |
| spoken-video-client | 199 | `\n    const PUBLISH_STATE_LABEL` | 同上 |
| spoken-video-client | 242/259/605/687/916/944 | `function ContentSchedulePage(` | 搬 `src/pages/schedule.mjs` |
| spoken-video-client | 243 | `\n    function mediaRunLabel(` | 同上 |
| spoken-video-client | 260/606 | `\n    function LegacyAudioCaptionsPageV2(` | 死代码删除后此锚点随之删除 |
| spoken-video-client | 293/576/770/795 | `function PublishPageV4(` | 搬 `src/pages/publish.mjs` |
| spoken-video-client | 294/577/771/796 | `\n    async function apply(ctx)` | 改为「读 pages/publish.mjs 到文件末尾」 |
| spoken-video-client | 342 | `const VIDEO_PIPELINE_STAGES = [` | 搬 `src/shared/video-progress.mjs` |
| spoken-video-client | 343 | `\n    function mediaDataUrl(` | 同上 |
| spoken-video-client | 457/495/851 | `function VideoTaskProgress(` | 同上 |
| spoken-video-client | 467/478/560 | `function VideoPreviewPageV2(` | 同上（页面） |
| spoken-video-client | 468/479/560 | `\n    function ` | 终点锚点改为文件末尾 |
| spoken-video-client | 511 | `const VIDEO_PHASE_HINT` | 随 `video-progress.mjs` |
| spoken-video-client | **528** | `const css = \`` | **样式拆到 `src/styles/*.mjs` 后改为读样式文件**（📌 见 §2.2） |
| spoken-video-client | **529** | `const productCss` | 同上 |
| spoken-video-client | **530** | `` `; `` | 同上（终点） |
| spoken-video-client | 548 | `@media (prefers-reduced-motion: reduce) {` | 同上，改为在样式文件内定位 |
| spoken-video-client | 643 | `function pendingCountByTab(` | 搬 `src/shared/script-util.mjs` |
| spoken-video-client | 644 | `\n    function` | 同上的终点锚点 |
| spoken-video-client | 686 | `const PIPELINE_STAGES = [` | 搬 `src/pages/pipeline.mjs` |
| spoken-video-client | 753 | `function ScheduleRunDetails(` | 搬 `src/pages/schedule.mjs` |
| spoken-video-client | 902 | `function videoTaskProgress(` | 搬 `src/shared/video-progress.mjs` |
| spoken-video-client | 915/943 | `function PipelineBoardPage(` | 搬 `src/pages/pipeline.mjs` |
| spoken-video-mimo | 614/678 | `function svAudioTagSlots` | 已在 `exports.__voice` 暴露，可改为直接调函数，去掉切片 |
| spoken-video-mimo | 616/680 | `\n    }` | 同上（终点锚点） |
| spoken-video-mimo | 806 | `async #mimoVoiceover(` | 切片的是后端文件，不受本次影响 |
| voice-mimo-only | 64 | `function LegacyAudioCaptionsPageV2` | 死代码删除后重写 |
| voice-mimo-only | 347 | `function svInsertAudioTag` | 改读 `src/shared/audio-tags.mjs` |
| voice-mimo-only | 357 | `lwbPackClient.register(` | 改读 `src/entry.mjs` |
| voice-mimo-only | 362 | `\n    function LegacyAudioCaptionsPageV2(` | **显式断言「锚点必须还在」**，删死代码时必须同步删这条 |
| voice-mimo-only | 364 | `未注册的历史项目视图` | 同上 |
| voice-mimo-only | 368 | `function LegacyAudioCaptionsPageV2` | 同上 |
| voice-mimo-only | 470 | `const SV_RETIRED_PROVIDER_LABEL` | 改读 `src/shared/voice-constants.mjs` |
| voice-mimo-only | 471 | `const SV_MIMO_BUILTIN_VOICES` | 同上 |

### 2.2 更正：样式**不是**零锚点（我上一轮说错了）

我上一轮写「样式字符串没有被任何测试锚定，96 处锚点一处都不用改」——**这是错的**，两处受影响：

1. **`spoken-video-client.test.mjs:523-552`** 那条 `video progress motion is subtle and fully disabled under prefers-reduced-motion` 就是**靠 :528-530 切片取 CSS 本体**来断言动画与 reduced-motion 覆盖的。样式搬出 `client.js`，这条立刻红。
2. **`client-lifecycle.test.mjs:20`** 在 vm 沙箱里注入 `installStyle() {}` 桩——样式搬走后 `installStyle` 的取样式方式变了，这条要跟着调。

因此**第 1 步（搬样式）的测试改动量是 2 处，不是 0 处。** 但 2 处仍远小于第 2–5 步的量级，方案不变，结论要准确。

### 2.3 `client-lifecycle.test.mjs` 单独说明（唯一真执行切片的测试）

它是**唯一把切出来的源码真正丢进 `vm` 执行的**测试（其余都是正则/`includes` 静态匹配），所以拆文件时它最先崩，且崩的方式不是断言失败而是 `ReferenceError`。

现状（:8-19）：
```js
const start = source.indexOf('    async function apply(ctx)')
const rest = source.slice(start)
const match = /^\s{4}exports\./mu.exec(rest)   // 终点=首个顶格导出行
const end = match ? start + match.index : source.length
const apply = vm.runInNewContext(`${source.slice(start, end)}; apply`, { … installStyle() {} … })
```

**拆分后的具体改法**：`apply` 单独成 `src/entry.mjs` 后，不再切片，直接：
```js
const entryPath = new URL('../src/entry.mjs', import.meta.url)
const apply = vm.runInNewContext(`${await readFile(entryPath, 'utf8')}; apply`, sandbox)
```
沙箱依赖注入（`connection: null, executionRemote: null, executionStreams: null, installStyle() {}`）保持不变。**注意**：如果 `entry.mjs` 里 `apply` 引用了共享工具层的函数，沙箱就要把这些也注入，否则同样 `ReferenceError`——这是拆到第 3 步之后才出现的问题，第 1、2 步不会碰到。

## 3. 方案与回滚

### 方案 A（推荐）：源码分片 + 拼接构建，产物仍是单文件 `client.js`

`src/` 下按区块分文件，`scripts/build-client.mjs` 按固定顺序在闭包内拼接，生成 `client.js` 并**入库**。

- 测试改动量：**第 1 步 0 处；搬样式 2 处（§2.2）；后续按 §2.1 清单逐条改**
- 构建/加载：新增构建步骤，`npm run check` 加「产物与源一致」校验防漂移；**pack 加载方式不变**（仍取 `client.js`）
- 回滚：删构建脚本、把 `src/` 拼回去即可；每步独立 commit，`git revert` 单步即可

### 方案 B：真 ESM 多文件

- 测试改动量：6 个文件 / 48 个用例 / 333+ 条断言全部重写；`voice-mimo-only` 的假 `__ModuleLoader__` 沙箱、`client-lifecycle` 的切片逻辑要重做；`exports.__voice` 契约要重新设计
- 构建/加载：pack 运行时需支持多模块加载，属**上游接口变更**
- 回滚：难（要同时回退运行时与包结构）
- **结论：本轮不做**

### 方案 C：只做内部整理（分区注释 + 目录），不拆文件

- 测试改动量 0，但体积不变，新人仍读不动。**治标**，可作为方案 A 第 0 步。

## 4. 推荐：方案 A，分 5 步，每步独立可停

1. **建构建管道**（不加内容）：`src/` + 拼接脚本 + `npm run check` 一致性校验。产物与现状逐字节相同，测试全绿。**回滚：删脚本。**
2. **抽 CSS**（−23.4% 体积）：`src/styles/`。需同步改 §2.2 的 2 处测试。**回滚：样式拼回 `client.js`。**
3. **抽共享工具层**（−26.7%）：`src/shared/`。**回滚：`git revert` 单 commit。**
4. **抽 MiMo 常量区 + 各页面**（−8.5% 与每页 2–15%）：按 §2.1 清单逐个搬、每搬一个跑全量。**回滚：按 commit 逐个 revert。**
5. **删死代码**（−3.6%）：`LegacyAudioCaptionsPageV2` 247 行 + `voice-mimo-only:362` 的「锚点必须还在」断言。**回滚：git revert。**

**建议先只做第 1–3 步**：已砍掉约 50% 体积（CSS + 共享层），且测试改动仅 2 处。

## 5. 未决事项

- **相对 `require` 可行性未验证**（Chief 裁定：等第 1 步真要做时再验）。
- **第 1、2 步推迟**：`sv-vprogress-*` 样式区与 QA 提出的「视频等待反馈」改动重叠，两件事同时动同一段代码必撞。等视频功能交付后再开。

---

## 6. 两条勘察期间真实踩到的坑（比数据更容易传染）

### 6.1 共享工作区**禁止**用 `git stash` 取基线

**本次险情**：为了跑「改动前」的基线，执行了一次 `git stash`。这个工作区当时有**四个人的未提交改动**
同时存在——`client.js`（动画 + QA 的活跃提示 + 前端改动）、`spoken-video-failure.mjs`（Backend 正在改的文案）、
`启动工作台.cmd`（Chief 的）、`docs/`。

`git stash` **无差别**把它们全部收走。紧接着 `stash pop` 因并发改动冲突**失败**，
那些改动一度只存在于 stash 里——而当时 Backend 和 QA 正在同一秒改文件，**他们不知道自己改了半截的东西被抽走过**。

后来逐文件比对确认工作区内容 ≥ stash 内容，才执行 `git stash drop`，**未丢东西**。
但这是**差一步就出事**的操作。

**规矩**：共享工作区禁用下面四个命令，它们都会无差别动到别人的未提交改动：

```bash
git stash          # 无差别收走全部未提交改动
git checkout -- <file>   # 无差别丢弃该文件改动
git reset --hard   # 无差别丢弃全部改动
git clean          # 无差别删除未跟踪文件
```

**取基线、对比版本的替代做法**：

```bash
# 只读单个文件（推荐，零干扰）
git show <commit>:lwb/packs/spoken-video/client.js > /tmp/old-client.js

# 需要跑测试时用独立目录
git worktree add /tmp/baseline <commit>
```

### 6.2 `doesNotMatch` 类断言要盯**渲染结果**，不盯源码注释

新增「等待反馈不能说谎」用例时，初版写的是：

```js
assert.doesNotMatch(page, /没有卡住/u)
```

**结果被自己的注释绊倒**——为了说明为什么删掉这句话，注释里引用了原文，
于是这条断言对着注释生效、对着代码空转。变异测试立刻暴露：
把正确实现改回旧文案，这条断言**仍然是绿的**。

**改法**：只对**渲染出来的字符串**断言：

```js
const rendered = [...page.matchAll(/'([^'\n]{4,})'|`([^`]{4,})`/gu)].map((m) => m[1] || m[2])
for (const text of rendered) assert.doesNotMatch(text, /没有卡住/u, `界面不能保证一件它无法知道的事：${text}`)
```

同一类问题还有一处：`assert.match(page, /const VIDEO_SILENT_ALARM_SECONDS = 300;/)` 查的是 `page`，
但常量定义在组件**外面**，切片里根本取不到——必须查 `source`。

**规律**：写 `doesNotMatch` / `match` 之前先问一句——
**我要盯的是「渲染结果」还是「源码形状」？** 再决定对 `page`（组件切片）还是 `source`（全文）断言。
盯错对象，就会写出恒真或恒假的断言；而这两种错误**测试都是绿的**，只有变异能抓出来。

> 这一点在本文件 §2.2 也出现过一次：`LegacyAudioCaptionsPageV2` 的「锚点必须还在」断言
> （`voice-mimo-only.test.mjs:362`）就是刻意盯源码形状的——它要保证的正是「这个函数没被删」。
> 所以不是一律盯渲染结果，而是**明确你在断言哪一种事实**。

## 7. 数据勘误记录

| 项 | 曾报 | 正确 | 原因 |
|---|---|---|---|
| 行数 | 6,782 | **6,781（当时基线）** / 现 6,831 | `split('\n')` 多算了结尾空串；后因后续改动增长 |
| 字节 | 635 KB | 593,647 B（文档基线）/ 现 653,742 B | 同一文件不同时点，含 CRLF |
| 锚点 | 96 / 66 / 62 | **93 处 `.indexOf(`**（本文口径） | 口径不同：含/不含 `slice`、含/不含非 `source` 前缀 |
| 样式锚点 | 0 处 | **2 处** | 见 §2.2，实地漏查 |

**规矩**：报数一律写成「**口径 + 值 + 复现命令**」。只报数字不报口径，
两边对不上账就会白费时间——本次已经因此来回核过两轮。
