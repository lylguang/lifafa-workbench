window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-benchmark',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    let connection;
    const PACK_ID = 'benchmark';
    const PLUGIN_NAME = '@scitiger-ai/lwb-benchmark';
    const PLATFORM_OPTIONS = [
      { id: 'douyin', label: '抖音' }, { id: 'bilibili', label: 'B站' }, { id: 'xhs', label: '小红书' },
      { id: 'wechat', label: '视频号' }, { id: 'kuaishou', label: '快手' }, { id: 'toutiao', label: '今日头条' },
      { id: 'other', label: '其他' },
    ];
    const PLATFORM_LABEL = new Map(PLATFORM_OPTIONS.map((item) => [item.id, item.label]));

    const css = `
      .bm-page { display:grid; gap:18px; max-width:1420px; margin:0 auto; } .bm-page * { box-sizing:border-box; }
      .bm-top { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:14px; padding-bottom:14px; border-bottom:1px solid var(--lwb-line); }
      .bm-top h1, .bm-section h3 { margin:0; font-size:var(--lwb-text-section,18px); }
      .bm-top p, .bm-meta, .bm-card p { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .bm-section { display:grid; gap:11px; }
      .bm-section-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; }
      .bm-section-head span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .bm-card, .bm-form { display:grid; gap:9px; padding:14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .bm-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; } .bm-form-grid .bm-wide { grid-column:1/-1; }
      .bm-label { display:grid; gap:4px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .bm-input, .bm-textarea, .bm-select { width:100%; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-base,14px); }
      .bm-input, .bm-select { height:36px; padding:0 10px; } .bm-textarea { min-height:96px; padding:9px; resize:vertical; line-height:1.6; }
      .bm-input:focus, .bm-textarea:focus, .bm-select:focus { border-color:var(--lwb-blue); outline:0; box-shadow:0 0 0 2px var(--lwb-blue-soft); }
      .bm-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .bm-tag, .bm-pill { display:inline-flex; min-height:21px; flex:none; align-items:center; padding:0 7px; border-radius:5px; color:var(--lwb-blue); background:var(--lwb-blue-soft); font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; }
      .bm-pill[data-tone="green"] { color:var(--lwb-green); background:var(--lwb-green-soft); }
      .bm-pill[data-tone="orange"] { color:#7a5b17; background:#fff4dd; }
      .bm-pill[data-tone="red"] { color:#a94343; background:#ffecec; }
      .bm-pill[data-tone="muted"] { color:var(--lwb-muted); background:var(--lwb-line); }
      .bm-error, .bm-note { margin:0; padding:10px 11px; border:1px solid #e6b5b5; border-radius:7px; color:#994646; background:#fff7f7; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .bm-note { border-color:#bad5ed; color:#486277; background:#f7fbff; }
      .bm-empty { padding:34px 12px; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); text-align:center; border:1px dashed var(--lwb-line); border-radius:9px; }
      .bm-list { display:grid; gap:8px; }
      .bm-card-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:9px; }
      .bm-card-title { overflow:hidden; font-size:var(--lwb-text-md,15px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .bm-tag-row { display:flex; flex-wrap:wrap; gap:5px; }
      .bm-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .bm-toolbar .bm-input, .bm-toolbar .bm-select { width:auto; min-width:150px; }
      .bm-analysis { display:grid; gap:12px; padding:12px; border:1px dashed var(--lwb-line); border-radius:8px; background:var(--lwb-surface); }
      .bm-analysis h4 { margin:0; font-size:var(--lwb-text-base,14px); color:var(--lwb-muted); font-weight:700; }
      .bm-score { display:flex; align-items:center; gap:9px; } .bm-score-track { flex:1; height:7px; border-radius:99px; background:var(--lwb-line); overflow:hidden; } .bm-score-fill { height:100%; border-radius:99px; background:linear-gradient(90deg,var(--lwb-blue),var(--lwb-green)); }
      .bm-steps { display:grid; gap:7px; margin:0; padding-left:20px; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.55; }
      .bm-checklist { display:grid; gap:6px; margin:0; padding-left:20px; font-size:var(--lwb-text-base,14px); line-height:1.55; }
      .bm-quote { margin:0; padding:9px 11px; border-left:3px solid var(--lwb-blue); border-radius:0 7px 7px 0; background:var(--lwb-blue-soft); color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .bm-backdrop { position:fixed; z-index:40; inset:0; display:grid; place-items:center; border:0; background:rgba(24,39,52,.35); }
      .bm-modal { display:grid; gap:10px; width:min(440px,calc(100vw - 48px)); padding:18px; border:1px solid var(--lwb-line); border-radius:11px; background:var(--lwb-surface); box-shadow:0 18px 48px rgba(23,47,70,.22); }
      .bm-modal h3 { margin:0; font-size:var(--lwb-text-md,15px); } .bm-modal p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .bm-danger { border:1px solid #d98c8c; border-radius:6px; padding:0 14px; height:34px; color:#a94343; background:#fff1f1; cursor:pointer; font:inherit; font-size:var(--lwb-text-base,14px); font-weight:700; }
      body[data-ds-dark-theme] .bm-error { border-color:#7a4444; color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .bm-note { border-color:#2c5578; color:#a9c9e6; background:#16324a; }
      body[data-ds-dark-theme] .bm-pill[data-tone="orange"] { color:#e8d9a9; background:#332b1b; }
      body[data-ds-dark-theme] .bm-pill[data-tone="red"] { color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .bm-danger { border-color:#7a4444; color:#e8b9b9; background:#3a2323; }
    `;

    function installStyle() {
      const existing = document.getElementById('lwb-benchmark-style');
      // A pack can be reloaded in place by the workbench. Replace old rules so
      // updated page layouts do not remain pinned to the earlier bundle's CSS.
      if (existing) { existing.setAttribute('data-plugin', PLUGIN_NAME); existing.textContent = css; return; }
      const style = document.createElement('style');
      style.id = 'lwb-benchmark-style';
      style.setAttribute('data-plugin', PLUGIN_NAME);
      style.textContent = css;
      document.head.appendChild(style);
    }

    async function remote(method, request) {
      if (!connection?.rpc?.call) throw new Error('工作台连接尚未就绪。');
      const response = await connection.rpc.call('/api', `benchmark/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '对标拆解操作未完成。');
      return response.value;
    }

    function formatTime(iso) {
      if (!iso) return '';
      const timestamp = Date.parse(iso);
      if (!Number.isFinite(timestamp)) return '';
      const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      const day = new Date(timestamp);
      return `${day.getMonth() + 1} 月 ${day.getDate()} 日`;
    }

    function ErrorNotice({ error }) {
      return error ? h('p', { className: 'bm-error' }, error) : null;
    }

    function EmptyState({ text }) {
      return h('div', { className: 'bm-empty' }, text);
    }

    function TagRow({ tags }) {
      const list = Array.isArray(tags) ? tags : [];
      return list.length ? h('div', { className: 'bm-tag-row' }, list.map((tag) => h('span', { key: tag, className: 'bm-tag' }, tag))) : null;
    }

    function StatusPill({ status }) {
      const map = { analyzing: ['拆解中…', 'orange'], completed: ['已完成', 'green'], failed: ['失败', 'red'], running: ['生成中…', 'orange'] };
      const [label, tone] = map[status] || [status || '未知', 'muted'];
      return h('span', { className: 'bm-pill', 'data-tone': tone }, label);
    }

    function useConfirm() {
      const [state, setState] = React.useState(null);
      const ask = React.useCallback((options) => setState(options), []);
      const close = React.useCallback(() => setState(null), []);
      const confirmNode = state ? h('div', { className: 'bm-backdrop', onClick: close },
        h('div', { className: 'bm-modal', role: 'dialog', 'aria-modal': 'true', onClick: (event) => event.stopPropagation() },
          h('h3', null, state.title || '请确认'),
          h('p', null, state.copy || ''),
          h('div', { className: 'bm-actions' },
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: close }, '取消'),
            h('button', { type: 'button', className: state.danger ? 'bm-danger' : 'lwb-primary-button', onClick: () => { close(); state.onConfirm?.(); } }, state.confirm || '确定'),
          ),
        )) : null;
      return { ask, confirmNode };
    }

    // 轮询只在有进行中任务时启用；reload 通过 ref 传递避免闭包过期。
    function usePolling(reload, active) {
      const reloadRef = React.useRef(reload);
      reloadRef.current = reload;
      React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => { void reloadRef.current?.(); }, 2500);
        return () => clearInterval(timer);
      }, [active]);
      return null;
    }

    function useAsyncData(loader) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const loaderRef = React.useRef(loader);
      loaderRef.current = loader;
      const reload = React.useCallback(async (silent = false) => {
        if (!silent) setError(null);
        try {
          const value = await loaderRef.current();
          setData(value);
          setError(null);
        } catch (cause) {
          if (!silent) setError(cause.message || String(cause));
        }
      }, []);
      React.useEffect(() => { void reload(); }, [reload]);
      return { data, error, reload, setError };
    }

    function accountNameOf(accountId, accounts) {
      if (!accountId) return null;
      const found = (accounts || []).find((item) => item.id === accountId);
      return found ? found.name : '已删除账号';
    }

    function PlatformSelect({ value, onChange, allowEmpty = false, disabled = false }) {
      return h('select', { className: 'bm-select', value, disabled, onChange: (event) => onChange(event.target.value) },
        allowEmpty ? h('option', { value: '' }, '跟随账号 / 未指定') : null,
        PLATFORM_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
      );
    }

    function parseTagsInput(value) {
      return String(value || '').split(/[,，、\s]+/u).map((item) => item.trim()).filter(Boolean);
    }

    /* ---------------- 对标账号 ---------------- */

    function AccountsPage() {
      const { data, error, reload, setError } = useAsyncData(() => remote('listAccounts'));
      const { ask, confirmNode } = useConfirm();
      const [busy, setBusy] = React.useState('');
      const [editing, setEditing] = React.useState(null);
      const [form, setForm] = React.useState({ platform: 'douyin', name: '', url: '', note: '', tags: '' });
      const accounts = data || [];
      const patchForm = (patch) => setForm((current) => ({ ...current, ...patch }));

      const submit = async () => {
        if (busy) return;
        setBusy('save');
        try {
          const payload = { platform: form.platform, name: form.name, url: form.url || undefined, note: form.note || undefined, tags: parseTagsInput(form.tags) };
          if (editing) await remote('updateAccount', { id: editing, ...payload });
          else await remote('createAccount', payload);
          setEditing(null);
          setForm({ platform: form.platform, name: '', url: '', note: '', tags: '' });
          await reload();
        } catch (cause) { setError(cause.message); } finally { setBusy(''); }
      };

      const remove = (account) => ask({
        title: '删除对标账号？',
        copy: `删除「${account.name}」只移除账号登记；已产生的拆解记录会保留，并显示为“已删除账号”。`,
        confirm: '删除', danger: true,
        onConfirm: () => { void remote('deleteAccount', { id: account.id }).then(reload).catch((cause) => setError(cause.message)); },
      });

      const startEdit = (account) => {
        setEditing(account.id);
        setForm({ platform: account.platform, name: account.name, url: account.url || '', note: account.note || '', tags: (account.tags || []).join('、') });
      };

      return h('div', { className: 'bm-page' },
        h('div', { className: 'bm-top' },
          h('div', null, h('h1', null, '对标账号'), h('p', null, '登记值得持续学习的账号与博主，标注平台和学习方向；后续版本的自动更新追踪会基于这里的登记进行。')),
          h('span', { className: 'bm-pill', 'data-tone': 'muted' }, `共 ${accounts.length} 个`),
        ),
        h(ErrorNotice, { error }),
        h('div', { className: 'bm-form' },
          h('h3', null, editing ? '编辑对标账号' : '添加对标账号'),
          h('div', { className: 'bm-form-grid' },
            h('label', { className: 'bm-label' }, '平台', h(PlatformSelect, { value: form.platform, onChange: (platform) => patchForm({ platform }) })),
            h('label', { className: 'bm-label' }, '账号名称 *', h('input', { className: 'bm-input', value: form.name, maxLength: 80, placeholder: '如：某某说 AI', onChange: (event) => patchForm({ name: event.target.value }) })),
            h('label', { className: 'bm-label' }, '主页链接（选填）', h('input', { className: 'bm-input', value: form.url, placeholder: 'https://…', onChange: (event) => patchForm({ url: event.target.value }) })),
            h('label', { className: 'bm-label' }, '标签（选填，用顿号分隔）', h('input', { className: 'bm-input', value: form.tags, placeholder: '口播、AI 解读', onChange: (event) => patchForm({ tags: event.target.value }) })),
            h('label', { className: 'bm-label bm-wide' }, '学习方向备注（选填）', h('textarea', { className: 'bm-textarea', style: { minHeight: '58px' }, value: form.note, maxLength: 600, placeholder: '例如：主要学习它的开头钩子和选题角度', onChange: (event) => patchForm({ note: event.target.value }) })),
          ),
          h('div', { className: 'bm-actions' },
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || !form.name.trim(), onClick: submit }, busy === 'save' ? '正在保存…' : editing ? '保存修改' : '添加账号'),
            editing ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => { setEditing(null); setForm({ platform: form.platform, name: '', url: '', note: '', tags: '' }); } }, '取消编辑') : null,
          ),
        ),
        !accounts.length ? h(EmptyState, { text: '还没有对标账号。先添加 1-3 个你想学习的账号，再去「爆款拆解」录入它们的内容。' })
          : h('div', { className: 'bm-list' }, accounts.map((account) => h('div', { key: account.id, className: 'bm-card' },
            h('div', { className: 'bm-card-head' },
              h('div', null,
                h('div', { className: 'bm-card-title' }, account.name),
                h('p', { className: 'bm-meta' }, `${PLATFORM_LABEL.get(account.platform) || account.platform} · 登记于 ${formatTime(account.createdAt)}`),
              ),
              h('div', { className: 'bm-actions' },
                h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => startEdit(account) }, '编辑'),
                h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => remove(account) }, '删除'),
              ),
            ),
            account.url ? h('a', { href: account.url, target: '_blank', rel: 'noreferrer', className: 'bm-note' }, account.url) : null,
            account.note ? h('p', null, account.note) : null,
            h(TagRow, { tags: account.tags }),
          ))),
        confirmNode,
      );
    }

    /* ---------------- 爆款拆解 ---------------- */

    function AnalysisView({ analysis }) {
      if (!analysis) return null;
      return h('div', { className: 'bm-analysis' },
        h('div', { className: 'bm-score' },
          h('h4', null, '传播力'),
          h('div', { className: 'bm-score-track' }, h('div', { className: 'bm-score-fill', style: { width: `${Math.max(3, analysis.viralityScore)}%` } })),
          h('strong', null, `${analysis.viralityScore}`),
        ),
        h('p', null, analysis.summary),
        h('div', null,
          h('h4', null, '开头钩子'),
          h('p', null, h('span', { className: 'bm-pill' }, analysis.hookType), analysis.hookQuote ? h('blockquote', { className: 'bm-quote', style: { marginTop: '7px' } }, analysis.hookQuote) : null),
        ),
        analysis.structure?.length ? h('div', null,
          h('h4', null, '内容结构'),
          h('ol', { className: 'bm-steps' }, analysis.structure.map((item, index) => h('li', { key: index }, h('strong', null, item.segment), ' —— ', item.purpose))),
        ) : null,
        analysis.pacing ? h('div', null, h('h4', null, '节奏与信息密度'), h('p', null, analysis.pacing)) : null,
        analysis.titleFormulas?.length ? h('div', null,
          h('h4', null, '标题公式'),
          h('div', { className: 'bm-tag-row' }, analysis.titleFormulas.map((formula) => h('span', { key: formula, className: 'bm-tag' }, formula))),
        ) : null,
        analysis.commentInsight ? h('div', null, h('h4', null, '受众与评论区洞察'), h('p', null, analysis.commentInsight)) : null,
        analysis.reusable?.length ? h('div', null,
          h('h4', null, '可复用清单'),
          h('ul', { className: 'bm-checklist' }, analysis.reusable.map((item) => h('li', { key: item }, item))),
        ) : null,
      );
    }

    function TeardownsPage() {
      const teardownsData = useAsyncData(() => remote('listTeardowns'));
      const accountsData = useAsyncData(() => remote('listAccounts'));
      const { ask, confirmNode } = useConfirm();
      const [busy, setBusy] = React.useState('');
      const [expanded, setExpanded] = React.useState({});
      const [form, setForm] = React.useState({ accountId: '', title: '', url: '', content: '', views: '', likes: '', comments: '', favorites: '', tags: '' });
      const teardowns = teardownsData.data || [];
      const accounts = accountsData.data || [];
      const running = teardowns.some((item) => item.status === 'analyzing');
      usePolling(teardownsData.reload, running);
      const patchForm = (patch) => setForm((current) => ({ ...current, ...patch }));
      const selectedAccount = accounts.find((item) => item.id === form.accountId);

      const submit = async () => {
        if (busy || !form.title.trim() || !form.content.trim()) return;
        setBusy('start');
        try {
          const payload = {
            accountId: form.accountId || undefined,
            platform: selectedAccount?.platform || undefined,
            title: form.title,
            url: form.url || undefined,
            content: form.content,
            tags: parseTagsInput(form.tags),
          };
          const stats = { views: form.views, likes: form.likes, comments: form.comments, favorites: form.favorites };
          if (Object.values(stats).some((value) => String(value).trim() !== '')) payload.stats = stats;
          const result = await remote('startTeardown', payload);
          setForm({ accountId: form.accountId, title: '', url: '', content: '', views: '', likes: '', comments: '', favorites: '', tags: '' });
          await teardownsData.reload();
          if (result?.teardownId) setExpanded((current) => ({ ...current, [result.teardownId]: true }));
        } catch (cause) { teardownsData.setError(cause.message); } finally { setBusy(''); }
      };

      const remove = (record) => ask({
        title: '删除拆解记录？',
        copy: `「${record.title}」的拆解结果会一并删除，不可恢复。`,
        confirm: '删除', danger: true,
        onConfirm: () => { void remote('deleteTeardown', { id: record.id }).then(() => teardownsData.reload()).catch((cause) => teardownsData.setError(cause.message)); },
      });

      const toggle = (id) => setExpanded((current) => ({ ...current, [id]: !current[id] }));

      return h('div', { className: 'bm-page' },
        h('div', { className: 'bm-top' },
          h('div', null, h('h1', null, '爆款拆解'), h('p', null, '把对标账号的爆款内容粘贴进来（标题 + 文案，可附数据和链接），AI 会拆解钩子、结构、节奏与标题套路，结果自动进入方法论库。')),
          h('span', { className: 'bm-pill', 'data-tone': 'muted' }, running ? 'AI 拆解进行中…' : `共 ${teardowns.length} 条`),
        ),
        h(ErrorNotice, { error: teardownsData.error }),
        h('div', { className: 'bm-form' },
          h('h3', null, '录入爆款内容'),
          h('div', { className: 'bm-form-grid' },
            h('label', { className: 'bm-label' }, '关联对标账号（选填）', h('select', { className: 'bm-select', value: form.accountId, onChange: (event) => patchForm({ accountId: event.target.value }) },
              h('option', { value: '' }, '不关联'),
              accounts.map((account) => h('option', { key: account.id, value: account.id }, `${account.name}（${PLATFORM_LABEL.get(account.platform) || account.platform}）`)),
            )),
            h('label', { className: 'bm-label' }, '平台', selectedAccount ? h('input', { className: 'bm-input', value: PLATFORM_LABEL.get(selectedAccount.platform) || selectedAccount.platform, disabled: true }) : h(PlatformSelect, { value: form.platform || 'other', allowEmpty: false, onChange: (platform) => patchForm({ platform }) })),
            h('label', { className: 'bm-label bm-wide' }, '标题 *', h('input', { className: 'bm-input', value: form.title, maxLength: 200, placeholder: '爆款内容的标题或首句', onChange: (event) => patchForm({ title: event.target.value }) })),
            h('label', { className: 'bm-label bm-wide' }, '文案原文 *', h('textarea', { className: 'bm-textarea', style: { minHeight: '130px' }, value: form.content, maxLength: 20000, placeholder: '粘贴完整文案/口播稿/图文正文；越长拆解越准。', onChange: (event) => patchForm({ content: event.target.value }) })),
            h('label', { className: 'bm-label bm-wide' }, '内容链接（选填）', h('input', { className: 'bm-input', value: form.url, placeholder: 'https://…', onChange: (event) => patchForm({ url: event.target.value }) })),
            h('label', { className: 'bm-label' }, '播放/阅读', h('input', { className: 'bm-input', inputMode: 'numeric', value: form.views, onChange: (event) => patchForm({ views: event.target.value }) })),
            h('label', { className: 'bm-label' }, '点赞', h('input', { className: 'bm-input', inputMode: 'numeric', value: form.likes, onChange: (event) => patchForm({ likes: event.target.value }) })),
            h('label', { className: 'bm-label' }, '评论', h('input', { className: 'bm-input', inputMode: 'numeric', value: form.comments, onChange: (event) => patchForm({ comments: event.target.value }) })),
            h('label', { className: 'bm-label' }, '收藏', h('input', { className: 'bm-input', inputMode: 'numeric', value: form.favorites, onChange: (event) => patchForm({ favorites: event.target.value }) })),
            h('label', { className: 'bm-label bm-wide' }, '标签（选填，用顿号分隔）', h('input', { className: 'bm-input', value: form.tags, placeholder: 'AI 解读、口播', onChange: (event) => patchForm({ tags: event.target.value }) })),
          ),
          h('div', { className: 'bm-actions' },
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || !form.title.trim() || !form.content.trim(), onClick: submit }, busy === 'start' ? '正在启动拆解…' : '开始 AI 拆解'),
            h('span', { className: 'bm-meta' }, '拆解使用系统默认模型，约需几十秒，可离开页面等待。'),
          ),
        ),
        !teardowns.length ? h(EmptyState, { text: '还没有拆解记录。录入第一条爆款内容，开始积累你的方法论库。' })
          : h('div', { className: 'bm-list' }, teardowns.map((record) => {
            const isExpanded = Boolean(expanded[record.id]);
            return h('div', { key: record.id, className: 'bm-card' },
              h('div', { className: 'bm-card-head' },
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'bm-card-title' }, record.title),
                  h('p', { className: 'bm-meta' },
                    `${PLATFORM_LABEL.get(record.platform) || record.platform}`,
                    accountNameOf(record.accountId, accounts) ? ` · ${accountNameOf(record.accountId, accounts)}` : '',
                    ` · ${formatTime(record.createdAt)}`,
                    record.stats?.views != null ? ` · 播放 ${record.stats.views}` : '',
                  ),
                ),
                h('div', { className: 'bm-actions' },
                  h(StatusPill, { status: record.status }),
                  record.status === 'completed' ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => toggle(record.id) }, isExpanded ? '收起拆解' : '查看拆解') : null,
                  h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => remove(record) }, '删除'),
                ),
              ),
              record.status === 'failed' && record.error ? h('p', { className: 'bm-error' }, record.error) : null,
              record.status === 'analyzing' ? h('p', { className: 'bm-note' }, 'AI 正在拆解这条内容，完成后自动更新。') : null,
              isExpanded && record.status === 'completed' ? h(AnalysisView, { analysis: record.analysis }) : null,
              h(TagRow, { tags: record.tags }),
            );
          })),
        confirmNode,
      );
    }

    /* ---------------- 方法论库 ---------------- */

    function PatternsPage() {
      const { data, error } = useAsyncData(() => remote('listTeardowns'));
      const [query, setQuery] = React.useState('');
      const [platform, setPlatform] = React.useState('');
      const [tag, setTag] = React.useState('');
      const teardowns = (data || []).filter((item) => item.status === 'completed');
      const allTags = [...new Set(teardowns.flatMap((item) => item.tags || []))];
      const keyword = query.trim().toLowerCase();
      const filtered = teardowns.filter((item) => {
        if (platform && item.platform !== platform) return false;
        if (tag && !(item.tags || []).includes(tag)) return false;
        if (!keyword) return true;
        const haystack = [item.title, item.analysis?.summary, item.analysis?.hookType, item.analysis?.hookQuote, ...(item.analysis?.titleFormulas || []), ...(item.analysis?.reusable || [])].filter(Boolean).join('\n').toLowerCase();
        return haystack.includes(keyword);
      });

      return h('div', { className: 'bm-page' },
        h('div', { className: 'bm-top' },
          h('div', null, h('h1', null, '方法论库'), h('p', null, '所有已完成拆解自动沉淀在这里。写稿前来翻一翻：找钩子、找标题公式、找可复用的结构。')),
          h('span', { className: 'bm-pill', 'data-tone': 'muted' }, `${filtered.length} / ${teardowns.length} 条`),
        ),
        h(ErrorNotice, { error }),
        h('div', { className: 'bm-toolbar' },
          h('input', { className: 'bm-input', style: { flex: '1 1 220px' }, value: query, placeholder: '搜索关键词（钩子、公式、摘要…）', onChange: (event) => setQuery(event.target.value) }),
          h('select', { className: 'bm-select', value: platform, onChange: (event) => setPlatform(event.target.value) },
            h('option', { value: '' }, '全部平台'),
            PLATFORM_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
          ),
          h('select', { className: 'bm-select', value: tag, onChange: (event) => setTag(event.target.value) },
            h('option', { value: '' }, '全部标签'),
            allTags.map((item) => h('option', { key: item, value: item }, item)),
          ),
        ),
        !teardowns.length ? h(EmptyState, { text: '方法论库还是空的——先去「爆款拆解」完成第一条拆解。' })
          : !filtered.length ? h(EmptyState, { text: '没有匹配的方法论，换一个关键词试试。' })
            : h('div', { className: 'bm-list' }, filtered.map((record) => h('div', { key: record.id, className: 'bm-card' },
              h('div', { className: 'bm-card-head' },
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'bm-card-title' }, record.title),
                  h('p', { className: 'bm-meta' }, `${PLATFORM_LABEL.get(record.platform) || record.platform} · ${record.analysis?.hookType || ''} · 传播力 ${record.analysis?.viralityScore ?? 0} · ${formatTime(record.completedAt || record.createdAt)}`),
                ),
                record.url ? h('a', { href: record.url, target: '_blank', rel: 'noreferrer', className: 'lwb-plain-button' }, '看原文') : null,
              ),
              record.analysis?.summary ? h('p', null, record.analysis.summary) : null,
              record.analysis?.titleFormulas?.length ? h('div', { className: 'bm-tag-row' }, record.analysis.titleFormulas.map((formula) => h('span', { key: formula, className: 'bm-tag' }, formula))) : null,
              record.analysis?.reusable?.length ? h('ul', { className: 'bm-checklist' }, record.analysis.reusable.slice(0, 3).map((item) => h('li', { key: item }, item))) : null,
              h(TagRow, { tags: record.tags }),
            ))),
      );
    }

    /* ---------------- 选题启发 ---------------- */

    function InsightsPage() {
      const teardownsData = useAsyncData(() => remote('listTeardowns'));
      const batchesData = useAsyncData(() => remote('listSuggestionBatches'));
      const { ask, confirmNode } = useConfirm();
      const [selected, setSelected] = React.useState(() => new Set());
      const [busy, setBusy] = React.useState('');
      const [expanded, setExpanded] = React.useState({});
      const completed = (teardownsData.data || []).filter((item) => item.status === 'completed');
      const batches = batchesData.data || [];
      const running = batches.some((item) => item.status === 'running');
      usePolling(() => { void batchesData.reload(true); void teardownsData.reload(true); }, running);
      const toggle = (id) => setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else if (next.size < 8) next.add(id);
        return next;
      });

      const generate = () => ask({
        title: '生成选题建议？',
        copy: `基于选中的 ${selected.size} 条拆解结论，AI 会生成 5-8 条可直接执行的选题建议。使用系统默认模型。`,
        confirm: '生成',
        onConfirm: () => {
          setBusy('generate');
          void remote('startTopicSuggestions', { teardownIds: [...selected] })
            .then(() => { setSelected(new Set()); return batchesData.reload(); })
            .catch((cause) => batchesData.setError(cause.message))
            .finally(() => setBusy(''));
        },
      });

      return h('div', { className: 'bm-page' },
        h('div', { className: 'bm-top' },
          h('div', null, h('h1', null, '选题启发'), h('p', null, '挑几条拆解结论（最多 8 条），AI 会交叉组合出下一阶段可以直接开写的选题建议，每条都注明依据。')),
          h('span', { className: 'bm-pill', 'data-tone': 'muted' }, running ? '建议生成中…' : `已选 ${selected.size} / 8`),
        ),
        h(ErrorNotice, { error: teardownsData.error || batchesData.error }),
        h('div', { className: 'bm-form' },
          h('h3', null, '选择拆解依据'),
          !completed.length ? h(EmptyState, { text: '还没有完成的拆解。先去「爆款拆解」完成至少一条。' })
            : h('div', { className: 'bm-list' }, completed.map((record) => h('label', { key: record.id, className: 'bm-card', style: { cursor: 'pointer', gridAutoFlow: 'column', gridTemplateColumns: 'auto 1fr', alignItems: 'start', justifyContent: 'start' } },
              h('input', { type: 'checkbox', checked: selected.has(record.id), onChange: () => toggle(record.id), style: { marginTop: '4px' } }),
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'bm-card-title' }, record.title),
                h('p', { className: 'bm-meta' }, `${PLATFORM_LABEL.get(record.platform) || record.platform} · ${record.analysis?.hookType || ''} · 传播力 ${record.analysis?.viralityScore ?? 0}`),
              ),
            ))),
          h('div', { className: 'bm-actions' },
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || selected.size === 0 || running, onClick: generate }, busy === 'generate' ? '正在启动…' : '生成选题建议'),
            selected.size >= 8 ? h('span', { className: 'bm-meta' }, '一次最多 8 条，先用这 8 条生成，再选下一批。') : null,
          ),
        ),
        !batches.length ? h(EmptyState, { text: '还没有生成过选题建议。' })
          : h('div', { className: 'bm-section' },
            h('div', { className: 'bm-section-head' }, h('h3', null, '建议历史'), h('span', null, '最新在上')),
            batches.map((batch) => h('div', { key: batch.id, className: 'bm-card' },
              h('div', { className: 'bm-card-head' },
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'bm-card-title' }, `基于 ${batch.inputs?.length || 0} 条拆解 · ${formatTime(batch.createdAt)}`),
                  h('p', { className: 'bm-meta' }, (batch.inputs || []).map((item) => item.title).join('；')),
                ),
                h('div', { className: 'bm-actions' },
                  h(StatusPill, { status: batch.status }),
                  batch.status === 'completed' ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setExpanded((current) => ({ ...current, [batch.id]: !current[batch.id] })) }, expanded[batch.id] === false ? '展开建议' : '收起建议') : null,
                ),
              ),
              batch.status === 'failed' && batch.error ? h('p', { className: 'bm-error' }, batch.error) : null,
              batch.status === 'completed' && expanded[batch.id] !== false ? h('div', { className: 'bm-analysis' },
                (batch.suggestions || []).map((item, index) => h('div', { key: index },
                  h('div', { className: 'bm-card-title' }, `${index + 1}. ${item.title}`),
                  h('p', null, h('strong', null, '角度：'), item.angle),
                  h('p', null, h('strong', null, '依据：'), item.rationale),
                  item.basedOn?.length ? h('div', { className: 'bm-tag-row', style: { marginTop: '5px' } }, item.basedOn.map((title) => h('span', { key: title, className: 'bm-tag' }, title))) : null,
                )),
              ) : null,
            ))),
        confirmNode,
      );
    }

    async function apply(ctx) {
      connection = ctx.get('connection');
      installStyle();
      ctx.effect(() => ctx.lwbPackClient.register({
        packId: PACK_ID,
        pages: { accounts: AccountsPage, teardowns: TeardownsPage, patterns: PatternsPage, insights: InsightsPage },
      }), 'benchmark: register capability pages');
    }
    exports.inject = ['connection', 'lwbPackClient'];
    exports.apply = apply;
    return module.exports;
  },
});
