// 场景 ↔ 字幕句的映射契约。
//
// 要解决的问题：配音侧已经有逐句地面真值（段级 ffprobe 实测、句级 VAD），
// 但它只被拿去生成 SRT。到了画面侧，"第 12 句该配第 3 幕"这个映射没有任何
// 结构化记录——AI 读 inputs/subtitles.srt 自己抄秒数写进 SCENES 表。
//
// 现状的检查只有 timeline-drift 一个统计门（有多少边界切在句子中间），
// 它只能回答"有多少处切错了"，回答不了"这一幕到底该讲哪几句"。出现音画
// 不同步时也无法定位到具体是哪一幕越界。
//
// 这里让导演在 SCENES 旁边并列声明 cueRange（这一幕覆盖第几条到第几条 cue，
// 从 1 开始），机器据此核对三件事：
//
//   覆盖完整  每一幕声明的 cue 区间的并集应当覆盖全部 cue。不完整说明有字幕
//             从未被任何一幕认领——画面就会在讲话的同时什么都不显示。
//   无重叠    相邻两幕不该大面积认领同一段字幕。轻微交叠说明边界划分含混。
//   接缝对齐  声明的 cue 区间与该幕实际起止时间应当吻合。这一条最关键：
//             它把「AI 抄的秒数」与「AI 声称的句子」互相印证——只说秒数时
//             秒数无从校验，两者都声明后至少内部自洽。
//
// 三条容差都按真实数据定的（2026-10-15 回放 49 个历史工程，量了 1189 个场景边界）：
//   接缝 1.5 秒  场景边界与最近 cue 边界的偏差 p50=0s、p90=0.61s、98% 在 1.0s 内。
//                 1.5 秒放过 99%，同时仍能揭穿整体错位（错 2 秒 100% 抓到）。
//   重叠 50%    一句话没说完就切画面是常态（实测有句子 40% 落在两幕重叠区）。
//   缺口 3 秒    场景之间有 0.4-1 秒转场间隙，字幕常比画面切得细。
//
// 设计上只产 warning、不阻塞渲染，也不新增必填字段：导演不写 cueRange 时
// 整条链路照旧工作（退化为现有 timeline-drift 一个门）。这是渐进加固，
// 不是契约强制——强制会让"机器可校验"变成"机器可拒绝"，把创作自由换来的
// 稳定性还回去。

/** 声明的句子与该幕起止时间允许差多少秒。 */
const SCENE_CUE_SEAM_TOLERANCE_SECONDS = 1.5
/** 一句话有多大比例落在两幕重叠区才算「分幕含混」（其余是正常的切画面时机）。 */
const SCENE_CUE_OVERLAP_RATIO = 0.5
/** 未被认领的语音累计超过多少秒才算「长时间无画面」。 */
const SCENE_CUE_GAP_TOLERANCE_SECONDS = 3

/**
 * 从导演源码里读出 SCENES 表旁边并列的 cueRange 声明。
 *
 * 认的形态（与场景表字段名一样，容忍多种写法）：
 *   { id: "s01", start: 0, end: 5, cues: [1, 3] }
 *   { id: "s02", start: 5, end: 9, cueRange: [4, 6] }
 *
 * @returns [{ id, start, end, cues: [from, to] }]，读不出声明返回空数组
 */
