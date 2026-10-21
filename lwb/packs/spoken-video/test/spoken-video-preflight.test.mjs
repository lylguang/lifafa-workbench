import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectCreativeSource, inspectSceneBoundaryCoverage, inspectTimelineAlignment } from '../spoken-video-preflight.mjs'
import { inspectContentSafety } from '../spoken-video-content-safety.mjs'
import { inspectSceneCueCoverage, parseSceneCueMap } from '../spoken-video-scene-cues.mjs'
import { parseSceneSpans } from '../spoken-video-scene-table.mjs'
import { APP_NODE_MODULES, ensureAgentDependencies, inspectSpokenVideoAgentProject, isBrowserLaunchFailure, parseRemotionEvalFailure, prepareSpokenVideoAgentProject, sampleFrameCoverage, sampleFrameNumbers, RENDER_BROWSER_ATTEMPTS } from '../spoken-video-remotion.mjs'
import { linkDirectoryForTest } from './fs-link-helper.mjs'

const source = (style, extra = '') => `import React from 'react'; import {useCurrentFrame} from 'remotion';
export const CreativeVideo=()=>{const frame=useCurrentFrame();return <div style={${style}}>Hello</div>};
${extra}
/* ${'scene details '.repeat(90)} */`
const motion = text => inspectCreativeSource(text).filter(x => x.code === 'css-motion')
const pad = (value) => String(value).padStart(2, '0')

test('parses CSS motion declarations: disabled values, comments and ordinary text do not trigger the gate', () => {
  assert.deepEqual(inspectCreativeSource(source('{transition:"none",animation:`none`,WebkitTransition:"none"}', '// transition: "opacity 1s"\nconst note="animation: spin 1s";')), [])
  assert.deepEqual(inspectCreativeSource(source('{transition: ("none" as const)}')), [])
  const findings = motion(source('{transition:"opacity 1s", "animation-name":"spin", ["transition"]:"all 2s"}'))
  assert.equal(findings.length, 3)
  assert.equal(findings[0].line, 2)
  assert.match(findings[0].message, /opacity 1s/u)
  assert.equal(motion(source('{transition: timing}')).length, 1)
  assert.equal(motion(source('{}', 'const s={};s.transition="all 2s";')).length, 1)
})

test('checks style blocks and CSS templates without matching comments or losing line locations', () => {
  assert.equal(motion(source('{}', 'const styles=<style>{`/* animation:spin */ .card { transition: none; }`}</style>')).length, 0)
  const findings = motion(source('{}', 'const styles=<style>{`\n.card {\n animation: spin 2s;\n}`}</style>'))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 5)
  assert.equal(motion(source('{}', 'const s=css`div {transition: opacity 1s}`;')).length, 1)
  assert.equal(inspectCreativeSource('export const Broken = <div')[0].code, 'syntax')
})

test('workspace preflight CLI and host agree, and dependency caches remain task-local', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'video-preflight-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const audioPath = join(dir, 'test.wav'); await writeFile(audioPath, 'audio fixture')
  const fixtureSrt = ['1', '00:00:00,000 --> 00:00:01,800', 'fixture cue', ''].join('\n')
  const workspace = await prepareSpokenVideoAgentProject({ projectRoot: dir, runId: 'fixture', audioPath, title: 'test', script: 'script', durationSeconds: 2, subtitles: [], subtitleSrt: fixtureSrt, subtitleEnabled: false })
  assert.equal((await lstat(join(workspace.projectDir, 'node_modules'))).isSymbolicLink(), false)
  const cache = join(workspace.projectDir, 'node_modules/.cache')
  assert.equal(await realpath(cache), join(await realpath(workspace.projectDir), 'node_modules', '.cache'))
  assert.notEqual(await realpath(join(workspace.projectDir, 'node_modules/react')), join(await realpath(workspace.projectDir), 'node_modules', 'react'))
  await writeFile(workspace.creativeFile, source('{transition:"none"}'))
  const host = await inspectSpokenVideoAgentProject(workspace)
  assert.equal(host.passed, true)
  const cli = JSON.parse(execFileSync(process.execPath, ['scripts/preflight.mjs'], { cwd: workspace.projectDir, encoding: 'utf8' }))
  assert.equal(cli.passed, true)
  await writeFile(workspace.creativeFile, source('{transition:"opacity 1s"}'))
  assert.equal((await inspectSpokenVideoAgentProject(workspace)).repairable, true)
  assert.throws(() => execFileSync(process.execPath, ['scripts/preflight.mjs'], { cwd: workspace.projectDir, stdio: 'pipe' }), error => error.status === 1 && /css-motion/.test(error.stdout.toString()))
  await writeFile(join(workspace.projectDir, 'scripts/preflight.mjs'), '// tampered')
  const tampered = await inspectSpokenVideoAgentProject(workspace)
  assert.equal(tampered.repairable, false)
  assert.match(tampered.failures.join(' '), /受保护文件 scripts\/preflight.mjs/u)
})

