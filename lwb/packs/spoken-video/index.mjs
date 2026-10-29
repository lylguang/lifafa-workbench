import manifest from './lwb-pack.json' with { type: 'json' }
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import SpokenVideoGateway from './gateway.mjs'
import { SpokenVideoProjectStore } from './spoken-video-store.mjs'
import { SpokenVideoContentStore } from './spoken-video-content-store.mjs'
import { SpokenVideoMediaHost, sweepStaleTempDirectories } from './spoken-video-media-host.mjs'
import { SpokenVideoPublishHost } from './spoken-video-publish-host.mjs'
import { SpokenVideoScheduleHost } from './spoken-video-schedule-host.mjs'
import { registerSpokenVideoMediaTools } from './spoken-video-media-tools.mjs'
import { buildVideoCreatorContinuationPrompt, VIDEO_REVIEW_SCHEMA } from './spoken-video-video-agent.mjs'

export const inject = ['lwbPackRegistry', 'lwbPackServices', 'subagents', 'tools', 'settings']

// 配音渠道：小米 MiMo 是唯一启用的渠道。bailian/scitiger 仍留在枚举里，
// 这样老设置文件能继续读出来（老任务也要能打开），只是新建任务时前端只给 mimo。
const MediaConnectionSettings = z.object({
  provider: z.union(['mimo', 'bailian', 'scitiger']).default('mimo'),
  bailianReferenceVoices: z.any().default({}),
})

// `enabled` is retained only so existing settings files remain readable. Cover
// generation availability is derived from the selected provider's credential.
const PublishConnectionSettings = z.object({
  enabled: z.boolean().default(false),
  provider: z.union(['bailian', 'scitiger', 'custom']).default('bailian'),
  model: z.string().default(''),
  // 自定义云端生图的服务描述。只在 provider === 'custom' 时有意义，随任务一起
  // 冻结进 imageProvider，让已在跑的那一轮不会因为中途改配置而换服务。
  customImage: z.object({
    baseUrl: z.string().default(''),
    protocol: z.union(['openai', 'async-generic']).default('openai'),
    path: z.string().default(''),
    authHeader: z.union(['bearer', 'raw']).default('bearer'),
  }).default({ baseUrl: '', protocol: 'openai', path: '', authHeader: 'bearer' }),
})

/**
 * Structured-output executor. It spawns a one-shot structured child through
 * the harness `subagents` seam and returns the captured structured output.
 * The service handle is captured from the pack's own declared `inject` —
 * Cordis contexts only expose services named there, so reaching through
 * `agent.ctx` is rejected. All model/credential/approval boundaries stay
 * inside DSH; the pack only supplies the prompt and schema. Topic
 * generation, script generation and account completion each receive one
 * instance.
 */

// 非结构化创作（视频导演）环节的时间预算。
//
// 为什么必须有：2026-10-23 实测，一条 611 秒的长片（82 条字幕）让创作 Agent
// 在导演环节连续打磨 61 分钟仍未跑一次预检——它自己写了 audit 脚本逐幕审计，
// 又写了 21 个 tune-*.cjs 反复微调字幕入点（±0.06s 级），事件流始终活跃，
// 没有任何失败迹象，也就没有任何机制能拦它。maxRepairs 只管预检失败后的
// 修复轮次，不管单轮打磨时长；awaitWithin 只用在 ASR 上。用户看到的就是
// 「卡在 AI 导演环节 45 分钟」。
//
// 为什么是 35 分钟：2026-10-23 成功的长片导演用时 15 分钟（45dd5497，
// 676 秒片长），今天成功的一条 158 秒短片用了 15 分钟。35 分钟约为实测
// 最慢正常值的 2 倍多，正常任务不会碰到；真陷入打磨循环的任务则被及时
// 止损，错误信息里写明可直接重跑（Agent 的阶段性产物已落盘，重跑不是
// 从零开始）。
//
// 可用环境变量 LWB_VIDEO_DIRECTOR_TIMEOUT_MS 覆盖（毫秒）。设为 0 或负数
// 表示不设限——留给确有特殊长片需求的场景，但默认必须有限。
export function directorTimeBudget(env = process.env) {
  const raw = Number(env.LWB_VIDEO_DIRECTOR_TIMEOUT_MS)
  if (Number.isFinite(raw)) return raw > 0 ? raw : 0
  return 35 * 60 * 1000
}

