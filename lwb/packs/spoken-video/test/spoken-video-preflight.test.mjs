import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectCreativeSource } from '../spoken-video-preflight.mjs'
import { ensureAgentDependencies, inspectSpokenVideoAgentProject, prepareSpokenVideoAgentProject } from '../spoken-video-remotion.mjs'

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
  const workspace = await prepareSpokenVideoAgentProject({ projectRoot: dir, runId: 'fixture', audioPath, title: 'test', script: 'script', durationSeconds: 2, subtitles: [], subtitleEnabled: false })
  assert.equal((await lstat(join(workspace.projectDir, 'node_modules'))).isSymbolicLink(), false)
  const cache = join(workspace.projectDir, 'node_modules/.cache')
  assert.equal(await realpath(cache), await realpath(workspace.projectDir) + '/node_modules/.cache')
  assert.notEqual(await realpath(join(workspace.projectDir, 'node_modules/react')), await realpath(workspace.projectDir) + '/node_modules/react')
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
  await symlink(resolve('node_modules'), join(dir, 'node_modules'))
  await ensureAgentDependencies(dir)
  await writeFile(join(dir, 'node_modules/.cache/task-only'), 'local')
  await ensureAgentDependencies(dir)
  assert.equal(await readFile(join(dir, 'node_modules/.cache/task-only'), 'utf8'), 'local')
  assert.equal((await lstat(join(dir, 'node_modules'))).isDirectory(), true)
})
