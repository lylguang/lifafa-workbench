# DSH 0.1.6-alpha.2 升级记录

> 升级记录，记录本次基座升级的破坏性变更、LWB 适配与验收证据。当前锁定版本见[基座锁定](08-base-lock.md)，升级步骤见[升级流程](../lwb/upgrade/README.md)。

核验日期：2026-11-07。升级分支：`chore/dsh-upgrade-alpha2`。

## 升级锚点

| 项 | 值 |
|---|---|
| 原基座 | `dsh-v0.1.6-alpha.1` / `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d` |
| 新基座 | `dsh-v0.1.6-alpha.2` / `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| 锁定文件 | `lwb/UPSTREAM.lock.json`（`checkedAt: 2026-11-07`） |
| vendor 源码改动 | 无 |

`vendor/deepseek-harness` 是无源码修改的 checkout，适配全部落在 `lwb/` 内。

## 破坏性变更：Session 控制器从「暂存模型」改为「所有权模型」

### 上游改动

alpha.2 重写了会话控制面，`ISessions` 的职责从「打开一个会话供后续读取」改成「显式保留 / 释放」：

| 项 | alpha.1 | alpha.2 |
|---|---|---|
| 打开会话 | `ISessions.open(id)` 返回一个暂存句柄 | 取消；改为 `retain()` / `using()` / `retainInfo()` 显式保留 |
| 当前会话 | `SessionListState.current` / `currentAddress` | 移除；当前会话由 `SessionSummary.retainedBy` 的来源→计数映射推导 |
| 取会话句柄 | 暂存句柄直接可用 | `binding()` 只返回**已保留**的一代会话，未保留则返回 undefined |
| 队列镜像 | `packages/api/session-controller/src/client/sessions/queue-mirror.ts` | 删除；改由 `projections.faceOf('inbox')` 投影（`packages/api/session-controller/src/client/sessions/session.ts:173`、`packages/client/ui-conversation/src/client/input/hub.ts:95`） |

上游自己的「当前会话」判定在 `packages/client/ui-workspace/src/client/tree.ts:42-44`：

```ts
Object.values(list.byId).find((s) => (s.retainedBy.mainView ?? 0) > 0)?.id
```

`mainView` 是 `SessionReferenceSource` 的一个合法取值：`packages/client/ui-session/src/client/index.ts:181-185` 通过声明合并把它加进了 `SessionReferenceSourceMap`；`workspaceOperation` 同理（`packages/client/ui-workspace/src/client/index.ts:54`）。

同时「导航归视图所有者」：`packages/client/ui-workspace/src/client/navigation.ts` 提供 `openSession` / `openWorkspace` / `forkSession` / `startSession` / `connectWorkspace` / `archiveSession` / `unarchiveSession` / `pickDirectory`，由视图侧发起导航，host 不再替会话列表决定当前项。

上游自己怎么重命名会话，是这次适配最直接的对照（`packages/client/ui-workspace/src/client/index.ts:115-122`）：

```ts
const result = await sessions.using(
  sessionId,
  { source: 'workspaceOperation' },
  reference => reference.binding.session.rename(title),
)
if (!result.ok) throw new Error(result.error.message)
```

`{ ok, error }` 不是 `using()` 自己的返回形状，而是 `SessionFace.rename()` 的返回类型 `RemoteResult<{ title: string; seq: SessionSeq }>`（`packages/typert/protocol/src/types.ts:75-77`、`packages/api/session-controller/src/client/contract/session.ts:119`）：`using()` 原样返回回调的值。

### 症状

升级后 LWB 会话侧栏出现四个用户可见故障，host 侧无报错：

1. 点会话行后仍停在首屏 hero「探索未至之境」，对话视图不切换——`showConversation` 只改了产品页状态，没让 DSH 真正切会话。
2. 当前会话行不高亮——依赖已被删除的 `SessionListState.current`。
3. 重命名报「未找到此会话」——`binding()` 只认已保留的会话，直接取句柄拿到 undefined。
4. 分叉会话无反应/落到错误会话。

### LWB 适配

全部落在 `lwb/dsh-bundle/client.js`：

- 切会话走视图所有者的导航接口，而不是自己改状态：

  ```js
  function showConversation(sessionId) {
    // DSH v0.1.6-alpha.2 取消了 ISessions.open()，导航归视图所有者：
    // 必须走 uiWorkspace.openSession 才会真正切换 DSH 会话视图。
    if (sessionId) services?.uiWorkspace?.openSession?.(sessionId);
    updateProduct({ page: 'conversation', capabilityPage: null, mobileNavOpen: false, conversationPanelOpen: false }, false);
  }
  ```

- 当前会话改为按 `retainedBy.mainView` 推导（与上游 `tree.ts` 同源），并同时驱动空会话过滤、工作区归属与 `data-active` 高亮：

  ```js
  const currentSessionId = Object.values(sessions.byId || {})
    .find((item) => (item?.retainedBy?.mainView ?? 0) > 0)?.id;
  ```

- 重命名先用 `sessions.using` 取得保留引用，再调 `binding.session.rename`：

  ```js
  result = await services.sessions.using(
    dialog.sessionId,
    { source: 'workspaceOperation' },
    (reference) => reference.binding.session.rename(title),
  );
  ```

- 分叉优先走 `uiWorkspace.forkSession`，失败才回退 `sessions.fork` + `uiWorkspace.openSession`。

回归测试见 `lwb/dsh-bundle/test/client-style-contract.test.mjs`（新增 5 条：切换走 `uiWorkspace.openSession`、当前会话按 `retainedBy.mainView` 推导、重命名走 `sessions.using` + `source: 'workspaceOperation'`、分叉走 `uiWorkspace.forkSession`、client.js 与各 pack client 中不再出现 alpha.1 的会话 API）。

## 破坏性变更：Typert strict codec 契约改为惰性工厂

### 上游改动

- `packages/typert/protocol/src/types.ts` 的 `TypertCodec`：strict 分支的 `readonly schema: TypertSchema` 改为 `readonly create: () => TypertSchema`。schema 对象不再直接挂在 codec 上，而是由 `create()` 在进程内首次使用边界时物化。
- `packages/typert/registry/src/service.ts` 的 `validateCodec()`：strict codec 缺 `create()` 时抛 `typert: <subject> strict codec has no create() factory`。
- `packages/typert/loader/src/index.ts` 的 `requireStrictCodec()`：同一要求，错误信息为 `typert-loader: <pkg> <subject> has no create() factory`。

### 症状

浏览器端报 `web boot: 2 entries did not activate`。失败的是 `@scitiger-ai/lwb-spoken-video` 与 `@scitiger-ai/lwb-manual-script-video` 两个能力包。该错误由 `packages/client/web/src/boot-client.ts` 的 `assertEntriesActive()` 抛出——它把没有成功激活的 client entry 逐条列出。host 侧没有任何报错：失败发生在 client entry 的 fiber 上（`packages/boot/app-boot/src/index.ts` 的 `activationDiagnostic()` 只把 optional 条目的失败降级成 warning 行）。

### LWB 适配

`lwb/packs/spoken-video/client.js` 与 `lwb/packs/manual-script-video/client.js` 的 `followExecution` 描述符：

```js
// alpha.1
codec: { mode: 'strict', typeSymbol: '...#ExecutionRequest', schema: { parse(...) { ... } } }
// alpha.2
codec: { mode: 'strict', typeSymbol: '...#ExecutionRequest', create: () => executionRequestSchema() }
```

### 语义变化：浏览器侧不再由上游执行入参 parse

alpha.2 的 Gateway client 面删掉了 `parseInput()`。alpha.1 的 `packages/api/gateway/src/client/index.ts` 在 `prepareInvocation` 里走 `args[projection.wire] = parseInput(...)`；alpha.2 同一处是 `args[parameter.wire] = value`，直接赋值。也就是说这份 strict codec 在浏览器侧不再有上游替我们校验的等价物。

strict 模式本身必须保留：`packages/api/gateway/src/client/index.ts` 的 `requireStrictInputs()` 只放行 `mode: 'strict'`，改成 `mode: 'src-json'` 会在 `$mount` 时被 `requireStrictCodec()` 拒绝。

因此 LWB 在调用点显式跑同一份 schema：`executionRemote.followExecution(sessionRequest, signal)` 之前先 `executionRequestSchema().parse(sessionRequest)`，保持 alpha.1 下「入参非法时调用前就失败」的业务行为不变。schema 实例惰性创建并缓存（`executionRequestSchemaValue`），因为 `create()` 契约要求的是工厂，重复物化会得到不同对象。

## alpha.2 其他变更中经评估对 LWB 无影响的项

| 上游变更 | LWB 现状 | 结论 |
|---|---|---|
| Typert schema contribution 的 `schema` → `create`（`packages/typert/loader/src/index.ts` 要求 `manifest.schemas` 的每项带 `create()`） | LWB 未提供 `TYPERT.schemas` manifest 条目 | 不受影响 |
| `TypertClientContextAdapter.resolve()` 可返回 `TypertOwnedValue<Context>`（`packages/typert/protocol/src/types.ts`） | LWB 未注册 client context adapter | 不受影响 |
| bundle factory 的 `require` 新增 `.async()`（`packages/client/modules/src/client/system.ts`） | LWB 全用同步 `require`（`lwb/dsh-bundle/client.js` 顶部取 React 与 `dsh-client-ui-primitives`） | 兼容 |
| `app-boot` profile 重构（移除 `patchReload` 字段与 `watchUserPatches()`；alpha.1 的 `DEFAULT_PROFILE_PATCH_RELOAD = 'live'` 让自定义 profile 也保留用户 patch 热加载，alpha.2 取消这一档） | LWB 的 `lwb/profile/cordis.patch.yml` 是空 patch 数组，且 LWB 不依赖 patch 文件热重载 | 兼容（patch 仍在启动时读取并应用） |
| `ui-slots` 新增 Component Factory（`packages/client/ui-slots/src/index.ts` 的 `registerFactory`） | LWB 只用 `ctx.slots.inject(...)` + `ctx.slots.register(...)`（`lwb/dsh-bundle/client.js`） | 兼容 |

## 验收证据

### 构建与静态检查

- `CI=true corepack pnpm install --frozen-lockfile`（在 `vendor/deepseek-harness`）：成功，约 4 分 18 秒。
- `CI=true corepack pnpm run build`：成功，输出 `build: recorded 248 client artifact(s) with 2 public value(s)`。
- `npm run check`：通过。
- `npm run profile:check`：通过，`LWB three-module Profile smoke passed (8 rows)`。
- `npm run pack:profile-check`：通过，`LWB static capability-pack Profile smoke passed`。

### 单元测试

`npm run unit:test`：996 用例，994 通过，0 失败，2 跳过。

升级中期跑出的 2 个失败（`lwb/packs/spoken-video/test/spoken-video-schedule.test.mjs` 的「云端配音时本地 TTS 引擎不可用不阻断」与「本地配音时引擎不可用仍然阻断」）在最终树上不再出现：单跑该文件为 72 用例、72 通过、0 失败。

这两个用例是**环境依赖**的，不是基座相关：它们把 `environment` 传成 `{ LWB_PREFLIGHT_MEMORY_FLOOR_MIB: '1' }` 这个全新对象，因此 `LWB_MEDIA_BRIDGE_URL` 覆盖不生效，`runPreflight` 总是去探测真实桥接 `http://127.0.0.1:8199`。桥接不可达时，`runPreflight` 走的是「桥接不可达」分支，压根不会产出 `engine.tts` 检查项，`assert.ok(engine, '引擎项总会被检查')` 因此失败。升级中期跑测试时桥接进程不在，2 个用例失败；最终复跑时桥接在跑（`netstat` 可见 8199 LISTENING），2 个用例通过。用 `LWB_MEDIA_BRIDGE_URL` 指向一个死端口复现，确认 `engine.tts` 检查项直接消失。

