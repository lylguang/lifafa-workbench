import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, statfs, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, parse as parsePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'

import { inspectAgentProject } from './spoken-video-preflight.mjs'

const execFileAsync = promisify(execFile)
const PACK_ROOT = dirname(fileURLToPath(import.meta.url))
const APP_NODE_MODULES = resolve(PACK_ROOT, '../../..', 'node_modules')
// Windows 兼容：.bin/remotion 是 bash 脚本无法在 Windows spawn，改为用 node 直接跑 CLI 的 JS 入口
const REMOTION_CLI = join(APP_NODE_MODULES, '@remotion', 'cli', 'remotion-cli.js')
const AGENT_SKILL_ROOT = join(PACK_ROOT, 'skills')
const RENDER_TARGET_BYTES = 72 * 1024 * 1024
const RENDER_AUDIO_BITRATE_BPS = 128_000
const RENDER_CONTAINER_OVERHEAD_BPS = 64_000
const MIN_VIDEO_BITRATE_BPS = 400_000
const MAX_VIDEO_BITRATE_BPS = 8_000_000

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function srtTimestamp(milliseconds) {
  const total = Math.max(0, Math.round(Number(milliseconds) || 0))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(total % 1_000).padStart(3, '0')}`
}

function subtitleSrtText(value, cues) {
  const provided = typeof value === 'string' ? value.replace(/^\uFEFF/u, '').trim() : ''
  if (provided) return `${provided}\n`
  const rows = (Array.isArray(cues) ? cues : []).map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}`)
  return rows.length ? `${rows.join('\n\n')}\n` : ''
}

async function exists(path) {
  return Boolean(await lstat(path).catch(() => null))
}

async function ensureLinkedNodeModules(projectDir) {
  const target = join(projectDir, 'node_modules')
  const [sourceInfo, targetInfo] = await Promise.all([lstat(APP_NODE_MODULES).catch(() => null), lstat(target).catch(() => null)])
  if (!sourceInfo?.isDirectory()) return false
  if (targetInfo) {
    if (!targetInfo.isSymbolicLink()) return false
    return (await realpath(target).catch(() => null)) === (await realpath(APP_NODE_MODULES).catch(() => null))
  }
  await symlink(APP_NODE_MODULES, target, 'dir')
  return true
}

// Share dependencies and the installed browser; keep Webpack caches task-local.
export async function ensureAgentDependencies(projectDir) {
  const target = join(projectDir, 'node_modules')
  const info = await lstat(target).catch(() => null)
  if (info?.isSymbolicLink()) {
    if (await realpath(target) !== await realpath(APP_NODE_MODULES)) throw new Error('任务依赖链接指向未知目录。')
    await unlink(target)
  } else if (info && !info.isDirectory()) throw new Error('任务依赖目录无效。')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const entries = await readdir(APP_NODE_MODULES)
  for (const name of entries.filter((name) => !name.startsWith('.') || ['.bin', '.remotion'].includes(name))) {
    const link = join(target, name)
    if (!await exists(link)) await symlink(join(APP_NODE_MODULES, name), link)
  }
  const cache = join(target, '.cache')
  const cacheInfo = await lstat(cache).catch(() => null)
  if (cacheInfo?.isSymbolicLink()) throw new Error('任务缓存不得链接到共享目录。')
  await mkdir(cache, { recursive: true, mode: 0o700 })
}

function entrySource() {
  return [
    'import { registerRoot } from "remotion";',
    'import { SpokenVideoRoot } from "./Root";',
    '',
    'registerRoot(SpokenVideoRoot);',
    '',
  ].join('\n')
}

function rootSource() {
  return [
    'import React from "react";',
    'import { Composition, getInputProps } from "remotion";',
    'import { SpokenVideo, type SpokenVideoProps } from "./SpokenVideo";',
    '',
    'export const SpokenVideoRoot: React.FC = () => {',
    '  const props = getInputProps() as SpokenVideoProps;',
    '  const fps = Math.max(1, Number(props.fps || 30));',
    '  const durationSeconds = Math.max(1, Number(props.durationSeconds || 1));',
    '  const landscape = props.orientation === "landscape";',
    '  return (',
    '    <Composition',
    '      id="SpokenVideo"',
    '      component={SpokenVideo}',
    '      width={landscape ? 1920 : 1080}',
    '      height={landscape ? 1080 : 1920}',
    '      fps={fps}',
    '      durationInFrames={Math.max(1, Math.ceil((durationSeconds + 0.1) * fps))}',
    '      defaultProps={props}',
    '    />',
    '  );',
    '};',
    '',
  ].join('\n')
}

