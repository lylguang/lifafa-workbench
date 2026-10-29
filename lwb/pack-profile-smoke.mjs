import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = join(root, 'lwb', 'dsh-launcher.mjs')
const packSource = join(root, 'lwb', 'packs', 'spoken-video')
const packManifest = JSON.parse(await readFile(join(packSource, 'lwb-pack.json'), 'utf8'))
const packSourceSa = join(root, 'lwb', 'packs', 'story-account')
const packManifestSa = JSON.parse(await readFile(join(packSourceSa, 'lwb-pack.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'lwb-pack-profile-smoke-'))

function dump(registryPath) {
  return execFileSync(process.execPath, [launcher, '--dump-config'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LWB_DSH_HOME: join(temporary, `dsh-home-${Math.random().toString(36).slice(2)}`),
      LWB_PACK_REGISTRY: registryPath,
    },
  })
}

try {
  const base = dump(join(temporary, 'missing-packs.json'))
  if (base.includes('@scitiger-ai/lwb-runtime-packs') || base.includes('@scitiger-ai/lwb-spoken-video')) {
    throw new Error('Base Profile unexpectedly mounted a local capability pack')
  }

  const registry = join(temporary, 'packs.json')
  // 两个能力包都写进 registry，断言两者都不进入静态 Profile 配置。
  // 这是验证 story-account 的 manifest（schema 合法、依赖声明正确）能被注册
  // 机制接受，而不会产生「注册的能力包被塞进静态 Profile」的副作用。
  await writeFile(registry, `${JSON.stringify({
    schemaVersion: 2,
    packs: [{
      id: 'spoken-video',
      packageName: '@scitiger-ai/lwb-spoken-video',
      source: packSource,
      installedAt: new Date().toISOString(),
      enabled: true,
      manifest: packManifest,
    }, {
      id: 'story-account',
      packageName: '@scitiger-ai/lwb-story-account',
      source: packSourceSa,
      installedAt: new Date().toISOString(),
      enabled: true,
      manifest: packManifestSa,
    }],
  }, null, 2)}\n`)
  const registered = dump(registry)
  for (const forbidden of ['@scitiger-ai/lwb-runtime-packs', '@scitiger-ai/lwb-spoken-video', 'lwb-pack-spoken-video', 'lwb-pack-spoken-video-client', '@scitiger-ai/lwb-story-account', 'lwb-pack-story-account', 'lwb-pack-story-account-client']) {
    if (registered.includes(forbidden)) throw new Error(`Registered capability pack unexpectedly entered the static Profile config: ${forbidden}`)
  }
  process.stdout.write('LWB static capability-pack Profile smoke passed\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
