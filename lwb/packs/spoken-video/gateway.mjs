import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { executionDetail, executionList, executionAsset, executionAddress, executionFrame } from './spoken-video-execution.mjs'

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
export class SpokenVideoGateway extends TypertRemoteService {
  static inject = ['spokenVideoProjects', 'spokenVideoContent', 'spokenVideoMedia', 'spokenVideoPublish', 'spokenVideoSchedule', 'spokenVideoScope', 'sessionController']

  constructor(ctx) {
    super(ctx, 'spokenVideo')
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  list() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.list(context)) }
  executionDetail(request) { return this.ctx.spokenVideoScope.request((context) => executionDetail(context, request)) }
  executionList(request) { return this.ctx.spokenVideoScope.request((context) => executionList(context, request)) }
  executionAsset(request) { return this.ctx.spokenVideoScope.request((context) => executionAsset(context, request)) }
  async executionPage(request, signal) {
    return this.ctx.spokenVideoScope.request(async (context) => {
      const address = await executionAddress(context, request)
      return executionFrame(await this.ctx.sessionController.page({ address, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq, maxMessages: 20 }, signal))
    })
  }
  async *followExecution(request, signal) {
    const address = await this.ctx.spokenVideoScope.request((context) => executionAddress(context, request))
    const observing = AbortSignal.any([signal, this.ctx.spokenVideoScope.signal])
    for await (const frame of this.ctx.sessionController.follow({ address, assistantStream: true, maxMessages: 20 }, observing)) yield executionFrame(frame)
  }
  listScripts(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.listScripts(context, request)) }
  listApprovedScripts(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.listApprovedScripts(context, request)) }
  listWritableTopics() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.listWritableTopics(context)) }
  create(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.create(context, request)) }
  get(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.get(context, request)) }
  commit(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.commit(context, request)) }
  approveScript(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoProjects.approveScript(context, request)) }
  sources() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.sources(context)) }
  sourceRuns() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.sourceRuns(context)) }
  setSourceEnabled(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.setSourceEnabled(context, request)) }
  collectSources(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.collectSources(context, request)) }
  listSignals(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.listSignals(context, request)) }
  board() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.board(context)) }
  setSignalState(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.setSignalState(context, request)) }
  listSchedules() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.listSchedules(context)) }
  listScheduleRuns(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.listScheduleRuns(context, request)) }
  scheduleRuntimeStatus() { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoSchedule.runtimeStatus()) }
  createSchedule(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.createSchedule(context, request)) }
  updateSchedule(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.updateSchedule(context, request)) }
  deleteSchedule(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.deleteSchedule(context, request)) }
  setScheduleEnabled(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.setScheduleEnabled(context, request)) }
  runSchedule(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.runSchedule(context, request)) }
  cancelScheduleRun(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.cancelScheduleRun(context, request)) }
  scheduleRun(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoSchedule.scheduleRun(context, request)) }
  getProfile() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.getProfile(context)) }
  setProfile(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.setProfile(context, request)) }
  listAccounts() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.listAccounts(context)) }
  createAccount(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.createAccount(context, request)) }
  updateAccount(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.updateAccount(context, request)) }
  setAccountStatus(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.setAccountStatus(context, request)) }
  setDefaultAccount(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.setDefaultAccount(context, request)) }
  deleteAccount(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.deleteAccount(context, request)) }
  suggestAccountProfile(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.suggestAccountProfile(context, request)) }
  startTopicGeneration(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.startTopicGeneration(context, request)) }
  topicGenerationStatus(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.topicGenerationStatus(context, request)) }
  listTopicGenerations() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.listGenerations(context)) }
  setTopicCandidateSelection(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.setTopicCandidateSelection(context, request)) }
  startScriptGeneration(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.startScriptGeneration(context, request)) }
  scriptGenerationStatus(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.scriptGenerationStatus(context, request)) }
  listScriptGenerations() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.listScriptGenerations(context)) }
  analyzeScript(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoContent.analyzeScript(context, request)) }
  mediaStatus() { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoMedia.status()) }
  configureMediaConnection(request) { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoMedia.configureConnection(request)) }
  clearMediaConnectionCredential(request) { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoMedia.clearConnectionCredential(request)) }
  mediaOperations(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.operations(context, request)) }
  listMediaTasks() { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.listTasks(context)) }
  listAudioTasks(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.listAudioTasks(context, request)) }
  listVideoTasks(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.listVideoTasks(context, request)) }
  uploadVoiceReference(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.uploadVoiceReference(context, request)) }
  uploadVideoBgm(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.uploadVideoBgm(context, request)) }
  audioTask(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.audioTask(context, request)) }
  startAudioTask(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.startAudioTask(context, request)) }
  syncAudioTask(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.syncAudioTask(context, request)) }
  startAudioTaskSubtitles(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.startAudioTaskSubtitles(context, request)) }
  saveAudioTaskSubtitles(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.saveAudioTaskSubtitles(context, request)) }
  readAudioTaskMedia(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.readAudioTaskMedia(context, request)) }
  readVideoTaskMedia(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.readVideoTaskMedia(context, request)) }
  startVoiceover(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.startVoiceover(context, request)) }
  startSubtitles(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.startSubtitles(context, request)) }
  startVideoRender(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.startVideoRender(context, request)) }
  startTechnicalQc(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.startTechnicalQc(context, request)) }
  readMedia(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoMedia.readMedia(context, request)) }
  publishStatus() { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoPublish.status()) }
  configurePublishConnection(request) { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoPublish.configureConnection(request)) }
  clearPublishConnectionCredential(request) { return this.ctx.spokenVideoScope.request(() => this.ctx.spokenVideoPublish.clearConnectionCredential(request)) }
  listPublishItems(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.listItems(context, request)) }
  startPackaging(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.startPackaging(context, request)) }
  publishTask(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.task(context, request)) }
  updatePackaging(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.updatePackaging(context, request)) }
  uploadPublishCover(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.uploadCover(context, request)) }
  regeneratePublishCover(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.regenerateCover(context, request)) }
  readPublishAsset(request) { return this.ctx.spokenVideoScope.request((context) => this.ctx.spokenVideoPublish.readAsset(context, request)) }
}

