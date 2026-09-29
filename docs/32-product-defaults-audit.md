# 产品默认配置审计

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

审计日期：2026-09-16。范围：LWB Profile、Bundle 补丁、启动器、工作台壳、能力包加载和口播业务代码。下面记录会影响初始界面、数据、外部连接及任务执行的产品默认值；分页、超时、校验上限等内部实现常量不逐项列出。

## 本次调整

从 `lwb/dsh-bundle/cordis.patch.yml` 删除 `llm-pi-ai.config.providers` 整段配置，取消 OpenAI、Anthropic、MiniMax、通义千问、智谱 GLM 五家默认服务商，以及随附的模型清单、接口地址和密钥引用。

保留 DSH 原生模型设置、多服务商适配器、官方 DeepSeek 接入和可添加服务商目录。没有预设额外对话模型；能力包 AI 任务继续读取 DSH 当前默认模型。

修改针对产品基础配置，不删除用户通过系统设置保存的服务商、密钥和默认模型。已运行的实例需要由用户重启后加载新组合；如果五家中的某家已被保存到用户设置，它仍可能出现，这属于用户配置。

## 工作台层仍保留的产品默认值

| 项目 | 默认行为与生效范围 | 来源 |
|---|---|---|
| 外观 | DSH 原生默认跟随系统，LWB 首次启动预填浅色主题；用户之后可在 DSH 原生外观设置中修改。启动器只在文件不存在时复制，不覆盖已有设置。 | `lwb/profile/settings.yaml`、`lwb/dsh-launcher.mjs` |
| 产品组合 | 固定使用 `lwb` Profile，加载 DSH Base、Web App 和 LWB Bundle；产品名为“老傅工作台”。 | `lwb/profile/package.json`、`lwb/dsh-bundle/cordis.patch.yml` |
| 导航与页面 | 替换 DSH 左侧栏；提供对话、场景能力包、设置三模块；没有历史页面状态时默认进入对话。系统设置仍复用 DSH。 | `lwb/dsh-bundle/client.js` |
| 视觉样式 | 产品字体层级、间距、图标、侧栏和会话列表布局由 LWB CSS 提供；颜色响应 DSH 深浅色状态。 | `lwb/dsh-bundle/client.js` |
| 数据位置 | 默认 DSH Home 为 `lwb/local/dsh-home/`，能力包登记文件为 `lwb/local/packs.json`；可通过专用环境变量指定其他位置。 | `lwb/dsh-launcher.mjs`、`lwb/pack-manager.mjs` |
| 能力包市场 | 自动发现仓库 `lwb/packs/` 下的包，因此口播包会出现在市场；发现或 CLI 登记不等于自动加载。启动只恢复用户此前启用的包。 | `lwb/pack-manager.mjs`、`lwb/dsh-bundle/pack-runtime.mjs` |
| 能力包任务工作区 | 加载包时为其创建或复用专属工作区；内部任务会话从普通会话列表隐藏。 | `lwb/dsh-bundle/pack-workspaces.mjs`、`lwb/dsh-bundle/client.js` |
| 能力包执行策略 | 内部 AI 任务固定选择 DSH `standard` 预设及 `workspace-write` 权限；模型和推理强度取 DSH 默认选择。这是产品明确指定的任务策略，不是继承当前聊天的全部设置。 | `lwb/dsh-bundle/pack-services.mjs` |

其中，浅色主题是仍保留的 DSH 用户偏好预填；侧栏替换属于产品组合；能力包任务模式与权限属于业务执行策略。当前没有在产品基础补丁中额外预填语言、对话模型、对话权限、服务端监听地址或端口。

## 口播能力包的业务默认值

这些值仅属于口播包，不会添加到“系统设置 → 模型”的对话服务商列表。

| 项目 | 默认行为与生效时机 | 来源 |
|---|---|---|
| 信号来源 | 内置 17 个来源，均默认启用：百度、头条、抖音、B站、知乎、微博、Hugging Face、36氪、InfoQ、IT之家、极客公园、爱范儿、少数派、掘金、GitHub Trending、Hacker News、SciTiger AI 内容日报。间隔为 30–360 分钟，普通源单次最多 20 条，AI 日报最多 200 条。 | `spoken-video-signal-adapters.mjs` |
| 自动采集 | 包加载后启动调度器，每 30 秒检查到期来源；业务 `data` 目录存在时开始按来源设置采集。首次信号配置为空时使用上述默认来源。卸载包后停止。 | `spoken-video-content-store.mjs`、`index.mjs` |
| 配音与识别 | 默认渠道为百炼，另支持 SciTiger。预设百炼/SciTiger 接口地址；TTS 默认 `qwen3-tts-flash`，ASR 默认 `qwen3-asr-flash-realtime`，复刻 TTS 默认 `qwen3-tts-vc-2026-01-22`，声音注册默认 `qwen-voice-enrollment`。环境变量可覆盖接口及模型。 | `index.mjs`、`spoken-video-media.mjs` |
| 音色 | 附带 `Tiffy - 自信` 参考音频；系统/参考音色流程使用该素材。直接使用百炼默认音色时有 `Cherry` 回退；默认语速与音量均为 1。 | `spoken-video-media.mjs`、`assets/voices/tiffy-confident.mp3` |
| 封面生图 | 默认关闭；渠道默认百炼，另支持 SciTiger；启用且未指定模型时回退到 `wan2.7-image`。 | `index.mjs`、`spoken-video-publish.mjs` |
| 写稿与视频 | 默认中篇稿件（1000–2499 字）；视频默认 Remotion、横屏、开启字幕、不选 BGM。选择 BGM 后默认音量 0.12。视频 Agent 最多允许两次输出上限续写。 | `spoken-video-script.mjs`、`spoken-video-media.mjs`、`index.mjs` |
| 内容安排 | 初始无任务。新建表单默认周一至周五 21:00、每轮 1 条、竖屏、中篇、字幕开启、执行到发布资料；保存后才成为任务，创建请求未指定开关时默认为启用。 | `client.js` 的 `emptyScheduleForm()`、`spoken-video-schedule.mjs` |
| 初始业务数据 | 无预置账号定位、项目、稿件、成片、内容安排或历史运行记录；信号源定义和参考音色属于随包提供的资源。 | `spoken-video-content-store.mjs`、`spoken-video-schedule.mjs`、`spoken-video-store.mjs` |

配音/生图默认渠道和模型并不附带可用密钥，也不会仅因加载能力包就提交生成任务。信号自动采集是单独的默认后台行为，需要与这些按任务调用的媒体服务区分。

## 后续判断

如果要求 DSH 偏好完全保持原生首次启动行为，下一处应讨论的是浅色主题预填。如果要求能力包加载后不主动访问外部来源，下一处应讨论的是信号源默认启用与自动采集策略。内部 Agent 模式、权限和业务媒体默认值也可进一步产品化，但本次仅记录，没有连带修改。

验证：`npm test`，246 项测试全部通过（包含 Profile 展开检查，确保原生多服务商适配器仍在且没有预置服务商配置）。本次没有启动产品 Web 服务，也没有清理用户设置。