function compositionSource() {
  return [
    'import React from "react";',
    'import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";',
    '',
    'type Theme = "ink" | "ocean" | "coral" | "forest" | "plum";',
    'type SceneMode = "editorial" | "kinetic" | "contrast" | "notebook" | "spotlight";',
    'type Scene = { startPercent: number; endPercent: number; mode: SceneMode; eyebrow: string; headline: string; supporting: string; emphasis: string };',
    'type Subtitle = { id: string; startMs: number; endMs: number; text: string };',
    'export type SpokenVideoProps = { title: string; coverTitle: string; theme: Theme; scenes: Scene[]; audioFileName: string; durationSeconds: number; fps: number; orientation: "portrait" | "landscape"; subtitleEnabled: boolean; subtitles: Subtitle[] };',
    '',
    'const themes: Record<Theme, { background: string; panel: string; ink: string; muted: string; accent: string; line: string }> = {',
    '  ink: { background: "#101827", panel: "#1D2B3A", ink: "#F8FAFC", muted: "#B8C4D4", accent: "#40D6B4", line: "#385069" },',
    '  ocean: { background: "#082F49", panel: "#0C4A6E", ink: "#F0F9FF", muted: "#BDE7F5", accent: "#F7C873", line: "#287598" },',
    '  coral: { background: "#3A1F2B", panel: "#5D2B3D", ink: "#FFF7ED", muted: "#F6C9C1", accent: "#86E3CE", line: "#8D5260" },',
    '  forest: { background: "#12352D", panel: "#1E5142", ink: "#F4FFF8", muted: "#BFE2D0", accent: "#FFD166", line: "#4B7968" },',
    '  plum: { background: "#2A1D42", panel: "#46305F", ink: "#FCF8FF", muted: "#D8C9EC", accent: "#8BE9C1", line: "#71558F" },',
    '};',
    '',
    'const activeScene = (scenes: Scene[], progress: number) => scenes.find((scene) => progress >= scene.startPercent && progress < scene.endPercent) || scenes[scenes.length - 1];',
    '',
    'const Captions: React.FC<{ enabled: boolean; subtitles: Subtitle[]; width: number; height: number }> = ({ enabled, subtitles, width, height }) => {',
    '  const frame = useCurrentFrame();',
    '  const { fps } = useVideoConfig();',
    '  const now = (frame / fps) * 1000;',
    '  const active = subtitles.find((subtitle) => now >= subtitle.startMs && now < subtitle.endMs);',
    '  if (!enabled || !active) return null;',
    '  const charCount = Math.max(1, Array.from(active.text).length);',
    '  const fontSize = Math.max(34, Math.min(56, Math.floor((width - 180) / Math.max(10, Math.ceil(charCount / 2)))));',
    '  return <div style={{ position: "absolute", left: 72, right: 72, bottom: 138, display: "flex", justifyContent: "center", pointerEvents: "none" }}><div style={{ maxWidth: "100%", padding: `${Math.round(fontSize * .26)}px ${Math.round(fontSize * .48)}px`, borderRadius: 10, background: "rgba(0,0,0,.78)", color: "#fff", fontFamily: "PingFang SC, Microsoft YaHei, sans-serif", fontSize, fontWeight: 760, lineHeight: 1.22, textAlign: "center", whiteSpace: "pre-wrap", overflowWrap: "anywhere", textShadow: "0 2px 5px rgba(0,0,0,.9)" }}>{active.text}</div></div>;',
    '};',
    '',
    'export const SpokenVideo: React.FC<SpokenVideoProps> = (props) => {',
    '  const frame = useCurrentFrame();',
    '  const { fps, width, height, durationInFrames } = useVideoConfig();',
    '  const theme = themes[props.theme] || themes.ink;',
    '  const landscape = width > height;',
    '  const progress = (frame / Math.max(1, durationInFrames - 1)) * 100;',
    '  const scene = activeScene(props.scenes, progress);',
    '  const sceneStart = Math.max(0, Math.round((scene.startPercent / 100) * durationInFrames));',
    '  const localFrame = Math.max(0, frame - sceneStart);',
    '  const entrance = interpolate(localFrame, [0, Math.max(8, Math.round(fps * .45))], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });',
    '  const scale = scene.mode === "kinetic" ? 1 + interpolate(localFrame, [0, fps * 3], [0, .035], { extrapolateRight: "clamp" }) : 1;',
    '  const offset = Math.round((1 - entrance) * (scene.mode === "spotlight" ? 42 : 28));',
    '  const column = scene.mode === "contrast" ? "1fr 12px" : "1fr";',
    '  return <AbsoluteFill style={{ background: theme.background, color: theme.ink, fontFamily: "PingFang SC, Microsoft YaHei, sans-serif", overflow: "hidden" }}>',
    '    <Audio src={staticFile(props.audioFileName)} />',
    '    <div style={{ position: "absolute", inset: 0, opacity: .24, backgroundImage: `linear-gradient(${theme.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.line} 1px, transparent 1px)`, backgroundSize: "72px 72px" }} />',
    '    <div style={{ position: "absolute", top: -180, right: -Math.round(width * .3), width: Math.round(width * .7), height: Math.round(height * .46), background: theme.accent, opacity: .1, transform: `skewY(-18deg) translateY(${Math.round(progress * .8)}px)` }} />',
    '    <div style={{ position: "absolute", inset: landscape ? 46 : 58, border: `1px solid ${theme.line}`, borderRadius: 10, opacity: .72 }} />',
    '    <div style={{ position: "absolute", left: landscape ? 126 : 94, right: landscape ? 126 : 94, top: landscape ? 82 : 116, bottom: landscape ? 224 : 320, display: "grid", gridTemplateRows: "auto 1fr auto", gap: landscape ? 22 : 30 }}>',
    '      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: theme.muted, fontSize: 24, letterSpacing: 0 }}><span>{scene.eyebrow}</span><span>{String(Math.min(99, Math.floor(progress))).padStart(2, "0")}%</span></div>',
    '      <div style={{ display: "grid", alignContent: "center", gridTemplateColumns: column, gap: 24, transform: `translateY(${offset}px) scale(${scale})`, opacity: .35 + entrance * .65 }}>',
    '        <div style={{ padding: scene.mode === "notebook" ? "54px 42px" : "0", border: scene.mode === "notebook" ? `1px solid ${theme.line}` : "none", background: scene.mode === "notebook" ? theme.panel : "transparent", borderRadius: scene.mode === "notebook" ? 8 : 0 }}>',
    '          <div style={{ color: theme.accent, fontSize: 28, fontWeight: 800, minHeight: 34 }}>{scene.emphasis}</div>',
    '          <h1 style={{ margin: landscape ? "12px 0 20px" : "18px 0 28px", fontSize: landscape ? (scene.mode === "spotlight" ? 76 : 64) : (scene.mode === "spotlight" ? 92 : 78), lineHeight: 1.16, letterSpacing: 0, fontWeight: 840, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{scene.headline}</h1>',
    '          <p style={{ margin: 0, maxWidth: landscape ? 1280 : 760, color: theme.muted, fontSize: landscape ? 30 : 34, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{scene.supporting}</p>',
    '        </div>',
    '        {scene.mode === "contrast" ? <div style={{ width: 12, borderRadius: 8, background: theme.accent, alignSelf: "stretch" }} /> : null}',
    '      </div>',
    '      <div style={{ display: "flex", alignItems: "center", gap: 12 }}><div style={{ height: 5, flex: 1, background: theme.line, borderRadius: 5 }}><div style={{ height: "100%", width: `${Math.max(3, progress)}%`, background: theme.accent, borderRadius: 5 }} /></div><span style={{ color: theme.muted, fontSize: 22 }}>{props.coverTitle}</span></div>',
    '    </div>',
    '    <Captions enabled={props.subtitleEnabled} subtitles={props.subtitles || []} width={width} height={height} />',
    '  </AbsoluteFill>;',
    '};',
    '',
  ].join('\n')
}

