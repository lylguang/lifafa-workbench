const REVIEW_FINDING_LIMIT = 12

function clipped(value, maximum) {
  const text = String(value || '').trim()
  return text.length > maximum ? text.slice(0, maximum) : text
}

export const VIDEO_REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    technicalPass: { type: 'boolean' },
    editorialPass: { type: 'boolean' },
    score: { type: 'integer', description: '0 到 100 的整数评分；范围由主机强制校验' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      description: `审核问题，主机最多接受 ${REVIEW_FINDING_LIMIT} 项`,
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'note'] },
          category: { type: 'string', enum: ['technical', 'composition', 'readability', 'pacing', 'relevance', 'variation'] },
          timestampSeconds: { type: 'number', description: '非负的成片时间点（秒）；范围由主机强制校验' },
          message: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
        additionalProperties: false,
      },
    },
    reviewEvidence: {
      type: 'array',
      description: '必须提供 2 到 8 项不同抽帧时间点的观察证据；数量由主机强制校验',
      items: {
        type: 'object',
        properties: {
          timestampSeconds: { type: 'number', description: '非负的已提供抽帧时间点（秒）；范围由主机强制校验' },
          observedMainVisual: { type: 'string' },
        },
        required: ['timestampSeconds', 'observedMainVisual'],
        additionalProperties: false,
      },
    },
  },
  required: ['passed', 'technicalPass', 'editorialPass', 'score', 'summary', 'findings', 'reviewEvidence'],
  additionalProperties: false,
})

