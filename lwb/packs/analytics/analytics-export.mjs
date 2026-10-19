/**
 * CSV 导出（方案 §4.2-12）。
 *
 * 契约写的是 `analyticsExport({from,to,accountIds?,format:'csv'}) → { assetUrl }`，
 * 但 asset URL 网关已被移出 P2（全仓暂无 asset URL 机制，publisher 与
 * spoken-video 都是把 bytes/base64 过 RPC）。为不违反字段冻结，这里**保留
 * `assetUrl` 字段并置 null**，同时把 CSV 文本内联在 `content` 里——前端用
 * `URL.createObjectURL(new Blob([content]))` 即可，与现有发布证据查看一致。
 * 等 asset 网关落地后，只要把 `assetUrl` 填上，前端无需改动。
 */

import { parseRange } from './analytics-local.mjs'

/** CSV 字段转义：含分隔符/引号/换行时用双引号包裹，内部引号翻倍。 */
function cell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (!/[",\r\n]/u.test(text)) return text
  return `"${text.replace(/"/gu, '""')}"`
}

/** 前置序数放到值前面（RFC 4180 里 BOM 让 Excel 正确识别 UTF-8 中文）。 */
const BOM = '﻿'

function toCsv(columns, rows) {
  const lines = [columns.map((column) => cell(column.label)).join(',')]
  for (const row of rows) lines.push(columns.map((column) => cell(column.get(row))).join(','))
  return BOM + lines.join('\r\n') + '\r\n'
}

/** 文件名带区间，便于用户一眼认出导出的是哪一段。 */
function filenameFor(range, prefix) {
  const day = (value) => String(value).slice(0, 10)
  return `${prefix}-${day(range.from)}_${day(range.to)}.csv`
}

export class AnalyticsExport {
  constructor({ host }) {
    this.host = host
  }

  /**
   * RPC 12。`format` 目前只支持 csv，其它值报 INVALID_INPUT 而不是静默降级。
   *
   * 数据来源就是 RPC 3 的内容列表 —— 导出与页面所见必须是同一口径，
   * 绝不另开一条查询路径（否则两边一旦漂移，用户导出的数和自己看到的对不上）。
   */
  async analyticsExport(request = {}) {
    const format = request?.format || 'csv'
    if (format !== 'csv') {
      const error = new Error(`暂不支持的导出格式：${format}`)
      error.code = 'ANALYTICS_INVALID_INPUT'
      throw error
    }
    const range = parseRange(request)
    // limit 给足，避免导出被默认分页截断成「只有前 N 条」。
    const page = await this.host.contents({
      from: request.from,
      to: request.to,
      accountIds: request.accountIds,
      platform: request.platform,
      bound: request.bound,
      sort: 'publishedAt',
      order: 'desc',
      offset: 0,
      limit: 10_000,
    })

    const columns = [
      { label: '内容ID', get: (row) => row.contentId },
      { label: '标题', get: (row) => row.title },
      { label: '平台', get: (row) => row.platform },
      { label: '账号', get: (row) => row.accountId },
      { label: '发布时间', get: (row) => row.publishedAt },
      { label: '播放', get: (row) => row.metrics?.views },
      { label: '点赞', get: (row) => row.metrics?.likes },
      { label: '评论', get: (row) => row.metrics?.comments },
      { label: '分享', get: (row) => row.metrics?.shares },
      { label: '收藏', get: (row) => row.metrics?.favorites },
      { label: '涨粉', get: (row) => row.metrics?.followersGained },
      { label: '完播率', get: (row) => row.metrics?.completionRate },
      { label: '互动率', get: (row) => row.engagementRate },
      { label: '作品链接', get: (row) => row.remoteUrl },
      { label: '数据来源', get: (row) => row.source },
      { label: '采集时间', get: (row) => row.collectedAt },
      { label: '是否已绑定', get: (row) => (row.bound ? '是' : '否') },
    ]

    return {
      // 契约字段保留但暂不可用，见文件头说明。
      assetUrl: null,
      format,
      filename: filenameFor(range, 'analytics-contents'),
      content: toCsv(columns, page.items ?? []),
      rowCount: (page.items ?? []).length,
      truncated: (page.total ?? 0) > (page.items ?? []).length,
      range: { from: request.from, to: request.to },
      generatedAt: new Date().toISOString(),
      // 动作类返回体按通用约定不带 stale；但导出的是快照，仍把来源新鲜度透出。
      stale: page.stale ?? true,
    }
  }
}

export default AnalyticsExport
