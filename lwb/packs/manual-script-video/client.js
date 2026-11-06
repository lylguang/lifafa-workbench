window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-manual-script-video',
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
    let publishHandoff = null;
    // Pipeline board → work page: carries the target project so the destination
    // page selects it on mount. Keyed by page id, mirroring openPackMenu ids.
    let pipelineHandoff = null;
    const STAGES = ['signals', 'topic', 'script', 'voiceover', 'subtitles', 'video', 'qc', 'packaging'];
    const LABEL = { signals: '信号', topic: '选题', script: '写稿', voiceover: '配音', subtitles: '字幕', video: '视频制作', qc: '质检', packaging: '发布资料' };
    const DEFAULT_VIDEO_VISUAL_BRIEF = '由 AI 视觉导演根据稿件语义完成主题化 Remotion 画面。';
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
      /* AI 导演环节的细进度：统计徽章 + 可展开的动作时间线。
         与渲染进度条视觉区分：这里没有百分比（事件计数不是完成度），
         用中性的行内徽章而不是进度条，避免把「干了 12 件事」误读成「完成 60%」。 */
      .sv-vprogress-director { display:grid; gap:6px; }
      .sv-vprogress-director-stats { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
      .sv-vprogress-director-stat { padding:2px 9px; border:1px solid var(--lwb-line); border-radius:999px; color:var(--lwb-ink); background:var(--lwb-page); font-size:var(--lwb-text-xs,12px); line-height:1.6; font-variant-numeric:tabular-nums; }
      .sv-vprogress-director-timeline { display:grid; gap:4px; padding:8px 9px; border:1px solid var(--lwb-line); border-radius:7px; background:var(--lwb-page); }
      .sv-vprogress-director-row { display:grid; grid-template-columns:8px minmax(0,1fr) auto; align-items:baseline; gap:7px; font-size:var(--lwb-text-xs,12px); line-height:1.6; }
      .sv-vprogress-director-row i { width:6px; height:6px; border-radius:50%; background:#f59e0b; align-self:center; }
      .sv-vprogress-director-row[data-status="done"] i { background:#16865f; }
      .sv-vprogress-director-row[data-status="error"] i { background:#d85f6d; }
      .sv-vprogress-director-row[data-status="waiting"] i { background:#b0b9c5; }
      .sv-vprogress-director-label { overflow:hidden; color:var(--lwb-ink); text-overflow:ellipsis; white-space:nowrap; }
      .sv-vprogress-director-row time { color:var(--lwb-muted); font-variant-numeric:tabular-nums; }
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
      /*
       * 文本内容框：内容再长也不该把整页撑长。
       *
       * 原来这里写的是 overflow:hidden + JS 逐字把 height 撑到 scrollHeight，
       * 于是粘贴一篇长稿就把页面拉到几千像素，底部的音色、语速、生成按钮全被推到
       * 屏幕外。现在框本身封顶（视口高的 46%，不超过 420px），超出部分在框内滚动。
       * resize 保留为 vertical：用户想看更多时可以往下拉一点，只是拉不过封顶线。
       */
      .sv-audio-script { min-height:136px; max-height:min(420px,46vh); overflow:auto; resize:vertical; color:var(--lwb-ink); background:var(--lwb-page); }
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

      /* ---- 手动稿件 · 写稿页 ----
         两栏工作台：左边是编辑器，右边是稿件库。
         窄屏折成一栏，编辑器在上、稿件库在下——写作时先看到稿子本身。 */
      .sv-ms-grid { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(260px,.9fr); gap:16px; align-items:start; }
      .sv-ms-panel { display:grid; gap:13px; padding:16px; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-surface); }
      .sv-ms-row { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:12px; }
      .sv-ms-field { display:grid; gap:6px; }
      .sv-ms-label-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
      .sv-ms-label { font-size:var(--lwb-text-xs,12px); font-weight:600; color:var(--lwb-muted); letter-spacing:.02em; }
      .sv-ms-hint { font-size:var(--lwb-text-xs,12px); color:var(--lwb-muted); line-height:1.55; }
      .sv-ms-textarea { min-height:360px; line-height:1.9; padding:14px 15px; font-size:var(--lwb-text-base,14px); }
      .sv-ms-meta { display:flex; flex-wrap:wrap; gap:12px; font-size:var(--lwb-text-xs,12px); color:var(--lwb-muted); }
      .sv-ms-meta [data-tone="warn"] { color:var(--sv-orange); }
      .sv-ms-meta [data-tone="ok"] { color:var(--lwb-green); }
      .sv-ms-card { display:grid; gap:10px; padding:14px; border:1px solid var(--lwb-line); border-radius:11px; background:var(--lwb-surface-soft,var(--lwb-surface)); }
      .sv-ms-card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .sv-ms-score { font-size:26px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
      .sv-ms-score[data-tone="warn"] { color:var(--sv-orange); }
      .sv-ms-score[data-tone="ok"] { color:var(--lwb-green); }
      .sv-ms-steps { display:grid; gap:5px; }
      .sv-ms-step { display:flex; align-items:baseline; gap:8px; font-size:var(--lwb-text-sm,13px); }
      .sv-ms-step-dot { width:7px; height:7px; border-radius:50%; background:var(--lwb-line); flex:none; transform:translateY(-1px); }
      .sv-ms-step-dot[data-status="done"] { background:var(--lwb-green); }
      .sv-ms-step-dot[data-status="running"] { background:var(--sv-accent); }
      .sv-ms-step-dot[data-status="error"] { background:var(--sv-red); }
      .sv-ms-bullets { margin:0; padding-left:18px; display:grid; gap:4px; font-size:var(--lwb-text-sm,13px); line-height:1.7; color:var(--lwb-ink); }
      .sv-ms-bullets[data-tone="warn"] { color:var(--sv-orange); }
      .sv-ms-preview { max-height:220px; overflow:auto; padding:12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-page); white-space:pre-wrap; font-size:var(--lwb-text-sm,13px); line-height:1.85; }
      .sv-ms-library { align-content:start; }
      .sv-ms-list { max-height:520px; overflow:auto; padding-right:2px; }
      .sv-ms-item { gap:5px; text-align:left; cursor:pointer; }
      .sv-ms-item[data-active="true"] { border-color:var(--sv-accent); box-shadow:inset 0 0 0 1px var(--sv-accent); }
      .sv-ms-item-title { font-weight:600; line-height:1.45; }
      .sv-ms-item-meta { display:flex; flex-wrap:wrap; gap:8px; font-size:var(--lwb-text-xs,12px); color:var(--lwb-muted); }
      .sv-ms-tiers { display:flex; flex-wrap:wrap; gap:8px; }
      .sv-ms-tier { display:grid; gap:2px; padding:8px 14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); color:var(--lwb-ink); cursor:pointer; text-align:left; }
      .sv-ms-tier span { font-size:var(--lwb-text-xs,12px); color:var(--lwb-muted); }
      .sv-ms-tier[data-active="true"] { border-color:var(--sv-accent); box-shadow:inset 0 0 0 1px var(--sv-accent); }
      @media (max-width:1040px) {
        .sv-ms-grid { grid-template-columns:minmax(0,1fr); }
        .sv-ms-row { grid-template-columns:minmax(0,1fr); }
        .sv-ms-textarea { min-height:260px; }
        .sv-ms-list { max-height:320px; }
      }
    `;
    function installStyle() {
      const existing = document.getElementById('lwb-manual-script-video-style');
      // A pack can be reloaded in place by the workbench. Replace old rules so
      // updated page layouts do not remain pinned to the earlier bundle's CSS.
      if (existing) { existing.setAttribute('data-plugin', '@scitiger-ai/lwb-manual-script-video'); existing.textContent = productCss; return; }
      const style = document.createElement('style');
      style.id = 'lwb-manual-script-video-style';
      style.setAttribute('data-plugin', '@scitiger-ai/lwb-manual-script-video');
      style.textContent = productCss;
      document.head.appendChild(style);
    }
    function actionKey(prefix) { return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    function stageName(project) { return LABEL[project.stage] || project.stage; }
    function stageData(detail, stage) { return detail?.artifacts?.[stage]?.data; }
    function done(detail, stage) { return Boolean(detail?.artifacts?.[stage]); }
    function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未执行'; }
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
      if (packId !== 'manual-script-video' || !connection?.rpc?.call) throw new Error('能力包连接尚未就绪。');
      const response = await connection.rpc.call('/api', `manualScriptVideo/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '口播视频操作未完成。');
      return response.value;
    }
    async function remoteStatic(method, request) {
      if (!connection?.rpc?.call) throw new Error('工作台连接不可用。');
      const response = await connection.rpc.call('/api', `manualScriptVideo/${method}`, { args: request === undefined ? {} : { request } });
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
            subscription = executionStreams.$stream({ name: 'manual-script-video execution', open: (signal) => executionRemote.followExecution(sessionRequest, signal), ended: () => new Error('会话订阅已结束，可重新连接读取记录。'), carrierFailed: () => { if (!stopped) setError('连接中断，正在恢复会话…'); } });
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
    const GENERAL_TAB = '__general__';
    const ARCHIVED_TAB = '__archived__';
    // 渠道分组与「全部稿件」保持同一套判据：写了渠道的归该渠道，没写的归全部，
    // 已归档渠道单独一档而不是被静默丢弃。
    //
    // 本包没有「账号定位」这件事。用户只想把稿子做成片，渠道名是可选的一行字，
    // 用来决定发布资料的口径。所以这里不是账号库，而是从工作区里出现过的渠道名
    // 汇总出来的动态列表。
    function ChannelTabs({ channelLibrary, activeTab, onChange, label, disabled = false, children, tabBadge, tabBadgeLabel = '条' }) {
      const channels = channelLibrary.channels.filter((channel) => channel.status === 'active');
      const tab = (id, name) => {
        const badge = typeof tabBadge?.[id] === 'number' && tabBadge[id] > 0 ? tabBadge[id] : null;
        return h('button', {
          key: id, type: 'button', role: 'tab', className: 'sv-tp-tab',
          'data-active': activeTab === id ? 'true' : 'false', 'aria-selected': activeTab === id,
          disabled, onClick: () => onChange(id),
        }, name, badge != null ? h('span', { className: 'sv-tp-tab-badge', 'aria-label': `${badge} ${tabBadgeLabel}` }, String(badge)) : null);
      };
      return h('div', { className: 'sv-tp-tabs', role: 'tablist', 'aria-label': label },
        channels.map((channel) => tab(channel.id, channel.name)),
        tab(GENERAL_TAB, '全部稿件'), children,
      );
    }
    function scriptDurationLabel(text) {
      const spoken = Array.from(String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')).length;
      const secs = Math.round(spoken / 4.1);
      return `${Math.floor(secs / 60)} 分 ${String(secs % 60).padStart(2, '0')} 秒`;
    }
    function charCount(text) { return Array.from(String(text || '').replace(/\s+/g, '')).length; }
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
     * 让文本框贴着内容长高，但不许长过封顶线。
     *
     * 原实现是 `height = scrollHeight`，内容越多框越高，于是粘贴一篇长稿就把
     * 整页拉到几千像素，底下的音色、语速、生成按钮全被顶到屏幕外。
     *
     * 现在改成：短文照样长到刚好放得下（不浪费空白），长文涨到封顶线就停，
     * 多出来的部分在框内滚动（CSS 里 `.sv-audio-script` 的 max-height 兜底）。
     * 封顶高度从**计算样式**读，不写死数值——CSS 改了这里自动跟着改。
     */
    function svFitTextAreaHeight(node) {
      if (!node) return;
      const computed = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(node) : null;
      const cap = computed ? parseFloat(computed.maxHeight) : Number.NaN;
      const ceiling = Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
      const floor = parseFloat(computed?.minHeight) || 0;
      node.style.height = 'auto';
      // scrollHeight 含内边距，min-height 也含内边距，两个基准要一致，直接取大值。
      const wanted = Math.max(node.scrollHeight, floor);
      node.style.height = `${Math.min(wanted, ceiling)}px`;
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
    const TOAST_LIMIT = 4;
    const TOAST_TTL_MS = 12_000;
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
      const dsh = task.dsh && typeof task.dsh === 'object' ? task.dsh : null;
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
      // 所以原本只有 `render.updatedAt` 能回答「后端还活着吗」——AI 阶段没有心跳，
      // 导演跑十几分钟期间卡死了界面也只会说「还在进行」。
      //
      // 补上的第二个心跳源：DSH 子会话事件流（`dsh.sessions[*].events[*].at`）。
      // 导演/审片的每个模型往返、每次工具调用都会实时落一条带时间戳的事件，
      // 它就是 AI 阶段的心跳。两个心跳源取更晚的那条。
      //
      // 「没有证据说明它活着」和「有证据说明它死了」是两回事。只有后者才配报警。
      const lastDshAtMs = (dsh?.sessions || [])
        .flatMap((session) => Array.isArray(session.events) ? session.events : [])
        .reduce((latest, event) => {
          const at = Date.parse(event?.at || '');
          return Number.isFinite(at) && at > latest ? at : latest;
        }, NaN);
      const heartbeatCandidates = [typeof render?.updatedAt === 'string' ? Date.parse(render.updatedAt) : NaN, lastDshAtMs]
        .filter((value) => Number.isFinite(value));
      const heartbeatMs = heartbeatCandidates.length ? Math.max(...heartbeatCandidates) : NaN;
      const hasHeartbeat = Number.isFinite(heartbeatMs);
      // AI 导演的实时活动摘要：从导演子会话的事件流里取「最近在干什么」和
      // 「已经干了多少」。这些是后端真实记录的事件，不是估算。
      const creatorSession = (dsh?.sessions || []).find((session) => session.role === 'creator');
      const director = creatorSession && Array.isArray(creatorSession.events) && creatorSession.events.length ? (() => {
        const events = creatorSession.events;
        const last = events.at(-1);
        const lastAtMs = Date.parse(last?.at || '');
        // 工具调用的判定与后端投影一致：detail 是工具名的就是 tool/call。
        const toolCalls = events.filter((event) => event.status === 'running' && typeof event.detail === 'string' && event.detail).length;
        const modelTurns = events.filter((event) => event.label === 'DSH 正在请求模型生成').length;
        return {
          label: typeof last?.label === 'string' ? last.label : null,
          detail: typeof last?.detail === 'string' && last.detail ? last.detail : null,
          // 距导演上一次动作过了多久（秒）。导演阶段专属的心跳读数。
          idleSeconds: Number.isFinite(lastAtMs) ? Math.max(0, (now - lastAtMs) / 1000) : null,
          toolCalls,
          modelTurns,
          // 最近几条动作，给时间线用。倒序，最新在上。
          recent: events.slice(-5).reverse().map((event) => ({
            id: event.id, label: event.label, detail: event.detail || null, at: event.at, status: event.status,
          })),
        };
      })() : null;
      return {
        steps,
        phase,
        label: videoPhaseLabel(phase) || mediaStatusLabel(task.status),
        totalSeconds,
        activeSeconds,
        // 距上一次**后端心跳**过了多久（秒）。没有心跳源就是 null——此时界面
        // 只说「已持续多久」，不推断死活。
        silentSeconds: hasHeartbeat ? Math.max(0, (now - heartbeatMs) / 1000) : null,
        director,
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
    /* --------------------------- 手动稿件 · 写稿页 --------------------------- */
    const MS_TIER_OPTIONS = [
      { id: 'short', label: '短篇', hint: '300-999 字' },
      { id: 'medium', label: '中篇', hint: '1000-2499 字' },
      { id: 'long', label: '长篇', hint: '2500 字以上' },
    ];
    const MS_STAGE_LABEL = {
      topic: '已建稿', script: '已成稿', voiceover: '已配音', subtitles: '已字幕', video: '已成片', qc: '已质检', packaging: '可发布',
    };
    function msStageLabel(project) {
      const stages = project.completedStages || [];
      if (stages.includes('packaging')) return MS_STAGE_LABEL.packaging;
      if (stages.includes('video')) return MS_STAGE_LABEL.video;
      if (stages.includes('subtitles')) return MS_STAGE_LABEL.subtitles;
      if (stages.includes('voiceover')) return MS_STAGE_LABEL.voiceover;
      if (stages.includes('script')) return MS_STAGE_LABEL.script;
      return MS_STAGE_LABEL.topic;
    }
    /**
     * 写稿页。
     *
     * 这一页只做一件事：把用户已经写好的稿子变成「可配音」的一篇稿件。
     *
     * 与口播包写稿页的根本区别在于谁掌握事实：那边是 AI 从选题和信号起稿，
     * 事实由 AI 找、由人核；这边的事实由用户带来，AI 最多当个编辑——把话说顺，
     * 不许添词。所以这里的「AI 润色」是可选动作，且它的产出必须交代
     * 「改了什么」和「哪里需要人工确认」，用户看得懂才敢用。
     */
    function ManualScriptPage({ packId, openConversation }) {
      const { projects, refresh, error, setError } = useProjects(packId);
      const [detail, setDetail] = React.useState(null);
      const [title, setTitle] = React.useState('');
      const [channel, setChannel] = React.useState('');
      const [body, setBody] = React.useState('');
      const [tier, setTier] = React.useState('medium');
      const [instructions, setInstructions] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const [quality, setQuality] = React.useState(null);
      const [polish, setPolish] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [advanced, setAdvanced] = React.useState(false);
      const [loadingId, setLoadingId] = React.useState(null);

      const chars = charCount(body);
      const savedBody = detail?.artifacts?.script?.data?.body || '';
      const dirty = Boolean(detail) ? body !== savedBody : Boolean(body.trim());
      const downstream = detail?.artifacts
        ? ['voiceover', 'subtitles', 'video', 'qc', 'packaging'].filter((stage) => detail.artifacts[stage])
        : [];

      const open = React.useCallback(async (projectId) => {
        if (!packId || !projectId) return null;
        setLoadingId(projectId);
        try {
          const next = await remote(packId, 'get', { projectId });
          setDetail(next);
          setTitle(next.title || next.artifacts?.topic?.data?.title || '');
          setChannel(next.account?.name || '');
          setBody(next.artifacts?.script?.data?.body || '');
          setQuality(null);
          setPolish(null);
          return next;
        } catch (cause) {
          setError(cause.message);
          return null;
        } finally {
          setLoadingId(null);
        }
      }, [packId, setError]);

      // 润色在后台跑，前端只负责轮询状态。任务没结束就切走也不影响——结果会落回稿件本身。
      React.useEffect(() => {
        if (!packId || !polish || !['queued', 'running'].includes(polish.status)) return undefined;
        const timer = setInterval(() => {
          void remote(packId, 'polishStatus', { id: polish.id })
            .then((next) => {
              setPolish(next);
              if (next.status === 'succeeded') {
                setNotice('润色完成，已保存为当前稿件版本。');
                void open(next.projectId).then(() => { void refresh(); });
              } else if (next.status === 'failed') {
                setNotice(next.error || '润色失败。');
              }
            })
            .catch((cause) => setError(cause.message));
        }, 1500);
        return () => clearInterval(timer);
      }, [packId, polish, open, refresh, setError]);

      const reset = () => {
        setDetail(null); setTitle(''); setChannel(''); setBody(''); setQuality(null); setPolish(null); setNotice('');
      };

      const save = async () => {
        if (!packId) return;
        if (!body.trim()) { setNotice('稿件正文还是空的。'); return; }
        setBusy('save'); setNotice('');
        try {
          if (!detail) {
            const created = await remote(packId, 'createScript', { title: title.trim(), body, channel: channel.trim() });
            await open(created.id);
            setNotice('稿件已保存。下一步可以去「配音 / 字幕」生成配音。');
          } else {
            if (!dirty) { setBusy(null); setNotice('正文没有改动，无需保存。'); return }
            await remote(packId, 'commit', {
              projectId: detail.id,
              expectedRevision: detail.revision,
              stage: 'script',
              payload: { body },
              idempotencyKey: `manual-save-${detail.id}-${detail.revision + 1}`,
            });
            await open(detail.id);
            setNotice(downstream.length ? '正文已更新。此前生成的配音、字幕与成片已作废，需要重新制作。' : '正文已保存。');
          }
          await refresh();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(null);
        }
      };

      const analyze = async () => {
        if (!packId || !body.trim()) { setNotice('先写点正文再质检。'); return; }
        setBusy('analyze'); setNotice('');
        try {
          const report = await remote(packId, 'analyzeScript', { body, title: title.trim(), tier, projectId: detail?.id });
          setQuality(report);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(null);
        }
      };

      const startPolish = async () => {
        if (!packId) return;
        if (!detail) { setNotice('先保存稿件，再做润色。'); return; }
        if (dirty) { setNotice('正文有未保存的改动，先保存再润色。'); return; }
        setBusy('polish'); setNotice('');
        try {
          const started = await remote(packId, 'startPolish', {
            projectId: detail.id,
            expectedRevision: detail.revision,
            instructions: instructions.trim(),
            channel: channel.trim(),
            tier,
          });
          setPolish({ id: started.id, status: 'queued', steps: [], projectId: detail.id });
          setNotice('润色任务已提交，正在处理…');
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(null);
        }
      };

      const paste = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) { setBody(text); setNotice('已从剪贴板粘贴正文。'); }
          else setNotice('剪贴板是空的。');
        } catch (_) {
          setNotice('浏览器没给剪贴板权限，请手动粘贴。');
        }
      };

      const filtered = projects.filter((project) => {
        if (!query.trim()) return true;
        const needle = query.trim().toLowerCase();
        return (project.title || '').toLowerCase().includes(needle) || (project.account?.name || '').toLowerCase().includes(needle);
      });
      const ready = projects.filter((project) => (project.completedStages || []).includes('script')).length;
      const voiced = projects.filter((project) => (project.completedStages || []).includes('voiceover')).length;
      const cut = projects.filter((project) => (project.completedStages || []).includes('video')).length;
      const channels = new Set(projects.map((project) => project.account?.name).filter(Boolean)).size;

      const hero = h(HeroMini, { cells: [
        { label: '稿件', value: String(projects.length), tone: 'brand' },
        { label: '已成稿', value: String(ready), tone: 'green' },
        { label: '已配音', value: String(voiced), tone: 'orange' },
        { label: '已成片', value: String(cut), tone: 'blue' },
        { label: '渠道', value: String(channels), tone: undefined },
      ] });

      const editor = h('section', { className: 'sv-ms-panel' },
        h('div', { className: 'sv-ms-row' },
          h('label', { className: 'sv-ms-field' },
            h('span', { className: 'sv-ms-label' }, '稿件标题'),
            h('input', {
              className: 'sv-input', value: title, maxLength: 160, placeholder: '留空时 AI 会根据正文起一个标题',
              disabled: Boolean(detail),
              onChange: (event) => setTitle(event.target.value),
            }),
            h('span', { className: 'sv-ms-hint' }, detail ? '标题与渠道在保存后不可改：改标题会让已生成的配音与成片作废。' : '选填。留空时由 AI 根据正文起一个，也可自己填。'),
          ),
          h('label', { className: 'sv-ms-field' },
            h('span', { className: 'sv-ms-label' }, '发布渠道'),
            h('input', {
              className: 'sv-input', value: channel, maxLength: 80, placeholder: '选填，例如「职场观察」',
              disabled: Boolean(detail),
              onChange: (event) => setChannel(event.target.value),
            }),
            h('span', { className: 'sv-ms-hint' }, '只用于发布资料的口径，不做账号定位。'),
          ),
        ),
        h('div', { className: 'sv-ms-field' },
          h('div', { className: 'sv-ms-label-row' },
            h('span', { className: 'sv-ms-label' }, '稿件正文'),
            h('span', { className: 'sv-ms-hint' }, '把你写好的稿子整段粘进来'),
          ),
          h('textarea', {
            className: 'sv-textarea sv-ms-textarea', value: body, maxLength: 30000,
            placeholder: '在这里粘贴正文。第一句别写「今天我们来聊聊」，直接进入内容。',
            onChange: (event) => setBody(event.target.value),
          }),
          h('div', { className: 'sv-ms-meta' },
            h('span', null, `${chars} 字`),
            h('span', null, `预计 ${scriptDurationLabel(body)}`),
            h('span', { 'data-tone': dirty ? 'warn' : 'ok' }, dirty ? (detail ? '有未保存的改动' : '尚未保存') : (detail ? '已保存' : '空稿')),
          ),
        ),
        h('div', { className: 'sv-actions' },
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy === 'save' || !body.trim(), onClick: () => { void save(); } }, busy === 'save' ? '保存中…' : (detail ? '保存正文' : '保存稿件')),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy === 'polish' || !detail || dirty, onClick: () => { void startPolish(); } }, busy === 'polish' ? '提交中…' : 'AI 润色'),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy === 'analyze' || !body.trim(), onClick: () => { void analyze(); } }, busy === 'analyze' ? '检查中…' : '确定性质检'),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: !body.trim(), onClick: () => { void paste(); } }, '粘贴剪贴板'),
          detail ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: reset }, '新建另一篇') : null,
        ),
        notice ? h('p', { className: 'sv-note', role: 'status' }, notice) : null,
        polish ? h('div', { className: 'sv-ms-card' },
          h('div', { className: 'sv-ms-card-head' },
            h('strong', null, 'AI 润色'),
            h('span', { className: 'sv-meta' }, polish.status === 'succeeded' ? '已完成' : polish.status === 'failed' ? '失败' : '进行中'),
          ),
          h('div', { className: 'sv-ms-steps' }, (polish.steps || []).map((step) => h('div', { key: step.id, className: 'sv-ms-step', 'data-status': step.status },
            h('span', { className: 'sv-ms-step-dot', 'data-status': step.status }),
            h('span', null, step.label),
            step.detail ? h('span', { className: 'sv-ms-hint' }, step.detail) : null,
          ))),
          polish.result?.changes?.length ? h('div', null,
            h('span', { className: 'sv-ms-label' }, '改了什么'),
            h('ul', { className: 'sv-ms-bullets' }, polish.result.changes.map((item) => h('li', { key: item }, item))),
          ) : null,
          polish.result?.warnings?.length ? h('div', null,
            h('span', { className: 'sv-ms-label' }, '需要你确认'),
            h('ul', { className: 'sv-ms-bullets', 'data-tone': 'warn' }, polish.result.warnings.map((item) => h('li', { key: item }, item))),
          ) : null,
          polish.result?.script ? h('div', null,
            h('span', { className: 'sv-ms-label' }, '润色稿预览'),
            h('div', { className: 'sv-ms-preview' }, polish.result.script),
          ) : null,
          polish.error ? h('p', { className: 'sv-error', role: 'alert' }, polish.error) : null,
        ) : null,
        quality ? h('div', { className: 'sv-ms-card' },
          h('div', { className: 'sv-ms-card-head' },
            h('strong', null, '确定性质检'),
            h('span', { className: 'sv-ms-score', 'data-tone': quality.rewriteRequired ? 'warn' : 'ok' }, String(quality.qualityScore)),
          ),
          h('div', { className: 'sv-ms-meta' },
            h('span', null, `判定：${quality.verdict}`),
            h('span', null, `篇幅 ${quality.checks.length.status}`),
            h('span', null, `段落 ${quality.checks.structure.paragraphCount}`),
            h('span', null, `平均句长 ${quality.checks.structure.averageParagraphLength} 字`),
          ),
          quality.recommendations?.length ? h('ul', { className: 'sv-ms-bullets' }, quality.recommendations.map((item, index) => h('li', { key: index }, typeof item === 'string' ? item : (item.reason || item.message || JSON.stringify(item))))) : null,
        ) : null,
      );

      const library = h('section', { className: 'sv-ms-panel sv-ms-library' },
        h('div', { className: 'sv-ms-card-head' },
          h('strong', null, '稿件库'),
          h('span', { className: 'sv-meta' }, `${filtered.length} 篇`),
        ),
        h('input', { className: 'sv-input', value: query, maxLength: 80, placeholder: '搜索标题或渠道', onChange: (event) => setQuery(event.target.value) }),
        filtered.length ? h('div', { className: 'sv-list sv-ms-list' }, filtered.map((project) => h('button', {
          key: project.id, type: 'button', className: 'sv-item sv-ms-item',
          'data-active': detail?.id === project.id ? 'true' : 'false',
          disabled: loadingId === project.id,
          onClick: () => { void open(project.id); },
        },
          h('span', { className: 'sv-ms-item-title' }, project.title),
          h('span', { className: 'sv-ms-item-meta' },
            h('span', null, project.account?.name || '未指定渠道'),
            h('span', null, msStageLabel(project)),
            h('span', null, relativeTime(project.updatedAt)),
          ),
        ))) : h('div', { className: 'sv-empty' }, projects.length ? '没有匹配的稿件。' : '还没有稿件。把写好的稿子粘到左边开始吧。'),
      );

      return h(PackFrame, {
        packId, openConversation, title: '写稿', accent: 'violet',
        copy: '把你已经写好的稿子粘进来，存成一篇稿件；可选让 AI 只把话说顺，然后直接去做配音和成片。',
        hero,
        introActions: h(React.Fragment, null,
          h('button', { type: 'button', className: 'lwb-plain-button', onClick: reset }, '新建稿件'),
          h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => { setAdvanced((current) => !current); } }, advanced ? '收起润色设置' : '润色设置'),
        ),
      },
      h(Notice, { error }),
      advanced ? h('section', { className: 'sv-ms-panel' },
        h('span', { className: 'sv-ms-label' }, '篇幅档位'),
        h('div', { className: 'sv-ms-tiers' }, MS_TIER_OPTIONS.map((option) => h('button', {
          key: option.id, type: 'button', className: 'sv-ms-tier',
          'data-active': tier === option.id ? 'true' : 'false',
          onClick: () => setTier(option.id),
        }, h('strong', null, option.label), h('span', null, option.hint)))),
        h('label', { className: 'sv-ms-field' },
          h('span', { className: 'sv-ms-label' }, '额外要求（选填）'),
          h('textarea', {
            className: 'sv-textarea', value: instructions, maxLength: 500, rows: 2,
            placeholder: '例如：第二段口语化一点；开头换个更抓人的说法。',
            onChange: (event) => setInstructions(event.target.value),
          }),
          h('span', { className: 'sv-ms-hint' }, '只影响表达，不会改变你的观点。'),
        ),
      ) : null,
      h('div', { className: 'sv-ms-grid' }, editor, library),
      );
    }
    /**
     * 配音 / 字幕页。
     *
     * 直接从口播包原样搬过来：三种配音模式（预置音色 / 音色设计 / 声音克隆）、
     * 字幕校对、任务列表与同步逻辑一个字没改。本包与口播包的区别只在“稿件从哪来”
     * ——这里是选本包工作区里已有的稿件，落地在同一个生产链路上。
     */
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
      const [channelLibrary, setChannelLibrary] = React.useState({ channels: [], defaultAccountId: null });
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
        void remote(packId, 'listChannels').then((next) => {
          setChannelLibrary(next);
          setActiveTab((current) => current !== GENERAL_TAB && next.channels.some((item) => item.id === current && item.status === 'active') ? current : next.defaultAccountId || GENERAL_TAB);
        }).catch((cause) => setError(cause.message));
      }, [packId, setError]);
      React.useEffect(() => { setTaskPage(0); }, [activeTab, taskQuery, taskFilter]);
      React.useEffect(() => { setPickerPage(0); }, [activeTab, pickerQuery]);
      // 短稿要让框贴住内容，长稿涨到封顶线就停（见 svFitTextAreaHeight）。
      React.useEffect(() => { svFitTextAreaHeight(textRef.current); }, [text]);
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
          h(ChannelTabs, { channelLibrary, activeTab, onChange: setActiveTab, label: '按渠道筛选稿件' }),
          h('div', { className: 'sv-drawer-scroll sv-audio-picker-body' },
            h('input', { className: 'sv-input', value: pickerQuery, maxLength: 160, placeholder: '搜索标题或正文', onChange: (event) => { setPickerQuery(event.target.value); setPickerPage(0); } }),
            picker.loading ? h('p', { className: 'sv-note' }, '正在加载稿件…') : picker.items.length ? h('div', { className: 'sv-list' }, picker.items.map((item) => h('article', { key: item.id, className: 'sv-audio-picker-item' }, h('div', null, h('strong', null, item.title), h('p', null, `${item.scriptChars} 字 · ${item.account?.name || '未指定渠道'} · 更新于 ${relativeTime(item.updatedAt)}`)), h('button', { type: 'button', className: 'lwb-primary-button', disabled: submitting === 'script', onClick: () => { void selectScript(item); } }, submitting === 'script' ? '载入中…' : '选择')))) : h('div', { className: 'sv-empty' }, '没有匹配的稿件。'),
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
        h('label', { className: 'sv-media-field' }, h('span', null, '文本内容'), h('textarea', { ref: textRef, className: 'sv-textarea sv-audio-script', value: text, maxLength: 60000, placeholder: '输入或粘贴需要配音的口播文稿', onChange: (event) => setText(event.target.value), onInput: (event) => svFitTextAreaHeight(event.currentTarget) })),
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
      const accountTabs = h(ChannelTabs, { channelLibrary, activeTab, onChange: setActiveTab, label: '按渠道查看配音任务' });
      return h(PackFrame, { packId, openConversation, title: '配音 / 字幕', accent: 'pink', copy: '选择稿件并生成配音；默认同时生成字幕，也可取消；字幕失败不影响已完成的配音。每条任务保留执行记录并同步项目产物。', hero, introActions: h('button', { type: 'button', className: 'sv-media-config-trigger', 'data-attention': service && !providerEntries.length ? 'true' : 'false', onClick: () => setConnectionOpen(true) }, h(React.Fragment, null, h(IconSettingsOutline16, { size: 16, 'aria-hidden': true }), '连接配置', h('span', { className: 'sv-config-state' }, !service ? '读取中' : providerEntries.length ? '已连接' : '待配置'))) }, h(Notice, { error }), notice ? h('p', { className: 'sv-note', role: 'status' }, notice) : null, accountTabs, h('section', { className: 'sv-split sv-audio-workbench' }, newTaskPanel, taskPanel), scriptPickerDrawer, connectionDrawer, syncPickerDrawer, sourceDrawerNode, subtitleDrawerNode, confirmNode, promptNode);
    }
    /**
     * 视频制作任务的实时进度：步骤条 + 当前阶段用时 + 总耗时 + 阶段明细。
     * 刻意不显示"已完成百分比"——导演与渲染的耗时不可预测，
     * 假精度比没有进度更伤人。只展示后端真实记录的时间事实。
     */
    function VideoTaskProgress({ progress, status, eta }) {
      const [open, setOpen] = React.useState(false);
      const [directorOpen, setDirectorOpen] = React.useState(false);
      if (!progress) return null;
      const running = status === 'running';
      const repair = progress.repair;
      const render = progress.render;
      const director = running && progress.phase === 'directing' ? progress.director : null;
      const summary = [];
      if (progress.activeSeconds != null) summary.push(`${running ? '当前阶段已用' : '本阶段用时'} ${formatElapsed(progress.activeSeconds)}`);
      if (progress.totalSeconds != null) summary.push(`总计 ${formatElapsed(progress.totalSeconds)}`);
      // 渲染阶段用 Remotion 自报的剩余时间；其它阶段才退回历史参考值。
      if (running && render?.remainingSeconds != null) summary.push(`预计剩余 ${formatElapsed(render.remainingSeconds)}`);
      else if (running && eta?.range) summary.push(`参考历史 ${eta.range}`);
      const doneCount = progress.steps.filter((step) => step.status === 'done').length;
      // 当前阶段的人话说明：告诉用户「这一步在干嘛」，而不只是阶段名。
      // 导演环节有实时动作时用人话模板说「正在做哪件事」，没有动作时退回静态提示。
      const activeHint = running
        ? (director?.label
          ? (director.detail ? `AI 导演：${director.label}（${director.detail}）` : `AI 导演：${director.label}`)
          : VIDEO_PHASE_HINT[progress.phase] || null)
        : null;
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
        // AI 导演环节的细进度：模型往返与工具调用计数 + 可展开的最近动作时间线。
        // 这些是后端真实记录的 DSH 会话事件（1.8 秒轮询刷新），不是估算的假百分比。
        director ? h('div', { className: 'sv-vprogress-director' },
          h('div', { className: 'sv-vprogress-director-stats' },
            h('span', { className: 'sv-vprogress-director-stat' }, `模型往返 ${director.modelTurns}`),
            h('span', { className: 'sv-vprogress-director-stat' }, `工具调用 ${director.toolCalls}`),
            director.idleSeconds != null ? h('span', { className: 'sv-vprogress-director-stat' }, `上次动作 ${formatElapsed(director.idleSeconds)}前`) : null,
            h('button', { type: 'button', className: 'sv-vprogress-toggle', 'aria-expanded': directorOpen ? 'true' : 'false', onClick: () => setDirectorOpen((value) => !value) }, directorOpen ? '收起动作' : '最近动作'),
          ),
          directorOpen ? h('div', { className: 'sv-vprogress-director-timeline' }, director.recent.map((event) => h('div', { key: event.id, className: 'sv-vprogress-director-row', 'data-status': event.status },
            h('i', { 'aria-hidden': 'true' }),
            h('span', { className: 'sv-vprogress-director-label' }, event.detail ? `${event.label} · ${event.detail}` : event.label),
            h('time', null, formatTime(event.at)),
          ))) : null,
        ) : null,
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
      const [channelLibrary, setChannelLibrary] = React.useState({ channels: [], defaultAccountId: null });
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
        void remote(packId, 'listChannels').then((next) => {
          setChannelLibrary(next);
          setActiveTab((current) => current !== GENERAL_TAB && next.channels.some((item) => item.id === current && item.status === 'active') ? current : next.defaultAccountId || GENERAL_TAB);
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
      const accountTabs = h(ChannelTabs, { channelLibrary, activeTab, onChange: setActiveTab, label: '按渠道筛选视频稿件与任务' });
      const sourceCard = (project) => h('button', { key: project.id, type: 'button', className: 'sv-video-source-item', 'data-active': selectedId === project.id ? 'true' : 'false', onClick: () => setSelectedId(project.id) }, h('span', { className: 'sv-item-head' }, h('strong', { className: 'sv-item-title' }, project.title), h('span', { className: 'sv-stage' }, project.completedStages.includes('subtitles') ? '配音、字幕已完成' : '配音已完成')), h('span', { className: 'sv-meta' }, `${relativeTime(project.updatedAt)} · ${project.account?.name || '未指定渠道'}`));
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
      const [channelLibrary, setChannelLibrary] = React.useState({ channels: [], defaultAccountId: null });
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
        void Promise.all([remote(packId, 'listChannels'), loadItems()])
          .then(([accounts, shelfItems]) => {
            setChannelLibrary(accounts);
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
            // 默认落在成片最多的那个 Tab。原逻辑退回「通用」，而绝大多数成片都带渠道
            // 归属，「全部」里往往只有零星几条——用户第一眼就以为成片不见了
            // （2026-10-08 反馈：刚跑完的成片在发布页找不到）。有作品最多的渠道优先，
            // 全都为空时才回到默认渠道 / 全部。
            const activeIds = new Set(accounts.channels.filter((item) => item.status === 'active').map((item) => item.id));
            const byTab = shelfItems.reduce((tally, row) => {
              const key = !row.account ? GENERAL_TAB : activeIds.has(row.account.id) ? row.account.id : ARCHIVED_TAB;
              tally[key] = (tally[key] || 0) + 1;
              return tally;
            }, {});
            const richest = Object.keys(byTab)
              .filter((key) => key !== ARCHIVED_TAB)
              .sort((left, right) => byTab[right] - byTab[left])[0] || null;
            setActiveTab((current) => {
              if (current !== GENERAL_TAB && accounts.channels.some((item) => item.id === current && item.status === 'active')) return current;
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

      const activeAccounts = channelLibrary.channels.filter((item) => item.status === 'active');
      const activeIds = new Set(activeAccounts.map((item) => item.id));
      const tabOf = (item) => (!item.account ? GENERAL_TAB : activeIds.has(item.account.id) ? item.account.id : ARCHIVED_TAB);
      const stateRank = { ready: 0, none: 1, failed: 2, running: 3 };
      const sortItems = (list) => [...list].sort((a, b) => (stateRank[publishStateOf(a)] - stateRank[publishStateOf(b)]) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const tabItems = sortItems(items.filter((item) => tabOf(item) === activeTab));
      const archivedItems = sortItems(items.filter((item) => tabOf(item) === ARCHIVED_TAB));
      const tabName = activeTab === GENERAL_TAB ? '全部稿件' : (activeAccounts.find((item) => item.id === activeTab)?.name || '—');
      // 每个 Tab 上的成片数量：默认落在「全部稿件」Tab 时，真正有作品的渠道是隐形的，
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
        h('p', { className: 'sv-pb-card-meta' }, [item.account?.name || '未指定渠道', videoSpec(item)].filter(Boolean).join(' · ')),
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

      const tabs = h(ChannelTabs, { channelLibrary, activeTab, onChange: setActiveTab, label: '按渠道筛选成片', tabBadge: countByTab, tabBadgeLabel: '条成片' },
        archivedItems.length ? h('span', { className: 'sv-sc-archived', title: '已归档渠道的成片仅在列表尾部展示' }, `已归档 ${archivedItems.length}`) : null,
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
        ) : h('div', { className: items.length ? 'sv-empty' : 'sv-empty-cta' }, items.length ? '当前渠道暂无成片，可切换其他渠道。' : h(React.Fragment, null, h('p', null, '还没有通过质检的成片。'), h('p', null, '先到「视频 / 预览」页完成视频制作与质检，质检通过的成片会自动出现在这里。'))),
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
              h('p', { className: 'sv-sc-drawer-meta' }, `${detail.account?.name || '未指定渠道'} · 版本 ${detail.revision}${packaging ? ` · 文案 ${charCount(content.copy)} 字 · 标签 ${content.tags.length} 个` : ''}`),
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
      await executionStreams.$mount({ package: '@scitiger-ai/lwb-manual-script-video', descriptors: [{
        id: '@scitiger-ai/lwb-manual-script-video#manualScriptVideo/followExecution', service: 'manualScriptVideo', namespace: 'manualScriptVideo', method: 'followExecution', mode: 'stream', invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: '@scitiger-ai/lwb-manual-script-video#ExecutionRequest', schema: { parse(value) { if (!value || typeof value.id !== 'string' || typeof value.kind !== 'string' || typeof value.role !== 'string') throw new Error('执行会话请求无效。'); return value; } } } }],
        cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
      }] });
      await ctx.plugin({ name: 'manual-script-video-execution-client', inject: ['remote.manualScriptVideo'], apply(scope) { executionRemote = scope.get('remote.manualScriptVideo'); scope.effect(() => () => { executionRemote = null; }); } });
      installStyle(); ctx.effect(() => ctx.lwbPackClient.register({ packId: 'manual-script-video', pages: { scripts: ManualScriptPage, 'audio-captions': AudioCaptionsPageV2, 'video-preview': VideoPreviewPageV2, publish: PublishPageV4 } }), 'manual-script-video: register capability pages'); }
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
