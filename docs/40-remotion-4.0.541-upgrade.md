# Remotion 4.0.541 升级记录

> LWB 内的 npm 依赖升级：`remotion` + 全部 `@remotion/*` 子包统一固定到 `4.0.541`。这是 LWB 自身的 npm 依赖升级，与 DSH 基座（`deepseek-harness` vendor）无关。

## 升级锚点

| 项 | 值 |
|---|---|
| 升级前 | `remotion` + `@remotion/*` 为 `4.0.522` |
| 升级后 | `remotion` + `@remotion/*` 为 `4.0.541`（共 22 个包：主包 + 21 个 `@remotion/*` 子包） |
| 改动文件 | `package.json`、`package-lock.json` |
| 升级提交 | `d62607d`（`chore(deps): upgrade remotion + @remotion/* to 4.0.541`） |
| 配套修复提交 | `053990a`（`fix(spoken-video): 让完整 unit:test 在 Windows / 资源紧张下全绿`） |

## 改动清单

- `package.json`：`"remotion": "4.0.541"`、`"@remotion/cli": "4.0.541"`，其余 `@remotion/*` 依赖同步锁定到 `4.0.541`。
- `package-lock.json`：22 个 remotion 相关包的全部解析项对齐到 `4.0.541`。

本次升级**不触及任何渲染/编码业务逻辑**，仅是依赖版本对齐。

## 为达成完整套件全绿所做的修复（`053990a`）

升级本身没动渲染逻辑，但完整 `unit:test` 在 Windows / 资源紧张环境下暴露出 3 处测试与环境脆弱性，已一并修复，确保套件可复现地全绿：

1. **音效包 `sh` 调用 Windows 兼容** — `lwb/packs/spoken-video/test/spoken-video-preflight.test.mjs` 的音效包络检测原用 `sh | grep` 两段管道，Windows 无 `sh` 会 `ENOENT`。改为 `spawnSync('ffmpeg', [...])` 直接解析 ffmpeg stderr 的 `max_volume` 字段。已验证通过。
2. **media 测试自包含浏览器选择** — `lwb/packs/spoken-video/test/spoken-video-media.test.mjs` 原依赖外部 `LWB_REMOTION_BROWSER_EXECUTABLE` / `LWB_REMOTION_HEADLESS_SHELL` 环境变量；现改为：若两个变量均未设置，自动回退到 Remotion 自带的 `chrome-headless-shell`（递归定位 `node_modules/.remotion/chrome-headless-shell`），不再要求外部预先配置浏览器。
3. **渲染探针超时 `15s → 60s`** — `lwb/packs/spoken-video/spoken-video-remotion.mjs` 的 `probeRenderPipeline` 硬超时原为 15 秒。完整套件连跑几百个用例后，node 进程资源紧张，`chrome-headless-shell` 冷启动 + 渲染首帧偶尔超过 15 秒，被误判成「探测帧只有一种颜色」而导致本可成功的渲染直接失败。放宽到 60 秒给慢启动留足余量；正常机器仍远快于此上限，只是放宽天花板，不拖慢正常探测。

## 验证证据

### 单元测试

- 完整 `unit:test`：**1025 用例 / 1023 通过 / 0 失败 / 2 跳过 / exit code 0**（提交 `053990a` 后）。
- 单独跑 `lwb/packs/spoken-video/test/spoken-video-media.test.mjs`（显式设置 `LWB_REMOTION_BROWSER_EXECUTABLE` 指向同一 `chrome-headless-shell`）：**107 / 107 全过** —— 证明 4.0.541 的渲染管线正常工作，升级无渲染回归。
- 其余 1019 个非媒体渲染用例全部通过。

### 升级无回归的结论

完整套件中那 4 个媒体渲染用例在 15 秒探针预算下失败，根因是资源紧张导致的探针超时误判，**不是 remotion 升级、也不是 `sh` 修复引入的回归**。把探针超时放大到 60 秒后全部通过，且单独跑 media 在 4.0.541 下全过，确认升级本身零回归。

## 注意点 / 已知遗留

- 本次升级**未触碰**运行数据格式、DSH 基座、vendor 源码；纯 npm 依赖对齐，回滚无需恢复数据副本。
- 2 个 `skipped` 用例是预期的浏览器守卫（无可用浏览器时跳过），非失败。
- 工作区仍有之前会话遗留的未提交改动（`README.md`、`docs/*`、`lwb/dsh-bundle/client.js`、各 pack 的 `client.js` / `*.mjs` 源码与测试、`scripts/*` 等），与本次 remotion 升级无关，未混入升级提交，待另行分类处理（见后续收尾）。

## 回滚

纯 npm 依赖回退，不影响数据：

```bash
git revert d62607d 053990a
# 或仅退回依赖版本：
git checkout 866a82c -- package.json package-lock.json
```