export function buildVideoCreatorPrompt({ runDir }) {
  return [
    '你是本次口播视频的 AI 视觉导演与 Remotion 实现者。你的任务不是输出分镜建议，而是直接完成可渲染的 Remotion 创意工程。',
    `任务工作目录：${runDir}`,
    '首先完整读取 task.json、inputs/draft.json、inputs/subtitles.srt，以及 task.json.skillPaths 指向的 remotion-best-practices 和 content-video 两份 SKILL.md。随后按 Remotion skill 的路由读取本任务需要的 subtitles、sequencing、timing、transitions 和 ffmpeg 规则。',
    '只允许修改 src/CreativeVideo.tsx。不得修改 Root.tsx、DeterministicSrtSubtitles.tsx、index.ts、task-props.json、输入文件或技能文件。字幕、配音与可选 BGM 混音由受保护外壳负责。',
    '直接根据完整稿件与字幕时间轴决定叙事节拍、视觉隐喻、场景边界、图表、流程、对比、模拟界面和转场。不要输出固定模板参数，也不要把视频做成连续文字卡片。',
    // 场景边界必须来自真实语音时间轴：按稿件段落估秒数会累积误差，实测画面比语音超前 2-3 个章节。


    // 幕长与语音起点：扫描 46 条历史成片，SCENES 幕长从 6 秒到 32 秒都有，
    // 平均 12-15 秒是已经能达到的水平，所以这里不设硬性幕长指标。真正要守的是两件事：
    // (1) 首 cue 之前是配音音频真实的前导静音（实测 0s 到 5.16s 不等），不要在语音未起时硬造画面；
    // (2) 幕内仍要有语义推进，不能靠"一个场景撑四十秒"来回避设计。
    '第一个场景的起点用 inputs/subtitles.srt 里第一条 cue 的真实起点，不要凭感觉写 0。实测历史成片的首 cue 起点从 0s 到 5.16s 不等，那是配音音频真实的前导静音——语音还没开始时不要硬造内容，那段留白是合理的；但反过来，也不要因为首 cue 较晚就把钩子往后拖，钩子必须落在第一条 cue 开始的瞬间。',

    '钩子本身要短。实测历史成片的第一条 cue 中位数 2.62 秒、最长约 5 秒，所以开场钩子就是第一句话本身，不要另加标题卡或 logo 铺垫独占开头。不要从选题自我介绍、背景铺垫或「今天聊聊……」开始；直接从冲突、反常识、具体数字或结论切入。钩子的呈现可以用 StageTypeOn 逐字写出，或用 KeywordRelay 强调其中的关键词，但开场不要叠加两个以上强调组件。',

    '幕长没有硬指标，但每个场景内部必须有语义推进：如果一个场景超过约 20 秒，检查它是否真的只讲一件事——若其实是 2-3 个论点挤在一幕里，就拆成相邻的短场景（相邻两幕可以复用同一组对象与配色，视觉上是延续而非换页）；若确实是一件事，就靠语义节点让对象分步变化，而不是让观众盯着静止画面听完。判断依据是字幕：数一数这段覆盖了几条语义不同的 cue。',

    '场景边界必须从 inputs/subtitles.srt 的真实时间戳推导，不得凭稿件段落长度估算秒数。做法：先在字幕里找到与该场景主题对应的那条 cue，用它的起始时间（秒）作为该场景的起点，写进 SCENES 表。若一个场景覆盖多条 cue，就用第一条的起点、最后一条的终点。禁止出现"第 12 秒开始讲第二问"这类凭感觉给出的秒数——语音的实际节奏与文本比例差异很大，估算会越往后偏得越多。',
    '写完 SCENES 表后必须自检一遍：逐个场景取出它的起止时间，回到 inputs/subtitles.srt 里查这段时间覆盖的是哪几句字幕，确认这几句的语义与该场景画面要表达的主题一致。任何一处不一致都要改边界，而不是改画面。',

    // SCENES 表格式：审片抽帧要靠机器解析这张表才能对齐到场景稳定期，而解析器只认
    // 「字面量秒数」一种写法。帧数、dur 代替 end、只有 name、展开运算符全部读不出来，
    // 读不出来就退回按全片比例盲选——实测一条 460 秒 18 场景的片子，6 帧里 4 帧落在
    // 入场动画期，审片看到的是并不存在的缺陷（5 个历史成片在 2 轮修复后仍被判不通过）。
    'SCENES 表必须写成下面这个形式，字段名、类型、单位都不许变：`{ id: "s01-hook", start: 3.34, end: 38.86 }`。start 与 end 都是**秒的小数**，直接从字幕时间戳抄，不要用帧数；不要引入 `dur`/`duration` 代替 `end`；`id` 必填（用于日志与审片定位）；不要用 `name` 代替 `id`；不要写展开运算符（`...SC.s1`）或任何表达式（`start: F(3.34)`、`end: 1 + 2` 都读不出来）。整个数组可以是多行或单行，但每一项都要能被逐行读出 id/start/end 三个字段。',
    // 场景↔字幕的映射契约：让机器能核对「哪几句归哪一幕」。现状是 AI 抄秒数，
    // 而秒数无从校验——只声明秒数时抄错了也没有第二个信息源能揭穿它。
    '建议在每个场景上**额外**加一个 `cues: [首句序号, 末句序号]` 字段，写明这一幕覆盖字幕里的第几条到第几条（从 1 开始，含两端）。例如 `{ id: "s02-scale", start: 4.86, end: 10.89, cues: [4, 7] }`。写了它，机器会逐幕核对三件事：有没有字幕没被任何一幕认领（那段时间配音在讲、画面却什么都不显示）、相邻两幕有没有认领同一条（分幕标准含混）、以及这一幕声明的句子与它实际起止时间是否吻合（抄错的秒数会因此自己露出来）。字段名可用 `cues` / `cueRange` / `cue`，格式固定是 `[数字, 数字]`。这不是强制项，不写照常通过，但写了对分幕质量多一层机器校验。',
    '审片会抽取每个场景约 60% 时刻的画面作为证据帧。容器（卡片外框、面板、对比栏）必须与它的内容同帧或紧随其后出现，全部入场动画应在场景时长的前 40% 内完成——20 秒的场景，最后一条内容最晚约第 8 秒出现。绝不允许先画空容器、几秒后才填内容：实测这类"空盒子"会占据场景 60% 以上的时间。',
    '视觉风格默认明亮、清晰、通透，适合知识讲解。除非 task.json.visualBrief 明确要求其他风格，优先使用浅色或中高明度背景，以清晰的深色文字、轮廓和少量主题强调色建立层次；亮色背景上的文字、图形与连线也必须有足够对比。不要因为主题涉及 AI、科技或软件，就自动采用黑底、深蓝仪表盘、霓虹光效或暗色卡片网格。高对比不等于明亮，不能仅凭黑底白字就视为满足默认视觉方向。深色可用于有语义动机的局部对比或重点强调，但不应成为整片的惯性底色。',
    '在开始实现时，根据本篇稿件确定协调的背景色、文字色、强调色与视觉隐喻，直接落实到创意代码；配色应服务内容，不要给所有主题套用同一套科技配色，也不要为了变化逐场景任意换色。保持主体与背景层次分明、线条和文字边缘清晰，避免低对比的灰字、模糊光晕或大面积装饰渐变削弱信息辨识；明亮不等于低对比粉彩或刺眼的高饱和铺底。这些选择在现有创作过程中完成，无需另写设计文档或增加制作阶段。',
    '画面默认不依赖外部素材、远程 URL、额外 API Key 或人工补充素材。优先使用 React、CSS 图形、程序化图表、图标化结构、数据动画、对象隐喻和状态变化完成主题相关表达。禁止抓取未授权网络素材。',
    '主画面必须与口播语义对应：机制用流程或状态变化表达，对比同时展示两侧，数字使用视觉强调，结论应形成可回忆的收束画面。字幕变化不等于主场景变化。',
    '构图以一个清楚的视觉焦点为主，让关键对象与关系占据足够画面；留白服务层次，不要把小图和细字缩在大面积空白中。主画面文案保留关键词和短句，复杂信息按讲解顺序逐步展开。显式设置统一的中文无衬线字体族（如 PingFang SC、Microsoft YaHei、Noto Sans CJK SC、sans-serif），使用本地可用字体。以短边 1080px 的成片为参考，标题通常 56–80px，关键标签和结论通常 36–48px，必要辅助说明尽量不低于 28px；这是视觉设计参考，需按横竖屏可用宽度与实际显示尺寸调整。信息放不下时优先精简、分步呈现或调整构图，不要靠缩小关键文字硬塞，也不要修改受保护字幕来配合主画面。',
    // 沙箱内看不到画面，这两类缺陷最容易漏掉，也是最常被审片退回的：给出可静态自查的判据。
    '版面必须自查两个高频缺陷，它们无法靠肉眼以外的办法补救——所以请在写代码时就守住：(1) 不要留大片空白。每个场景的主内容应覆盖画布高度的约 60%–85%，主体纵向居中；只有顶部一行标题、下半屏全空，等同于没有画面。卡片内也要填实，不要让一个 730x230 的框里只放一行字。(2) 不要出界或重叠。横向按 1920（竖屏 1080）规划安全区，左右各留至少 80px，任何文字/卡片/标签的右边界不得越过画布宽度减去安全区；长英文单词（如产品名）必须预留足够宽度，宁可缩小字号或换行，也不要被相邻元素遮住或裁断。多个文本块之间不得压叠——同一位置的横幅、卡片、装饰窗口要有明确的上下层级和互斥的坐标区间。',
    // 只画容器、内容很久才到，会让画面在中段大段呈现"空盒子"，实测被连续判为 blocker。
    '内容必须在场景早期就到齐：容器（卡片外框、面板、对比栏）要和它的首条内容同帧或紧随其后出现，绝不允许先画出空容器、几秒后才填内容——实测这类"空盒子"会占据场景 60% 以上的时间，观众看到的就是空卡片。所有入场动画应在场景时长的前 40% 内完成（例如 20 秒的场景，最后一条内容最晚约第 8 秒出现）；若内容需要按讲解顺序分步展示，就拆成多个短场景或用同一组对象做状态递进，而不是让后续内容长时间缺位。',

    // 关键词接力强调：针对实测问题——一条 468 秒的片子 12 个场景、平均 39 秒一幕，
    // 场景内没有任何元素跟着口播语义变化，39 秒才发生一次视觉事件。
    // 组件已用 Remotion 4.0.522 实渲验证（帧 30/55/105 依次点亮第 1/2/3 个词）。
    '关键词接力强调：把 remotion-best-practices/rules/keyword-relay.tsx 里的 KeywordRelay 复制进 src/CreativeVideo.tsx 使用（记得从 remotion 引入 useVideoConfig）。一句话里用 ||| 分隔 1–3 个关键词，当前词变为强调色并展开下划线后接力给下一个词，让关键论点随讲解逐个亮起，而不是全句同时出现。用在主画面的标题、结论句或论点标签上，例如 <KeywordRelay text="真正的瓶颈|||不是模型|||而是数据" color={C.accent} fontSize={56} fontWeight={700} />。不要用在受保护的字幕上。',

    '真实数值强调：把 remotion-best-practices/rules/number-spotlight.tsx 里的 NumberSpotlight 复制进 src/CreativeVideo.tsx 使用。稿件里的真实数字会在 1.4 秒内缓动到位（outCubic 收尾，末段慢下来让数字停稳可读），支持 prefix/suffix/decimals/thousands/compact 与 caption。用于「数据驱动」的一幕，例如 <NumberSpotlight value={128} suffix=" 万" color={C.accent} fontSize={112} caption="半年累计产出" />。已实测 tabular-nums，数字递增时字宽不变、不会左右抖动。**只能用于稿件或素材中确实存在的数值。** 没有真实数据时不要用本组件，改用定性状态、边界或条件表达——绝不能为了画面丰富自造能力分数、比例或精确刻度。caption 也必须来自稿件，不得自造结论。',
    '幕标题与结论句逐字写出：把 remotion-best-practices/rules/stage-type-on.tsx 里的 StageTypeOn 复制进 src/CreativeVideo.tsx 使用。整句按字写出，默认每字 0.055 秒，可用 speed 调整，caret={true} 显示写入光标，写完后整句保持可读不消失。用于场景开头的一句话或收束句，例如 <StageTypeOn text="先说结论：数据质量决定上限" fontSize={60} fontWeight={700} caret />。不要用在受保护的字幕上，也不要用它逐字写出长段落——逐字动画只在短句上成立，超过约 15 字就会显得拖沓，那种情况直接用普通文本。',
    '三个强调组件（KeywordRelay 关键词接力、NumberSpotlight 数值递增、StageTypeOn 逐字显现）都是**语义强调**而非装饰：它们的时刻必须对齐口播——讲到那个词、那个数字、那句话时才发生。它们用来解决实测问题「一条 468 秒的片子 12 个场景、平均 39 秒一幕，场景内没有任何元素跟着口播语义变化」。单个场景最多用一处，不要每个元素都套。强度配比与禁见 remotion-best-practices 的 motion-effects 规则。',
    'KeywordRelay 使用纪律：单个场景最多用一处，不要每个元素都接力；接力必须对齐口播——讲到哪个词才轮到哪个词亮；若那句话在旁白里根本没提这几个词，就不要用。',
    '复制组件时不要改它的时序计算：`const start = (index * step) / fps;` 这一步必须保留，start 要先从帧换算成秒才能与 frame / fps 相减。若照抄成 index * step（帧），第一个词之后 strength 恒为 0，整句会退回普通黑色——这个错误静态检查发现不了，只有渲染出画面才看得见，而它会让强调效果静默地完全消失。',
    '动画应随字幕时间轴中的语义节点推进：讲到哪一步，就让相关对象移动、连接、改变状态或成为视觉焦点。长段落复用同一组对象逐步解释，避免在开头几秒展示完所有信息后，让余下大段口播只剩静止画面；也不要用持续漂浮、旋转、闪烁或机械定时切镜冒充内容推进。保留必要阅读停顿，关键数字与结论给足辨认时间；相邻观点尽量通过对象延续或状态转换衔接，避免每次都整屏淡入重置。',
    '文字与关键图形的入场必须有可见运动：配合 spring 做 translateY/X 位移或 scale 回弹，标题类可带 10–26px 的滑入距离；同级多个条目按 2–4 帧阶梯错峰出现。禁止整段只做透明度渐显——没有位移的入场观众感知为静止。',
    '动效声音：public/sfx/ 下有三枚本地合成的短音效（whoosh.wav 转场扫掠、pop.wav 文字点入、ding.wav 重点强调，均短于 0.6 秒），已做响度归一化。用 <Sequence from={帧} durationInFrames={24} layout="none" premountFor={30}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.35}/></Sequence> 的写法，让音效与画面动效同帧触发（不要把 <Audio> 直接放在被 <Sequence> 包裹的组件里当普通子元素）。每个音效必须对应一个可见动效，全片不超过 12 处，音量 0.3–0.4，不得连续堆叠或铺满整段。若目录里没有这些文件，就不要虚构音效，也不要引入外部音频。',
    '让视觉承担解释，而不是给文字加装饰。优先用主题相关的简洁对象、流程动作、条件分支、前后状态或模拟操作呈现例子；例如权限限制可表现为请求被阻断，跨应用操作可表现为信息在对象之间传递，但不要把这些例子套用到所有题材。卡片用于必要分组，Emoji 只作少量辅助；避免反复使用编号标题加卡片网格、Emoji 加文字条的版式。图形保持统一的线条、形状与色彩语言，开场尽快呈现具体问题或反差，结尾用已出现的核心对象收束观点。',
    '视觉信息必须忠实于稿件。只有稿件或所提供材料有明确数值及比较依据时，才使用定量图表、评分、百分比、雷达图或带数值意义的进度条；不得为了画面丰富自行编造能力分数、比例、趋势或精确刻度。定性观点用条件、边界、状态或不带量化暗示的对比表达。模拟界面与示意场景应能辨认为示意，不得伪装成真实截图、实测结果或新增事实。按语义选择视觉形式，不为满足数量配额强行添加图表、SVG 动画或额外场景。',
    '使用 useCurrentFrame、interpolate、spring、Sequence 等帧驱动能力。所有延迟出现的前景 Sequence 必须有 durationInFrames；禁止由浏览器计时的 CSS animation 和 transition；明确关闭动画的 none 值允许，通常直接省略这些属性。',
    '横竖屏、安全区、视频时长和字幕策略以 task.json 为准。竖屏时必须避开底部字幕与平台信息区、右侧交互区；任何文本不得溢出或遮挡。',
    '不要先在回复或推理中完整展开全片的逐场景坐标、帧数和代码。完成必要读取后，必须尽快调用文件工具，把 src/CreativeVideo.tsx 从占位内容改成覆盖完整时长的最小可编译版本；随后分批完善场景并持续写回文件。工作进度以文件为准，不以文字方案为准。',
    '每次只规划当前准备落盘的一小批场景。较长视频应先建立完整场景骨架，再逐批补充细节；不要把所有场景的实现细节积压到一次超长模型输出中。',
    '完成后必须运行 task.json.commands.check（node scripts/preflight.mjs），这是主流程使用的同一套预检规则；失败时按文件行号修正并重查，不要自写正则冒充预检。还必须用 task.json.commands.still 追加 --frame 和 --scale 参数，至少检查开头、中段、结尾三个代表帧；视频超过 120 秒时，再检查两个场景交界附近的帧。重点确认主体没有长期挤在上半部或留下无意义大面积空白、连接线与组件没有压叠、不同语义段没有退化为同一套卡片版式。只使用工程已有的本地命令，不使用 npx 下载工具，不修改共享依赖或缓存权限。任务 node_modules/.cache 是独立可写缓存。不要改变 task.json 指定的最终输出路径。最后只需简要说明已经实现的视觉语言与检查结果；真正产物以工作区文件为准。',
    // 预检是纯进程内解析，任何环境都能跑；still 需要派生子进程，而部分部署的
    // 执行沙箱（如 Windows 的受限令牌沙箱）会拒绝 node.exe/chrome-headless-shell.exe，
    // 并在系统层弹出「应用程序无法正常启动(0xc0000142)」对话框。此时换 .cmd/.ps1
    // shim、Start-Process、或自建预览工具都不会成功，只会制造更多弹窗。
    '若 task.json.commands.still 或任何派生浏览器的写法因执行沙箱被拒绝（表现为 Access is denied、需要 node.exe/chrome-headless-shell.exe 的进程启动失败，或命令静默返回空输出），不要改换其他启动方式重试，也不要自建替代渲染或预览工具：直接跳到下一步，并在最终说明里写明该项未能在本环境执行。主流程会在沙箱之外统一渲染成片并由独立审片 Agent 复核抽帧，不要用源码推断代替观片结论。',
  ].join('\n\n')
}

