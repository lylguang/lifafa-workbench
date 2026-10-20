import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/*
 * 配音链路的静态守卫。
 *
 * 覆盖用户拍板的四件事：渠道白名单只有 mimo、三种合成模式互斥、
 * 历史任务的旧渠道名如实保留、以及面板/常量表的具体形状。
 *
 * 这里只做静态断言（源码形状 + 可导出的纯常量）。
 * **验不了的**——真实主题下的对比度、窄窗布局、Tab 顺序——仍需真浏览器走查。
 *
 * 需求反转变更记录：声音复刻（参考音频上传）原先按「退役」处理，本文件曾断言
 * `doesNotMatch(/uploadVoiceReference/)` 与 DOM 里不许出现上传入口。用户后来
 * 明确要求把克隆加回来（预置音色 / 音色设计 / 声音克隆 三模式切换），那几条
 * 断言已**改为正向断言**（入口存在、格式校验拦得住非 wav/mp3、模式互斥），
 * 不是被删掉——「复刻不可用」不再是需求，守卫方向因此反转。
 */

const clientPath = new URL('../client.js', import.meta.url)

async function loadSource() {
  return readFile(clientPath, 'utf8')
}

async function loadVoiceConstants() {
  const source = await loadSource()
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { sandbox.exports = factory((name) => {
      if (name === 'react') return { createElement: () => null }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconSettingsOutline16: () => null, MarkdownText: () => null }
      throw new Error(`未预期的依赖：${name}`)
    }) } } },
    document: { getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {} }), head: { appendChild() {} } },
    setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return sandbox.exports.__voice
}

test('渠道白名单只有小米 MiMo 一个，且 provider 固定为 mimo', async () => {
  const { SV_VOICE_PROVIDER, SV_VOICE_PROVIDERS, SV_VOICE_PROVIDER_LABEL } = await loadVoiceConstants()
  assert.equal(SV_VOICE_PROVIDER, 'mimo')
  assert.deepEqual([...SV_VOICE_PROVIDERS], ['mimo'])
  // 退役渠道不得再出现在白名单里——它们只是从 UI 隐藏，代码里保留。
  for (const retired of ['bailian', 'scitiger', 'custom']) {
    assert.equal(SV_VOICE_PROVIDERS.includes(retired), false, `${retired} 不应再是可见渠道`)
  }
  assert.equal(SV_VOICE_PROVIDER_LABEL.mimo, '小米 MiMo')
})

test('四处选择器共用同一个白名单常量，没有各写一份 id 数组', async () => {
  const source = await loadSource()
  // provider 选择器的 ARIA 标签各有四处，它们都必须遍历 SV_VOICE_PROVIDERS。
  const pickers = [...source.matchAll(/sv-media-provider-picker'[^)]*?'aria-label': '([^']+)'/gu)].map((match) => match[1])
  assert.ok(pickers.includes('生成方式'), '项目页连接抽屉的生成方式选择器')
  assert.ok(pickers.includes('连接提供方'), '配音页连接抽屉的选择器')
  assert.ok(pickers.includes('配音服务'), '配音页渠道条')
  // 三个配音选择器各自遍历白名单常量，不各写一份 id 数组。
  // 范围从「项目页（LegacyAudioCaptionsPageV2，配音/字幕的项目视图）」到发布页之前：
  // 发布页的「生图渠道」是另一条链路（bailian/scitiger/custom），本轮不动它。
  const voicePages = source.slice(source.indexOf('function LegacyAudioCaptionsPageV2'), source.indexOf('function PublishPageV4'))
  const pickerLines = voicePages.split('\n').filter((line) => line.includes('sv-media-provider-picker'))
  assert.equal(pickerLines.length, 3, '配音域应只剩三个选择器')
  // 有两个选择器把 .map 放在下一行（为了塞进一行格式化），所以跨行匹配。
  for (const line of pickerLines) {
    const head = line.slice(0, 400)
    assert.match(head, /'aria-label': '([^']+)'/u)
    const label = head.match(/'aria-label': '([^']+)'/u)[1]
    assert.doesNotMatch(head, /bailian|scitiger|custom/u, `选择器「${label}」不得再出现退役渠道 id`)
  }
  // 三个选择器的按钮来源统一是白名单常量。
  assert.equal([...voicePages.matchAll(/SV_VOICE_PROVIDERS\.map/gu)].length, 3)
})

