# DSH Upgrade Workflow

`vendor/deepseek-harness` 是 `lwb/UPSTREAM.lock.json` 指定 commit 的无源码修改 checkout。LWB 业务代码只位于 `lwb/`；不要为产品需求改写 vendor。

先查看公开 refs：

```bash
./lwb/upgrade/check-upstream.sh
```

升级流程：

0. **首次获取并构建上游**用 `npm run setup`（`scripts/setup-upstream.mjs`）：

   ```bash
   npm run setup
   ```

   它负责克隆 → fetch → checkout 锁定 commit → 安装 → 构建。首次安装与升级
   后的重建走的是同一套 corepack/shim 机制（`corepackEntry()` 拿 corepack.js
   绝对路径用 node 跑、`pnpmShimEnv()` 让嵌套 spawn 找得到 pnpm、`CI=true`），
   并在 checkout 之后核对 vendor HEAD 与 `lwb/UPSTREAM.lock.json` 的 `commit`
   是否一致——不一致直接退出。Windows 上不能直接 spawn 裸 `corepack`
   （无扩展名脚本 + `.cmd` 都认不出来，实测 ENOENT），也不能裸跑 `pnpm run build`
   （上游 `build:lib` 会再 spawn 一次 `pnpm`）。

   两个脚本的分工：**`npm run setup` 是入口**（拿上游 + 装 + 构建，一步到位）；
   `scripts/dsh-upgrade-build.mjs` 只负责「vendor 已在本地、已切到目标 commit」
   之后的重复安装/构建，不做 clone 与 checkout。
1. 新建升级分支并选择一个精确 commit；不要直接跟踪 `main` / `master`。
2. 在干净临时 clone 中运行 `CI=true corepack pnpm install --frozen-lockfile` 与 `CI=true corepack pnpm run build`。
   在 Windows 上嵌套 spawn 找不到 `pnpm`（上游 `build:lib` 会再 spawn 一次 pnpm），用仓库脚本代替裸命令：

   ```bash
   node scripts/dsh-upgrade-build.mjs install
   node scripts/dsh-upgrade-build.mjs build
   ```

   该脚本会先核对 vendor HEAD 与 `lwb/UPSTREAM.lock.json` 的 `commit` 是否一致，不一致直接退出——构建错基座比构建失败更难查。
3. 更新 vendor checkout 和 `UPSTREAM.lock.json`；若本地有旧 `lib/`、`.dsh-build/` 或已删除 package 的忽略产物，移至临时备份后重新构建，绝不编辑 DSH 源码迁就它们。
4. 只在 LWB Bundle/Profile 中处理公开 API 变化，随后运行 `npm run test`、`npm run dsh:dump` 与浏览器验收。
5. 人工确认普通对话、工作区、归档和文件附件保持可用。

如果以后确实需要 vendor 修改，先判断能否通过 LWB Plugin seam 完成；不能时才新建一份独立、可审查、可上游化的补丁。
