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

/**
 * 能力包的浏览器桥。命名空间是 `storyAccount`，与通用口播包的 `spokenVideo`
 * 完全隔离——两个包可以同时加载，互不覆盖 remote 契约。
 *
 * 所有方法都在 `storyAccountScope.request` 里执行：工作区归属、凭据与执行作用域
 * 全部由主机侧解析，浏览器只能提交请求体，不能指定路径或身份。
 *
 * 项目方法与内容方法分成两组委托：项目组只碰项目产物，内容组只碰定位、素材与
 * 生成任务。这样 store 的写入串行化与内容文件的原子写不会互相交叉。
 */
export class StoryAccountGateway extends TypertRemoteService {
  static inject = ['storyAccountProjects', 'storyAccountContent', 'storyAccountScope']

  constructor(ctx) {
    super(ctx, 'storyAccount')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  /* ------------------------------- 项目 ------------------------------- */

  list() { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.list(context)) }
  create(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.create(context, request)) }
  remove(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.remove(context, request)) }
  get(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.get(context, request)) }
  commit(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.commit(context, request)) }
  approveScript(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.approveScript(context, request)) }
  checkScript(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountProjects.checkScript(request)) }

  /* ------------------------------- 定位 ------------------------------- */

  getProfile() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.getProfile()) }
  setProfile(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.setProfile(request)) }
  suggestProfile(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.suggestProfile(request)) }
  listAccounts() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.listAccounts()) }
  createAccount(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.createAccount(request)) }
  updateAccount(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.updateAccount(request)) }
  deleteAccount(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.deleteAccount(request)) }
  setDefaultAccount(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.setDefaultAccount(request)) }

  /* ------------------------------- 素材 ------------------------------- */

  listMaterials() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.listMaterials()) }
  addMaterial(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.addMaterial(request)) }
  deleteMaterial(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.deleteMaterial(request)) }

  /* ------------------------------ 素材采集 ------------------------------ */

  startMaterialHarvest(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.startMaterialHarvest(request)) }
  materialHarvestStatus(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.materialHarvestStatus(request)) }
  adoptHarvest(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.adoptHarvest(request)) }

  /* ------------------------------- 选题 ------------------------------- */

  startTopicGeneration(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.startTopicGeneration(request)) }
  topicGenerationStatus(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.topicGenerationStatus(request)) }
  listTopicGenerations() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.listGenerations()) }

  /* ------------------------------- 写稿 ------------------------------- */

  startScriptGeneration(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.startScriptGeneration(request)) }
  scriptGenerationStatus(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.scriptGenerationStatus(request)) }
  listScriptGenerations() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.listGenerations()) }

  /* ------------------------------ 媒体流水线 ------------------------------ */

  startMediaPipeline(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.startMediaPipeline(request)) }
  mediaPipelineStatus(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.mediaPipelineStatus(request)) }
  previewVoice(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.previewVoice(request)) }

  /* -------------------------------- 封面 -------------------------------- */

  generateCover(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.generateCover(request)) }
  coverStatus(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.coverStatus(request)) }

  /* ------------------------------ 媒体凭据 ------------------------------ */

  // 与通用口播包共用同一套私有凭据库（按 ref 名存取，ref 逐字节一致）。
  // 这些方法永不回传密钥值，只回配置状态 / 保存 / 清除结果。
  getMediaCredentialStatus(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.getMediaCredentialStatus(request)) }
  saveMediaCredential(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.saveMediaCredential(request)) }
  clearMediaCredential(request) { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.clearMediaCredential(request)) }

  /* --------------------------- 反塑料感人工放行 --------------------------- */

  // 硬闸的人工放行，必须带操作者+理由（缺任一由 store 拒绝）。放行记录持久化、可被质检读取。
  overrideAntiPlastic(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.overrideAntiPlastic(context, request)) }
  listAntiPlasticOverrides(request) { return this.ctx.storyAccountScope.request((context) => this.ctx.storyAccountProjects.listAntiPlasticOverrides(context, request)) }

  /* ------------------------------- 概览 ------------------------------- */

  overview() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.overview()) }
  /** 题材、钩子、情绪驱动、篇幅档位：界面下拉项来自这里，前端不写死枚举。 */
  catalog() { return this.ctx.storyAccountScope.request(() => this.ctx.storyAccountContent.catalog()) }
}

for (const method of [
  'list', 'create', 'remove', 'get', 'commit', 'approveScript', 'checkScript',
  'getProfile', 'setProfile', 'suggestProfile',
  'listAccounts', 'createAccount', 'updateAccount', 'deleteAccount', 'setDefaultAccount',
  'listMaterials', 'addMaterial', 'deleteMaterial',
  'startMaterialHarvest', 'materialHarvestStatus', 'adoptHarvest',
  'startTopicGeneration', 'topicGenerationStatus', 'listTopicGenerations',
  'startScriptGeneration', 'scriptGenerationStatus', 'listScriptGenerations',
  'startMediaPipeline', 'mediaPipelineStatus', 'generateCover', 'coverStatus',
  'previewVoice',
  'getMediaCredentialStatus', 'saveMediaCredential', 'clearMediaCredential',
  'overrideAntiPlastic', 'listAntiPlasticOverrides',
  'overview', 'catalog',
]) decorateRemote(StoryAccountGateway.prototype, method, method)

export default StoryAccountGateway
