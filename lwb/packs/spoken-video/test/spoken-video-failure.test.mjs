import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CATEGORY_LABEL,
  classifyFailure,
  failureSignature,
  repairBackoffMs,
  REPAIR_BACKOFF_CEILING_MS,
  STAGE_MAX_ATTEMPTS,
} from '../spoken-video-failure.mjs'

// 下面每一条 case 都是 2026-10 审计里真实出现过的失败（取自 schedules.json
// 与 audio-tasks.json）。把它们钉成测试，是为了让「这次修好了」不等于
// 「下次换个错误措辞又漏判」。
const HISTORICAL = [
  {
    name: '百炼参考音色复刻的密钥失效',
    message: '百炼参考音色复刻失败：Invalid API-key provided.',
    category: 'credential.invalid',
    retryable: false,
    mustMention: /连接配置/u,
  },
  {
    name: '小米 TTS 的 API Key 未配置',
    message: 'SciTiger TTS任务failed：小米 TTS 未配置 API Key：请到桥接配置中心 http://127.0.0.1:8199/ 填写',
    category: 'credential.missing',
    retryable: false,
    mustMention: /连接配置/u,
  },
  {
    name: '小米 TTS 限流',
    message: 'SciTiger TTS任务failed：第 1/25 段云端合成失败（已重试）：小米 TTS 返回 429：Too many requests',
    category: 'credential.quota',
    retryable: true,
    mustMention: /退避/u,
    // 2026-10-26 实测：小米 MiMo 对**声音克隆**的限流按「同时在飞的请求数」算，
    // 不按速率。所以退避不是解药——真正要说的是「已经串行了，仍失败就是配额
    // 不够」。文案缺了这层，用户会一直等一个不会自己好的东西。
    mustMentionAll: [/退避/u, /串行/u, /配额/u],
  },
  {
    name: '桥接 fetch failed',
    message: 'SciTiger TTS 提交不可访问：fetch failed',
    category: 'engine.down',
    retryable: true,
    mustMention: /自动拉起/u,
  },
  {
    // 2026-10-10 改过 mustMention：原来钉的是「配置中心」四个字。桥接整个进程
    // 没起来时，让人去打开 127.0.0.1:8199 点按钮是执行不了的——那个端口就是
    // 死的（18:13 那次的真实故障）。现在改为钉「能真正执行的下一步」：
    // 保活计划任务与脚本路径。
    name: '引擎路径指向已删除的目录',
    message: 'SciTiger 字幕任务failed：字幕引擎的python 可执行文件不存在：E:\\ComfyUI-CZX\\ComfyUI-CZX\\python\\python.exe',
    category: 'engine.down',
    retryable: true,
    mustMention: /LWBKeepAlive|lwb-keepalive\.ps1/u,
  },
  {
    name: '引擎未连接',
    message: 'SciTiger 字幕任务failed：配音/字幕引擎未连接（ComfyUI 8188）。请打开桥接配置中心点「一键启动」。',
    category: 'engine.down',
    retryable: true,
    mustMention: /自动拉起/u,
  },
  {
    name: '写稿记录被保留上限挤出',
    message: '口播视频内容数据：写稿生成记录不存在。',
    category: 'record.missing',
    retryable: true,
    mustMention: /精确定位|保留上限/u,
  },
  {
    name: '媒体主机重启',
    message: '媒体主机在任务完成前已重启。请重新提交配音任务。',
    category: 'host.restart',
    retryable: true,
    mustMention: /续跑/u,
  },
  {
    name: '流水线在完成前重启',
    message: '主机在流水线完成前已重启，本轮中止；各阶段任务的真实状态见对应模块。',
    category: 'host.restart',
    retryable: true,
    mustMention: /续跑/u,
  },
  {
    name: '成片主画面变化不足',
    message: '成片未通过技术质检：主画面变化不足，成片可能退化为静态画面或少量文字卡片。',
    category: 'content.qc_failed',
    retryable: false,
    // 断言盯「行为」而非某个固定词汇：分类正确、且给出了能让人执行的下一步。
    // 2026-10-22 修复：真空白（QC 抽帧全单色）属于渲染浏览器画不出画面，必须
    // 同时保住两条出口——(1) 极简/纯字幕风格的合法用法可直接采用，(2) 非极简时
    // 给出换 Edge / 设 LWB_REMOTION_BROWSER_EXECUTABLE 的可执行动作。两者缺一不可，
    // 所以分别断言，任一项脱落都算没达标（守卫要有牙且咬对地方）。
    mustMention: /画面变化不足|程序问题/u,
    mustMentionAll: [/极简/u, /Edge|LWB_REMOTION_BROWSER_EXECUTABLE/u],
  },
  {
    name: '渲染管线画不出画面（探测帧只有一种颜色）',
    message: '渲染管线无法在当前浏览器画出画面：探测帧只有一种颜色，说明该浏览器（或它与 Remotion 的组合）不能正确渲染视频。请改用 Microsoft Edge，或设置环境变量 LWB_REMOTION_BROWSER_EXECUTABLE 指向 chrome-headless-shell / Edge 的可执行文件后重跑。',
    category: 'video.render_pipeline',
    retryable: false,
    mustMention: /Edge|LWB_REMOTION_BROWSER_EXECUTABLE|反馈问题/u,
  },
  {
    name: '字幕时间轴不合规',
    message: '字幕格式无效：第 134 条结束时间必须晚于开始时间。',
    category: 'content.invalid',
    retryable: false,
    mustMention: /字幕/u,
  },
  {
    // 2026-10-26 12:17 真实报文。审片 Agent 指出了具体视觉问题（元素迟到、
    // 箭头语义与结论相反），定向修复 2 轮仍未达标。此前这条被误报成
    // code.defect「内部缺陷，请反馈给开发者」——但根因是画面质量没达标，
    // 不是代码 bug，重跑/再修能解。
    name: '独立审片不通过（修复后仍未达标）',
    message: '成片经过 2 次定向修复后仍未通过独立审片：技术质检通过（1920x1080/30fps/211.35s/音轨与74条字幕齐全）。全片17个场景以 React/CSS/SVG 程序化绘制，未退化成纯文字卡片。编辑层面存在2处major：S14第三条建议在旁白念到时画面仍是约5%不透明度的幽灵残影且扣减算式迟到约3秒（164.778s 实测）；"抄底？接飞刀"用一支向上的箭头表达，画面语义与结论相反（145.558s 实测）。',
    category: 'content.editorial_rejected',
    retryable: false,
    mustMention: /画面|审片/u,
    // 修法必须给出真正能解决它的动作（重试/重跑），而且**不能**再说成
    // 「这是代码缺陷，请反馈给开发者」——审片不通过是画面质量没达标。
    mustMentionAll: [/重试|重跑/u],
    mustNotMention: /开发者/u,
  },
  {
    name: '固定墙钟超时（历史误杀）',
    message: 'Error [SPOKEN_VIDEO_SCHEDULE_TIMEOUT] 配音超过 10 分钟仍未完成。',
    category: 'timeout.ceiling',
    retryable: true,
    mustMention: /自动重入/u,
  },
  {
    name: '未归类的内部错误',
    message: "Cannot read properties of undefined (reading 'length')",
    category: 'code.defect',
    retryable: false,
    mustMention: /开发者/u,
  },
  {
    name: '被截断的渲染命令',
    message: 'Command failed: D:\\Program Files\\nodejs\\node.exe F:\\Users\\Administrator\\Desktop\\李发发工作台\\lifafa-workbench-main\\node_modules\\@remotion\\cli\\remotion-cli.j',
    category: 'code.defect',
    retryable: false,
    mustMention: /开发者/u,
  },
  {
    // 2026-10-25 09:30 真实报文。网关对默认模型
    // workbuddy-ai/minimax-m3.1-flash 的每次请求都回这条 429，而同网关下
    // hy3 / deepseek-v4.1-flash / group/smart-split 全部 200——所以它不是
    // 「等会儿就好」的限流，退避重试永远等不到恢复，必须换成不用等的那种处理。
    name: '默认模型额度耗尽（网关 429 Credits exhausted）',
    message: '生成未正常结束（error）：WorkBuddy AI: Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage — WorkBuddy requires an active credit package even for 0-rate free models; check your account package balance',
    category: 'credential.model_quota',
    retryable: false,
    mustMention: /模型/u,
    mustMentionAll: [/模型/u, /hy3|deepseek-v4\.1-flash/u],
  },
  {
    // 2026-11-05 真实报文（多批任务集体失败）。审片 Agent 必须 read_image 逐帧
    // 看画面，但默认模型 fan/glm-5.3-flash 不声明图像输入，read_image 直接报错，
    // 审片员看不到任何画面只能判不通过——这是「选了不支持读图的模型」导致的
    // 环境性失败，不是画面质量没达标。根因该由用户去「设置 → 模型」改选支持
    // 图像输入的模型，所以这里要提示切换模型，且**不能**误归成
    // content.editorial_rejected（那类讲的是画面质量没达标、可再修）。新规则必须
    // 排在 editorial_rejected 之前抢占分类。
    name: '审片模型不支持图像输入（read_image 报错）',
    message: '成片经过 2 次定向修复后仍未通过独立审片：无法完成视觉审核：本审核会话绑定的模型 glm-5.3-flash 不支持图像输入，read_image 读取 contact-sheet 与抽帧图片均直接报错（"model does not declare image input"）。由于无法真正看到任何画面，editorialPass 判为 false 并标记环境性 blocker。请用图像能力模型重新发起审核。',
    category: 'review.model_no_image',
    retryable: false,
    // 修法必须明确指向「切换支持图像输入的模型」，而不是让用户去「调整画面重跑」。
    mustMention: /图像输入|读图|切换/u,
    mustMentionAll: [/设置\s*→\s*模型|模型/u, /hy3|deepseek-v4\.1-flash|step-5-preview/u, /LWB_SPOKEN_VIDEO_REVIEWER_MODEL/u],
    // 必须区分「模型不支持看图」与「画面质量没达标」：修法不能只说「重试定向修复」。
    mustNotMention: /定向修复/u,
  },
  {
    // 守卫：同样是「未通过独立审片」，但根因是画面质量（元素迟到、语义相反），
    // 必须仍归到 content.editorial_rejected，不能被上面的读图模型规则抢走。
    name: '独立审片不通过（画面质量，非模型问题）不被读图规则误判',
    message: '成片经过 2 次定向修复后仍未通过独立审片：技术质检通过。S14 第三条画面仍是约 5% 不透明度残影且扣减算式迟到约 3 秒；"抄底？接飞刀"用向上箭头表达，画面语义与结论相反。',
    category: 'content.editorial_rejected',
    retryable: false,
    mustMention: /画面|审片/u,
    mustMentionAll: [/重试|重跑/u],
    mustNotMention: /开发者|图像输入/u,
  },
  {
    // 2026-11-05 真实报文（Kimi K3.1 任务导演阶段）。底层 pi-ai 网关链路在生成中
    // 超过 5 分钟没吐 token，客户端判流空闲超时断开。导演子会话缓存显示实际模型是
    // 支持读图的 fan/hy4free，所以**不是**模型不支持看图、也**不是**代码缺陷——
    // 是网关链路的瞬时抖动，重试通常能过。此前没有这条规则时被漏判成 code.defect
    // （「请反馈给开发者」），纯误导。
    name: '视觉导演网关链路流空闲超时（pi-ai stream idle timeout）',
    message: '生成未正常结束（error）：pi-ai stream idle timeout after 300000ms',
    category: 'timeout.stream_idle',
    retryable: true,
    // 修法必须说清「是链路抖动、非模型非代码、会重试」，并且按用户既定原则给出
    // 「持续失败就换走这条链路的模型」的提示，而非偷偷替用户改默认。
    mustMention: /链路|网关|抖动|重试/u,
    mustMentionAll: [/重试/u, /设置\s*→\s*模型|切换/u, /hy3|deepseek-v4\.1-flash/u, /magpie|pi-ai/u],
    // 绝不能又误导成「代码缺陷请找开发者」，也别和「模型不支持看图」混为一谈。
    mustNotMention: /开发者|代码缺陷|图像输入|读图/u,
  },
  {
    // 守卫：同样是「生成未正常结束」，但根因是模型额度耗尽（Credits exhausted），
    // 必须仍归到 credential.model_quota（不可重试），不能被这条流超时规则抢走。
    name: '模型额度耗尽（Credits exhausted）不被流超时规则误判',
    message: '生成未正常结束（error）：WorkBuddy AI: Credits exhausted. Please visit the link below to purchase add-on packs and get more credits.',
    category: 'credential.model_quota',
    retryable: false,
    mustMention: /模型/u,
    mustMentionAll: [/模型/u, /hy3|deepseek-v4\.1-flash/u],
  },
  {
    // 2026-11-05 23:15 真实报文（用户截图那一条）。上游同时给出了「限额什么时候
    // 解除」和「可以换模型」两件极有用的信息——原文里都写着，之前却被归进通用
    // quota 桶，配了一段讲「声音克隆按并发限流」的 TTS 文案，对视频任务完全
    // 不相干，用户既看不到重置时间，也看不到换模型这个出口。
    name: '模型网关频率限制（usage exceeds frequency limit）',
    message: '生成未正常结束（error）：429: {"code":null,"message":"WorkBuddy AI: usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-11-05 23:57:25 UTC+8, alternatively, you can switch to the other models to continue using it.","param":null,"type":"rate_limit_error"}',
    category: 'model.rate_limit',
    retryable: true,
    // 修法必须带上报文里的重置时间（用户最想知道「还有多久能好」），
    // 并且给出「换模型」这个出口——按用户既定原则只提示，不替用户改默认模型。
    mustMention: /频率限制|限流/u,
    mustMentionAll: [/频率限制|限流/u, /2026-11-05 23:57:25/u, /设置\s*→\s*模型/u, /hy3|deepseek-v4\.1-flash/u],
    // 这不是画面质量问题、也不是代码缺陷，不能那样说。
    mustNotMention: /开发者|声音克隆/u,
  },
  {
    // 2026-11-05 23:33 真实报文：`Request timed out.`——报文极短，零工具调用，
    // DSH 事件流里 llm/retry 连着 5 次 code=TIMEOUT。此前落进兜底的 code.defect，
    // 用户看到「未归类的内部错误，通常是代码缺陷，请反馈给开发者」，完全指错方向。
    name: '模型网关请求超时（Request timed out.）',
    message: '生成未正常结束（error）：Request timed out.',
    category: 'model.request_timeout',
    retryable: true,
    // 必须说清是模型链路问题、会重试、连续出现就换模型；不得推给开发者。
    mustMention: /超时/u,
    mustMentionAll: [/超时/u, /重试/u, /设置\s*→\s*模型|切换/u, /hy3|deepseek-v4\.1-flash/u],
    mustNotMention: /开发者|代码缺陷/u,
  },
  {
    // 2026-11-05/06 真实报文：50 分钟预算耗尽。这条文案一直在**误诊**——
    // 原文写「Agent 一直在打磨但从未跑预检」，但解开那次会话的 DSH 事件流
    // 看，llm/retry 连着 7–8 次，每次都是上游 5 分钟没吐 token
    // （pi-ai stream idle timeout after 300000ms），时间全烧在模型请求反复
    // 超时上，Agent 根本没在打磨。
    //
    // 误诊有实际后果：修法指向「调大预算重跑」，而真正该做的是换一条模型
    // 链路；用户按提示调预算，只会再烧 50 分钟。
    name: '视觉导演预算耗尽（真实根因是链路反复超时，不是打磨）',
    message: '视觉导演超过 50 分钟仍未提交可渲染工程（走 fan 链路）：期间模型请求反复失败，已重试 3/5 次，未拿到有效响应。最近一次失败原因：pi-ai stream idle timeout after 300000ms。已停止本轮以止损：可直接重跑本任务，阶段产物已落盘，重跑不必从零开始；如确需更长时间，可设置环境变量 LWB_VIDEO_DIRECTOR_TIMEOUT_MS（毫秒，当前 3000000）后重启。',
    category: 'video.director_budget',
    retryable: true,
    // 必须说清真实根因是链路超时，并给出换模型的出口。
    mustMention: /超时/u,
    mustMentionAll: [/超时/u, /设置\s*→\s*模型|切换/u, /hy3|deepseek-v4\.1-flash/u],
    // 绝不能再说成「Agent 一直在打磨」——那正是本次要修掉的误诊。
    mustNotMention: /开发者|代码缺陷/u,
  },
  {
    // 守卫：同样是导演预算耗尽，但内嵌的根因是限流，修法必须讲限流而不是超时。
    name: '视觉导演预算耗尽（根因是限流）按限流措辞',
    message: '视觉导演超过 50 分钟仍未提交可渲染工程（走 magpie 链路）：期间模型请求反复失败，已重试 5/5 次，未拿到有效响应。最近一次失败原因：429: usage exceeds frequency limit, reset at 2026-11-05 23:57:25 UTC+8',
    category: 'video.director_budget',
    retryable: true,
    // 必须说清真实根因是限流（而不是链路超时），并给出换模型的出口。
    mustMention: /限流|频率限制/u,
    mustMentionAll: [/限流|频率限制/u, /设置\s*→\s*模型|切换/u],
  },
  {
    // 守卫：TTS 侧的 429 不能被「模型限流」规则抢走——它的修法讲的是并发与
    // 声音克隆，跟模型网关限流是两回事。
    name: '小米 TTS 限流不被模型限流规则误判',
    message: 'SciTiger TTS任务failed：第 1/25 段云端合成失败（已重试）：小米 TTS 返回 429：Too many requests',
    category: 'credential.quota',
    retryable: true,
    mustMention: /退避/u,
    mustMentionAll: [/退避/u, /串行/u, /配额/u],
  },
]