decorateRemote(SpokenVideoGateway.prototype, 'list', 'list')
for (const method of ['executionDetail', 'executionList', 'executionAsset', 'executionPage']) decorateRemote(SpokenVideoGateway.prototype, method, method)
Remote({ mode: 'stream' })(SpokenVideoGateway.prototype.followExecution, { kind: 'method', name: 'followExecution', static: false, private: false, addInitializer(initializer) { remoteInitializers.push(initializer) } })
decorateRemote(SpokenVideoGateway.prototype, 'listScripts', 'listScripts')
decorateRemote(SpokenVideoGateway.prototype, 'listApprovedScripts', 'listApprovedScripts')
decorateRemote(SpokenVideoGateway.prototype, 'listWritableTopics', 'listWritableTopics')
decorateRemote(SpokenVideoGateway.prototype, 'create', 'create')
decorateRemote(SpokenVideoGateway.prototype, 'get', 'get')
decorateRemote(SpokenVideoGateway.prototype, 'commit', 'commit')
decorateRemote(SpokenVideoGateway.prototype, 'approveScript', 'approveScript')
decorateRemote(SpokenVideoGateway.prototype, 'sources', 'sources')
decorateRemote(SpokenVideoGateway.prototype, 'sourceRuns', 'sourceRuns')
decorateRemote(SpokenVideoGateway.prototype, 'setSourceEnabled', 'setSourceEnabled')
decorateRemote(SpokenVideoGateway.prototype, 'collectSources', 'collectSources')
decorateRemote(SpokenVideoGateway.prototype, 'listSignals', 'listSignals')
decorateRemote(SpokenVideoGateway.prototype, 'board', 'board')
decorateRemote(SpokenVideoGateway.prototype, 'setSignalState', 'setSignalState')
decorateRemote(SpokenVideoGateway.prototype, 'listSchedules', 'listSchedules')
decorateRemote(SpokenVideoGateway.prototype, 'listScheduleRuns', 'listScheduleRuns')
decorateRemote(SpokenVideoGateway.prototype, 'scheduleRuntimeStatus', 'scheduleRuntimeStatus')
decorateRemote(SpokenVideoGateway.prototype, 'createSchedule', 'createSchedule')
decorateRemote(SpokenVideoGateway.prototype, 'updateSchedule', 'updateSchedule')
decorateRemote(SpokenVideoGateway.prototype, 'deleteSchedule', 'deleteSchedule')
decorateRemote(SpokenVideoGateway.prototype, 'setScheduleEnabled', 'setScheduleEnabled')
decorateRemote(SpokenVideoGateway.prototype, 'runSchedule', 'runSchedule')
decorateRemote(SpokenVideoGateway.prototype, 'cancelScheduleRun', 'cancelScheduleRun')
decorateRemote(SpokenVideoGateway.prototype, 'scheduleRun', 'scheduleRun')
decorateRemote(SpokenVideoGateway.prototype, 'getProfile', 'getProfile')
decorateRemote(SpokenVideoGateway.prototype, 'setProfile', 'setProfile')
decorateRemote(SpokenVideoGateway.prototype, 'listAccounts', 'listAccounts')
decorateRemote(SpokenVideoGateway.prototype, 'createAccount', 'createAccount')
decorateRemote(SpokenVideoGateway.prototype, 'updateAccount', 'updateAccount')
decorateRemote(SpokenVideoGateway.prototype, 'setAccountStatus', 'setAccountStatus')
decorateRemote(SpokenVideoGateway.prototype, 'setDefaultAccount', 'setDefaultAccount')
decorateRemote(SpokenVideoGateway.prototype, 'deleteAccount', 'deleteAccount')
decorateRemote(SpokenVideoGateway.prototype, 'suggestAccountProfile', 'suggestAccountProfile')
decorateRemote(SpokenVideoGateway.prototype, 'startTopicGeneration', 'startTopicGeneration')
decorateRemote(SpokenVideoGateway.prototype, 'topicGenerationStatus', 'topicGenerationStatus')
decorateRemote(SpokenVideoGateway.prototype, 'listTopicGenerations', 'listTopicGenerations')
decorateRemote(SpokenVideoGateway.prototype, 'setTopicCandidateSelection', 'setTopicCandidateSelection')
decorateRemote(SpokenVideoGateway.prototype, 'startScriptGeneration', 'startScriptGeneration')
decorateRemote(SpokenVideoGateway.prototype, 'scriptGenerationStatus', 'scriptGenerationStatus')
decorateRemote(SpokenVideoGateway.prototype, 'listScriptGenerations', 'listScriptGenerations')
decorateRemote(SpokenVideoGateway.prototype, 'analyzeScript', 'analyzeScript')
decorateRemote(SpokenVideoGateway.prototype, 'mediaStatus', 'mediaStatus')
decorateRemote(SpokenVideoGateway.prototype, 'configureMediaConnection', 'configureMediaConnection')
decorateRemote(SpokenVideoGateway.prototype, 'clearMediaConnectionCredential', 'clearMediaConnectionCredential')
decorateRemote(SpokenVideoGateway.prototype, 'mediaOperations', 'mediaOperations')
decorateRemote(SpokenVideoGateway.prototype, 'listMediaTasks', 'listMediaTasks')
decorateRemote(SpokenVideoGateway.prototype, 'listAudioTasks', 'listAudioTasks')
decorateRemote(SpokenVideoGateway.prototype, 'listVideoTasks', 'listVideoTasks')
decorateRemote(SpokenVideoGateway.prototype, 'uploadVoiceReference', 'uploadVoiceReference')
decorateRemote(SpokenVideoGateway.prototype, 'uploadVideoBgm', 'uploadVideoBgm')
decorateRemote(SpokenVideoGateway.prototype, 'audioTask', 'audioTask')
decorateRemote(SpokenVideoGateway.prototype, 'startAudioTask', 'startAudioTask')
decorateRemote(SpokenVideoGateway.prototype, 'syncAudioTask', 'syncAudioTask')
decorateRemote(SpokenVideoGateway.prototype, 'startAudioTaskSubtitles', 'startAudioTaskSubtitles')
decorateRemote(SpokenVideoGateway.prototype, 'saveAudioTaskSubtitles', 'saveAudioTaskSubtitles')
decorateRemote(SpokenVideoGateway.prototype, 'readAudioTaskMedia', 'readAudioTaskMedia')
decorateRemote(SpokenVideoGateway.prototype, 'readVideoTaskMedia', 'readVideoTaskMedia')
decorateRemote(SpokenVideoGateway.prototype, 'startVoiceover', 'startVoiceover')
decorateRemote(SpokenVideoGateway.prototype, 'startSubtitles', 'startSubtitles')
decorateRemote(SpokenVideoGateway.prototype, 'startVideoRender', 'startVideoRender')
decorateRemote(SpokenVideoGateway.prototype, 'startTechnicalQc', 'startTechnicalQc')
decorateRemote(SpokenVideoGateway.prototype, 'readMedia', 'readMedia')
decorateRemote(SpokenVideoGateway.prototype, 'publishStatus', 'publishStatus')
decorateRemote(SpokenVideoGateway.prototype, 'configurePublishConnection', 'configurePublishConnection')
decorateRemote(SpokenVideoGateway.prototype, 'clearPublishConnectionCredential', 'clearPublishConnectionCredential')
decorateRemote(SpokenVideoGateway.prototype, 'listPublishItems', 'listPublishItems')
decorateRemote(SpokenVideoGateway.prototype, 'startPackaging', 'startPackaging')
decorateRemote(SpokenVideoGateway.prototype, 'publishTask', 'publishTask')
decorateRemote(SpokenVideoGateway.prototype, 'updatePackaging', 'updatePackaging')
decorateRemote(SpokenVideoGateway.prototype, 'uploadPublishCover', 'uploadPublishCover')
decorateRemote(SpokenVideoGateway.prototype, 'regeneratePublishCover', 'regeneratePublishCover')
decorateRemote(SpokenVideoGateway.prototype, 'readPublishAsset', 'readPublishAsset')

export default SpokenVideoGateway
