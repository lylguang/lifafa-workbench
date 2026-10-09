# 38 · 发布与账号管理能力包（publisher）

> 状态：设计 + 一期落地（2026-10-02）
> 结论先说：不改造现有发布模块的「资料生成」职责，新增一个平级的 `publisher` 能力包，
> 用**本机 Chrome + Playwright 持久化会话**承载「平台账号管理」与「作品自动发布」，
> 通过既有包契约与 spoken-video 成片货架对接。默认停在「发布前确认」，自动提交需显式开启。

## 0. 闭环全景

加上本包之后，口播视频从灵感到发布是一条完整链路，每一段都有明确的归属：

```
信号采集 → 选题 → 写稿 → 确认稿件 → 配音 → 字幕 → 成片+质检 → 发布资料 → 投递到平台
└────────────── spoken-video 能力包 ──────────────┘         └─ publisher 包 ─┘
   ▲                                                                  ▲
   └──────────── 内容安排（定时任务）可一路跑完全部 8 步 ───────────────┘
```

两种用法，同一条链路：

| 用法 | 怎么走 |
|---|---|
| 手动 | 逐页操作到「发布资料」，再到「发布与账号管理 → 发布」选片投递 |
| 定时全自动 | 内容安排任务选「投递到平台」深度，到点无人值守跑完全部 8 步 |

**唯一的默认闸门**在最后一步：即使选了「投递到平台」，默认也是把视频传好、资料填好，
**停在平台的发布按钮前**，由人在浏览器窗口点最后一下。要真正无人值守发布，
需要在任务表单上把投递方式改成「自动提交」——这是一个需要主动选择、且弹窗会复述
「发布后无法撤回」的动作。

---

## 1. 问题定义

工作台当前从选题一路自动到 `packaging`（发布资料：标题、文案、描述、标签、封面），
但**止步于此**，最后一段「把成片交到平台」始终靠人。这不是能力缺口，而是当初刻意划的边界：

| 位置 | 原文 |
|---|---|
| `spoken-video-schedule-host.mjs:109-115` | `Publishing is never automated.` |
| `client.js:5146` | 本模块不会向任何平台直发 |
| `lwb-pack.json:33` | 平台发布由你完成 |
| `docs/26:86` | 队列消费端（publish-manager 直连）依旧刻意不做 |

同时，工作台里的「账号」是**内容定位档案**（定位/受众/方向/边界），
与平台登录账号无关；凭据体系只服务服务商 API Key。所以要做的是：

1. **平台账号管理**——平台登录态、扫码、多账号、登录检测（全新领域）
2. **作品自动发布**——把成片 + 发布资料投递到平台（跨越「永不直发」边界）

---

## 2. 方案选型：为什么是「浏览器自动化」而不是「开放平台 API」

| 路线 | 抖音 | 视频号 | 小红书 | B站 | 快手 | 结论 |
|---|---|---|---|---|---|---|
| 开放平台 API | 需企业资质 + 应用审核 | 需认证 | 无开放发布 | 需审核 | 需资质 | ❌ 个人创作者拿不到 |
| 浏览器自动化 | 创作者中心可用 | 可用 | 可用 | 可用 | 可用 | ✅ 唯一对个人开发者的通路 |

本机实测（`curl` + Playwright 驱动系统 Chrome，2026-10-02 复测）：

- `creator.douyin.com` → 200，Playwright 成功打开创作者中心
- `channels.weixin.qq.com` → 200
- `creator.xiaohongshu.com` → 200
- `member.bilibili.com` / `cp.kuaishou.com` → **200**（首测时误判为网络不通，实为临时故障；
  用真实 Chrome 复测全部可达——教训是 curl 的 000 不能直接当结论，必须用真实浏览器再验证一次）
- 关键：`navigator.webdriver === false`，未被识别为自动化
- 本机 Chrome 154，`launchPersistentContext` 可持久化登录态

这决定了架构：**平台适配器可插拔**。已实现抖音、B站、快手三个；
未登录状态的登录检测在三个平台上都用真实浏览器实测过（B站跳 `passport.bilibili.com`、
快手落地页保持原 URL 渲染「立即登录」，两处判定均正确）；
上传/填单流程的选择器需要首次真实登录后做一轮校准。

