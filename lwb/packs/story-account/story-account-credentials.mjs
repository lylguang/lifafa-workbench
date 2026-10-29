/**
 * 媒体服务凭据引用。
 *
 * 与通用口播包（spoken-video）共用同一套「私有凭据库」：密钥本身不落本包，
 * 由宿主的凭据服务按 ref 名存取。这里的 ref 字符串必须与 spoken-video 的
 * `MEDIA_PROVIDER_CREDENTIAL_REFS` 逐字节一致——配音/字幕用的是同一套后端密钥。
 * 测试会锁死这一点：两包对同一 provider 生成相同 ref。
 */

export const STORY_ACCOUNT_CREDENTIAL_REFS = Object.freeze({
  scitiger: 'LWB_SPOKEN_VIDEO_SCITIGER_API_KEY',
  bridge: 'LWB_SPOKEN_VIDEO_SCITIGER_API_KEY',
})

export class StoryAccountCredentialError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

/** 生成方式 → 私有凭据库里的引用名。与 spoken-video 的 mediaCredentialRef 保持一致。 */
export function mediaCredentialRef(provider) {
  const normalized = provider === 'scitiger' || provider === 'bridge' ? provider : null
  if (!normalized) throw new StoryAccountCredentialError('STORY_ACCOUNT_CREDENTIAL_UNSUPPORTED', '该生成方式不支持保存 API Key。')
  return STORY_ACCOUNT_CREDENTIAL_REFS[normalized]
}
