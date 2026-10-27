import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const clientPath = new URL('../client.js', import.meta.url)

test('account completion uses the LAN-safe action key and keeps ID creation inside error handling', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function actionKey(')
  const end = source.indexOf('\n    function sourceName(', start)
  assert.ok(start >= 0 && end > start, 'account client must define the shared action key helper')
  const actionKey = vm.runInNewContext(`${source.slice(start, end)}; actionKey`, {
    globalThis: { crypto: {} },
  })
  assert.match(actionKey('account-completion'), /^account-completion-\d+-[a-z0-9]+$/u)
  assert.doesNotMatch(source, /const executionId = crypto\.randomUUID\(\)/u)
  assert.match(source, /try \{\s*const executionId = actionKey\('account-completion'\); setAccountExecutionId\(executionId\);/u)
})

test('topic task panel pins active work and paginates filtered terminal history', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function TopicsPage(')
  const end = source.indexOf('\n    function ScriptPage(', start)
  assert.ok(start >= 0 && end > start, 'TopicsPage must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(source, /const TOPIC_HISTORY_PAGE_SIZE = 6;/u)
  assert.match(page, /const terminalTasks = history\.filter\(\(item\) => item\.status !== 'queued' && item\.status !== 'running'\);/u)
  assert.match(page, /const filteredTerminalTasks = terminalTasks\.filter\(\(item\) => historyFilter === 'all' \|\| item\.status === historyFilter\);/u)
  assert.match(page, /activeTasks\.map\(taskCard\)/u)
  assert.match(page, /pagedTerminalTasks\.map\(taskCard\)/u)
  assert.match(page, /\{ id: 'completed', label: '已完成'/u)
  assert.match(page, /\{ id: 'failed', label: '失败'/u)
  assert.match(page, /aria-label': '上一页'/u)
  assert.match(page, /aria-label': '下一页'/u)
  assert.doesNotMatch(page, /history\.slice\(0, 12\)/u)
})

test('script page waits for both a completed draft and its loaded project revision', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ScriptPage(')
  const end = source.indexOf('\n    function AudioCaptionsPage', start)
  assert.ok(start >= 0 && end > start, 'ScriptPage must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(page, /const latestDraftMatchesDetail = Boolean\(latestDraft[\s\S]*?detail\?\.artifacts\?\.script\?\.revision != null[\s\S]*?latestDraft\.scriptRevision === detail\.artifacts\.script\.revision\);/u)
  assert.match(page, /latestDraftMatchesDetail \? h\('section'/u)
  assert.doesNotMatch(page, /latestDraft\?\.scriptRevision === detail\?\.artifacts\?\.script\?\.revision/u)
})

test('audio workbench selects saved scripts by account, preserves standalone tasks, and binds subtitles to audio tasks', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(source, /async function remoteStatic\(method, request\) \{[\s\S]*?args: request === undefined \? \{\} : \{ request \}/u)
  assert.match(page, /remote\(packId, 'listScripts', \{ query: pickerQuery, offset: pickerPage \* 8, limit: 8,/u)
  assert.match(page, /activeTab === GENERAL_TAB \? \{ general: true \} : \{ accountId: activeTab \}/u)
  assert.match(page, /按账号筛选稿件/u)
  assert.match(page, /选择稿件/u)
  assert.match(page, /remote\(packId, 'startAudioTask', \{ text,/u)
  // 声音复刻（克隆）在 2026-10-20 的路线一里退役过一次，随后用户明确要求加回来，
  // 现在是「预置音色 / 音色设计 / 声音克隆」三模式之一。这条断言已从「不许存在」
  // 反转为「入口必须在，且格式白名单必须拒掉非 wav/mp3」。
  assert.match(page, /remoteStatic\('uploadVoiceReference', \{/u, '克隆上传入口必须回到配音页')
  assert.match(page, /type: 'file', accept: SV_CLONE_ACCEPT/u, '上传控件走 wav/mp3 白名单')
  assert.match(page, /只支持 wav 和 mp3/u, '不支持的格式必须说清要先转码')
  assert.doesNotMatch(page, /预置音色 ID|指定预置音色/u)
  assert.match(page, /remote\(packId, 'startAudioTaskSubtitles', \{ taskId: task\.id, provider: providerId, language: 'zh', aiOptimize: true \}\)/u)
  assert.match(page, /setSubtitleDrawer\(\{ task, cues: subtitleCues\(task\.subtitle\?\.srt\), saving: false \}\)/u)
  assert.match(page, /const srt = srtFromSubtitleCues\(subtitleDrawer\.cues\);/u)
  assert.match(page, /remote\(packId, 'saveAudioTaskSubtitles', \{ taskId: subtitleDrawer\.task\.id, srt \}\)/u)
  assert.match(page, /className: 'sv-textarea sv-subtitle-text'/u)
  assert.match(page, /title: '生成配音'/u)
  assert.match(page, /onConfirm: \(\) => \{ void createAudioTask\(\); \}/u)
  assert.match(page, /title: '保存字幕'/u)
  assert.match(page, /onConfirm: \(\) => \{ void saveSubtitles\(\); \}/u)
  assert.doesNotMatch(page, /subtitleDrawer\.draft|sv-warn-list/u)
  assert.match(source, /readAudioTaskMedia/u)
  assert.match(page, /AudioTaskPreview/u)
  assert.match(page, /remoteStatic\('configureMediaConnection', \{ provider: providerId, apiKey \}\)/u)
  assert.match(page, /remoteStatic\('clearMediaConnectionCredential', \{ provider: providerId \}\)/u)
  assert.doesNotMatch(page, /remote\(packId, '(?:configureMediaConnection|clearMediaConnectionCredential)'/u)
  assert.match(page, /source\?\.projectId \? \{ sourceProjectId: source\.projectId \}/u)
  assert.doesNotMatch(page, /provider: providerId, apiKey,/u)
  assert.match(page, /API Key 保存到 DSH 私有凭据库/u)
  // 额度类错误仍要给出人话出路，但**不能吞掉服务端原文**——原文里带着原因和错误码，
  // 用户排查要靠它；意译只允许追加，不能替换。
  assert.match(source, /function mediaErrorText\(error\)[\s\S]*?账户额度不足：请在「连接配置」中检查该服务的余额或额度/u)
  assert.match(source, /function subtitleTaskProgress\(task, now = Date\.now\(\)\)[\s\S]*?实时识别/u)
  assert.match(page, /subtitleProgress = subtitleTaskProgress\(task\)/u)
  assert.match(page, /className: 'sv-audio-subtitle-progress'/u)
  assert.match(page, /'aria-label': '字幕识别进度'/u)
  assert.match(page, /mediaErrorText\(task\.error\)/u)
  assert.match(page, /mediaErrorText\(subtitle\.error\)/u)
  assert.doesNotMatch(page, /sv-list sv-run-list/u)
})



const VOICE_PAGE = async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  return { source, page: source.slice(start, end) }
}

test('audio workbench retries a failed voiceover from its frozen task input', async () => {
  const { page } = await VOICE_PAGE()

  assert.match(page, /const retryAudioTask = async \(task\) => \{/u)
  // 重试复用冻结的稿件与音色，而不是让人重新选一遍。
  assert.match(page, /text: task\.source\?\.text \|\| ''/u)
  // 渠道固定，不再跟着历史任务的 provider 走。
  assert.match(page, /provider: providerId/u)
  // 音色与语气都重放当初冻结的值：中途改了表单，重试也必须是同一条声音。
  assert.match(page, /voiceSource: 'preset'/u)
  assert.match(page, /task\.input\?\.voiceId \? \{ voiceId: task\.input\.voiceId \}/u)
  assert.match(page, /task\.input\?\.style \? \{ style: task\.input\.style \}/u)
  assert.match(page, /rate: Number\(task\.input\?\.rate \?\? 1\)/u)
  assert.match(page, /volume: Number\(task\.input\?\.volume \?\? 1\)/u)
  assert.match(page, /subtitleEnabled: task\.input\?\.subtitleEnabled === true/u)
  // 只有带冻结稿件的失败任务能重试。
  assert.match(page, /task\.status === 'failed' && task\.source\?\.text/u)
  assert.match(page, /title: '重试配音'/u)
  assert.match(page, /onConfirm: \(\) => \{ void retryAudioTask\(task\); \}/u)
})

test('audio workbench pins the MiMo provider and exposes voice and style on the task form', async () => {
  const { source, page } = await VOICE_PAGE()

  // 渠道取白名单常量，不再是「上次用过哪个」。
  assert.match(page, /const providerId = SV_VOICE_PROVIDER;/u)
  assert.match(page, /const providerName = SV_VOICE_PROVIDER_LABEL\[providerId\] \|\| providerId/u)
  // 音色下拉来自 MiMo 内置表，并带性格说明。九个音名按中英文分组渲染，
  // 所以 option 不再是平铺的 map，而是交给共用的 svVoiceSelect（内部按 optgroup 分组）。
  assert.match(page, /const voiceOptions = Array\.from\(new Set/u)
  assert.match(page, /svVoiceSelect\(\{ value: voiceId, onChange:/u)
  assert.match(source, /h\('optgroup', \{ key: group\.label, label: group\.label \}/u)
  // 选中的音色在下方用一句话说明性格：光看「茉莉」两个字没法判断该怎么搭语气。
  assert.match(page, /SV_MIMO_VOICE_HINTS\[voiceId\] \? h\('p', \{ className: 'sv-note' \}/u)
  // 语气：预设可一键选中、也可手输；预设表与 datalist 同源。
  assert.match(source, /const SV_VOICE_STYLE_PRESETS = \[/u)
  assert.match(source, /'清晰沉稳，适合知识讲解。'/u)
  assert.match(page, /list: 'sv-voice-style-presets'/u)
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('option'/u)
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('button'/u)
  // 起配音与重试共用同一份音色入参，不会各写一遍而走偏。
  // 这份入参按三模式分叉（互斥），所以不再是单行对象字面量。
  assert.match(page, /const voiceFieldsOf = \(\) => \{\s*const tone = stylePrompt\.trim\(\)/u)
  assert.match(page, /if \(voiceSource === 'design'\) return \{ voiceSource: 'design', \.\.\.tone, \.\.\.tags, voiceDesign: voiceDesignText\.trim\(\) \}/u)
  assert.match(page, /\.\.\.voiceFieldsOf\(\)/u)
})

test('audio workbench names the channel and never blames the voice for an auth failure', async () => {
  const { source, page } = await VOICE_PAGE()

  // 没配 Key 时要说清是「哪个服务没配」+「下一步去哪」，不能笼统报「采集失败」。
  assert.match(page, /尚未配置\$\{providerName\}的 API Key。请在右上角「连接配置」中完成设置。/u)
  assert.match(page, /请先在右上角「连接配置」里填写\$\{providerName\}的 API Key/u)
  // 提交前先说清楚会用哪个音色与语气，让用户知道将要发生什么。
  // 三模式各有一句措辞：预置音色报音名，音色设计报描述，克隆报参考音频文件名。
  assert.match(page, /将使用\$\{providerName\}、\$\{voiceSource === 'design'/u)
  assert.match(page, /stylePrompt\.trim\(\) \? `、语气「\$\{stylePrompt\.trim\(\)\}」` : ''/u)
  // 通用契约一：服务端原始错误原文必须透传（只剥 `Error [CODE]` 前缀），
  // 不能意译成一句「操作失败」把根因吃掉。
  assert.match(source, /只剥掉传输层/u)
  assert.ok(source.includes("/^Error \\[[A-Z0-9_]+\\]\\s*/u"), 'mediaErrorText must strip only the transport Error [CODE] prefix')
  assert.doesNotMatch(source, /请充值后重试，或切换到百炼 BYOK/u)
  // 通用契约二：任务卡必须回显渠道来源，新旧渠道都要显示，不能因为白名单只剩
  // 一个 provider 就让 mimo 任务和历史任务都变成空白来源。
  assert.match(source, /const SV_RETIRED_PROVIDER_LABEL = \{[^}]*bailian[^}]*scitiger/u)
  assert.match(source, /function voiceProviderLabel\(id, loopback = false\)/u)
  assert.match(page, /voiceProviderLabel\(task\.input\?\.provider, service\?\.providers\?\.scitiger\?\.loopback\)/u)
  assert.doesNotMatch(page, /task\.input\?\.provider === 'bailian' \?/u)
})

test('script drawer opens directly in edit mode and paginates completed history', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ScriptPage(')
  const end = source.indexOf('\n    function AudioCaptionsPage', start)
  const page = source.slice(start, end)

  assert.match(page, /setDrawerMode\('edit'\)/u)
  // 运行中与排队中的任务固定置顶，按账号与时间筛选后依然如此。
  assert.match(page, /const activeHistoryTasks = sortScriptTasks\(history\.filter\(\(item\) => historyMatchesAccount\(item\) && \(item\.status === 'queued' \|\| item\.status === 'running'\)\), historySort\);/u)
  assert.match(page, /const pagedHistoryTasks = filteredHistoryTasks\.slice\(historyPage \* 6, historyPage \* 6 \+ 6\);/u)
  assert.match(page, /pagedHistoryTasks\.map\(taskCard\)/u)
  assert.doesNotMatch(page, /history\.slice\(0, 12\)/u)
})

test('video workbench separates source selection from durable, filterable video tasks', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    const PUBLISH_STATE_LABEL', start)
  assert.ok(start >= 0 && end > start, 'VideoPreviewPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(page, /按账号筛选视频稿件与任务/u)
  assert.match(page, /project\.completedStages\.includes\('script'\) && project\.completedStages\.includes\('voiceover'\)/u)
  assert.match(page, /useVideoTasks\(packId, taskQuery, taskFilter, taskPage/u)
  assert.match(page, /remote\(packId, 'startVideoRender'/u)
  assert.match(page, /React\.useState\('landscape'\)/u)
  assert.match(page, /setSubtitleEnabled\(savedVideo \? savedVideo\.subtitleEnabled !== false : done\(detail, 'subtitles'\)\)/u)
  assert.match(page, /disabled: !done\(detail, 'subtitles'\)/u)
  assert.match(page, /竖屏 9:16/u)
  assert.match(page, /横屏 16:9/u)
  assert.match(page, /orientation: settings\.orientation === 'portrait' \? 'portrait' : 'landscape'/u)
  assert.match(page, /remote\(packId, 'uploadVideoBgm', \{ projectId: detail\.id, name: file\.name, mediaType: file\.type, data \}\)/u)
  assert.match(page, /背景音乐（可选）/u)
  assert.match(page, /BGM 音量/u)
  assert.match(page, /stage: 'bgm'/u)
  assert.match(page, /留空由 AI 视觉导演自主决定/u)
  assert.match(page, /visualBrief: settings\.visualBrief\.trim\(\) \|\| DEFAULT_VIDEO_VISUAL_BRIEF/u)
  assert.doesNotMatch(page, /!visualBrief\.trim\(\) \|\| !hasRequiredSource/u)
  assert.match(page, /选择已完成配音的稿件/u)
  assert.match(page, /还有 \$\{candidates\.length - 6\} 篇 · 查看更多/u)
  assert.match(page, /查看稿件/u)
  assert.match(page, /查看配音\/字幕/u)
  assert.match(page, /执行详情/u)
  assert.match(page, /VideoTaskMediaPreview/u)
  assert.match(page, /任务创建时冻结的稿件快照/u)
  assert.match(page, /展示任务创建时冻结的声音与字幕版本/u)
  assert.match(page, /DSH \+ Remotion/u)
  assert.match(page, /技术质检与独立审片通过/u)
  assert.doesNotMatch(page, /运行技术质检/u)
  assert.match(page, /sv-layout sv-video-workbench/u)
  assert.match(page, /sv-section sv-video-task-list/u)
  assert.doesNotMatch(page, /人工视频制作兜底/u)
  assert.doesNotMatch(page, /人工质检兜底/u)
  assert.doesNotMatch(page, /MediaRunList\(/u)
  assert.doesNotMatch(page, /commit\(detail, 'video'/u)
  assert.match(source, /\.sv-video-workbench \{ grid-template-columns:minmax\(300px,\.82fr\) minmax\(0,1\.18fr\); grid-template-areas:'sources tasks'; \}/u)
})

test('content schedule keeps run history scoped to each schedule drawer', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ContentSchedulePage(')
  const end = source.indexOf('\n    function mediaRunLabel(', start)
  assert.ok(start >= 0 && end > start, 'ContentSchedulePage must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(page, /onClick: \(\) => setHistorySchedule\(schedule\) \}, '运行记录'/u)
  assert.match(page, /h\(ScheduleRunHistory, \{ key: historySchedule\.id, packId, scheduleId: historySchedule\.id/u)
  assert.doesNotMatch(page, /h\('h3', null, '运行历史'\)/u)
  assert.doesNotMatch(page, /h\(ScheduleRunHistory, \{ key: activeTab/u)
  assert.match(source, /function ScheduleRunHistory\(\{ packId, scheduleId, refreshKey, onPublish, onContinue \}\)/u)
  assert.match(source, /function emptyScheduleForm\(\) \{[\s\S]*?orientation: 'landscape'/u)
  assert.match(page, /className: 'sv-as-adv-title' \}, '每轮产量与成片规格'/u)
  assert.doesNotMatch(page, /h\('details'|h\('summary'|高级：每轮产量与成片规格/u)
})

test('the schedule form only asks for a platform target at publish depth', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ContentSchedulePage(')
  const end = source.indexOf('\n    function LegacyAudioCaptionsPageV2(', start)
  assert.ok(start >= 0 && end > start, 'ContentSchedulePage must remain a standalone component')
  const page = source.slice(start, end)

  // The publish depth exists and carries its own copy. The depth vocabulary
  // lives beside emptyScheduleForm, outside the page component.
  assert.match(source, /id: 'publish', label: '投递到平台', copy: '再把成片投递到平台账号，默认停在发布前'/u)
  assert.match(source, /const AS_APPROVING = new Set\(\['video', 'packaging', 'publish'\]\);/u)
  assert.match(source, /packaging: '发布资料', publish: '投递到平台' \};/u)
  // The picker is gated on the depth, so shallower tasks never see it.
  assert.match(page, /form\.depth === 'publish' \? h\('div', \{ className: 'sv-as-field' \}/u)
  assert.match(page, /'投递到哪个平台账号'/u)
  // A publish task without a target cannot be saved.
  assert.match(page, /const publishReady = form\.depth !== 'publish' \|\| Boolean\(form\.publishAccountId\)/u)
  assert.match(page, /&& voiceReady && publishReady;/u)
  // The "no usable account" reason is rendered by runtimeBlockers alone; the
  // picker must not repeat the same sentence a second time.
  assert.match(page, /还没有可选的平台账号。/u)
  assert.doesNotMatch(page, /runtime\?\.publish\?\.reason \|\| '没有可用的平台账号/u)
  // A stale target must not ride a shallower task's payload.
  assert.match(page, /publish: form\.depth === 'publish' && form\.publishAccountId/u)
  // Auto-submit is called out as irreversible rather than quietly enabled.
  assert.match(page, /将无人值守直接发布到平台/u)
  assert.match(page, /发布后无法撤回/u)
  // The old absolute promise is gone: publishing IS automated at this depth.
  assert.doesNotMatch(page, /发布动作永远不会自动执行/u)
  // Confirmation copy states which mode is actually in force.
  assert.match(page, /该深度会无人值守直接发布到平台，发布后无法撤回。/u)
  assert.match(page, /最后一步停在发布前，需要你在浏览器窗口确认/u)
})

test('publish page is a flat video shelf with one lifecycle drawer and no release gates', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PublishPageV4(')
  const end = source.indexOf('\n    async function apply(ctx)', start)
  assert.ok(start >= 0 && end > start, 'PublishPageV4 must remain a standalone component')
  const page = source.slice(start, end)

  // The shelf is a single column of video cards: no task panel, no second drawer.
  assert.match(page, /className: 'sv-pb-shelf'/u)
  assert.doesNotMatch(page, /sv-split/u)
  assert.doesNotMatch(page, /moreDrawer|summaryDrawer|openMore|openSummary/u)
  assert.match(source, /const PUBLISH_PAGE_SIZE = 8;/u)
  assert.match(page, /PUBLISH_PAGE_SIZE/u)
  assert.match(page, /aria-label': '上一页'/u)
  assert.match(page, /aria-label': '下一页'/u)

  // Videos play in a modal; bytes are pulled lazily through readPublishAsset.
  assert.match(page, /PublishVideoThumb/u)
  assert.match(source, /remote\(packId, 'readPublishAsset', \{ projectId: item\.id, kind: 'video' \}\)/u)

  // Opening a video without publish info triggers exactly one generation.
  assert.match(page, /autoTriggered\.current/u)
  assert.match(page, /void startPackaging\(detail\.id, detail\.revision\)/u)

  // Covers: prompt is visible and editable, regenerable per direction, uploadable.
  assert.match(page, /remote\(packId, 'regeneratePublishCover', \{ projectId: detail\.id, expectedRevision: revision, kind, prompt: prompts\[kind\], negativePrompt: prompts\.negative \}\)/u)
  assert.match(page, /setPrompts\(\(prev\) => \(\{ \.\.\.prev, \[kind\]: event\.target\.value \}\)\)/u)
  assert.match(page, /按此提示词生图/u)
  assert.match(page, /uploadPublishCover/u)
  assert.doesNotMatch(page, /connectionEnabled|启用 AI 封面生成/u)
  assert.match(page, /service\?\.configured/u)
  assert.match(page, /保存当前渠道的 API Key/u)
  // Regenerating a cover commits unsaved edits first, like the script page.
  assert.match(page, /if \(dirty\) \{[\s\S]*?updatePackaging[\s\S]*?revision = saved\.project\.revision/u)

  // Readiness is the whole contract: title/copy/description/tags.
  assert.match(page, /资料齐备即视为可发布/u)
  assert.match(page, /重新生成发布信息/u)

  // No approval, queue or export surface survives.
  assert.doesNotMatch(page, /人工批准|加入发布队列|生成发布包|下载发布包/u)
  assert.doesNotMatch(page, /stage: 'approval'|stage: 'queue'/u)
  assert.doesNotMatch(page, /exportPublishPackage|readExport|queuePackage|listPublishTasks/u)
  assert.doesNotMatch(page, /destination/u)
  assert.match(page, /title: '发布'/u)
  assert.doesNotMatch(page, /发布 \/ 入队/u)
})

// 视频任务进度：把 client.js 里的纯函数抽出来真正执行，而不是只做文本匹配。
async function loadVideoProgressHelpers() {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('const VIDEO_PIPELINE_STAGES = [')
  const end = source.indexOf('\n    function mediaDataUrl(', start)
  assert.ok(start >= 0 && end > start, 'video progress helpers must stay extractable')
  const sandbox = {
    mediaStatusLabel: (status) => ({ queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败' })[status] || status,
    videoPhaseLabel: (phase) => ({ preparing: '正在准备制作空间', directing: 'AI 视觉导演创作中', rendering: '正在渲染成片', 'editorial-review': '独立审片中' })[phase] || null,
  }
  vm.runInNewContext(`${source.slice(start, end)}\n;globalThis.__h = { videoTaskProgress, formatElapsed, formatEtaRange, videoEtaFromHistory, videoTaskDurationSeconds, VIDEO_PIPELINE_STAGES }`, sandbox)
  const helpers = sandbox.__h
  // 沙箱里的数组/对象来自另一个 realm，原型不同，deepEqual 会做引用比较。
  // 统一用 JSON 结构比较，保持断言表达原意。
  helpers.plain = (value) => JSON.parse(JSON.stringify(value))
  return helpers
}

test('video task progress reflects real recorded stage timings without inventing a percentage', async () => {
  const helpers = await loadVideoProgressHelpers()
  const now = Date.parse('2026-09-27T09:04:09.506Z')
  const task = {
    status: 'running',
    phase: 'rendering',
    startedAt: '2026-09-27T08:44:08.506Z',
    completedAt: null,
    pipeline: {
      startedAt: '2026-09-27T08:44:08.506Z',
      stages: {
        preparing: { status: 'succeeded', startedAt: '2026-09-27T08:44:08.506Z', completedAt: '2026-09-27T08:44:08.906Z' },
        directing: { status: 'succeeded', startedAt: '2026-09-27T08:44:08.906Z', completedAt: '2026-09-27T09:00:18.106Z' },
        preflight: { status: 'succeeded', startedAt: '2026-09-27T09:00:18.106Z', completedAt: '2026-09-27T09:00:18.106Z' },
        rendering: { status: 'running', startedAt: '2026-09-27T08:58:38.506Z' },
      },
    },
  }
  const progress = helpers.videoTaskProgress(task, now)
  assert.equal(progress.steps.length, 7)
  assert.deepEqual(helpers.plain(progress.steps.map((step) => step.status)), ['done', 'done', 'done', 'active', 'pending', 'pending', 'pending'])
  // 导演阶段的真实耗时必须暴露出来——它通常是最长的瓶颈。
  assert.equal(Math.round(progress.steps[1].seconds), 969)
  assert.equal(Math.round(progress.activeSeconds), 331)
  assert.equal(Math.round(progress.totalSeconds), 1201)
  // 没有 progress.render 时不编造百分比。
  assert.equal(progress.render, null)
  assert.ok(!('percent' in progress))
})

test('video task progress surfaces Remotion frame progress and repair attempts', async () => {
  const helpers = await loadVideoProgressHelpers()
  const progress = helpers.videoTaskProgress({
    status: 'running',
    phase: 'rendering',
    startedAt: '2026-09-27T00:15:33.241Z',
    pipeline: {
      stages: { rendering: { status: 'running', startedAt: '2026-09-27T00:20:00.000Z' } },
      render: { stage: 'rendering', done: 4200, total: 8873, percent: 47, remainingSeconds: 2152 },
      editorialRepair: { attempts: 2, maxAttempts: 2 },
    },
  }, Date.parse('2026-09-27T00:30:00.000Z'))
  // 渲染进度来自 Remotion 自报的真实帧数。
  assert.equal(progress.render.percent, 47)
  assert.equal(progress.render.done, 4200)
  assert.equal(progress.render.total, 8873)
  assert.equal(progress.render.remainingSeconds, 2152)
  // 修复重试必须可见，否则长耗时修复看起来像卡死。
  assert.deepEqual(helpers.plain(progress.repair), { attempts: 2, maxAttempts: 2 })
})

test('video task progress marks the failing stage and freezes finished durations', async () => {
  const helpers = await loadVideoProgressHelpers()
  const task = {
    status: 'failed',
    phase: 'failed',
    startedAt: '2026-09-26T23:15:33.241Z',
    completedAt: '2026-09-27T00:17:52.942Z',
    pipeline: {
      completedAt: '2026-09-27T00:17:52.942Z',
      stages: {
        preparing: { status: 'succeeded', startedAt: '2026-09-26T23:15:33.241Z', completedAt: '2026-09-26T23:15:33.741Z' },
        directing: { status: 'succeeded', startedAt: '2026-09-26T23:15:33.741Z', completedAt: '2026-09-26T23:21:30.241Z' },
        'editorial-review': { status: 'failed', startedAt: '2026-09-26T23:21:30.241Z', completedAt: '2026-09-27T00:17:52.942Z' },
      },
    },
  }
  // 用一个远在未来的 now：已结束任务的总耗时必须锁定，不能继续增长。
  const progress = helpers.videoTaskProgress(task, Date.parse('2027-01-01T00:00:00.000Z'))
  assert.equal(Math.round(progress.totalSeconds), 3740)
  assert.equal(progress.steps.find((step) => step.id === 'editorial-review').status, 'failed')
  // 失败阶段之前的阶段按已完成展示，之后的保持待执行。
  assert.equal(progress.steps.find((step) => step.id === 'preparing').status, 'done')
  assert.equal(progress.steps.find((step) => step.id === 'committing').status, 'pending')
  assert.equal(progress.activeSeconds, null)
})

test('elapsed formatting and historical ETA stay honest about uncertainty', async () => {
  const helpers = await loadVideoProgressHelpers()
  assert.equal(helpers.formatElapsed(45), '45 秒')
  assert.equal(helpers.formatElapsed(331), '5 分 31 秒')
  assert.equal(helpers.formatElapsed(3600), '1 小时 0 分')
  // 样本不足时不给预期。
  assert.equal(helpers.videoEtaFromHistory([{ status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' }]), null)
  const many = [10, 12, 14, 16].map((minutes, index) => ({
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + minutes * 60_000).toISOString(),
    id: String(index),
  }))
  const eta = helpers.videoEtaFromHistory(many)
  // 中位数 13 分钟，输出区间而非伪精确单点。
  assert.equal(eta.sample, 4)
  assert.match(eta.range, /^约 \d+–\d+ 分钟$/u)
  assert.equal(helpers.formatEtaRange(90), '约 1–2 分钟')
  assert.equal(helpers.formatEtaRange(null), null)
})

test('video task card renders the progress surface instead of a bare phase label', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoTaskProgress(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'VideoTaskProgress must remain a standalone component')
  const component = source.slice(start, end)
  assert.match(component, /role: 'list', 'aria-label': '视频制作阶段'/u)
  assert.match(component, /'aria-label': '渲染进度'/u)
  assert.match(component, /预计剩余/u)
  assert.match(component, /已完成 \$\{render\.done\}\/\$\{render\.total\} 帧/u)
  assert.match(component, /审片触发修复/u)

  const pageStart = source.indexOf('function VideoPreviewPageV2(')
  const pageEnd = source.indexOf('\n    function ', pageStart + 40)
  const page = source.slice(pageStart, pageEnd)
  // 秒表必须每秒推进，否则阶段用时不走动。
  assert.match(page, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/u)
  assert.match(page, /videoTaskProgress\(task, now\)/u)
  assert.match(page, /videoEtaFromHistory\(taskFeed\.items/u)
})

test('video progress keeps ticking when a running task is off the current page', async () => {
  const source = await readFile(clientPath, 'utf8')
  const pageStart = source.indexOf('function VideoPreviewPageV2(')
  const pageEnd = source.indexOf('\n    function ', pageStart + 40)
  const page = source.slice(pageStart, pageEnd)

  // 时钟开关必须来自全局 counts（后端按全部任务统计），不能只看当前页的
  // `taskFeed.anyRunning`——那个值只统计当前这页 + 当前筛选，翻页或筛 tab
  // 时会变 false，正在跑的任务秒数随之冻结，而用户最需要它跳的时候正是这时。
  assert.match(page, /hasLiveTask/u)
  assert.match(page, /Number\(taskFeed\.counts\?\.running \|\| 0\) > 0/u)
  assert.match(page, /Number\(taskFeed\.counts\?\.queued \|\| 0\) > 0/u)
  assert.match(page, /\}, \[hasLiveTask\]\)/u)
  // 反向钉死：不许再退回到只看当前页的那个开关。
  assert.doesNotMatch(page, /\}, \[taskFeed\.anyRunning\]\)/u, '时钟开关不得退回当前页的 anyRunning')
})

test('video progress explains each phase in plain words and proves it is alive', async () => {
  const source = await readFile(clientPath, 'utf8')
  const component = source.slice(source.indexOf('function VideoTaskProgress('), source.indexOf('\n    function VideoPreviewPageV2(', source.indexOf('function VideoTaskProgress(')))

  // 七个阶段都有一句人话；漏一个就会出现「只有编号没有说明」的窗口期。
  for (const phrase of [
    '正在为这次制作准备空间',
    'AI 正在设计分镜和画面',
    '正在检查工程，避免渲染到一半才发现问题',
    '正在逐帧生成画面，这一步最花时间',
    '正在检查画质、音轨和字幕',
    '另一个 AI 正在看你的片子挑毛病',
    '马上就好',
  ]) {
    assert.ok(source.includes(phrase), `阶段说明缺失：${phrase}`)
  }
  // 说明表必须覆盖步骤条里的每一个 id，否则新增阶段会静默没有说明。
  const stages = ['preparing', 'directing', 'preflight', 'rendering', 'technical-qc', 'editorial-review', 'committing']
  const table = source.slice(source.indexOf('const VIDEO_PHASE_HINT'), source.indexOf('const VIDEO_STALL_SECONDS'))
  for (const id of stages) {
    assert.ok(table.includes(`'${id}':`) || table.includes(`${id}:`), `VIDEO_PHASE_HINT 缺少阶段 ${id}`)
  }
  // 长阶段必须有「还活着」的证据，阈值 30 秒。
  assert.match(source, /const VIDEO_STALL_SECONDS = 30;/u)
  assert.match(component, /sv-vprogress-alive/u)
  // 这里只断言「有这条提示」，**不断言具体措辞**。
  // 措辞的诚实性由「等待反馈不能说谎」那条用例按**渲染出来的字符串**管；
  // 在这里对整段源码断言「没有卡住」，命中的只会是注释，等于给旧文案留后门。
  assert.match(component, /className: 'sv-vprogress-alive', role: 'status'/u)
  // 渲染阶段本身有帧进度，就不再重复喊「还在进行」。
  assert.match(component, /const showStall = stalledSeconds != null && !\(render/u)
})

test('video progress motion is subtle and fully disabled under prefers-reduced-motion', async () => {
  const source = await readFile(clientPath, 'utf8')
  // 直接取内嵌样式表本体，避免拿整份源码当 CSS 匹配造成假绿。
  // 样式分两段模板：`css` 是基础块，`productCss` 用 ${css} 接着追加。
  // 两段都是最终装进页面的样式，所以取到 productCss 结束为止。
  const cssStart = source.indexOf('const css = `')
  const productStart = source.indexOf('const productCss')
  const cssEnd = source.indexOf('`;', productStart)
  assert.ok(cssStart > 0 && productStart > cssStart && cssEnd > productStart, 'client must define its product CSS')
  const css = source.slice(cssStart, cssEnd)

  // 呼吸而不是转圈：转圈是「假装在干活」，等得久时只会加剧焦躁。
  assert.ok(css.includes('@keyframes sv-vprogress-breathe'))
  assert.match(css, /\.sv-vprogress-step\[data-status="active"\] \{ animation:sv-vprogress-breathe/u)
  assert.doesNotMatch(css, /sv-vprogress[^}]*animation:[^;]*spin/u)
  // 已完成阶段一次性落定，不是无限循环。
  assert.match(css, /@keyframes sv-vprogress-settle/u)
  assert.match(css, /\.sv-vprogress-step\[data-status="done"\] i \{ animation:sv-vprogress-settle \.5s ease-out 1;/u)
  // 进度条高光扫过，且结束后不再扫（100% 还在扫会像没跑完）。
  assert.match(css, /\.sv-vprogress-sweep::after/u)
  assert.match(css, /\.sv-vprogress-sweep\[data-status="succeeded"\]::after/u)
  assert.match(css, /\.sv-vprogress-sweep\[data-status="failed"\]::after \{ content:none; \}/u)

  // 无障碍底线：本轮新增的四处动画都必须在 reduced-motion 下静止。
  // 旧规则只覆盖了 active 的 i，漏掉任何一条都会让「关了动画还在动」。
  const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {', css.indexOf('sv-vprogress-alive')))
  for (const selector of ['.sv-vprogress-step[data-status="active"]', '.sv-vprogress-step[data-status="done"] i', '.sv-vprogress-alive-dot', '.sv-vprogress-sweep::after']) {
    assert.ok(reducedMotion.includes(selector), `reduced-motion 未覆盖：${selector}`)
  }
  // 动画只碰 opacity / transform，不碰宽高（避免逐帧重排）。
  assert.match(css, /@keyframes sv-vprogress-breathe \{ 0%,100% \{ opacity:1; \} 50% \{ opacity:\.62; \} \}/u)
  assert.match(css, /@keyframes sv-vprogress-alive \{ 0%,100% \{ opacity:\.35; transform:scale\(\.82\); \} 50% \{ opacity:1; transform:scale\(1\.06\); \} \}/u)
})

test('video workbench offers a re-QC path for a finished cut that never got one', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    function ', start + 40)
  assert.ok(start >= 0 && end > start, 'VideoPreviewPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  // 成片存在但没有 qc 产物时（老任务或渲染路径没提交 qc），发布页看不到它；
  // 这里必须给出「补做技术质检」而不是逼用户重跑一次渲染。
  assert.match(page, /const runTechnicalQc = async \(task\) => \{/u)
  assert.match(page, /remote\(packId, 'startTechnicalQc', \{ projectId: task\.projectId, expectedRevision: project\.revision, videoTaskId: task\.id \}\)/u)
  assert.match(page, /task\.status === 'succeeded' && task\.result\?\.video && !qcPassed/u)
  assert.match(page, /补做技术质检/u)
  assert.match(page, /不会重新渲染视频/u)
  assert.match(page, /不会出现在「发布」页/u)
})

test('publish shelf deletes media one at a time or as a checked batch', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PublishPageV4(')
  const end = source.indexOf('\n    async function apply(ctx)', start)
  assert.ok(start >= 0 && end > start, 'PublishPageV4 must remain a standalone component')
  const page = source.slice(start, end)

  // 删除走 store.remove，一次提交整个选中集合。
  assert.match(page, /const deleteItems = async \(targets\) => \{/u)
  assert.match(page, /remote\(packId, 'remove', \{ projectIds: targets\.map\(\(item\) => item\.id\) \}\)/u)
  // 单个删除在卡片上，批量删除在工具条上，两者都先确认再删。
  assert.match(page, /const askDelete = \(targets\) => \{/u)
  assert.match(page, /title: single \? '删除素材' : `删除 \$\{targets\.length\} 个素材`/u)
  assert.match(page, /danger: true/u)
  assert.match(page, /confirm: '永久删除'/u)
  assert.match(page, /包括它的稿件、配音、字幕、成片和封面，无法恢复/u)
  // 多选：卡片复选框 + 本页全选 + 已选计数。
  assert.match(page, /const \[selected, setSelected\] = React\.useState\(\(\) => new Set\(\)\)/u)
  assert.match(page, /'aria-label': `选择素材「\$\{item\.title\}」`/u)
  assert.match(page, /'aria-label': '选择本页全部素材'/u)
  assert.match(page, /const allOnPageSelected = pageIds\.length > 0 && selectedOnPage\.length === pageIds\.length/u)
  assert.match(page, /已选 \$\{selected\.size\} 个/u)
  assert.match(page, /className: 'lwb-danger-button'/u)
  // 批量选择只覆盖当前页，跨页选择容易误删。
  assert.match(page, /批量选择只覆盖当前 Tab 当前页可见的卡片/u)
  // 被删项目正开着抽屉时要关掉，避免停留在已不存在的记录上。
  assert.match(page, /if \(openProject && removed\.has\(openProject\)\) \{ setOpenProject\(null\); setTriggerError\(null\); \}/u)
})

test('schedule form exposes a per-task voice preset that rides create, edit and upload', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ContentSchedulePage(')
  const end = source.indexOf('\n    function LegacyAudioCaptionsPageV2(', start)
  assert.ok(start >= 0 && end > start, 'ContentSchedulePage must remain a standalone component')
  const page = source.slice(start, end)

  // 音色有三个维度了：模式（预置/设计/克隆）+ 预置音名 + 可选语气，语速音量照旧。
  // 旧任务存的是 voiceSource/bridge.* 那套退役字段，读回来时只取音色名与语气，
  // 默认值与回填助手仍住在 emptyScheduleForm 旁边，不在页面组件里。
  // 默认音名不再取「数组最后一项」——扩到 9 个后那会变成英文男声 Dean。
  assert.match(source, /voiceId: SV_MIMO_DEFAULT_VOICE, voiceRate: '1', voiceVolume: '1', voiceStyle: ''/u)
  assert.match(source, /voiceId: voice\?\.voiceId && SV_MIMO_BUILTIN_VOICES\.includes\(voice\.voiceId\) \? voice\.voiceId/u)
  assert.match(source, /voiceStyle: voice\?\.style \|\| voice\?\.bridge\?\.style \|\| ''/u)
  assert.match(page, /voice: voicePayloadOf\(\)/u)
  // 三模式按模式分叉发：preset 带音名，design 只带描述，upload 只带参考音频。
  assert.match(page, /return \{ \.\.\.base, \.\.\.tone, voiceId: form\.voiceId, voiceName: form\.voiceId \}/u)
  assert.match(page, /const tone = form\.voiceStyle\.trim\(\) \? \{ style: form\.voiceStyle\.trim\(\) \} : \{\}/u)
  assert.doesNotMatch(page, /voicePayloadOf = \(\) => \{[\s\S]{0,600}?provider:/u)
  // 三模式互斥后，音色校验按模式分叉：design 看描述，preset 看音色表。
  assert.match(page, /const voiceReady = form\.voiceSource === 'design'\s*\? Boolean\(form\.voiceDesignText\.trim\(\)\)\s*: SV_MIMO_BUILTIN_VOICES\.includes\(form\.voiceId\)/u)
  assert.match(page, /请选择一个音色/u)
  // 语气预设与配音页同源，一键可选也可手输。
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('button'/u)
  // 声音复刻已回到排期页（克隆模式）；桥接面板仍然撤着，那条路不回来。
  // 排期页必须把 voiceDesign / referenceAudio 一并带进 payload——只搬 voiceId 会让
  // 定时生成的配音静默退回默认音色，用户选的声音根本没生效且无报错。
  assert.match(page, /remoteStatic\('uploadVoiceReference', \{/u, '排期页也要能上传参考音频')
  assert.match(page, /if \(form\.voiceSource === 'design'\) return \{ \.\.\.base, \.\.\.tone, voiceDesign: form\.voiceDesignText\.trim\(\) \}/u)
  assert.match(page, /referenceAudio: form\.voiceReference/u)
  // 旧任务读回也要带回 voiceDesign / referenceAudio，否则编辑一条 design 任务
  // 会把它悄悄变回预置音色。回填助手住在页面组件之外，所以断言整份源码。
  assert.match(source, /voiceDesignText: schedule\.voice\?\.voiceDesign \|\| ''/u)
  assert.match(source, /voiceReference: schedule\.voice\?\.referenceAudio \|\| null/u)
  assert.doesNotMatch(page, /bridgeVoiceoverInfo/u)
  assert.doesNotMatch(page, /桥接内置音色只能搭配云端/u)
})

test('pending topics group by frozen account snapshot and light up tab badges', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function pendingCountByTab(')
  const end = source.indexOf('\n    function', start)
  assert.ok(start >= 0 && end > start, 'script client must define pendingCountByTab beside emptyScriptForm')
  const pendingCountByTab = vm.runInNewContext(`${source.slice(start, end)}; const GENERAL_TAB = '__general__'; pendingCountByTab`, {})

  const topics = [
    { scriptState: 'none', account: { id: 'acc-1', name: '账号一' } },
    { scriptState: 'none', account: { id: 'acc-1', name: '账号一' } },
    { scriptState: 'none', account: null },
    { scriptState: 'none', account: null },
    { scriptState: 'none', account: null },
    { scriptState: 'draft', account: null },
    { scriptState: 'approved', account: { id: 'acc-2', name: '账号二' } },
  ]
  // vm 沙箱返回的对象原型与宿主不同，展开成宿主对象再比较。
  assert.deepEqual({ ...pendingCountByTab(topics) }, { 'acc-1': 2, __general__: 3 })
  assert.deepEqual({ ...pendingCountByTab([]) }, {})
  assert.deepEqual({ ...pendingCountByTab(null) }, {})
})

test('script page defaults to the tab holding pending topics and the topic dialog states the general-tab destination', async () => {
  const source = await readFile(clientPath, 'utf8')
  const scriptStart = source.indexOf('function ScriptPage(')
  const scriptEnd = source.indexOf('\n    function', scriptStart)
  const scriptPage = source.slice(scriptStart, scriptEnd)

  // 默认 Tab：账号/通用都有效时，当前 Tab 无待写稿而通用 Tab 有，则让位给通用 Tab。
  assert.match(scriptPage, /const pendingByTab = pendingCountByTab\(nextTopics\);/u)
  assert.match(scriptPage, /if \(general > currentPending\) return GENERAL_TAB;/u)
  // 角标传给 AccountTabs，由 sv-tp-tab-badge 渲染。
  assert.match(scriptPage, /tabBadge: pendingByTab/u)
  assert.match(source, /\.sv-tp-tab-badge \{/u)

  // 选题确认弹窗：不带账号定位的任务必须写明选题会落在写稿页通用 Tab。
  const topicStart = source.indexOf('function TopicsPage(')
  const topicEnd = source.indexOf('\n    function ScriptPage(', topicStart)
  const topicsPage = source.slice(topicStart, topicEnd)
  assert.match(topicsPage, /const destination = payload\.accountId/u)
  assert.match(topicsPage, /加入待写稿后只会出现在写稿页「通用（无账号定位）」Tab/u)
})

test('pipeline board page groups by stage and hands the project to the owning work page', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('const PIPELINE_STAGES = [')
  const end = source.indexOf('\n    function ContentSchedulePage(', start)
  assert.ok(start >= 0 && end > start, 'pipeline board must declare its stages beside the component')
  const board = source.slice(start, end)

  // 阶段 → 页面的映射与各工作页的过滤闸门一致。
  for (const page of ['scripts', 'audio-captions', 'video-preview', 'publish']) {
    assert.match(board, new RegExp(`page: '${page}'`), `board must route a stage to ${page}`)
  }
  for (const stage of ['script-pending', 'script-review', 'voiceover', 'video', 'publish']) {
    assert.match(board, new RegExp(`id: '${stage}'`), `board must declare stage ${stage}`)
  }
  // 跳转 = 模块级 handoff + openPackMenu，与既有接力机制同构。
  assert.match(board, /pipelineHandoff = \{ page: stage\.page, projectId: item\.id \}/u)
  assert.match(board, /openPackMenu\?\.\(stage\.page\)/u)
  assert.match(source, /let pipelineHandoff = null;/u)
  // 数据来自 gateway 的 pipelineOverview。
  assert.match(board, /remote\(packId, 'pipelineOverview'\)/u)
  // 四个目标页都消费 pipelineHandoff（写稿/视频页用守卫式，配音/发布页用可选链）。
  assert.match(source, /pipelineHandoff\?\.page === 'audio-captions'/u)
  assert.match(source, /pipelineHandoff\.page !== 'video-preview'/u)
  assert.match(source, /pipelineHandoff\?\.page === 'publish'/u)
  assert.match(source, /pipelineHandoff\.page !== 'scripts'/u)
  // 页面已注册。
  assert.match(source, /pipeline: PipelineBoardPage/u)
  // 选项卡式：一排阶段 tab + 数字徽标；默认停在首个非空阶段；空阶段给指引文案。
  assert.match(board, /role: 'tablist', 'aria-label': '按制作阶段筛选项目'/u)
  assert.match(board, /className: 'sv-tp-tab', 'data-active': activeStage === stage\.id/u)
  assert.match(board, /sv-tp-tab-badge/u)
  assert.match(board, /PIPELINE_STAGES\.find\(\(stage\) => byStage\.get\(stage\.id\)\?\.length\)\?\.id \|\| PIPELINE_STAGES\[0\]\.id/u)
  assert.match(board, /点上面的其他选项卡查看/u)
})

test('audio and video cards can delete a finished task after a danger confirmation', async () => {
  const source = await readFile(clientPath, 'utf8')
  const audioStart = source.indexOf('function AudioCaptionsPageV2(')
  const videoStart = source.indexOf('function VideoPreviewPageV2(')
  assert.ok(audioStart >= 0 && videoStart > audioStart, 'both pages must remain standalone components')
  const audio = source.slice(audioStart, videoStart)
  const video = source.slice(videoStart)

  for (const [name, page, call] of [
    ['audio', audio, 'deleteMediaTasks'],
    ['video', video, 'deleteMediaTasks'],
  ]) {
    // 走同一个后端入口，任务类型区分配音与视频。
    assert.match(page, new RegExp(`remote\\(packId, '${call}', \\{ taskType: '${name}', ids: targets\\.map\\(\\(task\\) => task\\.id\\) \\}\\)`, 'u'), `${name} delete must go through ${call}`)
    // 只给终态卡片显示删除，运行中的不显示（避免用户以为能删正在跑的）。
    //
    // 2026-10-27：视频任务多了 cancelled 终态（停止按钮的产物），它同样是终态，
    // 因此和 succeeded/failed 一样可以删除。这里允许可选地多一个 'cancelled'，
    // 同时钉住两条反向约束：running / interrupted 绝不能出现在可删集合里——
    // interrupted 是可续跑的，删掉它等于把能恢复的进度丢了。
    assert.match(page, /\['succeeded', 'failed'(?:, 'cancelled')?\]\.includes\(task\.status\) \? h\('button', \{ type: 'button', className: 'lwb-danger-button'/u, `${name} delete button is terminal-only`)
    const deleteGate = page.match(/\[([^\]]*)\]\.includes\(task\.status\) \? h\('button', \{ type: 'button', className: 'lwb-danger-button'/u)
    assert.ok(deleteGate, `${name} delete must be gated on a status list`)
    assert.doesNotMatch(deleteGate[1], /'running'|'queued'/u, `${name} must not offer delete on a live task`)
    assert.doesNotMatch(deleteGate[1], /'interrupted'/u, `${name} must not offer delete on a resumable interrupted task`)
    // 破坏性操作必须走 danger 二次确认。
    assert.match(page, /confirm: '确认删除', danger: true/u, `${name} delete asks for a danger confirmation`)
    assert.match(page, /删除后无法恢复/u, `${name} delete warns that it cannot be undone`)
    // 走既有确认弹窗与既有危险按钮样式，不新增 lwb-* 类名。
    assert.match(page, /ask\(\{ title: '删除这条/u, `${name} delete opens the shared confirm dialog`)
  }

  // 两处都要在成功后刷新列表并回报结果（含部分缺失的情况）。
  assert.match(audio, /await taskFeed\.refresh\(\); setError\(null\);/u)
  assert.match(audio, /另有 \$\{gone\} 条此前已不存在/u)
  assert.match(video, /另有 \$\{gone\} 条此前已不存在/u)
  // 配音删除文案要说清「想再生成一次请用重试」，视频要说明产物通常有几百 MB。
  assert.match(audio, /用「重试配音」更合适/u)
  assert.match(video, /视频产物通常有几百 MB/u)
})

test('a finished schedule round can be deleted, a running one cannot', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ScheduleRunDetails(')
  assert.ok(start >= 0, 'ScheduleRunDetails must remain a standalone component')
  const page = source.slice(start, start + 8000)

  // 停止与删除并存：运行中只给停止，停止后才出现删除。
  assert.match(page, /detail\.active \? h\('button', \{ type: 'button', className: 'lwb-plain-button'[\s\S]*?停止本轮/u)
  assert.match(page, /detail\.active \? null : h\('button', \{ type: 'button', className: 'lwb-danger-button'/u, 'the delete button is hidden while the round is active')
  assert.match(page, /remote\(packId, 'deleteScheduleRun', \{ runId \}\)/u)
  assert.match(page, /confirm: '确认删除', danger: true/u)
  // 说清只删记录、不动内容安排与项目，避免用户误以为会连带删内容。
  assert.match(page, /不影响内容安排本身，也不删除它产出的项目/u)
})

test('the publish shelf defaults to the richest account tab and badges every tab count', async () => {
  // 2026-10-08 反馈：刚跑完的成片在发布页「找不到」。真因是页面默认停在「通用」Tab，
  // 而绝大多数成片都带账号归属——数据一直都在，只是被 Tab 筛掉了。
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PublishPageV4(')
  const end = source.indexOf('\n    async function apply(ctx)', start)
  assert.ok(start >= 0 && end > start, 'PublishPageV4 must remain a standalone component')
  const page = source.slice(start, end)

  // 每个 Tab 统计成片数量并喂给角标（复用写稿页已有的 tabBadge 通道）。
  assert.match(page, /const countByTab = items\.reduce\(\(tally, item\) => \{/u)
  assert.match(page, /tabBadge: countByTab, tabBadgeLabel: '条成片'/u)
  // 归档 Tab 不参与「默认落在哪儿」，它另有专门的展示位。
  assert.match(page, /\.filter\(\(key\) => key !== ARCHIVED_TAB\)/u)

  // 默认 Tab = 成片最多的那个；用户手动切过之后不再被覆盖。
  assert.match(page, /if \(richest && byTab\[richest\] > 0\) return richest;/u)
  assert.match(page, /if \(current !== GENERAL_TAB && accounts\.accounts\.some\(\(item\) => item\.id === current && item\.status === 'active'\)\) return current;/u)
  // 全空时仍退回默认账号 / 通用，不能因为「没有最多」而落空。
  assert.match(page, /return accounts\.defaultAccountId \|\| GENERAL_TAB;/u)

  // 角标的无障碍文案要按页面语义走，不能沿用写稿页的「个待写稿」。
  assert.match(source, /function AccountTabs\(\{ accountLibrary, activeTab, onChange, label, disabled = false, children, tabBadge, tabBadgeLabel = '个待写稿' \}\)/u)
  assert.match(source, /'aria-label': `\$\{badge\} \$\{tabBadgeLabel\}`/u)
})

test('a shelf card states the next action instead of a passive status', async () => {
  // 旧文案对未生成只写「点『发布』查看或生成发布资料」，用户看到「未生成」以为白跑了。
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PublishPageV4(')
  const end = source.indexOf('\n    async function apply(ctx)', start)
  const page = source.slice(start, end)

  assert.match(page, /const publishFootNote = \(item\) => \{/u)
  assert.match(page, /if \(state === 'ready'\) return '标题 \/ 文案 \/ 描述 \/ 标签已就绪';/u)
  assert.match(page, /if \(state === 'running'\) return '正在生成发布资料…';/u)
  assert.match(page, /if \(state === 'failed'\) return '发布资料生成失败，点「发布」查看原因并重试';/u)
  assert.match(page, /return '点「发布」生成本片的标题、文案与标签';/u)
  // 卡片确实改用这个说明函数，而不是内联旧文案。
  assert.match(page, /className: 'sv-pb-card-meta' \}, publishFootNote\(item\)\)/u)
})


test('script task panel filters history by account positioning and sorts by time', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ScriptPage(')
  const end = source.indexOf('\n    function AudioCaptionsPage', start)
  const page = source.slice(start, end)
  assert.ok(start >= 0 && end > start, 'ScriptPage must remain a standalone component')

  // 运行中的任务也要跟着账号筛选走，否则选中某账号后正在跑的任务会凭空消失。
  assert.match(page, /const historyMatchesAccount = \(item\) => historyAccount === 'all' \|\| scriptTaskTab\(item, activeIds\) === historyAccount;/u)
  assert.match(page, /const activeHistoryTasks = sortScriptTasks\(history\.filter\(\(item\) => historyMatchesAccount\(item\) && \(item\.status === 'queued' \|\| item\.status === 'running'\)\), historySort\);/u)
  assert.match(page, /const filteredHistoryTasks = sortScriptTasks\(terminalHistoryTasks\.filter\(\(item\) => historyMatchesAccount\(item\) && \(historyFilter === 'all' \|\| item\.status === historyFilter\)\), historySort\);/u)
  assert.match(page, /按账号定位筛选写稿任务/u)
  assert.match(page, /按时间排序写稿任务/u)
  // 换筛选维度后必须回到第一页，否则可能停在越界页码上什么都看不到。
  assert.match(page, /React\.useEffect\(\(\) => \{ setHistoryPage\(0\); \}, \[historyFilter, historyAccount, historySort\]\);/u)
  // 账号归档后任务不消失，所以账号下拉里必须保留「已归档账号」这一档。
  assert.match(source, /function scriptTaskTab\(record, activeIds\) \{/u)
  assert.match(page, /const hasArchivedTasks = history\.some\(\(item\) => scriptTaskTab\(item, activeIds\) === ARCHIVED_TAB\);/u)
  assert.match(page, /historyAccountOptions\.push\(\{ id: ARCHIVED_TAB, label: '已归档账号' \}\)/u)
})


test('a finished render starts its own publish copy without covers', async () => {
  // 2026-10-08 反馈：刚跑完的成片在发布页显示「未生成」，像白跑了。原先发布资料只在
  // 点开发布页抽屉时才生成（那条路径保留——那里显存空闲、适合一并生封面）。
  const source = await readFile(clientPath, 'utf8')

  // 视频页轮询到成功任务时，自动补一次文案；幂等键落在项目+稿件版本上。
  assert.match(source, /const autoPackaging = React\.useRef\(new Set\(\)\)/u)
  assert.match(source, /if \(task\.status !== 'succeeded' \|\| !task\.projectId\) continue;/u)
  assert.match(source, /remote\(packId, 'autoStartPackaging', \{ projectId: task\.projectId \}\)/u)
  // 后端拒绝（已有资料/已在跑/没过质检）是正常路径，不弹错误；真错才提示且允许重试。
  assert.match(source, /if \(autoPackaging\.current\.has\(key\)\) continue;/u)
  assert.match(source, /\.catch\(\(cause\) => \{ autoPackaging\.current\.delete\(key\); setError\(cause\.message\); \}\)/u)
})


test('a finished render reports completion instead of still claiming to render', async () => {
  // 2026-10-08 反馈：卡片右上角已标「已完成」，进度块却仍写着「正在渲染成片 100%」，
  // 橙色满条看着更像还在跑。进度块在任务结束后保留是有价值的（总耗时、帧数），
  // 但文案与配色必须跟着状态走。
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoTaskProgress(')
  assert.ok(start >= 0, 'VideoTaskProgress must remain extractable')
  // 原来是固定 4000 字符窗口，靠「刚好够」吃饭：组件一加注释就会把后半段
  // （修复提示、进度条）挤出窗口，测试随之假红。改成切到下一个顶层声明为止，
  // 与文件里其它切片用例同一套做法。
  const nextDecl = /\r?\n {4}(?:function|async function|const [A-Za-z_$]|let |var )/gu
  nextDecl.lastIndex = start + 'function VideoTaskProgress('.length
  const boundary = nextDecl.exec(source)
  const page = source.slice(start, boundary ? boundary.index : source.length)

  // 结束后换标题：完成 / 中断 / 已停止。
  assert.match(page, /const renderHeadline = !running/u)
  assert.match(page, /\? \(status === 'succeeded' \? '渲染完成' : status === 'failed' \? '渲染中断' : '渲染已停止'\)/u)
  // 运行中才是「正在」。
  assert.match(page, /: \(render\?\.stage === 'bundling' \? '正在打包工程' : '正在渲染成片'\)/u)
  // 修复提示同理：结束后它记录的是「做过几次」，不是「正在」。
  assert.match(page, /`审片曾触发修复：共 \$\{repair\.attempts\}/u)

  // 进度条按状态换色，结束态不用进行中的橙色。断言写双冒号伪元素
  // （::-webkit-progress-value）——progress 元素真正生效的正是厂商伪元素。
  assert.match(page, /className: 'sv-vprogress-bar', 'data-status': status/u)
  assert.ok(source.includes('.sv-vprogress-bar[data-status="succeeded"] progress::-webkit-progress-value { background:#1f7354; }'), 'a finished render paints its bar green, not the in-progress orange')
  assert.ok(source.includes('.sv-vprogress-bar[data-status="failed"] progress::-webkit-progress-value { background:#a94343; }'), 'an interrupted render paints its bar red')

  /*
   * 等待反馈不能说谎：界面不许保证「没有卡住」。
   *
   * QA 查实：进度秒数来自前端 setInterval，后端渲染进程死了它照样跳，
   * 要跳到 90 分钟硬超时才报错。所以「界面每秒刷新，没有卡住」这句会在
   * 真卡住时持续骗用户一个半小时。
   *
   * 「界面静止用户会自己去刷新；界面假装活着，用户就会被骗着一直等。」
   */
  // 只查**会被渲染出来的字符串**，不查注释——注释里为了说明缘由会引用这句原文，
  // 直接对整段源码做 doesNotMatch 会被自己的注释绊倒。
  const rendered = [...page.matchAll(/'([^'\n]{4,})'|`([^`]{4,})`/gu)].map((m) => m[1] || m[2])
  for (const text of rendered) {
    assert.doesNotMatch(text, /没有卡住/u, `界面不能保证一件它无法知道的事：${text}`)
    assert.doesNotMatch(text, /界面每秒刷新/u, `本地时钟在跳不代表后端在干活：${text}`)
  }
  // 改成只陈述后端能作证的事实：已持续多久 + 最后一次后台动作在多久以前。
  assert.match(page, /最后一次后台动作在 \$\{formatElapsed\(silent\)\} 前/u)
  // 沉默超阈值要换措辞，明确说可能卡住了，并给出下一步。
  // 常量在组件外（与 VIDEO_STALL_SECONDS 并列），所以断言查整份源码。
  assert.match(source, /const VIDEO_SILENT_ALARM_SECONDS = 300;/u)
  assert.match(page, /silent >= VIDEO_SILENT_ALARM_SECONDS/u)
  // 「可能卡住了」必须出现在**渲染出来的字符串**里，而不是只出现在注释中
  // ——注释里说明缘由时也会写这四个字，对整段源码断言会被自己的注释蒙混过关。
  assert.ok(rendered.some((text) => text.includes('可能卡住了')), '沉默超阈值时渲染文案必须明说可能卡住了')
  assert.ok(rendered.some((text) => text.includes('可以刷新看看')), '说了可能卡住就要给出下一步，不能只报丧')
  // 沉默超阈值时那颗「跳动 = 我还活着」的橙点必须停：文案说卡住、点在跳，
  // 两种相反信号摆在同一个元素上，用户只会信那个在动的。
  const motionCss = source.slice(source.indexOf('const css = `'), source.indexOf('`;', source.indexOf('const productCss')))
  assert.match(motionCss, /\.sv-vprogress-alive\[data-silent="true"\] \.sv-vprogress-alive-dot \{[^}]*animation:none/u, '沉默态的点必须停止跳动')
  assert.match(motionCss, /\.sv-vprogress-alive\[data-silent="true"\] \.sv-vprogress-alive-dot \{[^}]*background:#a94343/u, '沉默态的点要改色，不能还是代表活着的橙')
  // 光有 CSS 规则不够——得确认那颗元素真的拿到了 data-silent。
  // 少了这半条，规则写好了但没人给它挂上，视觉上等于没做。
  assert.match(page, /'data-silent': progress\.silentSeconds != null && progress\.silentSeconds >= VIDEO_SILENT_ALARM_SECONDS \? 'true' : 'false'/u, '沉默态的 data-silent 必须由真实沉默时长决定，不能写死')
  // 沉默时长必须从**后端心跳**算，不能从本地 now 减本地 now，也不能拿阶段出生时间冒充。
  const progressFn = source.slice(source.indexOf('function videoTaskProgress('), source.indexOf('function videoTaskDurationSeconds('))
  assert.match(progressFn, /updatedAt: typeof rawRender\.updatedAt === 'string'/u, '渲染进度要带上后端的 updatedAt')
  // 心跳只认 render.updatedAt：别的阶段只在开始时写一次 startedAt，拿它算沉默
  // 会把每个正常跑十几分钟的导演/审片阶段误报成「卡住」。
  assert.match(progressFn, /const heartbeatMs = typeof render\?\.updatedAt === 'string' \? Date\.parse\(render\.updatedAt\) : NaN;/u, '心跳源只能是渲染进度的 updatedAt')
  assert.doesNotMatch(progressFn, /stages\[phase\]\?\.startedAt/u, '阶段出生时间不能当心跳用')
  assert.match(progressFn, /silentSeconds: hasHeartbeat \? Math\.max\(0, \(now - heartbeatMs\) \/ 1000\) : null/u, '没有心跳源时必须是 null，不推断死活')
  assert.doesNotMatch(progressFn, /silentSeconds.*?Date\.now\(\)/u, '不能拿本地时钟冒充后端心跳')
  assert.ok(source.includes('.sv-vprogress-bar[data-status="succeeded"] progress::-moz-progress-bar { background:#1f7354; }'), 'Firefox gets the same green bar')
})


test('the pipeline board surfaces a failed read and retries instead of hanging', async () => {
  // 2026-10-08 实测：工作台重启的那几秒里打开制作流水线页，pipelineOverview 请求撞上
  // 重启窗口失败，而页面既不报错也不重试——一直挂在「正在读取流水线…」，五个计数全是
  // 初始的 0（后端其实 39ms 就能返回 59 个项目）。
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PipelineBoardPage(')
  const end = source.indexOf('\n    function ContentSchedulePage(', start)
  assert.ok(start >= 0 && end > start, 'PipelineBoardPage must remain a standalone component')
  const page = source.slice(start, end)

  // 失败不静默：把原因和重试入口摆出来（与执行记录页同一模式）。
  assert.match(page, /error \? h\('div', \{ className: 'sv-error', role: 'alert' \}, error,/u)
  assert.match(page, /onClick: \(\) => \{ setAttempt\(\(value\) => value \+ 1\); void load\(\); \}/u)
  assert.match(page, /busy \? '正在重试…' : '重试读取'/u)

  // 自动重试：还没拿到任何数据且刚失败时，隔 2 秒自己再试。
  assert.match(page, /const \[attempt, setAttempt\] = React\.useState\(0\);/u)
  assert.match(page, /if \(items != null \|\| !error\) return undefined;/u)
  assert.match(page, /const timer = setTimeout\(\(\) => \{ void load\(\); \}, 2000\);/u)
  // 已经成功的项目不再被这条 effect 反复拉起。
  assert.match(page, /\[items, error, attempt, load\]/u)

  // 报错时不再同时显示「正在读取…」，否则看起来像还在加载。
  assert.match(page, /busy && items == null && !error \? h\('p'/u)
  assert.ok(!page.includes("h(Notice, { error })"), 'the bare notice without a retry affordance is gone')
})


test('the pipeline board times out a dead connection instead of hanging forever', async () => {
  // 2026-10-08 实测：工作台重启后，旧标签页的 WebSocket 已断，remote() 的 promise
  // 既不 resolve 也不 reject —— 页面永远停在「正在读取流水线…」，error 恒为 null，
  // 所以任何依赖 error 的重试都不会触发。必须有超时上限把它变成一次可见的失败。
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PipelineBoardPage(')
  const end = source.indexOf('\n    function ContentSchedulePage(', start)
  assert.ok(start >= 0 && end > start, 'PipelineBoardPage must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(page, /new Promise\(\(_, reject\) => setTimeout\(/u)
  assert.match(page, /工作台连接没有响应，可能已重启。请刷新页面后重试。/u)
  assert.match(page, /await Promise\.race\(\[remote\(packId, 'pipelineOverview'\), timer\]\)/u)
  // 连接断了「重试读取」也没用，额外给刷新页面这个出口。
  assert.match(page, /onClick: \(\) => location\.reload\(\)/u)
  assert.ok(page.includes("}, '刷新页面')"), 'the reload escape hatch is labelled')
})

// ---- 人工放行（C1/C2）：视频任务卡按钮 + 二次确认 + 持久标记 ----

test('video workbench releases a failed cut with a verifiable override commit', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    function ', start + 40)
  assert.ok(start >= 0 && end > start, 'VideoPreviewPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  // 放行入口：只在「质检失败且确有技术问题、且尚未放行」时出现。
  assert.match(page, /const qcFailedWithIssues = task\.status === 'succeeded' && Boolean\(task\.result\?\.video\) && !qcPassed && qcTechnicalIssues\.length > 0;/u)
  assert.match(page, /const qcReleased = qcFailedWithIssues && taskQc\?\.result\?\.userOverride === true;/u)

  // 放行提交：走独立 remote('commit')，idempotencyKey 绑定 task.id（重复提交同一任务不产生两条 qc 产物），
  // 必须带上 userOverride:true 且 passed:false（判据没过的事实不改写），technical 原样带回满足后端「有 issues 才放行」与「passed===technical.passed」两道断言。
  assert.match(page, /const releaseVideoCut = async \(task\) => \{/u)
  assert.match(page, /idempotencyKey: `manual-release-\$\{task\.id\}`,/u)
  assert.match(page, /userOverride: true,/u)
  assert.match(page, /passed: false,/u)
  assert.match(page, /technical: qc\.result\.technical,/u)
  // 放回行后刷新任务与项目，让 userOverride 生效、按钮消失、常驻标记出现。
  assert.match(page, /await taskFeed\.refresh\(\);/u)
  assert.match(page, /await reload\(\);/u)
  // 结论不完整时禁止放行：重提交会造出残缺 qc 产物，让用户先去补做技术质检。
  assert.match(page, /质检结论不完整，无法人工放行。请先点「补做技术质检」生成完整结论。/u)
})

test('video task card shows the release button only for a failed cut that is not yet released', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    function ', start + 40)
  const page = source.slice(start, end)

  // 按钮文案与显示条件：qcFailedWithIssues && !qcReleased。
  assert.match(page, /qcFailedWithIssues && !qcReleased \? h\('button', \{ type: 'button', className: 'lwb-primary-button', disabled: Boolean\(submitting\) \|\| taskFeed\.anyRunning, onClick: \(\) => ask\(\{ title: '人工放行这条成片'/u)
  assert.match(page, /'这是我要的静态风格，直接采用'\) : null,/u)
})

test('release confirmation states the static-style escape and the blank-video risk', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    function ', start + 40)
  const page = source.slice(start, end)

  // 二次确认必须把「这其实可能是空白视频」这层最坏可能说在前——否则用户以为放行的是正常视频。
  assert.ok(page.includes('如果你要的就是纯字幕/静态海报风格，可以继续。'), 'confirm copy offers the static-style escape')
  assert.ok(page.includes('如果这不是你要的效果，说明画面没渲染出来——放行后发出去就是一条空白视频。'), 'confirm copy warns the blank-video risk')
  // 还要说清放行会清掉已有发布文案/封面（invalidateDownstream 的副作用），让用户有预期。
  assert.ok(page.includes('放行会按当前稿件版本重新计算发布资料，原已生成的发布文案/封面将被清掉，放行后需重新生成封面。'), 'confirm copy warns that existing publish info is cleared')
  // 确认按钮文案明确是「放行」，不是模棱两可的「继续」。
  assert.match(page, /confirm: '确认放行'/u)
})

test('release button is disabled while its request is in flight to prevent double submit', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    function ', start + 40)
  const page = source.slice(start, end)

  // 防连点：提交中（submitting === `release:<id>`）时按钮 disabled，且文案切到「正在提交…」。
  assert.match(page, /disabled: Boolean\(submitting\) \|\| taskFeed\.anyRunning, onClick: \(\) => ask\(/u)
  assert.match(page, /submitting === `release:\$\{task\.id\}` \? '正在提交…' : '这是我要的静态风格，直接采用'\)/u)
})

test('after release the task card shows a persistent marker and hides the button', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function VideoPreviewPageV2(')
  const end = source.indexOf('\n    function ', start + 40)
  const page = source.slice(start, end)

  // 常驻标记：用中性偏冷新色（sv-released，不复用 warn 黄），几天后回看也知道它没合格质检。
  assert.match(page, /qcReleased \? h\('p', \{ className: 'sv-released' \}, `已人工放行 · 质检未通过（\$\{qcTechnicalIssues\[0\] \|\| '技术问题'\}）`\)/u)
  // 按钮被 !qcReleased 门控：放行成功后同一条件为假，按钮随之消失——用户不会以为没成功而重复点。
  assert.match(page, /qcFailedWithIssues && !qcReleased \? h\('button', \{ type: 'button', className: 'lwb-primary-button'/u)
})

test('publish shelf tags a manually-released cut so the user sees it from the other path too', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function PublishPageV4(')
  const end = source.indexOf('\n    async function apply(ctx)', start)
  assert.ok(start >= 0 && end > start, 'PublishPageV4 must remain a standalone component')
  const page = source.slice(start, end)

  // 发布页也要带「已人工放行」标记：复用后端 277c968 落地的 qcUserOverride 字段，无需新接口。
  // 用独立灰蓝标签，与任务卡常驻标记同色系，不与「质检通过」混淆。
  assert.match(page, /item\.qcUserOverride \? h\('span', \{ className: 'sv-released-tag' \}, '已人工放行'\)/u)
})



