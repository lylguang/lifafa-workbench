const PACK_ID = /^[a-z][a-z0-9-]{1,62}$/u
const MENU_ID = /^[a-z][a-z0-9-]{0,62}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u
const TONES = new Set(['blue', 'green', 'orange', 'pink', 'red', 'violet'])

export const LWB_PACK_SCHEMA_VERSION = 1

export class LwbPackManifestError extends Error {
  constructor(message) {
    super(`LWB capability pack manifest is invalid: ${message}`)
    this.name = 'LwbPackManifestError'
  }
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LwbPackManifestError(`${label} must be an object`)
  }
  return value
}

function text(value, label, maxLength) {
  if (typeof value !== 'string') throw new LwbPackManifestError(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new LwbPackManifestError(`${label} must contain 1-${maxLength} characters`)
  }
  return normalized
}

function optionalText(value, label, maxLength) {
  if (value === undefined) return undefined
  return text(value, label, maxLength)
}

function optionalStringList(value, label, maxItems, maxLength) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new LwbPackManifestError(`${label} must contain 1-${maxItems} text entries`)
  }
  const values = value.map((item, index) => text(item, `${label}[${index}]`, maxLength))
  if (new Set(values).size !== values.length) throw new LwbPackManifestError(`${label} must not contain duplicate entries`)
  return values
}

function optionalMarket(value) {
  if (value === undefined) return undefined
  const input = record(value, 'market')
  const category = optionalText(input.category, 'market.category', 48)
  const tags = optionalStringList(input.tags, 'market.tags', 8, 32)
  const workflow = optionalStringList(input.workflow, 'market.workflow', 16, 80)
  const icon = optionalText(input.icon, 'market.icon', 8)
  const introduction = optionalText(input.introduction, 'market.introduction', 500)
  const workflowHint = optionalText(input.workflowHint, 'market.workflowHint', 240)
  const gettingStarted = optionalStringList(input.gettingStarted, 'market.gettingStarted', 8, 240)
  let features
  if (input.features !== undefined) {
    if (!Array.isArray(input.features) || !input.features.length || input.features.length > 16) {
      throw new LwbPackManifestError('market.features must contain 1-16 entries')
    }
    const ids = new Set()
    features = input.features.map((value, index) => {
      const feature = record(value, `market.features[${index}]`)
      const menuId = text(feature.menuId, 'feature.menuId', 63)
      if (ids.has(menuId)) throw new LwbPackManifestError('market.features contains duplicate menuId')
      ids.add(menuId)
      const icon = optionalText(feature.icon, 'feature.icon', 32)
      return {
        menuId,
        title: text(feature.title, 'feature.title', 80),
        description: text(feature.description, 'feature.description', 240),
        ...(icon === undefined ? {} : { icon }),
      }
    })
  }
  if ([category, tags, workflow, icon, introduction, workflowHint, gettingStarted, features].every(value => value === undefined)) {
    throw new LwbPackManifestError('market must declare at least one field')
  }
  return {
    ...(category === undefined ? {} : { category }),
    ...(tags === undefined ? {} : { tags }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(icon === undefined ? {} : { icon }),
    ...(introduction === undefined ? {} : { introduction }),
    ...(workflowHint === undefined ? {} : { workflowHint }),
    ...(gettingStarted === undefined ? {} : { gettingStarted }),
    ...(features === undefined ? {} : { features }),
  }
}

function freeze(value) {
  if (Array.isArray(value)) value.forEach(freeze)
  else if (value && typeof value === 'object') Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

/**
 * Validate and normalize the public, browser-safe identity of one capability
 * pack. This deliberately excludes executable paths and arbitrary config: the
 * local installer owns package resolution, while DSH owns plugin loading.
 */
export function validateLwbPackManifest(value) {
  const input = record(value, 'manifest')
  if (input.schemaVersion !== LWB_PACK_SCHEMA_VERSION) {
    throw new LwbPackManifestError(`schemaVersion must be ${LWB_PACK_SCHEMA_VERSION}`)
  }
  const id = text(input.id, 'id', 63)
  if (!PACK_ID.test(id)) throw new LwbPackManifestError('id must use lowercase letters, digits, and hyphens')
  const packageName = text(input.packageName, 'packageName', 214)
  if (!PACKAGE_NAME.test(packageName)) throw new LwbPackManifestError('packageName is not a valid npm package name')
  const name = text(input.name, 'name', 120)
  const version = text(input.version, 'version', 64)
  const description = text(input.description, 'description', 500)
  const market = optionalMarket(input.market)
  if (!Array.isArray(input.menus) || input.menus.length === 0 || input.menus.length > 16) {
    throw new LwbPackManifestError('menus must contain 1-16 entries')
  }
  const menuIds = new Set()
  const menus = input.menus.map((candidate, index) => {
    const menu = record(candidate, `menus[${index}]`)
    const menuId = text(menu.id, `menus[${index}].id`, 63)
    if (!MENU_ID.test(menuId)) throw new LwbPackManifestError(`menus[${index}].id must use lowercase letters, digits, and hyphens`)
    if (menuIds.has(menuId)) throw new LwbPackManifestError(`menus contains duplicate id ${JSON.stringify(menuId)}`)
    menuIds.add(menuId)
    const label = text(menu.label, `menus[${index}].label`, 80)
    const glyph = optionalText(menu.glyph, `menus[${index}].glyph`, 8)
    const tone = optionalText(menu.tone, `menus[${index}].tone`, 16)
    if (tone !== undefined && !TONES.has(tone)) {
      throw new LwbPackManifestError(`menus[${index}].tone must be one of ${[...TONES].join(', ')}`)
    }
    return {
      id: menuId,
      label,
      ...(glyph === undefined ? {} : { glyph }),
      ...(tone === undefined ? {} : { tone }),
    }
  })
  for (const feature of market?.features || []) {
    if (!menuIds.has(feature.menuId)) throw new LwbPackManifestError('market.features references an unknown menuId')
  }
  return freeze({
    schemaVersion: LWB_PACK_SCHEMA_VERSION,
    id,
    packageName,
    name,
    version,
    description,
    ...(market === undefined ? {} : { market }),
    menus,
  })
}

/** Register a pack against the host-owned registry exposed by the LWB shell. */
export function registerLwbPack(ctx, manifest) {
  const normalized = validateLwbPackManifest(manifest)
  if (!ctx?.lwbPackRegistry || typeof ctx.lwbPackRegistry.register !== 'function') {
    throw new Error('LWB capability pack host service is unavailable; load this package from an LWB Profile.')
  }
  return ctx.lwbPackRegistry.register(normalized)
}

/** Obtain the host-issued scope after the runtime has mounted this package. */
export function getLwbPackScope(ctx, manifest) {
  const normalized = validateLwbPackManifest(manifest)
  if (!ctx?.lwbPackServices?.forPack) throw new Error('LWB pack workspace service is unavailable.')
  return ctx.lwbPackServices.forPack(normalized.id)
}