---

## 3. 架构

```
┌─────────────────────────── publisher 能力包 ───────────────────────────┐
│                                                                        │
│  账号管理页            发布页                记录页                      │
│  (accounts)          (publish)             (records)                    │
│      │                   │                    │                        │
│      └───────── gateway.mjs (RPC: publisher/*) ┘                        │
│                          │                                             │
│                   publisher-host.mjs  ← 编排：登录/检测/发布/留证        │
│                    │            │              │                       │
│        publisher-store.mjs  publisher-browser.mjs  publisher-evidence  │
│        （账号库+发布任务）    （Chrome 会话池）       （截图/日志）        │
│                                       │                                │
│                          publisher-adapters/douyin.mjs                 │
│                          （平台适配器：登录检测/上传/填单/提交）           │
└────────────────────────────────────────────────────────────────────────┘
                          │                          ▲
            读成片+发布资料 │                          │ 跨包调用
                          ▼                          │
              spoken-video 专属工作区          ctx.get('spokenVideo*')
              data/projects/<id>/
                media/videos/*.mp4
                artifacts/*-packaging-*.json
```

### 3.1 为什么是独立包

- `playwright-core` 是重依赖，隔离后 spoken-video 不必背它
- 平台账号是**跨内容形态**的能力（未来 benchmark / 白板包也可能要发）
- 包契约天然提供：专属工作区、独立凭据命名空间、独立菜单、可卸载

### 3.2 跨包边界（如实记录，不粉饰）

包契约没有官方跨包 API。本包用两条**已存在**的通路：

1. **小数据**：`ctx.get('spokenVideoPublish')` / `ctx.get('spokenVideoProjects')`
   —— spoken-video 自己就用这个惰性模式（`spoken-video-schedule-host.mjs:172-183`），
   比写进 `inject` 好：写了会变成硬依赖，导致任一方缺失时两个包都不加载。
2. **大文件**：经 `lwbPackServices.forPack('spoken-video').context()` 拿工作区路径，
   直接按路径读 `.mp4` / 封面 —— 与 whiteboard 包的跨包方式（子进程读对方 `engine/`）同源。

`docs/29:68` 已声明这是**非沙箱**设计，插件代码本就不受限；此处仅复用既有事实，不新增特权。

---

## 4. 数据模型

### 4.1 平台账号（`data/accounts.json`）

```jsonc
{
  "schemaVersion": 1,
  "accounts": [{
    "id": "uuid",
    "platform": "douyin",              // 平台标识
    "label": "AI工具解读·抖音",         // 用户可改的备注名
    "nickname": "AI工具解读",           // 从平台读回的真实昵称
    "handle": "抖音号",                 // 从平台读回
    "status": "active",                 // active | expired
    "profileDir": "chrome-profiles/<id>", // 登录态目录（包内相对路径）
    "lastCheckedAt": "ISO",
    "lastLoginAt": "ISO",
    "createdAt": "ISO", "updatedAt": "ISO"
  }]
}
```

- 登录态**不落 JSON**，落在 `chrome-profiles/<id>/`（Chrome user-data-dir），
  天然被 `.gitignore` 排除，且与浏览器同一套加密。
- 账号可关联到 spoken-video 的内容定位账号（`contentAccountId`），用于发布页按定位归组。

### 4.2 发布任务（`data/publish-jobs.json`）

```jsonc
{
  "schemaVersion": 1,
  "jobs": [{
    "id": "uuid",
    "accountId": "uuid",
    "platform": "douyin",
    "projectId": "uuid",              // spoken-video 项目
    "projectRevision": 13,            // 冻结版本，防止发错稿
    "title": "…",                     // 快照，发布后仍可追溯
    "status": "queued|running|succeeded|failed|cancelled|awaiting-confirm",
    "phase": "open|upload|metadata|cover|submit|verify",
    "proof": {                        // 证据
      "screenshots": ["evidence/<jobId>/step-1.png"],
      "submittedAt": "ISO",
      "remoteUrl": "平台作品链接"
    },
    "error": null,
    "submitMode": "confirm|auto",
    "createdAt": "ISO", "updatedAt": "ISO", "completedAt": null
  }]
}
```

