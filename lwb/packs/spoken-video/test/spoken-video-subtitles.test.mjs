import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSrt, validateSrt } from '../spoken-video-subtitles.mjs'
import { SpokenVideoProjectStore, SpokenVideoStoreError } from '../spoken-video-store.mjs'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-spoken-video-srt-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'workspace')
  await mkdir(dir)
  return dir
}

function agent(cwd) { return { session: { header: { cwd } } } }

test('parses a well-formed SRT into cues', () => {
  const { cues, errors } = parseSrt('1\n00:00:00,000 --> 00:00:02,000\n先说结论。\n\n2\n00:00:02,000 --> 00:00:04,000\n不要黑盒。')
  assert.equal(errors.length, 0)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].durationMs, 2000)
  assert.equal(cues[1].text, '不要黑盒。')
})

test('rejects invalid timecodes and inverted ranges', () => {
  assert.equal(parseSrt('1\n00:00:05,000 --> 00:00:02,000\n倒序。').errors.length > 0, true)
  assert.equal(parseSrt('1\nbad --> bad\n坏时间码。').errors.length > 0, true)
  assert.equal(parseSrt('not-an-srt').errors.length > 0, true)
})

test('accepts subtitle text and timing of any length when the SRT structure is valid', () => {
  const longText = '这是一条明显超过二十二字限制的超长字幕文本示例'
  const checked = validateSrt(`1\n00:00:00,000 --> 00:00:06,000\n${longText}`)
  assert.equal(checked.errors.length, 0)
  assert.equal(Object.hasOwn(checked, 'warnings'), false)
})

test('subtitle commit stores cue metadata and blocks malformed SRT', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  let project = await store.create(currentAgent, { title: '字幕校验' })
  for (const [stage, payload] of [
    ['topic', { title: '字幕校验' }],
    ['script', { body: '正文。' }],
    ['voiceover', { notes: '配音。' }],
  ]) {
    project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage, payload, idempotencyKey: `srt-${stage}-0001` })).project
    if (stage === 'script') project = await store.approveScript(currentAgent, { projectId: project.id })
  }
  await assert.rejects(
    store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', payload: { srt: '这不是字幕' }, idempotencyKey: 'srt-bad-0001' }),
    (error) => error instanceof SpokenVideoStoreError && error.code === 'SPOKEN_VIDEO_SUBTITLES_INVALID',
  )
  const longText = '这是一条明显超过二十二字限制的超长字幕文本示例'
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'subtitles', payload: { srt: `1\n00:00:00,000 --> 00:00:02,000\n${longText}` }, idempotencyKey: 'srt-ok-0001' })).project
  const detail = await store.get(currentAgent, { projectId: project.id })
  assert.equal(detail.artifacts.subtitles.data.cueCount, 1)
  assert.equal(Object.hasOwn(detail.artifacts.subtitles.data, 'warnings'), false)
})