for (const testCase of HISTORICAL) {
  test(`${testCase.name} is classified as ${testCase.category}`, () => {
    const failure = classifyFailure({ error: new Error(testCase.message), step: 'voiceover' })
    assert.equal(failure.category, testCase.category)
    assert.equal(failure.retryable, testCase.retryable)
    assert.match(failure.remedy, testCase.mustMention, '修法必须说清下一步做什么')
    // mustMentionAll：每条都要命中（AND），用来把「多个出口缺一不可」钉死——
    // 例如 content.qc_failed 必须同时保住极简风格出口和换 Edge 指引，任一项脱落都红。
    for (const pattern of testCase.mustMentionAll || []) {
      assert.match(failure.remedy, pattern, `修法必须包含：${pattern}`)
    }
    // mustNotMention：修法**不能**把问题推给开发者。用于钉死「这不是代码 bug」
    // 这类事实——一旦修法又出现「反馈给开发者」，误报就回来了。
    for (const pattern of [testCase.mustNotMention].flat().filter(Boolean)) {
      assert.doesNotMatch(failure.remedy, pattern, `修法不应包含：${pattern}`)
    }
    assert.ok(CATEGORY_LABEL[failure.category], '每个分类都要有中文标签供界面展示')
  })
}

test('a stalled stage is retried, a hard ceiling is retried, but they are told apart', () => {
  const stalled = classifyFailure({ error: new Error('Error [SPOKEN_VIDEO_SCHEDULE_NO_PROGRESS] 配音已连续 12 分钟没有任何进展。') })
  const ceiling = classifyFailure({ error: new Error('Error [SPOKEN_VIDEO_SCHEDULE_TIMEOUT] 成片超过 90 分钟硬性上限仍未完成。') })
  assert.equal(stalled.category, 'timeout.no_progress')
  assert.equal(ceiling.category, 'timeout.ceiling')
  assert.ok(stalled.retryable && ceiling.retryable)
  assert.notEqual(stalled.signature, ceiling.signature, '两种超时在故障档案里要能分开统计')
})