function agentRootSource() {
  return [
    'import React from "react";',
    'import { AbsoluteFill, Audio, Composition, getInputProps, staticFile } from "remotion";',
    'import { CreativeVideo, type CreativeVideoProps } from "./CreativeVideo";',
    'import { DeterministicSrtSubtitles } from "./DeterministicSrtSubtitles";',
    '',
    'export type TaskProps = CreativeVideoProps & { audioFileName: string; bgmFileName: string | null; bgmVolume: number | null };',
    '',
    'const SpokenVideo: React.FC<TaskProps> = (props) => (',
    '  <AbsoluteFill style={{backgroundColor: "#f4f5f2"}}>',
    '    {props.bgmFileName ? <Audio src={staticFile(props.bgmFileName)} loop volume={Math.max(0, Math.min(0.5, Number(props.bgmVolume ?? 0.12)))} /> : null}',
    '    <Audio src={staticFile(props.audioFileName)} />',
    '    <CreativeVideo {...props} />',
    '    <DeterministicSrtSubtitles enabled={props.subtitleEnabled} subtitles={props.subtitles} orientation={props.orientation} />',
    '  </AbsoluteFill>',
    ');',
    '',
    'export const SpokenVideoRoot: React.FC = () => {',
    '  const props = getInputProps() as TaskProps;',
    '  const landscape = props.orientation === "landscape";',
    '  return <Composition id="SpokenVideo" component={SpokenVideo} width={landscape ? 1920 : 1080} height={landscape ? 1080 : 1920} fps={30} durationInFrames={Math.max(1, Math.ceil((props.durationSeconds + 0.1) * 30))} defaultProps={props} />;',
    '};',
    '',
  ].join('\n')
}