### 4.3 发布策略（`data/settings.json`）

```jsonc
{
  "submitMode": "confirm",     // 全局默认：confirm 停在发布前；auto 直接提交
  "headless": false,           // 默认有界面（平台反自动化 + 便于人工接管）
  "keepWindowOpenMs": 0        // 确认模式下窗口保持打开
}
```

---

## 5. 关键流程

### 5.1 扫码登录（不能自动化，必须人来）

```
用户点「添加账号」→ 选平台
   ↓ startLogin(platform, label)
包内起一个可见 Chrome（持久化 profileDir）
   ↓ 导航到平台登录页，二维码渲染在窗口里
用户用手机扫码（此步无需任何界面交互，窗口就是界面）
   ↓ 包每 2s 检测登录成功标志（cookie / 跳转 / DOM）
成功后 → 读回昵称与账号号 → 落盘账号记录 → 关闭或保留窗口
```

**为什么不做二维码转发到工作台页面**：平台二维码是带时效的会话凭据，
截图转发等于把登录凭据复制一份到另一个上下文，风险与收益不成比例。
窗口即界面，是这里最干净的做法。

### 5.2 发布

```
用户点「发布」→ 选账号（该账号必须 active）
   ↓ startPublish({ accountId, projectId, submitMode })
校验三道：账号登录态 · 成片 qc.passed === true · packaging 资料齐备
   ↓ 冻结 projectRevision（发出去的就是审过的那一版）
后台执行：
   open    → 打开平台上传页
   upload  → setInputFiles(成片 mp4)
   metadata→ 填标题 / 正文 / 标签
   cover   → 上传封面
   submit  → confirm 模式：停住，等人在窗口里点；auto 模式：自动点
   verify  → 读回作品状态，记录链接
每步截图存 evidence/<jobId>/，失败也留图
```

### 5.3 与内容安排对接：`publish` 深度（已实现）

内容安排新增第 5 个深度档「投递到平台」，`AUTOMATION_STEPS` 随之延长一步。
深度即授权范围，这一档让定时任务一路跑到发布：

```
选题 → 写稿 → 确认稿件 → 配音 → 字幕 → 成片质检 → 发布资料 → 投递到平台
```

任务表单在选择该深度时才显示发布目标（平台账号 + 投递方式），
并且**没有选账号就存不下来**——避免半夜渲染完视频才发现没地方投。

两种投递方式，默认是前者：

| 方式 | 行为 |
|---|---|
| 发布前确认（默认） | 上传视频、填好标题标签封面，**停在平台发布按钮前**；该轮记录为「等待确认」而不是「已发布」 |
| 自动提交 | 无人值守直接点击发布。需在表单上显式选择，且确认弹窗会复述「发布后无法撤回」 |

两个刻意的取舍：

- **确认模式下不谎报成功。** 该轮结束时写的是「已投递…等待在浏览器窗口确认发布」，
  条目状态是 `awaiting`。审计记录不能说一件人还没做完的事已经完成了。
- **账号失效不写死任务。** 平台账号只是「没登录」时，任务保持启用，
  由表单的就绪检查提示去重新扫码；只有账号**确实被删除**才停用任务并写明原因。
  发布包未加载时不做判断——卸载一个包不该把任务永久关掉。

---

## 6. 安全与边界（写进代码，不只是写进文档）

| 风险 | 处置 |
|---|---|
| 误发未审内容 | 校验 `qc.passed === true`；冻结 `projectRevision`；发布前 `revision` 变了就中止 |
| 平台封号 | 默认有界面（非 headless）；默认 `confirm` 模式；单账号串行，不并发刷 |
| 登录态泄露 | profileDir 落在包工作区，不进 Git；凭据服务只存 Cookie 快照（可选） |
| 自动提交失控 | `auto` 模式需在设置里显式打开，且每个任务创建时二次确认 |
| 发错账号 | 账号必须 `status === 'active'`；每次发布任务记录账号快照 |
| 不可追溯 | 每步截图 + 冻结 revision + 记录平台作品链接 |

---

## 7. 落地清单

