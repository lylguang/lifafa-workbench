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
    category: 'credential.quota',
    test: /(\b429\b|too\s*many\s*requests|rate[\s-]?limit|额度|配额|余额不足|quota)/iu,
    retryable: true,
    autoRepair: 'backoff',
    remedy: '云端服务限流或额度不足。系统会自动退避重试；若持续出现请检查配额与并发。',
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
    category: 'content.qc_failed',
    test: /(未通过技术质检|未通过质检|主画面变化不足|审片未通过|qc\s*failed|退化为静态)/iu,
    retryable: false,
    remedy: '成片未通过质量检查。这是内容本身的问题，可让系统定向修复一次，或调整画面要求后重跑本条。',
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
      remedy: rule.remedy,
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
  'engine.down': '本地引擎不可用',
  'host.restart': '主机重启打断',
  'record.missing': '记录丢失',
  'timeout.no_progress': '阶段停滞',
  'timeout.ceiling': '超过时间上限',
  'content.qc_failed': '成片质检未过',
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