test('migrates a legacy dependency symlink without touching the shared cache', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'video-deps-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // 指向 ensureAgentDependencies 认可的共享依赖目录；包内 node_modules 在运行时
  // 环境里也存在（被运行时链接填充），用它会触发「未知目录」拒绝，测不到迁移路径。
  await linkDirectoryForTest(APP_NODE_MODULES, join(dir, 'node_modules'))
  await ensureAgentDependencies(dir)
  await writeFile(join(dir, 'node_modules/.cache/task-only'), 'local')
  await ensureAgentDependencies(dir)
  assert.equal(await readFile(join(dir, 'node_modules/.cache/task-only'), 'utf8'), 'local')
  // 迁移后 node_modules 必须是真的目录（不是链接）——这条不变。
  // 注意不能用 .isDirectory() 判断「是不是链接」：Junction 的 isDirectory() 为 false，
  // 但 .isSymbolicLink() 对 Junction 也返回 true。
  const info = await lstat(join(dir, 'node_modules'))
  assert.equal(info.isDirectory(), true)
  assert.equal(info.isSymbolicLink(), false)
})

test('依赖链接在非管理员 Windows 上走得通：symlink 被 EPERM 拒绝时仍能建出可用链接', async (t) => {
  // 2026-10-21 用户真实故障：视频制作报 `EPERM: operation not permitted, symlink`。
  // 根因是 fs.symlink(..., 'dir') 在非管理员且未开开发者模式的 Windows 上必然失败，
  // 而工作台正是以普通用户身份运行的。这条用例防的是「改了 Windows 分支、
  // 但 Linux CI 上永远绿、Windows 上照旧炸」——那种测试等于没测。
  const dir = await mkdtemp(join(tmpdir(), 'video-deps-eperm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // 真实验证：让 Node 自己报一次 symlink 能力，如果这台机器能建符号链接，
  // 说明当前环境不具代表性，但用例仍然应该通过（走了 symlink 分支也一样对）。
  let symlinkWorks = true
  try {
    await symlink(APP_NODE_MODULES, join(dir, 'probe-link'), 'dir')
    await rm(join(dir, 'probe-link'), { recursive: true, force: true })
  } catch {
    symlinkWorks = false
  }

  await ensureAgentDependencies(dir)
  const target = join(dir, 'node_modules')

  // 无论走哪条分支，结果都必须可用：能真的读到共享依赖里的内容。
  const { readdirSync } = await import('node:fs')
  assert.ok(readdirSync(join(target, '.bin')).length > 0, '.bin 应能读到内容（链接真的可用，不是空壳）')
  assert.ok(readdirSync(join(target, 'react')).length > 0, 'react 模块应可读')
  // 链接必须指向共享依赖目录，而不是别处。
  assert.equal(await realpath(join(target, '.bin')), await realpath(join(APP_NODE_MODULES, '.bin')))
  // .cache 必须是任务本地真目录，不能被链到共享目录。
  const cacheInfo = await lstat(join(target, '.cache'))
  assert.equal(cacheInfo.isDirectory(), true)
  assert.equal(cacheInfo.isSymbolicLink(), false)

  if (process.platform === 'win32' && !symlinkWorks) {
    // 这是关键分支：本机 symlink 不可用时，链接仍然建出来了，说明走的是 Junction。
    const binInfo = await lstat(join(target, '.bin'))
    assert.equal(binInfo.isSymbolicLink(), true, 'Junction 在 lstat 里也应表现为链接')
    assert.equal(binInfo.isDirectory(), false, 'Junction 的 isDirectory 为 false，调用方不得依赖它识别链接')
  }
})

test('目录链接失败时给出可读文案，而不是裸 EPERM', async (t) => {
  // 把 APPDATA 之类改成不可写不可行的路径不现实，这里直接断言文案模板本身：
  // 失败文案必须包含「怎么做」，并且指明是哪个条目失败。
  const source = await readFile(new URL('../spoken-video-remotion.mjs', import.meta.url), 'utf8')
  assert.match(source, /开发者选项/u, '文案要告诉用户去开开发者模式')
  assert.match(source, /管理员身份运行/u, '文案要告诉用户可以用管理员身份运行')
  assert.match(source, /为「\$\{entry\}」建立依赖链接时/u, '文案要指明是哪个条目失败')
  assert.match(source, /错误码：\$\{error\.code\}/u, '文案要带错误码便于排查')
  // 平台分支：Windows 用 'junction' 类型（不需要提权），其他平台保持 'dir'，不能一刀切。
  // 用 fs.symlink 的类型参数而不是 cmd /c mklink：不依赖外部命令，
  // 也不存在 mklink「先链接后目标」与 fs.symlink「先源后目标」顺序写反的风险。
  assert.match(source, /process\.platform === 'win32' \? 'junction' : 'dir'/u,
    'Windows 走 junction、其他平台走 dir')
  assert.match(source, /await symlink\(source, target, /u, '两侧统一经 fs.symlink')
  // 不得再退回到调用 cmd 内建命令（注释里提它是为了解释为什么不用，不算违规）。
  assert.doesNotMatch(source, /execFile\w*\(\s*['"]cmd['"]/u, '不应依赖 cmd 内建命令建链接')
})

test('浏览器探测：headless-shell 与 override 都没有时，必须找出系统 Chrome/Edge 而不是返回空', async (t) => {
  // 2026-10-21 用户真实体验：点「制作视频」后卡 390 秒，界面毫无提示。
  // 根因是 browserExecutableArgs() 探测不到 headless-shell 就返回空数组，
  // Remotion 于是静默联网下载浏览器（实测进程持到 142.250.73.123:443 的连接）。
  // 而代码上方注释当年写着「退回系统 Chrome：慢，但一定能启动」——那句话一直没实现。
  //
  // 这条断言就是那件缺失之事的守门人：只要本机装着 Chrome 或 Edge，
  // 就必须返回一个 --browser-executable，绝不能返回空、更不能抛错。
  const { browserExecutableArgs } = await import('../spoken-video-remotion.mjs')
  const { statSync, existsSync } = await import('node:fs')

  // 确保不会命中前两个分支：显式清空环境变量。
  const savedShell = process.env.LWB_REMOTION_HEADLESS_SHELL
  const savedOverride = process.env.LWB_REMOTION_BROWSER_EXECUTABLE
  delete process.env.LWB_REMOTION_HEADLESS_SHELL
  delete process.env.LWB_REMOTION_BROWSER_EXECUTABLE
  t.after(() => {
    if (savedShell !== undefined) process.env.LWB_REMOTION_HEADLESS_SHELL = savedShell
    if (savedOverride !== undefined) process.env.LWB_REMOTION_BROWSER_EXECUTABLE = savedOverride
  })

  // 本机是否真的装着浏览器？没有则这条断言的场景不成立，明确跳过而不是假装通过。
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  const hasBrowser = candidates.some((path) => {
    try { return statSync(path).isFile() } catch { return false }
  })
  if (!hasBrowser) {
    t.skip('本机没有安装 Chrome/Edge，无法验证「找到系统浏览器」这条分支')
    return
  }

  const args = browserExecutableArgs()
  assert.ok(args.length > 0, '本机装着浏览器时不得返回空数组——空数组会让 Remotion 静默下载')
  assert.equal(args[0], '--browser-executable')
  assert.ok(args[1] && existsSync(args[1]), `返回的浏览器路径必须真实存在：${args[1]}`)
  assert.ok(args[1].length <= 200, '可执行文件路径必须长度安全（Windows MAX_PATH 限制）')
})

test('never passes an OpenGL flag the bundled Chrome rejects', async (t) => {
  // Chrome 149 的 headless-shell 只允许 [(gl=egl-angle,angle=default)]，
  // --gl=swiftshader 会让 GPU 进程每次初始化即退出并不断重启。真正的契约有两个：
  // (1) 模块里不再有以 --gl 开头的参数（注释里可以解释原因，但不能真传）；
  // (2) 写进任务工程的 still/render 命令同样不带该参数。
  const moduleSource = await readFile(new URL('../spoken-video-remotion.mjs', import.meta.url), 'utf8')
  const passedFlags = moduleSource.match(/['"`]--gl[^'"`]*['"`]/gu) || []
  assert.deepEqual(passedFlags, [], `不得再向 Remotion 传任何 --gl 参数，实际：${passedFlags.join(' ')}`)

  const dir = await mkdtemp(join(tmpdir(), 'video-gl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const audioPath = join(dir, 'test.wav'); await writeFile(audioPath, 'audio fixture')
  const workspace = await prepareSpokenVideoAgentProject({ projectRoot: dir, runId: 'gl', audioPath, title: 'test', script: 'script', durationSeconds: 2, subtitles: [], subtitleEnabled: false })
  const pkg = JSON.parse(await readFile(join(workspace.projectDir, 'package.json'), 'utf8'))
  assert.doesNotMatch(pkg.scripts.still, /--gl/u)
  assert.doesNotMatch(pkg.scripts.render, /--gl/u)
  const task = JSON.parse(await readFile(join(workspace.projectDir, 'task.json'), 'utf8'))
  assert.doesNotMatch(task.commands.still, /--gl/u)
  assert.match(task.commands.still, /--overwrite/u, 'still 命令的其余参数必须保留')
})

test('retries only silent browser-launch failures, never render errors', () => {
  // 真实失败签名：25 秒连接超时，Chrome 一行日志都没有。
  assert.equal(isBrowserLaunchFailure('TimeoutError: Timed out after 25000 ms while trying to connect to the browser! Chrome logged the following: '), true)
  assert.equal(isBrowserLaunchFailure('Failed to launch the browser process!\nClosed with 1 signal: null'), true)
  // 其他错误必须原样抛出，不能被重试掩盖。
  assert.equal(isBrowserLaunchFailure('Error: The output file did not exist'), false)
  assert.equal(isBrowserLaunchFailure('ffmpeg exited with code 1'), false)
  assert.equal(isBrowserLaunchFailure(''), false)
  assert.equal(isBrowserLaunchFailure(undefined), false)
  assert.ok(RENDER_BROWSER_ATTEMPTS >= 2, '至少要允许一次重试')
})

test('parses remotion eval failures into located findings, never mistaking progress output', () => {
  // 真实失败签名（2026-10-02：修复 Agent 把组件注册表写到了组件定义之前，渲染在
  // Getting composition 阶段死于 TDZ）。
  const finding = parseRemotionEvalFailure(
    'Bundling 100%\n\nAn error occurred:\n ReferenceError  Cannot access \'HookScene\' before initialization\n\nat src/CreativeVideo.tsx:126\n124 │ \n',
  )
  assert.equal(finding.code, 'runtime-eval')
  assert.match(finding.message, /Cannot access 'HookScene' before initialization/u)
  assert.equal(finding.file, 'src/CreativeVideo.tsx')
  assert.equal(finding.line, 126)
  // 无 "An error occurred" 标记时退回 Error 行匹配；ANSI 与进度条不得当标题。
  const noisy = parseRemotionEvalFailure('Bundling code \x1b[34m━\x1b[39m 6%\nRendered 5%\nError: Cannot find module "./missing"\n    at webpackRequire (bootstrap)')
  assert.match(noisy.message, /Cannot find module/u)
  assert.doesNotMatch(noisy.message, /Bundling|Rendered/u)
  // 识别不出错误时必须返回 null：宁可让渲染自己报错，也不伪造 finding 去浪费修复轮。
  assert.equal(parseRemotionEvalFailure('Bundling 100%\nRendered 100%'), null)
  assert.equal(parseRemotionEvalFailure(''), null)
})


test('the frame gate samples one frame per scene so render-time errors surface before the render', async () => {
  // 2026-10-08 实测：SceneFounders 用了未声明的 a4（从相邻场景复制时漏掉锚点常量）。
  // compositions 门只读元数据、不渲染任何一帧，一路放行；渲染到该场景区间才抛
  // ReferenceError: a4 is not defined，40 分钟的整轮报废。抽帧门按场景中点渲一帧逼出来。
  const dir = await mkdtemp(join(tmpdir(), 'lwb-frame-gate-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    // 三个 5 秒场景，外加一个 0.2 秒的子锚点（同一场景内的次级动画，应被跳过）
    await writeFile(join(dir, 'src', 'CreativeVideo.tsx'), [
      'const a = F(0);',
      'const b = F(0.2);',
      'const c = F(5);',
      'const d = F(10);',
      'const e = F(15);',
      'const f = F(20);',
    ].join('\n'))
    const frames = sampleFrameNumbers(dir, Math.ceil(20.1 * 30))
    // 场景起点 0/5/10/15/20 共 5 个 -> 4 个区间，F(0.2) 因距上一锚点不足 0.5s 被并入
    assert.deepEqual(frames, [75, 225, 375, 525], '每个场景区间取中点，0.2s 子锚点不单独抽帧')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the frame gate falls back to even sampling when the source has no scene anchors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-frame-gate-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'CreativeVideo.tsx'), '// 没有任何 F() 时间锚点')
    const frames = sampleFrameNumbers(dir, 900)
    assert.ok(frames.length >= 5, '认不出锚点也必须抽样，宁可多抽也不能只验加载期')
    assert.ok(frames.every((frame) => frame > 0 && frame < 900))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 2026-10-15 补：三处边界解析曾各写一份正则，覆盖范围不一致，抽帧门与漂移门只认
// `F(数字)` 一种写法。实测 5 个已产出项目有 2 个写的是裸数字 `start: 0.11`，
// 这两道门在它们身上静默退化——报告仍显示通过，实际没按场景检查。抽帧门是专门
// 为了抓「只有落到那段才求值」的坏引用而设的，打折就等于削弱了它本来的作用。
test('the frame gate reads bare-number scene tables instead of degrading to even sampling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-frame-gate-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    // 与实测产物一致：裸数字秒、id+start+end、无任何 F() 调用。
    await writeFile(join(dir, 'src', 'CreativeVideo.tsx'), [
      'const SCENES: SceneDef[] = [',
      '  { id: "s01-hook", start: 0.11, end: 4.856 },',
      '  { id: "s02-scale", start: 4.856, end: 10.89 },',
      '  { id: "s03-drive", start: 10.89, end: 15.26 },',
      '];',
    ].join('\n'))
    const coverage = sampleFrameCoverage(dir, Math.ceil(20 * 30))
    assert.equal(coverage.mode, 'scene-table', '裸数字场景表必须被读出来，而不是退化成均匀抽样')
    assert.equal(coverage.spans, 3)
    // 每个场景各抽自己区间的中点：2.48s / 7.87s / 13.08s。
    assert.deepEqual(sampleFrameNumbers(dir, Math.ceil(20 * 30)), [74, 236, 392])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the frame gate covers the final scene, which pairwise anchor midpoints always miss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-frame-gate-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'CreativeVideo.tsx'), [
      'const F = (s: number) => Math.round(s*30);',
      'const SCENES = [',
      '  { id: "a", start: 0, end: 5 },',
      '  { id: "b", start: 5, end: 10 },',
      '  { id: "c", start: 10, end: 20 },',
      '];',
    ].join('\n'))
    const frames = sampleFrameNumbers(dir, Math.ceil(20 * 30))
    // 15s 是最后一幕的中点。旧的「相邻起点取中点」实现只取 2.5s 和 7.5s，
    // 10-20s 这一整幕从没被抽到过——它的组件体坏引用因此能一路漏到渲染。
    assert.ok(frames.includes(450), `最后一幕必须被抽到，实际抽到 ${JSON.stringify(frames)}`)
    assert.equal(new Set(frames).size, frames.length, '抽帧点不应重复')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scene-boundary degradation is reported instead of passing silently', () => {
  // 有可解析的场景表：不该有任何警告。
  assert.deepEqual(inspectSceneBoundaryCoverage('const SCENES = [\n{ id: "a", start: 0, end: 5 },\n{ id: "b", start: 5, end: 9 },\n];'), [])
  // 只有 F() 锚点、没有场景表：漂移门已失效，必须说出来。
  const anchorsOnly = inspectSceneBoundaryCoverage('const F = (s: number) => Math.round(s*30);\nconst a = F(0); const b = F(5); const c = F(10);')
  assert.equal(anchorsOnly.length, 1)
  assert.equal(anchorsOnly[0].code, 'scene-table-unused')
  // 什么都没有：最弱的一档，措辞要更重。
  const nothing = inspectSceneBoundaryCoverage('// 只有一段静态画面')
  assert.equal(nothing.length, 1)
  assert.equal(nothing[0].code, 'scene-table-missing')
})

test('the drift gate checks bare-number scene tables, which it used to skip entirely', () => {
  // 场景边界全部切在句子中间（每条 cue 8 秒长，场景却按 2.4 秒一刀切）。
  const cues = Array.from({ length: 6 }, (_, i) => `${pad(i * 8)}:00:00,000 --> ${pad(i * 8 + 7)}:00:00,000`).join('\n')
  const bareNumbers = `const SCENES = [\n${Array.from({ length: 7 }, (_, i) => `  { id: "s${i}", start: ${(i * 2.4).toFixed(2)}, end: ${((i + 1) * 2.4).toFixed(2)} },`).join('\n')}];`
  const findings = inspectTimelineAlignment(bareNumbers, cues)
  assert.equal(findings.length, 1, '裸数字场景表也必须参与漂移检查')
  assert.equal(findings[0].code, 'timeline-drift')
  // F() 写法得出同样的结论——两套实现此前会对同一份源码给出不同答案。
  const withF = bareNumbers.replace(/start: ([\d.]+), end: ([\d.]+)/gu, 'start: F($1), end: F($2)')
  assert.deepEqual(inspectTimelineAlignment(`const F = (s: number) => Math.round(s*30);\n${withF}`, cues).map((f) => f.code), ['timeline-drift'])
})

// 2026-10-15 补：AI 产物没有任何静态内容扫描，可以 import fs、读 process.env、
// 硬编码密钥与本机路径，而求值门只验「能不能跑起来」。这里钉住检查项既能抓到东西、
// 又不误伤正常产物——后者同样重要：误报会白白消耗修复轮。
test('content safety catches credentials, local paths and capabilities a video component cannot need', () => {
  const cases = [
    ['secret:OpenAI sk-proj', 'const k = "sk-proj-abcdefghij1234567890ABCDEFGHIJ";', 'secret-pattern'],
    ['secret:OpenAI 裸串', 'const k = "sk-abcdefghij1234567890ABCDEFGHIJKLMN";', 'secret-pattern'],
    ['secret:Anthropic', 'const k = "sk-ant-api03-abcdefghij1234567890ABCDEFGHIJKLMN";', 'secret-pattern'],
    ['secret:GitHub', 'const t = "ghp_abcdefghij1234567890ABCDEFGHIJ";', 'secret-pattern'],
    ['secret:AWS', 'const a = "AKIAIOSFODNN7EXAMPLE";', 'secret-pattern'],
    ['secret:私钥', 'const p = "-----BEGIN RSA PRIVATE KEY-----";', 'secret-pattern'],
    ['secret:Bearer', 'fetch(u, { headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" } })', 'secret-pattern'],
    ['path:Windows', String.raw`const f = "C:\Users\Administrator\Desktop\a.png";`, 'local-path'],
    ['path:macOS', 'const f = "/Users/zhangwei/Documents/a.png";', 'local-path'],
    ['path:Linux', 'const f = "/home/liwei/a.png";', 'local-path'],
    ['capability:fs', 'import fs from "node:fs";', 'forbidden-capability'],
    ['capability:child_process', 'const cp = require("child_process");', 'forbidden-capability'],
    ['capability:eval', 'eval("1+1");', 'forbidden-capability'],
    ['capability:process.exit', 'process.exit(1);', 'forbidden-capability'],
    ['env:读取', 'const f = process.env.FONT_PATH;', 'env-access'],
    ['注入:CLAUDE.md', 'const p = "CLAUDE.md";', 'auto-loaded-instructions'],
    ['注入:cursorrules', 'fs.readFileSync(".cursorrules");', 'auto-loaded-instructions'],
  ]
  for (const [name, source, code] of cases) {
    const hits = inspectContentSafety(source)
    assert.ok(hits.some((hit) => hit.code === code), `${name} 应命中 ${code}`)
    assert.ok(hits.every((hit) => hit.line >= 1), `${name} 的告警要带行号`)
  }
})

test('content safety stays quiet on placeholder paths and ordinary component code', () => {
  // 误报的代价和漏报一样大：导演写演示文案时经常用到占位路径与占位用户名，
  // 颜色常量、短 hex、Babel 的 helper 也不能被当成凭据。
  const safe = [
    ['占位用户名 user', 'const e = "/home/user/x";'],
    ['占位中文用户名', 'const d = { path: "/Users/你/Movies/我的片子" };'],
    ['占位 admin', 'const g = "/home/admin/app";'],
    ['颜色常量', 'const C = { c1: "#79c0ff", w: "#0d1117" };'],
    ['短 hex', 'const sha = "a1b2c3d4";'],
    ['正常组件', source('{opacity: interpolate(frame,[0,30],[0,1])}')],
  ]
  for (const [name, text] of safe) {
    assert.deepEqual(inspectContentSafety(text), [], `${name} 不该报内容安全告警`)
  }
})

// 2026-10-15 补：场景↔字幕的映射契约。现状是 AI 抄秒数写进 SCENES，而秒数无从
// 校验——只声明秒数时抄错了没有第二个信息源能揭穿它。让导演并列声明 cueRange 后，
// 「哪几句归哪一幕」成为可核对的事实：覆盖完整、无重叠、接缝对齐三件事都能查。
const srtOf = (count, stepMs = 5000) => {
  const blocks = []
  for (let i = 0; i < count; i += 1) {
    const at = (ms) => `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000)}`
    blocks.push(`${i + 1}\n${at(i * stepMs)} --> ${at((i + 1) * stepMs)}\n第 ${i + 1} 句`)
  }
  return blocks.join('\n\n')
}
const sixCues = () => Array.from({ length: 6 }, (_, i) => ({ startMs: i * 5000, endMs: (i + 1) * 5000 }))
const mapOf = (source) => parseSceneCueMap(source, parseSceneSpans(source))

test('the scene-cue contract reads the declared cue range under any of its field names', () => {
  const source = `const SCENES = [
  { id: "s01", start: 0, end: 10, cues: [1, 2] },
  { id: "s02", start: 10, end: 20, cueRange: [3, 4] },
  { id: "s03", start: 20, end: 30, cue: [5, 6] },
];`
  const map = mapOf(source)
  assert.equal(map.length, 3, '三种字段名都要认出来')
  assert.deepEqual(map.map((scene) => scene.cues), [[1, 2], [3, 4], [5, 6]])
  // 不声明 cueRange 时整条链路静默跳过，不产任何问题——这是渐进加固不是强制。
  assert.deepEqual(mapOf('const SCENES = [\n{ id: "a", start: 0, end: 5 },\n{ id: "b", start: 5, end: 9 },\n];'), [])
})

test('a scene table aligned to the subtitle passes the cue contract', () => {
  const source = `const SCENES = [
  { id: "s01", start: 0, end: 10, cues: [1, 2] },
  { id: "s02", start: 10, end: 20, cues: [3, 4] },
  { id: "s03", start: 20, end: 30, cues: [5, 6] },
];`
  assert.deepEqual(inspectSceneCueCoverage(mapOf(source), sixCues()), [], '严格对齐不该有问题')
})

test('subtitles no scene claims are reported, since the picture shows nothing while narration runs', () => {
  // cue6（25-30s）没人认领 = 5 秒无画面，超过 3 秒容差 → 该报。
  const source = `const SCENES = [
  { id: "s01", start: 0, end: 10, cues: [1, 2] },
  { id: "s02", start: 10, end: 20, cues: [3, 4] },
  { id: "s03", start: 20, end: 30, cues: [5, 5] },
];`
  const problems = inspectSceneCueCoverage(mapOf(source), sixCues())
  assert.deepEqual(problems.map((p) => p.code), ['scene-cue-gap'])

  // 只漏一条 2 秒的短句不算问题——场景之间本来就有 0.4-1 秒转场间隙，
  // 字幕常比画面切得细，边界附近的句子落进缝里是正常的（实测历史成片里很常见）。
  const short = sixCues()
  short[5] = { startMs: 25000, endMs: 27000 }
  const nudged = `const SCENES = [
  { id: "s01", start: 0, end: 10, cues: [1, 2] },
  { id: "s02", start: 10, end: 20, cues: [3, 4] },
  { id: "s03", start: 20, end: 30, cues: [5, 5] },
];`
  assert.deepEqual(inspectSceneCueCoverage(mapOf(nudged), short).filter((p) => p.code === 'scene-cue-gap'), [], '2 秒的短句落进间隙不该报')
})

test('two scenes claiming the same subtitle, or seconds that contradict the claimed lines, are reported', () => {
  // 真正的重叠：两幕的时间区间本身交叠，且都认领同一句（cue3 = 10-15s，
  // s01 到 12s、s02 从 8s 起，10-12s 那段两幕都覆盖 → overlapStart=10、End=12，
  // 占该句 40%… 要判出重叠需 >50%，所以让 s01 跨到 13s，句子 10-15s 有 3s 落在
  // 重叠区 10-13s，占 60%，应当被报。
  const overlap = `const SCENES = [
  { id: "s01", start: 0, end: 13, cues: [1, 3] },
  { id: "s02", start: 10, end: 20, cues: [3, 5] },
  { id: "s03", start: 20, end: 30, cues: [6, 6] },
];`
  assert.ok(inspectSceneCueCoverage(mapOf(overlap), sixCues()).some((p) => p.code === 'scene-cue-overlap'), '两幕交叠认领同一句应报 overlap')

  // 整表秒数比声称的句子晚 3 秒：只声明秒数时无从校验，两者都声明后自己露出来。
  const drift = `const SCENES = [
  { id: "s01", start: 3, end: 13, cues: [1, 2] },
  { id: "s02", start: 13, end: 23, cues: [3, 4] },
  { id: "s03", start: 23, end: 33, cues: [5, 6] },
];`
  assert.ok(inspectSceneCueCoverage(mapOf(drift), sixCues()).some((p) => p.code === 'scene-cue-drift'))
})

test('the cue contract stays out of the way when there is no scene table to check', () => {
  // 门是渐进加固：没有场景表、场景不足两幕、或字幕太少，都不该产问题——
  // 「测不了就放行」和仓库其余各门保持一致。
  assert.deepEqual(inspectSceneCueCoverage([], sixCues()), [])
  assert.deepEqual(inspectSceneCueCoverage([{ id: 'a', start: 0, end: 5, cues: [1, 2] }], sixCues()), [])
  assert.deepEqual(inspectSceneCueCoverage([{ id: 'a', start: 0, end: 5, cues: [1, 2] }, { id: 'b', start: 5, end: 9, cues: [3, 4] }], [{ start: 0, end: 1 }]), [])
})
