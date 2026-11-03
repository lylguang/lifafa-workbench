/**
 * 写 zip：给交付包用的最小实现，只做一件事——**中文文件名不乱码**。
 *
 * 为什么自己写（2026-11-03）：
 *   · PowerShell 的 Compress-Archive 按系统 ANSI 写条目名，「启动工作台.cmd」会变成
 *     「µëôÕ+ÇÕÀÑõ¢£ÕŦ.cmd」，客户双击直接废（2026-10-09 实测）。
 *   · 原方案用 Python 的 zipfile，它会给非 ASCII 条目名正确置 UTF-8 标志位（0x800）。
 *     但 Python 不是本项目的依赖，构建机上没有它就打不了包——一个隐藏的构建依赖。
 *   所以这里直接写 zip 结构：条目名按 UTF-8 编码，并在通用标志位里置 0x800，
 *   解压端（资源管理器 / bsdtar / Python）都能正确还原。
 *
 * 链接策略（与 build-delivery.mjs 的说明一致）：符号链接与 Windows junction
 * 一律跳过——zip 存不了它们，跟着走会撞 .pnpm 的环，或者把打包机的绝对路径
 * 固化进客户机。它们在客户机首次运行时重建。
 */
import { createWriteStream } from 'node:fs'
import { open, readdir, lstat, readFile } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { join, relative, sep } from 'node:path'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
// Windows 的 reparse point（junction）不是 islink，但同样是链接。
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() / 2) & 0x1F)
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
  return { time: time & 0xFFFF, date: day & 0xFFFF }
}

async function isLink(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return true
    // junction：不是符号链接，但带 reparse point 属性。
    return Boolean((info.attributes ?? 0) & FILE_ATTRIBUTE_REPARSE_POINT)
  } catch { return false }
}

/** 深度优先收集文件，跳过链接与调用方排除的路径。 */
async function collect(root, { exclude = () => false } = {}) {
  const files = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (exclude(full)) continue
      if (await isLink(full)) continue
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await walk(root)
  return files
}

/**
 * 把 srcDir 打包成 zipPath。
 *
 * @returns {Promise<{files: number, bytes: number}>}
 */
export async function zipDirectory(srcDir, zipPath, { exclude = () => false, compress = true } = {}) {
  const files = await collect(srcDir, { exclude })
  const handle = await open(zipPath, 'w')
  const central = []
  let offset = 0
  try {
    for (const file of files) {
      const name = relative(srcDir, file).split(sep).join('/')
      const nameBytes = Buffer.from(name, 'utf8')
      const data = await readFile(file)
      const info = await lstat(file)
      const deflated = compress && data.length > 64 ? deflateRawSync(data, { level: 6 }) : null
      // 压不小就不压：已经压过的二进制（zip/png）再 deflate 只是白费时间。
      const useDeflate = deflated !== null && deflated.length < data.length
      const payload = useDeflate ? deflated : data
      const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
      const crc = crc32(data)
      const { time, date } = dosDateTime(info.mtime)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(SIG_LOCAL, 0)
      local.writeUInt16LE(20, 4)              // version needed
      local.writeUInt16LE(FLAG_UTF8, 6)       // ← 中文文件名不乱码的关键
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBytes.length, 26)
      local.writeUInt16LE(0, 28)
      await handle.write(local, 0, 30, offset)
      await handle.write(nameBytes, 0, nameBytes.length, offset + 30)
      await handle.write(payload, 0, payload.length, offset + 30 + nameBytes.length)

      central.push({ nameBytes, method, time, date, crc, compressed: payload.length, uncompressed: data.length, offset })
      offset += 30 + nameBytes.length + payload.length
    }

    const centralStart = offset
    for (const entry of central) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(SIG_CENTRAL, 0)
      header.writeUInt16LE(20, 4)             // version made by
      header.writeUInt16LE(20, 6)             // version needed
      header.writeUInt16LE(FLAG_UTF8, 8)
      header.writeUInt16LE(entry.method, 10)
      header.writeUInt16LE(entry.time, 12)
      header.writeUInt16LE(entry.date, 14)
      header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(entry.compressed, 20)
      header.writeUInt32LE(entry.uncompressed, 24)
      header.writeUInt16LE(entry.nameBytes.length, 28)
      header.writeUInt16LE(0, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE(0x20, 38)          // 普通文件属性
      header.writeUInt32LE(entry.offset, 42)
      await handle.write(header, 0, 46, offset)
      await handle.write(entry.nameBytes, 0, entry.nameBytes.length, offset + 46)
      offset += 46 + entry.nameBytes.length
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(offset - centralStart, 12)
    eocd.writeUInt32LE(centralStart, 16)
    eocd.writeUInt16LE(0, 20)
    await handle.write(eocd, 0, 22, offset)
    offset += 22
  } finally {
    await handle.close()
  }
  return { files: files.length, bytes: offset }
}

export { crc32 }