结论：这 2 个用例的通过与否取决于本机桥接是否在跑，**不能作为基座升级的验收依据**。已记为待修的测试卫生问题（见下）。

`npm run test`（全量，996 用例）与 `npm run unit:test` 结果一致：994 通过 / 0 失败 / 2 跳过。`npm run dsh:dump` 通过。

### 浏览器实测

能力包加载：

- alpha.1 对照环境（同一份 LWB 代码 + alpha.1 基座）：4 个能力包全部正常加载。
- alpha.2 升级后、修复前：`@scitiger-ai/lwb-spoken-video` 与 `@scitiger-ai/lwb-manual-script-video` 两个包 client entry failed，对应 `web boot: 2 entries did not activate`。
- 按上文改用 `create: () => executionRequestSchema()` 后：4 个能力包全部加载，浏览器 console 零错误。

`docs/08-base-lock.md` 升级规则第 3 步要求的人工验证，在 alpha.2 上逐项实测通过：

| 验收项 | 操作 | 结果 |
|---|---|---|
| 普通对话 | 在输入框发送「测试回复测」 | `session/prompt` 返回 `{"accepted":true}`，模型回复「收到，测试回复正常 ✅」，console 零错误 |
| 文件附件 | 上传 `attach-test.txt`（42 字节）后发送 | 附件出现在输入区轨道；Agent 从 `lwb/local/dsh-home/attachments/v1/files/.../attach-test.txt` 读取并回显原文「DSH alpha.2 attachment verification / line2」 |
| 工作区 | `workspace/create` 注册 `lwb/local/ws-test-dir` | 返回 `created:true`，侧栏出现「ws-test-dir」；`workspace/delete` 返回 `deleted:true`，清理完毕 |
| 归档 | 对「你好问候会话」执行归档 | 归档数 2→3，会话从常规历史移入「已归档会话」列表 |
| 归档恢复 | 对归档会话执行「恢复到工作区「lifafa-workbench」」 | `lwbArchives/restore` 返回 `{"restored":true}`，归档数 3→2，工作区会话数 7→8 |