test('provider 一律取白名单常量，不再从后端 connection.provider 兜底', async () => {
  const source = await loadSource()
  // 两处 providerId 都必须直接等于常量，不能有 `|| 'bailian'` 这种旧兜底。
  const ids = [...source.matchAll(/const providerId = ([^;]+);/gu)].map((match) => match[1].trim())
  assert.ok(ids.length >= 2, '项目页与配音页各一处')
  for (const expr of ids) assert.equal(expr, 'SV_VOICE_PROVIDER', `providerId 不应是表达式：${expr}`)
  // 起配音的两个调用都必须显式带 provider。
  assert.match(source, /startVoiceover', \{[^\n]*provider: providerId/u)
  assert.match(source, /startAudioTask', \{[^\n]*provider: providerId/u)
})

test('声音克隆（参考音频上传）入口已回到 UI，且上传前拦掉非 wav/mp3', async () => {
  const source = await loadSource()
  const { SV_CLONE_EXTENSIONS, SV_CLONE_ACCEPT, svVoiceReferenceError } = await loadVoiceConstants()

  // 需求反转：克隆回来了，入口必须真的在 DOM 里。
  assert.match(source, /uploadVoiceReference/u, '配音页与排期页都要有上传调用')
  assert.equal([...source.matchAll(/remoteStatic\('uploadVoiceReference'/gu)].length, 2, '配音页与排期页各一处')
  assert.match(source, /type: 'file', accept: SV_CLONE_ACCEPT/u, '上传控件走这份白名单')
  assert.doesNotMatch(source, /VoiceLibraryPanel/u, '音色库面板仍不该回来')

  // 官方只认 wav/mp3。
  assert.deepEqual([...SV_CLONE_EXTENSIONS], ['wav', 'mp3'])
  // 老坑：m4a/aac 直接送上去只回一个笼统的「合成失败」，重试几次还会 429 把真因盖掉。
  // 所以必须在**上传之前**拦住并说清要转码。
  assert.ok(svVoiceReferenceError({ name: 'voice.m4a', type: 'audio/mp4', size: 1024 }), 'm4a 必须被拦')
  assert.ok(svVoiceReferenceError({ name: 'voice.aac', type: 'audio/aac', size: 1024 }), 'aac 必须被拦')
  assert.ok(svVoiceReferenceError({ name: 'voice.m4a', type: 'audio/mp4', size: 1024 }).includes('wav'), '要告诉用户转成 wav')
  assert.equal(svVoiceReferenceError({ name: 'voice.wav', type: 'audio/wav', size: 1024 }), null)
  assert.equal(svVoiceReferenceError({ name: 'voice.mp3', type: 'audio/mpeg', size: 1024 }), null)
  // 空文件与 0 字节也要拦，那是另一个失败原因，不该混进「格式不支持」。
  assert.ok(svVoiceReferenceError({ name: 'voice.wav', type: 'audio/wav', size: 0 }), '0 字节必须被拦')
  assert.ok(svVoiceReferenceError(null), '没选文件必须被拦')
})

test('三种合成模式互斥：只发当前模式那一套字段，不混传', async () => {
  const source = await loadSource()
  const { SV_VOICE_MODES, SV_SINGING_MODES } = await loadVoiceConstants()
  assert.deepEqual([...SV_VOICE_MODES.map((mode) => mode.id)], ['preset', 'design', 'upload'])
  // 唱歌只挂在预置音色模型上，另两个会直接 400，所以唱歌组仅在 preset 渲染。
  assert.deepEqual([...SV_SINGING_MODES], ['preset'])

  // 两处 payload（配音页的 create/retry 共用 voiceFieldsOf，排期页的 voicePayloadOf）
  // 都必须按模式分叉：design 不带 voiceId，upload 只带参考音频。
  const payloadBranches = [...source.matchAll(/voiceSource === 'design'/gu)].length
  assert.ok(payloadBranches >= 2, '配音页与排期页各一处按模式分叉')
  assert.match(source, /if \(voiceSource === 'design'\) return \{ voiceSource: 'design', \.\.\.tone, \.\.\.tags, designText: voiceDesignText\.trim\(\) \}/u)
  assert.match(source, /if \(voiceSource === 'upload'\) return \{ voiceSource: 'upload', \.\.\.tone, \.\.\.tags, referenceAudio: voiceReference \}/u)
  // 重试必须重放这条任务**当初冻结**的模式，不能拿当前表单的模式：
  // 中途把表单从 preset 改成 design 再点重试，同一条任务会换一个声音。
  assert.match(source, /voiceSource: \['design', 'upload'\]\.includes\(task\.input\?\.voiceSource\) \? task\.input\.voiceSource : 'preset'/u)
  assert.match(source, /\.\.\.\(task\.input\?\.designText \? \{ designText: task\.input\.designText \} : \{\}\)/u)
  assert.match(source, /\.\.\.\(task\.input\?\.referenceAudio \? \{ referenceAudio: task\.input\.referenceAudio \} : \{\}\)/u)
  assert.doesNotMatch(source, /voiceSource: 'preset', voiceId: task\.input/u, '重试不该把模式钉死成 preset')
  // design 分支不得夹带音色名：带了后端会判成混用并报错。
  const designBranch = source.slice(source.indexOf("if (voiceSource === 'design') return"), source.indexOf("if (voiceSource === 'upload') return"))
  assert.doesNotMatch(designBranch, /voiceId/u, 'design 模式不得夹带预置音色名')
  // 模式文案必须说清互斥，否则用户会以为三个可以叠着填。
  for (const mode of SV_VOICE_MODES) assert.ok(mode.hint && mode.label, `${mode.id} 缺文案`)
})

test('预置音色扩到官方 9 个，每个都有性格说明，且不把 mimo_default 当默认', async () => {
  const { SV_MIMO_BUILTIN_VOICES, SV_MIMO_VOICE_HINTS, SV_MIMO_VOICE_GROUPS, SV_MIMO_DEFAULT_VOICE, svDefaultVoice } = await loadVoiceConstants()
  // 顺序必须与后端 MIMO_VOICES 逐字一致（后端会拿这张表 deepEqual 对齐）。
  assert.deepEqual([...SV_MIMO_BUILTIN_VOICES], ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])
  // 九个音色都要有说明：只写一半等于让用户一个个试。
  for (const voice of SV_MIMO_BUILTIN_VOICES) {
    assert.ok(SV_MIMO_VOICE_HINTS[voice], `音色 ${voice} 缺性格说明`)
    assert.ok(String(SV_MIMO_VOICE_HINTS[voice]).length >= 8, `音色 ${voice} 的说明太短，等于没写`)
  }
  // mimo_default 的说明必须点出集群差异，否则用户默认选它就会静默换一个声音。
  assert.match(SV_MIMO_VOICE_HINTS.mimo_default, /集群/u)
  // 中英文必须分组，否则 9 个音名平铺一列会让人以为英文音是中文音的翻译版。
  assert.deepEqual([...SV_MIMO_VOICE_GROUPS.map((group) => group.label)], ['中文音色', '英文音色', '平台默认（随集群不同）'])
  assert.deepEqual([...SV_MIMO_VOICE_GROUPS[1].voices], ['Mia', 'Chloe', 'Milo', 'Dean'])
  // mimo_default 有集群差异（中国→冰糖，其他→Mia），当默认音色等于没定。
  assert.notEqual(SV_MIMO_DEFAULT_VOICE, 'mimo_default')
  // 但也不能硬编码「永远是冰糖」把运维配的 defaultVoice 整个忽略——
  // 配置要生效，只有配成 mimo_default 时才退到冰糖。
  assert.equal(svDefaultVoice({ mimoDefaultVoice: '白桦' }), '白桦', '运维配的默认音色必须生效')
  assert.equal(svDefaultVoice({ mimoDefaultVoice: 'mimo_default' }), SV_MIMO_DEFAULT_VOICE, '配成 mimo_default 时退到冰糖')
  assert.equal(svDefaultVoice(null), SV_MIMO_DEFAULT_VOICE)
  // mediaStatus 的 defaultVoice 是音色档案对象而不是字符串，直接 String() 会得到
  // 「[object Object]」并被当成音名传下去——这里必须不认它。
  assert.equal(svDefaultVoice({ defaultVoice: { id: 'x', name: '冰糖' } }), SV_MIMO_DEFAULT_VOICE)
})

test('音频标签两套语法分工：开头风格走入参，句中方括号写入正文，合并限 8', async () => {
  const { SV_AUDIO_TAG_GROUPS, SV_AUDIO_TAG_MAX_COUNT, SV_AUDIO_TAG_MAX_LENGTH, svAudioTagSlots, svAudioTagNames, svAudioTagError, svInsertAudioTag } = await loadVoiceConstants()
  // 每组必须标明归属：'param' 只进 audioTags 入参，'square' 插进正文光标处。
  for (const group of SV_AUDIO_TAG_GROUPS) assert.ok(['param', 'square'].includes(group.bracket), `${group.label} 未标明归属`)
  // 唱歌必须走 param（官方 `(唱歌)歌词` 由后端拼），且只在预置音色模式可用。
  const singing = SV_AUDIO_TAG_GROUPS.find((group) => group.label === '唱歌')
  assert.equal(singing.bracket, 'param')
  assert.equal(singing.presetOnly, true)
  // 细粒度那批必须可点击插入（不能逼用户手写——手写就绕过了计数）。
  const fine = SV_AUDIO_TAG_GROUPS.find((group) => group.label === '细粒度')
  assert.equal(fine.bracket, 'square')
  for (const tag of ['叹气', '哽咽', '深吸气', '提高音量']) assert.ok(fine.tags.includes(tag), `细粒度组缺少 ${tag}`)
  assert.equal(SV_AUDIO_TAG_MAX_COUNT, 8)
  assert.equal(SV_AUDIO_TAG_MAX_LENGTH, 40)

  // 计数与后端 countInlineAudioTags 同口径：数方括号起始符，全角也算；
  // 圆括号组**不占**正文配额（开头风格由入参承载）。
  assert.equal(svAudioTagSlots('正文').used, 0)
  assert.equal(svAudioTagSlots('[叹气]正文').used, 1)
  assert.equal(svAudioTagSlots('[叹气][哽咽]正文').used, 2)
  assert.equal(svAudioTagSlots('［叹气］正文').used, 1, '全角方括号也要计数')
  assert.equal(svAudioTagSlots('(唱歌)歌词').used, 0, '圆括号风格不占正文配额')
  // 收紧后的边界（2026-10-20 Chief 裁决）：成对且 ≤40 字才算标签。
  // 不成对的只有 '[' 没有 ']' —— 原样当普通文本放行，**不算标签**。
  // 理由：口播稿里写 [1] 引用来源是真实场景，让正常文案占配额、
  // 改稿时突然被拒而用户不知道为什么，比漏算一个标签糟得多。
  assert.equal(svAudioTagSlots('见[参考文献] 说明').used, 1, '成对且内容合法，算标签')
  assert.equal(svAudioTagSlots('见[1 参考文献]说明').used, 1, '成对且内容合法，算标签')
  assert.equal(svAudioTagSlots('见 [1] 与 [2] 的说法').used, 0, '纯数字引用不算标签（Chief 裁决 A）')
  assert.equal(svAudioTagSlots('只有左括号[').used, 0)
  assert.equal(svAudioTagSlots('只有全角［').used, 0)
  assert.equal(svAudioTagSlots('缺右括号 [叹气').used, 0, '不成对的不算标签')
  // 纯数字引用按文献编号处理，不占配额（2026-10-20 Chief 裁决 A，与后端
  // countInlineAudioTags 同口径）。钉这一条的同时钉住已否决的方案不会复活：
  // 「[1] 算标签」曾以「形状相同、无法区分」为由被实现过。
  assert.equal(svAudioTagSlots('见[1]。').used, 0, '纯数字引用不占配额')
  assert.equal(svAudioTagSlots('见 ［12］。').used, 0, '全角纯数字同样不算')
  // 写够 9 处参考文献不再被拒——这正是裁决 A 要消灭的那个必然发生的误伤。
  assert.equal(svAudioTagSlots('[1][2][3][4][5][6][7][8][9][10]').used, 0, '9 处以上文献引用不得占满配额')
  assert.equal(svAudioTagSlots('[1][叹气]').used, 1, '引用与真标签混排时只数真标签')
  // 超限提示不再教用户删参考文献——引用本来就不占名额，这句话会误导。
  assert.doesNotMatch(svAudioTagError('[a][b][c][d][e][f][g]', '新标签', ['风格']), /文献编号/u)
  // 成对但内容超 40 字：不算标签（原样放行，不占配额）。
  assert.equal(svAudioTagSlots(`[${'长'.repeat(41)}]`).used, 0, '超 40 字不算标签')
  assert.equal(svAudioTagSlots(`[${'长'.repeat(40)}]`).used, 1, '恰好 40 字仍算标签')
  // 内容为空、或内部还带括号：都不算。
  assert.equal(svAudioTagSlots('[]').used, 0)
  assert.equal(svAudioTagSlots('[a[b]]').used, 0, '内层再带方括号不算标签')
  assert.deepEqual([...svAudioTagNames('(唱歌)[叹气]')], ['唱歌', '叹气'])

  // 合并计数：正文内插 + 入参风格 一起 ≤8。两类分别算都会让用户提交后才吃 400。
  assert.equal(svAudioTagError('[a][b][c][d][e][f][g]', '新标签', []), null, '第 8 个仍可插')
  assert.ok(svAudioTagError('[a][b][c][d][e][f][g]', '新标签', ['风格']), '正文 7 + 入参 1 已满')
  assert.ok(svAudioTagError('[a][b]', '新标签', ['s1', 's2', 's3', 's4', 's5', 's6']), '正文 2 + 入参 6 已满')
  assert.equal(svAudioTagError('[a]', '新标签', ['s1', 's2', 's3', 's4', 's5', 's6']), null, '合计 7 仍可插')
  // 只剥最外层括号（与后端 normalizeAudioTags 同序），内层还带括号要拦。
  assert.equal(svAudioTagError('', '[开心]'), null, '外面一对括号应当被剥掉')
  assert.ok(svAudioTagError('', ''), '空标签要拦')
  assert.ok(svAudioTagError('', '[]'), '剥完是空的要拦')
  assert.ok(svAudioTagError('', 'x'.repeat(41)), '超长要拦')
  assert.ok(svAudioTagError('', 'a[b]'), '标签内含方括号要拦')
  assert.ok(svAudioTagError('(开心)', '开心'), '重复要拦')
  assert.ok(svAudioTagError('', '开心', ['开心']), '入参里重复也要拦')

  // 插入只产生方括号标签：**绝不把 (风格) 写进正文**，
  // 否则会被 countInlineAudioTags 当用户内容计数，且下次生成时跟着稿子累积。
  const fake = (value, caret) => ({ value, selectionStart: caret })
  let next = null
  svInsertAudioTag(fake('前后', 1), '叹气', (value) => { next = value })
  assert.equal(next, '前[叹气]后')
  // 光标落在已有方括号标签**内部**时续写，不插出嵌套。
  // 'a[叹气]b' 的标签跨度是 [1,5)。caret=2 在 '[' 之后（内部）；caret=5 在 ']' 之后。
  svInsertAudioTag(fake('a[叹气]b', 2), '哽咽', (value) => { next = value })
  assert.equal(next, 'a[哽咽叹气]b', '不得产生 [哽咽[叹气]] 这种嵌套')
  svInsertAudioTag(fake('a[叹气]b', 5), '哽咽', (value) => { next = value })
  assert.equal(next, 'a[叹气][哽咽]b', '光标在标签之后时应新开一个标签')
})

test('整体风格标签只进 audioTags 入参，不被拼进正文', async () => {
  const source = await loadSource()
  // 入参分支：三个模式都带上 audioTags。
  assert.match(source, /const tags = audioTagParams\.length \? \{ audioTags: audioTagParams \} : \{\}/u)
  assert.match(source, /return \{ voiceSource: 'preset', voiceId, voiceName: voiceId, \.\.\.tone, \.\.\.tags \}/u)
  // 插入函数只认方括号：没有任何一处往正文里拼 (风格)。
  const insert = source.slice(source.indexOf('function svInsertAudioTag'), source.indexOf('\n    }', source.indexOf('function svInsertAudioTag')))
  assert.doesNotMatch(insert, /`\(\$\{tag\}\)/u, '开头风格由后端 buildTaggedText 拼，前端不得写进正文')
  assert.match(insert, /\[`?\$\{tag\}\]?\]/u)
  // 重试重放任务当初冻结的 audioTags，而不是当前表单值。
  assert.match(source, /Array\.isArray\(task\.input\?\.audioTags\) && task\.input\.audioTags\.length \? \{ audioTags: task\.input\.audioTags \}/u)
})