/**
 * 审片 Agent 的时间预算。
 *
 * 2026-10-26 从历史数据挖出的根因：审片耗时是**双峰分布**，不是普遍慢。
 * 36 个审片会话里，22 个 ≤25 步（秒级完成），10 个 >50 步，最长的跑到
 * 221 步——这 10 个长尾吃掉了 84% 的 token（129.2M / 153.3M）。实测一轮
 * 成功任务（177 分钟）里，首审 56 分钟 + 复审 82 分钟 = 138 分钟，
 * 占全流程 78%。
 *
 * 为什么长尾会跑飞：审片是 `structured` 调用，而原代码里
 * `directorTimeoutMs = structured ? 0 : ...`——结构化任务的时间预算被
 * **显式设为 0，即完全无上限**。导演有 35 分钟止损，审片一分钟都没有，
 * 于是模型一旦进入「反复读帧、反复自我质疑」的循环就没人叫停。
 *
 * 预算取值：正常审片（≤25 步）在 2 分钟内完成，长尾里「还算正常」的
 * 89 步约 6 分钟。取 12 分钟——是正常值的 6 倍、留给大图多帧的余量，
 * 又能把 82 分钟那种失控死死截住。超时后按「本轮未通过」处理并进入
 * 既有返工流程，不静默放行。
 *
 * 可用 LWB_VIDEO_REVIEWER_TIMEOUT_MS 覆盖（毫秒），0 或负数表示不设限。
 */
export function reviewerTimeBudget(env = process.env) {
  const raw = Number(env.LWB_VIDEO_REVIEWER_TIMEOUT_MS)
  if (Number.isFinite(raw)) return raw > 0 ? raw : 0
  return 12 * 60 * 1000
}

/**
 * 从子会话快照里捞出「为什么 stopReason 不是 completed」的可用线索。
 *
 * 为什么需要：2026-10-25 实测，模型网关额度耗尽时它直接回 429
 * `Credits exhausted`，而 DSH 驱动层把这个上游异常吞在自己里面——子会话
 * 事件流停在 `request/header`（没有 `step/end`、没有 `llm/retry`、也没有
 * `turn/end`），`run.result` 只落地成 `{stopReason:'error'}` 且 `diagnostic`
 * 为空。于是 pack 只能拼出一句 `生成未正常结束（error）`，用户看不到
 * 「额度耗尽」，失败台账还把它归成 `code.defect`（内部缺陷）——把外部依赖
 * 故障误报成我们的代码 bug，正是最该修掉的那种误导。
 *
 * 这里按「信息量从高到低」找：先看 result 自身的 diagnostic，再看最后一个
 * error 事件，最后退回到一条可执行的判断。挖不到具体原因时也必须说清
 * 下一步该查什么，而不是把一句裸的 error 丢回去。
 */
function explainDshStop(run, result) {
  const own = typeof result?.diagnostic === 'string' ? result.diagnostic.trim() : ''
  if (own) return own
  const events = run?.localAgent?.session?.snapshotEvents?.() || []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const reason = event?.data?.reason
    // DSH 的 `turn/end` 失败原因是 `{ kind: 'error', error: LlmFailure }`，
    // LlmFailure 形状是 `{ message, code, status? }`（见
    // vendor/deepseek-harness/packages/core/session/src/types.ts 的
    // TurnEndReasonMap，以及 packages/llm/llm/src/types.ts 的 LlmFailure）。
    //
    // 2026-10-26 实测踩过的坑：这里原来只读 `reason.message` 和
    // `event.data.error.message`，两者都不存在，于是真实原因（网关 429
    // `Credits exhausted`）被整段丢掉，只剩一句「子会话以 error 结束」。
    // 这句话既不能触发 spoken-video-failure.mjs 的 credential.model_quota
    // 规则（它认的是「额度耗尽」措辞），也被误报成 code.defect（内部缺陷），
    // 用户只能看到「内部缺陷，请反馈给开发者」。
    //
    // 所以这里必须按 DSH 的真实形状读：`reason.error.message`。
    const text = typeof reason?.error?.message === 'string' ? reason.error.message
      : typeof reason?.message === 'string' ? reason.message
        : typeof event?.data?.error?.message === 'string' ? event.data.error.message
          : ''
    if (text.trim()) return text.trim()
    if (typeof reason?.kind === 'string' && reason.kind !== 'completed') return `子会话以 ${reason.kind} 结束`
  }
  // 完全没有线索：至少把「模型请求阶段就断了」这个事实说出来，指向模型配置，
  // 因为这是该形态唯一有意义的排查方向。
  //
  // 措辞刻意避开「密钥失效」「未连接」这类词：它们会命中
  // spoken-video-failure.mjs 里更靠前的 credential.invalid / engine.down 规则，
  // 把「模型额度用完了」误报成「去改连接配置的 Key」。这里统一用中性描述，
  // 由调用方按 model_quota 分类去给实际可执行的修法。
  const requested = events.some((event) => event?.type === 'request/header')
  const produced = events.some((event) => event?.type === 'assistant/message')
  if (requested && !produced) {
    return '模型在返回任何内容前就结束了本次请求（未产生 assistant 消息），最常见的原因是默认模型的额度已经用完；请检查「设置 → 模型」里默认模型是否仍可用、额度是否充足'
  }
  return ''
}