/** Prompt used only when the same creator session hit one response-output ceiling. */
export function buildVideoCreatorContinuationPrompt({ attempt, maximum }) {
  return [
    `上一轮达到单次输出上限，正在同一视频创作会话中继续（${attempt}/${maximum}）。`,
    '不要重新读取全部资料，不要复述或重新展开全片方案。先检查 src/CreativeVideo.tsx 的实际内容，立即从现有进度继续写入。',
    '如果文件仍是占位版本，先写出覆盖完整时长的最小可编译实现；如果已有部分实现，直接完成缺失场景。完成后运行低成本编译检查，并确认 data-agent-placeholder 已移除。',
  ].join('\n\n')
}

export function buildVideoCreatorRepairPrompt({ runDir, report, attempt, maximum }) {
  return [
    `渲染前检查未通过，正在原视频创作会话中修复（${attempt}/${maximum}）。`,
    `任务工作目录：${runDir}`,
    ...report.failures.map((failure) => `- ${failure}`),
    '保留已有场景、时间轴和创意，只修正上述问题。只允许修改 src/CreativeVideo.tsx，不得修改受保护外壳、检查器或检查清单。',
    '使用帧驱动动画；不需要 CSS 过渡时删除属性或明确使用 none。完成后运行 node scripts/preflight.mjs，确认检查通过。不要重建整个工程或重新生成上游素材。',
  ].join('\n\n')
}