test('LegacyAudioCaptionsPageV2 是未注册的历史视图，只能当测试切片锚点保留', async () => {
  const source = await loadSource()
  // 注册表里挂的是 AudioCaptionsPageV2，不是 Legacy。
  const register = source.slice(source.lastIndexOf('lwbPackClient.register('))
  assert.match(register, /'audio-captions': AudioCaptionsPageV2/u)
  assert.doesNotMatch(register, /LegacyAudioCaptionsPageV2/u, 'Legacy 不该被注册')
  // 它必须留在文件里：三处测试拿它当「项目页」范围的切片终点，删了 indexOf
  // 会返回 -1 而误圈整段文件，把无关源码纳入切片、让断言失去意义。
  assert.ok(source.indexOf('\n    function LegacyAudioCaptionsPageV2(') > 0, '切片锚点必须还在')
  // 所以这里写清「为什么不接新功能」，免得后人再当成漏做而顺手删掉。
  const doc = source.slice(source.indexOf('未注册的历史项目视图'), source.indexOf('function LegacyAudioCaptionsPageV2'))
  assert.match(doc, /新配音流程一律走/u)
  assert.match(doc, /切片锚点/u)
  // 三模式只做在真正跑起来的那一页；Legacy 里不该出现新模式的专属字段。
  const legacy = source.slice(source.indexOf('function LegacyAudioCaptionsPageV2'), source.indexOf('\n    function AudioCaptionsPageV2('))
  assert.doesNotMatch(legacy, /voiceSource: 'design'|referenceAudio/u, '接了也不会被执行到，还会让守卫出现两个来源')
})

