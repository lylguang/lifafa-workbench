import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoryAccountContent } from '../story-account-content.mjs'
import * as cover from '../story-account-cover.mjs'
import { useRoomyTempScratch } from '../../../test-utils/scratch-temp.mjs'

// 封面渲染会往工作区写真实图片；系统盘快满的机器上这些写入会失败，门就红在环境上。
// 选址口径与 launcher 一致，理由见 ../../../test-utils/scratch-temp.mjs。
useRoomyTempScratch()

async function withContent(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-cover-'))
  try {
    const content = new StoryAccountContent({ workspacePath: dir })
    await run({ content, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ----------------------------- B2-7：死代码已删除 ----------------------------- */

test('已删除的死代码不再导出（叠底图分支从未被接入）', () => {
  assert.equal(cover.renderStoryCover, undefined, 'renderStoryCover（叠字到底图）应已删除')
  assert.equal(cover.readImageSize, undefined, 'readImageSize（ffprobe 探测）零引用，应已删除')
})

test('确定性封面渲染器仍然可用', () => {
  assert.equal(typeof cover.renderPlainStoryCover, 'function', '纯色底 + 大字兜底仍应保留')
})

/* ----------------- B2-7：封面生成改为异步任务 + 状态查询 ----------------- */

test('generateCover 立即返回任务标识与状态，不阻塞等待渲染', async () => {
  await withContent(async ({ content }) => {
    const started = Date.now()
    const result = await content.generateCover({ projectId: '11111111-1111-1111-1111-111111111111', headline: '锅里的鱼记得吃完' })
    const elapsed = Date.now() - started
    assert.ok(/^[0-9a-f-]{36}$/u.test(result.id), '应返回任务 id')
    assert.equal(result.status, 'queued', '提交后应立即返回 queued 状态')
    assert.equal(result.projectId, '11111111-1111-1111-1111-111111111111')
    assert.ok(result.createdAt)
    assert.ok(elapsed < 1000, `generateCover 不应同步等 ffmpeg，实际耗时 ${elapsed}ms`)
  })
})

test('coverStatus 能按任务 id 轮询封面状态', async () => {
  await withContent(async ({ content }) => {
    const result = await content.generateCover({ projectId: '22222222-2222-2222-2222-222222222222', headline: '厨房里的暖黄灯光' })
    const status = await content.coverStatus({ id: result.id, projectId: result.projectId })
    assert.equal(status.id, result.id)
    assert.ok(['queued', 'running', 'success', 'failed'].includes(status.status), `状态应明确：${status.status}`)
    assert.ok('error' in status && 'cover' in status, '状态里应有失败原因与封面信息字段')
  })
})

test('coverStatus 无内存记录时回退到落盘文件（重启后仍可读）', async () => {
  await withContent(async ({ content }) => {
    // 没传 id，也没生成过封面文件 → 回退到 readStoryCoverInfo 的「无封面」事实。
    const status = await content.coverStatus({ projectId: '33333333-3333-3333-3333-333333333333' })
    assert.equal(status.exists, false, '没有封面文件时明确返回未生成')
    assert.equal(status.file, null)
  })
})
