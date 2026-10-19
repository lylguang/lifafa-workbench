import { AnalyticsExport } from './analytics-export.mjs'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const remoteInitializers = []

function decorateRemote(prototype, method, exportName) {
  const decorate = Remote(exportName)
  decorate(prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer) },
  })
}

/**
 * 数据看板网关（P1）。
 *
 * 方法名与《数据看板需求拆解方案》定稿 v1.0 §4.2 逐字一致，前端只认这套名字；
 * 聚合实现由 AnalyticsLocalSource 提供（档位 A 本地数据），
 * P2 起同一批方法背后会接上平台采集器，前端无需改动。
 */
export class AnalyticsGateway extends TypertRemoteService {
  static inject = ['analyticsHost']

  constructor(ctx) {
    super(ctx, 'analytics')
    this.exporter = new AnalyticsExport({ host: ctx.analyticsHost })
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  analyticsSummary(request) { return this.ctx.analyticsHost.summary(request) }
  analyticsAccounts(request) { return this.ctx.analyticsHost.accounts(request) }
  analyticsContents(request) { return this.ctx.analyticsHost.contents(request) }
  analyticsSeries(request) { return this.ctx.analyticsHost.series(request) }
  // P2：采集与绑定。方法名与定稿 v1.0 §4.2 逐字一致。
  startCollection(request) { return this.ctx.analyticsHost.startCollection(request) }
  collectionStatus(request) { return this.ctx.analyticsHost.collectionStatus(request) }
  collectionRuns(request) { return this.ctx.analyticsHost.collectionRuns(request) }
  updateContentMetrics(request) { return this.ctx.analyticsHost.updateContentMetrics(request) }
  bindContent(request) { return this.ctx.analyticsHost.bindContent(request) }
  bindAll(request) { return this.ctx.analyticsHost.bindAll(request) }
  analyticsExport(request) { return this.exporter.analyticsExport(request) }
}

for (const method of [
  'analyticsSummary', 'analyticsAccounts', 'analyticsContents', 'analyticsSeries',
  'startCollection', 'collectionStatus', 'collectionRuns',
  'updateContentMetrics', 'bindContent', 'bindAll', 'analyticsExport',
]) {
  decorateRemote(AnalyticsGateway.prototype, method, method)
}

export default AnalyticsGateway
