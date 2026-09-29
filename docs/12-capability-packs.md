# 12 场景能力包

LWB 场景能力包是运行时组合的 DSH 插件，不是核心 Profile 的业务模块。基础 Profile 不依赖任何具体领域包；`lwb/local/packs.json` 只记录本机已注册包，且已被 Git 忽略。因此克隆项目、拉取更新或不提交某个包目录时，基础版依然可以正常启动，也可以开发和注册其他独立包。

## 使用

当前仓库提供的第一个业务包是口播视频内容创作。仓库 `lwb/packs/` 下的包自动出现在目录中，首次需要在页面点击“加载”。外部包通过下面的命令注册；当前支持本机包源，不提供在线下载、包商店或自动更新。新包开发步骤见[开发入门](develop-a-pack.md)。

```sh
npm run pack:install -- /absolute/path/to/pack
npm run pack:list
npm run pack:remove -- pack-id
```

CLI 注册只把外部包源加入本机市场目录，初始为未启用，不会在下一次启动时加载它。工作台中的“场景能力包”是唯一的能力包生命周期入口：点击“加载”会由主机的 Cordis Loader 动态增加 host/client 条目，并把本机登记的 `enabled` 设为 `true`；后续启动会自动恢复这些已启用包。点击“卸载”会移除这些条目、把 `enabled` 设为 `false`，并保留包源和工作区数据。主机将受控、带版本的浏览器 bundle 返回给当前页面；工作台按需注册或销毁对应的浏览器 Loader 条目，再更新左侧菜单，无需刷新整个页面。

启动器始终只装配基础 Profile，不把任何具体能力包写入 Profile 配置。LWB Bundle 在基础服务启动后读取本机登记表，仅恢复 `enabled: true` 的包；运行时依赖链接与浏览器 bundle 均由这条受控加载链路建立。因此基础版仍可在没有任何场景包源码或本机登记的情况下正常运行；单个能力包恢复失败也不会阻止工作台启动。

## 包契约

一个独立包目录至少包含：

| 文件 | 用途 |
|---|---|
| `lwb-pack.json` | 公开 manifest：身份、版本、说明与菜单 |
| `package.json` | npm 包身份、host/client exports 与 `dsh.client` 声明 |
| `index.mjs` | host entry，注册 manifest 与领域服务/RPC |
| `client.js` | browser entry，向 `lwbPackClient` 注册菜单页面 |

manifest 的 `schemaVersion` 当前为 `1`。`id`、菜单 id 与 npm package name 都经过严格校验；菜单 id 在包内唯一。可选的 `market` 字段可声明分类、标签、工作流和图标，供市场卡片和详情抽屉显示。市场读取 `lwb-pack.json` 与 `package.json` 时不会执行包代码；只有用户明确加载后，Cordis Loader 才 import host/client entry。

详情内容由能力包自己的 `market` 元数据提供，核心只负责通用展示。以下字段均可选，兼容原有 schema 1 manifest：

| 字段 | 用途与约束 |
|---|---|
| `introduction` | 面向用户的用途介绍，最多 500 字符；未提供时使用 `description` |
| `workflowHint` | 工作流补充说明，最多 240 字符 |
| `gettingStarted` | 使用前须知，1–8 条，每条最多 240 字符 |
| `features` | 1–16 张能力说明卡；每项含 `menuId`、`title`（80 字符以内）、`description`（240 字符以内）与可选 `icon`（32 字符以内） |

`features.menuId` 必须引用本包已有菜单且不得重复，卡片颜色继承该菜单。支持的线性图标名为 `pack`、`target`、`signal`、`idea`、`write`、`audio`、`video`、`publish`、`calendar`，未知名称回退到通用能力包图标。未提供 `features` 时从现有菜单生成卡片，不要求旧包补充元数据。

详情抽屉按用途介绍、工作流、能力卡片、使用前须知、折叠的数据管理依次展示；标题与加载/开始使用操作固定，中间内容独立滚动。加载、卸载的结果或错误直接在抽屉内呈现。抽屉支持 Escape、点击遮罩关闭、键盘焦点约束及关闭后返回入口。

Host 侧通过 `lwbPackRegistry.register(manifest)` 注册，或使用 `@scitiger-ai/lwb-pack-sdk` 的 `registerLwbPack(ctx, manifest)`。注册必须由 `ctx.effect()` 托管，使包卸载时自动从运行中目录消失。client 侧声明 `inject: ['lwbPackClient']`，注册形如：

```js
ctx.effect(() => ctx.lwbPackClient.register({
  packId: 'example-pack',
  pages: { home: ExamplePage },
}), 'example-pack: register capability pages')
```

