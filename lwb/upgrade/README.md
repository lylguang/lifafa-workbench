# DSH Upgrade Workflow

`vendor/deepseek-harness` 是 `lwb/UPSTREAM.lock.json` 指定 commit 的无源码修改 checkout。LWB 业务代码只位于 `lwb/`；不要为产品需求改写 vendor。

先查看公开 refs：

```bash
./lwb/upgrade/check-upstream.sh
```

升级流程：

1. 新建升级分支并选择一个精确 commit；不要直接跟踪 `main` / `master`。
2. 在干净临时 clone 中运行 `CI=true corepack pnpm install --frozen-lockfile` 与 `CI=true corepack pnpm run build`。
3. 更新 vendor checkout 和 `UPSTREAM.lock.json`；若本地有旧 `lib/`、`.dsh-build/` 或已删除 package 的忽略产物，移至临时备份后重新构建，绝不编辑 DSH 源码迁就它们。
4. 只在 LWB Bundle/Profile 中处理公开 API 变化，随后运行 `npm run test`、`npm run dsh:dump` 与浏览器验收。
5. 人工确认普通对话、工作区、归档和文件附件保持可用。

如果以后确实需要 vendor 修改，先判断能否通过 LWB Plugin seam 完成；不能时才新建一份独立、可审查、可上游化的补丁。
