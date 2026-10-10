// 锁住运维脚本与仓库的约定。这些脚本不在 npm test 的常规路径上，但它们一旦
// 失效，定时任务在无人值守时就会静默停摆——而失效方式是静默的（保活日志里
// 只多一行「目录不存在」），所以必须有东西盯着。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const OPS = ['lwb-keepalive.ps1', 'lwb-alert.ps1']

for (const name of OPS) {
  test(`${name} is a UTF-8-with-BOM file, exactly one BOM`, async () => {
    // PowerShell 5.1 按 ANSI 读无 BOM 的脚本，中文会变乱码；
    // 重复 BOM 更糟：首行变成「?#」，脚本整体报错。2026-10-10 两次都踩过。
    const bytes = await readFile(fileURLToPath(new URL(`../../../ops/${name}`, import.meta.url)))
    let count = 0
    let offset = 0
    while (bytes[offset] === 0xEF && bytes[offset + 1] === 0xBB && bytes[offset + 2] === 0xBF) {
      count += 1
      offset += 3
    }
    assert.equal(count, 1, `${name} 必须恰好一个 BOM，实际 ${count} 个`)
  })

  test(`${name} locates the repository instead of hardcoding a drive letter`, async () => {
    const source = await readFile(fileURLToPath(new URL(`../../../ops/${name}`, import.meta.url)), 'utf8')
    // 不允许出现「盘符 + Users\用户名」这种硬编码。
    assert.doesNotMatch(
      source,
      /[A-Za-z]:\\Users\\/u,
      `${name} 里仍有硬编码的用户目录；路径必须走 lwb-repo.txt 或环境变量`,
    )
    // 兜底查找必须验证判据目录存在，否则会拼出一个看起来合理却不存在的路径。
    // 2026-10-10 实测：$env:USERPROFILE 在 C 盘而真实桌面在 F 盘，前者的 Desktop
    // 目录恰好也存在——不验证就会一直报「目录不存在」而没人知道差在哪。
    assert.match(
      source,
      /Test-Path \(Join-Path \$candidate '(?:media-bridge|lwb)'\)/u,
      `${name} 的盘符兜底必须验证仓库根确实存在`,
    )
  })
}

test('the repo pointer file is documented as UTF-8 without BOM', async () => {
  // 它是被 Get-Content -Encoding UTF8 读的；带 BOM 会让路径首字符变成看不见的
  // 宽字符，拼出来的路径永远不存在。
  const readme = await readFile(fileURLToPath(new URL('../../../ops/README.md', import.meta.url)), 'utf8')
  assert.match(readme, /UTF-8 无 BOM/u)
  assert.match(readme, /UTF-8 with BOM/u, '两个 .ps1 本身仍需 BOM，方向不能混淆')
})

test('ops/.gitignore keeps the machine-specific pointer out of the repo', async () => {
  const ignore = await readFile(fileURLToPath(new URL('../../../ops/.gitignore', import.meta.url)), 'utf8')
  assert.match(ignore, /^lwb-repo\.txt$/mu)
})