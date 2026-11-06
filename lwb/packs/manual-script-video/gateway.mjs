import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { executionDetail, executionList, executionAsset, executionAddress, executionFrame } from '../spoken-video/spoken-video-execution.mjs'
import { channelSnapshot } from './manual-script-channel.mjs'
import { fallbackTitleFromBody, generateTitle } from './manual-script-title.mjs'

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

/** Pack-scoped browser bridge; the host resolves all workspace ownership. */
export class ManualScriptVideoGateway extends TypertRemoteService {
  static inject = ['manualScriptVideoProjects', 'manualScriptVideoMedia', 'manualScriptVideoPublish', 'manualScriptVideoPolish', 'manualScriptVideoTitle', 'manualScriptVideoScope', 'sessionController']

  constructor(ctx) {
    super(ctx, 'manualScriptVideo')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  list() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.list(context)) }
  executionDetail(request) { return this.ctx.manualScriptVideoScope.request((context) => executionDetail(context, request)) }
  executionList(request) { return this.ctx.manualScriptVideoScope.request((context) => executionList(context, request)) }
  executionAsset(request) { return this.ctx.manualScriptVideoScope.request((context) => executionAsset(context, request)) }
  async executionPage(request, signal) {
    return this.ctx.manualScriptVideoScope.request(async (context) => {
      const address = await executionAddress(context, request)
      return executionFrame(await this.ctx.sessionController.page({ address, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq, maxMessages: 20 }, signal))
    })
  }
  async *followExecution(request, signal) {
    const address = await this.ctx.manualScriptVideoScope.request((context) => executionAddress(context, request))
    const observing = AbortSignal.any([signal, this.ctx.manualScriptVideoScope.signal])
    for await (const frame of this.ctx.sessionController.follow({ address, assistantStream: true, maxMessages: 20 }, observing)) yield executionFrame(frame)
  }
  listScripts(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.listScripts(context, request)) }
  listApprovedScripts(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.listApprovedScripts(context, request)) }
  /**
   * 渠道列表。
   *
   * 本包没有账号库，渠道是从工作区里出现过的稿件上汇总出来的——用户给第一篇稿件
   * 填了渠道名，这个渠道就出现了；没有渠道名的稿件归「全部稿件」。
   * 默认落在「全部稿件」：这里没有人格化的默认账号，硬选一个等于替用户做主。
   */
  async listChannels() {
    return this.ctx.manualScriptVideoScope.request(async (context) => {
      const projects = await this.ctx.manualScriptVideoProjects.list(context)
      const channels = new Map()
      for (const project of projects) {
        const account = project.account
        if (!account?.id || !account.name) continue
        const existing = channels.get(account.id)
        if (existing) { existing.count += 1; continue }
        channels.set(account.id, { id: account.id, name: account.name, status: 'active', revision: account.revision || 1, count: 1 })
      }
      const list = [...channels.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
      return { channels: list, defaultAccountId: null }
    })
  }
  pipelineOverview() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.pipelineOverview(context)) }
  create(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.create(context, request)) }
  remove(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.remove(context, request)) }
  get(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.get(context, request)) }
  commit(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.commit(context, request)) }
  approveScript(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoProjects.approveScript(context, request)) }

  /**
   * 一次落库一篇稿件。
   *
   * 拆成「建项目 → 落选题 → 落正文」三步会让前端处理版本号和幂等键，任何一步失败
   * 都会留下半截项目。这里在服务端一次做完，并沿用生产链路的阶段约束：正文必须
   * 有选题在先（stage 的前置指针），所以标题落成选题、正文落成稿件——下游的配音、
   * 成片、发布资料全都只认「稿件」阶段，不需要为本包改任何一行。
   */
  async createScript(request) {
    return this.ctx.manualScriptVideoScope.request(async (context) => {
      const projects = this.ctx.manualScriptVideoProjects
      const input = request && typeof request === 'object' ? request : {}
      const givenTitle = typeof input.title === 'string' ? input.title.trim() : ''
      const body = typeof input.body === 'string' ? input.body.trim() : ''
      const channel = typeof input.channel === 'string' ? input.channel.trim() : ''
      if (!body) throw new Error('稿件正文不能为空。')
      // 标题留空时由 AI 按正文起一个；AI 不可用就退回正文第一句，保存不卡死。
      // 标题保存后不可改，所以必须在落库前定稿。
      const title = givenTitle || await generateTitle(this.ctx.manualScriptVideoTitle, context, { body, channel }) || fallbackTitleFromBody(body)
      const project = await projects.create(context, { title })
      const topic = await projects.commit(context, {
        projectId: project.id,
        expectedRevision: project.revision,
        stage: 'topic',
        payload: { title, angle: channel || null, account: channelSnapshot(channel) },
        idempotencyKey: `manual-topic-${project.id}`,
      })
      const script = await projects.commit(context, {
        projectId: project.id,
        expectedRevision: topic.project.revision,
        stage: 'script',
        payload: { body },
        idempotencyKey: `manual-script-${project.id}`,
      })
      return script.project
    })
  }

  /** 确定性质检：与口播包同一把尺。 */
  analyzeScript(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPolish.analyze(context, request)) }
  /** 提交一次润色：只改表达，不改内容。 */
  startPolish(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPolish.start(context, request)) }
  polishStatus(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPolish.status(context, request)) }
  listPolishes() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPolish.list(context)) }

  mediaStatus() { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoMedia.status()) }
  configureMediaConnection(request) { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoMedia.configureConnection(request)) }
  clearMediaConnectionCredential(request) { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoMedia.clearConnectionCredential(request)) }
  mediaOperations(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.operations(context, request)) }
  listMediaTasks() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.listTasks(context)) }
  listAudioTasks(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.listAudioTasks(context, request)) }
  listVideoTasks(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.listVideoTasks(context, request)) }
  deleteMediaTasks(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.deleteTasks(context, request)) }
  uploadVoiceReference(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.uploadVoiceReference(context, request)) }
  listSavedVoices() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.listSavedVoices(context)) }
  renameSavedVoice(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.renameSavedVoice(context, request)) }
  deleteSavedVoice(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.deleteSavedVoice(context, request)) }
  bridgeVoiceoverInfo() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeVoiceoverInfo(context)) }
  bridgeControl() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeControl(context)) }
  bridgeEngineAction(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeEngineAction(context, request)) }
  bridgeLogs(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeLogs(context, request || {})) }
  bridgeTasks() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeTasks(context)) }
  bridgeConfig() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeConfig(context)) }
  bridgeConfigUpdate(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeConfigUpdate(context, request)) }
  bridgeVoiceTest(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeVoiceTest(context, request || {})) }
  bridgeVoices() { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeVoices(context)) }
  bridgeVoiceUpload(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeVoiceUpload(context, request)) }
  bridgeVoiceDelete(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.bridgeVoiceDelete(context, request)) }
  uploadVideoBgm(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.uploadVideoBgm(context, request)) }
  audioTask(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.audioTask(context, request)) }
  startAudioTask(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.startAudioTask(context, request)) }
  syncAudioTask(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.syncAudioTask(context, request)) }
  startAudioTaskSubtitles(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.startAudioTaskSubtitles(context, request)) }
  saveAudioTaskSubtitles(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.saveAudioTaskSubtitles(context, request)) }
  readAudioTaskMedia(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.readAudioTaskMedia(context, request)) }
  readVideoTaskMedia(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.readVideoTaskMedia(context, request)) }
  startVoiceover(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.startVoiceover(context, request)) }
  startSubtitles(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.startSubtitles(context, request)) }
  startVideoRender(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.startVideoRender(context, request)) }
  startTechnicalQc(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.startTechnicalQc(context, request)) }
  cancelMediaRun(request) { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoMedia.cancelRun(null, request)) }
  resumeMediaRun(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.resumeRun(context, request)) }
  releaseRejectedCut(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.releaseRejectedCut(context, request)) }
  readMedia(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoMedia.readMedia(context, request)) }
  publishStatus() { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoPublish.status()) }
  configurePublishConnection(request) { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoPublish.configureConnection(request)) }
  clearPublishConnectionCredential(request) { return this.ctx.manualScriptVideoScope.request(() => this.ctx.manualScriptVideoPublish.clearConnectionCredential(request)) }
  listPublishItems(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.listItems(context, request)) }
  startPackaging(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.startPackaging(context, request)) }
  autoStartPackaging(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.autoStartPackaging(context, request)) }
  publishTask(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.task(context, request)) }
  updatePackaging(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.updatePackaging(context, request)) }
  uploadPublishCover(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.uploadCover(context, request)) }
  regeneratePublishCover(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.regenerateCover(context, request)) }
  readPublishAsset(request) { return this.ctx.manualScriptVideoScope.request((context) => this.ctx.manualScriptVideoPublish.readAsset(context, request)) }
}

