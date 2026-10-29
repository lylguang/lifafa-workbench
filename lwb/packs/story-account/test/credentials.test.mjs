import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaCredentialRef, STORY_ACCOUNT_CREDENTIAL_REFS } from '../story-account-credentials.mjs'
import { mediaCredentialRef as spokenMediaCredentialRef } from '../../spoken-video/spoken-video-media.mjs'
import { StoryAccountContent } from '../story-account-content.mjs'

/* --------------- 跨包 ref 一致：story-account 与 spoken-video 同一套密钥 --------------- */

test('story-account 与 spoken-video 对同一 provider 生成逐字节相同的 ref', () => {
  for (const provider of ['scitiger', 'bridge']) {
    assert.equal(
      mediaCredentialRef(provider),
      spokenMediaCredentialRef(provider),
      `两包对 ${provider} 的凭据 ref 必须一致（共用同一套后端密钥）`,
    )
  }
})

test('凭据 ref 就是 spoken-video 那个密钥环境变量名', () => {
  assert.equal(mediaCredentialRef('scitiger'), 'LWB_SPOKEN_VIDEO_SCITIGER_API_KEY')
  assert.equal(mediaCredentialRef('bridge'), 'LWB_SPOKEN_VIDEO_SCITIGER_API_KEY')
  assert.deepEqual([...STORY_ACCOUNT_CREDENTIAL_REFS.scitiger], ['L', 'W', 'B', '_', 'S', 'P', 'O', 'K', 'E', 'N', '_', 'V', 'I', 'D', 'E', 'O', '_', 'S', 'C', 'I', 'T', 'I', 'G', 'E', 'R', '_', 'A', 'P', 'I', '_', 'K', 'E', 'Y'])
})

test('不支持的 provider 抛出明确错误', () => {
  assert.throws(() => mediaCredentialRef('openai'), /STORY_ACCOUNT_CREDENTIAL_UNSUPPORTED/u)
})

/* ----------------- 凭据状态/保存/清除：永不回传密钥值 ----------------- */

function makeCredentials() {
  const store = new Map()
  return {
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
    async describe(ref) {
      const configured = store.has(ref)
      return { configured, source: configured ? 'env' : null, writable: true }
    },
    async resolve(ref) {
      if (!store.has(ref)) throw new Error('missing')
      return { value: store.get(ref) }
    },
  }
}

async function withContent(run) {
  const dir = await mkdtemp(join(tmpdir(), 'story-cred-'))
  try {
    const content = new StoryAccountContent({ workspacePath: dir, credentials: makeCredentials() })
    await run({ content, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('未配置时凭据状态不含密钥且可写', async () => {
  await withContent(async ({ content }) => {
    const status = await content.getMediaCredentialStatus({ provider: 'scitiger' })
    assert.deepEqual(status, { provider: 'scitiger', configured: false, source: null, writable: true })
    assert.ok(!JSON.stringify(status).includes('TOPSECRET'))
  })
})

test('保存后状态变已配置，且回执与状态都不含密钥值', async () => {
  await withContent(async ({ content }) => {
    const saved = await content.saveMediaCredential({ provider: 'scitiger', apiKey: 'TOPSECRET-123' })
    assert.deepEqual(saved, { provider: 'scitiger', configured: true })
    assert.ok(!('apiKey' in saved) && !('value' in saved), '保存回执不得回传密钥')
    const status = await content.getMediaCredentialStatus({ provider: 'scitiger' })
    assert.equal(status.configured, true)
    assert.equal(status.source, 'env')
    assert.ok(!JSON.stringify(status).includes('TOPSECRET-123'), '状态查询不得泄露密钥')
  })
})

test('清除后状态回到未配置', async () => {
  await withContent(async ({ content }) => {
    await content.saveMediaCredential({ provider: 'scitiger', apiKey: 'TOPSECRET-123' })
    const cleared = await content.clearMediaCredential({ provider: 'scitiger' })
    assert.deepEqual(cleared, { provider: 'scitiger', configured: false })
    const status = await content.getMediaCredentialStatus({ provider: 'scitiger' })
    assert.equal(status.configured, false)
  })
})

test('保存空密钥被拒', async () => {
  await withContent(async ({ content }) => {
    await assert.rejects(
      () => content.saveMediaCredential({ provider: 'scitiger', apiKey: '   ' }),
      /STORY_ACCOUNT_INVALID_INPUT|不能为空/u,
    )
  })
})

test('不支持的 provider 在保存/状态上也被拒', async () => {
  await withContent(async ({ content }) => {
    await assert.rejects(() => content.getMediaCredentialStatus({ provider: 'openai' }), /STORY_ACCOUNT_CREDENTIAL_UNSUPPORTED/u)
  })
})
