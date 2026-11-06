/**
 * 手动稿件成片 · 渠道
 *
 * 本包没有「账号定位」：用户只想把稿子做成片，渠道名是可选的一行字，用来决定
 * 发布资料的口径（同一段话发到不同渠道，标题和文案的语气不同）。
 *
 * 但下游的发布 Agent 只认「账号快照」这一种结构（`topic.account`），这是口播包
 * 定下的契约，改它就得改共享的发布提示词。所以这里把渠道名存成一份最简的账号
 * 快照——只有 id 和名字，没有定位、受众、边界这些字段。
 *
 * 渠道 id 由名字派生：同一个渠道名永远得到同一个 id（改名字等于换渠道），
 * 这样筛选、归档、默认渠道这些行为才有一致的依据。
 */
import { createHash } from 'node:crypto'

export const CHANNEL_NAME_MAX = 80

/**
 * 渠道名 → 最简账号快照。
 *
 * 返回 null 表示没填渠道：没填不是错误，稿件照常能用，只是发布资料里没有渠道口径。
 */
export function channelSnapshot(channel) {
  const name = typeof channel === 'string' ? channel.trim() : ''
  if (!name) return null
  const digest = createHash('sha1').update(`manual-script-video:${name}`).digest('hex')
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  return { id, name: name.slice(0, CHANNEL_NAME_MAX), revision: 1 }
}

/** 校验渠道名长度（界面与服务端用同一把尺）。 */
export function normalizeChannel(channel) {
  const name = typeof channel === 'string' ? channel.trim() : ''
  if (!name) return null
  if (name.length > CHANNEL_NAME_MAX) throw new Error(`渠道名最长 ${CHANNEL_NAME_MAX} 个字符。`)
  return name
}
