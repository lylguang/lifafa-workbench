// Copied into each video workspace: the creator and host use this same checker.
import { parse } from '@babel/parser'
import postcss from 'postcss'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const motionProperty = (name) => /^(?:animation|animationname|transition|transitionproperty)$/u.test(String(name).replace(/^(?:-webkit-|-moz-|-o-|Webkit|Moz|O)/u, '').replaceAll('-', '').toLowerCase())
const literal = (node) => ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node?.type) ? literal(node.expression) : node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null
const propertyName = (node) => node?.type === 'Identifier' ? node.name : literal(node)

/** Static checks of authored TSX. Locations point to the actual declaration, not a comment. */
export function inspectCreativeSource(source) {
  const findings = []
  const report = (code, node, message) => findings.push({ code, file: 'src/CreativeVideo.tsx', line: node?.loc?.start?.line || 1, column: (node?.loc?.start?.column || 0) + 1, message })
  let ast
  try { ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }) }
  catch (error) {
    report('syntax', { loc: { start: error.loc } }, `TSX 语法错误：${error.message}`)
    return findings
  }
  let frameDriven = false
  const checkMotion = (name, value, node) => {
    if (!motionProperty(name)) return
    if (typeof value === 'string' && value.trim().toLowerCase() === 'none') return
    report('css-motion', node, `${name}: ${value === null ? '动态值' : JSON.stringify(value)} 使用了浏览器计时动画；请删除该声明、显式设为 "none"，或改用 Remotion 帧驱动。`)
  }
  const cssText = (node) => {
    if (node?.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked || '').join('__dynamic__')
    return literal(node)
  }
  const checkCss = (text, node) => {
    if (typeof text !== 'string') return
    try {
      const css = postcss.parse(text)
      css.walkDecls((decl) => {
        checkMotion(decl.prop, decl.value.replace(/\s*!important\s*$/iu, ''), { loc: { start: { line: (node.loc?.start?.line || 1) + (decl.source?.start?.line || 1) - 1, column: (decl.source?.start?.column || 1) - 1 } } })
      })
    } catch (error) { report('css-syntax', node, `样式块无法检查：${error.reason || error.message}`) }
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && ['useCurrentFrame', 'interpolate', 'spring'].includes(node.callee.name)) frameDriven = true
    if (node.type === 'JSXOpeningElement' && node.name?.name === 'Sequence') frameDriven = true
    if (node.type === 'JSXAttribute' && node.name?.name === 'data-agent-placeholder' && literal(node.value) === 'true') report('placeholder', node, '视频 Agent 未替换初始占位画面。')
    if (node.type === 'ObjectProperty' && (!node.computed || literal(node.key) !== null)) checkMotion(propertyName(node.key), literal(node.value), node)
    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
      const member = node.left
      if (!member.computed || literal(member.property) !== null) checkMotion(propertyName(member.property), literal(node.right), node)
    }
    if (node.type === 'JSXElement' && node.openingElement.name?.name === 'style') {
      for (const child of node.children) checkCss(child.type === 'JSXText' ? child.value : cssText(child.expression), child)
    }
    if (node.type === 'TaggedTemplateExpression' && (node.tag?.name === 'css' || node.tag?.object?.name === 'styled')) checkCss(cssText(node.quasi), node.quasi)
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast.program)
  if (!frameDriven) report('frame-driven', null, '创意画面没有使用 Remotion 帧驱动动画。')
  if (source.length < 900) report('incomplete', null, '创意画面实现过于简单，未达到完整视频构图要求。')
  return findings
}

/**
 * 场景边界与字幕时间轴的对应性检查。
 *
 * 画面分节必须落在语音句子的接缝上。实测最常出的错误是「按稿件段落猜秒数」：
 * 语音节奏与文本比例差异很大，越往后偏得越多，实测出现画面比语音超前整整两个章节。
 *
 * 判据用「场景边界是否切在句子中间」——这是可靠的、与 ASR 分段密度无关的信号。
 * 注意不能用「边界到最近句首的距离」：语音平均 5 秒一句，任何时刻距离最近句首都只有 1-2 秒，
 * 那个指标恒小，测不出错位（这个坑踩过）。
 *
 * @param source - CreativeVideo.tsx 源码
 * @param srt - inputs/subtitles.srt 内容（真实语音时间轴）
 * @returns 发现的问题列表
 */
