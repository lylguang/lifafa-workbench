# 第三方组件与资源说明

项目自有代码采用根目录的 [MIT License](LICENSE)。第三方代码、工具和素材遵循各自许可，本文件不替换其原始条款，也不为来源尚未确认的素材授予额外权利。

## 运行依赖

| 组件 | 用途 | 来源与许可 |
|---|---|---|
| DeepSeek Harness | 对话、模型、工具、会话和插件运行时 | [上游仓库](https://github.com/deepseek-ai/deepseek-harness)，锁定版本见 [UPSTREAM.lock.json](lwb/UPSTREAM.lock.json)；该版本根许可证为 MIT，Copyright 2026 DeepSeek |
| React / React DOM | 工作台与视频组件 | [React](https://github.com/facebook/react)，MIT |
| Remotion / Remotion CLI | 视频工程、预览与渲染 | [Remotion](https://github.com/remotion-dev/remotion)，使用独立的 [Remotion License](https://www.remotion.dev/license)，并非本项目 MIT 许可的一部分 |
| Babel parser | 解析生成的视频代码 | [Babel](https://github.com/babel/babel)，MIT |
| PostCSS | 样式解析 | [PostCSS](https://github.com/postcss/postcss)，MIT |
| ws | WebSocket 通信 | [ws](https://github.com/websockets/ws)，MIT |
| FFmpeg / ffprobe | 音视频处理与检查 | [FFmpeg](https://ffmpeg.org/legal.html)，具体许可依所安装的构建及启用组件而定 |
| Chrome / Chromium | 渲染浏览器 | 由用户安装或 Remotion 下载，遵循对应浏览器发行版条款 |

直接 npm 依赖版本见 [package.json](package.json)，解析版本见 [package-lock.json](package-lock.json)；上游和传递依赖的完整许可应以实际安装包内的许可证为准。Remotion 的免费与公司许可适用条件请查看原始条款，不能因为工作台采用 MIT 就推断所有使用场景均免费。

## 随包资料和音频

| 资源 | 当前出处记录 |
|---|---|
| `lwb/packs/spoken-video/skills/remotion-best-practices/` | 仓库包含 Remotion 编程规则资料；当前未完整记录其原始发布地址、导入版本和独立许可文件，需维护者补充核验。Remotion 软件本身的许可证不能代替这份资料的来源证明。 |
| `lwb/packs/spoken-video/skills/content-video/` | 口播创作规则，历史迁移背景见 [全链路设计记录](docs/14-spoken-video-full-pipeline.md)；原始来源及可再分发声明需进一步补充。 |
| `lwb/packs/spoken-video/assets/voices/tiffy-confident.mp3` | 随包参考音频；当前未记录可核验的来源和使用/再分发授权，需维护者补充。 |

以上未完成的出处记录是发布资料缺口，不表示已核验拥有开放再分发许可。贡献新的技能、音频、图片或字体时，应同时提交来源链接、版本、许可及必要署名；用户上传的素材由用户自行确认使用权限。

## 外部服务与内容

百炼、SciTiger、公开信号来源及 AI 内容日报属于外部服务或内容来源。各自的 API 费用、使用规则、内容权利和可用性不由本项目 MIT 许可证覆盖。工作台不附带服务额度；本地保存产物也不代表生成过程完全离线。
