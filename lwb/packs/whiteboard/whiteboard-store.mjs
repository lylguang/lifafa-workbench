import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FILES_SCHEMA_VERSION = 1
const MAX_PROJECTS = 200

export class WhiteboardStoreError extends Error {
  constructor(code, message) {
    super(`Error [${code}] ${message}`)
    this.code = code
  }
}

function fail(code, message) {
  return new WhiteboardStoreError(code, message)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('WHITEBOARD_INVALID_INPUT', `${label} 必须是对象。`)
  return value
}

function text(value, label, maxLength) {
  if (typeof value !== 'string') throw fail('WHITEBOARD_INVALID_INPUT', `${label} 必须是文本。`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw fail('WHITEBOARD_INVALID_INPUT', `${label} 长度必须在 1-${maxLength} 之间。`)
  return normalized
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  return text(value, label, maxLength)
}

/**
 * Windows：rename 的目标只要被任意句柄打开就会 EPERM，而工作台会轮询读取这些
 * 文件，写入窗口容易撞上。退避重试吸收偶发冲突，真故障仍然抛出。
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break }
      catch (error) {
        if ((error?.code !== 'EPERM' && error?.code !== 'EBUSY') || attempt >= 6) throw error
        await new Promise((resolve) => setTimeout(resolve, [50, 120, 280, 600, 1200, 2400, 4000][attempt]))
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function readJson(path, fallback) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw fail('WHITEBOARD_STORAGE_UNREADABLE', `读取 ${path} 失败：${error?.message || error}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw fail('WHITEBOARD_STORAGE_CORRUPT', `文件 ${path} 不是有效 JSON。`)
  }
}

export function parseProjectInput(input) {
  const source = object(input, '项目信息')
  return {
    name: text(source.name, '项目名称', 80),
    note: optionalText(source.note, '备注', 600),
  }
}

/** 只保留引擎认识的字段，避免把前端多余数据写进标注文件。 */
export function normalizeAnnotation(value) {
  const source = object(value, '标注')
  const canvas = object(source.canvas, '标注 canvas')
  const width = Number(canvas.width)
  const height = Number(canvas.height)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw fail('WHITEBOARD_INVALID_INPUT', 'canvas 宽高必须是正整数。')
  }
  if (!Array.isArray(source.elements)) throw fail('WHITEBOARD_INVALID_INPUT', 'elements 必须是数组。')
  const elements = source.elements.map((item, index) => {
    const entry = object(item, `elements[${index}]`)
    const region = object(entry.region, `elements[${index}].region`)
    const reveal = object(entry.reveal, `elements[${index}].reveal`)
    const rect = (value, label) => {
      const out = {}
      for (const key of ['x', 'y', 'width', 'height']) {
        const raw = value[key]
        // 与引擎一致：只接受真正的整数像素。字符串和浮点在引擎侧都会被拒绝，
        // 这里先拦下来，避免把非法标注写进文件后才在渲染时失败。
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
          throw fail('WHITEBOARD_INVALID_INPUT', `${label}.${key} 必须是整数像素。`)
        }
        out[key] = raw
      }
      return out
    }
    return {
      id: optionalText(entry.id, `elements[${index}].id`, 80) || `element_${index + 1}`,
      label: optionalText(entry.label, `elements[${index}].label`, 120) || `区域 ${index + 1}`,
      sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence : index + 1,
      narrativeRole: optionalText(entry.narrativeRole, `elements[${index}].narrativeRole`, 300) || '',
      subtitle: optionalText(entry.subtitle, `elements[${index}].subtitle`, 2000) || '',
      type: optionalText(entry.type, `elements[${index}].type`, 40) || 'object',
      region: rect(region, `elements[${index}].region`),
      reveal: {
        direction: optionalText(reveal.direction, `elements[${index}].reveal.direction`, 40) || 'top_to_bottom',
        startMs: Number.isSafeInteger(reveal.startMs) ? reveal.startMs : 0,
        durationMs: Number.isSafeInteger(reveal.durationMs) ? reveal.durationMs : 2000,
        maskPaddingPx: Number.isSafeInteger(reveal.maskPaddingPx) ? reveal.maskPaddingPx : 22,
        protectedRegions: Array.isArray(reveal.protectedRegions)
          ? reveal.protectedRegions.map((item, j) => rect(object(item, `protectedRegions[${j}]`), `protectedRegions[${j}]`))
          : [],
      },
      handPath: entry.handPath && typeof entry.handPath === 'object' ? entry.handPath : {},
    }
  })
  return {
    sceneId: optionalText(source.sceneId, 'sceneId', 80) || 'scene-01',
    canvas: { width, height },
    storyBasis: optionalText(source.storyBasis, 'storyBasis', 2000) || '',
    sceneDurationMs: Number.isSafeInteger(source.sceneDurationMs) ? source.sceneDurationMs : 8000,
    elements,
  }
}