export function buildVideoEditorialRepairPrompt({ runDir, review, frameFiles, timestamps, contactSheetFile, attempt, maximum }) {
  const evidence = (Array.isArray(review?.reviewEvidence) ? review.reviewEvidence : []).slice(0, 8).map((item) => ({
    timestampSeconds: item.timestampSeconds,
    observedMainVisual: clipped(item.observedMainVisual, 600),
  }))
  const findings = (Array.isArray(review?.findings) ? review.findings : []).slice(0, REVIEW_FINDING_LIMIT).map((item) => ({
    severity: item.severity,
    category: item.category,
    timestampSeconds: item.timestampSeconds,
    message: clipped(item.message, 500),
  }))
  return [
    `独立审片未通过，正在进行定向视觉修复（${attempt}/${maximum}）。`,
    `任务工作目录：${runDir}`,
    '继续现有 Remotion 工程。先读取 task.json、inputs/draft.json 和 src/CreativeVideo.tsx，再查看下面列出的本轮成片抽帧。只允许修改 src/CreativeVideo.tsx；不得修改字幕、配音、受保护外壳、预检器或输入文件。',
    `本轮抽帧：\n${frameFiles.map((file, index) => `- ${timestamps[index]} 秒：${file}`).join('\n')}${contactSheetFile ? `\n全片接触表（4 列网格、时间从左到右从上到下递增）：${contactSheetFile}` : ''}`,
    `审片结果：\n${JSON.stringify({ score: review?.score, summary: clipped(review?.summary, 1000), findings, reviewEvidence: evidence }, null, 2)}`,
    '逐项修复 blocker 和 major 问题。问题涉及重复版式时，必须改变对应段落的视觉表达和空间结构，不能只换颜色或文字；问题涉及大面积无意义留白时，应重新分配主体尺度和垂直构图；问题涉及压叠、悬空连线或关系不可读时，应修正布局与元素生命周期。保留已经有效的场景，不要无关重做整片。',
    // 修复轮最容易按下葫芦浮起瓢：补了空白又造成出界/重叠。给出去重后的硬性自检。
    '修复时不要只顾被点名的那一帧：补内容常会把元素挤出边界。落盘前对每个场景复核三点——主内容覆盖画布高度约 60%–85% 且纵向居中；所有元素的右边界在画布宽度减 80px 之内、长英文单词不被相邻元素遮挡或截断；任意两个文本块不重叠（横幅、卡片、装饰窗口的坐标区间互斥）。',
    '修复必须落实到实际代码和完整时间轴。不要删除有问题的内容来规避审片，也不要修改字幕或稿件。完成后运行 node scripts/preflight.mjs，并用 task.json.commands.still 在问题时间点附近检查代表帧；本阶段不要自行渲染完整成片，主流程会统一重渲染和复审。',
    '若 still 因执行沙箱拒绝派生 node.exe/chrome-headless-shell.exe 而无法运行，不要改换启动方式重试，也不要自建替代渲染或预览工具；以预检结果为准完成修复并在说明里注明该检查未能在本环境执行。',
  ].join('\n\n')
}