四个能力包的页面均单独打开验证过，渲染真实数据、console 零错误：口播视频内容创作（制作流水线，17/13/3/15/25 分档）、手动稿件成片（写稿，6 篇稿件库）、发布与账号管理（账号与发布记录）、数据看板（概览，来源 2/2 个账号）。

会话所有权模型修复后的逐项实测（alpha.2 + 本次改动）：

| 验收项 | 操作 | 结果 |
|---|---|---|
| 切会话 | 点侧栏「请用一句话介绍你自己」 | 首屏 hero「探索未至之境」消失，对话视图切换到该会话；该行 `data-active="true"` |
| 重命名 | 会话菜单 → 重命名 → 改名 → 保存名称 | 标题即时变为新名，**不再报「未找到此会话」** |
| 分叉 | 会话菜单 → 分叉会话 | 新会话「… (1)」出现并被选中，工作区会话数 7→8 |
| 归档 | 分叉出的会话 → 归档会话 → 确认 | 从常规历史移入「已归档会话」，归档数 3→4 |
| 还原 | 把原会话改回原名 | 标题还原成功 |

浏览器 console 全程零错误。

**alpha.2 没有公开的会话删除接口**——上游 API 目录（`packages/extensions/tool-cordis/src/api-catalog.ts`）里 `ctx.remote.session` 命名空间只有 `list` / `search` / `create` / `selectModel` / `openWorkspacePath` / `rename` / `fork` / `prompt` / `attachment` / `updateQueue` / `cancel` / `page` / `follow` / `control`，`ctx.sessions` store 只有 `create` / `prepare` / `enter` / `announce` / `flush` / `get` / `list` / `fork`，没有 `delete`。因此上面归档掉的分叉会话无法从产品界面删除（上游自己的「已归档会话」设置页同样只提供恢复）。这是上游能力边界，不是 LWB 的缺陷。

