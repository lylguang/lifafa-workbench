/**
 * Failure taxonomy for the unattended content pipeline.
 *
 * Everything that can go wrong in a round used to arrive as one free-text
 * `error` string, so the run record could not tell "your API key died" from
 * "this stage crashed" from "the record was evicted". Three consequences, all
 * of them observed in the 2026-10 audit of 33 rounds (24 failed):
 *
 * - nothing could be retried selectively, because nothing was classified;
 * - the message a person saw was whatever the deepest layer happened to throw
 *   (`Command failed: ...\remotion-cli.j`), which is useless to act on;
 * - a real environment problem surfaced at stage five, after twenty minutes
 *   of topic + script + voiceover had already been spent.
 *
 * `classifyFailure` gives every error a stable category, a decision (retry or
 * not), an automatic remedy where one exists, and a `signature` that collapses
 * near-identical messages into one cluster so the UI can say "this happened 7
 * times" instead of making the operator read 7 rows.
 *
 * Pure layer: no I/O, no services. The ledger that persists these records is
 * a separate module so this stays unit-testable.
 */

/** Ordered most-specific first: the first match wins. */
const RULES = [
  {
    // 模型网关/链路请求超时（含形态极简的 `Request timed out.`）。
    //
    // 2026-11-05 23:33 实测：一条视频任务以 `Request timed out.` 失败，
    // DSH 事件流里 `llm/retry` 连着 5 次、每次 code=TIMEOUT、**零工具调用**
    // ——模型一次都没响应过。这跟"代码缺陷"毫无关系，但这条报文太短，
    // 此前落进兜底的 code.defect，用户看到的是"未归类的内部错误，通常是
    // 代码缺陷。请把下面的完整错误反馈给开发者"，完全指错了方向。
    //
    // 所以给它一条规则：明确说清是模型请求超时、会重试、以及连续出现就
    // 换一条模型链路。按用户既定原则只提示换模型，不替用户改默认模型。
    category: 'model.request_timeout',
    test: /(request\s+timed\s*out|request\s+timeout|timed\s+out\s+after|上游请求超时|模型请求超时)/iu,
    retryable: true,
    autoRepair: 'restartStage',
    remedy: '模型网关请求超时——这一轮模型请求没有等到响应就被中断了（上游返回 Request timed out），Agent 没能开始生成。这不是画面质量问题，也不是程序缺陷。系统会自动重入本阶段重试；如果连续多次都超时，说明当前默认模型这条链路不稳定，请在「设置 → 模型」把默认模型切换到走另一条链路的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash，它们经 magpie 网关而非 pi-ai 网关）后再重跑。',
    remedyTarget: 'model-settings',
  },
  {
    // 视觉导演撞上时间预算被止损（"超过 50 分钟仍未提交可渲染工程…"）。
    //
    // 2026-11-05/06 实测：这条文案一直在**误诊**。原文写的是"Agent 一直在
    // 打磨但从未跑预检"，但把那次会话的 DSH 事件流解开看，真实情况是：
    // `llm/retry` 事件里连着 7–8 次重试，每次的 failure 都是上游 5 分钟
    // 没吐 token（`pi-ai stream idle timeout after 300000ms` /
    // `Request timed out.`）——时间全烧在**模型请求反复超时重试**上，
    // Agent 根本没在打磨。
    //
    // 这个误诊有实际后果：它把一个"网关链路不稳"的环境问题说成了"Agent
    // 打磨过头"，于是修法指向"调大时间预算重跑"，而真正该做的是换一条
    // 模型链路。用户按提示调预算重跑，只会再烧 50 分钟。
    //
    // 所以这条必须排在最前面：它的措辞（"仍未提交可渲染工程"）极具体，
    // 而且内嵌了上游真实报文，需要自己判断是"链路超时""被限流"还是
    // "额度耗尽"，不能被后面那些按 429/401/额度措辞匹配的规则抢走。
    category: 'video.director_budget',
    test: /(仍未提交可渲染工程|仍未提交结果（Agent|超过\s*\d+\s*(分钟|秒).{0,20}仍未提交|时间预算已到)/u,
    retryable: true,
    autoRepair: 'restartStage',
    remedy: (message) => {
      const text = String(message || '')
      // 上游真实报文被内嵌在超时文案里（由执行器从 llm/retry 事件取出）。
      // 按它区分三种根因，给出三种不同的下一步。
      const rateLimited = /(frequency\s+limit|rate_limit_error|usage\s+exceeds|429)/iu.test(text)
      const quotaGone = /(credits?\s*(exhausted|insufficient|depleted)|额度.{0,6}(不足|耗尽|用完))/iu.test(text)
      const linkIdle = /(stream\s+idle\s*timeout|idle\s+timeout|流空闲|request\s+timed\s*out|timed\s*out)/iu.test(text)
      const upstream = text.match(/最近一次失败原因：([^。；\n]{1,200})/u)
      const upstreamText = upstream ? `（上游原文：${upstream[1].trim()}）` : ''
      let cause
      if (quotaGone) {
        cause = '根因是模型网关的额度已耗尽——退避重试永远不会恢复。'
      } else if (rateLimited) {
        cause = '根因是模型网关触发了频率限制（按时间窗口计算，会自行解除）。'
      } else if (linkIdle) {
        cause = '根因是底层模型网关/链路反复超时——每次请求都没有等到响应，不是模型选错，也不是画面质量问题。'
      } else {
        cause = '这一轮模型请求阶段耗时异常，没有走到提交可渲染工程的那一步。'
      }
      return `视觉导演在时间预算内没有提交可渲染工程，本轮已被止损。${cause}${upstreamText}这不是程序缺陷。可以直接重跑本任务（阶段产物已落盘，重跑不必从零开始）；如果连续多次都卡在同一步，说明当前默认模型这条链路不稳定，请到「设置 → 模型」把默认模型切换到走另一条链路的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash，它们经 magpie 网关而非 pi-ai 网关）后再重跑；若确实是长片需要更长时间，可设置环境变量 LWB_VIDEO_DIRECTOR_TIMEOUT_MS（毫秒）调大预算。`
    },
    remedyTarget: 'model-settings',
  },
  {
    category: 'credential.invalid',
    test: /(invalid[\s-]?api[\s-]?key|api-key provided|apikey provided|unauthorized|401|鉴权失败|密钥.{0,4}(无效|失效|过期|被拒))/iu,
    retryable: false,
    remedy: '云端服务密钥已失效或被拒绝。请到「连接配置」更新对应服务的 API Key，或把该环节切换到本机桥接。',
    remedyTarget: 'media-connection',
  },
  {
    category: 'credential.missing',
    test: /(未配置\s*api\s*key|没有配置|缺少.{0,6}(api[\s-]?key|密钥)|api\s*key.{0,6}(未|空)配置)/iu,
    retryable: false,
    remedy: '云端服务尚未配置 API Key。请到「连接配置」填写，或把该环节切换到本机桥接。',
    remedyTarget: 'media-connection',
  },
  {
    // 模型网关的额度耗尽要和「普通限流」分开讲。2026-10-25 实测：默认模型
    // workbuddy-ai/minimax-m3.1-flash 的额度包用完后，网关对每次请求都直接
    // 回 429「Credits exhausted」，0.8 秒内失败；而同一个网关下 hy3、
    // deepseek-v4.1-flash、group/smart-split 全都 200。也就是说这不是
    // 「等一会儿就好」的限流，退避重试永远等不到恢复，只有换模型或充值能解。
    // 所以这条 retryable=false 且 autoRepair=null：不要拿退避去烧阶段预算，
    // 直接把人指向真正能解决它的两个动作。
    category: 'credential.model_quota',
    // 测试只认「额度真的用完了」的明确措辞，不认「模型 + 额度」这种宽松搭配：
    // 后者会把「模型返回 429 限流」也吞进不可重试的桶里，而限流恰恰是该退避的。
    test: /(credits?\s*(exhausted|insufficient|depleted)|quota\s*(exhausted|exceeded)|credit\s*package|add-on\s*packs?|账户.{0,8}(额度|余额).{0,6}(不足|耗尽|用完)|额度.{0,6}(不足|耗尽|用完))/iu,
    retryable: false,
    remedy: '当前默认模型的额度已耗尽（网关返回 429 Credits exhausted），自动重试不会恢复。请在「设置 → 模型」把默认模型切换到仍有额度的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash），或到 https://www.codebuddy.ai/profile/usage 购买额度包后再重试。',
    remedyTarget: 'model-settings',
  },
  {
    // 模型网关的**频率限制**（按时间窗口计算）与上面的「额度包耗尽」是两回事，
    // 必须分开讲，否则文案会骗人。
    //
    // 2026-11-05 23:15 实测：网关对每次请求回
    //   `WorkBuddy AI: usage exceeds frequency limit, but don't worry, your
    //    usage will reset at 2026-11-05 23:57:25 UTC+8, alternatively, you can
    //    switch to the other models to continue using it. (429: you can retry
    //    your request)`
    // 上游同时给了两件极有用的信息：**限额什么时候解除**、以及**可以换模型**。
    // 而这条报文此前落进下面的 credential.quota，配的却是「小米 TTS 声音克隆
    // 按并发限流」的文案——那是配音场景的说明书，对视频任务完全不相干，
    // 用户既看不到重置时间，也看不到换模型这个出口。
    //
    // 所以这里单列一条：retryable=true（窗口会重置，退避有意义），修法里带上
    // 报文给出的重置时间，并按用户既定原则明确指向「换模型」这个出口——
    // 但**不**替用户改默认模型，由用户自己在「设置 → 模型」决定。
    category: 'model.rate_limit',
    test: /(usage\s+exceeds\s+frequency\s+limit|frequency\s+limit|rate_limit_error|usage\s+will\s+reset)/iu,
    retryable: true,
    autoRepair: 'backoff',
    remedy: (message) => {
      // 重置时间就写在报文里，摘出来放进修法——这是用户最想知道的一件事
      // （「还有多久能好」），报文里有就绝不能丢。
      const reset = String(message || '').match(
        /reset\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\s*UTC[+-]?\d*)?)/iu,
      )
      const resetText = reset
        ? `本次限额将在 ${reset[1]} 解除。`
        : '这类限额按时间窗口计算，通常会自行解除。'
      return `模型网关的频率限制被触发了（上游返回 usage exceeds frequency limit）——这不是画面质量问题，也不是程序故障。${resetText}系统会自动退避重试；如果不想等这个窗口，请在「设置 → 模型」把默认模型切换到不受本窗口限制的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash，它们经 magpie 网关），换完直接重跑本任务即可。`
    },
    remedyTarget: 'model-settings',
  },
  {
    category: 'credential.quota',
    test: /(\b429\b|too\s*many\s*requests|rate[\s-]?limit|额度|配额|余额不足|quota)/iu,
    retryable: true,
    autoRepair: 'backoff',
    // 2026-10-26：配音的 429 有个特殊之处——小米 MiMo 对**声音克隆**的限流按
    // 「同时在飞的请求数」算，不是按请求速率。所以「等一会儿再试」这类退避
    // 并不解决问题，真正要解决的是别让多个复刻请求同时在飞（代码已按模式
    // 串行化）。文案要说清这两层，否则用户会一直等一个不会自己好的东西。
    //
    // 2026-11-06 补一层：这条规则也会命中**视频任务**里没有更具体措辞的
    // 裸 429（例如只回 `429 Too many requests`）。原先的文案整段都在讲声音
    // 克隆，对视频任务完全不相干——用户看完既不知道要换模型，也不知道
    // 声音克隆跟自己没关系。所以现在先分场景：报文里出现「模型 / 模型网关 /
    // LLM / agent」等字样时走「模型限流」的说法，并把「换模型」这个出口
    // 明确给出来（按用户既定原则只提示，不替用户改默认模型）。
    remedy: (message) => {
      const text = String(message || '')
      // 「生成未正常结束（…）」是 pack 里**模型生成环节**所有失败的统一前缀
      // （见 index.mjs 的 `生成未正常结束（${result.stopReason}）`），配音/字幕
      // 环节的报文用的是「…任务failed：」。用这个前缀把两种场景分开：
      // 模型侧的 429 要讲模型与换模型，TTS 侧的 429 要讲并发与声音克隆。
      const modelFlavored = /(生成未正常结束|模型|网关|llm|\bagent\b|model|provider|credits?|quota)/iu.test(text)
      if (!modelFlavored) {
        return '云端服务限流或额度不足。系统会自动退避重试；若持续出现请检查配额与并发。使用声音克隆（上传参考音频）时尤其要注意：该渠道按「同时在飞的请求数」限流而不是按速率，所以已经改为串行合成——若仍失败，多半是配额本身不够用，请检查服务商的用量与限流额度。'
      }
      return '模型网关返回了 429 限流。系统会自动退避重试；但如果同一窗口内反复出现，请到「设置 → 模型」把默认模型切换到仍在额度的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash），换完直接重跑本任务即可。这不是画面质量问题，也不是程序故障。'
    },
    remedyTarget: null,
  },
  {
    category: 'engine.down',
    test: /(fetch failed|econnrefused|connection refused|未连接|无法连接|可执行文件不存在|no such file|comfyui|8188|8187|引擎未启动|engine.*(down|not running))/iu,
    retryable: true,
    autoRepair: 'ensureEngine',
    // 2026-10-10 18:13 的教训：桥接整个进程没起来时，原来这句让人「打开
    // 127.0.0.1:8199 点一键启动」——而那个端口当时就是死的，页面根本打不开，
    // 建议在当场无法执行。现在先讲清系统会自己做什么，最后一步才轮到手动手，
    // 并且把「一直没好」的情况指向真正可执行的排查入口（桥接日志 / 计划任务）。
    remedy: '本地媒体桥接或推理引擎未运行。系统会依次自动拉起桥接（127.0.0.1:8199）与引擎并等待恢复，恢复后本轮自动续跑；超过等待上限仍未恢复时，请检查桥接进程是否被手工停止（E:\\lifa-scratch\\lwb-keepalive.ps1 是保活脚本，计划任务 LWBKeepAlive 应为「就绪」状态）。',
    remedyTarget: 'bridge-console',
  },
  {
    category: 'host.restart',
    test: /(主机.{0,8}重启|媒体主机在任务完成前已重启|已重启)/u,
    retryable: true,
    autoRepair: 'resume',
    remedy: '主机在任务进行中重启。本轮会从中断处自动续跑，已完成的产物不会重做。',
    remedyTarget: null,
  },
  {
    category: 'record.missing',
    test: /(不存在|丢失|已过期|not found|enoent)/iu,
    retryable: true,
    autoRepair: 'locateByRef',
    remedy: '阶段记录查不到。系统会改用精确任务标识重新定位；若仍找不到说明该记录已被保留上限淘汰。',
    remedyTarget: null,
  },
  {
    category: 'timeout.no_progress',
    test: /SPOKEN_VIDEO_SCHEDULE_NO_PROGRESS/u,
    retryable: true,
    autoRepair: 'restartStage',
    remedy: '该阶段长时间没有任何进展，已判定停滞。系统会自动重入本阶段一次。',
    remedyTarget: null,
  },
  {
    category: 'timeout.ceiling',
    test: /SPOKEN_VIDEO_SCHEDULE_TIMEOUT/u,
    retryable: true,
    autoRepair: 'restartStage',
    remedy: '该阶段超过硬性时间上限。系统会自动重入本阶段一次；若仍超时请检查中间服务的速度。',
    remedyTarget: null,
  },
  {
    // 视觉导演生成中，底层模型网关/链路超过 N 毫秒没再返回任何 token，客户端判
    // 定为「流空闲超时」并断开（「生成未正常结束（error）：<网关> stream idle
    // timeout after <ms>ms」）。2026-11-05 实测：Kimi K3.1 任务连续两次倒在导演
    // 阶段，目录子会话缓存显示实际模型是支持读图的 fan/hy4free（不是之前那个
    // 不支持看图的 glm 模型），报错里的「pi-ai」是底层网关链路名——所以是网关
    // 链路的瞬时抖动/稳定性问题，不是模型能力问题，也不是模型选错。
    //
    // 这条必须排在 credential.model_quota 之后（它更具体，只认额度耗尽的明确措辞），
    // 且必须排在兜底 code.defect 之前：否则会被误报成「未归类的内部错误请反馈给
    // 开发者」，而它重试往往能过。网关名（pi-ai / fan / magpie …）会变，只认
    // 「stream idle timeout / idle timeout」这个稳定的信号。
    //
    // 修法：先说清这是链路抖动、非模型非代码，系统会重试；再按用户既定原则给出
    // 「持续失败就换走这条链路的模型」的提示——但**不**替用户改默认模型，由用户在
    // 「设置 → 模型」决定（hy3 / deepseek-v4.1-flash 经 magpie 网关，与 pi-ai 网关不同）。
    category: 'timeout.stream_idle',
    test: /(stream\s+idle\s*timeout|idle\s*timeout|流空闲|空闲超时)/iu,
    retryable: true,
    autoRepair: 'restartStage',
    remedy: '视觉导演在生成过程中，底层模型网关/链路超过 5 分钟没有再返回任何 token，客户端判定为流空闲超时并断开（「生成未正常结束：<网关> stream idle timeout」）。这不是模型能力问题，也不是模型选错——本次实际用到的模型本身无误——而是该网关链路的一次瞬时抖动/稳定性问题，重试通常能过。系统会自动重入本阶段重试；若连续多次仍卡在流超时，多半是这条 tailnet 网关链路本身不稳，可在「设置 → 模型」把默认模型切换到走另一条链路的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash，它们经 magpie 网关而非 pi-ai 网关）后再重试。',
    remedyTarget: null,
  },
  {
    category: 'video.render_pipeline',
    test: /渲染管线无法在当前浏览器画出画面|探测帧只有一种颜色|render pipeline could not draw/u,
    retryable: false,
    // 这是程序/环境缺陷，不是用户内容问题：重跑同一浏览器只会再等满整片渲染又拿空片。
    // 给可执行动作——改用 Edge 或显式指定浏览器——而不是让用户「调整画面要求重跑」。
    remedy: '渲染管线不能在当前浏览器画出画面（探测帧只有一种颜色），属于程序/环境问题，重跑没有用。请改用 Microsoft Edge，或设置环境变量 LWB_REMOTION_BROWSER_EXECUTABLE 指向 chrome-headless-shell / Edge 的可执行文件后重跑；也可点「反馈问题」附上这条任务编号。',
    remedyTarget: null,
  },
  {
    // 审片因「当前模型不支持图像输入」而失败：这是环境性 blocker，不是画面
    // 质量问题。成片已经渲染出来了、技术质检也过了，但审片 Agent 必须
    // read_image 逐帧看画面，而所选模型（默认模型或显式指定的审片模型）
    // 声明不支持 image 输入，read_image 直接报错，审片员看不到任何画面，
    // 只能判 editorialPass=false。2026-11-05 实测：默认模型 fan/glm-5.3-flash
    // 不声明图像输入，导致一批任务集体倒在审片。根因是「选了不支持读图的
    // 模型」，该由用户改选支持读图的模型，而不是把它们误归成下面的
    // content.editorial_rejected（那类讲的是画面质量没达标、可再修）。
    //
    // 这条必须排在 content.editorial_rejected 之前：两条都能命中「仍未通过
    // 独立审片」，但本类带有明确的「模型不支持图像」信号，应优先判为模型
    // 配置问题并提示用户切换模型，而非提示「调整画面重跑」。
    //
    // 注意：这里只「提示」，不替用户换模型——默认模型该选哪个由用户在
    // 「设置 → 模型」决定（见 classifyFailure 的调用方与 CATEGORY_LABEL）。
    category: 'review.model_no_image',
    // 覆盖三种形态：上游英文原文、中文直述、以及「read_image 报错」的描述。
    test: /(model\s+does\s+not\s+declare\s+image\s*input|不支持图像输入|does\s+not\s+declare\s+image|read_image.{0,12}(报错|error)|image\s+input\s+(capability|not\s+supported))/iu,
    retryable: false,
    remedy: '独立审片需要逐帧看画面，但当前使用的审片模型不支持图像输入（read_image 读取抽帧时直接报错 “model does not declare image input”），审片员看不到任何画面，只能判不通过——这不是画面质量问题，换模型即可。请在「设置 → 模型」把默认模型切换到支持图像输入的模型（例如 workbuddy-ai/hy3、workbuddy-ai/deepseek-v4.1-flash、workbuddy-ai/step-5-preview），或在启动参数里设置 LWB_SPOKEN_VIDEO_REVIEWER_MODEL 指向上述任一模型后重试。',
    remedyTarget: 'model-settings',
  },
  {
    // 独立审片不通过：成片渲染出来了、技术质检也过了，但审片 Agent 指出
    // 了具体的视觉问题（元素迟到、语义与结论相反、断词换行错位等），定向
    // 修复若干轮后仍未达标。
    //
    // 为什么单列一条：2026-10-26 实测这条被误报成 code.defect「内部缺陷，
    // 请反馈给开发者」。实际根因是内容质量没达标——重跑/再修能解，不是代码
    // bug。而且下面的 content.qc_failed 讲的是另一回事（画面几乎全程静止、
    // 疑似渲染没画出内容），两者的处置完全不同，不能共用一条文案。
    category: 'content.editorial_rejected',
    test: /(未通过独立审片|独立审片未通过|仍未通过独立审片|审片.{0,6}(未通过|不通过)|editorial.{0,10}(reject|fail))/iu,
    retryable: false,
    remedy: '成片已经渲染出来、技术质检也过了，但独立审片指出了具体的画面问题（例如元素出现时机不对、画面语义与结论相反、断词换行错位），系统定向修复若干轮后仍未达标。这是画面质量没达标，不是程序故障：可以点「重试」再跑一轮定向修复，或在稿件里调整对应段落后重跑。',
    remedyTarget: null,
  },
  {
    category: 'content.qc_failed',
    test: /(未通过技术质检|未通过质检|主画面变化不足|审片未通过|qc\s*failed|退化为静态)/iu,
    retryable: false,
    remedy: '成片已经渲染出来了，但画面几乎全程没有变化。如果你要的就是极简/纯字幕风格，可以直接采用这条成片，不用重跑；如果不是，说明渲染环节没有把画面元素画出来，属于程序问题——重跑解决不了。这通常是因为渲染所用的浏览器无法在当前环境画出画面：请改用 Microsoft Edge，或设置环境变量 LWB_REMOTION_BROWSER_EXECUTABLE 指向 chrome-headless-shell / Edge 的可执行文件后重跑；也可点「反馈问题」并附上这条任务编号。',
    remedyTarget: null,
  },
  {
    category: 'content.invalid',
    test: /(字幕格式无效|必须晚于开始时间|格式无效|invalid\s*srt|时间轴.{0,6}(无效|错乱))/iu,
    retryable: false,
    remedy: '字幕时间轴不合规。属于内容生成缺陷，可重跑本条。',
    remedyTarget: null,
  },
  {
    category: 'publish.blocked',
    test: /(未配置发布账号|发布账号均不可用|未加载.{0,10}发布|未登录|平台未适配|未适配)/u,
    retryable: false,
    remedy: '发布目标不可用。请重新登录平台账号或重新选择发布目标。',
    remedyTarget: 'publish-accounts',
  },
  {
    category: 'preflight.blocked',
    test: /SPOKEN_VIDEO_PREFLIGHT_BLOCKED/u,
    retryable: false,
    remedy: '开工前体检未通过，任务未启动。',
    remedyTarget: null,
  },
]

