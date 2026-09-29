# 老傅工作台 · Laofu Workbench

**基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的可扩展 AI 工作台，通过可动态加载的「场景能力包」持续增加业务能力。**

工作台提供统一的对话、模型配置、工具执行和会话管理。场景能力包在此基础上提供独立页面、业务流程、数据存储和 AI 任务，新场景可以作为独立包接入。

**口播视频内容创作是第一个已实现的场景能力包**，覆盖信号发现、选题、写稿、配音字幕、视频制作与发布资料。工作台架构支持继续增加其他场景包；当前仓库只提供这一个业务包。

> 当前为开发预览版，面向本机单用户使用。主要验证环境为 macOS；Linux / Windows 的完整安装与媒体制作流程尚未在本文中提供验证承诺。运行时锁定 DSH `dsh-v0.1.6-alpha.1`，具体版本以 [UPSTREAM.lock.json](lwb/UPSTREAM.lock.json) 为准。

## 工作台与场景能力包

| 层次 | 提供什么 |
|---|---|
| 对话 | DSH 原生对话、工作区、附件、工具与执行记录 |
| 设置 | 模型服务商、默认模型、凭据、权限和审批等系统配置 |
| 场景能力包 | 按需加载的业务页面、任务流程、专属数据及业务接口 |

能力包支持动态加载和卸载，菜单随之更新。已启用的包会在下次启动时自动恢复；卸载保留业务数据和连接配置。开发者可以按公开契约创建独立包，无需把具体业务写进工作台核心。

当前「场景能力包」页面是**本机包目录**：自动发现 `lwb/packs/` 内的包，以及通过 CLI 注册的外部本地包。它尚不提供在线包商店、远程下载或自动更新。

- 使用已有包：打开「场景能力包」，找到目标包并点击「加载」。
- 注册外部包：在项目根目录执行 `npm run pack:install -- /absolute/path/to/pack`，再到页面加载。
- 开发新包：阅读[能力包开发入门](docs/develop-a-pack.md)与[接口契约](docs/12-capability-packs.md)。

能力包是运行在本机的 JavaScript 插件，专属工作区用于数据和任务归属，并不构成第三方代码的安全沙箱；请加载可信来源的包。

## 第一个能力包：口播视频内容创作

| 模块 | 当前能力 |
|---|---|
| 账号定位 | 保存受众、内容方向和表达约束，供后续创作复用 |
| 信号 | 采集内置公开来源和 AI 内容日报，查看与筛选素材 |
| 选题 | 按账号、渠道与选题角度生成候选，加入待写稿 |
| 写稿 | 起稿、编辑、润色与稿件检查；启动写稿前确认任务 |
| 配音 / 字幕 | 使用百炼或 SciTiger 生成配音，默认同时生成字幕 |
| 视频 / 预览 | DSH 创作 Agent 编写 Remotion 视频，通过技术质检和独立审片后展示成片 |
| 发布资料 | 生成、编辑标题、文案、标签和封面，预览及下载产物 |
| 内容安排 | 在服务运行时按计划执行创作流程，查看每轮记录 |

发布模块负责准备资料，**不直接向视频平台发布**。AI 模型、配音、字幕和封面服务需要自行配置凭据，费用由相应服务商收取；开源代码不附带服务额度。关闭浏览器不会停止主机上的任务，退出工作台服务则无法继续定时执行。

## 快速开始

### 环境准备

- Git。
- Node.js `^22.19.0 || >=24.0.0`，建议使用 Node.js 22 LTS 的最新补丁版本。
- npm、Corepack，以及本机 C/C++ 编译工具和开发头文件。macOS 可安装 Xcode Command Line Tools。
- 视频制作另需 `ffmpeg`、`ffprobe` 和 Chrome/Chromium 渲染浏览器。

首次安装需要访问 GitHub、npm 注册表及上游构建所需资源。根项目使用 npm 和 `package-lock.json`；`setup` 脚本进入 DSH 目录后通过 Corepack 使用上游锁定的 pnpm。根目录的 `packageManager` 字段不改变下面的 npm 安装流程。

### 安装与启动

```bash
git clone https://github.com/ScarecrowFu/dsh-laofu-workbench.git
cd dsh-laofu-workbench
npm ci
npm run setup
npm run dev -- --port 4173
```

`npm run setup` 获取并构建锁定版本的 DSH，放在被 Git 忽略的 `vendor/` 中。首次构建可能耗时较长。若提示缺少 Corepack 或编译工具，见[安装与故障排查](docs/troubleshooting.md)。

启动会自动打开浏览器。需要手动打开时运行 `npm run dev -- --no-open --port 4173`，使用终端输出的完整 `http://127.0.0.1:4173/?token=...` 地址完成首次鉴权。不要分享访问令牌。

### 首次使用

1. 打开「设置 → 系统设置 → 模型」，配置服务商、凭据和默认模型。
2. 打开「场景能力包」，加载「口播视频内容创作」。该包随仓库提供，首次无需另行执行安装命令。
3. 在「配音 / 字幕 → 连接配置」设置媒体服务；需要封面生图时，在「发布 → 封面生图」配置相应服务。
4. 准备 FFmpeg 和渲染浏览器，按「账号定位 → 信号 → 选题 → 写稿 → 配音 / 字幕 → 视频 / 预览 → 发布」完成第一条内容。

详见[从安装到第一条视频](docs/quickstart.md)。可以先验证对话和选题写稿，再配置媒体制作依赖。

## 数据与配置

默认运行数据保存在 `lwb/local/`，包括能力包登记、DSH 设置、凭据、会话和创作产物；该目录不提交到 Git。原生附件和业务数据位置见[运行数据目录](docs/31-runtime-data-layout.md)。

启动器**不会自动加载 `.env`**。[.env.example](.env.example) 仅用于说明可选变量；在启动终端中用 `export` 设置，例如：

```bash
export LWB_REMOTION_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm run dev -- --port 4173
```

更新或迁移前，停止服务并备份完整 `lwb/local/`；若自定义了数据目录，还需备份对应位置。包的“清空业务数据”会保留可恢复副本，与“卸载”含义不同。

## 开发与贡献

```bash
npm test
```

完成依赖安装和 DSH 构建后，上述命令执行语法检查、基础/能力包 Profile 检查及单元测试。真实模型和媒体接口需要另外配置并验收，测试通过不代表所有外部服务均可用。

欢迎提交问题、文档改进与场景能力包。请先阅读[贡献指南](CONTRIBUTING.md)，问题反馈入口为 [GitHub Issues](https://github.com/ScarecrowFu/dsh-laofu-workbench/issues)。

## 文档

- [快速开始](docs/quickstart.md)：配置默认模型并完成第一次创作。
- [故障排查](docs/troubleshooting.md)：安装、访问、模型和媒体任务问题。
- [开发场景能力包](docs/develop-a-pack.md)：创建、注册和动态加载独立包。
- [总体架构](docs/01-architecture.md)与[上游版本管理](docs/08-base-lock.md)。
- [文档索引](docs/README.md)：当前指南、开发契约与历史设计记录。

## 许可证与致谢

项目代码采用 [MIT License](LICENSE)。感谢 DeepSeek Harness 提供运行时，以及 React、Remotion 等项目提供基础能力。

第三方依赖和附带资源的许可独立于本项目，特别是 Remotion 使用其自身许可。来源、许可边界和待补充的素材出处见[第三方组件与资源说明](THIRD_PARTY_NOTICES.md)。