export function buildVideoReviewerPrompt({ runDir, technicalReportFile, frameFiles, timestamps, contactSheetFile }) {
  const contactSheetLine = contactSheetFile
    ? `\n另外还有一张全片接触表（contact sheet）：${contactSheetFile}。它把全片按时间均匀采样拼成 4 列网格（从左到右、从上到下时间递增），用于纵览全片节奏、场景变化和重复版式；网格缩略图较小，只用于发现整体节奏与版式重复问题，精确判断仍以下面的逐帧图片为准。`
    : ''
  return [
    '你是独立的视频成片审核 Agent，不是创作者。你与创作会话相互独立，不得修改任何文件、不得重新渲染、不得替创作者解释问题。',
    `任务工作目录：${runDir}`,
    `先读取 task.json、inputs/draft.json、${technicalReportFile}，再逐张查看以下从最终成片提取的全帧图片：\n${frameFiles.map((file, index) => `- ${timestamps[index]} 秒：${file}`).join('\n')}${contactSheetLine}`,
    '技术报告是音轨、尺寸、帧率、时长和画面变化的确定性事实，不得用主观判断推翻。若技术报告未通过，technicalPass 必须为 false。',
    '重点审核：主画面是否忠实对应稿件；是否具有清楚的视觉叙事与场景变化；机制、对比、数字和结论是否被视觉化；是否退化成文字卡片；横竖屏构图、字幕安全区、可读性和信息密度是否合格。若有接触表，先用它纵览全片：场景时长是否失衡、连续多帧版式雷同、节奏是否前紧后松这类全局问题优先从接触表发现，再回到对应时间点的全帧图确认。',
    '接触表本身的局限：它是按时间均匀采样的，可能落在某个场景的入场动画期或场景边界附近，缩略图又小，细节不可辨。因此接触表只用来发现全局问题（节奏失衡、版式雷同、场景时长突变），接触表按时间均匀采样，可能落在场景的入场动画期或场景边界附近；不要只凭接触表下结论——任何要写进 findings 的具体缺陷，都必须回到对应时间点的全帧图确认后才能判定。',
    // 创作侧被硬性禁止使用外部素材与实拍，审片不能拿它的缺失当缺陷，否则无论怎么画都永远不通过。
    '本片的画面语言只有一种：用 React/CSS/SVG 程序化绘制图形、图表、流程与示意界面。创作侧被明确禁止依赖外部素材、远程 URL、抓取网络图片或改用实拍，因此"没有实拍镜头/真实场景/人物/产品截图"是既定前提，不是缺陷，不得据此判定 editorialPass=false，也不得在 findings 里作为问题提出。评审"是否退化成文字卡片"时应看信息是否被结构化：真正的判据是 —— 画面有没有承担解释作用的图形关系（流程、对比、状态变化、条件分支、对象隐喻），而不是有没有照片。仅有装饰性色块配大段文字才算退化。',
    '抽帧已经对齐每个场景约 60% 时刻，容器与内容必须在那之前全部就位。因此 60% 时刻仍是空白、半成品或只有骨架，就是真实缺陷，不要归因为"入场动画未完成"，也不要按"入场过早/过慢"轻轻带过——那样会让真实缺陷长期蒙混过关。只在画面确实处在场景起始的极早期（相邻时间点显示入场尚未结束）时，才按入场节奏问题描述。',
    '通过条件：technicalPass 与 editorialPass 都为 true，score 不低于 70，且 reviewEvidence 至少引用两个不同的已提供时间点并具体描述当时看到的主画面。无法从抽帧确认的内容不得臆测。',
    '发现 blocker 或 major 问题时必须判定 editorialPass=false、passed=false。失败结果会交回视觉导演做有界定向修复，因此必须写明准确时间点、实际看到的画面和可执行的问题描述。',
    '严格返回 schema 要求的结构化审核结果，不输出 Markdown 或额外说明。',
  ].join('\n\n')
}

