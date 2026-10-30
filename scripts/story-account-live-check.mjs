/**
 * 情感故事号关键链路真实验证脚本（不进单测）。
 *
 * 为什么要有它：这个包最要紧的一段（独立审片）有过两次「测试全绿但真实必崩」：
 *   ① 审片拿不到任何画面证据（提示词里 frameFiles 恒空），模型编两个时间点
 *      就能过闸——双闸门实际只有一闸。
 *   ② 审片那一步把私有方法裸传出去，this 丢失，最后一步必崩。
 * 两次单测都发现不了：单测里审片执行器是假的、渲染是假的。
 *
 * 这个脚本反过来——ffmpeg 是真的、帧文件是真的、闸门判据是真的。它回答单测
 * 回答不了的问题：审片是不是真的看到了画面？缺证据时会不会放过？
 *
 * 用法：
 *   node scripts/story-account-live-check.mjs
 *
 * 产物写到仓库外的临时目录，跑完即删；不碰用户的 lwb/local/。
 * 模型调用用注入的假执行器（本脚本验的是**证据链与闸门判据**，不是模型质量）；
 * 真实模型那一段由 lead 在隔离实例上跑过（见提交记录）。
 */
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)
const workspace = await mkdtemp(join(tmpdir(), 'story-live-check-'))
const agent = { workspacePath: workspace }

let failed = 0
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`)
  if (!ok) failed += 1
}
async function shell(command, args, timeoutMs = 120000) {
  try {
    await run(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

try {
  const { StoryAccountContent } = await import('../lwb/packs/story-account/story-account-content.mjs')
  const { StoryAccountStore } = await import('../lwb/packs/story-account/story-account-store.mjs')
  const { extractReviewFrames, runIndependentReview } = await import('../lwb/packs/story-account/story-account-qc.mjs')
  const { resolveRemotionBrowserExecutable } = await import('../lwb/packs/story-account/story-account-remotion-browser.mjs')

  const store = new StoryAccountStore()
  const calls = { review: 0, reviewArgs: null }
  const content = new StoryAccountContent({
    workspacePath: workspace,
    // 审片执行器记录调用参数，用来证明「审片真的拿到了帧」。
    reviewExecutor: async (args) => {
      calls.review += 1
      calls.reviewArgs = args
      return {
        passed: true, technicalPass: true, editorialPass: true, score: 88,
        summary: '已看图：开场即冲突画面，字幕未压脸。',
        findings: [],
        reviewEvidence: [
          { timestampSeconds: 1, description: '开场是饭桌冲突画面' },
          { timestampSeconds: 3, description: '中段为情绪特写' },
        ],
      }
    },
    projectsStore: store,
  })

  /* ---------- 1. 账号矩阵与默认账号 ---------- */
  const accountA = await content.createAccount({ name: '账号甲', positioning: '专写中年夫妻之间说不出口的委屈与体面', audience: '35-50 岁女性' })
  const accountB = await content.createAccount({ name: '账号乙', positioning: '专写婆媳与原生家庭里说不出口的委屈', audience: '40-55 岁女性' })
  await content.setDefaultAccount({ id: accountB.id })
  const accounts = await content.listAccounts()
  check('账号矩阵：两个账号各持一份定位', accounts.items.length === 2, `${accounts.items.length} 个`)
  check('账号矩阵：默认账号指向账号乙', accounts.defaultId === accountB.id, accounts.defaultId || 'null')
  const resolved = await content.resolveAccount()
  check('下游 resolveAccount 取默认账号', resolved?.name === '账号乙', resolved?.name || 'null')

  /* ---------- 2. 造一段真实的竖屏视频（真 ffmpeg） ---------- */
  await mkdir(join(workspace, 'data', 'media', 'videos'), { recursive: true })
  const videoRelative = 'media/videos/live-check.mp4'
  const videoAbsolute = join(workspace, 'data', videoRelative)
  const made = await shell('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x2b1a12:s=1080x1920:d=6',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoAbsolute,
  ])
  check('造出真实竖屏测试视频', made.ok && existsSync(videoAbsolute))

  /* ---------- 3. 审片真抽帧 ---------- */
  const frames = await extractReviewFrames({ workspacePath: workspace, videoRelative, timestamps: [1, 3, 5], durationSeconds: 6 })
  check('审片真抽到帧', frames.length === 3, `${frames.length} 帧`)
  check('抽出的帧文件真实存在', frames.length > 0 && frames.every((f) => existsSync(f)))
  if (frames.length) {
    const size = (await readFile(frames[0])).length
    check('抽出的帧非空', size > 1000, `${size} bytes`)
  }

  /* ---------- 4. 审片执行器真的被调用，且真的拿到了帧 ---------- */
  const raw = await runIndependentReview({
    reviewExecutor: content.reviewExecutor,
    workspacePath: workspace,
    videoFile: videoRelative,
    sampledTimestamps: [1, 3, 5],
    durationSeconds: 6,
  })
  check('审片执行器被调用', calls.review > 0, `calls=${calls.review}`)
  // 执行器拿到的是拼好的 prompt 文本，帧以**路径**形式出现在里面
  // （与 spoken-video 的审片同款：路径给到，模型用 read_image 工具去读）。
  // 所以这里查 prompt 里有没有那 3 个帧路径，而不是查 frameFiles 数组。
  const promptText = String(calls.reviewArgs?.prompt || '')
  const framePathsInPrompt = [...promptText.matchAll(/frame-\d+\.png/gu)].map((m) => m[0])
  check('审片提示词里带上了抽帧画面', framePathsInPrompt.length === 3, `${framePathsInPrompt.length} 个帧路径`)
  check('审片提示词里带上了时间点', /\d+ 秒：/.test(promptText))
  check('审片有结论', !!raw && typeof raw.passed === 'boolean')

  /* ---------- 5. 缺证据时必须判不通过（关键防线） ---------- */
  const noFrame = await runIndependentReview({
    reviewExecutor: async () => { throw new Error('缺证据时不该调用审片执行器') },
    workspacePath: workspace,
    videoFile: 'media/videos/does-not-exist.mp4',
    sampledTimestamps: [1, 3, 5],
    durationSeconds: 6,
  })
  check('抽不到帧时审片判不通过（不放行）', noFrame.passed === false && noFrame.evidencePassed === false)
  check('判不通过时写明了原因', /证据|抽帧/.test(noFrame.summary || ''), (noFrame.summary || '').slice(0, 70))

  /* ---------- 6. 私有方法不得裸传（这正是审片崩溃的根因） ---------- */
  const source = await readFile(join(root, 'lwb', 'packs', 'story-account', 'story-account-content.mjs'), 'utf8')
  const barePrivate = [...source.matchAll(/:\s*this\.#[a-zA-Z]+\s*,/g)].map((m) => m[0].trim())
  check('没有把私有方法裸传成回调', barePrivate.length === 0, barePrivate.join(' / ') || 'none')

  /* ---------- 7. 渲染浏览器离线可解析 ---------- */
  const browser = resolveRemotionBrowserExecutable()
  check('能解析到渲染浏览器（离线不需下载）', !!browser && existsSync(browser), browser || 'null')
} catch (error) {
  failed += 1
  process.stdout.write(`FAIL  脚本异常：${error && error.message ? error.message : error}\n`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

process.stdout.write(`\n${failed ? `${failed} 项未通过` : '全部通过'}\n`)
process.exit(failed ? 1 : 0)
