import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const REPO = 'D:\\lifafa-workbench';
const CMD = join(REPO, '启动工作台.cmd');
const SRC = join(REPO, 'lwb', 'packs', 'spoken-video', 'spoken-video-remotion.mjs');

test('启动工作台.cmd 不得预设 LWB_REMOTION_BROWSER_EXECUTABLE 为任何具体浏览器', () => {
  assert.ok(existsSync(CMD), '启动工作台.cmd 应存在');
  // GB18030 解码：文件是中文 Windows 代码页，用 utf8 解会得到乱码
  const text = new TextDecoder('gb18030').decode(readFileSync(CMD));

  // 1) 只允许「留空」这一种写法
  const assignments = [...text.matchAll(/set\s+"LWB_REMOTION_BROWSER_EXECUTABLE=([^"]*)"/giu)];
  assert.ok(assignments.length >= 1, '必须保留 set "LWB_REMOTION_BROWSER_EXECUTABLE=" 这个留空出口');
  for (const m of assignments) {
    assert.equal(m[1].trim(), '', `不得把 LWB_REMOTION_BROWSER_EXECUTABLE 预设成具体路径，当前是：${m[1]}`);
  }

  // 2) 不得出现任何「条件存在就设成 Chrome」的分支
  assert.doesNotMatch(text, /set\s+"LWB_REMOTION_BROWSER_EXECUTABLE=%LOCALAPPDATA%/iu,
    '不得预设用户级 Chrome——那会越过 browserExecutableArgs() 的 Edge 优先');
  assert.doesNotMatch(text, /set\s+"LWB_REMOTION_BROWSER_EXECUTABLE=%ProgramFiles%/iu,
    '不得预设 Program Files 级 Chrome');

  // 3) 配套 headless-shell 那段必须保留（版本配对、路径短、实测快 5.6 倍）
  assert.match(text, /LWB_REMOTION_HEADLESS_SHELL=%~dp0/u,
    '配套 headless-shell 的预设必须保留');
});

test('browserExecutableArgs 的环境变量采信确实排在系统 Edge 之前（这条链路是本修复的前提）', async () => {
  const { browserExecutableArgs, chromiumCandidates } = await import('file:///' + SRC.replace(/\\/g, '/'));

  // 候选顺序：Windows 上 Edge 必须排在 Chrome 之前
  const candidates = chromiumCandidates();
  if (process.platform === 'win32') {
    const firstEdge = candidates.findIndex((p) => /Edge/i.test(p));
    const firstChrome = candidates.findIndex((p) => /Chrome/i.test(p));
    assert.ok(firstEdge !== -1 && firstChrome !== -1, '候选里应同时含 Edge 与 Chrome');
    assert.ok(firstEdge < firstChrome, 'Edge 必须排在 Chrome 之前，否则 Chrome 153 会抢走渲染');
  }

  // 干净环境下必须返回 Edge（这正是「.cmd 不再钉 Chrome」之后的实际行为）
  const saved = {
    shell: process.env.LWB_REMOTION_HEADLESS_SHELL,
    override: process.env.LWB_REMOTION_BROWSER_EXECUTABLE,
  };
  delete process.env.LWB_REMOTION_HEADLESS_SHELL;
  delete process.env.LWB_REMOTION_BROWSER_EXECUTABLE;
  try {
    const args = browserExecutableArgs();
    assert.equal(args[0], '--browser-executable');
    assert.ok(args[1] && existsSync(args[1]), `返回的路径必须真实存在：${args[1]}`);
    assert.match(args[1], /Edge/i, '干净环境下应探测到 Edge；若本机无 Edge 请自行调整此断言');
  } finally {
    if (saved.shell !== undefined) process.env.LWB_REMOTION_HEADLESS_SHELL = saved.shell;
    if (saved.override !== undefined) process.env.LWB_REMOTION_BROWSER_EXECUTABLE = saved.override;
  }
});
