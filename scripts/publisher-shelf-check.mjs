import { join } from 'node:path'
import { PublisherStore } from '../lwb/packs/publisher/publisher-store.mjs'
import { PublisherHost } from '../lwb/packs/publisher/publisher-host.mjs'
import { SpokenVideoProjectStore } from '../lwb/packs/spoken-video/spoken-video-store.mjs'
import { SpokenVideoPublishHost } from '../lwb/packs/spoken-video/spoken-video-publish-host.mjs'

/**
 * Cross-pack read check against the real workbench data: the publisher pack
 * must be able to list the sibling pack's finished cuts without owning them.
 */
const spokenVideoWorkspace = process.argv[2]
if (!spokenVideoWorkspace) {
  console.error('usage: node publisher-shelf-check.mjs <spoken-video workspace path>')
  process.exitCode = 1
} else {
  const agent = { workspacePath: spokenVideoWorkspace }
  const projects = new SpokenVideoProjectStore()
  const publish = new SpokenVideoPublishHost({
    projectsStore: projects,
    background: (work) => work,
    credentials: { describe: async () => ({ configured: false }) },
    connectionSettings: { get: () => ({ provider: 'bailian', model: '' }) },
  })
  const store = new PublisherStore({ workspacePath: join(spokenVideoWorkspace, '..', 'publisher-probe') })
  const host = new PublisherHost({
    store,
    browser: { status: async () => ({ ready: true }), isOpen: () => false },
    workspacePath: store.workspacePath,
    spokenVideo: { projects, publish, context: async () => agent },
  })
  const shelf = await host.listShelf()
  console.log('available:', shelf.available)
  console.log('reason:', shelf.reason)
  console.log('total:', shelf.total ?? 0)
  for (const item of (shelf.items || []).slice(0, 5)) {
    console.log(` - ${item.title?.slice(0, 40)} | revision=${item.revision} | ready=${item.ready} | orientation=${item.orientation} | video=${item.video?.file || 'none'}`)
  }
  const withCopy = (shelf.items || []).filter((item) => item.packaging?.content).length
  console.log('items with packaging copy:', withCopy)
}
