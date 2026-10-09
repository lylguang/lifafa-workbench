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
export class WhiteboardGateway extends TypertRemoteService {
  static inject = ['whiteboardHost']

  constructor(ctx) {
    super(ctx, 'whiteboard')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  status() { return this.ctx.whiteboardHost.status() }
  prepareEnvironment() { return this.ctx.whiteboardHost.prepareEnvironment() }
  deliverSkill(request) { return this.ctx.whiteboardHost.deliverSkill(request.projectId) }
  parseSrt(request) { return this.ctx.whiteboardHost.parseSrt(request) }
  planTimeline(request) { return this.ctx.whiteboardHost.planTimeline(request) }
  listProjects() { return this.ctx.whiteboardHost.listProjects() }
  createProject(request) { return this.ctx.whiteboardHost.createProject(request) }
  updateProject(request) { return this.ctx.whiteboardHost.updateProject(request.id, request) }
  deleteProject(request) { return this.ctx.whiteboardHost.deleteProject(request.id) }
  listScenes(request) { return this.ctx.whiteboardHost.listScenes(request.projectId) }
  saveScene(request) { return this.ctx.whiteboardHost.saveScene(request.projectId, request) }
  deleteScene(request) { return this.ctx.whiteboardHost.deleteScene(request.projectId, request.imageName) }
  readAnnotation(request) { return this.ctx.whiteboardHost.readAnnotation(request.projectId, request.annotationName) }
  startRender(request) { return this.ctx.whiteboardHost.startRender(request.projectId, request) }
  renderStatus(request) { return this.ctx.whiteboardHost.renderStatus(request.runId) }
  cancelRender(request) { return this.ctx.whiteboardHost.cancelRender(request.runId) }
  mergeScenes(request) { return this.ctx.whiteboardHost.mergeScenes(request) }
}

for (const method of [
  'status', 'prepareEnvironment', 'deliverSkill', 'parseSrt', 'planTimeline',
  'listProjects', 'createProject', 'updateProject', 'deleteProject',
  'listScenes', 'saveScene', 'deleteScene', 'readAnnotation',
  'startRender', 'renderStatus', 'cancelRender', 'mergeScenes',
]) {
  decorateRemote(WhiteboardGateway.prototype, method, method)
}

export default WhiteboardGateway
