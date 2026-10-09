import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectCreativeSource } from '../spoken-video-preflight.mjs'
import { APP_NODE_MODULES, ensureAgentDependencies, inspectSpokenVideoAgentProject, isBrowserLaunchFailure, parseRemotionEvalFailure, prepareSpokenVideoAgentProject, sampleFrameNumbers, RENDER_BROWSER_ATTEMPTS } from '../spoken-video-remotion.mjs'

const source = (style, extra = '') => `import React from 'react'; import {useCurrentFrame} from 'remotion';
export const CreativeVideo=()=>{const frame=useCurrentFrame();return <div style={${style}}>Hello</div>};
${extra}
/* ${'scene details '.repeat(90)} */`
const motion = text => inspectCreativeSource(text).filter(x => x.code === 'css-motion')

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
  await symlink(APP_NODE_MODULES, join(dir, 'node_modules'))
  await ensureAgentDependencies(dir)
  await writeFile(join(dir, 'node_modules/.cache/task-only'), 'local')
  await ensureAgentDependencies(dir)
  assert.equal(await readFile(join(dir, 'node_modules/.cache/task-only'), 'utf8'), 'local')
  assert.equal((await lstat(join(dir, 'node_modules'))).isDirectory(), true)
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
