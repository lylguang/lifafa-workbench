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

  // 干净环境下必须返回一个**真实存在**、且**不是 Chrome 153** 的浏览器。
  //
  // 2026-10-23 订正：原先这里断言结果必须是 Edge（`/Edge/i`）。装了配套
  // chrome-headless-shell 之后，`browserExecutableArgs()` 会**优先**返回它
  // （headless-shell 资源占用远低于完整浏览器、版本与 Remotion 精确配对、实测
  // 快 5.6 倍，且不受「16 路实例打不开」那堵墙影响）——于是断言失效。
  //
  // 真正要钉住的不变量是「**绝不落到 Chrome 153**」：它与 Remotion 4.0.522
  // 组合会整页零像素（成片一片纯色，2026-10-22 线上事故）。headless-shell 与
  // Edge 都是安全的，所以断言放宽为「不是 Chrome」，而不是钉死某一个浏览器。
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
    assert.doesNotMatch(args[1], /Chrome[\\/]Application[\\/]chrome\.exe$/iu,
      '绝不能选到 Chrome：Chrome 153 配 Remotion 4.0.522 会整页零像素（成片一片纯色）');
    // 有随包 headless-shell 时应当优先用它——它最快、版本配对，且不受实例数上限影响。
    const sharedShell = args[1].toLowerCase().includes('chrome-headless-shell');
    const bundled = existsSync(join(REPO, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    if (bundled) {
      assert.ok(sharedShell || /Edge/i.test(args[1]),
        `本机已装配套 headless-shell，应当优先使用它（当前选中 ${args[1]}）`);
    }
  } finally {
    if (saved.shell !== undefined) process.env.LWB_REMOTION_HEADLESS_SHELL = saved.shell;
    if (saved.override !== undefined) process.env.LWB_REMOTION_BROWSER_EXECUTABLE = saved.override;
  }
});

/**
 * 回归：渲染并发度必须停在 12，不得调回 16。
 *
 * 2026-10-23 实测（真实生产工程，同机同 Edge 155，只改 --concurrency）：
 *   4/8/12 稳定通过；**16 确定性失败**（6/6），签名固定为
 *   `Visited "http://localhost:3000/index.html" but got no response`，
 *   失败点在 `Promise.all (index 11)`——第 12 个浏览器实例建页时无响应。
 *
 * 先前注释断言「真实项目同参数（--concurrency 16）实测可跑通，因此判定为
 * 测试环境特有问题，不影响用户」——该结论已被证伪：真实用户任务正是死在这个
 * 签名上（2026-10-23 00:09 的任务日志写着「浏览器启动失败已重试 2 次」后仍失败）。
 *
 * 所以这条断言要钉住的是**上限**，不是某个具体值：16 必败，12 是实测最高稳定档。
 * 后人若看到「16 更快」就调回去，用户会重新拿到 100% 失败的长片渲染。
 */
test('渲染并发度停在 12：16 在 Edge 155 上确定性失败（6/6）', async () => {
  const { RENDER_CONCURRENCY } = await import('file:///' + SRC.replace(/\\/g, '/'));
  assert.ok(RENDER_CONCURRENCY <= 12,
    `渲染并发度必须 ≤ 12（实测 16 必败：第 12 个浏览器实例起建页无响应），当前是 ${RENDER_CONCURRENCY}`);
  assert.ok(RENDER_CONCURRENCY >= 4,
    `并发度不应低到没有意义（实测 4 稳定通过），当前是 ${RENDER_CONCURRENCY}`);
});