test('语气预设仍是一组完整的可选语气词（与三模式正交）', async () => {
  const { SV_VOICE_STYLE_PRESETS } = await loadVoiceConstants()
  assert.ok(SV_VOICE_STYLE_PRESETS.length >= 4)
  assert.match(SV_VOICE_STYLE_PRESETS[0], /。$/u, '语气预设是完整句子，去掉尾句号后作为 chip 显示')
})

test('历史任务的旧渠道名文案保留原样，老记录如实显示', async () => {
  const source = await loadSource()
  // 白名单重构后文案来源从三元改成查表助手，但**语义不能变**：老任务的
  // provider 值要照实回显，不能被静默改写成 mimo。
  const start = source.indexOf('const SV_RETIRED_PROVIDER_LABEL')
  const end = source.indexOf('const SV_MIMO_BUILTIN_VOICES')
  assert.ok(start > 0 && end > start, '退役渠道的文案表与标签助手必须还在')
  const labelBlock = source.slice(start, end)

  // 退役渠道各有一份中文名；scitiger 经本机桥接时另有一个说法。
  assert.match(labelBlock, /bailian: '百炼 BYOK'/u)
  assert.match(labelBlock, /scitiger: '远端 · SciTiger'/u)
  assert.match(labelBlock, /legacy: '兼容 TTS'/u)
  assert.match(labelBlock, /value === 'scitiger' && loopback\) return '本机桥接'/u)
  // 先查当前渠道表、再查退役表，最后回落到原始 id：新渠道不必改这里。
  assert.match(labelBlock, /SV_VOICE_PROVIDER_LABEL\[value\] \|\| SV_RETIRED_PROVIDER_LABEL\[value\] \|\| value/u)

  // 两处历史任务标签都必须走这个助手，不能又写回三元或直接显示 provider id。
  const taskLabels = [...source.matchAll(/voiceProviderLabel\(task\.input\?\.provider/g)].length
  assert.equal(taskLabels, 2, '项目页与配音页的任务标签各一处')
  assert.doesNotMatch(source, /task\.input\?\.provider === 'bailian'/u, '文案不应再是内联三元')
  assert.doesNotMatch(source, /task\.input\?\.provider === 'scitiger'/u)
})