/**
 * 上游模型网关的额度耗尽是**不可重试**的失败：网关对每次请求都直接回
 * 429 `Credits exhausted`，退避等待永远不会恢复，只有换模型或充值能解。
 *
 * 2026-10-26 实测：默认模型 group/smart-split 的额度包用完后，同一台机器上
 * 选题（10:17）、审片（10:54）两个环节相继以「子会话以 error 结束」失败，
 * 而同网关下 hy3 / deepseek-v4.1-flash 仍然 200。也就是说这不是某个环节
 * 的 bug，而是「所有继承默认路由的执行器」集体踩同一个雷。
 *
 * 这里按报文判定（与 spoken-video-failure.mjs 的 credential.model_quota
 * 规则同一套措辞），命中就换一个确定还有额度的模型重试一次。
 */
function isModelQuotaExhausted(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  return /(credits?\s*(exhausted|insufficient|depleted)|quota\s*(exhausted|exceeded)|credit\s*package|add-on\s*packs?|账户.{0,8}(额度|余额).{0,6}(不足|耗尽|用完)|额度.{0,6}(不足|耗尽|用完))/iu.test(text)
}

// 额度耗尽时的备用模型。它必须满足三件事：
//   1. 支持图片输入——审片要逐帧看图；
//   2. 在实测里持续 200——hy3 与 deepseek-v4.1-flash 在默认路由组额度耗尽后
//      仍可用（2026-10-26 实测）；
//   3. 输出预算够写稿——它本身就是 128k 输出的模型。
const QUOTA_FALLBACK_MODEL = 'workbuddy-ai/deepseek-v4.1-flash'

