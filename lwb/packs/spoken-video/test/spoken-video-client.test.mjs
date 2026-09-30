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
