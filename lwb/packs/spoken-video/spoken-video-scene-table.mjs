// 从导演生成的 Remotion 工程里读场景边界。
//
// 这是**唯一真源**：抽帧门（预检）、场景↔字幕对齐检查（预检）、审片抽帧三处都调它。
//
// 曾经有三份各自独立的正则实现，覆盖范围不一致，代价很具体（2026-10-15 实测 5 个
// 已产出项目，命中率 3/5）：
//
//   · parseSceneSpans（审片抽帧用）—— 裸数字和 F(数字) 都认
//   · sampleFrameNumbers（预检抽帧门）—— 只认 F(数字)，认不出就静默退化为每 5 秒一帧
//   · inspectTimelineAlignment（漂移门）—— 只认带括号的 start: F(...) / sec(...) / at(...)
//
// 于是同一个工程，抽帧门按场景中点抽、漂移门按另一套规则判，两边结论互不参照；而裸数字
// 写法的项目（`start: 0.11`）在预检两道门里都被静默忽略——门报告 pass，实际根本没按
// 场景检查。抽帧门是专门为了抓「只有落到那段才求值」的坏引用（`a4 is not defined`）
// 而设的，静默退化等于把这道门在四成项目上打折。
//
// 现在统一到这里，并且**解析结果分三档显式上报**，退化不再静默：
//   scene-table —— 读到了 SCENES 表，按真实边界抽（最准，且能覆盖最后一幕）
//   anchors     —— 没有 SCENES 表但有时间锚点，按锚点中点抽
//   even        —— 两者都没有，退化为均匀抽样（最弱，调用方应据此发警告）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 从导演生成的 Remotion 工程里读出场景边界（归一成「秒」）。
 *
 * 场景表是 AI 导演写进 src/CreativeVideo.tsx 的，实测写法比预想的多：
 *
 *   ① 字面量秒数        const SCENES = [ { id: "open", start: 0.08, end: 10.18 } ]
 *   ② 秒转帧函数 F()    const F = (sec) => Math.round(sec * 30);
 *                       const SCENES = [ { id: "s01", start: F(3.34), end: F(38.856) } ]
 *   ③ from/dur 字段名   const SCENES = [ { name: "hook", from: 0, dur: 12 } ]
 *   ④ 表名不同          const NARRATION_SCENES = [ ... ]
 *
 * 2026-10-15 统计 75 个仍留有工程目录的历史成片：47 个走 ①②（scene-table 档），
 * 10 个只有 F() 锚点（anchors 档），18 个曾落到最弱的均匀抽样档——其中多数其实
 * 写了表，只是用了 ③④（f3a1184d 用 from/dur、874fdf7d 叫 NARRATION_SCENES、
 * 45bb2a63 的表被包在注释里）。覆盖面不足会让「解析不出」被误当成「没有场景表」。
 *
 * 求值不做真正的 JS 求值——只支持「函数名(数字)」这一种调用，参数是表达式就放弃，
 * 交给调用方退回盲选。宁可少解析几条，也不能解析出错的边界：那会让抽帧对齐到错误的
 * 位置，比盲选更糟（看起来「修好了」实际更偏）。
 *
 * @param source - src/CreativeVideo.tsx 源码
 * @returns 场景列表 [{ id, start, end }]，单位秒；读不出返回空数组
 */
