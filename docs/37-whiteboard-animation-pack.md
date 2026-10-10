# 37 白板手绘动画能力包

`lwb/packs/whiteboard/` 是继口播视频内容创作、对标拆解之后的第三个场景能力包，包名 `@scitiger-ai/lwb-whiteboard`。加载后贡献一个「白板手绘动画」菜单组，包含两个页面：

- **场景**：新建项目、解析字幕给出分幕建议、查看各幕标注概况。
- **渲染**：准备引擎环境、逐幕渲染 MP4、多幕合并。

## 能力边界

把 SRT 字幕做成暖米黄纸张底的白板手绘动画。核心主张是**用字幕的叙事顺序驱动绘制顺序**——字幕讲到哪个元素，哪个元素才出场。

两层设计：

- **编排层（mask）**：每个元素是一个矩形 `region`，带 `sequence` 与 `reveal.startMs`。区域的允许作画掩码 = 自己的 `region` 扣除「所有后续区域的 `region`」再扣除 `protectedRegions`。纯几何减法实现出场顺序，不需要语义分割，后画的区域不会提前露线。
- **画法层（stream）**：在允许掩码内，笔尖沿骨架/网格连续滑行落墨（`ink` 铺线稿 → `color` 还原原色，权重 2:1），所有区域共享一张持久画布。

## 线稿生成（2026-10-01 接入，同日修正两处实测问题）

视频页选「白板手绘」后出现**线稿准备面板**，补上白板产线最后一环——线稿从哪来。面板按「状态 → 操作 → 网格」三段布局：

1. **状态行**：共 N 幕 · 已有 M 张 · 生图引擎状态（本机桥接 /health 实时探测）
2. **操作行**：「生成缺失线稿」批量补齐 /「全部重新生成」/ 进度实时显示（分镜师阶段与逐幕生成阶段分开提示）
3. **网格**：每幕一张卡片——幕号、时间跨度、320px 缩略图（host 端 PIL 压制并缓存在 `.thumbs/`，plan 一次带回，浏览器不拉原图）、字幕摘要、单张「重新生成本幕」

技术要点：

- **旁白 → 视觉描述转换层（关键）**：旁白原文绝不能直接喂给生图模型——Qwen-Image 是渲染文字的专家模型，给它长中文旁白会把整段文字「手写」进画面（首次实测全部翻车）。现在由 DSH 分镜师（结构化执行器 `spoken-video-whiteboard-line-art`）把每幕旁白转成 25–40 词的英文画面描述（具体主体 + 动作关系 + 简单布局），生图只消费视觉描述。描述缓存在 `media/whiteboard/descriptions.json`，键含稿件与字幕的产物版本，任一更新自动重算；LLM 缺幕时兜底描述也不带旁白文本。
- **生图通道**：本机媒体桥接（默认 `http://127.0.0.1:8199`，env `LWB_WHITEBOARD_BRIDGE_URL` 可覆盖）→ ComfyUI 8187 → Qwen-Image。桥接新增可选 `parameters.negative_prompt` / `parameters.seed`（向后兼容；注意模板 cfg=1 下负面词不参与采样，防文字靠正面提示词约束 + 人工确认）。
- **提示词**：固定英文视觉规范前缀（`#F5EBD7` 纸底、深灰线、禁文字、极简留白）+ 分镜师的英文画面描述。实测 40 秒/张，12 张全部无文字、内容对应分镜、风格统一。
- **种子策略**：按幕号固定（`lineArtSeed`），同幕重生成结果稳定，跨幕种子不同避免画面雷同。
- **进度机制**：生成是 host 内存 job（不入 runs 列表），前端每 2 秒轮询 `whiteboardLineArtStatus`，完成自动重拉 plan 刷新缩略图。host 重启丢 job 不丢文件——磁盘就是状态。
- **文件约定**：`media/whiteboard/scene-NN-story.png`（自动生成）/ `scene-NN.png` 或 `scene-NN-*.png`（手工放置均可），渲染分支按幕号精确匹配，缺幕报错具体到幕号。
- 生成是「可失败的资产准备」，刻意不塞进渲染 run：一张废图不值得重跑 7 分钟渲染；缩略图人工确认对应白板 skill 的线稿确认关卡。