function createDshExecutor(ctx, subagents, label, structured, { maxTokenContinuations = 0, continuationPrompt, maxTokens = 128_000, model = null, modelProvider = null, timeBudget = null, budgetLabel = null, budgetEnvHint = null } = {}) {
  // 网关 provider 名。所有可用模型都由 magpie 网关提供（settings.yaml 的
  // agent-default-model.provider 就是它），所以模型覆盖默认用同一个 provider。
  const defaultModelProvider = 'magpie'
  // 实际生效的模型：本执行器显式指定了就用它；没指定就跟随 DSH 的默认路由
  // （父会话的 provider/model 会被子会话原样继承）。
  const effectiveModel = model || null
  const dshExecutor = async function dshExecutor({ prompt, schema, agent, onDshStarted, onDshEvent, onDshContinuation, validate, repairPrompt, onDshRepair, maxRepairs = 2 }, route = {}) {
    if (agent?.workspacePath) {
      // withAgent 会用 DSH 的默认模型建一个父会话，子会话再继承它的模型。
      // 兜底重试时 route.model 必须一路带下去，否则换模型只换在这一层、
      // 真正 spawn 子会话时又被父会话的默认模型覆盖回去。
      return ctx.lwbPackServices.forPack(manifest.id).withAgent((parent) => dshExecutor({ prompt, schema, agent: parent, onDshStarted, onDshEvent, onDshContinuation, validate, repairPrompt, onDshRepair, maxRepairs }, route))
    }
    if (!subagents || typeof subagents.start !== 'function') {
      throw new Error('当前环境不提供子代理执行接缝，无法执行生成任务。')
    }
    const controller = new AbortController()
    let childSessionId = null
    let continuationCount = 0
    let continuationFailure = null
    const continuedTurns = new Set()
    let traceTail = Promise.resolve()
    const recordEvent = (event) => {
      if (!onDshEvent) return
      traceTail = traceTail.then(() => Promise.resolve(onDshEvent(event)).catch(() => {}))
    }
    let run
    const runSignal = ctx.lwbPackServices ? AbortSignal.any([controller.signal, ctx.lwbPackServices.forPack(manifest.id).signal]) : controller.signal
    const cancelChild = () => run?.localAgent?.cancel?.({ kind: 'parent' })
    const observeEvent = (session, event) => {
      if (!childSessionId || session.id !== childSessionId) return
      recordEvent(event)
      if (structured || event?.type !== 'turn/end' || event.data?.reason?.kind !== 'max-tokens') return
      const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : `seq-${event.seq}`
      if (continuedTurns.has(turn)) return
      continuedTurns.add(turn)
      if (continuationCount >= maxTokenContinuations) return
      const child = run?.localAgent
      if (!child || typeof child.followup !== 'function') {
        continuationFailure = new Error('当前子代理运行方式不支持在同一 DSH 会话中继续生成。')
        return
      }
      continuationCount += 1
      const text = continuationPrompt({ attempt: continuationCount, maximum: maxTokenContinuations })
      // **必须延后到本次 append 的发布边界之外再 followup。**
      //
      // 2026-10-25 实测：定时任务「11」的视频导演跑了 18 分钟后整轮失败，错误是
      //   `session append cannot reenter while another append is being published`
      // 来源就在这一行——`child.followup()` 本质是往子会话 append 一条 user 消息，
      // 而这里正处在 `session/event` 回调里，DSH 的 Session.append 此时带着
      // `entry.appending = true`（见 packages/core/session/src/index.ts 的重入守卫），
      // 于是同步 append 直接被判为重入并抛错，视频阶段整体挂掉、渲染一次都没开始。
      //
      // 修法：用 queueMicrotask 把 followup 推到当前同步发布流程结束之后。
      // 事件序不受影响（turn/end 已经落盘），续写仍然是同一条会话语义。
      queueMicrotask(() => {
        try {
          child.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'spoken-video-video-creator' },
          }))
          if (onDshContinuation) {
            traceTail = traceTail.then(() => Promise.resolve(onDshContinuation({
              childSessionId: String(childSessionId),
              attempt: continuationCount,
              maximum: maxTokenContinuations,
            })).catch(() => {}))
          }
        } catch (error) {
          continuationFailure = error instanceof Error ? error : new Error(String(error))
        }
      })
    }
    const disposeSessionEvent = ctx.on('session/event', observeEvent, { global: true })
    try {
      run = await subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: runSignal,
        ...(structured ? { outputSchema: schema } : {}),
        // 输出预算：选题/写稿/视频导演都走这里，统一显式申请大额度。
        //
        // 2026-10-25 实测三次失败的共同根源都是单次输出不够：
        //   · 写稿（结构化）要在一次 JSON 里装整篇稿子 —— 报 max-tokens；
        //   · 视频导演（非结构化）要一次写出 CreativeVideo.tsx，历史成功案例那个
        //     文件 84KB，而失败这轮只写出 1KB 就「连续 2 个创作轮次达到上限」。
        // 父级没配 maxTokens 时网关用模型默认值，实测 group/smart-split 会路由到
        // step-5-preview（max_out 64000），而同组 deepseek-v4.1-flash /
        // minimax-m3.1-flash 是 128000。显式要 128k 让路由到任一成员都不被卡住。
        // 模型与输出预算都必须走 agentOptions：SubagentStartRequest 里没有顶层
        // 的 model / maxTokens 字段，它们是 host-Agent 的选项（见
        // packages/subagent/subagent/src/types.ts 的 agentOptions 说明）。
        // 显式写错的后果不是报错而是被静默忽略——预算和模型都不会生效。
        ...(maxTokens || route.model || effectiveModel
          ? {
            agentOptions: {
              ...(route.model || effectiveModel ? { provider: modelProvider || defaultModelProvider, model: route.model || effectiveModel } : {}),
              ...(maxTokens ? { maxTokens } : {}),
            },
          }
          : {}),
      })
      childSessionId = run.id
      if (onDshStarted) {
        await Promise.resolve(onDshStarted({
          childSessionId: String(run.id),
          parentSessionId: typeof agent?.id === 'string' ? agent.id : null,
        })).catch(() => {})
      }
      // The one-shot run begins immediately after publication. Replay the in-memory prefix so
      // the audit timeline cannot miss an early turn or step before the listener observes it.
      const prefix = run.localAgent?.session ? [...run.localAgent.session.snapshotEvents()] : []
      prefix.forEach((event) => observeEvent(run.localAgent.session, event))
      // 非结构化创作（视频导演）加时间预算：Agent 事件流活跃不代表在收敛，
      // 2026-10-23 实测一条长片连续打磨 61 分钟仍未提交预检（期间写了 21 个
      // tune 脚本），而宿主没有任何机制能拦住它。超时通过 controller.abort()
      // 走与「能力包停止」同一条取消链路（cancelChild），子会话被有序取消，
      // 错误信息给出可执行动作。
      //
      // 结构化任务原本一律不设限（`structured ? 0`），理由是「它们有
      // structured_output 兜底与补交机制，节奏由模型轮次决定」。这个判断对
      // 选题/写稿成立，对**审片**不成立：审片同样是 structured，但它会跑成
      // 长尾（实测 10/36 个会话 >50 步，最长 221 步，吃掉 84% 的 token）。
      // 所以现在由调用方用 `timeBudget` 显式声明预算，没声明时保持原行为
      // （结构化不设限、非结构化走导演预算）。
      let directorTimer = null
      let directorDeadlineHit = false
      const budgetLabelText = budgetLabel || '视觉导演'
      const budgetEnvHintText = budgetEnvHint || 'LWB_VIDEO_DIRECTOR_TIMEOUT_MS'
      // 导演的失败语义是「没提交可渲染工程」，审片的是「没提交审片结论」。
      // 各自说清卡在哪一步，比一句通用的「没提交结果」有用。
      const budgetOutcomeText = budgetLabel ? '仍未提交结果（Agent 一直在打磨但从未收敛）' : '仍未提交可渲染工程（Agent 一直在打磨但从未跑预检）'
      const directorTimeoutMs = typeof timeBudget === 'function'
        ? timeBudget()
        : (structured ? 0 : directorTimeBudget())
      // 报错里的时长要按预算的量级选择单位：默认预算是分钟级，测试与极端配置
      // 可能是毫秒级——统一用「<60s 显示秒，其余显示分钟」。
      const directorBudgetText = directorTimeoutMs < 60_000
        ? `${(directorTimeoutMs / 1000).toFixed(1)} 秒`
        : `${Math.round(directorTimeoutMs / 60000)} 分钟`
      let result
      try {
        if (directorTimeoutMs > 0) {
          directorTimer = setTimeout(() => {
            directorDeadlineHit = true
            controller.abort(new Error(`${budgetLabelText}时间预算已到。`))
          }, directorTimeoutMs)
        }
        result = await run.result
      } catch (error) {
        // 超时触发的取消，无论子会话以 reject 还是非 completed 收尾，都要把
        // 「为什么停、下一步做什么」讲清楚，而不是让用户看到一句裸的取消错误。
        if (directorDeadlineHit) {
          throw new Error(
            `${budgetLabelText}超过 ${directorBudgetText}${budgetOutcomeText}。`
            + '已停止本轮以止损：可直接重跑本任务，阶段产物已落盘，重跑不必从零开始；'
            + `如确需更长时间，可设置环境变量 ${budgetEnvHintText}（毫秒，当前 ${directorTimeoutMs}）后重启。`,
          )
        }
        throw error
      } finally {
        if (directorTimer) clearTimeout(directorTimer)
      }
      // 超时后子会话也可能「正常收尾」（cancel 的 turn/end 可能先于 abort 传播），
      // 那时 result 存在但 stopReason 不是 completed——同样要给出超时语境。
      if (directorDeadlineHit) {
        throw new Error(
          `${budgetLabelText}超过 ${directorBudgetText}${budgetOutcomeText}。`
          + '已停止本轮以止损：可直接重跑本任务，阶段产物已落盘，重跑不必从零开始；'
          + `如确需更长时间，可设置环境变量 ${budgetEnvHintText}（毫秒，当前 ${directorTimeoutMs}）后重启。`,
        )
      }
      await traceTail
      if (continuationFailure) throw continuationFailure
      // 结构化任务（写稿/选题）撞上单次输出上限时的补救。
      //
      // 2026-10-25 实测：定时任务「11」在写稿阶段失败，错误是
      // `生成未正常结束（max-tokens）：子会话以 max-tokens 结束`。事件流显示
      // 模型打了 8 分钟、最后一条是「DSH 达到单次输出上限，正在继续」，
      // 然后就没有下文了——因为续写机制（observer 里的 followup）只对
      // **非结构化**任务生效（`if (structured || ...) return`），写稿恰恰是
      // structured。而写稿要产出一两千字的口播稿，恰恰是最容易触顶的环节。
      //
      // 这里补一次同会话续写：告诉它上轮被截断、请接着把结构化结果完整提交。
      // 只给一次机会——真接不上就如实报错，不要无限续。
      if (structured && result.stopReason === 'max-tokens') {
        const child = run.localAgent
        if (child?.followup && child?.whenIdle) {
          await onDshContinuation?.({
            childSessionId: String(childSessionId),
            attempt: 1,
            maximum: 1,
            label: '输出触顶，要求续写并提交',
          }).catch(() => {})
          child.followup(createUserMessage({
            content: [{
              type: 'text',
              text: '你上一次的输出达到了单次长度上限，被截断了。请接着已生成的内容把剩余部分写完，'
                + '并确保最终通过 structured_output 工具提交**完整**结果（参数必须完全符合给定 schema）。'
                + '不要重复已输出的部分，不要输出解释性文字。',
            }],
            source: { kind: 'plugin', plugin: 'spoken-video-script' },
          }))
          await child.whenIdle()
          await traceTail
          runSignal.throwIfAborted()
          const continued = await run.result
          if (continued.structured !== undefined) result = continued
        }
      }
      if (result.stopReason !== 'completed') {
        if (!structured && result.stopReason === 'max-tokens' && maxTokenContinuations > 0) {
          throw new Error(`视频 Agent 连续 ${continuationCount + 1} 个创作轮次达到单次输出上限，未能完成可渲染工程。`)
        }
        const detail = explainDshStop(run, result)
        // 额度耗尽是唯一值得「换个模型再来一次」的失败：网关对每次请求都直接回
        // 429，退避永远等不到恢复，但同网关下别的模型还有额度。
        //
        // 2026-10-26 实测：默认路由组 group/smart-split 额度用完后，选题与审片
        // 两个环节相继失败。explainDshStop 修好之前，这里根本看不出是额度问题；
        // 修好之后能读到上游原文，才谈得上自动换模型。
        //
        // 只给一次机会，且仅在**没有显式指定模型**时换——显式指定意味着用户/
        // 上层对这个环节的模型有明确要求，不能悄悄替换。审片与视频导演都显式
        // 指定了模型（它们各自的形态都绑定过具体模型），所以它们本来就不会
        // 走到这条分支；走这条分支的是选题/写稿/账号这类跟随默认路由的执行器。
        if (!route.quotaRetried && !effectiveModel && isModelQuotaExhausted(detail)) {
          route.quotaRetried = true
          const fallback = QUOTA_FALLBACK_MODEL
          await onDshEvent?.({
            type: 'quota/fallback',
            data: { reason: { kind: 'quota-fallback', message: `当前模型额度已耗尽，改用 ${fallback} 重试一次` } },
          }).catch(() => {})
          return await dshExecutor({ prompt, schema, agent, onDshStarted, onDshEvent, onDshContinuation, validate, repairPrompt, onDshRepair, maxRepairs }, { ...route, model: fallback })
        }
        throw new Error(`生成未正常结束（${result.stopReason}）${detail ? `：${detail}` : ''}`)
      }
      // structured 轮次正常结束但从未调 structured_output：模型偶尔会直接用一段
      // 短文本收尾（2026-10-17 晚报实测：turn 正常 completed、文本仅百余 token、
      // 无任何工具调用），in-process-driver 会把这种结果降级成 stopReason='error'
      // 且不带 diagnostic——报错只有「生成未正常结束（error）」，且此前一次机会
      // 都不重试。这里在判定之前给一次同会话补交的机会：followup 提醒模型必须
      // 走 structured_output 提交，成功则照常返回。
      if (structured && result.structured === undefined) {
        const child = run.localAgent
        if (child?.followup && child?.whenIdle) {
          await onDshContinuation?.({
            childSessionId: String(childSessionId),
            attempt: continuationCount + 1,
            maximum: 1,
            label: '模型未提交结构化结果，要求补交',
          }).catch(() => {})
          child.followup(createUserMessage({
            content: [{ type: 'text', text: '你的上一轮回答是普通文本，没有调用 structured_output 工具提交结果。请严格按任务要求重新产出完整结果，并必须通过 structured_output 工具提交（参数须完全符合给定 schema）。不要输出任何普通文本作为最终答案。' }],
            source: { kind: 'plugin', plugin: 'spoken-video-video-creator' },
          }))
          await child.whenIdle()
          await traceTail
          runSignal.throwIfAborted()
          const followup = await run.result
          if (followup.structured !== undefined) result = followup
        }
      }
      if (structured && result.structured === undefined) {
        throw new Error('生成未正常结束（error）：模型未通过 structured_output 提交结果（已重试一次）。')
      }
      // The driver keeps the published local child alive until dispose(). A repair
      // is another turn in that same session, after the first result has settled.
      if (!structured && validate) {
        runSignal.addEventListener('abort', cancelChild, { once: true })
        const maximum = Math.max(0, Math.min(2, Number.isSafeInteger(maxRepairs) ? maxRepairs : 2))
        for (let attempt = 0; ; attempt += 1) {
          runSignal.throwIfAborted()
          const report = await validate()
          runSignal.throwIfAborted()
          if (report.passed || report.repairable !== true || attempt >= maximum) break
          const child = run.localAgent
          if (!child?.followup || !child?.whenIdle || !repairPrompt) break
          const boundary = child.session.seq
          await onDshRepair?.({ attempt: attempt + 1, maximum, failures: report.failures, childSessionId: String(run.id) })
          runSignal.throwIfAborted()
          child.followup(createUserMessage({
            content: [{ type: 'text', text: repairPrompt({ report, attempt: attempt + 1, maximum }) }],
            source: { kind: 'plugin', plugin: 'spoken-video-video-preflight' },
          }))
          await child.whenIdle()
          await traceTail
          runSignal.throwIfAborted()
          if (continuationFailure) throw continuationFailure
          const events = child.session.snapshotEvents(boundary)
          const end = events.findLast((event) => event.type === 'turn/end')
          if (end?.data?.reason?.kind !== 'completed') throw new Error(`视频修复未正常结束（${end?.data?.reason?.kind || 'unknown'}）`)
          result = { ...result, output: events.filter((event) => event.type === 'assistant/message').at(-1)?.data?.message?.content || [] }
        }
      }
      return structured
        ? result.structured
        : { childSessionId: String(run.id), output: result.output }
    } finally {
      runSignal.removeEventListener('abort', cancelChild)
      disposeSessionEvent()
      await run?.dispose().catch(() => {})
    }
  }
  // 外层包装：额度兜底重试需要跨一次完整执行，所以真正的执行体是 dshExecutor，
  // 这里只负责把「本轮用了哪个模型」这个状态带进去，并保证兜底只发生一次。
  return (input) => dshExecutor(input, {})
}