function deterministicSubtitleSource() {
  return [
    'import React from "react";',
    'import { useCurrentFrame, useVideoConfig } from "remotion";',
    'import type { SubtitleCue } from "./CreativeVideo";',
    '',
    'export const DeterministicSrtSubtitles: React.FC<{enabled: boolean; subtitles: SubtitleCue[]; orientation: "portrait" | "landscape"}> = ({enabled, subtitles, orientation}) => {',
    '  const frame = useCurrentFrame();',
    '  const {fps} = useVideoConfig();',
    '  const now = frame / fps * 1000;',
    '  const active = subtitles.find((cue) => now >= cue.startMs && now < cue.endMs);',
    '  if (!enabled || !active) return null;',
    '  const portrait = orientation === "portrait";',
    // 底部对齐锚定：外层固定到底边，内层随行数向下生长。若按中心定位，单行/双行
    // 切换会让字幕块整体上下跳动（实测被判为"字幕位置在帧间跳动"）。
    '  return <div style={{position: "absolute", left: portrait ? 72 : 150, right: portrait ? 116 : 150, bottom: portrait ? 430 : 76, height: portrait ? 150 : 120, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none", zIndex: 1000}}>',
    '    <div style={{maxWidth: portrait ? 820 : 1420, padding: portrait ? "16px 26px" : "12px 24px", borderRadius: 8, background: "rgba(8,12,18,.82)", color: "#fff", fontFamily: "PingFang SC, Microsoft YaHei, sans-serif", fontSize: portrait ? 46 : 48, fontWeight: 760, lineHeight: 1.28, textAlign: "center", whiteSpace: "pre-wrap", overflowWrap: "anywhere", textShadow: "0 2px 4px rgba(0,0,0,.8)"}}>{active.text}</div>',
    '  </div>;',
    '};',
    '',
  ].join('\n')
}

function creativePlaceholderSource() {
  return [
    'import React from "react";',
    'import { AbsoluteFill } from "remotion";',
    '',
    'export type SubtitleCue = { id: string; startMs: number; endMs: number; text: string };',
    'export type CreativeVideoProps = { title: string; script: string; durationSeconds: number; orientation: "portrait" | "landscape"; subtitleEnabled: boolean; subtitles: SubtitleCue[] };',
    '',
    'export const CreativeVideo: React.FC<CreativeVideoProps> = ({title}) => (',
    '  <AbsoluteFill data-agent-placeholder="true" style={{justifyContent: "center", alignItems: "center", fontFamily: "PingFang SC, Microsoft YaHei, sans-serif"}}>',
    '    <div>{title}</div>',
    '  </AbsoluteFill>',
    ');',
    '',
  ].join('\n')
}

