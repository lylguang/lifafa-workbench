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

/** Browser-safe projection of the packs mounted in the current DSH Profile. */
export class LwbPackGateway extends TypertRemoteService {
  static inject = ['lwbPackRegistry', 'lwbPackRuntime', 'lwbPackWorkspaces', 'lwbPackServices']

  constructor(ctx) {
    super(ctx, 'lwbPacks')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  async list() {
    await this.ctx.lwbPackRuntime.ready()
    return { schemaVersion: 1, packs: this.ctx.lwbPackRegistry.list() }
  }

  async market() {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackRuntime.market()
  }

  async load(request) {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackRuntime.load(request)
  }

  async unload(request) {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackRuntime.unload(request)
  }

  async visibility() {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackWorkspaces.visibility()
  }
  async clearData(request) { await this.ctx.lwbPackRuntime.ready(); return this.ctx.lwbPackRuntime.maintain(request, 'clearData') }
  async unregisterWorkspace(request) { await this.ctx.lwbPackRuntime.ready(); return this.ctx.lwbPackRuntime.maintain(request, 'unregister') }
  async executionStatus(request) { return this.ctx.lwbPackWorkspaces.run(request.id, () => this.ctx.lwbPackServices.executionStatus(request.id)) }
}

decorateRemote(LwbPackGateway.prototype, 'list', 'list')
decorateRemote(LwbPackGateway.prototype, 'market', 'market')
decorateRemote(LwbPackGateway.prototype, 'load', 'load')
decorateRemote(LwbPackGateway.prototype, 'unload', 'unload')
for (const method of ['visibility', 'clearData', 'unregisterWorkspace', 'executionStatus']) {
  decorateRemote(LwbPackGateway.prototype, method, method)
}

export default LwbPackGateway
