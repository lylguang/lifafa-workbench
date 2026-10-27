/**
 * 回填「审片否决但成片已渲染」的历史记录。
 *
 * 2026-10-26 修的一个产品缺口：审片否决时成片已经渲染完，但提交动作在审片之后，
 * 于是盘上那条成片从来没进过 media/videos/，项目里也查不到，用户只看到「全部失败」。
 * 代码已改成「否决也落盘 + 记 rejectedCut」，但**历史记录**是旧代码产生的，
 * 没有 rejectedCut 字段，前端不会给放行入口。这个脚本把历史记录补上。
 *
 * 只补数据、不改结论：technical / review 的判定原样保留，只是把成片从渲染目录
 * 复制到 media/videos/ 并登记到 run.rejectedCut。放不放行仍由用户在界面上决定。
 *
 * 用法：node scripts/backfill-rejected-cuts.mjs [--dry-run]
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ROOT = 'D:/lifafa-workbench/lwb/local/dsh-home/profiles/lwb/pack-state/workspaces/spoken-video/data/projects'
const DRY = process.argv.includes('--dry-run')

const exists = async (path) => { try { await stat(path); return true } catch { return false } }

let scanned = 0
let backfilled = 0
let skipped = 0

for (const projectId of await readdir(ROOT)) {
  const runsFile = join(ROOT, projectId, 'media', 'runs.json')
  if (!await exists(runsFile)) continue
  let data
  try { data = JSON.parse(await readFile(runsFile, 'utf8')) } catch { continue }
  let changed = false

  for (const run of data.runs || []) {
    if (run.type !== 'video' || run.status !== 'failed') continue
    const pipeline = run.pipeline || {}
    // 只处理「技术质检过、审片不过」这一种：技术质检自己没过时成片可能是空白的，
    // 那种放行语义完全不同（见界面上的另一条路径），不该在这里批量补。
    if (!pipeline.review || pipeline.review.passed !== false) continue
    if (!pipeline.technical || pipeline.technical.passed !== true) continue
    if (run.rejectedCut) { skipped += 1; continue }
    scanned += 1

    const renderedPath = join(ROOT, projectId, pipeline.workspaceDir || '', 'outputs', 'final_video.mp4')
    if (!pipeline.workspaceDir || !await exists(renderedPath)) {
      console.log(`  跳过 ${run.id.slice(0, 8)}：找不到渲染产物`)
      skipped += 1
      continue
    }

    const videoRel = `media/videos/${run.id}.mp4`
    const videoAbs = join(ROOT, projectId, videoRel)
    const info = await stat(renderedPath)
    const reportRel = `media/qc/${run.id}.json`
    const reviewRel = `media/qc/${run.id}-editorial.json`

    if (!DRY) {
      await mkdir(dirname(videoAbs), { recursive: true, mode: 0o700 })
      await copyFile(renderedPath, videoAbs)
      // 报告也补齐：放行时前端要读技术质检报告原文，不能凭记忆重造。
      // media/qc/ 目录在旧记录里可能根本没建过（旧代码走不到提交那一步）。
      await mkdir(dirname(join(ROOT, projectId, reportRel)), { recursive: true, mode: 0o700 })
      if (pipeline.technicalReportFile && await exists(join(ROOT, projectId, pipeline.technicalReportFile))) {
        const technical = JSON.parse(await readFile(join(ROOT, projectId, pipeline.technicalReportFile), 'utf8'))
        const review = pipeline.reviewReportFile && await exists(join(ROOT, projectId, pipeline.reviewReportFile))
          ? JSON.parse(await readFile(join(ROOT, projectId, pipeline.reviewReportFile), 'utf8'))
          : pipeline.review
        await writeFile(join(ROOT, projectId, reportRel), `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, technical, review }, null, 2)}\n`)
        await writeFile(join(ROOT, projectId, reviewRel), `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: run.projectId, videoTaskId: run.id, ...review }, null, 2)}\n`)
      }
      run.rejectedCut = {
        videoFile: videoRel,
        bytes: info.size,
        durationSeconds: pipeline.technical?.video?.durationSeconds ?? null,
        width: pipeline.technical?.video?.width ?? null,
        height: pipeline.technical?.video?.height ?? null,
        fps: pipeline.technical?.video?.fps ?? null,
        technicalPassed: true,
        reviewScore: pipeline.review.score ?? null,
        reviewSummary: pipeline.review.summary ?? '',
        reportFile: reportRel,
        reviewFile: reviewRel,
        recordedAt: new Date().toISOString(),
        backfilled: true,
      }
      changed = true
    }
    backfilled += 1
    console.log(`  ${DRY ? '[dry] ' : ''}回填 ${run.id.slice(0, 8)} | ${(info.size / 1024 / 1024).toFixed(1)}MB | 审片 ${pipeline.review.score} 分 | ${(run.source?.title || '').slice(0, 28)}`)
  }

  if (changed) await writeFile(runsFile, `${JSON.stringify(data, null, 2)}\n`)
}

console.log(`\n扫描 ${scanned} 条，回填 ${backfilled} 条，跳过 ${skipped} 条${DRY ? '（dry-run，未写入）' : ''}`)
