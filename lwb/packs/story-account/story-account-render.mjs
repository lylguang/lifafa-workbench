// Remotion 竖屏成片搭建。
//
// 与 spoken-video 的渲染器共享同一份 Remotion 安装与同一个 node_modules，
// 但**不共享工程模板**：情感故事的画面语言和知识口播完全不同。
//
// 知识口播是「一张图 + 大字标题 + 要点条」，信息密度靠递增的条目撑；
// 情感故事是「一句话就是全部画面」，观众要有时间跟着一句话沉下去。
// 把要点条、编号、进度水印搬过来，会立刻显得像 PPT 而非故事。
//
// 所以本模块自己生成 Root / Composition / 画面组件三份源码，风格取向是：
//   · 暖色低饱和底 + 宣纸纹理噪点，贴近深夜手机的观看环境
//   · 一句一段，逐字淡入，不存在「同时出现一屏文字」
//   · 字幕在下三分之一安全区内，不压脸、不盖住画面主体
//   · 全片不做花哨转场——转场会打断情绪，情感故事最怕被打断

import { copyFile, lstat, mkdir, readFile, realpath, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveRemotionBrowserExecutable } from './story-account-remotion-browser.mjs'

const execFileAsync = promisify(execFile)
const PACK_ROOT = dirname(fileURLToPath(import.meta.url))
export const APP_NODE_MODULES = resolve(PACK_ROOT, '../../..', 'node_modules')
// Windows 上 .bin/remotion 是 bash 脚本，无法 spawn；直接用 node 跑 CLI 的 JS 入口。
const REMOTION_CLI = join(APP_NODE_MODULES, '@remotion', 'cli', 'remotion-cli.js')

export const STORY_COMPOSITION_ID = 'StoryAccountVideo'
export const STORY_RENDER_SPEC = Object.freeze({ width: 1080, height: 1920, fps: 30 })

export class StoryRenderError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoryRenderError'
    this.code = code
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function exists(path) {
  return Boolean(await lstat(path).catch(() => null))
}

/**
 * 把仓库级的 node_modules 逐项链接进任务目录。
 *
 * 不整目录软链：Remotion 的 webpack 会在任务目录里写 .cache，整目录软链会把
 * 缓存写回共享目录，两个任务并发渲染时互相踩。所以只有依赖本身是链接，
 * .cache 是任务内的真目录。
 */
export async function ensureStoryDependencies(projectDir) {
  const target = join(projectDir, 'node_modules')
  const info = await lstat(target).catch(() => null)
  if (info?.isSymbolicLink()) {
    if (await realpath(target) !== await realpath(APP_NODE_MODULES)) throw new StoryRenderError('STORY_RENDER_LAYOUT_INVALID', '任务依赖链接指向未知目录。')
    await unlink(target)
  } else if (info && !info.isDirectory()) {
    throw new StoryRenderError('STORY_RENDER_LAYOUT_INVALID', '任务依赖目录无效。')
  }
  await mkdir(target, { recursive: true, mode: 0o700 })
  const entries = await readdir(APP_NODE_MODULES)
  for (const name of entries.filter((entry) => !entry.startsWith('.') || entry === '.bin')) {
    const link = join(target, name)
    if (!await exists(link)) await symlink(join(APP_NODE_MODULES, name), link)
  }
  const cache = join(target, '.cache')
  const cacheInfo = await lstat(cache).catch(() => null)
  if (cacheInfo?.isSymbolicLink()) throw new StoryRenderError('STORY_RENDER_LAYOUT_INVALID', '任务缓存不得链接到共享目录。')
  await mkdir(cache, { recursive: true, mode: 0o700 })
}

/** Remotion 是否可用：CLI 入口存在即视为可用，真正能不能跑由渲染时暴露。 */
export async function storyRemotionAvailable() {
  return exists(REMOTION_CLI)
}

/* --------------------------------- 源码 --------------------------------- */

