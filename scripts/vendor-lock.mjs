/**
 * vendor 基座锁定守卫。
 *
 * 「构建错基座」比「构建失败」更难查：vendor 里装的是上一个 commit 的依赖，
 * 构建却按新 commit 的源码跑，产物看着正常、运行时才炸。所以凡是会对 vendor
 * 执行 install / build 的脚本，都必须先核对 vendor HEAD 与
 * `lwb/UPSTREAM.lock.json` 的 `commit` 一致。
 *
 * 这里单独成文件而不是各脚本各写一份，是因为重复的守卫逻辑会被当成缺陷：
 * 两份实现迟早会漂移，其中一份漏校验就等于没有守卫。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读取锁定文件里记录的 vendor commit。
 * @param root - 仓库根目录。
 * @returns the locked commit sha.
 */
export function lockedCommit(root) {
  const lock = JSON.parse(readFileSync(join(root, 'lwb', 'UPSTREAM.lock.json'), 'utf8'))
  return lock.commit
}

/**
 * 读 vendor 当前 HEAD；vendor 不是 git 仓库时返回 undefined（不阻断）。
 * @param vendor - vendor checkout 目录。
 * @returns the vendor HEAD sha, or undefined.
 */
export function vendorHead(vendor) {
  const result = spawnSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

/**
 * 比对 vendor HEAD 与锁定 commit。
 * @param root - 仓库根目录。
 * @param vendor - vendor checkout 目录。
 * @returns the expected commit, the actual HEAD (or undefined), and whether they match.
 */
export function compareVendorHead(root, vendor) {
  const expected = lockedCommit(root)
  const actual = vendorHead(vendor)
  return { expected, actual, matched: actual === expected }
}
