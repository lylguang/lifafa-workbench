# LWB Product Profile

`lwb/` 是锁定 DeepSeek Harness checkout 之外的产品层。LWB 通过 DSH Profile、Cordis Bundle 和浏览器模块扩展官方运行时，不维护另一套聊天服务。

## 基础版

默认 Profile 装配：

- DSH `base + web-app`；
- DSH 原生文件附件与 LWB 会话归档扩展；
- LWB 三模块浏览器壳；

用户可见导航只有“对话”“场景能力包”和“设置”。普通对话仍是 DSH Session；场景能力包由市场目录和本机安装表组合。“设置 → 系统设置”打开完整的 DSH 原生设置面板，管理语言、外观、模型服务、权限、插件和 Agent 预设等；能力包内部会话复用 DSH 默认模型及认证，无需单独配置 AI 模型连接。

| 路径 | 职责 |
|---|---|
| `UPSTREAM.lock.json` | 精确的上游 tag / commit 锁定 |
| `profile/` | 受跟踪的 DSH Profile manifest |
| `dsh-bundle/archive-gateway.mjs` | DSH 公开归档模型未覆盖的窄恢复接缝 |
| `dsh-bundle/remote-settings-gateway.mjs` | 非回环内网浏览器的模型设置兼容策略 |
| `dsh-bundle/client.js` | 对话、场景能力包和设置的浏览器壳 |
| `pack-sdk/` | 第三方场景能力包的 manifest 与 host 注册契约 |
| `pack-manager.mjs` | 本机能力包目录、安装状态与命令 |
| `packs/` | 可独立安装的场景能力包源码 |
| `upgrade/` | 上游检查和升级流程 |

## 场景能力包

基础 Profile 不直接装配具体领域包。仓库随附的口播包会自动出现在市场，首次需手动加载。使用 `npm run pack:install -- <包目录>` 将一个符合契约的外部包源登记到被忽略的 `lwb/local/packs.json`，使其出现在市场中；登记默认不启用。工作台市场加载包后会把它记为启用，使其在后续启动时自动恢复；卸载会取消该状态。加载和卸载均会在当前页面更新浏览器模块与菜单。`npm run pack:remove -- <包 id>` 只删除登记，不会删除包源码或工作区数据。

当前仓库仅提供 `packs/spoken-video/`，包含口播视频内容创作的账号定位、信号、选题、写稿、配音/字幕、视频/预览、发布资料和内容安排页面。新增业务可以继续以独立包接入；开发步骤见[能力包开发入门](../docs/develop-a-pack.md)，详细契约见[场景能力包文档](../docs/12-capability-packs.md)。

每个能力包加载后自动拥有专属工作区，无需创建普通对话。卸载保留目录、数据和连接配置；详情页提供分开的“清空业务数据”和“解除工作区注册”操作。见[专属工作区说明](../docs/29-pack-owned-workspaces.md)。

## 运行数据

默认所有持久化运行数据统一位于 `lwb/local/`：原生附件在 `dsh-home/attachments/`，口播数据在 `dsh-home/profiles/lwb/pack-state/workspaces/spoken-video/data/`。不再创建 `.lwb/` 或普通工作区上传目录；信号采集和内容安排只读取专属工作区，不维护跨工作区索引。测试夹具使用可清理的独立临时目录。详见[目录契约](../docs/31-runtime-data-layout.md)。

## 更新策略

`vendor/deepseek-harness` 必须保持源码 Git 工作树干净。LWB 业务逻辑应位于此目录；不要修改 vendor。

升级 DSH 时，在独立分支中选定精确 commit，在干净临时 checkout 安装和构建，更新 lock，适配 LWB 接缝，并执行 `npm run test` 和浏览器验收。详见[升级说明](upgrade/README.md)与[基座文档](../docs/08-base-lock.md)。

### 内网设置兼容策略

Profile 默认使用 `remoteSettings.mode: auto`。在非回环地址访问时，LWB 仅在 DSH 官方设置镜像明确返回 `unavailable` 且没有视图时，使用已认证的 `settings.describe` 读取补齐模型设置镜像；如果未来 DSH 官方支持非回环设置，官方视图会自动优先，兼容读取不会重复执行。可在 Profile 配置中临时选择 `compat`（强制兼容桥接）或 `disabled`（完全交给 DSH）。

这段代码不修改 DSH vendor、不伪造 `isLoopback`，也不开放远程文件/文档能力。升级 DSH 后如果官方镜像已覆盖非回环场景，验收通过后可将模式切换为 `disabled`，确认无兼容调用后删除 `remote-settings-gateway.mjs` 及客户端对应控制器。
