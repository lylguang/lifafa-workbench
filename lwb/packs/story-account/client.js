window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-story-account',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    /**
     * 情感故事号能力包的浏览器端。
     *
     * 设计取向与通用口播包相反：那个包的界面是「一个人坐在电脑前调一条片子」，
     * 所以每页都有大量抽屉与状态；这个包的界面是「一个人每天交一条作业」，
     * 所以只有三段：今天写什么、稿子过不过、片子能不能发。
     *
     * 页面上所有需要用户做判断的地方都直接给出**依据**（哪一条硬拦、哪一句像
     * AI、哪个时间点被判有问题），而不是给一个分数让人猜。
     */

    const PACK_ID = 'story-account';
    const NS = 'storyAccount';

    let connection = null;

    async function remote(method, request) {
      if (!connection?.rpc?.call) throw new Error('工作台连接不可用。');
      const response = await connection.rpc.call('/api', `${NS}/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '情感故事号操作未完成。');
      return response.value;
    }

    /* --------------------------------- 样式 --------------------------------- */

    const STYLE_ID = 'sa-style';
    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .sa-page { display: flex; min-width: 0; flex-direction: column; gap: var(--lwb-space-4); padding: 4px 2px 40px; }
        .sa-top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--lwb-space-4); }
        .sa-top h1 { margin: 0 0 6px; font-size: var(--lwb-text-title, 24px); line-height: 1.25; letter-spacing: .01em; }
        .sa-top p { margin: 0; max-width: 62ch; color: var(--lwb-muted); font-size: var(--lwb-text-base, 14px); line-height: 1.65; }
        .sa-kicker { display: flex; align-items: center; gap: var(--lwb-space-2); margin: 0 0 var(--lwb-space-2); color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); font-weight: 700; letter-spacing: .08em; }
        .sa-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; display: inline-block; }
        .sa-error { margin: 0; padding: var(--lwb-space-2) var(--lwb-space-3); border: 1px solid var(--lwb-danger-line); border-radius: var(--lwb-radius-md); background: var(--lwb-danger-soft); color: var(--lwb-danger); font-size: var(--lwb-text-sm, 13px); line-height: 1.6; }
        .sa-grid { display: grid; gap: var(--lwb-space-4); }
        .sa-grid.two { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
        .sa-card { border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-lg); padding: var(--lwb-space-4) var(--lwb-space-5); background: var(--lwb-surface); display: flex; flex-direction: column; gap: var(--lwb-space-3); }
        .sa-card h3 { margin: 0; font-size: var(--lwb-text-lg, 16px); line-height: 1.45; }
        .sa-card p { margin: 0; font-size: var(--lwb-text-base, 14px); line-height: 1.65; color: var(--lwb-muted); }
        .sa-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--lwb-space-3); flex-wrap: wrap; }
        .sa-card-head h3 { margin: 0; font-size: var(--lwb-text-section, 18px); line-height: 1.4; }
        .sa-field { display: flex; flex-direction: column; gap: 6px; }
        .sa-field label { color: var(--lwb-muted); font-size: var(--lwb-text-sm, 13px); font-weight: 700; }
        .sa-field input, .sa-field textarea, .sa-field select {
          min-height: var(--lwb-control-h, 36px);
          border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-sm, 6px); padding: var(--lwb-space-2) 11px;
          font: inherit; font-size: var(--lwb-text-base, 14px); line-height: 1.6; background: var(--lwb-surface); color: var(--lwb-ink);
          transition: border-color .15s ease, box-shadow .15s ease;
        }
        .sa-field input:hover, .sa-field textarea:hover, .sa-field select:hover { border-color: #b6c6d6; }
        .sa-field input:focus, .sa-field textarea:focus, .sa-field select:focus { border-color: var(--lwb-blue); outline: 0; box-shadow: var(--lwb-focus-ring); }
        .sa-field textarea { min-height: 96px; resize: vertical; }
        .sa-row { display: flex; gap: var(--lwb-space-3); flex-wrap: wrap; align-items: center; }
        .sa-actions { display: flex; gap: var(--lwb-space-2); flex-wrap: wrap; }
        .sa-primary, .sa-plain {
          min-height: var(--lwb-control-h, 36px); padding: 0 var(--lwb-space-4); border-radius: var(--lwb-radius-sm, 6px);
          font: inherit; font-size: var(--lwb-text-base, 14px); font-weight: 600; cursor: pointer;
          transition: border-color .15s ease, background .15s ease, color .15s ease, box-shadow .15s ease;
        }
        .sa-primary { border: 1px solid var(--lwb-blue); background: var(--lwb-blue); color: #fff; }
        .sa-primary:hover:not(:disabled) { border-color: #1f57bd; background: #1f57bd; }
        .sa-plain { border: 1px solid var(--lwb-line); background: var(--lwb-surface); color: var(--lwb-ink); }
        .sa-plain:hover:not(:disabled) { border-color: #b6c6d6; color: #2c3d4d; background: #f4f8fc; }
        .sa-primary:disabled, .sa-plain:disabled { opacity: .55; cursor: default; }
        .sa-primary:focus-visible, .sa-plain:focus-visible, .sa-chip:focus-visible, .sa-step:focus-visible { outline: 0; box-shadow: var(--lwb-focus-ring); border-color: var(--lwb-blue); }
        .sa-chip { display: inline-flex; align-items: center; gap: 6px; padding: var(--lwb-space-1) var(--lwb-space-2); border-radius: 999px; background: var(--lwb-page); color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); font-weight: 700; }
        .sa-chip[data-tone="good"] { background: var(--lwb-green-soft); color: var(--lwb-green); }
        .sa-chip[data-tone="bad"] { background: var(--lwb-danger-soft); color: var(--lwb-danger); }
        .sa-chip[data-tone="warn"] { background: var(--lwb-warm-soft); color: var(--lwb-warm); }
        .sa-list { display: flex; flex-direction: column; gap: var(--lwb-space-2); margin: 0; padding: 0; list-style: none; }
        .sa-item { border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-lg); padding: var(--lwb-space-3) var(--lwb-space-4); display: flex; flex-direction: column; gap: 7px; background: var(--lwb-surface); }
        .sa-item-head { display: flex; justify-content: space-between; gap: var(--lwb-space-3); align-items: baseline; flex-wrap: wrap; }
        .sa-item-head strong { font-size: var(--lwb-text-md, 15px); }
        /* 勾选项：checkbox + 标题 + 标签同行靠左。
           sa-item-head 是 space-between，塞进 checkbox 会把勾选框和标题推到两端、
           标签贴右边，看着像三组无关的东西。这里单独给一条靠左的规则，
           让「勾这个」读起来是一件事。 */
        .sa-pick-head { display: flex; gap: var(--lwb-space-2); align-items: center; flex-wrap: wrap; cursor: pointer; }
        .sa-pick-head input[type="checkbox"] { width: 15px; height: 15px; margin: 0; flex: none; cursor: pointer; }
        .sa-pick-head input[type="checkbox"]:focus-visible { outline: 2px solid var(--lwb-blue); outline-offset: 2px; }
        .sa-pick-head strong { font-size: var(--lwb-text-md, 15px); }
        /* 批量操作条：全选、清空、只选可用和「入库」在同一行，
           全选不该藏在列表末尾——那是上一版最被抱怨的地方。 */
        .sa-toolbar { display: flex; gap: var(--lwb-space-3); flex-wrap: wrap; align-items: center; padding: var(--lwb-space-2) var(--lwb-space-3); border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-md); background: var(--lwb-page); }
        .sa-toolbar .sa-actions { margin-left: auto; }
        .sa-check { display: inline-flex; align-items: center; gap: 7px; font-size: var(--lwb-text-sm, 13px); font-weight: 600; cursor: pointer; }
        .sa-check input[type="checkbox"] { width: 15px; height: 15px; margin: 0; cursor: pointer; }
        .sa-check input[type="checkbox"]:focus-visible { outline: 2px solid var(--lwb-blue); outline-offset: 2px; }
        .sa-meta { color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); }
        .sa-quote { margin: 0; padding: var(--lwb-space-2) var(--lwb-space-3); border-left: 3px solid var(--lwb-line); border-radius: 0 var(--lwb-radius-sm, 6px) var(--lwb-radius-sm, 6px) 0; background: var(--lwb-page); font-size: var(--lwb-text-sm, 13px); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
        .sa-steps { display: flex; flex-direction: column; gap: 6px; font-size: var(--lwb-text-sm, 13px); }
        .sa-step { display: flex; gap: var(--lwb-space-2); align-items: baseline; }
        .sa-step[data-status="done"] { color: var(--lwb-green); font-weight: 700; }
        .sa-step[data-status="failed"] { color: var(--lwb-danger); font-weight: 700; }
        .sa-step[data-status="running"] { font-weight: 700; color: var(--lwb-ink); }
        /* 特异性要压过 .sa-card p：否则硬拦项在卡片里会被染成 muted 灰，
           「这是硬拦」的颜色语义就丢了。 */
        .sa-card .sa-blocker, .sa-blocker { margin: 0; padding: var(--lwb-space-2) var(--lwb-space-3); border: 1px solid var(--lwb-danger-line); border-radius: var(--lwb-radius-md); background: var(--lwb-danger-soft); color: var(--lwb-danger); font-size: var(--lwb-text-sm, 13px); line-height: 1.7; }
        .sa-hint { margin: 0; color: var(--lwb-muted); font-size: var(--lwb-text-sm, 13px); line-height: 1.7; overflow-wrap: anywhere; }
        .sa-empty { padding: var(--lwb-space-5); text-align: center; border: 1px dashed var(--lwb-line); border-radius: var(--lwb-radius-lg); color: var(--lwb-muted); font-size: var(--lwb-text-base, 14px); line-height: 1.7; }
        .sa-flow { display: flex; gap: var(--lwb-space-2); flex-wrap: wrap; }
        .sa-flow-step { flex: 1 1 150px; border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-lg); padding: var(--lwb-space-3) var(--lwb-space-4); background: var(--lwb-surface); transition: border-color .15s ease, background .15s ease; }
        .sa-flow-step[data-done="true"] { border-color: #b6dfc9; background: var(--lwb-green-soft); }
        .sa-flow-step strong { display: block; margin-bottom: var(--lwb-space-1); font-size: var(--lwb-text-sm, 13px); }
        .sa-flow-step span { color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); line-height: 1.6; }
        /* 声音方案卡片：一张卡 = 一份完整配方，试听按钮就地给反馈。 */
        .sa-recipe-grid { display: grid; flex-wrap: wrap; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--lwb-space-2); }
        .sa-recipe { display: grid; gap: 6px; padding: 10px 11px; border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-md); background: var(--lwb-surface); transition: border-color .15s ease, box-shadow .15s ease; }
        .sa-recipe[data-on="true"] { border-color: var(--lwb-blue); background: var(--lwb-blue-soft); box-shadow: 0 0 0 2px var(--lwb-blue-soft); }
        .sa-recipe-main { display: grid; gap: 3px; padding: 0; border: 0; background: transparent; font: inherit; text-align: left; cursor: pointer; }
        .sa-recipe-main strong { color: var(--lwb-ink); font-size: var(--lwb-text-base, 14px); }
        .sa-recipe-main span { color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); }
        .sa-recipe-main:focus-visible { outline: 0; box-shadow: var(--lwb-focus-ring); border-radius: var(--lwb-radius-sm, 6px); }
        .sa-recipe-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
        .sa-recipe-voice { overflow: hidden; min-width: 0; color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); text-overflow: ellipsis; white-space: nowrap; }
        .sa-recipe-preview { flex: none; min-height: 26px; padding: 0 9px; border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-sm, 6px); color: var(--lwb-ink); background: var(--lwb-surface); font: inherit; font-size: var(--lwb-text-xs, 12px); font-weight: 700; cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease; }
        .sa-recipe-preview:hover:not(:disabled) { border-color: var(--lwb-blue); color: var(--lwb-blue); background: var(--lwb-blue-soft); }
        .sa-recipe-preview:disabled { opacity: .55; cursor: default; }
        .sa-recipe-preview:focus-visible { outline: 0; border-color: var(--lwb-blue); box-shadow: var(--lwb-focus-ring); }
        .sa-recipe audio { width: 100%; height: 32px; }
        /* 账号矩阵：列表 + 表单同页，默认账号要一眼认出来——下游所有阶段引用它。 */
        .sa-acct-list { display: grid; gap: var(--lwb-space-2); }
        .sa-acct { display: grid; gap: 7px; padding: 11px 12px; border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-md); background: var(--lwb-surface); transition: border-color .15s ease, background .15s ease; }
        .sa-acct[data-on="true"] { border-color: var(--lwb-blue); background: var(--lwb-blue-soft); }
        .sa-acct-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--lwb-space-2); }
        .sa-acct-head strong { font-size: var(--lwb-text-base, 14px); }
        .sa-acct-meta { color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); line-height: 1.6; overflow-wrap: anywhere; }
        .sa-acct-acts { display: flex; flex-wrap: wrap; gap: 6px; }
        /* 生成记录：一行一轮，状态、质量分与失败原因都在行内，不用点开才知道怎么了。 */
        .sa-gen-list { display: grid; gap: var(--lwb-space-2); }
        .sa-gen { display: grid; gap: 7px; padding: 11px 12px; border: 1px solid var(--lwb-line); border-radius: var(--lwb-radius-md); background: var(--lwb-surface); }
        .sa-gen-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--lwb-space-2); }
        .sa-gen-title { min-width: 0; font-size: var(--lwb-text-base, 14px); font-weight: 700; }
        .sa-gen-meta { color: var(--lwb-muted); font-size: var(--lwb-text-xs, 12px); line-height: 1.6; overflow-wrap: anywhere; }
        /* 危险按钮：删除这类不可逆操作用语义 danger 色，不与主操作抢蓝。 */
        .sa-danger { min-height: var(--lwb-control-h, 36px); padding: 0 var(--lwb-space-4, 16px); border: 1px solid var(--lwb-danger-line); border-radius: var(--lwb-radius-sm, 6px); color: var(--lwb-danger); background: var(--lwb-danger-soft); font: inherit; font-size: var(--lwb-text-base, 14px); font-weight: 700; cursor: pointer; transition: border-color .15s ease, background .15s ease, box-shadow .15s ease; }
        .sa-danger:hover:not(:disabled) { border-color: #c98d8d; color: #8f3330; background: #fdeceb; }
        .sa-danger:disabled { opacity: .55; cursor: default; }
        .sa-danger:focus-visible { outline: 0; border-color: var(--lwb-danger); box-shadow: var(--lwb-focus-ring); }
        .sa-danger-sm { min-height: var(--lwb-control-h-sm, 32px); padding: 0 var(--lwb-space-3, 12px); font-size: var(--lwb-text-sm, 13px); }
        /* 人工放行审计：放行记录必须显式可见，不能悄悄放行。 */
        .sa-override { display: grid; gap: 5px; margin: 0; padding: 10px 12px; border: 1px solid #ecd39b; border-radius: var(--lwb-radius-md); background: var(--lwb-warm-soft); color: var(--lwb-warm); font-size: var(--lwb-text-sm, 13px); line-height: 1.6; }
        .sa-override strong { color: var(--lwb-ink); font-size: var(--lwb-text-base, 14px); }
        .sa-override-reason { margin: 0; color: var(--lwb-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
        body[data-ds-dark-theme] .sa-top p, body[data-ds-dark-theme] .sa-card p, body[data-ds-dark-theme] .sa-kicker, body[data-ds-dark-theme] .sa-hint, body[data-ds-dark-theme] .sa-meta, body[data-ds-dark-theme] .sa-flow-step span, body[data-ds-dark-theme] .sa-empty { color: var(--lwb-muted); }
        /* 深色下 .sa-card p 的特异性高于 .sa-blocker，会把硬拦项染回 muted；
           这里再把danger色压回来。 */
        body[data-ds-dark-theme] .sa-card .sa-blocker, body[data-ds-dark-theme] .sa-blocker { color: var(--lwb-danger); }
        body[data-ds-dark-theme] .sa-field input:hover, body[data-ds-dark-theme] .sa-field textarea:hover, body[data-ds-dark-theme] .sa-field select:hover { border-color: #4d6478; }
        body[data-ds-dark-theme] .sa-primary:hover:not(:disabled) { border-color: #9cc4ff; background: #9cc4ff; color: #10233a; }
        body[data-ds-dark-theme] .sa-plain:hover:not(:disabled) { border-color: #4d6478; color: var(--lwb-ink); background: #2b3d4d; }
        body[data-ds-dark-theme] .sa-plain, body[data-ds-dark-theme] .sa-flow-step { background: #23313f; }
        body[data-ds-dark-theme] .sa-toolbar, body[data-ds-dark-theme] .sa-quote, body[data-ds-dark-theme] .sa-chip { background: #202d3a; }
        body[data-ds-dark-theme] .sa-flow-step[data-done="true"] { border-color: #2b6a4f; background: var(--lwb-green-soft); }
        body[data-ds-dark-theme] .sa-danger:hover:not(:disabled) { border-color: #a35b5b; color: #ffd0d0; background: #542f31; }
        body[data-ds-dark-theme] .sa-recipe-preview:hover:not(:disabled) { background: #1d344a; }
        @media (max-width: 390px) {
          .sa-page { padding: 4px 0 32px; }
          .sa-card { padding: var(--lwb-space-3) var(--lwb-space-4); border-radius: var(--lwb-radius-md); }
          .sa-grid.two { grid-template-columns: 1fr; }
          .sa-flow-step { flex: 1 1 100%; }
          .sa-recipe-grid { grid-template-columns: 1fr; }
          .sa-top h1 { font-size: var(--lwb-text-heading, 20px); }
          .sa-toolbar .sa-actions { margin-left: 0; width: 100%; }
        }
      `;
      document.head.appendChild(style);
    }

    /* -------------------------------- 小组件 -------------------------------- */

    function ErrorLine({ error }) { return error ? h('p', { className: 'sa-error', role: 'alert' }, error) : null; }

    /**
     * 状态块：原因 + 下一步。tone 走共享语义色（info / success / warning / danger），
     * danger 只留给真的失败——数量多、等确认都不是 danger。
     * next 是「下一步做什么」的短句数组，直接渲染成 → 列表。
     */
    function Callout({ tone = 'info', title, children, next }) {
      return h('div', { className: 'lwb-callout', 'data-tone': tone, role: tone === 'danger' ? 'alert' : undefined },
        title ? h('p', { className: 'lwb-callout-title' }, title) : null,
        children ? h('p', null, children) : null,
        next?.length ? h('ul', { className: 'lwb-callout-next' }, next.map((item, index) => h('li', { key: index }, item))) : null,
      );
    }

    /** 实时计时：任务跑着就每秒走，跑完定格在最终用时。 */
    function useElapsed(startedAt, finishedAt) {
      const start = React.useMemo(() => (typeof startedAt === 'string' ? Date.parse(startedAt) : Number(startedAt)) || null, [startedAt]);
      const end = React.useMemo(() => (finishedAt ? (typeof finishedAt === 'string' ? Date.parse(finishedAt) : Number(finishedAt)) || null : null), [finishedAt]);
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!start || end) return undefined;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, [start, end]);
      if (!start) return null;
      return formatElapsed(Math.max(0, (end || now) - start));
    }

    function formatElapsed(ms) {
      const total = Math.round(ms / 1000);
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes >= 1 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
    }

    function Top({ title, kicker, copy, actions }) {
      return h('header', { className: 'sa-top' },
        h('div', null,
          kicker ? h('p', { className: 'sa-kicker' }, h('span', { className: 'sa-dot', style: { background: kicker.tone || '#8b5cf6' } }), kicker.label) : null,
          h('h1', null, title),
          copy ? h('p', null, copy) : null,
        ),
        actions ? h('div', { className: 'sa-actions' }, actions) : null,
      );
    }

    function Field({ label, children }) {
      return h('div', { className: 'sa-field' }, h('label', null, label), children);
    }

    function Chip({ tone, children }) { return h('span', { className: 'sa-chip', 'data-tone': tone }, children); }

    /**
     * 步骤条 + 实时计时。running 时顶部一颗呼吸点和走动的计时，让「还在跑」
     * 和「卡住了」有区别；failed 的步骤标红并保留 detail 里的原因。
     */
    function Steps({ steps, startedAt, finishedAt }) {
      if (!steps?.length) return null;
      // hooks 必须每次渲染都跑，所以把带计时的正文拆成子组件，空步骤时整体早退。
      return h(StepsBody, { steps, startedAt, finishedAt });
    }

    function StepsBody({ steps, startedAt, finishedAt }) {
      const running = steps.some((step) => step.status === 'running');
      const failed = steps.find((step) => step.status === 'failed');
      const elapsed = useElapsed(startedAt, finishedAt);
      const doneCount = steps.filter((step) => step.status === 'done').length;
      return h('div', { className: 'sa-steps' },
        running || elapsed ? h('p', { className: 'lwb-live' },
          running ? h('span', { className: 'lwb-live-dot' }) : null,
          h('span', { className: 'lwb-timer' }, running ? `进行中 ${elapsed || ''}`.trim() : `用时 ${elapsed}`),
          h('span', { className: 'sa-meta' }, `${doneCount}/${steps.length} 步`),
        ) : null,
        failed ? h('p', { className: 'sa-step', 'data-status': 'failed' }, `卡在「${failed.label}」：${failed.detail || '未说明原因'}`) : null,
        steps.map((step) =>
          h('div', { key: step.id, className: 'sa-step', 'data-status': step.status },
            h('span', null, step.status === 'done' ? '✔' : step.status === 'failed' ? '✕' : step.status === 'running' ? '…' : '·'),
            h('span', null, step.label),
            step.detail ? h('span', { className: 'sa-meta' }, ` ${step.detail}`) : null,
            step.status === 'running' && elapsed ? h('span', { className: 'lwb-timer' }, elapsed) : null,
          )));
    }

    /** 空态：说清缺什么、去哪儿配、配完会怎样；有主操作就一并给出。 */
    function Empty({ title, children, actions }) {
      return h('div', { className: 'sa-empty' },
        title ? h('p', { className: 'sa-empty-title', style: { color: 'var(--lwb-ink)', fontWeight: 700, fontSize: 'var(--lwb-text-md,15px)' } }, title) : null,
        children ? h('p', null, children) : null,
        actions ? h('div', { className: 'sa-actions', style: { justifyContent: 'center', marginTop: 'var(--lwb-space-2)' } }, actions) : null,
      );
    }

    /** 通用异步动作钩子：统一处理 busy 与错误，避免每页各写一份。 */
    function useAction() {
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const run = React.useCallback(async (key, task) => {
        setBusy(key);
        setError(null);
        try {
          return await task();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          return undefined;
        } finally {
          setBusy(null);
        }
      }, []);
      return { busy, error, setError, run };
    }

    /**
     * 二次确认弹窗：删除、人工放行这类不可逆或需要担责的操作都走这里。
     * 复用宿主 lwb 对话框视觉体系（modal 遮罩 / 卡片 / 三类按钮）。
     * 失败时把服务端真实原因留在弹窗里——删除失败只说「删不掉」等于没说。
     */
    function useConfirm() {
      const [meta, setMeta] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        if (!meta) return undefined;
        const onKey = (event) => { if (event.key === 'Escape' && !busy) setMeta(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [meta, busy]);
      const ask = React.useCallback((options) => { setBusy(false); setError(null); setMeta(options); }, []);
      const close = React.useCallback(() => { if (!busy) setMeta(null); }, [busy]);
      const confirm = React.useCallback(async () => {
        if (!meta?.onConfirm) return;
        setBusy(true);
        setError(null);
        try {
          await meta.onConfirm();
          setMeta(null);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      }, [meta]);
      const node = meta ? h('div', { className: 'lwb-modal-backdrop', onClick: close },
        h('div', { className: 'lwb-card lwb-pack-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': meta.title, onClick: (event) => event.stopPropagation() },
          h('div', { className: 'lwb-pack-detail-head' },
            h('div', null, h('h2', { className: 'lwb-modal-title' }, meta.title), meta.copy ? h('p', { className: 'lwb-modal-copy' }, meta.copy) : null),
          ),
          error ? h('p', { className: 'sa-blocker', role: 'alert' }, error) : null,
          h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: close }, '取消'),
            h('button', {
              type: 'button',
              className: meta.danger ? 'sa-danger' : 'lwb-primary-button',
              disabled: busy || meta.confirmDisabled === true,
              onClick: () => { void confirm(); },
            }, busy ? '处理中…' : (meta.confirm || '确认')),
          ),
        ),
      ) : null;
      return { ask, node };
    }

    function useRemoteValue(loader, deps = []) {
      const [state, setState] = React.useState({ loading: true, value: null, error: null });
      const reload = React.useCallback(() => {
        setState((current) => ({ ...current, loading: true }));
        loader().then(
          (value) => setState({ loading: false, value, error: null }),
          (error) => setState({ loading: false, value: null, error: error instanceof Error ? error.message : String(error) }),
        );
      }, deps);
      React.useEffect(() => { reload(); }, [reload]);
      return { ...state, reload };
    }

    /* --------------------------- 跨页存活的生成任务 --------------------------- */

    /**
     * 生成任务必须活过页面卸载。
     *
     * 能力包的每个菜单页都是独立组件，切 tab 会让旧页面卸载、本地 state 全部丢掉。
     * 而选题、写稿、素材采集、媒体流水线都是几十秒到几分钟的后台任务——切走再切回，
     * 界面就退化成「什么都没发生」，用户既看不到进度，也看不到已经生成好的候选。
     *
     * 任务记录本身在主机侧，所以这里做两层恢复：
     * 1. 模块级缓存：同一会话内切 tab，直接拿回记录，不用再请求一次；
     * 2. 主机侧最近记录：模块被重载（刷新、能力包重载）后，用最新一条续上。
     * 记录会一直留着直到被新一轮生成替换——生成完的结果同样不该因为切走而消失。
     */
    const liveTasks = new Map();

    function useLiveTask(kind, statusMethod, listField, interval = 1200) {
      const [task, setTask] = React.useState(() => liveTasks.get(kind) || null);
      const settle = React.useCallback((record) => {
        if (record) liveTasks.set(kind, record);
        else liveTasks.delete(kind);
        setTask(record);
      }, [kind]);

      React.useEffect(() => {
        if (task) return undefined;
        const remembered = liveTasks.get(kind);
        if (remembered) {
          remote(statusMethod, { id: remembered.id }).then(settle, () => settle(null));
          return undefined;
        }
        remote('listTopicGenerations').then((all) => {
          settle(all?.[listField]?.[0] || null);
        }, () => {});
      }, [kind, statusMethod, listField, task, settle]);

      React.useEffect(() => {
        if (!task || task.status === 'success' || task.status === 'failed') return undefined;
        const timer = window.setTimeout(() => {
          remote(statusMethod, { id: task.id }).then(settle, () => {});
        }, interval);
        return () => window.clearTimeout(timer);
      }, [kind, statusMethod, interval, task, settle]);

      return [task, settle];
    }

    /** 写稿正文同理：按项目缓存，切走再切回不丢还没保存的稿子。 */
    const scriptDrafts = new Map();

    function useScriptDraft(projectId) {
      const [body, setBody] = React.useState(() => scriptDrafts.get(projectId) || '');
      React.useEffect(() => { setBody(scriptDrafts.get(projectId) || ''); }, [projectId]);
      const update = React.useCallback((next) => {
        scriptDrafts.set(projectId, next);
        setBody(next);
      }, [projectId]);
      return [body, update];
    }

    /* ------------------------------- 流水线页 ------------------------------- */

    const FLOW = [
      { id: 'topic', label: '故事选题', copy: '具体场景 + 一句关键对白' },
      { id: 'script', label: '故事写稿', copy: '反塑料感硬闸门' },
      { id: 'voiceover', label: '配音', copy: '45-110 秒，女性舒缓音色' },
      { id: 'subtitles', label: '字幕', copy: '竖屏单行 16 字' },
      { id: 'video', label: '竖屏成片', copy: '1080×1920 / 30fps' },
      { id: 'qc', label: '质检闸门', copy: '技术 + 独立审片' },
      { id: 'packaging', label: '发布资料', copy: '标题不剧透 + 封面大字' },
    ];

    function PipelinePage({ openConversation }) {
      const projects = useRemoteValue(() => remote('list'), []);
      const overview = useRemoteValue(() => remote('overview'), []);
      const action = useAction();
      const confirm = useConfirm();

      const create = () => action.run('create', async () => {
        const title = window.prompt('给这条故事起一个项目名（内部用）：', '未命名故事');
        if (!title) return;
        await remote('create', { title });
        projects.reload();
        overview.reload();
      });

      // 项目删不掉是上一版最实的缺口：建错了只能留着。删除走二次确认，
      // 服务端拒绝时把真实原因留在弹窗里（例如「项目不存在」），不说「删不掉」。
      const remove = (item) => confirm.ask({
        title: '删除这个故事项目？',
        copy: `将永久删除「${item.title || '未命名故事'}」及其稿件、配音、字幕、成片与发布资料，无法恢复。`,
        confirm: '删除',
        danger: true,
        onConfirm: async () => {
          const result = await remote('remove', { projectIds: [item.id] });
          if (result?.missing?.length && !result?.removed?.length) {
            throw new Error('项目已经不存在了，列表可能过期。刷新后再试一次。');
          }
          projects.reload();
          overview.reload();
        },
      });

      const items = projects.value || [];
      const done = items.filter((item) => item.qcPassed).length;

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '制作流水线',
          kicker: { label: '内容策略', tone: '#8b5cf6' },
          copy: '一条情感故事从素材到发布资料要过七道关。写稿和质检两道是硬闸门：反塑料感不通过不能落库，质检不通过不能生成发布资料。',
          actions: h('button', { type: 'button', className: 'sa-primary', disabled: action.busy === 'create', onClick: create }, action.busy === 'create' ? '创建中…' : '新建故事'),
        }),
        h(ErrorLine, { error: action.error || projects.error || overview.error }),
        h('section', { className: 'sa-flow' }, FLOW.map((step) => h('div', { key: step.id, className: 'sa-flow-step' }, h('strong', null, step.label), h('span', null, step.copy)))),
        h('div', { className: 'sa-grid two' },
          h('article', { className: 'sa-card' },
            h('h3', null, '素材与定位'),
            h('p', null, `已收集素材 ${overview.value?.materialCount ?? 0} 条，其中带来源地址 ${overview.value?.materialWithSource ?? 0} 条。`),
            h('p', null, overview.value?.profile?.name ? `当前定位：${overview.value.profile.name}` : '还没有填写账号定位，选题会缺少受众约束。'),
            h('p', { className: 'sa-hint' }, '素材是唯一事实来源：写稿时每个具体细节都要能在素材里找到出处，找不到的必须写进「无素材支撑」清单。'),
          ),
          h('article', { className: 'sa-card' },
            h('h3', null, '交付情况'),
            h('p', null, `故事项目 ${items.length} 条，其中已过质检 ${done} 条。`),
            h('p', { className: 'sa-hint' }, '通过质检的那几条，发布资料页会列出标题、文案、标签与封面大字。'),
          ),
        ),
        h('section', { className: 'sa-card' },
          h('h3', null, '故事项目'),
          items.length
            ? h('ul', { className: 'sa-list' }, items.map((item) => h('li', { key: item.id, className: 'sa-item' },
              h('div', { className: 'sa-item-head' },
                h('strong', null, item.title),
                h('span', { className: 'sa-row' },
                  h(Chip, { tone: item.qcPassed ? 'good' : undefined }, item.qcPassed ? '已过质检' : `${item.completedStages.length}/7 阶段`),
                  h('button', { type: 'button', className: 'sa-danger sa-danger-sm', onClick: () => remove(item) }, '删除'),
                ),
              ),
              h('p', { className: 'sa-meta' }, `更新于 ${new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}`),
            )))
            : h(Empty, null, '还没有故事项目。先新建一个，再去「故事选题」生成候选。'),
        ),
        h('p', { className: 'sa-hint' }, '本包只准备发布资料，不向任何平台直发。需要自动投递请加载「发布与账号管理」能力包。'),
        confirm.node,
      );
    }

    /* ------------------------------- 账号定位页 ------------------------------- */

    /**
     * 账号定位页 = 多账号矩阵。
     *
     * 两份存储的分工（后端已定，前端只负责别搞混）：
     *   · accounts.json —— 具名账号列表，每个账号带一份完整定位，其中一个为默认；
     *   · account.json  —— 单份定位档案，只在「一个账号都没建」时被下游引用。
     * 下游取定位的顺序是：显式指定 > 默认账号 > 单份档案。所以「默认账号」才是
     * 后续选题/写稿真正引用的那一份，不是「最后一次保存的那一份」——这点必须在
     * 界面上说清，否则用户改完 A 账号发现没生效，会以为保存坏了。
     */
    function PositioningPage({ openPackMenu }) {
      const [accounts, setAccounts] = React.useState(null);
      const [single, setSingle] = React.useState(null);
      const [catalog, setCatalog] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      // 正在编辑的账号 id；'' 表示没有账号、编辑的是单份定位档案。
      const [activeId, setActiveId] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      // 'edit' 改当前选中项，'new' 新建账号（表单清空，主按钮变成「创建账号」）。
      const [mode, setMode] = React.useState('edit');
      const action = useAction();
      const confirm = useConfirm();

      const reload = React.useCallback(async () => {
        try {
          const [next, profile] = await Promise.all([
            remote('listAccounts').catch(() => null),
            remote('getProfile').catch(() => null),
          ]);
          setAccounts(next);
          setSingle(profile);
        } catch (caught) {
          setNotice(caught instanceof Error ? caught.message : String(caught));
        }
      }, []);
      React.useEffect(() => {
        remote('catalog').then(setCatalog, () => {});
        void reload();
      }, [reload]);

      const items = accounts?.items || [];
      const defaultId = accounts?.defaultId || null;
      const active = items.find((item) => item.id === activeId) || null;
      const editingAccount = mode === 'edit' && Boolean(active);

      // 表单内容跟着「当前在编辑谁」走；只有选中项或档案真的变了才重载，
      // 否则用户打字会被自己敲出来的 key 变化冲掉。
      const loadKey = mode === 'new'
        ? 'new'
        : (active ? `acct:${active.id}:${active.revision}` : `single:${single?.updatedAt || ''}`);
      const lastKey = React.useRef('');
      React.useEffect(() => {
        if (lastKey.current === loadKey) return;
        lastKey.current = loadKey;
        const source = mode === 'new' ? {} : (active || single || {});
        setDraft({
          name: source.name || '',
          positioning: source.positioning || '',
          audience: source.audience || '',
          themes: [...(source.themes || [])],
          boundary: source.boundary || '',
        });
      }, [loadKey, mode, active, single]);

      const patch = (next) => setDraft((current) => ({ ...(current || {}), ...next }));

      const save = () => action.run('save', async () => {
        if (mode === 'new') {
          const created = await remote('createAccount', draft);
          setMode('edit');
          setActiveId(created.id);
          // 第一个账号会被后端直接设为默认；之后的不会，说法要跟着变。
          const after = await remote('listAccounts').catch(() => null);
          const isDefault = after?.defaultId === created.id;
          setNotice(isDefault
            ? `账号「${created.name}」已创建，并且是默认账号——后续选题与写稿都会引用它的定位。`
            : `账号「${created.name}」已创建。要让它被后续阶段引用，点它的「设为默认」。`);
          await reload();
          return;
        }
        if (editingAccount) {
          await remote('updateAccount', { id: active.id, ...draft });
          setNotice('账号已保存。已经开始的选题不会跟着变——定位会以快照形式冻结进项目。');
        } else {
          await remote('setProfile', draft);
          setNotice('定位已保存。已经开始的选题不会跟着变——定位会以快照形式冻结进项目。');
        }
        await reload();
      });

      const suggest = () => action.run('suggest', async () => {
        const result = await remote('suggestProfile', draft);
        patch(result.suggestion || {});
        setNotice(`AI 补全了 ${result.filled.length} 项、调整了 ${result.updated.length} 项，请确认后保存。`);
      });

      const makeDefault = (account) => action.run(`default-${account.id}`, async () => {
        await remote('setDefaultAccount', { id: account.id });
        setNotice(`「${account.name}」已设为默认账号。后续新建的选题与写稿都会引用它的定位。`);
        await reload();
      });

      // 删除不会把历史项目怎么样：定位早就以快照冻结进项目了，删的只是以后的默认引用。
      const remove = (account) => confirm.ask({
        title: `删除账号「${account.name}」？`,
        copy: '已经开始的选题与稿件不受影响——定位在立项时就被快照冻结，不会追溯修改。删除后这个账号不再出现在列表里；如果它是默认账号，默认会顺延到剩下的第一个账号。',
        confirm: '删除',
        danger: true,
        onConfirm: async () => {
          const result = await remote('deleteAccount', { id: account.id });
          if (!result?.removed) throw new Error('账号已经不存在了，刷新后再试一次。');
          if (activeId === account.id) { setActiveId(''); setMode('edit'); }
          await reload();
        },
      });

      if (!draft) return h('div', { className: 'sa-page' }, h(ErrorLine, { error: notice }), h(Empty, null, '正在读取账号定位…'));

      const themes = catalog?.themes || [];
      const selected = new Set(Array.isArray(draft.themes) ? draft.themes : []);
      const toggle = (id) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else if (next.size < 4) next.add(id);
        patch({ themes: [...next] });
      };
      const profileReady = Boolean((draft.name || '').trim() || (draft.positioning || '').trim());

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '账号定位',
          kicker: { label: '受众与题材', tone: '#8b5cf6' },
          copy: '定位只定边界，不定选题：受众、题材上限、内容红线。它以快照形式冻结进每个项目，改了不会追溯已经开始的稿子。多个账号各持一份定位，下游引用的是「默认账号」那一份。',
          actions: h('div', { className: 'sa-actions' },
            h('button', { type: 'button', className: 'sa-plain', disabled: Boolean(action.busy) || !profileReady, onClick: suggest }, action.busy === 'suggest' ? '补全中…' : 'AI 补全'),
            h('button', {
              type: 'button',
              className: 'sa-primary',
              disabled: Boolean(action.busy) || (mode === 'new' && !profileReady),
              onClick: save,
            }, action.busy === 'save' ? '保存中…' : mode === 'new' ? '创建账号' : editingAccount ? '保存账号' : '保存定位'),
          ),
        }),
        h(ErrorLine, { error: action.error }),
        notice ? h('p', { className: 'sa-hint', role: 'status' }, notice) : null,

        // 账号矩阵：没有账号时也要把「为什么只有一个表单」说清，并给出一条升级路径。
        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-card-head' },
            h('h3', null, items.length ? `账号（${items.length}）` : '账号'),
            h('span', { className: 'sa-meta' }, items.length ? `默认：${(items.find((item) => item.id === defaultId) || {}).name || '未设置'}` : '尚未创建账号'),
          ),
          items.length ? h('div', { className: 'sa-acct-list' }, items.map((account) => h('div', {
            key: account.id, className: 'sa-acct', 'data-on': editingAccount && account.id === active.id ? 'true' : 'false',
          },
            h('div', { className: 'sa-acct-head' },
              h('strong', null, account.name || '未命名账号'),
              h('span', { className: 'sa-row' },
                account.id === defaultId ? h(Chip, { tone: 'good' }, '默认') : null,
                h('span', { className: 'sa-meta' }, `修订 ${account.revision}`),
              ),
            ),
            h('p', { className: 'sa-acct-meta' }, [
              account.positioning || '未填写定位',
              account.audience ? `受众：${account.audience}` : null,
              account.themes?.length ? `题材：${account.themes.join('、')}` : null,
            ].filter(Boolean).join(' · ')),
            h('div', { className: 'sa-acct-acts' },
              h('button', {
                type: 'button', className: 'sa-plain',
                disabled: Boolean(action.busy) || (editingAccount && account.id === active.id),
                onClick: () => { setMode('edit'); setActiveId(account.id); },
              }, editingAccount && account.id === active.id ? '正在编辑' : '编辑'),
              account.id === defaultId ? null : h('button', {
                type: 'button', className: 'sa-plain', disabled: Boolean(action.busy),
                onClick: () => { void makeDefault(account); },
              }, '设为默认'),
              h('button', { type: 'button', className: 'sa-danger sa-danger-sm', disabled: Boolean(action.busy), onClick: () => remove(account) }, '删除'),
            ),
          ))) : h('p', { className: 'sa-hint' }, '还没有账号。下面这份是「单份定位档案」：一个号够用时用它就行；要做矩阵就填好下面的表单，点「创建账号」把它变成第一个账号。'),
          h('div', { className: 'sa-actions' },
            h('button', {
              type: 'button', className: 'sa-plain',
              disabled: Boolean(action.busy) || mode === 'new',
              onClick: () => { setMode('new'); setNotice(null); },
            }, '新建账号'),
            mode === 'new' ? h('button', {
              type: 'button', className: 'sa-plain', disabled: Boolean(action.busy),
              onClick: () => { setMode('edit'); setNotice(null); },
            }, '取消新建') : null,
          ),
          h('p', { className: 'sa-hint' }, '下游取定位的顺序：显式指定 > 默认账号 > 单份档案。所以改了非默认账号不会立刻影响新选题——先「设为默认」。'),
        ),

        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-card-head' },
            h('h3', null, mode === 'new' ? '新账号定位' : editingAccount ? `编辑「${active.name || '未命名账号'}」` : '单份定位档案'),
            h('span', { className: 'sa-meta' }, mode === 'new' ? '创建后不会自动成为默认' : editingAccount ? (active.id === defaultId ? '默认账号' : '非默认') : '未建账号时生效'),
          ),
          h(Field, { label: '账号名（内部用）' }, h('input', { value: draft.name || '', maxLength: 60, onChange: (event) => patch({ name: event.target.value }) })),
          h(Field, { label: '账号定位' }, h('input', { value: draft.positioning || '', maxLength: 300, placeholder: '例如：专写婚姻里被磨掉的期待', onChange: (event) => patch({ positioning: event.target.value }) })),
          h(Field, { label: '目标受众' }, h('input', { value: draft.audience || '', maxLength: 120, onChange: (event) => patch({ audience: event.target.value }) })),
          h(Field, { label: '故事题材（最多 4 个）' },
            h('div', { className: 'sa-row' }, themes.map((theme) => h('button', {
              key: theme.id,
              type: 'button',
              className: selected.has(theme.id) ? 'sa-primary' : 'sa-plain',
              onClick: () => toggle(theme.id),
            }, theme.name))),
          ),
          h(Field, { label: '内容边界' }, h('textarea', { value: draft.boundary || '', maxLength: 600, placeholder: '允许什么、禁止什么：不煽动性别对立、不写可指认的真实人物、不做医疗与投资建议……', onChange: (event) => patch({ boundary: event.target.value }) })),
          !profileReady && mode === 'new' ? h('p', { className: 'sa-hint' }, '至少填账号名或账号定位，否则创建会被服务端拒绝。') : null,
        ),
        openPackMenu ? h('p', { className: 'sa-hint' }, h('button', {
          type: 'button', className: 'sa-plain',
          onClick: () => openPackMenu('materials'),
        }, '下一步：去故事素材')) : null,
        confirm.node,
      );
    }
    /* ------------------------------- 素材页 ------------------------------- */

    /**
     * 素材页分三块，从上到下就是「发起 → 挑 → 入库」，不再把表单、进度、结果、
     * 素材库、手动补录全糊在一屏里：
     *
     *   ① 采集入口：一个焦点输入框 + 一个按钮，只负责发起。
     *   ② 这一轮的结果：先看跑到哪了（步骤 + 各源状态），再看条目；
     *      批量操作和「入库」按钮固定在同一行工具栏里，全选不再藏在列表末尾。
     *   ③ 已入库素材库：主产物在这里，删除是唯一动作。
     *      手动补录折叠在末尾——它不是主路径，不该和采集结果抢注意力。
     *
     * 「偏弱」条目默认不勾：它是能看出是素材但不一定能出故事的那批，要人单独放行。
     */
    function MaterialsPage() {
      const materials = useRemoteValue(() => remote('listMaterials'), []);
      const catalog = useRemoteValue(() => remote('catalog'), []);
      const action = useAction();
      const [draft, setDraft] = React.useState({ title: '', content: '', kind: 'news-comment', sourceUrl: '', note: '' });
      const [focus, setFocus] = React.useState('');
      const [picked, setPicked] = React.useState({});
      const [manual, setManual] = React.useState(false);
      // 采集要检索外部内容，比一次模型调用慢，轮询间隔放宽到 2 秒。
      // 采集结果同样跨页存活：切走不会中断采集，也不会让已找到的条目消失。
      const [harvest, setHarvest] = useLiveTask('harvest', 'materialHarvestStatus', 'harvests', 2000);

      const items = materials.value?.items || [];
      const kinds = catalog.value?.sourceKinds || [];
      const kindLabel = (id) => kinds.find((kind) => kind.id === id)?.label || id;
      const found = harvest?.items || [];
      const pickedCount = Object.values(picked).filter(Boolean).length;
      const strongCount = found.filter((item) => !item.weak).length;
      const allPicked = found.length > 0 && pickedCount === found.length;

      const selectAll = () => {
        const next = {};
        found.forEach((_, index) => { next[index] = true; });
        setPicked(next);
      };

      const clearAll = () => setPicked({});

      const toggleAll = () => (allPicked ? clearAll() : selectAll());

      // 只选可用：偏弱条目要人单独放行，不该被一次「全选」顺手带进库。
      const selectStrong = () => {
        const next = {};
        found.forEach((item, index) => { if (!item.weak) next[index] = true; });
        setPicked(next);
      };

      const toggleOne = (index, checked) => setPicked((current) => ({ ...current, [index]: checked }));

      const startHarvest = () => action.run('harvest', async () => {
        const created = await remote('startMaterialHarvest', { focus: focus.trim() || undefined });
        setHarvest(created);
        const next = {};
        (created.items || []).forEach((item, index) => { if (!item.weak) next[index] = true; });
        setPicked(next);
      });

      const adopt = () => action.run('adopt', async () => {
        const indexes = found.map((_, index) => index).filter((index) => picked[index]);
        const result = await remote('adoptHarvest', { id: harvest.id, indexes });
        await materials.reload();
        setHarvest(null);
        setPicked({});
        window.alert(`已入库 ${result.count} 条素材。`);
      });

      const add = () => action.run('add', async () => {
        await remote('addMaterial', draft);
        setDraft({ title: '', content: '', kind: draft.kind, sourceUrl: '', note: '' });
        materials.reload();
      });

      const remove = (id) => action.run(`remove:${id}`, async () => {
        await remote('deleteMaterial', { id });
        materials.reload();
      });

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '故事素材',
          kicker: { label: '内容情报', tone: '#3b82f6' },
          copy: '素材是写稿唯一的事实来源：每一条都必须带出处，给不出来源的会被直接丢弃。日常让 agent 去找，自己有料时再手动补录。',
          actions: h('button', {
            type: 'button',
            className: 'sa-primary',
            disabled: Boolean(action.busy) || harvest?.status === 'running',
            onClick: startHarvest,
          }, harvest?.status === 'running' ? '采集进行中…' : '让 agent 去找素材'),
        }),
        h(ErrorLine, { error: action.error || materials.error }),

        /* ① 采集入口 */
        h('section', { className: 'sa-card' },
          h(Field, { label: '采集焦点（可选，留空就是「你看着办」）' },
            h('input', { value: focus, placeholder: '例如：婆媳之间关于钱的事；也可以留空', onChange: (event) => setFocus(event.target.value) })),
          h('p', { className: 'sa-hint' }, '出处来自公开社区的带链接原话。一轮跑几十秒到几分钟，结果出现在下面的「待入库」里；中途切到别的页面再回来，进度和结果都还在。'),
        ),

        /* ② 这一轮的结果 */
        harvest ? h('section', { className: 'sa-card' },
          h('div', { className: 'sa-card-head' },
            h('h3', null, harvest.status === 'running' ? '正在找素材…' : harvest.status === 'failed' ? '采集失败' : '这一轮找到的素材'),
            h('span', { className: 'sa-meta' }, found.length ? `${pickedCount}/${found.length} 条待入库` : null),
          ),
          h(Steps, { steps: harvest.steps, startedAt: harvest.createdAt, finishedAt: harvest.status === 'running' || harvest.status === 'queued' ? null : harvest.updatedAt }),
          // 采集源状态：哪个源通了、哪个源挂了、拿到了多少条。
          // 没有这一段，界面上只剩一个总数，看不出「是没找到」还是「源没抓到」。
          harvest.sources?.length
            ? h('div', { className: 'sa-row' }, harvest.sources.map((source) => h(Chip, { tone: source.status === 'ready' ? 'good' : 'bad' }, `${source.name} ${source.status === 'ready' ? `${source.count} 条` : '未取到'}`)))
            : null,
          harvest.sources?.some((source) => source.status !== 'ready' && source.error)
            ? h('p', { className: 'sa-hint' }, `未取到的来源：${harvest.sources.filter((source) => source.status !== 'ready').map((source) => `${source.name}（${source.error}）`).join('、')}`)
            : null,
          harvest.error ? h('p', { className: 'sa-blocker' }, harvest.error) : null,
          harvest.summary ? h('p', { className: 'sa-quote' }, harvest.summary) : null,
          // 找不到不是失败，但要如实呈现：让人知道下一步该去哪补。
          harvest.status === 'success' && !found.length && harvest.gaps
            ? h('div', null, h('p', { className: 'sa-hint' }, '这一轮没有找到可入库的素材。'), h('p', { className: 'sa-quote' }, harvest.gaps))
            : null,
          found.length
            ? h('div', null,
              /* 批量操作和入库在同一行：找按钮不该是这一页的难点。 */
              h('div', { className: 'sa-toolbar' },
                h('label', { className: 'sa-check' },
                  h('input', { type: 'checkbox', checked: allPicked, onChange: toggleAll }),
                  h('span', null, '全选'),
                ),
                h('span', { className: 'sa-meta' }, `已勾选 ${pickedCount} 条${strongCount ? `，其中可用 ${strongCount} 条` : ''}`),
                h('div', { className: 'sa-actions' },
                  h('button', { type: 'button', className: 'sa-plain', onClick: selectAll }, '全选'),
                  h('button', { type: 'button', className: 'sa-plain', disabled: pickedCount === 0, onClick: clearAll }, '清空'),
                  h('button', { type: 'button', className: 'sa-plain', disabled: pickedCount === strongCount, onClick: selectStrong }, '只选可用'),
                  h('button', { type: 'button', className: 'sa-primary', disabled: Boolean(action.busy) || pickedCount === 0, onClick: adopt },
                    pickedCount ? `入库选中的 ${pickedCount} 条` : '请先勾选'),
                ),
              ),
              h('ul', { className: 'sa-list' }, found.map((item, index) => h('li', { key: index, className: 'sa-item' },
                h('label', { className: 'sa-pick-head' },
                  h('input', { type: 'checkbox', checked: Boolean(picked[index]), onChange: (event) => toggleOne(index, event.target.checked) }),
                  h('strong', null, item.title),
                  item.weak ? h(Chip, { tone: 'warn' }, '偏弱') : h(Chip, { tone: 'good' }, '可用'),
                ),
                h('p', { className: 'sa-quote' }, item.content.slice(0, 240)),
                item.sceneHint ? h('p', { className: 'sa-hint' }, `场景：${item.sceneHint}`) : null,
                item.keyLineHint ? h('p', { className: 'sa-quote' }, `「${item.keyLineHint}」`) : null,
                item.note ? h('p', { className: 'sa-hint' }, item.note) : null,
                h('p', { className: 'sa-meta' }, `${kindLabel(item.kind)} · ${item.sourceUrl}`),
              ))),
            )
            : null,
        ) : null,

        /* ③ 已入库素材库 */
        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-card-head' },
            h('h3', null, `已入库素材（${items.length}）`),
            h('button', { type: 'button', className: 'sa-plain', onClick: () => setManual(!manual) }, manual ? '收起手动补录' : '手动补录一条'),
          ),
          items.length
            ? h('ul', { className: 'sa-list' }, items.slice().reverse().map((item) => h('li', { key: item.id, className: 'sa-item' },
              h('div', { className: 'sa-item-head' }, h('strong', null, item.title), h(Chip, { tone: item.sourceUrl ? 'good' : 'warn' }, item.sourceUrl ? '有来源' : '无来源地址')),
              h('p', { className: 'sa-quote' }, item.content.slice(0, 240)),
              h('div', { className: 'sa-row' },
                h('span', { className: 'sa-meta' }, `${kindLabel(item.kind)} · 被引用 ${item.usedBy.length} 次`),
                h('button', { type: 'button', className: 'sa-plain', disabled: Boolean(action.busy), onClick: () => remove(item.id) }, '删除'),
              ),
            )))
            : h(Empty, null, '还没有素材。点上方「让 agent 去找素材」，或者手动补录一条。'),
        ),

        manual ? h('section', { className: 'sa-card' },
          h('h3', null, '手动补录'),
          h(Field, { label: '标题' }, h('input', { value: draft.title, onChange: (event) => setDraft({ ...draft, title: event.target.value }) })),
          h(Field, { label: '内容（原话、细节、对白都可以贴进来）' }, h('textarea', { value: draft.content, onChange: (event) => setDraft({ ...draft, content: event.target.value }) })),
          h('div', { className: 'sa-row' },
            h(Field, { label: '来源类型' }, h('select', { value: draft.kind, onChange: (event) => setDraft({ ...draft, kind: event.target.value }) }, kinds.map((kind) => h('option', { key: kind.id, value: kind.id }, kind.label)))),
            h(Field, { label: '来源地址（可选）' }, h('input', { value: draft.sourceUrl, placeholder: 'https://', onChange: (event) => setDraft({ ...draft, sourceUrl: event.target.value }) })),
          ),
          h(Field, { label: '备注（可选）' }, h('input', { value: draft.note, onChange: (event) => setDraft({ ...draft, note: event.target.value }) })),
          h('div', { className: 'sa-actions' }, h('button', { type: 'button', className: 'sa-primary', disabled: Boolean(action.busy) || !draft.title.trim() || !draft.content.trim(), onClick: add }, action.busy === 'add' ? '保存中…' : '保存素材')),
        ) : null,
      );
    }

    /* ------------------------------- 候选卡片 ------------------------------- */

    function CandidateCard({ candidate, index, onPick, busy }) {
      const themeName = { marriage: '婚姻与离婚', 'family-origin': '原生家庭', midlife: '中年危机', 'late-love': '中年人的爱', kinship: '亲情细碎日常', unresolved: '意难平' }[candidate.theme] || '未指定题材';
      const confidence = { high: { label: '有素材支撑', tone: 'good' }, medium: { label: '部分推演', tone: 'warn' }, low: { label: '基本推演', tone: 'bad' } }[candidate.confidence] || null;
      return h('li', { className: 'sa-item' },
        h('div', { className: 'sa-item-head' },
          h('strong', null, `${index + 1}. ${candidate.title}`),
          h(Chip, null, themeName),
          confidence ? h(Chip, { tone: confidence.tone }, confidence.label) : null,
        ),
        h('p', { className: 'sa-hint' }, `场景：${candidate.scenario}`),
        h('p', { className: 'sa-quote' }, `「${candidate.keyLine}」`),
        // 推荐理由：由 agent 决定排序，就必须把依据摆出来，否则人只能盲选。
        candidate.reason ? h('p', { className: 'sa-hint' }, `推荐理由：${candidate.reason}`) : null,
        h('div', { className: 'sa-row' },
          candidate.materialIds.length ? h(Chip, { tone: 'good' }, `引用 ${candidate.materialIds.length} 条素材`) : h(Chip, { tone: 'warn' }, '无素材依据'),
          h('button', { type: 'button', className: 'sa-primary', disabled: busy, onClick: () => onPick(candidate) }, '用这个选题'),
        ),
      );
    }

    /* ------------------------------- 选题页 ------------------------------- */

    function TopicsPage() {
      const projects = useRemoteValue(() => remote('list'), []);
      const materials = useRemoteValue(() => remote('listMaterials'), []);
      const action = useAction();
      const [generation, setGeneration] = useLiveTask('topic', 'topicGenerationStatus', 'topics');

      const start = () => action.run('start', async () => {
        const created = await remote('startTopicGeneration', {});
        setGeneration({ ...created, candidates: [], steps: created.steps });
      });

      // 选题落到哪个项目上：有选中就用，没有就现场建一个，避免「先生成后找地方放」。
      const pick = (candidate) => action.run('pick', async () => {
        const title = candidate.title.slice(0, 60);
        const project = await remote('create', { title });
        await remote('commit', {
          projectId: project.id,
          expectedRevision: project.revision,
          stage: 'topic',
          idempotencyKey: `topic-${Date.now()}`,
          payload: {
            title: candidate.title,
            scenario: candidate.scenario,
            keyLine: candidate.keyLine,
            theme: candidate.theme || undefined,
            hook: candidate.hook || undefined,
            emotion: candidate.emotion || undefined,
            account: generation?.account || undefined,
          },
        });
        projects.reload();
        window.alert('选题已写入项目。下一步：故事写稿。');
      });

      const materialCount = materials.value?.items?.length || 0;

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '故事选题',
          kicker: { label: '创作策划', tone: '#f97316' },
          copy: '好的情感故事选题必须能说出两件事：一个具体到能拍出来的场景，和一句扎人的原话。说不出来的候选会被直接丢弃，不会显示给你。agent 自行判断推荐顺序，每个候选都给出推荐理由和依据强度。',
          actions: h('button', { type: 'button', className: 'sa-primary', disabled: Boolean(action.busy) || generation?.status === 'running', onClick: start }, generation?.status === 'running' ? '生成中…' : '生成 5 个候选'),
        }),
        h(ErrorLine, { error: action.error }),
        // 不再让用户选题材与角度：agent 基于素材池和账号定位自行判断并排序，
        // 每个候选都带推荐理由和依据强度，人只负责「用这个」。
        h('section', { className: 'sa-card' },
          h('p', { className: 'sa-hint' }, materialCount
            ? `agent 会基于已入库的 ${materialCount} 条素材和账号定位自行判断，直接给出排序后的候选。`
            : '工作区还没有素材：生成的候选会标为「基本推演」，可信度低。建议先去「故事素材」让 agent 去找一轮。'),
        ),
        generation ? h('section', { className: 'sa-card' },
          h('h3', null, generation.status === 'success' ? `候选（${generation.candidates.length}）` : generation.status === 'failed' ? '生成失败' : '生成中'),
          h(Steps, { steps: generation.steps, startedAt: generation.createdAt, finishedAt: generation.status === 'running' || generation.status === 'queued' ? null : generation.updatedAt }),
          generation.error ? h('p', { className: 'sa-blocker' }, generation.error) : null,
          generation.summary ? h('p', { className: 'sa-quote' }, generation.summary) : null,
        ) : null,
        generation?.candidates?.length
          ? h('ul', { className: 'sa-list' }, generation.candidates.map((candidate, index) => h(CandidateCard, { key: index, candidate, index, onPick: pick, busy: Boolean(action.busy) })))
          : null,
      );
    }

    /* ------------------------------- 写稿页 ------------------------------- */

    function maskScript(body) {
      return checkLocal(body);
    }

    // 本地轻量镜像：只做「有没有明显硬伤」的即时提示，真正的判定仍以主机端为准。
    function checkLocal(body) {
      const text = String(body || '');
      const banned = /重生|穿越|霸总|豪门|车祸失忆|绝症/u.test(text);
      const lifted = /我终于明白|后来我才懂|这就是人生|说到底|愿你/u.test(text);
      const dialogue = /[「“"][^」”"]{2,80}[」”"]/u.test(text);
      const problems = [];
      if (banned) problems.push('出现套路词（重生/穿越/霸总/豪门/车祸失忆/绝症）');
      if (lifted) problems.push('出现升华句');
      if (text.length > 150 && !dialogue) problems.push('没有人物对白');
      return problems;
    }

    function ScriptsPage({ openPackMenu }) {
      const action = useAction();
      const [projects, setProjects] = React.useState([]);
      const [projectId, setProjectId] = React.useState('');
      const [generation, setGeneration] = useLiveTask('script', 'scriptGenerationStatus', 'scripts');
      const [body, setBodyState] = useScriptDraft(projectId);
      const [tier, setTier] = React.useState('standard');
      const [report, setReport] = React.useState(null);
      // 人工放行：反塑料感硬闸的唯一人工出口。null=没打开。
      const [override, setOverride] = React.useState(null);
      const [overrideBusy, setOverrideBusy] = React.useState(false);
      // 放行失败的原因就地显示在弹窗里：用户在哪儿点的，就在哪儿看到为什么没成。
      const [overrideError, setOverrideError] = React.useState(null);
      // 操作者只存在本机（审计记录的「谁」），下次打开自动带上，不用反复填。
      const [operator, setOperator] = React.useState(() => {
        try { return window.localStorage.getItem('sa-operator') || ''; } catch (caught) { return ''; }
      });
      // 已经记录过放行的硬拦项：放行是逐条记录的，别让用户对同一条放两次。
      const [overridden, setOverridden] = React.useState(() => new Set());
      // ② 历史写稿记录：轮询只看得到当前这一轮，过往几轮要能从列表里翻出来。
      const [history, setHistory] = React.useState(null);
      const [historyError, setHistoryError] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const loadHistory = React.useCallback(() => {
        remote('listScriptGenerations').then(setHistory, (error) => setHistoryError(error instanceof Error ? error.message : String(error)));
      }, []);
      React.useEffect(() => { loadHistory(); }, [loadHistory]);
      // 这一轮跑到终态就刷新一次列表：否则用户刚跑完，历史里还是空的。
      React.useEffect(() => {
        if (!generation || generation.status === 'running' || generation.status === 'queued') return undefined;
        loadHistory();
        return undefined;
      }, [generation, loadHistory]);

      React.useEffect(() => {
        remote('listAntiPlasticOverrides', { projectId }).then((result) => {
          setOverridden(new Set((result?.overrides || []).map((item) => item.blocker).filter(Boolean)));
        }, () => {});
      }, [projectId]);

      React.useEffect(() => {
        remote('list').then((items) => {
          setProjects(items);
          const first = items.find((item) => item.completedStages.includes('topic'));
          if (first) setProjectId(first.id);
        }, () => {});
      }, []);

      React.useEffect(() => {
        if (!generation || generation.status === 'success' || generation.status === 'failed') return undefined;
        const timer = window.setTimeout(() => {
          remote('scriptGenerationStatus', { id: generation.id }).then((next) => {
            setGeneration(next);
            // 生成完成后自动填入：没动过的草稿才填，避免覆盖用户正在写的版本。
            if (next.draft?.script && !scriptDrafts.get(projectId)) setBodyState(next.draft.script);
          }, () => {});
        }, 1200);
        return () => window.clearTimeout(timer);
      }, [generation, body]);

      React.useEffect(() => {
        if (!body.trim()) { setReport(null); return undefined; }
        const timer = window.setTimeout(() => {
          remote('checkScript', { body }).then(setReport, () => {});
        }, 500);
        return () => window.clearTimeout(timer);
      }, [body]);

      const generate = () => action.run('generate', async () => {
        if (!projectId) return;
        const created = await remote('startScriptGeneration', { projectId, tier });
        setGeneration({ ...created, steps: created.steps });
      });

      const save = () => action.run('save', async () => {
        const project = projects.find((item) => item.id === projectId);
        if (!project) return;
        await remote('commit', {
          projectId,
          expectedRevision: project.revision,
          stage: 'script',
          idempotencyKey: `script-${Date.now()}`,
          payload: { body, title: project.title },
        });
        await remote('approveScript', { projectId });
        remote('list').then(setProjects, () => {});
        window.alert('稿件已保存并确认。可以进入配音与字幕。');
      });

      const local = maskScript(body);
      const blocking = report?.blocking || [];
      const suggestions = report?.suggestions || [];

      // ③ 按钮全灰必须有解释：没项目 / 没选中 / 选中了但缺选题阶段，是三件不同的
      // 事，都给一句说明和一个能点的动作，别让人对着一片灰猜。
      const current = projects.find((item) => item.id === projectId) || null;
      const topicReady = projects.filter((item) => item.completedStages.includes('topic'));
      // 一个选题阶段都没有时，问题不在「选哪个项目」而在「先有选题」——说法要指对地方。
      const lackingTopic = current || topicReady.length === 0 ? (current || projects[0] || null) : null;
      const blockedReason = !projects.length
        ? { title: '还没有项目', copy: '写稿要挂在某个项目下。先去「制作流水线」新建一个项目，再回来选它。', to: 'pipeline', action: '去新建项目' }
        : lackingTopic && !lackingTopic.completedStages.includes('topic')
          ? { title: `「${lackingTopic.title || '这个项目'}」还没有选题阶段`, copy: '写稿依据的是冻结下来的选题，没有选题就无从写起。先去「故事选题」生成候选并加入待写稿，再回来写。', to: 'topics', action: '去生成选题' }
          : !projectId
            ? { title: '还没有选中项目', copy: '上面的项目下拉里选一个已经完成选题的项目就能开始写。', to: null, action: null }
            : null;

      // ② 历史写稿记录：倒序，最多 20 条（后端上限）。失败那几轮要把原因带出来。
      const historyItems = history?.scripts || [];
      const projectTitle = (id) => (projects.find((item) => item.id === id) || {}).title || '已删除的项目';

      /**
       * 人工放行。理由与时间戳随 commit 一起落库，质检页据此显示「本条经人工放行」——
       * 放行必须留痕，不能悄悄放过。后端此刻还没认这个字段，服务端会以
       * STORY_ACCOUNT_SCRIPT_REJECTED 拒绝并把真实硬拦项回给界面；等后端支持后
       * 同一条路径即刻生效，界面无需再改。
       */
      /**
       * 逐条记录人工放行。放行不是把硬拦项删掉：原始报告原样保留，放行记录单独
       * 落库，质检闸门据此把「已放行的那几条」从最终判定里摘掉。审计要能回答
       * 谁、何时、为什么放行了哪一条，所以操作者与理由都必填。
       */
      const applyOverride = async () => {
        setOverrideBusy(true);
        setOverrideError(null);
        try {
          if (!projectId) throw new Error('请先选择项目。');
          const picked = (override?.picked || []).filter((item) => !overridden.has(item));
          if (!picked.length) throw new Error('请至少勾选一条要放行的硬拦项。');
          const who = (override?.operator || '').trim();
          if (!who) throw new Error('必须填操作者：审计记录要能回答「是谁批准的」。');
          const reason = (override?.reason || '').trim();
          if (reason.length < 4) throw new Error('放行理由至少写 4 个字：这条记录会进审计，写「知道」等于没写。');
          for (const blocker of picked) {
            await remote('overrideAntiPlastic', { projectId, blocker, operator: who, reason });
          }
          try { window.localStorage.setItem('sa-operator', who); } catch (caught) { /* 隐私模式下记不住就算了，不阻塞放行 */ }
          setOperator(who);
          setOverridden((current) => new Set([...current, ...picked]));
          setOverride(null);
        } catch (caught) {
          // 服务端原话直接给用户：比「放行失败」有用。
          setOverrideError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setOverrideBusy(false);
        }
      };

      const overrideNode = override ? h('div', { className: 'lwb-modal-backdrop', onClick: () => { if (!overrideBusy) setOverride(null); } },
        h('div', { className: 'lwb-card lwb-pack-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': '人工放行这条稿件', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'lwb-pack-detail-head' }, h('div', null,
            h('h2', { className: 'lwb-modal-title' }, '人工放行这条稿件'),
            h('p', { className: 'lwb-modal-copy' }, '放行记录会写进审计（操作者 + 理由 + 时间 + 放行了哪一条），质检闸门据此把勾选的这几条从最终判定里摘掉；原始报告里的硬拦项原样保留，不会被删掉。它是给「客户指定要这样」用的，不是给「懒得改」用的。'),
          )),
          h(Field, { label: '操作者（谁批准的，会进审计记录）' }, h('input', {
            value: override.operator, maxLength: 60, autoComplete: 'off',
            placeholder: '例如：李发发 / 工号',
            onChange: (event) => setOverride({ ...override, operator: event.target.value }),
          })),
          h(Field, { label: '放行理由（必填，会进审计记录）' }, h('textarea', {
            style: { minHeight: 84 }, value: override.reason, maxLength: 300,
            placeholder: '例如：客户指定要这个结尾，升华句是brief要求',
            onChange: (event) => setOverride({ ...override, reason: event.target.value }),
          })),
          h('p', { className: 'sa-hint' }, '勾选要放行的硬拦项（逐条记录，可只放其中几条）：'),
          h('div', { className: 'sa-list' }, blocking.map((item, index) => {
            const done = overridden.has(item);
            return h('label', { key: index, className: 'sa-check' },
              h('input', {
                type: 'checkbox', checked: done || (override.picked || []).includes(item), disabled: done,
                onChange: (event) => setOverride((current) => ({
                  ...current,
                  picked: event.target.checked
                    ? [...(current.picked || []), item]
                    : (current.picked || []).filter((entry) => entry !== item),
                })),
              }),
              h('span', null, done ? `${item}（已放行）` : item),
            );
          })),
          overrideError ? h('p', { className: 'sa-blocker', role: 'alert' }, overrideError) : null,
          h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: overrideBusy, onClick: () => setOverride(null) }, '取消'),
            h('button', {
              type: 'button', className: 'lwb-primary-button',
              disabled: overrideBusy || !(override.operator || '').trim() || (override.reason || '').trim().length < 4,
              onClick: () => { void applyOverride(); },
            }, overrideBusy ? '放行中…' : '确认放行'),
          ),
        ),
      ) : null;

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '故事写稿',
          kicker: { label: '内容生产', tone: '#7c3aed' },
          copy: '写稿页的核心不是「生成一篇」，而是「卡住不让人味不合格的稿子出去」。硬拦项在保存时由主机再判一次，本地这个红框只是提前提醒。',
        }),
        h(ErrorLine, { error: action.error }),
        notice ? h('p', { className: 'sa-hint', role: 'status' }, notice) : null,
        // ③ 不能开工就说清为什么，并给一个能点的动作——按钮无解释地全灰是静默失败。
        blockedReason ? h(Callout, { tone: 'warning', title: blockedReason.title },
          blockedReason.copy,
          blockedReason.to && openPackMenu
            ? [h('button', { key: 'go', type: 'button', className: 'lwb-plain-button lwb-button-sm', onClick: () => openPackMenu(blockedReason.to) }, blockedReason.action)]
            : ['上面的项目下拉里选一个就能继续。'],
        ) : null,
        // 有可选项目但缺选题阶段时，按钮仍然禁用——但原因已经写在上面，不是静默失败。
        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-row' },
            h(Field, { label: '项目' }, h('select', { value: projectId, onChange: (event) => setProjectId(event.target.value) },
              projects.length ? projects.map((item) => h('option', { key: item.id, value: item.id }, item.title)) : h('option', { value: '' }, '还没有项目'))),
            h(Field, { label: '篇幅' }, h('select', { value: tier, onChange: (event) => setTier(event.target.value) },
              h('option', { value: 'short' }, '快节奏 45-60 秒'),
              h('option', { value: 'standard' }, '标准 60-80 秒'),
              h('option', { value: 'long' }, '慢叙述 80-110 秒'),
            ))),
          h('div', { className: 'sa-actions' },
            h('button', { type: 'button', className: 'sa-primary', disabled: Boolean(action.busy) || !projectId || generation?.status === 'running', onClick: generate }, generation?.status === 'running' ? '写作中…' : 'AI 写稿'),
            h('button', { type: 'button', className: 'sa-plain', disabled: Boolean(action.busy) || !body.trim() || blocking.length > 0, onClick: save }, action.busy === 'save' ? '保存中…' : '保存并确认'),
            // 硬闸的唯一人工出口：按钮只在真有硬拦项时出现，且必须填理由。
            blocking.length ? h('button', { type: 'button', className: 'sa-plain', disabled: Boolean(action.busy) || !projectId || !body.trim(), onClick: () => setOverride({ operator, reason: '', picked: [] }) }, '人工放行…') : null,
          ),
        ),
        generation ? h('section', { className: 'sa-card' },
          h('h3', null, generation.status === 'success' ? `稿件（${generation.quality?.qualityScore ?? 0} 分）` : generation.status === 'failed' ? '写稿失败' : '写作中'),
          h(Steps, { steps: generation.steps, startedAt: generation.createdAt, finishedAt: generation.status === 'running' || generation.status === 'queued' ? null : generation.updatedAt }),
          generation.error ? h('p', { className: 'sa-blocker' }, generation.error) : null,
        ) : null,
        h('section', { className: 'sa-card' },
          h(Field, { label: '口播稿正文' }, h('textarea', { style: { minHeight: 320 }, value: body, onChange: (event) => setBodyState(event.target.value) })),
          local.length ? h('p', { className: 'sa-blocker' }, `本地即时提醒：${local.join('；')}。`) : null,
          blocking.length ? h('p', { className: 'sa-blocker' }, `反塑料感硬拦项（${blocking.length}）：\n${blocking.join('\n')}`) : null,
          blocking.length ? h('p', { className: 'sa-hint' }, '这些是硬拦项，不改就保存不了。确有理由保留时，用上面的「人工放行…」逐条记录放行——放行进审计，质检闸门会据此把这几条从最终判定里摘掉，原始报告仍原样保留。') : null,
          suggestions.length ? h('div', null, h('p', { className: 'sa-hint' }, '改写建议（不拦截）：'), h('ul', { className: 'sa-list' }, suggestions.map((item, index) => h('li', { key: index, className: 'sa-hint' }, `· ${item}`)))) : null,
          report?.passed ? h('p', { className: 'sa-hint' }, `反塑料感通过，可读性 ${report.score} 分。`) : null,
        ),
        // ② 历史写稿记录：轮询只看当前这一轮，这里把过往几轮列出来，
        // 失败的那几轮连原因一起给，并能直接把某一版稿件采用回编辑器。
        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-card-head' },
            h('h3', null, '历史写稿记录'),
            h('span', { className: 'sa-meta' }, historyItems.length ? `最近 ${historyItems.length} 轮` : ''),
          ),
          h('p', { className: 'sa-hint' }, '每一轮生成都会留在这里：跑到哪一步、质量分多少、失败在哪儿。采用某一版只会把正文填回上面的编辑器，不会改动已落库的稿件。'),
          historyError ? h('p', { className: 'sa-blocker' }, historyError) : null,
          historyItems.length ? h('div', { className: 'sa-gen-list' }, historyItems.map((record) => {
            const script = record.draft?.script || '';
            return h('div', { key: record.id, className: 'sa-gen' },
              h('div', { className: 'sa-gen-head' },
                h('span', { className: 'sa-gen-title' }, projectTitle(record.projectId)),
                h('span', { className: 'sa-row' },
                  h(Chip, {
                    tone: record.status === 'succeeded' ? 'good' : record.status === 'failed' ? 'bad' : undefined,
                  }, record.status === 'succeeded' ? '已完成' : record.status === 'failed' ? '失败' : record.status === 'running' ? '进行中' : '排队中'),
                  record.quality?.qualityScore != null ? h('span', { className: 'sa-meta' }, `${record.quality.qualityScore} 分`) : null,
                ),
              ),
              h('p', { className: 'sa-gen-meta' }, [
                new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false }),
                script ? `${script.length} 字` : '无正文',
                record.draft?.title ? `《${record.draft.title}》` : null,
              ].filter(Boolean).join(' · ')),
              record.error ? h('p', { className: 'sa-blocker' }, record.error) : null,
              script ? h('div', { className: 'sa-actions' },
                h('button', {
                  type: 'button', className: 'sa-plain', disabled: Boolean(action.busy),
                  onClick: () => {
                    setBodyState(script);
                    setNotice(`已把 ${new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })} 那一版填回编辑器。要落库还得点「保存并确认」。`);
                  },
                }, '采用这一版'),
                h('span', { className: 'sa-meta' }, '填回上方编辑器'),
              ) : null,
            );
          })) : h(Empty, null, '还没有写稿记录。点上面的「AI 写稿」跑第一轮。'),
        ),
        overrideNode,
      );
    }

    /* ----------------------------- 配音与字幕页 ----------------------------- */

    const PALETTES = [
      { id: 'dusk', label: '黄昏（暖褐）' },
      { id: 'rainy', label: '雨夜（冷蓝）' },
      { id: 'kitchen', label: '厨房（暖黄）' },
      { id: 'oldroom', label: '旧屋（暗红）' },
    ];

    function AudioCaptionsPage() {
      const projects = useRemoteValue(() => remote('list'), []);
      const catalog = useRemoteValue(() => remote('catalog'), []);
      const action = useAction();
      const [projectId, setProjectId] = React.useState('');
      const [palette, setPalette] = React.useState('dusk');
      const [rate, setRate] = React.useState(0.92);
      const [recipeId, setRecipeId] = React.useState('');
      const [generation, setGeneration] = useLiveTask('media', 'mediaPipelineStatus', 'media', 2000);
      // 声音方案卡片 + 试听。试听是唯一能证明「这声音真的可用」的动作：
      // 音色名写对了但桥接没起来、Key 没额度，只有真合成一次才暴露。
      const [previews, setPreviews] = React.useState({});
      const [previewBusy, setPreviewBusy] = React.useState(null);
      // 媒体服务状态只能由真实试探得出：story-account 的网关没有只读状态方法，
      // 所以这里记试听/启动的结果，不猜。'ready'=通，'unreachable'=配了但连不上，
      // null=还没试过。
      const [mediaReady, setMediaReady] = React.useState(null);
      // 媒体服务凭据：与 spoken-video 共用同一套私有凭据库与同一个 ref
      // （LWB_SPOKEN_VIDEO_SCITIGER_API_KEY），密钥永不落本包、永不回传。
      const [credential, setCredential] = React.useState(null);
      const [credentialOpen, setCredentialOpen] = React.useState(false);
      const [apiKey, setApiKey] = React.useState('');
      const [credentialBusy, setCredentialBusy] = React.useState(null);
      const [credentialError, setCredentialError] = React.useState(null);

      React.useEffect(() => {
        const items = projects.value || [];
        const ready = items.find((item) => item.completedStages.includes('script'));
        if (!projectId && ready) setProjectId(ready.id);
      }, [projects.value, projectId]);

      const recipes = catalog.value?.voiceRecipes || [];
      React.useEffect(() => {
        if (recipeId || !recipes.length) return;
        setRecipeId(catalog.value?.defaultVoiceRecipeId || recipes[0].id);
      }, [recipes, recipeId, catalog.value]);
      // 换方案就把语速复位到该方案的推荐值：用户改了语速又换方案，
      // 不应该把上一个方案的语速带到新方案上。
      React.useEffect(() => {
        const recipe = recipes.find((item) => item.id === recipeId);
        if (recipe) setRate(recipe.rate);
      }, [recipeId, recipes]);

      const scriptReady = (projects.value || []).filter((item) => item.completedStages.includes('script'));
      const done = (generation?.steps || []).filter((step) => step.status === 'done').length;

      // 凭据状态：宿主不提供私有凭据服务时（旧环境）不阻塞页面，回到「未知」。
      const refreshCredential = React.useCallback(async () => {
        try {
          setCredential(await remote('getMediaCredentialStatus', { provider: 'scitiger' }));
        } catch (caught) {
          setCredential(null);
        }
      }, []);
      React.useEffect(() => { void refreshCredential(); }, [refreshCredential]);

      const saveCredential = async () => {
        if (!apiKey.trim()) return;
        setCredentialBusy('save');
        setCredentialError(null);
        try {
          await remote('saveMediaCredential', { provider: 'scitiger', apiKey });
          setApiKey('');
          await refreshCredential();
        } catch (caught) {
          setCredentialError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setCredentialBusy(null);
        }
      };

      const clearCredential = async () => {
        setCredentialBusy('clear');
        setCredentialError(null);
        try {
          await remote('clearMediaCredential', { provider: 'scitiger' });
          await refreshCredential();
        } catch (caught) {
          setCredentialError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setCredentialBusy(null);
        }
      };

      const preview = async (recipe) => {
        setPreviewBusy(recipe.id);
        try {
          const result = await remote('previewVoice', { recipeId: recipe.id });
          setPreviews((current) => ({ ...current, [recipe.id]: result }));
          setMediaReady('ready');
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : String(caught);
          setPreviews((current) => ({ ...current, [recipe.id]: { ok: false, reason } }));
          // 「没配地址」和「桥接没起来」是两件事，下一步不同，但都归到连不上这一类。
          if (/没有配置媒体服务地址|LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL|媒体服务不可访问|媒体服务返回/u.test(reason)) setMediaReady('unreachable');
        } finally {
          setPreviewBusy(null);
        }
      };

      const start = () => action.run('start', async () => {
        const created = await remote('startMediaPipeline', { projectId, voice: { recipeId, rate }, palette });
        setGeneration(created);
        setMediaReady('ready');
      });

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '配音与字幕',
          kicker: { label: '音频与字幕', tone: '#ec4899' },
          copy: '这一步同时完成配音、字幕与成片渲染。字幕严格跟着画面节拍走——两处各自切分会错位，观众会看到画面换了三句、字幕还停在第二条。',
          actions: h('button', {
            type: 'button',
            className: 'sa-primary',
            disabled: Boolean(action.busy) || !projectId || generation?.status === 'running',
            onClick: start,
          }, generation?.status === 'running' ? '流水线运行中…' : '开始制作'),
        }),
        h(ErrorLine, { error: action.error || catalog.error }),
        // 凭据状态：有结论才显示。没保存 Key 时把入口直接给出来——这是用户
        // 唯一能自己修的一项，而且和「口播视频」包共用同一份密钥。
        credential?.configured === false ? h(Callout, { tone: 'warning', title: '还没保存媒体服务 API Key' },
          '配音、字幕都走本机媒体桥接。Key 保存在 DSH 私有凭据库里，不会写进稿件、任务或浏览器存储；与「口播视频」包共用同一份。',
          [h('button', { key: 'open', type: 'button', className: 'lwb-plain-button lwb-button-sm', onClick: () => setCredentialOpen(true) }, '打开连接配置保存 API Key')])
          : credential?.configured === true ? h(Callout, { tone: 'success', title: '媒体服务凭据已保存' },
            `API Key 在私有凭据库里${credential.writable ? '' : '（由启动环境管理，页面不能修改或清除）'}。试听通过就说明它真的能用。`)
            : null,
        // 连通性状态：只有真实试探过才下结论。
        mediaReady === 'unreachable' ? h(Callout, { tone: 'danger', title: '媒体服务连不上，现在配不了音' },
          '配音、字幕都走本机媒体桥接，地址来自启动环境变量，页面里改不了。上面那张卡片的「试听」已经给出了服务端的真实原因。',
          ['确认桥接在跑：计划任务 LWBKeepAlive 应为「就绪」，或手动执行仓库里的 lwb-keepalive.ps1。',
            '地址不对就改启动环境变量 LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL（默认 http://127.0.0.1:8199），改完重启工作台。',
            '两者都确认过还是不通，就把试听报的原因发给团队群——那是服务端原话，比「连不上」有用。'])
          : mediaReady === 'ready' ? h(Callout, { tone: 'success', title: '媒体服务已就绪' },
            '试听已经通过：桥接能合成音频，可以直接开始制作。')
            : h(Callout, { tone: 'info', title: '配音走本机媒体桥接' },
              '地址来自启动环境变量 LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL（默认 http://127.0.0.1:8199）。点下面任意一张卡片的「试听」，可以立刻验证它通不通。'),
        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-field' }, h('span', null, '声音方案'),
            recipes.length
              ? h('div', { className: 'sa-recipe-grid' }, recipes.map((recipe) => {
                const result = previews[recipe.id];
                return h('div', { key: recipe.id, className: 'sa-recipe', 'data-on': recipeId === recipe.id ? 'true' : 'false' },
                  h('button', {
                    type: 'button', className: 'sa-recipe-main',
                    'aria-pressed': recipeId === recipe.id ? 'true' : 'false',
                    onClick: () => setRecipeId(recipe.id),
                  }, h('strong', null, recipe.label), h('span', null, recipe.hint)),
                  h('div', { className: 'sa-recipe-foot' },
                    h('span', { className: 'sa-recipe-voice' }, recipe.summary || `语速 ${recipe.rate}`),
                    h('button', {
                      type: 'button', className: 'sa-recipe-preview',
                      disabled: previewBusy === recipe.id,
                      title: `试听「${recipe.label}」`,
                      onClick: () => { void preview(recipe); },
                    }, previewBusy === recipe.id ? '合成中…' : '▶ 试听'),
                  ),
                  // 试听结果就地挂在那张卡上：音频能播就是通了，不能播就连原因一起显示。
                  result?.audioUrl ? h('audio', { controls: true, preload: 'none', src: result.audioUrl }) : null,
                  result && result.ok === false ? h('p', { className: 'sa-blocker' }, result.reason) : null,
                );
              }))
              : h('p', { className: 'sa-hint' }, '正在读取声音方案…'),
          ),
          h('p', { className: 'sa-hint' }, '选一张卡就是配好音色、语气与语速。试听会真去合成一段，失败时会把服务端原因显示出来。'),
        ),
        h('section', { className: 'sa-card' },
          h('div', { className: 'sa-row' },
            h(Field, { label: '项目（需已完成稿件）' },
              scriptReady.length
                ? h('select', { value: projectId, onChange: (event) => setProjectId(event.target.value) },
                  scriptReady.map((item) => h('option', { key: item.id, value: item.id }, item.title)))
                : h('select', { disabled: true }, h('option', null, '还没有完成稿件的项目')),
            ),
            h(Field, { label: '画面配色' },
              h('select', { value: palette, onChange: (event) => setPalette(event.target.value) },
                PALETTES.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
            h(Field, { label: '语速（情感故事建议 0.88-0.96）' },
              h('input', {
                type: 'number', min: 0.8, max: 1.15, step: 0.01, value: rate,
                onChange: (event) => setRate(Number(event.target.value)),
              })),
          ),
          h('p', { className: 'sa-hint' }, '念快了会毁稿：故事要留出沉默的空间。'),
        ),
        generation ? h('section', { className: 'sa-card' },
          h('h3', null, generation.status === 'running'
            ? `流水线运行中（${done}/${generation.steps.length}）`
            : generation.status === 'success' ? '流水线完成' : generation.status === 'failed' ? '流水线未通过' : '排队中'),
          h(Steps, { steps: generation.steps, startedAt: generation.createdAt, finishedAt: generation.status === 'running' || generation.status === 'queued' ? null : generation.updatedAt }),
          generation.error ? h('p', { className: 'sa-blocker' }, generation.error) : null,
          generation.status === 'success'
            ? h('p', { className: 'sa-hint' }, '四个阶段产物已落库。下一步：质检闸门确认后生成发布资料。')
            : null,
        ) : null,
        h('p', { className: 'sa-hint' }, '媒体服务不可用时，这一步会明确失败并说明原因，不会静默跳过——静默跳过会让整条链在没有声音的情况下继续跑。'),
        credentialOpen ? h('div', { className: 'lwb-modal-backdrop', onClick: () => setCredentialOpen(false) },
          h('div', { className: 'lwb-card lwb-pack-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接配置', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'lwb-pack-detail-head' }, h('div', null,
              h('h2', { className: 'lwb-modal-title' }, '连接配置'),
              h('p', { className: 'lwb-modal-copy' }, 'API Key 保存到 DSH 私有凭据库，不会写入稿件、任务或浏览器存储。与「口播视频」包共用同一份密钥。'),
            )),
            h('div', { className: 'sa-field' }, h('span', null, '生成方式'), h('p', { className: 'sa-hint' }, '本机桥接（小米 MiMo）——配音与字幕都走它。')),
            h('label', { className: 'sa-field' }, h('span', null, '本机桥接 API Key'),
              h('input', {
                type: 'password', value: apiKey, maxLength: 512, autoComplete: 'off',
                placeholder: credential?.configured ? '已保存，输入新值可更新' : '输入 API Key',
                onChange: (event) => setApiKey(event.target.value),
              })),
            credentialError ? h('p', { className: 'sa-blocker', role: 'alert' }, credentialError) : null,
            h('p', { className: 'sa-hint' }, credential?.configured
              ? (credential.writable ? '密钥已保存，不会回显。' : '密钥由启动环境管理，当前页面不能修改或清除。')
              : '保存后，新建配音任务即可使用。'),
            h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'lwb-plain-button', disabled: credentialBusy === 'clear' || !credential?.configured || credential?.writable !== true, onClick: () => { void clearCredential(); } }, credentialBusy === 'clear' ? '正在清除…' : '清除已保存密钥'),
              h('button', { type: 'button', className: 'lwb-primary-button', disabled: credentialBusy === 'save' || !apiKey.trim() || credential?.writable === false, onClick: () => { void saveCredential(); } }, credentialBusy === 'save' ? '正在保存…' : '保存连接'),
            ),
          ),
        ) : null,
      );
    }

    /* ------------------------------ 竖屏成片页 ------------------------------ */

    function VideoPreviewPage() {
      const projects = useRemoteValue(() => remote('list'), []);
      const action = useAction();
      const [projectId, setProjectId] = React.useState('');
      const detail = useRemoteValue(() => (projectId ? remote('get', { projectId }) : Promise.resolve(null)), [projectId]);

      const withVideo = (projects.value || []).filter((item) => item.completedStages.includes('video'));
      const video = detail.value?.artifacts?.video?.data?.video || null;
      const subtitles = detail.value?.artifacts?.subtitles?.data || null;

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '竖屏成片',
          kicker: { label: '视频制作', tone: '#10b981' },
          copy: '成片是 1080×1920 / 30fps 的 Remotion 渲染结果。这一页只读：渲染在「配音与字幕」页的流水线里完成，这里用来核对规格与字幕。',
        }),
        h(ErrorLine, { error: action.error || detail.error }),
        h('section', { className: 'sa-card' },
          h(Field, { label: '项目' },
            withVideo.length
              ? h('select', { value: projectId, onChange: (event) => setProjectId(event.target.value) },
                h('option', { value: '' }, '请选择…'),
                withVideo.map((item) => h('option', { key: item.id, value: item.id }, item.title)))
              : h('select', { disabled: true }, h('option', null, '还没有渲染完成的成片')),
          ),
        ),
        video ? h('section', { className: 'sa-card' },
          h('h3', null, '成片规格'),
          h('div', { className: 'sa-row' },
            h(Chip, { tone: video.width === 1080 && video.height === 1920 ? 'good' : 'bad' }, `${video.width}×${video.height}`),
            h(Chip, { tone: Math.abs(video.fps - 30) < 0.1 ? 'good' : 'bad' }, `${video.fps}fps`),
            h(Chip, null, `${Number(video.durationSeconds || 0).toFixed(1)} 秒`),
            h(Chip, { tone: video.hasAudio ? 'good' : 'bad' }, video.hasAudio ? '有音轨' : '无音轨'),
          ),
          h('p', { className: 'sa-meta' }, `文件：${video.file}`),
          subtitles
            ? h('p', { className: 'sa-hint' }, `字幕 ${subtitles.cueCount} 条，${subtitles.mode === 'story-account/asr' ? '跟随画面节拍' : '按字数估算（建议听一遍）'}。`)
            : null,
        ) : null,
        !withVideo.length ? h(Empty, null, '还没有成片。先去「配音与字幕」页跑流水线。') : null,
      );
    }

    /* ------------------------------ 质检闸门页 ------------------------------ */

    function QcPage() {
      const projects = useRemoteValue(() => remote('list'), []);
      const [projectId, setProjectId] = React.useState('');
      const detail = useRemoteValue(() => (projectId ? remote('get', { projectId }) : Promise.resolve(null)), [projectId]);

      React.useEffect(() => {
        const items = projects.value || [];
        const ready = items.find((item) => item.completedStages.includes('qc'));
        if (!projectId && ready) setProjectId(ready.id);
      }, [projects.value, projectId]);

      const qc = detail.value?.artifacts?.qc?.data || null;
      const technical = qc?.technical || null;
      const review = qc?.review || null;
      const antiPlastic = qc?.antiPlastic || null;
      // 人工放行审计：质检产物里单列了放行记录。放行必须留痕且看得见——
      // 悄悄放过比拦住更危险。原始 blocking 原样保留，放行只作用于最终闸门。
      const overrides = qc?.antiPlasticOverrides || [];
      const [qcOverride, setQcOverride] = React.useState(null);
      const [qcOverrideBusy, setQcOverrideBusy] = React.useState(false);
      const [qcOverrideError, setQcOverrideError] = React.useState(null);
      const [qcOperator, setQcOperator] = React.useState(() => {
        try { return window.localStorage.getItem('sa-operator') || ''; } catch (caught) { return ''; }
      });

      const applyQcOverride = async () => {
        setQcOverrideBusy(true);
        setQcOverrideError(null);
        try {
          if (!projectId) throw new Error('请先选择项目。');
          const picked = (qcOverride?.picked || []).filter((item) => !overrides.some((entry) => entry.blocker === item));
          if (!picked.length) throw new Error('请至少勾选一条要放行的硬拦项。');
          const who = (qcOverride?.operator || '').trim();
          if (!who) throw new Error('必须填操作者：审计记录要能回答「是谁批准的」。');
          const reason = (qcOverride?.reason || '').trim();
          if (reason.length < 4) throw new Error('放行理由至少写 4 个字：这条记录会进审计，写「知道」等于没写。');
          for (const blocker of picked) {
            await remote('overrideAntiPlastic', { projectId, blocker, operator: who, reason });
          }
          try { window.localStorage.setItem('sa-operator', who); } catch (caught) { /* 记不住不阻塞 */ }
          setQcOperator(who);
          setQcOverride(null);
          detail.reload();
        } catch (caught) {
          setQcOverrideError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setQcOverrideBusy(false);
        }
      };

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '质检闸门',
          kicker: { label: '质检', tone: '#ef4444' },
          copy: '两个闸门是「与」不是「或」：技术不过，审片说破天也不通过；审片发现 blocker，分数再高也不通过。任一不过则不能生成发布资料。',
        }),
        h(ErrorLine, { error: detail.error }),
        h('section', { className: 'sa-card' },
          h(Field, { label: '项目' },
            (projects.value || []).length
              ? h('select', { value: projectId, onChange: (event) => setProjectId(event.target.value) },
                h('option', { value: '' }, '请选择…'),
                (projects.value || []).map((item) => h('option', { key: item.id, value: item.id }, item.title)))
              : h('select', { disabled: true }, h('option', null, '还没有项目')),
          ),
        ),
        overrides.length ? h('div', { className: 'sa-override', role: 'status' },
          h('strong', null, `本条经人工放行 ${overrides.length} 条`),
          overrides.map((item, index) => h('div', { key: item.id || index },
            h('p', { className: 'sa-override-reason' }, `已放行：${item.blocker}`),
            h('span', { className: 'sa-meta' }, `${item.operator || '未署名'} · ${item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'} · ${item.reason || '未填写理由'}`),
          )),
          h('p', { className: 'sa-hint' }, '原始反塑料感报告里的硬拦项原样保留，放行只作用于最终闸门判定。'),
        ) : null,
        antiPlastic?.blocking?.length ? h('article', { className: 'sa-card' },
          h('h3', null, '反塑料感'),
          h('p', null, h(Chip, { tone: antiPlastic.blocking.length ? 'warn' : 'good' }, `硬拦项 ${antiPlastic.blocking.length} 条`)),
          h('ul', { className: 'sa-list' }, antiPlastic.blocking.map((item, index) => {
            const done = overrides.some((entry) => entry.blocker === item);
            return h('li', { key: index, className: done ? 'sa-hint' : 'sa-blocker' }, done ? `已放行：${item}` : item);
          })),
          h('div', { className: 'sa-actions' },
            h('button', { type: 'button', className: 'sa-plain', disabled: Boolean(qcOverrideBusy), onClick: () => setQcOverride({ operator: qcOperator, reason: '', picked: [] }) }, '记录人工放行…'),
          ),
          h('p', { className: 'sa-hint' }, '放行逐条记录并进审计；已放行的条目不参与最终闸门判定，但报告里原样保留。'),
        ) : null,
        qcOverride ? h('div', { className: 'lwb-modal-backdrop', onClick: () => { if (!qcOverrideBusy) setQcOverride(null); } },
          h('div', { className: 'lwb-card lwb-pack-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': '记录人工放行', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'lwb-pack-detail-head' }, h('div', null,
              h('h2', { className: 'lwb-modal-title' }, '记录人工放行'),
              h('p', { className: 'lwb-modal-copy' }, '操作者 + 理由 + 放行了哪一条，都会写进审计记录，本页与写稿页都看得到。'),
            )),
            h(Field, { label: '操作者（谁批准的）' }, h('input', {
              value: qcOverride.operator, maxLength: 60, autoComplete: 'off',
              placeholder: '例如：李发发 / 工号',
              onChange: (event) => setQcOverride({ ...qcOverride, operator: event.target.value }),
            })),
            h(Field, { label: '放行理由' }, h('textarea', {
              style: { minHeight: 84 }, value: qcOverride.reason, maxLength: 300,
              placeholder: '例如：客户认可这个结尾，保留升华句',
              onChange: (event) => setQcOverride({ ...qcOverride, reason: event.target.value }),
            })),
            h('p', { className: 'sa-hint' }, '勾选要放行的硬拦项：'),
            h('div', { className: 'sa-list' }, antiPlastic.blocking.map((item, index) => {
              const done = overrides.some((entry) => entry.blocker === item);
              return h('label', { key: index, className: 'sa-check' },
                h('input', {
                  type: 'checkbox', checked: done || (qcOverride.picked || []).includes(item), disabled: done,
                  onChange: (event) => setQcOverride((current) => ({
                    ...current,
                    picked: event.target.checked
                      ? [...(current.picked || []), item]
                      : (current.picked || []).filter((entry) => entry !== item),
                  })),
                }),
                h('span', null, done ? `${item}（已放行）` : item),
              );
            })),
            qcOverrideError ? h('p', { className: 'sa-blocker', role: 'alert' }, qcOverrideError) : null,
            h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'lwb-plain-button', disabled: qcOverrideBusy, onClick: () => setQcOverride(null) }, '取消'),
              h('button', {
                type: 'button', className: 'lwb-primary-button',
                disabled: qcOverrideBusy || !(qcOverride.operator || '').trim() || (qcOverride.reason || '').trim().length < 4,
                onClick: () => { void applyQcOverride(); },
              }, qcOverrideBusy ? '记录中…' : '确认放行'),
            ),
          ),
        ) : null,
        qc ? h('div', { className: 'sa-grid two' },
          h('article', { className: 'sa-card' },
            h('h3', null, '技术闸门'),
            h('p', null, technical?.passed ? h(Chip, { tone: 'good' }, '通过') : h(Chip, { tone: 'bad' }, '不通过')),
            technical?.issues?.length
              ? h('ul', { className: 'sa-list' }, technical.issues.map((item, index) => h('li', { key: index, className: 'sa-blocker' }, item)))
              : h('p', { className: 'sa-hint' }, '没有技术问题：分辨率、帧率、音轨、字幕与音画时长差均符合要求。'),
            technical?.warnings?.length
              ? h('div', null, h('p', { className: 'sa-hint' }, '警告（不拦截）：'),
                h('ul', { className: 'sa-list' }, technical.warnings.map((item, index) => h('li', { key: index, className: 'sa-hint' }, `· ${item}`))))
              : null,
          ),
          h('article', { className: 'sa-card' },
            h('h3', null, '独立审片'),
            h('p', null, review?.passed ? h(Chip, { tone: 'good' }, `通过 · ${review.score} 分`) : h(Chip, { tone: 'bad' }, `不通过 · ${review?.score ?? 0} 分`)),
            review?.summary ? h('p', { className: 'sa-quote' }, review.summary) : null,
            review?.findings?.length
              ? h('ul', { className: 'sa-list' }, review.findings.map((item, index) => h('li', { key: index, className: 'sa-hint' },
                `${item.severity === 'blocker' ? '⛔' : item.severity === 'major' ? '⚠️' : '·'} ${item.timestampSeconds != null ? `${item.timestampSeconds}s ` : ''}${item.message}`)))
              : h('p', { className: 'sa-hint' }, '审片没有提出问题。'),
            review?.reviewEvidence?.length
              ? h('div', null,
                h('p', { className: 'sa-hint' }, '审片证据（模型实际看到了什么）：'),
                h('ul', { className: 'sa-list' }, review.reviewEvidence.map((item, index) => h('li', { key: index, className: 'sa-hint' },
                  `${item.timestampSeconds}s — ${item.observedMainVisual}`))))
              : null,
          ),
        ) : null,
        !qc && projectId ? h(Empty, null, '这个项目还没有质检记录。先去「配音与字幕」页跑流水线。') : null,
      );
    }

    /* ------------------------------ 发布资料页 ------------------------------ */

    function PublishPage() {
      const projects = useRemoteValue(() => remote('list'), []);
      const action = useAction();
      const [projectId, setProjectId] = React.useState('');
      const detail = useRemoteValue(() => (projectId ? remote('get', { projectId }) : Promise.resolve(null)), [projectId]);
      const cover = useRemoteValue(() => (projectId ? remote('coverStatus', { projectId }) : Promise.resolve(null)), [projectId]);
      const [copied, setCopied] = React.useState(false);
      // 封面生成是同步阻塞的（本地 ffmpeg 叠大字，约几十秒）。按钮置灰之外，
      // 再给一个走动的计时，让人知道它还在动、大概等了多久。
      const [coverStartedAt, setCoverStartedAt] = React.useState(null);
      const coverElapsed = useElapsed(action.busy === 'cover' ? coverStartedAt : null, null);

      const passed = (projects.value || []).filter((item) => item.qcPassed);
      React.useEffect(() => {
        if (!projectId && passed.length) setProjectId(passed[0].id);
      }, [projects.value, projectId]);

      const packaging = detail.value?.artifacts?.packaging?.data || null;

      const generateCover = () => action.run('cover', async () => {
        if (!packaging?.coverHeadline) return;
        setCoverStartedAt(new Date().toISOString());
        try {
          // generateCover 现在只建任务就返回，ffmpeg 叠大字在后台跑（可能几十秒），
          // 所以这里轮询 coverStatus 到终态，按钮与计时在等待期间一直有反馈。
          const started = await remote('generateCover', { projectId, headline: packaging.coverHeadline });
          if (!started?.id) { cover.reload(); return; }
          let final = null;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            final = await remote('coverStatus', { id: started.id });
            if (final?.status === 'success' || final?.status === 'failed') break;
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
          }
          if (!final || (final.status !== 'success' && final.status !== 'failed')) {
            throw new Error('封面生成等得太久了。刷新本页看看是否已经生成——后台任务不受关闭影响。');
          }
          if (final.status !== 'success') throw new Error(final.error || '封面没有生成，服务端没给原因。');
          cover.reload();
        } finally {
          setCoverStartedAt(null);
        }
      });

      const copyAll = () => {
        const text = [
          packaging?.title || '',
          '',
          packaging?.copy || '',
          '',
          packaging?.description || '',
          '',
          (packaging?.tags || []).map((tag) => `#${tag}`).join(' '),
        ].join('\n').trim();
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        }, () => {});
      };

      return h('div', { className: 'sa-page' },
        h(Top, {
          title: '发布资料',
          kicker: { label: '发布资料', tone: '#ef4444' },
          copy: '只准备资料，不向任何平台直发。标题不剧透结局：给出结论，点击动机就没了。',
          actions: packaging ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'sa-plain', onClick: copyAll }, copied ? '已复制' : '复制全部'),
            h('button', { type: 'button', className: 'sa-primary', disabled: Boolean(action.busy), onClick: generateCover }, action.busy === 'cover' ? '生成中…' : '生成封面'),
          ) : null,
        }),
        h(ErrorLine, { error: action.error || detail.error || cover.error }),
        h('section', { className: 'sa-card' },
          h(Field, { label: '项目（仅列出已过质检的）' },
            passed.length
              ? h('select', { value: projectId, onChange: (event) => setProjectId(event.target.value) },
                passed.map((item) => h('option', { key: item.id, value: item.id }, item.title)))
              : h('select', { disabled: true }, h('option', null, '还没有通过质检的项目')),
          ),
          !passed.length ? h('p', { className: 'sa-hint' }, '质检未通过时不能生成发布资料——这是闸门，不是建议。') : null,
          action.busy === 'cover' ? h('p', { className: 'lwb-live', role: 'status' },
            h('span', { className: 'lwb-live-dot' }),
            h('span', { className: 'lwb-timer' }, `封面生成中${coverElapsed ? ` ${coverElapsed}` : ''}`),
            h('span', { className: 'sa-hint' }, '这一步是本地 ffmpeg 叠加大字，通常几十秒；期间不要关闭工作台。'),
          ) : null,
        ),
        packaging ? h('div', { className: 'sa-grid two' },
          h('article', { className: 'sa-card' },
            h('h3', null, '标题'),
            h('p', { className: 'sa-quote' }, packaging.title),
            h('h3', null, '文案'),
            h('p', { className: 'sa-quote' }, packaging.copy || '—'),
            h('h3', null, '描述'),
            h('p', { className: 'sa-quote' }, packaging.description || '—'),
            h('h3', null, '标签'),
            h('div', { className: 'sa-row' }, (packaging.tags || []).map((tag) => h(Chip, { key: tag }, `#${tag}`))),
          ),
          h('article', { className: 'sa-card' },
            h('h3', null, '封面'),
            h('p', { className: 'sa-hint' }, `封面大字：${packaging.coverHeadline}`),
            h('p', { className: 'sa-hint' }, `底图情绪：${packaging.coverMood}`),
            cover.value?.exists
              ? h('div', null,
                h('p', { className: 'sa-hint' }, `已生成：${cover.value.file}（${Math.round(cover.value.bytes / 1024)} KB）`),
                h('img', {
                  src: `/api/lwb/story-account/asset?path=${encodeURIComponent(cover.value.file)}`,
                  alt: '封面',
                  style: { width: '100%', borderRadius: 12, marginTop: 8 },
                  onError: (event) => { event.currentTarget.style.display = 'none'; },
                }))
              : h('p', { className: 'sa-hint' }, '还没有生成封面。封面大字由本地 ffmpeg 叠加，不走生图模型——中文交给模型会糊。'),
          ),
        ) : null,
        projectId && !packaging ? h(Empty, null, '这个项目还没有发布资料。发布资料由写稿上下文之外的独立会话生成。') : null,
        h('p', { className: 'sa-hint' }, '需要自动投递请加载「发布与账号管理」能力包；本包不做平台登录与直发。'),
      );
    }

    /* -------------------------------- 注册 -------------------------------- */

    async function apply(ctx) {
      connection = ctx.get('connection');
      installStyle();
      ctx.effect(() => ctx.lwbPackClient.register({
        packId: PACK_ID,
        pages: {
          pipeline: PipelinePage,
          positioning: PositioningPage,
          materials: MaterialsPage,
          topics: TopicsPage,
          scripts: ScriptsPage,
          'audio-captions': AudioCaptionsPage,
          'video-preview': VideoPreviewPage,
          qc: QcPage,
          publish: PublishPage,
        },
      }), 'story-account: register capability pages');
    }

    exports.inject = ['connection', 'lwbPackClient'];
    exports.apply = apply;
    return module.exports;
  },
});