客户端注册同样需要由 `ctx.effect()` 托管，以便卸载时释放页面，允许同一页面会话内反复加载与卸载。

核心只向页面传入公开的 pack/menu 信息、`packId` 与基础导航回调。包不能 import `lwb/dsh-bundle/client.js`，也不能假定核心了解它的业务路由或数据模型。加载时宿主自动创建该包专属工作区；数据 RPC 使用宿主分配的上下文，不依赖普通 DSH 对话。Host 声明 `lwbPackServices` 依赖，通过 SDK `getLwbPackScope(ctx, manifest)` 获取包级目录、任务与凭据服务。完整契约见 [29 能力包专属工作区](29-pack-owned-workspaces.md)。

包应在 `peerDependencies` 或 `dependencies` 中声明所需 DSH 运行时包。装载器会为声明的受控 DSH peer 建立同版本本机链接；其他第三方依赖仍由包自己的包管理流程负责。

## 首个包：口播视频内容创作

`lwb/packs/spoken-video/` 是当前仓库唯一提供的场景能力包，包名为 `@scitiger-ai/lwb-spoken-video`。加载后它贡献一个“口播视频内容创作”菜单组，包含：

- 账号定位：保存账号受众、内容方向与表达边界；可用 AI 协助完善。选题确认时将定位快照绑定到项目，后续修改账号配置不会改写已有项目快照。
- 信号：17 个内置来源，包括 16 个公开来源及 SciTiger AI 内容日报。来源默认启用；支持采集、启停、查看记录、收藏和忽略信号，不提供来源增删改或手动日报导入页面。当前存储 schema 为 10，结果按来源去重并保留最近 7 天记录。
- 选题：按账号 Tab 选择参与渠道、填写角度、按需排除信号。确认启动后补采当天缺失渠道，并由 DSH 生成候选；推荐候选自动加入待写稿，其他候选可自行选择。
- 写稿：选择选题、篇幅与要求，点击“写稿”并确认后启动；失败任务重试也需确认。AI 稿件自动保存，可直接进入配音；编辑、润色和检查在稿件抽屉中完成，人工编辑通过“保存并进入配音”提交。
- 配音 / 字幕：从项目稿件或直接输入的文稿创建音频任务，使用百炼或 SciTiger；支持系统参考音色或用户上传的参考音频。默认同时生成字幕，字幕失败不影响已经完成的配音，可单独重试。
- 视频 / 预览：从关联项目的配音继续制作，配置横竖屏、字幕、BGM 与画面要求。DSH 创作 Agent 编写 Remotion 工程，经过渲染、确定性技术质检和独立 DSH 审片后提交成片。没有人工制作说明或手工质检覆盖失败的兜底路径。
- 发布：展示通过质检的成片，生成和编辑标题、文案、标签与横竖封面，支持预览、下载和封面重生/上传。资料齐备后由用户自行到平台发布；没有平台直发或发布队列。
- 内容安排：持久化的主机侧定时任务，支持账号、来源、执行日/时间、每轮条数和执行深度，并保留每轮记录。服务必须运行才会调度，不自动补跑错过的时刻。

阶段标识如下，是否生成字幕等具体执行分支由任务配置决定：

```text
signals -> topic -> script -> voiceover -> subtitles -> video -> qc -> packaging
```

口播数据位于能力包专属工作区 `data/` 子目录，项目位于 `data/projects/<project-id>/`。每一次阶段提交会写入不可变 artifact；更新任一阶段会清除其下游指针而保留历史文件。请求带期望 revision 与幂等键，避免并发点击造成重复提交。`packaging`（发布资料）是终态阶段，必须先有通过的 QC，且只能由受控的发布 Agent 任务写入。

信号池和内容安排位于 `data/signals.json` 与 `data/schedules.json`。调度器运行在主机进程中；来源采集仅访问公开 HTTPS 地址，并检查 DNS 与重定向，拒绝本机和私网地址。

AI 创作通过 DSH 内部 Agent 使用系统默认模型和原生认证。TTS、ASR 和封面生图是包内供应商接口，使用独立业务配置与凭据；用户在页面确认的媒体任务不等同于每次网络请求都触发 DSH 工具审批。具体边界见[工作区与执行作用域](29-pack-owned-workspaces.md)。

源码入口：`index.mjs` 装配服务；`gateway.mjs` 提供 RPC；各 store/host 文件处理持久化和任务；`client.js` 注册八个业务页面。首次使用见[快速开始](quickstart.md)，原生会话和产物展示见[统一执行详情](32-execution-details.md)。
