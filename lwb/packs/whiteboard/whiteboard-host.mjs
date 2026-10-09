import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

const RENDER_TIMEOUT_MS = 60 * 60 * 1000
const MAX_LOG_LINES = 400

export class WhiteboardHostError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  return new WhiteboardHostError(code, message)
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true }
  catch { return false }
}

/**
 * 编排层：把存储、Python 引擎与包级生命周期粘在一起。
 * 渲染是长任务，全部通过 scope.background 跟踪，卸载时会等待结算。
 */
export class WhiteboardHost {
  #store
  #background
  #engineRoot
  #workspacePath
  #runs = new Map()
  #cancellations = new Map()

  constructor({ store, background, engineRoot, workspacePath }) {
    this.#store = store
    this.#background = background
    this.#engineRoot = engineRoot
    this.#workspacePath = workspacePath
  }

  /**
   * 选一个能跑引擎的解释器：优先包内 .venv，其次系统 Python。
   *
   * 引擎依赖只有 OpenCV/NumPy/Pillow，系统 Python 往往已经具备。实测在没有
   * 国内镜像的情况下新建 venv 装 opencv-python 会拖很久，所以先探测系统解释器
   * 是否已满足依赖，满足就直接用，避免让用户白等。
   */
  async #resolvePython() {
    const probe = 'import cv2, numpy, PIL; print("WHITEBOARD_DEPS_OK")'
    const candidates = []
    const venv = process.platform === 'win32'
      ? join(this.#engineRoot, '.venv', 'Scripts', 'python.exe')
      : join(this.#engineRoot, '.venv', 'bin', 'python')
    if (await exists(venv)) candidates.push({ python: venv, source: 'venv' })
    candidates.push({ python: process.platform === 'win32' ? 'python' : 'python3', source: 'system' })

    for (const candidate of candidates) {
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(candidate.python, ['-c', probe], { windowsHide: true })
          let out = ''
          child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
          child.on('error', reject)
          child.on('close', (code) => resolve({ code, out }))
        })
        if (result.code === 0 && result.out.includes('WHITEBOARD_DEPS_OK')) return candidate
      } catch { /* 该解释器不可用，继续找下一个 */ }
    }
    return null
  }

  async status() {
    const projects = await this.#store.listProjects()
    const sceneCount = projects.reduce((sum, item) => sum + (item.scenes?.length || 0), 0)
    const env = await this.#detectEnvironment()
    return {
      projects: projects.length,
      scenes: sceneCount,
      running: this.#runs.size,
      engine: env,
    }
  }

  /** 探测引擎可用性，让界面能在渲染前就提示缺什么。 */
  async #detectEnvironment() {
    const scripts = join(this.#engineRoot, 'scripts')
    const venvPython = process.platform === 'win32'
      ? join(this.#engineRoot, '.venv', 'Scripts', 'python.exe')
      : join(this.#engineRoot, '.venv', 'bin', 'python')
    const resolved = await this.#resolvePython()
    return {
      engineRoot: this.#engineRoot,
      scriptsReady: await exists(join(scripts, 'render_stream_whiteboard.py')),
      venvReady: await exists(venvPython),
      venvPython: (await exists(venvPython)) ? venvPython : null,
      python: resolved?.python || null,
      pythonSource: resolved?.source || null,
      // 依赖可用即视为就绪；不要求一定来自包内 venv。
      ready: Boolean(resolved) && await exists(join(scripts, 'render_stream_whiteboard.py')),
    }
  }

  /**
   * 运行一个 Python 脚本并收集输出。
   * 引擎约定：末行输出 `OUTPUT=<路径>` 表示产物位置，`ENV_PY=<路径>` 表示解释器位置。
   */
  async #runPython(python, script, args, { signal, onLog, cwd } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, ...args], { cwd: cwd || this.#engineRoot, windowsHide: true })
      let stdout = ''
      let stderr = ''
      const lines = []
      const push = (chunk, isErr) => {
        const text = chunk.toString('utf8')
        if (isErr) stderr += text
        else stdout += text
        for (const line of text.split(/\r?\n/u)) {
          if (!line.trim()) continue
          lines.push(line)
          if (lines.length > MAX_LOG_LINES) lines.shift()
          onLog?.(line, isErr)
        }
      }
      child.stdout.on('data', (chunk) => push(chunk, false))
      child.stderr.on('data', (chunk) => push(chunk, true))

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(fail('WHITEBOARD_RENDER_TIMEOUT', `渲染超过 ${RENDER_TIMEOUT_MS / 60000} 分钟，已终止。`))
      }, RENDER_TIMEOUT_MS)

      const onAbort = () => { child.kill('SIGKILL'); reject(fail('WHITEBOARD_RENDER_CANCELLED', '渲染已取消。')) }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (error) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(fail('WHITEBOARD_ENGINE_MISSING', `无法启动 Python：${error.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (code !== 0) {
          const tail = lines.slice(-12).join('\n')
          reject(fail('WHITEBOARD_RENDER_FAILED', `引擎退出码 ${code}。\n${tail}`))
          return
        }
        const output = [...stdout.split(/\r?\n/u), ...stderr.split(/\r?\n/u)]
          .map((line) => line.trim())
          .filter(Boolean)
        resolve({
          stdout,
          stderr,
          lines,
          outputPath: output.filter((line) => line.startsWith('OUTPUT=')).at(-1)?.slice(7) || null,
          envPython: output.filter((line) => line.startsWith('ENV_PY=')).at(-1)?.slice(7) || null,
        })
      })
    })
  }

  async prepareEnvironment({ signal, onLog } = {}) {
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const script = join(this.#engineRoot, 'scripts', 'prepare_env.py')
    if (!(await exists(script))) throw fail('WHITEBOARD_ENGINE_MISSING', `找不到引擎脚本：${script}`)
    const result = await this.#runPython(python, script, [], { signal, onLog })
    return { envPython: result.envPython, log: result.lines }
  }

  /**
   * 把一幕的字幕时间轴分配给元素，产出标注骨架。
   *
   * 这是"startMs 查表"的落地：时间来自 SRT 的实际 cue 边界，不是估计值。
   * 返回的 region 是等分占位值，调用方（或预览台）需要按画面把区域拖到实际主体上。
   */
  async planTimeline(request) {
    const source = request || {}
    const srtPath = source.srtPath
    if (typeof srtPath !== 'string' || !srtPath.trim()) throw fail('WHITEBOARD_INVALID_INPUT', '缺少字幕文件路径。')
    if (!(await exists(srtPath))) throw fail('WHITEBOARD_NOT_FOUND', `字幕文件不存在：${srtPath}`)
    if (!Array.isArray(source.elements) || source.elements.length === 0) {
      throw fail('WHITEBOARD_INVALID_INPUT', '请按叙事顺序提供元素名称列表。')
    }
    if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)) {
      throw fail('WHITEBOARD_INVALID_INPUT', '需要原图像素宽高（整数）。')
    }
    const env = await this.#detectEnvironment()
    const python = env.python || (process.platform === 'win32' ? 'python' : 'python3')
    const args = [
      srtPath,
      '--scene', String(Number.isSafeInteger(source.scene) ? source.scene : 1),
      '--elements', ...source.elements.map((item) => String(item)),
      '--width', String(source.width),
      '--height', String(source.height),
    ]
    const result = await this.#runPython(python, join(this.#engineRoot, 'scripts', 'plan_timeline.py'), args)
    let annotation = null
    try { annotation = JSON.parse(result.stdout) }
    catch { throw fail('WHITEBOARD_RENDER_FAILED', `时间轴规划输出不是有效 JSON。\n${result.lines.slice(-8).join('\n')}`) }
    return { annotation, log: result.lines }
  }

  /** 解析字幕并给出分幕建议。 */
  async parseSrt(request) {
    const source = request || {}
    const srtPath = source.srtPath
    if (typeof srtPath !== 'string' || !srtPath.trim()) throw fail('WHITEBOARD_INVALID_INPUT', '缺少字幕文件路径。')
    if (!(await exists(srtPath))) throw fail('WHITEBOARD_NOT_FOUND', `字幕文件不存在：${srtPath}`)
    const env = await this.#detectEnvironment()
    const python = env.python || (process.platform === 'win32' ? 'python' : 'python3')
    const args = [srtPath]
    if (Number.isFinite(source.targetSec)) args.push('--target-sec', String(source.targetSec))
    if (Number.isFinite(source.minSec)) args.push('--min-sec', String(source.minSec))
    if (Number.isFinite(source.maxSec)) args.push('--max-sec', String(source.maxSec))
    const result = await this.#runPython(python, join(this.#engineRoot, 'scripts', 'parse_srt.py'), args)
    let parsed = null
    try { parsed = JSON.parse(result.stdout) }
    catch { throw fail('WHITEBOARD_RENDER_FAILED', `字幕解析输出不是有效 JSON。\n${result.lines.slice(-8).join('\n')}`) }
    return { ...parsed, log: result.lines }
  }

  /**
   * 渲染一幕。调用前会把标注写到项目目录（store.saveScene 已做），
   * 这里只负责把图片和标注交给引擎。
   */
  async startRender(projectId, request) {
    const source = request || {}
    const imagePath = source.imagePath
    if (typeof imagePath !== 'string' || !imagePath.trim()) throw fail('WHITEBOARD_INVALID_INPUT', '缺少线稿图片路径。')
    if (!(await exists(imagePath))) throw fail('WHITEBOARD_NOT_FOUND', `线稿图片不存在：${imagePath}`)
    const scenes = await this.#store.listScenes(projectId)
    const imageName = imagePath.split(/[\\/]/u).pop()
    const scene = scenes.find((item) => item.imageName === imageName)
    if (!scene) throw fail('WHITEBOARD_NOT_FOUND', `该项目下没有名为 ${imageName} 的已保存场景，请先保存标注。`)

    const projectDir = join(this.#workspacePath, 'data', 'projects', projectId)
    const annotationPath = join(projectDir, scene.annotationName)
    const outputDir = join(projectDir, 'out')
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    const outputPath = join(outputDir, `${imageName.replace(/\.[^.]+$/u, '')}-whiteboard.mp4`)

    const env = await this.#detectEnvironment()
    if (!env.ready) throw fail('WHITEBOARD_ENV_MISSING', '找不到具备 OpenCV/NumPy/Pillow 的 Python 解释器，请先执行「准备环境」。')
    if (!env.scriptsReady) throw fail('WHITEBOARD_ENGINE_MISSING', '引擎脚本缺失，请重新安装能力包。')

    const args = [imagePath, annotationPath, outputPath]
    if (Number.isFinite(source.capLongEdge)) args.push('--cap-long-edge', String(source.capLongEdge))
    if (Number.isFinite(source.totalMs)) args.push('--total-ms', String(source.totalMs))
    if (source.inkPath === 'skeleton' || source.inkPath === 'grid') args.push('--ink-path', source.inkPath)
    if (source.colorFill === 'brush' || source.colorFill === 'contour-wipe') args.push('--color-fill', source.colorFill)
    if (typeof source.penText === 'string' && source.penText.trim()) args.push('--pen-text', source.penText.trim())
    if (source.bareTip) args.push('--bare-tip')

    const runId = `${projectId}:${imageName}`
    const controller = new AbortController()
    this.#cancellations.set(runId, controller)

    const task = this.#runPython(env.python, join(this.#engineRoot, 'scripts', 'render_stream_whiteboard.py'), args, {
      signal: controller.signal,
      onLog: source.onLog,
    }).then((result) => {
      this.#runs.set(runId, { phase: 'completed', outputPath: result.outputPath || outputPath })
      return result
    }).catch((error) => {
      this.#runs.set(runId, { phase: 'failed', error: error.message })
      throw error
    }).finally(() => {
      this.#cancellations.delete(runId)
    })

    this.#runs.set(runId, { phase: 'running', startedAt: new Date().toISOString() })
    const settled = this.#background
      ? this.#background(task).catch(() => {})
      : task.catch(() => {})
    return { runId, outputPath, started: true, settled }
  }

  async renderStatus(runId) {
    return this.#runs.get(runId) || { phase: 'unknown' }
  }

  cancelRender(runId) {
    const controller = this.#cancellations.get(runId)
    if (!controller) return { cancelled: false }
    controller.abort()
    return { cancelled: true }
  }

  /** 多幕合并。 */
  async mergeScenes(request) {
    const source = request || {}
    if (!Array.isArray(source.inputs) || source.inputs.length < 2) {
      throw fail('WHITEBOARD_INVALID_INPUT', '合并至少需要两个输入文件。')
    }
    for (const input of source.inputs) {
      if (!(await exists(input))) throw fail('WHITEBOARD_NOT_FOUND', `输入文件不存在：${input}`)
    }
    const output = source.output
    if (typeof output !== 'string' || !output.trim()) throw fail('WHITEBOARD_INVALID_INPUT', '缺少输出路径。')
    const env = await this.#detectEnvironment()
    if (!env.ready) throw fail('WHITEBOARD_ENV_MISSING', '找不到具备 OpenCV/NumPy/Pillow 的 Python 解释器，请先执行「准备环境」。')
    const result = await this.#runPython(
      env.python,
      join(this.#engineRoot, 'scripts', 'merge_scenes.py'),
      ['--inputs', ...source.inputs, '--output', output],
      { onLog: source.onLog },
    )
    return { outputPath: result.outputPath || output, log: result.lines }
  }

  /**
   * 把技能文档投递到项目目录，供 Agent 按提示词读取。
   *
   * 与口播包的做法一致：技能不靠自动发现，而是复制到任务目录后由提示词
   * 指向具体路径。这样 Agent 拿到的是随包分发的确定版本，不受全局技能目录影响。
   */
  async deliverSkill(projectId) {
    const projectDir = join(this.#workspacePath, 'data', 'projects', projectId)
    const source = join(this.#engineRoot, '..', 'skills', 'srt-whiteboard-animation', 'SKILL.md')
    if (!(await exists(source))) throw fail('WHITEBOARD_ENGINE_MISSING', `找不到技能文档：${source}`)
    const destination = join(projectDir, 'skills', 'srt-whiteboard-animation', 'SKILL.md')
    await mkdir(join(projectDir, 'skills', 'srt-whiteboard-animation'), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    return { skillPath: destination }
  }

  async listProjects() { return this.#store.listProjects() }  async createProject(request) { return this.#store.createProject(request) }
  async updateProject(id, request) { return this.#store.updateProject(id, request) }
  async deleteProject(id) { return this.#store.deleteProject(id) }
  async listScenes(projectId) { return this.#store.listScenes(projectId) }
  async saveScene(projectId, request) { return this.#store.saveScene(projectId, request) }
  async deleteScene(projectId, imageName) { return this.#store.deleteScene(projectId, imageName) }

  /** 读取项目目录里的标注原文，供预览台或界面直接展示。 */
  async readAnnotation(projectId, annotationName) {
    const path = join(this.#workspacePath, 'data', 'projects', projectId, annotationName)
    if (!(await exists(path))) throw fail('WHITEBOARD_NOT_FOUND', `标注文件不存在：${annotationName}`)
    return JSON.parse(await readFile(path, 'utf8'))
  }
}
