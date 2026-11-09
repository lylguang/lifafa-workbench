import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  installRootAwareSearchTools,
  resolveRootAnchoredPattern,
  rewriteRootAwareSearchSpec,
  ROOT_AWARE_SEARCH_INSTALL,
} from '../root-aware-search-tools.mjs'

const cwd = resolve('D:/lifafa-workbench')
const root = 'data/projects/p1/media/video-agent/r1'

function globSpec(pattern = 'public/sfx/*.wav', path = root, workdir = cwd) {
  return {
    argv: [
      'C:/ripgrep/rg.exe',
      '--no-config',
      '--files',
      `--glob=${pattern}`,
      '--sort=modified',
      '--no-ignore',
      '--hidden',
      '--glob=!**/.git',
      '--glob=!**/.git/**',
      '--',
      path,
    ],
    cwd: workdir,
  }
}

function grepSpec(include = 'src/*.ts', path = root, workdir = cwd) {
  return {
    argv: [
      'C:/ripgrep/rg.exe',
      '--no-config',
      '--json',
      '--regexp=TODO',
      `--glob=${include}`,
      '--',
      path,
    ],
    cwd: workdir,
  }
}

test('resolves root-anchored patterns without changing universal patterns', () => {
  assert.equal(resolveRootAnchoredPattern('*.wav', root, cwd), undefined)
  assert.equal(resolveRootAnchoredPattern('**/public/sfx/*.wav', root, cwd), undefined)
  assert.equal(resolveRootAnchoredPattern('/tmp/*.wav', root, cwd), undefined)
  assert.equal(resolveRootAnchoredPattern('C:/tmp/*.wav', root, cwd), undefined)
  assert.equal(resolveRootAnchoredPattern('', root, cwd), undefined)
  assert.equal(resolveRootAnchoredPattern('public/sfx/*.wav', undefined, cwd), undefined)
  assert.equal(resolveRootAnchoredPattern('public/sfx/*.wav', '.', cwd), `**/public/sfx/*.wav`)
  assert.equal(resolveRootAnchoredPattern('./public/sfx/*.wav', root, cwd), `${root}/public/sfx/*.wav`)
  assert.equal(
    resolveRootAnchoredPattern('public\\sfx\\*.wav', root, cwd),
    `${root}/public/sfx/*.wav`,
  )
  assert.equal(
    resolveRootAnchoredPattern('public/sfx/*.wav', resolve(cwd, root), cwd),
    `${root}/public/sfx/*.wav`,
  )
  assert.equal(
    resolveRootAnchoredPattern('public/sfx/*.wav', 'D:/outside/project', cwd),
    '**/public/sfx/*.wav',
  )
  const first = resolveRootAnchoredPattern('public/sfx/*.wav', root, cwd)
  assert.equal(resolveRootAnchoredPattern(first, root, cwd), `${root}/${first}`)
})

test('adds one root-anchored glob while preserving original glob and excludes', () => {
  const spec = globSpec()
  const rewritten = rewriteRootAwareSearchSpec(spec)
  assert.notEqual(rewritten, spec)
  assert.equal(spec.argv.filter((arg) => arg.startsWith('--glob=')).length, 3)
  assert.deepEqual(rewritten.argv, [
    'C:/ripgrep/rg.exe',
    '--no-config',
    '--files',
    '--glob=public/sfx/*.wav',
    '--sort=modified',
    '--no-ignore',
    '--hidden',
    `--glob=${root}/public/sfx/*.wav`,
    '--glob=!**/.git',
    '--glob=!**/.git/**',
    '--',
    root,
  ])
  const globs = rewritten.argv.filter((arg) => arg.startsWith('--glob='))
  assert.ok(globs.includes('--glob=public/sfx/*.wav'))
  assert.ok(globs.includes(`--glob=${root}/public/sfx/*.wav`))
  assert.ok(globs.includes('--glob=!**/.git'))
  assert.equal(rewritten.argv.at(-2), '--')
  assert.equal(rewritten.argv.at(-1), root)
  const missingCwd = { ...spec, cwd: undefined }
  assert.equal(rewriteRootAwareSearchSpec(missingCwd), missingCwd)
})

test('fixes grep include and does not affect commands without an eligible root', () => {
  const rewritten = rewriteRootAwareSearchSpec(grepSpec())
  assert.ok(rewritten.argv.includes('--glob=src/*.ts'))
  assert.ok(rewritten.argv.includes(`--glob=${root}/src/*.ts`))
  assert.equal(rewritten.argv.at(-2), '--')
  assert.equal(rewritten.argv.at(-1), root)

  for (const pattern of ['*.wav', '**/*.wav']) {
    const spec = globSpec(pattern)
    assert.equal(rewriteRootAwareSearchSpec(spec), spec)
  }
  for (const spec of [
    globSpec('public/sfx/*.wav', '.'),
    { ...globSpec(), argv: globSpec().argv.slice(0, -2) },
    { ...globSpec(), argv: ['node', 'script.js'] },
    { argv: ['node', 'script.js'], cwd },
    { argv: ['bash', '-lc', 'echo --no-config'], cwd },
  ]) {
    assert.equal(rewriteRootAwareSearchSpec(spec), spec)
  }
})