function agentPackageSource() {
  return {
    private: true,
    type: 'module',
    scripts: {
      check: 'node scripts/preflight.mjs',
      still: 'remotion still src/index.ts SpokenVideo outputs/check.png --props public/task-props.json --gl=swiftshader --overwrite',
      render: 'remotion render src/index.ts SpokenVideo outputs/final_video.mp4 --props public/task-props.json --gl=swiftshader --overwrite',
    },
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function copyAgentGuidance(projectDir) {
  const targets = [
    ['remotion-best-practices/SKILL.md', 'remotion-best-practices/SKILL.md'],
    ['remotion-best-practices/rules/subtitles.md', 'remotion-best-practices/rules/subtitles.md'],
    ['remotion-best-practices/rules/ffmpeg.md', 'remotion-best-practices/rules/ffmpeg.md'],
    ['remotion-best-practices/rules/sequencing.md', 'remotion-best-practices/rules/sequencing.md'],
    ['remotion-best-practices/rules/timing.md', 'remotion-best-practices/rules/timing.md'],
    ['remotion-best-practices/rules/transitions.md', 'remotion-best-practices/rules/transitions.md'],
    ['content-video/SKILL.md', 'content-video/SKILL.md'],
  ]
  await Promise.all(targets.map(async ([source, target]) => {
    const destination = join(projectDir, 'skills', target)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(join(AGENT_SKILL_ROOT, source), destination)
  }))
}

/** Build one isolated Remotion workspace whose creative source is owned by a DSH child. */

// 动效音效素材：用 ffmpeg 本地合成三枚短音效（无网络、无版权负担），放进任务
// 的 public/sfx/，供创作 Agent 在关键动画节点铺 <Audio>。生成是尽力而为：
// ffmpeg 缺失或失败时跳过目录，提示词要求 Agent 以目录实际内容为准。
//
// 响度必须做归一化：旁白峰值约 -4.6dB，而初版音效峰值只有 -16.7 ~ -25.5dB，
// 混进成片后人耳完全听不到（实测把音量推到 0.6 仍被淹没）。感知音效靠瞬态峰值，
// 所以这里用 loudnorm 把峰值压到 -1 ~ -1.5dB，让它在旁白之上能被清晰听见。
async function writeSfxKit(publicDir) {
  const sfxDir = join(publicDir, 'sfx')
  await mkdir(sfxDir, { recursive: true, mode: 0o700 })
  const clips = [
    ['whoosh.wav', ['-f', 'lavfi', '-i', 'anoisesrc=d=0.45:c=pink:a=0.9', '-af', 'highpass=f=250,lowpass=f=1600,afade=t=in:st=0:d=0.16,afade=t=out:st=0.26:d=0.19,volume=6dB,loudnorm=I=-16:TP=-1.5:LRA=7']],
    ['pop.wav', ['-f', 'lavfi', '-i', 'sine=frequency=760:duration=0.12', '-af', 'afade=t=out:st=0.015:d=0.105,volume=9dB,loudnorm=I=-13:TP=-1:LRA=6']],
    ['ding.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1180:duration=0.6', '-af', 'afade=t=out:st=0.05:d=0.55,volume=8dB,loudnorm=I=-13:TP=-1:LRA=6']],
  ]
  for (const [name, args] of clips) {
    try { await execFileAsync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args, '-ac', '2', '-ar', '48000', join(sfxDir, name)], { timeout: 30_000 }) } catch {}
  }
}

