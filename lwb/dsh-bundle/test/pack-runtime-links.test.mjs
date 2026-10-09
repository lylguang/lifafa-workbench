import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureLwbRuntimeSymlink, linkInRepoPacks } from '../../pack-runtime-links.mjs'

// 交付包第一次运行时，包内 node_modules/@deepseek-ai/* 这些 junction 位置的
// 实际内容是**zip 解压出来的实体目录副本**——zip 格式存不了 junction。这两个
// 用例锁住那次替换的行为：空壳要换成链接，带 package.json 的真实内容不能删。

test('a leftover directory left by zip extraction is replaced with a real link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-link-'))
  try {
    const target = join(dir, 'target')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), '{"name":"target"}', 'utf8')

    // zip 解压后的残留：有内容但没有 package.json，说明是展开的链接而不是代码。
    const linkPath = join(dir, 'node_modules', 'pkg')
    await mkdir(linkPath, { recursive: true })
    await writeFile(join(linkPath, 'stale.txt'), 'left over from extraction', 'utf8')

    await ensureLwbRuntimeSymlink(linkPath, target)

    assert.equal(await readFile(join(linkPath, 'package.json'), 'utf8'), '{"name":"target"}')
    assert.equal(existsSync(join(linkPath, 'stale.txt')), false, '残留文件应随替换一起清掉')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a real package directory is never deleted to make room for a link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-link-'))
  try {
    const linkPath = join(dir, 'node_modules', 'pkg')
    await mkdir(linkPath, { recursive: true })
    await writeFile(join(linkPath, 'package.json'), '{"name":"real"}', 'utf8')

    await assert.rejects(
      () => ensureLwbRuntimeSymlink(linkPath, join(dir, 'target')),
      /不是链接|real directory/u,
    )
    // 静默删掉带 package.json 的目录就是在毁代码，必须留着并报错。
    assert.equal(await readFile(join(linkPath, 'package.json'), 'utf8'), '{"name":"real"}')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing correct link is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwb-link-'))
  try {
    const target = join(dir, 'target')
    await mkdir(target, { recursive: true })
    const linkPath = join(dir, 'link')
    await ensureLwbRuntimeSymlink(linkPath, target)
    await ensureLwbRuntimeSymlink(linkPath, target)
    assert.ok(existsSync(linkPath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every in-repo pack gets its runtime peers linked', async () => {
  const linked = await linkInRepoPacks()
  assert.ok(linked.includes('spoken-video'), `spoken-video 应在链接列表里，实际 ${linked.join(', ')}`)
  assert.ok(linked.includes('whiteboard'), 'whiteboard 引擎包也要链接')
  assert.ok(linked.includes('publisher'), 'publisher 包也要链接')
})
