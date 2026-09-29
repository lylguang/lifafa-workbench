# 15 信号板视觉设计（指挥中心）

> 历史设计/验收记录，包含当时的方案与限制，不作为当前使用指南。当前入口见[文档索引](README.md)和[快速开始](quickstart.md)。

> **状态（2026-09-02）**：用户提出"普通用户仅凭观感就要觉得酷炫"的目标，经两个提案对比后选定「指挥中心」方向并已落地到 `lwb/packs/spoken-video/client.js`。本文记录视觉决策与验收截图位置。

## 修订记录

- **2026-09-02**：落地指挥中心首屏、流水线轨道、卡片热度条；亮/暗双主题真实页面验证通过。

## 1. 目标

首屏要在第一眼传递"这是一个实时运行的内容情报中心"，而不是表单集合。观感优先级高于信息密度；所有装饰必须双主题成立、零新依赖。

## 2. 已落地元素

| 元素 | 形态 | 关键类 |
|---|---|---|
| 指挥中心首屏 | 深色渐变岛（径向光斑 + 深海军蓝），白色大标题，四个半透明统计大字 | `.sv-signal-hero` `.sv-hero-stat` |
| 实时状态 | 呼吸灯圆点 + 「实时采集中 · 每 30 秒巡检」胶囊，采集时切换为「正在采集…」 | `.sv-live-pill` `.sv-live-dot`（`sv-pulse` 动画） |
| 主/次按钮 | 深色底上白主按钮、玻璃描边幽灵按钮 | `.sv-hero-primary` `.sv-hero-ghost` |
| 项目流水线 | 九阶段轨道：完成=蓝✓、当前=绿+光晕、待办=描边数字；连接杆完成态染蓝；节点可点击跳转对应阶段菜单 | `.sv-pipeline*`，跳转经 `openPackMenu` 的阶段→菜单映射 |
| 来源卡片 | 顶部 3px 热度条（蓝→绿渐变；异常=红；人工/导入=紫），悬浮抬升 + 阴影 + 边框提亮 | `.sv-board-card`（`::before` + hover transform） |
| 提示条 | `sv-note/sv-error/sv-warn-list` 增加暗色适配，避免深色主题下出现刺眼浅色块 | `body[data-ds-dark-theme]` 覆盖 |

## 3. 双主题策略

- 亮色：hero 用高对比"暗岛"（Linear/Stripe 式手法），其余沿用 `--lwb-*` 浅色 token。
- 暗色：`body[data-ds-dark-theme] .sv-signal-hero` 换更深的底色与收敛光斑；统计、按钮、轨道、卡片全部走 `--lwb-*` 变量自动适配。
- 不引入外部字体、图标库或图片资源；动画只用 CSS（呼吸灯、悬浮过渡）。

## 4. 非目标

- 不改壳层（`dsh-bundle/client.js`）样式与导航；视觉升级限定在能力包页面内。
- 不做玻璃拟态亮色首屏（提案 B，否决）、不铺满渐变背景。

## 5. 验收截图

位于 `.workbuddy/ui-shots/`：`light-hero.png`、`dark-hero.png`、`pipeline.png`、`light-cards.png`、`dark-cards.png`。

关联文档：[信号板设计](./13-signal-board.md)、[全链路推进分析](./14-spoken-video-full-pipeline.md)。