/** Collapses volatile parts so the same fault clusters into one signature. */
export function failureSignature(message) {
  const text = String(message || '').replace(/Error \[[A-Z_]+\]\s*/u, '')
  return text
    .replace(/https?:\/\/\S+/giu, '<url>')
    .replace(/[A-Za-z]:\\[^\s"'，。；、）)]*/gu, '<path>')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu, '<id>')
    .replace(/\b\d{2,}\b/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * @param {object} input
 * @param {unknown} input.error       the thrown value
 * @param {string} [input.step]       the automation stage it happened in
 * @param {string} [input.code]       an explicit SpokenVideoScheduleError code
 * @returns {{category: string, retryable: boolean, autoRepair: string|null,
 *            remedy: string, remedyTarget: string|null, signature: string,
 *            message: string, code: string|null, step: string|null}}
 */
export function classifyFailure({ error, step = null, code = null } = {}) {
  const message = String(error?.message || error || '').trim()
  const explicitCode = code || (typeof error?.code === 'string' ? error.code : null)
  for (const rule of RULES) {
    if (!rule.test.test(message)) continue
    return {
      category: rule.category,
      retryable: rule.retryable === true,
      autoRepair: rule.autoRepair || null,
      remedy: typeof rule.remedy === 'function' ? rule.remedy(message) : rule.remedy,
      remedyTarget: rule.remedyTarget || null,
      signature: failureSignature(message),
      message,
      code: explicitCode,
      step,
    }
  }
  // Anything unmatched is, as far as this host is concerned, a defect in our own
  // code rather than an environment problem. It is deliberately NOT retried:
  // retrying a deterministic crash just burns the stage budget again and hides
  // the fact that it reproduces.
  return {
    category: 'code.defect',
    retryable: false,
    autoRepair: null,
    remedy: '这是一个未归类的内部错误，通常是代码缺陷。请把下面的完整错误反馈给开发者。',
    remedyTarget: null,
    signature: failureSignature(message),
    message,
    code: explicitCode,
    step,
  }
}

/** Human label per category, used by the failure-cluster panel. */
export const CATEGORY_LABEL = Object.freeze({
  'credential.invalid': '密钥失效',
  'credential.missing': '密钥未配置',
  'credential.quota': '限流或额度不足',
  'credential.model_quota': '模型额度耗尽',
  'model.rate_limit': '模型网关限流',
  'model.request_timeout': '模型请求超时',
  'engine.down': '本地引擎不可用',
  'host.restart': '主机重启打断',
  'record.missing': '记录丢失',
  'timeout.no_progress': '阶段停滞',
  'timeout.ceiling': '超过时间上限',
  'timeout.stream_idle': '网关链路流超时',
  'video.director_budget': '导演预算耗尽',
  'content.qc_failed': '成片质检未过',
  'content.editorial_rejected': '独立审片未通过',
  'video.render_pipeline': '渲染管线不可用',
  'review.model_no_image': '审片模型不支持看图',
  'content.invalid': '内容格式无效',
  'publish.blocked': '发布目标不可用',
  'preflight.blocked': '开工前体检未过',
  'code.defect': '内部缺陷',
})

/**
 * How many times a stage may be re-entered automatically. Kept small and
 * explicit: an unattended round that silently retries forever is worse than
 * one that stops and says why.
 *
 * `topic` and `script` get none — the LLM layer already retries internally, and
 * a second attempt would only re-bill a long generation.
 *
 * `voiceover`/`subtitles`/`video` 给 4 次而不是 2 次：这三个阶段真正依赖外部服务，
 * 而「服务掉线」恢复要按分钟计，不是按秒计。2026-10-09 21:00 那轮配音实测 12 分
 * 24 秒、2026-10-10 18:13 那轮桥接整个没了——两次都是被 2 次尝试的上限判死，
 * 而产物（写稿、配音 wav、字幕）全在盘上，只差最后一次机会。
 * 代价是最坏情况多等几分钟：外部依赖故障本来也不会自己好，多等的是修复窗口，
 * 不是白等。`publish` 仍然是 1——重复提交可能真的发出两条。
 */
export const STAGE_MAX_ATTEMPTS = Object.freeze({
  topic: 1,
  script: 1,
  approve: 1,
  voiceover: 4,
  subtitles: 4,
  video: 4,
  packaging: 1,
  publish: 1,
})

/** Backoff ceiling: no category waits longer than this between attempts. */
export const REPAIR_BACKOFF_CEILING_MS = 300_000

/**
 * 退避时长（毫秒），按尝试序号。
 *
 * 2026-10-10 改过：原来是 `base * attempt` 的纯线性（15s / 30s / 45s…），它对
 * 「瞬时抖动」够用，对「服务真的掉了」完全不够——桥接进程没了，15 秒后它照样没
 * 起来，第二次重试再打一次死服务，然后轮次就判失败。2026-10-10 18:13 那次就是这样
 * 在 38 秒里把 3 次机会全浪费掉的。
 *
 * 现在改成两条曲线：
 *   · 外部依赖类（engine.down / credential 等）走 60s → 180s → 300s → 300s 的
 *     阶梯，封顶 5 分钟。桥接由保活每 5 分钟拉一次，这个量级才跟得上。
 *   · 其它错误保持 15s 起步的线性，不给它们平白增加等待。
 * 封顶是必须的：原来没有上限，`credential.quota` 叠到大 attempt 上会算出十几分钟，
 * 那已经不是退避而是卡死。
 */
export function repairBackoffMs(attempt, category = null) {
  const index = Math.max(1, Number(attempt) || 1)
  if (EXTERNAL_DEPENDENCY_CATEGORIES.has(category)) {
    const ladder = [60_000, 180_000, REPAIR_BACKOFF_CEILING_MS]
    return ladder[Math.min(index - 1, ladder.length - 1)]
  }
  const quota = category === 'credential.quota'
  const base = quota ? 60_000 : 15_000
  return Math.min(base * index, REPAIR_BACKOFF_CEILING_MS)
}

/**
 * 这些类别的失败不是「这次调用没成」，而是「依赖本身不在」。
 * 重试有意义的前提是给修复留时间，所以它们享受更长的退避阶梯。
 */
export const EXTERNAL_DEPENDENCY_CATEGORIES = Object.freeze(new Set([
  'engine.down',
  'credential.invalid',
  'credential.missing',
]))