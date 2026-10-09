---
name: whiteboard-animation
description: 把 SRT 字幕做成暖米黄纸张底的白板手绘动画。读字幕出分镜策略 → 生成统一风格线稿 → 按叙事语义标注分区（区域坐标 + 出场时间 + 对应字幕）→ 预览台调整 → 渲染 MP4 → 多幕合并。编排沿用分区遮罩揭示（annotation.json / sequence / startMs / protectedRegions），区域内落墨为连续笔迹（骨架/网格 ink→color）。当用户提供字幕并要求"字幕做成白板手绘""SRT 生成白板动画""按字幕分镜画手绘""白板手绘视频"时触发。
metadata:
  tags: whiteboard-animation, srt, hand-drawn, remotion-alternative, mp4
---

# 白板手绘动画

把 SRT 字幕转成白板手绘视频。**编排**用分区遮罩揭示：按叙事顺序逐区域出场，未开始的区域完全隐藏，交叠主体用 `protectedRegions` 保护。**画法**用流式笔迹：每个区域在自己的允许掩码内，笔尖沿骨架/网格连续滑行落墨（起笔 ink → 添彩 color），所有区域共享一张持久画布，画完的保留在画布上。

与逐格跳变或矩形擦除不同，这里的笔迹是连贯流动的；与整图一次性绘制不同，这里按字幕叙事分区依次作画，能控制每个元素的出场顺序与时序。

所有面向用户的说明、分镜、配置和界面文字使用中文。

## 引擎位置

本包自带打过补丁的渲染引擎，位于本包目录下的 `engine/`：

```text
engine/
  scripts/
    parse_srt.py                    # 字幕解析 + 动态规划分幕
    plan_timeline.py                # 字幕时间轴 → 标注骨架（元素 startMs 查表）
    render_annotation_preview.py    # 区域编号检查图
    render_stream_whiteboard.py     # 整合渲染器（mask 编排 + stream 画法）
    stream_render.py                # 笔迹引擎（被上面引用）
    merge_scenes.py                 # 多幕合并
    prepare_env.py                  # 依赖环境准备
  assets/
    drawing-hand.png                # 笔杆无文字的绘制手部
    drawing-hand-branded.png        # 上游原始素材（带作者标识，仅供溯源）
    preview.html                    # 本地预览台
  PATCHES.md                        # 相对上游的修复清单
```

上游 `geeklee/srt-whiteboard-animation` 自发布后未再更新，已知缺陷的修复停留在未合并的社区 PR 里，因此引擎以 vendor 副本形式随包分发，补丁内容见 `engine/PATCHES.md`。

## 环境准备

引擎依赖 OpenCV、NumPy、Pillow，首次使用先准备隔离环境：

```bash
python engine/scripts/prepare_env.py --check   # 探测；成功末行输出 ENV_PY=<路径>
python engine/scripts/prepare_env.py           # 缺则建 .venv 并安装依赖
```

后续渲染统一用该解释器（下称 `<ENV_PY>`）。ffmpeg 存在时优先用它转 H.264，否则退回 PyAV；两者都没有会保留 mp4v 并告警。

## 工作流

每一步完成后**停止并等待用户明确确认**再进入下一步。"未回复""此前的笼统授权""用户没有反对"都不算确认。用户要求修改某一步时，只重做该步，完成后再次等待确认。

