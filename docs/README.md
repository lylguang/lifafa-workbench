# 文档索引

老傅工作台通过可动态加载的场景能力包扩展业务，口播视频内容创作是第一个已实现的业务包。以下区分当前使用/开发指南与历史设计记录，避免把过渡方案当作当前操作说明。

## 使用工作台

| 文档 | 内容 |
|---|---|
| [项目首页](../README.md) | 产品定位、扩展机制、安装与当前能力 |
| [快速开始](quickstart.md) | 从安装、模型配置到第一条口播视频 |
| [故障排查](troubleshooting.md) | 安装、鉴权、包加载、模型和媒体问题 |
| [运行数据目录](31-runtime-data-layout.md) | 状态、凭据、附件、业务产物及可恢复副本 |
| [第三方组件与资源](../THIRD_PARTY_NOTICES.md) | 来源、许可边界及待补充的出处记录 |

## 开发与扩展

| 文档 | 内容 |
|---|---|
| [贡献指南](../CONTRIBUTING.md) | 开发环境、验证、Issue 与 PR |
| [能力包开发入门](develop-a-pack.md) | 最小独立包与注册、加载、卸载 |
| [总体架构](01-architecture.md) | 工作台与 DSH、业务包的职责边界 |
| [能力包契约](12-capability-packs.md) | 清单、host/client 贡献及当前口播流程 |
| [工作区与执行作用域](29-pack-owned-workspaces.md) | 生命周期、默认模型复用、任务及凭据隔离 |
| [统一执行详情](32-execution-details.md) | 业务任务与 DSH 原生会话展示 |
| [上游锁定](08-base-lock.md) | 运行时版本、构建和回滚边界 |
| [升级流程](../lwb/upgrade/README.md) | 更新 DSH 的步骤 |
| [产品层目录](../lwb/README.md) | 源码结构与宿主实现 |
| [本地增强说明](36-local-enhancements.md) | 本分支相对上游的改动清单、根因与实测结论 |

## 历史设计与验收记录

下面保留产品演进过程，用于理解设计背景，**不作为首次安装或当前功能说明**。其中的旧版本、`.lwb/` 路径、`file:test` 命令、个人参考工程和测试数量只代表记录时状态。当前命令见贡献指南，运行数据以目录契约为准；文中未提交的截图或私人参考项目不是构建依赖。

- [11 LWB 工作台壳](11-lwb-workbench-shell.md)
- [13 信号板设计（Signal Board）](13-signal-board.md)
- [14 口播视频全链路推进分析](14-spoken-video-full-pipeline.md)
- [15 信号板视觉设计（指挥中心）](15-signal-board-visual.md)
- [16 信号模块梳理分析（人工与导入 / AI 内容日报 / 平台情报）](16-signal-module-analysis.md)
- [17 选题模块梳理分析（账号定位 + 渠道最新批次 · DSH 统一执行）](17-topic-module-analysis.md)
- [18 信号模块调整方案：双链路分治（无兼容版）](18-signal-module-restructure-plan.md)
- [19 写稿模块分析（P2 规则质检 + P3 AI 起稿 · 合并实施）](19-script-module-analysis.md)
- [20 信号页视觉美化分析与方案（命令条 + 信号卡片重塑）](20-signal-page-visual-polish-plan.md)
- [21 信号模块简化分析：去掉信号卡工程动作、来源设置与手动导入入口](21-signal-module-simplification-analysis.md)
- [22 账号模块分析（去版本号显示 + 账号卡片重塑）](22-account-module-analysis.md)
- [23 选题模块重设计分析（账号 Tab 化 + 表单简化 + 任务卡/抽屉交互）](23-topic-module-account-tabs-analysis.md)
- [24 写稿模块 UI 重设计分析（对齐选题页：账号 Tab + 选题选择器抽屉 + 任务卡 + 稿件工作台）](24-script-page-ui-redesign-analysis.md)
- [25 发布 / 入队模块设计与实施记录（发布包装 Agent + 封面生图 + 单一生命线抽屉）](25-publish-module-analysis.md)
- [26 发布模块简化：视频货架 + 单一发布资料抽屉（连根删除批准/入队/导出）](26-publish-module-simplification.md)
- [27 内容安排模块重设计分析（定时全自动流水线）](27-content-schedule-module-analysis.md)
- [DSH 0.1.6 升级与文件上传验收](28-dsh-016-upgrade.md)
- [UI 巡检与使用就绪评估](30-ui-audit-and-readiness.md)
- [产品默认配置审计](32-product-defaults-audit.md)
- [视频工程预检与修复](33-video-preflight-repair.md)
- [34 账号 Tab 一致性（2026-09-17）](34-account-tabs-consistency.md)
- [口播视频：配音、发布与内容安排交互细节](35-spoken-video-workflow-details.md)
- [配音、字幕与视频的衔接](audio-video-handoff.md)
