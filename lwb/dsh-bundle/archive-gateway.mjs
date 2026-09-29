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

function sessionId(value) {
  if (typeof value !== 'string') throw new Error('sessionId must be text')
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new Error('sessionId must contain 1-256 characters')
  return normalized
}

async function restoreRegistryArchive(registry, id) {
  if (typeof registry?.unarchiveSession !== 'function') {
    throw new Error('当前 DSH Workspace Registry 不支持归档恢复。')
  }
  const restored = registry.archivedSessionIds.includes(id)
  await registry.unarchiveSession(id)
  return { restored, archivedSessionIds: [...registry.archivedSessionIds] }
}

/** Preserve LWB's response fields while delegating to DSH's public restore API. */
export class LwbArchiveGateway extends TypertRemoteService {
  static inject = ['workspaceRegistry']

  constructor(ctx) {
    super(ctx, 'lwbArchives')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  async restore(request) {
    const id = sessionId(request?.sessionId)
    return await restoreRegistryArchive(this.ctx.workspaceRegistry, id)
  }
}

decorateRemote(LwbArchiveGateway.prototype, 'restore', 'restore')

export default LwbArchiveGateway