export function parseSceneSpans(source) {
  if (typeof source !== 'string' || !source) return []
  const lines = source.split(/\r?\n/u)
  const start = findSceneTableLine(lines)
  if (start === -1) return []

  // 本文件里所有「单参数 → 数字」的辅助函数。名字来自形如
  //   const F = (sec: number) => Math.round(sec * 30);
  // 的定义；只认单参数、且函数体是「参数 * 常数」这种可线性求值的形态。
  // fps 先算出来，好让 `s * fps` 这种乘变量的写法也能定出单位。
  const fps = detectFps(source)
  const unitFor = helperUnitFns(source, fps)

  const spans = []
  // `frameUnit` 表示这条 start/end 是帧还是秒。字面量写法通常是秒，F() 写法是帧
  // （F(3.34) = 3.34*30 帧）。混用时按行判断：这一行用了 F() 就是帧。
  let sawFrameUnit = null
  // 从声明行本身开始扫——单行写法 `const SCENES = [{ id: "a", ... }];` 的场景对象
  // 就在这一行上，从下一行开始会整片漏掉。
  for (let index = start; index < lines.length && index < start + 401; index += 1) {
    const line = lines[index]
    // 声明行只取 `=` 之后的部分（前面是 `const SCENES: T[] =`，含类型标注里的
    // 花括号，不能当场景对象切）。类型标注本身要跳过——实测有
    // `const SCENES: Array<{ from: number; dur: number }> = [` 这种写法，
    // 标注里的 { from: number; dur: number } 会被切成一个"场景"，读到
    // from: number 求值失败（返回 null），还算幸运；写成 `from: 0` 的默认值就会
    // 读出一个假边界。
    const target = index === start ? stripTypeArgument(line.slice(line.indexOf('=') + 1)) : line
    // 同行可能有多个场景对象（单行写法），逐个 `{...}` 切开处理。
    for (const part of target.split(/(?=\{\s*(?:id|name|start|from)\s*:)/u)) {
      if (!/\b(?:id|name|start|from)\s*:/u.test(part)) continue
      const named = /\b(?:id|name)\s*:\s*["'`]([^"'`]+)["'`]/u.exec(part)
      // 名字：id 最常见，但实测有 10 条只写 name。都没有就用序号——名字只是给审片
      // 看的标签，缺了不影响抽帧位置。
      const id = named?.[1] || `#${spans.length + 1}`
      // 字段名实测有两套：start/end 与 from/dur（或 from/to）。
      // 边界值一直取到逗号或行尾/右括号，而不是遇到第一个空格就停：`start: 1 + 2`
      // 会被截成 "1"，当成字面量 1 读进来——那是在**猜**一个错误的边界，比解析失败
      // 更糟（抽帧会对齐到错误位置，看起来「修好了」实际更偏）。取完整 token 后交给
      // readBoundary 判断，只认「纯数字」和「辅助函数(数字)」两种能真正求值的形态。
      const startToken = fieldToken(part, ['start', 'from'])
      const endToken = fieldToken(part, ['end', 'to'])
      // 也认 dur 写法（实测 8 条）：`{ id: "hook", start: F(0), dur: F(12) }`。
      // end = start + dur，与 JS 里 Remotion <Sequence durationInFrames> 的语义一致。
      const durToken = fieldToken(part, ['dur', 'duration'])
      const first = readBoundary(startToken, unitFor)
      let last = readBoundary(endToken, unitFor)
      if (last === null && first !== null) {
        const dur = readBoundary(durToken, unitFor)
        if (dur !== null) last = first + dur
      }
      if (first === null || last === null) continue
      if (!(last > first)) continue
      // 单位：这个场景的边界是帧还是秒。字段名本身就是线索——from/to/dur 是 Remotion
      // <Sequence from durationInFrames> 的原生命名，值恒为帧；start/end 是我们约定的秒。
      // 混用时以第一次遇到的为准。
      const frameUnit = isFrameToken(startToken) || isFrameToken(endToken) || isFrameToken(durToken)
        || fieldToken(part, ['from']) !== undefined || fieldToken(part, ['dur', 'duration']) !== undefined
      if (sawFrameUnit === null) sawFrameUnit = frameUnit
      spans.push({ id, start: first, end: last, frameUnit })
    }
    // 数组闭合：声明行之后，出现 ']' 就结束（多行与单行写法都覆盖）。
    if (index > start && /\]\s*(?:as\s+const\s*)?;?\s*$/u.test(line)) break
  }
  // 统一归一成「秒」：调用方（reviewTimestamps、抽帧、比对片长）全都按秒工作，
  // 混着帧和秒会让抽帧点算到片长之外去。
  //
  // 写了辅助函数却定不出它的乘数时**丢弃整张表**，不按秒硬读：那种情况下 849 很可能是
  // 帧号，当成秒会得到 28 分钟的「场景」，抽帧直接落到片长之外——看起来门通过了，
  // 实际一个场景都没盖住（实测有条工程写 `const f = (s) => s * fps`，fps 来自 props）。
  // 丢表后调用方退回 anchors/even 档并如实上报退化，比猜错好得多。
  // fps 取不到时退回 30：渲染管线固定 30fps（task-props 与 QC 都按 30 判），
  // 而 from/dur 的值必须按帧解释——定不出乘数就按事实标准换算，比丢表强。
  if (sawFrameUnit) {
    const unit = fps > 0 ? fps : 30
    return spans.map((span) => ({ id: span.id, start: span.start / unit, end: span.end / unit }))
  }
  return spans.map(({ frameUnit, ...span }) => span)
}

/** 读一个字段的值（按 names 顺序取第一个存在的），取完整 token 而不是遇到空格就停。 */
function fieldToken(part, names) {
  for (const name of names) {
    const found = new RegExp(`\\b${name}\\s*:\\s*(.+?)\\s*(?:,|\\}|$)`, 'u').exec(part)
    if (found) return found[1]
  }
  return undefined
}

/**
 * 剥掉声明行里 `=` 之前的类型标注残留。
 *
 * `const SCENES: Array<{ from: number; dur: number }> = [` 的 `=` 右侧其实很干净，
 * 但 `Array<...>` 里的花括号会让「按 `{` 切场景对象」的逻辑把类型成员当成场景：
 * `from: number` 求值失败被跳过还算运气，若写成 `from: number = 0` 这类带默认值的
 * 形态就会读出一个假边界。这里显式从 `[` 之后才开始切，类型标注一律不看。
 */
function stripTypeArgument(text) {
  const arrayStart = text.indexOf('[')
  return arrayStart === -1 ? text : text.slice(arrayStart)
}

/**
 * 定位场景表的声明行。认 SCENES 及常见别名（NARRATION_SCENES / VIDEO_SCENES 等），
 * 但**跳过注释里的表**——实测有条工程把 SCENES 写在块注释的说明里，源码里有、
 * 运行时却没有，照着它抽帧会抽到不存在的场景。
 *
 * 必须跟踪块注释状态：块内的行不以 `/*` 开头，光看行首认不出来。
 */
function findSceneTableLine(lines) {
  let inBlockComment = false
  for (const [index, line] of lines.entries()) {
    const code = stripComments(line, inBlockComment)
    inBlockComment = endsInsideBlockComment(line, inBlockComment)
    if (!code) continue
    if (!/(?:const|var|let)\s+\w*SCENES\w*\s*(?::[^=]+)?=/u.test(code)) continue
    return index
  }
  return -1
}

/** 去掉行内注释（含块注释跨越到本行的部分），只留代码。 */
function stripComments(line, inBlockComment) {
  let out = ''
  let block = inBlockComment
  for (let i = 0; i < line.length; i += 1) {
    const two = line.slice(i, i + 2)
    if (block) {
      if (two === '*/') { block = false; i += 1 }
      continue
    }
    if (two === '/*') { block = true; i += 1; continue }
    if (two === '//') break
    out += line[i]
  }
  return out
}

/** 处理完本行后，是否处于块注释内部。 */
function endsInsideBlockComment(line, inBlockComment) {
  let block = inBlockComment
  for (let i = 0; i < line.length; i += 1) {
    const two = line.slice(i, i + 2)
    if (block) { if (two === '*/') { block = false; i += 1 } continue }
    if (two === '/*') { block = true; i += 1; continue }
    if (two === '//') break
  }
  return block
}

/**
 * 场景边界是怎么读出来的——抽帧门退化时要如实上报，不能静默降级。
 * @returns 'scene-table' | 'anchors' | 'even'
 */
export function sceneBoundaryMode(source) {
  if (parseSceneSpans(source).length >= 2) return 'scene-table'
  if (timeAnchors(source).length >= 2) return 'anchors'
  return 'even'
}

/**
 * 抽帧计划：给出要渲染的帧号，以及边界是从哪读出来的。
 *
 * 三个档次的覆盖能力依次递减，调用方可以据此决定要不要发警告：
 *
 *   scene-table 按每个场景自身的中点抽。覆盖每一幕的组件体，**包括最后一幕**——
 *     旧实现只取「相邻起点之间的中点」，最后一幕的区间从没被抽到过。
 *   anchors     没有 SCENES 表，退回源码里的 F(秒) 锚点。不能简单两两配对：同一场景里
 *     常有 0.2s 级的次级动画锚点（F(0) 是入点、F(0.2) 是入场结束），那样会把它切成
 *     一个独立「场景」，既抽到无意义的帧，又在末尾多出一段（2026-10-08 单测实测多抽
 *     2 帧）。所以先按「场景至少 0.5 秒」把密集锚点并成场景起点，再取相邻起点中点。
 *   even        两者都没有，每 5 秒一帧。覆盖不完整也比只验加载期强，但必须让调用方知道。
 *
 * @param source - src/CreativeVideo.tsx 源码
 * @param totalFrames - 成片总帧数
 * @param fps - 帧率
 * @returns { frames: number[], mode: 'scene-table'|'anchors'|'even' }
 */
export function sceneSamplePlan(source, totalFrames, fps = 30) {
  const spanFrames = []
  const spans = parseSceneSpans(source)
  if (spans.length >= 2) {
    // 场景起点 0 通常留一小段引子（实测有 s00-gutter），中点天然避开入场动画期。
    for (const span of spans) {
      const mid = Math.round(((span.start + span.end) / 2) * fps)
      spanFrames.push(Math.max(0, Math.min(totalFrames - 1, mid)))
    }
    const unique = [...new Set(spanFrames)]
    if (unique.length) return { frames: unique, mode: 'scene-table' }
  }

  const anchors = timeAnchors(source)
  if (anchors.length >= 2) {
    const starts = [anchors[0]]
    for (const value of anchors.slice(1)) {
      if (value - starts[starts.length - 1] >= 0.5) starts.push(value)
    }
    if (starts.length >= 2) {
      const frames = []
      for (let i = 0; i + 1 < starts.length; i += 1) {
        const mid = Math.round(((starts[i] + starts[i + 1]) / 2) * fps)
        frames.push(Math.max(0, Math.min(totalFrames - 1, mid)))
      }
      if (frames.length) return { frames: [...new Set(frames)], mode: 'anchors' }
    }
  }

  const fallback = []
  for (let second = 2; second * fps < totalFrames; second += 5) fallback.push(Math.round(second * fps))
  return { frames: fallback, mode: 'even' }
}

/** 源码里所有 F(数字) 形式的时间锚点（秒，升序去重）。 */
function timeAnchors(source) {
  if (typeof source !== 'string' || !source) return []
  const seconds = [...source.matchAll(/\bF\((\d+(?:\.\d+)?)\)/gu)].map((m) => Number(m[1]))
  return [...new Set(seconds)].filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b)
}

