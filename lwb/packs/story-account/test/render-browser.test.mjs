import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { renderStoryVideo, StoryRenderError } from '../story-account-render.mjs'
import { resolveRemotionBrowserExecutable } from '../story-account-remotion-browser.mjs'

// 渲染浏览器必须本机可解析，绝不能让 Remotion 去 storage.googleapis.com 联网下载。
test('本机解析到已安装的渲染浏览器，且路径真实存在（渲染不会联网下载）', () => {
  const exe = resolveRemotionBrowserExecutable()
  assert.ok(exe, '应解析到本机已有的渲染浏览器（vendor 安装的 chrome-headless-shell）')
  assert.ok(existsSync(exe), `解析到的浏览器路径必须真实存在：${exe}`)
})

test('渲染参数带 --browser-executable，且路径在本机存在（不触发联网下载）', async () => {
  let captured = null
  const fakeRun = async (cmd, args) => { captured = args; return }
  await renderStoryVideo(
    { projectDir: 'p', outputPath: 'o', propsFile: 'f', spec: { width: 1080, height: 1920, fps: 30 } },
    { remotionAvailable: async () => true, run: fakeRun },
  )
  assert.ok(captured.includes('--browser-executable'), '渲染参数必须显式指定浏览器，禁止 Remotion 联网下载')
  const path = captured[captured.indexOf('--browser-executable') + 1]
  assert.ok(existsSync(path), `传入的浏览器路径必须存在：${path}`)
})

test('没有可用浏览器时抛出带下一步说明的领域错误，而不是让 Remotion 去联网下载', async () => {
  const workspace = { projectDir: 'p', outputPath: 'o', propsFile: 'f', spec: { width: 1080, height: 1920, fps: 30 } }
  await assert.rejects(
    () => renderStoryVideo(workspace, { remotionAvailable: async () => true, resolveBrowser: () => null }),
    (err) => err instanceof StoryRenderError
      && err.code === 'STORY_RENDER_UNAVAILABLE'
      && /启动工作台|npm run setup|LWB_REMOTION_BROWSER_EXECUTABLE/.test(err.message),
    '报错必须告诉用户下一步怎么做，而不是一句干巴巴的「渲染失败」',
  )
})