1. **读字幕、出策略**（不生成图片）。用 `parse_srt.py` 解析 SRT 并分幕，据此输出配图策略：每幕的场景编号、核心表达、画面主体、对应字幕区间与 `sceneDurationMs`。每幕只表达一个核心意思。**完成后停止，等待确认策略。**
2. **生成线稿**。按下面的"统一出图视觉规范"逐幕生成 16:9 暖米黄旧纸张底线稿。**完成后停止，展示线稿并等待确认。**
3. **标注并打开预览台**。先阅读该图对应的字幕、再实际查看图片、并获取原图像素宽高；不得只凭字幕臆测画面，也不得只按画面位置机械排序。提炼字幕叙事事件，把图中可见主体对应到事件，按"场景铺垫 → 关键人物/物体 → 动作冲突或变化 → 反应/结果"排序。

   用 `plan_timeline.py` 把这一幕的字幕时间轴分配给元素，直接得到带正确 `startMs` / `durationMs` / `subtitle` 的标注骨架：

   ```bash
   python engine/scripts/plan_timeline.py <字幕.srt> --scene 1 \
       --elements "假山与小猴" "大猴抢香蕉" "小朋友围观" \
       --width 1672 --height 941 --output scene-01.annotation.json
   ```

   元素数多于字幕条数时，同一句字幕会被多个元素共享——一句话里讲到多个元素是常态，这些元素应依次出场。骨架里的 `region` 是等分占位值，**必须看图后拖到实际主体上**：时间是查表得来的，坐标只能看图确定。

   随后创建 `<图片名>.annotation.json` 并立即用浏览器打开 `engine/assets/preview.html` 载入该目录。**载入后停止，等待确认标注。**
4. **生成区域预览图**。用 `render_annotation_preview.py` 出编号/方向检查图，核对分区与叙事顺序一致、区域都在画布内、重叠主体已用 `protectedRegions` 保护。**完成后停止，等待确认。**
5. **在预览台调整并保存**。可拖区域四边四角改 `region`，改名称/方向/开始(ms)/结束(ms)与字幕，拖动模块列表调整顺序（自动重排 `sequence`），拖时间轴看揭示。改完点"保存本场景/全部保存"写回原 `.annotation.json`。**保存后停止，等待确认最终标注与时序。**
6. **渲染成片**。逐幕渲染 MP4，抽查开场、重叠模块中段、结尾三个时间点。**完成后停止，等待确认成片。**
7. **多幕合并**（仅多幕项目）。用 `merge_scenes.py` 按顺序合并。**完成后停止，等待确认最终视频。**

## 与口播管线对接（本工作台专属）

本包与「口播视频内容创作」包的配音字幕阶段可直接衔接。口播包产出的是**经过时间轴守卫校正的 SRT**（`spoken-video-subtitle-align.mjs`：能量 VAD + 发音字符占比铺排 + 本地 ASR 锚点校正），时间戳已对齐真实音频。

对接方式：

- 从口播项目的字幕产物（`media/subtitles/*.srt`）取 SRT 作为本流程第 1 步的输入。
- 每幕的 `sceneDurationMs` 直接取该幕字幕跨度，不要另行估算。
- 每个区域的 `reveal.startMs` / `durationMs` 对齐到该区域对应字幕的起止时间，并把字幕文本写进 `element.subtitle`。这样"第几秒画哪个元素"来自字幕时间轴查表，而不是凭感觉猜秒数。

这条链路是相对通用做法的关键增量：Agent 拿不到语音时间轴时只能猜秒数，容易造成画面超前或滞后；这里每个区域的出场时间是显式写在 JSON 里、可在预览台拖拽微调的。

## 默认实现参数

| 项目 | 默认要求 |
|---|---|
| 纸张背景 | 生成图使用暖米黄旧纸色 `#F5EBD7`；渲染时从原图四角内缩取样染底，禁止纯白。 |
| 画法 | 每区域连续笔迹：起笔 `ink`（铺线稿）→ 添彩 `color`（还原原色）；权重 `ink:color = 2:1`。 |
| 笔迹路径 | `--ink-path grid`（网格，默认，稳）或 `skeleton`（骨架追踪，线稿清晰的插画更贴合）。 |
| 上色风格 | `--color-fill contour-wipe`（轮廓扫描，默认）或 `brush`（沿轨迹刷）。 |
| 未绘制区域 | 允许掩码 = 矩形 `region` 扣除「后续区域 + protectedRegions」；未开始区域完全隐藏。 |
| 时长来源 | 每幕 `sceneDurationMs` 来自该幕字幕跨度（建议 25–35 秒/幕）。 |
| 绘制手部 | 内置素材笔杆无文字，可直接用于商业成片；需要自己的标识时用 `--pen-text`。 |