### 一期（本次交付，已实测）
- [x] `publisher` 包骨架：manifest / package.json / index.mjs / gateway.mjs / client.js
- [x] `publisher-store.mjs`：账号库 + 发布任务落盘（原子写 + EPERM 退避）
- [x] `publisher-browser.mjs`：Chrome 会话池（持久化 profile、串行、可中断）
- [x] `publisher-adapter-douyin.mjs`：抖音适配器（登录检测 / 上传 / 填单 / 提交 / 读回）
- [x] `publisher-host.mjs`：编排 + 跨包读成片 + 校验闸门 + 证据
- [x] 三个页面：账号管理 / 发布 / 记录
- [x] 依赖 `playwright-core`，脚本 `npm run publisher:install`
- [x] 内容安排 `publish` 深度：定时任务一路跑到平台投递，默认停在发布前

### 二期（未实现，留接口）
- [ ] 视频号 / 小红书适配器（本机可达，按同一接口补）
- [ ] 一个成片同时投递到多个账号（当前一轮一条投给一个账号）
- [ ] 定时发布（指定时间点提交，而非跑完即投）
- [ ] 数据回收（播放/点赞）写回工作台
- [ ] B站分区自动选择（当前自动选失败时，auto 模式在上传前就报错拦下，confirm 模式留给人工）

---

## 8. 验证记录（2026-10-02）

交付时实际跑过的验证，不是纸面推演：

| 验证 | 方式 | 结果 |
|---|---|---|
| 平台可达性 | `curl` 五个创作者中心 | 抖音 / 视频号 / 小红书 200；B站 / 快手当前网络不通 |
| 浏览器通路 | Playwright 驱动本机 Chrome 打开抖音 | 成功；`navigator.webdriver === false` |
| 单元测试（publisher 包） | `node --test lwb/packs/publisher/test/` | 18 / 18 通过 |
| 宿主挂载 | `lwb/dsh-bundle/test/pack-publisher-mount.test.mjs` | 9 / 9 通过 |
| B站/快手登录检测 | 真实 Chrome 走两个适配器自身的 `isLoggedIn` | 均正确判定「未登录」 |
| 内容安排 publish 深度 | `spoken-video-schedule.test.mjs`（含端到端轮次） | 56 / 56 通过 |
| 前端契约 | `spoken-video-client.test.mjs` | 20 / 20 通过 |
| 全量回归 | `npm run unit:test` | 426 / 426 通过，无回归 |
| 真实登录检测 | `node scripts/publisher-smoke.mjs`（真 Chrome + 真网络） | 正确判定「未登录」，未误报成功 |
| 跨包读成片 | `node scripts/publisher-shelf-check.mjs <workspace>` | 读到 9 条成片，7 条资料齐备 |
| 成片路径解析 | `node scripts/publisher-resolve-check.mjs <workspace>` | 3 / 3 解析到项目内真实文件 |
| 界面挂载 | 隔离实例（4174）+ 浏览器点击三个菜单 | 三页均渲染，0 控制台错误 |

验证用的三个脚本留在 `scripts/` 下，可随时重跑；隔离实例与用户实例（4173）互不影响。

> 备注：`npm test` 偶发一个 `spoken-video-media` 用例因 Windows 临时目录 `EBUSY` 失败，
> 单独重跑即通过，与本包无关（该用例会创建并清理大量渲染中间目录）。

---

## 9. 已知限制

1. 平台上传页 DOM 会变，适配器是**消耗品**，需要按失败截图快速修（所以证据很重要）。
2. 三个适配器都只实测过「未登录」路径；登录后的上传/填单选择器需要首次真实登录后校准一轮。
3. B站投稿**分区是必填项**且无可靠默认值：自动选择失败时，auto 模式会在上传前报错拦下
   （避免白传一次大文件），confirm 模式留给窗口里的人选。
4. 视频号/小红书需要各自适配，接口已抽好但未实现。
5. 自动发布可能违反平台条款，风险由使用者自担——这一点在 UI 上明示。
6. 「发布前确认」模式下，视频上传与填单完成后流程停在提交前，**需要人工在浏览器窗口点发布**；这是刻意设计，不是缺陷。