同日修正的两处实测问题：

1. **字幕顶在画面上半部**：libass 默认 PlayRes 是 384×288，`MarginV=180` 按该坐标系换算等于距底 62%。改为 `MarginV=30`（≈距底 10%），字幕落到常规底部位置。
2. **分镜师接入的三处接线缺陷**（均为首测抓出）：media host 构造函数漏收 `lineArtPlanner`；`whiteboardLineArtStatus` 签名漏了 agent 参数导致轮询恒 idle；`normalizeLineArtPlan` 用 `sceneIndex` 对齐而 host 传的是 plan items 的 `index`，LLM 结果被整体丢弃走了含旁白的兜底。

改动位置：`media-bridge/bridge.mjs`（negative_prompt/seed）、`spoken-video-whiteboard-art.mjs`（新模块：提示词组装、分镜师提示词与 schema、桥接调用）、`spoken-video-media-host.mjs`（plan/start/status 三个 RPC、描述缓存、缩略图、字幕边距）、`client.js`（线稿准备面板与分阶段提示）、`index.mjs`（分镜师执行器接线）。

## 作为口播包的制作方式（2026-10-01 接入）

白板动画已接入「口播视频内容创作」包的视频制作阶段，成为与 Remotion 并列的制作方式。用户在「视频 / 预览」页选择"制作方式 → 白板手绘"后，整条链路不再需要跨包手动衔接：

```text
口播包项目（稿件 → 配音 → 字幕）
  → parse_srt 分幕（每幕 25–35 秒）
  → 逐幕渲染白板动画（线稿取自项目 media/whiteboard/）
  → merge 合并
  → ffmpeg 合成配音音轨 + 规格化 1920x1080 / 1080x1920、30fps
  → 沿用口播包既有的技术质检与独立审片流程
```

要点：

- **配音字幕是必需输入**。字幕时间轴是「第几秒画哪个元素」的唯一依据（与 Remotion 路径同一原则：即使不烧录字幕也必须有字幕产物）。配音音轨在合成阶段 mux 进成片——白板引擎本身只输出无声视频流。
- **线稿约定**：项目 `media/whiteboard/` 下每幕一张 `scene-*.png`（16:9，暖米黄纸底 `#F5EBD7`，画面不出现文字）。分幕数由字幕决定，线稿不足时任务失败并明确提示需要几张。
- **标注可省略**：线稿同名 `.annotation.json` 存在则直接使用；缺省时调用引擎的 `plan_timeline.py` 自动生成骨架——出场时间精确对齐字幕 cue，区域为等分占位（精调可在白板包预览台完成或手工放置标注文件）。
- **QC 规格对齐**：合成时把画面 scale+pad 到口播包 QC 要求的精确尺寸（pad 色用白板纸底 `#F6F1E3`，避免黑边），输出 30fps；末幕时长自动对齐配音结尾，保证与配音时长差落在 QC 的 2 秒线内。
- 跨包调用方式：口播包的媒体主机直接以子进程调用白板包 `engine/` 里的 Python 脚本（路径可用 `LWB_WHITEBOARD_ENGINE_ROOT` 覆盖）。白板引擎对用户不可见地复用，不需要用户再进白板包操作。

改动位置：`spoken-video-media.mjs`（renderer 白名单）、`spoken-video-media-host.mjs`（`#renderWhiteboardVideo` 分支）、`spoken-video-store.mjs`（video artifact 的 whiteboard 元数据）、`client.js`（制作方式选择与确认文案）。

## 与口播管线的衔接（脚本级，保留）

本包与「口播视频内容创作」包的配音字幕阶段衔接。口播包产出的是经过时间轴守卫校正的 SRT（`spoken-video-subtitle-align.mjs`：能量 VAD + 发音字符占比铺排 + 本地 ASR 锚点校正），时间戳已对齐真实音频。