decorateRemote(ManualScriptVideoGateway.prototype, 'list', 'list')
for (const method of ['executionDetail', 'executionList', 'executionAsset', 'executionPage']) decorateRemote(ManualScriptVideoGateway.prototype, method, method)
Remote({ mode: 'stream' })(ManualScriptVideoGateway.prototype.followExecution, { kind: 'method', name: 'followExecution', static: false, private: false, addInitializer(initializer) { remoteInitializers.push(initializer) } })
decorateRemote(ManualScriptVideoGateway.prototype, 'listScripts', 'listScripts')
decorateRemote(ManualScriptVideoGateway.prototype, 'listApprovedScripts', 'listApprovedScripts')
decorateRemote(ManualScriptVideoGateway.prototype, 'listChannels', 'listChannels')
decorateRemote(ManualScriptVideoGateway.prototype, 'pipelineOverview', 'pipelineOverview')
decorateRemote(ManualScriptVideoGateway.prototype, 'create', 'create')
decorateRemote(ManualScriptVideoGateway.prototype, 'createScript', 'createScript')
decorateRemote(ManualScriptVideoGateway.prototype, 'remove', 'remove')
decorateRemote(ManualScriptVideoGateway.prototype, 'get', 'get')
decorateRemote(ManualScriptVideoGateway.prototype, 'commit', 'commit')
decorateRemote(ManualScriptVideoGateway.prototype, 'approveScript', 'approveScript')
decorateRemote(ManualScriptVideoGateway.prototype, 'analyzeScript', 'analyzeScript')
decorateRemote(ManualScriptVideoGateway.prototype, 'startPolish', 'startPolish')
decorateRemote(ManualScriptVideoGateway.prototype, 'polishStatus', 'polishStatus')
decorateRemote(ManualScriptVideoGateway.prototype, 'listPolishes', 'listPolishes')
decorateRemote(ManualScriptVideoGateway.prototype, 'mediaStatus', 'mediaStatus')
decorateRemote(ManualScriptVideoGateway.prototype, 'configureMediaConnection', 'configureMediaConnection')
decorateRemote(ManualScriptVideoGateway.prototype, 'clearMediaConnectionCredential', 'clearMediaConnectionCredential')
decorateRemote(ManualScriptVideoGateway.prototype, 'mediaOperations', 'mediaOperations')
decorateRemote(ManualScriptVideoGateway.prototype, 'listMediaTasks', 'listMediaTasks')
decorateRemote(ManualScriptVideoGateway.prototype, 'listAudioTasks', 'listAudioTasks')
decorateRemote(ManualScriptVideoGateway.prototype, 'listVideoTasks', 'listVideoTasks')
decorateRemote(ManualScriptVideoGateway.prototype, 'deleteMediaTasks', 'deleteMediaTasks')
decorateRemote(ManualScriptVideoGateway.prototype, 'uploadVoiceReference', 'uploadVoiceReference')
decorateRemote(ManualScriptVideoGateway.prototype, 'listSavedVoices', 'listSavedVoices')
decorateRemote(ManualScriptVideoGateway.prototype, 'renameSavedVoice', 'renameSavedVoice')
decorateRemote(ManualScriptVideoGateway.prototype, 'deleteSavedVoice', 'deleteSavedVoice')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeVoiceoverInfo', 'bridgeVoiceoverInfo')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeControl', 'bridgeControl')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeEngineAction', 'bridgeEngineAction')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeLogs', 'bridgeLogs')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeTasks', 'bridgeTasks')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeConfig', 'bridgeConfig')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeConfigUpdate', 'bridgeConfigUpdate')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeVoiceTest', 'bridgeVoiceTest')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeVoices', 'bridgeVoices')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeVoiceUpload', 'bridgeVoiceUpload')
decorateRemote(ManualScriptVideoGateway.prototype, 'bridgeVoiceDelete', 'bridgeVoiceDelete')
decorateRemote(ManualScriptVideoGateway.prototype, 'uploadVideoBgm', 'uploadVideoBgm')
decorateRemote(ManualScriptVideoGateway.prototype, 'audioTask', 'audioTask')
decorateRemote(ManualScriptVideoGateway.prototype, 'startAudioTask', 'startAudioTask')
decorateRemote(ManualScriptVideoGateway.prototype, 'syncAudioTask', 'syncAudioTask')
decorateRemote(ManualScriptVideoGateway.prototype, 'startAudioTaskSubtitles', 'startAudioTaskSubtitles')
decorateRemote(ManualScriptVideoGateway.prototype, 'saveAudioTaskSubtitles', 'saveAudioTaskSubtitles')
decorateRemote(ManualScriptVideoGateway.prototype, 'readAudioTaskMedia', 'readAudioTaskMedia')
decorateRemote(ManualScriptVideoGateway.prototype, 'readVideoTaskMedia', 'readVideoTaskMedia')
decorateRemote(ManualScriptVideoGateway.prototype, 'startVoiceover', 'startVoiceover')
decorateRemote(ManualScriptVideoGateway.prototype, 'startSubtitles', 'startSubtitles')
decorateRemote(ManualScriptVideoGateway.prototype, 'startVideoRender', 'startVideoRender')
decorateRemote(ManualScriptVideoGateway.prototype, 'startTechnicalQc', 'startTechnicalQc')
decorateRemote(ManualScriptVideoGateway.prototype, 'cancelMediaRun', 'cancelMediaRun')
decorateRemote(ManualScriptVideoGateway.prototype, 'resumeMediaRun', 'resumeMediaRun')
decorateRemote(ManualScriptVideoGateway.prototype, 'releaseRejectedCut', 'releaseRejectedCut')
decorateRemote(ManualScriptVideoGateway.prototype, 'readMedia', 'readMedia')
decorateRemote(ManualScriptVideoGateway.prototype, 'publishStatus', 'publishStatus')
decorateRemote(ManualScriptVideoGateway.prototype, 'configurePublishConnection', 'configurePublishConnection')
decorateRemote(ManualScriptVideoGateway.prototype, 'clearPublishConnectionCredential', 'clearPublishConnectionCredential')
decorateRemote(ManualScriptVideoGateway.prototype, 'listPublishItems', 'listPublishItems')
decorateRemote(ManualScriptVideoGateway.prototype, 'startPackaging', 'startPackaging')
decorateRemote(ManualScriptVideoGateway.prototype, 'autoStartPackaging', 'autoStartPackaging')
decorateRemote(ManualScriptVideoGateway.prototype, 'publishTask', 'publishTask')
decorateRemote(ManualScriptVideoGateway.prototype, 'updatePackaging', 'updatePackaging')
decorateRemote(ManualScriptVideoGateway.prototype, 'uploadPublishCover', 'uploadPublishCover')
decorateRemote(ManualScriptVideoGateway.prototype, 'regeneratePublishCover', 'regeneratePublishCover')
decorateRemote(ManualScriptVideoGateway.prototype, 'readPublishAsset', 'readPublishAsset')

export default ManualScriptVideoGateway