## 统一出图视觉规范（强制）

所有场景的源图必须遵循同一套视觉语言；生成前把要求完整写入出图提示词，生成后逐条检查：

- **风格与构图：** 极简手绘插图、纯素描草图风格、类似 Notion 的克制涂鸦美学。以概念表达为主，不追求写实；构图简洁、背景干净、大量留白，系列内线条/人物/配色一致。
- **颜色与材质：** 米色纸张背景 `#F5EBD7`、深灰色草图线条；仅可用红色、橙色、蓝色作少量概念性点缀。不得使用其他强调色、高饱和度配色或复杂纹理。
- **人物与对象：** 对象以简洁轮廓、少量线条和留白表达，强调关系/变化/核心概念，而非真实比例、材质与细节。
- **绝对禁止：** 场景源图中的任何文字、词语、字母、数字、字体或标签；写实感、摄影细节、3D 效果、绘画质感；复杂场景、密集背景、繁复装饰和高饱和度画面。

纸张背景必须用 `#F5EBD7`：渲染器把原图背景染成画布底色（`#F6F1E3`）靠的是颜色差异阈值，实测推荐纸色与画布色的三通道差为 19，低于阈值 28 能正常替换；偏黄的纸色（如 `#FAEDCF`，差 28）会卡在阈值边界，导致上色阶段与未绘制区域出现轻微底色接缝。

## 语义排序与像素级标注（必须执行）

1. **阅读依据：** 标注前必须同时具备字幕与已查看的原图。缺任一项先索取。
2. **顺序依据：** `sequence`、`startMs` 与 `label` 必须反映字幕中的事件先后，而非仅按从左到右、从上到下或视觉显眼程度。
3. **坐标依据：** 每个模块输出原图坐标系的整数像素 `x`、`y`、`width`、`height`；原点左上角，禁止百分比/比例/估算坐标或省略尺寸。`canvas.width`/`canvas.height` 必须等于原图像素尺寸。
4. **模块字段：** 每个元素含 `sequence`、`narrativeRole`、`subtitle`、`region`、`reveal`、`handPath`。`narrativeRole` 用中文说明其在字幕中的叙事作用；`subtitle` 存该区域对应的字幕文本；`sequence` 从 1 起连续。
5. **校验：** 渲染器会在出片前校验坐标越界、非整数、缺字段等问题并一次报出全部，按提示修正即可。

## 时序模型

- 每幕总时长 `sceneDurationMs` 来自该幕字幕跨度。
- **区域串行作画：** 同一幕内各区域应在时间上依次进行，`startMs` 不重叠；下一区域从上一区域 `startMs + durationMs` 开始（可加 100–300ms 呼吸）。
- **区域内 ink→color：** 每区域 `durationMs` 按 `ink:color = 2:1` 切成起笔段和添彩段。`durationMs` 由预览台的开始/结束时间决定（结束−开始），可对齐该区域对应字幕的时长。
- **凝视收尾：** 全部区域画完后自动补到 `sceneDurationMs`，并保证结尾至少停留 0.5 秒完整原图。
- `reveal.direction` 在 stream 画法下不决定真实笔迹（笔迹由骨架/网格自动生成），仅供预览台的矩形代理演示。

## 遮罩不变量（必须执行）

- 在时间 `t`，模块仅可显示其 `reveal.startMs ≤ t` 之后、且不超过当前作画进度的像素；未开始模块的任何线条/填充/图像都不得出现。
- 每个区域的允许掩码 = 矩形 `region` 扣除全部后续模块的 `region`，再扣除本模块 `reveal.protectedRegions`。落墨被限制在允许掩码内，因此后续区域不会提前露线。
- `protectedRegions` 用与 `region` 相同的原图整数像素坐标，用于矩形过大、主体交叠或背景线条可能泄露的情况。