export async function prepareSpokenVideoAgentProject({ projectRoot, runId, title, script, audioPath, durationSeconds, subtitles, subtitleSrt = '', subtitleEnabled, orientation = 'landscape', visualBrief, bgmPath = null, backgroundMusic = null, bgmVolume = null }) {
  if (!await remotionRendererAvailable()) throw new Error('当前安装未包含 Remotion 渲染器。')
  const projectDir = join(projectRoot, 'media', 'video-agent', runId)
  const srcDir = join(projectDir, 'src')
  const publicDir = join(projectDir, 'public')
  const inputsDir = join(projectDir, 'inputs')
  const outputsDir = join(projectDir, 'outputs')
  await Promise.all([srcDir, publicDir, inputsDir, outputsDir].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
  await ensureAgentDependencies(projectDir)

  const audioFileName = `narration${extname(audioPath) || '.wav'}`
  await copyFile(audioPath, join(publicDir, audioFileName))
  await copyFile(audioPath, join(inputsDir, audioFileName))
  await writeSfxKit(publicDir)
  const bgmFileName = bgmPath ? `background-music${extname(bgmPath) || '.mp3'}` : null
  if (bgmPath) {
    await copyFile(bgmPath, join(publicDir, bgmFileName))
    await copyFile(bgmPath, join(inputsDir, bgmFileName))
  }
  const root = agentRootSource()
  const captions = deterministicSubtitleSource()
  const entry = entrySource()
  const creative = creativePlaceholderSource()
  const props = {
    title,
    script,
    durationSeconds: Math.max(1, Number(durationSeconds) || 1),
    orientation: orientation === 'landscape' ? 'landscape' : 'portrait',
    subtitleEnabled,
    subtitles: subtitleEnabled ? subtitles : [],
    audioFileName,
    bgmFileName,
    bgmVolume: bgmFileName ? Math.max(0, Math.min(0.5, Number(bgmVolume ?? 0.12))) : null,
  }
  const task = {
    schemaVersion: 1,
    videoTaskId: runId,
    renderer: 'remotion',
    requirements: {
      width: props.orientation === 'landscape' ? 1920 : 1080,
      height: props.orientation === 'landscape' ? 1080 : 1920,
      fps: 30,
      durationSeconds: props.durationSeconds,
      orientation: props.orientation,
      subtitleEnabled,
      backgroundMusicEnabled: Boolean(bgmFileName),
      bgmVolume: props.bgmVolume,
      subtitleRenderer: 'orchestrator-deterministic-srt',
      editableFiles: ['src/CreativeVideo.tsx'],
      protectedFiles: ['src/index.ts', 'src/Root.tsx', 'src/DeterministicSrtSubtitles.tsx', 'public/task-props.json', 'scripts/preflight.mjs', 'preflight-manifest.json'],
    },
    inputs: {
      draft: 'inputs/draft.json',
      // 字幕时间轴始终可用：它是画面分节的唯一依据，与「是否把字幕条烧进画面」无关。
      subtitles: 'inputs/subtitles.srt',
      narration: `inputs/${audioFileName}`,
      backgroundMusic: bgmFileName ? { file: `inputs/${bgmFileName}`, name: backgroundMusic?.name || bgmFileName, volume: props.bgmVolume } : null,
    },
    skillPaths: { remotionBestPractices: 'skills/remotion-best-practices/SKILL.md', contentVideo: 'skills/content-video/SKILL.md' },
    commands: { check: 'node scripts/preflight.mjs', still: 'node_modules/.bin/remotion still src/index.ts SpokenVideo outputs/check.png --props public/task-props.json --gl=swiftshader --overwrite', render: 'npm run render', output: 'outputs/final_video.mp4' },
    visualBrief,
  }
  await Promise.all([
    writeFile(join(projectDir, 'package.json'), json(agentPackageSource()), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(projectDir, 'tsconfig.json'), json({ compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'Node', strict: true, skipLibCheck: true, jsx: 'react-jsx', noEmit: true }, include: ['src'] }), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'index.ts'), entry, { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'Root.tsx'), root, { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'DeterministicSrtSubtitles.tsx'), captions, { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'CreativeVideo.tsx'), creative, { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(publicDir, 'task-props.json'), json(props), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(inputsDir, 'draft.json'), json({ title, body: script }), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(inputsDir, 'subtitles.srt'), subtitleSrtText(subtitleSrt, subtitles), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(projectDir, 'task.json'), json(task), { encoding: 'utf8', mode: 0o600 }),
  ])
  await copyAgentGuidance(projectDir)
  const protectedFiles = {
    'src/index.ts': sha256(entry), 'src/Root.tsx': sha256(root),
    'src/DeterministicSrtSubtitles.tsx': sha256(captions), 'public/task-props.json': sha256(json(props)),
  }
  const checker = await readFile(join(PACK_ROOT, 'spoken-video-preflight.mjs'), 'utf8')
  await mkdir(join(projectDir, 'scripts'), { recursive: true, mode: 0o700 })
  await writeFile(join(projectDir, 'scripts/preflight.mjs'), checker, { mode: 0o600 })
  protectedFiles['scripts/preflight.mjs'] = sha256(checker)
  const manifest = json({ protected: protectedFiles })
  await writeFile(join(projectDir, 'preflight-manifest.json'), manifest, { mode: 0o600 })
  protectedFiles['preflight-manifest.json'] = sha256(manifest)
  return {
    projectDir,
    relativeProjectDir: `media/video-agent/${runId}`,
    creativeFile: join(srcDir, 'CreativeVideo.tsx'),
    outputPath: join(outputsDir, 'final_video.mp4'),
    durationSeconds: props.durationSeconds,
    protected: protectedFiles,
  }
}

/** Reject placeholder output and changes to the deterministic shell before rendering. */
export const inspectSpokenVideoAgentProject = inspectAgentProject

/** Keep normal spoken-video renders below the host's 80 MiB artifact boundary. */
export function remotionEncodingSettings(durationSeconds) {
  const parsedDuration = Number(durationSeconds)
  const duration = Number.isFinite(parsedDuration) && parsedDuration > 0
    ? Math.max(1, parsedDuration)
    : 1
  const totalBudgetBps = Math.floor(RENDER_TARGET_BYTES * 8 / duration)
  const videoBitrateBps = Math.max(
    MIN_VIDEO_BITRATE_BPS,
    Math.min(MAX_VIDEO_BITRATE_BPS, totalBudgetBps - RENDER_AUDIO_BITRATE_BPS - RENDER_CONTAINER_OVERHEAD_BPS),
  )
  return {
    codec: 'h264',
    audioBitrate: `${Math.floor(RENDER_AUDIO_BITRATE_BPS / 1000)}k`,
    videoBitrate: `${Math.floor(videoBitrateBps / 1000)}k`,
    x264Preset: 'medium',
    targetBytes: RENDER_TARGET_BYTES,
  }
}