对接方式：该 SRT 作为「解析字幕」的输入；每幕 `sceneDurationMs` 取该幕字幕跨度；每个区域的 `reveal.startMs` / `durationMs` 对齐到对应字幕起止，字幕文本写入 `element.subtitle`。

这条链路是相对通用做法的关键增量：Agent 拿不到语音时间轴时只能猜秒数，容易造成画面超前或滞后；这里每个区域的出场时间是显式写在 JSON 里、可在预览台拖拽微调的。

## 引擎来源与补丁

引擎是 `geeklee/srt-whiteboard-animation`（MIT，3.8k star）的 vendor 副本，位于包的 `engine/`。上游自 2026-07-27 首次发布后未再更新，已知缺陷的修复仍停留在未合并的社区 PR 里（7 个 open issue、4 个 open PR，维护者零回应），因此直接落在源码上。完整清单见 `engine/PATCHES.md`：

| # | 问题 | 处理 |
|---|---|---|
| 1 | 区域允许掩码内无墨迹时 `_lay_ink` 参数不匹配必崩 —— **区域重叠正是这套设计的正常用法**，实测稳定复现 | 删除多余参数 |
| 2 | 渲染前零输入校验：坐标越界被静默裁剪照常出片、百分比/浮点坐标渲染中途才崩、缺 `reveal` 抛裸 KeyError | 新增 `_validate_annotation()`，出片前一次报出全部问题 |
| 3 | 贪心分幕会切出短幕（总长 40s → 32s + 8s） | 改为动态规划全局切分 |
| 4 | 检查图脚本中文字体写死 Windows 路径，macOS/Linux 必崩 | 按平台探测候选字体 |
| 5 | 标签胶囊宽度用字符数估算，长标签冲出白底 | 改用实测文字宽度 |
| 6 | 默认手部素材笔杆印着上游作者品牌「江哥是老登啊」，**默认参数出的每一帧都带这行字** | 生成无文字笔杆版本作为默认素材，原文件保留溯源 |
| 7 | 缺少自定义笔杆文案能力 | 新增 `--pen-text` |

第 6 条是商用前提：上游素材的笔杆标识是作者的美术作品与商标性标识，与 MIT 代码许可是两回事。默认素材替换后可直接用于商业成片；需要自己的标识时用 `--pen-text`。

## 数据位置

项目与标注位于能力包专属工作区的 `data/` 下：

```text
data/projects.json                      # 项目索引
data/projects/<project-id>/
  scene-01-<名称>.annotation.json       # 标注（与图片同名）
  out/scene-01-<名称>-whiteboard.mp4    # 成片
```

标注文件同时写在项目目录，便于用浏览器打开 `engine/assets/preview.html` 后「打开文件夹」直接载入。

## 性能

纯 CPU 计算，不需要 GPU 或联网。实测 1080×600、8.6 秒成片（516 帧 @60fps）耗时约 27 秒，约 19 帧/秒；3 分钟成片约需 9–10 分钟。调试可用 `--cap-long-edge 640` 显著加速。

## 首次使用

在「渲染」页点「准备环境」，会在包内创建隔离的 `.venv` 并安装 OpenCV、NumPy、Pillow。ffmpeg 存在时优先用它转 H.264，否则退回 PyAV，两者都没有则保留 mp4v 并告警。

## 技能文档

Agent 侧的完整工作流与硬约束位于 `skills/srt-whiteboard-animation/SKILL.md`，包含 7 步强制确认关卡、统一出图视觉规范、语义排序与像素级标注要求、遮罩不变量与质量检查清单。

## 验证

- 单元测试：`node --test lwb/packs/whiteboard/test/*.test.mjs`（10 项，覆盖项目持久化、标注规范化与边界拒绝）
- 语法检查：已并入根 `npm run check`
- 引擎补丁：`engine/PATCHES.md` 记录每项修复的复现条件与验证方式