class FakeSubprocess extends Service {
  constructor(ctx) {
    super(ctx, 'subprocess')
    this.calls = []
    this.raw = this
  }

  spawn(spec) {
    this.calls.push(spec)
    return { spec, serviceIsReceiver: this === this.raw }
  }
}

async function withInstalledHost(callback) {
  const ctx = new Context()
  const serviceFiber = ctx.plugin(FakeSubprocess)
  await serviceFiber.await()
  const first = installRootAwareSearchTools(ctx)
  const second = installRootAwareSearchTools(ctx)
  await first.await()
  await second.await()
  try {
    await callback(ctx, { first, second })
  } finally {
    await first.dispose()
    await second.dispose()
    await serviceFiber.dispose()
  }
}

test('installs one spawn wrapper, rewrites only search spawns, and restores on disposal', async () => {
  await withInstalledHost(async (ctx, { first, second }) => {
    const service = ctx.subprocess
    assert.equal(service[ROOT_AWARE_SEARCH_INSTALL].refs, 2)
    const search = globSpec()
    service.spawn(search)
    const shell = { argv: ['node', 'script.js'], cwd }
    service.spawn(shell)
    assert.equal(service.calls.length, 2)
    assert.ok(service.calls[0].argv.includes(`--glob=${root}/public/sfx/*.wav`))
    assert.deepEqual(service.calls[1], shell)
    const raw = service[Symbol.for('cordis.original')] ?? service
    assert.equal(raw.raw, raw, 'provider spawn must keep the real service receiver')
    assert.equal(raw[ROOT_AWARE_SEARCH_INSTALL].refs, 2)
    assert.equal(search.argv.includes(`--glob=${root}/public/sfx/*.wav`), false)

    await first.dispose()
    assert.equal(service[ROOT_AWARE_SEARCH_INSTALL].refs, 1)
    service.spawn(globSpec())
    assert.ok(service.calls.at(-1).argv.includes(`--glob=${root}/public/sfx/*.wav`))
    await second.dispose()
    assert.equal(service[ROOT_AWARE_SEARCH_INSTALL], undefined)
    service.spawn(globSpec())
    assert.equal(service.calls.at(-1).argv.includes(`--glob=${root}/public/sfx/*.wav`), false)
  })
})

test('real ripgrep finds root-relative files with both relative and absolute roots', () => {
  const require = createRequire('D:/lifafa-workbench/vendor/deepseek-harness/packages/fs/tool-fs-search/lib/index.js')
  let rg
  try {
    rg = require('@vscode/ripgrep').rgPath
  } catch {
    return // Packaged ripgrep is not installed in this checkout.
  }
  const base = mkdtempSync(join(tmpdir(), 'lwb-root-glob-'))
  try {
    const work = join(base, 'work')
    const projectRoot = join(work, root)
    mkdirSync(join(projectRoot, 'public', 'sfx'), { recursive: true })
    writeFileSync(join(projectRoot, 'public', 'sfx', 'a.wav'), 'x')
    writeFileSync(join(projectRoot, 'public', 'sfx', 'b.wav'), 'x')

    for (const path of [root, projectRoot]) {
      const original = globSpec('public/sfx/*.wav', path, work)
      const fixed = rewriteRootAwareSearchSpec({ ...original, argv: [rg, ...original.argv.slice(1)] })
      const before = spawnSync(rg, original.argv.slice(1), { cwd: work, encoding: 'utf8' })
      const after = spawnSync(fixed.argv[0], fixed.argv.slice(1), { cwd: work, encoding: 'utf8' })
      assert.equal(before.status, 1)
      assert.equal(before.stdout.trim(), '')
      assert.equal(after.status, 0)
      assert.match(after.stdout, /public[\\/]sfx[\\/]a\.wav/u)
      assert.match(after.stdout, /public[\\/]sfx[\\/]b\.wav/u)
      assert.match(after.stdout, /public.*a\.wav[\s\S]*public.*b\.wav/u)
    }

    const outside = join(base, 'outside')
    mkdirSync(join(outside, 'public', 'sfx'), { recursive: true })
    writeFileSync(join(outside, 'public', 'sfx', 'c.wav'), 'x')
    const outsideOriginal = globSpec('public/sfx/*.wav', outside, work)
    const outsideFixed = rewriteRootAwareSearchSpec({ ...outsideOriginal, argv: [rg, ...outsideOriginal.argv.slice(1)] })
    assert.ok(outsideFixed.argv.includes('--glob=**/public/sfx/*.wav'))
    const result = spawnSync(outsideFixed.argv[0], outsideFixed.argv.slice(1), { cwd: work, encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /c\.wav/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