test('an unmatched error is treated as our own defect and never retried', () => {
  // 重试一个确定性崩溃只会再烧一次阶段预算，并把「它会稳定复现」这个事实藏起来。
  const failure = classifyFailure({ error: new Error('something nobody predicted') })
  assert.equal(failure.category, 'code.defect')
  assert.equal(failure.retryable, false)
  assert.equal(failure.autoRepair, null)
})

test('模型额度耗尽不会被误判成可退避重试的普通限流', () => {
  // 这条规则是 2026-10-25 加的：新规则必须排在小米 TTS 那条通用 429 之前，
  // 否则「额度用完了」会被当成「限流一会儿就好」，退避重试把阶段预算烧光
  // 也等不到恢复。反过来，TTS 那条带 429 的真实报文不能被新规则抢走。
  const modelQuota = classifyFailure({
    error: new Error('生成未正常结束（error）：WorkBuddy AI: Credits exhausted. Please visit https://www.codebuddy.ai/profile/usage'),
  })
  assert.equal(modelQuota.category, 'credential.model_quota')
  assert.equal(modelQuota.retryable, false, '额度耗尽重试不会恢复，不能给它退避重试')

  // pack 在完全挖不到线索时给的兜底文案也必须落在这个分类上：它描述的
  // 就是「请求还没产出任何内容就断了」，把它留在可退避的 quota 桶里会白等。
  const fallback = classifyFailure({
    error: new Error('生成未正常结束（error）：模型在返回任何内容前就结束了本次请求（未产生 assistant 消息），最常见的原因是默认模型的额度已经用完'),
  })
  assert.equal(fallback.category, 'credential.model_quota')

  // 反过来：真正的限流不能被新规则抢走，它们该退避重试。
  const ttsThrottle = classifyFailure({
    error: new Error('SciTiger TTS任务failed：第 1/25 段云端合成失败（已重试）：小米 TTS 返回 429：Too many requests'),
  })
  assert.equal(ttsThrottle.category, 'credential.quota', 'TTS 的限流仍走可退避的那条')
  assert.equal(ttsThrottle.retryable, true)

  const plainThrottle = classifyFailure({ error: new Error('模型返回 429 Too many requests') })
  assert.equal(plainThrottle.category, 'credential.quota', '普通限流不该被判成额度耗尽')
  assert.equal(plainThrottle.retryable, true)
})