export class WhiteboardStore {
  constructor({ workspacePath }) {
    this.workspacePath = workspacePath
  }

  #projectsFile() {
    return join(this.workspacePath, 'data', 'projects.json')
  }

  #projectDir(id) {
    return join(this.workspacePath, 'data', 'projects', id)
  }

  async listProjects() {
    const data = await readJson(this.#projectsFile(), { schemaVersion: FILES_SCHEMA_VERSION, projects: [] })
    return Array.isArray(data.projects) ? data.projects : []
  }

  async #saveProjects(projects) {
    await writeJson(this.#projectsFile(), { schemaVersion: FILES_SCHEMA_VERSION, projects })
  }

  async getProject(id) {
    const projects = await this.listProjects()
    const found = projects.find((item) => item.id === id)
    if (!found) throw fail('WHITEBOARD_NOT_FOUND', `项目不存在：${id}`)
    return found
  }

  async createProject(input) {
    const parsed = parseProjectInput(input)
    const projects = await this.listProjects()
    if (projects.length >= MAX_PROJECTS) throw fail('WHITEBOARD_LIMIT', `项目数量已达上限 ${MAX_PROJECTS}。`)
    const now = new Date().toISOString()
    const project = { id: randomUUID(), name: parsed.name, note: parsed.note, scenes: [], createdAt: now, updatedAt: now }
    projects.unshift(project)
    await this.#saveProjects(projects)
    await mkdir(this.#projectDir(project.id), { recursive: true, mode: 0o700 })
    return project
  }

  async updateProject(id, input) {
    const parsed = parseProjectInput(input)
    const projects = await this.listProjects()
    const index = projects.findIndex((item) => item.id === id)
    if (index < 0) throw fail('WHITEBOARD_NOT_FOUND', `项目不存在：${id}`)
    projects[index] = { ...projects[index], name: parsed.name, note: parsed.note, updatedAt: new Date().toISOString() }
    await this.#saveProjects(projects)
    return projects[index]
  }

  async deleteProject(id) {
    const projects = await this.listProjects()
    const next = projects.filter((item) => item.id !== id)
    if (next.length === projects.length) throw fail('WHITEBOARD_NOT_FOUND', `项目不存在：${id}`)
    await this.#saveProjects(next)
    return { id }
  }

  /**
   * 保存一幕的标注。幕以「图片文件名」为键，与引擎的 `<名称>.png` + `<名称>.annotation.json`
   * 配对约定一致；渲染时按这个约定还原目录。
   */
  async saveScene(projectId, request) {
    const project = await this.getProject(projectId)
    const source = object(request, '场景')
    const imageName = text(source.imageName, '图片文件名', 200)
    if (!/\.(png|jpe?g)$/iu.test(imageName)) throw fail('WHITEBOARD_INVALID_INPUT', '图片文件名必须是 .png/.jpg/.jpeg。')
    const annotation = normalizeAnnotation(source.annotation)

    const scene = {
      imageName,
      annotationName: `${imageName.replace(/\.[^.]+$/u, '')}.annotation.json`,
      annotation,
      sceneDurationMs: annotation.sceneDurationMs,
      updatedAt: new Date().toISOString(),
    }
    const projects = await this.listProjects()
    const index = projects.findIndex((item) => item.id === projectId)
    const scenes = Array.isArray(projects[index].scenes) ? [...projects[index].scenes] : []
    const sceneIndex = scenes.findIndex((item) => item.imageName === imageName)
    if (sceneIndex >= 0) scenes[sceneIndex] = scene
    else scenes.push(scene)
    projects[index] = { ...projects[index], scenes, updatedAt: new Date().toISOString() }
    await this.#saveProjects(projects)

    // 同时把标注写到项目目录，便于预览台「打开文件夹」直接载入
    const dir = this.#projectDir(projectId)
    await writeJson(join(dir, scene.annotationName), annotation)
    return scene
  }

  async listScenes(projectId) {
    const project = await this.getProject(projectId)
    return Array.isArray(project.scenes) ? project.scenes : []
  }

  async deleteScene(projectId, imageName) {
    const projects = await this.listProjects()
    const index = projects.findIndex((item) => item.id === projectId)
    if (index < 0) throw fail('WHITEBOARD_NOT_FOUND', `项目不存在：${projectId}`)
    const scenes = (projects[index].scenes || []).filter((item) => item.imageName !== imageName)
    projects[index] = { ...projects[index], scenes, updatedAt: new Date().toISOString() }
    await this.#saveProjects(projects)
    return { imageName }
  }
}
