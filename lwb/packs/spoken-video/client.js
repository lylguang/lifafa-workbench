window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-spoken-video',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const { IconSettingsOutline16, MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    // 提示音与桌面通知。
    //
    // 定时任务是无人值守的，改造前工作台对这件事的回应是零——只有一个 CSS 脉冲
    // 小圆点。这里用 WebAudio 实时合成而不是音频文件：完成音与失败音是两段不到
    // 半秒的正弦波，合成出来 0 字节资源、没有加载延迟，也不会出现「文件没打进包
    // 所以没声音」这种问题。
    //
    // 浏览器关掉时这条通道失效，由 alerts.json 加独立的 Windows 计划任务兜底。
    const NOTIFY_KEY = 'lwb.notify.v1';
    const notifySettings = { sound: true, desktop: false };
    try {
      const raw = window.localStorage?.getItem(NOTIFY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.sound === 'boolean') notifySettings.sound = parsed.sound;
        if (typeof parsed.desktop === 'boolean') notifySettings.desktop = parsed.desktop;
      }
    } catch (_) { /* 隐私模式下 localStorage 会抛 */ }
    const notifySave = () => { try { window.localStorage?.setItem(NOTIFY_KEY, JSON.stringify(notifySettings)); } catch (_) {} };
    // 上行双音 = 到头了，好事；下行低音 = 沉、留尾巴。隔一层墙也分得出。
    const NOTIFY_VOICES = {
      success: [[660, 0.18, 0.22, 0], [880, 0.22, 0.22, 0.18]],
      error: [[440, 0.22, 0.26, 0], [220, 0.34, 0.24, 0.22], [120, 0.5, 0.2, 0.24]],
      attention: [[880, 0.16, 0.22, 0], [880, 0.16, 0.22, 0.26]],
    };
    let notifyCtx = null;
    let notifyLast = { key: '', at: 0 };
    const notifyAudio = () => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!notifyCtx || notifyCtx.state === 'closed') notifyCtx = new Ctx();
      return notifyCtx;
    };
    function notifyPlay(voiceName) {
      if (!notifySettings.sound) return false;
      const voice = NOTIFY_VOICES[voiceName];
      if (!voice) return false;
      try {
        const ctx = notifyAudio();
        if (!ctx) return false;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        for (const [frequency, duration, peak, delay] of voice) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(frequency, now + delay);
          // 5 毫秒淡入、指数衰减：避免咔哒声。
          gain.gain.setValueAtTime(0.0001, now + delay);
          gain.gain.exponentialRampToValueAtTime(peak, now + delay + 0.005);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + delay);
          osc.stop(now + delay + duration + 0.02);
        }
        return true;
      } catch (_) { return false; }
    }
    /** 解锁音频：必须在用户手势里调用一次，否则后续自动播放全被拦。 */
    function notifyUnlock() {
      try {
        const ctx = notifyAudio();
        if (!ctx) return false;
        if (ctx.state === 'suspended') ctx.resume();
        return ctx.state === 'running';
      } catch (_) { return false; }
    }
    /** 同一事件只响一次：轮次终态会被连续几轮轮询读到，不去重就响成一片。 */
    function notifyOnce(key, voiceName) {
      const signature = `${key}:${voiceName}`;
      const at = Date.now();
      if (notifyLast.key === signature && at - notifyLast.at < 60_000) return false;
      notifyLast = { key: signature, at };
      return notifyPlay(voiceName);
    }
    function notifyDesktop(title, body) {
      if (!notifySettings.desktop || typeof window.Notification !== 'function') return false;
      if (window.Notification.permission !== 'granted') return false;
      try {
        const n = new window.Notification(title, { body, tag: title, silent: true });
        n.onclick = () => { window.focus?.(); n.close(); };
        return true;
      } catch (_) { return false; }
    }
    function notifyRequestDesktop() {
      if (typeof window.Notification !== 'function') return Promise.resolve('unsupported');
      if (window.Notification.permission !== 'default') return Promise.resolve(window.Notification.permission);
      return window.Notification.requestPermission().then((permission) => {
        if (permission === 'granted') { notifySettings.desktop = true; notifySave(); }
        return permission;
      }).catch(() => 'denied');
    }
    const notify = { play: notifyPlay, playOnce: notifyOnce, unlock: notifyUnlock, notifyDesktop, requestDesktop: notifyRequestDesktop, settings: notifySettings };
    let connection; let executionRemote; let executionStreams;
    let audioCaptionsHandoff = null;
    // 选题页 → 写稿页：把刚加入待写稿的项目带过去，让写稿页直接选中并打开抽屉。
    // 此前选题抽屉底部只有「生成新一批 / 完成」，用户选完只能自己去切页，
    // 于是「已加入待写稿」看着像终点、实际没往下走（2026-10-11 反馈）。
    let scriptsHandoff = null;
    let publishHandoff = null;
    // Pipeline board → work page: carries the target project so the destination
    // page selects it on mount. Keyed by page id, mirroring openPackMenu ids.
    let pipelineHandoff = null;
    const STAGES = ['signals', 'topic', 'script', 'voiceover', 'subtitles', 'video', 'qc', 'packaging'];
    const LABEL = { signals: '信号', topic: '选题', script: '写稿', voiceover: '配音', subtitles: '字幕', video: '视频制作', qc: '质检', packaging: '发布资料' };
    const DEFAULT_VIDEO_VISUAL_BRIEF = '由 AI 视觉导演根据稿件语义完成主题化 Remotion 画面。';
    const SOURCES = { baidu: '百度热榜', toutiao: '今日头条', 'douyin-hot': '抖音热榜', 'bilibili-popular': 'B站热门内容', 'zhihu-hot': '知乎热榜', 'weibo-hot': '微博热搜', 'huggingface-papers': 'AI 论文日报 · Hugging Face', '36kr': '36氪', infoq: 'InfoQ', ithome: 'IT之家', geekpark: '极客公园', ifanr: '爱范儿', sspai: '少数派', juejin: '掘金', 'github-trending': 'GitHub Trending', 'hacker-news': 'Hacker News', 'ai-daily-import': 'AI 内容日报' };
    const css = `
      .sv-page { display:grid; gap:18px; max-width:1420px; margin:0 auto; } .sv-page * { box-sizing:border-box; } .sv-top { display:flex; flex-wrap:wrap; justify-content:space-between; gap:14px; padding-bottom:14px; border-bottom:1px solid var(--lwb-line); } .sv-top h1,.sv-section h3,.sv-form h3 { margin:0; font-size:var(--lwb-text-section,18px); } .sv-top p,.sv-meta,.sv-item p { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; } .sv-section { display:grid; gap:11px; } .sv-section-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; } .sv-section-head span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); } .sv-layout { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(270px,.85fr); gap:20px; align-items:start; } .sv-list { display:grid; gap:8px; } .sv-item,.sv-form,.sv-source { display:grid; gap:9px; padding:14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); } .sv-item[data-active="true"] { border-color:#9fc2ec; background:var(--lwb-blue-soft); } .sv-item-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:9px; } .sv-item-title { overflow:hidden; font-size:var(--lwb-text-md,15px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; } .sv-tag,.sv-stage { display:inline-flex; min-height:21px; flex:none; align-items:center; padding:0 7px; border-radius:5px; color:var(--lwb-blue); background:var(--lwb-blue-soft); font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; } .sv-stage { color:var(--lwb-green); background:var(--lwb-green-soft); } .sv-input,.sv-textarea,.sv-select { width:100%; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-base,14px); } .sv-input,.sv-select { height:36px; padding:0 10px; } .sv-textarea { min-height:114px; padding:9px; resize:vertical; line-height:1.6; } .sv-input:focus,.sv-textarea:focus,.sv-select:focus { border-color:var(--lwb-blue); outline:0; box-shadow:0 0 0 2px var(--lwb-blue-soft); } .sv-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; } .sv-error,.sv-note { margin:0; padding:10px 11px; border:1px solid #e6b5b5; border-radius:7px; color:#994646; background:#fff7f7; font-size:var(--lwb-text-sm,13px); line-height:1.55; } .sv-note { border-color:#bad5ed; color:#486277; background:#f7fbff; } .sv-empty { padding:34px 12px; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); text-align:center; } .sv-source-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; } .sv-source { min-height:155px; } .sv-source a,.sv-url { overflow:hidden; color:var(--lwb-blue); font-size:var(--lwb-text-sm,13px); text-overflow:ellipsis; white-space:nowrap; } .sv-checks { display:grid; gap:7px; } .sv-basis { display:grid; gap:7px; padding:11px; border:1px dashed var(--lwb-line); border-radius:8px; background:var(--lwb-surface); } .sv-basis .sv-item { padding:9px 11px; } .sv-basis-text { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.55; white-space:pre-wrap; word-break:break-word; } .sv-warn-list { display:grid; gap:4px; margin:0; padding:9px 11px 9px 24px; border:1px solid #ecd39b; border-radius:7px; color:#7a5b17; background:#fffaf0; font-size:var(--lwb-text-sm,13px); line-height:1.5; } .sv-form summary { cursor:pointer; color:var(--lwb-blue); font-size:var(--lwb-text-base,14px); } .sv-checks label,.sv-signal { display:flex; align-items:flex-start; gap:7px; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.5; } .sv-signal { padding:9px; border-bottom:1px solid var(--lwb-line); cursor:pointer; } .sv-signal:last-child { border-bottom:0; } .sv-signal input { margin-top:3px; } .sv-signal small { display:block; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); } .sv-toolbar,.sv-stat-grid,.sv-filter-grid { display:flex; flex-wrap:wrap; gap:8px; align-items:center; } .sv-stat { min-width:112px; padding:10px 12px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-surface); } .sv-stat strong { display:block; color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); } .sv-stat span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); } .sv-filter-grid > * { flex:1 1 145px; } .sv-source-detail { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); line-height:1.5; } .sv-status-error { color:#a94343; background:#fff1f1; } .sv-status-disabled { color:#6d7280; background:#f2f3f5; } .sv-status-manual { color:#8059aa; background:#f5effb; } .sv-status-warn { color:#7a5b17; background:#fff6e2; } .sv-preflight { display:grid; gap:7px; margin:0; padding:12px 14px; border:1px solid #e6b5b5; border-left:3px solid #e5484d; border-radius:8px; color:#8a3b3b; background:#fff7f7; font-size:var(--lwb-text-sm,13px); line-height:1.6; } .sv-preflight strong { font-size:var(--lwb-text-base,14px); } .sv-preflight ul { display:grid; gap:5px; margin:0; padding-left:18px; } body[data-ds-dark-theme] .sv-preflight { border-color:#7a4444; border-left-color:#e5484d; color:#e8b9b9; background:#3a2323; } .sv-status-ready { color:#1f7354; background:#eaf8f1; } .sv-inline-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; } .sv-inline-form .sv-wide { grid-column:1/-1; } .sv-run-list { max-height:360px; overflow:auto; } .sv-signal-shell { display:grid; gap:16px; } .sv-live-pill { display:inline-flex; flex:none; align-items:center; gap:8px; padding:6px 13px; border:1px solid rgba(62,207,142,.35); border-radius:999px; color:#8fe6bd; background:rgba(62,207,142,.12); font-size:var(--lwb-text-base,14px); } .sv-live-dot { width:8px; height:8px; border-radius:50%; background:#3ecf8e; animation:sv-pulse 1.8s ease-in-out infinite; } @keyframes sv-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } } body[data-ds-dark-theme] .sv-note { border-color:#2c5578; color:#a9c9e6; background:#16324a; } body[data-ds-dark-theme] .sv-error { border-color:#7a4444; color:#e8b9b9; background:#3a2323; } body[data-ds-dark-theme] .sv-warn-list { border-color:#7a6534; color:#e8d9a9; background:#332b1b; } .sv-pipeline { display:grid; gap:13px; padding:16px 20px 18px; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-surface); } .sv-pipeline-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; } .sv-pipeline-head h3 { margin:0; font-size:var(--lwb-text-md,15px); } .sv-pipeline-track { display:flex; align-items:flex-start; overflow-x:auto; padding-bottom:2px; } .sv-pipeline-node { display:flex; flex:none; flex-direction:column; align-items:center; gap:6px; } .sv-pipeline-dot { display:flex; width:26px; height:26px; align-items:center; justify-content:center; border-radius:50%; font-size:var(--lwb-text-base,14px); font-weight:700; } .sv-pipeline-dot[data-state="done"] { background:var(--lwb-blue); color:#fff; } .sv-pipeline-dot[data-state="current"] { background:var(--lwb-green); color:#fff; box-shadow:0 0 0 4px var(--lwb-green-soft); } .sv-pipeline-dot[data-state="todo"] { border:1px solid var(--lwb-line); background:var(--lwb-surface); color:var(--lwb-muted); } .sv-pipeline-bar { flex:1 0 14px; height:2px; margin-top:12px; background:var(--lwb-line); } .sv-pipeline-bar[data-done="true"] { background:var(--lwb-blue); } .sv-pipeline-label { color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); white-space:nowrap; } .sv-pipeline-node[data-state="done"] .sv-pipeline-label { color:var(--lwb-ink); } .sv-pipeline-node[data-state="current"] .sv-pipeline-label { color:var(--lwb-green); font-weight:700; } .sv-eyebrow { margin:0 0 7px; color:#477194; font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.12em; } .sv-tabs { display:flex; gap:4px; border-bottom:1px solid var(--lwb-line); } .sv-tab { padding:9px 12px; border:0; border-bottom:2px solid transparent; color:var(--lwb-muted); background:transparent; cursor:pointer; font:inherit; font-size:var(--lwb-text-base,14px); font-weight:700; } .sv-tab[data-active="true"] { border-color:var(--lwb-blue); color:var(--lwb-blue); } .sv-dashboard { display:grid; grid-template-columns:minmax(0,1fr) 288px; gap:16px; align-items:start; } .sv-feed { display:grid; gap:10px; } .sv-feed-toolbar { display:grid; grid-template-columns:minmax(220px,1fr) 156px 135px; gap:8px; padding:12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); } .sv-signal-card { display:grid; gap:8px; padding:15px 16px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); transition:border-color .15s ease,box-shadow .15s ease; } .sv-signal-card:hover { border-color:#a8c8e4; box-shadow:0 5px 18px rgba(36,87,127,.07); } .sv-signal-title { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); line-height:1.45; } .sv-signal-summary { display:-webkit-box; overflow:hidden; margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.65; -webkit-box-orient:vertical; -webkit-line-clamp:2; } .sv-signal-foot { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; align-items:center; } .sv-kpi { display:flex; flex-wrap:wrap; gap:5px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); } .sv-score { color:#3571a4; font-weight:800; } .sv-insight-panel { position:sticky; top:16px; display:grid; gap:12px; padding:15px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); } .sv-insight-panel h3 { margin:0; font-size:var(--lwb-text-md,15px); } .sv-family-list { display:grid; gap:5px; } .sv-family-row { display:flex; align-items:center; justify-content:space-between; width:100%; padding:7px 0; border:0; color:var(--lwb-ink); background:transparent; cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); text-align:left; } .sv-family-row[data-active="true"] { color:var(--lwb-blue); font-weight:800; } .sv-family-row small { color:var(--lwb-muted); } .sv-source-table { display:grid; gap:12px; } .sv-family-section { display:grid; gap:10px; padding:15px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); } .sv-source-compact-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(245px,1fr)); gap:8px; } .sv-source-compact { display:grid; gap:7px; padding:13px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-surface); }  .sv-source-health { display:flex; flex-wrap:wrap; gap:5px; } .sv-drawer-backdrop { position:fixed; z-index:40; inset:0; border:0; background:rgba(24,39,52,.35); } .sv-drawer { position:fixed; z-index:41; top:0; right:0; bottom:0; width:min(560px,100vw); overflow:auto; padding:22px; border-left:1px solid var(--lwb-line); background:var(--lwb-surface); box-shadow:-16px 0 40px rgba(23,47,70,.18); } .sv-drawer-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:16px; } @media (max-width:900px) { .sv-dashboard { grid-template-columns:1fr; } .sv-insight-panel { position:static; } } @media (max-width:780px) {  } .sv-board { display:grid; gap:16px; } .sv-board-group { display:grid; gap:9px; } .sv-board-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:10px; } .sv-board-card { position:relative; display:grid; overflow:hidden; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-surface); transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease; } .sv-board-card:hover { transform:translateY(-3px); border-color:#9fc2ec; box-shadow:0 8px 22px rgba(24,60,104,.1); } .sv-board-card::before { content:''; height:3px; background:linear-gradient(90deg,var(--lwb-blue),var(--lwb-green)); opacity:.55; transition:opacity .18s ease; } .sv-board-card:hover::before { opacity:1; } .sv-board-card[data-health="error"]::before { background:#e2574d; opacity:1; } .sv-board-card[data-health="manual"]::before { background:linear-gradient(90deg,#8059aa,#b98ae0); } .sv-board-card-main { display:grid; gap:7px; width:100%; padding:14px; border:0; background:transparent; cursor:pointer; font:inherit; text-align:left; } .sv-board-card-main:hover { background:var(--lwb-blue-soft); } .sv-board-card-main strong { font-size:var(--lwb-text-md,15px); } .sv-board-today { margin:0; color:var(--lwb-blue); font-size:var(--lwb-text-sm,13px); font-weight:700; } .sv-board-meta { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); } .sv-board-preview { display:grid; gap:4px; margin:2px 0 0; padding:0; list-style:none; } .sv-board-preview li { overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); line-height:1.5; text-overflow:ellipsis; white-space:nowrap; } .sv-board-preview li small { color:var(--lwb-muted); } .sv-board-card-foot { display:flex; justify-content:flex-end; padding:0 10px 10px; } .sv-drawer-section { margin:14px 0 8px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; } .sv-drawer-list { display:grid; gap:8px; } .sv-split { display:grid; grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr); gap:20px; align-items:start; } .sv-badge { display:inline-flex; min-height:22px; align-items:center; padding:0 8px; border-radius:99px; border:1px solid var(--lwb-line); background:var(--lwb-surface); color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); cursor:pointer; } .sv-badge[data-on="true"] { border-color:#9fc2ec; background:var(--lwb-blue-soft); color:var(--lwb-blue); } .sv-badge-row { display:flex; flex-wrap:wrap; gap:6px; } .sv-step { display:flex; gap:10px; align-items:flex-start; padding:7px 0; border-bottom:1px dashed var(--lwb-line); } .sv-step:last-child { border-bottom:0; } .sv-dot { width:10px; height:10px; border-radius:50%; flex:none; margin-top:5px; background:var(--lwb-line); } .sv-dot[data-state="running"] { background:#f5a623; } .sv-dot[data-state="done"] { background:#4caf50; } .sv-dot[data-state="error"] { background:#e5484d; } .sv-cand { border:1px solid var(--lwb-line); border-radius:8px; padding:11px 13px; cursor:pointer; background:var(--lwb-surface); } .sv-cand[data-sel="true"] { border:2px solid #9fc2ec; background:var(--lwb-blue-soft); } .sv-cand h4 { margin:0 0 4px; font-size:var(--lwb-text-md,15px); } .sv-cand p { margin:3px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.5; } .sv-genhead { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; } .sv-chips { display:flex; flex-wrap:wrap; gap:6px; }
    `;
    const productCss = `${css}
      /* Task execution inspector: quiet chrome, readable documents, bounded tools. */
      .sv-ex-layer { position:fixed; inset:0; z-index:1400; width:100vw; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:transparent; color:var(--lwb-ink); }
      .sv-ex-layer::backdrop { background:transparent; }
      .sv-ex-backdrop { position:absolute; inset:0; border:0; background:rgba(20,28,44,.36); backdrop-filter:blur(3px); cursor:default; }
      .sv-ex-drawer { position:absolute; top:16px; bottom:16px; right:16px; display:flex; flex-direction:column; width:min(900px,calc(100vw - 32px)); min-width:0; border:1px solid var(--lwb-line); border-radius:20px; background:var(--lwb-surface); box-shadow:0 24px 90px #101b3440; overflow:hidden; outline:none; }
      .sv-ex-drawer[data-wide="true"] { width:calc(100vw - 64px); max-width:1400px; }
      .sv-ex-header { display:flex; justify-content:space-between; gap:24px; padding:26px 30px 22px; border-bottom:1px solid var(--lwb-line); background:linear-gradient(120deg,var(--sv-accent-soft,var(--lwb-blue-soft)),var(--lwb-surface) 65%); }
      .sv-ex-header > div:first-child { min-width:0; }
      .sv-ex-kicker { margin:0 0 9px; color:var(--sv-accent,var(--lwb-blue)); font-size:12px; font-weight:700; letter-spacing:.07em; }
      .sv-ex-header h2 { margin:0; font-size:22px; line-height:1.45; letter-spacing:-.02em; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .sv-ex-subtitle { color:var(--lwb-muted); margin:9px 0 0; font-size:12px; line-height:1.6; }
      .sv-ex-header-actions { display:flex; gap:6px; align-items:flex-start; flex-shrink:0; }
      .sv-ex-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 30px; border-bottom:1px solid var(--lwb-line); }
      .sv-ex-tabs { display:flex; gap:22px; }
      .sv-ex-tabs button { position:relative; min-height:54px; padding:0 2px; border:0; background:none; color:var(--lwb-muted); font:inherit; font-size:14px; font-weight:600; cursor:pointer; }
      .sv-ex-tabs button[aria-selected="true"] { color:var(--sv-accent,var(--lwb-blue)); }
      .sv-ex-tabs button[aria-selected="true"]::after { content:''; height:3px; position:absolute; bottom:0; left:0; right:0; background:currentColor; border-radius:3px 3px 0 0; }
      .sv-ex-state { padding:5px 10px; border-radius:20px; font-size:12px; color:var(--lwb-muted); background:var(--lwb-page); white-space:nowrap; }
      .sv-ex-state[data-status="running"],.sv-ex-state[data-status="queued"] { color:#b77912; background:#fff4da; }
      .sv-ex-state[data-status="completed"],.sv-ex-state[data-status="succeeded"] { color:#20825c; background:#e9f6ef; }
      .sv-ex-state[data-status="failed"] { color:#ba3a48; background:#fcecef; }
      .sv-ex-body { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:26px 30px 36px; scrollbar-gutter:stable; }
      .sv-ex-footer { display:flex; justify-content:space-between; gap:16px; border-top:1px solid var(--lwb-line); padding:13px 30px; color:var(--lwb-muted); font-size:12px; }
      .sv-ex-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); padding:18px 0; margin-bottom:24px; border:1px solid var(--lwb-line); border-radius:14px; background:var(--lwb-page); }
      .sv-ex-metrics > div { padding:0 20px; display:grid; gap:7px; border-right:1px solid var(--lwb-line); }
      .sv-ex-metrics > div:last-child { border:0; }
      .sv-ex-metrics span { color:var(--lwb-muted); font-size:12px; }
      .sv-ex-metrics strong { font-size:20px; font-weight:650; }
      .sv-ex-disclosure { margin:10px 0; border:1px solid var(--lwb-line); border-radius:10px; overflow:hidden; background:var(--lwb-surface); }
      .sv-ex-disclosure > summary,.sv-ex-input > summary { cursor:pointer; padding:12px 15px; color:var(--lwb-muted); font-size:13px; line-height:1.6; font-weight:600; }
      .sv-ex-disclosure[open] > summary { border-bottom:1px solid var(--lwb-line); }
      .sv-ex-disclosure > .sv-ex-prose { padding:12px 16px; }
      .sv-ex-code { display:block; margin:0; padding:15px 17px; max-height:440px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace; background:var(--lwb-page); color:var(--lwb-ink); tab-size:2; }
      .sv-ex-prose { min-width:0; overflow-wrap:anywhere; line-height:1.85; font-size:14px; }
      .sv-ex-prose pre { max-width:100%; overflow:auto; }
      .sv-ex-prose img { max-width:100%; }
      .sv-ex-prose table { display:block; max-width:100%; overflow:auto; }
      .sv-ex-section-head { display:flex; align-items:center; gap:12px; margin:26px 0 18px; }
      .sv-ex-section-head strong { font-size:16px; }
      .sv-ex-section-head p { margin:5px 0 0; color:var(--lwb-muted); font-size:12px; }
      .sv-ex-avatar { display:grid; place-items:center; width:38px; height:38px; border-radius:12px; background:var(--lwb-blue-soft); color:var(--lwb-blue); font-weight:800; }
      .sv-ex-message { margin:15px 0; border:1px solid var(--lwb-line); border-radius:13px; padding:18px 20px; background:var(--lwb-surface); }
      .sv-ex-message-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px; font-size:13px; }
      .sv-ex-message-head time,.sv-ex-marker time,.sv-ex-input time { color:var(--lwb-muted); font-size:11px; font-weight:400; }
      .sv-ex-input { padding:0; background:var(--lwb-page); }
      .sv-ex-input > .sv-ex-prose { padding:0 18px 14px; max-height:380px; overflow:auto; }
      .sv-ex-input time { float:right; }
      .sv-ex-tool { border-left:3px solid var(--sv-accent-line,var(--lwb-blue)); background:var(--lwb-page); padding:15px 17px; margin:14px 0; border-radius:0 12px 12px 0; }
      .sv-ex-tool .sv-ex-disclosure { margin-bottom:0; }
      .sv-ex-marker { display:flex; align-items:center; gap:9px; padding:9px 0; color:var(--lwb-muted); font-size:12px; }
      .sv-ex-marker time { margin-left:auto; }
      .sv-ex-marker i { width:5px; height:5px; border-radius:50%; background:var(--lwb-muted); }
      .sv-ex-reasoning { border-left:2px solid var(--sv-accent-line,var(--lwb-line)); padding:0 0 0 13px; margin:12px 0; color:var(--lwb-muted); }
      .sv-ex-reasoning summary { cursor:pointer; font-size:13px; padding:6px 0; }
      .sv-ex-process { margin:12px 0 20px; min-width:0; }
      .sv-ex-process > summary { display:flex; align-items:center; gap:12px; list-style:none; padding:12px 0; color:var(--lwb-ink); cursor:pointer; font-size:13px; font-weight:600; border-bottom:1px solid var(--lwb-line); }
      .sv-ex-process > summary::-webkit-details-marker,.sv-ex-process-row > summary::-webkit-details-marker { display:none; }
      .sv-ex-process > summary::after,.sv-ex-process-row > summary::after { content:''; width:6px; height:6px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(-45deg); flex-shrink:0; margin-left:auto; }
      .sv-ex-process[open] > summary::after,.sv-ex-process-row[open] > summary::after { transform:rotate(45deg); }
      .sv-ex-process-counts { color:var(--lwb-muted); font-size:11px; font-weight:400; }
      .sv-ex-process-body { padding:10px 0 0; }
      .sv-ex-process-row { min-width:0; margin:3px 0; border-radius:9px; }
      .sv-ex-process-row > summary { display:flex; align-items:center; gap:10px; min-width:0; list-style:none; padding:12px 10px; cursor:pointer; color:var(--lwb-muted); font-size:13px; line-height:1.6; border-radius:9px; }
      .sv-ex-process-row > summary:hover { background:var(--lwb-page); }
      .sv-ex-process-row > summary:focus-visible,.sv-ex-process > summary:focus-visible { outline:2px solid var(--lwb-blue); outline-offset:2px; }
      .sv-ex-process-row > summary svg { width:17px; height:17px; flex-shrink:0; }
      .sv-ex-row-title { flex-shrink:0; font-weight:500; }
      .sv-ex-row-preview { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
      .sv-ex-row-preview::before { content:'·'; margin-right:10px; opacity:.6; }
      .sv-ex-row-status { flex-shrink:0; font-size:11px; color:var(--sv-accent,var(--lwb-blue)); }
      .sv-ex-row-status[data-error] { color:#cc5263; }
      .sv-ex-row-body { margin:0 10px 14px 18px; padding:4px 0 4px 18px; border-left:1px solid var(--lwb-line); max-height:520px; overflow:auto; }
      .sv-ex-row-body > .sv-ex-prose { padding:0 4px; }
      .sv-ex-assistant > .sv-ex-prose { padding:10px 12px; }
      .sv-ex-tool-output > strong { display:block; margin:16px 0 8px; color:var(--lwb-muted); font-size:12px; }
      @media (max-width:600px) { .sv-ex-process-row > summary { gap:7px; padding:11px 3px; } .sv-ex-row-body { margin-left:11px; padding-left:12px; } .sv-ex-process > summary { flex-wrap:wrap; gap:6px 12px; } .sv-ex-process-counts { font-size:10px; } }
      .sv-ex-live { color:var(--sv-accent,var(--lwb-blue)); font-size:12px; }
      .sv-ex-steps { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-bottom:20px; }
      .sv-ex-steps > div { display:grid; grid-template-columns:8px minmax(0,1fr); gap:5px 9px; border:1px solid var(--lwb-line); border-radius:10px; padding:13px; }
      .sv-ex-steps strong { font-size:13px; }
      .sv-ex-steps span { grid-column:2; font-size:12px; color:var(--lwb-muted); line-height:1.65; }
      .sv-ex-steps i,.sv-ex-timeline-row > i { width:7px; height:7px; margin-top:5px; border-radius:50%; background:#b0b9c5; }
      .sv-ex-steps [data-status="done"] i,.sv-ex-steps [data-status="succeeded"] i,.sv-ex-timeline-row[data-status="done"] > i { background:#35a575; }
      .sv-ex-steps [data-status="running"] i,.sv-ex-timeline-row[data-status="running"] > i { background:#e3a432; }
      .sv-ex-steps [data-status="failed"] i,.sv-ex-steps [data-status="error"] i,.sv-ex-timeline-row[data-status="error"] > i { background:#d85f6d; }
      .sv-ex-timeline h4 { font-size:14px; margin:20px 0; }
      .sv-ex-timeline-row { display:grid; grid-template-columns:12px minmax(0,1fr); gap:10px; padding:9px 0 16px; }
      .sv-ex-timeline-row > div { border-bottom:1px solid var(--lwb-line); padding-bottom:12px; }
      .sv-ex-actor { font-size:11px; color:var(--lwb-muted); }
      .sv-ex-paper,.sv-ex-candidate { padding:23px 25px; margin:0 0 18px; border:1px solid var(--lwb-line); border-radius:14px; background:var(--lwb-surface); }
      .sv-ex-paper h3,.sv-ex-candidate h3 { font-size:19px; line-height:1.55; margin:5px 0 16px; }
      .sv-ex-number { color:var(--sv-accent,var(--lwb-blue)); font:600 20px/1.2 ui-monospace,monospace; }
      .sv-ex-why { margin:15px 0 0; padding:12px 14px; border-radius:9px; background:var(--sv-accent-soft,var(--lwb-blue-soft)); font-size:13px; line-height:1.8; }
      .sv-ex-fields { margin:0 0 22px; }
      .sv-ex-fields h4 { margin:0 0 15px; font-size:14px; }
      .sv-ex-fields dl { margin:0; border:1px solid var(--lwb-line); border-radius:12px; overflow:hidden; }
      .sv-ex-fields dl > div { display:grid; grid-template-columns:100px minmax(0,1fr); gap:16px; padding:13px 17px; border-bottom:1px solid var(--lwb-line); font-size:13px; line-height:1.8; }
      .sv-ex-fields dl > div:last-child { border:0; }
      .sv-ex-fields dt { color:var(--lwb-muted); }
      .sv-ex-fields dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
      .sv-ex-issues { padding-left:20px; font-size:13px; line-height:1.8; }
      .sv-ex-assets { display:grid; gap:14px; }
      .sv-ex-asset { padding:17px; border:1px solid var(--lwb-line); border-radius:12px; }
      .sv-ex-asset audio,.sv-ex-asset video { width:100%; max-height:65vh; }
      .sv-ex-asset img { display:block; max-width:100%; max-height:65vh; margin:auto; border-radius:8px; object-fit:contain; }
      .sv-ex-empty { padding:22px; border:1px dashed var(--lwb-line); border-radius:12px; color:var(--lwb-muted); line-height:1.8; font-size:13px; }
      .sv-ex-alert { padding:15px 17px; border:1px solid #eac1c8; background:#fff3f4; color:#a83d4b; border-radius:10px; margin-bottom:18px; line-height:1.8; overflow-wrap:anywhere; font-size:13px; }
      .sv-ex-alert p { margin:4px 0; }
      .sv-ex-footnote { color:var(--lwb-muted); font-size:12px; line-height:1.7; margin-top:22px; }
      .sv-ex-history { display:grid; padding:6px 12px; max-height:270px; overflow:auto; }
      .sv-ex-history button { display:flex; gap:12px; justify-content:space-between; align-items:center; border:0; border-bottom:1px solid var(--lwb-line); padding:13px 3px; color:var(--lwb-muted); background:none; cursor:pointer; font-size:12px; }
      .sv-ex-history strong { color:var(--lwb-ink); }
      body[data-ds-dark-theme] .sv-ex-layer { --sv-accent:var(--lwb-blue); }
      body[data-ds-dark-theme] .sv-ex-alert { background:#3b242a; color:#f7b5bd; border-color:#633b44; }
      body[data-ds-dark-theme] .sv-ex-state[data-status="running"] { background:#493819; color:#ffd383; }
      body[data-ds-dark-theme] .sv-ex-state[data-status="completed"],body[data-ds-dark-theme] .sv-ex-state[data-status="succeeded"] { background:#1d3b30; color:#8fdfb7; }
      body[data-ds-dark-theme] .sv-ex-state[data-status="failed"] { background:#43272d; color:#ffb1be; }
      .sv-ex-layer button:focus-visible,.sv-ex-layer summary:focus-visible { outline:2px solid var(--sv-accent,var(--lwb-blue)); outline-offset:3px; }
      @media(max-width:640px) { .sv-ex-drawer,.sv-ex-drawer[data-wide="true"] { inset:0; width:100%; border-radius:0; } .sv-ex-header { padding:19px 18px; gap:12px; } .sv-ex-header h2 { font-size:18px; } .sv-ex-header-actions > button:first-child { display:none; } .sv-ex-body { padding:18px 16px 28px; } .sv-ex-toolbar { padding:0 18px; } .sv-ex-tabs { gap:16px; } .sv-ex-tabs button { font-size:13px; } .sv-ex-steps { grid-template-columns:1fr; } .sv-ex-footer { padding:12px 18px; } .sv-ex-paper,.sv-ex-candidate { padding:18px; } .sv-ex-message-head { flex-wrap:wrap; } }
      @media(prefers-reduced-motion:reduce) { .sv-ex-layer * { scroll-behavior:auto!important; animation:none!important; } }
      /* Shared module canvas: each workflow page uses the same compact hierarchy. */
      .sv-page { width:100%; max-width:none; margin:0; gap:16px; }
      .sv-page > * { min-width:0; }
      .sv-top { align-items:flex-start; min-height:72px; padding:0 0 15px; border-bottom:1px solid var(--lwb-line); }
      .sv-top-actions { display:flex; flex:none; align-items:center; gap:8px; }
      .sv-top h1 { font-size:var(--lwb-text-heading,20px); line-height:1.35; }
      .sv-top p { max-width:820px; }
      .sv-module-kicker { margin:0 0 5px !important; color:var(--lwb-blue) !important; font-size:var(--lwb-text-xs,12px) !important; font-weight:800; letter-spacing:.08em; }
      .sv-layout { grid-template-columns:minmax(320px,1.15fr) minmax(0,.85fr); gap:16px; }
      .sv-split { gap:16px; }
      .sv-item,.sv-form,.sv-source,.sv-source-compact,.sv-signal-card,.sv-family-section,.sv-feed-toolbar,.sv-insight-panel,.sv-board-card,.sv-pipeline { border-radius:8px; }
      .sv-item,.sv-form,.sv-source { padding:15px; }
      .sv-section { gap:10px; }
      .sv-section-head { min-height:28px; }
      .sv-source-compact-grid { grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); }
      .sv-board-grid { grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); }
      .sv-badge { border-radius:6px; }

      /* Signal is a data workspace, not a decorative dashboard. */
      .sv-signal-shell { gap:14px; }
      .sv-live-pill { width:max-content; padding:4px 8px; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-green); background:var(--lwb-green-soft); font-size:var(--lwb-text-sm,13px); }
      .sv-live-dot { width:6px; height:6px; animation:none; }
      .sv-pipeline { gap:10px; padding:13px 15px; }
      .sv-pipeline-label { font-size:var(--lwb-text-sm,13px); }
      .sv-board-card::before { background:var(--lwb-blue); }
      .sv-board-card[data-health="manual"]::before { background:#8059aa; }

      @media (max-width:780px) {
        .sv-layout,.sv-split { grid-template-columns:1fr; }
        .sv-board-grid,.sv-source-compact-grid { grid-template-columns:1fr; }
      }

      /* ── 视觉重构 v2（设计稿《口播视频能力包 · 视觉重构方案》）── */
      /* 品牌主色 + 8 模块色 + 双层轻阴影 + 12px 圆角 */
      .sv-page { --sv-brand:#4f46e5; --sv-brand-soft:#eef2ff; --sv-violet:#8b5cf6; --sv-blue:#3b82f6; --sv-orange:#f97316; --sv-purple:#7c3aed; --sv-pink:#ec4899; --sv-green:#10b981; --sv-red:#ef4444; --sv-sky:#0ea5e9; --sv-shadow-sm:0 1px 2px rgba(15,20,25,.04); --sv-shadow-md:0 4px 12px rgba(15,20,25,.06); }
      /* Per-page accent: the shared task kit (tabs / task cards / step pills / pick cards) reads these, so one kit serves every module color. Default = topic orange; script page opts into violet. */
      .sv-page { --sv-accent:#f97316; --sv-accent-soft:#fff7ed; --sv-accent-line:#f0c08a; --sv-accent-ink:#c2410c; --sv-accent-rgb:249,115,22; }
      .sv-page[data-accent="violet"] { --sv-accent:#7c3aed; --sv-accent-soft:#f5f3ff; --sv-accent-line:#c4b5fd; --sv-accent-ink:#6d28d9; --sv-accent-rgb:124,58,237; }
      .sv-page[data-accent="red"] { --sv-accent:#ef4444; --sv-accent-soft:#fef2f2; --sv-accent-line:#f5b5b5; --sv-accent-ink:#b91c1c; --sv-accent-rgb:239,68,68; }
      .sv-page[data-accent="sky"] { --sv-accent:#0ea5e9; --sv-accent-soft:#f0f9ff; --sv-accent-line:#7dd3fc; --sv-accent-ink:#0369a1; --sv-accent-rgb:14,165,233; }
      body[data-ds-dark-theme] .sv-page { --sv-accent-soft:rgba(var(--sv-accent-rgb),.16); --sv-accent-line:rgba(var(--sv-accent-rgb),.45); --sv-accent-ink:#fdba74; }
      body[data-ds-dark-theme] .sv-page[data-accent="violet"] { --sv-accent-ink:#c4b5fd; }
      body[data-ds-dark-theme] .sv-page[data-accent="red"] { --sv-accent-ink:#fca5a5; }
      body[data-ds-dark-theme] .sv-page[data-accent="sky"] { --sv-accent-ink:#7dd3fc; }
      .sv-item,.sv-form,.sv-source,.sv-source-compact,.sv-signal-card,.sv-board-card,.sv-cmdbar { border-color:#eceef3; border-radius:12px; box-shadow:var(--sv-shadow-sm); }
      .sv-board-card::before { background:linear-gradient(90deg,var(--sv-brand),var(--sv-blue)); opacity:.7; }
      .sv-item[data-active="true"] { border-color:#c7d2fe; background:var(--sv-brand-soft); }
      .sv-board-card:hover,.sv-signal-card:hover { box-shadow:var(--sv-shadow-md); }
      .sv-board-card[data-empty="true"]:hover { box-shadow:var(--sv-shadow-sm); }
      .sv-board-card[data-empty="true"] .sv-board-card-main { cursor:default; }
      .sv-board-card[data-empty="true"] .sv-board-card-main:hover { background:transparent; }
      /* 字阶层级：页标题放大、指标数字强调 */
      .sv-top h1 { font-size:24px; letter-spacing:-.01em; }
      .sv-section h3,.sv-form h3 { font-size:var(--lwb-text-section,18px); }
      /* 呼吸感运行指示器 */
      .sv-live-pill { display:inline-flex; align-items:center; gap:6px; border-radius:100px; border-color:transparent; }
      .sv-live-dot { border-radius:50%; animation:sv-breathe 2s ease-in-out infinite; }
      @keyframes sv-breathe { 0%,100% { opacity:1; } 50% { opacity:.35; } }
      /* 暗色主题覆盖 */
      body[data-ds-dark-theme] .sv-page { --sv-brand-soft:rgba(99,102,241,.18); --sv-shadow-sm:0 1px 2px rgba(0,0,0,.35); --sv-shadow-md:0 4px 12px rgba(0,0,0,.4); }
      body[data-ds-dark-theme] .sv-item,body[data-ds-dark-theme] .sv-form,body[data-ds-dark-theme] .sv-source,body[data-ds-dark-theme] .sv-source-compact,body[data-ds-dark-theme] .sv-signal-card,body[data-ds-dark-theme] .sv-board-card,body[data-ds-dark-theme] .sv-cmdbar,body[data-ds-dark-theme] .sv-heromini { border-color:var(--lwb-line); }
      /* 分页 hero mini：统一语法，内容按各页主导问题定制 */
      .sv-heromini { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:0; padding:6px 4px; border:1px solid #eceef3; border-radius:12px; background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); }
      .sv-heromini-cell { display:grid; gap:3px; min-width:0; padding:10px 14px; }
      .sv-heromini-cell + .sv-heromini-cell { border-left:1px solid var(--lwb-line); }
      .sv-heromini-cell span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-heromini-cell strong { overflow:hidden; font-size:var(--lwb-text-title,24px); font-weight:800; line-height:1.2; letter-spacing:-.01em; color:var(--lwb-ink); text-overflow:ellipsis; white-space:nowrap; }
      .sv-heromini-cell strong[data-tone="green"] { color:var(--sv-green); } .sv-heromini-cell strong[data-tone="red"] { color:#dc2626; } .sv-heromini-cell strong[data-tone="brand"] { color:var(--sv-brand); } .sv-heromini-cell strong[data-tone="orange"] { color:#c2410c; }
      @media (max-width:780px) { .sv-heromini-cell:nth-child(even) { border-left:0; } }
      body[data-ds-dark-theme] .sv-item[data-active="true"] { border-color:#4f6cd8; background:var(--sv-brand-soft); }
      /* v2.1 模块页延展：色、进度、空态 */
      .sv-module-dot { display:inline-block; width:8px; height:8px; flex:none; border-radius:50%; background:var(--sv-blue); }
      .sv-module-kicker { display:inline-flex; align-items:center; gap:6px; }
      .sv-proj-dots { display:flex; align-items:center; gap:4px; }
      .sv-proj-dots i { width:7px; height:7px; border-radius:50%; background:#e2e8f0; transition:background .18s ease; }
      .sv-proj-dots i[data-on="true"] { background:var(--sv-blue); }
      .sv-proj-dots i[data-on="done"] { background:var(--sv-green); }
      .sv-qa-score { display:flex; align-items:baseline; gap:8px; }
      .sv-qa-score strong { font-size:30px; font-weight:800; line-height:1; color:var(--lwb-ink); }
      .sv-qa-score em { font-style:normal; font-size:var(--lwb-text-base,14px); color:var(--lwb-muted); }
      .sv-approval-ritual { border-color:#fecaca; background:#fffbfb; }
      body[data-ds-dark-theme] .sv-approval-ritual { border-color:#5b3434; background:#2b1e1e; }
      .sv-empty-cta { display:grid; gap:10px; padding:22px; border:1px dashed #c7d2fe; border-radius:12px; background:var(--sv-brand-soft); text-align:center; }
      .sv-empty-cta p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      body[data-ds-dark-theme] .sv-empty-cta { border-color:#4f6cd8; }
      body[data-ds-dark-theme] .sv-proj-dots i { background:#33424f; } body[data-ds-dark-theme] .sv-proj-dots i[data-on="true"] { background:#78adff; } body[data-ds-dark-theme] .sv-proj-dots i[data-on="done"] { background:#5bd0a0; }
      /* v2.2 模块细节收尾：选题橙、配音粉、视频绿舞台、安排天青 */
      .sv-cand { border-radius:12px; box-shadow:var(--sv-shadow-sm); }
      .sv-cand[data-sel="true"] { border-color:var(--sv-orange); background:#fff7ed; }
      body[data-ds-dark-theme] .sv-cand[data-sel="true"] { border-color:#c2410c; background:rgba(249,115,22,.14); }
      .sv-media-panel { padding:10px; border-radius:10px; background:#fdf2f8; }
      body[data-ds-dark-theme] .sv-media-panel { background:rgba(236,72,153,.12); }
      .sv-media-panel audio { display:block; width:100%; }
      .sv-video-stage { padding:10px; border-radius:12px; background:#0e1a2b; }
      .sv-video-stage video { display:block; width:100%; max-height:560px; border-radius:8px; }
      /* Configuration is a prerequisite, so expose its state beside the action. */
      .sv-page .sv-media-config-trigger { min-height:42px; gap:9px; padding:0 14px; border:1px solid var(--sv-accent-line); border-radius:10px; color:var(--sv-accent-ink); background:var(--sv-accent-soft); box-shadow:0 2px 8px rgba(var(--sv-accent-rgb),.08); font-size:14px; }
      .sv-page .sv-media-config-trigger:hover { border-color:var(--sv-accent); filter:brightness(.98); }
      .sv-page .sv-media-config-trigger[data-attention="true"] { border-color:var(--sv-accent); box-shadow:0 0 0 3px var(--sv-accent-soft); }
      .sv-page .sv-config-state { padding:3px 7px; border-radius:5px; font-size:11px; line-height:1.4; background:var(--lwb-surface); color:var(--lwb-muted); }
      .sv-page .sv-media-config-trigger[data-attention="true"] .sv-config-state { background:var(--sv-accent); color:#fff; }
      .sv-audio-subtitle-option { display:flex; align-items:flex-start; gap:10px; padding:13px; background:var(--sv-accent-soft); border:1px solid var(--sv-accent-line); border-radius:10px; cursor:pointer; }
      .sv-audio-subtitle-option input { margin-top:4px; accent-color:var(--sv-accent); }
      .sv-audio-subtitle-option span { display:grid; gap:5px; }
      .sv-audio-subtitle-option strong { font-size:14px; }
      .sv-audio-subtitle-option small { color:var(--lwb-muted); line-height:1.7; }
      /* ---- 我的音色库：克隆模式上传过的参考音频自动沉淀，点选即用 ---- */
      .sv-voice-library { display:grid; gap:8px; padding:11px; border:1px dashed var(--lwb-line); border-radius:10px; background:var(--lwb-surface); }
      .sv-voice-library-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .sv-voice-library-list { display:grid; gap:6px; max-height:220px; overflow-y:auto; }
      .sv-voice-library-item { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--lwb-line); border-radius:8px; }
      .sv-voice-library-item[data-selected="true"] { border-color:var(--sv-accent); background:var(--sv-accent-soft); }
      .sv-voice-library-pick { flex:1; display:grid; gap:2px; padding:4px 6px; border:0; background:transparent; text-align:left; cursor:pointer; border-radius:6px; }
      .sv-voice-library-pick:hover:not(:disabled) { background:var(--sv-accent-soft); }
      .sv-voice-library-pick:disabled { opacity:.5; cursor:not-allowed; }
      .sv-voice-library-name { font-size:14px; font-weight:700; color:var(--lwb-ink); }
      .sv-voice-library-meta { font-size:12px; color:var(--lwb-muted); }
      .sv-voice-library-actions { display:flex; gap:4px; flex-shrink:0; }
      .sv-voice-library-delete { color:#b3372f; }
      .sv-voice-library-delete:hover:not(:disabled) { text-decoration:underline; }
      /* ---- 内容安排专属：执行日/整点 chip + 深度档 + 警示条 + 运行历史 + 视频条目 + 生命线（accent 由 data-accent=sky 驱动）---- */
      .sv-as-chips { display:flex; flex-wrap:wrap; gap:6px; }
      .sv-as-chip { display:inline-flex; align-items:center; min-height:30px; padding:0 11px; border:1px solid var(--lwb-line); border-radius:999px; color:var(--lwb-ink); background:var(--lwb-surface); font-size:var(--lwb-text-base,14px); cursor:pointer; transition:border-color .15s,background .15s,color .15s; }
      .sv-as-chip:hover:not(:disabled) { border-color:var(--sv-accent-line); color:var(--sv-accent-ink); }
      .sv-as-chip:disabled { opacity:.5; cursor:not-allowed; }
      .sv-as-chip[data-on="true"] { border-color:var(--sv-accent); color:var(--sv-accent-ink); background:var(--sv-accent-soft); font-weight:700; }
      .sv-as-chip[data-kind="quick"] { border-style:dashed; }
      .sv-as-field { display:grid; gap:6px; }
      .sv-as-label { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-as-depth { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; }
      .sv-as-depth-opt { display:grid; gap:3px; padding:10px 12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); text-align:left; cursor:pointer; transition:border-color .15s,background .15s; }
      .sv-as-depth-opt:hover:not(:disabled) { border-color:var(--sv-accent-line); }
      .sv-as-depth-opt:disabled { opacity:.55; cursor:not-allowed; }
      .sv-as-depth-opt[data-on="true"] { border-color:var(--sv-accent); background:var(--sv-accent-soft); }
      .sv-as-depth-opt strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-as-depth-opt[data-on="true"] strong { color:var(--sv-accent-ink); }
      .sv-as-depth-opt span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-as-warn { display:grid; gap:4px; padding:9px 11px; border:1px solid #ecd39b; border-radius:8px; color:#7a5b17; background:#fffaf0; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      body[data-ds-dark-theme] .sv-as-warn { border-color:#665327; color:#e8d9a9; background:#332b1b; }
      .sv-as-blockers { display:grid; gap:4px; }
      /* 队列条 / 故障聚类 / 提示音开关（无人值守可用性，2026-10 加） */
      .sv-queue-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:10px 13px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .sv-queue-title { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.08em; }
      .sv-queue-waiting { display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-queue-chip { padding:3px 9px; border:1px solid var(--sv-accent-line); border-radius:99px; color:var(--sv-accent-ink); background:var(--sv-accent-soft); font-size:var(--lwb-text-xs,12px); font-weight:700; }
      .sv-queue-more { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-queue-idle { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-notify-toggle { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .sv-fail-panel { display:grid; gap:9px; padding:14px; border:1px solid #e6b5b5; border-radius:10px; background:#fff7f7; }
      body[data-ds-dark-theme] .sv-fail-panel { border-color:#7a4444; background:#3a2323; }
      .sv-fail-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; }
      .sv-fail-head h4 { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); }
      .sv-fail-row { display:flex; gap:10px; padding:9px 11px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-surface); }
      .sv-fail-count { flex:none; min-width:44px; padding:2px 8px; border-radius:99px; color:var(--lwb-muted); background:var(--lwb-blue-soft); font-size:var(--lwb-text-xs,12px); font-weight:800; text-align:center; }
      .sv-fail-count.is-many { color:#994646; background:#ffe9e9; }
      .sv-fail-body { display:grid; gap:3px; min-width:0; }
      .sv-fail-cat { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.06em; }
      .sv-fail-sig { overflow:hidden; margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-fail-remedy { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .sv-fail-recent { display:grid; gap:6px; }
      /* 页面内弹窗：与提示音同源同人不在电脑前时的兜底。 */
      .sv-toast-stack { position:fixed; z-index:60; right:18px; bottom:18px; display:grid; gap:9px; width:min(380px,calc(100vw - 36px)); }
      /* 音色库的上传区：和上面的音色卡片之间有一道虚线，视觉上分得开「已有的」
         与「往里加」，否则一排卡片下面跟着输入框会以为是某个音色的编辑框。 */
      .sv-voice-upload { display:grid; gap:7px; padding-top:11px; border-top:1px dashed var(--lwb-line); }
      .sv-voice-upload-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .sv-voice-upload-row .sv-input { flex:1 1 240px; min-width:0; }
      .sv-voice-upload-row button { flex:none; }
      .sv-engine-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; }
      .sv-engine-head h3 { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); }
      .sv-engine-actions { display:flex; flex-wrap:wrap; gap:7px; }
      .sv-engine-usage { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:11px; }
      .sv-usage { display:grid; gap:3px; }
      .sv-usage-label { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.06em; }
      .sv-usage-value { color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-usage-bar { display:block; overflow:hidden; height:6px; border-radius:99px; background:var(--lwb-page); }
      .sv-usage-fill { display:block; height:100%; background:var(--sv-accent, #3b82f6); border-radius:99px; }
      .sv-usage-bar[data-level="mid"] .sv-usage-fill { background:#d69a1c; }
      .sv-usage-bar[data-level="high"] .sv-usage-fill { background:#d1443f; }
      .sv-engine-row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:10px 12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); }
      /* 字幕引擎与生图引擎并排。列宽只有整宽的一半，所以行内改成竖排：
         名称/端口一行、状态一行、按钮一行——横排会把按钮挤到换行更难读。 */
      .sv-engine-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(232px,1fr)); gap:10px; }
      .sv-engine-grid .sv-engine-row { display:grid; gap:8px; align-content:start; }
      /* 行改成 grid 后子项默认拉伸，状态标签会被拉成整条色块；
         标签和按钮组都要收回内容宽度。 */
      .sv-engine-grid .sv-tag, .sv-engine-grid .sv-stage { justify-self:start; }
      .sv-engine-grid .sv-engine-buttons { justify-self:start; }
      /* 可折叠的标题。整块（含 h3）都是按钮的点击区，否则要点中文字才生效。 */
      .sv-collapsible-head { display:inline-flex; align-items:center; gap:7px; padding:0; border:0; color:inherit; background:transparent; cursor:pointer; font:inherit; }
      .sv-collapsible-head h3 { margin:0; }
      .sv-collapse-caret { color:var(--lwb-muted); font-size:12px; }
      .sv-collapsible-head:hover h3 { color:var(--lwb-blue); }
      .sv-engine-id { display:grid; gap:2px; flex:1 1 190px; min-width:0; }
      .sv-engine-id strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-engine-buttons { display:flex; flex-wrap:wrap; gap:6px; }
      .sv-engine-log { display:grid; gap:7px; padding:11px 12px; border:1px dashed var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      /* 参考音色库与本地配音配置 */
      .sv-voice-panel { display:grid; gap:11px; padding:15px 17px; border:1px solid var(--lwb-line); border-radius:11px; background:var(--lwb-surface); }
      /* 音色库是可扫读的列表：多列排布，一眼能看完有几个音色、各自叫什么。 */
      .sv-voice-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(268px,1fr)); gap:9px; margin:0; padding:0; list-style:none; align-items:start; }
      .sv-voice-row { display:grid; gap:8px; align-content:start; padding:11px 12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); }
      .sv-voice-id { display:grid; gap:2px; flex:1 1 190px; min-width:0; }
      .sv-voice-id strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-voice-buttons { display:flex; flex-wrap:wrap; gap:6px; }
      /* 音色卡里那条信息行：名称/时长在左，操作在右，卡变窄也不会挤成一团。 */
      .sv-voice-head { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; }
      .sv-voice-audio { width:100%; max-width:340px; height:34px; margin-top:4px; }
      .sv-bridge-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(215px,1fr)); gap:11px; }
      .sv-bridge-test { display:grid; gap:5px; padding:10px 12px; border:1px dashed var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      body[data-ds-dark-theme] .sv-voice-row,
      body[data-ds-dark-theme] .sv-bridge-test { background:#1b2530; }
      .sv-engine-log-head { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); font-weight:800; }
      .sv-log-lines { overflow:auto; max-height:240px; margin:0; padding:0 0 0 18px; color:var(--lwb-muted); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:var(--lwb-text-xs,12px); line-height:1.6; }
      body[data-ds-dark-theme] .sv-usage-bar { background:#1b2530; }
      body[data-ds-dark-theme] .sv-engine-row,
      body[data-ds-dark-theme] .sv-engine-log { background:#1b2530; }
      .sv-toast { display:flex; flex-wrap:wrap; gap:10px; justify-content:space-between; padding:12px 13px; border:1px solid var(--lwb-line); border-left-width:4px; border-radius:9px; background:var(--lwb-surface); box-shadow:0 10px 30px rgba(16,32,48,.18); animation:sv-toast-in .22s ease-out; }
      @keyframes sv-toast-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
      .sv-toast[data-level="success"] { border-left-color:#1f9d6b; }
      .sv-toast[data-level="warn"] { border-left-color:#d69a1c; }
      .sv-toast[data-level="error"] { border-left-color:#d1443f; }
      .sv-toast-main { display:grid; gap:3px; min-width:0; flex:1 1 190px; }
      .sv-toast-title { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.45; }
      .sv-toast-detail { margin:0; overflow:hidden; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; text-overflow:ellipsis; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; }
      .sv-toast-remedy { margin:0; color:#486277; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .sv-toast-actions { display:flex; flex:none; gap:6px; align-self:flex-end; }
      body[data-ds-dark-theme] .sv-toast { background:#1b2530; }
      body[data-ds-dark-theme] .sv-toast-remedy { color:#a9c9e6; }
      .sv-as-adv { display:grid; gap:10px; padding:11px; border:1px dashed var(--lwb-line); border-radius:9px; }
      .sv-as-adv-title { margin:0; color:var(--sv-accent-ink); font-size:var(--lwb-text-base,14px); font-weight:700; }
      .sv-as-grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:9px; }
      .sv-as-task-note { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .sv-as-task[data-disabled="true"] { opacity:.72; }
      .sv-as-disabled { display:inline-flex; align-items:center; gap:5px; padding:6px 9px; border:1px solid #ecd39b; border-radius:7px; color:#7a5b17; background:#fffaf0; font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      body[data-ds-dark-theme] .sv-as-disabled { border-color:#665327; color:#e8d9a9; background:#332b1b; }
      .sv-as-runs { display:flex; flex-wrap:wrap; gap:6px; }
      .sv-as-run { display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-surface); font-size:var(--lwb-text-sm,13px); cursor:pointer; }
      .sv-as-run:hover { border-color:var(--sv-accent-line); }
      .sv-as-run[data-on="true"] { border-color:var(--sv-accent); background:var(--sv-accent-soft); color:var(--sv-accent-ink); font-weight:700; }
      .sv-as-run i { width:7px; height:7px; border-radius:50%; background:#cbd5e1; flex:none; }
      .sv-as-run[data-status="completed"] i { background:#16a34a; }
      .sv-as-run[data-status="partial"] i { background:#f59e0b; }
      .sv-as-run[data-status="running"] i { background:var(--sv-accent); animation:sv-tp-pulse 1.2s ease-in-out infinite; }
      .sv-as-run[data-status="failed"] i,.sv-as-run[data-status="cancelled"] i { background:var(--sv-red); }
      .sv-as-run[data-status="missed"] i { background:#94a3b8; }
      .sv-as-sumgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:8px; }
      .sv-as-sumgrid > div { display:grid; gap:2px; justify-items:center; padding:9px 6px; border-radius:8px; background:var(--lwb-page); }
      .sv-as-sumgrid strong { color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); }
      .sv-as-sumgrid span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-as-item { display:grid; gap:7px; padding:11px 12px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); }
      .sv-as-item-head { display:flex; align-items:flex-start; justify-content:space-between; gap:9px; }
      .sv-as-item-title { margin:0; overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .sv-as-item-meta { margin:2px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .sv-as-life { display:grid; gap:0; padding:9px 11px; border:1px dashed var(--lwb-line); border-radius:9px; background:var(--lwb-page); }
      .sv-as-life-stage { display:grid; grid-template-columns:86px 1fr auto; gap:9px; align-items:center; padding:6px 0; border-bottom:1px solid var(--lwb-line); }
      .sv-as-life-stage:last-child { border-bottom:0; }
      .sv-as-life-stage > strong { color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-as-life-stage > p { margin:0; overflow:hidden; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; text-overflow:ellipsis; }
      .sv-as-life-stage[data-status="done"] > strong { color:#16865f; }
      .sv-as-life-stage[data-status="running"] > strong { color:var(--sv-accent-ink); }
      .sv-as-life-stage[data-status="failed"] > strong { color:var(--sv-red); }
      .sv-as-life-stage[data-status="skipped"] { opacity:.6; }
      .sv-as-life-dot { display:inline-flex; align-items:center; gap:5px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); white-space:nowrap; }
      .sv-as-life-dot i { width:7px; height:7px; border-radius:50%; background:#cbd5e1; flex:none; }
      .sv-as-life-stage[data-status="done"] .sv-as-life-dot i { background:#16a34a; }
      .sv-as-life-stage[data-status="running"] .sv-as-life-dot i { background:var(--sv-accent); animation:sv-tp-pulse 1.2s ease-in-out infinite; }
      .sv-as-life-stage[data-status="failed"] .sv-as-life-dot i { background:var(--sv-red); }
      /* v2.5 账号卡重塑：头像 + 双徽章分离 + 完善度条 + 相对时间，版本号不再外露 */
      .sv-acc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; }
      .sv-acc-card { display:grid; gap:10px; align-content:start; padding:16px; border:1px solid #eceef3; border-radius:12px; background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); text-align:left; cursor:pointer; transition:box-shadow .18s ease,border-color .18s ease; }
      .sv-acc-card:hover { border-color:#c7d2fe; box-shadow:var(--sv-shadow-md); }
      .sv-acc-card[data-state="todo"] { border-color:#fed7aa; }
      .sv-acc-card[data-default="true"] { border-color:#c7d2fe; background:linear-gradient(180deg,var(--sv-brand-soft),var(--lwb-surface) 78%); }
      .sv-acc-card[data-default="true"]:hover { border-color:var(--sv-brand); }
      .sv-acc-head { display:flex; min-width:0; align-items:center; gap:10px; }
      .sv-acc-avatar { display:grid; place-items:center; flex:none; width:34px; height:34px; border-radius:9px; color:#fff; font-size:var(--lwb-text-section,18px); font-weight:700; }
      .sv-acc-id { display:grid; gap:3px; min-width:0; flex:1; }
      .sv-acc-name { overflow:hidden; font-size:var(--lwb-text-lg,16px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; color:var(--lwb-ink); }
      .sv-acc-badges { display:flex; flex-wrap:wrap; gap:5px; }
      .sv-acc-pill { display:inline-flex; flex:none; align-items:center; min-height:19px; padding:0 7px; border-radius:999px; font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; background:#f3f4f6; color:#6b7280; }
      .sv-acc-pill[data-tone="default"] { background:var(--sv-brand-soft); color:var(--sv-brand); }
      .sv-acc-pill[data-tone="done"] { background:#ecfdf5; color:#047857; }
      .sv-acc-pill[data-tone="todo"] { background:#fff7ed; color:#c2410c; }
      .sv-acc-summary { display:-webkit-box; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .sv-acc-summary[data-empty="true"] { color:#9ca3af; }
      .sv-acc-chips { display:flex; flex-wrap:wrap; gap:6px; }
      .sv-acc-chip { padding:2px 8px; border-radius:6px; background:#f3f4f6; color:#4b5563; font-size:var(--lwb-text-sm,13px); }
      .sv-acc-meter { display:flex; align-items:center; gap:4px; }
      .sv-acc-meter i { width:22px; height:4px; border-radius:2px; background:#e5e7eb; }
      .sv-acc-meter i[data-on="true"] { background:var(--sv-brand); }
      .sv-acc-meter[data-full="false"] i[data-on="true"] { background:var(--sv-orange); }
      .sv-acc-meter-text { margin-left:4px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-acc-foot { display:flex; justify-content:space-between; gap:8px; padding-top:10px; border-top:1px solid var(--lwb-line); color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-acc-new { display:grid; place-items:center; gap:6px; min-height:150px; border:1px dashed #c7d2fe; border-radius:12px; background:#f8f9fe; color:var(--sv-brand); font-size:var(--lwb-text-md,15px); font-weight:700; cursor:pointer; }
      .sv-acc-new-sub { color:#9ca3af; font-size:var(--lwb-text-sm,13px); font-weight:400; }
      .sv-acc-arch { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); }
      .sv-acc-arch-actions { display:flex; align-items:center; gap:8px; margin-left:auto; }
      .sv-acc-arch-info { display:grid; gap:2px; min-width:0; }
      .sv-acc-arch-info strong { font-size:var(--lwb-text-md,15px); color:var(--lwb-muted); }
      .sv-acc-arch-info span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-acc-danger { color:#b91c1c; }
      .sv-acc-danger:hover { background:#fee2e2; }
      .sv-acc-complete { display:grid; gap:6px; padding:10px 12px; margin-bottom:4px; border:1px dashed #c7d2fe; border-radius:10px; background:#f8f9fe; }
      .sv-acc-complete .lwb-primary-button { justify-self:start; }
      body[data-ds-dark-theme] .sv-acc-card { border-color:var(--lwb-line); }
      body[data-ds-dark-theme] .sv-acc-card:hover { border-color:#4f6cd8; }
      body[data-ds-dark-theme] .sv-acc-card[data-state="todo"] { border-color:#8a5a2b; }
      body[data-ds-dark-theme] .sv-acc-card[data-default="true"] { border-color:#4f6cd8; background:linear-gradient(180deg,rgba(99,102,241,.14),var(--lwb-surface) 78%); }
      body[data-ds-dark-theme] .sv-acc-pill[data-tone="todo"] { background:rgba(249,115,22,.16); color:#fdba74; }
      body[data-ds-dark-theme] .sv-acc-pill[data-tone="done"] { background:rgba(16,185,129,.16); color:#6ee7b7; }
      body[data-ds-dark-theme] .sv-acc-chip { background:#22313f; color:#c3ccd6; }
      body[data-ds-dark-theme] .sv-acc-meter i[data-on="false"] { background:#22313f; }
      body[data-ds-dark-theme] .sv-acc-new { border-color:#4f6cd8; background:rgba(99,102,241,.1); }
      body[data-ds-dark-theme] .sv-acc-danger:hover { background:rgba(239,68,68,.16); }
      body[data-ds-dark-theme] .sv-acc-complete { border-color:#4f6cd8; background:rgba(99,102,241,.08); }
      /* ── v2.5 信号页美化：命令条 + 信号卡片五要素 + 抽屉重塑 ── */
      /* 命令条：左标题 / 中内联统计 / 右动作，单行 64px */
      .sv-cmdbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; min-height:64px; padding:10px 16px; border:1px solid #eceef3; border-radius:12px; background:var(--lwb-surface); box-shadow:var(--sv-shadow-md); }
      .sv-cmd-title { display:grid; gap:2px; }
      .sv-cmd-kicker { display:inline-flex; align-items:center; gap:5px; margin:0; color:var(--sv-blue); font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.08em; }
      .sv-cmd-title h2 { margin:0; font-size:var(--lwb-text-heading,20px); line-height:1.25; color:var(--lwb-ink); }
      .sv-cmd-sep { width:1px; height:32px; flex:none; background:var(--lwb-line); }
      .sv-cmd-stats { display:flex; align-items:center; flex:1; min-width:0; }
      .sv-cmd-stat { display:grid; gap:1px; padding:0 14px; }
      .sv-cmd-stat + .sv-cmd-stat { border-left:1px solid var(--lwb-line); }
      .sv-cmd-stat span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-cmd-stat strong { color:var(--lwb-ink); font-size:19px; font-weight:800; line-height:1.2; letter-spacing:-.01em; }
      .sv-cmd-stat strong[data-tone="brand"] { color:var(--sv-brand); }
      .sv-cmd-stat strong[data-tone="ok"] { color:var(--sv-green); }
      .sv-cmd-stat strong[data-tone="alert"] { color:#dc2626; }
      .sv-cmd-stat strong[data-tone="time"] { font-size:var(--lwb-text-lg,16px); line-height:23px; }
      .sv-cmd-actions { display:flex; align-items:center; gap:8px; margin-left:auto; }
      @media (max-width:980px) { .sv-cmd-stats { flex-basis:100%; order:3; border-top:1px solid var(--lwb-line); padding-top:8px; } .sv-cmd-actions { margin-left:0; } }
      /* 信号卡五要素：来源 glyph / 评分条 / 排名徽标 / 热度 / 相对时间 */
      .sv-sig-head { display:flex; gap:10px; align-items:flex-start; }
      .sv-glyph { display:grid; place-items:center; flex:none; width:30px; height:30px; border-radius:8px; color:#fff; font-size:var(--lwb-text-lg,16px); font-weight:700; }
      .sv-sig-titlebox { min-width:0; flex:1; }
      .sv-sig-src { margin:0 0 2px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-signal-title { display:-webkit-box; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; white-space:normal; font-size:var(--lwb-text-lg,16px); line-height:1.5; }
      .sv-rank { display:inline-flex; flex:none; align-items:center; padding:4px 8px; border-radius:6px; background:#f2f3f5; color:#5b6472; font-size:var(--lwb-text-sm,13px); font-weight:800; font-variant-numeric:tabular-nums; }
      .sv-rank[data-tier="top"] { background:var(--lwb-ink); color:#fff; }
      .sv-rank[data-tier="hot"] { background:var(--sv-brand-soft); color:var(--sv-brand); }
      .sv-sig-metrics { display:flex; flex-wrap:wrap; align-items:center; gap:6px 14px; }
      .sv-sig-metrics .sv-scorebar strong,.sv-sig-metrics .sv-hot,.sv-sig-metrics .sv-new,.sv-sig-metrics .sv-meta { line-height:16px; }
      .sv-sig-metrics .sv-meta { margin:0; font-size:var(--lwb-text-sm,13px); }
      .sv-scorebar { display:inline-flex; align-items:center; gap:6px; }
      .sv-scorebar i { position:relative; display:inline-block; width:64px; height:4px; border-radius:2px; background:#e5e7ed; }
      .sv-scorebar i::after { content:''; position:absolute; left:0; top:0; bottom:0; width:var(--sv-fill,50%); border-radius:2px; background:var(--sv-brand); }
      .sv-scorebar strong { color:var(--sv-brand); font-size:var(--lwb-text-base,14px); font-weight:800; }
      body[data-ds-dark-theme] .sv-scorebar i { background:#33424f; }
      .sv-hot { display:inline-flex; align-items:center; gap:5px; color:#c2410c; font-size:var(--lwb-text-sm,13px); font-weight:600; }
      .sv-hot i { display:inline-block; width:8px; height:10px; border-radius:50% 50% 50% 0; background:var(--sv-orange); transform:rotate(-45deg); }
      .sv-new { display:inline-flex; align-items:center; gap:5px; color:#047857; font-size:var(--lwb-text-sm,13px); }
      .sv-new i { width:6px; height:6px; border-radius:50%; background:var(--sv-green); animation:sv-breathe 2s ease-in-out infinite; }
      /* 动作区：全部评估动作为可读文字按钮，平级排列 */
      .sv-sig-acts { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
      .sv-sig-tools { display:flex; flex:none; align-items:center; gap:8px; }
      .sv-sig-acts a.sv-outline-mini { text-decoration:none; }
      .sv-primary-mini { border:0; border-radius:7px; padding:7px 12px; background:var(--sv-brand); color:#fff; font:inherit; font-size:var(--lwb-text-base,14px); font-weight:600; cursor:pointer; transition:opacity .15s ease; }
      .sv-primary-mini:hover { opacity:.9; }
      .sv-primary-mini:disabled { opacity:.55; cursor:default; }
      .sv-outline-mini { border:1px solid var(--sv-brand); border-radius:7px; padding:6px 11px; background:transparent; color:var(--sv-brand); font:inherit; font-size:var(--lwb-text-base,14px); font-weight:600; cursor:pointer; }
      .sv-outline-mini:hover { background:var(--sv-brand-soft); }
      .sv-ghost-btn { display:grid; place-items:center; width:28px; height:28px; border:1px solid #d7e0e9; border-radius:7px; background:var(--lwb-surface); color:#8a94a6; font:inherit; font-size:var(--lwb-text-sm,13px); cursor:pointer; transition:color .15s ease,border-color .15s ease; }
      .sv-ghost-btn:hover { color:var(--sv-brand); border-color:var(--sv-brand); }
      body[data-ds-dark-theme] .sv-ghost-btn { border-color:var(--lwb-line); }
      body[data-ds-dark-theme] .sv-rank { background:#22313f; color:#9aa7b5; }
      body[data-ds-dark-theme] .sv-rank[data-tier="top"] { background:#e2e8f0; color:#0f172a; }
      body[data-ds-dark-theme] .sv-rank[data-tier="hot"] { background:rgba(99,102,241,.2); color:#a5b4fc; }
      body[data-ds-dark-theme] .sv-drawer-search { border-color:var(--lwb-line); }
      body[data-ds-dark-theme] .sv-filter-chip { background:#22313f; color:#9aa7b5; }
      body[data-ds-dark-theme] .sv-hot { color:#fdba74; }
      body[data-ds-dark-theme] .sv-new { color:#6ee7b7; }
      /* 抽屉重塑：固定来源头 + 工具行 + 独立滚动区（分组标题区内粘性） */
      .sv-drawer { display:flex; flex-direction:column; width:min(640px,100vw); overflow:hidden; }
      .sv-drawer-head { flex:none; margin-bottom:0; padding-bottom:12px; border-bottom:1px solid var(--lwb-line); }
      .sv-drawer-src { display:flex; align-items:center; gap:10px; }
      .sv-drawer-src .sv-glyph { width:34px; height:34px; border-radius:9px; font-size:var(--lwb-text-section,18px); }
      .sv-drawer-srcbox { min-width:0; flex:1; }
      .sv-drawer-srcbox .sv-item-title { font-size:var(--lwb-text-section,18px); }
      .sv-drawer-stats { display:grid; grid-template-columns:repeat(3,1fr); margin-top:10px; padding:8px 10px; border-radius:8px; background:var(--lwb-page); }
      .sv-drawer-stat { display:grid; gap:1px; justify-items:center; }
      .sv-drawer-stat + .sv-drawer-stat { border-left:1px solid var(--lwb-line); }
      .sv-drawer-stat strong { color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); font-weight:800; }
      .sv-drawer-stat strong[data-tone="brand"] { color:var(--sv-brand); }
      .sv-drawer-stat span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-drawer-tools { display:flex; flex-wrap:wrap; align-items:center; gap:8px; flex:none; padding:10px 0; }
      .sv-filter-chip { border:0; border-radius:100px; padding:4px 10px; background:var(--lwb-page); color:var(--lwb-muted); font:inherit; font-size:var(--lwb-text-xs,12px); font-weight:600; cursor:pointer; }
      .sv-filter-chip[data-on="true"] { background:var(--sv-brand); color:#fff; }
      .sv-drawer-search { min-width:150px; flex:1; height:28px; border:1px solid #d7e0e9; border-radius:7px; padding:0 10px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-sm,13px); }
      .sv-drawer-search:focus { border-color:var(--sv-brand); outline:0; }
      .sv-drawer-scroll { min-height:0; flex:1; overflow:auto; }
      /* 直挂修复：候选/账号抽屉把 sv-drawer-list 直接放在 sv-drawer（flex 列 + overflow:hidden）下，
         无滚动容器会被裁切。子选择器只命中直接子级——信号/写稿抽屉的 list 在 sv-drawer-scroll 内（孙级），不受影响。 */
      .sv-drawer > .sv-drawer-list { min-height:0; flex:1; overflow:auto; }
      .sv-group-title { position:sticky; top:0; z-index:1; display:flex; align-items:center; gap:6px; margin:0; padding:8px 0 6px; background:var(--lwb-surface); color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-group-title::before { content:''; width:3px; height:10px; border-radius:1.5px; background:var(--sv-brand); }
      .sv-group-title[data-tone="muted"]::before { background:var(--lwb-muted); }
      /* 配音工作台：运行参数在主页面，连接凭据收在紧凑抽屉。 */
      .sv-page[data-accent="pink"] { --sv-accent:#db2777; --sv-accent-soft:#fdf2f8; --sv-accent-line:#f5b5d0; --sv-accent-ink:#be185d; --sv-accent-rgb:219,39,119; }
      body[data-ds-dark-theme] .sv-page[data-accent="pink"] { --sv-accent-ink:#f9a8d4; }
      .sv-media-config-strip { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); }
      .sv-media-config-summary { display:flex; min-width:0; align-items:center; gap:11px; }
      .sv-media-config-mark { display:grid; flex:none; width:31px; height:31px; place-items:center; border-radius:8px; color:#c026d3; background:#fdf4ff; font-size:var(--lwb-text-section,18px); }
      .sv-media-config-copy { display:grid; min-width:0; gap:2px; }
      .sv-media-config-copy strong { overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-media-config-copy span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-media-config-meta { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; }
      .sv-media-config-trigger { display:inline-flex; align-items:center; gap:6px; min-height:30px; padding:0 10px; border:1px solid #d7e0e9; border-radius:7px; color:#4b647a; background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-sm,13px); font-weight:700; cursor:pointer; }
      .sv-media-config-trigger:hover { border-color:#b8a0d4; color:#8b3bb2; background:#fdf8ff; }
      .sv-media-config-trigger > span:first-child { font-size:var(--lwb-text-lg,16px); line-height:1; }
      .sv-media-config-drawer { width:min(484px,100vw); }
      .sv-media-drawer-title { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); }
      .sv-media-drawer-copy { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-media-drawer-body { display:grid; grid-auto-rows:max-content; min-height:0; flex:1; align-content:start; gap:18px; overflow:auto; padding:17px 2px 2px; }
      .sv-media-provider-picker { display:inline-flex; width:max-content; max-width:100%; align-self:start; padding:3px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-media-tradeoff { display:grid; gap:4px; padding:10px 12px; border:1px dashed var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-custom-image { display:grid; gap:12px; padding:13px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); }
      .sv-media-tradeoff p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-media-tradeoff strong { color:var(--lwb-ink); }
      .sv-media-provider-choice { min-height:30px; padding:0 10px; border:1px solid transparent; border-radius:6px; color:var(--lwb-muted); background:transparent; font:inherit; font-size:var(--lwb-text-sm,13px); font-weight:700; cursor:pointer; }
      .sv-media-provider-choice[data-active="true"] { border-color:var(--sv-accent-line); color:var(--sv-accent-ink); background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); }
      .sv-media-settings-section { display:grid; grid-auto-rows:max-content; align-content:start; gap:12px; padding-top:16px; border-top:1px solid var(--lwb-line); }
      .sv-media-settings-section h4 { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:800; }
      .sv-media-config-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .sv-media-field { display:grid; min-width:0; gap:6px; }
      .sv-media-field > span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-media-field-wide { grid-column:1/-1; }
      .sv-style-presets { display:flex; flex-wrap:wrap; align-items:center; gap:5px; }
      .sv-style-presets > .sv-meta { margin:0 2px 0 0; }
      /* 音色设计预设：12 个卡片要能一眼扫完，所以标签行整体缩进对齐描述框、
         并给一点上边距和它贴住；窄窗下自然换行，不设固定列数。 */
      .sv-design-presets { margin:2px 0 0; padding:8px 10px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); }
      .sv-design-presets-wide { grid-column:1/-1; }
      /* 三模式切换：三个模型互斥，所以做成并列的 radio 卡而不是一个下拉——
         下拉会让人以为可以混着填，radio 卡把「互斥」这件事说在明面上。 */
      .sv-voice-modes { display:grid; grid-template-columns:repeat(auto-fit,minmax(0,1fr)); gap:8px; margin:2px 0 4px; }
      .sv-voice-modes-wide { grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
      .sv-voice-mode { display:flex; flex-direction:column; gap:3px; padding:9px 11px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); color:var(--lwb-text); font:inherit; text-align:left; cursor:pointer; }
      .sv-voice-mode[data-active="true"] { border-color:var(--lwb-accent,#3b82f6); box-shadow:0 0 0 1px var(--lwb-accent,#3b82f6) inset; }
      .sv-voice-mode:disabled { opacity:.55; cursor:not-allowed; }
      .sv-voice-mode-label { font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-voice-mode-hint { font-size:var(--lwb-text-xs,12px); color:var(--lwb-muted); line-height:1.5; }
      body[data-ds-dark-theme] .sv-voice-mode { background:#182430; border-color:#2c3a48; }
      body[data-ds-dark-theme] .sv-voice-mode[data-active="true"] { background:#1d2b3a; }
      /* 音频标签按钮组：贴着文本框放，按组分行，一行放不下自然换行。 */
      .sv-audio-tags { display:flex; flex-direction:column; gap:6px; margin:2px 0 4px; }
      .sv-audio-tags-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .sv-audio-tags-head .sv-meta { margin:0; }
      .sv-audio-tags-head .sv-meta[data-tone="warn"] { color:#7a5b17; font-weight:700; }
      body[data-ds-dark-theme] .sv-audio-tags-head .sv-meta[data-tone="warn"] { color:#e8d9a9; }
      .sv-audio-tag-row { display:flex; flex-wrap:wrap; align-items:center; gap:5px; }
      .sv-audio-tag-group { min-width:64px; font-size:var(--lwb-text-xs,12px); color:var(--lwb-muted); }
      .sv-warn { margin:0; padding:10px 11px; border:1px solid #ecd39b; border-radius:7px; color:#7a5b17; background:#fffaf0; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      body[data-ds-dark-theme] .sv-warn { border-color:#7a6534; color:#e8d9a9; background:#332b1b; }
      /* 人工放行是「用户已确认」的状态，不是风险提醒——用中性偏冷的灰蓝，
         与 sv-warn 的黄明确区分，避免用户以为刚放行就有问题。 */
      .sv-released { margin:0; padding:10px 11px; border:1px solid #bcd0e0; border-radius:7px; color:#2f5d7c; background:#f1f7fb; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      body[data-ds-dark-theme] .sv-released { border-color:#3f6076; color:#bcd6e6; background:#1c2a33; }
      .sv-released-tag { display:inline-block; padding:2px 8px; border:1px solid #bcd0e0; border-radius:999px; color:#2f5d7c; background:#f1f7fb; font-size:var(--lwb-text-xs,12px); line-height:1.4; font-weight:600; }
      body[data-ds-dark-theme] .sv-released-tag { border-color:#3f6076; color:#bcd6e6; background:#1c2a33; }
      .sv-media-drawer-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:14px; border-top:1px solid var(--lwb-line); }
      body[data-ds-dark-theme] .sv-media-config-mark,body[data-ds-dark-theme] .sv-media-provider-choice[data-active="true"] { background:rgba(192,132,211,.14); }
      body[data-ds-dark-theme] .sv-media-config-trigger { border-color:var(--lwb-line); background:var(--lwb-surface); }
      .sv-audio-workbench { grid-template-columns:minmax(300px,.9fr) minmax(0,1.1fr); }
      .sv-video-workbench { grid-template-columns:minmax(300px,.82fr) minmax(0,1.18fr); grid-template-areas:'sources tasks'; }
      .sv-video-source { grid-area:sources; align-content:start; }
      .sv-video-task-list { grid-area:tasks; align-content:start; }
      .sv-video-source-item { display:grid; width:100%; gap:6px; padding:11px 12px; border:1px solid var(--lwb-line); border-left:3px solid var(--lwb-line); border-radius:8px; color:var(--lwb-ink); background:var(--lwb-surface); cursor:pointer; font:inherit; text-align:left; }
      .sv-video-source-item:hover,.sv-video-source-item[data-active="true"] { border-color:#8ccfb2; background:#f3fbf7; }
      .sv-video-source-item[data-active="true"] { border-left-color:#16865f; }
      .sv-video-create { margin-top:4px; border-color:#c7e5d5; }
      .sv-video-option { display:grid; gap:6px; }
      .sv-video-option > span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-video-orientation { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:3px; width:100%; padding:3px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-video-orientation button { min-height:34px; border:1px solid transparent; border-radius:6px; color:var(--lwb-muted); background:transparent; cursor:pointer; font:inherit; font-size:var(--lwb-text-base,14px); font-weight:700; }
      .sv-video-orientation button[data-active="true"] { border-color:#a9d9c4; color:#126b4c; background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); }
      body[data-ds-dark-theme] .sv-video-orientation button[data-active="true"] { border-color:#2c8a61; color:#7bd9b2; background:rgba(22,134,95,.14); }
      .sv-video-task-tools { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
      .sv-video-task { display:grid; gap:10px; padding:14px; border:1px solid var(--lwb-line); border-left:3px solid var(--lwb-line); border-radius:8px; background:var(--lwb-surface); }
      .sv-video-task[data-status="queued"],.sv-video-task[data-status="running"] { border-left-color:#f59e0b; }
      .sv-video-task[data-status="succeeded"] { border-left-color:#16865f; }
      .sv-video-task[data-status="failed"] { border-left-color:#e5484d; }
      .sv-video-task[data-status="cancelled"] { border-left-color:#9aa3ad; }
      .sv-video-task[data-status="interrupted"] { border-left-color:#d99427; }
      .sv-video-task-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:10px; }
      .sv-video-task-head > div { display:grid; min-width:0; gap:3px; }
      .sv-video-task-title { overflow:hidden; margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.5; text-overflow:ellipsis; white-space:nowrap; }
      .sv-video-task-meta,.sv-video-task-detail { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-video-task-detail { display:flex; flex-wrap:wrap; gap:5px 9px; }
      .sv-video-task-detail span { white-space:nowrap; }
      .sv-video-task .sv-video-stage { margin:0; padding:8px; border-radius:8px; }
      .sv-video-task .sv-video-stage video { max-height:360px; }
      /* 视频制作进度：步骤条 + 计时。用 grid 保证窄屏可换行、不溢出。 */
      .sv-vprogress { display:grid; gap:8px; padding:9px 10px; border:1px solid var(--lwb-line); border-radius:7px; background:var(--lwb-surface-soft,var(--lwb-blue-soft)); }
      .sv-vprogress-steps { display:flex; flex-wrap:wrap; gap:4px 6px; align-items:center; }
      .sv-vprogress-step { display:inline-flex; align-items:center; gap:5px; padding:2px 8px 2px 3px; border-radius:999px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); line-height:1.5; }
      .sv-vprogress-step i { display:inline-flex; width:17px; height:17px; flex:none; align-items:center; justify-content:center; border:1px solid currentColor; border-radius:50%; font-size:10px; font-style:normal; font-weight:700; }
      .sv-vprogress-step[data-status="done"] { color:#16865f; }
      .sv-vprogress-step[data-status="done"] i { color:#fff; background:#16865f; border-color:#16865f; }
      .sv-vprogress-step[data-status="active"] { color:#b45309; background:rgba(245,158,11,.14); font-weight:700; }
      .sv-vprogress-step[data-status="active"] i { color:#fff; background:#f59e0b; border-color:#f59e0b; animation:sv-vprogress-pulse 1.4s ease-in-out infinite; }
      .sv-vprogress-step[data-status="failed"] { color:#e5484d; font-weight:700; }
      .sv-vprogress-step[data-status="failed"] i { color:#fff; background:#e5484d; border-color:#e5484d; }
      @keyframes sv-vprogress-pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
      /* 当前阶段整体缓慢呼吸：像心跳，表示「还在走」。
         刻意不用 spinner 转圈——转圈是廉价的「假装在干活」，等得久时只会加剧焦躁。
         只动 opacity，不动宽高，避免重排。 */
      .sv-vprogress-step[data-status="active"] { animation:sv-vprogress-breathe 2.6s ease-in-out infinite; }
      @keyframes sv-vprogress-breathe { 0%,100% { opacity:1; } 50% { opacity:.62; } }
      /* 已完成阶段：打勾后轻微一闪再落定，给「这一步真的过去了」一个反馈。
         一次性动画，不是循环——循环会让步骤条整体在闪，反而更乱。 */
      .sv-vprogress-step[data-status="done"] i { animation:sv-vprogress-settle .5s ease-out 1; }
      @keyframes sv-vprogress-settle { 0% { transform:scale(.72); opacity:.45; } 60% { transform:scale(1.12); opacity:1; } 100% { transform:scale(1); opacity:1; } }
      /* 阶段说明：一行小字，跟步骤条同宽，不抢注意力。 */
      .sv-vprogress-hint { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      /* 长阶段「还活着」提示：小圆点持续跳动 + 秒数在涨，两者一起证明没卡死。 */
      .sv-vprogress-alive { display:flex; align-items:center; gap:6px; margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.6; font-variant-numeric:tabular-nums; }
      .sv-vprogress-alive-dot { position:relative; display:block; width:7px; height:7px; flex:none; border-radius:50%; background:#f59e0b; animation:sv-vprogress-alive 1.1s ease-in-out infinite; }
      @keyframes sv-vprogress-alive { 0%,100% { opacity:.35; transform:scale(.82); } 50% { opacity:1; transform:scale(1.06); } }
      /* 沉默超阈值时这颗点必须停下来、变灰。
         跳动的橙点意思是「我在动」——当文案已经在说「可能卡住了」，
         还让它继续跳就是两种相反信号摆在同一个元素上，用户只会信那个在动的。
         灰 + 静止 + 换底色，三个通道同时说「这个没在动」。 */
      .sv-vprogress-alive[data-silent="true"] { color:#a94343; }
      .sv-vprogress-alive[data-silent="true"] .sv-vprogress-alive-dot { background:#a94343; animation:none; opacity:1; transform:none; box-shadow:none; }
      body[data-ds-dark-theme] .sv-vprogress-alive[data-silent="true"] { color:#e8b9b9; }
      body[data-ds-dark-theme] .sv-vprogress-alive[data-silent="true"] .sv-vprogress-alive-dot { background:#e8b9b9; }
      @media (prefers-reduced-motion: reduce) { .sv-vprogress-step[data-status="active"] i { animation:none; } }
      /* reduced-motion：用户关掉动画就全部静止。圈出的是本轮新增的四处动画，
         前面的旧规则只覆盖了 active 的 i，不写这条会让呼吸/落定/跳动继续跑。 */
      @media (prefers-reduced-motion: reduce) {
        .sv-vprogress-step[data-status="active"],
        .sv-vprogress-step[data-status="done"] i,
        .sv-vprogress-alive-dot,
        .sv-vprogress-sweep::after { animation:none !important; }
        .sv-vprogress-alive-dot { opacity:1; transform:none; }
        .sv-vprogress-step[data-status="done"] i { transform:none; opacity:1; }
      }
      .sv-vprogress-repair { margin:0; padding:6px 8px; border-radius:6px; color:#b45309; background:rgba(245,158,11,.12); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-vprogress-bar { display:grid; gap:4px; }
      .sv-vprogress-bar-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-vprogress-bar progress { width:100%; height:7px; border:0; border-radius:999px; appearance:none; overflow:hidden; }
      /* 渲染进度条上的一层高光从左扫到右，暗示「正在推进」。
         只在运行中扫：任务结束后还在扫，会让人觉得 100% 还在跑。
         用 transform 位移（GPU 合成），不动 width，避免每帧重排。 */
      .sv-vprogress-sweep { position:relative; overflow:hidden; border-radius:999px; }
      .sv-vprogress-sweep::after { content:''; position:absolute; inset:0; border-radius:999px; background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,.55) 45%, rgba(255,255,255,.55) 55%, transparent 100%); animation:sv-vprogress-sweep 1.9s linear infinite; transform:translateX(-100%); pointer-events:none; }
      .sv-vprogress-sweep[data-status="succeeded"]::after,
      .sv-vprogress-sweep[data-status="failed"]::after { content:none; }
      @keyframes sv-vprogress-sweep { 0% { transform:translateX(-100%); } 100% { transform:translateX(100%); } }
      .sv-vprogress-bar progress::-webkit-progress-bar { border-radius:999px; background:var(--lwb-line); }
      .sv-vprogress-bar progress::-webkit-progress-value { border-radius:999px; background:#f59e0b; transition:width .4s ease; }
      .sv-vprogress-bar progress::-moz-progress-bar { border-radius:999px; background:#f59e0b; }
      /* 结束后不再用「进行中」的橙色：一条 100% 的橙条看着仍像在跑（2026-10-08 反馈）。 */
      .sv-vprogress-bar[data-status="succeeded"] progress::-webkit-progress-value { background:#1f7354; }
      .sv-vprogress-bar[data-status="succeeded"] progress::-moz-progress-bar { background:#1f7354; }
      .sv-vprogress-bar[data-status="failed"] progress::-webkit-progress-value { background:#a94343; }
      .sv-vprogress-bar[data-status="failed"] progress::-moz-progress-bar { background:#a94343; }
      .sv-vprogress-bar[data-status="succeeded"] .sv-vprogress-live { color:#1f7354; }
      .sv-vprogress-bar[data-status="failed"] .sv-vprogress-live { color:#a94343; }
      .sv-vprogress-bar .sv-meta { margin:0; font-variant-numeric:tabular-nums; }
      .sv-vprogress-foot { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px; }
      .sv-vprogress-foot .sv-meta { margin:0; }
      .sv-vprogress-toggle { padding:3px 9px; border:1px solid var(--lwb-line); border-radius:999px; color:var(--lwb-blue); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-xs,12px); cursor:pointer; }
      .sv-vprogress-toggle:hover { border-color:#9fc2ec; }
      .sv-vprogress-detail { display:grid; gap:3px; padding-top:7px; border-top:1px dashed var(--lwb-line); }
      .sv-vprogress-row { display:flex; align-items:baseline; justify-content:space-between; gap:9px; font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-vprogress-row .sv-meta { margin:0; }
      .sv-vprogress-live { color:#b45309; font-variant-numeric:tabular-nums; font-weight:700; }
      .sv-vprogress-foot .sv-meta,.sv-vprogress-row .sv-meta { font-variant-numeric:tabular-nums; }
      .sv-video-media-drawer { display:grid; gap:12px; padding-top:14px; }
      body[data-ds-dark-theme] .sv-video-source-item:hover,body[data-ds-dark-theme] .sv-video-source-item[data-active="true"] { border-color:#2c8a61; background:rgba(22,134,95,.12); }
      @media (max-width:780px) { .sv-video-workbench { grid-template-columns:minmax(0,1fr); grid-template-areas:'sources' 'tasks'; } }
      .sv-audio-config { align-content:start; }
      .sv-audio-script { min-height:136px; overflow:hidden; resize:none; color:var(--lwb-ink); background:var(--lwb-page); }
      .sv-audio-project { display:grid; gap:5px; padding:10px 11px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-audio-project strong { overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-audio-project span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sync-target-banner { display:flex; align-items:center; gap:8px; margin-bottom:12px; padding:10px 12px; border:1.5px dashed color-mix(in srgb, var(--lwb-accent, #d6336c) 45%, var(--lwb-line)); border-radius:8px; background:color-mix(in srgb, var(--lwb-accent, #d6336c) 6%, transparent); }
      .sv-sync-target-banner svg { flex:none; color:var(--lwb-accent, #d6336c); }
      .sv-sync-target-banner-body { min-width:0; display:grid; gap:2px; }
      .sv-sync-target-banner-body strong { overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-sync-target-banner-body span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sync-target-excerpt { color:var(--lwb-ink); opacity:.75; }
      .sv-audio-task-excerpt { margin:2px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sv-voice-upload,.sv-video-bgm-upload { display:grid; gap:8px; padding:10px 11px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-voice-upload-row,.sv-video-bgm-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
      .sv-voice-upload-file,.sv-video-bgm-file { min-width:0; flex:1; overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-voice-upload-file span,.sv-video-bgm-file span { color:var(--lwb-muted); }
      .sv-video-bgm-volume { display:grid; grid-template-columns:auto minmax(120px,1fr) 44px; align-items:center; gap:8px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-video-bgm-volume input { width:100%; accent-color:#16865f; }
      .sv-video-bgm-volume output { color:var(--lwb-ink); text-align:right; }
      .sv-audio-parameters { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
      .sv-audio-connect-note { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding-top:2px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-audio-connect-note button { flex:none; }
      .sv-audio-source-row { display:grid; gap:8px; }
      .sv-audio-task-tools { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
      .sv-filter-chips { display:flex; flex-wrap:wrap; gap:5px; }
      .sv-audio-pagebar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding-top:2px; }
      .sv-audio-picker { width:min(620px,100vw); }
      .sv-audio-picker-body { display:flex; flex-direction:column; gap:12px; min-height:0; padding-top:14px; }
      .sv-audio-picker-body > .sv-list { display:grid; grid-auto-rows:max-content; align-content:start; gap:8px; min-height:0; }
      .sv-audio-picker-item { display:flex; min-width:0; align-items:center; justify-content:space-between; gap:12px; padding:12px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-audio-picker-item > div { display:grid; min-width:0; gap:4px; }
      .sv-audio-picker-item strong { overflow:hidden; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-audio-picker-item p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-audio-subtitle-editor { display:grid; gap:0; padding-top:14px; }
      .sv-subtitle-text { min-height:72px; padding:8px 9px; resize:vertical; line-height:1.6; }
      .sv-audio-task { display:grid; gap:10px; padding:13px 14px; border:1px solid var(--lwb-line); border-left:3px solid var(--lwb-line); border-radius:8px; background:var(--lwb-surface); }
      .sv-audio-task[data-status="running"],.sv-audio-task[data-status="queued"] { border-left-color:#f59e0b; }
      .sv-audio-task[data-status="succeeded"] { border-left-color:#16865f; }
      .sv-audio-task[data-status="failed"] { border-left-color:#e5484d; }
      .sv-audio-task[data-active="true"] { border-color:var(--sv-accent-line); background:var(--sv-accent-soft); }
      .sv-audio-task-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:10px; }
      .sv-audio-task-head > div { display:grid; min-width:0; gap:3px; }
      .sv-audio-task-title { overflow:hidden; margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.5; text-overflow:ellipsis; white-space:nowrap; }
      .sv-audio-task-meta { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-audio-task-detail { display:flex; flex-wrap:wrap; gap:5px 9px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-audio-task-detail span { white-space:nowrap; }
      .sv-audio-subtitle-progress { display:grid; gap:6px; padding:9px 10px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-audio-subtitle-progress-head { display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.45; }
      .sv-audio-subtitle-progress-head strong { color:var(--lwb-ink); font-weight:600; }
      .sv-audio-subtitle-progress-head span { flex:none; font-variant-numeric:tabular-nums; }
      .sv-audio-subtitle-progress progress { display:block; width:100%; height:6px; accent-color:#16865f; }
      .sv-audio-player { display:grid; gap:7px; padding:10px; border:1px solid #f1d2df; border-radius:8px; background:#fff8fb; }
      .sv-audio-player audio { display:block; width:100%; }
      .sv-audio-player p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-subtitle-cues { display:grid; gap:0; }
      .sv-subtitle-cue { display:grid; grid-template-columns:62px minmax(0,1fr); gap:10px; padding:10px 0; border-bottom:1px solid var(--lwb-line); }
      .sv-subtitle-cue time { color:var(--sv-accent-ink); font-size:var(--lwb-text-xs,12px); font-variant-numeric:tabular-nums; }
      .sv-subtitle-cue p { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.6; white-space:pre-wrap; word-break:break-word; }
      .sv-subtitle-raw { margin:0; padding:12px; overflow:auto; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); color:var(--lwb-ink); font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
      body[data-ds-dark-theme] .sv-audio-player { border-color:rgba(236,72,153,.28); background:rgba(236,72,153,.08); }
      @media (max-width:780px) { .sv-audio-workbench { grid-template-columns:1fr; } }
      @media (max-width:560px) { .sv-media-config-grid,.sv-audio-parameters { grid-template-columns:1fr; } .sv-media-field-wide { grid-column:auto; } .sv-media-config-strip { align-items:flex-start; } .sv-media-config-meta { justify-content:flex-start; } .sv-media-provider-picker { width:100%; } .sv-media-provider-choice { flex:1; } .sv-subtitle-cue { grid-template-columns:1fr; gap:3px; } .sv-audio-task-tools,.sv-video-task-tools { grid-template-columns:1fr; } .sv-audio-picker-item { align-items:flex-start; flex-direction:column; } }
      @media (prefers-reduced-motion:reduce) { .sv-live-dot { animation:none; } }
      /* 应用内确认对话框：遮罩高于 sv-drawer(41)，卡片沿用宿主 lwb 卡片圆角与按钮体系。 */
      .sv-confirm-backdrop { position:fixed; z-index:45; inset:0; display:grid; place-items:center; padding:24px; background:rgba(27,39,53,.32); }
      .sv-confirm-card { width:min(430px,100%); max-height:min(720px,calc(100vh - 48px)); overflow:auto; padding:21px; box-shadow:0 18px 50px rgba(20,34,49,.22); }
      .sv-confirm-card .lwb-pack-detail-head { margin-bottom:14px; }
      /* ---- 共享任务套件：账号 Tab + 来源卡 + 任务卡 + 步骤胶囊 + 选取卡 + 抽屉（选题橙为默认 accent，写稿页经 data-accent=violet 复用同一套件）---- */
      .sv-tp-tabs { display:flex; flex-wrap:wrap; gap:7px; }
      .sv-tp-tab { display:inline-flex; align-items:center; gap:6px; padding:7px 13px; border:1px solid var(--lwb-line); border-radius:999px; color:var(--lwb-muted); background:var(--lwb-surface); cursor:pointer; font:inherit; font-size:var(--lwb-text-base,14px); font-weight:700; transition:border-color .15s ease,color .15s ease,background .15s ease; }
      .sv-tp-tab:hover:not(:disabled) { border-color:var(--sv-accent-line); color:var(--sv-accent-ink); }
      .sv-tp-tab:disabled { cursor:default; opacity:.6; }
      .sv-tp-tab[data-active="true"] { border-color:var(--sv-accent); color:var(--sv-accent-ink); background:var(--sv-accent-soft); }
      .sv-tp-tab-dot { width:6px; height:6px; border-radius:50%; background:var(--sv-accent); }
      .sv-tp-tab-badge { min-width:18px; padding:1px 5px; border-radius:999px; background:var(--sv-accent); color:#fff; font-size:11px; font-weight:700; line-height:16px; text-align:center; }
      .sv-pl-item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 14px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); }
      .sv-pl-item-main { display:grid; gap:3px; min-width:0; }
      .sv-pl-item-main strong { font-size:var(--lwb-text-base,14px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sv-pl-item-meta { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-pl-item-go { flex:none; }
      .sv-tp-acct-note { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-tp-acct-link { padding:0; border:0; color:var(--lwb-blue); background:none; cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); }
      .sv-tp-srcgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(170px,100%),1fr)); gap:8px; }
      .sv-tp-src { display:grid; gap:5px; padding:10px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); cursor:pointer; text-align:left; font:inherit; transition:border-color .15s ease,background .15s ease,box-shadow .15s ease; }
      .sv-tp-src:hover:not(:disabled) { border-color:#f0c08a; box-shadow:var(--sv-shadow-sm); }
      .sv-tp-src:disabled { cursor:default; opacity:.55; }
      .sv-tp-src[data-on="true"] { border-color:var(--sv-orange); background:#fff7ed; }
      .sv-tp-src-head { display:flex; align-items:flex-start; gap:6px; min-width:0; }
      .sv-tp-src-main { display:grid; flex:1 1 auto; gap:3px; min-width:0; padding:0; border:0; background:none; cursor:pointer; text-align:left; font:inherit; }
      .sv-tp-src-titlerow { display:flex; align-items:center; gap:6px; min-width:0; }
      .sv-tp-src-dot { flex:none; width:8px; height:8px; border-radius:3px; }
      .sv-tp-src-name { overflow:hidden; flex:1 1 auto; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .sv-tp-src-check { flex:none; display:grid; place-items:center; width:16px; height:16px; margin-top:1px; padding:0; border:1.5px solid var(--sv-orange); border-radius:5px; background:var(--sv-orange); color:#fff; cursor:pointer; font:inherit; }
      .sv-tp-src-check i { display:block; width:8px; height:4px; border:2px solid #fff; border-top:0; border-right:0; transform:rotate(-45deg) translate(1px,-1px); }
      .sv-tp-src[data-on="false"] .sv-tp-src-check { border-color:#c3ccd6; background:var(--lwb-surface); }
      .sv-tp-src[data-on="false"] .sv-tp-src-check i { display:none; }
      .sv-tp-src-open { padding:0; border:0; color:var(--lwb-blue); background:none; cursor:pointer; font:inherit; font-size:var(--lwb-text-xs,12px); }
      .sv-tp-src-open:hover { text-decoration:underline; }
      .sv-tp-src-meta { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-tp-src[data-on="false"] .sv-tp-src-check { border-color:var(--lwb-line); background:var(--lwb-surface); }
      .sv-tp-exclbar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 11px; border:1px solid #f3d7b0; border-radius:8px; background:#fff9f0; color:#9a5a10; font-size:var(--lwb-text-sm,13px); }
      .sv-tp-exclbar button { padding:2px 8px; border:1px solid #e7c493; border-radius:6px; color:#9a5a10; background:var(--lwb-surface); cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); }
      .sv-tp-task { display:grid; gap:9px; padding:13px 14px; border:1px solid var(--lwb-line); border-radius:11px; background:var(--lwb-surface); transition:border-color .15s ease,box-shadow .15s ease; }
      .sv-tp-task[data-status="queued"] { border-color:#c9d8e8; background:#f7fbff; }
      .sv-tp-task[data-status="running"] { border-color:var(--sv-accent-line); background:var(--sv-accent-soft); }
      .sv-tp-task[data-status="failed"] { border-color:#eec9c9; background:#fffafa; }
      .sv-tp-task-head { display:flex; align-items:flex-start; justify-content:space-between; gap:9px; }
      .sv-tp-task-title { overflow:hidden; margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.5; }
      .sv-tp-task-meta { margin:3px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-tp-task-badges { display:flex; flex:none; flex-wrap:wrap; gap:5px; justify-content:flex-end; }
      .sv-tp-steps { display:flex; flex-wrap:wrap; gap:6px; }
      .sv-tp-step { display:inline-flex; align-items:center; gap:5px; padding:4px 9px; border-radius:7px; background:#f2f3f5; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); font-weight:600; }
      .sv-tp-step i { width:5px; height:5px; border-radius:50%; background:#a7b2be; }
      .sv-tp-step[data-state="done"] { background:#eaf8f1; color:#1f7354; } .sv-tp-step[data-state="done"] i { background:#16865f; }
      .sv-tp-step[data-state="running"] { background:var(--sv-accent-soft); color:var(--sv-accent-ink); } .sv-tp-step[data-state="running"] i { background:var(--sv-accent); animation:sv-tp-pulse 1.2s ease-in-out infinite; }
      .sv-tp-step[data-state="error"] { background:#fdecec; color:#a94343; } .sv-tp-step[data-state="error"] i { background:#e5484d; }
      @keyframes sv-tp-pulse { 50% { opacity:.35; } }
      .sv-tp-task-acts { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
      .sv-tp-task-acts .sv-note { flex:1 1 180px; padding:0; border:0; background:none; }
      .sv-tp-task-group { display:grid; gap:8px; }
      .sv-tp-task-group-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:7px; }
      .sv-tp-task-group-title { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); font-weight:800; }
      .sv-tp-task-group-meta { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-tp-history-filters { display:flex; flex-wrap:wrap; gap:6px; }
      .sv-tp-history-tools { display:flex; flex-wrap:wrap; gap:8px; }
      .sv-tp-history-field { display:flex; flex:1 1 165px; min-width:0; flex-direction:column; gap:4px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-tp-history-field .sv-select { height:32px; }
      .sv-tp-history-filter { min-height:28px; padding:0 9px; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-muted); background:var(--lwb-surface); cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-tp-history-filter:hover:not(:disabled),.sv-tp-history-filter[aria-pressed="true"] { border-color:var(--sv-accent-line); color:var(--sv-accent-ink); background:var(--sv-accent-soft); }
      .sv-tp-history-filter:disabled { cursor:default; opacity:.6; }
      .sv-tp-pagination { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:2px; }
      .sv-tp-pagination-page { min-width:78px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); text-align:center; }
      .sv-tp-task[data-confirmed="true"] { border-color:#bfe3cf; background:#f6fcf8; }
      .sv-tp-confirmed { display:grid; gap:3px; padding:10px 12px; border:1px dashed #bfe3cf; border-radius:9px; background:var(--lwb-surface); }
      .sv-tp-confirmed-title { color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.5; }
      .sv-tp-confirmed-meta { color:#1f7354; font-size:var(--lwb-text-sm,13px); }
      .sv-tp-cand { display:grid; gap:5px; padding:12px 13px; border:1.5px solid var(--lwb-line); border-radius:11px; background:var(--lwb-surface); cursor:pointer; text-align:left; font:inherit; transition:border-color .15s ease,background .15s ease; }
      .sv-tp-cand:hover { border-color:var(--sv-accent-line); }
      .sv-tp-cand[data-sel="true"] { border-color:var(--sv-accent); background:var(--sv-accent-soft); }
      .sv-tp-cand-head { display:flex; flex-wrap:wrap; align-items:flex-start; gap:7px 9px; }
      .sv-tp-cand-radio { flex:none; display:grid; place-items:center; width:16px; height:16px; margin-top:2px; border:1.5px solid #c3ccd6; border-radius:4px; background:var(--lwb-surface); }
      .sv-tp-cand[data-sel="true"] .sv-tp-cand-radio { border-color:var(--sv-accent); }
      .sv-tp-cand-radio i { width:7px; height:4px; border:solid transparent; border-width:0 0 2px 2px; transform:translateY(-1px) rotate(-45deg); }
      .sv-tp-cand[data-sel="true"] .sv-tp-cand-radio i { border-color:var(--sv-accent); }
      .sv-tp-cand-title { flex:1 1 200px; min-width:0; margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.5; }
      .sv-tp-rec { flex:none; padding:2px 8px; border:1px solid var(--sv-accent-line); border-radius:5px; background:var(--sv-accent-soft); color:var(--sv-accent-ink); font-size:var(--lwb-text-xs,12px); font-weight:800; }
      .sv-tp-cand-meta { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-tp-cand-core { margin:0; color:#5b6572; font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-tp-cand-why { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .sv-tp-sumrow { display:grid; grid-template-columns:64px minmax(0,1fr); gap:8px; }
      .sv-tp-sumrow > span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-tp-sumrow > p { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-sm,13px); line-height:1.65; }
      .sv-tp-sumgrid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
      .sv-tp-sumgrid > div { display:grid; gap:2px; padding:9px 12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .sv-tp-sumgrid strong { color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); }
      .sv-tp-sumgrid strong[data-tone="brand"] { color:#c2410c; }
      .sv-tp-sumgrid span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-tp-drawer-foot { position:sticky; bottom:0; display:flex; align-items:center; justify-content:space-between; gap:10px; margin:14px -22px -22px; padding:13px 22px; border-top:1px solid var(--lwb-line); background:var(--lwb-surface); }
      .sv-sig-check { flex:none; display:grid; place-items:center; width:17px; height:17px; margin-top:2px; padding:0; border:1.5px solid var(--sv-orange); border-radius:5px; background:var(--sv-orange); cursor:pointer; }
      .sv-sig-check[data-on="false"] { border-color:#c3ccd6; background:var(--lwb-surface); }
      .sv-sig-check-tick { display:block; width:8px; height:4px; border:2px solid #fff; border-top:0; border-right:0; transform:rotate(-45deg) translate(1px,-1px); }
      .sv-signal-card[data-excluded="true"] { opacity:.55; }
      .sv-sig-excluded-tag { color:#7a5b17; background:#fff3e2; }
      .sv-drawer-selhint { margin:0 0 10px; padding:8px 11px; border:1px solid #f3d7b0; border-radius:8px; background:#fff9f0; color:#9a5a10; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      body[data-ds-dark-theme] .sv-tp-src[data-on="true"] { background:rgba(249,115,22,.14); }
      body[data-ds-dark-theme] .sv-tp-task[data-status="queued"] { border-color:rgba(96,165,250,.35); background:rgba(96,165,250,.08); }
      body[data-ds-dark-theme] .sv-tp-task[data-confirmed="true"] { border-color:rgba(16,185,129,.4); background:rgba(16,185,129,.08); }
      body[data-ds-dark-theme] .sv-tp-confirmed { border-color:rgba(16,185,129,.3); }
      body[data-ds-dark-theme] .sv-tp-confirmed-meta { color:#6ee7b7; }
      body[data-ds-dark-theme] .sv-tp-step[data-state="done"] { background:rgba(16,185,129,.14); color:#6ee7b7; }
      body[data-ds-dark-theme] .sv-tp-exclbar,body[data-ds-dark-theme] .sv-drawer-selhint { border-color:rgba(249,115,22,.3); background:rgba(249,115,22,.1); color:#fdba74; }
      /* ---- 写稿页专属：选题卡状态徽章/打开稿件 + 篇幅分段 + 稿件抽屉（编辑·润色·质检·确认仪式）---- */
      .sv-sc-state { flex:none; padding:1px 8px; border-radius:999px; border:1px solid var(--lwb-line); background:var(--lwb-page); color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; }
      .sv-sc-state[data-state="draft"] { border-color:#f3d7b0; background:#fff7ed; color:#c2410c; }
      .sv-sc-state[data-state="approved"] { border-color:#bfe3cf; background:#eaf8f1; color:#16865f; }
      .sv-sc-archived { flex:none; padding:1px 7px; border-radius:999px; background:#f3f4f6; color:#9ca3af; font-size:var(--lwb-text-xs,12px); font-weight:700; }
      .sv-sc-seg { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
      .sv-sc-seg button { display:grid; gap:1px; padding:7px 6px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); cursor:pointer; font:inherit; text-align:center; transition:border-color .15s ease,background .15s ease; }
      .sv-sc-seg button strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); font-weight:700; }
      .sv-sc-seg button span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-sc-seg button:hover:not(:disabled) { border-color:var(--sv-accent-line); }
      .sv-sc-seg button:disabled { cursor:default; opacity:.55; }
      .sv-sc-seg button[data-on="true"] { border-color:var(--sv-accent); background:var(--sv-accent-soft); }
      .sv-sc-seg button[data-on="true"] strong { color:var(--sv-accent-ink); }
      .sv-sc-more { display:block; width:100%; padding:7px; border:1px dashed var(--sv-accent-line); border-radius:9px; background:none; color:var(--sv-accent-ink); cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-sc-more:hover { background:var(--sv-accent-soft); }
      .sv-sc-open { flex:none; padding:2px 9px; border:1px solid var(--sv-accent-line); border-radius:6px; background:var(--lwb-surface); color:var(--sv-accent-ink); cursor:pointer; font:inherit; font-size:var(--lwb-text-xs,12px); font-weight:700; }
      .sv-sc-open:hover { background:var(--sv-accent-soft); }
      /* 稿件抽屉：承载「AI 稿件 → 编辑 → 润色 → 质检 → 确认」整条生命线，故加宽 */
      .sv-drawer-wide { width:min(860px,100vw); }
      .sv-sc-drawer-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
      .sv-sc-drawer-title { display:grid; min-width:0; gap:5px; }
      .sv-sc-drawer-titleline { display:flex; flex-wrap:wrap; width:100%; min-width:0; align-items:center; gap:8px; }
      .sv-sc-drawer-titleline h3 { min-width:0; flex:1 1 auto; overflow:hidden; margin:0; font-size:var(--lwb-text-section,18px); text-overflow:ellipsis; white-space:nowrap; }
      .sv-sc-drawer-meta { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-sc-drawer-tools { display:flex; flex:none; flex-wrap:wrap; justify-content:flex-end; gap:5px; }
      .sv-sc-drawer-tool { min-height:28px; padding:0 8px; border:1px solid var(--lwb-line); border-radius:6px; background:var(--lwb-surface); color:var(--lwb-muted); cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-sc-drawer-tool[data-tone="context"] { border-color:#bfdbfe; color:#1d4ed8; background:#eff6ff; }
      .sv-sc-drawer-tool[data-tone="ai"] { border-color:#ddd6fe; color:#6d28d9; background:#f5f3ff; }
      .sv-sc-drawer-tool[data-tone="quality"] { border-color:#fde68a; color:#a16207; background:#fffbeb; }
      .sv-sc-drawer-tool:hover:not(:disabled),.sv-sc-drawer-tool[data-active="true"] { filter:brightness(.97); box-shadow:0 1px 2px rgba(15,23,42,.08); }
      .sv-sc-drawer-tool:disabled { cursor:default; opacity:.55; }
      .sv-sc-drawer-body { display:grid; gap:18px; padding:18px 1px 28px; }
      .sv-sc-manuscript { max-width:720px; margin:0 auto; color:var(--lwb-ink); font-size:var(--lwb-text-lg,16px); line-height:1.9; white-space:pre-wrap; word-break:break-word; }
      .sv-sc-manuscript[data-candidate="true"] { color:#354254; }
      .sv-sc-empty-manuscript { display:grid; justify-items:center; gap:8px; max-width:560px; margin:54px auto; color:var(--lwb-muted); text-align:center; }
      .sv-sc-view-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px; padding-bottom:10px; border-bottom:1px solid var(--lwb-line); }
      .sv-sc-view-head h4 { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); }
      .sv-sc-view-head p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-sc-context-list { display:grid; gap:8px; }
      .sv-sc-context-item { display:grid; gap:4px; padding:12px 0; border-bottom:1px solid var(--lwb-line); }
      .sv-sc-context-item:last-child { border-bottom:0; }
      .sv-sc-context-item p { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); line-height:1.7; white-space:pre-wrap; word-break:break-word; }
      .sv-sc-context-item span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sc-brief { display:grid; gap:12px; max-width:720px; }
      .sv-sc-brief-row { display:grid; grid-template-columns:96px minmax(0,1fr); gap:14px; padding:11px 0; border-bottom:1px solid var(--lwb-line); }
      .sv-sc-brief-row span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sc-brief-row p { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); line-height:1.7; white-space:pre-wrap; word-break:break-word; }
      .sv-sc-candidate-meta { display:flex; flex-wrap:wrap; gap:6px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sc-fact-check { display:grid; gap:7px; max-width:720px; padding:12px 14px; border:1px solid #ecd39b; border-radius:8px; background:#fffaf0; }
      .sv-sc-fact-check strong { color:#9a6700; font-size:var(--lwb-text-base,14px); }
      .sv-sc-fact-check ul { display:grid; gap:4px; margin:0; padding-left:18px; color:#7a5b17; font-size:var(--lwb-text-base,14px); line-height:1.55; }
      .sv-sc-editor-label { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px; }
      .sv-sc-editor-label strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-sc-editor-label span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sc-editor { display:grid; gap:10px; min-width:0; }
      .sv-sc-editor .sv-textarea { min-height:420px; overflow:hidden; resize:none; font-size:var(--lwb-text-lg,16px); line-height:1.9; }
      .sv-sc-ai-actions { display:grid; gap:14px; max-width:720px; }
      .sv-sc-ai-action { display:grid; gap:9px; padding:0 0 14px; border-bottom:1px solid var(--lwb-line); }
      .sv-sc-ai-action:last-child { padding-bottom:0; border-bottom:0; }
      .sv-sc-ai-action-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px; }
      .sv-sc-ai-action-head strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-sc-ai-action-head span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sc-run-status { display:grid; gap:9px; max-width:720px; padding:12px 14px; border:1px solid var(--sv-accent-line); border-radius:9px; background:var(--sv-accent-soft); }
      .sv-sc-run-status[data-current="false"] { border-color:#f3d7b0; background:#fff9f0; }
      .sv-sc-run-status .sv-note { padding:0; border:0; color:var(--lwb-muted); background:transparent; }
      .sv-sc-auto-quality { display:grid; gap:7px; max-width:720px; }
      .sv-sc-auto-quality > p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-sc-polish { display:flex; flex-wrap:wrap; align-items:center; gap:7px; }
      .sv-sc-polish > .sv-sc-polish-label { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-sc-tiermini { display:flex; gap:4px; }
      .sv-sc-tiermini button { padding:3px 10px; border:1px solid var(--lwb-line); border-radius:6px; background:var(--lwb-surface); color:var(--lwb-muted); cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); }
      .sv-sc-tiermini button[data-on="true"] { border-color:var(--sv-accent); background:var(--sv-accent-soft); color:var(--sv-accent-ink); font-weight:700; }
      .sv-sc-polish input { flex:1 1 140px; min-width:120px; height:28px; padding:0 9px; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-sm,13px); }
      .sv-sc-polish-actions { display:flex; gap:7px; margin-left:auto; }
      .sv-sc-report { display:grid; gap:8px; max-width:720px; padding:12px 14px; border-radius:10px; background:var(--lwb-page); }
      .sv-sc-report-empty { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .sv-sc-ritual { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; flex:1; padding:9px 13px; border:1px solid #bfe3cf; border-radius:10px; background:#f6fcf8; }
      .sv-sc-ritual-info { display:grid; gap:2px; min-width:0; }
      .sv-sc-ritual-info strong { color:#16865f; font-size:var(--lwb-text-base,14px); }
      .sv-sc-ritual-info span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .sv-sc-gate-note { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      /* 稿件辅助信息不再替换正文，而是显示在独立弹窗中。 */
      .sv-sc-modal-backdrop { position:fixed; z-index:44; inset:0; display:grid; place-items:center; padding:24px; background:rgba(27,39,53,.32); }
      .sv-sc-modal { display:flex; flex-direction:column; width:min(720px,100%); max-height:min(780px,calc(100vh - 48px)); overflow:hidden; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-surface); box-shadow:0 18px 50px rgba(20,34,49,.22); }
      .sv-sc-modal-head { display:flex; flex:none; align-items:flex-start; justify-content:space-between; gap:12px; padding:18px 20px 14px; border-bottom:1px solid var(--lwb-line); }
      .sv-sc-modal-title { display:grid; min-width:0; gap:4px; }
      .sv-sc-modal-title h4 { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-section,18px); }
      .sv-sc-modal-title p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .sv-sc-modal-scroll { min-height:0; overflow:auto; padding:18px 20px 22px; }
      .sv-sc-modal-foot { display:flex; flex:none; flex-wrap:wrap; justify-content:flex-end; gap:8px; padding:13px 20px; border-top:1px solid var(--lwb-line); background:var(--lwb-page); }
      .sv-sc-modal-section { display:grid; gap:9px; }
      .sv-sc-modal-section + .sv-sc-modal-section { margin-top:20px; padding-top:18px; border-top:1px solid var(--lwb-line); }
      .sv-sc-modal-section h5 { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-sc-modal-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
      .sv-sc-modal-fact { display:grid; gap:4px; min-width:0; padding:11px 12px; border:1px solid var(--lwb-line); border-radius:8px; background:var(--lwb-page); }
      .sv-sc-modal-fact span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-sc-modal-fact p { margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.65; white-space:pre-wrap; word-break:break-word; }
      .sv-sc-modal-form { display:grid; gap:13px; }
      .sv-sc-modal-form label { display:grid; gap:6px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-sc-modal-form .sv-textarea { min-height:88px; resize:vertical; }
      .sv-sc-modal-note { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.65; }
      .sv-sc-candidate-copy { margin:0 0 12px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.65; }
      .sv-sc-modal .sv-sc-manuscript { max-width:100%; font-size:var(--lwb-text-md,15px); line-height:1.8; }
      body[data-ds-dark-theme] .sv-sc-drawer-tool[data-tone="context"] { border-color:rgba(96,165,250,.45); color:#93c5fd; background:rgba(59,130,246,.14); }
      body[data-ds-dark-theme] .sv-sc-drawer-tool[data-tone="ai"] { border-color:rgba(196,181,253,.45); color:#c4b5fd; background:rgba(124,58,237,.16); }
      body[data-ds-dark-theme] .sv-sc-drawer-tool[data-tone="quality"] { border-color:rgba(252,211,77,.42); color:#fcd34d; background:rgba(245,158,11,.12); }
      body[data-ds-dark-theme] .sv-sc-modal-foot,body[data-ds-dark-theme] .sv-sc-modal-fact { background:rgba(255,255,255,.03); }
      /* 确认闸门是写稿页唯一的绿色放行动作，与紫色生成动作明确区分 */
      .lwb-primary-button.sv-sc-approve { border-color:#16865f; background:#16865f; color:#fff; }
      .lwb-primary-button.sv-sc-approve:hover:not(:disabled) { background:#12764f; }
      body[data-ds-dark-theme] .lwb-primary-button.sv-sc-approve { background:#16865f; border-color:#16865f; }
      body[data-ds-dark-theme] .sv-sc-state[data-state="draft"] { border-color:rgba(249,115,22,.35); background:rgba(249,115,22,.14); color:#fdba74; }
      body[data-ds-dark-theme] .sv-sc-state[data-state="approved"] { border-color:rgba(16,185,129,.4); background:rgba(16,185,129,.14); color:#6ee7b7; }
      body[data-ds-dark-theme] .sv-sc-archived { background:#22313f; color:#8a94a6; }
      body[data-ds-dark-theme] .sv-sc-report { background:rgba(255,255,255,.03); }
      body[data-ds-dark-theme] .sv-sc-run-status[data-current="false"] { border-color:rgba(236,179,63,.35); background:rgba(236,179,63,.1); }
      body[data-ds-dark-theme] .sv-sc-ritual { border-color:rgba(16,185,129,.35); background:rgba(16,185,129,.08); }
      body[data-ds-dark-theme] .sv-sc-ritual-info strong { color:#6ee7b7; }
      body[data-ds-dark-theme] .sv-sc-fact-check { border-color:rgba(236,179,63,.35); background:rgba(236,179,63,.1); }
      body[data-ds-dark-theme] .sv-sc-fact-check strong { color:#fcd34d; }
      body[data-ds-dark-theme] .sv-sc-fact-check ul { color:#f5d99e; }
      /* ---- 发布页专属：视频货架卡片 + 封面预览/上传/提示词 + 发布资料表单（accent 红，复用 sv-tp-* 任务套件与 sv-sc-state 徽章）---- */
      .sv-pb-covers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .sv-pb-cover { display:grid; gap:8px; padding:12px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-page); }
      .sv-pb-cover-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
      .sv-pb-cover-head strong { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); }
      .sv-pb-cover-head span { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-pb-cover-frame { display:grid; place-items:center; min-height:120px; overflow:hidden; border:1px dashed var(--lwb-line); border-radius:8px; background:var(--lwb-surface); }
      .sv-pb-cover-frame img { display:block; max-width:100%; max-height:240px; object-fit:contain; }
      .sv-pb-cover-empty { padding:22px 10px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); text-align:center; }
      .sv-pb-cover-error { margin:0; padding:7px 9px; border:1px solid #eec9c9; border-radius:7px; background:#fffafa; color:#a94343; font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-pb-cover-acts { display:flex; flex-wrap:wrap; align-items:center; gap:7px; }
      .sv-pb-cover-acts .sv-meta { flex:1 1 120px; margin:0; }
      .sv-pb-form { display:grid; gap:13px; max-width:720px; }
      .sv-pb-field { display:grid; gap:6px; }
      .sv-pb-field > span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-pb-field-note { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .sv-pb-tags { display:flex; flex-wrap:wrap; gap:5px; }
      .sv-pb-tag { display:inline-flex; align-items:center; padding:2px 9px; border:1px solid var(--sv-accent-line); border-radius:999px; background:var(--sv-accent-soft); color:var(--sv-accent-ink); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-pb-prompt { display:grid; gap:6px; }
      .sv-pb-prompt > span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); font-weight:700; }
      .sv-pb-prompt .sv-textarea { min-height:64px; font-size:var(--lwb-text-sm,13px); }
      .sv-pb-shelf { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }
      .sv-pb-card { display:grid; gap:10px; padding:12px; border:1px solid var(--lwb-line); border-radius:10px; background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); }
      .sv-pb-card[data-selected="true"] { border-color:var(--sv-accent-line); box-shadow:0 0 0 2px var(--sv-accent-line); }
      .sv-pb-select { display:inline-flex; flex:none; align-items:center; gap:6px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); cursor:pointer; }
      .sv-pb-select input { width:16px; height:16px; margin:0; cursor:pointer; }
      .sv-pb-selection { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); }
      .sv-pb-selection > .sv-meta { flex:1; margin:0; }
      .sv-pb-thumb { position:relative; display:grid; place-items:center; min-height:150px; overflow:hidden; border:1px solid var(--lwb-line); border-radius:8px; background:#0e1a2b; }
      .sv-pb-thumb img { display:block; width:100%; height:100%; max-height:220px; object-fit:cover; }
      .sv-pb-thumb video { display:block; width:100%; max-height:340px; }
      .sv-pb-thumb-empty { padding:30px 12px; color:#8a94a6; font-size:var(--lwb-text-sm,13px); text-align:center; }
      .sv-pb-play { position:absolute; display:grid; place-items:center; width:46px; height:46px; border:0; border-radius:50%; background:rgba(255,255,255,.88); cursor:pointer; }
      .sv-pb-play::after { content:''; margin-left:3px; border-left:14px solid #1f2937; border-top:9px solid transparent; border-bottom:9px solid transparent; }
      .sv-pb-play:hover:not(:disabled) { background:#fff; }
      .sv-pb-play:disabled { opacity:.55; cursor:default; }
      .sv-pb-card-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:8px; }
      .sv-pb-card-title { overflow:hidden; margin:0; color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); font-weight:700; line-height:1.5; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
      .sv-pb-card-meta { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; }
      .sv-pb-card-foot { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
      body[data-ds-dark-theme] .sv-pb-cover { border-color:var(--lwb-line); background:rgba(255,255,255,.03); }
      body[data-ds-dark-theme] .sv-pb-cover-frame { border-color:rgba(255,255,255,.14); }
      body[data-ds-dark-theme] .sv-pb-cover-error { border-color:rgba(229,72,77,.4); background:rgba(229,72,77,.12); color:#fda4a4; }
      body[data-ds-dark-theme] .sv-pb-tag { border-color:rgba(var(--sv-accent-rgb),.45); background:rgba(var(--sv-accent-rgb),.16); }
      .sv-pb-drawer { width:min(1040px,100vw); padding:0; display:flex; flex-direction:column; overflow:hidden; }
      .sv-pb-drawer .sv-drawer-head { margin:0; padding:24px 28px 20px; background:linear-gradient(120deg,var(--sv-accent-soft),var(--lwb-surface) 75%); border-bottom:1px solid var(--lwb-line); }
      .sv-pb-drawer .sv-drawer-scroll { flex:1; min-height:0; padding:24px; background:var(--lwb-page); }
      .sv-pb-drawer .sv-sc-drawer-body { display:grid; gap:20px; padding:0; }
      .sv-pb-drawer .sv-pb-section { min-width:0; padding:22px; border:1px solid var(--lwb-line); border-radius:14px; background:var(--lwb-surface); box-shadow:var(--sv-shadow-sm); }
      .sv-pb-drawer .sv-pb-form { max-width:none; gap:16px; }
      .sv-pb-drawer .sv-tp-drawer-foot { flex:none; margin:0; padding:16px 24px; background:var(--lwb-surface); border-top:1px solid var(--lwb-line); }
      .sv-pb-section-number { margin:0 0 10px; color:var(--sv-accent-ink); font-size:11px; font-weight:750; letter-spacing:.08em; }
      .sv-pb-section-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; }
      .sv-pb-section-heading h4 { margin:0; font-size:18px; }
      .sv-pb-section-heading p:not(.sv-pb-section-number) { margin:6px 0 0; color:var(--lwb-muted); font-size:12px; }
      .sv-pb-final .sv-pb-thumb { height:280px; }
      .sv-pb-final .sv-pb-thumb img { object-fit:contain; max-height:280px; }
      .sv-pb-drawer .sv-pb-cover { padding:16px; gap:12px; align-content:start; }
      .sv-pb-drawer .sv-pb-cover-head { align-items:flex-start; flex-direction:column; gap:5px; }
      .sv-pb-drawer .sv-pb-cover-frame { height:230px; border-style:solid; background:var(--lwb-page); }
      .sv-pb-drawer .sv-pb-cover-frame img { max-height:228px; }
      .sv-pb-download { display:grid; gap:6px; justify-items:start; flex:none; }
      .sv-pb-player { position:fixed; inset:0; width:100vw; height:100dvh; max-width:none; max-height:none; margin:0; border:0; padding:24px; background:transparent; color:var(--lwb-ink); }
      .sv-pb-player[open] { display:grid; place-items:center; }
      .sv-pb-player::backdrop { background:rgba(8,14,26,.76); backdrop-filter:blur(6px); }
      .sv-pb-player-panel { width:min(1080px,100%); max-height:calc(100dvh - 48px); display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--lwb-line); border-radius:18px; background:var(--lwb-surface); box-shadow:0 24px 90px #0006; }
      .sv-pb-player header,.sv-pb-player footer { display:flex; flex:none; justify-content:space-between; align-items:center; gap:20px; padding:18px 22px; }
      .sv-pb-player header p { margin:0 0 6px; color:var(--lwb-muted); font-size:11px; }
      .sv-pb-player h3 { margin:0; font-size:18px; line-height:1.5; overflow-wrap:anywhere; }
      .sv-pb-player footer { font-size:12px; color:var(--lwb-muted); }
      .sv-pb-player-stage { min-height:150px; min-width:0; overflow:auto; background:#080f1c; display:grid; place-items:center; color:#d0d7e4; }
      .sv-pb-player-stage > p { padding:30px; }
      .sv-pb-player video { display:block; width:100%; max-height:calc(100dvh - 210px); }
      .sv-as-history { display:grid; gap:16px; }
      .sv-as-history-filters { display:grid; grid-template-columns:minmax(180px,1fr) 140px 145px; gap:8px; }
      .sv-as-history-drawer { width:min(1000px,100vw); display:flex; flex-direction:column; overflow:hidden; }
      .sv-as-history-drawer .sv-drawer-scroll { min-height:0; flex:1; padding:2px 4px 12px; }
      .sv-as-history-drawer .sv-as-history-filters { position:sticky; top:0; z-index:1; padding:8px 0; background:var(--lwb-surface); }
      .sv-as-history-drawer .sv-audio-pagebar { position:sticky; bottom:-12px; z-index:1; margin:0; padding:12px 0; background:var(--lwb-surface); border-top:1px solid var(--lwb-line); }
      .sv-as-history-drawer h3 { margin:0; font-size:21px; }
      .sv-as-round { min-width:0; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-surface); overflow:hidden; }
      .sv-as-round-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:17px 18px 10px; }
      .sv-as-round-toggle { display:grid; gap:7px; min-width:0; padding:0; border:0; background:none; color:var(--lwb-ink); text-align:left; font:inherit; cursor:pointer; }
      .sv-as-round-toggle strong { font-size:14px; overflow-wrap:anywhere; }
      .sv-as-round-toggle span,.sv-as-round-message { color:var(--lwb-muted); font-size:12px; line-height:1.7; }
      .sv-as-round-toggle small { color:var(--sv-accent-ink); font-size:12px; }
      .sv-as-round-message { margin:0; padding:0 18px 12px; }
      .sv-as-round-items { display:grid; gap:10px; padding:4px 18px 18px; }
      .sv-as-result { display:grid; grid-template-columns:150px minmax(0,1fr); gap:15px; align-items:center; padding:10px; border:1px solid var(--lwb-line); border-radius:9px; }
      .sv-as-result .sv-pb-thumb { min-height:84px; height:84px; }
      .sv-as-result .sv-pb-thumb img { object-fit:contain; max-height:84px; }
      .sv-as-result .sv-pb-thumb-empty { padding:12px; font-size:12px; }
      .sv-as-result .sv-pb-play { width:32px; height:32px; }
      .sv-as-result .sv-pb-play::after { border-left-width:10px; border-top-width:6px; border-bottom-width:6px; }
      .sv-as-result-info { display:grid; gap:7px; justify-items:start; min-width:0; }
      .sv-as-result-info strong { font-size:14px; line-height:1.6; overflow-wrap:anywhere; }
      .sv-as-result-info span { font-size:12px; color:var(--lwb-muted); }
      .sv-as-round-detail { display:grid; gap:14px; padding:20px 18px; border-top:1px solid var(--lwb-line); background:var(--lwb-page); }
      .sv-as-page-size { width:auto; }
      .sv-ex-state[data-status="partial"] { background:#fff4da; color:#a5680b; }
      body[data-ds-dark-theme] .sv-ex-state[data-status="partial"] { background:#493819; color:#ffd383; }
      @media(max-width:680px) { .sv-as-history-filters { grid-template-columns:1fr 1fr; } .sv-as-history-filters input { grid-column:1/-1; } .sv-as-result { grid-template-columns:100px minmax(0,1fr); gap:10px; } .sv-pb-drawer .sv-drawer-head,.sv-pb-drawer .sv-drawer-scroll { padding:16px; } .sv-pb-drawer .sv-pb-section { padding:16px; } .sv-pb-player { padding:10px; } .sv-pb-player-panel { max-height:calc(100dvh - 20px); } .sv-pb-section-heading { align-items:flex-start; flex-wrap:wrap; } }
      @media (max-width:680px) { .sv-pb-covers { grid-template-columns:1fr; } .sv-pb-shelf { grid-template-columns:1fr; } }
      @media (max-width:680px) { .sv-sc-drawer-head { display:grid; } .sv-sc-drawer-tools { justify-content:flex-start; } .sv-drawer-wide { width:100vw; padding-top:58px; } .sv-sc-brief-row { grid-template-columns:1fr; gap:4px; } .sv-sc-editor .sv-textarea { min-height:320px; } .sv-sc-modal-backdrop { align-items:start; padding:58px 12px 16px; } .sv-sc-modal { width:100%; max-height:calc(100vh - 74px); } .sv-sc-modal-head,.sv-sc-modal-scroll,.sv-sc-modal-foot { padding-left:14px; padding-right:14px; } .sv-sc-modal-grid { grid-template-columns:1fr; } }

      .lwb-page-capability:has(.sv-page) > .lwb-page-intro { display:none; }
      /* Type follows the workbench scale; shrink columns to the actual content width. */
      body[data-ds-dark-theme] .sv-page { --sv-brand:#a5b4fc; }
      body[data-ds-dark-theme] .sv-primary-mini,body[data-ds-dark-theme] .sv-filter-chip[data-on="true"] { background:#4f46e5; }
      body[data-ds-dark-theme] .sv-heromini-cell strong[data-tone="red"] { color:#fca5a5; }
      body[data-ds-dark-theme] .sv-heromini-cell strong[data-tone="orange"] { color:#fdba74; }
      .sv-page { font-size:var(--lwb-text-base,14px); line-height:1.55; container-type:inline-size; }
      .sv-layout > *,.sv-split > *,.sv-top > *,.sv-item-head > * { min-width:0; }
      .sv-input,.sv-select,.sv-drawer-search { min-height:40px; }
      .sv-tabs,.sv-tp-acctabs { max-width:100%; overflow-x:auto; }
      .sv-tab { flex:none; }
      .sv-drawer-head > :first-child { min-width:0; overflow-wrap:anywhere; }
      .sv-drawer-head > button { flex:none; }
      .sv-top-actions { flex-wrap:wrap; }
      .sv-stat,.sv-cmd-stat { min-width:0; }
      .sv-page :is(button,a,summary):focus-visible { outline:2px solid var(--lwb-blue); outline-offset:3px; }
      .sv-sc-manuscript,.sv-sc-modal .sv-sc-manuscript { font-size:var(--lwb-text-lg,16px); }
      @container (max-width:850px) {
        .sv-layout,.sv-split,.sv-dashboard,.sv-audio-workbench { grid-template-columns:minmax(0,1fr); }
        .sv-video-workbench { grid-template-columns:minmax(0,1fr); grid-template-areas:'sources' 'tasks'; }
        .sv-insight-panel { position:static; }
      }
      @container (max-width:480px) {
        .sv-board-grid,.sv-source-grid,.sv-source-compact-grid,.sv-acc-grid,.sv-pb-shelf { grid-template-columns:minmax(0,1fr); }
        .sv-inline-form,.sv-media-config-grid,.sv-audio-parameters { grid-template-columns:minmax(0,1fr); }
        .sv-top-actions { width:100%; }
      }
      @media (max-width:680px) {
        .sv-drawer { z-index:91; padding:18px 16px; }
        .sv-pb-drawer { padding:0; }
        .sv-pb-drawer,.sv-as-history-drawer { max-width:100%; }
        .sv-pb-drawer .sv-sc-drawer-head { display:flex; align-items:flex-start; }
        .sv-pb-drawer .sv-sc-drawer-tools { flex:none; }
        .sv-tp-drawer-foot { flex-wrap:wrap; margin:14px -16px -18px; padding:13px 16px; }
        .sv-tp-drawer-foot > span { flex-wrap:wrap; max-width:100%; }
        .sv-drawer-backdrop { z-index:90; }
        .sv-confirm-backdrop,.sv-sc-modal-backdrop { z-index:95; }
        .sv-input,.sv-textarea,.sv-select,.sv-drawer-search { font-size:16px; }
        .sv-tp-srcgrid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      }
      @media (prefers-reduced-motion:reduce) { .sv-page * { animation:none !important; transition:none !important; } }
    `;
    function installStyle() {
      const existing = document.getElementById('lwb-spoken-video-style');
      // A pack can be reloaded in place by the workbench. Replace old rules so
      // updated page layouts do not remain pinned to the earlier bundle's CSS.
      if (existing) { existing.setAttribute('data-plugin', '@scitiger-ai/lwb-spoken-video'); existing.textContent = productCss; return; }
      const style = document.createElement('style');
      style.id = 'lwb-spoken-video-style';
      style.setAttribute('data-plugin', '@scitiger-ai/lwb-spoken-video');
      style.textContent = productCss;
      document.head.appendChild(style);
    }
    function actionKey(prefix) { return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    function sourceName(id) { return SOURCES[id] || id || '未知来源'; }
    function sourceLabel(sources, id) { return sources.find((source) => source.id === id)?.name || sourceName(id); }
    function csv(value) { return String(value || '').split(/[，,]/u).map((item) => item.trim()).filter(Boolean); }
    function sourceStatus(source) { if (!source.enabled) return ['已停用', 'sv-status-disabled']; if (source.health?.status === 'ready') return ['正常', '']; if (source.health?.status === 'error') return ['异常', 'sv-status-error']; return ['未采集', '']; }
    function sourceActivity(source) { return `最近成功 ${formatTime(source.health?.lastSuccessAt)} · ${source.signalCount} 条`; }
    function stageName(project) { return LABEL[project.stage] || project.stage; }
    function stageData(detail, stage) { return detail?.artifacts?.[stage]?.data; }
    function done(detail, stage) { return Boolean(detail?.artifacts?.[stage]); }
    function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未执行'; }
    const FAMILY_ORDER = ['公共热点', '内容平台', '科技与商业', '开发者社区', 'AI / 开源'];
    const FRESH_LABEL = { fresh: '新鲜', recent: '较新', stale: '过期', none: '今日暂无数据' };
    function formatHot(value) { if (!value) return ''; if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`; if (value >= 10000) return `${(value / 10000).toFixed(1)}万`; return String(value); }
    function relativeTime(value) {
      if (!value) return '尚未采集';
      const diff = Date.now() - Date.parse(value);
      if (!Number.isFinite(diff) || diff < 0) return formatTime(value);
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.floor(hours / 24)} 天前`;
    }
    const AVATAR_HUES = [258, 210, 152, 16, 288, 330, 190, 42, 124, 268];
    function accountAvatar(name) {
      const chars = Array.from(String(name || '账'));
      const letter = chars[0] || '账';
      const hash = String(name || '').split('').reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 7);
      return { letter, background: `hsl(${AVATAR_HUES[hash % AVATAR_HUES.length]}, 62%, 47%)` };
    }
    async function remote(packId, method, request) {
      if (packId !== 'spoken-video' || !connection?.rpc?.call) throw new Error('能力包连接尚未就绪。');
      const response = await connection.rpc.call('/api', `spokenVideo/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '口播视频操作未完成。');
      return response.value;
    }
    async function remoteStatic(method, request) {
      if (!connection?.rpc?.call) throw new Error('工作台连接不可用。');
      const response = await connection.rpc.call('/api', `spokenVideo/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '口播视频操作未完成。');
      return response.value;
    }
    async function base64FromAudioFile(file) {
      if (!file || typeof FileReader !== 'function') throw new Error('当前浏览器无法读取所选音频。');
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('无法读取所选音频。'));
        reader.onabort = () => reject(new Error('音频读取已取消。'));
        reader.onload = () => {
          const encoded = typeof reader.result === 'string' ? reader.result : '';
          const separator = encoded.indexOf(',');
          const header = separator < 0 ? '' : encoded.slice(0, separator);
          if (!header.startsWith('data:') || !/;base64$/iu.test(header)) { reject(new Error('浏览器未能读取音频。')); return; }
          resolve(encoded.slice(separator + 1));
        };
        reader.readAsDataURL(file);
      });
    }
    const MODULE_CONTEXT = {
      '账号定位': ['内容策略', '#8b5cf6'],
      '信号': ['内容情报', '#3b82f6'],
      '选题': ['创作策划', '#f97316'],
      '写稿': ['内容生产', '#7c3aed'],
      '配音 / 字幕': ['音频与字幕', '#ec4899'],
      '视频 / 预览': ['视频制作', '#10b981'],
      '发布': ['发布资料', '#ef4444'],
      '内容安排': ['运营安排', '#0ea5e9'],
    };
    function Intro({ title, copy, actions }) {
      const ctx = MODULE_CONTEXT[title];
      return h('header', { className: 'sv-top' },
        h('div', null,
          ctx && h('p', { className: 'sv-module-kicker' }, h('span', { className: 'sv-module-dot', style: { background: ctx[1] } }), ctx[0]),
          h('h1', null, title),
          h('p', null, copy),
          ),
        actions ? h('div', { className: 'sv-top-actions' }, actions) : null,
      );
    }
    function Notice({ error }) { return error ? h('p', { className: 'sv-error', role: 'alert' }, error) : null; }

    /**
     * 提示音与桌面通知开关。
     *
     * 音频上下文必须在用户手势里首次解锁，这是浏览器自动播放策略的要求——
     * 所以开关按钮同时承担「开声音」和「解锁音频」两件事，光勾选不点不会生效。
     */

    function NotifyToggle() {
      const [sound, setSound] = React.useState(() => notify.settings.sound !== false);
      const [desktop, setDesktop] = React.useState(() => Boolean(notify.settings.desktop));
      return h('div', { className: 'sv-notify-toggle' },
        h('button', {
          type: 'button',
          className: `lwb-plain-button${sound ? ' is-on' : ''}`,
          title: sound ? '完成与失败时会播放提示音' : '提示音已关闭',
          onClick: () => {
            // 先解锁再改设置：用户点了按钮就是一个合规的手势上下文。
            notify.unlock();
            const next = !sound;
            setSound(next);
            notify.settings.sound = next;
            notifySave();
            if (next) notify.play('attention');
          },
        }, sound ? '🔔 提示音开' : '🔕 提示音关'),
        h('button', {
          type: 'button',
          className: `lwb-plain-button${desktop ? ' is-on' : ''}`,
          title: desktop ? '桌面通知已开启' : '点击开启桌面通知（浏览器会询问权限）',
          onClick: async () => {
            if (desktop) { notify.settings.desktop = false; notifySave(); setDesktop(false); return; }
            const permission = await notify.requestDesktop();
            setDesktop(permission === 'granted');
          },
        }, desktop ? '🖥 桌面通知开' : '🖥 桌面通知关'));
    }

    /**
     * 排队条：同时只跑一轮，其余按执行顺序排队等位次。
     *
     * 改造前同刻到期的任务会互相抢跑，抢输的那个被静默吞掉；现在它们都在
     * 队列里可见，位次是确定的。
     */
    function QueueBar({ queue }) {
      const waiting = queue?.waiting || [];
      const active = Number(queue?.active || 0);
      if (!active && !waiting.length) return null;
      return h('div', { className: 'sv-queue-bar' },
        h('span', { className: 'sv-queue-title' }, '执行队列'),
        active ? h('span', { className: 'sv-live-pill' }, h('span', { className: 'sv-live-dot' }), `正在执行 ${active} 项`) : null,
        waiting.length
          ? h('span', { className: 'sv-queue-waiting' }, `等待 ${waiting.length} 项：`,
            waiting.slice(0, 4).map((item) => h('span', { key: item.id, className: 'sv-queue-chip' }, `${item.position}. ${item.scheduleName || '内容安排'}`)),
            waiting.length > 4 ? h('span', { className: 'sv-queue-more' }, `等 ${waiting.length - 4} 项`) : null)
          : h('span', { className: 'sv-queue-idle' }, '队列空闲'));
    }

    /**
     * 故障聚类面板：按根因折叠，直接回答「最近为什么失败、该改什么」。
     *
     * 24 条失败逐条读是读不完的；同一根因折叠成一行、带上该做什么，才是真的
     * 「自己能找出原因」。
     */
    function FailurePanel({ failures, onResume, busy }) {
      const [expanded, setExpanded] = React.useState(false);
      const clusters = failures?.clusters || [];
      if (!clusters.length) return null;
      return h('section', { className: 'sv-fail-panel' },
        h('header', { className: 'sv-fail-head' },
          h('h4', null, `最近失败 ${failures.total} 次，归为 ${clusters.length} 类`),
          h('button', {
            type: 'button', className: 'lwb-plain-button',
            onClick: () => setExpanded((value) => !value),
          }, expanded ? '收起' : '展开明细')),
        clusters.slice(0, expanded ? 20 : 5).map((cluster) => h('div', { key: cluster.signature, className: 'sv-fail-row' },
          h('span', { className: `sv-fail-count${cluster.count > 1 ? ' is-many' : ''}` }, `×${cluster.count}`),
          h('div', { className: 'sv-fail-body' },
            h('p', { className: 'sv-fail-cat' }, cluster.categoryLabel),
            h('p', { className: 'sv-fail-sig' }, cluster.sample),
            h('p', { className: 'sv-fail-remedy' }, cluster.remedy)))),
        expanded && (failures.recent || []).some((row) => row.runId) ? h('div', { className: 'sv-fail-recent' },
          h('p', { className: 'sv-fail-cat' }, '可续跑的轮次'),
          (failures.recent || [])
            .filter((row) => row.category === 'host.restart')
            .slice(0, 5)
            .map((row) => h('button', {
              key: row.id, type: 'button', className: 'lwb-plain-button',
              disabled: busy,
              onClick: () => onResume(row.runId),
            }, `续跑该轮（${row.scheduleName || row.itemTitle || '内容安排'}）`))) : null);
    }
    /* 应用内确认对话框：复用宿主 lwb 对话框视觉体系（modal 遮罩 / 卡片 / 三类按钮），层级高于 sv-drawer。 */
    function useSvConfirm() {
      const [meta, setMeta] = React.useState(null);
      React.useEffect(() => {
        if (!meta) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setMeta(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [meta]);
      const node = meta && h('div', { className: 'sv-confirm-backdrop', role: 'presentation', onClick: () => setMeta(null) },
        h('div', { className: 'lwb-card lwb-pack-detail sv-confirm-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': meta.title, onClick: (event) => event.stopPropagation() },
          h('div', { className: 'lwb-pack-detail-head' },
            h('div', null, h('h2', { className: 'lwb-modal-title' }, meta.title), meta.copy ? h('p', { className: 'lwb-modal-copy' }, meta.copy) : null),
            h('button', { type: 'button', className: 'lwb-detail-close', title: '取消', 'aria-label': '取消', onClick: () => setMeta(null) }, '×'),
          ),
          h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setMeta(null) }, '取消'),
            h('button', { type: 'button', className: meta.danger ? 'lwb-danger-button' : 'lwb-primary-button', onClick: () => { const action = meta.onConfirm; setMeta(null); action(); } }, meta.confirm || '确认'),
          ),
        ),
      );
      return [node, setMeta];
    }
    /**
     * 带输入框的站内弹窗（替代 window.prompt）。
     *
     * 原生 prompt 在暗色主题下是白底黑字、不可样式化、会阻塞渲染线程；
     * 与同文件其它操作（走 useSvConfirm）视觉上完全割裂。
     */
    function useSvPrompt() {
      const [meta, setMeta] = React.useState(null);
      const [value, setValue] = React.useState('');
      React.useEffect(() => {
        if (!meta) return undefined;
        setValue(meta.initialValue || '');
        const onKey = (event) => { if (event.key === 'Escape') setMeta(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [meta]);
      const node = meta && h('div', { className: 'sv-confirm-backdrop', role: 'presentation', onClick: () => setMeta(null) },
        h('div', { className: 'lwb-card lwb-pack-detail sv-confirm-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': meta.title, onClick: (event) => event.stopPropagation() },
          h('div', { className: 'lwb-pack-detail-head' },
            h('div', null, h('h2', { className: 'lwb-modal-title' }, meta.title), meta.copy ? h('p', { className: 'lwb-modal-copy' }, meta.copy) : null),
            h('button', { type: 'button', className: 'lwb-detail-close', title: '取消', 'aria-label': '取消', onClick: () => setMeta(null) }, '×'),
          ),
          h('input', { className: 'sv-input', value, maxLength: meta.maxLength || 80, autoFocus: true, 'aria-label': meta.title, onChange: (event) => setValue(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && value.trim()) { const action = meta.onConfirm; setMeta(null); action(value.trim()); } } }),
          h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setMeta(null) }, '取消'),
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: !value.trim(), onClick: () => { const action = meta.onConfirm; setMeta(null); action(value.trim()); } }, meta.confirm || '确定'),
          ),
        ),
      );
      const open = (options) => setMeta(options);
      return [node, open];
    }
    function NeedPack() { return h('section', { className: 'sv-form' }, h('p', null, '正在准备能力包工作区…')); }
    function useProjects(packId) {
      const [projects, setProjects] = React.useState([]); const [error, setError] = React.useState(null); const [loading, setLoading] = React.useState(false);
      const refresh = React.useCallback(async () => { if (!packId) { setProjects([]); return []; } setLoading(true); try { const next = await remote(packId, 'list'); setProjects(next); setError(null); return next; } catch (cause) { setError(cause.message); return []; } finally { setLoading(false); } }, [packId]);
      React.useEffect(() => { void refresh(); }, [refresh]); return { projects, error, setError, loading, refresh };
    }
    function useDetail(packId, projectId) {
      const [detail, setDetail] = React.useState(null); const [error, setError] = React.useState(null);
      const reload = React.useCallback(async (id = projectId) => { if (!packId || !id) { setDetail(null); return null; } try { const next = await remote(packId, 'get', { projectId: id }); setDetail(next); setError(null); return next; } catch (cause) { setError(cause.message); return null; } }, [packId, projectId]);
      React.useEffect(() => { void reload(); }, [reload]); return { detail, error, reload };
    }
    function StageDots({ project }) {
      return h('span', { className: 'sv-proj-dots', 'aria-label': `已完成 ${project.completedStages.length}/${STAGES.length} 阶段` }, STAGES.map((stage) => h('i', { key: stage, 'data-on': project.completedStages.includes(stage) ? (project.stage === stage ? 'true' : 'done') : project.stage === stage ? 'true' : undefined, title: LABEL[stage] })));
    }
    function ProjectList({ projects, selectedId, onSelect, empty }) {
      return projects.length ? h('div', { className: 'sv-list' }, projects.map((project) => h('button', { key: project.id, type: 'button', className: 'sv-item', 'data-active': selectedId === project.id ? 'true' : 'false', onClick: () => onSelect(project.id), style: { textAlign: 'left', cursor: 'pointer' } }, h('span', { className: 'sv-item-head' }, h('span', { className: 'sv-item-title' }, project.title), h('span', { className: 'sv-stage' }, stageName(project))), h(StageDots, { project }), h('span', { className: 'sv-meta' }, `版本 ${project.revision} · 已完成 ${project.completedStages.length}/${STAGES.length} 阶段`)))) : h('div', { className: 'sv-empty' }, empty);
    }
    function useCommit(packId, refreshProjects, reloadDetail, setError) {
      const [saving, setSaving] = React.useState(false);
      const commit = React.useCallback(async (detail, stage, payload) => { if (!detail) return null; setSaving(true); try { const result = await remote(packId, 'commit', { projectId: detail.id, expectedRevision: detail.revision, stage, payload, idempotencyKey: actionKey(stage) }); await refreshProjects(); await reloadDetail(result.project.id); setError(null); return result; } catch (cause) { setError(cause.message); return null; } finally { setSaving(false); } }, [packId, refreshProjects, reloadDetail, setError]);
      return { saving, commit };
    }
    function useSelectedProject(projects, condition = () => true) {
      const conditionRef = React.useRef(condition);
      conditionRef.current = condition;
      const projectIds = projects.map((project) => project.id).join('|');
      const [selectedId, setSelectedId] = React.useState(null);
      React.useEffect(() => {
        setSelectedId((current) => current && projects.some((project) => project.id === current)
          ? current
          : projects.find(conditionRef.current)?.id || null);
      }, [projectIds]);
      return [selectedId, setSelectedId];
    }

    const PLATFORM_GLYPHS = { '抖音': ['#171B26', '抖'], 'B站': ['#FB7299', 'B'], '公众号': ['#07C160', '公'], '小红书': ['#FF2442', '红'], '视频号': ['#FA9D3B', '视'], '微博': ['#E6162D', '微'], '知乎': ['#0084FF', '知'] };
    function glyphFor(item, fallbackName) {
      const platform = item?.platform || null;
      const known = platform && PLATFORM_GLYPHS[platform];
      if (known) return { color: known[0], letter: known[1], label: platform };
      const name = platform || fallbackName || '来源';
      return { color: '#3b82f6', letter: name.charAt(0), label: platform || name };
    }
    function SignalDrawerBody({ packId, sources, spec, today, busy, onClose, onCollect, onChanged, ask, selection }) {
      const [signals, setSignals] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [acting, setActing] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const reload = React.useCallback(async () => {
        try {
          const next = await remote(packId, 'listSignals', { sourceIds: [spec.sourceId], ...(spec.platform ? { platform: spec.platform } : {}), limit: 200 })
          setSignals(next)
          setLoadError(null)
        } catch (cause) { setLoadError(cause.message) }
      }, [packId, spec.sourceId, spec.platform])
      React.useEffect(() => { void reload() }, [reload])
      const source = sources.find((item) => item.id === spec.sourceId)
      const setState = async (item, state) => {
        setActing(item.id)
        try { await remote(packId, 'setSignalState', { signalId: item.id, state }); await reload(); onChanged() } catch (cause) { setLoadError(cause.message) } finally { setActing(null) }
      }
      const inToday = (item) => Boolean(today) && item.capturedAt >= today.startIso && item.capturedAt < today.endIso
      const [statusText, statusClass] = source ? sourceStatus(source) : ['—', 'sv-status-disabled']
      const all = signals || []
      const savedCount = all.filter((item) => item.state === 'saved').length
      const activeCount = all.filter((item) => item.state === 'active').length
      const excludedCount = selection ? all.filter((item) => selection.excluded.has(item.id)).length : 0
      const toggleSelect = selection && typeof selection.onToggle === 'function' ? selection.onToggle : null
      const matches = (item) => {
        if (filter === 'today' && !inToday(item)) return false
        if (filter === 'saved' && item.state !== 'saved') return false
        if (filter === 'ignored' && item.state !== 'ignored') return false
        if (filter === 'excluded' && (!selection || !selection.excluded.has(item.id))) return false
        const q = query.trim().toLowerCase()
        if (q && !`${item.title}\n${item.summary || ''}`.toLowerCase().includes(q)) return false
        return true
      }
      const filtered = all.filter(matches)
      const todayItems = filtered.filter(inToday)
      const earlierItems = filtered.filter((item) => !inToday(item))
      const rankTier = (rank) => (rank <= 1 ? 'top' : rank <= 3 ? 'hot' : undefined)
      const row = (item) => {
        const glyph = glyphFor(item, spec.name)
        const tags = (item.tags || []).filter((tag) => !/^\d+$/u.test(tag))
        const fresh = inToday(item)
        const excluded = selection ? selection.excluded.has(item.id) : false
        const checkbox = selection && item.state === 'active' ? h('button', { type: 'button', className: 'sv-sig-check', 'data-on': excluded ? 'false' : 'true', 'aria-pressed': !excluded, 'aria-label': excluded ? '本次参与' : '本次排除', onClick: () => { toggleSelect(item.id) } }, excluded ? null : h('span', { className: 'sv-sig-check-tick' })) : null
        return h('article', { key: item.id, className: 'sv-signal-card', 'data-excluded': selection && excluded ? 'true' : 'false' },
          h('div', { className: 'sv-sig-head' },
            checkbox,
            h('span', { className: 'sv-glyph', style: { background: glyph.color }, title: glyph.label }, glyph.letter),
            h('div', { className: 'sv-sig-titlebox' },
              h('p', { className: 'sv-sig-src' }, item.platform ? glyph.label : spec.name),
              h('h3', { className: 'sv-signal-title' }, item.title),
            ),
            selection && excluded && h('span', { className: 'sv-tag sv-sig-excluded-tag' }, '本次排除'),
            item.state !== 'active' && h('span', { className: `sv-tag ${item.state === 'saved' ? 'sv-status-ready' : 'sv-status-disabled'}` }, item.state === 'saved' ? '已收藏' : '已忽略'),
            item.rank ? h('span', { className: 'sv-rank', 'data-tier': rankTier(item.rank) }, `#${item.rank}`) : null,
          ),
          h('p', { className: 'sv-signal-summary' }, item.summary || '该来源未提供摘要。'),
          h('div', { className: 'sv-sig-metrics' },
            h('span', { className: 'sv-scorebar' }, h('i', { style: { '--sv-fill': `${Math.min(100, item.score || 0)}%` } }), h('strong', null, item.score)),
            item.hotValue ? h('span', { className: 'sv-hot' }, h('i', null), formatHot(item.hotValue)) : null,
            h('span', { className: fresh ? 'sv-new' : 'sv-meta' }, fresh ? h('i', null) : null, `${relativeTime(item.capturedAt)}${fresh ? ' · 今日新增' : ''}`),
            tags.length ? h('span', { className: 'sv-meta' }, tags.slice(0, 3).join(' · ')) : null,
          ),
          h('div', { className: 'sv-sig-acts' },
            h('span', { className: 'sv-sig-tools' },
              item.url && h('a', { href: item.url, target: '_blank', rel: 'noreferrer', className: 'sv-outline-mini' }, '原文'),
              item.state !== 'saved' && h('button', { type: 'button', className: 'sv-outline-mini', disabled: Boolean(acting), onClick: () => { void setState(item, 'saved') } }, '收藏'),
              item.state !== 'ignored' && h('button', { type: 'button', className: 'sv-outline-mini', disabled: Boolean(acting), onClick: () => { void setState(item, 'ignored') } }, '忽略'),
              item.state !== 'active' && h('button', { type: 'button', className: 'sv-outline-mini', disabled: Boolean(acting), onClick: () => { void setState(item, 'active') } }, '恢复'),
            ),
          ),
        )
      }
      const chip = (id, label) => h('button', { key: id, type: 'button', className: 'sv-filter-chip', 'data-on': filter === id ? 'true' : 'false', onClick: () => setFilter(id) }, label)
      return h(React.Fragment, null,
        h('div', { className: 'sv-drawer-head' },
          h('div', { className: 'sv-drawer-src' },
            h('span', { className: 'sv-glyph', style: { background: glyphFor({ platform: spec.platform }, spec.name).color } }, glyphFor({ platform: spec.platform }, spec.name).letter),
            h('div', { className: 'sv-drawer-srcbox' },
              h('h3', { className: 'sv-item-title' }, spec.name),
              h('p', { className: 'sv-source-detail' }, source ? `${source.enabled ? '自动采集在位' : '已停用'} · ${source.kind || ''}` : '来源未在位'),
            ),
            h('span', { className: `sv-tag ${statusClass}` }, statusText),
            source && h('button', { type: 'button', className: 'sv-primary-mini', disabled: Boolean(busy), onClick: () => ask({ title: '立即采集', copy: `从「${source.name}」立即采集一次？不影响自动采集计划。`, confirm: '采集', onConfirm: () => onCollect([source.id]) }) }, busy ? '采集中…' : '立即采集'),
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'sv-drawer-stats' },
            h('div', { className: 'sv-drawer-stat' }, h('strong', { 'data-tone': 'brand' }, all.filter(inToday).length), h('span', null, '今日新增')),
            h('div', { className: 'sv-drawer-stat' }, h('strong', null, activeCount), h('span', null, '活跃')),
            h('div', { className: 'sv-drawer-stat' }, h('strong', null, savedCount), h('span', null, '已收藏')),
            selection ? h('div', { className: 'sv-drawer-stat' }, h('strong', { 'data-tone': excludedCount ? 'alert' : undefined }, excludedCount), h('span', null, '本次排除')) : null,
          ),
        ),
        h('div', { className: 'sv-drawer-scroll' },
          selection && h('p', { className: 'sv-drawer-selhint' }, '取消勾选 = 本次生成不参与；「忽略」是跨选题的全局动作，可在信号模块恢复。'),
          h('div', { className: 'sv-drawer-tools' },
            chip('all', `全部 ${all.length}`),
            chip('today', `今日 ${all.filter(inToday).length}`),
            chip('saved', `已收藏 ${savedCount}`),
            chip('ignored', `已忽略 ${all.filter((item) => item.state === 'ignored').length}`),
            selection ? chip('excluded', `本次排除 ${excludedCount}`) : null,
            h('input', { className: 'sv-drawer-search', value: query, maxLength: 120, placeholder: '搜索标题 / 摘要', onChange: (event) => setQuery(event.target.value) }),
          ),
          h(Notice, { error: loadError }),
          signals === null && !loadError && h('div', { className: 'sv-empty' }, '正在读取信号…'),
          signals !== null && h(React.Fragment, null,
            h('p', { className: 'sv-group-title' }, `今日新增 ${todayItems.length}`),
            todayItems.length ? h('div', { className: 'sv-drawer-list' }, todayItems.map(row)) : h('div', { className: 'sv-empty' }, '今天暂无新信号。'),
            h('p', { className: 'sv-group-title', 'data-tone': 'muted' }, `更早 ${earlierItems.length}`),
            earlierItems.length ? h('div', { className: 'sv-drawer-list' }, earlierItems.map(row)) : null,
          ),
        ),
      )
    }

    function HeroMini({ cells }) {
      return h('section', { className: 'sv-heromini' }, cells.map((cell) => h('div', { key: cell.label, className: 'sv-heromini-cell' }, h('span', null, cell.label), h('strong', cell.tone ? { 'data-tone': cell.tone } : null, cell.value))));
    }
    // One task inspector for every module. It observes execution; closing it only
    // aborts read subscriptions and never controls the production task.
    let executionSelection = null;
    const executionListeners = new Set();
    function openExecution(request) { executionSelection = request; executionListeners.forEach((notify) => notify()); }
    function ExecutionButton({ kind, id, projectId, label = '执行详情' }) {
      return h('button', { type: 'button', className: 'lwb-plain-button sv-ex-open', onClick: () => openExecution({ kind, id, projectId }) }, label);
    }
    const EX_STATUS = { queued: '排队中', running: '进行中', completed: '已完成', succeeded: '已完成', success: '已完成', failed: '失败', cancelled: '已停止', skipped: '已跳过', unchanged: '复用快照' };
    const EX_PHASE = { preparing: '准备素材', directing: '视觉创作', preflight: '工程预检', rendering: '视频渲染', 'technical-qc': '技术质检', 'editorial-review': '独立审片', committing: '保存产物', completed: '完成', agent: '文案生成', covers: '封面生成', ready: '资料就绪' };
    const EX_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '参考资料' };
    const exLive = (value) => ['queued', 'running'].includes(value?.status) || ['queued', 'running'].includes(value?.record?.subtitle?.status);
    const exText = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const exJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
    function ExecutionText({ text, streaming = false }) { return h('div', { className: 'sv-ex-prose' }, h(MarkdownText, { text: String(text || ''), streaming, labels: EX_LABELS })); }
    function ExecutionData({ label, value, open = false }) {
      if (value == null || value === '') return null;
      return h('details', { className: 'sv-ex-disclosure', open }, h('summary', null, label), h('pre', { className: 'sv-ex-code' }, exText(value)));
    }
    const EX_FIELD = { name: '名称', positioning: '账号定位', audience: '目标受众', pillars: '内容方向', boundary: '内容边界', summary: '说明', mode: '执行模式', tier: '创作档位', instructions: '创作要求', prompt: '提示词', model: '模型', provider: '服务渠道', voiceId: '音色', rate: '语速', volume: '音量', outputFormat: '音频格式', orientation: '画幅', renderer: '制作方式', visualBrief: '画面要求', subtitleEnabled: '字幕', title: '标题', description: '发布描述', tags: '话题标签', hashtags: '话题标签', copy: '发布文案', temperature: '创作自由度', imageProvider: '封面服务', language: '语言', sourceId: '采集来源', reason: '触发方式', fetchedCount: '读取条数', filteredCount: '筛除条数', addedCount: '新增条数', duplicateCount: '重复条数', message: '采集说明', httpStatus: '响应状态', durationMs: '用时（毫秒）' };
    function ExecutionFields({ label, value }) {
      if (!value) return null;
      const entries = Object.entries(value).filter(([, item]) => item != null && item !== '' && (!Array.isArray(item) || item.length));
      const simple = entries.filter(([key, item]) => EX_FIELD[key] && (typeof item !== 'object' || Array.isArray(item) && item.every((part) => typeof part === 'string')));
      return h('section', { className: 'sv-ex-fields' }, h('h4', null, label), simple.length ? h('dl', null, simple.map(([key, item]) => h('div', { key }, h('dt', null, EX_FIELD[key]), h('dd', null, Array.isArray(item) ? item.join(' · ') : typeof item === 'boolean' ? item ? '开启' : '关闭' : String(item))))) : null, h(ExecutionData, { label: '完整记录', value }));
    }
    function ExecutionReport({ label, value }) {
      if (!value) return null;
      const issues = value.issues || value.failures || value.rewriteReasons || value.warnings || [];
      return h('article', { className: 'sv-ex-paper' }, h('div', { className: 'sv-ex-message-head' }, h('strong', null, label), Number.isFinite(value.qualityScore) ? h('span', { className: 'sv-ex-state', 'data-status': value.rewriteRequired ? 'failed' : 'succeeded' }, `${value.qualityScore} 分`) : typeof value.passed === 'boolean' ? h('span', { className: 'sv-ex-state', 'data-status': value.passed ? 'succeeded' : 'failed' }, value.passed ? '通过' : '未通过') : null), value.summary ? h(ExecutionText, { text: value.summary }) : null, issues.length ? h('ul', { className: 'sv-ex-issues' }, issues.map((item, index) => h('li', { key: index }, typeof item === 'string' ? item : item.message || item.description || exText(item)))) : null, h(ExecutionData, { label: '指标与完整证据', value }));
    }
    function executionChunks(blocks, chunk) {
      const next = blocks.slice(); const index = Number.isInteger(chunk.index) ? chunk.index : 0;
      const prev = next[index] || {};
      if (chunk.type === 'block-start') next[index] = { type: chunk.blockType, text: '', arguments: '' };
      else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') next[index] = { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: (prev.text || '') + chunk.text };
      else if (chunk.type === 'tool-call-delta') next[index] = { type: 'tool-call', name: chunk.name || prev.name, arguments: (prev.arguments || '') + (chunk.argumentsDelta || '') };
      else if (chunk.type === 'block-end') next[index] = chunk.block;
      return next;
    }
    // These are projections of durable DSH events, not generated process copy.
    function executionContext(source) {
      if (!source || source.kind === 'user') return null;
      const names = (items, key) => [...new Set((items || []).map((item) => item[key]).filter(Boolean))].join(', ');
      const label = source.kind === 'plugin' ? source.plugin : source.kind === 'skill-invocation' ? source.name : source.kind === 'agent-instructions' ? names(source.changes, 'path') : source.kind === 'session-reference' ? names(source.references, 'label') : source.kind;
      return { title: source.kind === 'session-reference' ? '上下文召回' : '上下文注入', label: label || source.kind || '未知来源' };
    }
    function executionPreview(text, streaming = false) {
      const lines = String(text || '').trim().split('\n');
      return (streaming ? lines.at(-1) : lines[0]).replaceAll('**', '');
    }
    function executionToolSummary(name, raw) {
      const args = typeof raw === 'string' ? exJson(raw) : raw;
      if (!args || typeof args !== 'object') return executionPreview(raw);
      if (name === 'structured_output') return executionPreview(args.summary || args.title || args.name || '提交本轮生成的结构化结果');
      const kind = String(name || '').toLowerCase();
      const keys = kind === 'bash' ? ['description', 'command'] : ['read', 'write', 'edit'].includes(kind) ? ['path', 'file_path', 'url'] : kind === 'search' ? ['query', 'pattern', 'url'] : ['description'];
      if (kind === 'search' && Array.isArray(args.queries)) return args.queries.filter((value) => typeof value === 'string').map((value) => executionPreview(value)).join(', ');
      const value = keys.map((key) => args[key]).find((value) => typeof value === 'string' && value) || Object.values(args).find((value) => typeof value === 'string' && value);
      return executionPreview(value);
    }
    function executionContent(event) {
      const data = event.data || {};
      return data.message?.content || data.content || (data.chunks || []).reduce(executionChunks, []);
    }
    function executionTurns(records) {
      const turns = []; let current;
      for (const { event } of records) {
        if (event.type === 'execution/omitted') continue;
        if (!current || event.type === 'turn/start' && current.events.length) {
          current = { key: event.seq, events: [] }; turns.push(current);
        }
        current.events.push(event);
      }
      return turns.map((turn) => {
        const calls = new Map(); const rows = [];
        const callKey = (event, id) => id == null ? null : `${event.data?.turn ?? ''}:${event.data?.step ?? ''}:${id}`;
        for (const event of turn.events) {
          if (event.type === 'tool/result') {
            const key = callKey(event, event.data?.message?.source?.callId);
            const call = key === null ? null : calls.get(key);
            if (call) { call.result = event; continue; }
          }
          const row = { event }; rows.push(row);
          if (event.type === 'tool/call') {
            const key = callKey(event, event.data?.callId);
            if (key !== null) calls.set(key, row);
          }
        }
        const end = turn.events.findLast((event) => event.type === 'turn/end');
        const lastAssistant = rows.findLast((row) => row.event.type === 'assistant/message');
        const blocks = lastAssistant ? executionContent(lastAssistant.event) : [];
        const hasFinal = Boolean(end && Array.isArray(blocks) && blocks.some((block) => block.type === 'text' && block.text) && !blocks.some((block) => block.type === 'tool-call') && !rows.some((row) => row.event.seq > lastAssistant.event.seq && row.event.type === 'tool/call'));
        let answer = null;
        if (hasFinal) {
          answer = { ...lastAssistant.event, data: { message: { content: blocks.filter((block) => block.type !== 'reasoning') } } };
          lastAssistant.event = { ...lastAssistant.event, data: { message: { content: blocks.filter((block) => block.type === 'reasoning') } } };
        }
        return { ...turn, rows, answer, ended: Boolean(end), contexts: turn.events.filter((event) => event.type === 'user/message' && executionContext(event.data?.source)).length, tools: turn.events.filter((event) => event.type === 'tool/call').length };
      });
    }
    function ExecutionProcessRow({ kind, title, preview, status, children }) {
      const icons = { context: 'M4 5h3m10 0h3v16H4V5Zm4-2h8v5H8V3Zm0 9h8m-8 4h6', reasoning: 'M9 18h6m-6 3h6M8 15a7 7 0 1 1 8 0l-1 3H9l-1-3Z', tool: 'm5 7 4 4-4 4m7 0h6M3 3h18v18H3V3Z', result: 'm5 12 4 4L19 6' };
      return h('details', { className: 'sv-ex-process-row', 'data-kind': kind },
        h('summary', null, h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: icons[kind] || icons.tool })), h('span', { className: 'sv-ex-row-title' }, title), preview ? h('span', { className: 'sv-ex-row-preview', title: preview }, preview) : null, status ? h('span', { className: 'sv-ex-row-status', 'data-error': status === '失败' || undefined }, status) : null),
        h('div', { className: 'sv-ex-row-body' }, children));
    }
    function ExecutionBlocks({ content, streaming = false }) {
      if (typeof content === 'string') return h(ExecutionText, { text: content, streaming });
      return (content || []).filter(Boolean).map((block, index) => {
        if (block.type === 'text') return h(ExecutionText, { key: index, text: block.text, streaming });
        if (block.type === 'reasoning') return block.text ? h(ExecutionProcessRow, { key: index, kind: 'reasoning', title: '思考', preview: executionPreview(block.text, streaming), status: streaming ? '输出中' : null }, h(ExecutionText, { text: block.text, streaming })) : null;
        if (block.type === 'tool-call' && streaming) return h(ExecutionProcessRow, { key: index, kind: 'tool', title: block.name === 'structured_output' ? '提交生成结果' : block.name || '工具调用', preview: executionToolSummary(block.name, block.arguments), status: '组织参数' }, h('pre', { className: 'sv-ex-code' }, exText(exJson(block.arguments) || block.arguments)));
        if (block.type === 'tool-result') return h(ExecutionBlocks, { key: index, content: block.content });
        if (['image', 'file', 'image-ref', 'file-ref'].includes(block.type)) return h('p', { key: index, className: 'sv-meta' }, `附件 · ${block.name || block.type}`);
        return null;
      });
    }
    function ExecutionEvent({ event, result, ended = false }) {
      const data = event.data || {};
      if (event.type === 'execution/omitted') return null;
      if (event.type === 'user/message') {
        const context = executionContext(data.source);
        if (context) return h(ExecutionProcessRow, { kind: 'context', title: context.title, preview: context.label }, h(ExecutionBlocks, { content: executionContent(event) }), h(ExecutionData, { label: '来源详情', value: data.source }));
        return h('details', { className: 'sv-ex-message sv-ex-input' }, h('summary', null, '任务输入', h('time', null, formatTime(event.time))), h(ExecutionBlocks, { content: executionContent(event) }));
      }
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        const content = executionContent(event);
        if (!Array.isArray(content)) return h(ExecutionText, { text: content });
        if (!content.some((block) => ['text', 'reasoning'].includes(block.type))) return null;
        return h('div', { className: 'sv-ex-assistant' }, event.type === 'assistant/attempt' ? h('p', { className: 'sv-meta' }, 'DSH · 未完成的输出') : null, h(ExecutionBlocks, { content }));
      }
      if (event.type === 'tool/call' || event.type === 'tool/result') {
        const output = event.type === 'tool/result' ? event : result;
        const failed = output && (output.data?.error || output.data?.message?.isError || output.data?.message?.content?.some((block) => block.isError));
        return h(ExecutionProcessRow, { kind: 'tool', title: event.type === 'tool/result' ? '工具返回' : data.name === 'structured_output' ? '提交生成结果' : data.name === 'bash' ? 'Bash' : data.name || '工具调用', preview: event.type === 'tool/call' ? executionToolSummary(data.name, data.arguments) : '', status: output ? failed ? '失败' : '完成' : ended ? '未记录返回' : '执行中' },
          event.type === 'tool/call' ? h(ExecutionData, { label: data.name === 'structured_output' ? '结构化结果' : '调用参数', value: exJson(data.arguments) ?? data.arguments, open: true }) : null,
          output ? h('div', { className: 'sv-ex-tool-output' }, h('strong', null, failed ? '工具返回 · 异常' : '工具返回'), h(ExecutionBlocks, { content: executionContent(output) }), output.data?.error ? h(ExecutionData, { label: '错误详情', value: output.data.error, open: true }) : null, h(ExecutionData, { label: '完整返回', value: output.data })) : null);
      }
      const labels = { 'step/start': '请求模型', 'turn/start': '开始执行', 'turn/end': data.reason?.kind === 'completed' ? 'DSH 执行完成' : `本轮结束 · ${data.reason?.kind || '未知原因'}`, 'llm/retry-started': '模型请求重试', 'llm/retry': '重试结束', 'approval/asked': '等待授权', 'approval/decided': '已收到授权决定' };
      return labels[event.type] ? h('div', { className: 'sv-ex-marker' }, h('i'), h('span', null, labels[event.type]), h('time', null, formatTime(event.time))) : null;
    }
    function ExecutionTranscript({ records, partial }) {
      const turns = executionTurns(records);
      if (!turns.length && partial) turns.push({ key: 'live', rows: [], contexts: 0, tools: 0 });
      return turns.map((turn, index) => h('div', { key: turn.key, className: 'sv-ex-turn' },
        h('details', { className: 'sv-ex-process', open: true }, h('summary', null, h('span', null, turn.ended ? '执行过程' : '本轮执行过程'), h('span', { className: 'sv-ex-process-counts' }, [turn.contexts ? `${turn.contexts} 项上下文` : '', turn.tools ? `${turn.tools} 次工具调用` : ''].filter(Boolean).join(' · '))),
          h('div', { className: 'sv-ex-process-body' }, turn.rows.map((row) => h(ExecutionEvent, { key: row.event.seq, ...row, ended: turn.ended })), index === turns.length - 1 && partial ? h('div', { className: 'sv-ex-assistant', 'aria-label': '正在输出' }, h(ExecutionBlocks, { content: partial.blocks, streaming: true })) : null)),
        turn.answer ? h('article', { className: 'sv-ex-message' }, h('div', { className: 'sv-ex-message-head' }, h('strong', null, 'DSH · 结果输出'), h('time', null, formatTime(turn.answer.time))), h(ExecutionBlocks, { content: executionContent(turn.answer) })) : null));
    }
    function ExecutionSession({ request, session }) {
      const [state, setState] = React.useState({ records: [], hasMore: false, cursor: -1, partial: null });
      const [error, setError] = React.useState(null); const [retry, setRetry] = React.useState(0); const [loading, setLoading] = React.useState(true);
      const [olderBusy, setOlderBusy] = React.useState(false);
      const currentRef = React.useRef(state);
      const sessionRequest = { ...request, role: session.role };
      React.useEffect(() => {
        const controller = new AbortController(); let timer; let stopped = false; let subscription;
        let current = { records: [], hasMore: false, cursor: -1, partial: null }; currentRef.current = current;
        const publish = () => { if (!timer) timer = setTimeout(() => { timer = null; if (!stopped) setState({ ...current }); }, 80); };
        const run = async () => {
          setLoading(true); setError(null);
          try {
            if (!executionRemote) throw new Error('会话连接正在准备，请稍后重试。');
            subscription = executionStreams.$stream({ name: 'spoken-video execution', open: (signal) => executionRemote.followExecution(sessionRequest, signal), ended: () => new Error('会话订阅已结束，可重新连接读取记录。'), carrierFailed: () => { if (!stopped) setError('连接中断，正在恢复会话…'); } });
            for await (const delivery of subscription) {
              const frame = delivery.value;
              if (stopped) break;
              if (frame.type === 'snapshot') {
                delivery.accept(); setError(null);
                const active = frame.assistantStream?.activeAttempt;
                current = { records: frame.records || [], cursor: frame.cursor, hasMore: frame.hasMore, partial: active ? { id: active.attemptId, nextIndex: active.nextIndex, blocks: (active.chunks || []).reduce(executionChunks, []) } : null };
                currentRef.current = current; setState({ ...current }); setLoading(false);
              } else if (frame.type === 'event') {
                current.records = [...current.records.filter((item) => item.event.seq !== frame.event.seq), frame];
                current.cursor = Math.max(current.cursor, frame.event.seq);
                if (['assistant/message', 'assistant/attempt'].includes(frame.event.type)) current.partial = null;
              } else if (frame.type === 'assistant-stream') {
                const item = frame.frame;
                if (item.type === 'start') current.partial = { id: item.attemptId, nextIndex: 0, blocks: [] };
                else if (item.type === 'chunk' && current.partial?.id === item.attemptId) {
                  if (item.index > current.partial.nextIndex) throw new Error('实时内容连接发生间断，请重新连接以恢复完整记录。');
                  if (item.index === current.partial.nextIndex) current.partial = { ...current.partial, nextIndex: item.index + 1, blocks: executionChunks(current.partial.blocks, item.chunk) };
                } else if (item.type === 'end' && current.partial?.id === item.attemptId && (item.outcome?.kind === 'abandoned' || current.records.some((record) => record.event.seq === item.outcome?.seq))) current.partial = null;
              }
              publish();
            }
          } catch (cause) { if (!stopped) { setError(cause.message || '会话记录暂不可用。'); setLoading(false); } }
        };
        void run();
        return () => { stopped = true; controller.abort(); void subscription?.dispose(); clearTimeout(timer); };
      }, [request.kind, request.id, request.projectId, session.childSessionId, retry]);
      const older = async () => {
        setOlderBusy(true);
        try {
          const page = await remoteStatic('executionPage', { ...sessionRequest, throughSeq: state.cursor, beforeSeq: state.records[0]?.event.seq });
          const current = currentRef.current;
          current.records = [...page.records, ...current.records].filter((item, index, items) => items.findIndex((other) => other.event.seq === item.event.seq) === index).sort((a, b) => a.event.seq - b.event.seq); current.hasMore = page.hasMore; setState({ ...current });
        } catch (cause) { setError(cause.message); } finally { setOlderBusy(false); }
      };
      return h('section', { className: 'sv-ex-session' },
        h('div', { className: 'sv-ex-section-head' }, h('span', { className: 'sv-ex-avatar' }, 'D'), h('div', null, h('strong', null, session.label || 'DSH 执行'), h('p', null, '原生会话 · 实时内容与历史记录'))),
        loading ? h('p', { className: 'sv-ex-empty' }, '正在读取会话…') : null,
        error ? h('div', { className: 'sv-ex-alert' }, h('p', null, error), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setRetry((value) => value + 1) }, '重新连接')) : null,
        state.hasMore ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: olderBusy, onClick: older }, olderBusy ? '正在读取…' : '加载更早内容') : null,
        h(ExecutionTranscript, { records: state.records, partial: state.partial }),
        !loading && !error && !state.records.length && !state.partial ? h('p', { className: 'sv-ex-empty' }, '会话已建立，等待第一条执行内容。') : null,
      );
    }
    function ExecutionAsset({ request, asset }) {
      const [value, setValue] = React.useState(null); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState(null);
      const [url, setUrl] = React.useState(null);
      React.useEffect(() => {
        if (!value?.data) return;
        const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
        const next = URL.createObjectURL(new Blob([bytes], { type: value.mediaType })); setUrl(next);
        return () => URL.revokeObjectURL(next);
      }, [value]);
      const read = async () => { setBusy(true); setError(null); try { setValue(await remoteStatic('executionAsset', { ...request, assetId: asset.id })); } catch (cause) { setError(cause.message); } finally { setBusy(false); } };
      return h('article', { className: 'sv-ex-asset' }, h('div', { className: 'sv-ex-message-head' }, h('strong', null, asset.label), !value ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: read }, busy ? '正在加载…' : asset.type === 'text' ? '查看内容' : '预览') : null),
        url ? asset.type === 'image' ? h('img', { src: url, alt: asset.label }) : h(asset.type === 'video' ? 'video' : 'audio', { src: url, controls: true, preload: 'metadata' }) : null,
        value?.text != null ? h('pre', { className: 'sv-ex-code' }, value.text) : null,
        error ? h('p', { className: 'sv-error' }, error) : null);
    }
    function ExecutionResults({ detail, request }) {
      const record = detail.record;
      const packageResult = record.result?.content ? record.result : record.result?.artifact?.data;
      const draft = record.draft;
      const subtitle = record.subtitle?.current || (record.type === 'subtitles' ? record.result?.artifact?.data || record.result : null);
      return h('div', { className: 'sv-ex-results' },
        record.candidates?.map((item, index) => h('article', { key: item.id || index, className: 'sv-ex-candidate' }, h('div', { className: 'sv-ex-message-head' }, h('span', { className: 'sv-ex-number' }, String(index + 1).padStart(2, '0')), index === 0 ? h('span', { className: 'sv-tag' }, '推荐选题') : null, h('span', { className: 'sv-meta' }, item.selection?.state === 'selected' ? '已加入待写稿' : '候选')), h('h3', null, item.title), h(ExecutionText, { text: item.contentCore }), h('p', { className: 'sv-meta' }, item.angle), item.whyNow ? h('p', { className: 'sv-ex-why' }, `为什么现在做 · ${item.whyNow}`) : null, h(ExecutionData, { label: '引用信号', value: (record.materialSnapshot || []).filter((signal) => item.signalIds?.includes(signal.id)) }))),
        draft ? h('article', { className: 'sv-ex-paper' }, h('span', { className: 'sv-ex-kicker' }, record.appliedAt ? `已保存 · 稿件版本 ${record.scriptRevision || '—'}` : '本次生成稿件'), h('h3', null, draft.title || detail.title), h(ExecutionText, { text: draft.script }), h(ExecutionData, { label: '核实提示与生成说明', value: Object.fromEntries(Object.entries(draft).filter(([key]) => !['script', 'title', 'suggestedTitle'].includes(key))) })) : null,
        packageResult ? h('article', { className: 'sv-ex-paper' }, h('h3', null, packageResult.content?.title || '发布资料'), h(ExecutionText, { text: packageResult.content?.copy }), h(ExecutionFields, { label: '描述与标签', value: packageResult.content }), h(ExecutionData, { label: '封面提示词', value: packageResult.prompts })) : null,
        record.suggestion ? h(ExecutionFields, { label: '账号定位建议', value: { ...record.suggestion.suggestion, summary: record.suggestion.summary } }) : null,
        subtitle?.srt ? h('article', { className: 'sv-ex-paper' }, h('h3', null, `时间轴字幕 · ${subtitle.cueCount || 0} 条`), h('pre', { className: 'sv-ex-code' }, subtitle.srt), h(ExecutionData, { label: '识别诊断', value: subtitle.diagnostics }), h(ExecutionData, { label: '字幕历史版本', value: record.subtitle?.history })) : null,
        h(ExecutionReport, { label: '稿件质量报告', value: record.quality }),
        h(ExecutionReport, { label: '技术质检', value: record.pipeline?.technical || record.result?.qc?.technical || record.result?.technical }),
        h(ExecutionReport, { label: '独立审片结论与证据', value: record.pipeline?.review || record.result?.qc?.review }),
        detail.assets.length ? h('div', { className: 'sv-ex-assets' }, detail.assets.map((asset) => h(ExecutionAsset, { key: asset.file, asset, request }))) : null,
        record.projectSync ? h('p', { className: 'sv-note' }, `已同步到项目版本 ${record.projectSync.revision}`) : detail.kind === 'audio' && record.status === 'succeeded' ? h('p', { className: 'sv-note' }, record.source?.projectId ? record.projectSyncError || '音频已生成；尚未同步为项目当前配音。' : '独立音频任务，未关联项目。') : null,
        detail.kind === 'source' ? h(ExecutionFields, { label: '采集结果', value: record }) : null,
        record.subtitleSyncError ? h('p', { className: 'sv-note' }, record.subtitleSyncError) : null,
        record.coverErrors && Object.keys(record.coverErrors).length ? h(ExecutionData, { label: '部分封面生成失败', value: record.coverErrors, open: true }) : null,
        h(ExecutionData, { label: '完整结果记录', value: record.result }),
        detail.kind !== 'source' && !draft && !record.candidates?.length && !record.result && !record.suggestion && !detail.assets.length ? h('p', { className: 'sv-ex-empty' }, exLive(detail) ? '产物生成后会在这里展示。' : '这条历史记录没有保存可展示的产物。') : null,
      );
    }
    function ExecutionProcess({ detail, request }) {
      const record = detail.record;
      const events = record.executionEvents || [];
      const steps = record.steps || Object.entries(record.pipeline?.stages || {}).map(([id, value]) => ({ id, label: EX_PHASE[id] || id, ...value }));
      return h('div', { className: 'sv-ex-process' },
        steps.length ? h('div', { className: 'sv-ex-steps' }, steps.map((step) => h('div', { key: step.id, 'data-status': step.status }, h('i'), h('strong', null, step.label), h('span', null, step.detail || EX_STATUS[step.status] || ({ done: '完成', pending: '待执行', error: '失败' })[step.status] || step.status)))) : null,
        events.length ? h('section', { className: 'sv-ex-timeline' }, h('h4', null, '执行记录'), events.map((event) => h('div', { key: event.id, className: 'sv-ex-timeline-row', 'data-status': event.status }, h('i'), h('div', null, h('div', { className: 'sv-ex-message-head' }, h('strong', null, event.label), h('time', null, formatTime(event.at))), h('span', { className: 'sv-ex-actor' }, event.actor), event.detail ? h(ExecutionData, { label: '详情', value: event.detail }) : null)))) : null,
        detail.sessions.map((session) => h(ExecutionSession, { key: session.childSessionId, session, request })),
        !detail.sessions.length ? h('p', { className: 'sv-ex-empty' }, exLive(detail) && ['topic', 'script', 'account'].includes(detail.kind) ? '任务已提交，等待 DSH 会话建立。' : detail.kind === 'publish' && !record.coverKind && exLive(detail) ? '发布文案任务正在准备。' : events.length ? '以上为服务与本地处理的实际执行记录。' : '该任务未保存详细过程；可查看已记录的输入、状态和产物。') : null,
        record.subtitle?.error ? h('p', { className: 'sv-ex-alert' }, `字幕生成失败：${mediaErrorText(record.subtitle.error)}`) : null,
        record.dsh?.events?.length ? h(ExecutionData, { label: '简要事件记录', value: record.dsh.events }) : null,
      );
    }
    function ExecutionDrawer({ request, onClose }) {
      const [detail, setDetail] = React.useState(null); const [error, setError] = React.useState(null); const [tab, setTab] = React.useState(null);
      const [wide, setWide] = React.useState(false); const [refresh, setRefresh] = React.useState(0); const root = React.useRef(null); const modal = React.useRef(null);
      React.useEffect(() => {
        let active = true; let timer; let settled = 0; let failures = 0;
        const load = async () => {
          try {
            const value = await remoteStatic('executionDetail', request);
            settled = exLive(value) ? 0 : settled + 1; failures = 0;
            if (active) { setDetail(value); setError(null); setTab((current) => current || (exLive(value) || value.status === 'failed' ? 'process' : 'results')); }
          } catch (cause) { failures += 1; if (active) setError(cause.message); }
          if (active && settled < 3 && failures < 3) timer = setTimeout(load, failures ? 3500 : 1800);
        };
        void load();
        return () => { active = false; clearTimeout(timer); };
      }, [request.kind, request.id, request.projectId, refresh]);
      React.useEffect(() => {
        const previous = document.activeElement; modal.current?.showModal(); root.current?.focus();
        const key = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key === 'Tab') {
            const nodes = [...(root.current?.querySelectorAll('button:not(:disabled), a[href], summary, [tabindex="0"]') || [])].filter((node) => node.getClientRects().length);
            if (!nodes.length) return;
            if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === root.current)) { event.preventDefault(); nodes.at(-1).focus(); }
            else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
          }
        };
        document.addEventListener('keydown', key, true);
        return () => { document.removeEventListener('keydown', key, true); modal.current?.close(); if (previous?.isConnected) previous.focus(); };
      }, []);
      const record = detail?.record || {};
      const actor = detail?.sessions.length ? (['topic', 'script', 'account'].includes(detail.kind) ? 'DSH 会话' : 'DSH · 服务与本地处理') : request.kind === 'audio' ? '配音 / 字幕服务' : request.kind === 'publish' && record.coverKind ? '封面生图服务' : request.kind === 'source' ? '来源采集程序' : '任务执行';
      return h('dialog', { ref: modal, className: 'sv-ex-layer', 'aria-label': '执行详情', onCancel: (event) => { event.preventDefault(); onClose(); } }, h('button', { className: 'sv-ex-backdrop', type: 'button', 'aria-label': '关闭执行详情', onClick: onClose }),
        h('aside', { ref: root, tabIndex: -1, className: 'sv-ex-drawer', 'data-wide': wide },
          h('header', { className: 'sv-ex-header' }, h('div', null, h('p', { className: 'sv-ex-kicker' }, `${detail?.moduleLabel || '任务'} / 执行详情`), h('h2', null, detail?.title || '正在读取…'), h('p', { className: 'sv-ex-subtitle' }, detail ? `${formatTime(detail.createdAt)} · ${actor}` : '读取任务与会话关联')),
            h('div', { className: 'sv-ex-header-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setWide((value) => !value), 'aria-label': wide ? '收起宽屏' : '展开宽屏' }, wide ? '收起' : '展开'), h('button', { type: 'button', className: 'lwb-plain-button', onClick: onClose }, '关闭'))),
          h('div', { className: 'sv-ex-toolbar' }, h('div', { role: 'tablist', 'aria-label': '执行详情视图', className: 'sv-ex-tabs' }, [['overview', '执行概览'], ['process', '执行过程'], ['results', '结果产物']].map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, label))), h('span', { className: 'sv-ex-state', 'data-status': detail?.status, role: 'status' }, EX_STATUS[detail?.status] || '读取中')),
          h('div', { key: tab, className: 'sv-ex-body', role: 'tabpanel' }, error ? h('div', { className: 'sv-ex-alert' }, h('p', null, error), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setRefresh((value) => value + 1) }, '重新读取')) : null,
            detail?.record.error ? h('div', { className: 'sv-ex-alert' }, h('strong', null, '执行未完成'), h('p', null, ['audio', 'media'].includes(request.kind) ? mediaErrorText(detail.record.error) : detail.record.error)) : null,
            detail && tab === 'overview' ? h(React.Fragment, null,
              h('div', { className: 'sv-ex-metrics' }, h('div', null, h('span', null, '执行状态'), h('strong', null, EX_STATUS[detail.status] || detail.status)), h('div', null, h('span', null, 'DSH 会话'), h('strong', null, detail.sessions.length ? `${detail.sessions.length} 个` : '无')), h('div', null, h('span', null, '用时'), h('strong', null, detail.completedAt && detail.createdAt ? `${Math.max(0, Math.round((Date.parse(detail.completedAt) - Date.parse(detail.createdAt)) / 1000))} 秒` : exLive(detail) ? '执行中' : '—'))),
              h(ExecutionFields, { label: '任务输入与配置', value: record.input || { mode: record.mode, tier: record.tier, instructions: record.instructions, prompt: record.prompt, imageProvider: record.imageProvider } }),
              h(ExecutionData, { label: '账号定位快照', value: record.account }),
              h(ExecutionData, { label: '输入稿件与素材快照', value: record.source || record.sourceSnapshot }),
              h(ExecutionData, { label: `参与信号 · ${record.materialSnapshot?.length || 0} 条`, value: record.materialSnapshot }),
              h(ExecutionData, { label: '来源批次', value: record.materialBatches }),
              record.unavailableSources?.length ? h(ExecutionData, { label: '未获得当天数据的来源', value: record.unavailableSources, open: true }) : null,
              request.kind === 'source' ? h(ExecutionData, { label: '采集结果', value: record, open: true }) : null,
              h('p', { className: 'sv-ex-footnote' }, '这里展示本次任务记录的版本与内容；后续编辑不会改写 DSH 原始会话。')) : null,
            detail && tab === 'process' ? h(ExecutionProcess, { detail, request }) : null,
            detail && tab === 'results' ? h(ExecutionResults, { detail, request }) : null),
          h('footer', { className: 'sv-ex-footer' }, h('span', null, exLive(detail) ? '实时更新 · 关闭面板不影响执行' : '历史记录 · 只读查看'), h('span', null, record.expectedRevision ? `输入项目版本 ${record.expectedRevision}` : ''))));
    }
    function ExecutionPortal() {
      const request = React.useSyncExternalStore((notify) => { executionListeners.add(notify); return () => executionListeners.delete(notify); }, () => executionSelection);
      React.useEffect(() => () => { executionSelection = null; }, []);
      return request ? h(ExecutionDrawer, { key: `${request.kind}:${request.id}`, request, onClose: () => openExecution(null) }) : null;
    }
    function ExecutionHistory({ kind, projectId, refreshKey }) {
      const [items, setItems] = React.useState([]); const [error, setError] = React.useState(null); const [retry, setRetry] = React.useState(0);
      React.useEffect(() => { let active = true; void remoteStatic('executionList', { kind, projectId }).then((value) => { if (active) { setItems(value); setError(null); } }).catch((cause) => { if (active) setError(cause.message); }); return () => { active = false; }; }, [kind, projectId, refreshKey, retry]);
      if (error) return h('div', { className: 'sv-ex-alert' }, h('p', null, `执行历史读取失败：${error}`), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setRetry((value) => value + 1) }, '重新读取'));
      return items.length ? h('details', { className: 'sv-ex-disclosure' }, h('summary', null, `执行历史 · ${items.length} 次`), h('div', { className: 'sv-ex-history' }, items.map((item) => h('button', { key: item.id, type: 'button', onClick: () => openExecution({ kind, id: item.id, projectId }) }, h('span', null, formatTime(item.createdAt)), h('strong', null, EX_STATUS[item.status] || item.status), h('span', null, '查看详情 →'))))) : null;
    }

    function PackFrame({ packId, openConversation, title, copy, className, intro = true, hero, accent, introActions, children }) {
      if (!packId) return h(NeedPack, { openConversation });
      return h('div', { className: `sv-page${className ? ` ${className}` : ''}`, ...(accent ? { 'data-accent': accent } : {}) },
        intro && h(Intro, { title, copy, actions: introActions }),
        hero,
        children,
        h(ExecutionPortal),
      );
    }
    function SignalsPage({ packId, openConversation }) {
      const [board, setBoard] = React.useState(null)
      const [sources, setSources] = React.useState([])
      const [runs, setRuns] = React.useState([])
      const [view, setView] = React.useState('board')
      const [adminTab, setAdminTab] = React.useState('sources')
      const [drawer, setDrawer] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [confirmNode, ask] = useSvConfirm()

      const refresh = React.useCallback(async () => {
        if (!packId) return
        try {
          const [nextBoard, nextSources, nextRuns] = await Promise.all([
            remote(packId, 'board'),
            remote(packId, 'sources'),
            remote(packId, 'sourceRuns'),
          ])
          setBoard(nextBoard)
          setSources(nextSources)
          setRuns(nextRuns)
          setError(null)
        } catch (cause) { setError(cause.message) }
      }, [packId])

      React.useEffect(() => { void refresh() }, [refresh])

      if (!packId) return h(NeedPack, { openConversation })

      const closeDrawer = () => setDrawer(null)
      const invoke = async (method, request, marker) => {
        setBusy(marker)
        try { await remote(packId, method, request); await refresh() } catch (cause) { setError(cause.message) } finally { setBusy(null) }
      }
      const collect = (ids, marker) => { void invoke('collectSources', { ...(ids ? { sourceIds: ids } : {}) }, marker) }
      const openSignalDrawer = (spec) => setDrawer({ kind: 'signals', ...spec })

      const totals = board?.totals
      const boardSources = (board?.sources || []).filter((card) => card.id !== 'ai-daily-import')
      const families = [...new Set([...FAMILY_ORDER, ...boardSources.map((card) => card.family)])].filter((family) => boardSources.some((card) => card.family === family))
      const boardStatus = (card) => {
        if (!card.enabled) return ['已停用', 'sv-status-disabled']
        if (card.status === 'error') return ['异常', 'sv-status-error']
        if (card.status === 'ready') return ['正常', 'sv-status-ready']
        return ['未采集', 'sv-status-disabled']
      }
      const previewList = (card) => h('ol', { className: 'sv-board-preview' }, card.preview.length ? card.preview.map((item) => h('li', { key: item.id }, `${item.rank ? `#${item.rank} ` : ''}${item.title}`, item.hotValue ? h('small', null, ` · ${formatHot(item.hotValue)}`) : null)) : [h('li', { key: 'empty' }, '暂无信号')])
      const sourceCard = (card) => {
        const [status, statusClass] = boardStatus(card)
        const health = card.status === 'error' ? 'error' : 'ok'
        return h('article', { key: card.id, className: 'sv-board-card', 'data-health': health },
          h('button', { type: 'button', className: 'sv-board-card-main', onClick: () => openSignalDrawer({ sourceId: card.id, platform: null, name: card.name }) },
            h('div', { className: 'sv-item-head' }, h('strong', null, card.name), h('span', { className: `sv-tag ${statusClass}` }, status)),
            h('p', { className: 'sv-board-today' }, `今日新增 ${card.todayCount} · 活跃 ${card.activeCount}`),
            card.lastError ? h('p', { className: 'sv-source-detail', style: { color: '#a94343' } }, card.lastError) : h('p', { className: 'sv-board-meta' }, `${card.previewScope === 'today' ? '今日 Top' : '最近信号'} · 最近采集 ${relativeTime(card.lastAttemptAt || card.lastSuccessAt)}`),
            previewList(card),
          ),
          h('div', { className: 'sv-board-card-foot' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => ask({ title: '立即采集', copy: `从「${card.name}」立即采集一次？不影响自动采集计划。`, confirm: '采集', onConfirm: () => collect([card.id], `collect:${card.id}`) }) }, busy === `collect:${card.id}` ? '采集中…' : '采集')),
        )
      }
      const platformCard = (card) => {
        const freshClass = { fresh: 'sv-status-ready', recent: 'sv-status-manual', stale: 'sv-status-disabled', none: 'sv-status-disabled' }[card.freshness] || 'sv-status-disabled'
        return h('article', { key: card.platform, className: 'sv-board-card', 'data-empty': card.totalCount ? undefined : 'true' },
          card.totalCount
            ? h('button', { type: 'button', className: 'sv-board-card-main', onClick: () => openSignalDrawer({ sourceId: 'ai-daily-import', platform: card.platform, name: `AI 内容日报 · ${card.platform}` }) },
              h('div', { className: 'sv-item-head' }, h('strong', null, `AI 内容日报 · ${card.platform}`), h('span', { className: `sv-tag ${freshClass}` }, FRESH_LABEL[card.freshness] || card.freshness)),
              h('p', { className: 'sv-board-today' }, `今日新增 ${card.todayCount} · 累计 ${card.totalCount}`),
              h('p', { className: 'sv-board-meta' }, `最近更新 ${relativeTime(card.lastImportedAt)}`),
              previewList(card),
            )
            : h('div', { className: 'sv-board-card-main' },
              h('div', { className: 'sv-item-head' }, h('strong', null, `AI 内容日报 · ${card.platform}`), h('span', { className: `sv-tag ${freshClass}` }, FRESH_LABEL[card.freshness] || card.freshness)),
              h('p', { className: 'sv-board-meta' }, '今日暂无数据 · 采集服务每 60 分钟自动拉取'),
            ),
        )
      }
      const boardView = board && h('section', { className: 'sv-board' },
        families.map((family) => h('section', { key: family, className: 'sv-board-group' },
          h('div', { className: 'sv-section-head' }, h('h3', null, family), h('span', null, `${boardSources.filter((card) => card.family === family).length} 个来源 · 自动采集`)),
          h('div', { className: 'sv-board-grid' }, boardSources.filter((card) => card.family === family).map(sourceCard)),
        )),
        h('section', { className: 'sv-board-group' },
          h('div', { className: 'sv-section-head' }, h('h3', null, 'AI 内容日报'), h('span', null, `报告导入 · 覆盖 ${board.aiDaily.platforms.length} 个平台 · 每 60 分钟自动拉取`)),
          h('div', { className: 'sv-board-grid' }, board.aiDaily.platforms.map(platformCard)),
        ),
      )

      const renderSourceCard = (source) => {
        const [status, statusClass] = sourceStatus(source)
        const isDaily = source.id === 'ai-daily-import'
        return h('article', { key: source.id, className: 'sv-source-compact' },
          h('div', { className: 'sv-item-head' }, h('strong', null, source.name), h('span', { className: `sv-tag ${statusClass}` }, status)),
          h('p', { className: 'sv-source-detail' }, isDaily ? '报告导入 · 覆盖：抖音 / B站 / 公众号 / 小红书 / 视频号' : `${source.enabled ? `每 ${source.intervalMinutes} 分钟自动采集` : '已停用'}`),
          h('p', { className: 'sv-source-detail' }, sourceActivity(source)),
          source.health?.lastError && h('p', { className: 'sv-source-detail', style: { color: '#a94343' } }, source.health.lastError),
          h('div', { className: 'sv-actions' },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => ask({ title: '立即采集', copy: `从「${source.name}」立即采集一次？不影响自动采集计划。`, confirm: '采集', onConfirm: () => collect([source.id], `collect:${source.id}`) }) }, busy === `collect:${source.id}` ? '采集中…' : '采集'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => ask({ title: source.enabled ? '停用来源' : '启用来源', copy: `${source.enabled ? '停用' : '启用'}「${source.name}」的自动采集？`, confirm: source.enabled ? '停用' : '启用', danger: source.enabled, onConfirm: () => { void invoke('setSourceEnabled', { sourceId: source.id, enabled: !source.enabled }, `toggle:${source.id}`) } }) }, source.enabled ? '停用' : '启用'),
          ),
        )
      }
      const runItems = runs.slice(0, 20).map((run) => h('article', { key: run.id, className: 'sv-item' },
        h('div', { className: 'sv-item-head' },
          h('strong', null, sourceLabel(sources, run.sourceId)),
          h('span', { className: `sv-tag ${run.status === 'failed' ? 'sv-status-error' : run.status === 'skipped' ? 'sv-status-disabled' : ''}` }, run.status === 'success' ? '成功' : run.status === 'skipped' ? '未变化' : '失败'),
        ),
        h('p', { className: 'sv-meta' }, `${run.message} · ${formatTime(run.completedAt)}`),
        h('p', { className: 'sv-source-detail' }, `读取 ${run.fetchedCount} · 过滤 ${run.filteredCount} · 新增 ${run.addedCount} · 去重 ${run.duplicateCount} · ${run.durationMs} ms`),
        h(ExecutionButton, { kind: 'source', id: run.id }),
      ))
      const adminFamilies = [...new Set(sources.map((source) => source.family || '其他'))]
      const sourcesView = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' },
          h('div', null, h('h3', null, '来源库'), h('p', { className: 'sv-meta' }, '产品内置的信号来源目录：可立即采集或停用，不提供增删与参数配置。')),
        ),
        h('div', { className: 'sv-source-table' }, adminFamilies.map((family) => {
          const familySources = sources.filter((source) => source.family === family)
          return h('section', { key: family, className: 'sv-family-section' },
            h('div', { className: 'sv-section-head' }, h('h3', null, family), h('span', null, `${familySources.length} 个来源`)),
            h('div', { className: 'sv-source-compact-grid' }, familySources.map(renderSourceCard)),
          )
        })),
      )
      const runsView = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '采集记录'), h('span', null, '成功、未变化和失败均保留')),
        runs.length ? h('div', { className: 'sv-list sv-run-list' }, runItems) : h('div', { className: 'sv-empty' }, '尚未执行采集。'),
      )
      const adminView = h(React.Fragment, null,
        h('nav', { className: 'sv-tabs', 'aria-label': '来源管理视图' }, [['sources', '来源库'], ['runs', '采集记录']].map(([id, label]) => h('button', { key: id, type: 'button', className: 'sv-tab', 'data-active': adminTab === id ? 'true' : 'false', onClick: () => setAdminTab(id) }, label))),
        adminTab === 'sources' && sourcesView,
        adminTab === 'runs' && runsView,
      )

      const cmdBar = h('section', { className: 'sv-cmdbar', 'aria-label': '信号池概览' },
        h('div', { className: 'sv-cmd-title' },
          h('p', { className: 'sv-cmd-kicker' }, h('span', { className: 'sv-module-dot', style: { background: '#3b82f6' } }), '内容情报'),
          h('h2', null, '信号板'),
        ),
        h('span', { className: 'sv-live-pill' }, h('span', { className: 'sv-live-dot' }), busy ? '正在采集…' : '采集服务待命'),
        h('span', { className: 'sv-cmd-sep' }),
        h('div', { className: 'sv-cmd-stats' },
          h('div', { className: 'sv-cmd-stat' }, h('span', null, '今日新增'), h('strong', { 'data-tone': 'brand' }, totals?.todayNew ?? '—')),
          h('div', { className: 'sv-cmd-stat' }, h('span', null, '已采集来源'), h('strong', null, `${totals?.collectedToday ?? 0}/${totals?.collectableSources ?? 0}`)),
          h('div', { className: 'sv-cmd-stat' }, h('span', null, '异常来源'), h('strong', { 'data-tone': totals?.errorSources ? 'alert' : 'ok' }, totals?.errorSources ?? '—')),
          h('div', { className: 'sv-cmd-stat' }, h('span', null, '最近采集'), h('strong', { 'data-tone': 'time' }, totals ? relativeTime(totals.lastCollectAt) : '—')),
        ),
        h('div', { className: 'sv-cmd-actions' },
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy), onClick: () => ask({ title: '全量采集', copy: `立即采集全部 ${totals?.collectableSources ?? 0} 个来源？可能需要数十秒。`, confirm: '采集', onConfirm: () => collect(null, 'collect-all') }) }, busy === 'collect-all' ? '正在采集…' : `采集 ${totals?.collectableSources ?? 0} 个来源`),
          h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setView(view === 'board' ? 'admin' : 'board') }, view === 'board' ? '来源管理' : '返回信号板'),
        ),
      )

      const drawerView = drawer && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: closeDrawer }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': drawer.name },
          h(SignalDrawerBody, { packId, sources, spec: drawer, today: board?.today, busy, onClose: closeDrawer, onCollect: (ids) => collect(ids, `collect:${ids[0]}`), onChanged: () => { void refresh() }, ask }),
        ),
      )

      return h(PackFrame, { packId, openConversation, className: 'sv-signal-shell', intro: false, hero: cmdBar },
        board && totals.todayNew === 0 && view === 'board' && h('p', { className: 'sv-note' }, '今天暂无新信号，卡片展示最近一次采集的信号；可点击“采集”获取最新内容。'),
        h(Notice, { error }),
        h('nav', { className: 'sv-tabs', 'aria-label': '信号工作台视图' }, [['board', '信号板'], ['admin', '来源管理']].map(([id, label]) => h('button', { key: id, type: 'button', className: 'sv-tab', 'data-active': view === id ? 'true' : 'false', onClick: () => setView(id) }, label))),
        view === 'board' && (boardView || h('div', { className: 'sv-empty' }, '正在读取信号板…')),
        view === 'admin' && adminView,
        drawerView,
        confirmNode,
      )
    }

    function AccountPositioningPage({ packId, openConversation }) {
      const [accountExecutionId, setAccountExecutionId] = React.useState(null);
      const emptyForm = () => ({ name: '', positioning: '', audience: '', pillars: '', boundary: '' });
      const formFor = (account) => account ? { name: account.name || '', positioning: account.positioning || '', audience: account.audience || '', pillars: (account.pillars || []).join('、'), boundary: account.boundary || '' } : emptyForm();
      const [library, setLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      // 加载态：library 初值就是空数组，请求未回时 active.length === 0，
      // 于是页面先闪一次「还没有账号定位 + 建立第一个账号」——用户可能因此
      // 重复创建。这个标志让「加载中」和「真的没有」分开。
      const [loading, setLoading] = React.useState(true);
      const [editing, setEditing] = React.useState(null);
      const [form, setForm] = React.useState(emptyForm);
      const [saving, setSaving] = React.useState(false);
      const [completing, setCompleting] = React.useState(false);
      const [completionNote, setCompletionNote] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [confirmNode, ask] = useSvConfirm();
      const openCreate = () => { setEditing({ account: null }); setForm(emptyForm()); setCompletionNote(null); };
      const openEdit = (account) => { setEditing({ account }); setForm(formFor(account)); setCompletionNote(null); };
      const closeDrawer = () => setEditing(null);
      const load = React.useCallback(async () => {
        if (!packId) return;
        try { const next = await remote(packId, 'listAccounts'); setLibrary(next); setError(null); }
        catch (cause) { setError(cause.message); }
        finally { setLoading(false); }
      }, [packId]);
      React.useEffect(() => { void load(); }, [load]);
      if (!packId) return h(NeedPack, { openConversation });
      const active = library.accounts.filter((item) => item.status === 'active');
      const archived = library.accounts.filter((item) => item.status === 'archived');
      const editingAccount = editing ? editing.account : null;
      const save = async (event) => {
        event.preventDefault(); setSaving(true);
        const payload = { name: form.name, positioning: form.positioning, audience: form.audience, pillars: csv(form.pillars), boundary: form.boundary };
        try {
          const result = editingAccount ? await remote(packId, 'updateAccount', { accountId: editingAccount.id, ...payload }) : await remote(packId, 'createAccount', payload);
          setLibrary(result.library); setError(null); closeDrawer();
          // 保存成功要有一句回执：抽屉直接关掉时，用户无法区分「保存成功」
          // 和「误触关闭」，只能重开抽屉确认。
          setCompletionNote(editingAccount ? `账号「${result.library.accounts.find((item) => item.id === (editingAccount.id))?.name || form.name}」已保存。` : `账号「${form.name}」已创建，可以在选题时选择它。`);
        } catch (cause) { setError(cause.message); } finally { setSaving(false); }
      };
      const setStatus = async (account, status) => {
        if (!account) return; setSaving(true);
        try {
          const result = await remote(packId, 'setAccountStatus', { accountId: account.id, status });
          setLibrary(result.library); setError(null);
          if (status === 'archived') closeDrawer();
        } catch (cause) { setError(cause.message); } finally { setSaving(false); }
      };
      const makeDefault = async (account) => {
        if (!account || account.status !== 'active') return; setSaving(true);
        try { setLibrary(await remote(packId, 'setDefaultAccount', { accountId: account.id })); setError(null); } catch (cause) { setError(cause.message); } finally { setSaving(false); }
      };
      const deleteAccount = async (account) => {
        if (!account || account.status !== 'archived') return;
        setSaving(true);
        try {
          const result = await remote(packId, 'deleteAccount', { accountId: account.id });
          setLibrary(result.library); setError(null);
        } catch (cause) { setError(cause.message); } finally { setSaving(false); }
      };
      const FIELD_LABELS = { name: '账号名称', positioning: '账号定位', audience: '目标受众', pillars: '内容方向', boundary: '内容边界' };
      const formHasInput = Boolean(form.name.trim() || form.positioning.trim() || form.audience.trim() || csv(form.pillars).length || form.boundary.trim());
      const complete = async () => {
        if (saving || completing || !formHasInput) return;
        setCompleting(true); setError(null); setCompletionNote(null);
        try {
          const executionId = actionKey('account-completion'); setAccountExecutionId(executionId);
          const result = await remote(packId, 'suggestAccountProfile', { executionId, name: form.name, positioning: form.positioning, audience: form.audience, pillars: csv(form.pillars), boundary: form.boundary });
          const suggestion = result.suggestion || {};
          setForm({
            name: suggestion.name || form.name,
            positioning: suggestion.positioning || form.positioning,
            audience: suggestion.audience || form.audience,
            pillars: (suggestion.pillars || []).join('、') || form.pillars,
            boundary: suggestion.boundary || form.boundary,
          });
          const filled = (result.filled || []).map((field) => FIELD_LABELS[field] || field);
          const updated = (result.updated || []).map((field) => FIELD_LABELS[field] || field);
          const parts = [];
          if (updated.length) parts.push(`已润色改写：${updated.join('、')}`);
          if (filled.length) parts.push(`已补齐：${filled.join('、')}`);
          setCompletionNote(parts.length ? `Agent 完善完成（${parts.join('；')}）。请检查后再保存。${result.summary ? ` · ${result.summary}` : ''}` : '当前字段已齐全，没有需要补全的内容。');
        } catch (cause) { setError(cause.message); } finally { setCompleting(false); }
      };
      const accountCard = (account) => {
        const isDefault = account.id === library.defaultAccountId;
        const avatar = accountAvatar(account.name);
        const doneFields = [account.positioning, account.audience, account.boundary].filter(Boolean).length + (account.pillars.length ? 1 : 0);
        return h('button', { key: account.id, type: 'button', className: 'sv-acc-card', 'data-state': account.configured ? 'ready' : 'todo', 'data-default': isDefault ? 'true' : 'false', onClick: () => openEdit(account) },
          h('span', { className: 'sv-acc-head' },
            h('span', { className: 'sv-acc-avatar', style: { background: avatar.background }, title: account.name }, avatar.letter),
            h('span', { className: 'sv-acc-id' },
              h('span', { className: 'sv-acc-name' }, account.name),
              h('span', { className: 'sv-acc-badges' },
                isDefault ? h('span', { className: 'sv-acc-pill', 'data-tone': 'default' }, '默认') : null,
                h('span', { className: 'sv-acc-pill', 'data-tone': account.configured ? 'done' : 'todo' }, account.configured ? '已完善' : '待完善'),
              ),
            ),
          ),
          h('p', { className: 'sv-acc-summary', 'data-empty': account.configured ? 'false' : 'true' }, account.positioning || account.audience || '尚未填写内容约束，完善后选题与写稿将自动继承'),
          account.pillars.length ? h('span', { className: 'sv-acc-chips' }, account.pillars.map((pillar) => h('span', { key: pillar, className: 'sv-acc-chip' }, pillar))) : null,
          h('span', { className: 'sv-acc-meter', 'data-full': doneFields === 4 ? 'true' : 'false', title: `定位完善度 ${doneFields}/4（定位 / 受众 / 方向 / 边界）` },
            [0, 1, 2, 3].map((index) => h('i', { key: index, 'data-on': index < doneFields ? 'true' : 'false' })),
            h('span', { className: 'sv-acc-meter-text' }, `完善度 ${doneFields}/4`),
          ),
          h('span', { className: 'sv-acc-foot' },
            h('span', null, `更新于 ${relativeTime(account.updatedAt)}`),
            h('span', null, account.configured ? '选题与写稿可继承' : '可用 Agent 补齐'),
          ),
        );
      };
      const newTile = h('button', { key: 'new', type: 'button', className: 'sv-acc-new', disabled: saving, onClick: openCreate },
        h('span', null, '新建账号定位'),
        h('span', { className: 'sv-acc-new-sub' }, '建立后，选题与写稿自动继承定位约束'),
      );
      const defaultAccount = library.accounts.find((account) => account.id === library.defaultAccountId) || null;
      const accountHero = h(HeroMini, { cells: [{ label: '启用账号', value: String(active.length), tone: 'brand' }, { label: '默认账号', value: defaultAccount ? defaultAccount.name : '未设置', tone: defaultAccount ? 'green' : undefined }, { label: '已归档', value: String(archived.length) }] });
      const drawerView = editing && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: closeDrawer }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': editingAccount ? `编辑账号定位 · ${editingAccount.name}` : '新建账号定位' },
          h('form', { className: 'sv-drawer-list', onSubmit: save },
            h('div', { className: 'sv-drawer-head' },
              h('div', null,
                h('h3', { style: { margin: '0', fontSize: 'var(--lwb-text-section,18px)' } }, editingAccount ? '编辑账号定位' : '新建账号定位'),
                editingAccount && h('p', { className: 'sv-meta' }, editingAccount.configured ? `已完善 · ${editingAccount.status === 'active' ? '启用' : '已归档'}` : '待完善 · 尚未填写内容约束'),
              ),
              h('button', { type: 'button', className: 'lwb-plain-button', onClick: closeDrawer }, '关闭'),
            ),
            h('div', { className: 'sv-acc-complete' },
              h('button', { type: 'button', className: 'lwb-primary-button', disabled: saving || completing || !formHasInput, onClick: () => { void complete(); } }, completing ? 'Agent 正在完善…' : 'Agent协助完善'),
              h('span', { className: 'sv-meta' }, '把录入内容当作草稿：Agent 可润色、扩写并补齐全部字段；结果回填表单，需人工检查后才保存。'),
            ),
            completionNote && h('p', { className: 'sv-note' }, completionNote),
            h('label', { className: 'sv-meta' }, '账号名称 *'),
            h('input', { className: 'sv-input', value: form.name, maxLength: 80, required: true, placeholder: '例如：AI 工具解读号', disabled: saving, onChange: (event) => setForm({ ...form, name: event.target.value }) }),
            accountExecutionId ? h(ExecutionButton, { kind: 'account', id: accountExecutionId }) : null,
            h('label', { className: 'sv-meta' }, '账号定位'),
            h('textarea', { className: 'sv-textarea', style: { minHeight: '70px' }, value: form.positioning, maxLength: 600, placeholder: '例如：面向普通创作者的 AI 工具解读', disabled: saving, onChange: (event) => setForm({ ...form, positioning: event.target.value }) }),
            h('label', { className: 'sv-meta' }, '目标受众'),
            h('input', { className: 'sv-input', value: form.audience, maxLength: 300, placeholder: '例如：想提升效率的职场创作者', disabled: saving, onChange: (event) => setForm({ ...form, audience: event.target.value }) }),
            h('label', { className: 'sv-meta' }, '内容方向（用顿号或逗号分隔）'),
            h('input', { className: 'sv-input', value: form.pillars, maxLength: 480, placeholder: '工具拆解、行业观察', disabled: saving, onChange: (event) => setForm({ ...form, pillars: event.target.value }) }),
            h('label', { className: 'sv-meta' }, '内容边界'),
            h('textarea', { className: 'sv-textarea', style: { minHeight: '70px' }, value: form.boundary, maxLength: 600, placeholder: '允许和禁止的内容，例如：不做医疗与投资建议', disabled: saving, onChange: (event) => setForm({ ...form, boundary: event.target.value }) }),
            h('div', { className: 'sv-actions' },
              h('button', { type: 'submit', className: 'lwb-primary-button', disabled: saving || !form.name.trim() }, saving ? '正在保存…' : editingAccount ? '保存账号' : '创建账号'),
              editingAccount?.status === 'active' && editingAccount.id !== library.defaultAccountId ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: saving, onClick: () => { void makeDefault(editingAccount); } }, '设为默认') : null,
              editingAccount?.status === 'active' ? h('button', { type: 'button', className: 'lwb-plain-button sv-acc-danger', disabled: saving, onClick: () => ask({ title: '归档账号', copy: `归档账号「${editingAccount.name}」？归档后不再出现在选题账号列表中。`, confirm: '归档', danger: true, onConfirm: () => { void setStatus(editingAccount, 'archived'); } }) }, '归档账号') : null,
            ),
            h('p', { className: 'sv-note' }, editingAccount ? '保存后的定位仅影响后续新生成的选题；归档不会删除已确认项目中的账号快照。' : '创建后即可在选题时选择该账号；确认选题后定位快照会绑定到项目，写稿自动继承。'),
          ),
        ),
      );
      return h(PackFrame, { packId, openConversation, title: '账号定位', copy: '管理本工作区的账号定位库。选题时明确选择一个账号，确认后会将定位快照绑定到项目；写稿自动继承该项目的账号上下文。', hero: accountHero },
        h(Notice, { error }),
        // 保存/创建成功的回执：抽屉关闭后页面要告诉用户刚才那一下生效了。
        completionNote && !editing ? h('p', { className: 'sv-note', role: 'status' }, completionNote) : null,
        h(ExecutionHistory, { kind: 'account', refreshKey: completing }),
        h('section', { className: 'sv-section' },
          h('div', { className: 'sv-section-head' },
            h('h3', null, '账号定位库'),
            h('span', null, `${active.length} 个启用 · 上限 50`),
          ),
          h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-primary-button', disabled: saving, onClick: openCreate }, '新建账号')),
          loading ? h('div', { className: 'sv-empty', 'aria-busy': 'true' }, '正在读取账号定位…')
            : active.length ? h('div', { className: 'sv-acc-grid' }, [...active.map(accountCard), newTile])
              : h('div', { className: 'sv-empty-cta' }, h('p', null, '还没有账号定位。建立第一个账号后，选题与写稿会自动继承它的定位约束。'), h('div', null, h('button', { type: 'button', className: 'lwb-primary-button', disabled: saving, onClick: openCreate }, '建立第一个账号'))),
          archived.length ? h('section', { className: 'sv-section' },
            h('div', { className: 'sv-section-head' }, h('h3', null, '已归档'), h('span', null, '归档不会删除已确认项目中的账号快照')),
            h('div', { className: 'sv-list' }, archived.map((account) => h('div', { key: account.id, className: 'sv-acc-arch' },
              h('span', { className: 'sv-acc-arch-info' },
                h('strong', null, account.name),
                h('span', null, `归档于 ${relativeTime(account.updatedAt)} · 快照保留在已确认项目中`),
              ),
              h('div', { className: 'sv-acc-arch-actions' },
                h('button', { type: 'button', className: 'lwb-plain-button', disabled: saving, onClick: () => { void setStatus(account, 'active'); } }, '恢复'),
                h('button', { type: 'button', className: 'lwb-plain-button sv-acc-danger', disabled: saving, onClick: () => ask({ title: '删除账号', copy: `删除账号“${account.name}”？删除不可恢复，但不影响已确认项目中的账号快照。`, confirm: '删除', danger: true, onConfirm: () => { void deleteAccount(account); } }) }, '删除'),
              ),
            ))),
          ) : null,
        ),
        drawerView,
        confirmNode,
      );
    }

    const GENERAL_TAB = '__general__';
    function AccountTabs({ accountLibrary, activeTab, onChange, label, disabled = false, children, tabBadge, tabBadgeLabel = '个待写稿' }) {
      const accounts = accountLibrary.accounts.filter((account) => account.status === 'active');
      const tab = (id, name) => {
        const badge = typeof tabBadge?.[id] === 'number' && tabBadge[id] > 0 ? tabBadge[id] : null;
        return h('button', {
          key: id, type: 'button', role: 'tab', className: 'sv-tp-tab',
          'data-active': activeTab === id ? 'true' : 'false', 'aria-selected': activeTab === id,
          disabled, onClick: () => onChange(id),
        }, id === accountLibrary.defaultAccountId ? h('span', { className: 'sv-tp-tab-dot', title: '默认账号', 'aria-label': '默认账号' }) : null, name, badge != null ? h('span', { className: 'sv-tp-tab-badge', 'aria-label': `${badge} ${tabBadgeLabel}` }, String(badge)) : null);
      };
      return h('div', { className: 'sv-tp-tabs', role: 'tablist', 'aria-label': label },
        accounts.map((account) => tab(account.id, account.name)),
        tab(GENERAL_TAB, '通用（无账号定位）'), children,
      );
    }
    const TOPIC_HISTORY_PAGE_SIZE = 6;
    function emptyTopicForm() { return { angle: '', offSources: new Set(), offPlatforms: new Set(), excluded: new Set() }; }
    function sourceDotColor(name) {
      const hash = String(name || '').split('').reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 11);
      return `hsl(${hash % 360}, 62%, 52%)`;
    }
    function TopicsPage({ packId, openConversation, openPackMenu }) {
      const { projects, refresh, error, setError } = useProjects(packId);
      const [board, setBoard] = React.useState(null);
      const [sources, setSources] = React.useState([]);
      // 信号源加载状态。旧实现把「还在读」和「真的没有」混成同一句
      // 「正在读取信号源…」，而且请求失败后 setError 已置错、这里仍显示
      // 那句话，永远不会结束。三态分开之后失败能明确说出来。
      const [sourcesState, setSourcesState] = React.useState('pending');
      const [accountLibrary, setAccountLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      const [formsByTab, setFormsByTab] = React.useState({});
      const [activeTab, setActiveTab] = React.useState(GENERAL_TAB);
      const [history, setHistory] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [launching, setLaunching] = React.useState(false);
      const [historyFilter, setHistoryFilter] = React.useState('all');
      const [historyPage, setHistoryPage] = React.useState(0);
      const [drawer, setDrawer] = React.useState(null);
      const [openSummary, setOpenSummary] = React.useState(null);
      const [openCand, setOpenCand] = React.useState(null);
      const [confirmNode, ask] = useSvConfirm();

      const loadHistory = React.useCallback(async () => {
        if (!packId) return [];
        try { const next = await remote(packId, 'listTopicGenerations'); setHistory(next); return next; } catch (cause) { setError(cause.message); return []; }
      }, [packId, setError]);

      React.useEffect(() => {
        if (!packId) return;
        void Promise.all([remote(packId, 'board'), remote(packId, 'sources'), remote(packId, 'listAccounts'), remote(packId, 'listTopicGenerations')])
          .then(([nextBoard, nextSources, nextAccounts, nextHistory]) => {
            setBoard(nextBoard); setSources(nextSources); setAccountLibrary(nextAccounts); setHistory(nextHistory);
            setActiveTab((current) => current !== GENERAL_TAB && nextAccounts.accounts.some((item) => item.id === current && item.status === 'active') ? current : nextAccounts.defaultAccountId || GENERAL_TAB);
            setSourcesState('ready');
          }).catch((cause) => { setError(cause.message); setSourcesState('error'); });
      }, [packId, setError]);

      const activeTasks = history.filter((item) => item.status === 'queued' || item.status === 'running');
      const runningCount = activeTasks.filter((item) => item.status === 'running').length;
      const queuedCount = activeTasks.length - runningCount;
      React.useEffect(() => {
        if (!packId || !activeTasks.length) return undefined;
        let active = true;
        const tick = () => { void remote(packId, 'listTopicGenerations').then((list) => { if (active) setHistory(list); }).catch((cause) => { if (active) setError(cause.message); }); };
        const timer = setInterval(tick, 1500);
        return () => { active = false; clearInterval(timer); };
      }, [packId, activeTasks.length, setError]);

      if (!packId) return h(NeedPack, { openConversation });

      const activeAccounts = accountLibrary.accounts.filter((item) => item.status === 'active');
      const form = formsByTab[activeTab] || emptyTopicForm();
      const patchForm = (fn) => setFormsByTab((prev) => ({ ...prev, [activeTab]: fn(prev[activeTab] || emptyTopicForm()) }));
      const publicCards = (board?.sources || []).filter((card) => card.id !== 'ai-daily-import');
      const platformCards = board?.aiDaily?.platforms || [];
      const allPublicIds = publicCards.map((card) => card.id);
      const selectedPublic = allPublicIds.filter((id) => !form.offSources.has(id));
      const selectedPlatforms = platformCards.map((card) => card.platform).filter((name) => !form.offPlatforms.has(name));
      const aiDailyOn = selectedPlatforms.length > 0;
      const allPlatformsSelected = platformCards.length > 0 && selectedPlatforms.length === platformCards.length;
      const selectedCount = selectedPublic.length + selectedPlatforms.length;
      const submitSourceIds = [...selectedPublic, ...(aiDailyOn ? ['ai-daily-import'] : [])];
      const activeAccount = activeAccounts.find((item) => item.id === activeTab) || null;
      const selectedSourceNames = [
        ...publicCards.filter((card) => !form.offSources.has(card.id)).map((card) => card.name),
        ...(aiDailyOn ? [`AI 内容日报 · ${allPlatformsSelected ? '全部平台' : selectedPlatforms.join('、')}`] : []),
      ];
      const selectedCandidatesOf = (record) => (record.candidates || []).filter((candidate) => candidate.selection?.state === 'selected');
      const queuedCandidateCount = history.reduce((count, record) => count + selectedCandidatesOf(record).length, 0);
      const terminalTasks = history.filter((item) => item.status !== 'queued' && item.status !== 'running');
      const filteredTerminalTasks = terminalTasks.filter((item) => historyFilter === 'all' || item.status === historyFilter);
      const historyPageCount = Math.max(1, Math.ceil(filteredTerminalTasks.length / TOPIC_HISTORY_PAGE_SIZE));
      const currentHistoryPage = Math.min(historyPage, historyPageCount - 1);
      const pagedTerminalTasks = filteredTerminalTasks.slice(currentHistoryPage * TOPIC_HISTORY_PAGE_SIZE, (currentHistoryPage + 1) * TOPIC_HISTORY_PAGE_SIZE);
      const historyRangeStart = filteredTerminalTasks.length ? currentHistoryPage * TOPIC_HISTORY_PAGE_SIZE + 1 : 0;
      const historyRangeEnd = Math.min((currentHistoryPage + 1) * TOPIC_HISTORY_PAGE_SIZE, filteredTerminalTasks.length);
      const historyFilters = [
        { id: 'all', label: '全部', count: terminalTasks.length },
        { id: 'completed', label: '已完成', count: terminalTasks.filter((item) => item.status === 'completed').length },
        { id: 'failed', label: '失败', count: terminalTasks.filter((item) => item.status === 'failed').length },
      ];
      React.useEffect(() => { setHistoryPage(0); }, [historyFilter]);
      React.useEffect(() => {
        if (historyPage >= historyPageCount) setHistoryPage(historyPageCount - 1);
      }, [historyPage, historyPageCount]);

      const toggleSource = (id) => { if (launching) return; patchForm((current) => { const offSources = new Set(current.offSources); if (offSources.has(id)) offSources.delete(id); else offSources.add(id); return { ...current, offSources }; }); };
      const togglePlatform = (name) => { if (launching) return; patchForm((current) => { const offPlatforms = new Set(current.offPlatforms); if (offPlatforms.has(name)) offPlatforms.delete(name); else offPlatforms.add(name); return { ...current, offPlatforms }; }); };
      const selectAllSources = () => { if (launching) return; patchForm((current) => ({ ...current, offSources: new Set(), offPlatforms: new Set() })); };
      const clearSources = () => { if (launching) return; patchForm((current) => ({ ...current, offSources: new Set(allPublicIds), offPlatforms: new Set(platformCards.map((card) => card.platform)) })); };
      const toggleExclude = (signalId) => patchForm((current) => { const excluded = new Set(current.excluded); if (excluded.has(signalId)) excluded.delete(signalId); else excluded.add(signalId); return { ...current, excluded }; });
      const clearExcluded = () => patchForm((current) => ({ ...current, excluded: new Set() }));

      const currentPayload = () => ({
          angle: form.angle.trim() || undefined,
          accountId: activeTab === GENERAL_TAB ? undefined : activeTab,
          sourceIds: submitSourceIds.length ? submitSourceIds : undefined,
          platforms: aiDailyOn && !allPlatformsSelected ? selectedPlatforms : undefined,
          excludeSignalIds: form.excluded.size ? [...form.excluded] : undefined,
        });
      const launch = async (payload) => {
        if (launching) return;
        setLaunching(true); setError(null);
        try { await remote(packId, 'startTopicGeneration', payload); await loadHistory(); }
        catch (cause) { setError(cause.message); } finally { setLaunching(false); }
      };
      const confirmLaunch = (payload, description) => {
        if (launching) return;
        // 通用 Tab 的选题不带账号快照，写稿页只会在「通用（无账号定位）」Tab 展示它们；
        // 用户默认停在账号 Tab 时会找不到，去向前置到这里说明。
        const destination = payload.accountId
          ? ''
          : '选题将不带账号定位，加入待写稿后只会出现在写稿页「通用（无账号定位）」Tab。';
        ask({
          title: '启动选题任务？',
          copy: `${description}。任务将先确认渠道当天采集，缺失时自动补采；补采仍失败的渠道会被跳过，不阻塞本轮选题，再交给 DSH 生成最多 5 个候选。任务会立即出现在右侧；你可以继续编辑并启动其他任务。完成后推荐候选会自动加入待写稿。${destination}`,
          confirm: '启动任务',
          onConfirm: () => { void launch(payload); },
        });
      };
      const generate = () => {
        if (launching || selectedCount === 0) return;
        const accountLabel = activeAccount ? `账号「${activeAccount.name}」` : '通用（无账号定位）';
        const angleLabel = form.angle.trim() ? `选题角度「${form.angle.trim()}」` : '未设置选题角度';
        const exclusions = form.excluded.size ? `，排除 ${form.excluded.size} 条信号` : '';
        confirmLaunch(currentPayload(), `${accountLabel}；${angleLabel}；参与渠道：${selectedSourceNames.join('、')}${exclusions}`);
      };
      const regenerate = (record) => {
        if (launching) return;
        const accountLabel = record.account?.name ? `账号「${record.account.name}」` : '通用（无账号定位）';
        confirmLaunch(record.input || {}, `将按该任务的冻结配置重新生成：${accountLabel}`);
        setOpenCand(null);
      };
      const toggleCandidateSelection = async (record, candidate) => {
        const state = candidate?.selection?.state || 'available';
        if (!candidate || busy || state === 'activating' || state === 'deactivating') return;
        setBusy(true);
        try {
          await remote(packId, 'setTopicCandidateSelection', { id: record.id, candidateId: candidate.id, selected: state !== 'selected' });
          setError(null);
          await refresh(); await loadHistory();
        } catch (cause) { setError(cause.message); } finally { setBusy(false); }
      };

      const openSourceDrawer = (card) => setDrawer({ kind: 'signals', sourceId: card.id, platform: null, name: card.name });
      const openPlatformDrawer = (card) => setDrawer({ kind: 'signals', sourceId: 'ai-daily-import', platform: card.platform, name: `AI 内容日报 · ${card.platform}` });
      const openCandidate = (record) => { setOpenCand(record.id); };

      const tabs = h(AccountTabs, { accountLibrary, activeTab, onChange: setActiveTab, label: '按账号定位选择选题范围' });

      const accountNote = activeAccount
        ? h('p', { className: 'sv-tp-acct-note' }, `本次将注入「${activeAccount.name}」${activeAccount.configured ? '的定位约束' : '（尚未填写内容约束）'}；加入待写稿时定位快照绑定到项目。`)
        : h('p', { className: 'sv-tp-acct-note' }, '本次不注入账号定位。', h('button', { type: 'button', className: 'sv-tp-acct-link', onClick: () => { setActiveTab(accountLibrary.defaultAccountId || GENERAL_TAB); } }, activeAccounts.length ? ' 切换到账号 Tab' : ' 去「账号定位」建立账号'));

      const sourceCard = (card) => {
        const on = !form.offSources.has(card.id);
        return h('div', { key: card.id, className: 'sv-tp-src', 'data-on': on ? 'true' : 'false' },
          h('div', { className: 'sv-tp-src-head' },
            h('button', { type: 'button', className: 'sv-tp-src-check', disabled: launching, 'aria-pressed': on, 'aria-label': `${on ? '取消' : '选择'}${card.name}`, onClick: () => toggleSource(card.id) }, h('i', null)),
            h('button', { type: 'button', className: 'sv-tp-src-main', onClick: () => openSourceDrawer(card) },
              h('span', { className: 'sv-tp-src-titlerow' }, h('span', { className: 'sv-tp-src-dot', style: { background: sourceDotColor(card.name) } }), h('span', { className: 'sv-tp-src-name' }, card.name)),
              h('span', { className: 'sv-tp-src-meta' }, `最新 ${relativeTime(card.lastSuccessAt)} · 今日 ${card.todayCount}`),
            ),
          ),
        );
      };
      const platformCard = (card) => {
        const on = !form.offPlatforms.has(card.platform);
        const glyph = PLATFORM_GLYPHS[card.platform];
        return h('div', { key: card.platform, className: 'sv-tp-src', 'data-on': on ? 'true' : 'false' },
          h('div', { className: 'sv-tp-src-head' },
            h('button', { type: 'button', className: 'sv-tp-src-check', disabled: launching, 'aria-pressed': on, 'aria-label': `${on ? '取消' : '选择'}${card.platform}`, onClick: () => togglePlatform(card.platform) }, h('i', null)),
            h('button', { type: 'button', className: 'sv-tp-src-main', onClick: () => openPlatformDrawer(card) },
              h('span', { className: 'sv-tp-src-titlerow' }, h('span', { className: 'sv-tp-src-dot', style: { background: glyph ? glyph[0] : sourceDotColor(card.platform) } }), h('span', { className: 'sv-tp-src-name' }, card.platform)),
              h('span', { className: 'sv-tp-src-meta' }, `最新 ${relativeTime(card.lastImportedAt)} · 今日 ${card.todayCount}`),
            ),
          ),
        );
      };

      const configCard = h('section', { className: 'sv-form' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '新建选题任务'), h('span', null, activeAccount ? activeAccount.name : '通用 · 无账号定位')),
        tabs,
        accountNote,
        h('label', { className: 'sv-meta' }, '选题角度（选填）'),
        h('textarea', { className: 'sv-textarea', style: { minHeight: '64px' }, value: form.angle, maxLength: 500, placeholder: '例如：避坑角度 · 真实使用场景，面向新手创作者', disabled: launching, onChange: (event) => patchForm((current) => ({ ...current, angle: event.target.value })) }),
        h('div', { className: 'sv-section-head' },
          h('label', { className: 'sv-meta' }, `参与渠道（初始已全选 · 已选 ${selectedCount}）`),
          h('span', { className: 'sv-actions' },
            h('button', { type: 'button', className: 'sv-tp-acct-link', disabled: launching, onClick: selectAllSources }, '全选'),
            h('button', { type: 'button', className: 'sv-tp-acct-link', disabled: launching, onClick: clearSources }, '清空'),
          ),
        ),
        h('p', { className: 'sv-tp-acct-note' }, '勾选决定哪些渠道的最新采集进入本轮。启动时会先补采当天缺失的渠道；补采失败的渠道会跳过，不阻塞本轮选题。点渠道名可查看信号，并排除单条。'),
        sourcesState === 'pending' ? h('p', { className: 'sv-note', 'aria-busy': 'true' }, '正在读取信号源…')
          : sourcesState === 'error' ? h('p', { className: 'sv-error', role: 'alert' }, '信号源读取失败。请检查网络与工作台服务后刷新页面；这不影响手动输入选题。')
            : publicCards.length ? h('div', { className: 'sv-tp-srcgrid' }, publicCards.map(sourceCard))
              : h('p', { className: 'sv-note' }, '还没有可用的信号源。可在「信号」页启用渠道，或直接用下方的自定义选题。'),
        platformCards.length ? h(React.Fragment, null,
          h('label', { className: 'sv-meta' }, 'AI 内容日报（报告导入 · 按平台）'),
          h('div', { className: 'sv-tp-srcgrid' }, platformCards.map(platformCard)),
        ) : null,
        form.excluded.size ? h('div', { className: 'sv-tp-exclbar' }, h('span', null, `已在抽屉中排除 ${form.excluded.size} 条信号，本次生成不参与。`), h('button', { type: 'button', disabled: launching, onClick: clearExcluded }, '清空排除')) : null,
        h('div', { className: 'sv-actions' },
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: launching || selectedCount === 0, onClick: generate }, launching ? '正在创建任务…' : '生成选题'),
          selectedCount === 0 ? h('span', { className: 'sv-meta' }, '至少选择一个参与渠道') : null,
        ),
      );

      const stepPills = (record) => h('div', { className: 'sv-tp-steps' }, (record.steps || []).map((step) => h('span', { key: step.id, className: 'sv-tp-step', 'data-state': step.status, title: step.detail || step.label }, h('i', null), step.detail || step.label)));
      const taskCard = (record) => {
        const selectedCandidates = selectedCandidatesOf(record);
        const taskActive = record.status === 'queued' || record.status === 'running';
        const statusTag = record.status === 'queued' ? ['排队中', 'sv-status-manual']
          : record.status === 'running' ? ['运行中', '']
          : record.status === 'failed' ? ['失败', 'sv-status-error']
          : selectedCandidates.length ? [`待写稿 ${selectedCandidates.length}`, 'sv-stage']
          : [`${record.returned} 个候选`, ''];
        return h('div', { key: record.id, className: 'sv-tp-task', 'data-status': record.status, 'data-confirmed': selectedCandidates.length ? 'true' : 'false' },
          h('div', { className: 'sv-tp-task-head' },
            h('div', null,
              h('p', { className: 'sv-tp-task-title' }, record.summary || '选题生成'),
              h('p', { className: 'sv-tp-task-meta' }, `${relativeTime(record.startedAt)} · 账号：${record.account?.name || '无'}${record.elapsedMs != null ? ` · 耗时 ${(record.elapsedMs / 1000).toFixed(1)}s` : ''}`),
            ),
            h('span', { className: 'sv-tp-task-badges' }, h('span', { className: `sv-tag ${statusTag[1]}` }, statusTag[0])),
          ),
          taskActive ? h('div', { role: 'status', 'aria-live': 'polite' }, stepPills(record)) : null,
          record.unavailableSources?.length ? h('p', { className: 'sv-note', role: 'status' }, `部分信号源未获得当天数据，本轮未使用：${record.unavailableSources.map((item) => item.name || item.id).join('、')}。${record.materialSignalIds?.length ? '已使用其他可用来源继续生成。' : '已按用户输入与账号定位继续生成。'}`) : null,
          selectedCandidates.length ? h('div', { className: 'sv-tp-confirmed' },
            h('span', { className: 'sv-tp-confirmed-title' }, `已加入待写稿 ${selectedCandidates.length} 个`),
            h('span', { className: 'sv-tp-confirmed-meta' }, selectedCandidates.map((candidate) => {
              const project = candidate.selection?.projectId ? projects.find((item) => item.id === candidate.selection.projectId) : null;
              return `${candidate.title}${project ? ` · ${stageName(project)}` : ' · 正在建立项目'}`;
            }).join('；')),
          ) : null,
          h('div', { className: 'sv-tp-task-acts' },
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setOpenSummary(record.id) }, '执行详情'),
            record.status === 'completed' && record.returned ? h('button', { type: 'button', className: selectedCandidates.length ? 'lwb-plain-button' : 'lwb-primary-button', onClick: () => openCandidate(record) }, selectedCandidates.length ? '管理候选' : '查看候选') : null,
            record.status === 'failed' ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: launching, onClick: () => regenerate(record) }, '重试') : null,
            record.status === 'queued' ? h('span', { className: 'sv-note' }, '等待可用的生成执行位；可以继续创建其他任务。') : null,
            record.status === 'running' ? h('span', { className: 'sv-note' }, '切换页面不会中断，完成后在此查看候选。') : null,
          ),
        );
      };

      const taskPanel = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '选题任务 · 全部账号'), h('span', { role: 'status', 'aria-live': 'polite' }, activeTasks.length ? `运行 ${runningCount} · 排队 ${queuedCount}` : `${terminalTasks.length} 条历史 · ${queuedCandidateCount} 个待写稿`)),
        history.length ? h(React.Fragment, null,
          activeTasks.length ? h('div', { className: 'sv-tp-task-group' },
            h('div', { className: 'sv-tp-task-group-head' }, h('h4', { className: 'sv-tp-task-group-title' }, '进行中的任务'), h('span', { className: 'sv-tp-task-group-meta' }, `${activeTasks.length} 个任务始终置顶`)),
            h('div', { className: 'sv-list' }, activeTasks.map(taskCard)),
          ) : null,
          h('div', { className: 'sv-tp-task-group' },
            h('div', { className: 'sv-tp-task-group-head' }, h('h4', { className: 'sv-tp-task-group-title' }, '历史任务'), h('span', { className: 'sv-tp-task-group-meta' }, filteredTerminalTasks.length ? `显示 ${historyRangeStart}-${historyRangeEnd} / ${filteredTerminalTasks.length}` : '没有历史任务')),
            h('div', { className: 'sv-tp-history-filters', role: 'group', 'aria-label': '按任务状态筛选历史任务' }, historyFilters.map((filter) => h('button', { key: filter.id, type: 'button', className: 'sv-tp-history-filter', 'aria-pressed': historyFilter === filter.id, onClick: () => setHistoryFilter(filter.id) }, `${filter.label} ${filter.count}`))),
            pagedTerminalTasks.length ? h(React.Fragment, null,
              h('div', { className: 'sv-list' }, pagedTerminalTasks.map(taskCard)),
              historyPageCount > 1 ? h('div', { className: 'sv-tp-pagination', 'aria-label': '历史任务分页' },
                h('button', { type: 'button', className: 'lwb-plain-button', title: '上一页', 'aria-label': '上一页', disabled: currentHistoryPage === 0, onClick: () => setHistoryPage((page) => Math.max(0, page - 1)) }, '←'),
                h('span', { className: 'sv-tp-pagination-page', 'aria-live': 'polite' }, `第 ${currentHistoryPage + 1} / ${historyPageCount} 页`),
                h('button', { type: 'button', className: 'lwb-plain-button', title: '下一页', 'aria-label': '下一页', disabled: currentHistoryPage >= historyPageCount - 1, onClick: () => setHistoryPage((page) => Math.min(historyPageCount - 1, page + 1)) }, '→'),
              ) : null,
            ) : h('div', { className: 'sv-empty' }, '没有符合当前筛选条件的历史任务。'),
          ),
        ) : h('div', { className: 'sv-empty' }, '尚无选题任务。左侧圈定参与渠道后点击「生成选题」。'),
      );

      const summaryRecord = history.find((item) => item.id === openSummary) || null;
      const summaryDrawer = summaryRecord && h(ExecutionDrawer, { key: summaryRecord.id, request: { kind: 'topic', id: summaryRecord.id }, onClose: () => setOpenSummary(null) });

      const candRecord = history.find((item) => item.id === openCand) || null;
      // 「去写稿」：带走本轮选中的第一个候选的 projectId，切到写稿页后由那边的
      // scriptsHandoff 消费。取第一个是因为候选按 DSH 推荐度排序、推荐项已自动
      // 选中，用户点这个按钮的意图几乎总是「先写推荐的那篇」。
      const goToScript = candRecord && (() => {
        const target = selectedCandidatesOf(candRecord).find((item) => item.projectId);
        if (!target || typeof openPackMenu !== 'function') return null;
        return () => { scriptsHandoff = target.projectId; setOpenCand(null); openPackMenu('scripts'); };
      })();
      const candidateDrawer = candRecord && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: () => { setOpenCand(null); } }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '候选选题' },
          h('div', { className: 'sv-drawer-head' },
            h('div', null,
              h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, `提供选题 · ${candRecord.returned} 个`),
              h('p', { className: 'sv-meta' }, `${candRecord.account?.name || '通用'} · ${relativeTime(candRecord.startedAt)}${candRecord.elapsedMs != null ? ` · 耗时 ${(candRecord.elapsedMs / 1000).toFixed(1)}s` : ''} · 推荐项已自动加入待写稿`),
            ),
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => { setOpenCand(null); } }, '关闭'),
          ),
          h('div', { className: 'sv-drawer-list' },
            h('p', { className: 'sv-note' }, '候选按 DSH 推荐程度排序。第一个已自动加入待写稿；可继续加入其他候选，未写稿前也可移出。'),
            candRecord.candidates.length ? candRecord.candidates.map((candidate, index) => {
              const state = candidate.selection?.state || 'available';
              const project = candidate.selection?.projectId ? projects.find((item) => item.id === candidate.selection.projectId) : null;
              const hasScript = Boolean(project?.completedStages?.includes('script'));
              const stateLabel = state === 'selected' ? hasScript ? '已有稿件' : '已加入待写稿' : state === 'activating' ? '加入中…' : state === 'deactivating' ? '移出中…' : '加入待写稿';
              return h('button', { key: candidate.id, type: 'button', className: 'sv-tp-cand', 'data-sel': state === 'selected' ? 'true' : 'false', disabled: busy || state === 'activating' || state === 'deactivating' || hasScript, onClick: () => { void toggleCandidateSelection(candRecord, candidate); } },
              h('span', { className: 'sv-tp-cand-head' },
                h('span', { className: 'sv-tp-cand-radio' }, h('i', null)),
                h('span', { className: 'sv-tp-cand-title' }, candidate.title),
                index === 0 ? h('span', { className: 'sv-tp-rec' }, '推荐') : null,
                h('span', { className: state === 'selected' ? 'sv-stage' : 'sv-tag' }, stateLabel),
              ),
              h('p', { className: 'sv-tp-cand-meta' }, [candidate.videoForm, candidate.angle, `依据 ${candidate.signalIds.length} 条信号`].filter(Boolean).join(' · ')),
              candidate.contentCore ? h('p', { className: 'sv-tp-cand-core' }, candidate.contentCore) : null,
              candidate.whyNow ? h('p', { className: 'sv-tp-cand-why' }, `为什么现在做：${candidate.whyNow}`) : null,
              candidate.selection?.error ? h('p', { className: 'sv-error' }, candidate.selection.error) : null,
            );
            }) : h('p', { className: 'sv-note' }, '本轮没有获得候选，请调整输入后重新生成。'),
          ),
          h('div', { className: 'sv-tp-drawer-foot' },
            h('span', { className: 'sv-meta' }, `已加入待写稿 ${selectedCandidatesOf(candRecord).length} 个`),
            // 「去写稿」：把本轮选中的候选带到写稿页并直接选中。
            // 之前底部只有「生成新一批 / 完成」，选完就没有下一步了，用户以为
            // 「已加入待写稿」就是终点，得自己记住去切页（2026-10-11 反馈）。
            // 用 handoff 携带 projectId：写稿页的数据源是 listWritableTopics，
            // 按 updatedAt 倒序，刚加入的自然排第一，这里再把抽屉直接打开。
            h('button', {
              type: 'button',
              className: 'lwb-plain-button',
              disabled: !goToScript || !selectedCandidatesOf(candRecord).some((item) => item.projectId),
              title: goToScript ? '前往写稿页并打开第一个待写稿' : '当前环境不支持页面跳转，可手动切到「写稿」页',
              onClick: goToScript,
            }, '下一步：去写稿'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: launching, onClick: () => regenerate(candRecord) }, '生成新一批'),
            h('button', { type: 'button', className: 'lwb-primary-button', onClick: () => { setOpenCand(null); } }, '完成'),
          ),
        ),
      );

      const collectFromDrawer = async (ids) => {
        setBusy(true); setError(null);
        try { await remote(packId, 'collectSources', { sourceIds: ids }); await remote(packId, 'board').then(setBoard); }
        catch (cause) { setError(cause.message); } finally { setBusy(false); }
      };
      const signalsDrawer = drawer && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: () => setDrawer(null) }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': drawer.name },
          h(SignalDrawerBody, { packId, sources, spec: drawer, today: board?.today, busy, onClose: () => setDrawer(null), onCollect: (ids) => { void collectFromDrawer(ids); }, onChanged: () => { void remote(packId, 'board').then(setBoard).catch(() => {}); }, ask, selection: { excluded: form.excluded, onToggle: toggleExclude } }),
        ),
      );

      return h(PackFrame, { packId, openConversation, title: '选题', copy: '按账号定位分 Tab 选择参与渠道与选题角度。确认后任务会立即进入右侧列表；可继续创建其他任务。启动时会补采当天缺失的渠道，本轮仅使用各渠道最新一次采集的信号。推荐项自动加入待写稿，其他候选可按需加入或移出。', hero: h(HeroMini, { cells: [{ label: '近 7 日可用', value: String(board?.totals?.active ?? '—') }, { label: '任务状态', value: activeTasks.length ? `运行 ${runningCount} · 排队 ${queuedCount}` : '空闲', tone: activeTasks.length ? 'orange' : 'green' }, { label: '待写稿选题', value: String(queuedCandidateCount), tone: 'brand' }] }) },
        h(Notice, { error }),
        h('section', { className: 'sv-split' }, configCard, taskPanel),
        signalsDrawer,
        summaryDrawer,
        candidateDrawer,
        confirmNode,
      );
    }
    const ARCHIVED_TAB = '__archived__';
    // 任务卡片上的账号分组与选题 Tab 保持同一套判据：有快照归该账号，
    // 无快照归通用，已归档账号单独一档而不是被静默丢弃。
    function scriptTaskTab(record, activeIds) {
      const id = record?.account?.id || null;
      return !id ? GENERAL_TAB : activeIds.has(id) ? id : ARCHIVED_TAB;
    }
    function sortScriptTasks(records, mode) {
      const direction = mode === 'oldest' ? 1 : -1;
      return [...records].sort((left, right) => direction * String(left?.startedAt || left?.queuedAt || '').localeCompare(String(right?.startedAt || right?.queuedAt || '')));
    }
    function emptyScriptForm() { return { tier: 'medium', instructions: '', targetId: null }; }
    // 待写稿 = 已确认选题但还没有稿的项目（listWritableTopics 的 scriptState === 'none'）。
    // 按选题冻结的账号快照分组：无快照的归通用 Tab，与写稿页 tabOf 的分组一致。
    function pendingCountByTab(topics) {
      const counts = {};
      for (const topic of Array.isArray(topics) ? topics : []) {
        if (topic?.scriptState !== 'none') continue;
        const tab = topic.account?.id || GENERAL_TAB;
        counts[tab] = (counts[tab] || 0) + 1;
      }
      return counts;
    }
    const SCRIPT_STATE_LABEL = { none: '未写稿', draft: '已保存', approved: '已保存' };
    const TIER_OPTIONS = [['short', '短篇', '300-999 字'], ['medium', '中篇', '1000-2499 字'], ['long', '长篇', '2500 字以上']];
    const TIER_LABEL = { short: '短篇', medium: '中篇', long: '长篇' };
    const TIER_SHORT = { short: '短', medium: '中', long: '长' };
    function scriptDurationLabel(text) {
      const spoken = Array.from(String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')).length;
      const secs = Math.round(spoken / 4.1);
      return `${Math.floor(secs / 60)} 分 ${String(secs % 60).padStart(2, '0')} 秒`;
    }
    function charCount(text) { return Array.from(String(text || '').replace(/\s+/g, '')).length; }
    function originalityLabel(risk) { return risk === 'high' ? '高' : risk === 'medium' ? '中' : '低'; }

    /**
     * The script page keeps the topic page's shape — configure a new run on the
     * left, watch runs on the right — and puts the whole script lifecycle
     * (AI generation -> optional edit -> polish -> quality -> approve) inside
     * one drawer.
     * Account binding is deliberately absent: a project's account is decided
     * when its topic is confirmed, and rebinding here would rewrite the topic
     * artifact and destroy the script plus every downstream stage.
     */
    function ScriptPage({ packId, openConversation, openPackMenu }) {
      const { projects, refresh, error, setError } = useProjects(packId);
      const [topics, setTopics] = React.useState([]);
      const [accountLibrary, setAccountLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      const [formsByTab, setFormsByTab] = React.useState({});
      const [activeTab, setActiveTab] = React.useState(GENERAL_TAB);
      const [history, setHistory] = React.useState([]);
      const [historyFilter, setHistoryFilter] = React.useState('all');
      // 任务面板另外按账号定位收窄，并可翻转时间方向；两者只影响展示，
      // 不改变任何任务状态，也不参与左侧选题 Tab 的选择。
      const [historyAccount, setHistoryAccount] = React.useState('all');
      const [historySort, setHistorySort] = React.useState('newest');
      const [historyPage, setHistoryPage] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [openMore, setOpenMore] = React.useState(false);
      const [openSummary, setOpenSummary] = React.useState(null);
      // One selection surface for the whole page: the drawer is keyed by project.
      const [openProject, setOpenProject] = React.useState(null);
      const [drawerMode, setDrawerMode] = React.useState('read');
      const [scriptModal, setScriptModal] = React.useState(null);
      const drawerScrollRef = React.useRef(null);
      const editorRef = React.useRef(null);
      const [moreFilter, setMoreFilter] = React.useState('all');
      const [moreQuery, setMoreQuery] = React.useState('');
      const [body, setBody] = React.useState('');
      const [report, setReport] = React.useState(null);
      const [reportBody, setReportBody] = React.useState('');
      const [reportBusy, setReportBusy] = React.useState(false);
      const [draftTier, setDraftTier] = React.useState('medium');
      const [polishNote, setPolishNote] = React.useState('');
      const [regenerateNote, setRegenerateNote] = React.useState('');
      const [confirmNode, ask] = useSvConfirm();

      const { detail, error: detailError, reload } = useDetail(packId, openProject);
      const { saving, commit } = useCommit(packId, refresh, reload, setError);

      const loadTopics = React.useCallback(async () => {
        if (!packId) return [];
        try { const next = await remote(packId, 'listWritableTopics'); setTopics(next); return next; }
        catch (cause) { setError(cause.message); return []; }
      }, [packId, setError]);
      const loadHistory = React.useCallback(async () => {
        if (!packId) return [];
        try { const next = await remote(packId, 'listScriptGenerations'); setHistory(next); return next; }
        catch (cause) { setError(cause.message); return []; }
      }, [packId, setError]);

      React.useEffect(() => {
        if (!packId) return;
        void Promise.all([remote(packId, 'listAccounts'), loadTopics(), loadHistory()])
          .then(([accounts, nextTopics]) => {
            setAccountLibrary(accounts);
            // 默认落在待写稿最多的 Tab：账号快照为空的选题（选题页通用 Tab 生成）
            // 只会出现在通用 Tab，默认账号 Tab 会把它们藏住，用户因此找不到。
            const pendingByTab = pendingCountByTab(nextTopics);
            setActiveTab((current) => {
              if (current === GENERAL_TAB || accounts.accounts.some((item) => item.id === current && item.status === 'active')) {
                const general = pendingByTab[GENERAL_TAB] || 0;
                const currentPending = current === GENERAL_TAB ? general : pendingByTab[current] || 0;
                if (currentPending > 0 || general === 0) return current;
                if (general > currentPending) return GENERAL_TAB;
              }
              return accounts.defaultAccountId || GENERAL_TAB;
            });
          }).catch((cause) => setError(cause.message));
      }, [packId, loadTopics, loadHistory, setError]);

      // Commits and approvals change a topic's scriptState, so follow the project list.
      React.useEffect(() => { void loadTopics(); }, [projects, loadTopics]);

      const anyRunning = history.some((item) => item.status === 'running');
      const projectIsRunning = (projectId) => history.some((item) => item.projectId === projectId && (item.status === 'queued' || item.status === 'running'));
      const projectBusy = Boolean(openProject && projectIsRunning(openProject));
      // 任一筛选维度变化都回到第一页，否则可能停在越界页码上看不到结果。
      React.useEffect(() => { setHistoryPage(0); }, [historyFilter, historyAccount, historySort]);
      React.useEffect(() => {
        if (!packId || !anyRunning) return undefined;
        let active = true;
        const tick = () => {
          void (async () => {
            await loadHistory();
            if (!active) return;
            await Promise.all([loadTopics(), refresh(), openProject ? reload() : Promise.resolve()]);
          })();
        };
        tick();
        const timer = setInterval(tick, 1500);
        return () => { active = false; clearInterval(timer); };
      }, [packId, anyRunning, loadHistory, loadTopics, refresh, reload, openProject]);

      const activeAccounts = accountLibrary.accounts.filter((item) => item.status === 'active');
      const activeIds = new Set(activeAccounts.map((item) => item.id));
      const tabOf = (topic) => (!topic.account ? GENERAL_TAB : activeIds.has(topic.account.id) ? topic.account.id : ARCHIVED_TAB);

      // Pipeline board handoff: open the carried project's draft drawer directly.
      // Declared after activeAccounts — the dependency array evaluates during
      // render, so referencing a later const here is a TDZ crash.
      React.useEffect(() => {
        if (!pipelineHandoff || pipelineHandoff.page !== 'scripts' || !pipelineHandoff.projectId) return;
        const target = topics.find((topic) => topic.projectId === pipelineHandoff.projectId);
        if (!target) return;
        const { projectId } = pipelineHandoff;
        pipelineHandoff = null;
        // Land on the project's own tab so the card is visible, then open the drawer.
        setActiveTab(target.account && activeAccounts.some((item) => item.id === target.account.id) ? target.account.id : GENERAL_TAB);
        setOpenProject(projectId);
        setOpenMore(false);
      }, [topics, activeAccounts]);
      // 选题页「下一步：去写稿」交接：同样落到项目自己的 Tab 并直接打开抽屉。
      // 与 pipelineHandoff 走同一套逻辑，只是来源不同，所以单开一个变量而不是
      // 复用 pipelineHandoff（那个按 page 键，语义上是看板过来的）。
      React.useEffect(() => {
        if (!scriptsHandoff) return;
        const target = topics.find((topic) => topic.projectId === scriptsHandoff);
        if (!target) return;
        const { projectId } = scriptsHandoff;
        scriptsHandoff = null;
        setActiveTab(target.account && activeAccounts.some((item) => item.id === target.account.id) ? target.account.id : GENERAL_TAB);
        setOpenProject(projectId);
        setOpenMore(false);
      }, [topics, activeAccounts]);
      // 纯按更新时间倒序，**不再按 scriptState 把已确认稿排在前面**。
      // 2026-10-11 用户反馈：刚在选题页加入待写稿的「字节没发世界模型」在写稿页
      // 排到第 39 位。原排序 `{approved:0, none:1}` 先比状态，所以 38 条已确认稿
      // 把 13 条待写稿全压在后面 —— 而待写稿正是用户此刻唯一想动的那批。
      // 实测改成纯时间倒序后：新选题回到第 1 位，已确认稿之间仍是新的在前。
      const sortTopics = (list) => [...list].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const tabTopics = sortTopics(topics.filter((topic) => tabOf(topic) === activeTab));
      const archivedTopics = sortTopics(topics.filter((topic) => tabOf(topic) === ARCHIVED_TAB));
      const tabName = activeTab === GENERAL_TAB ? '通用（无账号定位）' : (activeAccounts.find((item) => item.id === activeTab)?.name || '—');

      // Keep a valid new-run target for the active tab.
      React.useEffect(() => {
        const ids = new Set(topics.map((topic) => topic.projectId));
        setFormsByTab((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            const current = next[key] || emptyScriptForm();
            if (current.targetId && !ids.has(current.targetId)) next[key] = { ...current, targetId: null };
          }
          return next;
        });
      }, [topics]);
      React.useEffect(() => {
        setFormsByTab((prev) => {
          const current = prev[activeTab] || emptyScriptForm();
          if (current.targetId && tabTopics.some((topic) => topic.projectId === current.targetId)) return prev;
          return { ...prev, [activeTab]: { ...current, targetId: tabTopics[0]?.projectId || null } };
        });
      }, [activeTab, tabTopics]);

      const form = formsByTab[activeTab] || emptyScriptForm();
      const patchForm = (fn) => setFormsByTab((prev) => ({ ...prev, [activeTab]: fn(prev[activeTab] || emptyScriptForm()) }));

      const topicData = stageData(detail, 'topic');
      const account = topicData?.account || null;
      const signalItems = stageData(detail, 'signals')?.items || [];
      const savedScript = stageData(detail, 'script')?.body || '';
      const approved = Boolean(savedScript.trim());
      const dirty = Boolean(detail) && body !== savedScript;
      React.useEffect(() => { setBody(stageData(detail, 'script')?.body || ''); setReport(null); setReportBody(''); }, [detail?.id, detail?.revision]);

      const projectRecords = openProject ? history.filter((item) => item.projectId === openProject) : [];
      const activeRunningRecord = history.find((item) => item.status === 'running') || null;
      const runningRecord = projectRecords.find((item) => item.status === 'running') || null;
      const otherRunningRecord = activeRunningRecord && activeRunningRecord.id !== runningRecord?.id ? activeRunningRecord : null;
      const latestDraft = projectRecords.find((item) => item.status === 'completed' && item.draft?.script) || null;
      const latestDraftMatchesDetail = Boolean(latestDraft
        && detail?.artifacts?.script?.revision != null
        && latestDraft.scriptRevision === detail.artifacts.script.revision);
      React.useEffect(() => { setDraftTier(latestDraft?.tier || 'medium'); setPolishNote(''); setRegenerateNote(''); }, [detail?.id, latestDraft?.id]);
      React.useEffect(() => {
        if (!scriptModal) return undefined;
        const onKey = (event) => { if (event.key === 'Escape' && !reportBusy) setScriptModal(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [scriptModal, reportBusy]);
      React.useEffect(() => {
        const node = editorRef.current;
        if (drawerMode !== 'edit' || !node) return;
        node.style.height = 'auto';
        node.style.height = `${node.scrollHeight}px`;
      }, [body, drawerMode]);

      if (!packId) return h(NeedPack, { openConversation });

      const INLINE_LIMIT = 6;
      const inlineTopics = tabTopics.slice(0, INLINE_LIMIT);
      const hiddenInTab = tabTopics.length - inlineTopics.length;
      const canOpenMore = topics.length > 0;

      const selectTab = (tab) => { setActiveTab(tab); setOpenMore(false); };
      const selectTarget = (topic) => patchForm((current) => ({ ...current, targetId: topic.projectId }));
      const resetDrawer = () => { setOpenProject(null); setDrawerMode('read'); setScriptModal(null); };
      const openDraft = (projectId) => {
        const open = () => { setOpenProject(projectId); setOpenMore(false); setDrawerMode('edit'); setScriptModal(null); };
        if (dirty && projectId !== openProject) {
          ask({ title: '放弃未保存的修改？', danger: true, confirm: '放弃修改', copy: '切换稿件后会丢失当前未保存的修改。', onConfirm: open });
          return;
        }
        open();
      };
      const closeDraft = () => {
        if (!dirty) { resetDrawer(); return; }
        ask({
          title: '放弃未保存的修改？', danger: true, confirm: '放弃修改',
          copy: '编辑器里有尚未保存的稿件修改，关闭后会丢失。',
          onConfirm: resetDrawer,
        });
      };
      const scrollDrawerTop = () => {
        requestAnimationFrame(() => { drawerScrollRef.current?.scrollTo({ top: 0 }); });
      };

      const startGeneration = async ({ projectId, mode, tier, instructions }) => {
        if (!projectId || busy || projectIsRunning(projectId)) return false;
        setBusy(true); setError(null);
        try {
          await remote(packId, 'startScriptGeneration', { projectId, mode, tier, instructions: instructions || undefined });
          await loadHistory();
          await Promise.all([refresh(), openProject ? reload() : Promise.resolve()]);
          return true;
        }
        catch (cause) { setError(cause.message); return false; } finally { setBusy(false); }
      };
      const confirmGeneration = (payload, title = '写稿') => {
        if (!payload.projectId || busy || projectIsRunning(payload.projectId)) return;
        const topic = topics.find((item) => item.projectId === payload.projectId);
        const project = projects.find((item) => item.id === payload.projectId);
        ask({
          title,
          copy: `将为「${topic?.title || project?.title || '当前选题'}」启动${payload.mode === 'polish' ? '润色' : '写稿'}任务，篇幅为${TIER_LABEL[payload.tier] || payload.tier}。${payload.instructions ? `额外要求：${payload.instructions}。` : ''}生成完成后会自动保存稿件，可直接进入配音。`,
          confirm: '启动任务',
          onConfirm: () => { void startGeneration(payload); },
        });
      };
      const generateNew = () => confirmGeneration({ projectId: form.targetId, mode: 'new', tier: form.tier, instructions: form.instructions.trim() });
      // Polish needs a durable source body. Pending editor changes are saved
      // automatically so users never need a separate save action.
      const startPolish = async () => {
        if (!detail || busy || projectIsRunning(detail.id) || !body.trim()) return;
        if (dirty) { const saved = await commit(detail, 'script', { body }); if (!saved) return; }
        const started = await startGeneration({ projectId: detail.id, mode: 'polish', tier: draftTier, instructions: polishNote.trim() });
        if (started) setScriptModal('ai');
      };
      const startRegenerate = async () => {
        if (!detail || busy || projectIsRunning(detail.id)) return;
        if (dirty) { const saved = await commit(detail, 'script', { body }); if (!saved) return; }
        const started = await startGeneration({ projectId: detail.id, mode: 'new', tier: draftTier, instructions: regenerateNote.trim() });
        if (started) setScriptModal('ai');
      };
      const analyze = async (target) => {
        if (!detail || !String(target || '').trim()) return;
        setReportBusy(true);
        try {
          const next = await remote(packId, 'analyzeScript', { projectId: detail.id, title: detail.title, body: target, tier: draftTier });
          setReport(next); setReportBody(String(target));
        }
        catch (cause) { setError(cause.message); } finally { setReportBusy(false); }
      };
      const approve = () => ask({
        title: dirty ? '保存并进入配音' : '进入配音', confirm: dirty ? '保存并进入' : '进入配音',
        copy: dirty ? `保存「${detail.title}」当前修改并进入配音？` : `选择「${detail.title}」进入配音模块？`,
        onConfirm: async () => {
          setBusy(true);
          try {
            const saved = dirty ? await commit(detail, 'script', { body }) : { project: detail };
            if (!saved) return;
            await refresh(); await reload(); await loadTopics(); setError(null);
            // The next page owns its selected-project state, so carry the approved project across navigation.
            audioCaptionsHandoff = saved.project.id;
            openPackMenu?.('audio-captions');
          } catch (cause) { setError(cause.message); } finally { setBusy(false); }
        },
      });

      const stepPills = (record) => h('div', { className: 'sv-tp-steps' }, (record.steps || []).map((step) => h('span', { key: step.id, className: 'sv-tp-step', 'data-state': step.status, title: step.detail || step.label }, h('i', null), step.detail || step.label)));
      const generationStatus = (record, currentProject) => h('section', { className: 'sv-sc-run-status', 'data-current': currentProject ? 'true' : 'false' },
        h('div', { className: 'sv-sc-ai-action-head' },
          h('strong', null, currentProject ? `DSH 正在${record.mode === 'polish' ? '润色当前稿件' : '重新起稿'}` : '另一份稿件正在生成'),
          h('span', null, `${TIER_LABEL[record.tier] || record.tier}${currentProject ? '' : ` · ${record.projectTitle || '未命名项目'}`}`),
        ),
        stepPills(record),
        h('p', { className: 'sv-note' }, currentProject ? '任务已提交，会持续更新步骤；关闭此抽屉不会中断生成。' : '另一份稿件正在生成，本任务不会被中断。'),
      );
      // Archived-account topics have no Tab to host a new run, so they are
      // open-only rather than selectable — a selection the left column cannot
      // show would silently vanish.
      const topicCard = (topic, archived) => h('div', { key: topic.projectId, className: 'sv-tp-cand', 'data-sel': archived ? 'false' : form.targetId === topic.projectId ? 'true' : 'false', ...(archived ? { style: { cursor: 'default' } } : { role: 'button', tabIndex: 0, onClick: () => selectTarget(topic), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectTarget(topic); } } }) },
        h('span', { className: 'sv-tp-cand-head' },
          archived ? null : h('span', { className: 'sv-tp-cand-radio' }, h('i', null)),
          h('span', { className: 'sv-tp-cand-title' }, topic.title),
          h('span', { className: 'sv-sc-state', 'data-state': topic.scriptState }, SCRIPT_STATE_LABEL[topic.scriptState] || '未写稿'),
          archived ? h('span', { className: 'sv-sc-archived' }, `已归档 · ${topic.account?.name || ''}`) : null,
        ),
        h('p', { className: 'sv-tp-cand-meta' }, [topic.angle ? `角度：${topic.angle}` : '角度：未填写', `信号 ${topic.signalCount} 条`, topic.scriptChars ? `已存稿 ${topic.scriptChars} 字` : null, relativeTime(topic.updatedAt)].filter(Boolean).join(' · ')),
        topic.scriptState !== 'none' ? h('div', null, h('button', { type: 'button', className: 'sv-sc-open', onClick: (event) => { event.stopPropagation(); openDraft(topic.projectId); } }, '打开稿件 →')) : null,
      );
      const taskCard = (record) => {
        const score = record.quality?.qualityScore;
        const ready = record.status === 'completed' && Boolean(record.draft?.script);
        const statusTag = record.status === 'running' ? ['运行中', '']
          : record.status === 'failed' ? ['失败', 'sv-status-error']
          : score != null ? [`质检 ${score}`, score >= 80 ? 'sv-stage' : '']
          : ['已完成', 'sv-stage'];
        return h('div', { key: record.id, className: 'sv-tp-task', 'data-status': record.status, 'data-confirmed': ready ? 'true' : 'false' },
          h('div', { className: 'sv-tp-task-head' },
            h('div', null,
              h('p', { className: 'sv-tp-task-title' }, record.projectTitle || record.summary || '写稿生成'),
              h('p', { className: 'sv-tp-task-meta' }, `${relativeTime(record.startedAt)} · 账号：${record.account?.name || '通用'} · ${record.mode === 'polish' ? '润色' : '新起稿'} · ${TIER_LABEL[record.tier] || record.tier}${record.elapsedMs != null ? ` · 耗时 ${(record.elapsedMs / 1000).toFixed(1)}s` : ''}`),
            ),
            h('span', { className: 'sv-tp-task-badges' }, h('span', { className: `sv-tag ${statusTag[1]}` }, statusTag[0])),
          ),
          record.status === 'running' ? stepPills(record) : null,
          ready ? h('div', { className: 'sv-tp-confirmed' },
            h('span', { className: 'sv-tp-confirmed-title' }, 'AI 稿件已保存，可直接进入配音'),
            h('span', { className: 'sv-tp-confirmed-meta' }, `正文 ${charCount(record.draft.script)} 字 · 可按需调整`),
          ) : null,
          h('div', { className: 'sv-tp-task-acts' },
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setOpenSummary(record.id) }, '执行详情'),
            h('button', { type: 'button', className: ready ? 'lwb-primary-button' : 'lwb-plain-button', disabled: !record.projectId, onClick: () => openDraft(record.projectId) }, ready ? '查看稿件' : '打开稿件'),
            record.status === 'failed' ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || projectIsRunning(record.projectId), onClick: () => confirmGeneration({ projectId: record.projectId, mode: record.mode, tier: record.tier, instructions: record.instructions }, '重试写稿任务') }, '重试') : null,
            record.status === 'running' ? h('span', { className: 'sv-note' }, '切换页面不会中断，完成后在此查看稿件。') : null,
          ),
        );
      };

      const pendingByTab = React.useMemo(() => pendingCountByTab(topics), [topics]);
      const tabs = h(AccountTabs, { accountLibrary, activeTab, onChange: selectTab, label: '按账号筛选可写稿选题', tabBadge: pendingByTab });

      const topicArea = tabTopics.length
        ? h(React.Fragment, null,
            h('div', { className: 'sv-list' }, inlineTopics.map((topic) => topicCard(topic, false))),
            hiddenInTab > 0 ? h('button', { type: 'button', className: 'sv-sc-more', onClick: () => setOpenMore(true) }, `还有 ${hiddenInTab} 个 · 查看更多`) : null,
          )
        : h('div', { className: topics.length ? 'sv-empty' : 'sv-empty-cta' }, topics.length ? '当前账号 Tab 暂无可写稿选题，可点「查看更多」浏览其他账号或已归档选题。' : h(React.Fragment, null, h('p', null, '还没有可写稿选题。'), h('p', null, '先到「选题」页生成候选并确认选题，确认后的选题会自动出现在这里。')));

      const configCard = h('section', { className: 'sv-form' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '新建写稿任务'), h('span', null, `当前 Tab · ${tabName}`)),
        tabs,
        h('p', { className: 'sv-tp-acct-note' }, '选题按选题页确认时的账号定位分组；通用 Tab 收录未绑定账号的选题。'),
        h('div', { className: 'sv-section-head' },
          h('h3', null, '可写稿选题'),
          h('span', null, `${tabTopics.length} 个`, canOpenMore ? h('button', { type: 'button', className: 'sv-tp-acct-link', style: { marginLeft: '8px' }, onClick: () => setOpenMore(true) }, '查看更多') : null),
        ),
        topicArea,
        h('label', { className: 'sv-meta' }, '篇幅'),
        h('div', { className: 'sv-sc-seg' }, TIER_OPTIONS.map(([value, name, range]) => h('button', { key: value, type: 'button', 'data-on': form.tier === value ? 'true' : 'false', disabled: projectIsRunning(form.targetId), onClick: () => patchForm((current) => ({ ...current, tier: value })) }, h('strong', null, name), h('span', null, range)))),
        h('label', { className: 'sv-meta' }, '额外要求（可选，≤500 字）'),
        h('textarea', { className: 'sv-textarea', style: { minHeight: '64px' }, value: form.instructions, maxLength: 500, placeholder: '例如：更口语一点、多用例子', disabled: projectIsRunning(form.targetId), onChange: (event) => patchForm((current) => ({ ...current, instructions: event.target.value })) }),
        h('p', { className: 'sv-note' }, form.targetId ? '新起稿依据选题与信号素材生成；生成后在右侧任务列表点「查看稿件」，即可在抽屉里编辑、润色并保存。已有稿件的选题可直接点卡片上的「打开稿件」。' : '先在上方选择一个可写稿选题。'),
        h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || projectIsRunning(form.targetId) || !form.targetId, onClick: generateNew }, projectIsRunning(form.targetId) ? '该项目已有任务…' : '写稿')),
      );

      const historyMatchesAccount = (item) => historyAccount === 'all' || scriptTaskTab(item, activeIds) === historyAccount;
      const activeHistoryTasks = sortScriptTasks(history.filter((item) => historyMatchesAccount(item) && (item.status === 'queued' || item.status === 'running')), historySort);
      const terminalHistoryTasks = history.filter((item) => item.status !== 'queued' && item.status !== 'running');
      const filteredHistoryTasks = sortScriptTasks(terminalHistoryTasks.filter((item) => historyMatchesAccount(item) && (historyFilter === 'all' || item.status === historyFilter)), historySort);
      const historyPages = Math.max(1, Math.ceil(filteredHistoryTasks.length / 6));
      const pagedHistoryTasks = filteredHistoryTasks.slice(historyPage * 6, historyPage * 6 + 6);
      const historyAccountOptions = [...activeAccounts.map((account) => ({ id: account.id, label: account.name })), { id: GENERAL_TAB, label: '通用（无账号定位）' }];
      // 账号被归档后任务不会消失，所以下拉里必须保留「已归档账号」一档，
      // 否则这些任务在按账号筛选时无处可去（只有「全部账号」能看到）。
      const hasArchivedTasks = history.some((item) => scriptTaskTab(item, activeIds) === ARCHIVED_TAB);
      if (hasArchivedTasks) historyAccountOptions.push({ id: ARCHIVED_TAB, label: '已归档账号' });
      const taskPanel = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '写稿任务 · 全部账号'), h('span', null, `${history.filter((item) => item.status === 'running').length} 个运行中 · ${history.filter((item) => item.status === 'queued').length} 个排队中`)),
        activeHistoryTasks.length ? h('div', { className: 'sv-list' }, activeHistoryTasks.map(taskCard)) : null,
        terminalHistoryTasks.length ? h(React.Fragment, null,
          h('div', { className: 'sv-tp-history-tools' },
            h('label', { className: 'sv-tp-history-field' },
              h('span', null, '账号定位'),
              h('select', { className: 'sv-select', value: historyAccount, 'aria-label': '按账号定位筛选写稿任务', onChange: (event) => setHistoryAccount(event.target.value) },
                h('option', { value: 'all' }, '全部账号'),
                historyAccountOptions.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
              ),
            ),
            h('label', { className: 'sv-tp-history-field' },
              h('span', null, '时间排序'),
              h('select', { className: 'sv-select', value: historySort, 'aria-label': '按时间排序写稿任务', onChange: (event) => setHistorySort(event.target.value) },
                h('option', { value: 'newest' }, '最新在前'),
                h('option', { value: 'oldest' }, '最早在前'),
              ),
            ),
          ),
          h('div', { className: 'sv-filter-chips' }, [{ id: 'all', label: '全部' }, { id: 'completed', label: '已完成' }, { id: 'failed', label: '失败' }].map((item) => h('button', { key: item.id, type: 'button', className: 'sv-filter-chip', 'data-on': historyFilter === item.id ? 'true' : 'false', onClick: () => setHistoryFilter(item.id) }, item.label))),
          h('div', { className: 'sv-list' }, pagedHistoryTasks.map(taskCard)),
          h('div', { className: 'sv-audio-pagebar' }, h('span', { className: 'sv-meta' }, `第 ${historyPage + 1}/${historyPages} 页 · 共 ${filteredHistoryTasks.length} 条`), h('span', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '上一页', disabled: historyPage === 0, onClick: () => setHistoryPage((current) => Math.max(0, current - 1)) }, '上一页'), h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '下一页', disabled: historyPage + 1 >= historyPages, onClick: () => setHistoryPage((current) => current + 1) }, '下一页'))),
        ) : !activeHistoryTasks.length ? h('div', { className: 'sv-empty' }, '尚无写稿任务。左侧选择选题后点「写稿」。') : null,
      );

      const candidateScript = latestDraft?.draft?.script || '';
      const readableScript = dirty ? body : savedScript.trim() || candidateScript;
      const showingCandidate = !dirty && !savedScript.trim() && Boolean(candidateScript);
      const reportIsCurrent = Boolean(report && reportBody === readableScript);
      const automaticQuality = latestDraft?.quality || null;
      const automaticReport = automaticQuality?.checks ? automaticQuality : null;
      const automaticReportIsCurrent = Boolean(automaticReport && candidateScript.trim() && candidateScript.trim() === readableScript.trim());
      const visibleReport = reportIsCurrent ? report : automaticReportIsCurrent ? automaticReport : null;
      const visibleReportSource = reportIsCurrent ? 'manual' : automaticReportIsCurrent ? 'automatic' : null;
      const drawerState = approved ? 'approved' : savedScript.trim() ? 'draft' : candidateScript ? 'candidate' : 'none';
      const drawerStateLabel = drawerState === 'candidate' ? '历史 AI 候选稿' : SCRIPT_STATE_LABEL[drawerState];
      const enterEditor = (text = readableScript) => { setBody(text); setDrawerMode('edit'); setScriptModal(null); scrollDrawerTop(); };
      const discardEdits = () => {
        const leave = () => { setBody(savedScript); setDrawerMode('read'); scrollDrawerTop(); };
        if (dirty) {
          ask({ title: '放弃未保存的修改？', danger: true, confirm: '放弃修改', copy: '返回阅读后不会保留本次编辑。', onConfirm: leave });
          return;
        }
        leave();
      };
      const useCandidateForEditing = () => {
        if (!candidateScript) return;
        const adopt = () => { setBody(candidateScript); setDrawerMode('edit'); setScriptModal(null); scrollDrawerTop(); };
        if (dirty) {
          ask({ title: '替换未保存的修改？', danger: true, confirm: '继续编辑此稿', copy: '这会覆盖当前未保存的编辑内容；保存后可直接进入配音。', onConfirm: adopt });
          return;
        }
        adopt();
      };
      const qualityPanel = (quality, source, empty) => h('div', { className: 'sv-sc-report' },
        quality?.checks ? h(React.Fragment, null,
          h('div', { className: 'sv-qa-score' }, h('strong', null, String(quality.qualityScore)), h('em', null, '质检分'), h('span', { className: `sv-tag ${quality.verdict === 'pass' ? 'sv-stage' : 'sv-status-error'}` }, quality.verdict === 'pass' ? '通过' : '建议改写')),
          h('p', { className: 'sv-meta' }, source === 'automatic' ? 'AI 稿件保存完成时已自动质检。' : '根据当前正文重新完成质检。'),
          h('p', { className: 'sv-meta' }, `正文 ${quality.checks.length.scriptChars} 字（${quality.checks.length.lengthTier} 档） · 段落 ${quality.checks.structure.paragraphCount} · 预估口播 ${quality.checks.length.estimatedDurationSeconds}s`),
          h('p', { className: 'sv-meta' }, `对比已有稿件 ${quality.checks.similarity.comparedRecords} 篇 · 原创风险 ${originalityLabel(quality.originalityRisk)}`),
          (quality.checks.similarity.topMatches || []).slice(0, 3).map((match, index) => h('p', { key: index, className: 'sv-meta' }, `· ${match.title || '未命名稿件'}：全文重叠 ${(match.ngramJaccard * 100).toFixed(0)}%，最长相同片段 ${match.longestCommonSubstring.length} 字`)),
          quality.recommendations?.length ? h('ul', { className: 'sv-warn-list' }, quality.recommendations.slice(0, 6).map((item, index) => h('li', { key: index }, item))) : h('p', { className: 'sv-note' }, '无改进建议。'),
        ) : quality ? h(React.Fragment, null,
          h('div', { className: 'sv-qa-score' }, h('strong', null, String(quality.qualityScore)), h('em', null, '质检分'), h('span', { className: `sv-tag ${quality.verdict === 'pass' ? 'sv-stage' : 'sv-status-error'}` }, quality.verdict === 'pass' ? '通过' : '建议改写')),
          h('p', { className: 'sv-sc-report-empty' }, '这是旧记录保留的自动质检摘要；完整明细需对当前正文重新质检。'),
        ) : h('p', { className: 'sv-sc-report-empty' }, empty),
      );
      const reportPanel = qualityPanel(visibleReport, visibleReportSource, report ? '正文已变更，现有报告不再对应当前稿件。请重新质检。' : '尚未质检。质检会检查长度节奏、段落结构、口播表达与已有稿件相似度。');
      const contextContent = h(React.Fragment, null,
        h('section', { className: 'sv-sc-modal-section' },
          h('h5', null, '创作背景'),
          h('div', { className: 'sv-sc-modal-grid' },
            h('div', { className: 'sv-sc-modal-fact' }, h('span', null, '账号'), h('p', null, account?.name || '通用写稿')),
            h('div', { className: 'sv-sc-modal-fact' }, h('span', null, '选题角度'), h('p', null, topicData?.angle || '未填写')),
            account?.positioning ? h('div', { className: 'sv-sc-modal-fact' }, h('span', null, '账号定位'), h('p', null, account.positioning)) : null,
            account?.audience ? h('div', { className: 'sv-sc-modal-fact' }, h('span', null, '目标受众'), h('p', null, account.audience)) : null,
            account?.pillars?.length ? h('div', { className: 'sv-sc-modal-fact' }, h('span', null, '内容方向'), h('p', null, account.pillars.join('、'))) : null,
          ),
        ),
        h('section', { className: 'sv-sc-modal-section' },
          h('h5', null, `素材依据 · ${signalItems.length} 条信号`),
          signalItems.length ? h('div', { className: 'sv-sc-context-list' }, signalItems.map((item) => h('article', { key: item.id, className: 'sv-sc-context-item' }, h('p', null, item.title || item.text), h('span', null, item.source || sourceName(item.sourceId))))) : h('p', { className: 'sv-sc-report-empty' }, '该选题没有可展示的信号依据。'),
        ),
      );
      const tierPicker = (label) => h('label', null, label,
        h('div', { className: 'sv-sc-seg' }, TIER_OPTIONS.map(([value, name, range]) => h('button', { key: value, type: 'button', 'data-on': draftTier === value ? 'true' : 'false', disabled: busy || projectBusy, onClick: () => setDraftTier(value) }, h('strong', null, name), h('span', null, range)))),
      );
      const aiContent = h('div', { className: 'sv-sc-ai-actions' },
        runningRecord ? generationStatus(runningRecord, true) : otherRunningRecord ? generationStatus(otherRunningRecord, false) : null,
        latestDraftMatchesDetail ? h('section', { className: 'sv-sc-ai-action' }, h('div', { className: 'sv-sc-ai-action-head' }, h('strong', null, 'AI 稿件已保存，可直接使用'), h('span', null, `${relativeTime(latestDraft.completedAt || latestDraft.startedAt)} · ${latestDraft.mode === 'polish' ? '润色' : '新起稿'}`))) : null,
        h('section', { className: 'sv-sc-ai-action' },
          h('div', { className: 'sv-sc-ai-action-head' }, h('strong', null, '润色当前稿件'), h('span', null, savedScript.trim() || body.trim() ? (dirty ? '会自动保存当前修改，再基于此润色' : '基于当前稿件') : '需先补充正文')),
          h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || projectBusy || !body.trim(), onClick: () => setScriptModal('polish') }, '润色')),
        ),
        h('section', { className: 'sv-sc-ai-action' },
          h('div', { className: 'sv-sc-ai-action-head' }, h('strong', null, '重新起稿'), h('span', null, '生成完成后会自动替换当前稿件')),
          h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy || projectBusy, onClick: () => setScriptModal('regenerate') }, '重新起稿')),
        ),
      );
      const polishContent = h('form', { className: 'sv-sc-modal-form', onSubmit: (event) => { event.preventDefault(); void startPolish(); } },
        h('p', { className: 'sv-sc-modal-note' }, dirty ? '当前编辑内容会自动保存，再交给 DSH 润色。完成后，润色稿会自动成为当前稿件。' : 'DSH 将基于当前稿件润色，完成后会自动替换为新的稿件版本。'),
        h('p', { className: 'sv-sc-modal-note' }, `待处理正文 ${charCount(body)} 字 · 预估口播 ${scriptDurationLabel(body)}`),
        tierPicker('目标篇幅'),
        h('label', null, '润色要求（可选）', h('textarea', { className: 'sv-textarea', value: polishNote, maxLength: 500, placeholder: '例如：开头更有张力，减少书面表达', disabled: busy || projectBusy, onChange: (event) => setPolishNote(event.target.value) })),
      );
      const regenerateContent = h('form', { className: 'sv-sc-modal-form', onSubmit: (event) => { event.preventDefault(); void startRegenerate(); } },
        h('p', { className: 'sv-sc-modal-note' }, '这会围绕当前选题和创作依据重新起稿。生成完成后会自动保存为当前稿件，并取消此前的稿件确认及下游产物。'),
        tierPicker('新稿篇幅'),
        h('label', null, '新稿要求（可选）', h('textarea', { className: 'sv-textarea', value: regenerateNote, maxLength: 500, placeholder: '例如：改成更冷静的实测口吻', disabled: busy || projectBusy, onChange: (event) => setRegenerateNote(event.target.value) })),
      );
      const candidateContent = h(React.Fragment, null,
        h('p', { className: 'sv-sc-candidate-copy' }, `这份历史候选稿生成于 ${relativeTime(latestDraft?.completedAt || latestDraft?.startedAt)}。选择“以此版本继续编辑”后即可保存并进入配音。`),
        h('article', { className: 'sv-sc-manuscript', 'data-candidate': 'true' }, candidateScript),
        latestDraft?.draft?.needsVerification?.length ? h('section', { className: 'sv-sc-fact-check' }, h('strong', null, `待核实 ${latestDraft.draft.needsVerification.length} 项`), h('ul', null, latestDraft.draft.needsVerification.map((item, index) => h('li', { key: index }, item)))) : null,
        automaticQuality ? h('section', { className: 'sv-sc-auto-quality' }, h('p', null, '自动质检结果'), qualityPanel(automaticQuality, 'automatic', '')) : null,
      );
      const qualityContent = h(React.Fragment, null,
        h('p', { className: 'sv-sc-modal-note' }, `检查对象：当前${drawerMode === 'edit' ? '编辑中' : '阅读中'}的正文 · ${charCount(readableScript)} 字 · 预估口播 ${scriptDurationLabel(readableScript)}`),
        visibleReportSource === 'automatic' ? h('p', { className: 'sv-sc-modal-note' }, '以下为生成完成时已自动产出的结果，无需再次运行；可按需重新质检。') : null,
        reportBusy ? h('p', { className: 'sv-note' }, '正在分析长度、结构、口播表达与相似度，请稍候。') : null,
        reportPanel,
      );
      const modalConfig = scriptModal === 'context'
        ? { title: '创作依据', copy: '账号定位、选题角度与本次写稿使用的信号素材。', content: contextContent }
        : scriptModal === 'ai'
          ? { title: 'AI 调整', copy: '每个动作都会先说明影响范围，再由你确认提交。', content: aiContent }
          : scriptModal === 'polish'
            ? { title: '润色当前稿件', copy: '生成完成后会自动保存为当前稿件版本。', content: polishContent }
          : scriptModal === 'regenerate'
              // 覆盖性操作必须把后果说全：确认掉的稿件、配音、字幕、成片都会失效。
              ? { title: '重新起稿', copy: `将围绕当前选题重新生成一稿，并自动替换当前稿件版本${detail?.artifacts?.script?.revision ? `（当前版本 ${detail.artifacts.script.revision}）` : ''}。此前的稿件确认与下游产物（配音、字幕、成片、发布资料）会一并失效，需要重新生成。此操作不可撤销。`, content: regenerateContent }
              : scriptModal === 'candidate'
                ? { title: '未采用的新稿', copy: '这是一份与当前正式稿不同的候选版本。', content: candidateContent }
                : scriptModal === 'quality'
                  ? { title: visibleReport ? '稿件质检报告' : '开始稿件质检', copy: '质检不会修改正文，只生成当前版本的诊断报告。', content: qualityContent }
                  : null;
      const closeScriptModal = () => { if (!reportBusy) setScriptModal(null); };
      const scriptModalFoot = scriptModal === 'polish'
        ? h(React.Fragment, null, h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy || saving || projectBusy, onClick: closeScriptModal }, '取消'), h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || saving || projectBusy || !body.trim(), onClick: () => { void startPolish(); } }, '开始润色'))
        : scriptModal === 'regenerate'
          ? h(React.Fragment, null, h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy || saving || projectBusy, onClick: closeScriptModal }, '取消'), h('button', { type: 'button', className: 'lwb-danger-button', disabled: busy || saving || projectBusy, onClick: () => { void startRegenerate(); } }, '覆盖当前稿件，开始生成'))
          : scriptModal === 'candidate'
            ? h(React.Fragment, null, h('button', { type: 'button', className: 'lwb-plain-button', onClick: closeScriptModal }, '关闭'), h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || projectBusy, onClick: useCandidateForEditing }, '以此版本继续编辑'))
            : scriptModal === 'quality'
              ? h(React.Fragment, null, h('button', { type: 'button', className: 'lwb-plain-button', disabled: reportBusy, onClick: closeScriptModal }, visibleReport ? '关闭' : '取消'), h('button', { type: 'button', className: 'lwb-primary-button', disabled: reportBusy || !readableScript.trim(), onClick: () => { void analyze(readableScript); } }, reportBusy ? '正在质检…' : visibleReport ? '重新质检' : '开始质检'))
              : h('button', { type: 'button', className: 'lwb-primary-button', onClick: closeScriptModal }, '完成');
      const runStatus = runningRecord ? generationStatus(runningRecord, true) : otherRunningRecord ? generationStatus(otherRunningRecord, false) : null;
      const automaticQualityPanel = automaticReportIsCurrent && !reportIsCurrent ? h('section', { className: 'sv-sc-auto-quality' }, h('p', null, '自动质检结果'), reportPanel) : null;
      const scriptView = drawerMode === 'edit'
        ? h('div', { className: 'sv-sc-drawer-body' },
            runStatus,
            h('div', { className: 'sv-sc-editor' },
              h('div', { className: 'sv-sc-editor-label' }, h('strong', null, '编辑稿件'), h('span', null, `${charCount(body)} 字（不含空白） · 预估口播 ${scriptDurationLabel(body)}`)),
              h('textarea', { ref: editorRef, className: 'sv-textarea', value: body, maxLength: 30000, placeholder: '编写可口播、可审阅的脚本正文', disabled: projectBusy, onChange: (event) => setBody(event.target.value), onInput: (event) => { event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; } }),
            ),
          )
          : h('div', { className: 'sv-sc-drawer-body' },
            runStatus,
            readableScript.trim()
              ? h('article', { className: 'sv-sc-manuscript', 'data-candidate': showingCandidate ? 'true' : 'false' }, readableScript)
              : h('div', { className: 'sv-sc-empty-manuscript' }, h('p', null, '还没有稿件正文。'), h('button', { type: 'button', className: 'lwb-primary-button', onClick: () => enterEditor('') }, '开始写稿')),
            automaticQualityPanel,
          );
      const scriptModalNode = detail && modalConfig && h('div', { className: 'sv-sc-modal-backdrop', role: 'presentation', onClick: closeScriptModal },
        h('section', { className: 'sv-sc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': modalConfig.title, onClick: (event) => event.stopPropagation() },
          h('div', { className: 'sv-sc-modal-head' }, h('div', { className: 'sv-sc-modal-title' }, h('h4', null, modalConfig.title), h('p', null, modalConfig.copy)), h('button', { type: 'button', className: 'sv-ghost-btn', title: '关闭', 'aria-label': '关闭', disabled: reportBusy, onClick: closeScriptModal }, '×')),
          h('div', { className: 'sv-sc-modal-scroll' }, modalConfig.content),
          h('div', { className: 'sv-sc-modal-foot' }, scriptModalFoot),
        ),
      );
      const draftDrawer = detail && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: closeDraft }),
        h('aside', { className: 'sv-drawer sv-drawer-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': `稿件 · ${detail.title}` },
          h('div', { className: 'sv-drawer-head sv-sc-drawer-head' },
            h('div', { className: 'sv-sc-drawer-title' },
              h('div', { className: 'sv-sc-drawer-titleline' }, h('h3', null, detail.title), h('span', { className: 'sv-sc-state', 'data-state': drawerState }, drawerStateLabel), dirty ? h('span', { className: 'sv-tag' }, '未保存') : null),
              h('p', { className: 'sv-sc-drawer-meta' }, `${charCount(readableScript)} 字 · 预估口播 ${scriptDurationLabel(readableScript)}`),
            ),
            h('div', { className: 'sv-sc-drawer-tools' },
              h('button', { type: 'button', className: 'sv-sc-drawer-tool', 'data-tone': 'context', 'data-active': scriptModal === 'context', onClick: () => setScriptModal('context') }, `创作依据${signalItems.length ? ` · ${signalItems.length}` : ''}`),
              h('button', { type: 'button', className: 'sv-sc-drawer-tool', 'data-tone': 'ai', 'data-active': scriptModal === 'ai' || scriptModal === 'candidate' || scriptModal === 'polish' || scriptModal === 'regenerate', onClick: () => setScriptModal('ai') }, 'AI 调整'),
              h('button', { type: 'button', className: 'sv-sc-drawer-tool', 'data-tone': 'quality', 'data-active': scriptModal === 'quality', disabled: !readableScript.trim(), onClick: () => setScriptModal('quality') }, reportBusy ? '质检中…' : '质检'),
              h('button', { type: 'button', className: 'sv-ghost-btn', title: '关闭', 'aria-label': '关闭', onClick: closeDraft }, '×'),
            ),
          ),
          h('div', { ref: drawerScrollRef, className: 'sv-drawer-scroll' }, scriptView),
          h('div', { className: 'sv-tp-drawer-foot' },
            drawerMode === 'edit' ? h(React.Fragment, null,
              h('p', { className: 'sv-sc-gate-note' }, dirty ? '保存当前修改并进入配音' : '当前稿件可直接进入配音'),
              h('span', { style: { display: 'flex', gap: '8px', flex: 'none' } }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: saving || anyRunning, onClick: discardEdits }, '取消编辑'), h('button', { type: 'button', className: 'lwb-primary-button sv-sc-approve', disabled: busy || saving || projectBusy || !body.trim(), onClick: approve }, busy || saving ? '正在处理…' : dirty ? '保存并进入配音' : '进入配音')),
            ) : approved ? h(React.Fragment, null,
              h('div', { className: 'sv-sc-ritual' }, h('div', { className: 'sv-sc-ritual-info' }, h('strong', null, '稿件已保存 · 可进入配音'), h('span', null, `版本 ${detail.artifacts?.script?.revision || '—'}`))),
              h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => enterEditor(readableScript) }, '编辑稿件'),
            ) : h(React.Fragment, null,
              h('p', { className: 'sv-sc-gate-note' }, savedScript.trim() ? '已保存，可直接进入配音' : showingCandidate ? '历史 AI 候选稿尚未保存' : '尚未保存稿件'),
              h('span', { style: { display: 'flex', gap: '8px', flex: 'none' } },
                h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => enterEditor(readableScript) }, '编辑稿件'),
                savedScript.trim() ? h('button', { type: 'button', className: 'lwb-primary-button sv-sc-approve', disabled: busy || saving || projectBusy, onClick: approve }, '进入配音') : null,
              ),
            ),
          ),
        ),
      );

      const matchesMore = (topic) => {
        if (moreFilter !== 'all' && topic.scriptState !== moreFilter) return false;
        const q = moreQuery.trim().toLowerCase();
        if (q && !`${topic.title}\n${topic.angle || ''}`.toLowerCase().includes(q)) return false;
        return true;
      };
      const scopedAll = topics.filter((topic) => tabOf(topic) === activeTab);
      const chipCount = (state) => scopedAll.filter((topic) => topic.scriptState === state).length;
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const moreScoped = sortTopics(scopedAll.filter(matchesMore));
      const moreRecent = moreScoped.filter((topic) => Date.parse(topic.updatedAt) >= weekAgo);
      const moreEarlier = moreScoped.filter((topic) => Date.parse(topic.updatedAt) < weekAgo);
      const moreArchived = archivedTopics.filter(matchesMore);
      const moreChip = (id, label) => h('button', { key: id, type: 'button', className: 'sv-filter-chip', 'data-on': moreFilter === id ? 'true' : 'false', onClick: () => setMoreFilter(id) }, label);
      const moreDrawer = openMore && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: () => setOpenMore(false) }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '全部可写稿选题' },
          h('div', { className: 'sv-drawer-head' },
            h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, `全部可写稿选题 · ${tabName}`), h('p', { className: 'sv-meta' }, `当前账号 ${scopedAll.length} 个${moreArchived.length ? ` · 已归档 ${moreArchived.length} 个` : ''} · 点卡片选为新建目标，点「打开稿件」进入编辑`)),
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setOpenMore(false) }, '关闭'),
          ),
          h('div', { className: 'sv-drawer-scroll' },
            h('div', { className: 'sv-drawer-tools' },
              moreChip('all', `全部 ${scopedAll.length}`), moreChip('none', `未写稿 ${chipCount('none')}`), moreChip('approved', `已保存 ${chipCount('approved')}`),
              h('input', { className: 'sv-drawer-search', value: moreQuery, maxLength: 120, placeholder: '搜索标题 / 角度', onChange: (event) => setMoreQuery(event.target.value) }),
            ),
            moreScoped.length || moreArchived.length ? h(React.Fragment, null,
              moreRecent.length ? h(React.Fragment, null, h('p', { className: 'sv-group-title' }, `本周 ${moreRecent.length}`), h('div', { className: 'sv-drawer-list' }, moreRecent.map((topic) => topicCard(topic, false)))) : null,
              moreEarlier.length ? h(React.Fragment, null, h('p', { className: 'sv-group-title', 'data-tone': 'muted' }, `更早 ${moreEarlier.length}`), h('div', { className: 'sv-drawer-list' }, moreEarlier.map((topic) => topicCard(topic, false)))) : null,
              moreArchived.length ? h(React.Fragment, null, h('p', { className: 'sv-group-title', 'data-tone': 'muted' }, `已归档账号 ${moreArchived.length} · 仅可打开稿件，不能作为新建目标`), h('div', { className: 'sv-drawer-list' }, moreArchived.map((topic) => topicCard(topic, true)))) : null,
            ) : h('div', { className: 'sv-empty' }, '没有符合筛选条件的选题。'),
          ),
        ),
      );

      const summaryRecord = history.find((item) => item.id === openSummary) || null;
      const summaryDrawer = summaryRecord && h(ExecutionDrawer, { key: summaryRecord.id, request: { kind: 'script', id: summaryRecord.id }, onClose: () => setOpenSummary(null) });

      const draftCount = topics.filter((topic) => topic.scriptState === 'draft').length;
      const approvedCount = topics.filter((topic) => topic.scriptState === 'approved').length;
      const hero = h(HeroMini, { cells: [{ label: '可写稿选题', value: String(topics.length), tone: 'brand' }, { label: '已保存稿件', value: String(draftCount + approvedCount), tone: 'green' }, { label: '当前账号', value: tabName, tone: 'brand' }, { label: '生成状态', value: anyRunning ? '生成中' : '空闲', tone: anyRunning ? 'brand' : 'green' }] });

      return h(PackFrame, { packId, openConversation, title: '写稿', accent: 'violet', copy: '按账号定位分 Tab；左侧选择可写稿选题、篇幅与额外要求交给 DSH 写稿，右侧是任务列表。AI 生成的稿件会自动保存并可直接进入配音；编辑后用“保存并进入配音”一次完成。切换页面不会中断生成。', hero },
        h(Notice, { error: error || detailError }),
        h('section', { className: 'sv-split' }, configCard, taskPanel),
        moreDrawer,
        draftDrawer,
        scriptModalNode,
        summaryDrawer,
        confirmNode,
      );
    }

    function AudioCaptionsPage({ packId, openConversation }) {
      const { projects, refresh, error, setError } = useProjects(packId); const candidates = projects.filter((project) => project.completedStages.includes('script') && project.scriptApproval?.current); const [selectedId, setSelectedId] = useSelectedProject(projects, (project) => project.completedStages.includes('script') && project.scriptApproval?.current); const { detail, error: detailError, reload } = useDetail(packId, selectedId); const { saving, commit } = useCommit(packId, refresh, reload, setError); const [voiceover, setVoiceover] = React.useState(''), [subtitles, setSubtitles] = React.useState('');
      React.useEffect(() => { setVoiceover(stageData(detail, 'voiceover')?.notes || ''); setSubtitles(stageData(detail, 'subtitles')?.srt || ''); }, [detail?.id, detail?.revision]); if (!packId) return h(NeedPack, { openConversation });
      const subtitleData = stageData(detail, 'subtitles'); const subtitleWarnings = subtitleData?.warnings || [];
      const scriptBody = stageData(detail, 'script')?.body || '';
      return h('div', { className: 'sv-page' }, h(Intro, { title: '配音 / 字幕', copy: '只接受已在写稿页确认的口播稿；稿件更新后需重新确认。TTS、ASR 和音频资产必须由已获批的 DSH 工具接入；未接入时可以保存人工配音说明和校对后的 SRT。' }), h(Notice, { error: error || detailError }), h('section', { className: 'sv-layout' }, h('section', { className: 'sv-section' }, h('div', { className: 'sv-section-head' }, h('h3', null, '已确认稿件的项目'), h('span', null, `${candidates.length} 个`)), h(ProjectList, { projects: candidates, selectedId, onSelect: setSelectedId, empty: '请先在写稿页保存并确认稿件。' })), detail ? h('div', { className: 'sv-section' }, scriptBody ? h('details', { className: 'sv-form', open: false }, h('summary', null, `口播稿（${[...scriptBody].length} 字，来自写稿阶段）`), h('p', { className: 'sv-basis-text' }, scriptBody)) : null, h('form', { className: 'sv-form', onSubmit: (event) => { event.preventDefault(); void commit(detail, 'voiceover', { notes: voiceover }); } }, h('h3', null, '配音'), h('p', { className: 'sv-note' }, '记录人工录音位置、音色、语速，或由获批工具生成的音频资产引用。'), h('textarea', { className: 'sv-textarea', value: voiceover, maxLength: 6000, placeholder: '配音说明或音频资产引用', onChange: (event) => setVoiceover(event.target.value) }), h('div', { className: 'sv-actions' }, h('button', { type: 'submit', className: 'lwb-primary-button', disabled: saving || !voiceover.trim() }, saving ? '正在保存…' : '保存配音产物'))), h('form', { className: 'sv-form', onSubmit: (event) => { event.preventDefault(); void commit(detail, 'subtitles', { srt: subtitles }); } }, h('h3', null, '字幕'), h('textarea', { className: 'sv-textarea', value: subtitles, maxLength: 30000, placeholder: '粘贴或编辑经校对的 SRT 字幕（序号、时间码、文本）', onChange: (event) => setSubtitles(event.target.value) }), subtitleData ? h('p', { className: 'sv-meta' }, `当前已保存 ${subtitleData.cueCount ?? '?'} 条字幕${subtitleWarnings.length ? `，${subtitleWarnings.length} 条规格警告` : ''}`) : null, subtitleWarnings.length ? h('ul', { className: 'sv-warn-list' }, subtitleWarnings.map((warning, index) => h('li', { key: index }, warning))) : null, h('div', { className: 'sv-actions' }, h('button', { type: 'submit', className: 'lwb-primary-button', disabled: saving || !subtitles.trim() }, saving ? '正在保存…' : '保存字幕')))) : h('div', { className: 'sv-empty' }, '选择项目后配置配音与字幕。')));
    }

    function VideoPreviewPage({ packId, openConversation }) {
      const { projects, refresh, error, setError } = useProjects(packId); const candidates = projects.filter((project) => project.completedStages.includes('subtitles')); const [selectedId, setSelectedId] = useSelectedProject(projects, (project) => project.completedStages.includes('subtitles')); const { detail, error: detailError, reload } = useDetail(packId, selectedId); const { saving, commit } = useCommit(packId, refresh, reload, setError); const [visualBrief, setVisualBrief] = React.useState(''), [checks, setChecks] = React.useState({ script: false, voiceover: false, subtitles: false, video: false }), [notes, setNotes] = React.useState('');
      React.useEffect(() => { setVisualBrief(stageData(detail, 'video')?.visualBrief || ''); setChecks(stageData(detail, 'qc')?.checks || { script: false, voiceover: false, subtitles: false, video: false }); setNotes(stageData(detail, 'qc')?.notes || ''); }, [detail?.id, detail?.revision]); if (!packId) return h(NeedPack, { openConversation });
      const upstreamPresent = ['script', 'voiceover', 'subtitles'].every((stage) => done(detail, stage)); const upstreamMissing = ['script', 'voiceover', 'subtitles'].filter((stage) => !done(detail, stage));
      return h('div', { className: 'sv-page' }, h(Intro, { title: '视频 / 预览', copy: '记录画面模板、素材和渲染版本，并在发布前完成质检。真实视频预览必须由获批的渲染适配器写入。' }), h(Notice, { error: error || detailError }), h('section', { className: 'sv-layout' }, h('section', { className: 'sv-section' }, h('div', { className: 'sv-section-head' }, h('h3', null, '待制作项目'), h('span', null, `${candidates.length} 个`)), h(ProjectList, { projects: candidates, selectedId, onSelect: setSelectedId, empty: '请先完成配音和字幕。' })), detail ? h('div', { className: 'sv-section' }, h('form', { className: 'sv-form', onSubmit: (event) => { event.preventDefault(); void commit(detail, 'video', { visualBrief }); } }, h('h3', null, '视频制作与预览'), h('details', { className: 'sv-form', open: false }, h('summary', null, `口播稿（${[...(stageData(detail, 'script')?.body || '')].length} 字）`), h('p', { className: 'sv-basis-text' }, stageData(detail, 'script')?.body || '尚未写稿。')), h('p', { className: 'sv-note' }, `配音说明：${stageData(detail, 'voiceover')?.notes || '尚未保存。'}`), stageData(detail, 'subtitles') ? h('p', { className: 'sv-meta' }, `字幕：${stageData(detail, 'subtitles').cueCount ?? '?'} 条${stageData(detail, 'subtitles').warnings?.length ? `，${stageData(detail, 'subtitles').warnings.length} 条规格警告` : ''}`) : null, h('textarea', { className: 'sv-textarea', value: visualBrief, maxLength: 6000, placeholder: '模板、素材、镜头、版式和渲染产物引用', onChange: (event) => setVisualBrief(event.target.value) }), h('div', { className: 'sv-actions' }, h('button', { type: 'submit', className: 'lwb-primary-button', disabled: saving || !visualBrief.trim() }, saving ? '正在保存…' : '保存视频版本'))), done(detail, 'video') && h('form', { className: 'sv-form', onSubmit: (event) => { event.preventDefault(); void commit(detail, 'qc', { checks, notes }); } }, h('h3', null, '质检'), upstreamPresent ? h('p', { className: 'sv-note' }, '自动核对：稿件、配音、字幕、画面说明四个上游产物齐备。') : h('p', { className: 'sv-error' }, `上游产物缺失：${upstreamMissing.map((stage) => LABEL[stage]).join('、')}。`), h('div', { className: 'sv-checks' }, ['script', 'voiceover', 'subtitles', 'video'].map((name) => h('label', { key: name }, h('input', { type: 'checkbox', checked: checks[name] === true, onChange: (event) => setChecks((current) => Object.assign({}, current, { [name]: event.target.checked })) }), LABEL[name]))), h('textarea', { className: 'sv-textarea', value: notes, maxLength: 2000, placeholder: '质检备注（可选）', onChange: (event) => setNotes(event.target.value) }), h('div', { className: 'sv-actions' }, h('button', { type: 'submit', className: 'lwb-primary-button', disabled: saving || !upstreamPresent || !Object.values(checks).every(Boolean) }, saving ? '正在保存…' : '确认质检通过')))) : h('div', { className: 'sv-empty' }, '选择项目后管理视频版本。')));
    }

    const AS_WEEKDAYS = [{ day: 1, label: '周一' }, { day: 2, label: '周二' }, { day: 3, label: '周三' }, { day: 4, label: '周四' }, { day: 5, label: '周五' }, { day: 6, label: '周六' }, { day: 7, label: '周日' }];
    const AS_DEPTHS = [
      { id: 'topic', label: '选题', copy: '生成候选、建项目并加入待写稿' },
      { id: 'script', label: '写稿', copy: '再自动起稿并保存版本，稿件留待人工确认' },
      { id: 'video', label: '成片 + 质检', copy: '再配音、字幕、渲染成片并通过质检' },
      { id: 'packaging', label: '发布资料', copy: '再生成标题文案标签与横竖封面' },
      { id: 'publish', label: '投递到平台', copy: '再把成片投递到平台账号，默认停在发布前' },
    ];
    const AS_APPROVING = new Set(['video', 'packaging', 'publish']);
    const AS_STEPS = { topic: '选题', script: '写稿', approve: '确认稿件', voiceover: '配音', subtitles: '字幕', video: '成片质检', packaging: '发布资料', publish: '投递到平台' };
    const AS_TIERS = [{ id: 'short', label: '短（300-999 字）' }, { id: 'medium', label: '中（1000-2499 字）' }, { id: 'long', label: '长（2500 字以上）' }];
    /**
     * 配音渠道白名单：只显示小米 MiMo 一个。
     *
     * 这里是**唯一来源**——四处选择器（项目页连接抽屉、配音页渠道条、配音页
     * 连接抽屉、历史任务标签）都从这里取。以前每处各写一份 `['bailian','scitiger']`，
     * 改一次漏一处就会出现「UI 上没有这个渠道但代码还在往它传 id」。
     *
     * 代码里百炼 / SciTiger / 自定义 TTS 三条渠道**保留不删**（后端仍是多 provider），
     * 只是不再出现在 UI 上。把「只有 mimo」写成常量而不是把其余分支删干净，是为了
     * 以后要恢复某个渠道时不必从版本历史里捞代码。
     */
    const SV_VOICE_PROVIDER = 'mimo';
    const SV_VOICE_PROVIDERS = [SV_VOICE_PROVIDER];
    const SV_VOICE_PROVIDER_LABEL = { mimo: '小米 MiMo' };
    // 历史任务仍可能带着已退役渠道的 provider 值；老数据照实回显，不静默改写。
    const SV_RETIRED_PROVIDER_LABEL = { bailian: '百炼 BYOK', scitiger: '远端 · SciTiger', legacy: '兼容 TTS' };
    function voiceProviderLabel(id, loopback = false) {
      const value = String(id || '').trim();
      if (!value) return null;
      if (value === 'scitiger' && loopback) return '本机桥接';
      return SV_VOICE_PROVIDER_LABEL[value] || SV_RETIRED_PROVIDER_LABEL[value] || value;
    }
    // MiMo 云端的内置音色表；随 mediaStatus 一并返回（service.mimoVoices），
    // 取不到时退回这份实测值，保证下拉不是空的。
    // 官方共 9 个。**顺序必须与后端 MIMO_VOICES 逐字一致**（后端会拿这张表做
    // deepEqual 对齐），别为了好看重排。
    // 另外**不要把 mimo_default 当默认音色**：它有集群差异（中国→冰糖，
    // 其他→Mia），同一份配置换个集群就换一个声音且不报错。默认见 SV_MIMO_DEFAULT_VOICE。
    const SV_MIMO_BUILTIN_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
    /**
     * 默认音色。
     *
     * 取运维配置的默认音色，**它配的是什么就用什么**——不能在前端硬编码
     * 「永远是冰糖」把运维配的默认值整个忽略掉（后端已因为这个思路被打回过一次）。
     * 唯一要拦的是 `mimo_default` 本身：它随集群变，当默认音色等于没定，
     * 所以退到中国集群的实际音名「冰糖」。
     *
     * 注意 mediaStatus 里的 `defaultVoice` 是**音色档案对象**（{id,name}），
     * 不是音名字符串，直接 String() 会得到 "[object Object]"；所以这里只认
     * 字符串形态，读不到就回落冰糖，而不是把对象当音名传下去。
     */
    function svDefaultVoice(service) {
      const raw = service?.providers?.mimo?.defaultVoice ?? service?.mimoDefaultVoice ?? SV_MIMO_DEFAULT_VOICE;
      const configured = typeof raw === 'string' ? raw.trim() : '';
      if (configured && configured !== 'mimo_default' && SV_MIMO_BUILTIN_VOICES.includes(configured)) return configured;
      return SV_MIMO_DEFAULT_VOICE;
    }
    /** 冻结常量形式：没有 service 时（排期页初值、单测）用中国集群音名。 */
    const SV_MIMO_DEFAULT_VOICE = '冰糖';
    /**
     * 内置音色的性格说明。
     *
     * 「小米音色」以前是一个自由输入框，光填「茉莉」两个字没法判断该怎么搭
     * 语气，写稿时只能一个个试。这一栏把它变成下拉并附一句说明，选之前就知道
     * 这个声音大致是什么调子。
     *
     * 只覆盖实测存在的音名；不在表里的（比如后端以后加了新的）照样进下拉，
     * 只是没有说明——不能因为说明表没更新就把新音色挡在门外。
     */
    /** 下拉里只显示中文名与说明，内部 id（mimo_default 等）只作为 value 传输。 */
    const voiceDisplayName = (voice) => (voice === 'mimo_default' ? '平台默认（随集群不同）' : voice);
    const SV_MIMO_VOICE_HINTS = {
      '冰糖': '偏甜的年轻女声，适合生活方式、好物与轻松话题',
      '茉莉': '中性偏稳的女声，知识讲解与资讯播报都比较稳',
      '苏打': '清亮活泼，适合快节奏口播与开场引入',
      '白桦': '沉稳男声，适合观点表达、深度解读与结论段',
      'Mia': '英文音色，音色偏年轻明亮，适合英文口播与短内容',
      'Chloe': '英文音色，中性自然，适合英文讲解与叙事',
      'Milo': '英文音色，轻松活泼，适合英文种草与开场',
      'Dean': '英文音色，沉稳成年男声，适合英文观点与结论段',
      'mimo_default': '平台默认音色，有集群差异：中国集群是「冰糖」，其他集群是「Mia」。想要确定的声音请直接选音名。',
    };
    /** 音色按语种分组显示，避免中英文混在一列里让人误以为英文音是中文音的变体。 */
    const SV_MIMO_VOICE_GROUPS = [
      { label: '中文音色', voices: ['冰糖', '茉莉', '苏打', '白桦'] },
      { label: '英文音色', voices: ['Mia', 'Chloe', 'Milo', 'Dean'] },
      { label: '平台默认（随集群不同）', voices: ['mimo_default'] },
    ];

    /**
     * 三种合成模式，互斥不可混用（官方明确）：
     *   preset 预置音色（唯一支持唱歌的模式）
     *   design 用一句文字描述设计音色，描述必填
     *   upload  上传参考音频复刻
     * 值就是后端 `voiceSource` 的取值，不再另造一套 mode 字段。
     */
    const SV_VOICE_MODES = [
      { id: 'preset', label: '预置音色', hint: '用小米官方预置音色，可选唱歌。' },
      { id: 'design', label: '音色设计', hint: '用一段文字描述你想要的声音，每次生成一个新音色。' },
      { id: 'upload', label: '声音克隆', hint: '上传一段参考音频，复刻说话人。只支持 wav / mp3。' },
    ];
    /**
     * 音色设计的优质预设。
     *
     * 设计模式的唯一输入就是一句描述，而「描述越具体出来的声音越接近」——
     * 可大多数人对着空白输入框写不出「三十五岁、中低频、气声少、尾音收得住」
     * 这种话，最后只能写「好听的男声」，出来的结果自然随机。这一组把实测好用
     * 的写法固化成可点的卡片：点一下即填满描述框，再按需微调。
     *
     * 三条硬约束，改表时别破：
     *  · `text` 是**直接提交给模型的描述本身**，不是提示词包装。别写「请生成一位…」
     *    这种指令句，那段文字是要被当成音色定义读的。
     *  · 长度 ≤200，且 ≤ SV_DESIGN_TEXT_MAX：输入框与后端校验都是这个上限，
     *    预设超了会当场被截断或提交失败。
     *  · 只写**声音本身的客观属性**（年龄 / 性别 / 音区 / 音色 / 语速 / 咬字 / 气质），
     *    不写文案主题或情绪剧情——那是「语气」栏的活，两栏混写会互相打架。
     *
     * 顺序按使用频率排：口播最常用的解说、播报、种草放前面。
     */
    const SV_DESIGN_VOICE_PRESETS = [
      { id: 'male-narrator', label: '磁性男声解说', text: '三十五岁左右的男声，中低音区，音色厚实带轻微沙哑，语速偏慢，咬字清晰沉稳，尾音收得住，像做了多年纪录片的解说员。' },
      { id: 'female-news', label: '标准女声播报', text: '三十岁左右的女声，中高音区，音色干净明亮，语速中等偏快，吐字利落有顿挫，气息稳，像电视台的新闻播报员。' },
      { id: 'female-seeding', label: '闺蜜种草女声', text: '二十五岁上下的女声，音色甜美柔和，语速偏快，说话带笑意和轻微的气声，像好朋友面对面安利东西。' },
      { id: 'male-knowledge', label: '知识博主男声', text: '三十岁出头的男声，中音区，音色清爽不厚重，语速中等，讲解时条理清楚、句间留有停顿，像在镜头前讲干货的科普博主。' },
      { id: 'radio-night', label: '深夜电台', text: '四十岁左右的男声，中低音区，音色温润微哑，语速很慢，气声明显，句尾自然下沉，像深夜电台节目里贴着话筒说话。' },
      { id: 'female-warm', label: '温柔故事女声', text: '三十岁左右的女声，中低音区，音色柔和不甜腻，语速缓慢平稳，语调轻柔有起伏，适合安静地讲一个故事。' },
      { id: 'male-strong', label: '沉稳评论男声', text: '四十岁上下的男声，低音区，音色浑厚有力，语速中等偏慢，重音明确、不拖泥带水，像严肃节目的评论员。' },
      { id: 'female-lively', label: '元气少女', text: '二十岁出头的女声，高音区偏亮，音色活泼有弹性，语速快，语气跳跃带笑意，句尾微微上扬。' },
      { id: 'male-enthusiastic', label: '热情带货男声', text: '三十岁左右的男声，中高音区，音色明亮有冲劲，语速快，重音密集，情绪饱满上扬，像直播间里带节奏的主播。' },
      { id: 'female-tech', label: '干练职场女声', text: '三十五岁左右的女声，中音区，音色干练中性，语速中等，表达简洁直接、少语气词，像职场汇报或产品介绍。' },
      { id: 'teen-male', label: '清爽少年音', text: '十八岁上下的男声，中高音区，音色干净清瘦，语速中等偏快，语气自然松弛，带一点少年的往上扬的尾音。' },
      { id: 'en-anchor', label: '英文新闻主播', text: 'A male English narrator in his forties, warm mid-low register, steady medium-slow pace, crisp articulation, neutral American accent, like a broadcast news anchor.' },
    ];
    /** 音色描述的长度上限。输入框 maxLength 与后端 optionalText(...,500) 都以此为准。 */
    const SV_DESIGN_TEXT_MAX = 200;
    /** 描述按 id 查预设，用于回显「当前用的是哪个预设」。 */
    const SV_DESIGN_PRESET_BY_TEXT = new Map(SV_DESIGN_VOICE_PRESETS.map((preset) => [preset.text, preset.id]));
    function svVoiceDesignPresetLabel(text) {
      const id = SV_DESIGN_PRESET_BY_TEXT.get(String(text || '').trim());
      if (!id) return null;
      const preset = SV_DESIGN_VOICE_PRESETS.find((item) => item.id === id);
      return preset ? preset.label : null;
    }
    /**
     * 音色设计描述预设选择器。
     *
     * 点一下填满描述框，再点一下同一个预设就清空——和「常用语气」的 chip 同手感。
     * 一页两处（配音页、排期页）共用，免得两边各写一份后行为分叉。
     */
    function svVoiceDesignPresets({ value, disabled, onChange, className }) {
      return h('div', { className: `sv-style-presets sv-design-presets${className ? ` ${className}` : ''}` },
        h('span', { className: 'sv-meta' }, '优质预设'),
        SV_DESIGN_VOICE_PRESETS.map((preset) => h('button', {
          key: preset.id,
          type: 'button',
          className: 'sv-filter-chip',
          title: preset.text,
          'data-on': value === preset.text ? 'true' : 'false',
          disabled: Boolean(disabled),
          onClick: () => onChange(value === preset.text ? '' : preset.text),
        }, preset.label)),
      );
    }
    /** 唱歌只挂在预置音色模型上，另两个模型会直接 400，所以 UI 上先拦住。 */
    const SV_SINGING_MODES = ['preset'];

    /**
     * 音频标签预设组。
     *
     * 官方是**两套语法**，而两套的**归属不同**（后端 buildTaggedText / countInlineAudioTags）：
     *  · `(风格)` 放开头，是**整篇什么调子** —— 由后端 `buildTaggedText` 拼进正文，
     *    前端只传 `audioTags` 数组，**绝不把它写进正文文本框**（写进去会被
     *    countInlineAudioTags 当成用户内容，下次生成时还会跟着稿子累积）。
     *  · `[音频标签]` 放句中，是**细粒度表演提示** —— 属于用户正文的一部分，
     *    用户自己写在文本框里（所见即所得），由后端 `countInlineAudioTags` 清点。
     *
     * `bracket` 标出这一组走哪条路：`param` 只进数组、`square` 插进正文光标处。
     * 「唱歌」组是 `param`（官方 `(唱歌)歌词`），且只在预置音色模式可用。
     */
    const SV_AUDIO_TAG_GROUPS = [
      { label: '整体风格', tags: ['新闻播报', '知识博主', '情感电台', '相声捧哏', '广告配音', '纪录片旁白'], bracket: 'param' },
      { label: '方言', tags: ['东北话', '四川话', '粤语', '上海话', '闽南话'], bracket: 'param' },
      { label: '角色扮演', tags: ['角色扮演：老师', '角色扮演：客服', '角色扮演：旁白'], bracket: 'param' },
      { label: '唱歌', tags: ['唱歌', '轻声哼唱', '高声歌唱'], bracket: 'param', presetOnly: true },
      { label: '细粒度', tags: ['叹气', '哽咽', '深吸气', '轻声', '停顿', '提高音量', '压低音量'], bracket: 'square' },
      { label: '情绪', tags: ['开心', '难过', '生气', '惊讶', '委屈', '激动'], bracket: 'square' },
      { label: '语调', tags: ['温柔', '严肃', '活泼', '慵懒', '急促', '平静'], bracket: 'square' },
      { label: '音色定位', tags: ['磁性', '清亮', '低沉', '沙哑', '少女音', '少年音'], bracket: 'square' },
    ];
    /** 两类标签合并计数：入参标签数 + 正文内插方括号标签数 ≤ 8。 */
    const SV_AUDIO_TAG_MAX_COUNT = 8;
    const SV_AUDIO_TAG_MAX_LENGTH = 40;
    /**
     * 标出正文里真正的内插标签槽位，并给出总数。
     *
     * 与后端 `countInlineAudioTags` **同口径**（2026-10-20 Chief 裁决收紧）：
     * 形如 `[xxx]` / `［xxx］`，且**内容非空、长度 ≤40、内部不含任何括号**
     * 才算一个标签。**不成对的（只有 `[` 没有 `]`）不算标签**，原样当普通
     * 文本放行。
     *
     * 为什么收紧：口播稿里写 `[1]` 引用来源是真实场景。原先「数 `[` 起始符」
     * 会让正常文案占配额，改稿时突然被拒而用户不知道为什么——这个失败模式
     * 比漏算一个标签糟得多。纯数字同理：`[1]` 按引用处理，不占配额。
     *
     * 圆括号组这里**一个都不数**：开头 `(风格)` 由 `audioTags` 入参承载，不经正文。
     *
     * 返回 `{ used, spans }`：spans 带起止位置，插入时用来判断光标是否落在
     * 某个标签内部（落进去再插标签会插出嵌套括号，模型解析歧义）。
     */
    function svAudioTagSlots(text) {
      const body = String(text ?? '');
      const spans = [];
      // 成对 + 内容非空 + ≤40 字 + 内部不含任何括号，才算一个内插标签。
      const re = /[[［]([^\]］]{1,40})[\]］]/gu;
      let match = re.exec(body);
      while (match) {
        // 成对 + ≤40 字已由 SHELL 正则保证；这里补第二道：内层仍含任何括号就不是标签。
        // 判定顺序必须与后端 countInlineAudioTags 逐字同形（先取候选、再判内层），
        // 否则同一段正文前端算 0、后端算 1，配额口径当场分叉。
        //
        // 纯数字**不算**标签（2026-10-20 Chief 裁决 A，与后端 countInlineAudioTags 同口径）：
        // 口播稿里写 `[1]` 引用来源是真实场景。若把它算进配额，用户写够 9 处参考文献
        // 就会被拒，而错误文案指向「音频标签」——他看着自己的引用完全不知道被拒在哪，
        // 而且这是必然发生的，不是概率问题。反过来「用户真想写纯数字标签」在官方标签表里
        // 不存在。失败模式代价不对称，故豁免。
        //
        // 字符集必须与后端 `MIMO_INLINE_TAG_DIGITS_ONLY = /^[0-9０-９]+$/u` **逐字相同**。
        // 这里曾经写的是 `/^\d+$/u`——`\d` 只匹配半角 0-9，不匹配全角 `１`，
        // 于是 `［１］` 前端算 1 个标签、后端算 0 个，同一条裁决两边漂移。
        // 改的时候两边一起改这两个字面量，别各自「顺手优化」成 \d。
        //
        // 内层括号字符集含 `【】`：这是**沿用 HEAD 的既有约束**（当时写在
        // MIMO_INLINE_TAG_SHELL 的排除类里，注释原文「标签内不得再含任何括号
        // （含【】）」），不是新加的取舍。`[叹【气】]` 这种嵌套会让剥离与计数
        // 都失去意义，所以按普通文本放行。后端在改成「先取候选再判内层」那次
        // 重构里把 `【】` 漏掉了，需要后端同步补回 MIMO_INLINE_TAG_INNER，
        // 否则这一条会变成新的前后端分叉。
        if (!/^[0-9０-９]+$/u.test(match[1].trim()) && !/[[\]［］()（）【】]/u.test(match[1])) {
          spans.push({ start: match.index, end: match.index + match[0].length, tag: match[1].trim() });
        }
        re.lastIndex = match.index + match[0].length;
        match = re.exec(body);
      }
      return { used: spans.length, spans };
    }
    /** 已在正文里出现的标签名（去掉括号后比对），用于「这一条已经用过了」。 */
    function svAudioTagNames(text) {
      const body = String(text || '');
      const out = [];
      const re = /[[［(（]([^()［］]*)[\]］)）]/gu;
      let match = re.exec(body);
      while (match) {
        for (const piece of match[1].split(/[，,]/u)) {
          const tag = piece.trim();
          if (tag) out.push(tag);
        }
        match = re.exec(body);
      }
      return out;
    }
    /**
     * 插入前的校验。返回 null 表示可以插入，否则返回该拦下时要说的话。
     *
     * 上限是**合并计数**：入参标签（`audioTags`，整体风格/方言/唱歌）加上正文里
     * 内插的方括号标签，一起不超过 8 个——与后端
     * `normalizeAudioTags(list, countInlineAudioTags(text))` 同口径。
     * 只按其中一类算，都会让用户提交后才吃后端 400。
     */
    function svAudioTagError(text, tag, paramTags = []) {
      // 与后端 normalizeAudioTags 同序：**只剥最外层的一对括号**，再判内层是否
      // 还有括号。先全局去括号会把 `a[b]` 洗成 `ab` 放过去，与后端不一致。
      const raw = String(tag || '').trim();
      const clean = raw.replace(/^[[［(（](.*)[\]］)）]$/u, '$1').trim();
      if (!clean) return '这个标签是空的，选一个下面的预设标签。';
      if (clean.length > SV_AUDIO_TAG_MAX_LENGTH) return `标签「${clean.slice(0, 12)}…」超过 ${SV_AUDIO_TAG_MAX_LENGTH} 字，换个短一点的描述。`;
      if (/[[\]［］()（）]/u.test(clean)) return `标签「${clean}」里带了括号，请去掉——括号只用来包住整组标签。`;
      const { used } = svAudioTagSlots(text);
      const paramList = Array.isArray(paramTags) ? paramTags : [];
      const total = used + paramList.length;
      if (total >= SV_AUDIO_TAG_MAX_COUNT) return `已经有 ${total} 个标签了（上限 ${SV_AUDIO_TAG_MAX_COUNT} 个，正文 ${used} 个 + 整体风格 ${paramList.length} 个）。先用掉几个，或从正文里删掉已有的标签再加。`;
      if (paramList.includes(clean) || svAudioTagNames(text).includes(clean)) return `标签「${clean}」已经在正文里了，换一个或直接手写。`;
      return null;
    }

    /**
     * 参考音频格式校验。官方只认 wav/mp3，其余格式直接 400。
     *
     * 这条必须在**上传之前**拦：以前 m4a/aac 直接送上去只回一个笼统的「合成失败」，
     * 用户分不清是自己文件格式不对还是别的问题；再密集重试几次还会 429，把真正的
     * 原因盖掉。所以宁可在这里说清楚，也不要让它到后端才炸。
     */
    const SV_CLONE_EXTENSIONS = ['wav', 'mp3'];
    const SV_CLONE_ACCEPT = '.wav,.mp3,audio/wav,audio/x-wav,audio/mpeg,audio/mp3';
    function svVoiceReferenceError(file) {
      if (!file) return '请先选择一段参考音频。';
      const name = String(file.name || '');
      const extension = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
      const type = String(file.type || '').toLowerCase();
      if (!name) return '这个文件没有名字，浏览器读不出格式——换个方式导入再试。';
      // 双判：只看扩展名会被改了名的假文件骗过，只看 mediaType 会被部分系统
      // 留空骗过。两个都不沾边的才放到后端去（后端还有一道 ffprobe 复核）。
      const byExtension = SV_CLONE_EXTENSIONS.includes(extension);
      const byMediaType = !type || /^audio\/(?:wav|x-wav|mpeg|mp3)$/iu.test(type);
      if (!byExtension && !byMediaType) {
        const shown = extension || type || '未知格式';
        return `参考音频只支持 wav 和 mp3，你选的是 ${shown}。请先用音频工具转成 wav（或 mp3）再上传——直接传会在合成阶段失败，而且重试多次后可能变成限流错误，看不出真正原因。`;
      }
      if (byExtension && type && !byMediaType) return `文件名是 .${extension}，但浏览器把它识别成 ${type}——两者对不上，文件可能损坏了，请换一个。`;
      if ((file.size || 0) === 0) return '这个音频文件是空的（0 字节），换一个。';
      return null;
    }

    /**
     * 音色库条目 → 任务 referenceAudio 入参。
     *
     * name 必须带扩展名：冻结链路（#uploadedVoiceReference → voiceReferenceFormat）
     * 按 name 的扩展名与 file 的扩展名做一致性校验，显示名（用户可重命名成任何
     * 文字、没有扩展名）过不了那道校验，所以引用库条目时用原始上传文件名；
     * 老条目没有 originalName 时用显示名拼上 file 的扩展名兜底。
     */
    function savedVoiceReference(voice) {
      return {
        id: voice.id,
        file: voice.file,
        name: voice.originalName || `${voice.name}${String(voice.file || '').match(/(\.[a-z0-9]+)$/iu)?.[1] || '.wav'}`,
        mediaType: voice.mediaType,
        bytes: voice.bytes,
        durationSeconds: voice.durationSeconds,
        savedVoiceId: voice.id,
      };
    }

    /**
     * 把方括号标签插进正文的光标处，并重新聚焦回文本框。
     *
     * 追加到末尾会让「[叹气]放在这段前面」变成「放在全文最前面」，语气完全不是
     * 用户点那一下的意思。所以读 selectionStart 插在光标后面，再把光标停在
     * 标签之后，继续手写正文时不会把字打到标签里面。
     *
     * 只处理 `[标签]`——开头那对 `(风格)` 由后端 buildTaggedText 拼，前端**不写**
     * 进正文（写进去会被算成用户内容，下次生成还跟着稿子累积）。
     * 落在已有方括号标签内部时续写，不插出 `[叹气[哽咽]]` 这种嵌套。
     */
    function svInsertAudioTag(textarea, tag, onChange) {
      const value = String(textarea?.value ?? '');
      const at = typeof textarea?.selectionStart === 'number' ? textarea.selectionStart : value.length;
      const before = value.slice(0, at);
      const after = value.slice(at);
      // 光标前面若还有一个没闭合的 `[`，说明正处在这个标签内部，续写即可。
      // 用「最后一个 `[` 之后没有 `]`」判断，比拿 span 范围比大小可靠：
      // 光标紧跟在 `[` 之后时 span 是未闭合的，范围比较会把它误判成外部。
      // 两种括号各自比一次，任一未闭合即算在标签内部。
      // 必须分别比再取或：写成 `a > b && c > d` 时，两边都没出现时是 -1 > -1，
      // 整个条件会被这个 false 拖成 false，光标紧跟 '[' 时反而判成外部。
      const halfOpen = before.lastIndexOf('[') > before.lastIndexOf(']');
      const fullOpen = before.lastIndexOf('［') > before.lastIndexOf('］');
      const openBefore = halfOpen || fullOpen;
      const joined = openBefore ? `${before}${tag}${after}` : `${before}[${tag}]${after}`;
      onChange(joined);
      const caret = openBefore ? before.length + tag.length : before.length + tag.length + 2;
      try { textarea.focus(); textarea.setSelectionRange(caret, caret); } catch {}
    }

    /**
     * 三模式切换器。
     *
     * 三个模型互斥，所以这不是一个和音色并排的下拉，而是**先选模式、再按模式
     * 填那一套专属字段**——把它们做成一个下拉会让人以为能混着填。
     */
    function svVoiceModePicker({ value, onChange, disabled, className = 'sv-voice-modes', labelClass = 'sv-voice-mode-label' }) {
      return h('div', { className, role: 'radiogroup', 'aria-label': '配音模式' },
        SV_VOICE_MODES.map((mode) => h('button', {
          key: mode.id,
          type: 'button',
          role: 'radio',
          'aria-checked': value === mode.id ? 'true' : 'false',
          'data-active': value === mode.id ? 'true' : 'false',
          className: 'sv-voice-mode',
          disabled: Boolean(disabled),
          onClick: () => onChange(mode.id),
        }, h('span', { className: labelClass }, mode.label), h('span', { className: 'sv-voice-mode-hint' }, mode.hint))));
    }

    /**
     * 预置音色下拉，按语种分组。
     *
     * 用 optgroup 是因为 9 个音名平铺一列时，中英文混在一起会让人以为英文音是
     * 中文音的翻译版。mimo_default 单独一组，提示里写清它随集群变化。
     */
    function svVoiceSelect({ value, onChange, disabled, className = 'sv-select', options, include = null }) {
      const extra = include && include !== value && !SV_MIMO_BUILTIN_VOICES.includes(include) ? [include] : [];
      return h('select', { className, value, disabled: Boolean(disabled), onChange: (event) => onChange(event.target.value) },
        SV_MIMO_VOICE_GROUPS.map((group) => {
          const voices = group.voices.filter((voice) => options.includes(voice));
          if (!voices.length) return null;
          return h('optgroup', { key: group.label, label: group.label }, voices.map((voice) => h('option', { key: voice, value: voice }, SV_MIMO_VOICE_HINTS[voice] ? `${voiceDisplayName(voice)} — ${SV_MIMO_VOICE_HINTS[voice]}` : voiceDisplayName(voice))));
        }),
        extra.map((voice) => h('option', { key: voice, value: voice }, voice)));
    }

    /**
     * 音频标签按钮组。点击把标签插进**正文文本框的光标处**，不是追加到末尾——
     * 用户得能看见自己插了什么、插在哪一段前面。
     *
     * 「唱歌」组只在预置音色模式渲染：唱歌只挂在 tts 模型上，另两个模型会直接 400。
     * 括号形态按组给（`group.bracket`），细粒度那批方括号标签才是主力写法，
     * 不能让用户手写——手写就不会被计数，超限也拦不住。
     */
    function svAudioTagPicker({ text, onInsert, onToggleParam, paramTags = [], disabled, mode = 'preset', className = 'sv-audio-tags' }) {
      const groups = SV_AUDIO_TAG_GROUPS.filter((group) => !group.presetOnly || SV_SINGING_MODES.includes(mode));
      const { used } = svAudioTagSlots(text);
      const total = used + paramTags.length;
      const inText = svAudioTagNames(text);
      return h('div', { className },
        h('div', { className: 'sv-audio-tags-head' },
          h('span', { className: 'sv-meta' }, '音频标签'),
          // 两类合并计数：正文内插 + 整体风格（入参），与后端同口径。
          h('span', { className: 'sv-meta', 'data-tone': total >= SV_AUDIO_TAG_MAX_COUNT ? 'warn' : '' }, `已用 ${total}/${SV_AUDIO_TAG_MAX_COUNT}`),
        ),
        groups.map((group) => h('div', { key: group.label, className: 'sv-audio-tag-row' },
          h('span', { className: 'sv-audio-tag-group' }, `${group.label} ${group.bracket === 'param' ? '（开头）' : '（句中）'}`),
          group.tags.map((tag) => {
            const on = group.bracket === 'param' ? paramTags.includes(tag) : inText.includes(tag);
            const problem = svAudioTagError(text, tag, paramTags);
            return h('button', {
              key: tag,
              type: 'button',
              className: 'sv-filter-chip',
              'data-on': on ? 'true' : 'false',
              disabled: Boolean(disabled) || (on ? false : Boolean(problem)),
              title: problem || (group.bracket === 'param' ? `作为整体风格随合成一起发送` : `插入「[${tag}]」到光标处`),
              onClick: () => {
                // 已选中的再点一次是取消，不是报错——整体风格可多选。
                if (on) { if (group.bracket === 'param') onToggleParam(tag); return; }
                if (problem) return;
                if (group.bracket === 'param') onToggleParam(tag);
                else onInsert(tag);
              },
            }, tag);
          }),
        )),
      );
    }
    // 常用且专业的语气提示词。桥接把它作为 user 角色指令传给小米 TTS 控制语气/节奏，
    // 不进合成文本，所以可以放心写风格描述；也允许在输入框里自己改。
    const SV_VOICE_STYLE_PRESETS = [
      '清晰沉稳，适合知识讲解。',
      '亲切自然，像和朋友聊天。',
      '轻快活泼，节奏明快。',
      '温柔舒缓，适合情感共鸣。',
      '沉稳有力，适合观点表达。',
      '干练利落，适合资讯播报。',
      '娓娓道来，适合故事讲述。',
      '热情推荐，适合好物种草。',
    ];
    // interrupted/blocked 是断点续跑、开工前体检与依赖自愈引入的终态，界面上必须能认出来。
    // interrupted 的下一步是「等它自动续跑」，blocked 有两种含义：
    //   · blockedBy 有值 → 外部依赖不可用，正在等它恢复并自动续跑（不是失败）
    //   · blockedBy 为空 → 开工前体检没通过，没开跑（下一步是改配置）
    // 这两种混成同一个词会让「等得起」看起来像「完了」，所以按 blockedBy 分开显示。
    const IMAGE_PROVIDER_SHORT = { bailian: '百炼', scitiger: 'SciTiger', custom: '自定义' };
    const AS_RUN_STATUS = { running: '执行中', completed: '已完成', partial: '部分完成', failed: '失败', missed: '已错过', cancelled: '已停止', interrupted: '已中断·待续跑', blocked: '体检未过·未启动' };
    const AS_RUN_STATUS_WAITING = '等待服务恢复·将自动续跑';
    /** blocked 有两种语义，靠 blockedBy 区分：等待依赖 vs 体检拦截。 */
    function runStatusLabel(run) {
      if (run?.status === 'blocked' && run?.blockedBy) return AS_RUN_STATUS_WAITING;
      return AS_RUN_STATUS[run?.status] || run?.status || '';
    }
    /** 等待依赖的挂起不是红色失败——它会自己好，标红只会让人误以为要手工处理。 */
    function runStatusTone(run) {
      if (run?.status === 'blocked' && run?.blockedBy) return 'orange';
      if (['failed', 'cancelled', 'blocked'].includes(run?.status)) return 'red';
      if (['partial', 'interrupted'].includes(run?.status)) return 'orange';
      if (run?.status === 'missed') return undefined;
      return run?.status === 'running' ? undefined : 'green';
    }
    const AS_ITEM_STATUS = { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已停止' };
    const AS_STAGE_TONE = { done: 'sv-stage', failed: 'sv-status-error', running: '', skipped: 'sv-status-disabled' };
    function emptyScheduleForm() {
      return { name: '', days: new Set([1, 2, 3, 4, 5]), time: '21:00', angle: '', offSources: new Set(), offPlatforms: new Set(), excluded: new Set(), depth: 'packaging', perRunLimit: 1, orientation: 'landscape', scriptTier: 'medium', subtitleEnabled: true, visualBrief: '', voiceSource: 'preset', voiceDesignText: '', voiceReference: null, voiceId: SV_MIMO_DEFAULT_VOICE, voiceRate: '1', voiceVolume: '1', voiceStyle: '', publishAccountId: '', publishSubmitMode: 'confirm' };
    }
    /** Rehydrate a per-tab form from a stored task so editing reuses the create form. */
    function scheduleFormOf(schedule, board) {
      const publicIds = (board?.sources || []).filter((card) => card.id !== 'ai-daily-import').map((card) => card.id);
      const platformNames = (board?.aiDaily?.platforms || []).map((card) => card.platform);
      const chosen = new Set(schedule.sources?.sourceIds || []);
      const chosenPlatforms = new Set(schedule.sources?.platforms || []);
      const voice = schedule.production?.voice || null;
      return {
        name: schedule.name || '',
        days: new Set(schedule.days?.length ? schedule.days : [1, 2, 3, 4, 5]),
        time: schedule.time || '21:00',
        angle: schedule.angle || '',
        offSources: new Set(publicIds.filter((id) => !chosen.has(id))),
        offPlatforms: new Set(platformNames.filter((name) => !chosenPlatforms.has(name))),
        excluded: new Set(schedule.sources?.excludeSignalIds || []),
        depth: schedule.depth || 'packaging',
        perRunLimit: schedule.perRunLimit || 1,
        orientation: schedule.production?.orientation === 'landscape' ? 'landscape' : 'portrait',
        scriptTier: schedule.production?.scriptTier || 'medium',
        subtitleEnabled: schedule.production?.subtitleEnabled !== false,
        visualBrief: schedule.production?.visualBrief || '',
        // 旧任务存的是 voiceSource/bridge.* 这套退役字段：读回来时只取音色名，
        // 它现在统一是 MiMo 内置音色。写不出来的老配置照样能编辑，不丢内容。
        // 三模式只有 preset 存了 voiceId；design/upload 各自有专属字段，
        // 老配置没有它们，回落 preset 才不会把一条老任务读成空壳。
        voiceSource: ['design', 'upload'].includes(schedule.voice?.voiceSource) ? schedule.voice.voiceSource : 'preset',
        // 存盘字段是 `voiceDesign`（后端 normalize 的输出），不是 designText。
        // 读错名字会让编辑一条音色设计任务时描述框空掉，保存后变成非法配置。
        voiceDesignText: schedule.voice?.voiceDesign || '',
        voiceReference: schedule.voice?.referenceAudio || null,
        voiceId: voice?.voiceId && SV_MIMO_BUILTIN_VOICES.includes(voice.voiceId) ? voice.voiceId : SV_MIMO_DEFAULT_VOICE,
        voiceRate: String(voice?.rate ?? 1),
        voiceVolume: String(voice?.volume ?? 1),
        voiceStyle: voice?.style || voice?.bridge?.style || '',
        // A stored task keeps its first target selected; the rest stay in the
        // saved list and are reachable by editing the task again.
        publishAccountId: schedule.publish?.accountIds?.[0] || '',
        publishSubmitMode: schedule.publish?.submitMode === 'auto' ? 'auto' : 'confirm',
      };
    }
    function ScheduleRunDetails({ packId, runId, onChanged }) {
      const [detail, setDetail] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [refresh, setRefresh] = React.useState(0);
      const [confirmNode, ask] = useSvConfirm();
      React.useEffect(() => {
        let active = true; let timer;
        const load = async () => {
          try {
            const next = await remote(packId, 'scheduleRun', { runId });
            if (!active) return;
            setDetail(next); setError(null);
            if (next.run.status === 'running') timer = setTimeout(load, 1500);
          } catch (cause) { if (active) setError(cause.message); }
        };
        void load();
        return () => { active = false; clearTimeout(timer); };
      }, [packId, runId, refresh]);
      const run = detail?.run;
      return h('div', { className: 'sv-as-round-detail', id: `run-${runId}` },
        error ? h('div', { className: 'sv-error', role: 'alert' }, error, h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setRefresh((value) => value + 1) }, '重试读取')) : null,
        !run && !error ? h('p', { className: 'sv-meta', role: 'status' }, '正在读取本轮执行过程…') : null,
        run ? h(React.Fragment, null,
          run.error ? h('p', { className: 'sv-error' }, run.error) : null,
          h('div', { className: 'sv-section-head' }, h('strong', null, '本轮执行过程'), h('span', null, `记录 ${run.id.slice(0, 8)}`)),
          run.refs?.topicGenerationId ? h(ExecutionButton, { kind: 'topic', id: run.refs.topicGenerationId, label: '本轮选题 · 执行详情' }) : null,
          run.items.length ? run.items.map((item, index) => h('section', { key: item.projectId || index, className: 'sv-as-item' },
            h('div', { className: 'sv-as-item-head' }, h('strong', null, item.title || '标题待定'), h('span', { className: 'sv-ex-state', 'data-status': item.status }, AS_ITEM_STATUS[item.status] || item.status)),
            h('p', { className: 'sv-meta' }, [item.signalCount != null ? `依据 ${item.signalCount} 条信号` : null, item.scriptChars != null ? `稿件 ${item.scriptChars} 字` : null, item.durationSeconds != null ? `成片 ${Math.round(item.durationSeconds)} 秒` : null, item.qcPassed ? '质检通过' : null, ({ both: '横竖封面已生成', partial: '单侧封面缺失', none: '封面生成失败', disabled: '未配置生图服务' })[item.coverState]].filter(Boolean).join(' · ')),
            item.error ? h('p', { className: 'sv-error' }, item.error) : null,
            h('div', { className: 'sv-as-life' }, item.stages.map((stage) => h('div', { key: stage.step, className: 'sv-as-life-stage', 'data-status': stage.status },
              h('strong', null, AS_STEPS[stage.step] || stage.step),
              stage.refId ? h(ExecutionButton, { kind: stage.step === 'topic' ? 'topic' : stage.step === 'script' ? 'script' : stage.step === 'packaging' ? 'publish' : 'media', id: stage.refId, projectId: item.projectId, label: '查看过程 →' }) : null,
              h('p', null, stage.message || ({ pending: '未开始', skipped: '已跳过' })[stage.status] || '—'),
              h('span', { className: 'sv-as-life-dot' }, h('i', null), stage.status === 'done' && stage.completedAt ? relativeTime(stage.completedAt) : ({ running: '进行中', failed: '失败', skipped: '跳过' })[stage.status] || '待执行'),
            ))),
          )) : h('p', { className: 'sv-note' }, run.status === 'missed' ? '本次执行被跳过，没有产出。' : run.status === 'running' ? '本轮刚开始，还没有产出条目。' : '本轮没有产出条目。'),
          detail.active ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: () => ask({ title: '停止本轮执行？', copy: '已完成的阶段产物会保留，未开始的阶段不再推进。', confirm: '停止本轮', danger: true, onConfirm: async () => {
            setBusy(true);
            try { await remote(packId, 'cancelScheduleRun', { runId }); setRefresh((value) => value + 1); onChanged(); }
            catch (cause) { setError(cause.message); } finally { setBusy(false); }
          } }) }, busy ? '正在停止…' : '停止本轮') : null,
          // 运行中的轮次不给删——先停止再删。执行的产物项目不受影响，只清这条审计记录。
          detail.active ? null : h('button', { type: 'button', className: 'lwb-danger-button', disabled: busy, onClick: () => ask({ title: '删除这条执行记录？', copy: `将从运行记录里移除这次执行（${run ? `${relativeTime(run.triggeredAt)}触发，状态「${runStatusLabel(run)}」` : ''}）。只删这一条记录，不影响内容安排本身，也不删除它产出的项目。删除后无法恢复。`, confirm: '确认删除', danger: true, onConfirm: async () => {
            setBusy(true);
            try { await remote(packId, 'deleteScheduleRun', { runId }); setRefresh((value) => value + 1); onChanged(); }
            catch (cause) { setError(cause.message); } finally { setBusy(false); }
          } }) }, busy ? '正在删除…' : '删除这条记录'),
        ) : null,
        confirmNode,
      );
    }
    function ScheduleRunHistory({ packId, scheduleId, refreshKey, onPublish, onContinue }) {
      const [status, setStatus] = React.useState('all');
      const [trigger, setTrigger] = React.useState('all');
      const [query, setQuery] = React.useState('');
      const [page, setPage] = React.useState(0);
      const [pageSize, setPageSize] = React.useState(8);
      const [expanded, setExpanded] = React.useState(null);
      const [feed, setFeed] = React.useState({ items: [], total: 0, loading: true });
      const [error, setError] = React.useState(null);
      const [refresh, setRefresh] = React.useState(0);
      React.useEffect(() => {
        let active = true; let timer;
        setFeed((current) => ({ ...current, loading: true }));
        const load = async () => {
          try {
            const next = await remote(packId, 'listScheduleRuns', { scheduleId, status, trigger, query, offset: page * pageSize, limit: pageSize });
            if (!active) return;
            const lastPage = Math.max(0, Math.ceil(next.total / pageSize) - 1);
            if (page > lastPage) { setPage(lastPage); return; }
            setFeed({ ...next, loading: false }); setError(null);
            timer = setTimeout(load, next.anyRunning ? 1500 : 10000);
          } catch (cause) { if (active) { setError(cause.message); setFeed((current) => ({ ...current, loading: false })); } }
        };
        void load();
        return () => { active = false; clearTimeout(timer); };
      }, [packId, scheduleId, status, trigger, query, page, pageSize, refresh, refreshKey]);
      const changeFilter = (setter, value) => { setter(value); setPage(0); setExpanded(null); };
      const pages = Math.max(1, Math.ceil(feed.total / pageSize));
      return h('div', { className: 'sv-as-history' },
        h('div', { className: 'sv-as-history-filters' },
          h('input', { className: 'sv-input', 'aria-label': '搜索执行记录', placeholder: '搜索任务名称、视频标题或执行信息', value: query, maxLength: 160, onChange: (event) => changeFilter(setQuery, event.target.value) }),
          h('select', { className: 'sv-select', 'aria-label': '执行状态', value: status, onChange: (event) => changeFilter(setStatus, event.target.value) }, h('option', { value: 'all' }, '全部状态'), Object.entries(AS_RUN_STATUS).map(([value, label]) => h('option', { key: value, value }, label))),
          h('select', { className: 'sv-select', 'aria-label': '触发方式', value: trigger, onChange: (event) => changeFilter(setTrigger, event.target.value) }, h('option', { value: 'all' }, '全部触发方式'), h('option', { value: 'automatic' }, '定时触发'), h('option', { value: 'manual' }, '手动执行')),
        ),
        error ? h('div', { className: 'sv-error', role: 'alert' }, error, h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setRefresh((value) => value + 1) }, '重试读取')) : null,
        h('div', { className: 'sv-list', 'aria-busy': feed.loading }, feed.loading ? h('p', { className: 'sv-empty', role: 'status' }, '正在读取执行记录…') : feed.items.length ? feed.items.map((run) => h('article', { key: run.id, className: 'sv-as-round', 'data-status': run.status },
          h('div', { className: 'sv-as-round-head' },
            h('button', { type: 'button', className: 'sv-as-round-toggle', 'aria-expanded': expanded === run.id, 'aria-controls': `run-${run.id}`, onClick: () => setExpanded((current) => current === run.id ? null : run.id) },
              h('strong', null, `${scheduleId ? '' : `${run.scheduleName} · `}${formatTime(run.triggeredAt)}`),
              h('span', null, `${run.trigger === 'manual' ? '手动执行' : '定时触发'} · ${run.depthLabel || '—'} · 完成 ${run.completedCount}/${run.itemCount} 条${run.elapsedMs != null ? ` · 耗时 ${Math.max(1, Math.round(run.elapsedMs / 60000))} 分钟` : ''}`),
              h('small', null, expanded === run.id ? '收起本轮详情 ↑' : '展开本轮详情 ↓'),
            ),
            h('span', { className: 'sv-ex-state', 'data-status': run.status }, runStatusLabel(run)),
          ),
          run.message ? h('p', { className: 'sv-as-round-message' }, run.message) : null,
          run.items.length ? h('div', { className: 'sv-as-round-items' }, run.items.map((item, index) => h('div', { key: item.projectId || index, className: 'sv-as-result' },
            h(PublishVideoThumb, { packId, item: { ...item, id: item.projectId }, videoThumbnail: true }),
            h('div', { className: 'sv-as-result-info' }, h('strong', null, item.title || '标题待定'), h('span', null, `${AS_ITEM_STATUS[item.status] || item.status}${item.qcPassed ? ' · 质检通过' : ''}`),
              item.qcPassed && item.video && item.projectId ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => onPublish(item.projectId) }, '去发布页核对资料 →') : null,
              !item.qcPassed && item.projectId && onContinue ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => onContinue(item) }, item.scriptChars != null ? '去配音页继续 →' : '去写稿页查看 →') : null,
            ),
          ))) : h('p', { className: 'sv-as-round-message' }, run.status === 'running' ? `正在${AS_STEPS[run.step] || '准备'}，尚无产出` : '本轮没有产出'),
          expanded === run.id ? h(ScheduleRunDetails, { key: run.id, packId, runId: run.id, onChanged: () => setRefresh((value) => value + 1) }) : null,
        )) : h('div', { className: 'sv-empty' }, '没有匹配的执行记录。')),
        h('div', { className: 'sv-audio-pagebar' }, h('span', { className: 'sv-meta', role: 'status' }, `共 ${feed.total} 轮 · 第 ${page + 1}/${pages} 页`), h('div', { className: 'sv-actions' },
          h('select', { className: 'sv-select sv-as-page-size', 'aria-label': '每页记录数', value: pageSize, onChange: (event) => changeFilter(setPageSize, Number(event.target.value)) }, [8, 20, 50].map((size) => h('option', { key: size, value: size }, `每页 ${size} 轮`))),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: feed.loading || page === 0, onClick: () => { setExpanded(null); setPage((value) => value - 1); } }, '上一页'),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: feed.loading || page + 1 >= pages, onClick: () => { setExpanded(null); setPage((value) => value + 1); } }, '下一页'),
        )),
      );
    }
    // 看板阶段元数据：顺序即流水线顺序；page 是该阶段下一步所在的页面 id。
    const PIPELINE_STAGES = [
      { id: 'script-pending', label: '待写稿', page: 'scripts', tone: 'orange', action: '去写稿' },
      { id: 'script-review', label: '待确认稿件', page: 'scripts', tone: 'violet', action: '去确认稿件' },
      { id: 'voiceover', label: '待配音 / 字幕', page: 'audio-captions', tone: 'pink', action: '去配音' },
      { id: 'video', label: '待视频制作', page: 'video-preview', tone: 'green', action: '去制作视频' },
      { id: 'publish', label: '可发布', page: 'publish', tone: 'red', action: '去发布' },
    ];
    // 看板没有 topic 组——未确认选题的项目仍在选题页管理，不进流水线视角。
    function PipelineBoardPage({ packId, openConversation, openPackMenu }) {
      const [items, setItems] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      // 读不到数据时要能自己爬起来。2026-10-08 实测：工作台重启的那几秒里打开本页，
      // pipelineOverview 请求撞上重启窗口失败，而页面既不报错也不重试，就一直挂在
      // 「正在读取流水线…」，计数全是初始的 0（后端其实 39ms 就能返回 59 个项目）。
      // 一次失败先原地重试，两次都失败才把错误和「重试读取」按钮摆出来给人。
      const [attempt, setAttempt] = React.useState(0);
      const load = React.useCallback(async () => {
        if (!packId) return;
        setBusy(true);
        // 超时看门狗：连接死掉时 remote() 的 promise 既不 resolve 也不 reject
        // （2026-10-08 实测：工作台重启后旧标签页的 WebSocket 已断，页面永远停在
        // 「正在读取流水线…」，error 始终为 null，所以任何依赖 error 的重试都不会触发）。
        // 这里给它加个上限，超时按失败处理，页面就能把原因和重试入口摆出来。
        const timer = new Promise((_, reject) => setTimeout(
          () => reject(new Error('工作台连接没有响应，可能已重启。请刷新页面后重试。')),
          15000,
        ));
        try {
          const next = await Promise.race([remote(packId, 'pipelineOverview'), timer]);
          setItems(next.items || []); setError(null);
        }
        catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
      }, [packId, setError]);
      React.useEffect(() => { void load(); }, [load]);
      // 还没有任何数据、且刚失败过一次时，隔 2 秒自己再试一次。
      React.useEffect(() => {
        if (items != null || !error) return undefined;
        const timer = setTimeout(() => { void load(); }, 2000);
        return () => clearTimeout(timer);
      }, [items, error, attempt, load]);
      // 有运行中的写稿/配音/视频任务时轻量轮询，让阶段变化自动浮上来。
      const [running, setRunning] = React.useState(false);
      React.useEffect(() => {
        if (!packId) return;
        let active = true;
        const hasRunning = async () => {
          try {
            const [scripts, media] = await Promise.all([remote(packId, 'listScriptGenerations'), remote(packId, 'listMediaTasks')]);
            if (active) setRunning(scripts.some((item) => item.status === 'running' || item.status === 'queued') || media.some((item) => item.status === 'running' || item.status === 'queued'));
          } catch (_) { if (active) setRunning(false); }
        };
        void hasRunning();
        const timer = setInterval(hasRunning, 3000);
        return () => { active = false; clearInterval(timer); };
      }, [packId]);
      React.useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => { void load(); }, 4000);
        return () => clearInterval(timer);
      }, [running, load]);

      const byStage = new Map(PIPELINE_STAGES.map((stage) => [stage.id, []]));
      for (const item of items || []) if (byStage.has(item.stage)) byStage.get(item.stage).push(item);
      const total = (items || []).length;

      // 选项卡：一次只看一个阶段，默认落在第一个非空阶段；全部为空时停在待写稿。
      const [activeStage, setActiveStage] = React.useState(PIPELINE_STAGES[0].id);
      React.useEffect(() => {
        if (!items) return;
        setActiveStage((current) => {
          if (byStage.get(current)?.length) return current;
          return PIPELINE_STAGES.find((stage) => byStage.get(stage.id)?.length)?.id || PIPELINE_STAGES[0].id;
        });
      }, [items]);
      const selectedStage = PIPELINE_STAGES.find((stage) => stage.id === activeStage) || PIPELINE_STAGES[0];
      const visibleItems = byStage.get(selectedStage.id) || [];

      const goNext = (item) => {
        const stage = PIPELINE_STAGES.find((entry) => entry.id === item.stage);
        if (!stage) return;
        pipelineHandoff = { page: stage.page, projectId: item.id };
        openPackMenu?.(stage.page);
      };

      const stageCard = (item) => h('div', { key: item.id, className: 'sv-pl-item' },
        h('div', { className: 'sv-pl-item-main' },
          h('strong', null, item.title || '未命名项目'),
          h('span', { className: 'sv-pl-item-meta' }, [item.account?.name || '通用', relativeTime(item.updatedAt)].filter(Boolean).join(' · ')),
        ),
        h('button', { type: 'button', className: 'lwb-plain-button sv-pl-item-go', onClick: () => goNext(item) }, PIPELINE_STAGES.find((entry) => entry.id === item.stage)?.action || '查看', ' →'),
      );

      return h(PackFrame, { packId, openConversation, title: '制作流水线', accent: 'sky', copy: '按阶段分选项卡查看：一张卡片就是一个项目，卡片上的按钮直达它下一步该去的工作页并自动选中它。各工作页的入口不变；本页只回答两件事——项目现在在哪、下一步去哪。', hero: h(HeroMini, { cells: PIPELINE_STAGES.map((stage) => ({ label: stage.label, value: String((byStage.get(stage.id) || []).length), tone: (byStage.get(stage.id) || []).length ? stage.tone : '' })) }) },
        // 读不到数据时把原因和重试入口摆出来，别让页面无声无息地空着（与执行记录页同一模式）。
        // 连接断了的话「重试读取」没用——RPC 根本发不出去，所以额外给一个刷新页面的出口。
        error ? h('div', { className: 'sv-error', role: 'alert' }, error,
          h('div', { className: 'sv-actions' },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: () => { setAttempt((value) => value + 1); void load(); } }, busy ? '正在重试…' : '重试读取'),
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => location.reload() }, '刷新页面'))) : null,
        total === 0 && !error && items ? h('div', { className: 'sv-empty' }, '还没有项目。到「选题」页生成候选并加入待写稿，或用「内容安排」让定时任务自动产出；流水线一有项目就会在这里出现。') : null,
        total > 0 || error ? h('div', { className: 'sv-tp-tabs', role: 'tablist', 'aria-label': '按制作阶段筛选项目' }, PIPELINE_STAGES.map((stage) => {
          const count = (byStage.get(stage.id) || []).length;
          return h('button', { key: stage.id, type: 'button', role: 'tab', className: 'sv-tp-tab', 'data-active': activeStage === stage.id ? 'true' : 'false', 'aria-selected': activeStage === stage.id, onClick: () => setActiveStage(stage.id) },
            stage.label,
            count > 0 ? h('span', { className: 'sv-tp-tab-badge', 'aria-label': `${count} 个项目` }, String(count)) : null,
          );
        })) : null,
        visibleItems.length ? h('section', { className: 'sv-section' },
          h('div', { className: 'sv-section-head' }, h('h3', null, selectedStage.label), h('span', null, `${visibleItems.length} 个`)),
          h('div', { className: 'sv-list' }, visibleItems.map(stageCard)),
        ) : total > 0 && !error ? h('div', { className: 'sv-empty' }, `${selectedStage.label}暂时没有项目；点上面的其他选项卡查看。`) : null,
        // 已经报错时不再显示「正在读取…」——两者同时出现会让人以为还在加载。
        busy && items == null && !error ? h('p', { className: 'sv-meta', role: 'status' }, packId ? '正在读取流水线…' : '正在连接工作台…') : null,
        // 有数据就别再挂着加载态了；失败且正在自动重试时说明一下在做什么。
        !busy && items == null && !error ? h('p', { className: 'sv-meta', role: 'status' }, '正在重试读取流水线…') : null,
      );
    }
    function ContentSchedulePage({ packId, openConversation, openPackMenu }) {
      const [board, setBoard] = React.useState(null);
      const [sources, setSources] = React.useState([]);
      // 与选题页同一个问题：把「加载中」与「失败」分开，否则失败后永远显示
      // 「正在读取信号源…」。
      const [sourcesState, setSourcesState] = React.useState('pending');
      const [accountLibrary, setAccountLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      const [runtime, setRuntime] = React.useState(null);
      const [schedules, setSchedules] = React.useState([]);
      const [runs, setRuns] = React.useState([]);
      const [formsByTab, setFormsByTab] = React.useState({});
      const [activeTab, setActiveTab] = React.useState(GENERAL_TAB);
      const [editingId, setEditingId] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [signalDrawer, setSignalDrawer] = React.useState(null);
      const [historySchedule, setHistorySchedule] = React.useState(null);
      const [historyRefresh, setHistoryRefresh] = React.useState(0);
      const [confirmNode, ask] = useSvConfirm();
      const [schedulePromptNode, schedulePrompt] = useSvPrompt();
      const [voiceRefBusy, setVoiceRefBusy] = React.useState(false);
      const [voiceRefError, setVoiceRefError] = React.useState('');
      // 音色库（与音频页共享同一份）：克隆模式点选即用，无需重复上传。
      // 按账号 Tab 各存一份加载结果，切 Tab 不重复拉取。
      const [scheduleVoicesByForm, setScheduleVoicesByForm] = React.useState({});
      const refreshScheduleSavedVoices = React.useCallback(async () => {
        try {
          const next = await remoteStatic('listSavedVoices');
          const voices = Array.isArray(next?.voices) ? next.voices : [];
          setScheduleVoicesByForm((prev) => ({ ...prev, [activeTab]: voices }));
        } catch { /* 库不可用时静默：克隆仍可手动上传 */ }
      }, [activeTab]);
      React.useEffect(() => { void refreshScheduleSavedVoices(); }, [refreshScheduleSavedVoices]);
      const fail = React.useCallback((message) => { setError(message); }, [setError]);

      // 上一次已知的轮次状态，用来发现「刚刚落到终态」这件事。放在 ref 而不是
      // state：它是轮询的副产物，不该触发重渲染。
      const seenRunStates = React.useRef(new Map());
      // 本页打开的时刻。用来区分「我开着的时候跑完了」与「我打开前就跑完了」——
      // 后者不该弹窗，否则每次打开页面都会被几十条历史轮次刷屏。
      const openedAt = React.useRef(Date.now());
      const [queue, setQueue] = React.useState({ active: 0, waiting: [], recent: [] });
      const [failures, setFailures] = React.useState(null);
      const [toasts, setToasts] = React.useState([]);

      /**
       * 弹窗自动消失。定时任务的完成提示没人会盯着看，占着屏幕不走反而碍事；
       * 12 秒足够读完一行标题加一句修法。需要留着细看时点「查看」进历史抽屉。
       *
       * 每条带自己的到期时刻，而不是「数组变化就重置一个定时器」——后者会让
       * 先到的弹窗被后到的不断顺延，四条提示能挂上好几分钟才消第一条。
       */
      const dismissToast = React.useCallback((id) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, []);

      React.useEffect(() => {
        if (!toasts.length) return undefined;
        const now = Date.now();
        const expired = toasts.filter((toast) => toast.expiresAt <= now).map((toast) => toast.id);
        if (expired.length) {
          setToasts((current) => current.filter((toast) => !expired.includes(toast.id)));
          return undefined;
        }
        // 只等最近一条到期的那段：更早的会在下一轮被上面那段清掉。
        const wait = Math.max(200, Math.min(...toasts.map((toast) => toast.expiresAt)) - now);
        const timer = setTimeout(() => {
          setToasts((current) => {
            const at = Date.now();
            const kept = current.filter((toast) => toast.expiresAt > at);
            // 全部过期时清空，避免留下永远不再触发的空数组。
            return kept.length === current.length ? current : kept;
          });
        }, wait);
        return () => clearTimeout(timer);
      }, [toasts]);

    /**
     * 页面内弹窗提示（toast）。
     *
     * 与提示音是同一套事件的两条通道：声音解决「人不在电脑前也该知道」，弹窗解决
     * 「人在电脑前但盯别的标签页」。两者各自都有失效场景——浏览器静音策略会让网页
     * 声音在后台标签页被节流，而弹窗在页面没打开时根本不存在——所以必须都有。
     *
     * 只做展示，不承担任何控制职责：点「查看」只是把对应轮次的历史抽屉拉起来，
     * 关掉弹窗不会影响已经在跑的轮次。
     */
    const TOAST_LIMIT = 4;
    const TOAST_TTL_MS = 12_000;
    function ToastStack({ toasts, onDismiss, onOpenRun }) {
      if (!toasts.length) return null;
      return h('div', { className: 'sv-toast-stack', role: 'status', 'aria-live': 'polite' },
        toasts.map((toast) => h('div', {
          key: toast.id,
          className: 'sv-toast',
          'data-level': toast.level,
        },
          h('div', { className: 'sv-toast-main' },
            h('p', { className: 'sv-toast-title' }, toast.title),
            toast.detail ? h('p', { className: 'sv-toast-detail' }, toast.detail) : null,
            toast.remedy ? h('p', { className: 'sv-toast-remedy' }, toast.remedy) : null),
          h('div', { className: 'sv-toast-actions' },
            toast.runId && onOpenRun
              ? h('button', {
                type: 'button', className: 'lwb-plain-button',
                onClick: () => { onOpenRun(toast.runId); onDismiss(toast.id); },
              }, '查看')
              : null,
            h('button', {
              type: 'button', className: 'lwb-plain-button',
              'aria-label': `关闭提示：${toast.title}`,
              onClick: () => onDismiss(toast.id),
            }, '关闭')))));
    }

    /**
     * 提示音与桌面通知的唯一触发点。
     *
     * 放在轮询结果上比对，而不是由后端推事件：这一页本来就在按 1.5 秒轮询，
     * 复用它零成本；代价是页面不在时听不见——那条由 alerts.json 加独立的
     * Windows 计划任务兜底，不依赖浏览器。
     *
     * 只在「首次见到某条已是终态的轮次」时弹/响，避免刷新页面就响一片；同一条
     * 终态被后续轮询反复读到也只报一次。
     */
      const announceRuns = React.useCallback((nextRuns, nameOf) => {
        const seen = seenRunStates.current;
        for (const run of nextRuns || []) {
          if (!run || !run.id) continue;
          const status = run.status;
          const terminal = ['completed', 'partial', 'failed', 'blocked', 'interrupted'].includes(status);
          if (!terminal) { seen.set(run.id, status); continue; }
          if (seen.get(run.id) === status) continue;
          seen.set(run.id, status);
          // 只播报「这一页开着的时候刚发生」的那些。
          //
          // 分页历史里有几十条终态轮次，页面一打开就全弹一遍等于用旧消息刷屏，
          // 用户会立刻学会忽略这个弹窗——那它对真正的新失败也就失效了。判据是
          // 结束时间落在「本页首次取数」之后：早于它的都是打开前就发生的事。
          const finishedAt = Date.parse(run.completedAt || run.triggeredAt || '') || 0;
          if (finishedAt && finishedAt < openedAt.current) continue;
          const minutes = run.elapsedMs ? `，耗时 ${Math.round(run.elapsedMs / 60000)} 分钟` : '';
          const name = nameOf ? nameOf(run) : '';
          const label = name ? `${name}：自动化` : '自动化';
          let level = 'error';
          let title = `${label}失败`;
          let voice = 'error';
          if (status === 'completed') { level = 'success'; voice = 'success'; title = `${label}已完成${minutes}`; }
          else if (status === 'partial') { level = 'warn'; voice = 'attention'; title = `${label}部分完成${minutes}`; }
          else if (status === 'blocked') { title = `${label}未启动（开工前体检未通过）`; }
          else if (status === 'interrupted') { level = 'warn'; voice = 'attention'; title = `${label}被中断，将自动续跑`; }
          // 弹窗正文优先用修复建议：失败时「该做什么」比「错在哪」更有用。
          const detail = run.remedy || run.message || run.error || '';
          notify.playOnce(run.id, voice);
          notify.notifyDesktop(title, detail);
          setToasts((current) => [{
            id: run.id, level, title, detail,
            runId: run.id, scheduleId: run.scheduleId,
            // 到期时刻在入栈时定死：渲染阶段算会因重渲染而漂移。
            expiresAt: Date.now() + TOAST_TTL_MS,
          }, ...current].slice(0, TOAST_LIMIT));
        }
        // 长时间开着页面不能让这张表无限增长。
        if (seen.size > 200) {
          for (const key of [...seen.keys()].slice(0, seen.size - 200)) seen.delete(key);
        }
      }, []);

      const loadSchedules = React.useCallback(async () => {
        if (!packId) return { schedules: [], runs: [] };
        try {
          const next = await remote(packId, 'listSchedules');
          setSchedules(next.schedules || []); setRuns(next.runs || []); setError(null);
          return next;
        } catch (cause) { fail(cause.message); return { schedules: [], runs: [] }; }
      }, [packId, setError, fail]);

      /**
       * 终态播报必须读完整历史，不能挂在 loadSchedules 上。
       *
       * listSchedules 是任务卡专用的轻量视图：只返回「最新一条 + 所有 running」
       * （见 host 的注释，那是刻意的性能优化）。而一次轮询里结束的任务往往不止
       * 一条——多任务排队后更常见——所以挂在它上面会漏掉除最新一条外的所有终态。
       *
       * 走分页历史接口：它的返回字段是 `items`（不是 `runs`），并且每行已经带好
       * `scheduleName`，省掉一次任务表联查。
       */
      React.useEffect(() => {
        if (!packId) return undefined;
        let active = true;
        const check = async () => {
          const page = await remote(packId, 'listScheduleRuns', { limit: 20 }).catch(() => null);
          if (!active || !page) return;
          announceRuns(page.items || [], (run) => run.scheduleName || '');
        };
        void check();
        const timer = setInterval(() => { if (active) void check(); }, 4000);
        return () => { active = false; clearInterval(timer); };
      }, [packId, announceRuns]);

      // 队列与故障档案：低频刷新即可，它们的变化节奏远慢于轮次列表本身。
      React.useEffect(() => {
        if (!packId) return undefined;
        let active = true;
        const load = async () => {
          const [queueNext, failureNext] = await Promise.all([
            remoteStatic('scheduleQueue').catch(() => null),
            remote(packId, 'listScheduleFailures').catch(() => null),
          ]);
          if (!active) return;
          if (queueNext) setQueue(queueNext);
          if (failureNext) setFailures(failureNext);
        };
        void load();
        const timer = setInterval(() => { if (active) void load(); }, 8000);
        return () => { active = false; clearInterval(timer); };
      }, [packId]);

      React.useEffect(() => {
        if (!packId) return;
        void Promise.all([
          remote(packId, 'board'),
          remote(packId, 'sources'),
          remote(packId, 'listAccounts'),
          remoteStatic('scheduleRuntimeStatus').catch(() => null),
        ]).then(([nextBoard, nextSources, nextAccounts, nextRuntime]) => {
          setBoard(nextBoard); setSources(nextSources); setAccountLibrary(nextAccounts); setRuntime(nextRuntime);
          setActiveTab((current) => current !== GENERAL_TAB && nextAccounts.accounts.some((item) => item.id === current && item.status === 'active') ? current : nextAccounts.defaultAccountId || GENERAL_TAB);
          setSourcesState('ready');
        }).catch((cause) => { setSourcesState('error'); fail(cause.message); });
        void loadSchedules();
      }, [packId, fail, loadSchedules]);

      const anyRunning = runs.some((run) => run.status === 'running');
      // 调度器本来会自动续跑中断的轮次；这个按钮是给「我刚把失效的 Key 换好了，
      // 现在就跑」的人准备的，不用再等下一个 30 秒节拍。
      const resumeInterrupted = React.useCallback(async (runId) => {
        setBusy(`resume:${runId}`);
        try {
          await remote(packId, 'resumeScheduleRun', { runId });
          await loadSchedules();
        } catch (cause) { fail(cause.message); }
        finally { setBusy(null); }
      }, [packId, loadSchedules, setBusy, fail]);
      React.useEffect(() => {
        if (!packId) return undefined;
        let active = true;
        const timer = setInterval(() => { if (active) void loadSchedules(); }, anyRunning ? 1500 : 10000);
        return () => { active = false; clearInterval(timer); };
      }, [packId, anyRunning, loadSchedules]);

      if (!packId) return h(NeedPack, { openConversation });

      const activeAccounts = accountLibrary.accounts.filter((item) => item.status === 'active');
      const activeAccount = activeAccounts.find((item) => item.id === activeTab) || null;
      const form = formsByTab[activeTab] || emptyScheduleForm();
      const patchForm = (fn) => setFormsByTab((prev) => ({ ...prev, [activeTab]: fn(prev[activeTab] || emptyScheduleForm()) }));
      const editing = editingId ? schedules.find((item) => item.id === editingId) || null : null;
      /** Same format gate as the audio page: reject before upload, not with a 400 after it. */
      const pickScheduleVoiceReference = async (file) => {
        const problem = svVoiceReferenceError(file);
        if (problem) { setVoiceRefError(problem); patchForm((current) => ({ ...current, voiceReference: null })); return; }
        setVoiceRefBusy(true); setVoiceRefError('');
        try {
          const data = await base64FromAudioFile(file);
          const extension = String(file.name || '').split('.').pop().toLowerCase();
          const uploaded = await remoteStatic('uploadVoiceReference', {
            name: file.name,
            mediaType: /^mp3$/iu.test(extension) ? 'audio/mpeg' : 'audio/wav',
            data,
          });
          patchForm((current) => ({ ...current, voiceReference: uploaded }));
          // 上传即已自动入音色库——刷新让新音色在库列表里出现。
          void refreshScheduleSavedVoices();
        } catch (cause) {
          setVoiceRefError(`上传失败：${cause.message}`);
          patchForm((current) => ({ ...current, voiceReference: null }));
        } finally { setVoiceRefBusy(false); }
      };
      /** 定时任务表单也能直接从音色库选：与音频页同一份库、同一个冻结链路。 */
      const scheduleSavedVoices = scheduleVoicesByForm[activeTab] || [];
      const pickScheduleSavedVoice = (voice) => {
        setVoiceRefError('');
        patchForm((current) => ({ ...current, voiceReference: savedVoiceReference(voice) }));
      };
      const renameScheduleSavedVoice = (voice) => {
        schedulePrompt({
          title: '修改音色名称',
          copy: '只改显示名，音频文件不动。',
          initialValue: voice.name || '',
          confirm: '保存',
          onConfirm: (name) => { void doRenameScheduleSavedVoice(voice, name); },
        });
      };
      const doRenameScheduleSavedVoice = async (voice, name) => {
        setVoiceRefBusy(true);
        try { await remoteStatic('renameSavedVoice', { id: voice.id, name }); await refreshScheduleSavedVoices(); }
        catch (cause) { setVoiceRefError(`重命名失败：${cause.message}`); }
        finally { setVoiceRefBusy(false); }
      };
      const deleteScheduleSavedVoice = (voice) => {
        ask({
          title: '删除这个音色？',
          copy: `将从音色库删除「${voice.name}」，音频文件一并删除。已生成的配音与已保存的任务预设不受影响。`,
          confirm: '删除',
          danger: true,
          onConfirm: () => { void doDeleteScheduleSavedVoice(voice); },
        });
      };
      const doDeleteScheduleSavedVoice = async (voice) => {
        setVoiceRefBusy(true);
        try {
          await remoteStatic('deleteSavedVoice', { id: voice.id });
          patchForm((current) => current.voiceReference?.savedVoiceId === voice.id ? { ...current, voiceReference: null } : current);
          await refreshScheduleSavedVoices();
        } catch (cause) { setVoiceRefError(`删除失败：${cause.message}`); }
        finally { setVoiceRefBusy(false); }
      };

      const publicCards = (board?.sources || []).filter((card) => card.id !== 'ai-daily-import');
      const platformCards = board?.aiDaily?.platforms || [];
      const allPublicIds = publicCards.map((card) => card.id);
      const selectedPublic = allPublicIds.filter((id) => !form.offSources.has(id));
      const selectedPlatforms = platformCards.map((card) => card.platform).filter((name) => !form.offPlatforms.has(name));
      const allPlatformsSelected = platformCards.length > 0 && selectedPlatforms.length === platformCards.length;
      const selectedCount = selectedPublic.length + selectedPlatforms.length;
      const submitSourceIds = [...selectedPublic, ...(selectedPlatforms.length ? ['ai-daily-import'] : [])];
      const sortedDays = [...form.days].sort((a, b) => a - b);
      // Platform accounts come from the publisher pack's own status read; a
      // signed-out account stays selectable so the operator can see it and
      // re-login, but the label says so.
      const publishAccounts = runtime?.publish?.accounts || [];
      // A blocker only matters when the chosen depth actually reaches the step
      // it guards: a task that stops at「写稿」must not be warned that its
      // platform account is missing, and neither must one stopping at「成片」.
      const AS_DEPTH_ORDER = AS_DEPTHS.map((item) => item.id);
      const blockersFor = (depth) => {
        const limit = AS_DEPTH_ORDER.indexOf(depth);
        return (runtime?.blockers || []).filter((item) => AS_DEPTH_ORDER.indexOf(item.depth) <= limit);
      };
      // 音色必填：MiMo 内置表之外的值会让合成直接失败，不给保存。
      // design 模式没有音色名可校验，它唯一的输入是那段描述（必填）。
      const voiceReady = form.voiceSource === 'design'
        ? Boolean(form.voiceDesignText.trim())
        : SV_MIMO_BUILTIN_VOICES.includes(form.voiceId);
      // A publish-depth task is unusable without a target, so require one before
      // letting it be saved rather than discovering it at the round's last step.
      const publishReady = form.depth !== 'publish' || Boolean(form.publishAccountId);
      const formValid = Boolean(form.name.trim()) && sortedDays.length > 0 && /^\d{2}:\d{2}$/u.test(form.time) && selectedCount > 0 && voiceReady && publishReady;

      const payloadOf = () => ({
        name: form.name.trim(),
        enabled: editing ? editing.enabled : true,
        accountId: activeTab === GENERAL_TAB ? null : activeTab,
        days: sortedDays,
        time: form.time,
        angle: form.angle.trim() || null,
        sources: {
          sourceIds: submitSourceIds,
          // All platforms selected is the same as no platform filter.
          platforms: selectedPlatforms.length && !allPlatformsSelected ? selectedPlatforms : [],
          excludeSignalIds: [...form.excluded],
        },
        depth: form.depth,
        perRunLimit: form.perRunLimit,
        // Only a publish-depth task carries a target; sending one for shallower
        // depths would leave a stale account selection behind on the record.
        publish: form.depth === 'publish' && form.publishAccountId
          ? { accountIds: [form.publishAccountId], submitMode: form.publishSubmitMode }
          : null,
        production: {
          orientation: form.orientation,
          subtitleEnabled: form.subtitleEnabled,
          scriptTier: form.scriptTier,
          visualBrief: form.visualBrief.trim() || null,
          voice: voicePayloadOf(),
        },
      });

      const submit = () => {
        if (!formValid || busy) return;
        const label = activeAccount ? `账号「${activeAccount.name}」` : '通用（无账号定位）';
        const daysLabel = sortedDays.length === 7 ? '每天' : sortedDays.map((day) => AS_WEEKDAYS[day - 1].label).join('、');
        const depthLabel = AS_DEPTHS.find((item) => item.id === form.depth)?.label || form.depth;
        const voiceLabel = form.voiceSource === 'design'
          ? `音色设计「${form.voiceDesignText.trim().slice(0, 30)}${form.voiceDesignText.trim().length > 30 ? '…' : ''}」${form.voiceStyle.trim() ? `，语气「${form.voiceStyle.trim()}」` : ''}`
          : `音色「${form.voiceId}」${form.voiceStyle.trim() ? `，语气「${form.voiceStyle.trim()}」` : ''}`;
        const publishLabel = form.depth === 'publish' && form.publishAccountId
          ? `；投递到「${publishAccounts.find((item) => item.id === form.publishAccountId)?.label || '所选账号'}」${form.publishSubmitMode === 'auto' ? '并自动提交' : '，停在发布前等你确认'}`
          : '';
        const description = `${label}；${daysLabel} ${form.time}；深度「${depthLabel}」；每轮最多 ${form.perRunLimit} 条；${voiceLabel}；参与渠道 ${selectedCount} 个${publishLabel}`;
        // The old copy promised publishing was never automated. That promise is
        // now a setting, so the confirmation states which one is in force
        // instead of repeating something that is no longer true.
        const automationNote = form.depth === 'publish'
          ? (form.publishSubmitMode === 'auto'
            ? '该深度会无人值守直接发布到平台，发布后无法撤回。'
            : '该深度会把成片投递到平台并填好资料，最后一步停在发布前，需要你在浏览器窗口确认。')
          : '发布动作不会执行，任务停在「发布资料」。';
        ask({
          title: editing ? '保存任务修改？' : '创建定时任务？',
          copy: `${description}。${AS_APPROVING.has(form.depth) ? '该深度将自动确认 AI 稿件，不再人工过稿；' : ''}到点后由主机侧调度器无人值守执行，切换页面不会中断。${automationNote}`,
          confirm: editing ? '保存修改' : '创建任务',
          onConfirm: async () => {
            setBusy('save');
            try {
              if (editing) await remote(packId, 'updateSchedule', { scheduleId: editing.id, ...payloadOf() });
              else await remote(packId, 'createSchedule', payloadOf());
              setEditingId(null);
              setFormsByTab((prev) => ({ ...prev, [activeTab]: emptyScheduleForm() }));
              await loadSchedules();
            } catch (cause) { fail(cause.message); } finally { setBusy(null); }
          },
        });
      };

      const invoke = (method, request, marker, confirm, then) => {
        const run = async () => {
          setBusy(marker);
          try {
            const result = await remote(packId, method, request);
            await loadSchedules();
            if (then) await then(result);
          } catch (cause) { fail(cause.message); } finally { setBusy(null); }
        };
        if (confirm) ask({ ...confirm, onConfirm: () => { void run(); } });
        else void run();
      };

      const startEdit = (schedule) => {
        const tab = schedule.accountId && activeAccounts.some((item) => item.id === schedule.accountId) ? schedule.accountId : GENERAL_TAB;
        setActiveTab(tab);
        setFormsByTab((prev) => ({ ...prev, [tab]: scheduleFormOf(schedule, board) }));
        setEditingId(schedule.id);
      };
      const cancelEdit = () => {
        setEditingId(null);
        setFormsByTab((prev) => ({ ...prev, [activeTab]: emptyScheduleForm() }));
      };

      const toggleDay = (day) => { if (busy) return; patchForm((current) => { const days = new Set(current.days); if (days.has(day)) days.delete(day); else days.add(day); return { ...current, days }; }); };
      const setDays = (list) => { if (busy) return; patchForm((current) => ({ ...current, days: new Set(list) })); };
      const toggleSource = (id) => { if (busy) return; patchForm((current) => { const offSources = new Set(current.offSources); if (offSources.has(id)) offSources.delete(id); else offSources.add(id); return { ...current, offSources }; }); };
      const togglePlatform = (name) => { if (busy) return; patchForm((current) => { const offPlatforms = new Set(current.offPlatforms); if (offPlatforms.has(name)) offPlatforms.delete(name); else offPlatforms.add(name); return { ...current, offPlatforms }; }); };
      const selectAllSources = () => { if (busy) return; patchForm((current) => ({ ...current, offSources: new Set(), offPlatforms: new Set() })); };
      const clearSources = () => { if (busy) return; patchForm((current) => ({ ...current, offSources: new Set(allPublicIds), offPlatforms: new Set(platformCards.map((card) => card.platform)) })); };
      const toggleExclude = (signalId) => patchForm((current) => { const excluded = new Set(current.excluded); if (excluded.has(signalId)) excluded.delete(signalId); else excluded.add(signalId); return { ...current, excluded }; });
      const clearExcluded = () => patchForm((current) => ({ ...current, excluded: new Set() }));

      const tabs = h(AccountTabs, { accountLibrary, activeTab, onChange: setActiveTab, label: '按账号定位选择任务归属', disabled: Boolean(editing) });

      const sourceCard = (card) => {
        const on = !form.offSources.has(card.id);
        return h('div', { key: card.id, className: 'sv-tp-src', 'data-on': on ? 'true' : 'false' },
          h('div', { className: 'sv-tp-src-head' },
            h('button', { type: 'button', className: 'sv-tp-src-check', disabled: Boolean(busy), 'aria-pressed': on, 'aria-label': `${on ? '取消' : '选择'}${card.name}`, onClick: () => toggleSource(card.id) }, h('i', null)),
            h('button', { type: 'button', className: 'sv-tp-src-main', onClick: () => setSignalDrawer({ kind: 'signals', sourceId: card.id, platform: null, name: card.name }) },
              h('span', { className: 'sv-tp-src-titlerow' }, h('span', { className: 'sv-tp-src-dot', style: { background: sourceDotColor(card.name) } }), h('span', { className: 'sv-tp-src-name' }, card.name)),
              h('span', { className: 'sv-tp-src-meta' }, `最新 ${relativeTime(card.lastSuccessAt)} · 今日 ${card.todayCount}`),
            ),
          ),
        );
      };
      const platformCard = (card) => {
        const on = !form.offPlatforms.has(card.platform);
        const glyph = PLATFORM_GLYPHS[card.platform];
        return h('div', { key: card.platform, className: 'sv-tp-src', 'data-on': on ? 'true' : 'false' },
          h('div', { className: 'sv-tp-src-head' },
            h('button', { type: 'button', className: 'sv-tp-src-check', disabled: Boolean(busy), 'aria-pressed': on, 'aria-label': `${on ? '取消' : '选择'}${card.platform}`, onClick: () => togglePlatform(card.platform) }, h('i', null)),
            h('button', { type: 'button', className: 'sv-tp-src-main', onClick: () => setSignalDrawer({ kind: 'signals', sourceId: 'ai-daily-import', platform: card.platform, name: `AI 内容日报 · ${card.platform}` }) },
              h('span', { className: 'sv-tp-src-titlerow' }, h('span', { className: 'sv-tp-src-dot', style: { background: glyph ? glyph[0] : sourceDotColor(card.platform) } }), h('span', { className: 'sv-tp-src-name' }, card.platform)),
              h('span', { className: 'sv-tp-src-meta' }, `最新 ${relativeTime(card.lastImportedAt)} · 今日 ${card.todayCount}`),
            ),
          ),
        );
      };

      const runtimeBlockers = blockersFor(form.depth);
      const voicePayloadOf = () => {
        const numeric = (value, fallback) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; };
        // 三模式互斥：只发当前模式那一套字段，不把另外两套传空值过去。
        // 传空 voiceId 给 design 或传空 voiceDesign 给 preset 都会让对方模型 400。
        // 这套字段必须**逐项都带上**——只搬 voiceId 会让排期任务在到点执行时
        // 静默退回默认音色，用户在排期里选的声音根本没生效，且没有任何报错。
        const base = { voiceSource: form.voiceSource, rate: numeric(form.voiceRate, 1), volume: numeric(form.voiceVolume, 1) };
        const tone = form.voiceStyle.trim() ? { style: form.voiceStyle.trim() } : {};
        // 字段名是后端定的 `voiceDesign`（见 normalizeVoiceoverRequest）。前端内部
        // state 叫 voiceDesignText，但**出网必须换成 voiceDesign**——发 designText
        // 后端读不到描述，会判成「音色设计模式需要填写音色描述」。
        if (form.voiceSource === 'design') return { ...base, ...tone, voiceDesign: form.voiceDesignText.trim() };
        if (form.voiceSource === 'upload') return { ...base, ...tone, ...(form.voiceReference ? { referenceAudio: form.voiceReference } : {}) };
        return { ...base, ...tone, voiceId: form.voiceId, voiceName: form.voiceId };
      };
      const configCard = h('section', { className: 'sv-form' },
        h('div', { className: 'sv-section-head' },
          h('h3', null, editing ? `编辑任务 · ${editing.name}` : '新建自动化任务'),
          h('span', null, activeAccount ? activeAccount.name : '通用 · 无账号定位'),
        ),
        tabs,
        h('label', { className: 'sv-as-field' },
          h('span', { className: 'sv-as-label' }, '任务名称'),
          h('input', { className: 'sv-input', value: form.name, maxLength: 120, disabled: Boolean(busy), placeholder: '例如：晚间自动出片', onChange: (event) => patchForm((current) => ({ ...current, name: event.target.value })) }),
        ),
        h('div', { className: 'sv-as-field' },
          h('span', { className: 'sv-as-label' }, `执行日（已选 ${sortedDays.length} 天）`),
          h('div', { className: 'sv-as-chips' },
            ...AS_WEEKDAYS.map((item) => h('button', { key: item.day, type: 'button', className: 'sv-as-chip', 'data-on': form.days.has(item.day) ? 'true' : 'false', disabled: Boolean(busy), onClick: () => toggleDay(item.day) }, item.label)),
            h('button', { type: 'button', className: 'sv-as-chip', 'data-kind': 'quick', disabled: Boolean(busy), onClick: () => setDays([1, 2, 3, 4, 5, 6, 7]) }, '每天'),
            h('button', { type: 'button', className: 'sv-as-chip', 'data-kind': 'quick', disabled: Boolean(busy), onClick: () => setDays([1, 2, 3, 4, 5]) }, '工作日'),
            h('button', { type: 'button', className: 'sv-as-chip', 'data-kind': 'quick', disabled: Boolean(busy), onClick: () => setDays([6, 7]) }, '周末'),
          ),
        ),
        h('div', { className: 'sv-as-field' },
          h('span', { className: 'sv-as-label' }, '执行时刻（本机本地时间）'),
          h('div', { className: 'sv-as-chips' },
            h('input', { className: 'sv-input', type: 'time', value: form.time, style: { width: '128px', flex: 'none' }, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, time: event.target.value })) }),
            ...['07:00', '09:00', '12:00', '18:00', '21:00'].map((item) => h('button', { key: item, type: 'button', className: 'sv-as-chip', 'data-on': form.time === item ? 'true' : 'false', disabled: Boolean(busy), onClick: () => patchForm((current) => ({ ...current, time: item })) }, item)),
          ),
          h('p', { className: 'sv-as-task-note' }, '到点时主机未运行则跳过本次，不自动补跑，只在该任务的运行记录里记一条「已错过」。'),
        ),
        h('label', { className: 'sv-as-field' },
          h('span', { className: 'sv-as-label' }, '选题角度（选填）'),
          h('textarea', { className: 'sv-textarea', style: { minHeight: '58px' }, value: form.angle, maxLength: 500, disabled: Boolean(busy), placeholder: '例如：避坑角度 · 真实使用场景，面向新手创作者', onChange: (event) => patchForm((current) => ({ ...current, angle: event.target.value })) }),
        ),
        h('div', { className: 'sv-section-head' },
          h('span', { className: 'sv-as-label' }, `参与渠道（初始已全选 · 已选 ${selectedCount}）`),
          h('span', { className: 'sv-actions' },
            h('button', { type: 'button', className: 'sv-tp-acct-link', disabled: Boolean(busy), onClick: selectAllSources }, '全选'),
            h('button', { type: 'button', className: 'sv-tp-acct-link', disabled: Boolean(busy), onClick: clearSources }, '清空'),
          ),
        ),
        h('p', { className: 'sv-tp-acct-note' }, '与选题页同一套渠道卡。执行时会先补采当天缺失的渠道；点渠道名可查看信号并排除单条。'),
        sourcesState === 'pending' ? h('p', { className: 'sv-note', 'aria-busy': 'true' }, '正在读取信号源…')
          : sourcesState === 'error' ? h('p', { className: 'sv-error', role: 'alert' }, '信号源读取失败。请检查网络与工作台服务后刷新页面。')
            : publicCards.length ? h('div', { className: 'sv-tp-srcgrid' }, publicCards.map(sourceCard))
              : h('p', { className: 'sv-note' }, '还没有可用的信号源。可在「信号」页启用渠道。'),
        platformCards.length ? h(React.Fragment, null,
          h('span', { className: 'sv-as-label' }, 'AI 内容日报（报告导入 · 按平台）'),
          h('div', { className: 'sv-tp-srcgrid' }, platformCards.map(platformCard)),
        ) : null,
        form.excluded.size ? h('div', { className: 'sv-tp-exclbar' }, h('span', null, `已排除 ${form.excluded.size} 条信号，本任务每次执行都不参与。`), h('button', { type: 'button', disabled: Boolean(busy), onClick: clearExcluded }, '清空排除')) : null,
        h('div', { className: 'sv-as-field' },
          h('span', { className: 'sv-as-label' }, '自动化深度（每轮跑到哪一步就停）'),
          h('div', { className: 'sv-as-depth' }, AS_DEPTHS.map((item) => h('button', { key: item.id, type: 'button', className: 'sv-as-depth-opt', 'data-on': form.depth === item.id ? 'true' : 'false', disabled: Boolean(busy), onClick: () => patchForm((current) => ({ ...current, depth: item.id })) },
            h('strong', null, item.label),
            h('span', null, item.copy),
          ))),
          AS_APPROVING.has(form.depth) ? h('p', { className: 'sv-as-warn' }, h('strong', null, '将自动确认 AI 稿件，不再人工过稿。'), h('span', null, '深度到达「成片」或更深时，自动化会代为确认稿件后继续配音与渲染。想保留人工把关请选「写稿」档：跑完停在稿件等你确认。')) : null,
          form.depth === 'publish' ? h('div', { className: 'sv-as-field' },
            h('span', { className: 'sv-as-label' }, '投递到哪个平台账号'),
            publishAccounts.length
              ? h('div', { className: 'sv-as-grid2' },
                h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '发布账号'),
                  h('select', { className: 'sv-select', value: form.publishAccountId, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, publishAccountId: event.target.value })) },
                    h('option', { value: '' }, '选择账号'),
                    publishAccounts.map((account) => h('option', { key: account.id, value: account.id }, `${account.platformLabel} · ${account.label}${account.status === 'active' ? '' : '（登录已失效）'}`)),
                  )),
                h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '投递方式'),
                  h('select', { className: 'sv-select', value: form.publishSubmitMode, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, publishSubmitMode: event.target.value })) },
                    h('option', { value: 'confirm' }, '发布前确认（推荐）：填好资料，停在提交前'),
                    h('option', { value: 'auto' }, '自动提交：无人值守直接发布'),
                  )),
              )
              // The reason itself is rendered once by `runtimeBlockers` below;
              // repeating it here would show the operator the same sentence twice.
              : h('p', { className: 'sv-note' }, '还没有可选的平台账号。'),
            form.publishSubmitMode === 'auto' && form.publishAccountId ? h('p', { className: 'sv-as-warn' }, h('strong', null, '将无人值守直接发布到平台。'), h('span', null, '视频上传、标题标签封面填写完成后会自动点击发布按钮，发布后无法撤回。想保留最后一道人工确认请选「发布前确认」。')) : null,
          ) : null,
          // Blockers are filtered by the chosen depth, so the publish reason
          // shows up exactly here and nowhere else.
          runtimeBlockers.length ? h('div', { className: 'sv-as-blockers' }, runtimeBlockers.map((item, index) => h('p', { key: index, className: 'sv-as-warn' }, item.message))) : null,
          runtime && runtime.automationAvailable === false ? h('p', { className: 'sv-error' }, '当前运行环境不提供执行自动化所需的 Agent 服务，任务保存后无法执行。') : null,
        ),
        h('div', { className: 'sv-as-adv' },
          h('p', { className: 'sv-as-adv-title' }, '每轮产量与成片规格'),
          h('div', { className: 'sv-as-grid2' },
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '每轮最多几条'), h('select', { className: 'sv-select', value: String(form.perRunLimit), disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, perRunLimit: Number(event.target.value) })) }, [1, 2, 3].map((item) => h('option', { key: item, value: String(item) }, `${item} 条`)))),
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '视频方向'), h('select', { className: 'sv-select', value: form.orientation, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, orientation: event.target.value })) }, h('option', { value: 'landscape' }, '横屏'), h('option', { value: 'portrait' }, '竖屏'))),
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '稿件篇幅'), h('select', { className: 'sv-select', value: form.scriptTier, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, scriptTier: event.target.value })) }, AS_TIERS.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '字幕'), h('select', { className: 'sv-select', value: form.subtitleEnabled ? 'on' : 'off', disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, subtitleEnabled: event.target.value === 'on' })) }, h('option', { value: 'on' }, '生成字幕'), h('option', { value: 'off' }, '不要字幕'))),
          ),
          h('div', { className: 'sv-as-grid2' },
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '语速'), h('input', { className: 'sv-input', type: 'number', min: '0.5', max: '2', step: '0.05', value: form.voiceRate, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, voiceRate: event.target.value })) })),
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '音量'), h('input', { className: 'sv-input', type: 'number', min: '0', max: '2', step: '0.05', value: form.voiceVolume, disabled: Boolean(busy), onChange: (event) => patchForm((current) => ({ ...current, voiceVolume: event.target.value })) })),
            h('label', { className: 'sv-as-field' }, h('span', { className: 'sv-as-label' }, '语气（选填）'), h('input', { className: 'sv-input', value: form.voiceStyle, maxLength: 200, disabled: Boolean(busy), placeholder: '留空则按音色默认语气合成', onChange: (event) => patchForm((current) => ({ ...current, voiceStyle: event.target.value })) })),
          ),
          // 三模式互斥：这里换的是下面那一个字段，不是叠加。
          svVoiceModePicker({ value: form.voiceSource, disabled: busy, className: 'sv-voice-modes sv-voice-modes-wide', onChange: (mode) => patchForm((current) => ({ ...current, voiceSource: mode })) }),
          form.voiceSource === 'design'
            // design 的唯一输入就是这段描述，后端也判空，所以空的时候直接拦在提交前。
            // 预设卡片与配音页同一份表和同一个组件，两边行为不分叉。
            ? h(React.Fragment, null,
              h('label', { className: 'sv-as-field sv-as-field-wide' }, h('span', { className: 'sv-as-label' }, '音色描述（必填）'), h('input', { className: 'sv-input', value: form.voiceDesignText, maxLength: SV_DESIGN_TEXT_MAX, disabled: Boolean(busy), placeholder: '例：一位三十岁上下、语速偏慢、带点沙哑的中年男声', onChange: (event) => patchForm((current) => ({ ...current, voiceDesignText: event.target.value })) })),
              svVoiceDesignPresets({ value: form.voiceDesignText.trim(), disabled: busy, className: 'sv-design-presets-wide', onChange: (text) => patchForm((current) => ({ ...current, voiceDesignText: text })) }),
              form.voiceDesignText.trim() ? null : h('p', { className: 'sv-as-warn sv-as-field-wide' }, '音色设计模式必须写一段声音描述，否则合成会失败——描述越具体（年龄、声线、语速、气质）出来的音色越接近你想的样子；可以先点上面一个预设再微调。'))
            : form.voiceSource === 'upload'
              ? h('div', { className: 'sv-as-field sv-as-field-wide' },
                h('span', { className: 'sv-as-label' }, '参考音频（必填）'),
                scheduleSavedVoices.length ? h('div', { className: 'sv-voice-library' },
                  h('div', { className: 'sv-voice-library-head' },
                    h('span', { className: 'sv-meta' }, `我的音色库（${scheduleSavedVoices.length}）— 点选即用，每轮都用它`)),
                  h('div', { className: 'sv-voice-library-list' }, scheduleSavedVoices.map((voice) => {
                    const selected = form.voiceReference?.savedVoiceId === voice.id;
                    return h('div', { key: voice.id, className: 'sv-voice-library-item', 'data-selected': selected ? 'true' : 'false' },
                      h('button', { type: 'button', className: 'sv-voice-library-pick', disabled: Boolean(busy), onClick: () => pickScheduleSavedVoice(voice), title: `选用「${voice.name}」` },
                        h('span', { className: 'sv-voice-library-name' }, voice.name),
                        h('span', { className: 'sv-voice-library-meta' }, [voice.durationSeconds ? formatMediaDuration(voice.durationSeconds) : null, formatMediaBytes(voice.bytes)].filter(Boolean).join(' · '))),
                      h('span', { className: 'sv-voice-library-actions' },
                        h('button', { type: 'button', className: 'lwb-plain-button', disabled: voiceRefBusy, onClick: () => { void renameScheduleSavedVoice(voice); }, title: '重命名' }, '重命名'),
                        h('button', { type: 'button', className: 'lwb-plain-button sv-voice-library-delete', disabled: voiceRefBusy, onClick: () => { void deleteScheduleSavedVoice(voice); }, title: '从音色库删除' }, '删除')));
                  }))) : null,
                h('input', { className: 'sv-input', type: 'file', accept: SV_CLONE_ACCEPT, disabled: Boolean(voiceRefBusy || busy), onChange: (event) => { void pickScheduleVoiceReference(event.target.files?.[0] || null); event.target.value = ''; } }),
                h('p', { className: 'sv-note' }, scheduleSavedVoices.length ? '上面选一个每轮固定用它，或从下面再传新音色（上传后自动存进音色库）。' : '上传过的参考音频会自动存进音色库，下次建任务直接选。'),
                voiceRefBusy ? h('p', { className: 'sv-note' }, '正在读取并上传参考音频…')
                  : form.voiceReference ? h('p', { className: 'sv-note' }, `已选用：${form.voiceReference.name}。换一个文件或库条目会切换音色。`)
                    : h('p', { className: 'sv-note' }, '只支持 wav 和 mp3；m4a / aac 等格式需要先转成 wav，否则合成会失败。'),
                voiceRefError ? h('p', { className: 'sv-error', role: 'alert' }, voiceRefError) : null)
              : h('label', { className: 'sv-as-field sv-as-field-wide' }, h('span', { className: 'sv-as-label' }, '音色'), svVoiceSelect({ value: form.voiceId, disabled: busy, onChange: (voiceId) => patchForm((current) => ({ ...current, voiceId })), options: Array.isArray(runtime?.media?.mimoVoices) && runtime.media.mimoVoices.length ? runtime.media.mimoVoices : SV_MIMO_BUILTIN_VOICES, include: form.voiceId })),
          form.voiceSource === 'preset' && SV_MIMO_VOICE_HINTS[form.voiceId] ? h('p', { className: 'sv-as-warn sv-as-warn-soft' }, `当前音色「${form.voiceId}」：${SV_MIMO_VOICE_HINTS[form.voiceId]}`) : null,
          SV_VOICE_STYLE_PRESETS.length ? h('div', { className: 'sv-style-presets' }, h('span', { className: 'sv-meta' }, '常用语气'), SV_VOICE_STYLE_PRESETS.map((style) => h('button', { key: style, type: 'button', className: 'sv-filter-chip', 'data-on': form.voiceStyle === style ? 'true' : 'false', disabled: Boolean(busy), onClick: () => patchForm((current) => ({ ...current, voiceStyle: current.voiceStyle === style ? '' : style })) }, style.replace(/[，。]$/u, '')))) : null,
          h('label', { className: 'sv-as-field' },
            h('span', { className: 'sv-as-label' }, '画面制作说明（选填）'),
            h('textarea', { className: 'sv-textarea', style: { minHeight: '58px' }, value: form.visualBrief, maxLength: 6000, disabled: Boolean(busy), placeholder: '留空则交给 AI 视觉导演按稿件语义自由发挥', onChange: (event) => patchForm((current) => ({ ...current, visualBrief: event.target.value })) }),
          ),
          h('p', { className: 'sv-as-task-note' }, '上面选的音色方式（预置音色 / 音色设计 / 声音克隆）对本任务的每一轮都生效。建议先「立即执行」一轮试听效果再交给定时。'),
        ),
        h('div', { className: 'sv-actions' },
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || !formValid, onClick: submit }, busy === 'save' ? '正在保存…' : editing ? '保存修改' : '创建任务'),
          editing ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: cancelEdit }, '取消编辑，恢复为新建') : null,
          !form.name.trim() ? h('span', { className: 'sv-meta' }, '请填写任务名称')
            : !sortedDays.length ? h('span', { className: 'sv-meta' }, '请至少选择一个执行日')
              : selectedCount === 0 ? h('span', { className: 'sv-meta' }, '至少选择一个参与渠道')
                : !voiceReady ? h('span', { className: 'sv-meta' }, '请选择一个音色') : null,
        ),
      );

      const scopedSchedules = schedules.filter((item) => (activeTab === GENERAL_TAB ? !item.accountId : item.accountId === activeTab));
      const runningRunOf = (scheduleId) => runs.find((run) => run.scheduleId === scheduleId && run.status === 'running') || null;
      const latestRunOf = (scheduleId) => runs.find((run) => run.scheduleId === scheduleId) || null;
      const taskCard = (schedule) => {
        const running = runningRunOf(schedule.id);
        const latest = schedule.latestRun || latestRunOf(schedule.id);
        const badge = running ? ['执行中', ''] : schedule.disabledReason ? ['不可用', 'sv-status-error'] : schedule.enabled ? ['启用', 'sv-stage'] : ['停用', 'sv-status-disabled'];
        const blocked = blockersFor(schedule.depth);
        return h('div', { key: schedule.id, className: 'sv-tp-task sv-as-task', 'data-status': running ? 'running' : 'idle', 'data-disabled': schedule.disabledReason ? 'true' : 'false' },
          h('div', { className: 'sv-tp-task-head' },
            h('div', { style: { minWidth: 0 } },
              h('p', { className: 'sv-tp-task-title' }, schedule.name),
              h('p', { className: 'sv-tp-task-meta' }, `${schedule.daysLabel} ${schedule.time} · 深度「${schedule.depthLabel}」· 每轮 ${schedule.perRunLimit} 条 · ${schedule.production.orientation === 'landscape' ? '横屏' : '竖屏'}`),
            ),
            h('span', { className: 'sv-tp-task-badges' },
              schedule.approvesScript ? h('span', { className: 'sv-tag sv-status-manual', title: '该深度会自动确认 AI 稿件' }, '自动确认稿件') : null,
              h('span', { className: `sv-tag ${badge[1]}` }, badge[0]),
            ),
          ),
          schedule.disabledReason ? h('p', { className: 'sv-as-disabled' }, schedule.disabledReason) : null,
          blocked.length ? h('p', { className: 'sv-as-disabled' }, blocked[0].message) : null,
          running ? h('p', { className: 'sv-as-task-note' }, `正在执行「${AS_STEPS[running.step] || running.step || '—'}」· ${relativeTime(running.triggeredAt)}触发`)
            : latest ? h('p', { className: 'sv-as-task-note' }, `最近 ${relativeTime(latest.triggeredAt)} · ${runStatusLabel(latest)}${latest.itemCount ? ` · ${latest.itemCount} 条` : ''}${latest.message ? ` · ${latest.message}` : ''}`)
              : h('p', { className: 'sv-as-task-note' }, schedule.enabled ? `下次执行：${schedule.nextRunAt ? formatTime(schedule.nextRunAt) : '—'}` : '任务已停用，不会自动执行。'),
          h('div', { className: 'sv-tp-task-acts' },
            h('button', { type: 'button', className: 'lwb-plain-button', title: '查看该任务的全部执行记录', onClick: () => setHistorySchedule(schedule) }, '运行记录'),
            running ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy), onClick: () => invoke('cancelScheduleRun', { runId: running.id }, `cancel:${running.id}`, { title: '停止本轮执行？', copy: `停止「${schedule.name}」的本轮自动化？已完成的阶段产物会保留，未开始的阶段不再推进。`, confirm: '停止本轮', danger: true }, () => setHistoryRefresh((value) => value + 1)) }, busy === `cancel:${running.id}` ? '正在停止…' : '停止本轮')
              : h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || Boolean(schedule.disabledReason) || blocked.length > 0, onClick: () => invoke('runSchedule', { scheduleId: schedule.id }, `run:${schedule.id}`, { title: '立即执行一次？', copy: `按「${schedule.name}」的当前配置立即跑一轮，深度「${schedule.depthLabel}」。${schedule.approvesScript ? '将自动确认 AI 稿件。' : ''}一轮可能耗时十几分钟到一小时，期间可随时停止。`, confirm: '立即执行' }, () => { setHistorySchedule(schedule); setHistoryRefresh((value) => value + 1); }) }, busy === `run:${schedule.id}` ? '正在启动…' : '立即执行'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy) || Boolean(running), onClick: () => startEdit(schedule) }, '编辑'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy) || Boolean(running) || Boolean(schedule.disabledReason), onClick: () => invoke('setScheduleEnabled', { scheduleId: schedule.id, enabled: !schedule.enabled }, `toggle:${schedule.id}`, { title: schedule.enabled ? '停用任务？' : '启用任务？', copy: schedule.enabled ? `停用「${schedule.name}」后不再到点自动执行，历史记录保留。` : `启用「${schedule.name}」后将在 ${schedule.daysLabel} ${schedule.time} 自动执行。`, confirm: schedule.enabled ? '停用' : '启用', danger: schedule.enabled }) }, schedule.enabled ? '停用' : '启用'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy) || Boolean(running), onClick: () => invoke('deleteSchedule', { scheduleId: schedule.id }, `delete:${schedule.id}`, { title: '删除任务？', copy: `删除「${schedule.name}」及其全部运行历史？此操作不可撤销；已生成的项目与成片不受影响。`, confirm: '删除', danger: true }) }, '删除'),
          ),
        );
      };

      const taskPanel = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '定时任务'), h('span', { role: 'status', 'aria-live': 'polite' }, anyRunning ? '有任务正在执行' : `${scopedSchedules.length} 个任务`)),
        scopedSchedules.length ? h('div', { className: 'sv-list' }, scopedSchedules.map(taskCard)) : h('div', { className: 'sv-empty' }, '当前账号下还没有定时任务。左侧配置后点「创建任务」。'),
      );

      const enabledSchedules = schedules.filter((item) => item.enabled && !item.disabledReason);
      const nextRun = enabledSchedules.map((item) => item.nextRunAt).filter(Boolean).sort()[0] || null;
      const lastRun = runs[0] || null;
      const hero = h(HeroMini, { cells: [
        { label: '启用中任务', value: String(enabledSchedules.length), tone: 'brand' },
        { label: '下次执行', value: nextRun ? formatTime(nextRun) : '—', tone: nextRun ? 'green' : undefined },
        { label: '最近产出', value: lastRun ? `${lastRun.itemCount || 0} 条` : '—', tone: lastRun?.itemCount ? 'brand' : undefined },
        { label: '最近结果', value: lastRun ? runStatusLabel(lastRun) : '—', tone: lastRun ? runStatusTone(lastRun) : undefined },
      ] });

      const signalsDrawerNode = signalDrawer && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: () => setSignalDrawer(null) }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': signalDrawer.name },
          h(SignalDrawerBody, { packId, sources, spec: signalDrawer, today: board?.today, busy: Boolean(busy), onClose: () => setSignalDrawer(null), onCollect: (ids) => { void remote(packId, 'collectSources', { sourceIds: ids }).then(() => remote(packId, 'board')).then(setBoard).catch((cause) => fail(cause.message)); }, onChanged: () => { void remote(packId, 'board').then(setBoard).catch(() => {}); }, ask, selection: { excluded: form.excluded, onToggle: toggleExclude } }),
        ),
      );

      const goPublish = (projectId) => { publishHandoff = { packId, projectId }; setHistorySchedule(null); openPackMenu?.('publish'); };
      const continueItem = (item) => { setHistorySchedule(null); if (item.scriptChars != null) audioCaptionsHandoff = item.projectId; openPackMenu?.(item.scriptChars != null ? 'audio-captions' : 'scripts'); };
      const runDetailDrawer = historySchedule && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭运行记录', onClick: () => setHistorySchedule(null) }),
        h('aside', { className: 'sv-drawer sv-drawer-wide sv-as-history-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '运行记录' },
          h('div', { className: 'sv-drawer-head' }, h('div', null, h('p', { className: 'sv-ex-kicker' }, '内容安排 / 执行记录'), h('h3', null, historySchedule.name), h('p', { className: 'sv-meta' }, '每一轮单独记录，点击展开执行过程。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setHistorySchedule(null) }, '关闭')),
          h('div', { className: 'sv-drawer-scroll' }, h(ScheduleRunHistory, { key: historySchedule.id, packId, scheduleId: historySchedule.id, refreshKey: historyRefresh, onPublish: goPublish, onContinue: continueItem })),
        ),
      );
      // 弹窗上的「查看」：直接跳到那条轮次所属任务的执行记录抽屉，并刷新一次，
      // 这样用户点进来看到的就是刚结束那轮，而不是抽屉里停留的旧读数。
      const openRunFromToast = React.useCallback((toast) => {
        const schedule = schedules.find((item) => item.id === toast.scheduleId);
        if (!schedule) return;
        setHistorySchedule(schedule);
        setHistoryRefresh((value) => value + 1);
      }, [schedules]);

      return h(PackFrame, { packId, openConversation, title: '内容安排', accent: 'sky', copy: '按账号配置定时任务：到点后由主机侧调度器无人值守跑完「选题 → 写稿 → 配音字幕 → 成片质检 → 发布资料 → 投递到平台」。深度决定跑到哪一步；选到成片及以后会自动确认 AI 稿件。选「投递到平台」时，默认停在平台的发布按钮前等你确认；只有把投递方式设为「自动提交」，才会无人值守直接发布。', hero, introActions: h(NotifyToggle) },
        h(ToastStack, { toasts, onDismiss: dismissToast, onOpenRun: (toastId) => {
          const toast = toasts.find((item) => item.id === toastId);
          if (toast) openRunFromToast(toast);
        } }),
        h(Notice, { error }),
        h(QueueBar, { queue }),
        h(FailurePanel, { failures, busy, onResume: resumeInterrupted }),
        h('section', { className: 'sv-split' }, configCard, taskPanel),
        signalsDrawerNode,
        runDetailDrawer,
        confirmNode,
        schedulePromptNode,
      );
    }
    function mediaRunLabel(type) { return ({ voiceover: '配音生成', subtitles: '字幕对齐', video: '视频渲染', qc: '技术质检' })[type] || type; }
    /**
     * 前置条件预检：在用户点按钮之前就把「缺什么」说清楚。
     *
     * 为什么要单独做这一层：媒体工具链的缺失原本要等到很晚才暴露——
     *   · 没装 ffmpeg：点了配音，在媒体主机里拿到「ffprobe失败：spawn ffprobe ENOENT」；
     *   · 没装 Remotion：点了生成视频，AI 导演跑十几分钟、预检都过了，
     *     才在渲染阶段收到「当前安装未包含 Remotion 渲染器」。
     * 两种都是「等半天才失败」，而它们本来在页面挂载时就能判断。
     *
     * 返回 null 表示没有阻断项。
     */
    function MediaPreflight({ service, need }) {
      if (!service) return null;
      const tools = service.mediaTools || null;
      const rows = [];
      if (need === 'video') {
        if (service.renderers?.remotion === false) {
          rows.push('未检测到 Remotion 渲染器：视频无法渲染。请在项目根目录执行 npx --no-install remotion browser ensure 后重启工作台。');
        }
        if (tools && !tools.available) {
          const missing = [tools.ffmpeg?.available === false ? 'ffmpeg' : null, tools.ffprobe?.available === false ? 'ffprobe' : null].filter(Boolean);
          rows.push(`未检测到 ${missing.join(' 与 ')}：视频抽帧、质检与时长检测都会失败。请安装 FFmpeg 并确保它在 PATH 中。`);
        }
      }
      if (need === 'audio' && tools && !tools.available) {
        const missing = [tools.ffmpeg?.available === false ? 'ffmpeg' : null, tools.ffprobe?.available === false ? 'ffprobe' : null].filter(Boolean);
        rows.push(`未检测到 ${missing.join(' 与 ')}：配音的语速/音量处理与时长检测会失败。请安装 FFmpeg 并确保它在 PATH 中。`);
      }
      if (!rows.length) return null;
      return h('div', { className: 'sv-preflight', role: 'alert' },
        h('strong', null, '当前环境还差一步，现在开始会失败：'),
        h('ul', null, rows.map((text, index) => h('li', { key: index }, text))),
      );
    }
    function mediaStatusLabel(status) { return ({ queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断，可继续' })[status] || status; }
    // 服务端原始错误文案必须原样透传（例如 Invalid API key、限流提示），
    // 只剥掉传输层的 `Error [CODE]` 前缀，不做意译——把原文吞掉等于让用户无从下手。
    function mediaErrorText(error) {
      const value = String(error || '').replace(/^Error \[[A-Z0-9_]+\]\s*/u, '');
      return /(?:insufficient[ _-]*points|积分不足|余额不足)/iu.test(value)
        ? `${value}（账户额度不足：请在「连接配置」中检查该服务的余额或额度）`
        : value;
    }
    function videoPhaseLabel(phase) { return ({ preparing: '正在准备制作空间', directing: 'AI 视觉导演创作中', preflight: '正在检查 Remotion 工程', rendering: '正在渲染成片', 'technical-qc': '正在执行技术质检', 'editorial-review': '独立审片中', 'editorial-repair': '正在按审片意见修复', committing: '正在提交成片', completed: '已完成', failed: '失败' })[phase] || null; }
    // 视频制作的固定阶段顺序，用于把 pipeline.stages 渲染成步骤条。
    const VIDEO_PIPELINE_STAGES = [
      { id: 'preparing', label: '准备' },
      { id: 'directing', label: 'AI 导演' },
      { id: 'preflight', label: '预检' },
      { id: 'rendering', label: '渲染' },
      { id: 'technical-qc', label: '技术质检' },
      { id: 'editorial-review', label: '独立审片' },
      { id: 'committing', label: '提交成片' },
    ];
    /**
     * 每个阶段一句人话：说「这一步在干嘛、为什么值得等」。
     *
     * 步骤条上的「AI 导演」只说了是谁在干活，没说在干什么；用户等十几分钟时
     * 最想知道的是「它现在具体在做哪件事」，而不是阶段编号。
     * 文案只描述**已知在做的事**，不承诺剩余时间——耗时不可预测，猜就是骗人。
     */
    const VIDEO_PHASE_HINT = {
      preparing: '正在为这次制作准备空间。',
      directing: 'AI 正在设计分镜和画面。',
      preflight: '正在检查工程，避免渲染到一半才发现问题。',
      rendering: '正在逐帧生成画面，这一步最花时间。',
      'technical-qc': '正在检查画质、音轨和字幕。',
      'editorial-review': '另一个 AI 正在看你的片子挑毛病。',
      committing: '马上就好，正在提交成片。',
    };
    // 当前阶段超过这个时长没有任何新阶段事件，就要显式告诉用户「它没死」。
    const VIDEO_STALL_SECONDS = 30;
    /**
     * 后端沉默超过这个秒数，措辞就从「还在跑」换成「可能卡住了」。
     *
     * 5 分钟是按现有阶段耗时定的：渲染单帧、打包工程、审片重跑都可能连续
     * 几分钟不写事件，比这更短的阈值会把正常慢阶段误报成卡死。
     * 超过它还没动静，就该把人从等待里捞出来，而不是继续安慰。
     */
    const VIDEO_SILENT_ALARM_SECONDS = 300;
    function formatElapsed(seconds) {
      const value = Math.max(0, Math.floor(Number(seconds) || 0));
      if (value < 60) return `${value} 秒`;
      const minutes = Math.floor(value / 60); const rest = value % 60;
      if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
      const hours = Math.floor(minutes / 60);
      return `${hours} 小时 ${minutes % 60} 分`;
    }
    /**
     * 把运行中的视频任务整理成步骤条 + 计时所需的形状。
     * 只表达后端确实记录过的事实：某阶段何时开始、何时结束。
     * 不推断"还剩多久"，因为 AI 导演与渲染的耗时不可预测。
     */
    function videoTaskProgress(task, now) {
      const pipeline = task?.pipeline;
      if (!pipeline || typeof pipeline !== 'object') return null;
      const stages = pipeline.stages && typeof pipeline.stages === 'object' ? pipeline.stages : {};
      const phase = task.phase || pipeline.phase || null;
      const activeIndex = VIDEO_PIPELINE_STAGES.findIndex((item) => item.id === phase);
      const steps = VIDEO_PIPELINE_STAGES.map((item, index) => {
        const record = stages[item.id];
        const started = Date.parse(record?.startedAt || '');
        const completed = Date.parse(record?.completedAt || '');
        // 后端只把已结束的阶段标成 succeeded；当前阶段据 phase 判断。
        const isActive = item.id === phase && task.status === 'running';
        const status = record?.status === 'failed' ? 'failed'
          : record?.status === 'succeeded' || (task.status === 'succeeded') ? 'done'
            : isActive ? 'active'
              : activeIndex >= 0 && index < activeIndex ? 'done' : 'pending';
        return {
          id: item.id, label: item.label, status,
          seconds: Number.isFinite(started) ? ((Number.isFinite(completed) ? completed : now) - started) / 1000 : null,
        };
      });
      const startedMs = Date.parse(task.startedAt || pipeline.startedAt || '');
      const endedMs = Date.parse(task.completedAt || pipeline.completedAt || '');
      const totalSeconds = Number.isFinite(startedMs)
        ? ((Number.isFinite(endedMs) ? endedMs : now) - startedMs) / 1000
        : null;
      const activeSeconds = steps.find((step) => step.status === 'active')?.seconds ?? null;
      const repairs = pipeline.editorialRepair;
      // 渲染阶段的真实进度：Remotion 自己报告已完成帧数与剩余时间。
      // 这是真值，不是估算，所以优先于历史参考值展示。
      const rawRender = pipeline.render && typeof pipeline.render === 'object' ? pipeline.render : null;
      const render = rawRender && Number.isFinite(rawRender.percent)
        ? {
          stage: rawRender.stage || 'rendering',
          percent: Math.max(0, Math.min(100, Number(rawRender.percent))),
          done: Number.isFinite(rawRender.done) ? Number(rawRender.done) : null,
          total: Number.isFinite(rawRender.total) ? Number(rawRender.total) : null,
          remainingSeconds: Number.isFinite(rawRender.remainingSeconds) ? Number(rawRender.remainingSeconds) : null,
          // 后端每次写入渲染进度都会带 updatedAt（spoken-video-media-host.mjs
          // #setVideoRenderProgress）。这是**后端时钟**的最后一次动作时间，
          // 与界面每秒滴答的本地 setInterval 是两回事——后者后端死了也照样跳。
          updatedAt: typeof rawRender.updatedAt === 'string' && Number.isFinite(Date.parse(rawRender.updatedAt))
            ? rawRender.updatedAt
            : null,
        }
        : null;
      // 「后端沉默多久」只从**会持续更新的**后端时间戳算。
      //
      // 关键区分：`#setVideoRenderProgress` 在渲染阶段每几秒写一次 `render.updatedAt`；
      // 而 `#setVideoPhase` 对其它阶段只在**阶段开始那一刻**写一次 `startedAt`，
      // 整个 AI 导演 / 预检 / 审片跑完都不再落任何记录（见 media-host.mjs:3924）。
      //
      // 所以：
      //  · 只有 `render.updatedAt` 能回答「后端还活着吗」——它是心跳。
      //  · `stages[phase].startedAt` 只是**出生时间**。拿它算沉默，会把每个本来就要
      //    跑十几分钟的导演/审片阶段误判成「卡住」，狼来了两次之后真卡住也没人信。
      //
      // 「没有证据说明它活着」和「有证据说明它死了」是两回事。只有后者才配报警。
      const heartbeatMs = typeof render?.updatedAt === 'string' ? Date.parse(render.updatedAt) : NaN;
      const hasHeartbeat = Number.isFinite(heartbeatMs);
      return {
        steps,
        phase,
        label: videoPhaseLabel(phase) || mediaStatusLabel(task.status),
        totalSeconds,
        activeSeconds,
        // 距上一次**后端心跳**过了多久（秒）。没有心跳源就是 null——此时界面
        // 只说「已持续多久」，不推断死活。
        silentSeconds: hasHeartbeat ? Math.max(0, (now - heartbeatMs) / 1000) : null,
        render,
        // 修复重试：后端记录 attempts/maxAttempts，重试期间必须让用户看见，
        // 否则长耗时的修复看起来就像卡死。
        repair: repairs && Number(repairs.attempts) > 0
          ? { attempts: Number(repairs.attempts), maxAttempts: Number(repairs.maxAttempts) || 0 }
          : null,
        attempts: Number(pipeline.preflight?.attempt) || null,
      };
    }
    /** 已完成任务的真实总耗时，用于给出"参考历史"的诚实区间。 */
    function videoTaskDurationSeconds(task) {
      const pipeline = task?.pipeline;
      const start = Date.parse(task?.startedAt || pipeline?.startedAt || '');
      const end = Date.parse(task?.completedAt || pipeline?.completedAt || '');
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : null;
    }
    function formatEtaRange(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value <= 0) return null;
      const minutes = value / 60;
      if (minutes < 2) return '约 1–2 分钟';
      // 用 ±25% 的区间表达不确定性，避免给出虚假的精确单点值。
      const low = Math.max(1, Math.round(minutes * 0.75));
      const high = Math.max(low + 1, Math.round(minutes * 1.25));
      return `约 ${low}–${high} 分钟`;
    }
    /**
     * 用历史已完成任务的中位耗时估算参考区间。
     * 样本不足时返回 null —— 宁可不显示，也不给错误预期。
     */
    function videoEtaFromHistory(tasks, revision) {
      const durations = (tasks || [])
        .filter((item) => item.status === 'succeeded')
        .map(videoTaskDurationSeconds)
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
      if (durations.length < 3) return null;
      const middle = Math.floor(durations.length / 2);
      const median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
      return { range: formatEtaRange(median), sample: durations.length, seconds: median };
    }
    function mediaDataUrl(media) { return media?.data && media?.mediaType ? `data:${media.mediaType};base64,${media.data}` : null; }
    function downloadBase64(media, filename) {
      if (!media?.data) return;
      const decoded = globalThis.atob(media.data); const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
      const url = URL.createObjectURL(new Blob([bytes], { type: media.mediaType || 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    function MediaRunList({ runs, onCancel, onResume }) {
      if (!runs?.length) return null;
      const items = runs.slice(0, 12).map((run) => h(
        'article',
        { key: run.id, className: 'sv-item', 'data-status': run.status },
        h('div', { className: 'sv-item-head' },
          h('strong', null, mediaRunLabel(run.type)),
          h('span', { className: `sv-tag ${['failed', 'cancelled'].includes(run.status) ? 'sv-status-error' : run.status === 'succeeded' ? 'sv-stage' : run.status === 'interrupted' ? 'sv-status-warn' : 'sv-status-manual'}` }, mediaStatusLabel(run.status)),
        ),
        h('p', { className: 'sv-meta' }, `${formatTime(run.createdAt)} · 版本 ${run.expectedRevision}`),
        run.error ? h('p', { className: 'sv-error' }, run.error) : null,
        // 运行中的任务给一个真的能停下来的取消按钮（服务端会中止 ffmpeg 与请求）。
        run.status === 'running' && onCancel
          ? h('button', { type: 'button', className: 'lwb-secondary-button', onClick: () => onCancel(run) }, '停止这个任务')
          : null,
        // 重启导致的中断不再让人从头再来：已完成阶段会跳过。
        run.status === 'interrupted' && onResume
          ? h('button', { type: 'button', className: 'lwb-primary-button', onClick: () => onResume(run) }, '从断点继续')
          : null,
      ));
      return h(
        'section',
        { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '媒体任务'), h('span', null, `${runs.length} 条`)),
        h('div', { className: 'sv-list sv-run-list' }, items),
      );
    }
    function useMediaRuns(packId, projectId, refreshProjects, reloadDetail, setError) {
      const [service, setService] = React.useState(null); const [runs, setRuns] = React.useState([]); const [busy, setBusy] = React.useState(null);
      const refreshRuns = React.useCallback(async () => {
        if (!packId) { setService(null); setRuns([]); return; }
        try {
          const [nextService, nextRuns] = await Promise.all([remoteStatic('mediaStatus'), projectId ? remote(packId, 'mediaOperations', { projectId }) : Promise.resolve([])]);
          setService(nextService); setRuns(nextRuns); setError(null);
          if (projectId && nextRuns.some((run) => run.status === 'succeeded' || run.status === 'failed')) { await refreshProjects(); await reloadDetail(projectId); }
        } catch (cause) { setError(cause.message); }
      }, [packId, projectId, refreshProjects, reloadDetail, setError]);
      React.useEffect(() => { void refreshRuns(); }, [refreshRuns]);
      React.useEffect(() => {
        if (!runs.some((run) => ['queued', 'running', 'interrupted'].includes(run.status))) return undefined;
        const timer = setInterval(() => { void refreshRuns(); }, 1800); return () => clearInterval(timer);
      }, [runs, refreshRuns]);
      const start = React.useCallback(async (method, request, marker) => {
        setBusy(marker);
        try { const started = await remote(packId, method, request); await refreshRuns(); setError(null); return started; } catch (cause) { setError(cause.message); return null; } finally { setBusy(null); }
      }, [packId, refreshRuns, setError]);
      // 取消与续跑都走 start，复用同一套 busy / 错误上报。
      const cancel = React.useCallback(async (run) => {
        setBusy(`cancel:${run.id}`);
        try { await remote(packId, 'cancelMediaRun', { runId: run.id }); await refreshRuns(); setError(null); }
        catch (cause) { setError(cause.message); }
        finally { setBusy(null); }
      }, [packId, refreshRuns, setError]);
      const resume = React.useCallback(async (run) => {
        setBusy(`resume:${run.id}`);
        try { await remote(packId, 'resumeMediaRun', { runId: run.id, projectId: run.projectId }); await refreshRuns(); setError(null); }
        catch (cause) { setError(cause.message); }
        finally { setBusy(null); }
      }, [packId, refreshRuns, setError]);
      return { service, runs, busy, start, cancel, resume, refreshRuns };
    }
    function useMediaTasks(packId, setError) {
      const [tasks, setTasks] = React.useState([]);
      const refresh = React.useCallback(async () => {
        if (!packId) { setTasks([]); return []; }
        try { const next = await remote(packId, 'listMediaTasks'); setTasks(next); return next; }
        catch (cause) { setError(cause.message); return []; }
      }, [packId, setError]);
      React.useEffect(() => { void refresh(); }, [refresh]);
      const anyRunning = tasks.some((task) => task.status === 'queued' || task.status === 'running');
      React.useEffect(() => {
        if (!anyRunning) return undefined;
        const timer = setInterval(() => { void refresh(); }, 1800);
        return () => clearInterval(timer);
      }, [anyRunning, refresh]);
      return { tasks, refresh, anyRunning };
    }
    function useAudioTasks(packId, query, status, page, scope, setError, refreshProjects) {
      const emptyResult = { items: [], total: 0, counts: { all: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } };
      const [result, setResult] = React.useState(emptyResult);
      const [loading, setLoading] = React.useState(false);
      const requestKey = JSON.stringify([packId, query, status, page, scope.accountId, scope.general]);
      const currentKey = React.useRef(requestKey);
      const requestVersion = React.useRef(0);
      currentKey.current = requestKey;
      const refresh = React.useCallback(async () => {
        const version = ++requestVersion.current;
        const isCurrent = () => currentKey.current === requestKey && requestVersion.current === version;
        if (!packId) { setResult({ ...emptyResult, requestKey }); return null; }
        setLoading(true);
        try {
          const next = await remote(packId, 'listAudioTasks', { query, status, offset: page * 8, limit: 8, ...(scope.accountId ? { accountId: scope.accountId } : {}), ...(scope.general ? { general: true } : {}) });
          if (!isCurrent()) return null;
          setResult({ ...next, requestKey }); setError(null); await refreshProjects(); return next;
        } catch (cause) {
          if (isCurrent()) { setResult({ ...emptyResult, requestKey }); setError(cause.message); }
          return null;
        } finally { if (isCurrent()) setLoading(false); }
      }, [packId, query, status, page, scope.accountId, scope.general, requestKey, setError, refreshProjects]);
      React.useEffect(() => { void refresh(); return () => { requestVersion.current += 1; }; }, [refresh]);
      const current = result.requestKey === requestKey ? result : emptyResult;
      const anyRunning = current.counts.queued > 0 || current.counts.running > 0 || current.items.some((task) => ['queued', 'running'].includes(task.subtitle?.status));
      React.useEffect(() => {
        if (!anyRunning) return undefined;
        const timer = setInterval(() => { void refresh(); }, 1800);
        return () => clearInterval(timer);
      }, [anyRunning, refresh]);
      return { ...current, loading: loading || result.requestKey !== requestKey, refresh, anyRunning };
    }
    function useVideoTasks(packId, query, status, page, scope, setError, refreshProjects) {
      const [result, setResult] = React.useState({ items: [], total: 0, counts: { all: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } });
      const [loading, setLoading] = React.useState(false);
      const refresh = React.useCallback(async () => {
        if (!packId) { setResult({ items: [], total: 0, counts: { all: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } }); return null; }
        setLoading(true);
        try {
          const next = await remote(packId, 'listVideoTasks', { query, status, offset: page * 6, limit: 6, ...(scope.accountId ? { accountId: scope.accountId } : {}), ...(scope.general ? { general: true } : {}) });
          setResult(next); setError(null); await refreshProjects(); return next;
        } catch (cause) { setError(cause.message); return null; } finally { setLoading(false); }
      }, [packId, query, status, page, scope.accountId, scope.general, setError]);
      React.useEffect(() => { void refresh(); }, [refresh]);
      const anyRunning = result.items.some((task) => task.status === 'queued' || task.status === 'running');
      React.useEffect(() => {
        if (!anyRunning) return undefined;
        const timer = setInterval(() => { void refresh(); void refreshProjects(); }, 1800);
        return () => clearInterval(timer);
      }, [anyRunning, refresh, refreshProjects]);
      // 渲染成功后自动补一份发布文案（不含封面）。原先只在用户点开发布页抽屉时
      // 才生成，于是「跑完 → 打开发布页 → 未生成」成了常态，看着像白跑了
      // （2026-10-08 反馈）。后端 autoStartPackaging 幂等：已有 packaging 或已在跑
      // 都会自己跳过，所以这里可以对每个成功任务放心重复调用。
      const autoPackaging = React.useRef(new Set());
      React.useEffect(() => {
        if (!packId) return;
        for (const task of result.items) {
          if (task.status !== 'succeeded' || !task.projectId) continue;
          const key = `${task.projectId}:${task.expectedRevision ?? ''}`;
          if (autoPackaging.current.has(key)) continue;
          autoPackaging.current.add(key);
          void remote(packId, 'autoStartPackaging', { projectId: task.projectId })
            .then((outcome) => {
              // 被后端拒绝（已有资料/已在跑/没过质检）是正常情况，不打扰用户；
              // 只在真正出错时提示，且不阻断视频页。
              if (outcome?.started) void refreshProjects();
            })
            .catch((cause) => { autoPackaging.current.delete(key); setError(cause.message); });
        }
      }, [packId, result.items, refreshProjects, setError]);
      return { ...result, loading, refresh, anyRunning };
    }
    function formatMediaDuration(value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) return '时长待确认';
      const rounded = Math.round(seconds);
      return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
    }
    function formatMediaClock(value) {
      const seconds = Math.max(0, Math.floor(Number(value) || 0));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function subtitleTaskProgress(task, now = Date.now()) {
      const subtitle = task?.subtitle || {};
      if (subtitle.status === 'queued') return { label: '字幕任务正在排队…', button: '字幕排队中…', percent: null };
      if (subtitle.status !== 'running') return null;
      const duration = Number(task?.result?.audio?.durationSeconds);
      const startedAt = Date.parse(subtitle.startedAt || '');
      if (subtitle.input?.provider !== 'bailian' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(startedAt)) {
        return { label: '字幕服务正在处理音频…', button: '字幕生成中…', percent: null };
      }
      const elapsed = Math.max(0, (now - startedAt) / 1000);
      const processed = Math.min(duration, elapsed);
      const percent = Math.min(99, Math.max(1, Math.floor(processed / duration * 100)));
      const remaining = Math.max(0, duration - elapsed);
      return remaining > 0
        ? { label: `实时识别 ${formatMediaClock(processed)} / ${formatMediaClock(duration)} · 约剩 ${formatMediaClock(Math.ceil(remaining))}`, button: `实时识别 ${percent}%`, percent }
        : { label: '音频已发送，正在整理识别结果…', button: '正在整理字幕…', percent: 99 };
    }
    function formatMediaBytes(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes <= 0) return '大小待确认';
      return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
    }
    function subtitleCues(srt) {
      return String(srt || '').trim().split(/\n\s*\n/u).filter(Boolean).map((block, index) => {
        const lines = block.split('\n');
        const time = lines.find((line) => line.includes('-->')) || '';
        const timeIndex = lines.indexOf(time);
        return { id: `${index}-${time}`, time, text: lines.slice(timeIndex + 1).join('\n') };
      });
    }
    function srtFromSubtitleCues(cues) {
      return cues.map((cue, index) => `${index + 1}\n${cue.time}\n${cue.text.trim()}`).join('\n\n');
    }
    function AudioTaskPreview({ packId, taskId, setError }) {
      const [audioUrl, setAudioUrl] = React.useState(null);
      React.useEffect(() => {
        let cancelled = false;
        setAudioUrl(null);
        void remote(packId, 'readAudioTaskMedia', { taskId }).then((next) => {
          if (!cancelled) setAudioUrl(mediaDataUrl(next));
        }).catch((cause) => { if (!cancelled) setError(cause.message); });
        return () => { cancelled = true; };
      }, [packId, taskId, setError]);
      return h('div', { className: 'sv-audio-player' }, audioUrl
        ? h('audio', { controls: true, preload: 'metadata', src: audioUrl })
        : h('p', null, '正在加载音频…'));
    }
    function VideoTaskMediaPreview({ packId, task, stage, setError }) {
      const [mediaUrl, setMediaUrl] = React.useState(null);
      React.useEffect(() => {
        let cancelled = false;
        setMediaUrl(null);
        void remote(packId, 'readVideoTaskMedia', { projectId: task.projectId, taskId: task.id, stage }).then((next) => {
          if (!cancelled) setMediaUrl(mediaDataUrl(next));
        }).catch((cause) => { if (!cancelled) setError(cause.message); });
        return () => { cancelled = true; };
      }, [packId, task.projectId, task.id, stage, setError]);
      if (stage === 'voiceover' || stage === 'bgm') return h('div', { className: 'sv-audio-player' }, mediaUrl
        ? h('audio', { controls: true, preload: 'metadata', src: mediaUrl })
        : h('p', null, stage === 'bgm' ? '正在加载任务 BGM…' : '正在加载任务配音…'));
      return h('div', { className: 'sv-video-stage' }, mediaUrl
        ? h('video', { controls: true, preload: 'metadata', src: mediaUrl })
        : h('p', null, '正在加载成片预览…'));
    }
    /**
     * 未注册的历史项目视图（配音/字幕的项目视图）。
     *
     * **不是当前在用的配音流程**：注册表里 'audio-captions' 挂的是
     * `AudioCaptionsPageV2`，`LegacyAudioCaptionsPageV2` 从未注册，所以这里
     * 的 `startVoiceover` 调用点在运行时走不到，新配音流程一律走
     * `AudioCaptionsPageV2`（三模式：预置音色 / 音色设计 / 声音克隆也在那边）。
     *
     * **保留它的唯一原因是它被测试当切片锚点**：
     * `spoken-video-client.test.mjs` 与 `voice-mimo-only.test.mjs` 都用
     * `source.indexOf('\n    function LegacyAudioCaptionsPageV2(')` 作为
     * 「项目页」范围的终点。删掉这个函数会让那几处 indexOf 返回 -1，从而
     * 误圈整段文件，把大量无关源码纳入切片、让断言失去意义。
     *
     * 所以：不要删，也不要在这里接新功能（接了也不会被执行到，还会让三模式
     * 的守卫出现两个来源）。改它之前先改那三处测试的切片锚点。
     */
    function LegacyAudioCaptionsPageV2({ packId, openConversation }) {
      const { projects, refresh, error, setError } = useProjects(packId);
      // 写稿页只列「已确认稿件」的项目。刚在选题页生成的选题还没走完写稿那一步
      // （stage=topic、scriptApproval 为空），不进这个列表是设计如此：写稿页的
      // 职责就是处理已确认的稿子，待写稿在选题页就地写。详见「字节没发世界模型」
      // 那次的排查结论 —— 试过改成列出所有 stage>=topic 的项目，结果 80 条里
      // 42 条是早就跑完全流程的老项目，新选题反而排到第 39 位，比原样更糟。
      const candidates = projects.filter((project) => project.completedStages.includes('script') && project.scriptApproval?.current);
      const [selectedId, setSelectedId] = useSelectedProject(projects, (project) => project.completedStages.includes('script') && project.scriptApproval?.current);
      const { detail, error: detailError, reload } = useDetail(packId, selectedId);
      const { saving, commit } = useCommit(packId, refresh, reload, setError);
      const media = useMediaRuns(packId, selectedId, refresh, reload, setError);
      const taskFeed = useMediaTasks(packId, setError);
      const [voiceover, setVoiceover] = React.useState('');
      const [subtitles, setSubtitles] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [voiceId, setVoiceId] = React.useState(SV_MIMO_DEFAULT_VOICE);
      const [stylePrompt, setStylePrompt] = React.useState('');
      const [rate, setRate] = React.useState(1);
      const [volume, setVolume] = React.useState(1);
      const [configOpen, setConfigOpen] = React.useState(false);
      const [connectionBusy, setConnectionBusy] = React.useState(null);
      const [openAudioTaskId, setOpenAudioTaskId] = React.useState(null);
      const [subtitleDrawer, setSubtitleDrawer] = React.useState(null);

      React.useEffect(() => {
        setVoiceover(stageData(detail, 'voiceover')?.notes || '');
        setSubtitles(stageData(detail, 'subtitles')?.srt || '');
      }, [detail?.id, detail?.revision]);
      React.useEffect(() => {
        const handoff = audioCaptionsHandoff;
        if (handoff && candidates.some((project) => project.id === handoff)) {
          setSelectedId(handoff);
          audioCaptionsHandoff = null;
          return;
        }
        // Pipeline board handoff: same selection surface, carried per page id.
        if (pipelineHandoff?.page === 'audio-captions' && candidates.some((project) => project.id === pipelineHandoff.projectId)) {
          setSelectedId(pipelineHandoff.projectId);
          pipelineHandoff = null;
        }
      }, [candidates, setSelectedId]);
      if (!packId) return h(NeedPack, { openConversation });

      const scriptBody = stageData(detail, 'script')?.body || '';
      // 渠道固定为白名单里的唯一 provider。不再从 media.service.connection.provider
      // 兜底：那是后端记的「上次用过哪个」，退役渠道的旧值会顺着它渗回 UI。
      const providerId = SV_VOICE_PROVIDER;
      const selectedProvider = media.service?.providers?.[providerId];
      const providerCredential = selectedProvider?.credential;
      const providerLabel = SV_VOICE_PROVIDER_LABEL[providerId] || providerId;
      const mimoVoices = Array.isArray(media.service?.mimoVoices) && media.service.mimoVoices.length ? media.service.mimoVoices : SV_MIMO_BUILTIN_VOICES;
      const referenceVoiceReady = Boolean(selectedProvider?.configured);
      // credentialHint 把「没填」和「填了但被拒」分开：两者 configured 都是 true，
      // 只看 configured 的话，填错 Key 的用户只会看到一句「合成失败」，不知道该换 Key
      // 还是该等限流。missing / rejected / ok 三态直接给状态条，不让用户去猜。
      const credentialHint = selectedProvider?.credentialHint || 'ok';
      const credentialStatus = !selectedProvider?.configured
        ? '服务不可用'
        : !providerCredential?.configured
          ? '需要 API Key'
          : credentialHint === 'rejected'
            ? 'Key 被拒绝，请重新填写'
            : credentialHint === 'missing'
              ? '需要 API Key'
              : '连接已保存';
      const canGenerate = Boolean(selectedProvider?.configured && providerCredential?.configured);
      // 工具链缺失时直接禁用按钮并说明原因，而不是等用户在媒体主机里
      // 看到 spawn ffprobe ENOENT。
      const toolsReady = media.service?.mediaTools?.available !== false;
      const voiceReady = done(detail, 'voiceover');
      const subtitleReady = done(detail, 'subtitles');
      const voiceArtifact = stageData(detail, 'voiceover');
      const subtitleData = stageData(detail, 'subtitles');
      const startVoiceover = async () => {
        if (!detail) return;
        const started = await media.start('startVoiceover', { projectId: detail.id, expectedRevision: detail.revision, provider: providerId, voiceSource: 'preset', voiceId, voiceName: voiceId, ...(stylePrompt.trim() ? { style: stylePrompt.trim() } : {}), rate: Number(rate), volume: Number(volume) }, 'voiceover');
        if (started) void taskFeed.refresh();
      };
      const startSubtitles = async () => {
        if (!detail) return;
        const started = await media.start('startSubtitles', { projectId: detail.id, expectedRevision: detail.revision, provider: providerId, language: 'zh', aiOptimize: true }, 'subtitles');
        if (started) void taskFeed.refresh();
      };
      const saveConnection = async () => {
        if (!apiKey.trim()) return;
        setConnectionBusy('save');
        try {
          const saved = await remoteStatic('configureMediaConnection', { provider: providerId, apiKey });
          setApiKey('');
          await media.refreshRuns();
          setError(null);
        } catch (cause) { setError(cause.message); } finally { setConnectionBusy(null); }
      };
      const clearConnection = async () => {
        setConnectionBusy('clear');
        try {
          const saved = await remoteStatic('clearMediaConnectionCredential', { provider: providerId });
          setApiKey('');
          await media.refreshRuns();
          setError(null);
        } catch (cause) { setError(cause.message); } finally { setConnectionBusy(null); }
      };
      const openSubtitles = async (task) => {
        setSelectedId(task.projectId);
        setSubtitleDrawer({ task, loading: true, project: null, data: null });
        try {
          const project = await remote(packId, 'get', { projectId: task.projectId });
          setSubtitleDrawer({ task, loading: false, project, data: stageData(project, 'subtitles') || null });
        } catch (cause) {
          setError(cause.message);
          setSubtitleDrawer(null);
        }
      };

      const voiceHero = h(HeroMini, { cells: [
        { label: '已确认稿件', value: String(candidates.length), tone: 'brand' },
        { label: '待配音', value: String(candidates.filter((project) => !project.completedStages.includes('voiceover')).length), tone: 'orange' },
        { label: '字幕就绪', value: String(candidates.filter((project) => project.completedStages.includes('subtitles')).length), tone: 'green' },
        { label: '任务状态', value: taskFeed.anyRunning ? '生成中' : '空闲', tone: taskFeed.anyRunning ? 'brand' : 'green' },
      ] });
      const voiceCopy = '从已确认稿件生成可播放配音，并基于真实音频时间轴生成字幕。';

      const providerConfigStrip = h('section', { className: 'sv-media-config-strip' },
        h('div', { className: 'sv-media-config-summary' },
          h('span', { className: 'sv-media-config-mark', 'aria-hidden': 'true' }, '♪'),
          h('div', { className: 'sv-media-config-copy' }, h('strong', null, providerLabel), h('span', null, !providerCredential?.configured ? '等待配置' : credentialHint === 'rejected' ? 'Key 被拒绝' : '已保存连接')),
        ),
        h('div', { className: 'sv-media-config-meta' },
          h('span', { className: `sv-tag ${canGenerate ? 'sv-stage' : selectedProvider?.configured ? 'sv-status-manual' : 'sv-status-disabled'}` }, credentialStatus),
          h('button', { type: 'button', className: 'sv-media-config-trigger', title: '连接设置', 'aria-label': '打开连接设置', onClick: () => setConfigOpen(true) }, h('span', { 'aria-hidden': 'true' }, '⚙'), h('span', null, '连接设置')),
        ),
      );
      const providerConfigDrawer = configOpen && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭连接设置', onClick: () => setConfigOpen(false) }),
        h('aside', { className: 'sv-drawer sv-media-config-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接设置' },
          h('div', { className: 'sv-drawer-head' },
            h('div', null, h('p', { className: 'sv-eyebrow' }, '配音服务'), h('h3', { className: 'sv-media-drawer-title' }, '连接设置'), h('p', { className: 'sv-media-drawer-copy' }, '密钥保存到 DSH 私有凭据库，重启后仍可用；不会写入项目、媒体任务或浏览器存储。')),
            h('button', { type: 'button', className: 'sv-ghost-btn', title: '关闭', 'aria-label': '关闭连接设置', onClick: () => setConfigOpen(false) }, '×'),
          ),
          h('div', { className: 'sv-media-drawer-body' },
            h('section', { className: 'sv-media-settings-section', style: { paddingTop: 0, borderTop: 0 } },
              h('h4', null, '生成方式'),
              h('div', { className: 'sv-media-provider-picker', role: 'group', 'aria-label': '生成方式' },
                SV_VOICE_PROVIDERS.map((id) => h('button', {
                  key: id, type: 'button', className: 'sv-media-provider-choice',
                  'data-active': providerId === id ? 'true' : 'false',
                  onClick: () => setApiKey(''),
                }, SV_VOICE_PROVIDER_LABEL[id] || id))),
              h('p', { className: 'sv-note' }, '当前配音统一使用小米 MiMo 云端服务。'),
            ),
            h('section', { className: 'sv-media-settings-section' },
              h('h4', null, '访问凭据'),
              h('label', { className: 'sv-media-field' }, h('span', null, `${providerLabel} API Key`), h('input', { className: 'sv-input', type: 'password', value: apiKey, maxLength: 512, autoComplete: 'off', placeholder: providerCredential?.configured ? '已保存，输入新值可更新' : '输入后保存到私有凭据库', disabled: Boolean(connectionBusy), onChange: (event) => setApiKey(event.target.value) })),
              h('p', { className: 'sv-note' }, providerCredential?.configured ? (providerCredential.writable ? '密钥已保存。输入新值后可更新，密钥不会回显。' : '密钥由启动环境管理，当前页面不能修改或清除。') : '尚未保存密钥。保存后，后续启动无需重复输入。'),
            ),
          ),
          h('div', { className: 'sv-media-drawer-foot' },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(connectionBusy) || !providerCredential?.configured || !providerCredential.writable, onClick: () => { void clearConnection(); } }, connectionBusy === 'clear' ? '正在清除…' : '清除已保存密钥'),
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(connectionBusy) || !apiKey.trim(), onClick: () => { void saveConnection(); } }, connectionBusy === 'save' ? '正在保存…' : '保存连接'),
          ),
        ),
      );

      const configPanel = h('section', { className: 'sv-form sv-audio-config' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '新建配音任务'), h('span', null, `${candidates.length} 个可用稿件`)),
        h('label', { className: 'sv-media-field' }, h('span', null, '已确认稿件'), h('select', { className: 'sv-select', value: selectedId || '', onChange: (event) => setSelectedId(event.target.value || null) }, h('option', { value: '' }, candidates.length ? '选择一篇已确认稿件' : '暂无已确认稿件'), candidates.map((project) => h('option', { key: project.id, value: project.id }, project.title)))),
        detail ? h('div', { className: 'sv-audio-project' }, h('strong', null, detail.title), h('span', null, `已确认 · ${charCount(scriptBody)} 字 · ${scriptDurationLabel(scriptBody)} 预计口播`)) : null,
        h('label', { className: 'sv-media-field' }, h('span', null, '文本内容'), h('textarea', { className: 'sv-textarea sv-audio-script', value: scriptBody, readOnly: true, placeholder: '选择已确认稿件后显示正文' })),
        h('p', { className: 'sv-note' }, '文本与已确认稿件绑定。需要改文案时，请返回写稿模块修改并重新确认。'),
        h('label', { className: 'sv-media-field' }, h('span', null, '音色'), h('select', { className: 'sv-select', value: voiceId, onChange: (event) => setVoiceId(event.target.value) }, mimoVoices.map((voice) => h('option', { key: voice, value: voice }, SV_MIMO_VOICE_HINTS[voice] ? `${voiceDisplayName(voice)} — ${SV_MIMO_VOICE_HINTS[voice]}` : voiceDisplayName(voice))))),
        h('p', { className: 'sv-note' }, `由${providerLabel}合成。不确定选哪个音色时用「${SV_MIMO_DEFAULT_VOICE}」；「mimo_default」跟随平台集群，中国集群是「冰糖」、其他集群是「Mia」，想要确定的声音请选具体音名。`),
        h('label', { className: 'sv-media-field' }, h('span', null, '语气（选填）'), h('input', { className: 'sv-input', value: stylePrompt, maxLength: 200, list: 'sv-style-preset-list', placeholder: '留空则按音色默认语气合成', onChange: (event) => setStylePrompt(event.target.value) }), h('datalist', { id: 'sv-style-preset-list' }, SV_VOICE_STYLE_PRESETS.map((style) => h('option', { key: style, value: style })))),
        SV_VOICE_STYLE_PRESETS.length ? h('div', { className: 'sv-style-presets' }, h('span', { className: 'sv-meta' }, '常用语气'), SV_VOICE_STYLE_PRESETS.map((style) => h('button', { key: style, type: 'button', className: 'sv-filter-chip', 'data-on': stylePrompt === style ? 'true' : 'false', onClick: () => setStylePrompt((current) => current === style ? '' : style) }, style.replace(/[，。]$/u, '')))) : null,
        h('div', { className: 'sv-audio-parameters' },
          h('label', { className: 'sv-media-field' }, h('span', null, '语速'), h('input', { className: 'sv-input', type: 'number', min: '0.5', max: '2', step: '0.05', value: rate, onChange: (event) => setRate(event.target.value) })),
          h('label', { className: 'sv-media-field' }, h('span', null, '音量'), h('input', { className: 'sv-input', type: 'number', min: '0', max: '2', step: '0.05', value: volume, onChange: (event) => setVolume(event.target.value) })),
        ),
        h('div', { className: 'sv-audio-connect-note' }, h('span', null, credentialStatus), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setConfigOpen(true) }, '连接设置')),
        h(MediaPreflight, { service: media.service, need: 'audio' }),
        h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-primary-button', disabled: media.busy || !detail || !canGenerate || !toolsReady, onClick: () => { void startVoiceover(); } }, media.busy === 'voiceover' ? '正在提交…' : '生成配音')),
        voiceReady ? h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: subtitleReady ? 'lwb-plain-button' : 'lwb-primary-button', disabled: media.busy || !canGenerate, onClick: () => { void startSubtitles(); } }, media.busy === 'subtitles' ? '正在对齐…' : subtitleReady ? '重新生成字幕' : '从真实音频生成字幕')) : null,
        h('details', { className: 'sv-form', open: false },
          h('summary', null, '人工记录与字幕校对'),
          h('form', { className: 'sv-list', onSubmit: (event) => { event.preventDefault(); void commit(detail, 'voiceover', { notes: voiceover }); } },
            h('label', { className: 'sv-media-field' }, h('span', null, '人工配音记录'), h('textarea', { className: 'sv-textarea', value: voiceover, maxLength: 6000, placeholder: '记录人工录音位置、音色、语速与复核说明', onChange: (event) => setVoiceover(event.target.value) })),
            h('div', { className: 'sv-actions' }, h('button', { type: 'submit', className: 'lwb-plain-button', disabled: saving || !detail || !voiceover.trim() }, saving ? '正在保存…' : '保存人工记录')),
          ),
          h('form', { className: 'sv-list', onSubmit: (event) => { event.preventDefault(); void commit(detail, 'subtitles', { srt: subtitles }); } },
            h('label', { className: 'sv-media-field' }, h('span', null, '校对后的 SRT'), h('textarea', { className: 'sv-textarea', value: subtitles, maxLength: 30000, placeholder: '粘贴或编辑经校对的 SRT 字幕', onChange: (event) => setSubtitles(event.target.value) })),
            h('div', { className: 'sv-actions' }, h('button', { type: 'submit', className: 'lwb-plain-button', disabled: saving || !detail || !subtitles.trim() }, saving ? '正在保存…' : '保存校对字幕')),
          ),
        ),
      );

      const taskCard = (task) => {
        const isVoice = task.type === 'voiceover';
        const audio = task.result?.audio || null;
        const taskMeta = [
          mediaRunLabel(task.type), formatTime(task.createdAt), voiceProviderLabel(task.input?.provider, service?.providers?.scitiger?.loopback),
          task.input?.voiceId ? `音色 ${task.input.voiceId}` : task.input?.voiceName || null,
          task.input?.rate ? `语速 ${task.input.rate}` : null,
        ].filter(Boolean).join(' · ');
        return h('article', { key: task.id, className: 'sv-audio-task', 'data-status': task.status, 'data-active': task.projectId === selectedId ? 'true' : 'false' },
          h('div', { className: 'sv-audio-task-head' },
            h('div', null, h('p', { className: 'sv-audio-task-title' }, task.projectTitle || '未命名项目'), h('p', { className: 'sv-audio-task-meta' }, taskMeta)),
            h('span', { className: `sv-tag ${task.status === 'failed' ? 'sv-status-error' : task.status === 'succeeded' ? 'sv-stage' : 'sv-status-manual'}` }, mediaStatusLabel(task.status)),
          ),
          isVoice && audio ? h('div', { className: 'sv-audio-task-detail' }, h('span', null, `时长 ${formatMediaDuration(audio.durationSeconds)}`), h('span', null, audio.sampleRate ? `${audio.sampleRate} Hz` : '采样率待确认'), h('span', null, formatMediaBytes(audio.bytes))) : null,
          !isVoice && task.result?.cueCount != null ? h('div', { className: 'sv-audio-task-detail' }, h('span', null, `已对齐 ${task.result.cueCount} 条字幕`), task.result?.warnings?.length ? h('span', null, `${task.result.warnings.length} 条提示`) : null) : null,
          task.error ? h('p', { className: 'sv-error' }, mediaErrorText(task.error)) : null,
          h('div', { className: 'sv-actions' },
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSelectedId(task.projectId) }, task.projectId === selectedId ? '当前稿件' : '查看稿件'),
            isVoice && task.status === 'succeeded' ? h('button', { type: 'button', className: openAudioTaskId === task.id ? 'lwb-plain-button' : 'lwb-primary-button', onClick: () => setOpenAudioTaskId((current) => current === task.id ? null : task.id) }, openAudioTaskId === task.id ? '收起播放器' : '播放音频') : null,
            !isVoice && task.status === 'succeeded' ? h('button', { type: 'button', className: 'lwb-primary-button', onClick: () => { void openSubtitles(task); } }, '查看字幕') : null,
            // 重启后不再从头再来：这两类任务都能从断点继续。
            task.status === 'interrupted' ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(media.busy), onClick: () => { void media.resume({ id: task.id, projectId: task.projectId }); } }, '从断点继续') : null,
            task.status === 'running' ? h('button', { type: 'button', className: 'lwb-secondary-button', disabled: Boolean(media.busy), onClick: () => { void media.cancel({ id: task.id }); } }, '停止') : null,
          ),
          isVoice && openAudioTaskId === task.id ? h(MediaAudioPreview, { packId, projectId: task.projectId, setError }) : null,
        );
      };
      const taskPanel = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '配音任务'), h('span', null, taskFeed.anyRunning ? '生成进行中' : `${taskFeed.tasks.length} 条记录`)),
        taskFeed.tasks.length ? h('div', { className: 'sv-list sv-run-list' }, taskFeed.tasks.map(taskCard)) : h('div', { className: 'sv-empty' }, '尚无配音或字幕任务。左侧选择已确认稿件后生成配音。'),
      );

      const subtitleDataForDrawer = subtitleDrawer?.data;
      const drawerCues = subtitleCues(subtitleDataForDrawer?.srt);
      const subtitlesDrawer = subtitleDrawer && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭字幕内容', onClick: () => setSubtitleDrawer(null) }),
        h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '字幕内容' },
          h('div', { className: 'sv-drawer-head' },
            h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, `字幕内容 · ${subtitleDrawer.project?.title || subtitleDrawer.task.projectTitle}`), h('p', { className: 'sv-meta' }, subtitleDataForDrawer ? `${subtitleDataForDrawer.cueCount || drawerCues.length} 条 · ${relativeTime(subtitleDrawer.task.createdAt)}` : '读取当前字幕中')),
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSubtitleDrawer(null) }, '关闭'),
          ),
          h('div', { className: 'sv-drawer-scroll' },
            subtitleDrawer.loading ? h('p', { className: 'sv-note' }, '正在读取字幕…') : subtitleDataForDrawer ? h(React.Fragment, null,
              subtitleDataForDrawer.warnings?.length ? h('ul', { className: 'sv-warn-list' }, subtitleDataForDrawer.warnings.map((warning, index) => h('li', { key: index }, warning))) : null,
              h('div', { className: 'sv-subtitle-cues' }, drawerCues.map((cue) => h('article', { key: cue.id, className: 'sv-subtitle-cue' }, h('time', null, cue.time), h('p', null, cue.text)))),
              h('details', { className: 'sv-form', open: false }, h('summary', null, '查看 SRT 源文'), h('pre', { className: 'sv-subtitle-raw' }, subtitleDataForDrawer.srt)),
            ) : h('div', { className: 'sv-empty' }, '当前项目还没有可展示的字幕。'),
          ),
        ),
      );

      return h(PackFrame, { packId, openConversation, title: '配音 / 字幕', accent: 'pink', copy: voiceCopy, hero: voiceHero },
        h(Notice, { error: error || detailError }),
        providerConfigStrip,
        h('section', { className: 'sv-split sv-audio-workbench' }, configPanel, taskPanel),
        providerConfigDrawer,
        subtitlesDrawer,
      );
    }
    function AudioCaptionsPageV2({ packId, openConversation }) {
      const { projects, refresh, error, setError } = useProjects(packId);
      const [service, setService] = React.useState(null);
      const [text, setText] = React.useState('');
      const [source, setSource] = React.useState(null);
      const [voiceId, setVoiceId] = React.useState(SV_MIMO_DEFAULT_VOICE);
      const [stylePrompt, setStylePrompt] = React.useState('');
      const [rate, setRate] = React.useState(1);
      const [volume, setVolume] = React.useState(1);
      const [subtitleEnabled, setSubtitleEnabled] = React.useState(true);
      const [submitting, setSubmitting] = React.useState(null);
      // 删除等无错误但需要回话的操作：用一句 sv-note 告知结果，成功与失败都看得见。
      const [notice, setNotice] = React.useState('');
      const [connectionOpen, setConnectionOpen] = React.useState(false);
      const [apiKey, setApiKey] = React.useState('');
      const [connectionBusy, setConnectionBusy] = React.useState(null);
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [accountLibrary, setAccountLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      const [activeTab, setActiveTab] = React.useState(GENERAL_TAB);
      const [pickerQuery, setPickerQuery] = React.useState('');
      const [pickerPage, setPickerPage] = React.useState(0);
      const [picker, setPicker] = React.useState({ items: [], total: 0, loading: false });
      const [taskQuery, setTaskQuery] = React.useState('');
      const [taskFilter, setTaskFilter] = React.useState('all');
      const [taskPage, setTaskPage] = React.useState(0);
      const [sourceDrawer, setSourceDrawer] = React.useState(null);
      const [subtitleDrawer, setSubtitleDrawer] = React.useState(null);
      const [syncPicker, setSyncPicker] = React.useState(null);
      // 纯手动任务的「自动放进项目」：生成成功后无需手动二次同步，视频页直接可见。
      const [autoProjectId, setAutoProjectId] = React.useState('');
      const [autoProjects, setAutoProjects] = React.useState([]);
      const [confirmNode, ask] = useSvConfirm();
      // 音色库的重命名改用站内输入弹窗：原生 prompt 暗色主题下白底黑字、
      // 阻塞渲染线程，与本页其它操作风格断裂。
      const [promptNode, prompt] = useSvPrompt();
      const textRef = React.useRef(null);
      // 三模式互斥：preset 用音色表，design 用一段描述，upload 用上传的参考音频。
      // 只有当前模式那一个 state 会被读，其余两个留着但绝不进 payload——
      // 混着传会让后端的互斥校验直接报错。
      const [voiceSource, setVoiceSource] = React.useState('preset');
      /**
       * 整体风格标签（官方开头 `(风格)` 那套）。
       *
       * 它**只进 audioTags 入参**，绝不写进正文文本框——写了会被后端
       * countInlineAudioTags 当成用户内插标签一起计数（重复计数），而且下次
       * 拿同一份稿件再生成时标签会跟着正文累积，一遍遍加下去。
       */
      const [audioTagParams, setAudioTagParams] = React.useState([]);
      const [voiceDesignText, setVoiceDesignText] = React.useState('');
      const [voiceReference, setVoiceReference] = React.useState(null);
      const [voiceReferenceBusy, setVoiceReferenceBusy] = React.useState(false);
      const [voiceReferenceError, setVoiceReferenceError] = React.useState('');
      // 我的音色库：克隆模式上传过的参考音频自动沉淀在这里，下次直接选不用重传。
      // 结构与任务上传的 voiceReference 一致（id/file/name/mediaType），选中后走
      // 同一条冻结链路（voice-references/<id>.<ext> → audio-media/references/）。
      const [savedVoices, setSavedVoices] = React.useState([]);
      const [savedVoicesLoaded, setSavedVoicesLoaded] = React.useState(false);
      const [savedVoiceBusy, setSavedVoiceBusy] = React.useState(false);
      const refreshSavedVoices = React.useCallback(async () => {
        try {
          const next = await remoteStatic('listSavedVoices');
          setSavedVoices(Array.isArray(next?.voices) ? next.voices : []);
          setSavedVoicesLoaded(true);
        } catch { /* 库不可用时静默：克隆仍可手动上传 */ }
      }, []);
      React.useEffect(() => { void refreshSavedVoices(); }, [refreshSavedVoices]);
      // 换模式时把上一个模式的专属输入清掉：留着 design 描述切回 preset，
      // 用户会以为那段描述还在生效。
      React.useEffect(() => {
        setVoiceReferenceError('');
        if (voiceSource !== 'preset') setVoiceReference(null);
      }, [voiceSource]);
      /** Upload a reference clip for clone mode; format is checked before it leaves the browser. */
      const pickVoiceReference = async (file) => {
        const problem = svVoiceReferenceError(file);
        if (problem) { setVoiceReferenceError(problem); setVoiceReference(null); return; }
        setVoiceReferenceBusy(true); setVoiceReferenceError('');
        try {
          const data = await base64FromAudioFile(file);
          const extension = String(file.name || '').split('.').pop().toLowerCase();
          const uploaded = await remoteStatic('uploadVoiceReference', {
            name: file.name,
            mediaType: /^mp3$/iu.test(extension) ? 'audio/mpeg' : 'audio/wav',
            data,
          });
          setVoiceReference(uploaded);
          // 上传即已自动入音色库（host 侧幂等登记）——刷新列表让新音色立刻可选。
          void refreshSavedVoices();
          setError(null);
        } catch (cause) {
          // 上传本身失败（过大、解码不了、磁盘满）要和「格式不支持」分开说，
          // 前者用户换个文件就行，后者得先转码。
          setVoiceReferenceError(`上传失败：${cause.message}`);
          setVoiceReference(null);
        } finally { setVoiceReferenceBusy(false); }
      };
      /** 从音色库直接选：文件已在 voice-references/，走同一条冻结链路，无需重传。 */
      const pickSavedVoice = (voice) => {
        setVoiceReferenceError('');
        setVoiceReference(savedVoiceReference(voice));
      };
      /** 库内重命名：只改显示名，音频不动。 */
      const renameSavedVoice = (voice) => {
        prompt({
          title: '修改音色名称',
          copy: '只改显示名，音频文件不动。',
          initialValue: voice.name || '',
          confirm: '保存',
          onConfirm: (name) => { void doRenameSavedVoice(voice, name); },
        });
      };
      const doRenameSavedVoice = async (voice, name) => {
        setSavedVoiceBusy(true);
        try {
          await remoteStatic('renameSavedVoice', { id: voice.id, name });
          await refreshSavedVoices();
          setError(null);
        } catch (cause) { setError(`重命名失败：${cause.message}`); }
        finally { setSavedVoiceBusy(false); }
      };
      /** 从库里删除：元数据与音频文件一起删；若当前选中正引用它，一并清掉。 */
      const deleteSavedVoice = (voice) => {
        ask({
          title: '删除这个音色？',
          copy: `将从音色库删除「${voice.name}」，音频文件一并删除。已生成的配音不受影响。`,
          confirm: '删除',
          danger: true,
          onConfirm: () => { void doDeleteSavedVoice(voice); },
        });
      };
      const doDeleteSavedVoice = async (voice) => {
        setSavedVoiceBusy(true);
        try {
          await remoteStatic('deleteSavedVoice', { id: voice.id });
          setVoiceReference((current) => current?.savedVoiceId === voice.id ? null : current);
          await refreshSavedVoices();
          setError(null);
        } catch (cause) { setError(`删除失败：${cause.message}`); }
        finally { setSavedVoiceBusy(false); }
      };

      const refreshService = React.useCallback(async () => {
        try { const next = await remoteStatic('mediaStatus'); setService(next); setError(null); return next; }
        catch (cause) { setError(cause.message); return null; }
      }, [setError]);
      React.useEffect(() => { void refreshService(); }, [refreshService]);
      // 「自动放进项目」下拉的项目列表：选稿件时该项隐藏（已有归属），纯手动时可选。
      React.useEffect(() => {
        if (!packId || source?.projectId) return;
        let cancelled = false;
        void remote(packId, 'list').then((list) => { if (!cancelled) setAutoProjects(Array.isArray(list) ? list : []); }).catch(() => {});
        return () => { cancelled = true; };
      }, [packId, source?.projectId]);
      // 音色表随 mediaStatus 返回；取不到就用实测内置表兜底，保证下拉不是空的。
      // 回落目标是运维配置的默认音色（再退「冰糖」），**不是数组最后一项**——
      // 之前取末项，改成 9 个音色后末项变成了 Dean，用户一进来就默认英文男声。
      const voiceTouched = React.useRef(false);
      React.useEffect(() => {
        const list = Array.isArray(service?.mimoVoices) && service.mimoVoices.length ? service.mimoVoices : null;
        if (!list || voiceTouched.current) return;
        setVoiceId((current) => {
          if (list.includes(current)) return current;
          const preferred = svDefaultVoice(service);
          return list.includes(preferred) ? preferred : SV_MIMO_DEFAULT_VOICE;
        });
      }, [service?.mimoVoices]);
      React.useEffect(() => {
        if (!packId) return;
        void remote(packId, 'listAccounts').then((next) => {
          setAccountLibrary(next);
          setActiveTab((current) => current !== GENERAL_TAB && next.accounts.some((item) => item.id === current && item.status === 'active') ? current : next.defaultAccountId || GENERAL_TAB);
        }).catch((cause) => setError(cause.message));
      }, [packId, setError]);
      React.useEffect(() => { setTaskPage(0); }, [activeTab, taskQuery, taskFilter]);
      React.useEffect(() => { setPickerPage(0); }, [activeTab, pickerQuery]);
      React.useEffect(() => {
        const node = textRef.current;
        if (!node) return;
        node.style.height = 'auto'; node.style.height = `${Math.max(node.scrollHeight, 136)}px`;
      }, [text]);
      // 渠道固定为白名单里的唯一 provider；「已连接」只看它自己的凭据。
      const providerEntries = SV_VOICE_PROVIDERS.filter((id) => service?.providers?.[id]?.configured && service.providers[id].credential?.configured);
      React.useEffect(() => {
        if (!pickerOpen || !packId) return undefined;
        let cancelled = false;
        const load = async () => {
          setPicker((current) => ({ ...current, loading: true }));
          try {
            const next = await remote(packId, 'listScripts', { query: pickerQuery, offset: pickerPage * 8, limit: 8, ...(activeTab === GENERAL_TAB ? { general: true } : { accountId: activeTab }) });
            if (!cancelled) { setPicker({ ...next, loading: false }); setError(null); }
          } catch (cause) { if (!cancelled) { setPicker((current) => ({ ...current, loading: false })); setError(cause.message); } }
        };
        void load(); return () => { cancelled = true; };
      }, [pickerOpen, pickerQuery, pickerPage, packId, activeTab, setError]);
      React.useEffect(() => {
        const handoff = audioCaptionsHandoff;
        if (!handoff || !packId) return;
        audioCaptionsHandoff = null;
        void remote(packId, 'get', { projectId: handoff }).then((detail) => {
          const body = stageData(detail, 'script')?.body || '';
          if (!body.trim()) return;
          setSource({ projectId: detail.id, title: detail.title }); setText(body);
        }).catch((cause) => setError(cause.message));
      }, [packId, setError]);
      const taskFeed = useAudioTasks(packId, taskQuery, taskFilter, taskPage, activeTab === GENERAL_TAB ? { general: true } : { accountId: activeTab }, setError, refresh);

      if (!packId) return h(NeedPack, { openConversation });

      const providerId = SV_VOICE_PROVIDER;
      const selectedProvider = service?.providers?.[providerId] || null;
      const providerName = SV_VOICE_PROVIDER_LABEL[providerId] || providerId;
      const voiceOptions = Array.from(new Set([...(Array.isArray(service?.mimoVoices) && service.mimoVoices.length ? service.mimoVoices : SV_MIMO_BUILTIN_VOICES), voiceId]));
      const canGenerate = Boolean(selectedProvider?.credential?.configured && selectedProvider?.configured);
      const inActiveTab = (project) => activeTab === GENERAL_TAB ? !project.account : project.account?.id === activeTab;
      const tabProjects = projects.filter(inActiveTab);
      const visibleTasks = taskFeed.items;
      const confirmedCount = tabProjects.filter((project) => project.completedStages.includes('script')).length;
      const taskPages = Math.max(1, Math.ceil((taskFeed.total || 0) / 8));
      React.useEffect(() => { if (!taskFeed.loading) setTaskPage((current) => Math.min(current, taskPages - 1)); }, [taskFeed.loading, taskPages]);
      const selectScript = async (item) => {
        setSubmitting('script');
        try {
          const detail = await remote(packId, 'get', { projectId: item.id });
          const body = stageData(detail, 'script')?.body || '';
          if (!body.trim()) throw new Error('该稿件没有可用正文，请刷新后重新选择。');
          setSource({ projectId: detail.id, title: detail.title }); setText(body); setPickerOpen(false); setError(null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      /**
       * Voice payload shared by create and retry, so both stay in step.
       *
       * 三个模型互斥，所以只发当前模式那一套：design 不带 voiceId（带了后端会
       * 当成混用报错），upload 不带 voiceId 也不带 voiceDesign，只带参考音频。
       */
      const voiceFieldsOf = () => {
        const tone = stylePrompt.trim() ? { style: stylePrompt.trim() } : {};
        // 开头风格由后端 buildTaggedText 拼，这里只传数组。
        const tags = audioTagParams.length ? { audioTags: audioTagParams } : {};
        // 出网字段名是后端的 `voiceDesign`，不是内部 state 名 voiceDesignText。
        if (voiceSource === 'design') return { voiceSource: 'design', ...tone, ...tags, voiceDesign: voiceDesignText.trim() };
        if (voiceSource === 'upload') return { voiceSource: 'upload', ...tone, ...tags, referenceAudio: voiceReference };
        return { voiceSource: 'preset', voiceId, voiceName: voiceId, ...tone, ...tags };
      };
      /** 每个模式自己那条「还差什么才能生成」，说清下一步去哪填。 */
      const voiceMissingOf = () => {
        if (voiceSource === 'design' && !voiceDesignText.trim()) return '音色设计模式要先写一段声音描述才能生成——年龄、声线、语速、气质写得越具体，出来的音色越接近。';
        if (voiceSource === 'upload' && !voiceReference) return voiceReferenceError || '声音克隆模式要先上传一段参考音频（只支持 wav / mp3），或从「我的音色库」里直接选一个，才能生成。';
        return '';
      };
      const createAudioTask = async () => {
        if (!canGenerate || !text.trim()) return;
        const missing = voiceMissingOf();
        if (missing) { setError(missing); return; }
        setSubmitting('voiceover');
        try {
          // 未选稿件的纯手动任务可以携带目标项目：配音（和字幕）生成成功后由
          // host 自动「采纳」进该项目，视频页立即可见，不再需要手动二次同步。
          await remote(packId, 'startAudioTask', { text, subtitleEnabled, ...(source?.projectId ? { sourceProjectId: source.projectId } : { title: source?.title || '手动输入文稿', ...(autoProjectId ? { autoAdoptProjectId: autoProjectId } : {}) }), provider: providerId, ...voiceFieldsOf(), rate: Number(rate), volume: Number(volume) });
          await taskFeed.refresh(); setError(null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      const startSubtitles = async (task) => {
        if (!canGenerate) return;
        setSubmitting(`subtitle:${task.id}`);
        try { await remote(packId, 'startAudioTaskSubtitles', { taskId: task.id, provider: providerId, language: 'zh', aiOptimize: true }); await taskFeed.refresh(); setError(null); }
        catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      /** Re-run a failed voiceover from its frozen text and voice settings. */
      const retryAudioTask = async (task) => {
        if (!canGenerate || submitting) return;
        setSubmitting(`retry:${task.id}`);
        try {
          await remote(packId, 'startAudioTask', {
            text: task.source?.text || '',
            ...(task.source?.projectId ? { sourceProjectId: task.source.projectId } : { title: task.source?.title || '手动输入文稿' }),
            provider: providerId,
            // 重试重放这条任务**当初冻结**的音色与语气，而不是当前表单值——
            // 否则中途改了表单再点重试，同一条任务会换一个声音。
            // 三模式同理：design 的任务重试还是 design，不能按当前表单变成 preset。
            // 老的 preset 任务没有 voiceSource 字段，回落 preset（默认分支即 preset）。
            voiceSource: ['design', 'upload'].includes(task.input?.voiceSource) ? task.input.voiceSource : 'preset',
            ...(task.input?.voiceId ? { voiceId: task.input.voiceId } : { voiceId, voiceName: voiceId }),
            ...(task.input?.voiceName ? { voiceName: task.input.voiceName } : {}),
            // 后端冻结的是 `voiceDesign`；designText 是内部 state 名，读它永远读不到，
            // 会让「重试一条音色设计任务」丢掉描述而直接报错。
            ...(task.input?.voiceDesign ? { voiceDesign: task.input.voiceDesign } : {}),
            ...(task.input?.referenceAudio ? { referenceAudio: task.input.referenceAudio } : {}),
            ...(task.input?.style ? { style: task.input.style } : {}),
            ...(Array.isArray(task.input?.audioTags) && task.input.audioTags.length ? { audioTags: task.input.audioTags } : {}),
            rate: Number(task.input?.rate ?? 1),
            volume: Number(task.input?.volume ?? 1),
            subtitleEnabled: task.input?.subtitleEnabled === true,
          });
          await taskFeed.refresh(); setError(null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      // 删一条已结束的配音任务及其产物。传多个 id 时走同一条路径（批量删）。
      const deleteAudioTasks = async (tasks) => {
        const targets = (Array.isArray(tasks) ? tasks : [tasks]).filter(Boolean);
        if (!targets.length || submitting) return;
        setSubmitting(`delete:${targets[0].id}`);
        try {
          const result = await remote(packId, 'deleteMediaTasks', { taskType: 'audio', ids: targets.map((task) => task.id) });
          await taskFeed.refresh(); setError(null);
          const gone = result?.missing?.length || 0;
          setNotice(gone ? `已删除 ${result.removed.length} 条，另有 ${gone} 条此前已不存在。` : `已删除 ${result.removed.length} 条配音任务及其产物。`);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      const openSubtitles = (task) => setSubtitleDrawer({ task, cues: subtitleCues(task.subtitle?.srt), saving: false });
      const syncAudioResult = async (task, targetProjectId = null) => {
        setSubmitting(`sync:${task.id}`);
        try {
          const updated = await remote(packId, 'syncAudioTask', { taskId: task.id, ...(targetProjectId ? { targetProjectId } : {}) });
          await taskFeed.refresh();
          setError(updated.projectSyncError || updated.subtitleSyncError || null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      // 无项目任务的「同步到视频」：先把音频挂到选中的项目（必要时补稿件），视频页才有得用。
      const syncTargetProject = async (task) => {
        setSyncPicker({ task, loading: true, items: [] });
        try {
          const list = await remote(packId, 'list');
          setSyncPicker({ task, loading: false, items: Array.isArray(list) ? list : [] });
        } catch (cause) { setError(cause.message); setSyncPicker(null); }
      };
      const adoptIntoProject = async (task, projectId) => {
        setSubmitting(`sync:${task.id}`);
        try {
          const updated = await remote(packId, 'syncAudioTask', { taskId: task.id, targetProjectId: projectId });
          await taskFeed.refresh(); setSyncPicker(null);
          setError(updated.projectSyncError || updated.subtitleSyncError || null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      const saveSubtitles = async () => {
        if (!subtitleDrawer?.cues.length || subtitleDrawer.cues.some((cue) => !cue.text.trim())) return;
        const srt = srtFromSubtitleCues(subtitleDrawer.cues);
        setSubtitleDrawer((current) => ({ ...current, saving: true }));
        try {
          const updated = await remote(packId, 'saveAudioTaskSubtitles', { taskId: subtitleDrawer.task.id, srt });
          await taskFeed.refresh(); setSubtitleDrawer({ task: updated, cues: subtitleCues(updated.subtitle?.srt || srt), saving: false }); setError(null);
        } catch (cause) { setError(cause.message); setSubtitleDrawer((current) => ({ ...current, saving: false })); }
      };
      const saveConnection = async () => {
        if (!apiKey.trim()) return;
        setConnectionBusy('save');
        try { await remoteStatic('configureMediaConnection', { provider: providerId, apiKey }); setApiKey(''); await refreshService(); setError(null); }
        catch (cause) { setError(cause.message); } finally { setConnectionBusy(null); }
      };
      const clearConnection = async () => {
        setConnectionBusy('clear');
        try { await remoteStatic('clearMediaConnectionCredential', { provider: providerId }); await refreshService(); setError(null); }
        catch (cause) { setError(cause.message); } finally { setConnectionBusy(null); }
      };
      const filterOptions = [{ id: 'all', label: '全部' }, { id: 'succeeded', label: '已完成' }, { id: 'failed', label: '失败' }];
      const hero = h(HeroMini, { cells: [
        { label: '可选稿件', value: String(confirmedCount), tone: 'brand' },
        { label: '音频任务', value: String(taskFeed.counts?.all || 0), tone: 'pink' },
        { label: '生成状态', value: taskFeed.anyRunning ? '进行中' : '空闲', tone: taskFeed.anyRunning ? 'orange' : 'green' },
      ] });
      // 只剩一个渠道时不做选择器——一个不可点的按钮只会让人反复点它。
      // Key 被服务端拒绝是独立于「没填」的一种状态：凭据已保存，但上次请求被 401/403 拒了，
      // 必须单独提示去重填，否则用户只会看到后续的「合成失败」而不知道该换 Key。
      const providerRejected = Boolean(selectedProvider?.configured && selectedProvider?.credential?.configured && selectedProvider.credentialHint === 'rejected');
      const providerControl = providerRejected
        ? h('p', { className: 'sv-error', role: 'alert' }, `${providerName} 拒绝了当前 API Key，请在右上角「连接配置」中重新填写。`)
        : !service
        ? h('p', { className: 'sv-note' }, '正在读取连接状态…')
        : providerEntries.length
          ? h('div', { className: 'sv-media-provider-picker', role: 'group', 'aria-label': '配音服务' },
            SV_VOICE_PROVIDERS.map((id) => h('button', { key: id, type: 'button', className: 'sv-media-provider-choice', 'data-active': providerId === id ? 'true' : 'false' }, SV_VOICE_PROVIDER_LABEL[id] || id)))
          : h('p', { className: 'sv-error' }, `尚未配置${providerName}的 API Key。请在右上角「连接配置」中完成设置。`);
      const providerEndpointNote = null;
      const scriptPickerDrawer = pickerOpen && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭稿件选择', onClick: () => setPickerOpen(false) }),
        h('aside', { className: 'sv-drawer sv-audio-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择稿件' },
          h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, '选择稿件'), h('p', { className: 'sv-meta' }, '选择后载入当前稿件正文；随后可继续修改，不会改写原稿。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setPickerOpen(false) }, '关闭')),
          h(AccountTabs, { accountLibrary, activeTab, onChange: setActiveTab, label: '按账号筛选稿件' }),
          h('div', { className: 'sv-drawer-scroll sv-audio-picker-body' },
            h('input', { className: 'sv-input', value: pickerQuery, maxLength: 160, placeholder: '搜索标题或正文', onChange: (event) => { setPickerQuery(event.target.value); setPickerPage(0); } }),
            picker.loading ? h('p', { className: 'sv-note' }, '正在加载稿件…') : picker.items.length ? h('div', { className: 'sv-list' }, picker.items.map((item) => h('article', { key: item.id, className: 'sv-audio-picker-item' }, h('div', null, h('strong', null, item.title), h('p', null, `${item.scriptChars} 字 · ${item.account?.name || '通用'} · 更新于 ${relativeTime(item.updatedAt)}`)), h('button', { type: 'button', className: 'lwb-primary-button', disabled: submitting === 'script', onClick: () => { void selectScript(item); } }, submitting === 'script' ? '载入中…' : '选择')))) : h('div', { className: 'sv-empty' }, '没有匹配的稿件。'),
          ),
          h('div', { className: 'sv-audio-pagebar' }, h('span', { className: 'sv-meta' }, `共 ${picker.total || 0} 篇 · 第 ${pickerPage + 1}/${Math.max(1, Math.ceil((picker.total || 0) / 8))} 页`), h('span', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: pickerPage === 0, onClick: () => setPickerPage((current) => Math.max(0, current - 1)) }, '上一页'), h('button', { type: 'button', className: 'lwb-plain-button', disabled: pickerPage + 1 >= Math.max(1, Math.ceil((picker.total || 0) / 8)), onClick: () => setPickerPage((current) => current + 1) }, '下一页'))),
        ),
      );
      const connectionCredential = selectedProvider?.credential;
      const syncPickerDrawer = syncPicker && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭项目选择', onClick: () => setSyncPicker(null) }),
        h('aside', { className: 'sv-drawer sv-audio-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择要采纳配音的项目' },
          h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, '这条音频要放进哪个项目？'), h('p', { className: 'sv-meta' }, '视频按项目组织：项目是「视频的文件夹」，配音要挂到某个项目名下，视频页才有得用。下面选的就是目标项目，不是音频。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSyncPicker(null) }, '关闭')),
          h('div', { className: 'sv-drawer-scroll sv-audio-picker-body' },
            h('div', { className: 'sv-sync-target-banner' },
              h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': true }, h('path', { d: 'M9 18V6l10-2v12' }), h('circle', { cx: 6, cy: 18, r: 3 }), h('circle', { cx: 19, cy: 16, r: 3 })),
              h('div', { className: 'sv-sync-target-banner-body' },
                h('strong', null, syncPicker.task.source?.title || '手动输入文稿'),
                h('span', null, `正在同步的音频（本条，无需再选） · ${syncPicker.task.result?.audio?.durationSeconds ? `${Math.round(syncPicker.task.result.audio.durationSeconds)} 秒` : '时长未知'} · 创建于 ${formatTime(syncPicker.task.createdAt)}`),
                syncPicker.task.source?.text ? h('span', { className: 'sv-sync-target-excerpt' }, [...syncPicker.task.source.text.replace(/\s+/gu, ' ').trim()].slice(0, 50).join('') + ([...syncPicker.task.source.text.replace(/\s+/gu, '').trim()].length > 50 ? '…' : '')) : null,
              ),
            ),
            syncPicker.loading ? h('p', { className: 'sv-note' }, '正在加载项目…') : syncPicker.items.length ? h('div', { className: 'sv-list' }, syncPicker.items.map((project) => h('article', { key: project.id, className: 'sv-audio-picker-item' }, h('div', null, h('strong', null, project.title), h('p', null, `目标项目 · ${project.account?.name || '通用'} · 更新于 ${relativeTime(project.updatedAt)}`)), h('button', { type: 'button', className: 'lwb-primary-button', disabled: submitting === `sync:${syncPicker.task.id}`, onClick: () => { void adoptIntoProject(syncPicker.task, project.id); } }, submitting === `sync:${syncPicker.task.id}` ? '采纳中…' : '放进这个项目')))) : h('div', { className: 'sv-empty' }, '还没有项目。请先在「选题与稿件」里创建一个（或随便发起一次选题），再回来把这条音频放进去。'),
          ),
        ),
      );
      const connectionDrawer = connectionOpen && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭连接配置', onClick: () => setConnectionOpen(false) }),
        h('aside', { className: 'sv-drawer sv-media-config-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接配置' },
          h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { className: 'sv-media-drawer-title' }, '连接配置'), h('p', { className: 'sv-media-drawer-copy' }, 'API Key 保存到 DSH 私有凭据库，不会写入稿件、任务或浏览器存储。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setConnectionOpen(false) }, '关闭')),
          h('div', { className: 'sv-media-drawer-body' },
            h('div', { className: 'sv-media-provider-picker', role: 'group', 'aria-label': '连接提供方' }, SV_VOICE_PROVIDERS.map((id) => h('button', { key: id, type: 'button', className: 'sv-media-provider-choice', 'data-active': providerId === id ? 'true' : 'false' }, SV_VOICE_PROVIDER_LABEL[id] || id))),
            h('label', { className: 'sv-media-field' }, h('span', null, `${providerName} API Key`), h('input', { className: 'sv-input', type: 'password', value: apiKey, maxLength: 512, autoComplete: 'off', placeholder: connectionCredential?.configured ? '已保存；输入新值可更新' : '输入 API Key', onChange: (event) => setApiKey(event.target.value) })),
            h('p', { className: 'sv-note' }, connectionCredential?.configured ? '已保存连接；密钥不会回显。' : '保存后，可在新建任务中使用该服务。'),
          ),
          h('div', { className: 'sv-media-drawer-foot' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(connectionBusy) || !connectionCredential?.configured || !connectionCredential?.writable, onClick: () => { void clearConnection(); } }, connectionBusy === 'clear' ? '正在清除…' : '清除密钥'), h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(connectionBusy) || !apiKey.trim(), onClick: () => { void saveConnection(); } }, connectionBusy === 'save' ? '正在保存…' : '保存连接')),
        ),
      );
      const newTaskPanel = h('section', { className: 'sv-form sv-audio-config' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '新建配音任务'), h('span', null, source ? '已载入稿件' : '可直接输入文稿')),
        h('div', { className: 'sv-audio-source-row' }, source ? h('div', { className: 'sv-audio-project' }, h('strong', null, source.title), h('span', null, `当前稿件 · ${charCount(text)} 字 · 可继续修改`)) : h('p', { className: 'sv-note' }, '稿件为可选项。也可以直接输入自己的口播内容。'), h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => { setPickerPage(0); setPickerOpen(true); } }, source ? '更换稿件' : '选择稿件'), source ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSource(null) }, '改为手动输入') : null)),
        h('label', { className: 'sv-media-field' }, h('span', null, '文本内容'), h('textarea', { ref: textRef, className: 'sv-textarea sv-audio-script', value: text, maxLength: 60000, placeholder: '输入或粘贴需要配音的口播文稿', onChange: (event) => setText(event.target.value), onInput: (event) => { event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.max(event.currentTarget.scrollHeight, 136)}px`; } })),
        // 标签是写进正文里的，所以这一组紧贴着文本框，并且把计数摆在旁边——
        // 上限 8 个是后端的硬校验，超了直接在这里拦住，别让用户提交完才吃 400。
        svAudioTagPicker({
          text,
          mode: voiceSource,
          disabled: submitting,
          paramTags: audioTagParams,
          onToggleParam: (tag) => setAudioTagParams((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]),
          onInsert: (tag) => svInsertAudioTag(textRef.current, tag, setText),
        }),
        h('p', { className: 'sv-meta' }, `${charCount(text)} 字 · 预计口播 ${scriptDurationLabel(text)}`),
        !source?.projectId && autoProjects.length ? h('label', { className: 'sv-media-field' }, h('span', null, '生成后放进项目（可选）'), h('select', { className: 'sv-select', value: autoProjectId, onChange: (event) => setAutoProjectId(event.target.value) },
          h('option', { value: '' }, '不放进项目（留在配音列表，稍后手动放）'),
          autoProjects.map((project) => h('option', { key: project.id, value: project.id }, `${project.title}${project.account?.name ? ` · ${project.account.name}` : ''}`))),
          h('small', { className: 'sv-meta' }, '选中后，配音（含字幕）生成成功会自动挂到该项目名下，视频页立即可见，无需再手动同步。')) : null,
        h('label', { className: 'sv-media-field' }, h('span', null, '配音服务'), providerControl),
        providerEndpointNote,
        svVoiceModePicker({ value: voiceSource, disabled: submitting, onChange: setVoiceSource }),
        voiceSource === 'design'
          // 描述是设计模式的唯一输入，所以预设卡片贴着输入框放；
          // 选中态由文本内容反推，手改一个字就自动脱离选中。
          ? h(React.Fragment, null,
            h('label', { className: 'sv-media-field sv-media-field-wide' }, h('span', null, '音色描述（必填）'), h('input', { className: 'sv-input', value: voiceDesignText, maxLength: SV_DESIGN_TEXT_MAX, disabled: Boolean(submitting), placeholder: '例：一位三十岁上下、语速偏慢、带点沙哑的中年男声', onChange: (event) => setVoiceDesignText(event.target.value) })),
            svVoiceDesignPresets({ value: voiceDesignText.trim(), disabled: submitting, onChange: setVoiceDesignText }),
            voiceDesignText.trim() ? h('p', { className: 'sv-note' }, `将按这段描述生成音色${svVoiceDesignPresetLabel(voiceDesignText) ? `（预设「${svVoiceDesignPresetLabel(voiceDesignText)}」）` : ''}，可在描述里继续微调年龄、音区、语速。`) : null)
          : voiceSource === 'upload'
            ? h('div', { className: 'sv-media-field sv-media-field-wide' },
              h('span', null, '参考音频（必填）'),
              savedVoices.length ? h('div', { className: 'sv-voice-library' },
                h('div', { className: 'sv-voice-library-head' },
                  h('span', { className: 'sv-meta' }, `我的音色库（${savedVoices.length}）— 点选即用，无需重新上传`),
                  h('button', { type: 'button', className: 'lwb-plain-button', disabled: savedVoiceBusy || savedVoicesLoaded === false, onClick: () => { void refreshSavedVoices(); } }, '刷新')),
                h('div', { className: 'sv-voice-library-list' }, savedVoices.map((voice) => {
                  const selected = voiceReference?.savedVoiceId === voice.id;
                  return h('div', { key: voice.id, className: 'sv-voice-library-item', 'data-selected': selected ? 'true' : 'false' },
                    h('button', { type: 'button', className: 'sv-voice-library-pick', disabled: Boolean(submitting), onClick: () => pickSavedVoice(voice), title: `选用「${voice.name}」` },
                      h('span', { className: 'sv-voice-library-name' }, voice.name),
                      h('span', { className: 'sv-voice-library-meta' }, [voice.durationSeconds ? formatMediaDuration(voice.durationSeconds) : null, formatMediaBytes(voice.bytes)].filter(Boolean).join(' · '))),
                    h('span', { className: 'sv-voice-library-actions' },
                      h('button', { type: 'button', className: 'lwb-plain-button', disabled: savedVoiceBusy, onClick: () => { void renameSavedVoice(voice); }, title: '重命名' }, '重命名'),
                      h('button', { type: 'button', className: 'lwb-plain-button sv-voice-library-delete', disabled: savedVoiceBusy, onClick: () => { void deleteSavedVoice(voice); }, title: '从音色库删除' }, '删除')));
                }))) : null,
              h('input', { className: 'sv-input', type: 'file', accept: SV_CLONE_ACCEPT, disabled: Boolean(voiceReferenceBusy || submitting), onChange: (event) => { void pickVoiceReference(event.target.files?.[0] || null); event.target.value = ''; } }),
              h('p', { className: 'sv-meta' }, savedVoices.length ? '上面选一个直接用，或从下面再传新音色（上传后自动存进音色库）。' : '上传过的参考音频会自动存进音色库，下次直接选，不用重复上传。'),
              voiceReferenceBusy ? h('p', { className: 'sv-note' }, '正在读取并上传参考音频…')
                : voiceReference ? h('p', { className: 'sv-note' }, `已选用：${voiceReference.name}（${formatMediaBytes(voiceReference.bytes)}${voiceReference.durationSeconds ? ` · ${formatMediaDuration(voiceReference.durationSeconds)}` : ''}）。换一个文件或库条目会切换音色。`)
                  : h('p', { className: 'sv-note' }, '只支持 wav 和 mp3；m4a / aac 等格式需要先转成 wav，否则合成会失败。'),
              voiceReferenceError ? h('p', { className: 'sv-error', role: 'alert' }, voiceReferenceError) : null)
            : h(React.Fragment, null,
              h('label', { className: 'sv-media-field' }, h('span', null, '音色'), svVoiceSelect({ value: voiceId, onChange: (next) => { voiceTouched.current = true; setVoiceId(next); }, disabled: submitting, options: voiceOptions, include: voiceId })),
              SV_MIMO_VOICE_HINTS[voiceId] ? h('p', { className: 'sv-note' }, `当前音色「${voiceId}」：${SV_MIMO_VOICE_HINTS[voiceId]}`) : null),
        h('label', { className: 'sv-media-field' }, h('span', null, '语气（选填）'), h('input', { className: 'sv-input', value: stylePrompt, maxLength: 200, list: 'sv-voice-style-presets', placeholder: voiceSource === 'design' ? '这段描述是必填的音色来源；这里填的是语气（选填）' : '留空则按音色默认语气合成', onChange: (event) => setStylePrompt(event.target.value) }), h('datalist', { id: 'sv-voice-style-presets' }, SV_VOICE_STYLE_PRESETS.map((style) => h('option', { key: style, value: style })))),
        SV_VOICE_STYLE_PRESETS.length ? h('div', { className: 'sv-style-presets' }, h('span', { className: 'sv-meta' }, '常用语气'), SV_VOICE_STYLE_PRESETS.map((style) => h('button', { key: style, type: 'button', className: 'sv-filter-chip', 'data-on': stylePrompt === style ? 'true' : 'false', onClick: () => setStylePrompt((current) => current === style ? '' : style) }, style.replace(/[，。]$/u, '')))) : null,
        h('div', { className: 'sv-audio-parameters' }, h('label', { className: 'sv-media-field' }, h('span', null, '语速'), h('input', { className: 'sv-input', type: 'number', min: '0.5', max: '2', step: '0.05', value: rate, onChange: (event) => setRate(event.target.value) })), h('label', { className: 'sv-media-field' }, h('span', null, '音量'), h('input', { className: 'sv-input', type: 'number', min: '0', max: '2', step: '0.05', value: volume, onChange: (event) => setVolume(event.target.value) }))),
        h('label', { className: 'sv-audio-subtitle-option' }, h('input', { type: 'checkbox', checked: subtitleEnabled, onChange: (event) => setSubtitleEnabled(event.target.checked) }), h('span', null, h('strong', null, '同时生成字幕'), h('small', null, '配音完成后自动对齐字幕；字幕失败不影响音频，可单独重试。'))),
        h('div', { className: 'sv-actions' },
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(submitting) || !canGenerate || !text.trim() || Boolean(voiceMissingOf()), onClick: () => ask({ title: '生成配音', copy: `将使用${providerName}、${voiceSource === 'design' ? `音色设计「${voiceDesignText.trim()}」` : voiceSource === 'upload' ? `克隆参考音频「${voiceReference?.name || ''}」` : `音色「${voiceId}」`}${stylePrompt.trim() ? `、语气「${stylePrompt.trim()}」` : ''}为「${source?.title || '手动输入文稿'}」创建新的配音任务${subtitleEnabled ? '，并在配音完成后自动生成字幕' : ''}。`, confirm: '确认生成', onConfirm: () => { void createAudioTask(); } }) }, submitting === 'voiceover' ? '正在提交…' : subtitleEnabled ? '生成配音和字幕' : '生成配音'),
          !canGenerate ? h('span', { className: 'sv-meta' }, `请先在右上角「连接配置」里填写${providerName}的 API Key`)
            : voiceMissingOf() ? h('span', { className: 'sv-meta' }, voiceMissingOf())
              : text.trim().length > 600 ? h('span', { className: 'sv-meta' }, `文稿约 ${text.trim().length} 字，长文案会分段合成，预计约 ${Math.max(2, Math.round(text.trim().length / 700))} 分钟，进度会显示在任务记录里`) : null,
        ));
      const taskCard = (task) => {
        const subtitle = task.subtitle || { status: 'idle' };
        const audio = task.result?.audio;
        const liveProgress = task.status === 'running' && task.progress?.stage ? `${task.progress.stage}${task.progress.progress != null ? ` · ${task.progress.progress}%` : ''}` : null;
        const activeSubtitle = ['queued', 'running'].includes(subtitle.status);
        const subtitleProgress = subtitleTaskProgress(task);
        const subtitleButton = task.status !== 'succeeded' ? null : activeSubtitle
          ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: true }, subtitleProgress?.button || '字幕生成中…')
          : h('button', { type: 'button', className: subtitle.status === 'succeeded' ? 'lwb-plain-button' : 'lwb-primary-button', disabled: !canGenerate || Boolean(submitting), onClick: () => ask({ title: subtitle.status === 'succeeded' ? '重新生成字幕' : '生成字幕', copy: subtitle.status === 'succeeded' ? '将基于这条音频重新生成字幕，现有字幕版本会保留为历史结果。' : '将基于这条音频的真实时间轴生成字幕。', confirm: subtitle.status === 'succeeded' ? '重新生成' : '生成字幕', onConfirm: () => { void startSubtitles(task); } }) }, submitting === `subtitle:${task.id}` ? '正在提交…' : subtitle.status === 'succeeded' ? '重新生成字幕' : '生成字幕');
        return h('article', { key: task.id, className: 'sv-audio-task', 'data-status': task.status },
          h('div', { className: 'sv-audio-task-head' }, h('div', null, h('p', { className: 'sv-audio-task-title' }, task.source?.title || '手动输入文稿'), h('p', { className: 'sv-audio-task-meta' }, [formatTime(task.createdAt), voiceProviderLabel(task.input?.provider, service?.providers?.scitiger?.loopback), task.input?.bridge?.channel === 'cloud' ? '云端合成' : task.input?.bridge?.channel === 'local' ? '本地合成' : null, liveProgress, task.source?.kind === 'manual-text' ? '手动文稿' : task.source?.kind === 'edited-script-copy' ? '已保存稿件副本' : task.source?.kind === 'adopted-by-project' ? '已采纳进项目' : '已保存稿件'].filter(Boolean).join(' · '))), h('span', { className: `sv-tag ${task.status === 'failed' ? 'sv-status-error' : task.status === 'succeeded' ? 'sv-stage' : 'sv-status-manual'}` }, mediaStatusLabel(task.status))),
          task.source?.text && task.source?.kind !== 'saved-script' ? h('p', { className: 'sv-audio-task-excerpt' }, [...task.source.text.replace(/\s+/gu, ' ').trim()].slice(0, 42).join('') + ([...task.source.text.replace(/\s+/gu, '').trim()].length > 42 ? '…' : '')) : null,
          audio ? h('div', { className: 'sv-audio-task-detail' }, h('span', null, `时长 ${formatMediaDuration(audio.durationSeconds)}`), h('span', null, formatMediaBytes(audio.bytes)), h('span', null, subtitle.status === 'succeeded' ? `字幕 ${subtitle.cueCount || 0} 条` : subtitle.status === 'failed' ? '字幕失败 · 配音可用' : activeSubtitle ? '字幕实时处理中' : '未生成字幕')) : null,
          subtitleProgress ? h('div', { className: 'sv-audio-subtitle-progress', role: 'status', 'aria-live': 'polite' },
            h('div', { className: 'sv-audio-subtitle-progress-head' }, h('strong', null, subtitleProgress.label), subtitleProgress.percent == null ? null : h('span', null, `${subtitleProgress.percent}%`)),
            subtitleProgress.percent == null ? null : h('progress', { max: 100, value: subtitleProgress.percent, 'aria-label': '字幕识别进度' }),
          ) : null,
          task.status === 'succeeded' ? h(AudioTaskPreview, { packId, taskId: task.id, setError }) : null,
          task.error ? h('p', { className: 'sv-error' }, mediaErrorText(task.error)) : null,
          subtitle.error ? h('p', { className: 'sv-error' }, `字幕生成失败，配音已保留：${mediaErrorText(subtitle.error)}`) : null,
          task.status === 'succeeded' && task.source?.projectId ? h('div', { className: 'sv-list' },
            h('p', { className: task.projectSyncError || task.subtitleSyncError ? 'sv-error' : 'sv-note', role: 'status' }, task.projectSyncError || task.subtitleSyncError || (task.projectSync ? '配音已同步到项目，可在「视频 / 预览」中使用。' : '配音已生成，尚未同步到项目。同步后可在「视频 / 预览」中使用。')),
            (!task.projectSync || task.projectSyncError || task.subtitleSyncError) ? h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(submitting) || activeSubtitle, onClick: () => { void syncAudioResult(task); } }, submitting === `sync:${task.id}` ? '正在同步…' : '同步到视频'), h('span', { className: 'sv-meta' }, '复用已有音频和字幕，不会重新生成。')) : null,
          ) : null,
          task.status === 'succeeded' && !task.source?.projectId ? h('div', { className: 'sv-list' },
            h('p', { className: task.projectSyncError ? 'sv-error' : 'sv-note', role: 'status' }, task.projectSyncError || (task.projectSync ? `配音已放进「${task.source?.projectTitle || '项目'}」，可在「视频 / 预览」中制作视频。` : '这条音频要做成视频，需要先放进一个项目（视频按项目组织）。点击后选择目标项目即可，音频就是本条，无需再挑。')),
            task.projectSync ? null : h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(submitting) || activeSubtitle, onClick: () => { void syncTargetProject(task); } }, submitting === `sync:${task.id}` ? '正在打开…' : '放进项目做视频…'), h('span', { className: 'sv-meta' }, '音频就是本条，弹层里选的是目标项目。')),
          ) : null,
          h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSourceDrawer(task) }, '查看稿件'), task.status === 'failed' && task.source?.text ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: !canGenerate || Boolean(submitting), onClick: () => ask({ title: '重试配音', copy: `将按原任务的文稿、音色和语速重新生成配音${task.source?.projectId ? `，并覆盖「${task.source?.title || '当前项目'}」的配音版本` : ''}。原失败记录会保留。`, confirm: '确认重试', onConfirm: () => { void retryAudioTask(task); } }) }, submitting === `retry:${task.id}` ? '正在提交…' : '重试配音') : null, h(ExecutionButton, { kind: 'audio', id: task.id }), subtitleButton, subtitle.status === 'succeeded' ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => openSubtitles(task) }, '查看字幕') : null, ['succeeded', 'failed'].includes(task.status) ? h('button', { type: 'button', className: 'lwb-danger-button', disabled: Boolean(submitting), onClick: () => ask({ title: '删除这条配音任务？', copy: `将删除「${task.source?.title || '手动输入文稿'}」这条${task.status === 'failed' ? '失败' : '已完成'}的配音任务记录，以及磁盘上的音频与字幕文件。删除后无法恢复；如果只是想再生成一次，用「重试配音」更合适。`, confirm: '确认删除', danger: true, onConfirm: () => { void deleteAudioTasks(task); } }) }, submitting === `delete:${task.id}` ? '正在删除…' : '删除') : null),
        );
      };
      const taskPanel = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '配音任务'), h('span', null, taskFeed.anyRunning ? '生成进行中' : `共 ${taskFeed.total || 0} 条记录`)),
        h('div', { className: 'sv-audio-task-tools' }, h('input', { className: 'sv-input', value: taskQuery, maxLength: 160, placeholder: '搜索稿件标题或内容', onChange: (event) => setTaskQuery(event.target.value) }), h('div', { className: 'sv-filter-chips' }, filterOptions.map((item) => h('button', { key: item.id, type: 'button', className: 'sv-filter-chip', 'data-on': taskFilter === item.id ? 'true' : 'false', onClick: () => setTaskFilter(item.id) }, `${item.label} ${item.id === 'all' ? taskFeed.counts?.all || 0 : item.id === 'succeeded' ? taskFeed.counts?.succeeded || 0 : taskFeed.counts?.failed || 0}`)))),
        visibleTasks.length ? h('div', { className: 'sv-list' }, visibleTasks.map(taskCard)) : h('div', { className: 'sv-empty' }, taskFeed.loading ? '正在读取任务…' : '当前账号暂无配音任务。可选择稿件，也可直接输入文稿。'),
        h('div', { className: 'sv-audio-pagebar' }, h('span', { className: 'sv-meta' }, `第 ${taskPage + 1}/${taskPages} 页 · 共 ${taskFeed.total || 0} 条`), h('span', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '上一页', disabled: taskPage === 0, onClick: () => setTaskPage((current) => Math.max(0, current - 1)) }, '上一页'), h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '下一页', disabled: taskPage + 1 >= taskPages, onClick: () => setTaskPage((current) => current + 1) }, '下一页'))),
      );
      const sourceDrawerNode = sourceDrawer && h(React.Fragment, null, h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭稿件内容', onClick: () => setSourceDrawer(null) }), h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '稿件内容' }, h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, sourceDrawer.source?.title || '稿件内容'), h('p', { className: 'sv-meta' }, sourceDrawer.source?.kind === 'manual-text' ? '手动输入文稿快照' : '任务创建时冻结的稿件快照')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSourceDrawer(null) }, '关闭')), h('div', { className: 'sv-drawer-scroll' }, h('article', { className: 'sv-sc-manuscript' }, sourceDrawer.source?.text || ''))));
      const subtitleDrawerNode = subtitleDrawer && h(React.Fragment, null, h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭字幕内容', onClick: () => setSubtitleDrawer(null) }), h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '编辑字幕' }, h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, `字幕 · ${subtitleDrawer.task.source?.title || '手动文稿'}`), h('p', { className: 'sv-meta' }, `${subtitleDrawer.cues.length} 条字幕，可直接校对错别字并保存。`)), h('button', { type: 'button', className: 'lwb-plain-button', disabled: subtitleDrawer.saving, onClick: () => setSubtitleDrawer(null) }, '关闭')), h('div', { className: 'sv-drawer-scroll sv-audio-subtitle-editor' }, h('div', { className: 'sv-subtitle-cues' }, subtitleDrawer.cues.map((cue, index) => h('article', { key: cue.id, className: 'sv-subtitle-cue' }, h('time', null, cue.time), h('textarea', { className: 'sv-textarea sv-subtitle-text', value: cue.text, maxLength: 30000, 'aria-label': `第 ${index + 1} 条字幕文本`, onChange: (event) => setSubtitleDrawer((current) => ({ ...current, cues: current.cues.map((currentCue, currentIndex) => currentIndex === index ? { ...currentCue, text: event.target.value } : currentCue) })) }))))), h('div', { className: 'sv-media-drawer-foot' }, h('span', { className: 'sv-meta' }, '时间码来自音频对齐结果，保存将更新字幕文本。'), h('button', { type: 'button', className: 'lwb-primary-button', disabled: subtitleDrawer.saving || !subtitleDrawer.cues.length || subtitleDrawer.cues.some((cue) => !cue.text.trim()), onClick: () => ask({ title: '保存字幕', copy: `将保存这 ${subtitleDrawer.cues.length} 条字幕的文本修改，时间码保持不变。`, confirm: '确认保存', onConfirm: () => { void saveSubtitles(); } }) }, subtitleDrawer.saving ? '正在保存…' : '保存字幕'))));
      const accountTabs = h(AccountTabs, { accountLibrary, activeTab, onChange: setActiveTab, label: '按账号查看配音任务' });
      return h(PackFrame, { packId, openConversation, title: '配音 / 字幕', accent: 'pink', copy: '按账号选择稿件并生成配音；默认同时生成字幕，也可取消；字幕失败不影响已完成的配音。每条任务保留执行记录并同步项目产物。', hero, introActions: h('button', { type: 'button', className: 'sv-media-config-trigger', 'data-attention': service && !providerEntries.length ? 'true' : 'false', onClick: () => setConnectionOpen(true) }, h(React.Fragment, null, h(IconSettingsOutline16, { size: 16, 'aria-hidden': true }), '连接配置', h('span', { className: 'sv-config-state' }, !service ? '读取中' : providerEntries.length ? '已连接' : '待配置'))) }, h(Notice, { error }), notice ? h('p', { className: 'sv-note', role: 'status' }, notice) : null, accountTabs, h('section', { className: 'sv-split sv-audio-workbench' }, newTaskPanel, taskPanel), scriptPickerDrawer, connectionDrawer, syncPickerDrawer, sourceDrawerNode, subtitleDrawerNode, confirmNode, promptNode);
    }
    /**
     * 视频制作任务的实时进度：步骤条 + 当前阶段用时 + 总耗时 + 阶段明细。
     * 刻意不显示"已完成百分比"——导演与渲染的耗时不可预测，
     * 假精度比没有进度更伤人。只展示后端真实记录的时间事实。
     */
    function VideoTaskProgress({ progress, status, eta }) {
      const [open, setOpen] = React.useState(false);
      if (!progress) return null;
      const running = status === 'running';
      const repair = progress.repair;
      const render = progress.render;
      const summary = [];
      if (progress.activeSeconds != null) summary.push(`${running ? '当前阶段已用' : '本阶段用时'} ${formatElapsed(progress.activeSeconds)}`);
      if (progress.totalSeconds != null) summary.push(`总计 ${formatElapsed(progress.totalSeconds)}`);
      // 渲染阶段用 Remotion 自报的剩余时间；其它阶段才退回历史参考值。
      if (running && render?.remainingSeconds != null) summary.push(`预计剩余 ${formatElapsed(render.remainingSeconds)}`);
      else if (running && eta?.range) summary.push(`参考历史 ${eta.range}`);
      const doneCount = progress.steps.filter((step) => step.status === 'done').length;
      // 当前阶段的人话说明：告诉用户「这一步在干嘛」，而不只是阶段名。
      const activeHint = running ? VIDEO_PHASE_HINT[progress.phase] || null : null;
      // 长时间没有新阶段事件时的「还活着」证据：秒数本身在跳，配上明确措辞，
      // 避免用户把「卡住」和「还在跑」混为一谈。渲染阶段本身有帧进度，不重复喊。
      const stalledSeconds = running && progress.activeSeconds != null && progress.activeSeconds >= VIDEO_STALL_SECONDS
        ? progress.activeSeconds
        : null;
      const showStall = stalledSeconds != null && !(render && Number.isFinite(render.percent) && render.percent > 0);
      /**
       * 沉默提示的两档措辞。
       *
       * 后端沉默超过 VIDEO_SILENT_ALARM_SECONDS 就换第二档，明确说「可能卡住了」——
       * 区分「这个阶段本来就慢」和「后端没动静」是这条提示存在的全部意义。
       * 拿不到后端时间戳（progress.silentSeconds 为 null）时只说已持续多久，
       * 不编一个「最后一次动作」出来。
       */
      const silent = progress.silentSeconds;
      const percentText = render && render.done != null && render.total != null
        ? `（渲染 ${render.done}/${render.total} 帧）`
        : '';
      const gotAction = silent != null
        ? `，最后一次后台动作在 ${formatElapsed(silent)} 前${percentText}`
        : '';
      const stallCopy = silent != null && silent >= VIDEO_SILENT_ALARM_SECONDS
        ? `已 ${formatElapsed(stalledSeconds)} 没有收到后台进度${gotAction}，可能卡住了。可以刷新看看，或到任务记录里查看详情。`
        : `还在进行，本阶段已持续 ${formatElapsed(stalledSeconds)}${gotAction}。`;
      // 进度块在任务结束后仍然保留（时长、帧数值得看），但标题不能说「正在」——
      // 2026-10-08 反馈：卡片已标「已完成」却又写着「正在渲染成片 100%」。
      const renderHeadline = !running
        ? (status === 'succeeded' ? '渲染完成' : status === 'failed' ? '渲染中断' : '渲染已停止')
        : (render?.stage === 'bundling' ? '正在打包工程' : '正在渲染成片');
      return h('div', { className: 'sv-vprogress' },
        h('div', { className: 'sv-vprogress-steps', role: 'list', 'aria-label': '视频制作阶段' },
          progress.steps.map((step, index) => h('div', {
            key: step.id, role: 'listitem', className: 'sv-vprogress-step', 'data-status': step.status,
            title: step.seconds == null ? step.label : `${step.label} · ${formatElapsed(step.seconds)}`,
          }, h('i', { 'aria-hidden': true }, step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : String(index + 1)), h('span', null, step.label)))),
        activeHint ? h('p', { className: 'sv-vprogress-hint', role: 'status' }, activeHint) : null,
        // 只说事实，不做保证。
        //
        // 原来这里写的是「界面每秒刷新，没有卡住」——那是在保证一件界面不知道的事：
        // 每秒跳动的秒数来自前端的 setInterval，后端渲染进程死了它照样跳，
        // 要跳到 90 分钟硬超时才报错。也就是说这句「没有卡住」会在真卡住时
        // 持续骗用户一个半小时。界面静止用户会自己去刷新；界面假装活着，
        // 用户就会被骗着一直等。
        //
        // 现在改成陈述两件后端能作证的事实：本阶段已持续多久、上一次后端动作
        // 是多久以前。沉默超过阈值就明说「可能卡住了」，把人从等待里捞出来。
        showStall ? h('p', { className: 'sv-vprogress-alive', role: 'status', 'data-silent': progress.silentSeconds != null && progress.silentSeconds >= VIDEO_SILENT_ALARM_SECONDS ? 'true' : 'false' },
          h('span', { className: 'sv-vprogress-alive-dot', 'aria-hidden': 'true' }),
          stallCopy) : null,
        // 修复提示同理：结束后它记录的是「做过第几次修复」，不是「正在」。
        repair ? h('p', { className: 'sv-vprogress-repair', role: 'status' }, running
          ? `审片触发修复：第 ${repair.attempts}${repair.maxAttempts ? `/${repair.maxAttempts}` : ''} 次尝试，正在按审片意见重做。`
          : `审片曾触发修复：共 ${repair.attempts}${repair.maxAttempts ? `/${repair.maxAttempts}` : ''} 次尝试。`) : null,
        render ? h('div', { className: 'sv-vprogress-bar', 'data-status': status },
          h('div', { className: 'sv-vprogress-bar-head' }, h('span', null, renderHeadline), h('span', { className: 'sv-vprogress-live' }, `${render.percent}%`)),
          h('div', { className: 'sv-vprogress-sweep', 'data-status': status }, h('progress', { max: 100, value: render.percent, 'aria-label': '渲染进度' })),
          render.total ? h('span', { className: 'sv-meta' }, `已完成 ${render.done}/${render.total} 帧`) : null,
        ) : null,
        h('div', { className: 'sv-vprogress-foot' },
          h('span', { className: 'sv-meta' }, summary.join(' · ')),
          h('button', { type: 'button', className: 'sv-vprogress-toggle', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen((value) => !value) }, open ? '收起阶段明细' : `阶段明细 ${doneCount}/${progress.steps.length}`)),
        open ? h('div', { className: 'sv-vprogress-detail' }, progress.steps.map((step) => h('div', { key: step.id, className: 'sv-vprogress-row', 'data-status': step.status },
          h('span', null, step.label),
          h('span', { className: step.status === 'active' ? 'sv-vprogress-live' : 'sv-meta' }, step.seconds == null ? ({ pending: '待执行', done: '已完成' }[step.status] || '—') : formatElapsed(step.seconds)),
        ))) : null,
      );
    }
    function VideoPreviewPageV2({ packId, openConversation }) {
      const { projects, refresh, error, setError } = useProjects(packId);
      // 视频页自己拿一次媒体状态，用于渲染前预检。
      // 旧实现从未读取 renderers：用户点「生成视频」要等 AI 导演跑十几分钟、
      // 预检都过了，才在渲染阶段收到「当前安装未包含 Remotion 渲染器」。
      const [mediaService, setMediaService] = React.useState(null);
      React.useEffect(() => {
        if (!packId) return;
        let active = true;
        void remoteStatic('mediaStatus').then((next) => { if (active) setMediaService(next); }).catch(() => {});
        return () => { active = false; };
      }, [packId]);
      // 渲染器或工具链缺失时禁止创建任务，并把原因写在按钮上方。
      const videoToolsReady = Boolean(mediaService)
        && mediaService.renderers?.remotion !== false
        && mediaService.mediaTools?.available !== false;
      const [accountLibrary, setAccountLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      const [activeTab, setActiveTab] = React.useState(GENERAL_TAB);
      const inActiveTab = (project) => activeTab === GENERAL_TAB ? !project.account : project.account?.id === activeTab;
      const candidates = projects.filter((project) => inActiveTab(project) && project.completedStages.includes('script') && project.completedStages.includes('voiceover'));
      const [selectedId, setSelectedId] = useSelectedProject(candidates);
      // Pipeline board handoff: switch to the project's tab so it enters candidates, then select it.
      React.useEffect(() => {
        if (!pipelineHandoff || pipelineHandoff.page !== 'video-preview' || !pipelineHandoff.projectId) return;
        const target = projects.find((project) => project.id === pipelineHandoff.projectId);
        if (!target) return;
        pipelineHandoff = null;
        setActiveTab(target.account ? target.account.id : GENERAL_TAB);
        setSelectedId(target.id);
      }, [projects, setSelectedId]);
      const { detail, error: detailError, reload } = useDetail(packId, selectedId);
      const [visualBrief, setVisualBrief] = React.useState('');
      const [subtitleEnabled, setSubtitleEnabled] = React.useState(true);
      const [orientation, setOrientation] = React.useState('landscape');
      const [backgroundMusic, setBackgroundMusic] = React.useState(null);
      const [bgmVolume, setBgmVolume] = React.useState('0.12');
      const [bgmUploading, setBgmUploading] = React.useState(false);
      const bgmFileInputRef = React.useRef(null);
      const [sourcePickerOpen, setSourcePickerOpen] = React.useState(false);
      const [sourceQuery, setSourceQuery] = React.useState('');
      const [sourcePage, setSourcePage] = React.useState(0);
      const [taskQuery, setTaskQuery] = React.useState('');
      const [taskFilter, setTaskFilter] = React.useState('all');
      const [taskPage, setTaskPage] = React.useState(0);
      const [submitting, setSubmitting] = React.useState(null);
      // 删除等无错误但需要回话的操作：用一句 sv-note 告知结果。
      const [notice, setNotice] = React.useState('');
      const [scriptDrawer, setScriptDrawer] = React.useState(null);
      const [mediaDrawer, setMediaDrawer] = React.useState(null);
      const [summaryDrawer, setSummaryDrawer] = React.useState(null);
      const [confirmNode, ask] = useSvConfirm();
      const taskFeed = useVideoTasks(packId, taskQuery, taskFilter, taskPage, activeTab === GENERAL_TAB ? { general: true } : { accountId: activeTab }, setError, refresh);
      // 运行中任务需要一个每秒推进的时钟，阶段用时与总耗时才会走动。
      // 开关必须看**全局计数**（counts 由后端按全部任务统计），不能看当前页的
      // `taskFeed.anyRunning`：那个值只统计「当前这页 + 当前筛选」的任务，翻到
      // 第 2 页或筛到「失败」tab 时就会变 false，于是正在跑的任务秒数**冻结**——
      // 用户最需要它跳的时候它偏偏不动。
      const [now, setNow] = React.useState(() => Date.now());
      const hasLiveTask = Boolean(taskFeed.anyRunning)
        || Number(taskFeed.counts?.running || 0) > 0
        || Number(taskFeed.counts?.queued || 0) > 0;
      React.useEffect(() => {
        if (!hasLiveTask) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [hasLiveTask]);
      // 参考历史耗时：只在样本足够时给出区间，否则不显示，避免错误预期。
      const taskEta = React.useMemo(() => videoEtaFromHistory(taskFeed.items, null), [taskFeed.items]);
      React.useEffect(() => {
        if (!packId) return;
        void remote(packId, 'listAccounts').then((next) => {
          setAccountLibrary(next);
          setActiveTab((current) => current !== GENERAL_TAB && next.accounts.some((item) => item.id === current && item.status === 'active') ? current : next.defaultAccountId || GENERAL_TAB);
        }).catch((cause) => setError(cause.message));
      }, [packId, setError]);
      React.useEffect(() => {
        const savedVideo = stageData(detail, 'video');
        const savedBrief = savedVideo?.visualBrief || '';
        setVisualBrief(['默认信息型竖屏口播版式。', '默认信息型口播版式。', DEFAULT_VIDEO_VISUAL_BRIEF].includes(savedBrief) ? '' : savedBrief);
        setSubtitleEnabled(savedVideo ? savedVideo.subtitleEnabled !== false : done(detail, 'subtitles'));
        setOrientation(savedVideo?.orientation === 'portrait' ? 'portrait' : 'landscape');
        setBackgroundMusic(savedVideo?.backgroundMusic || null);
        setBgmVolume(String(savedVideo?.bgmVolume ?? 0.12));
      }, [detail?.id, detail?.revision]);
      React.useEffect(() => { setTaskPage(0); }, [activeTab, taskFilter, taskQuery]);
      React.useEffect(() => { setSourcePage(0); }, [activeTab, sourceQuery]);
      React.useEffect(() => {
        if (taskPage > 0 && taskPage >= Math.max(1, Math.ceil(taskFeed.total / 6))) setTaskPage(Math.max(0, Math.ceil(taskFeed.total / 6) - 1));
      }, [taskPage, taskFeed.total]);
      React.useEffect(() => {
        if (selectedId && taskFeed.items.some((task) => task.projectId === selectedId && (task.status === 'succeeded' || task.status === 'failed'))) void reload();
      }, [selectedId, taskFeed.items, reload]);
      if (!packId) return h(NeedPack, { openConversation });
      const hasRequiredSource = detail && done(detail, 'script') && done(detail, 'voiceover') && (!subtitleEnabled || done(detail, 'subtitles'));
      const selectedSource = candidates.find((project) => project.id === selectedId) || null;
      const projectForTask = (task) => projects.find((project) => project.id === task.projectId) || null;

      const createVideoTask = async (source = detail, settings = { visualBrief, subtitleEnabled, orientation, backgroundMusic, bgmVolume: Number(bgmVolume) }) => {
        if (!source) return;
        setSubmitting(source.id);
        try {
          await remote(packId, 'startVideoRender', { projectId: source.id, expectedRevision: source.revision, visualBrief: settings.visualBrief.trim() || DEFAULT_VIDEO_VISUAL_BRIEF, subtitleEnabled: settings.subtitleEnabled, orientation: settings.orientation === 'portrait' ? 'portrait' : 'landscape', renderer: 'remotion', backgroundMusic: settings.backgroundMusic || null, bgmVolume: settings.backgroundMusic ? Number(settings.bgmVolume ?? 0.12) : null });
          await taskFeed.refresh(); setError(null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      const uploadVideoBgm = async (event) => {
        const file = event.target.files?.[0] || null;
        event.target.value = '';
        if (!file || !detail || bgmUploading) return;
        const limit = 20 * 1024 * 1024;
        if (file.size < 1 || file.size > limit) { setError(`BGM 必须小于 ${formatMediaBytes(limit)}。`); return; }
        setBgmUploading(true);
        try {
          const data = await base64FromAudioFile(file);
          const uploaded = await remote(packId, 'uploadVideoBgm', { projectId: detail.id, name: file.name, mediaType: file.type, data });
          setBackgroundMusic(uploaded); setError(null);
        } catch (cause) { setError(cause.message); } finally { setBgmUploading(false); }
      };
      /**
       * 停止正在跑的视频任务。服务端会真的中止 ffmpeg 与在途请求，
       * 不只是把界面状态改成失败——旧实现里点了取消，渲染进程照样跑完。
       */
      const stopVideoTask = async (task) => {
        setSubmitting(`cancel:${task.id}`);
        try { await remote(packId, 'cancelMediaRun', { runId: task.id }); await taskFeed.refresh(); setNotice('已停止这条视频任务。'); setError(null); }
        catch (cause) { setError(cause.message); }
        finally { setSubmitting(null); }
      };
      /**
       * 从断点继续一条被重启中断的视频任务。
       * 已完成阶段（视觉导演 + 预检、已渲染的成片）会被跳过，不重新花时间和额度。
       */
      const resumeVideoTask = async (task) => {
        setSubmitting(`resume:${task.id}`);
        try { await remote(packId, 'resumeMediaRun', { runId: task.id, projectId: task.projectId }); await taskFeed.refresh(); setNotice('已从断点继续，已完成的阶段不会重做。'); setError(null); }
        catch (cause) { setError(cause.message); }
        finally { setSubmitting(null); }
      };
      const retryTask = (task) => {
        const project = projectForTask(task);
        if (!project || project.revision !== task.expectedRevision) { setError('稿件、配音或字幕已更新。请在左侧重新选择当前稿件后创建新的视频任务。'); return; }
        ask({ title: '重试视频任务', copy: `将按该任务冻结的配置，重新提交「${task.projectTitle}」当前版本的视频渲染。`, confirm: '确认重试', onConfirm: () => { void createVideoTask(project, task.input); } });
      };
      /**
       * 补做技术质检：成片已存在但缺 qc 产物（老任务，或渲染路径没提交 qc）时，
       * 重跑渲染既慢又没必要——直接对现有成片补一次技术质检。发布页只列
       * qc 通过的项目，所以这是让这类成片重新可见的捷径。
       */
      const runTechnicalQc = async (task) => {
        const project = projectForTask(task);
        if (!project) { setError('找不到该成片对应的项目。'); return; }
        setSubmitting(`qc:${task.id}`);
        try {
          await remote(packId, 'startTechnicalQc', { projectId: task.projectId, expectedRevision: project.revision, videoTaskId: task.id });
          await taskFeed.refresh(); setError(null);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      /**
       * 人工放行：成片技术质检未通过（确实有画面/音轨问题），但用户确认就要这个
       * 静态风格时，把这条 qc 以 userOverride 形式重新提交，让它进入「发布」页。
       * 提交的是整段 replace 的 qc 产物，会触发 invalidateDownstream 清掉已有
       * packaging/封面——所以确认文案里必须提前说清，让用户有预期。
       */
      const releaseVideoCut = async (task) => {
        const project = projectForTask(task);
        const qc = task.qc;
        // 结论不完整（缺 mode/reportFile/technical）时禁止放行：重提交会造出残缺
        // qc 产物，比「不显示按钮」更糟。让用户在「补做技术质检」拿到完整结论再来。
        if (!project || !qc || qc.status !== 'succeeded' || !qc.result?.technical || !qc.result?.mode || !qc.result?.reportFile) {
          setError('质检结论不完整，无法人工放行。请先点「补做技术质检」生成完整结论。');
          return;
        }
        setSubmitting(`release:${task.id}`);
        try {
          await remote(packId, 'commit', {
            projectId: project.id,
            expectedRevision: project.revision,
            stage: 'qc',
            idempotencyKey: `manual-release-${task.id}`,
            payload: {
              mode: qc.result.mode,
              reportFile: qc.result.reportFile,
              // 判据没过的事实不改写；technical 原样带回，后端才不会因为
              // `passed !== technical.passed` 或「没有 issues 却放行」而拒绝。
              passed: false,
              technical: qc.result.technical,
              userOverride: true,
            },
          });
          // 重新拉取任务与项目：让 task.qc.result.userOverride 生效，按钮随之消失、
          // 常驻标记出现；同时 invalidateDownstream 清掉的 packaging/封面也会刷新。
          await taskFeed.refresh();
          await reload();
          setError(null);
          setNotice('已人工放行：这条成片已进入「发布」页，原已生成的发布文案/封面已被清掉，需重新生成封面。');
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      /**
       * 放行「审片否决但技术质检通过」的成片。
       *
       * 与 releaseVideoCut 的区别：那条处理的是「技术质检没过」（qc 记录存在、
       * 带 issues）；这条处理的是「技术质检过了、审片不过」——这时根本没有 qc
       * 记录，结论在 run.rejectedCut 里。所以放行要按 rejectedCut 重建一份 qc
       * 提交，而不是复用已有记录。
       *
       * 2026-10-26 补：此前这种成片既进不了 result（拿不到 video），也没有放行
       * 按钮，整轮判死后成片等于白扔。
       */
      const releaseRejectedCut = async (task) => {
        const project = projectForTask(task);
        const cut = task.rejectedCut;
        if (!project || !cut?.reportFile) {
          setError('这条成片的质检记录不完整，无法人工放行。');
          return;
        }
        setSubmitting(`release:${task.id}`);
        try {
          // 必须走后端受控方法：`commit` 对 qc 阶段一律拒绝
          // （SPOKEN_VIDEO_STAGE_AUTOMATION_REQUIRED），这是防伪造质检结论的守卫。
          // releaseRejectedCut 会在后端读回落盘的真实结论、原样提交并只加 userOverride。
          await remote(packId, 'releaseRejectedCut', { projectId: project.id, taskId: task.id });
          await taskFeed.refresh();
          await reload();
          setError(null);
          setNotice('已人工放行：这条成片已进入「发布」页，原已生成的发布文案/封面已被清掉，需重新生成封面。');
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      const deleteVideoTasks = async (tasks) => {
        const targets = (Array.isArray(tasks) ? tasks : [tasks]).filter(Boolean);
        if (!targets.length || submitting) return;
        setSubmitting(`delete:${targets[0].id}`);
        try {
          const result = await remote(packId, 'deleteMediaTasks', { taskType: 'video', ids: targets.map((task) => task.id) });
          await taskFeed.refresh(); setError(null);
          const gone = result?.missing?.length || 0;
          setNotice(gone ? `已删除 ${result.removed.length} 条，另有 ${gone} 条此前已不存在。` : `已删除 ${result.removed.length} 条视频任务及其成片文件。`);
        } catch (cause) { setError(cause.message); } finally { setSubmitting(null); }
      };
      const taskPages = Math.max(1, Math.ceil(taskFeed.total / 6));
      const sourceMatches = candidates.filter((project) => !sourceQuery.trim() || project.title.toLowerCase().includes(sourceQuery.trim().toLowerCase()));
      const sourcePages = Math.max(1, Math.ceil(sourceMatches.length / 8));
      const visibleSources = sourceMatches.slice(sourcePage * 8, sourcePage * 8 + 8);
      const taskFilters = [{ id: 'all', label: '全部', count: taskFeed.counts.all }, { id: 'active', label: '进行中', count: taskFeed.counts.queued + taskFeed.counts.running }, { id: 'succeeded', label: '已完成', count: taskFeed.counts.succeeded }, { id: 'failed', label: '失败', count: taskFeed.counts.failed }];
      const videoHero = h(HeroMini, { cells: [{ label: '可制作稿件', value: String(candidates.length), tone: 'brand' }, { label: '视频任务', value: String(taskFeed.counts.all), tone: taskFeed.anyRunning ? 'orange' : undefined }, { label: '制作链路', value: 'DSH + Remotion', tone: 'green' }] });
      const accountTabs = h(AccountTabs, { accountLibrary, activeTab, onChange: setActiveTab, label: '按账号筛选视频稿件与任务' });
      const sourceCard = (project) => h('button', { key: project.id, type: 'button', className: 'sv-video-source-item', 'data-active': selectedId === project.id ? 'true' : 'false', onClick: () => setSelectedId(project.id) }, h('span', { className: 'sv-item-head' }, h('strong', { className: 'sv-item-title' }, project.title), h('span', { className: 'sv-stage' }, project.completedStages.includes('subtitles') ? '配音、字幕已完成' : '配音已完成')), h('span', { className: 'sv-meta' }, `${relativeTime(project.updatedAt)} · ${project.account?.name || '通用'}`));
      const taskCard = (task) => {
        const taskQc = task.qc || null;
        const qcPassed = taskQc?.status === 'succeeded' && taskQc.result?.technical?.passed === true && (task.result?.qc ? taskQc.result?.review?.passed === true : true);
        // 技术质检结论里的具体问题清单；缺结论时为空数组，不放行。
        const qcTechnicalIssues = taskQc?.status === 'succeeded' && Array.isArray(taskQc.result?.technical?.issues) ? taskQc.result.technical.issues : [];
        // 质检失败且确有技术问题：可人工放行，但「质检通过」标记不会点亮。
        const qcFailedWithIssues = task.status === 'succeeded' && Boolean(task.result?.video) && !qcPassed && qcTechnicalIssues.length > 0;
        // 已经点过人工放行：常驻标记，且不再提供放行按钮（避免用户以为没成功而重复点）。
        const qcReleased = qcFailedWithIssues && taskQc?.result?.userOverride === true;
        // 审片否决但成片已渲染：技术质检过了、审片判了 major，整轮记为 failed。
        // 2026-10-26 补的出口——此前这种成片既不在 result 里（所以拿不到 video），
        // 也没有任何放行按钮，用户只看到「全部失败」，盘上的成片等于白扔。
        // 现在后端在否决时也会落盘并在 run.rejectedCut 里记下产物，这里据此给放行入口。
        const rejectedCut = task.status === 'failed' && task.rejectedCut && typeof task.rejectedCut === 'object' ? task.rejectedCut : null;
        // 只有「技术质检通过、纯粹审片不过」才走这条放行：技术质检自己没过时，
        // 成片可能是空白的，那条路径仍由 qcFailedWithIssues 负责（判据不同、文案也不同）。
        // 另外要求审片报告自带 ≥2 项证据：没有证据的否决本身站不住，放行等于盲放。
        // 历史上有条记录证据是 0 项（更早的代码留下的残缺报告），这种不给按钮。
        const reviewEvidence = Array.isArray(task.pipeline?.review?.reviewEvidence) ? task.pipeline.review.reviewEvidence.length : 0;
        const editorialRejected = Boolean(rejectedCut) && rejectedCut.technicalPassed === true && reviewEvidence >= 2 && taskQc?.result?.userOverride !== true;
        const liveStatus = task.status === 'running' ? videoPhaseLabel(task.phase) || mediaStatusLabel(task.status) : mediaStatusLabel(task.status);
        const statusClass = task.status === 'failed' ? 'sv-status-error' : task.status === 'succeeded' ? 'sv-stage' : 'sv-status-manual';
        const progress = task.status === 'running' || task.status === 'succeeded' ? videoTaskProgress(task, now) : null;
        return h('article', { key: task.id, className: 'sv-video-task', 'data-status': task.status },
          h('div', { className: 'sv-video-task-head' }, h('div', null, h('p', { className: 'sv-video-task-title' }, task.projectTitle), h('p', { className: 'sv-video-task-meta' }, `${formatTime(task.createdAt)} · 稿件版本 ${task.expectedRevision} · ${task.input?.orientation === 'portrait' ? '竖屏' : '横屏'} · ${task.input?.subtitleEnabled === false ? '不含字幕' : '含字幕'} · ${task.input?.backgroundMusic ? `BGM：${task.input.backgroundMusic.name}` : '无 BGM'}`)), h('span', { className: `sv-tag ${statusClass}` }, liveStatus)),
          progress ? h(VideoTaskProgress, { progress, status: task.status, eta: task.status === 'running' && task.status !== 'succeeded' ? taskEta : null }) : null,
          task.status === 'succeeded' && task.result?.video ? h(React.Fragment, null, h(VideoTaskMediaPreview, { packId, task, stage: 'video', setError }), h('div', { className: 'sv-video-task-detail' }, h('span', null, `${task.result.video.width || '?'}x${task.result.video.height || '?'} · ${task.result.video.fps || '?'}fps`), h('span', null, `时长 ${formatMediaDuration(task.result.video.durationSeconds)}`), h('span', null, formatMediaBytes(task.result.video.bytes)))) : null,
          task.error ? h('p', { className: 'sv-error' }, mediaErrorText(task.error)) : null,
          // 三种下游缺失，分开说清，避免把「质检失败」误报成「没有记录」。
          // 1) 根本没有质检记录（缺 qc 产物）：引导去补做。
          task.status === 'succeeded' && task.result?.video && !taskQc ? h('p', { className: 'sv-warn' }, '这条成片还没有技术质检记录，因此不会出现在「发布」页。可点「补做技术质检」，无需重新渲染。') : null,
          // 2) 质检失败且确有技术问题：给放行入口 + 危险提示（warn 黄，提示风险）。
          qcFailedWithIssues && !qcReleased ? h('p', { className: 'sv-warn' }, `这条成片技术质检未通过（${qcTechnicalIssues[0]}），不会出现在「发布」页。若你确认这正是要的静态/字幕风格，可点下方按钮人工放行。`) : null,
          // 3) 已人工放行：常驻状态标记，用中性偏冷的新色（不复用 warn 黄），
          //    让用户几天后回看也知道它没经过合格质检。
          qcReleased ? h('p', { className: 'sv-released' }, `已人工放行 · 质检未通过（${qcTechnicalIssues[0] || '技术问题'}）`) : null,
          // 4) 审片否决但技术质检通过：成片能播，只是审片认为画面有缺陷。
          //    这里把审片的分说清楚，让用户自己判断值不值得放行。
          editorialRejected ? h('p', { className: 'sv-warn' }, `这条成片技术质检已通过，但独立审片判为不通过（${rejectedCut.reviewScore != null ? `${rejectedCut.reviewScore} 分` : '未评分'}）：${String(rejectedCut.reviewSummary || '审片未给出摘要').slice(0, 160)}。成片已保留，不会自动进入「发布」页；若你认可这个质量，可点下方按钮人工放行。`) : null,
          h('div', { className: 'sv-actions' }, task.source?.script?.body ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setScriptDrawer(task) }, '查看稿件') : null, task.source?.voiceover?.audio || task.source?.subtitles || task.input?.backgroundMusic ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setMediaDrawer(task) }, '查看配音/字幕/BGM') : null, h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSummaryDrawer(task) }, '执行详情'), task.status === 'succeeded' && task.result?.video && !qcPassed ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(submitting) || taskFeed.anyRunning, onClick: () => ask({ title: '补做技术质检', copy: `将对「${task.projectTitle}」的现有成片补做一次技术质检（检查分辨率、帧率、音轨、时长与字幕），通过后该成片会出现在「发布」页。不会重新渲染视频。`, confirm: '开始质检', onConfirm: () => { void runTechnicalQc(task); } }) }, submitting === `qc:${task.id}` ? '正在提交…' : '补做技术质检') : null,
          // 人工放行：仅当质检失败且确有技术问题、且尚未放行时显示。放过之后按钮消失。
          qcFailedWithIssues && !qcReleased ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(submitting) || taskFeed.anyRunning, onClick: () => ask({ title: '人工放行这条成片', copy: `这条成片技术质检未通过（${qcTechnicalIssues[0]}）。放行后它会进入「发布」页，可正常打包与生成封面，但「质检通过」标记不会点亮。\n\n如果你要的就是纯字幕/静态海报风格，可以继续。\n如果这不是你要的效果，说明画面没渲染出来——放行后发出去就是一条空白视频。\n\n注意：放行会按当前稿件版本重新计算发布资料，原已生成的发布文案/封面将被清掉，放行后需重新生成封面。`, confirm: '确认放行', onConfirm: () => { void releaseVideoCut(task); } }) }, submitting === `release:${task.id}` ? '正在提交…' : '这是我要的静态风格，直接采用') : null,
          // 审片否决的放行入口。语义与技术质检那条**不同**：那边是「画面可能压根没画出来」，
          // 这边是「画面画出来了、技术指标也合格，只是审片认为表达有缺陷」——所以文案
          // 强调「我认可这个质量」，而不是「这是我要的静态风格」。
          editorialRejected ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(submitting) || taskFeed.anyRunning, onClick: () => ask({ title: '放行这条审片未通过的成片', copy: `独立审片判为不通过（${rejectedCut.reviewScore != null ? `${rejectedCut.reviewScore} 分` : '未评分'}）。技术质检是通过的，成片能正常播放，审片指的是表达层面的问题。\n\n审片意见：${String(rejectedCut.reviewSummary || '').slice(0, 300)}\n\n放行后它会进入「发布」页，可正常打包与生成封面，但「质检通过」标记不会点亮。\n\n建议先点开成片看一眼再决定——如果你也认可这个质量，就放行；如果不认可，关掉这个对话框去改稿重跑。\n\n注意：放行会按当前稿件版本重新计算发布资料，原已生成的发布文案/封面将被清掉，放行后需重新生成封面。`, confirm: '我认可这个质量，放行', onConfirm: () => { void releaseRejectedCut(task); } }) }, submitting === `release:${task.id}` ? '正在提交…' : '我认可这个质量，放行') : null,
          task.status === 'interrupted' ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(submitting), onClick: () => { void resumeVideoTask(task); } }, submitting === `resume:${task.id}` ? '正在继续…' : '从断点继续') : null,
          task.status === 'running' ? h('button', { type: 'button', className: 'lwb-secondary-button', disabled: Boolean(submitting), onClick: () => { void stopVideoTask(task); } }, submitting === `cancel:${task.id}` ? '正在停止…' : '停止这个任务') : null,
          task.status === 'failed' ? h('button', { type: 'button', className: 'lwb-primary-button', disabled: submitting === task.projectId, onClick: () => retryTask(task) }, submitting === task.projectId ? '正在提交…' : '重试') : null, qcPassed ? h('span', { className: 'sv-meta' }, task.result?.qc ? '技术质检与独立审片通过' : '技术质检通过') : null, ['succeeded', 'failed', 'cancelled'].includes(task.status) ? h('button', { type: 'button', className: 'lwb-danger-button', disabled: Boolean(submitting), onClick: () => ask({ title: '删除这条视频任务？', copy: `将删除「${task.projectTitle}」这条${task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : '已完成'}的视频任务记录，以及磁盘上的成片与渲染中间文件（视频产物通常有几百 MB）。删除后无法恢复；项目的稿件与配音不受影响，只是这条渲染记录不再出现在列表里。`, confirm: '确认删除', danger: true, onConfirm: () => { void deleteVideoTasks(task); } }) }, submitting === `delete:${task.id}` ? '正在删除…' : '删除') : null),
        );
      };
      const sourcePanel = h('section', { className: 'sv-section sv-video-source' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '选择已完成配音的稿件'), h('span', null, `${candidates.length} 篇`)),
        candidates.length ? h(React.Fragment, null, h('div', { className: 'sv-list' }, candidates.slice(0, 6).map(sourceCard)), candidates.length > 6 ? h('button', { type: 'button', className: 'sv-sc-more', onClick: () => { setSourceQuery(''); setSourcePage(0); setSourcePickerOpen(true); } }, `还有 ${candidates.length - 6} 篇 · 查看更多`) : null) : h('div', { className: 'sv-empty' }, '当前账号暂无可制作视频的稿件。若配音已完成，请到「配音 / 字幕」检查项目同步状态。'),
        detail ? h('section', { className: 'sv-form sv-video-create' },
          h('div', { className: 'sv-section-head' }, h('h3', null, '创建视频任务'), h('span', null, selectedSource?.title || '')),
          h('p', { className: 'sv-note' }, subtitleEnabled ? 'DSH 视觉导演将读取当前稿件、配音和字幕，直接制作 Remotion 成片，再由独立会话审片。' : done(detail, 'subtitles') ? '当前任务将跳过已有字幕，仅使用稿件和配音制作成片。' : '当前稿件没有字幕，将直接制作无字幕成片。'),
          h('div', { className: 'sv-video-option' }, h('span', null, '视频方向'), h('div', { className: 'sv-video-orientation', role: 'radiogroup', 'aria-label': '视频方向' }, [{ id: 'landscape', label: '横屏 16:9' }, { id: 'portrait', label: '竖屏 9:16' }].map((item) => h('button', { key: item.id, type: 'button', role: 'radio', 'aria-checked': orientation === item.id, 'data-active': orientation === item.id ? 'true' : 'false', onClick: () => setOrientation(item.id) }, item.label)))),
          h('label', { className: 'sv-checks' }, h('span', null, h('input', { type: 'checkbox', checked: subtitleEnabled, disabled: !done(detail, 'subtitles'), onChange: (event) => setSubtitleEnabled(event.target.checked) }), '启用字幕')),
          h('div', { className: 'sv-video-option' },
            h('span', null, '背景音乐（可选）'),
            h('input', { ref: bgmFileInputRef, type: 'file', accept: 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,.mp3,.wav,.m4a,.ogg', tabIndex: -1, style: { display: 'none' }, onChange: (event) => { void uploadVideoBgm(event); } }),
            h('div', { className: 'sv-video-bgm-upload' },
              h('div', { className: 'sv-video-bgm-row' },
                h('p', { className: 'sv-video-bgm-file' }, backgroundMusic ? h(React.Fragment, null, backgroundMusic.name, h('span', null, ` · ${formatMediaBytes(backgroundMusic.bytes)} · ${formatMediaDuration(backgroundMusic.durationSeconds)}`)) : '未添加 BGM'),
                h('button', { type: 'button', className: 'lwb-plain-button', disabled: bgmUploading || Boolean(submitting), onClick: () => bgmFileInputRef.current?.click?.() }, bgmUploading ? '正在上传…' : backgroundMusic ? '更换 BGM' : '上传 BGM'),
                backgroundMusic ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: bgmUploading || Boolean(submitting), onClick: () => setBackgroundMusic(null) }, '移除') : null,
              ),
              backgroundMusic ? h('label', { className: 'sv-video-bgm-volume' }, h('span', null, 'BGM 音量'), h('input', { type: 'range', min: '0', max: '0.5', step: '0.01', value: bgmVolume, onChange: (event) => setBgmVolume(event.target.value) }), h('output', null, `${Math.round(Number(bgmVolume) * 100)}%`)) : null,
            ),
          ),
          h('textarea', { className: 'sv-textarea', value: visualBrief, maxLength: 6000, placeholder: '可选：补充视觉风格、表现重点或必须避开的表达；留空由 AI 视觉导演自主决定', onChange: (event) => setVisualBrief(event.target.value) }),
          h(MediaPreflight, { service: mediaService, need: 'video' }),
          h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-primary-button', disabled: submitting === detail.id || bgmUploading || !hasRequiredSource || !videoToolsReady, onClick: () => ask({ title: '创建视频任务', copy: `将为「${detail.title}」启动 DSH 视觉导演，制作${orientation === 'landscape' ? '横屏 16:9' : '竖屏 9:16'} Remotion 成片。任务会冻结当前稿件、配音${subtitleEnabled ? '、字幕' : ''}${backgroundMusic ? `和 BGM「${backgroundMusic.name}」` : ''}，并在技术质检后交给独立 DSH 会话审片；任一环节不通过都会直接失败。`, confirm: '确认创建', onConfirm: () => { void createVideoTask(); } }) }, submitting === detail.id ? '正在提交…' : '生成视频')),
        ) : null,
      );
      const taskPanel = h('section', { className: 'sv-section sv-video-task-list' }, h('div', { className: 'sv-section-head' }, h('h3', null, '视频制作任务'), h('span', { role: 'status', 'aria-live': 'polite' }, taskFeed.anyRunning ? '任务执行中' : `共 ${taskFeed.total} 条`)), h('div', { className: 'sv-video-task-tools' }, h('input', { className: 'sv-input', value: taskQuery, maxLength: 160, placeholder: '搜索稿件标题、稿件内容或制作说明', onChange: (event) => setTaskQuery(event.target.value) }), h('div', { className: 'sv-filter-chips' }, taskFilters.map((filter) => h('button', { key: filter.id, type: 'button', className: 'sv-filter-chip', 'data-on': taskFilter === filter.id ? 'true' : 'false', onClick: () => setTaskFilter(filter.id) }, `${filter.label} ${filter.count}`)))), taskFeed.items.length ? h('div', { className: 'sv-list' }, taskFeed.items.map(taskCard)) : h('div', { className: 'sv-empty' }, taskFeed.loading ? '正在读取视频任务…' : '尚无视频制作任务。请在左侧选择完成配音的稿件后创建。'), h('div', { className: 'sv-audio-pagebar' }, h('span', { className: 'sv-meta' }, `第 ${taskPage + 1}/${taskPages} 页 · 共 ${taskFeed.total} 条`), h('span', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '上一页', disabled: taskPage === 0, onClick: () => setTaskPage((current) => Math.max(0, current - 1)) }, '上一页'), h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '下一页', disabled: taskPage + 1 >= taskPages, onClick: () => setTaskPage((current) => current + 1) }, '下一页'))));
      const sourcePicker = sourcePickerOpen && h(React.Fragment, null, h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭稿件选择', onClick: () => setSourcePickerOpen(false) }), h('aside', { className: 'sv-drawer sv-audio-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择已完成配音的稿件' }, h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, '选择已完成配音的稿件'), h('p', { className: 'sv-meta' }, '选择后在左侧创建独立的视频制作任务。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSourcePickerOpen(false) }, '关闭')), h('div', { className: 'sv-drawer-scroll sv-audio-picker-body' }, h('input', { className: 'sv-input', value: sourceQuery, maxLength: 160, placeholder: '搜索稿件标题', onChange: (event) => { setSourceQuery(event.target.value); setSourcePage(0); } }), visibleSources.length ? h('div', { className: 'sv-list' }, visibleSources.map((project) => h('article', { key: project.id, className: 'sv-audio-picker-item' }, h('div', null, h('strong', null, project.title), h('p', null, `${project.completedStages.includes('subtitles') ? '配音、字幕已完成' : '配音已完成'} · ${project.account?.name || '通用'} · ${relativeTime(project.updatedAt)}`)), h('button', { type: 'button', className: 'lwb-primary-button', onClick: () => { setSelectedId(project.id); setSourcePickerOpen(false); } }, '选择')))) : h('div', { className: 'sv-empty' }, '没有匹配的稿件。')), h('div', { className: 'sv-audio-pagebar' }, h('span', { className: 'sv-meta' }, `共 ${sourceMatches.length} 篇 · 第 ${sourcePage + 1}/${sourcePages} 页`), h('span', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: sourcePage === 0, onClick: () => setSourcePage((page) => Math.max(0, page - 1)) }, '上一页'), h('button', { type: 'button', className: 'lwb-plain-button', disabled: sourcePage + 1 >= sourcePages, onClick: () => setSourcePage((page) => Math.min(sourcePages - 1, page + 1)) }, '下一页')))));
      const scriptDrawerNode = scriptDrawer && h(React.Fragment, null, h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭稿件内容', onClick: () => setScriptDrawer(null) }), h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '任务稿件' }, h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, scriptDrawer.projectTitle), h('p', { className: 'sv-meta' }, `任务创建时冻结的稿件快照 · 稿件版本 ${scriptDrawer.source?.script?.revision || '—'}`)), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setScriptDrawer(null) }, '关闭')), h('div', { className: 'sv-drawer-scroll' }, h('article', { className: 'sv-sc-manuscript' }, scriptDrawer.source?.script?.body || '该历史任务未保存稿件快照。'))));
      const mediaDrawerNode = mediaDrawer && h(React.Fragment, null, h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭配音、字幕和背景音乐', onClick: () => setMediaDrawer(null) }), h('aside', { className: 'sv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '任务配音、字幕和背景音乐' }, h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { style: { margin: 0, fontSize: 'var(--lwb-text-section,18px)' } }, `配音 / 字幕 / BGM · ${mediaDrawer.projectTitle}`), h('p', { className: 'sv-meta' }, '展示任务创建时冻结的声音与字幕版本。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setMediaDrawer(null) }, '关闭')), h('div', { className: 'sv-drawer-scroll sv-video-media-drawer' }, mediaDrawer.source?.voiceover?.audio ? h(React.Fragment, null, h('p', { className: 'sv-meta' }, '配音'), h(VideoTaskMediaPreview, { packId, task: mediaDrawer, stage: 'voiceover', setError })) : null, mediaDrawer.input?.backgroundMusic ? h(React.Fragment, null, h('p', { className: 'sv-meta' }, `BGM · ${mediaDrawer.input.backgroundMusic.name} · ${Math.round(Number(mediaDrawer.input.bgmVolume ?? 0.12) * 100)}%`), h(VideoTaskMediaPreview, { packId, task: mediaDrawer, stage: 'bgm', setError })) : null, mediaDrawer.source?.subtitles ? h(React.Fragment, null, h('p', { className: 'sv-meta' }, `字幕 · ${mediaDrawer.source.subtitles.cueCount || 0} 条`), h('pre', { className: 'sv-subtitle-raw' }, mediaDrawer.source.subtitles.srt || '该任务未包含字幕。')) : h('p', { className: 'sv-note' }, '该视频任务未启用字幕。'))));
      const summaryDrawerNode = summaryDrawer && h(ExecutionDrawer, { key: summaryDrawer.id, request: { kind: 'media', id: summaryDrawer.id, projectId: summaryDrawer.projectId }, onClose: () => setSummaryDrawer(null) });
      return h(PackFrame, { packId, openConversation, title: '视频 / 预览', copy: '选择完成配音的稿件后，DSH 视觉导演会直接制作 Remotion 成片，并由独立 DSH 会话审核。只有技术质检和审片都通过的任务才会展示成片。', hero: videoHero }, h(Notice, { error: error || detailError }), notice ? h('p', { className: 'sv-note', role: 'status' }, notice) : null, accountTabs, h('section', { className: 'sv-layout sv-video-workbench' }, sourcePanel, taskPanel), sourcePicker, scriptDrawerNode, mediaDrawerNode, summaryDrawerNode, confirmNode);
    }
    const PUBLISH_STATE_LABEL = { none: '未生成', running: '生成中', failed: '生成失败', ready: '已就绪' };
    const PUBLISH_PAGE_SIZE = 8;
    function emptyPublishContent() { return { title: '', copy: '', description: '', tags: [] }; }
    function emptyPublishPrompts() { return { landscape: '', portrait: '', negative: '' }; }
    /** Readiness is the whole contract: a packaging artifact means publishable.
     *  No approval/queue states exist anymore; a failed run is just a retry hint. */
    function publishStateOf(record) {
      if (!record) return 'none';
      const stages = Array.isArray(record.completedStages) ? record.completedStages : [];
      if (stages.includes('packaging') || record.packaging) return 'ready';
      const task = record.task || null;
      if (task && ['queued', 'running'].includes(task.status)) return 'running';
      if (task && task.status === 'failed') return 'failed';
      return 'none';
    }
    function publishStateTone(state) {
      if (state === 'ready') return 'approved';
      if (state === 'running') return 'draft';
      if (state === 'failed') return 'draft';
      return 'none';
    }
    function contentEquals(a, b) {
      return a.title === b.title && a.copy === b.copy && a.description === b.description
        && a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index]);
    }
    function promptsEquals(a, b) {
      return a.landscape === (b.landscape || '') && a.portrait === (b.portrait || '') && a.negative === (b.negative || '');
    }
    function mediaDownloadName(title, kind, asset) {
      const extension = ({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[asset?.mediaType] || 'bin';
      return `${String(title || '成片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}-${kind === 'video' ? '视频' : kind === 'landscape' ? '横屏封面' : '竖屏封面'}.${extension}`;
    }
    function PublishAssetDownload({ packId, projectId, title, kind, asset, disabled = false }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const download = async () => {
        setBusy(true); setError(null);
        try {
          const media = asset || await remote(packId, 'readPublishAsset', { projectId, kind });
          downloadBase64(media, mediaDownloadName(title, kind, media));
        } catch (cause) { setError(cause.message); } finally { setBusy(false); }
      };
      return h('div', { className: 'sv-pb-download' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: disabled || busy, onClick: () => { void download(); } }, busy ? '下载准备中…' : kind === 'video' ? '↓ 下载视频' : '↓ 下载封面'), error ? h('p', { className: 'sv-error', role: 'alert' }, error) : null);
    }
    function PublishVideoModal({ packId, item, onClose }) {
      const modal = React.useRef(null);
      const [asset, setAsset] = React.useState(null);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        const previous = document.activeElement;
        modal.current?.showModal();
        return () => { modal.current?.close(); if (previous?.isConnected) previous.focus(); };
      }, []);
      React.useEffect(() => {
        let active = true;
        void remote(packId, 'readPublishAsset', { projectId: item.id, kind: 'video' })
          .then((next) => { if (active) setAsset(next); })
          .catch((cause) => { if (active) setError(cause.message); });
        return () => { active = false; };
      }, [packId, item.id, item.video?.file]);
      return h('dialog', { ref: modal, className: 'sv-pb-player', 'aria-label': `播放成片 · ${item.title}`, onCancel: (event) => { event.preventDefault(); onClose(); }, onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'sv-pb-player-panel' },
          h('header', null, h('div', null, h('p', null, '成片预览'), h('h3', null, item.title)), h('button', { type: 'button', className: 'lwb-plain-button', onClick: onClose, autoFocus: true }, '关闭')),
          h('div', { className: 'sv-pb-player-stage' }, error ? h('p', { role: 'alert' }, error) : asset ? h('video', { controls: true, autoPlay: true, preload: 'metadata', src: mediaDataUrl(asset) }) : h('p', { role: 'status' }, '正在载入视频…')),
          h('footer', null, h('span', null, [item.orientation === 'portrait' ? '竖屏 9:16' : '横屏 16:9', formatMediaDuration(item.video?.durationSeconds)].join(' · ')), h(PublishAssetDownload, { packId, projectId: item.id, title: item.title, kind: 'video', asset, disabled: !asset })),
        ),
      );
    }
    /** Cards only request a small thumbnail; video bytes are loaded in a modal. */
    function PublishVideoThumb({ packId, item, videoThumbnail = false }) {
      const [cover, setCover] = React.useState(null);
      const [playing, setPlaying] = React.useState(false);
      const covers = videoThumbnail ? null : item.packaging?.covers || null;
      const prefer = item.orientation === 'portrait' ? 'portrait' : 'landscape';
      const coverKind = covers?.[prefer]?.file ? prefer : covers?.landscape?.file ? 'landscape' : covers?.portrait?.file ? 'portrait' : null;
      const coverFile = coverKind ? covers[coverKind].file : null;
      React.useEffect(() => {
        setCover(null);
        if (!packId || !item.video) return undefined;
        let active = true;
        const read = (kind) => remote(packId, 'readPublishAsset', { projectId: item.id, kind });
        void (coverKind ? read(coverKind).catch(() => read('thumbnail')) : read('thumbnail'))
          .then((next) => { if (active) setCover(next); }).catch(() => {});
        return () => { active = false; };
      }, [packId, item.id, coverKind, coverFile, item.video?.file]);
      return h(React.Fragment, null,
        h('div', { className: 'sv-pb-thumb' },
          cover ? h('img', { src: mediaDataUrl(cover), alt: `${item.title} 视频缩略图` }) : h('div', { className: 'sv-pb-thumb-empty' }, item.video ? '成片预览' : '尚无成片'),
          item.video ? h('button', { type: 'button', className: 'sv-pb-play', title: '弹窗播放成片', 'aria-label': `播放 ${item.title}`, onClick: () => setPlaying(true) }) : null,
        ),
        playing ? h(PublishVideoModal, { key: item.video?.file || item.id, packId, item, onClose: () => setPlaying(false) }) : null,
      );
    }
    /**
     * The publish page is a flat video shelf grouped by account: every
     * QC-passed final cut shows up with modal playback and one 「发布」
     * button. The drawer is the whole lifecycle — it auto-generates publish
     * info on first open, then offers editing, prompt-driven cover
     * regeneration, uploads and full regeneration. Having title/copy/
     * description/tags means publishable; there are no approval or queue
     * gates and nothing is ever sent to a platform.
     */
    function PublishPageV4({ packId, openConversation }) {
      const { refresh, error, setError } = useProjects(packId);
      const [service, setService] = React.useState(null);
      const [accountLibrary, setAccountLibrary] = React.useState({ accounts: [], defaultAccountId: null });
      const [activeTab, setActiveTab] = React.useState(GENERAL_TAB);
      const [items, setItems] = React.useState([]);
      const [page, setPage] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [connectionOpen, setConnectionOpen] = React.useState(false);
      const [connectionProvider, setConnectionProvider] = React.useState('bailian');
      const [connectionModel, setConnectionModel] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      // 自定义云端生图的表单。默认值由后端给（可被环境变量覆盖），这样打开抽屉
      // 就能改，而不是面对四个空框猜该填什么。
      const [customBaseUrl, setCustomBaseUrl] = React.useState('');
      const [customProtocol, setCustomProtocol] = React.useState('openai');
      const [customPath, setCustomPath] = React.useState('');
      const [customAuthHeader, setCustomAuthHeader] = React.useState('bearer');
      // 首次拿到 status 时用后端默认值预填一次，之后以用户输入为准。
      const [customSeeded, setCustomSeeded] = React.useState(false);
      React.useEffect(() => {
        if (customSeeded || !service) return;
        const preset = service.custom || service.customDefaults;
        if (preset) {
          if (preset.baseUrl) setCustomBaseUrl(preset.baseUrl);
          if (preset.protocol) setCustomProtocol(preset.protocol);
          if (preset.path) setCustomPath(preset.path);
          if (preset.authHeader) setCustomAuthHeader(preset.authHeader);
        }
        setCustomSeeded(true);
      }, [service, customSeeded]);
      const [connectionBusy, setConnectionBusy] = React.useState(null);
      // The drawer is the only selection surface; it is keyed by project id.
      const [openProject, setOpenProject] = React.useState(null);
      const [content, setContent] = React.useState(emptyPublishContent());
      const [prompts, setPrompts] = React.useState(emptyPublishPrompts());
      const [covers, setCovers] = React.useState({ landscape: null, portrait: null });
      const [coverBusy, setCoverBusy] = React.useState(null);
      const [triggerError, setTriggerError] = React.useState(null);
      const [tagInput, setTagInput] = React.useState('');
      // 素材管理：单个删除直接走卡片按钮，多选后批量删除。选择集按项目 id 存。
      const [selected, setSelected] = React.useState(() => new Set());
      const [deleting, setDeleting] = React.useState(null);
      const [confirmNode, ask] = useSvConfirm();
      const landscapeInputRef = React.useRef(null);
      const portraitInputRef = React.useRef(null);
      const coverInputRef = (kind) => (kind === 'landscape' ? landscapeInputRef : portraitInputRef);
      // Auto-generation is attempted once per project revision; a failure is
      // never retried silently — the drawer shows the error and a retry button.
      const autoTriggered = React.useRef(new Set());

      const { detail, error: detailError, reload } = useDetail(packId, openProject);

      const refreshService = React.useCallback(async () => {
        try { const next = await remoteStatic('publishStatus'); setService(next); return next; }
        catch (cause) { setError(cause.message); return null; }
      }, [setError]);
      const loadItems = React.useCallback(async () => {
        if (!packId) return [];
        try { const next = await remote(packId, 'listPublishItems'); setItems(next.items || []); setError(null); return next.items || []; }
        catch (cause) { setError(cause.message); return []; }
      }, [packId, setError]);

      /** 删除项目会连同它的稿件、配音、字幕、成片与封面一起永久移除。 */
      const deleteItems = async (targets) => {
        if (!packId || !targets.length || deleting) return;
        setDeleting(targets.length === 1 ? targets[0].id : `batch:${targets.length}`);
        try {
          const result = await remote(packId, 'remove', { projectIds: targets.map((item) => item.id) });
          const removed = new Set(result?.removed || []);
          setSelected((current) => { const next = new Set(current); for (const id of removed) next.delete(id); return next; });
          // 抽屉正开着被删的项目时关掉，避免停留在已不存在的记录上。
          if (openProject && removed.has(openProject)) { setOpenProject(null); setTriggerError(null); }
          await Promise.all([loadItems(), refresh()]);
          const missing = result?.missing?.length || 0;
          setError(missing ? `有 ${missing} 个素材已不存在，可能已被删除。` : null);
        } catch (cause) { setError(cause.message); } finally { setDeleting(null); }
      };
      const askDelete = (targets) => {
        if (!targets.length) return;
        const single = targets.length === 1;
        ask({
          title: single ? '删除整个项目（含成片）' : `删除 ${targets.length} 个项目（含成片）`,
          danger: true,
          confirm: '永久删除',
          copy: single
            ? `将永久删除项目「${targets[0].title}」的全部内容：稿件、配音、字幕、成片和封面。它也会从发布列表与视频任务列表中消失，无法恢复。只想删掉成片本身的话，请到「视频 / 预览」页删除那条视频任务。`
            : `将永久删除选中的 ${targets.length} 个素材，包括各自的稿件、配音、字幕、成片和封面，无法恢复。`,
          onConfirm: () => { void deleteItems(targets); },
        });
      };

      React.useEffect(() => { void refreshService(); }, [refreshService]);
      React.useEffect(() => {
        if (!packId) return;
        void Promise.all([remote(packId, 'listAccounts'), loadItems()])
          .then(([accounts, shelfItems]) => {
            setAccountLibrary(accounts);
            if (publishHandoff?.packId === packId) {
              const target = publishHandoff.projectId; publishHandoff = null;
              const item = shelfItems.find((row) => row.id === target);
              setOpenProject(target);
              setActiveTab(item?.account?.id || GENERAL_TAB);
              return;
            }
            // Pipeline board handoff: open the passed-qc project's publish drawer.
            if (pipelineHandoff?.page === 'publish' && shelfItems.some((row) => row.id === pipelineHandoff.projectId)) {
              const target = pipelineHandoff.projectId; pipelineHandoff = null;
              const item = shelfItems.find((row) => row.id === target);
              setOpenProject(target);
              setActiveTab(item?.account?.id || GENERAL_TAB);
              return;
            }
            // 默认落在成片最多的那个 Tab。原逻辑退回「通用」，而绝大多数成片都带账号
            // 归属，「通用」里往往只有零星几条——用户第一眼就以为成片不见了
            // （2026-10-08 反馈：刚跑完的成片在发布页找不到）。有作品最多的账号优先，
            // 全都为空时才回到默认账号 / 通用。
            const activeIds = new Set(accounts.accounts.filter((item) => item.status === 'active').map((item) => item.id));
            const byTab = shelfItems.reduce((tally, row) => {
              const key = !row.account ? GENERAL_TAB : activeIds.has(row.account.id) ? row.account.id : ARCHIVED_TAB;
              tally[key] = (tally[key] || 0) + 1;
              return tally;
            }, {});
            const richest = Object.keys(byTab)
              .filter((key) => key !== ARCHIVED_TAB)
              .sort((left, right) => byTab[right] - byTab[left])[0] || null;
            setActiveTab((current) => {
              if (current !== GENERAL_TAB && accounts.accounts.some((item) => item.id === current && item.status === 'active')) return current;
              if (richest && byTab[richest] > 0) return richest;
              return accounts.defaultAccountId || GENERAL_TAB;
            });
          }).catch((cause) => setError(cause.message));
      }, [packId, loadItems, setError]);
      // Reflect the saved image-generation config into the drawer form.
      React.useEffect(() => {
        if (!service) return;
        setConnectionProvider(['bailian', 'scitiger'].includes(service.provider) ? service.provider : 'bailian');
        setConnectionModel(typeof service.model === 'string' ? service.model : '');
      }, [service?.provider, service?.model]);

      const openItem = openProject ? items.find((item) => item.id === openProject) || null : null;
      const openTask = openItem?.task || null;
      const running = Boolean(openTask && ['queued', 'running'].includes(openTask.status));
      // While a generation runs, keep the shelf, the detail and the task summary fresh.
      React.useEffect(() => {
        if (!packId || !running || !openProject) return undefined;
        let active = true;
        const tick = () => { void (async () => { await loadItems(); if (active) { await Promise.all([reload(), refresh()]); } })(); };
        tick();
        const timer = setInterval(tick, 1500);
        return () => { active = false; clearInterval(timer); };
      }, [packId, running, openProject, loadItems, reload, refresh]);

      const packaging = stageData(detail, 'packaging') || null;
      // Load the persisted publish info into the editor on every artifact change.
      React.useEffect(() => {
        const data = stageData(detail, 'packaging');
        setContent(data?.content ? { title: data.content.title, copy: data.content.copy, description: data.content.description, tags: [...(data.content.tags || [])] } : emptyPublishContent());
        setPrompts(data?.prompts ? { landscape: data.prompts.landscape || '', portrait: data.prompts.portrait || '', negative: data.prompts.negative || '' } : emptyPublishPrompts());
        setTagInput('');
      }, [detail?.id, detail?.revision]);
      const dirty = Boolean(packaging) && (!contentEquals(content, packaging.content) || !promptsEquals(prompts, packaging.prompts));

      // Pull frozen cover bytes whenever the opened project's covers change.
      React.useEffect(() => {
        setCovers({ landscape: null, portrait: null });
        if (!packId || !openProject || !packaging) return undefined;
        const kinds = ['landscape', 'portrait'].filter((kind) => packaging.covers?.[kind]?.file);
        if (!kinds.length) return undefined;
        let cancelled = false;
        void Promise.all(kinds.map((kind) => remote(packId, 'readPublishAsset', { projectId: openProject, kind })
          .then((asset) => [kind, asset]).catch(() => [kind, null])))
          .then((entries) => { if (!cancelled) setCovers((prev) => { const next = { ...prev }; for (const [kind, asset] of entries) if (asset) next[kind] = asset; return next; }); });
        return () => { cancelled = true; };
      }, [packId, openProject, packaging?.covers?.landscape?.file, packaging?.covers?.portrait?.file]);

      const startPackaging = async (projectId, revision) => {
        if (busy) return false;
        setBusy(true); setError(null); setTriggerError(null);
        try {
          await remote(packId, 'startPackaging', { projectId, expectedRevision: revision });
          await loadItems();
          return true;
        } catch (cause) {
          // A rejected trigger creates no task record, so the failure would be
          // invisible inside the drawer. Surface it there with a retry button.
          setTriggerError(cause.message); setError(cause.message); return false;
        } finally { setBusy(false); }
      };
      // 打开抽屉不再静默扣额度。
      //
      // 旧实现：打开一条成片的发布抽屉，若还没有发布资料就自动开始一次
      // AI 文案 + 两张生图——用户只是想「看看」，什么都没点就被扣了一次
      // 模型与生图额度。现在改为显式确认：抽屉里给出说明与「开始生成」按钮。
      // autoTriggered 仍保留：同一条成片的同一版本只提示一次，不反复打扰。
      const [autoPrompt, setAutoPrompt] = React.useState(null);
      React.useEffect(() => {
        if (!packId || !openProject || !detail || busy) return;
        if (detail.artifacts?.packaging) return;
        const item = items.find((row) => row.id === openProject);
        if (item?.task && ['queued', 'running'].includes(item.task.status)) return;
        const key = `${detail.id}:${detail.revision}`;
        if (autoTriggered.current.has(key)) return;
        autoTriggered.current.add(key);
        setAutoPrompt({ projectId: detail.id, revision: detail.revision });
      }, [packId, openProject, detail?.id, detail?.revision, items, busy]);

      const saveContent = async () => {
        if (!detail || !packaging) return null;
        setBusy(true); setError(null);
        try {
          const saved = await remote(packId, 'updatePackaging', { projectId: detail.id, expectedRevision: detail.revision, content, prompts });
          await Promise.all([reload(), loadItems()]);
          return saved;
        } catch (cause) { setError(cause.message); return null; } finally { setBusy(false); }
      };
      const uploadCover = async (kind, file) => {
        if (!detail || !packaging || !file) return;
        const limit = service?.imageMaxBytes || 20 * 1024 * 1024;
        if (file.size < 1 || file.size > limit) { setError(`封面必须小于 ${formatMediaBytes(limit)}。`); return; }
        setCoverBusy(kind); setError(null);
        try {
          const data = await base64FromAudioFile(file);
          await remote(packId, 'uploadPublishCover', { projectId: detail.id, expectedRevision: detail.revision, kind, data });
          const asset = await remote(packId, 'readPublishAsset', { projectId: detail.id, kind });
          setCovers((prev) => ({ ...prev, [kind]: asset }));
          await Promise.all([reload(), loadItems()]);
        } catch (cause) { setError(cause.message); } finally { setCoverBusy(null); }
      };
      // Regenerating one cover direction reuses the (possibly hand-edited)
      // prompt. Unsaved edits are committed first so the copy the user sees is
      // the copy that survives the regeneration.
      const regenerateCover = async (kind) => {
        if (!detail || !packaging || coverBusy || running) return;
        setCoverBusy(kind); setError(null);
        try {
          let revision = detail.revision;
          if (dirty) {
            const saved = await remote(packId, 'updatePackaging', { projectId: detail.id, expectedRevision: revision, content, prompts });
            revision = saved.project.revision;
            await reload();
          }
          await remote(packId, 'regeneratePublishCover', { projectId: detail.id, expectedRevision: revision, kind, prompt: prompts[kind], negativePrompt: prompts.negative });
          await loadItems();
        } catch (cause) { setError(cause.message); } finally { setCoverBusy(null); }
      };
      const regenerateAll = () => ask({
        title: '重新生成发布信息', danger: true, confirm: '确认重新生成',
        copy: `将由 AI 重新生成「${detail?.title || ''}」的标题、文案、描述、标签与封面提示词${service?.configured ? '，并重新生成横竖封面' : ''}。当前的人工修改会被覆盖。`,
        onConfirm: async () => { if (detail) await startPackaging(detail.id, detail.revision); },
      });
      const saveConnection = async () => {
        setConnectionBusy('save');
        try {
          await remoteStatic('configurePublishConnection', {
            provider: connectionProvider,
            model: connectionModel.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            // 自定义渠道要带上完整的服务描述；不传时后端会沿用已存的值，
            // 这样只改模型名不会把地址冲掉。
            ...(connectionProvider === 'custom' ? { custom: { baseUrl: customBaseUrl.trim(), protocol: customProtocol, path: customPath.trim(), authHeader: customAuthHeader } } : {}),
          });
          setApiKey(''); await refreshService(); setError(null);
        } catch (cause) { setError(cause.message); } finally { setConnectionBusy(null); }
      };
      const clearConnection = async () => {
        setConnectionBusy('clear');
        try { await remoteStatic('clearPublishConnectionCredential', { provider: connectionProvider }); await refreshService(); setError(null); }
        catch (cause) { setError(cause.message); } finally { setConnectionBusy(null); }
      };

      const addTag = (raw) => {
        const tag = String(raw || '').trim().replace(/^#+/u, '');
        if (!tag) return;
        setContent((prev) => (prev.tags.includes(tag) || prev.tags.length >= 10 ? prev : { ...prev, tags: [...prev.tags, tag] }));
        setTagInput('');
      };
      const removeTag = (tag) => setContent((prev) => ({ ...prev, tags: prev.tags.filter((item) => item !== tag) }));

      const activeAccounts = accountLibrary.accounts.filter((item) => item.status === 'active');
      const activeIds = new Set(activeAccounts.map((item) => item.id));
      const tabOf = (item) => (!item.account ? GENERAL_TAB : activeIds.has(item.account.id) ? item.account.id : ARCHIVED_TAB);
      const stateRank = { ready: 0, none: 1, failed: 2, running: 3 };
      const sortItems = (list) => [...list].sort((a, b) => (stateRank[publishStateOf(a)] - stateRank[publishStateOf(b)]) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const tabItems = sortItems(items.filter((item) => tabOf(item) === activeTab));
      const archivedItems = sortItems(items.filter((item) => tabOf(item) === ARCHIVED_TAB));
      const tabName = activeTab === GENERAL_TAB ? '通用（无账号定位）' : (activeAccounts.find((item) => item.id === activeTab)?.name || '—');
      // 每个 Tab 上的成片数量：默认落在「通用」Tab 时，真正有作品的账号是隐形的，
      // 用户会以为成片丢了（2026-10-08 反馈）。角标把藏起来的量直接说出来。
      const countByTab = items.reduce((tally, item) => {
        const key = tabOf(item);
        tally[key] = (tally[key] || 0) + 1;
        return tally;
      }, {});
      const pageCount = Math.max(1, Math.ceil(tabItems.length / PUBLISH_PAGE_SIZE));
      const pagedItems = tabItems.slice(page * PUBLISH_PAGE_SIZE, page * PUBLISH_PAGE_SIZE + PUBLISH_PAGE_SIZE);
      // Shelf pagination follows the audio workbench: reset on tab switch and
      // clamp when the list shrinks underneath the current page.
      React.useEffect(() => { setPage(0); }, [activeTab]);
      React.useEffect(() => { if (page >= pageCount) setPage(Math.max(0, pageCount - 1)); }, [page, pageCount]);

      const resetDrawer = () => { setOpenProject(null); setTriggerError(null); };
      const closeDrawer = () => {
        if (!dirty) { resetDrawer(); return; }
        ask({ title: '放弃未保存的修改？', danger: true, confirm: '放弃修改', copy: '发布信息里有尚未保存的修改，关闭后会丢失。', onConfirm: resetDrawer });
      };

      const stateBadge = (item) => {
        const state = publishStateOf(item);
        return h('span', { className: 'sv-sc-state', 'data-state': publishStateTone(state) }, PUBLISH_STATE_LABEL[state]);
      };
      const coverNote = (item) => {
        const covers2 = item.packaging?.covers || null;
        if (!item.packaging) return null;
        const ready = ['landscape', 'portrait'].filter((kind) => covers2?.[kind]?.file);
        const failed = ['landscape', 'portrait'].filter((kind) => item.packaging.coverErrors?.[kind]);
        if (ready.length === 2) return '封面：横竖已就绪';
        if (failed.length) return `封面待补：${failed.map((kind) => kind === 'landscape' ? '横屏' : '竖屏').join('、')}`;
        return ready.length ? `封面：${ready[0] === 'landscape' ? '横屏' : '竖屏'}已就绪` : '封面：尚未生成';
      };
      // 卡片底部的状态说明。旧文案对未生成的情况只写「点『发布』查看或生成发布资料」，
      // 而发布资料其实是「点开抽屉才自动生成」——用户看到「未生成」以为白跑了
      // （2026-10-08 反馈）。改成按状态说清下一步该做什么。
      const publishFootNote = (item) => {
        const state = publishStateOf(item);
        if (state === 'ready') return '标题 / 文案 / 描述 / 标签已就绪';
        if (state === 'running') return '正在生成发布资料…';
        if (state === 'failed') return '发布资料生成失败，点「发布」查看原因并重试';
        return '点「发布」生成本片的标题、文案与标签';
      };
      const videoSpec = (item) => [
        item.orientation === 'portrait' ? '竖屏 9:16' : item.orientation === 'landscape' ? '横屏 16:9' : null,
        item.video?.width && item.video?.height ? `${item.video.width}x${item.video.height}` : null,
        item.video?.durationSeconds ? formatMediaDuration(item.video.durationSeconds) : null,
        item.video?.bytes ? formatMediaBytes(item.video.bytes) : null,
      ].filter(Boolean).join(' · ');
      // The drawer prefers the loaded artifact so the spec shows even before the
      // shelf listing settles; the card falls back to the list item.
      const detailVideo = stageData(detail, 'video') || null;
      const drawerSpec = videoSpec({ orientation: detailVideo?.orientation || openItem?.orientation || null, video: detailVideo?.video || openItem?.video || null });
      const itemCard = (item, archived) => h('article', { key: item.id, className: 'sv-pb-card', 'data-selected': selected.has(item.id) ? 'true' : 'false' },
        h(PublishVideoThumb, { packId, item, setError }),
        h('div', { className: 'sv-pb-card-head' },
          h('label', { className: 'sv-pb-select' },
            h('input', { type: 'checkbox', checked: selected.has(item.id), disabled: Boolean(deleting), 'aria-label': `选择素材「${item.title}」`, onChange: () => setSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }) }),
          ),
          h('p', { className: 'sv-pb-card-title' }, item.title),
          h('div', { className: 'sv-pb-card-badges' }, stateBadge(item), item.qcUserOverride ? h('span', { className: 'sv-released-tag' }, '已人工放行') : null),
        ),
        h('p', { className: 'sv-pb-card-meta' }, [item.account?.name || '通用', videoSpec(item)].filter(Boolean).join(' · ')),
        h('p', { className: 'sv-pb-card-meta' }, [coverNote(item), item.packaging ? `标签 ${item.packaging.content?.tags?.length || 0} 个` : null, archived ? `已归档 · ${item.account?.name || ''}` : null, relativeTime(item.updatedAt)].filter(Boolean).join(' · ')),
        item.task?.status === 'failed' ? h('p', { className: 'sv-pb-cover-error' }, item.task.error || '发布信息生成失败。') : null,
        h('div', { className: 'sv-pb-card-foot' },
          h('span', { className: 'sv-pb-card-meta' }, publishFootNote(item)),
          h('span', { className: 'sv-actions' },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(deleting), onClick: () => askDelete([item]) }, deleting === item.id ? '正在删除…' : '删除项目'),
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(deleting), onClick: () => setOpenProject(item.id) }, '发布'),
          ),
        ),
      );

      const tabs = h(AccountTabs, { accountLibrary, activeTab, onChange: setActiveTab, label: '按账号筛选成片', tabBadge: countByTab, tabBadgeLabel: '条成片' },
        archivedItems.length ? h('span', { className: 'sv-sc-archived', title: '已归档账号的成片仅在列表尾部展示' }, `已归档 ${archivedItems.length}`) : null,
      );

      // 批量选择只覆盖当前 Tab 当前页可见的卡片，跨页选择容易误删。
      const pageIds = [...pagedItems.map((item) => item.id), ...(page === pageCount - 1 ? archivedItems.map((item) => item.id) : [])];
      const selectedOnPage = pageIds.filter((id) => selected.has(id));
      const allOnPageSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
      const selectedItems = items.filter((item) => selected.has(item.id));
      const selectionBar = pageIds.length ? h('div', { className: 'sv-pb-selection' },
        h('label', { className: 'sv-pb-select' },
          h('input', { type: 'checkbox', checked: allOnPageSelected, disabled: Boolean(deleting), 'aria-label': '选择本页全部素材', onChange: () => setSelected((current) => { const next = new Set(current); if (allOnPageSelected) for (const id of pageIds) next.delete(id); else for (const id of pageIds) next.add(id); return next; }) }),
          h('span', null, allOnPageSelected ? '取消本页全选' : '全选本页'),
        ),
        h('span', { className: 'sv-meta' }, selected.size ? `已选 ${selected.size} 个` : '可勾选多个素材后批量删除'),
        h('span', { className: 'sv-actions' },
          selected.size ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(deleting), onClick: () => setSelected(new Set()) }, '清空选择') : null,
          h('button', { type: 'button', className: 'lwb-danger-button', disabled: Boolean(deleting) || !selected.size, onClick: () => askDelete(selectedItems) }, typeof deleting === 'string' && deleting.startsWith('batch:') ? '正在删除…' : `删除选中${selected.size ? `（${selected.size}）` : ''}`),
        ),
      ) : null;

      const shelf = h('section', { className: 'sv-section' },
        h('div', { className: 'sv-section-head' }, h('h3', null, '成片与发布资料'), h('span', null, `当前 Tab · ${tabName} · ${tabItems.length} 个`)),
        tabs,
        tabItems.length || archivedItems.length ? h(React.Fragment, null,
          selectionBar,
          h('div', { className: 'sv-pb-shelf' }, pagedItems.map((item) => itemCard(item, false)), page === pageCount - 1 && archivedItems.length ? archivedItems.map((item) => itemCard(item, true)) : null),
          pageCount > 1 ? h('div', { className: 'sv-audio-pagebar' },
            h('span', { className: 'sv-meta' }, `第 ${page + 1}/${pageCount} 页 · 共 ${tabItems.length + archivedItems.length} 个`),
            h('span', { className: 'sv-actions' },
              h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '上一页', disabled: page === 0, onClick: () => setPage((current) => Math.max(0, current - 1)) }, '上一页'),
              h('button', { type: 'button', className: 'lwb-plain-button', 'aria-label': '下一页', disabled: page + 1 >= pageCount, onClick: () => setPage((current) => Math.min(pageCount - 1, current + 1)) }, '下一页'),
            ),
          ) : null,
        ) : h('div', { className: items.length ? 'sv-empty' : 'sv-empty-cta' }, items.length ? '当前账号 Tab 暂无成片，可切换其他账号 Tab。' : h(React.Fragment, null, h('p', null, '还没有通过质检的成片。'), h('p', null, '先到「视频 / 预览」页完成视频制作与质检，质检通过的成片会自动出现在这里。'))),
      );

      // ---- lifecycle drawer ----
      const coverCard = (kind) => {
        // 封面标签里的比例要和实际生成的尺寸一致：竖版是 3:4（抖音/小红书信息流展示比例），
// 不是视频本身的 9:16 —— 标错会让人以为该把封面裁窄。
const label = kind === 'landscape' ? '横屏封面 16:9' : '竖屏封面 3:4';
        const descriptor = packaging?.covers?.[kind] || null;
        const asset = covers[kind];
        const coverError = packaging?.coverErrors?.[kind] || null;
        return h('div', { key: kind, className: 'sv-pb-cover', 'data-kind': kind },
          h('div', { className: 'sv-pb-cover-head' }, h('strong', null, label), descriptor ? h('span', null, `${descriptor.width}x${descriptor.height} · ${formatMediaBytes(descriptor.bytes)} · ${descriptor.source === 'upload' ? '人工上传' : 'AI 生成'}`) : h('span', null, '未生成')),
          h('div', { className: 'sv-pb-cover-frame' }, asset?.data ? h('img', { src: `data:${asset.mediaType};base64,${asset.data}`, alt: label }) : h('div', { className: 'sv-pb-cover-empty' }, descriptor ? '正在载入封面…' : '尚无封面')),
          h(PublishAssetDownload, { packId, projectId: detail.id, title: detail.title, kind, asset, disabled: !descriptor }),
          coverError ? h('p', { className: 'sv-pb-cover-error' }, coverError) : null,
          h('label', { className: 'sv-pb-prompt' }, h('span', null, `${label.slice(0, 2)}生图提示词（可修改）`),
            h('textarea', { className: 'sv-textarea', value: prompts[kind], maxLength: 3000, disabled: busy || running, onChange: (event) => setPrompts((prev) => ({ ...prev, [kind]: event.target.value })) }),
          ),
          h('div', { className: 'sv-pb-cover-acts' },
            h('input', { ref: coverInputRef(kind), type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' }, onChange: (event) => { const file = event.target.files?.[0] || null; event.target.value = ''; if (file) void uploadCover(kind, file); } }),
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: !packaging || coverBusy === kind || running || !prompts[kind].trim() || service?.configured !== true, title: service?.configured === true ? '按当前提示词重新生成这张封面' : '需先在「封面生图」里保存当前渠道的 API Key', onClick: () => { void regenerateCover(kind); } }, coverBusy === kind ? '生成中…' : '按此提示词生图'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: !packaging || coverBusy === kind || running, onClick: () => coverInputRef(kind).current?.click() }, coverBusy === kind ? '上传中…' : descriptor ? '上传替换' : '上传封面'),
          ),
          service?.configured !== true ? h('p', { className: 'sv-pb-field-note' }, '当前生图渠道尚未配置 API Key；也可上传自己的封面图。') : null,
        );
      };
      const tagEditor = h('div', { className: 'sv-pb-field' },
        h('span', null, `标签（${content.tags.length}/10）`),
        content.tags.length ? h('div', { className: 'sv-pb-tags' }, content.tags.map((tag) => h('span', { key: tag, className: 'sv-pb-tag' }, `#${tag}`, h('button', { type: 'button', className: 'sv-tp-acct-link', style: { marginLeft: '5px' }, disabled: !packaging || busy, onClick: () => removeTag(tag) }, '×')))) : h('p', { className: 'sv-pb-field-note' }, '尚无标签，至少需要一个。'),
        h('div', { className: 'sv-actions' },
          h('input', { className: 'sv-input', style: { flex: '1 1 160px' }, value: tagInput, maxLength: 30, placeholder: '输入标签后回车添加', disabled: !packaging || busy || content.tags.length >= 10, onChange: (event) => setTagInput(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(tagInput); } } }),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: !packaging || busy || !tagInput.trim() || content.tags.length >= 10, onClick: () => addTag(tagInput) }, '添加'),
        ),
      );
      const stepBlock = (task) => {
        const phases = task.coverKind ? ['covers', 'ready'] : ['agent', 'covers', 'ready'];
        const labels = { agent: '生成发布资料', covers: '生成封面', ready: '就绪' };
        const currentIndex = phases.indexOf(task.phase);
        return h('div', { className: 'sv-tp-steps' }, phases.map((phase, index) => h('span', { key: phase, className: 'sv-tp-step', 'data-state': task.status === 'failed' && index === Math.max(currentIndex, 0) ? 'error' : index < currentIndex || task.status === 'succeeded' ? 'done' : index === currentIndex ? 'running' : undefined }, h('i', null), labels[phase])));
      };

      const drawerBody = detail && h('div', { className: 'sv-sc-drawer-body' },
        h('section', { className: 'sv-pb-section sv-pb-final' },
          h('div', { className: 'sv-pb-section-heading' }, h('div', null, h('p', { className: 'sv-pb-section-number' }, '01 / 成片'), h('h4', null, '预览与下载'), h('p', null, drawerSpec || '上一模块生成的视频')), h(PublishAssetDownload, { packId, projectId: detail.id, title: detail.title, kind: 'video', disabled: !detailVideo?.video && !openItem?.video })),
          h(PublishVideoThumb, { packId, item: { id: detail.id, title: detail.title, video: detailVideo?.video || openItem?.video || null, orientation: detailVideo?.orientation || openItem?.orientation || null, packaging: packaging || openItem?.packaging || null }, setError }),
        ),
        !packaging
          ? h('div', { className: 'sv-sc-empty-manuscript' },
              running
                ? h(React.Fragment, null, h('p', null, openTask?.coverKind ? '正在重新生成封面…' : '正在生成发布信息…'), stepBlock(openTask), h('p', { className: 'sv-sc-report-empty' }, '关闭抽屉不会中断生成。'))
                : openTask?.status === 'failed'
                  ? h(React.Fragment, null,
                      h('p', null, '发布信息生成失败。'),
                      h('p', { className: 'sv-pb-cover-error' }, openTask.error || '未知错误'),
                      h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy, onClick: () => { void startPackaging(detail.id, detail.revision); } }, busy ? '正在提交…' : '重试生成'),
                    )
                  : triggerError
                    ? h(React.Fragment, null,
                        h('p', null, '未能触发生成。'),
                        h('p', { className: 'sv-pb-cover-error' }, triggerError),
                        h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy, onClick: () => { autoTriggered.current.delete(`${detail.id}:${detail.revision}`); void startPackaging(detail.id, detail.revision); } }, busy ? '正在提交…' : '重试生成'),
                      )
                    // 不再静默触发：生成会调用模型与生图服务、产生费用，
                    // 所以把「做什么、花什么」说清楚，由用户点按钮开始。
                    : h(React.Fragment, null,
                        h('p', null, '这条成片还没有发布资料。'),
                        h('p', { className: 'sv-sc-report-empty' }, '点「开始生成」将调用模型生成标题、文案、描述、标签与封面提示词' + (service?.configured ? '，并生成横竖两版封面（会调用生图服务）。' : '；未配置生图服务时可自行上传封面。')),
                        h('div', { className: 'sv-actions' }, h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy, onClick: () => { setAutoPrompt(null); void startPackaging(detail.id, detail.revision); } }, busy ? '正在提交…' : '开始生成')),
                      ),
            )
          : h(React.Fragment, null,
              running ? h('section', { className: 'sv-sc-run-status' }, h('div', { className: 'sv-sc-ai-action-head' }, h('strong', null, openTask?.coverKind ? '生图服务正在重新生成封面' : 'DSH 正在重新生成发布信息'), h('span', null, relativeTime(openTask.createdAt))), stepBlock(openTask), h('p', { className: 'sv-note' }, '完成后会自动更新下方内容；关闭抽屉不会中断。')) : null,
              h('section', { className: 'sv-pb-section sv-pb-form' },
                h('p', { className: 'sv-pb-section-number' }, '02 / 发布资料'),
                h('div', { className: 'sv-sc-view-head' }, h('h4', null, '核对标题与文案'), h('p', null, packaging.mode === 'agent' ? 'AI 生成，可人工修改后保存' : packaging.mode === 'manual-update' ? '已人工修改' : packaging.mode === 'cover-upload' ? '封面已人工替换' : '封面已按提示词重生')),
                h('label', { className: 'sv-pb-field' }, h('span', null, '标题'), h('input', { className: 'sv-input', value: content.title, maxLength: 80, disabled: busy, onChange: (event) => setContent((prev) => ({ ...prev, title: event.target.value })) })),
                h('label', { className: 'sv-pb-field' }, h('span', null, '视频文案'), h('textarea', { className: 'sv-textarea', style: { minHeight: '96px' }, value: content.copy, maxLength: 2000, disabled: busy, onChange: (event) => setContent((prev) => ({ ...prev, copy: event.target.value })) })),
                h('label', { className: 'sv-pb-field' }, h('span', null, '视频描述'), h('textarea', { className: 'sv-textarea', style: { minHeight: '80px' }, value: content.description, maxLength: 1000, disabled: busy, onChange: (event) => setContent((prev) => ({ ...prev, description: event.target.value })) })),
                tagEditor,
              ),
              h('section', { className: 'sv-pb-section' },
                h('p', { className: 'sv-pb-section-number' }, '03 / 封面素材'),
                h('div', { className: 'sv-sc-view-head' }, h('h4', null, '横竖封面'), h('p', null, '可查看并修改生图提示词后单独重生；也可直接上传自己的封面图。')),
                h('div', { className: 'sv-pb-covers' }, coverCard('landscape'), coverCard('portrait')),
                h('label', { className: 'sv-pb-prompt', style: { marginTop: '10px' } }, h('span', null, '负面提示词（可选，两个方向共用）'),
                  h('textarea', { className: 'sv-textarea', style: { minHeight: '52px' }, value: prompts.negative, maxLength: 1000, disabled: busy || running, onChange: (event) => setPrompts((prev) => ({ ...prev, negative: event.target.value })) }),
                ),
              ),
              openTask ? h('section', { className: 'sv-pb-section sv-pb-generation' }, h('div', { className: 'sv-sc-view-head' }, h('h4', null, '最近一次生成'), h('p', null, `${openTask.status === 'succeeded' ? '已完成' : openTask.status === 'failed' ? '失败' : '进行中'} · ${formatTime(openTask.createdAt)}${openTask.imageProvider ? ` · 封面 ${IMAGE_PROVIDER_SHORT[openTask.imageProvider.provider] || openTask.imageProvider.provider}` : ' · 未配置生图服务'}`)), openTask.status === 'failed' ? h('p', { className: 'sv-error' }, openTask.error || '生成失败。') : null, h(ExecutionButton, { kind: 'publish', id: openTask.id, projectId: openTask.projectId }), h(ExecutionHistory, { kind: 'publish', projectId: openTask.projectId, refreshKey: openTask.status })) : null,
            ),
      );
      const drawerFoot = detail && h('div', { className: 'sv-tp-drawer-foot' },
        packaging
          ? h(React.Fragment, null,
              h('p', { className: 'sv-sc-gate-note' }, dirty ? '有未保存的修改' : '资料齐备即视为可发布，复制标题/文案/描述/标签与封面到平台即可'),
              h('span', { style: { display: 'flex', gap: '8px', flex: 'none' } },
                h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy || running, onClick: regenerateAll }, '重新生成发布信息'),
                h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || running || !dirty || content.tags.length < 1, onClick: () => { void saveContent(); } }, busy ? '保存中…' : '保存'),
              ),
            )
          : h('p', { className: 'sv-sc-gate-note' }, running ? '发布信息生成中…' : '生成发布信息后可在此编辑标题、文案、描述、标签与封面。'),
      );
      const lifecycleDrawer = detail && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭面板', onClick: closeDrawer }),
        h('aside', { className: 'sv-drawer sv-drawer-wide sv-pb-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `发布资料 · ${detail.title}` },
          h('div', { className: 'sv-drawer-head sv-sc-drawer-head' },
            h('div', { className: 'sv-sc-drawer-title' },
              h('p', { className: 'sv-pb-section-number' }, '发布工作台 / 资料核对'),
              h('div', { className: 'sv-sc-drawer-titleline' }, h('h3', null, detail.title), h('span', { className: 'sv-sc-state', 'data-state': publishStateTone(packaging ? 'ready' : running ? 'running' : openTask?.status === 'failed' ? 'failed' : 'none') }, packaging ? PUBLISH_STATE_LABEL.ready : running ? PUBLISH_STATE_LABEL.running : openTask?.status === 'failed' ? PUBLISH_STATE_LABEL.failed : PUBLISH_STATE_LABEL.none), dirty ? h('span', { className: 'sv-tag' }, '未保存') : null),
              h('p', { className: 'sv-sc-drawer-meta' }, `${detail.account?.name || '通用'} · 版本 ${detail.revision}${packaging ? ` · 文案 ${charCount(content.copy)} 字 · 标签 ${content.tags.length} 个` : ''}`),
            ),
            h('div', { className: 'sv-sc-drawer-tools' },
              h('button', { type: 'button', className: 'sv-ghost-btn', title: '关闭', 'aria-label': '关闭', onClick: closeDrawer }, '×'),
            ),
          ),
          h('div', { className: 'sv-drawer-scroll' }, drawerBody),
          drawerFoot,
        ),
      );

      const connectionCredential = service?.providers?.[connectionProvider]?.credential;
      const connectionDrawer = connectionOpen && h(React.Fragment, null,
        h('button', { type: 'button', className: 'sv-drawer-backdrop', 'aria-label': '关闭连接配置', onClick: () => setConnectionOpen(false) }),
        h('aside', { className: 'sv-drawer sv-media-config-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '封面生图配置' },
          h('div', { className: 'sv-drawer-head' }, h('div', null, h('h3', { className: 'sv-media-drawer-title' }, '封面生图配置'), h('p', { className: 'sv-media-drawer-copy' }, 'API Key 保存到 DSH 私有凭据库，不会写入发布资料或浏览器存储。保存当前渠道的 API Key 后，生成发布信息时会自动生成封面。')), h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setConnectionOpen(false) }, '关闭')),
          h('div', { className: 'sv-media-drawer-body' },
            h('div', { className: 'sv-media-provider-picker', role: 'group', 'aria-label': '生图渠道' }, ['bailian', 'scitiger', 'custom'].map((id) => h('button', { key: id, type: 'button', className: 'sv-media-provider-choice', 'data-active': connectionProvider === id ? 'true' : 'false', disabled: Boolean(connectionBusy), onClick: () => { setConnectionProvider(id); setApiKey(''); } }, service?.providers?.[id]?.label || (id === 'bailian' ? '百炼 BYOK' : id === 'scitiger' ? 'SciTiger 云端' : '自定义 API')))),
            // 自定义渠道的四个字段。刻意不给「一键测试」：一次测试要真的生一张图，
            // 既花钱又慢，而配置正误在下一张封面上立刻可见。
            connectionProvider === 'custom' ? h('div', { className: 'sv-custom-image' },
              h('label', { className: 'sv-media-field' }, h('span', null, '服务地址'), h('input', { className: 'sv-input', value: customBaseUrl, maxLength: 500, placeholder: 'https://api.example.com/v1', onChange: (event) => setCustomBaseUrl(event.target.value) })),
              h('label', { className: 'sv-media-field' }, h('span', null, '协议'), h('select', { className: 'sv-select', value: customProtocol, onChange: (event) => setCustomProtocol(event.target.value) }, h('option', { value: 'openai' }, 'OpenAI 兼容（同步返回图片）'), h('option', { value: 'async-generic' }, '通用异步（提交后轮询取图）'))),
              h('label', { className: 'sv-media-field' }, h('span', null, '请求路径（留空按协议默认）'), h('input', { className: 'sv-input', value: customPath, maxLength: 300, placeholder: customProtocol === 'openai' ? '/images/generations' : '/api/v1/services/aigc/image-generation/generation', onChange: (event) => setCustomPath(event.target.value) })),
              h('label', { className: 'sv-media-field' }, h('span', null, '认证方式'), h('select', { className: 'sv-select', value: customAuthHeader, onChange: (event) => setCustomAuthHeader(event.target.value) }, h('option', { value: 'bearer' }, 'Bearer（Authorization: Bearer <key>）'), h('option', { value: 'raw' }, '原始值（Authorization: <key>）'))),
              h('label', { className: 'sv-media-field' }, h('span', null, 'API Key（服务不校验时可留空）'), h('input', { className: 'sv-input', type: 'password', value: apiKey, maxLength: 512, autoComplete: 'off', placeholder: connectionCredential?.configured ? '已保存；输入新值可更新' : '可留空', onChange: (event) => setApiKey(event.target.value) })),
              h('p', { className: 'sv-note' }, (service?.customPreset?.note || '自建服务、第三方中转与各类聚合服务都走这条路。') + ' 地址请填到路径之前，不要带查询串或账号密码。')
            ) : h('label', { className: 'sv-media-field' }, h('span', null, connectionProvider === 'bailian' ? '百炼 API Key' : 'SciTiger 云端生图 API Key'), h('input', { className: 'sv-input', type: 'password', value: apiKey, maxLength: 512, autoComplete: 'off', placeholder: connectionCredential?.configured ? '已保存；输入新值可更新' : '输入 API Key', onChange: (event) => setApiKey(event.target.value) })),
            h('label', { className: 'sv-media-field' }, h('span', null, '生图模型（可选）'), h('input', { className: 'sv-input', value: connectionModel, maxLength: 120, placeholder: service?.model || '默认模型', onChange: (event) => setConnectionModel(event.target.value) })),
            // 说清两条路的真实代价，否则用户只能凭猜。2026-10-10 实测：本地生图引擎
            // （Qwen-Image）常驻时占 5.8 GB 内存 + 大部分 16G 卡显存，而云端通道
            // 什么都不占——只是每张封面要花钱。
            h('div', { className: 'sv-media-tradeoff' },
              h('p', null, h('strong', null, '云端生图'), '：不吃本机内存与显存，封面生成不与配音/渲染抢资源；每张按服务商计费。'),
              h('p', null, h('strong', null, '本地生图'), '：不花钱、完全离线，但模型常驻要占约 5.8 GB 内存与大部分显存，因此空闲时会自动释放。')),
            h('p', { className: 'sv-note' }, connectionCredential?.configured ? '已保存连接；密钥不会回显。' : '保存后，生成发布信息时会自动生成横竖封面，并支持按提示词单独重生。'),
          ),
          h('div', { className: 'sv-media-drawer-foot' }, h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(connectionBusy) || !connectionCredential?.configured || !connectionCredential?.writable, onClick: () => { void clearConnection(); } }, connectionBusy === 'clear' ? '正在清除…' : '清除密钥'), h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(connectionBusy), onClick: () => { void saveConnection(); } }, connectionBusy === 'save' ? '正在保存…' : '保存配置')),
        ),
      );

      const readyCount = items.filter((item) => publishStateOf(item) === 'ready').length;
      const pendingCount = items.filter((item) => publishStateOf(item) === 'none' || publishStateOf(item) === 'failed').length;
      const hero = h(HeroMini, { cells: [
        { label: '可发布成片', value: String(items.length), tone: 'brand' },
        { label: '发布资料就绪', value: String(readyCount), tone: 'green' },
        { label: '待生成', value: String(pendingCount), tone: pendingCount ? 'orange' : 'green' },
        { label: '封面生图', value: service?.configured ? IMAGE_PROVIDER_SHORT[service.provider] || service.provider : '待配置', tone: service?.configured ? 'green' : undefined },
      ] });

      return h(PackFrame, { packId, openConversation, title: '发布', accent: 'red', copy: '这里直接陈列上一模块生成的成片，可点开播放。点「发布」查看或生成发布资料：标题、文案、描述、标签与横竖封面。资料齐备即视为可发布，复制到平台即可；封面可按提示词重生，也可自行上传。本页只准备资料，不会向任何平台直发；要自动投递请用「发布与账号管理」能力包。', hero, introActions: h('button', { type: 'button', className: 'sv-media-config-trigger', 'data-attention': service && !service.configured ? 'true' : 'false', onClick: () => setConnectionOpen(true) }, h(React.Fragment, null, h(IconSettingsOutline16, { size: 16, 'aria-hidden': true }), '封面生图', h('span', { className: 'sv-config-state' }, !service ? '读取中' : service.configured ? '已连接' : '待配置'))) },
        h(Notice, { error: error || detailError }),
        shelf,
        lifecycleDrawer,
        connectionDrawer,
        confirmNode,
      );
    }
    async function apply(ctx) {
      connection = ctx.get('connection'); executionStreams = ctx.get('remote');
      // Mount the pack's dynamic contract on the same native mux used by ordinary conversations.
      await executionStreams.$mount({ package: '@scitiger-ai/lwb-spoken-video', descriptors: [{
        id: '@scitiger-ai/lwb-spoken-video#spokenVideo/followExecution', service: 'spokenVideo', namespace: 'spokenVideo', method: 'followExecution', mode: 'stream', invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: '@scitiger-ai/lwb-spoken-video#ExecutionRequest', schema: { parse(value) { if (!value || typeof value.id !== 'string' || typeof value.kind !== 'string' || typeof value.role !== 'string') throw new Error('执行会话请求无效。'); return value; } } } }],
        cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
      }] });
      await ctx.plugin({ name: 'spoken-video-execution-client', inject: ['remote.spokenVideo'], apply(scope) { executionRemote = scope.get('remote.spokenVideo'); scope.effect(() => () => { executionRemote = null; }); } });
      installStyle(); ctx.effect(() => ctx.lwbPackClient.register({ packId: 'spoken-video', pages: { positioning: AccountPositioningPage, signals: SignalsPage, topics: TopicsPage, scripts: ScriptPage, 'audio-captions': AudioCaptionsPageV2, 'video-preview': VideoPreviewPageV2, publish: PublishPageV4, 'content-schedule': ContentSchedulePage, pipeline: PipelineBoardPage } }), 'spoken-video: register capability pages'); }
    // 测试用的纯常量出口。带 hook 的页面没法在 SSR 里跑（useEffect 不执行），
    // 但渠道白名单、音色表这类**决定 UI 形状的常量**可以纯静态断言，
    // 不必为了可测就把整个页面拆出来重写。
    exports.__voice = {
      SV_VOICE_PROVIDER, SV_VOICE_PROVIDERS, SV_VOICE_PROVIDER_LABEL, SV_RETIRED_PROVIDER_LABEL,
      voiceProviderLabel, SV_MIMO_BUILTIN_VOICES, SV_MIMO_VOICE_HINTS, SV_MIMO_VOICE_GROUPS,
      SV_MIMO_DEFAULT_VOICE, svDefaultVoice, SV_VOICE_MODES, SV_SINGING_MODES,
      SV_AUDIO_TAG_GROUPS, SV_AUDIO_TAG_MAX_COUNT, SV_AUDIO_TAG_MAX_LENGTH,
      svAudioTagSlots, svAudioTagNames, svAudioTagError, svInsertAudioTag, SV_VOICE_STYLE_PRESETS,
      SV_DESIGN_VOICE_PRESETS, SV_DESIGN_TEXT_MAX, svVoiceDesignPresetLabel,
      SV_CLONE_EXTENSIONS, SV_CLONE_ACCEPT, svVoiceReferenceError,
    };
    exports.inject = ['connection', 'lwbPackClient', 'remote']; exports.apply = apply; return module.exports;
  },
});