function nearestSample(value, samples) {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number) || number < 0 || !samples.length) return null
  return samples.reduce((best, sample) => Math.abs(sample - number) < Math.abs(best - number) ? sample : best, samples[0])
}

/** Reconcile model judgement with deterministic gates and evidence requirements. */
export function normalizeVideoReview(value, { technicalPassed, sampledTimestamps } = {}) {
  const samples = Array.isArray(sampledTimestamps) ? sampledTimestamps.map(Number).filter((item) => Number.isFinite(item) && item >= 0) : []
  const findings = (Array.isArray(value?.findings) ? value.findings : []).slice(0, REVIEW_FINDING_LIMIT).map((item) => ({
    severity: ['blocker', 'major', 'minor', 'note'].includes(item?.severity) ? item.severity : 'major',
    category: ['technical', 'composition', 'readability', 'pacing', 'relevance', 'variation'].includes(item?.category) ? item.category : 'composition',
    timestampSeconds: nearestSample(item?.timestampSeconds, samples),
    message: clipped(item?.message, 500) || '审核发现未提供具体说明。',
  }))
  const evidence = (Array.isArray(value?.reviewEvidence) ? value.reviewEvidence : []).slice(0, 8).map((item) => ({
    timestampSeconds: nearestSample(item?.timestampSeconds, samples),
    observedMainVisual: clipped(item?.observedMainVisual, 600),
  })).filter((item) => item.timestampSeconds !== null && item.observedMainVisual.length >= 12)
  const distinctEvidence = new Set(evidence.map((item) => item.timestampSeconds.toFixed(2))).size
  const score = Number.isSafeInteger(value?.score) && value.score >= 0 && value.score <= 100 ? value.score : 0
  const technicalPass = technicalPassed === true && value?.technicalPass === true
  const editorialPass = value?.editorialPass === true && !findings.some((item) => ['blocker', 'major'].includes(item.severity))
  const passed = technicalPass && editorialPass && score >= 70 && distinctEvidence >= 2 && value?.passed === true
  return {
    passed,
    technicalPass,
    editorialPass,
    score,
    summary: clipped(value?.summary, 1000) || (passed ? '视频通过独立审核。' : '视频未通过独立审核。'),
    findings,
    reviewEvidence: evidence,
    evidencePassed: distinctEvidence >= 2,
  }
}
