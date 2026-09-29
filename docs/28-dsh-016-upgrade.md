# DSH 0.1.6 升级与文件上传验收

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> 历史升级记录。2026-09-16 已按用户要求重置数据并移除旧上传适配器及历史附件包装逻辑；当前实现见 [31 运行数据目录](31-runtime-data-layout.md)。下文兼容策略描述升级当时的状态。

核验日期：2026-09-15。升级分支：`codex/upgrade-dsh-0.1.6`。

## 版本与构建

- 原基座：`dsh-v0.1.2-alpha.1`，`cd5ef8148158c3a752a658978873241fdf8e2bbc`。
- 新基座：`dsh-v0.1.6-alpha.1`，`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`。
- 环境：macOS arm64、Node 22.23.2、上游 pnpm 11.7.0。
- 在不含旧依赖和构建产物的独立 checkout 中安装、构建；`CI=true corepack pnpm install --frozen-lockfile` 与 `CI=true corepack pnpm run build` 均成功。最终 `vendor/deepseek-harness` 源码 Git 状态干净。
- 锁定文件、README、基座文档已同步。上游仍是 alpha 版本，其他平台尚未在本次核验。

## 是否移除 LWB 文件上传

结论：新上传默认交给 DSH，停用 LWB 自有上传入口与发送拦截；保留旧附件记录展示及旧适配器源码，不做历史数据删除。

上游依据（均为上述精确 commit）：

- `packages/attachment/attachment/README.md`：普通文件按原始字节存储，模型通过只读路径按需读取。
- `packages/client/file-upload/src/index.ts`：流式上传、会话范围内的上传回执与消息绑定。
- `packages/client/ui-attachment/README.md`：混合图片/文件卡片、上传进度、失败重试、移除与历史展示。
- `apps/web/tests/file-upload-round.e2e.ts`：上游维护普通文件上传、混合附件消息持久化和真实 read 工具读取的测试。本次读取其源码，未单独执行这套上游 Web 测试。

LWB 默认 Profile 已设置 `fileIntake.mode: native`、`nativeAvailable: true`。原生模式下不安装 LWB 的 Session prompt 拦截器，旧图片回调与旧文件卡片也不接管原生上传。旧 `lwb-file-attachments` 消息展示代码继续保留，工作区 `.lwb/uploads/` 不能因升级而删除。

原生文件不受旧 LWB 20 MiB 上限约束，也不自动垃圾回收。文件存于 DSH Home 而非工作区；备份时必须包含 DSH Home。上传 PDF、Office 文件只代表文件可被工具读取，不等于内置所有格式的解析器。媒体能力包上传音色、背景音乐、封面是独立业务功能，不受本次对话附件切换影响。

## 代码适配

1. 设置 API：移除 `settingsNamespace` / `installSettingsSection` 旧导出依赖，使用字符串 namespace 和 `ctx.settings.installSection()`，声明 settings 注入依赖。
2. 归档恢复：使用 `workspaceRegistry.unarchiveSession()` 公开方法，不再读写内部状态。
3. 新用户能力包加载：修复市场登记后丢失 `available` 标志的问题；补测卸载后通过市场重新加载。
4. Profile smoke：使用隔离 DSH Home，校验原生 file-upload、ui-attachment 以及默认 native 策略。
5. 渲染环境：可通过 `LWB_REMOTION_BROWSER_EXECUTABLE` 指定已安装的 Chrome/Chromium。首次测试超时定位为 Remotion 尚未下载渲染浏览器，不是模型或 DSH 调用超时；指定本机 Chrome 后完整测试 240/240 通过。随后完成 Remotion 默认 Chrome Headless Shell 下载，不设置浏览器覆盖变量再次运行 `npm test`，240 项全部通过、无跳过（约 19.5 秒）；包含语法检查、两组 Profile smoke 和业务测试。

## 实际页面与服务验证

测试服务使用独立 DSH Home、能力包登记表和 `/tmp` 工作区，监听 14173；未重启或迁移用户原有服务的数据。

- 页面显示老傅工作台，Host 无插件激活失败。
- 创建测试工作区与会话成功。
- 浏览器原生选择并上传 TXT 和约 21 MiB 文件，待发送卡片展示正确名称与大小；移除大文件成功。
- 小文件随用户消息持久化，重载页面、重启测试服务后仍显示附件卡片。
- 磁盘证实文件写入测试 DSH Home 的 `attachments/v1/files/` 与 `file-objects/`，没有通过 LWB 工作区上传目录写入。
- DOM 核对：一个 file input，零个 `.lwb-file-intake-button`，无重复入口。
- 真实 API 完成归档与 LWB 恢复，恢复后归档集合为空。
- 能力包首次加载成功，八个菜单正常显示，重启测试服务后自动恢复。

隔离环境没有配置模型密钥。带附件消息已接收并持久化，但模型调用明确返回 `MISSING_CREDENTIAL`；本次没有宣称真实云模型读文件或付费媒体服务已端到端通过。测试通过也不等同于旧用户数据迁移、全部图片格式和 Windows/Linux 平台已验收。

## 使用与数据升级

新 checkout：

```bash
npm ci
npm run setup
npx --no-install remotion browser ensure # 仅视频功能需要
npm run dev -- --port 4173
```

当前机器已完成安装和构建，下次启动会使用新基座。现有服务需要停止后重新启动才会运行新版。现有用户升级前应停止服务，备份完整 DSH Home（默认 `lwb/local/dsh-home/`）、`lwb/local/packs.json` 与各工作区 `.lwb/`。会话格式升级到 v3 后，回滚应恢复整套升级前的数据副本，不能仅回退基座版本。

原有内容安排业务改动、开源准备与基座升级按独立提交维护。本地合并不包含远端推送或公开发布。
