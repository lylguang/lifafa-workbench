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

/** Pack-scoped browser bridge; the host owns every workspace and browser decision. */
export class PublisherGateway extends TypertRemoteService {
  static inject = ['publisherHost']

  constructor(ctx) {
    super(ctx, 'publisher')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  status() { return this.ctx.publisherHost.status() }
  listAccounts() { return this.ctx.publisherHost.listAccounts() }
  createAccount(request) { return this.ctx.publisherHost.createAccount(request) }
  updateAccount(request) { return this.ctx.publisherHost.updateAccount(request.id, request) }
  deleteAccount(request) { return this.ctx.publisherHost.deleteAccount(request.id) }
  startLogin(request) { return this.ctx.publisherHost.startLogin(request.id) }
  confirmLogin(request) { return this.ctx.publisherHost.confirmLogin(request.id) }
  checkAccount(request) { return this.ctx.publisherHost.checkAccount(request.id) }
  closeSession(request) { return this.ctx.publisherHost.closeSession(request.id) }
  listShelf() { return this.ctx.publisherHost.listShelf() }
  startPublish(request) { return this.ctx.publisherHost.startPublish(request) }
  listJobs() { return this.ctx.publisherHost.listJobs() }
  job(request) { return this.ctx.publisherHost.job(request.jobId) }
  cancelJob(request) { return this.ctx.publisherHost.cancelJob(request.jobId) }
  // 用户在平台页面点完「发表」后回执：这一档本来没有任何回读逻辑，任务会永远
  // 停在「待确认」（2026-10-13 反馈）。
  confirmSubmitted(request) { return this.ctx.publisherHost.confirmSubmitted(request.jobId, { remoteUrl: request.remoteUrl }) }
  evidence(request) { return this.ctx.publisherHost.evidence(request) }
  settings() { return this.ctx.publisherHost.store.settings() }
  updateSettings(request) { return this.ctx.publisherHost.store.updateSettings(request) }
}

for (const method of [
  'status', 'listAccounts', 'createAccount', 'updateAccount', 'deleteAccount',
  'startLogin', 'confirmLogin', 'checkAccount', 'closeSession',
  'listShelf', 'startPublish', 'listJobs', 'job', 'cancelJob', 'confirmSubmitted', 'evidence',
  'settings', 'updateSettings',
]) {
  decorateRemote(PublisherGateway.prototype, method, method)
}

export default PublisherGateway
