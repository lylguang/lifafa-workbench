import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { PublisherStore } from '../lwb/packs/publisher/publisher-store.mjs'
import { PublisherHost } from '../lwb/packs/publisher/publisher-host.mjs'
import { SpokenVideoProjectStore } from '../lwb/packs/spoken-video/spoken-video-store.mjs'
import { SpokenVideoPublishHost } from '../lwb/packs/spoken-video/spoken-video-publish-host.mjs'

/**
 * Resolve a real finished cut exactly the way the publish flow does, so the
 * path the adapter would hand to a browser upload is proven to exist before a
 * person ever clicks publish.
 */
const workspace = process.argv[2]
if (!workspace) {
  console.error('usage: node publisher-resolve-check.mjs <spoken-video workspace path>')
  process.exitCode = 1
} else {
  const agent = { workspacePath: workspace }
  const projects = new SpokenVideoProjectStore()
  const publish = new SpokenVideoPublishHost({
    projectsStore: projects,
    background: (work) => work,
    credentials: { describe: async () => ({ configured: false }) },
    connectionSettings: { get: () => ({ provider: 'bailian', model: '' }) },
  })
  const store = new PublisherStore({ workspacePath: join(workspace, '..', 'publisher-probe') })
  const host = new PublisherHost({
    store,
    browser: { status: async () => ({ ready: true }), isOpen: () => false },
    workspacePath: store.workspacePath,
    spokenVideo: { projects, publish, context: async () => agent },
  })

  const shelf = await host.listShelf()
  const ready = (shelf.items || []).filter((item) => item.ready)
  console.log(`ready items: ${ready.length}`)
  let checked = 0
  for (const item of ready.slice(0, 3)) {
    const detail = await projects.get(agent, { projectId: item.projectId })
    const root = resolve(workspace, 'data', 'projects', item.projectId)
    const projectRoot = await realpath(root)
    const file = detail.artifacts?.video?.data?.video?.file
    const target = resolve(projectRoot, file)
    const inside = (() => { const v = relative(projectRoot, target); return v !== '' && v !== '..' && !v.startsWith(`..${sep}`) && !isAbsolute(v) })()
    const info = await lstat(target).catch(() => null)
    const covers = detail.artifacts?.packaging?.data?.covers || {}
    const coverInfo = ['landscape', 'portrait'].map((kind) => {
      const entry = covers[kind]
      if (!entry?.file) return `${kind}=none`
      return `${kind}=${entry.width}x${entry.height}`
    }).join(' ')
    console.log(`[${checked + 1}] inside=${inside} exists=${Boolean(info?.isFile())} bytes=${info?.size ?? 0} | ${coverInfo}`)
    console.log(`     ${file}`)
    checked += 1
  }
  console.log(checked > 0 ? 'PASS: every sampled cut resolved to a real file inside its project' : 'SKIP: no ready item to resolve')
}