// Remotion 渲染前先确认盘上有地方写：帧缓存、Chromium 配置和输出文件都落在
// 输出盘/临时盘上，写完 11000 帧才发现 ENOSPC 等于白跑 20 分钟。
// 按分辨率、时长和编码码率估算所需空间，留 3 倍余量给中间产物。
const RENDER_FREE_SPACE_FACTOR = 3
const RENDER_MIN_FREE_BYTES = 1024 * 1024 * 1024

async function assertRenderDiskSpace({ projectDir, outputPath, durationSeconds }) {
  const encoding = remotionEncodingSettings(durationSeconds)
  const estimatedBytes = Math.max(RENDER_MIN_FREE_BYTES, Number(encoding.targetBytes) * RENDER_FREE_SPACE_FACTOR)
  const targets = [
    { label: '渲染输出盘', path: outputPath || projectDir },
    { label: '临时目录', path: tmpdir() },
  ]
  const checked = new Set()
  for (const target of targets) {
    let volume
    try { volume = parsePath(resolve(target.path)).root } catch { continue }
    if (!volume || checked.has(volume)) continue
    checked.add(volume)
    let info
    try { info = await statfs(volume) } catch { continue }
    const free = Number(info.bavail) * Number(info.bsize)
    if (!Number.isFinite(free)) continue
    if (free < estimatedBytes) {
      const needGb = (estimatedBytes / 1024 ** 3).toFixed(1)
      const freeGb = (free / 1024 ** 3).toFixed(1)
      throw new Error(`磁盘空间不足，无法开始渲染：${target.label} ${volume} 只剩 ${freeGb} GB，预计需要 ${needGb} GB。请清理该盘或把暂存目录指向空闲盘（TEMP/LWB_TEMP_DIR）后重试。`)
    }
  }
}

// Remotion 与系统 Chrome 的版本必须配对：4.0.522 期望 Chrome 149 的
// chrome-headless-shell，走的是旧版无头模式。系统 Chrome（153+）已移除该模式，
// 每帧退回到更重的合成路径。实测同一项目 2000 帧：headless-shell 37 秒、
// 系统 Chrome 206 秒（5.6 倍差距）。
//
// 但 headless-shell 只有在路径短的时候才能启动：Windows 默认 MAX_PATH 260，
// 而任务项目目录很深（…/pack-state/workspaces/spoken-video/data/projects/<uuid>/
// media/video-agent/<uuid>/node_modules/.remotion/…），exe 绝对路径会超过 330
// 字符，spawn 直接报 ENOENT（文件明明存在）。所以这里只接受长度安全的路径，
// 找不到就退回系统 Chrome，绝不因为缺浏览器而让渲染失败。
const MAX_EXECUTABLE_PATH = 200
function browserExecutableArgs() {
  // 优先用配套 headless-shell（实测快 5.6 倍），但必须路径够短。
  const headlessShell = process.env.LWB_REMOTION_HEADLESS_SHELL?.trim()
  if (headlessShell && headlessShell.length <= MAX_EXECUTABLE_PATH) return ['--browser-executable', headlessShell]
  // 退回系统 Chrome：慢，但一定能启动。
  const override = process.env.LWB_REMOTION_BROWSER_EXECUTABLE?.trim()
  if (override) return ['--browser-executable', override]
  return []
}