function entrySource() {
  return [
    'import { registerRoot } from "remotion";',
    'import { StoryRoot } from "./Root";',
    '',
    'registerRoot(StoryRoot);',
    '',
  ].join('\n')
}

function rootSource() {
  return [
    'import React from "react";',
    'import { Composition, getInputProps } from "remotion";',
    'import { StoryAccountVideo, type StoryVideoProps } from "./StoryAccountVideo";',
    '',
    `export const StoryRoot: React.FC = () => {`,
    '  const props = getInputProps() as StoryVideoProps;',
    '  const fps = Math.max(1, Number(props.fps || 30));',
    '  const durationSeconds = Math.max(1, Number(props.durationSeconds || 1));',
    '  return (',
    '    <Composition',
    `      id="${STORY_COMPOSITION_ID}"`,
    '      component={StoryAccountVideo}',
    `      width={${STORY_RENDER_SPEC.width}}`,
    `      height={${STORY_RENDER_SPEC.height}}`,
    '      fps={fps}',
    '      durationInFrames={Math.max(1, Math.ceil((durationSeconds + 0.1) * fps))}',
    '      defaultProps={props}',
    '    />',
    '  );',
    '};',
    '',
  ].join('\n')
}

/**
 * 画面组件源码。
 *
 * 三件事值得单独说明：
 *
 * 1. **正文和字幕不能同时显示同一句话。** 第一版两处各渲染一遍，实测同一帧上
 *    出现了两遍「年初三晚上，我在厨房说完这句」，视觉上像卡带。现在的分工：
 *    有字幕时正文只作为背景运镜（大字号、低透明度），字幕承担阅读；没字幕时
 *    正文才是唯一文本。
 * 2. **逐字淡入必须在本拍结束前完成。** 第一版按整拍百分比推进，一拍 4 秒时
 *    到 2 秒才刚显出一半字——观众听到的比看到的多。改成按「本拍时长 - 0.6 秒」
 *    折算固定速度，保证说完就显完。
 * 3. 字幕在下三分之一：正文在上三分之一，听众的眼神不用在两个位置之间跳。
 */
