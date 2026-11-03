import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { creatorModel, reviewerModel } from '../index.mjs'
import { scheduleAgentOptions } from '../spoken-video-schedule-host.mjs'

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..')

test('视频导演与审片默认跟随默认模型，只有显式设置环境变量才钉死', () => {
  // 2026-11-02：这两个环节原来各自钉死 workbuddy-ai/deepseek-v4.1-flash。
  // 钉死是绕开当时两个具体故障的临时手段（默认路由组收敛不了 / 额度耗尽），
  // 但它让 UI 里换默认模型对这两个环节失效，并且屏蔽了「额度耗尽换模型重试」
  // 那条兜底（那条只在没有显式模型时才生效）。所以默认必须返回 null。
  assert.equal(creatorModel({}), null, '不设环境变量 = 跟随默认模型')
  assert.equal(reviewerModel({}), null)
  assert.equal(creatorModel({ LWB_SPOKEN_VIDEO_CREATOR_MODEL: '   ' }), null, '空白字符串等同于没设')
  assert.equal(reviewerModel({ LWB_SPOKEN_VIDEO_REVIEWER_MODEL: '' }), null)
  assert.equal(creatorModel({ LWB_SPOKEN_VIDEO_CREATOR_MODEL: 'workbuddy/hy3' }), 'workbuddy/hy3')
  assert.equal(reviewerModel({ LWB_SPOKEN_VIDEO_REVIEWER_MODEL: 'workbuddy/glm-5.3-flash' }), 'workbuddy/glm-5.3-flash')
})

test('定时任务的 AI 导演默认不传 agentOptions，环境变量仍可指定', () => {
  assert.equal(scheduleAgentOptions({}), null, '不传 agentOptions 才会落到 DSH 的默认模型')
  assert.deepEqual(
    scheduleAgentOptions({ LWB_SPOKEN_VIDEO_AGENT_MODEL: 'workbuddy-ai/hy3' }),
    { provider: 'magpie', model: 'workbuddy-ai/hy3' },
  )
  assert.deepEqual(
    scheduleAgentOptions({ LWB_SPOKEN_VIDEO_AGENT_MODEL: 'workbuddy-ai/hy3', LWB_SPOKEN_VIDEO_AGENT_PROVIDER: 'fan' }),
    { provider: 'fan', model: 'workbuddy-ai/hy3' },
  )
  // 显式设成空字符串必须报错，不能静默回落到默认——否则用户以为设了其实没生效。
  assert.throws(() => scheduleAgentOptions({ LWB_SPOKEN_VIDEO_AGENT_MODEL: '' }), /空字符串/u)
})

test('执行器配置里不再写死任何阶段模型（回归守卫）', async () => {
  // 这条是防回归：硬编码模型名会让「跟随默认模型」悄悄失效，而产物本身不会报错。
  // 只检查代码行，注释里保留历史模型名是允许的。
  const files = ['index.mjs', 'spoken-video-schedule-host.mjs']
  for (const file of files) {
    const source = await readFile(join(PACK, file), 'utf8')
    const offenders = source.split(/\r?\n/).filter((line) => {
      const code = line.split('//')[0]
      return /model:\s*['"`]/.test(code) && /workbuddy|deepseek|glm-|hy3|minimax|kimi|gpt-/u.test(code)
    })
    assert.deepEqual(offenders, [], `${file} 里不应再写死阶段模型：${offenders.join(' | ')}`)
  }
})
