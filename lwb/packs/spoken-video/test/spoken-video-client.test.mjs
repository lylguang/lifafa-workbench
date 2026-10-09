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
  assert.match(page, /remote\(packId, 'uploadVoiceReference', \{ name: file\.name, mediaType: file\.type, data \}\)/u)
  assert.match(page, /上传自己的参考音频/u)
  assert.match(page, /accept: 'audio\/mpeg,audio\/wav/u)
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
  assert.match(page, /remoteStatic\('configureMediaConnection', \{ provider: connectionProvider, apiKey \}\)/u)
  assert.match(page, /remoteStatic\('clearMediaConnectionCredential', \{ provider: connectionProvider \}\)/u)
  assert.doesNotMatch(page, /remote\(packId, '(?:configureMediaConnection|clearMediaConnectionCredential)'/u)
  assert.match(page, /source\?\.projectId \? \{ sourceProjectId: source\.projectId \}/u)
  assert.doesNotMatch(page, /provider: providerId, apiKey,/u)
  assert.match(page, /API Key 保存到 DSH 私有凭据库/u)
  assert.match(source, /function mediaErrorText\(error\)[\s\S]*?SciTiger 账户积分不足，请充值后重试，或切换到百炼 BYOK/u)
  assert.match(source, /function subtitleTaskProgress\(task, now = Date\.now\(\)\)[\s\S]*?实时识别/u)
  assert.match(page, /subtitleProgress = subtitleTaskProgress\(task\)/u)
  assert.match(page, /className: 'sv-audio-subtitle-progress'/u)
  assert.match(page, /'aria-label': '字幕识别进度'/u)
  assert.match(page, /mediaErrorText\(task\.error\)/u)
  assert.match(page, /mediaErrorText\(subtitle\.error\)/u)
  assert.doesNotMatch(page, /sv-list sv-run-list/u)
})

test('audio workbench retries a failed voiceover from its frozen task input', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(page, /const retryAudioTask = async \(task\) => \{/u)
  // The retry reuses the frozen manuscript and voice settings rather than
  // asking the person to reselect the script.
  assert.match(page, /text: task\.source\?\.text \|\| ''/u)
  assert.match(page, /voiceSource: task\.input\?\.voiceSource \|\| 'system'/u)
  assert.match(page, /rate: Number\(task\.input\?\.rate \?\? 1\)/u)
  assert.match(page, /volume: Number\(task\.input\?\.volume \?\? 1\)/u)
  assert.match(page, /subtitleEnabled: task\.input\?\.subtitleEnabled === true/u)
  // Only failed tasks with a frozen manuscript can be retried.
  assert.match(page, /task\.status === 'failed' && task\.source\?\.text/u)
  assert.match(page, /title: '重试配音'/u)
  assert.match(page, /onConfirm: \(\) => \{ void retryAudioTask\(task\); \}/u)
})