export function parseSceneCueMap(source, spans) {
  if (typeof source !== 'string' || !source || !Array.isArray(spans) || !spans.length) return []
  const lines = source.split(/\r?\n/u)
  const declared = lines.findIndex((line) => /(?:const|var|let)\s+\w*SCENES\w*\s*(?::[^=]+)?=/u.test(line))
  if (declared === -1) return []
  const chunk = lines.slice(declared, declared + 401).join('\n')
  const ranges = new Map()
  // 逐个场景对象切出来，按出现顺序与 spans 对齐——SCENES 的顺序就是播放顺序，
  // 用顺序配对比按 id 匹配更稳（id 可能缺失，序号是现成的）。
  for (const part of chunk.split(/(?=\{\s*(?:id|name|start|from)\s*:)/u)) {
    const named = /\b(?:id|name)\s*:\s*["'`]([^"'`]+)["'`]/u.exec(part)
    const range = /\bcue(?:s|Range)?\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/u.exec(part)
    if (!range) continue
    const from = Number(range[1])
    const to = Number(range[2])
    if (!(to >= from) || from < 1) continue
    ranges.set(named?.[1] ?? null, [from, to, named?.[1] ?? null])
  }
  const out = []
  const ordered = [...ranges.values()]
  for (const [index, span] of spans.entries()) {
    const hit = ranges.get(span.id) ?? ordered[index]
    if (!hit) continue
    out.push({ id: span.id, start: span.start, end: span.end, cues: [hit[0], hit[1]] })
  }
  return out
}

/**
 * 核对场景与字幕的对应关系。
 *
 * @param sceneCues - parseSceneCueMap 的结果
 * @param cues - 字幕 cue 列表 [{ startMs, endMs }] 或 SRT 解析结果 [{ start, end }]
 * @returns [{ code, message }]，一切正常返回空数组
 */
export function inspectSceneCueCoverage(sceneCues, cues) {
  if (!Array.isArray(sceneCues) || sceneCues.length < 2) return []
  if (!Array.isArray(cues) || cues.length < 3) return []
  const problems = []
  const total = cues.length

  // 1) 覆盖完整：没有一幕认领过的 cue，就是画面在讲话时什么都不显示的区间。
  //    但场景之间本来就有转场间隙（实测有 0.4-1 秒），字幕切得比画面细时，
  //    边界附近的句子会落在缝里。所以按「没被认领的语音时长」算，不按条数：
  //    缝隙累计超过 SCENE_CUE_GAP_TOLERANCE_SECONDS 才报——那才是真的长时间无画面。
  const claimed = new Set()
  for (const scene of sceneCues) {
    for (let i = scene.cues[0]; i <= scene.cues[1]; i += 1) claimed.add(i)
  }
  const missing = []
  let missingSeconds = 0
  for (let i = 1; i <= total; i += 1) {
    if (claimed.has(i)) continue
    missing.push(i)
    const cue = cues[i - 1]
    if (cue) missingSeconds += Math.max(0, cueEnd(cue) - cueStart(cue))
  }
  if (missing.length && missingSeconds > SCENE_CUE_GAP_TOLERANCE_SECONDS) {
    problems.push({
      code: 'scene-cue-gap',
      message: `有 ${missing.length} 条字幕（共 ${missingSeconds.toFixed(1)} 秒语音）没有被任何场景认领（${preview(missing)}）：这段时间配音在讲，画面却没有对应内容。请补一个场景覆盖它们，或修正 cueRange。`,
    })
  }

  // 2) 无重叠。真实的语音里「一句话没说完就切画面」是常态——场景边界落在句子
  //    中间很常见（cue 40 横跨 106.5-108.3，两幕边界恰在 106.9）。所以只把
  //    **大幅**重叠当问题：一句字幕被两幕同时「主要认领」才说明分幕标准含混。
  //    判据是重叠幅度占该句时长的比例，而不是有没有重叠。
  const overlaps = []
  for (let i = 1; i < sceneCues.length; i += 1) {
    const prev = sceneCues[i - 1]
    const cur = sceneCues[i]
    const lo = Math.max(prev.cues[0], cur.cues[0])
    const hi = Math.min(prev.cues[1], cur.cues[1])
    if (lo > hi) continue
    for (let k = lo; k <= hi; k += 1) {
      const cue = cues[k - 1]
      if (!cue) continue
      const startSec = cueStart(cue)
      const endSec = cueEnd(cue)
      if (!(endSec > startSec)) continue
      // 这一句落在两幕重叠区里的时长，占该句的比例。
      const overlapStart = Math.max(startSec, Math.min(prev.end, cur.start))
      const overlapEnd = Math.min(endSec, Math.max(prev.end, cur.start))
      const ratio = Math.max(0, overlapEnd - overlapStart) / (endSec - startSec)
      if (ratio > SCENE_CUE_OVERLAP_RATIO) {
        overlaps.push(`第 ${k} 句有 ${(ratio * 100).toFixed(0)}% 落在 ${prev.id || '#' + i} 与 ${cur.id || '#' + (i + 1)} 的重叠区`)
        break
      }
    }
  }
  if (overlaps.length) {
    problems.push({
      code: 'scene-cue-overlap',
      message: `相邻场景的主要覆盖范围交叠（${overlaps.slice(0, 3).join('；')}）。分幕标准不清，画面会在同一句话上犹豫该归哪一幕。请重新划分 cueRange，让每句字幕主要属于一幕。`,
    })
  }

  // 3) 接缝对齐：声明的 cue 与该幕实际起止时间应当吻合。这是把「秒数」与
  //    「句子」互相印证的关键——两者都声明后，抄错的秒数会自己露出来。
  const mismatched = []
  for (const scene of sceneCues) {
    const first = cues[scene.cues[0] - 1]
    const last = cues[scene.cues[1] - 1]
    if (!first || !last) {
      mismatched.push(`${scene.id || '?'}(cue ${scene.cues.join('-')} 超出字幕范围)`)
      continue
    }
    const startSec = cueStart(first)
    const endSec = cueEnd(last)
    if (!(startSec >= 0) || !(endSec >= 0)) continue
    // 容差取 1.5 秒。实测 1189 个历史场景边界与最近 cue 边界的偏差：p50=0s、
    // p90=0.61s、98% 在 1.0 秒内——语音有前导静音和换气，场景切点本就不该
    // 精确落在 cue 边界上。1.5 秒放过 99%，同时仍能揭穿整体错位（实测整体
    // 错 2 秒 100% 抓到）。
    if (Math.abs(scene.start - startSec) > SCENE_CUE_SEAM_TOLERANCE_SECONDS || Math.abs(scene.end - endSec) > SCENE_CUE_SEAM_TOLERANCE_SECONDS) {
      mismatched.push(`${scene.id || '?'}(声明 ${scene.cues.join('-')}=${startSec.toFixed(1)}-${endSec.toFixed(1)}s，实际 ${scene.start.toFixed(1)}-${scene.end.toFixed(1)}s)`)
    }
  }
  if (mismatched.length > Math.max(1, sceneCues.length * 0.34)) {
    problems.push({
      code: 'scene-cue-drift',
      message: `${mismatched.length}/${sceneCues.length} 个场景声称覆盖的字幕与它实际的时间区间对不上（如 ${mismatched.slice(0, 3).join('；')}）。秒数和 cueRange 至少有一个是错的：请让二者一致，回到 inputs/subtitles.srt 核对。`,
    })
  }

  return problems
}

const preview = (values) => {
  const head = values.slice(0, 5).join('、')
  return values.length > 5 ? `${head} 等 ${values.length} 条` : head
}

const cueStart = (cue) => Number.isFinite(cue?.startMs) ? cue.startMs / 1000 : Number(cue?.start)
const cueEnd = (cue) => Number.isFinite(cue?.endMs) ? cue.endMs / 1000 : Number(cue?.end)