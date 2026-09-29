import { validateLwbPackManifest } from '../pack-sdk/index.mjs'

function sameManifest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Host-owned inventory of packs that have actually mounted in this Profile.
 * It is intentionally in-memory: the local registry only records discoverable
 * sources, while the Cordis Loader is the source of truth for this process.
 */
export class LwbPackRegistry {
  constructor() {
    this.packs = new Map()
  }

  register(manifest) {
    const normalized = validateLwbPackManifest(manifest)
    const existing = this.packs.get(normalized.id)
    if (existing) {
      if (sameManifest(existing, normalized)) {
        throw new Error(`LWB capability pack ${JSON.stringify(normalized.id)} registered more than once`)
      }
      throw new Error(`LWB capability pack id collision: ${JSON.stringify(normalized.id)}`)
    }
    for (const pack of this.packs.values()) {
      if (pack.packageName === normalized.packageName) {
        throw new Error(`LWB capability package collision: ${JSON.stringify(normalized.packageName)}`)
      }
    }
    this.packs.set(normalized.id, normalized)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.packs.get(normalized.id) === normalized) this.packs.delete(normalized.id)
    }
  }

  list() {
    return [...this.packs.values()].map((manifest) => ({
      schemaVersion: manifest.schemaVersion,
      id: manifest.id,
      packageName: manifest.packageName,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      menus: manifest.menus.map((menu) => ({ ...menu })),
    }))
  }
}
