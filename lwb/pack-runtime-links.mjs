import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_DIR = join(ROOT_DIR, 'vendor', 'deepseek-harness')
const PROFILE_HOME = resolve(process.env.LWB_DSH_HOME || join(ROOT_DIR, 'lwb', 'local', 'dsh-home'))
const PROFILE_NODE_MODULES = join(PROFILE_HOME, 'profiles', 'lwb', 'node_modules')
const PACK_SDK_DIR = join(ROOT_DIR, 'lwb', 'pack-sdk')
const PACK_RUNTIME_PEERS = new Map([
  ['@deepseek-ai/cordis', join(DSH_DIR, 'vendor', 'cordis')],
  ['@deepseek-ai/dsh-typert-protocol', join(DSH_DIR, 'packages', 'typert', 'protocol')],
  ['@deepseek-ai/dsh-tools', join(DSH_DIR, 'packages', 'core', 'tools')],
  ['@deepseek-ai/dsh-credentials', join(DSH_DIR, 'packages', 'credentials', 'credentials')],
  ['@deepseek-ai/dsh-llm', join(DSH_DIR, 'packages', 'llm', 'llm')],
  ['@deepseek-ai/dsh-settings', join(DSH_DIR, 'packages', 'settings', 'settings')],
  ['@deepseek-ai/dsh-storage-domain', join(DSH_DIR, 'packages', 'storage', 'storage-domain')],
  ['@deepseek-ai/schemastery', join(DSH_DIR, 'vendor', 'schemastery')],
  ['@scitiger-ai/lwb-pack-sdk', PACK_SDK_DIR],
])

function packagePath(nodeModules, packageName) {
  const segments = packageName.split('/')
  return packageName.startsWith('@') ? join(nodeModules, segments[0], segments[1]) : join(nodeModules, packageName)
}

export async function ensureLwbRuntimeSymlink(linkPath, target) {
  await mkdir(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath)) {
    const stats = await lstat(linkPath)
    if (!stats.isSymbolicLink()) throw new Error(`LWB profile path is not a symlink: ${linkPath}`)
    if (resolve(dirname(linkPath), await readlink(linkPath)) === resolve(target)) return
    await unlink(linkPath)
  }
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Make a locally registered package resolvable by the active DSH Profile. */
export async function linkLwbPackForRuntime(pack) {
  if (!pack?.source || !pack?.manifest?.packageName) throw new Error('Cannot link an invalid LWB pack for runtime use.')
  await mkdir(PROFILE_NODE_MODULES, { recursive: true })
  await ensureLwbRuntimeSymlink(packagePath(PROFILE_NODE_MODULES, pack.manifest.packageName), pack.source)

  const packageJson = JSON.parse(await readFile(join(pack.source, 'package.json'), 'utf8'))
  const declared = Object.assign({}, packageJson.dependencies, packageJson.peerDependencies)
  const packageNodeModules = join(pack.source, 'node_modules')
  for (const [name, target] of PACK_RUNTIME_PEERS) {
    if (typeof declared[name] === 'string') {
      await ensureLwbRuntimeSymlink(packagePath(packageNodeModules, name), target)
    }
  }
}