/** 读工程的 src/CreativeVideo.tsx；读不到返回空串（交给上层判定，不要抛）。 */
export function readCreativeSource(projectDir) {
  try { return readFileSync(join(projectDir, 'src', 'CreativeVideo.tsx'), 'utf8') } catch { return '' }
}

function isFrameToken(token) {
  return typeof token === 'string' && /^[A-Za-z_$][\w$]*\s*\(/u.test(token.trim())
}

/** 帧率。优先取工程里显式声明的 FPS 常量，其次取辅助函数的乘数（30fps 是事实标准）。 */
function detectFps(source) {
  const declared = /(?:export\s+)?(?:const|let|var)\s+(?:FPS|FRAME_RATE|fps)\s*(?::[^=]+)?=\s*(\d+(?:\.\d+)?)/u.exec(source)
  if (declared && Number(declared[1]) > 0) return Number(declared[1])
  for (const unit of helperUnitFns(source).values()) return unit
  return 0
}

/**
 * 扫出「秒→帧」之类的线性辅助函数，返回 名字 → 每单位的帧数。
 *
 * 认的定义形态（2026-10-10 实测导演只写这几种）：
 *   const F = (sec: number) => Math.round(sec * 30);
 *   const f = (s) => Math.round(s * 30)
 *   const toFrame = (sec: number): number => Math.round(sec * FPS);
 * 取「参数 * 30」里的 30；乘的是变量（`s * fps`）时回查那个变量的定义。
 * 取不到就返回空表（那一条按字面量读）。
 */
function helperUnitFns(source, fps = 0) {
  const units = new Map()
  const pattern = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?\)\s*(?::\s*number\s*)?=>\s*(?:Math\.(?:round|floor|ceil)\s*\(\s*)?\2\s*\*\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/gu
  const constants = numberConstants(source)
  for (const match of source.matchAll(pattern)) {
    const raw = match[3]
    const unit = /^\d/u.test(raw) ? Number(raw) : (constants.get(raw) ?? 0)
    if (Number.isFinite(unit) && unit > 0) units.set(match[1], unit)
  }
  // 兜底：函数体乘的是我们不认识的变量，但 FPS 常量本身已知时按它算。
  if (!units.size && fps > 0) {
    const loose = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?\)\s*(?::\s*number\s*)?=>\s*(?:Math\.(?:round|floor|ceil)\s*\(\s*)?\2\s*\*\s*[A-Za-z_$][\w$]*/gu
    for (const match of source.matchAll(loose)) units.set(match[1], fps)
  }
  return units
}

/** 源码里所有「名字 = 数字」的顶层常量（fps、FPS、frameRate 等），用于回查乘数。 */
function numberConstants(source) {
  const constants = new Map()
  const pattern = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(\d+(?:\.\d+)?)\b/gu
  for (const match of source.matchAll(pattern)) {
    const value = Number(match[2])
    if (Number.isFinite(value) && value > 0) constants.set(match[1], value)
  }
  return constants
}

/**
 * 读一个边界值：字面量数字，或「辅助函数(数字)」调用。求不出来返回 null。
 *
 * 刻意不 eval：start/end 的值来自 AI 生成的代码，eval 相当于执行它。
 */
function readBoundary(token, unitFor) {
  if (typeof token !== 'string') return null
  const literal = /^-?\d+(?:\.\d+)?$/u.exec(token.trim())
  if (literal) return Number(literal[0])
  const call = /^([A-Za-z_$][\w$]*)\(\s*(-?\d+(?:\.\d+)?)\s*\)$/u.exec(token.trim())
  if (!call) return null
  const unit = unitFor.get(call[1])
  if (!unit) return null
  return Number(call[2]) * unit
}