function compositionSource() {
  return [
    'import React from "react";',
    'import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";',
    '',
    'type Subtitle = { id: string; startMs: number; endMs: number; text: string };',
    'type Beat = { startPercent: number; endPercent: number; text: string };',
    'export type StoryVideoProps = {',
    '  title: string;',
    '  beats: Beat[];',
    '  audioFileName: string;',
    '  durationSeconds: number;',
    '  fps: number;',
    '  subtitleEnabled: boolean;',
    '  subtitles: Subtitle[];',
    '  palette: { background: string; ink: string; muted: string; accent: string };',
    '};',
    '',
    'const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };',
    '',
    'const Grain: React.FC = () => (',
    '  <AbsoluteFill',
    '    style={{',
    '      backgroundImage:',
    '        "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.06), transparent 55%)," +',
    '        "radial-gradient(circle at 70% 80%, rgba(0,0,0,0.18), transparent 60%)",',
    '      pointerEvents: "none",',
    '    }}',
    '  />',
    ');',
    '',
    '/**',
    ' * 逐字淡入。',
    ' * revealProgress 是 0-1 的「本拍已显示进度」，由调用方按固定速度折算好，',
    ' * 这里不关心时长——它只负责把进度摊到每个字上。',
    ' */',
    'const FadeWords: React.FC<{ text: string; revealProgress: number; color: string; size: number; weight: number; letterSpacing: string }> = ({ text, revealProgress, color, size, weight, letterSpacing }) => {',
    '  const chars = Array.from(text);',
    '  return (',
    '    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0.06em", lineHeight: 1.5 }}>',
    '      {chars.map((char, index) => {',
    '        // 全部字的起点压在 0-0.72，最后一个字也在 0.9 之前显完；',
    '        // 留出的尾巴就是「读完还能看一眼」的时间。',
    '        const at = chars.length <= 1 ? 0 : (index / chars.length) * 0.72;',
    '        const alpha = interpolate(revealProgress, [at, Math.min(0.9, at + 0.18)], [0, 1], clamp);',
    '        return (',
    '          <span key={index} style={{ color, fontSize: size, fontWeight: weight, opacity: alpha, letterSpacing }}>',
    '            {char}',
    '          </span>',
    '        );',
    '      })}',
    '    </div>',
    '  );',
    '};',
    '',
    'const Captions: React.FC<{ enabled: boolean; subtitles: Subtitle[] }> = ({ enabled, subtitles }) => {',
    '  const frame = useCurrentFrame();',
    '  const { fps, height } = useVideoConfig();',
    '  const now = (frame / fps) * 1000;',
    '  const active = subtitles.find((cue) => now >= cue.startMs && now < cue.endMs);',
    '  if (!enabled || !active) return null;',
    '  const chars = Math.max(1, Array.from(active.text).length);',
    '  const size = Math.max(40, Math.min(58, Math.floor(940 / Math.max(9, Math.ceil(chars / 2)))));',
    '  return (',
    '    <div style={{ position: "absolute", left: 0, right: 0, bottom: Math.round(height * 0.22), display: "flex", justifyContent: "center", padding: "0 64px" }}>',
    '      <span style={{ color: "#FFFFFF", fontSize: size, fontWeight: 700, lineHeight: 1.35, textAlign: "center", textShadow: "0 2px 14px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.95)" }}>',
    '        {active.text}',
    '      </span>',
    '    </div>',
    '  );',
    '};',
    '',
    'export const StoryAccountVideo: React.FC<StoryVideoProps> = (props) => {',
    '  const frame = useCurrentFrame();',
    '  const { fps, durationInFrames } = useVideoConfig();',
    '  const progress = durationInFrames <= 1 ? 0 : frame / (durationInFrames - 1);',
    '  const beats = props.beats?.length ? props.beats : [{ startPercent: 0, endPercent: 1, text: props.title || "" }];',
    '  const index = Math.max(0, beats.findIndex((beat) => progress >= beat.startPercent && progress < beat.endPercent));',
    '  const beat = beats[index] || beats[beats.length - 1];',
    '  const span = Math.max(0.0001, beat.endPercent - beat.startPercent);',
    '  const beatSeconds = Math.max(0.3, span * props.durationSeconds);',
    '  const elapsed = (progress - beat.startPercent) * props.durationSeconds;',
    '  //',
    '  // 逐字显示要抢在「读到」之前完成，所以不是严格按本拍时长摊，而是：',
    '  // 前 0.25 倍时长把字全部显完，剩下的时间留给观众读完、看画面。',
    '  // 第一版按整拍线性推进，一拍 4.7 秒时到第 2.7 秒才显到「把碗」——',
    '  // 观众听到第 6 个字，画面上还没显出来，抽帧能直接看到这句被截断。',
    '  const revealSeconds = Math.max(0.35, Math.min(1.6, beatSeconds * 0.25));',
    '  const revealProgress = Math.min(1, Math.max(0, elapsed / revealSeconds));',
    '  // 拍与拍之间的冷场：0.3 秒淡入、0.2 秒淡出，形成「一句一顿」的呼吸。',
    '  const fadeIn = interpolate(elapsed, [0, Math.min(0.3, beatSeconds * 0.4)], [0, 1], clamp);',
    '  const fadeOut = interpolate(elapsed, [Math.max(0, beatSeconds - 0.2), beatSeconds], [1, 0.88], clamp);',
    '  const palette = props.palette;',
    '  const hasCaptions = props.subtitleEnabled && (props.subtitles || []).length > 0;',
    '  return (',
    '    <AbsoluteFill style={{ backgroundColor: palette.background }}>',
    '      <Grain />',
    '      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 88px" }}>',
    '        <div style={{ transform: `translateY(${(1 - fadeIn) * 16}px)`, opacity: fadeIn * fadeOut, width: "100%" }}>',
    '          {hasCaptions',
    '            // 有字幕时：正文退成背景运镜（大字、低透明度），阅读交给字幕。',
    '            ? <div style={{ opacity: 0.22 }}><FadeWords text={beat.text} revealProgress={revealProgress} color={palette.ink} size={104} weight={700} letterSpacing="0.04em" /></div>',
    '            : <FadeWords text={beat.text} revealProgress={revealProgress} color={palette.ink} size={84} weight={600} letterSpacing="0.02em" />}',
    '        </div>',
    '      </AbsoluteFill>',
    '      <div style={{ position: "absolute", top: 92, left: 0, right: 0, textAlign: "center" }}>',
    '        <span style={{ color: palette.muted, fontSize: 28, letterSpacing: "0.32em" }}>{props.title}</span>',
    '      </div>',
    '      <div style={{ position: "absolute", left: 88, bottom: 96, height: 4, width: 220, backgroundColor: palette.accent, opacity: 0.55 }} />',
    '      <Captions enabled={props.subtitleEnabled} subtitles={props.subtitles || []} />',
    '      {props.audioFileName ? <Audio src={staticFile(props.audioFileName)} /> : null}',
    '    </AbsoluteFill>',
    '  );',
    '};',
    '',
  ].join('\n')
}

