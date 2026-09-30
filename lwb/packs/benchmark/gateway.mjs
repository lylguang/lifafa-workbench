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

/** Pack-scoped browser bridge; the host resolves all workspace ownership. */
export class BenchmarkGateway extends TypertRemoteService {
  static inject = ['benchmarkHost']

  constructor(ctx) {
    super(ctx, 'benchmark')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  status() { return this.ctx.benchmarkHost.status() }
  listAccounts() { return this.ctx.benchmarkHost.listAccounts() }
  createAccount(request) { return this.ctx.benchmarkHost.createAccount(request) }
  updateAccount(request) { return this.ctx.benchmarkHost.updateAccount(request) }
  deleteAccount(request) { return this.ctx.benchmarkHost.deleteAccount(request) }
  listTeardowns() { return this.ctx.benchmarkHost.listTeardowns() }
  startTeardown(request) { return this.ctx.benchmarkHost.startTeardown(request) }
  teardownStatus(request) { return this.ctx.benchmarkHost.teardownStatus(request) }
  deleteTeardown(request) { return this.ctx.benchmarkHost.deleteTeardown(request) }
  startTopicSuggestions(request) { return this.ctx.benchmarkHost.startTopicSuggestions(request) }
  suggestionsStatus(request) { return this.ctx.benchmarkHost.suggestionsStatus(request) }
  listSuggestionBatches() { return this.ctx.benchmarkHost.listSuggestionBatches() }
}

for (const method of [
  'status', 'listAccounts', 'createAccount', 'updateAccount', 'deleteAccount',
  'listTeardowns', 'startTeardown', 'teardownStatus', 'deleteTeardown',
  'startTopicSuggestions', 'suggestionsStatus', 'listSuggestionBatches',
]) {
  decorateRemote(BenchmarkGateway.prototype, method, method)
}

export default BenchmarkGateway
