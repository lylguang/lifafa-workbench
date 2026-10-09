# 引擎来源与本地补丁

上游：`geeklee/srt-whiteboard-animation`（MIT，commit `696a7243`，2026-07-27 首次发布）
本目录是 vendor 副本。上游自发布后未再更新，已知缺陷的修复仍停留在未合并的社区 PR 里，
因此这里直接落在源码上。

## 补丁清单

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | `scripts/render_stream_whiteboard.py` `_lay_ink` 调用 | 多传一个 `None`，参数个数不匹配。**区域允许掩码内无墨迹时必崩** —— 而区域重叠（后画区域覆盖先画区域）正是这套设计的正常用法，实测稳定复现 | 删除多余参数 |
| 2 | `scripts/render_stream_whiteboard.py` | 渲染前零输入校验：坐标越界被静默裁剪照常出片、百分比/浮点坐标渲染中途才崩、缺 `reveal` 抛裸 KeyError | 新增 `_validate_annotation()`，出片前一次报出全部问题（越界、非整数、缺字段、宽高非正、duration 为 0、id 重复、protectedRegions 越界） |
| 3 | `scripts/parse_srt.py` `group_scenes` | 贪心分幕只在"达到 target"时断幕，末幕可能只剩几秒（总长 40s 会切出 32s + 8s），中间也会被 max 挤出一段短幕 | 改为动态规划全局切分，短幕在规划阶段就不产生；仅在字幕总长本身不足时保留短幕并提示 |
| 4 | `scripts/render_annotation_preview.py` | 中文字体写死 `C:/Windows/Fonts/msyh.ttc`，macOS/Linux 上必抛 `OSError`，工作流第 4 步完全走不通（上游 issue #2/#5/#8 均报此问题） | 按平台探测候选字体，都找不到退回 Pillow 内置字体 |
| 5 | `scripts/render_annotation_preview.py` | 标签胶囊宽度用 `len(label) * 19` 估算，中英文字宽不同导致长标签冲出白底 | 改用 `draw.textlength()` 实测宽度 |
| 6 | `assets/drawing-hand.png` | 上游素材笔杆印着作者品牌「江哥是老登啊」，**默认参数渲染的每一帧都带这行字**，商用会带上他人标识 | 生成无文字笔杆版本作为默认素材（见下），原文件保留为 `drawing-hand-branded.png` |
| 7 | `scripts/render_stream_whiteboard.py` | 上游缺少自定义笔杆文案能力（对应未合并 PR #7） | 新增 `--pen-text`，按笔杆实际轴向写入文案 |
| 8 | `scripts/prepare_env.py` | 无条件新建 `.venv` 并安装全部依赖。实测在缺少国内镜像的机器上装 `opencv-python` 会拖很久（本机跑了 35 分钟仍未完成）；而系统 Python 通常已具备这些库。另外把 PyAV 当作必需依赖，但它在系统有 ffmpeg 时根本用不到 | 先探测当前解释器，必需依赖齐全就直接复用；`av` 移入可选依赖，仅在没有 ffmpeg 时提示 |

## 新增（上游没有的能力）

| 文件 | 能力 | 理由 |
|---|---|---|
| `scripts/plan_timeline.py` | 把一幕的字幕时间轴分配给元素，产出带正确 `startMs` / `durationMs` / `subtitle` 的标注骨架 | 上游要求 Agent"把区域 startMs 对齐到字幕"，但没有给出工具，Agent 只能凭感觉填秒数。这个脚本把分配变成查表：时间来自 SRT 的实际 cue 边界。元素多于字幕条数时同句字幕被多个元素共享（一句话讲多个元素是常态）；`region` 留等分占位值，必须看图后拖到实际主体上 |

## 无文字笔杆的生成方式

`assets/drawing-hand.png` 由 `drawing-hand-branded.png` 处理而来，步骤可复现：

1. 取笔杆掩码（亮且低饱和的细长大连通域），用 flood fill 补上被文字占据的内部孔洞，得到笔杆实体
2. 用距离变换取笔杆内部（距边界 > 4px），排除笔杆自身的黑色描边
3. 对内部灰度 < 200 的像素（即品牌文字）做 `cv2.inpaint` 结构感知填充
4. 沿笔杆中心做加权平滑，压掉修补纹理并保留原有高光渐变

实测笔杆内部深色像素从 10843 降至 188，成片尺寸下不可见。若需重新生成，参考
`--pen-text` 的笔杆定位逻辑（旋转 50.11° 后笔杆水平）。

## 与上游的差异摘要

- 渲染器：更严格的输入校验、`--pen-text`、默认素材无品牌
- 字幕解析：动态规划分幕
- 检查图：跨平台字体、标签宽度自适应

上游 `SKILL.md` 中关于"笔杆标识可保留"的条款已移除——默认素材本身不再带标识。
