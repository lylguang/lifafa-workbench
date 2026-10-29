import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { invalidateDownstream, safeJoin } from '../story-account-store.mjs'

const PROJECT_ID = 'p-inv'

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'story-inv-'))
  const root = join(workspace, 'data', 'projects', PROJECT_ID)
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await mkdir(join(workspace, 'data', 'media', 'voiceovers'), { recursive: true })
  await mkdir(join(workspace, 'data', 'media', 'subtitles'), { recursive: true })
  return { workspace, root, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

test('safeJoin 拒绝逃逸工作区的路径', () => {
  const dir = '/tmp/workspace'
  assert.equal(safeJoin(join(dir, 'data', 'projects', 'p'), '../secret.txt', dir), null, '含 .. 的路径必须拒绝')
  assert.equal(safeJoin(join(dir, 'data'), '/etc/passwd', dir), null, '绝对路径必须拒绝')
  assert.equal(safeJoin(join(dir, 'data'), 'https://x/y', dir), null, '带协议前缀的路径必须拒绝')
  // 合法相对路径解析后仍落在工作区内。
  const base = join(dir, 'data', 'projects', 'p')
  const expected = resolve(base, 'artifacts/x.json')
  const ok = safeJoin(base, 'artifacts/x.json', dir)
  assert.equal(ok, expected, '合法路径应被接受')
})

test('invalidateDownstream 删指针并连同产物 JSON 与内嵌媒体一起删', async () => {
  const { workspace, root, cleanup } = await setup()
  try {
    const artifactFile = 'artifacts/1-voiceover-a.json'
    const mediaFileRel = 'media/voiceovers/a.wav'
    await writeFile(join(root, artifactFile), JSON.stringify({ data: { audio: { file: mediaFileRel } } }))
    await writeFile(join(workspace, 'data', mediaFileRel), 'audio-bytes')
    const project = { artifacts: { voiceover: { file: artifactFile } } }
    await invalidateDownstream(project, 'voiceover', { root, workspace })
    assert.deepEqual(project.artifacts, {}, '指针应被清空')
    await assert.rejects(() => stat(join(root, artifactFile)), '产物 JSON 应被删除')
    await assert.rejects(() => stat(join(workspace, 'data', mediaFileRel)), '内嵌媒体应被删除')
  } finally {
    await cleanup()
  }
})

test('invalidateDownstream 只删 >= 目标阶段，并守住工作区红线', async () => {
  const { workspace, root, cleanup } = await setup()
  try {
    await writeFile(join(root, 'artifacts/1-topic.json'), JSON.stringify({ data: {} }))
    await writeFile(join(root, 'artifacts/2-subtitles.json'), JSON.stringify({ data: { srtFile: 'media/subtitles/s.srt' } }))
    await writeFile(join(workspace, 'data', 'media', 'subtitles', 's.srt'), 'srt')
    const project = {
      artifacts: {
        topic: { file: 'artifacts/1-topic.json' },
        subtitles: { file: 'artifacts/2-subtitles.json' },
      },
    }
    // 目标选 voiceover：上游 topic 应保留，下游 subtitles 应被删。
    await invalidateDownstream(project, 'voiceover', { root, workspace })
    assert.ok(project.artifacts.topic, '上游 topic 指针应保留')
    assert.equal(project.artifacts.subtitles, undefined, '下游 subtitles 指针应被删')
    await assert.doesNotReject(() => stat(join(root, 'artifacts/1-topic.json')), 'topic 产物应保留')
    await assert.rejects(() => stat(join(root, 'artifacts/2-subtitles.json')), 'subtitles 产物应被删')
    await assert.rejects(() => stat(join(workspace, 'data', 'media', 'subtitles', 's.srt')), 'subtitles 媒体应被删')
  } finally {
    await cleanup()
  }
})
