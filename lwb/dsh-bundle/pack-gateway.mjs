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

/** Browser-safe projection of the packs mounted in the current DSH Profile. */
export class LwbPackGateway extends TypertRemoteService {
  static inject = ['lwbPackRegistry', 'lwbPackRuntime', 'lwbPackWorkspaces', 'lwbPackServices']

  constructor(ctx) {
    super(ctx, 'lwbPacks')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  async list() {
    await this.ctx.lwbPackRuntime.ready()
    return { schemaVersion: 1, packs: this.ctx.lwbPackRegistry.list() }
  }

  async market() {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackRuntime.market()
  }

  async load(request) {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackRuntime.load(request)
  }

  async unload(request) {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackRuntime.unload(request)
  }

  async visibility() {
    await this.ctx.lwbPackRuntime.ready()
    return this.ctx.lwbPackWorkspaces.visibility()
  }
  async clearData(request) { await this.ctx.lwbPackRuntime.ready(); return this.ctx.lwbPackRuntime.maintain(request, 'clearData') }
  async unregisterWorkspace(request) { await this.ctx.lwbPackRuntime.ready(); return this.ctx.lwbPackRuntime.maintain(request, 'unregister') }
  async executionStatus(request) { return this.ctx.lwbPackWorkspaces.run(request.id, () => this.ctx.lwbPackServices.executionStatus(request.id)) }
  /**
   * 一键体检：能力包侧边栏消失时，用户在界面上点「检测能力包」即走这里。
   * 只读，不改任何状态。逐项产出 pass/fail 与中文结论，前端按序展示。
   * 检查项对齐历史故障：清单校验（menu tone 非法等）、挂载与启用、恢复失败原因、
   * 工作区路径规范化（盘符大小写）。
   */
  async diagnostics() {
    const checks = []
    const add = (name, passed, detail, extra = {}) => checks.push({ name, passed, detail, ...extra })
    // 1. 包目录扫描（marketplace 只读探查，能报出每个包的清单错误）
    let market = []
    try {
      market = await this.ctx.lwbPackRuntime.market()
      const packs = Array.isArray(market?.packs) ? market.packs : []
      const broken = packs.filter((pack) => pack.available === false || pack.error)
      add('pack-scan', true, packs.length ? `发现 ${packs.length} 个能力包${broken.length ? `，其中 ${broken.length} 个存在问题` : '，清单全部有效'}` : '未发现任何能力包（packs 目录为空或不可读）', { broken: broken.map((pack) => ({ id: pack.manifest?.id || '?', error: pack.error || '清单不可解析' })) })
    } catch (error) {
      // 历史故障主因：任一包清单非法 → market 整体抛错 → 侧边栏全空
      add('pack-scan', false, `能力包目录读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 2. 已挂载包（注册表 = 本进程 Cordis 实际挂载的包）
    let mounted = []
    try {
      mounted = this.ctx.lwbPackRegistry.list()
      add('mounted', mounted.length > 0, mounted.length ? `${mounted.map((pack) => pack.name).join('、')} 已加载` : '没有任何能力包在运行（可能都未启用，或启动恢复失败）')
    } catch (error) {
      add('mounted', false, `读取已加载包失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 3. 启用状态与恢复失败对照
    try {
      const allPacks = Array.isArray(market) ? market : Array.isArray(market?.packs) ? market.packs : []
      const enabled = allPacks.filter((pack) => pack.enabled === true)
      const failedRestore = enabled.filter((pack) => pack.error)
      add('restore', failedRestore.length === 0, failedRestore.length ? `启用的包里有 ${failedRestore.length} 个恢复失败：${failedRestore.map((pack) => `${pack.manifest?.id || '?'}（${pack.error}）`).join('；')}` : enabled.length ? `已启用 ${enabled.length} 个包且状态正常` : '当前没有标记为启用的包（可在能力包市场里重新启用）')
    } catch (error) {
      add('restore', false, `读取启用状态失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 4. 工作区路径规范化（Windows 盘符大小写会让安全校验误判）
    try {
      const visibility = await this.ctx.lwbPackWorkspaces.visibility()
      const paths = Array.isArray(visibility.workspacePaths) ? visibility.workspacePaths : []
      const nonCanonical = paths.filter((path) => path !== path.replace(/^[a-z]:/, (match) => match.toUpperCase()))
      add('workspaces', visibility.workspaceIds?.length > 0, paths.length ? `${paths.length} 个包工作区就绪${nonCanonical.length ? `，${nonCanonical.length} 个路径盘符非大写（历史故障形状）` : ''}` : '没有已注册的包工作区')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      add('workspaces', false, message.includes('canonical') ? `工作区路径校验失败（历史已知问题形状）：${message}` : `读取包工作区失败：${message}`)
    }
    const passed = checks.every((check) => check.passed)
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), passed, checks }
  }
}

decorateRemote(LwbPackGateway.prototype, 'list', 'list')
decorateRemote(LwbPackGateway.prototype, 'market', 'market')
decorateRemote(LwbPackGateway.prototype, 'load', 'load')
decorateRemote(LwbPackGateway.prototype, 'unload', 'unload')
for (const method of ['visibility', 'clearData', 'unregisterWorkspace', 'executionStatus', 'diagnostics']) {
  decorateRemote(LwbPackGateway.prototype, method, method)
}

export default LwbPackGateway
