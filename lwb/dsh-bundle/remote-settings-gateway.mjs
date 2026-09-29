import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const remoteInitializers = []
const MODES = new Set(['auto', 'compat', 'disabled'])

export function normalizeRemoteSettingsMode(value) {
  return MODES.has(value) ? value : 'auto'
}

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
 * Projects the product's remote-settings policy to the browser. The policy is
 * deliberately read-only so the compatibility behavior cannot be changed by
 * an untrusted page at runtime.
 */
export class LwbRemoteSettingsGateway extends TypertRemoteService {
  constructor(ctx, config = {}) {
    super(ctx, 'lwbRemoteSettings')
    this.mode = normalizeRemoteSettingsMode(config.mode)
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  policy() {
    return { schemaVersion: 1, mode: this.mode }
  }
}

decorateRemote(LwbRemoteSettingsGateway.prototype, 'policy', 'policy')

export default LwbRemoteSettingsGateway
