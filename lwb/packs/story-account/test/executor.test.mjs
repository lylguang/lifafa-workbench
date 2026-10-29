import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StoryAccountContent } from '../story-account-content.mjs'
import { StoryAccountStore } from '../story-account-store.mjs'
import { createStructuredExecutor } from '../index.mjs'

/**
 * 生成任务的 agent 传递。
 *
 * 起因是一个真实的线上报错：账号定位点「AI 补全」时抛
 * "Cannot read properties of undefined (reading 'options')"。根因是
 * suggestProfile 调用执行器时漏传 agent，subagents.start 拿到
 * parent: undefined，DSH 内部读 agent.options 炸掉——报错完全看不出
 * 是谁漏传的。
 *
 * 这两条用例钉死两件事：调用方必须传 agent；执行器缺 agent 就地报错，
 * 不再把 undefined 往下传。
 */

async function withContent(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-exec-'))
  try {
    const content = new StoryAccountContent({ workspacePath: dir })
    content.attachProjects(new StoryAccountStore(), { workspacePath: dir })
    await run(content, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('定位补全会把工作区 agent 交给执行器', async () => {
  await withContent(async (content) => {
    const seen = []
    content.profileExecutor = async (request) => {
      seen.push(request)
      return { name: '晚风里的故事', audience: '30-40 岁女性', themes: ['marriage'] }
    }
    await content.suggestProfile({ name: '晚风里的故事' })
    assert.equal(seen.length, 1)
    // 漏传 agent 会让子会话没有父会话，进而抛 undefined.options。
    assert.ok(seen[0].agent, '执行器调用必须带 agent')
    assert.equal(seen[0].agent.workspacePath, content.workspacePath)
  })
})

test('选题生成会把工作区 agent 交给执行器', async () => {
  await withContent(async (content) => {
    const seen = []
    content.topicExecutor = async (request) => {
      seen.push(request)
      return { candidates: [{ title: '锅里的鱼', scenario: '年初三的厨房', keyLine: '你吃吧，我不饿' }] }
    }
    await content.startTopicGeneration({ theme: 'marriage', count: 1 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(seen.length >= 1)
    assert.ok(seen[0].agent, '执行器调用必须带 agent')
  })
})

test('执行器缺少 agent 时明确报错，不抛 undefined.options', async () => {
  // 直接走真实执行器的守卫（来自 index.mjs 的 createStructuredExecutor），不再用
  // 测试里自造的 guard 做同义反复：不传 agent 就应就地报「缺少工作区 agent」，
  // 而不是把 undefined 传给 subagents.start 后炸出 undefined.options。
  const executor = createStructuredExecutor({ lwbPackServices: {} }, { start: () => {} }, 'story-account-profile')
  await assert.rejects(
    () => executor({ prompt: '补全账号定位', schema: {} }),
    /缺少工作区 agent/u,
  )
})

test('没有 profileExecutor 时定位补全给出可执行说明', async () => {
  await withContent(async (content) => {
    content.profileExecutor = null
    await assert.rejects(
      () => content.suggestProfile({ name: '晚风里的故事' }),
      /模型执行接缝|补全/u,
    )
  })
})