### 升级脚本

`npm run setup`（`scripts/setup-upstream.mjs`）此前是**坏的**：`run('corepack', ...)` 用 `shell: false` spawn 裸 `corepack`，而 Windows 上 `corepack` 是无扩展名 shell 脚本 + `corepack.cmd`，Node 两者都认不出来——实测 `spawn('corepack', ['pnpm','--version'])` 直接 `ENOENT`。同时它缺 `CI=true`、缺 pnpm 垫片（上游 `pnpm run build` 内部再 spawn `pnpm` 会失败）、缺 vendor HEAD 守卫。

修复后 install/build 统一走 `scripts/pnpm-shim.mjs` 的 `runPnpm()`（corepack.js 绝对路径 + `pnpmShimEnv()` 垫片 + `CI=true`），HEAD 守卫统一走 `scripts/vendor-lock.mjs` 的 `compareVendorHead()`。实测 `node scripts/setup-upstream.mjs` 全程跑通：install `Already up to date`，build 输出 `build: recorded 248 client artifact(s) with 2 public value(s)`，结束于 `DeepSeek Harness ddefc45fbc7f8e46dd73185e68295696d1297887 is ready.`，无 ENOENT。

### 定位方法

用 `git worktree` 建 alpha.1 对照环境做 A/B 对照（同一份 LWB 代码，只换 vendor 基座），而不是靠猜。alpha.1 侧的 `packages/typert/protocol/src/types.ts` 是 `readonly schema: TypertSchema`、`packages/api/gateway/src/client/index.ts` 有 `parseInput()`；alpha.2 侧分别是 `readonly create: () => TypertSchema` 和 `parseInput` 已删除。两处差异与症状直接对应。