/**
 * 把稿件切成画面节拍：一句一拍，过长的句子在逗号处再断。
 *
 * 两个必须守住的不变量：
 * 1. 成对的引号不能拆开。`「妈，我不饿。」` 切开后剩一个孤零零的 `」`，
 *    会在屏幕上单独占据一拍——这是真实测出来的 bug，不是假设。
 * 2. 拼接所有节拍必须还原成原文（只差首尾空白）。节拍是画面的分镜表，
 *    丢字等于观众少听到一句。
 */
export function buildStoryBeats({ body, durationSeconds }) {
  const CLOSERS = '」』”’）)》]'
  const text = String(body || '').replace(/\r/gu, '').trim()
  if (!text) throw new StoryRenderError('STORY_RENDER_INVALID_INPUT', '稿件没有可切分成画面的内容。')

  // 切分点后面若紧跟收尾标点，把标点留在前一句里。
  const splitSentences = (value) => value
    .split(/(?<=[。！？!?])(?![」』”’）)》\]])/u)
    .map((item) => item.trim())
    .filter(Boolean)

  const sentences = text.split(/\n+/u).flatMap(splitSentences)
  // 一句话超过 24 字就再切一刀，否则一屏放不下、逐字淡入也会拖太久。
  const units = sentences.flatMap((sentence) => {
    if (Array.from(sentence).length <= 24) return [sentence]
    return sentence.split(/(?<=[，、；,;])(?![」』”’）)》\]])/u).map((item) => item.trim()).filter(Boolean)
  })
  // 仍然孤立成拍的收尾标点，粘回上一拍。
  const merged = []
  for (const unit of units) {
    if (CLOSERS.includes(unit) && merged.length) merged[merged.length - 1] += unit
    else merged.push(unit)
  }
  if (!merged.length) throw new StoryRenderError('STORY_RENDER_INVALID_INPUT', '稿件没有可切分成画面的内容。')

  const total = Math.max(1, Number(durationSeconds) || 1)
  const weights = merged.map((unit) => Math.max(6, Array.from(unit).length))
  const sum = weights.reduce((left, right) => left + right, 0)
  let cursor = 0
  return merged.map((unit, index) => {
    const startPercent = cursor / sum
    cursor += weights[index]
    return { startPercent, endPercent: Math.min(1, cursor / sum), text: unit, seconds: (weights[index] / sum) * total }
  })
}