test('audio workbench exposes the bridge channel, voice and style on the task form', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  // 云端/本地开关按任务覆盖桥接配置，与定时任务表单同名同义。
  assert.match(page, /const \[bridgeChannel, setBridgeChannel\] = React\.useState\(''\)/u)
  assert.match(page, /h\('option', \{ value: '' \}, '跟随桥接配置'\)/u)
  assert.match(page, /h\('option', \{ value: 'cloud' \}, '云端（小米 MiMo）'\)/u)
  assert.match(page, /h\('option', \{ value: 'local' \}, '本地（LongCat）'\)/u)
  // 音色：系统默认 / 上传参考音频 / 桥接内置 / 桥接音色库。
  assert.match(page, /'桥接内置音色（云端 · 小米 MiMo）'/u)
  assert.match(page, /'桥接音色库（本机参考音频）'/u)
  assert.match(page, /const builtinVoiceOptions = Array\.from\(new Set\(\[/u)
  assert.match(page, /const libraryVoiceOptions = bridgeInfo\?\.available/u)
  // 语气：预设提示词可一键选中，也可手输；预设表与 datalist 同源。
  assert.match(source, /const SV_VOICE_STYLE_PRESETS = \[/u)
  assert.match(source, /'清晰沉稳，适合知识讲解。'/u)
  assert.match(page, /list: 'sv-voice-style-presets'/u)
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('option'/u)
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('button'/u)
  // 内置音色 + 本地合成是死路，提交前就要拦住。
  assert.match(page, /const bridgeConflict = bridgeActive && voiceSource === 'builtin' && bridgeChannel === 'local'/u)
  assert.match(page, /桥接内置音色只能搭配云端（小米 MiMo）合成/u)
  // 覆盖参数只在桥接渠道下随请求发出，其他渠道原样忽略。
  assert.match(page, /const bridgeFieldsOf = \(\) => \{/u)
  assert.match(page, /if \(!bridgeActive\) return \{\};/u)
  assert.match(page, /if \(bridgeChannel\) bridge\.channel = bridgeChannel;/u)
  assert.match(page, /if \(bridgeStyle\.trim\(\)\) bridge\.style = bridgeStyle\.trim\(\);/u)
  assert.match(page, /\.\.\.voiceFieldsOf\(\)/u)
  // 重试要重放冻结的桥接覆盖，否则会悄悄回落到桥接全局配置。
  assert.match(page, /\.\.\.\(task\.input\?\.bridge \? \{ bridge: task\.input\.bridge \} : \{\}\)/u)
})

test('audio workbench names the channel endpoint and never blames the voice for an auth failure', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  // 渠道指向哪里必须看得见：本机桥接与远端云端用的是完全不同的 Key。
  assert.match(page, /service\?\.providers\?\.scitiger\?\.loopback \? '本机桥接' : '远端 · SciTiger'/u)
  assert.match(page, /渠道指向本机桥接/u)
  assert.match(page, /请用「启动工作台\.cmd」启动/u)
  assert.match(page, /Invalid API key/u)
  // 任务卡要显示这条用的是云端还是本地合成。
  assert.match(page, /task\.input\?\.bridge\?\.channel === 'cloud' \? '云端合成' : task\.input\?\.bridge\?\.channel === 'local' \? '本地合成' : null/u)
})

test('script drawer opens directly in edit mode and paginates completed history', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ScriptPage(')
  const end = source.indexOf('\n    function AudioCaptionsPage', start)
  const page = source.slice(start, end)

  assert.match(page, /setDrawerMode\('edit'\)/u)
  assert.match(page, /const activeHistoryTasks = history\.filter\(\(item\) => item\.status === 'queued' \|\| item\.status === 'running'\);/u)
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

  // The preset covers source (system / upload / bridge builtin / bridge
  // library), reference audio and rate/volume, and edit mode rehydrates it
  // from the stored task. Defaults and rehydrate helpers live beside
  // emptyScheduleForm, outside the page component.
  assert.match(source, /voiceSource: 'system', voiceReference: null, voiceRate: '1', voiceVolume: '1', bridgeVoice: '冰糖', libraryVoice: '', bridgeChannel: '', bridgeStyle: ''/u)
  assert.match(source, /voiceSource: voice\?\.voiceSource === 'upload' \? 'upload' : voice\?\.voiceSource === 'preset' \? \(presetIsBuiltin \? 'builtin' : 'library'\) : 'system'/u)
  assert.match(source, /bridgeChannel: voice\?\.bridge\?\.channel \|\| ''/u)
  assert.match(page, /voice: voicePayloadOf\(\)/u)
  // Bridge presets both ride voiceSource 'preset' and never pin a provider
  // client-side; the runner follows the saved connection channel.
  assert.match(page, /\{ voiceSource: 'preset', voiceId: form\.bridgeVoice, voiceName: form\.bridgeVoice, rate, volume, \.\.\.bridgeFields \}/u)
  assert.match(page, /\{ voiceSource: 'preset', voiceId: form\.libraryVoice, voiceName: form\.libraryVoice, rate, volume, \.\.\.bridgeFields \}/u)
  assert.doesNotMatch(page, /voicePayloadOf = \(\) => \{[\s\S]{0,600}?provider:/u)
  // Broken preset combinations cannot be saved silently.
  assert.match(page, /&& \(form\.voiceSource !== 'library' \|\| Boolean\(form\.libraryVoice\)\)/u)
  assert.match(page, /&& !\(form\.voiceSource === 'builtin' && form\.bridgeChannel === 'local'\)/u)
  assert.match(page, /请先上传音频文件/u)
  assert.match(page, /桥接内置音色只能搭配云端/u)
  // The bridge settings snapshot rides the page load and feeds the info line.
  assert.match(page, /remote\(packId, 'bridgeVoiceoverInfo'\)/u)
  assert.match(page, /桥接当前：/u)
  // Upload flows through the same shared endpoint as the audio workbench.
  assert.match(page, /remote\(packId, 'uploadVoiceReference', \{ name: file\.name, mediaType: file\.type, data \}\)/u)
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
    assert.match(page, /\['succeeded', 'failed'\]\.includes\(task\.status\) \? h\('button', \{ type: 'button', className: 'lwb-danger-button'/u, `${name} delete button is terminal-only`)
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
  assert.match(page, /remote\(packId, 'uploadVoiceReference', \{ name: file\.name, mediaType: file\.type, data \}\)/u)
  assert.match(page, /上传自己的参考音频/u)
  assert.match(page, /accept: 'audio\/mpeg,audio\/wav/u)
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
  assert.match(page, /remoteStatic\('configureMediaConnection', \{ provider: connectionProvider, apiKey \}\)/u)
  assert.match(page, /remoteStatic\('clearMediaConnectionCredential', \{ provider: connectionProvider \}\)/u)
  assert.doesNotMatch(page, /remote\(packId, '(?:configureMediaConnection|clearMediaConnectionCredential)'/u)
  assert.match(page, /source\?\.projectId \? \{ sourceProjectId: source\.projectId \}/u)
  assert.doesNotMatch(page, /provider: providerId, apiKey,/u)
  assert.match(page, /API Key 保存到 DSH 私有凭据库/u)
  assert.match(source, /function mediaErrorText\(error\)[\s\S]*?SciTiger 账户积分不足，请充值后重试，或切换到百炼 BYOK/u)
  assert.match(source, /function subtitleTaskProgress\(task, now = Date\.now\(\)\)[\s\S]*?实时识别/u)
  assert.match(page, /subtitleProgress = subtitleTaskProgress\(task\)/u)
  assert.match(page, /className: 'sv-audio-subtitle-progress'/u)
  assert.match(page, /'aria-label': '字幕识别进度'/u)
  assert.match(page, /mediaErrorText\(task\.error\)/u)
  assert.match(page, /mediaErrorText\(subtitle\.error\)/u)
  assert.doesNotMatch(page, /sv-list sv-run-list/u)
})

test('audio workbench retries a failed voiceover from its frozen task input', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  assert.match(page, /const retryAudioTask = async \(task\) => \{/u)
  // The retry reuses the frozen manuscript and voice settings rather than
  // asking the person to reselect the script.
  assert.match(page, /text: task\.source\?\.text \|\| ''/u)
  assert.match(page, /voiceSource: task\.input\?\.voiceSource \|\| 'system'/u)
  assert.match(page, /rate: Number\(task\.input\?\.rate \?\? 1\)/u)
  assert.match(page, /volume: Number\(task\.input\?\.volume \?\? 1\)/u)
  assert.match(page, /subtitleEnabled: task\.input\?\.subtitleEnabled === true/u)
  // Only failed tasks with a frozen manuscript can be retried.
  assert.match(page, /task\.status === 'failed' && task\.source\?\.text/u)
  assert.match(page, /title: '重试配音'/u)
  assert.match(page, /onConfirm: \(\) => \{ void retryAudioTask\(task\); \}/u)
})

test('audio workbench exposes the bridge channel, voice and style on the task form', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  // 云端/本地开关按任务覆盖桥接配置，与定时任务表单同名同义。
  assert.match(page, /const \[bridgeChannel, setBridgeChannel\] = React\.useState\(''\)/u)
  assert.match(page, /h\('option', \{ value: '' \}, '跟随桥接配置'\)/u)
  assert.match(page, /h\('option', \{ value: 'cloud' \}, '云端（小米 MiMo）'\)/u)
  assert.match(page, /h\('option', \{ value: 'local' \}, '本地（LongCat）'\)/u)
  // 音色：系统默认 / 上传参考音频 / 桥接内置 / 桥接音色库。
  assert.match(page, /'桥接内置音色（云端 · 小米 MiMo）'/u)
  assert.match(page, /'桥接音色库（本机参考音频）'/u)
  assert.match(page, /const builtinVoiceOptions = Array\.from\(new Set\(\[/u)
  assert.match(page, /const libraryVoiceOptions = bridgeInfo\?\.available/u)
  // 语气：预设提示词可一键选中，也可手输；预设表与 datalist 同源。
  assert.match(source, /const SV_VOICE_STYLE_PRESETS = \[/u)
  assert.match(source, /'清晰沉稳，适合知识讲解。'/u)
  assert.match(page, /list: 'sv-voice-style-presets'/u)
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('option'/u)
  assert.match(page, /SV_VOICE_STYLE_PRESETS\.map\(\(style\) => h\('button'/u)
  // 内置音色 + 本地合成是死路，提交前就要拦住。
  assert.match(page, /const bridgeConflict = bridgeActive && voiceSource === 'builtin' && bridgeChannel === 'local'/u)
  assert.match(page, /桥接内置音色只能搭配云端（小米 MiMo）合成/u)
  // 覆盖参数只在桥接渠道下随请求发出，其他渠道原样忽略。
  assert.match(page, /const bridgeFieldsOf = \(\) => \{/u)
  assert.match(page, /if \(!bridgeActive\) return \{\};/u)
  assert.match(page, /if \(bridgeChannel\) bridge\.channel = bridgeChannel;/u)
  assert.match(page, /if \(bridgeStyle\.trim\(\)\) bridge\.style = bridgeStyle\.trim\(\);/u)
  assert.match(page, /\.\.\.voiceFieldsOf\(\)/u)
  // 重试要重放冻结的桥接覆盖，否则会悄悄回落到桥接全局配置。
  assert.match(page, /\.\.\.\(task\.input\?\.bridge \? \{ bridge: task\.input\.bridge \} : \{\}\)/u)
})

test('audio workbench names the channel endpoint and never blames the voice for an auth failure', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function AudioCaptionsPageV2(')
  const end = source.indexOf('\n    function VideoPreviewPageV2(', start)
  assert.ok(start >= 0 && end > start, 'AudioCaptionsPageV2 must remain a standalone component')
  const page = source.slice(start, end)

  // 渠道指向哪里必须看得见：本机桥接与远端云端用的是完全不同的 Key。
  assert.match(page, /service\?\.providers\?\.scitiger\?\.loopback \? '本机桥接' : '远端 · SciTiger'/u)
  assert.match(page, /渠道指向本机桥接/u)
  assert.match(page, /请用「启动工作台\.cmd」启动/u)
  assert.match(page, /Invalid API key/u)
  // 任务卡要显示这条用的是云端还是本地合成。
  assert.match(page, /task\.input\?\.bridge\?\.channel === 'cloud' \? '云端合成' : task\.input\?\.bridge\?\.channel === 'local' \? '本地合成' : null/u)
})

test('script drawer opens directly in edit mode and paginates completed history', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function ScriptPage(')
  const end = source.indexOf('\n    function AudioCaptionsPage', start)
  const page = source.slice(start, end)

  assert.match(page, /setDrawerMode\('edit'\)/u)
  assert.match(page, /const activeHistoryTasks = history\.filter\(\(item\) => item\.status === 'queued' \|\| item\.status === 'running'\);/u)
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

  // The preset covers source (system / upload / bridge builtin / bridge
  // library), reference audio and rate/volume, and edit mode rehydrates it
  // from the stored task. Defaults and rehydrate helpers live beside
  // emptyScheduleForm, outside the page component.
  assert.match(source, /voiceSource: 'system', voiceReference: null, voiceRate: '1', voiceVolume: '1', bridgeVoice: '冰糖', libraryVoice: '', bridgeChannel: '', bridgeStyle: ''/u)
  assert.match(source, /voiceSource: voice\?\.voiceSource === 'upload' \? 'upload' : voice\?\.voiceSource === 'preset' \? \(presetIsBuiltin \? 'builtin' : 'library'\) : 'system'/u)
  assert.match(source, /bridgeChannel: voice\?\.bridge\?\.channel \|\| ''/u)
  assert.match(page, /voice: voicePayloadOf\(\)/u)
  // Bridge presets both ride voiceSource 'preset' and never pin a provider
  // client-side; the runner follows the saved connection channel.
  assert.match(page, /\{ voiceSource: 'preset', voiceId: form\.bridgeVoice, voiceName: form\.bridgeVoice, rate, volume, \.\.\.bridgeFields \}/u)
  assert.match(page, /\{ voiceSource: 'preset', voiceId: form\.libraryVoice, voiceName: form\.libraryVoice, rate, volume, \.\.\.bridgeFields \}/u)
  assert.doesNotMatch(page, /voicePayloadOf = \(\) => \{[\s\S]{0,600}?provider:/u)
  // Broken preset combinations cannot be saved silently.
  assert.match(page, /&& \(form\.voiceSource !== 'library' \|\| Boolean\(form\.libraryVoice\)\)/u)
  assert.match(page, /&& !\(form\.voiceSource === 'builtin' && form\.bridgeChannel === 'local'\)/u)
  assert.match(page, /请先上传音频文件/u)
  assert.match(page, /桥接内置音色只能搭配云端/u)
  // The bridge settings snapshot rides the page load and feeds the info line.
  assert.match(page, /remote\(packId, 'bridgeVoiceoverInfo'\)/u)
  assert.match(page, /桥接当前：/u)
  // Upload flows through the same shared endpoint as the audio workbench.
  assert.match(page, /remote\(packId, 'uploadVoiceReference', \{ name: file\.name, mediaType: file\.type, data \}\)/u)
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
    assert.match(page, /\['succeeded', 'failed'\]\.includes\(task\.status\) \? h\('button', \{ type: 'button', className: 'lwb-danger-button'/u, `${name} delete button is terminal-only`)
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
  const page = source.slice(start, start + 4000)

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