// 导出仅供测试：验证 structured 任务不受导演时间预算约束。
export function createStructuredExecutor(ctx, subagents, label, options = {}) {
  return createDshExecutor(ctx, subagents, label, true, options)
}

export function createAgentExecutor(ctx, subagents, label, options = {}) {
  return createDshExecutor(ctx, subagents, label, false, options)
}

/** Host entry for the standalone spoken-video capability pack. */
export async function apply(ctx, config = {}) {
  if (config.clientOnly) return
  if (!ctx.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('The spoken-video pack must be loaded by an LWB Profile.')
  }
  assertObjectJsonSchema(VIDEO_REVIEW_SCHEMA)
  const scope = ctx.lwbPackServices.forPack(manifest.id)
  const context = await scope.context()
  ctx.provide('spokenVideoScope', scope)
  const projects = new SpokenVideoProjectStore()
  const connectionSettings = ctx.settings.register(scope.settingsNamespace('media'), MediaConnectionSettings, { base: {} })
  const content = new SpokenVideoContentStore({
    workspacePath: context.workspacePath, background: scope.background, fetch: scope.fetch,
    topicExecutor: config.topicExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-topic'),
    scriptExecutor: config.scriptExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-script'),
    accountExecutor: config.accountExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-account'),
    projectsStore: projects,
  })
  // 清掉上次进程被硬杀时留下的暂存目录（整段配音音频，会把系统盘吃掉）。
  // 失败不阻断加载：清理是维护动作，不该让能力包起不来。
  void sweepStaleTempDirectories().catch(() => {})
  const media = new SpokenVideoMediaHost({
    background: scope.background, fetch: scope.fetch, signal: scope.signal,
    projectsStore: projects,
    credentials: scope.credentials,
    connectionSettings,
    videoCreator: config.videoCreator || createAgentExecutor(ctx, ctx.subagents, 'spoken-video-video-creator', {
      // 2026-10-25 从 2 抬到 4。依据：视频导演要写出 CreativeVideo.tsx，历史成功
      // 案例那个文件 30–119KB；而失败这轮「连续 2 个创作轮次达到单次输出上限」
      // 就判死了，src/CreativeVideo.tsx 只落下 1KB。一个 84KB 的组件本来就该
      // 允许分几次写完，2 次续写对它的体量明显不够。上限仍是有限的 4 次。
      maxTokenContinuations: 4,
      continuationPrompt: buildVideoCreatorContinuationPrompt,
      // 视频导演**单独指定模型**，不跟随默认的 group/smart-split。
      //
      // 2026-10-25 失败日志分析：那次 33 次工具调用里 31 次是 read/glob，
      // 一次 write 都没有——13.5 分钟全在读 skill 文档，src 只落下 1KB 骨架，
      // 最后一条 assistant 消息文本 0、工具 0（被截断）。说明真正的问题不是
      // 额度不够，而是路由到的 step-5-preview 在这类长任务上收敛不了。
      //
      // 选 deepseek-v4.1-flash 的依据是同条件实测（写一个含 5 场景、带
      // useCurrentFrame/interpolate 的完整 Remotion 组件）：
      //   deepseek-v4.1-flash  13.1s / 12615 字符 / finish=stop  ✅
      //   zcode/GLM-5.3        20.4s /  6947 字符 / finish=stop
      //   workbuddy-ai/hy3     12.3s /     0 字符               ✗
      //   workbuddy-ai/gpt-6-luna             429 额度耗尽        ✗
      // 用它还有一个好处：它本身就是 128k 输出的模型，不再被 step-5-preview
      // 的 64k 上限卡住。
      model: 'workbuddy-ai/deepseek-v4.1-flash',
    }),
    videoReviewer: config.videoReviewer || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-video-reviewer', {
      // 审片 Agent **单独指定模型**，不跟随默认路由。
      //
      // 2026-10-26 实测根因：两条成片（鹤岗房、AI 数字人）渲染完全成功、
      // 技术质检也过了，全都倒在审片这一步，报「子会话以 error 结束」。
      // 挖到子会话后发现 LLM token 用量全是 0——模型压根没被调用成功。
      // 直接打网关复现，得到上游原话：
      //   HTTP 429 「WorkBuddy AI: Credits exhausted」
      // 也就是说**默认模型 group/smart-split 的额度包已经用完**。同一个网关
      // 下 hy3 / deepseek-v4.1-flash 仍然 200，所以这不是网关整体故障，是
      // 默认路由组这一个模型没额度了。
      //
      // 审片本来是继承父会话的模型（DSH 的 resolveChildAgentOptions 会把
      // parent 的 provider/model 原样传给子会话），而父会话用的是默认路由
      // 组 —— 于是审片跟着一起挂。审片是纯视觉判断任务、输出很小，用不着
      // 路由组那套「难题给强模型」的能力，所以这里钉死到一个确定还有额度、
      // 且支持图片输入（审片要逐帧看图）的模型。
      //
      // 注意 model 必须写成 provider 限定的全名，且和上面 creator 用同一个
      // 模型：它在 2026-10-25 的实测里已经证明能稳定跑完审片形态，且
      // 2026-10-26 这次实测它依然 200。
      model: 'workbuddy-ai/deepseek-v4.1-flash',
      // 审片的时间预算。原先结构化任务一律不设限（`structured ? 0`），
      // 导致审片跑成长尾：实测 10/36 个会话 >50 步（最长 221 步），
      // 吃掉 84% 的 token；一轮任务里首审 56 分钟 + 复审 82 分钟，
      // 占全流程 78%。正常审片 ≤25 步、2 分钟内完成，12 分钟预算
      // 足以覆盖大图多帧，又能把失控轮次截住。
      timeBudget: reviewerTimeBudget,
      budgetLabel: '独立审片',
      budgetEnvHint: 'LWB_VIDEO_REVIEWER_TIMEOUT_MS',
    }),
  })
  const publishConnectionSettings = ctx.settings.register(scope.settingsNamespace('publish'), PublishConnectionSettings, { base: {} })
  const publish = new SpokenVideoPublishHost({
    background: scope.background, fetch: scope.fetch,
    projectsStore: projects,
    credentials: scope.credentials,
    connectionSettings: publishConnectionSettings,
    packageExecutor: config.publishExecutor || createStructuredExecutor(ctx, ctx.subagents, 'spoken-video-publish'),
  })
  // Scheduling uses the same owned data context and DSH defaults as manual jobs.
  const schedule = new SpokenVideoScheduleHost({
    context, background: scope.background,
    executionStatus: () => ctx.lwbPackServices.executionStatus(manifest.id),
    ctx,
    content,
    projects,
    media,
    publish,
  })
  ctx.provide('spokenVideoProjects', projects)
  // 供兄弟能力包（数据看板）读取生产漏斗：预先绑定好本包工作区，
  // 调用方无需也无法提供 agent。
  // 2026-10-29 修：看板原先直接拿 projects store 调 pipelineOverview()，
  // 而 store 需要含 workspacePath 的 agent——跨包调用拿不到，
  // 漏斗永远报 SPOKEN_VIDEO_WORKSPACE_REQUIRED。
  ctx.provide('spokenVideoPipeline', {
    pipelineOverview: async () => projects.pipelineOverview({ workspacePath: context.workspacePath }),
  })
  ctx.provide('spokenVideoContent', content)
  ctx.provide('spokenVideoMedia', media)
  ctx.provide('spokenVideoPublish', publish)
  ctx.provide('spokenVideoSchedule', schedule)
  ctx.plugin(SpokenVideoGateway)
  registerSpokenVideoMediaTools(ctx, media, scope)
  ctx.effect(() => { const stop = content.startScheduler(); scope.onStop(stop); return stop }, 'spoken-video: durable content scheduler')
  ctx.effect(() => { const stop = schedule.startScheduler(); scope.onStop(stop); return stop }, 'spoken-video: durable content schedule orchestrator')
  ctx.effect(() => ctx.lwbPackRegistry.register(manifest), 'spoken-video: register LWB capability pack')
}
