import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { crc32, zipDirectory } from '../../../scripts/zip-utf8.mjs'

/** 独立读 zip 的中央目录：不复用写端的任何逻辑，才算真的验了格式。 */
async function readCentral(zipPath) {
  const buf = await readFile(zipPath)
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocdOffset >= 0, 'zip 必须有 EOCD')
  const count = buf.readUInt16LE(eocdOffset + 10)
  let offset = buf.readUInt32LE(eocdOffset + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, '中央目录签名')
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const crc = buf.readUInt32LE(offset + 16)
    const compressed = buf.readUInt32LE(offset + 20)
    const uncompressed = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const nameBytes = buf.subarray(offset + 46, offset + 46 + nameLength)
    entries.push({ flags, method, crc, compressed, uncompressed, nameBytes, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return { buf, entries }
}

function readEntry(buf, entry) {
  assert.equal(buf.readUInt32LE(entry.localOffset), 0x04034b50, '本地文件头签名')
  const nameLength = buf.readUInt16LE(entry.localOffset + 26)
  const extraLength = buf.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const payload = buf.subarray(start, start + entry.compressed)
  return entry.method === 8 ? inflateRawSync(payload) : payload
}

test('打包：中文条目名按 UTF-8 写入并置标志位，内容可原样还原', async (t) => {
  // 2026-11-03：原来的打包脚本用 Python 的 zipfile 保证中文名不乱码，但 Python 不是
  // 本项目的依赖——构建机上没有它就打不了包。改成自己的实现后，这两件事必须守住：
  // ① 通用标志位 0x800（UTF-8）；② 名字与内容一字不差。
  // 反例（2026-10-09 实测）：PowerShell 的 Compress-Archive 把「启动工作台.cmd」
  // 写成「µëôÕ+ÇÕÀÑõ¢£ÕŦ.cmd」，客户双击直接废。
  const dir = await mkdtemp(join(tmpdir(), 'zip-utf8-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const src = join(dir, 'src')
  await mkdir(join(src, '子目录'), { recursive: true })
  const files = {
    '启动工作台.cmd': '@echo off\r\necho 中文测试\r\n',
    '子目录/安装说明.md': '# 说明\n中文内容\n',
    'plain.txt': 'ascii\n',
  }
  for (const [name, content] of Object.entries(files)) await writeFile(join(src, name), content)

  const zipPath = join(dir, 'out.zip')
  const result = await zipDirectory(src, zipPath)
  assert.equal(result.files, 3)

  const { buf, entries } = await readCentral(zipPath)
  const byName = new Map(entries.map((entry) => [entry.nameBytes.toString('utf8'), entry]))
  assert.deepEqual([...byName.keys()].sort(), Object.keys(files).sort(), '中文名必须原样保留')
  for (const [name, content] of Object.entries(files)) {
    const entry = byName.get(name)
    assert.ok(entry.flags & 0x0800, `${name} 必须置 UTF-8 标志位（0x800），否则解压端按 ANSI 解释`)
    const data = readEntry(buf, entry)
    assert.equal(data.toString('utf8'), content, `${name} 的内容必须原样还原`)
    assert.equal(entry.crc, crc32(Buffer.from(content, 'utf8')), `${name} 的 CRC 必须正确`)
  }
})

test('打包：符号链接与 junction 一律跳过（客户机上重建，不把打包机路径固化进去）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-links-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const src = join(dir, 'src')
  const outside = join(dir, 'outside')
  await mkdir(src, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(src, 'keep.txt'), 'keep\n')
  await writeFile(join(outside, 'secret.txt'), 'secret\n')
  let linked = true
  try { await symlink(outside, join(src, 'link-dir'), 'junction') } catch { linked = false }
  if (!linked) { t.skip('当前环境不允许创建 junction'); return }

  const zipPath = join(dir, 'out.zip')
  await zipDirectory(src, zipPath)
  const { entries } = await readCentral(zipPath)
  const names = entries.map((entry) => entry.nameBytes.toString('utf8'))
  assert.deepEqual(names, ['keep.txt'], '链接必须被跳过，不能把目标目录整棵拷进包里')
})

test('打包：已压缩的二进制不会被无谓地再压一遍', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const src = join(dir, 'src')
  await mkdir(src, { recursive: true })
  // 高熵数据 deflate 压不动，应当按 store（method=0）存。
  // 注意别用 (i * 大数) % 256 这类写法：它周期性很强，deflate 反而能压得很好。
  const noise = Buffer.alloc(4096)
  let state = 0x2545f491
  for (let i = 0; i < noise.length; i += 1) {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    noise[i] = state & 0xFF
  }
  await writeFile(join(src, 'noise.bin'), noise)
  const zipPath = join(dir, 'out.zip')
  await zipDirectory(src, zipPath)
  const { buf, entries } = await readCentral(zipPath)
  assert.equal(entries[0].method, 0, '压不小就用 store，别白费时间')
  assert.deepEqual(readEntry(buf, entries[0]), noise, 'store 的内容也必须原样还原')
  assert.ok((await stat(zipPath)).size > noise.length, 'zip 至少要有头部开销')
})

test('pnpm 垫片写进临时目录，PATH 首段可用（不能写 Node 安装目录）', async (t) => {
  // 2026-11-03 实测：垫片原本写在 dirname(node.exe)/.. —— 开发机上那是
  // C:\Program Files，非管理员直接写失败；客户机上才是包内目录。改到系统临时目录。
  const { pnpmShimEnv } = await import('../../../scripts/pnpm-shim.mjs')
  const env = pnpmShimEnv({ PATH: 'C:\original' })
  const [first] = env.PATH.split(';')
  assert.ok(first.startsWith(tmpdir()), `垫片目录必须在临时目录内，实际 ${first}`)
  assert.ok(!/Program Files/i.test(first), '不得写 Node 安装目录')
  const { existsSync } = await import('node:fs')
  assert.ok(existsSync(join(first, 'pnpm.cmd')), 'cmd.exe 用的垫片必须存在')
  assert.ok(existsSync(join(first, 'pnpm')), 'Git Bash 用的垫片必须存在')
  assert.ok(env.PATH.endsWith('C:\original'), '原有 PATH 必须保留在后面')
})
