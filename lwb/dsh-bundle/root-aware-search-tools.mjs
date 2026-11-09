// Host-plane fix for DSH's `glob` / `grep` ripgrep commands.
//
// The upstream tools build root-relative `--glob` filters but always spawn
// ripgrep from the session cwd, passing the requested search root as a path
// argument. A root such as `data/projects/p1/media/root` therefore misses
// `root/public/sfx/*.wav` when the model writes `public/sfx/*.wav`.
//
// Keep the model-facing tools, schemas, caps, and rendering untouched. Insert
// one additive positive glob at the subprocess seam: the original include
// keeps its CWD-relative meaning, while the fallback matches it relative to
// the explicit search root. Multiple positive `--glob` flags are ORed by
// ripgrep; exclusions and the trailing `-- <path>` remain unchanged.

import { isAbsolute, relative, resolve } from 'node:path'

export const ROOT_AWARE_SEARCH_INSTALL = Symbol.for('lwb.rootAwareSearch.install')
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** Extract a positive `--flag=value` option without matching excludes. */
function optionValue(argv, name) {
  const prefix = `${name}=`
  const option = argv.find((part) => typeof part === 'string'
    && part.startsWith(prefix)
    && (name !== '--glob' || !part.slice(prefix.length).startsWith('!')))
  return option === undefined ? undefined : option.slice(prefix.length)
}

/** Convert Windows path separators to the forward slashes ripgrep globs use. */
function globPath(value) {
  return value.replaceAll('\\', '/').replace(/\/{2,}/gu, '/')
}

function normalizePattern(pattern) {
  return typeof pattern === 'string'
    ? pattern.replaceAll('\\', '/').replace(/^\.\/(?=.)/u, '')
    : undefined
}

function isAbsoluteGlob(pattern) {
  return pattern.startsWith('/') || /^[A-Za-z]:/u.test(pattern) || isAbsolute(pattern)
}

/**
 * Resolve one search-tool pattern against the requested search root.
 *
 * Slash-free and any-depth patterns already match at any depth and are unchanged.
 * When root is inside the session cwd, prefix its CWD-relative path; when it
 * is outside, use an any-depth prefix. A relative root is resolved against
 * sessionCwd. Returns undefined when there is nothing to add.
 */
export function resolveRootAnchoredPattern(pattern, root, sessionCwd) {
  const normalized = normalizePattern(pattern)
  if (normalized === undefined || normalized.length === 0 || normalized.startsWith('**/')) return undefined
  if (isAbsoluteGlob(normalized) || !normalized.includes('/')) return undefined
  if (root === undefined || root === null || typeof root !== 'string' || root.trim().length === 0) return undefined

  const rootValue = root.trim()
  const absoluteRoot = resolve(sessionCwd || process.cwd(), rootValue)
  const relativeRoot = relative(resolve(sessionCwd || process.cwd()), absoluteRoot)
  const rootIsInside = relativeRoot.length > 0
    && relativeRoot !== '..'
    && !relativeRoot.startsWith('..\\')
    && !relativeRoot.startsWith('../')
    && !isAbsolute(relativeRoot)
  const rootPrefix = globPath(relativeRoot)
  const prefix = rootIsInside ? rootPrefix : '**'
  return `${prefix}/${normalized}`
}

/** Locate the trailing `-- <path>` target in a built search command. */
function searchRoot(argv) {
  const marker = argv.lastIndexOf('--')
  if (marker < 0 || marker + 1 >= argv.length) return undefined
  const value = argv[marker + 1]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Add one root-anchored positive glob to a `glob` or `grep` ripgrep command.
 * Argv is the complete subprocess vector (binary first); cwd is its workdir.
 */
export function rewriteRootAwareSearchSpec(spec) {
  if (!spec || !Array.isArray(spec.argv) || typeof spec.cwd !== 'string') return spec
  const argv = spec.argv
  if (argv.length < 2 || argv[1] !== '--no-config') return spec

  const globPattern = optionValue(argv, '--glob')
  const isGlobCommand = argv.includes('--files')
  const isGrepCommand = argv.includes('--json') && optionValue(argv, '--regexp') !== undefined
  if ((!isGlobCommand && !isGrepCommand) || globPattern === undefined || !argv[0] || !/ripgrep|rg(?:\.exe)?$/iu.test(String(argv[0]))) return spec
  const root = searchRoot(argv)
  if (root === undefined || root === '.') return spec

  const anchored = resolveRootAnchoredPattern(globPattern, root, spec.cwd)
  if (anchored === undefined) return spec

  // Insert before excludes and `-- <path>`; keep all original argv entries.
  const insertAt = argv.findIndex((part, index) => index > 1
    && typeof part === 'string'
    && (part.startsWith('--glob=!') || part === '--'))
  const nextArgv = argv.slice()
  nextArgv.splice(insertAt < 0 ? argv.length : insertAt, 0, `--glob=${anchored}`)
  return { ...spec, argv: nextArgv }
}

/**
 * Patch the host subprocess service once. The returned task is a Cordis fiber;
 * disposing it restores the original spawn descriptor. Idempotency is shared
 * per subprocess service so repeated apply() calls never stack wrappers.
 */
export function installRootAwareSearchTools(ctx) {
  return ctx.inject(['subprocess'], (scopedCtx) => {
    const tracedService = scopedCtx.subprocess
    // Cordis returns a traceable proxy whose shadow receiver is not the real
    // service object. Patch the underlying instance so every caller's proxy
    // resolves the same spawn method.
    const service = tracedService?.[CORDIS_ORIGINAL] ?? tracedService
    if (!service || typeof service.spawn !== 'function') return
    const existing = service[ROOT_AWARE_SEARCH_INSTALL]
    if (existing !== undefined) {
      existing.refs += 1
      const release = existing.release
      scopedCtx.effect(() => () => {
        existing.refs -= 1
        if (existing.refs === 0) release()
      })
      return
    }

    const original = service.spawn
    const originalDescriptor = Object.getOwnPropertyDescriptor(service, 'spawn')
    const patched = function spawn(spec, ...rest) {
      const next = rewriteRootAwareSearchSpec(spec)
      // Avoid rebinding the provider's method to a Cordis shadow proxy: state
      // such as live process sets belongs to the real service instance.
      return Reflect.apply(original, service, [next, ...rest])
    }
    const entry = { refs: 1, release: () => {} }
    service[ROOT_AWARE_SEARCH_INSTALL] = entry
    service.spawn = patched

    const restore = () => {
      // Only restore while our wrapper is still the one installed. This keeps
      // any later host patch intact and avoids deleting a foreign descriptor.
      if (Object.getOwnPropertyDescriptor(service, 'spawn')?.value === patched) {
        if (originalDescriptor) Object.defineProperty(service, 'spawn', originalDescriptor)
        else Reflect.deleteProperty(service, 'spawn')
      }
      if (service[ROOT_AWARE_SEARCH_INSTALL] === entry) {
        Reflect.deleteProperty(service, ROOT_AWARE_SEARCH_INSTALL)
      }
    }
    entry.release = restore
    let disposed = false
    scopedCtx.effect(() => () => {
      if (disposed) return
      disposed = true
      entry.refs -= 1
      if (entry.refs === 0) restore()
    })
  })
}