/** Render the already-authored Agent project through the locally pinned Remotion CLI. */
export async function renderSpokenVideoAgentProject(workspace, { signal, onProgress } = {}) {
  signal?.throwIfAborted()
  const temporaryOutput = `${workspace.outputPath}.partial.mp4`
  const encoding = remotionEncodingSettings(workspace.durationSeconds)
  // Do not abort only the CLI parent and leave renderer descendants writing.
  // An in-progress render keeps its lifecycle lease until the CLI settles;
  // the host's stop deadline blocks data maintenance if that takes too long.
  await assertRenderDiskSpace({ projectDir: workspace.projectDir, outputPath: temporaryOutput, durationSeconds: workspace.durationSeconds })
  const rendering = execFileAsync(process.execPath, [REMOTION_CLI,
    'render', join('src', 'index.ts'), 'SpokenVideo', temporaryOutput,
    '--props', join('public', 'task-props.json'), '--gl=swiftshader', '--overwrite', ...browserExecutableArgs(),
    '--codec', encoding.codec, '--audio-bitrate', encoding.audioBitrate,
    '--video-bitrate', encoding.videoBitrate, '--x264-preset', encoding.x264Preset,
    // 让预编码走显卡（NVENC），把 CPU 留给每帧的 DOM 渲染；无可用硬件编码器时
    // 自动退回 libx264（if-possible 不会让渲染失败）。
    '--hardware-acceleration', 'if-possible',
  ], { cwd: workspace.projectDir, timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 * 24 })
  let pending = ''; let lastProgressAt = 0; let progressTail = Promise.resolve()
  const flushProgress = () => {
    const text = pending.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').trim(); pending = ''
    if (text && onProgress) progressTail = progressTail.then(() => onProgress(text.slice(-1600))).catch(() => {})
    lastProgressAt = Date.now()
  }
  const observe = (chunk) => { pending += String(chunk); if (Date.now() - lastProgressAt > 5000) flushProgress() }
  rendering.child?.stdout?.on('data', observe)
  rendering.child?.stderr?.on('data', observe)
  try {
    const output = await rendering
    await writeFile(join(workspace.projectDir, 'outputs', 'render.log'), `${output.stdout || ''}\n${output.stderr || ''}`, 'utf8')
  } catch (error) {
    await writeFile(join(workspace.projectDir, 'outputs', 'render.log'), `${error.stdout || ''}\n${error.stderr || ''}\n${error.message}`, 'utf8').catch(() => {})
    throw error
  } finally { flushProgress(); await progressTail }
  signal?.throwIfAborted()
  if (!await exists(temporaryOutput)) throw new Error('Remotion 没有生成视频文件。')
  await rename(temporaryOutput, workspace.outputPath)
  return workspace.outputPath
}

async function writeProject(projectDir) {
  const srcDir = join(projectDir, 'src')
  await mkdir(join(projectDir, 'public'), { recursive: true, mode: 0o700 })
  await mkdir(srcDir, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(projectDir, 'package.json'), json({ private: true, type: 'module' }), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(projectDir, 'tsconfig.json'), json({ compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'Node', strict: true, skipLibCheck: true, jsx: 'react-jsx', noEmit: true }, include: ['src'] }), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'index.ts'), entrySource(), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'Root.tsx'), rootSource(), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(srcDir, 'SpokenVideo.tsx'), compositionSource(), { encoding: 'utf8', mode: 0o600 }),
  ])
}

/** Check locally bundled Remotion without invoking network package resolution. */
export async function remotionRendererAvailable() {
  return Boolean((await lstat(REMOTION_CLI).catch(() => null)) && (await lstat(APP_NODE_MODULES).catch(() => null)))
}

/**
 * Render a DSH-planned, deterministic Remotion composition. The model owns only
 * task props; this module owns the executable composition and all filesystem paths.
 */
export async function renderSpokenVideoWithRemotion({ projectRoot, runId, audioPath, durationSeconds, plan, subtitles, subtitleEnabled, orientation = 'landscape', outputPath }) {
  if (!await remotionRendererAvailable()) throw new Error('当前安装未包含 Remotion 渲染器。')
  const projectDir = join(projectRoot, 'media', 'remotion', runId)
  const publicDir = join(projectDir, 'public')
  await writeProject(projectDir)
  if (!await ensureLinkedNodeModules(projectDir)) throw new Error('Remotion 运行依赖不可用。')

  const audioExtension = extname(audioPath) || '.wav'
  const audioFileName = `narration${audioExtension}`
  await copyFile(audioPath, join(publicDir, audioFileName))
  const props = {
    title: plan.coverTitle,
    coverTitle: plan.coverTitle,
    theme: plan.theme,
    scenes: plan.scenes,
    audioFileName,
    durationSeconds: Math.max(1, Number(durationSeconds) || 1),
    fps: 30,
    orientation: orientation === 'landscape' ? 'landscape' : 'portrait',
    subtitleEnabled,
    subtitles: subtitleEnabled ? subtitles : [],
  }
  const propsPath = join(publicDir, 'task-props.json')
  await writeFile(propsPath, json(props), { encoding: 'utf8', mode: 0o600 })
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  const temporaryOutput = `${outputPath}.partial.mp4`
  await execFileAsync(process.execPath, [REMOTION_CLI,
    'render', join('src', 'index.ts'), 'SpokenVideo', temporaryOutput,
    '--props', propsPath, '--gl=swiftshader', '--overwrite', ...browserExecutableArgs(),
  ], { cwd: projectDir, timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 * 12 })
  if (!await exists(temporaryOutput)) throw new Error('Remotion 没有生成视频文件。')
  await rename(temporaryOutput, outputPath)
  return {
    projectDir: `media/remotion/${runId}`,
    propsFile: `media/remotion/${runId}/public/task-props.json`,
    entryFile: `media/remotion/${runId}/src/index.ts`,
  }
}