## 配置示例

```json
{
  "sceneId": "scene-01",
  "canvas": { "width": 1672, "height": 941 },
  "storyBasis": "该幕字幕的事件摘要",
  "sceneDurationMs": 9000,
  "elements": [
    {
      "id": "rockery",
      "label": "假山场景",
      "sequence": 1,
      "narrativeRole": "故事的场景铺垫",
      "subtitle": "猴子山上，一只小猴子坐在假山顶端，手里拿着香蕉。",
      "type": "structure",
      "region": { "x": 20, "y": 120, "width": 540, "height": 780 },
      "reveal": { "direction": "top_to_bottom", "startMs": 300, "durationMs": 2600, "maskPaddingPx": 22, "protectedRegions": [] },
      "handPath": { "start": [290, 130], "end": [290, 890], "easing": "easeInOut" }
    }
  ]
}
```

`direction` / `handPath` 仅供预览台矩形代理使用；成片笔迹由引擎自动生成。

## 常用命令

```bash
# 解析字幕 + 分幕建议（stdout 是 JSON，stderr 是人类可读摘要）
python engine/scripts/parse_srt.py <字幕.srt> --target-sec 30 --min-sec 25 --max-sec 35

# 字幕时间轴 -> 标注骨架（元素 startMs 来自字幕 cue，不是估计值）
python engine/scripts/plan_timeline.py <字幕.srt> --scene <幕号> \
  --elements "元素1" "元素2" ... --width <原图宽> --height <原图高> [--output <标注.json>]

# 区域编号检查图
python engine/scripts/render_annotation_preview.py <图片> <标注> <预览图输出>

# 渲染单幕
<ENV_PY> engine/scripts/render_stream_whiteboard.py <图片> <标注> <输出.mp4> \
  [--ink-path grid|skeleton] [--color-fill contour-wipe|brush] [--total-ms <毫秒>] \
  [--pen-text "笔杆文案"]

# 多幕合并
<ENV_PY> engine/scripts/merge_scenes.py --inputs 幕1.mp4 幕2.mp4 --output final.mp4
```

渲染器末行输出 `OUTPUT=<路径>`，便于上层捕获。

## 目录约定

```text
assets/whiteboard/<项目名>/
  scene-01-<名称>.png
  scene-01-<名称>.annotation.json     # 与 png 同名
  scene-01-<名称>-whiteboard.mp4      # 成片
```

图片与配置必须同名：`foo.png` 对应 `foo.annotation.json`，预览台据此自动加载。

## 性能与资源

- 纯 CPU 计算，不需要 GPU 或联网。
- 实测 1080×600、8.6 秒成片（516 帧 @60fps）耗时约 27 秒，约 19 帧/秒；3 分钟成片约需 9–10 分钟。
- 预览或调试时可加 `--cap-long-edge 640` 显著加速。

## 质量检查

渲染前/后确认：

- 首帧为干净的暖米黄旧纸张底，没有提前露出的线条。
- 已阅读对应字幕并实际查看原图；`canvas` 与原图像素尺寸一致，所有 `region` 为画布内的整数像素坐标。
- `sequence`、`startMs` 与字幕事件顺序一致；预览图编号/标签/区域来自同一份标注 JSON。
- 在开场、任意重叠模块中段、所有模块完成后三个时间点检查：未绘制模块均不可见，重叠保护区不漏出，最终帧显示完整原图。
- 笔尖贴近正在推进的笔迹；线稿清晰的插画可用 `--ink-path skeleton` 让笔迹更贴合。
- 所有模块结束后停留至少 0.5 秒完整原图。
- 多幕合并后顺序、时长与字幕分镜一致。

如需修改效果，先在预览台调整标注（区域/顺序/时序）并保存，再命令行渲染，不要凭空反复出片。
