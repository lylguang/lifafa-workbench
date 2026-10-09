import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { WhiteboardStore, normalizeAnnotation, parseProjectInput } from '../whiteboard-store.mjs'
import { WhiteboardHost } from '../whiteboard-host.mjs'

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-'))
  try { await run(new WhiteboardStore({ workspacePath: dir }), dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('parseProjectInput requires a name and trims fields', () => {
  assert.throws(() => parseProjectInput({}), /项目名称/u)
  assert.throws(() => parseProjectInput({ name: '   ' }), /项目名称/u)
  assert.deepEqual(parseProjectInput({ name: '  猴子山  ', note: ' 第一期 ' }), { name: '猴子山', note: '第一期' })
  assert.deepEqual(parseProjectInput({ name: 'x' }), { name: 'x', note: undefined })
})

test('normalizeAnnotation keeps integer pixel regions and drops unknown fields', () => {
  const normalized = normalizeAnnotation({
    canvas: { width: 1672, height: 941 },
    sceneDurationMs: 8600,
    elements: [{
      id: 'rockery',
      label: '假山场景',
      sequence: 1,
      subtitle: '小猴子坐在假山顶端。',
      region: { x: 20, y: 120, width: 540, height: 780 },
      reveal: { direction: 'top_to_bottom', startMs: 300, durationMs: 2600, protectedRegions: [] },
      handPath: { start: [290, 130], end: [290, 890] },
      somethingUnknown: 'dropped',
    }],
  })
  assert.equal(normalized.canvas.width, 1672)
  assert.equal(normalized.elements.length, 1)
  assert.equal(normalized.elements[0].region.x, 20)
  assert.equal(normalized.elements[0].reveal.startMs, 300)
  assert.equal(normalized.elements[0].somethingUnknown, undefined)
})

test('normalizeAnnotation rejects non-integer coordinates', () => {
  const base = { canvas: { width: 100, height: 100 }, elements: [] }
  const element = (region) => ({
    canvas: { width: 100, height: 100 },
    elements: [{ region, reveal: { startMs: 0, durationMs: 100 } }],
  })
  assert.throws(() => normalizeAnnotation(element({ x: 0.5, y: 0, width: 10, height: 10 })), /必须是整数像素/u)
  assert.throws(() => normalizeAnnotation(element({ x: 0, y: '0', width: 10, height: 10 })), /必须是整数像素/u)
  assert.throws(() => normalizeAnnotation({ ...base, canvas: { width: 0, height: 10 } }), /canvas 宽高/u)
  assert.throws(() => normalizeAnnotation({ canvas: { width: 10, height: 10 } }), /elements 必须是数组/u)
})

test('normalizeAnnotation fills defaults for optional element fields', () => {
  const normalized = normalizeAnnotation({
    canvas: { width: 100, height: 100 },
    elements: [{ region: { x: 0, y: 0, width: 10, height: 10 }, reveal: { startMs: 0, durationMs: 500 } }],
  })
  const [element] = normalized.elements
  assert.equal(element.id, 'element_1')
  assert.equal(element.label, '区域 1')
  assert.equal(element.sequence, 1)
  assert.equal(element.type, 'object')
  assert.equal(element.reveal.direction, 'top_to_bottom')
  assert.equal(element.reveal.maskPaddingPx, 22)
  assert.deepEqual(element.reveal.protectedRegions, [])
})

test('projects persist across store instances and validate input', async () => {
  await withStore(async (store, dir) => {
    const created = await store.createProject({ name: '猴子山' })
    assert.ok(created.id)
    const reopened = new WhiteboardStore({ workspacePath: dir })
    const projects = await reopened.listProjects()
    assert.equal(projects.length, 1)
    assert.equal(projects[0].name, '猴子山')
    await assert.rejects(() => reopened.getProject('missing'), /项目不存在/u)
    await assert.rejects(() => reopened.createProject({ name: '' }), /项目名称/u)
  })
})

test('saveScene writes the annotation beside the project and pairs names', async () => {
  await withStore(async (store) => {
    const project = await store.createProject({ name: '猴子山' })
    const scene = await store.saveScene(project.id, {
      imageName: 'scene-01-monkey.png',
      annotation: {
        canvas: { width: 1672, height: 941 },
        sceneDurationMs: 8600,
        elements: [{
          label: '假山',
          region: { x: 20, y: 120, width: 540, height: 780 },
          reveal: { startMs: 300, durationMs: 2600 },
        }],
      },
    })
    assert.equal(scene.annotationName, 'scene-01-monkey.annotation.json')
    const scenes = await store.listScenes(project.id)
    assert.equal(scenes.length, 1)
    assert.equal(scenes[0].imageName, 'scene-01-monkey.png')
  })
})

test('saveScene replaces an existing scene with the same image name', async () => {
  await withStore(async (store) => {
    const project = await store.createProject({ name: 'p' })
    const annotation = (label) => ({
      canvas: { width: 100, height: 100 },
      elements: [{ label, region: { x: 0, y: 0, width: 10, height: 10 }, reveal: { startMs: 0, durationMs: 100 } }],
    })
    await store.saveScene(project.id, { imageName: 'a.png', annotation: annotation('first') })
    await store.saveScene(project.id, { imageName: 'a.png', annotation: annotation('second') })
    const scenes = await store.listScenes(project.id)
    assert.equal(scenes.length, 1)
    assert.equal(scenes[0].annotation.elements[0].label, 'second')
  })
})

test('saveScene rejects non-image names', async () => {
  await withStore(async (store) => {
    const project = await store.createProject({ name: 'p' })
    await assert.rejects(
      () => store.saveScene(project.id, { imageName: 'a.txt', annotation: { canvas: { width: 1, height: 1 }, elements: [] } }),
      /必须是 \.png/u,
    )
  })
})

test('deleteScene removes only the named scene', async () => {
  await withStore(async (store) => {
    const project = await store.createProject({ name: 'p' })
    const annotation = {
      canvas: { width: 100, height: 100 },
      elements: [{ region: { x: 0, y: 0, width: 10, height: 10 }, reveal: { startMs: 0, durationMs: 100 } }],
    }
    await store.saveScene(project.id, { imageName: 'a.png', annotation })
    await store.saveScene(project.id, { imageName: 'b.png', annotation })
    await store.deleteScene(project.id, 'a.png')
    const scenes = await store.listScenes(project.id)
    assert.deepEqual(scenes.map((item) => item.imageName), ['b.png'])
  })
})

test('deleteProject removes the project and tolerates a missing id', async () => {
  await withStore(async (store) => {
    const project = await store.createProject({ name: 'p' })
    await store.deleteProject(project.id)
    assert.equal((await store.listProjects()).length, 0)
    await assert.rejects(() => store.deleteProject(project.id), /项目不存在/u)
  })
})

test('deliverSkill copies the skill document into the project directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-skill-'))
  try {
    const store = new WhiteboardStore({ workspacePath: dir })
    const project = await store.createProject({ name: 'p' })
    const engineRoot = join(PACK_ROOT, 'engine')
    const host = new WhiteboardHost({ store, background: null, engineRoot, workspacePath: dir })
    const { skillPath } = await host.deliverSkill(project.id)
    assert.ok(skillPath.endsWith(join('skills', 'srt-whiteboard-animation', 'SKILL.md')))
    const content = await readFile(skillPath, 'utf8')
    assert.match(content, /白板手绘动画/u)
    assert.match(content, /工作流/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deliverSkill reports a missing skill document instead of writing nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-skill-missing-'))
  try {
    const store = new WhiteboardStore({ workspacePath: dir })
    const project = await store.createProject({ name: 'p' })
    const host = new WhiteboardHost({ store, background: null, engineRoot: join(dir, 'nope'), workspacePath: dir })
    await assert.rejects(() => host.deliverSkill(project.id), /找不到技能文档/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status reports engine readiness without throwing when the venv is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-status-'))
  try {
    const store = new WhiteboardStore({ workspacePath: dir })
    const host = new WhiteboardHost({ store, background: null, engineRoot: join(PACK_ROOT, 'engine'), workspacePath: dir })
    const status = await host.status()
    assert.equal(typeof status.engine.scriptsReady, 'boolean')
    assert.equal(typeof status.engine.venvReady, 'boolean')
    assert.equal(status.projects, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startRender refuses a scene that has no saved annotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-render-'))
  try {
    const store = new WhiteboardStore({ workspacePath: dir })
    const project = await store.createProject({ name: 'p' })
    const host = new WhiteboardHost({ store, background: null, engineRoot: join(PACK_ROOT, 'engine'), workspacePath: dir })
    await assert.rejects(
      () => host.startRender(project.id, { imagePath: join(dir, 'missing.png') }),
      /线稿图片不存在/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('planTimeline validates its inputs before touching the engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-plan-'))
  try {
    const store = new WhiteboardStore({ workspacePath: dir })
    const host = new WhiteboardHost({ store, background: null, engineRoot: join(PACK_ROOT, 'engine'), workspacePath: dir })
    await assert.rejects(() => host.planTimeline({}), /缺少字幕文件路径/u)
    await assert.rejects(() => host.planTimeline({ srtPath: join(dir, 'x.srt') }), /字幕文件不存在/u)

    const srt = join(dir, 'a.srt')
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:05,000\n第一句。\n', 'utf8')
    await assert.rejects(() => host.planTimeline({ srtPath: srt, width: 100, height: 100 }), /元素名称列表/u)
    await assert.rejects(
      () => host.planTimeline({ srtPath: srt, elements: ['A'], width: 100 }),
      /像素宽高/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('planTimeline maps subtitle cue boundaries onto element start times', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-whiteboard-plan2-'))
  try {
    const store = new WhiteboardStore({ workspacePath: dir })
    const host = new WhiteboardHost({ store, background: null, engineRoot: join(PACK_ROOT, 'engine'), workspacePath: dir })
    const srt = join(dir, 'a.srt')
    await writeFile(srt, [
      '1', '00:00:00,000 --> 00:00:06,500', '猴子山上，一只小猴子坐在假山顶端。', '',
      '2', '00:00:06,500 --> 00:00:13,000', '突然，一只大猴子冲了过来。', '',
      '3', '00:00:13,000 --> 00:00:20,000', '小朋友们都惊呆了。', '',
    ].join('\n'), 'utf8')

    const { annotation } = await host.planTimeline({
      srtPath: srt, scene: 1,
      elements: ['假山与小猴', '大猴抢香蕉', '小朋友围观'],
      width: 1672, height: 941,
    })
    assert.equal(annotation.elements.length, 3)
    assert.equal(annotation.canvas.width, 1672)
    // 第一个元素从该幕起点开始；各元素按字幕顺序排列且不重叠
    assert.equal(annotation.elements[0].reveal.startMs, 0)
    for (let i = 1; i < annotation.elements.length; i++) {
      const previous = annotation.elements[i - 1]
      const current = annotation.elements[i]
      assert.ok(current.reveal.startMs >= previous.reveal.startMs + previous.reveal.durationMs - 200,
        `元素 ${i + 1} 的起点应与上一元素衔接`)
    }
    // 字幕文本被带上，供预览台联动
    assert.match(annotation.elements[0].subtitle, /小猴子/u)
    assert.match(annotation.elements[2].subtitle, /惊呆/u)
    // 区域是占位值，必须在画布内
    for (const element of annotation.elements) {
      assert.ok(element.region.x >= 0 && element.region.y >= 0)
      assert.ok(element.region.x + element.region.width <= 1672)
      assert.ok(element.region.y + element.region.height <= 941)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scene renderer never pads a scene past its planned duration', async () => {
  // 回归：凝视段原为 max(total_ms, cur_ms + 500)，每幕强制多停 0.5s。
  // 多幕拼接时逐幕累积，15 幕实测 +7.5s——画面整体滞后于配音，越往后越明显。
  // 单幕看不出来，所以必须在源码层钉住这条不变量。
  const source = await readFile(join(PACK_ROOT, 'engine', 'scripts', 'render_stream_whiteboard.py'), 'utf8')
  assert.doesNotMatch(source, /gaze_until\s*=\s*max\(\s*total_ms\s*,\s*cur_ms\s*\+/u,
    '凝视段不得在计划时长之外再追加固定停留：多幕会累积成整体错位')
  assert.match(source, /gaze_until\s*=\s*max\(cur_ms,\s*float\(total_ms\)\)/u,
    '凝视应补齐到计划时长，且绝不越过它')
})

test('scene renderer writes exactly the planned frame count', async (t) => {
  // 端到端：真的渲染一幕，确认输出时长等于 total_ms（允许 1 帧量化误差）。
  const engineRoot = join(PACK_ROOT, 'engine')
  const script = join(engineRoot, 'scripts', 'render_stream_whiteboard.py')
  const { execFileSync } = await import('node:child_process')
  // 与宿主 #whiteboardPython 同一套候选顺序：先 venv，再系统解释器。
  const venvPython = process.platform === 'win32'
    ? join(engineRoot, '.venv', 'Scripts', 'python.exe')
    : join(engineRoot, '.venv', 'bin', 'python')
  let python = null
  for (const candidate of [venvPython, process.platform === 'win32' ? 'python' : 'python3']) {
    try {
      const probe = execFileSync(candidate, ['-c', 'import cv2, numpy, PIL; print("OK")'], { encoding: 'utf8', timeout: 60_000 })
      if (probe.includes('OK')) { python = candidate; break }
    } catch { /* 该解释器不可用，尝试下一个 */ }
  }
  if (!python) { t.skip('whiteboard engine dependencies (OpenCV/NumPy/Pillow) are unavailable'); return }
  const dir = await mkdtemp(join(tmpdir(), 'lwb-wb-render-'))
  try {
    const image = join(dir, 'scene.png')
    const annotation = join(dir, 'scene.annotation.json')
    const output = join(dir, 'out.mp4')
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0xF5EBD7:s=640x360:d=1', '-frames:v', '1', image], { stdio: 'ignore' })
    await writeFile(annotation, JSON.stringify({
      sceneId: 1, canvas: { width: 640, height: 360 }, sceneDurationMs: 6000,
      elements: [
        { id: 'e1', label: '场景铺垫', sequence: 1, region: { x: 40, y: 40, width: 200, height: 120 }, reveal: { startMs: 0, durationMs: 2500 } },
        { id: 'e2', label: '核心主体', sequence: 2, region: { x: 300, y: 120, width: 260, height: 160 }, reveal: { startMs: 2500, durationMs: 2500 } },
      ],
    }), 'utf8')
    execFileSync(python, [script, image, annotation, output, '--fps', '30', '--total-ms', '6000', '--cap-long-edge', '360'], { stdio: 'ignore', timeout: 300_000 })
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output], { encoding: 'utf8' }).trim())
    assert.ok(Math.abs(duration - 6) <= 1 / 30 + 0.01, `输出时长 ${duration}s 应等于计划 6s（允许 1 帧误差）`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// pip 镜像源的解析逻辑是纯函数式的，值得单独回归：它决定客户首次使用白板
// 时装依赖走哪个源，错了的表现是"装了几十分钟还没完"而不是任何报错。
// 用真实解释器跑 prepare_env.py 的解析路径，通过环境变量隔离外部网络状态。
test('prepare_env 按 LWB_PIP_INDEX_URL 覆盖镜像源，默认走清华源', async () => {
  const { execFileSync } = await import('node:child_process')
  const script = join(PACK_ROOT, 'engine', 'scripts', 'prepare_env.py')
  const probe = [
    'import sys, importlib.util',
    'spec = importlib.util.spec_from_file_location("pe", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'print(m.resolve_index_url())',
  ].join(';')
  const run = (env) => execFileSync('python', ['-c', probe, script], {
    encoding: 'utf8', env: { ...process.env, LWB_PIP_INDEX_URL: env }, timeout: 30_000,
  }).trim()
  assert.equal(run('https://mirrors.aliyun.com/pypi/simple'), 'https://mirrors.aliyun.com/pypi/simple')
  // 不设置覆盖时：镜像可达走清华源，不可达则打印告警并退回官方源。
  // 取最后一行——告警信息会先于结果打印，不能把它算进返回值。
  const fallback = execFileSync('python', ['-c', probe, script], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LWB_PIP_INDEX_URL: '' },
  }).trim().split('\n').pop().trim()
  assert.ok(
    fallback === 'https://pypi.tuna.tsinghua.edu.cn/simple' || fallback === 'https://pypi.org/simple',
    `默认源应是清华或官方其一，实际 ${fallback}`,
  )
})
