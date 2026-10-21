/**
 * 测试专用的文件系统辅助。
 *
 * 为什么需要这个模块：非管理员且未开开发者模式的 Windows 上，
 * `fs.symlink(src, dst, 'dir')` 必然 EPERM（2026-10-21 用户真实撞上：
 * 视频制作报 `EPERM: operation not permitted, symlink`）。测试里若直接用它
 * 构造「目录被换成链接」这类场景，就会在真实用户机器上红，而在 Linux CI 上绿
 * ——这种测试等于没测。
 *
 * 因此所有「造目录链接」的测试都走 {@link linkDirectoryForTest}：
 * Windows 用 `'junction'` 类型（不需要管理员权限），其他平台保持 `'dir'`。
 *
 * 注意两个语义差异（实测确认，不要凭推断）：
 *  · Junction 在 `lstat` 里 `isSymbolicLink()` 返回 **true**、
 *    `isDirectory()` 返回 **false**。判「是不是链接」只能用前者。
 *  · Junction **只能指向目录**。指向文件的场景在非管理员 Windows 上构造不出来，
 *    那种用例要用 {@link canSymlinkFiles} 判断后明确跳过，不许假通过。
 */
import { lstat, symlink } from 'node:fs/promises'
import { platform } from 'node:process'

/** 建立 source → target 的目录链接。source 必须是已存在的目录。 */
export async function linkDirectoryForTest(sourceDir, targetDir) {
  if (platform === 'win32') {
    // fs.symlink 的 'junction' 类型在 Windows 上不需要管理员权限（实测确认）。
    // 它比调 cmd /c mklink 干净：不依赖外部命令、路径含中文/空格也不用担心引号。
    await symlink(sourceDir, targetDir, 'junction')
    return
  }
  await symlink(sourceDir, targetDir, 'dir')
}

/** 本机能否建立「文件」符号链接。false 时指向文件的场景无法构造。 */
export async function canSymlinkFiles(probeDir) {
  const source = `${probeDir}/symlink-probe-source.txt`
  const target = `${probeDir}/symlink-probe-target.txt`
  const { writeFile, rm } = await import('node:fs/promises')
  try {
    await writeFile(source, 'probe')
    await symlink(source, target, 'file')
    return true
  } catch {
    return false
  } finally {
    await rm(source, { force: true })
    await rm(target, { force: true })
  }
}

/** 目标路径是否为链接（符号链接或 Junction 都算）。 */
export async function isDirectoryLink(path) {
  const info = await lstat(path).catch(() => null)
  return Boolean(info?.isSymbolicLink())
}