test('signatures collapse volatile parts so one root cause clusters into one row', () => {
  const first = failureSignature('写稿生成记录不存在（已重试 5 次仍读不到记录）')
  const second = failureSignature('写稿生成记录不存在（已重试 5 次仍读不到记录）')
  assert.equal(first, second)

  const a = failureSignature('Error [X] 任务 12345 失败于 D:\\a\\b\\c.json')
  const b = failureSignature('Error [X] 任务 98765 失败于 E:\\x\\y\\z.json')
  assert.equal(a, b, '路径与数字抖动不该把同一次故障拆成多条')

  const c = failureSignature('Error [X] Invalid API-key provided.')
  const d = failureSignature('Error [Y] Invalid API-key provided.')
  assert.equal(c, d, '错误码前缀不该影响聚类')
})

test('only the stages that genuinely benefit get a second attempt', () => {
  // 选题与写稿：LLM 层自己会重试，再来一轮只是重复计费。
  assert.equal(STAGE_MAX_ATTEMPTS.topic, 1)
  assert.equal(STAGE_MAX_ATTEMPTS.script, 1)
  // 配音/字幕/渲染：环境类故障（引擎挂了、限流）是重试的主战场。
  // 2026-10-10 从 2 提到 4：这三种故障的恢复按分钟计，不按秒计。2026-10-09 21:00
  // 那轮配音实测 12 分 24 秒、10-10 18:13 那轮桥接整个没了，两次都被 2 次的上限判死，
  // 而产物全在盘上只差最后一次机会。
  assert.equal(STAGE_MAX_ATTEMPTS.voiceover, 4)
  assert.equal(STAGE_MAX_ATTEMPTS.video, 4)
  // 投递平台：重复提交可能真的发出去两条，所以绝不自动重试。
  assert.equal(STAGE_MAX_ATTEMPTS.publish, 1)
})

