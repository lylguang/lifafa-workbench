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
    mustMention: /质量检查|质检/u,
  },
  {
    name: '字幕时间轴不合规',
    message: '字幕格式无效：第 134 条结束时间必须晚于开始时间。',
    category: 'content.invalid',
    retryable: false,
    mustMention: /字幕/u,
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
]

for (const testCase of HISTORICAL) {
  test(`${testCase.name} is classified as ${testCase.category}`, () => {
    const failure = classifyFailure({ error: new Error(testCase.message), step: 'voiceover' })
    assert.equal(failure.category, testCase.category)
    assert.equal(failure.retryable, testCase.retryable)
    assert.match(failure.remedy, testCase.mustMention, '修法必须说清下一步做什么')
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