## 已知遗留

本次升级后**未**处理的问题，按性质分两类。

### 与基座无关，但会误导验收

1. **两个预检用例依赖本机媒体桥接**——`lwb/packs/spoken-video/test/spoken-video-schedule.test.mjs` 的「云端配音时本地 TTS 引擎不可用不阻断」与「本地配音时引擎不可用仍然阻断」。它们把 `environment` 整体替换成 `{ LWB_PREFLIGHT_MEMORY_FLOOR_MIB: '1' }`，所以 `LWB_MEDIA_BRIDGE_URL` 覆盖不生效，永远探测真实的 `127.0.0.1:8199`；桥接不在时 `runPreflight` 走「桥接不可达」分支，压根不产出 `engine.tts` 检查项，用例因此失败。修法是让这两个用例注入一个假的桥接 URL（或注入 `probeJson`），把环境依赖从用例里摘掉。

### 与基座相关，等真正要升 rc.2 时再处理

见[本地增强说明](36-local-enhancements.md)的「升级边界」一节——那里记了三处 rc.2 才出现的阻塞点（`settings-file` 被删且 `installSection` API 消失、Session 日志 v3→v4、`settings.yaml` 被改名为 `settings.yaml.imported` 导致 `lwb/dsh-launcher.mjs` 的首次拷贝每次启动都重复执行）。在当前 alpha.2 基座上这三处都还不存在。

另外 `dist/delivery/` 是 gitignored 的交付产物，其中还留着 alpha.1 时期的 `lwb/UPSTREAM.lock.json`（`dsh-v0.1.6-alpha.1` / `0a15e36e...`）与旧版文档。发布前需要重跑 `npm run delivery:build` 重新打包。

## 回滚

回滚到 alpha.1 的精确 commit `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`：

1. `git -C vendor/deepseek-harness checkout --detach 0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`，重建 vendor（`CI=true corepack pnpm install --frozen-lockfile` 与 `pnpm run build`）。
2. 回退 LWB 侧 `client.js` 的 codec 改动：`create: () => executionRequestSchema()` 改回 `schema: { parse(...) }`，同时移除调用点的显式 parse。
3. `lwb/UPSTREAM.lock.json` 的 `tag` / `commit` / `checkedAt` 改回 alpha.1 对应值。

本次升级未改动运行数据格式：Session 日志版本、能力包工作区 `data/` 布局、附件存储位置均不变，因此回滚不需要恢复数据副本。仍应按[基座锁定](08-base-lock.md)的要求在升级前备份 `lwb/local/` 与 DSH Home。