test('a dead dependency waits far longer than an ordinary glitch', () => {
  // 「服务掉了」的恢复以分钟计：保活每 5 分钟一轮，第一档就该给它 60 秒。
  // 2026-10-10 18:13 的教训——2 秒的间隔对桥接恢复毫无意义，三次全废在 38 秒里。
  const dead = repairBackoffMs(1, 'engine.down')
  const ordinary = repairBackoffMs(1, 'timeout')
  assert.ok(dead > ordinary * 2, '桥接/引擎不可达不该和普通抖动一个量级')
  assert.ok(repairBackoffMs(2, 'engine.down') > dead, '退避随尝试次数递增')
})

test('backoff never runs away', () => {
  // 原来 base*attempt 没有上限，credential.quota 叠到大 attempt 上会算出十几分钟，
  // 那已经不是退避而是卡死：轮次挂在那里既不失败也不前进。
  for (const category of [null, 'engine.down', 'credential.quota', 'timeout']) {
    for (const attempt of [1, 5, 50, 500]) {
      assert.ok(
        repairBackoffMs(attempt, category) <= REPAIR_BACKOFF_CEILING_MS,
        `${category} 第 ${attempt} 次的退避不该超过封顶值`,
      )
    }
  }
})

test('classification never throws on odd input', () => {
  for (const input of [null, undefined, '', 0, {}, new Error('')]) {
    const failure = classifyFailure({ error: input })
    assert.equal(typeof failure.category, 'string')
    assert.equal(typeof failure.remedy, 'string')
    assert.ok(failure.remedy.length > 0, '任何输入都要有一条能给人看的修法')
  }
})