export function inspectTimelineAlignment(source, srt) {
  const findings = []
  const report = (code, message) => findings.push({ code, file: 'src/CreativeVideo.tsx', line: 1, column: 1, message })
  // 字幕 cue 的起止时间（秒）
  const cues = []
  const re = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/gu
  let m
  while ((m = re.exec(srt || ''))) {
    const from = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) + Number(m[4]) / 1000
    const to = (Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7])) + Number(m[8]) / 1000
    cues.push({ from, to })
  }
  if (cues.length < 3) return findings
  // 只取 SCENES 表里的场景起点（文件里还有大量动画用的 F()，不能全收）
  const table = /const SCENES[\s\S]*?=\s*\[([\s\S]*?)\]/u.exec(source || '')
  if (!table) return findings
  const starts = []
  const fRe = /start:\s*(?:F|sec|at)\s*\(\s*([\d.]+)\s*\)/gu
  while ((m = fRe.exec(table[1]))) starts.push(Number(m[1]))
  starts.sort((a, b) => a - b)
  if (starts.length < 3) return findings
  // 场景边界落在某条 cue 内部（留 0.6s 容差，避免句子极短时误判）
  const midSentence = []
  for (const t of starts) {
    if (t <= 0.5) continue
    const hit = cues.find((c) => t > c.from + 0.6 && t < c.to - 0.6)
    if (hit) midSentence.push(t)
  }
  const ratio = midSentence.length / starts.length
  if (ratio > 0.34 || midSentence.length > 6) {
    report('timeline-drift', `${starts.length} 个场景里有 ${midSentence.length} 个边界切在语音句子中间（如 ${midSentence.slice(0, 4).map((t) => `${t}s`).join('、')}）：画面分节必须落在字幕 cue 的接缝上，不能按稿件段落估算秒数。请回到 inputs/subtitles.srt，用覆盖该场景主题的那条 cue 的起止时间重定边界。`)
  }
  return findings
}

export async function inspectAgentProject(workspace) {
  const findings = []
  for (const [file, expected] of Object.entries(workspace.protected)) {
    const source = await readFile(join(workspace.projectDir, file), 'utf8').catch(() => null)
    if (source === null || createHash('sha256').update(source).digest('hex') !== expected) findings.push({ code: 'protected-file', file, line: 1, column: 1, message: `受保护文件 ${file} 被修改或丢失。` })
  }
  const creativeSource = await readFile(workspace.creativeFile, 'utf8').catch(() => '')
  if (!creativeSource.trim()) findings.push({ code: 'empty', file: 'src/CreativeVideo.tsx', line: 1, column: 1, message: 'CreativeVideo.tsx 为空。' })
  else {
    findings.push(...inspectCreativeSource(creativeSource))
    // 场景边界必须落在真实语音的时间点上：字幕时间轴是唯一依据，缺失就无从对齐。
    const srt = await readFile(join(workspace.projectDir, 'inputs', 'subtitles.srt'), 'utf8').catch(() => '')
    if (!srt.trim()) findings.push({ code: 'timeline-missing', file: 'inputs/subtitles.srt', line: 1, column: 1, message: '缺少字幕时间轴：画面场景边界必须有真实语音时间可依，请先生成字幕再制作视频。' })
    else findings.push(...inspectTimelineAlignment(creativeSource, srt))
  }
  return {
    passed: findings.length === 0,
    repairable: findings.length > 0 && findings.every((item) => item.code !== 'protected-file'),
    findings,
    failures: findings.map((item) => `${item.file}:${item.line}:${item.column} ${item.message}`),
    creativeBytes: Buffer.byteLength(creativeSource), creativeSource,
  }
}

// The installed workspace copy is a CLI; imports by the host have no side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(await readFile(join(projectDir, 'preflight-manifest.json'), 'utf8'))
  const result = await inspectAgentProject({ projectDir, creativeFile: join(projectDir, 'src/CreativeVideo.tsx'), protected: manifest.protected })
  const { creativeSource, ...report } = result
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = result.passed ? 0 : 1
}
