# 贡献指南

欢迎改进工作台、修复问题、补充文档，或开发新的场景能力包。口播视频内容创作是首个业务包，新的场景应优先作为独立包接入。

## 讨论与反馈

- Bug 和功能建议请提交到 [Issues](https://github.com/ScarecrowFu/dsh-laofu-workbench/issues)。
- 较大的架构变化或新场景包，建议先说明目标用户、输入输出、外部依赖和工作台需要提供的接口。
- Bug 报告请包含系统、Node 版本、Git commit、复现步骤、预期结果、实际结果及脱敏日志。
- 不要在公开问题中提交密钥、访问令牌或私人业务数据。涉及敏感信息的问题，先去除敏感内容再报告；不要公开可直接使用的凭据。

## 开发环境

Fork [项目仓库](https://github.com/ScarecrowFu/dsh-laofu-workbench)，克隆自己的 Fork，在根目录执行：

```bash
npm ci
npm run setup
npm run dev -- --port 4173
```

具体环境要求见 [README](README.md) 和[快速开始](docs/quickstart.md)。上游 DSH 用锁定版本构建，根项目依赖用 npm 安装。

建议使用独立分支开发。手工测试不要复用自己的正式业务数据；可以在一个启动终端中同时指定：

```bash
export LWB_DSH_HOME="$PWD/lwb/local/verification/dev/dsh-home"
export LWB_PACK_REGISTRY="$PWD/lwb/local/verification/dev/packs.json"
npm run dev -- --port 4174
```

后续注册测试包的 CLI 命令也应在设置了这些变量的终端运行。测试实例需要自行配置模型与媒体服务；结束后停止实例并处理测试数据。不要将这些目录加入 Git。

## 代码放在哪里

| 路径 | 职责 |
|---|---|
| `lwb/profile/` | 工作台基础运行组合 |
| `lwb/dsh-bundle/` | 工作台壳、包生命周期、工作区和服务 |
| `lwb/pack-sdk/` | 包清单校验、注册和作用域接口 |
| `lwb/packs/` | 独立业务包；目前仅有 `spoken-video` |
| `scripts/setup-upstream.mjs` | 获取和构建锁定的 DSH |
| `docs/` | 当前指南、开发契约及历史记录 |

工作台核心应保持通用，场景页面、业务数据和任务流程放在包内。新包参考[开发入门](docs/develop-a-pack.md)，不要复制个人模型凭据或现有运行数据。

`vendor/deepseek-harness` 是上游 checkout，不属于产品改动区。通过公开插件接口扩展 DSH；上游升级遵循[升级流程](lwb/upgrade/README.md)，不要在 vendor 中留下未记录的业务补丁。

## 验证

```bash
npm run check
npm run profile:check
npm run pack:profile-check
npm run unit:test
```

也可以用 `npm test` 一次运行上述检查。`npm run dsh:dump` 可查看展开的运行配置，输出分享前应检查是否包含本机信息。

测试应覆盖变更的实际行为。界面改动需要人工检查相关页面，包生命周期改动应验证加载、卸载与重新加载。真实模型、媒体供应商和平台依赖需要单独验收，并在 PR 中注明哪些环节实际运行、哪些仅用了测试替身。纯文档改动检查命令、链接和描述是否与代码一致即可。

## 提交 Pull Request

PR 目标分支为 `main`。描述应说明解决的问题、用户可见行为、相关测试结果，以及数据或配置是否需要迁移。尽量保持一次 PR 解决一个主题；行为变化时同步更新当前指南，不只追加历史记录。

提交前确认没有包含 `lwb/local/`、`.env`、`vendor/`、`node_modules/`、媒体生成物或个人路径。不要为不相关的改动重写锁文件。

贡献代码遵循项目 [MIT License](LICENSE)。引入第三方代码、技能、字体、音频或图片时，应记录可核验的来源、版本、许可和必要署名，更新[第三方说明](THIRD_PARTY_NOTICES.md)；不要假设素材自动受本项目许可证覆盖。