/** 暖色低饱和配色：深夜观看时比高对比配色更不容易刺眼。 */
export const STORY_PALETTES = Object.freeze({
  dusk: { background: '#2A211E', ink: '#F5EDE4', muted: '#C0AFA0', accent: '#D98E63' },
  rainy: { background: '#1F262E', ink: '#EAF0F5', muted: '#9FB0BE', accent: '#7FB2C9' },
  kitchen: { background: '#2B2416', ink: '#F7F0DC', muted: '#C6B48C', accent: '#E0B15C' },
  oldroom: { background: '#241E1A', ink: '#F0E6DA', muted: '#B7A491', accent: '#C56B5A' },
})

export function normalizeStoryPalette(value) {
  const key = typeof value === 'string' && value in STORY_PALETTES ? value : 'dusk'
  return { key, ...STORY_PALETTES[key] }
}

/**
 * 搭一个可渲染的 Remotion 任务目录。
 *
 * 返回的 outputPath 是约定位置，不代表文件已存在——真正产片要调
 * renderStoryVideo。这样搭目录与跑渲染可以分开：搭目录是纯文件操作，
 * 没有 Remotion 也能测；渲染才受浏览器与 ffmpeg 影响。
 */
export async function prepareStoryVideoProject({
  projectRoot,
  runId,
  title,
  script,
  audioPath,
  durationSeconds,
  subtitles,
  subtitleSrt = '',
  subtitleEnabled = true,
  palette = 'dusk',
  // 依赖链接要写符号链接，某些受限环境（沙箱）不允许。允许跳过，让调用方
  // 只搭目录不装依赖——目录与源码本身不依赖 node_modules。
  linkDependencies = true,
}) {
  if (!/^[a-zA-Z0-9._-]{1,80}$/u.test(String(runId || ''))) throw new StoryRenderError('STORY_RENDER_INVALID_INPUT', '渲染任务标识无效。')
  if (!await exists(audioPath)) throw new StoryRenderError('STORY_RENDER_INVALID_INPUT', '找不到配音文件，无法搭建渲染任务。')

  const projectDir = join(projectRoot, 'media', 'story-video', runId)
  const srcDir = join(projectDir, 'src')
  const publicDir = join(projectDir, 'public')
  const outputsDir = join(projectDir, 'outputs')
  await Promise.all([srcDir, publicDir, outputsDir].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
  if (linkDependencies) await ensureStoryDependencies(projectDir)

  const audioFileName = `narration${extname(audioPath) || '.wav'}`
  await copyFile(audioPath, join(publicDir, audioFileName))

  const beats = buildStoryBeats({ body: script, durationSeconds })
  const chosen = normalizeStoryPalette(palette)
  const props = {
    title: String(title || '').slice(0, 40),
    beats: beats.map((beat) => ({ startPercent: beat.startPercent, endPercent: beat.endPercent, text: beat.text })),
    audioFileName,
    durationSeconds: Math.max(1, Number(durationSeconds) || 1),
    fps: STORY_RENDER_SPEC.fps,
    subtitleEnabled: Boolean(subtitleEnabled),
    subtitles: subtitleEnabled && Array.isArray(subtitles) ? subtitles : [],
    palette: { background: chosen.background, ink: chosen.ink, muted: chosen.muted, accent: chosen.accent },
  }

  await Promise.all([
    writeFile(join(srcDir, 'index.ts'), entrySource(), { mode: 0o600 }),
    writeFile(join(srcDir, 'Root.tsx'), rootSource(), { mode: 0o600 }),
    writeFile(join(srcDir, 'StoryAccountVideo.tsx'), compositionSource(), { mode: 0o600 }),
    writeFile(join(publicDir, 'task-props.json'), json(props), { mode: 0o600 }),
    writeFile(join(projectDir, 'tsconfig.json'), json({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src/**/*'],
    }), { mode: 0o600 }),
  ])
  if (subtitleSrt) await writeFile(join(projectDir, 'inputs.srt'), `${String(subtitleSrt).trim()}\n`, { mode: 0o600 })

  return {
    projectDir,
    relativeProjectDir: `media/story-video/${runId}`,
    entry: join(srcDir, 'index.ts'),
    propsFile: join(publicDir, 'task-props.json'),
    outputPath: join(outputsDir, 'final_video.mp4'),
    audioFileName,
    beats,
    palette: chosen.key,
    spec: { ...STORY_RENDER_SPEC },
    durationSeconds: props.durationSeconds,
  }
}

/** 跑 Remotion 渲染。stdio 用 inherit：沙箱里管道捕获会被 EPERM 拒绝。 */
export async function renderStoryVideo(
  workspace,
  { signal, resolveBrowser = resolveRemotionBrowserExecutable, remotionAvailable = storyRemotionAvailable, run = execFileAsync } = {},
) {
  if (!await remotionAvailable()) throw new StoryRenderError('STORY_RENDER_UNAVAILABLE', '当前安装未包含 Remotion 渲染器。')
  // 离线条：必须显式指定浏览器，绝不把决定权交回 Remotion 让它去联网下载
  // chrome-headless-shell（storage.googleapis.com）——离线/内网/CI 必失败。
  const browserExecutable = resolveBrowser()
  if (!browserExecutable) {
    throw new StoryRenderError(
      'STORY_RENDER_UNAVAILABLE',
      '本机没有可用的渲染浏览器，无法离线渲染竖屏成片。请任选其一：① 用「启动工作台.cmd」启动工作台（会自动带上 Remotion 浏览器）；② 运行 npm run setup 安装 chrome-headless-shell；③ 在环境变量 LWB_REMOTION_BROWSER_EXECUTABLE 里指定本机 Chrome / Chromium 可执行文件路径。',
    )
  }
  const args = [
    REMOTION_CLI,
    'render',
    join(workspace.projectDir, 'src', 'index.ts'),
    STORY_COMPOSITION_ID,
    workspace.outputPath,
    '--props', workspace.propsFile,
    '--concurrency', '4',
    '--codec', 'h264',
    '--overwrite',
    '--browser-executable', browserExecutable,
  ]
  await run(process.execPath, args, { cwd: workspace.projectDir, signal, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { outputPath: workspace.outputPath, spec: workspace.spec }
}

/** ffprobe 读数。判据在 story-account-qc.mjs，这里只负责把文件读成事实。 */
export async function probeStoryVideo(path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,sample_rate,nb_frames:stream_disposition=attached_pic',
    '-of', 'json',
    path,
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  const parsed = JSON.parse(stdout)
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const video = streams.find((stream) => stream?.codec_type === 'video' && Number(stream?.disposition?.attached_pic || 0) !== 1) || null
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || null
  const fpsOf = (value) => {
    const parts = String(value || '').split('/').map(Number)
    return parts.length === 2 && parts[1] !== 0 && Number.isFinite(parts[0]) ? parts[0] / parts[1] : null
  }
  return {
    durationSeconds: Number(parsed.format?.duration || video?.duration || 0) || null,
    width: Number.isInteger(video?.width) ? video.width : null,
    height: Number.isInteger(video?.height) ? video.height : null,
    fps: video ? fpsOf(video.avg_frame_rate || video.r_frame_rate) : null,
    hasAudio: Boolean(audio),
    audioDurationSeconds: Number(audio?.duration || parsed.format?.duration || 0) || null,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
  }
}

/** 读回搭建结果，供重载校验用（不重新跑渲染）。 */
export async function readStoryVideoProject(projectDir) {
  const props = JSON.parse(await readFile(join(projectDir, 'public', 'task-props.json'), 'utf8'))
  return {
    beats: props.beats || [],
    beatCount: (props.beats || []).length,
    title: props.title,
    durationSeconds: props.durationSeconds,
    spec: { width: STORY_RENDER_SPEC.width, height: STORY_RENDER_SPEC.height, fps: STORY_RENDER_SPEC.fps },
    hasComposition: await exists(join(projectDir, 'src', 'StoryAccountVideo.tsx')),
  }
}