test('凭据被服务端拒绝时界面单独提示，不能只显示「合成失败」', async () => {
  const source = await loadSource()
  // 后端 connection().providers.mimo.credentialHint 提供 missing | rejected | ok；
  // 前端必须消费它。漏掉的后果：填错 Key 与「没填」在 UI 上长得一样。
  assert.match(source, /selectedProvider\?\.credentialHint \|\| 'ok'/u)
  // 两处页面各有一条：状态条与配音页的渠道控制区。
  const rejectedHints = [...source.matchAll(/credentialHint === 'rejected'/gu)].length
  assert.ok(rejectedHints >= 2, '项目页与配音页都要消费 rejected 态')
  assert.match(source, /'Key 被拒绝，请重新填写'/u)
  assert.match(source, /拒绝了当前 API Key，请在右上角「连接配置」中重新填写/u)
  // 只有 401/403 判 rejected：限流与参数错误不能误导用户去换 Key。
  assert.doesNotMatch(source, /credentialHint === 'quota'/u)
})

test('零新增第三方依赖，且删除面板后没有留下引用死符号', async () => {
  const source = await loadSource()
  const requires = [...source.matchAll(/require\('([^']+)'\)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)].filter((name) => name !== '@deepseek-ai/dsh-client-ui-primitives'), ['react'])
  // 三面板删除后，专属状态与 handler 必须一起走干净。
  for (const dead of ['bridgeInfo', 'voiceUploading', 'scheduleVoiceFileInputRef', 'bridgeVoiceReady', 'bridgeConflict', 'libraryVoiceOptions', 'bridgeFieldsOf']) {
    assert.doesNotMatch(source, new RegExp(dead, 'u'), `${dead} 应随面板一起移除`)
  }
})
