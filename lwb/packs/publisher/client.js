window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-publisher',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    let connection;
    const PACK_ID = 'publisher';
    const PLUGIN_NAME = '@scitiger-ai/lwb-publisher';

    const PLATFORM_OPTIONS = [
      { id: 'douyin', label: '抖音' },
      { id: 'wechat', label: '视频号' },
      { id: 'xhs', label: '小红书' },
      { id: 'bilibili', label: 'B站' },
      { id: 'kuaishou', label: '快手' },
    ];
    const PLATFORM_LABEL = new Map(PLATFORM_OPTIONS.map((item) => [item.id, item.label]));
    const JOB_LABEL = { queued: '排队中', running: '发布中', 'awaiting-confirm': '待确认', succeeded: '已提交', failed: '失败', cancelled: '已取消' };
    const JOB_TONE = { queued: 'muted', running: 'orange', 'awaiting-confirm': 'orange', succeeded: 'green', failed: 'red', cancelled: 'muted' };
    const PHASE_LABEL = {
      open: '打开上传页', upload: '上传视频', editor: '等待转码', metadata: '填写标题',
      cover: '上传封面', 'cover-skipped': '跳过封面', 'awaiting-confirm': '等待确认',
      submit: '提交发布', verify: '读回状态', done: '已完成', failed: '失败', cancelled: '已取消',
    };

    const css = `
      .pb-page { display:grid; gap:18px; max-width:1420px; margin:0 auto; } .pb-page * { box-sizing:border-box; }
      .pb-top { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:14px; padding-bottom:14px; border-bottom:1px solid var(--lwb-line); }
      .pb-top h1, .pb-section h3 { margin:0; font-size:var(--lwb-text-section,18px); }
      .pb-top p, .pb-meta, .pb-card p { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .pb-section { display:grid; gap:11px; }
      .pb-section-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; }
      .pb-section-head span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .pb-card, .pb-form { display:grid; gap:9px; padding:14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .pb-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; } .pb-form-grid .pb-wide { grid-column:1/-1; }
      .pb-label { display:grid; gap:4px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .pb-input, .pb-textarea, .pb-select { width:100%; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-base,14px); }
      .pb-input, .pb-select { height:36px; padding:0 10px; } .pb-textarea { min-height:88px; padding:9px; resize:vertical; line-height:1.6; }
      .pb-input:focus, .pb-textarea:focus, .pb-select:focus { border-color:var(--lwb-blue); outline:0; box-shadow:0 0 0 2px var(--lwb-blue-soft); }
      .pb-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .pb-pill { display:inline-flex; min-height:21px; flex:none; align-items:center; padding:0 7px; border-radius:5px; color:var(--lwb-blue); background:var(--lwb-blue-soft); font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; }
      .pb-pill[data-tone="green"] { color:var(--lwb-green); background:var(--lwb-green-soft); }
      .pb-pill[data-tone="orange"] { color:#7a5b17; background:#fff4dd; }
      .pb-pill[data-tone="red"] { color:#a94343; background:#ffecec; }
      .pb-pill[data-tone="muted"] { color:var(--lwb-muted); background:var(--lwb-line); }
      .pb-error, .pb-note { margin:0; padding:10px 11px; border:1px solid #e6b5b5; border-radius:7px; color:#994646; background:#fff7f7; font-size:var(--lwb-text-sm,13px); line-height:1.55; white-space:pre-wrap; }
      .pb-note { border-color:#bad5ed; color:#486277; background:#f7fbff; }
      .pb-warn { margin:0; padding:10px 11px; border:1px solid #e2c58a; border-radius:7px; color:#7a5b17; background:#fffaf0; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .pb-empty { padding:34px 12px; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); text-align:center; border:1px dashed var(--lwb-line); border-radius:9px; }
      .pb-list { display:grid; gap:8px; }
      .pb-card-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:9px; }
      .pb-card-title { overflow:hidden; font-size:var(--lwb-text-md,15px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .pb-avatar { display:grid; flex:none; width:38px; height:38px; place-items:center; border-radius:10px; color:#fff; background:var(--lwb-blue); font-size:var(--lwb-text-md,15px); font-weight:700; }
      .pb-account { display:grid; grid-template-columns:auto minmax(0,1fr); gap:11px; align-items:start; padding:13px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .pb-kv { display:grid; gap:3px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .pb-kv b { color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); font-weight:600; }
      .pb-steps { display:grid; gap:5px; margin:0; padding-left:18px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.6; }
      .pb-shelf { display:grid; gap:9px; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); }
      .pb-tile { display:grid; gap:8px; padding:12px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .pb-tile[data-ready="false"] { opacity:.72; }
      .pb-progress { height:5px; border-radius:99px; background:var(--lwb-line); overflow:hidden; }
      .pb-progress i { display:block; height:100%; border-radius:99px; background:linear-gradient(90deg,var(--lwb-blue),var(--lwb-green)); transition:width .3s ease; }
      .pb-backdrop { position:fixed; z-index:40; inset:0; display:grid; place-items:center; border:0; background:rgba(24,39,52,.35); }
      .pb-modal { display:grid; gap:10px; width:min(520px,calc(100vw - 48px)); max-height:calc(100vh - 80px); overflow:auto; padding:18px; border:1px solid var(--lwb-line); border-radius:11px; background:var(--lwb-surface); box-shadow:0 18px 48px rgba(23,47,70,.22); }
      .pb-modal h3 { margin:0; font-size:var(--lwb-text-md,15px); } .pb-modal p { margin:0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .pb-danger { border:1px solid #d98c8c; border-radius:6px; padding:0 14px; height:34px; color:#a94343; background:#fff1f1; cursor:pointer; font:inherit; font-size:var(--lwb-text-base,14px); font-weight:700; }
      .pb-shot { width:100%; border:1px solid var(--lwb-line); border-radius:7px; background:#fff; }
      .pb-mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
      body[data-ds-dark-theme] .pb-error { border-color:#7a4444; color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .pb-note { border-color:#2c5578; color:#a9c9e6; background:#16324a; }
      body[data-ds-dark-theme] .pb-warn { border-color:#6b5a2c; color:#e8d9a9; background:#332b1b; }
      body[data-ds-dark-theme] .pb-pill[data-tone="orange"] { color:#e8d9a9; background:#332b1b; }
      body[data-ds-dark-theme] .pb-pill[data-tone="red"] { color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .pb-danger { border-color:#7a4444; color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .pb-shot { background:#111; }
    `;

    function installStyle() {
      const existing = document.getElementById('lwb-publisher-style');
      // Packages can be reloaded in place; replace old rules so an updated
      // layout is not pinned to the previous bundle's CSS.
      if (existing) { existing.setAttribute('data-plugin', PLUGIN_NAME); existing.textContent = css; return; }
      const style = document.createElement('style');
      style.id = 'lwb-publisher-style';
      style.setAttribute('data-plugin', PLUGIN_NAME);
      style.textContent = css;
      document.head.appendChild(style);
    }

    async function remote(method, request) {
      if (!connection?.rpc?.call) throw new Error('工作台连接尚未就绪。');
      const response = await connection.rpc.call('/api', `publisher/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '发布操作未完成。');
      return response.value;
    }

    function ErrorNotice({ error }) {
      return error ? h('p', { className: 'pb-error' }, String(error.message || error)) : null;
    }
    function EmptyState({ text }) {
      return h('div', { className: 'pb-empty' }, text);
    }
    function Pill({ tone = 'muted', children }) {
      return h('span', { className: 'pb-pill', 'data-tone': tone }, children);
    }
    function relativeTime(value) {
      if (!value) return '—';
      const stamp = new Date(value).getTime();
      if (!Number.isFinite(stamp)) return '—';
      const seconds = Math.round((Date.now() - stamp) / 1000);
      if (seconds < 60) return '刚刚';
      if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
      if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} 天前`;
      return new Date(value).toLocaleDateString('zh-CN');
    }
    function hueOf(value) {
      let hash = 0;
      for (let index = 0; index < String(value).length; index += 1) hash = (hash * 31 + String(value).charCodeAt(index)) % 360;
      return hash;
    }

    /** Shared header used by all three pages. */
    function PageTop({ title, copy, children }) {
      return h('div', { className: 'pb-top' },
        h('div', null, h('h1', null, title), h('p', null, copy)),
        children
      );
    }

    /* ------------------------------ accounts ------------------------------ */

    function AccountsPage() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [editing, setEditing] = React.useState(null);
      const [form, setForm] = React.useState({ platform: 'douyin', label: '' });
      const [removing, setRemoving] = React.useState(null);

      const reload = React.useCallback(async () => {
        try {
          const [status, accounts, settings] = await Promise.all([
            remote('status'), remote('listAccounts'), remote('settings'),
          ]);
          setState({ status, accounts, settings });
        } catch (err) { setError(err); }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);
      React.useEffect(() => {
        const timer = setInterval(() => { void reload(); }, 5000);
        return () => clearInterval(timer);
      }, [reload]);

      async function act(key, work) {
        setBusy(key); setError(null); setNotice(null);
        try { const message = await work(); if (message) setNotice(message); await reload(); }
        catch (err) { setError(err); }
        finally { setBusy(''); }
      }

      const accounts = state?.accounts || [];
      const status = state?.status || null;
      const browser = status?.browser || null;

      return h('div', { className: 'pb-page' },
        h(PageTop, {
          title: '平台账号',
          copy: '这里管理要发布到的平台账号。登录使用本机 Chrome 的真实登录态：点「登录」会打开一个窗口显示平台二维码，用手机扫码即可，登录状态长期有效。',
        }, h('div', { className: 'pb-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => { void act('reload', async () => null); } }, '刷新'),
        )),

        h(ErrorNotice, { error: error }),
        notice ? h('p', { className: 'pb-note' }, notice) : null,

        browser && !browser.ready ? h('p', { className: 'pb-warn' },
          '浏览器自动化尚未就绪：',
          !browser.playwright ? '缺少 playwright-core 依赖，请在根目录运行「npm run publisher:install」。' : '',
          !browser.executable ? '未找到 Chrome 或 Edge，请安装 Chrome 或设置 LWB_PUBLISHER_CHROME。' : ''
        ) : null,

        browser && browser.ready ? h('p', { className: 'pb-note' },
          `浏览器就绪（Chrome：${String(browser.executable).split(/[\\\\/]/u).pop()}）`,
          browser.openSessions ? ` · 当前打开 ${browser.openSessions} 个会话` : ''
        ) : null,

        h('div', { className: 'pb-section' },
          h('div', { className: 'pb-section-head' },
            h('h3', null, '添加账号'),
            h('span', null, `${accounts.length} / 40`),
          ),
          h('div', { className: 'pb-card pb-form' },
            h('div', { className: 'pb-form-grid' },
              h('label', { className: 'pb-label' }, '平台',
                h('select', { className: 'pb-select', value: form.platform, onChange: (event) => setForm({ ...form, platform: event.target.value }) },
                  PLATFORM_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
                )),
              h('label', { className: 'pb-label' }, '备注名',
                h('input', { className: 'pb-input', value: form.label, maxLength: 80, placeholder: '例如 AI工具解读·抖音', onChange: (event) => setForm({ ...form, label: event.target.value }) })),
            ),
            // The implemented-platform list comes from the host's own status so
            // the copy cannot drift from the adapter registry in code.
            h('p', { className: 'pb-meta' },
              `当前已实现自动发布的平台：${(status?.adapters || []).map((id) => PLATFORM_LABEL.get(id) || id).join('、') || '加载中…'}。其他平台可以先登记账号，适配器补齐后即可使用。`),
            h('div', { className: 'pb-actions' },
              h('button', {
                type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || !form.label.trim(),
                onClick: () => { void act('create', async () => {
                  const account = await remote('createAccount', form);
                  setForm({ platform: form.platform, label: '' });
                  return `已添加「${account.label}」，现在点它的「登录」按钮扫码。`;
                }); },
              }, busy === 'create' ? '添加中…' : '添加账号'),
            ),
          ),
        ),

        h('div', { className: 'pb-section' },
          h('div', { className: 'pb-section-head' },
            h('h3', null, '账号列表'),
            h('span', null, accounts.length ? `可用 ${accounts.filter((item) => item.status === 'active').length} 个` : ''),
          ),
          accounts.length === 0 ? h(EmptyState, { text: '还没有平台账号。先在上方添加一个，再扫码登录。' })
            : h('div', { className: 'pb-list' }, accounts.map((account) => h(AccountCard, {
              key: account.id, account, busy,
              onLogin: () => { void act(`login-${account.id}`, async () => {
                await remote('startLogin', { id: account.id });
                return '登录窗口已打开。扫码完成后，点该账号的「检测登录」。';
              }); },
              onConfirm: () => { void act(`confirm-${account.id}`, async () => (await remote('confirmLogin', { id: account.id })).message); },
              onCheck: () => { void act(`check-${account.id}`, async () => {
                const result = await remote('checkAccount', { id: account.id });
                return result.loggedIn ? `「${account.label}」登录正常。` : `「${account.label}」登录态已失效，请重新登录。`;
              }); },
              onClose: () => { void act(`close-${account.id}`, async () => { await remote('closeSession', { id: account.id }); return '已关闭浏览器窗口。'; }); },
              onEdit: () => { setEditing(account); setError(null); },
              onRemove: () => setRemoving(account),
            }))),
        ),

        h('div', { className: 'pb-section' },
          h('div', { className: 'pb-section-head' }, h('h3', null, '发布策略')),
          h('div', { className: 'pb-card pb-form' },
            h('div', { className: 'pb-form-grid' },
              h('label', { className: 'pb-label' }, '提交方式',
                h('select', {
                  className: 'pb-select', value: state?.settings?.submitMode || 'confirm',
                  onChange: (event) => { void act('settings', async () => { await remote('updateSettings', { submitMode: event.target.value }); return '发布策略已保存。'; }); },
                },
                  h('option', { value: 'confirm' }, '发布前确认（推荐）：自动填好资料，停在提交前'),
                  h('option', { value: 'auto' }, '自动提交：直接发布，无需人工点击'),
                )),
              h('label', { className: 'pb-label' }, '浏览器窗口',
                h('select', {
                  className: 'pb-select', value: state?.settings?.headless ? 'hidden' : 'visible',
                  onChange: (event) => { void act('settings', async () => { await remote('updateSettings', { headless: event.target.value === 'hidden' }); return '发布策略已保存。'; }); },
                },
                  h('option', { value: 'visible' }, '显示窗口（推荐）：可随时人工接管'),
                  h('option', { value: 'hidden' }, '后台运行：不显示窗口'),
                )),
            ),
            h('p', { className: 'pb-meta' }, '自动发布可能违反部分平台的服务条款，风险由使用者自行承担。平台账号的登录态保存在本机浏览器目录中，不会写入配置文件。'),
          ),
        ),

        editing ? h(EditAccountModal, {
          account: editing, busy,
          onClose: () => setEditing(null),
          onSave: (patch) => { void act('update', async () => { await remote('updateAccount', { id: editing.id, ...patch }); setEditing(null); return '账号信息已更新。'; }); },
        }) : null,
        removing ? h(RemoveAccountModal, {
          account: removing, busy,
          onClose: () => setRemoving(null),
          onConfirm: () => { void act('remove', async () => { await remote('deleteAccount', { id: removing.id }); setRemoving(null); return '账号及其登录数据已删除。'; }); },
        }) : null,
      );
    }

    function AccountCard({ account, busy, onLogin, onConfirm, onCheck, onClose, onEdit, onRemove }) {
      const active = account.status === 'active';
      return h('article', { className: 'pb-account' },
        h('div', { className: 'pb-avatar', style: { background: `hsl(${hueOf(account.label)}deg 58% 52%)` } }, String(account.label || '?').slice(0, 1)),
        h('div', { style: { display: 'grid', gap: '8px', minWidth: 0 } },
          h('div', { className: 'pb-card-head' },
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'pb-card-title' }, account.label, ' ',
                h(Pill, { tone: 'muted' }, account.platformLabel || PLATFORM_LABEL.get(account.platform) || account.platform)),
              h('p', { className: 'pb-meta' },
                account.nickname ? `平台昵称：${account.nickname}` : '尚未读取平台昵称',
                account.handle ? ` · ${account.handle}` : '',
                account.sessionOpen ? ' · 窗口已打开' : '',
              ),
            ),
            h('div', { className: 'pb-actions' },
              h(Pill, { tone: active ? 'green' : 'red' }, active ? '登录正常' : '未登录'),
              !account.adapterReady ? h(Pill, { tone: 'orange' }, '待适配') : null,
            ),
          ),
          h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
            h('div', { className: 'pb-kv' }, '最近检测', h('b', null, relativeTime(account.lastCheckedAt))),
            h('div', { className: 'pb-kv' }, '最近登录', h('b', null, relativeTime(account.lastLoginAt))),
          ),
          account.lastError ? h('p', { className: 'pb-warn' }, account.lastError) : null,
          h('div', { className: 'pb-actions' },
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy), onClick: onLogin },
              busy === `login-${account.id}` ? '打开中…' : (active ? '重新登录' : '登录')),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: onConfirm },
              busy === `confirm-${account.id}` ? '检测中…' : '检测登录'),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy) || !account.adapterReady, onClick: onCheck }, '刷新状态'),
            account.sessionOpen ? h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: onClose }, '关闭窗口') : null,
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: onEdit }, '编辑'),
            h('button', { type: 'button', className: 'pb-danger', disabled: Boolean(busy), onClick: onRemove }, '删除'),
          ),
        ),
      );
    }

    function Modal({ title, children, onClose }) {
      return h('div', { className: 'pb-backdrop', role: 'presentation', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'pb-modal', role: 'dialog', 'aria-modal': 'true' },
          h('h3', null, title), children,
        ),
      );
    }

    function EditAccountModal({ account, busy, onClose, onSave }) {
      const [label, setLabel] = React.useState(account.label);
      return h(Modal, { title: '编辑账号', onClose },
        h('label', { className: 'pb-label' }, '备注名',
          h('input', { className: 'pb-input', value: label, maxLength: 80, onChange: (event) => setLabel(event.target.value) })),
        h('p', { className: 'pb-meta' }, `平台：${account.platformLabel || account.platform}。平台昵称与账号号由登录检测自动读回，不能手动修改。`),
        h('div', { className: 'pb-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || !label.trim(), onClick: () => onSave({ label }) }, '保存'),
        ),
      );
    }

    function RemoveAccountModal({ account, busy, onClose, onConfirm }) {
      return h(Modal, { title: `删除「${account.label}」？`, onClose },
        h('p', null, '将同时删除该账号在本机保存的登录数据，下次使用需要重新扫码。已发布的记录会保留。'),
        h('p', { className: 'pb-meta' }, '此操作不可撤销。'),
        h('div', { className: 'pb-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'pb-danger', disabled: Boolean(busy), onClick: onConfirm }, busy ? '删除中…' : '确认删除'),
        ),
      );
    }

    /* ------------------------------- publish ------------------------------- */

    function PublishPage({ openPackMenu }) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [target, setTarget] = React.useState(null);
      const [confirmAuto, setConfirmAuto] = React.useState(false);

      const reload = React.useCallback(async () => {
        try {
          const [status, accounts, shelf, jobs] = await Promise.all([
            remote('status'), remote('listAccounts'), remote('listShelf'), remote('listJobs'),
          ]);
          setState({ status, accounts, shelf, jobs });
          setTarget((current) => {
            if (!current) return current;
            const items = shelf?.items || [];
            return items.some((item) => item.projectId === current.projectId) ? current : null;
          });
        } catch (err) { setError(err); }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);
      React.useEffect(() => {
        const timer = setInterval(() => { void reload(); }, 5000);
        return () => clearInterval(timer);
      }, [reload]);

      const shelf = state?.shelf || null;
      const items = shelf?.items || [];
      const accounts = state?.accounts || [];
      const activeAccounts = accounts.filter((item) => item.status === 'active' && item.adapterReady);
      const settings = state?.status?.settings || {};

      return h('div', { className: 'pb-page' },
        h(PageTop, {
          title: '发布作品',
          copy: '选择一条已通过质检、且发布信息齐备的成片，挑一个平台账号提交。默认停在发布前，你在窗口里点最后一下。',
        }, h('div', { className: 'pb-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => { void reload(); } }, '刷新'),
        )),

        h(ErrorNotice, { error: error }),
        notice ? h('p', { className: 'pb-note' }, notice) : null,

        !shelf ? null : !shelf.available ? h('p', { className: 'pb-warn' }, shelf.reason || '成片货架暂不可用。') : null,

        h('div', { className: 'pb-section' },
          h('div', { className: 'pb-section-head' },
            h('h3', null, '可发布成片'),
            h('span', null, `${items.length} 条 · 已就绪 ${items.filter((item) => item.ready).length} 条`),
          ),
          items.length === 0
            ? h(EmptyState, { text: '还没有通过质检的成片。先到「视频制作」完成一条，再回到这里发布。' })
            : h('div', { className: 'pb-shelf' }, items.map((item) => h(ShelfTile, {
              key: item.projectId, item, accounts: activeAccounts,
              onOpenAccounts: () => openPackMenu?.('accounts'),
              onPublish: (accountId) => { setTarget({ projectId: item.projectId, accountId }); setConfirmAuto(false); setError(null); },
            }))),
        ),

        h('div', { className: 'pb-section' },
          h('div', { className: 'pb-section-head' }, h('h3', null, '最近发布')),
          h('div', { className: 'pb-list' },
            (state?.jobs || []).slice(0, 6).map((job) => h(JobRow, { key: job.id, job })),
            (state?.jobs || []).length === 0 ? h(EmptyState, { text: '还没有发布记录。' }) : null,
          ),
        ),

        target ? h(PublishModal, {
          target, items, accounts: activeAccounts, settings,
          confirmAuto, setConfirmAuto, busy,
          onClose: () => setTarget(null),
          onConfirm: () => { void (async () => {
            setBusy('publish'); setError(null); setNotice(null);
            try {
              const job = await remote('startPublish', { projectId: target.projectId, accountId: target.accountId, confirmAuto });
              setTarget(null);
              setNotice(settings.submitMode === 'auto' && confirmAuto
                ? '已开始自动提交。'
                : '已开始处理：视频上传并填好后会停在发布前，请在浏览器窗口里确认提交。');
              await reload();
              return job;
            } catch (err) { setError(err); }
            finally { setBusy(''); }
          })(); },
        }) : null,
      );
    }

    function ShelfTile({ item, accounts, onPublish, onOpenAccounts }) {
      const [picking, setPicking] = React.useState(false);
      return h('article', { className: 'pb-tile', 'data-ready': item.ready ? 'true' : 'false' },
        h('div', { className: 'pb-card-head' },
          h('div', { className: 'pb-card-title', title: item.title || '' }, item.title || '未命名项目'),
          item.ready ? h(Pill, { tone: 'green' }, '资料就绪') : h(Pill, { tone: 'orange' }, '待生成资料'),
        ),
        h('p', { className: 'pb-meta' },
          item.orientation === 'portrait' ? '竖屏' : item.orientation === 'landscape' ? '横屏' : '方向未知',
          item.account?.name ? ` · ${item.account.name}` : ' · 通用',
          item.video?.durationSeconds ? ` · ${Math.round(item.video.durationSeconds)} 秒` : '',
        ),
        item.packaging?.content?.title ? h('p', { className: 'pb-meta' }, `发布标题：${item.packaging.content.title}`) : null,
        h('p', { className: 'pb-meta' }, '更新于 ', relativeTime(item.updatedAt)),
        !item.ready ? h('p', { className: 'pb-warn' }, '请先到「发布」页生成发布信息（标题、文案、标签、封面），再回来发布。') : null,
        item.alreadyQueued ? h('p', { className: 'pb-note' }, '该项目已有未完成的发布任务，可在「记录」页查看。') : null,
        h('div', { className: 'pb-actions' },
          item.ready && accounts.length && !item.alreadyQueued
            ? (picking
              ? h(React.Fragment, null,
                accounts.map((account) => h('button', {
                  key: account.id, type: 'button', className: 'lwb-primary-button',
                  onClick: () => { setPicking(false); onPublish(account.id); },
                }, `${account.platformLabel || account.platform}·${account.label}`)),
                h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setPicking(false) }, '取消'),
              )
              : h('button', { type: 'button', className: 'lwb-primary-button', onClick: () => setPicking(true) }, '发布到…'))
            : null,
          item.ready && accounts.length === 0
            ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: onOpenAccounts }, '先添加平台账号')
            : null,
        ),
      );
    }

    function JobRow({ job }) {
      return h('article', { className: 'pb-card' },
        h('div', { className: 'pb-card-head' },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'pb-card-title' }, job.projectTitle || job.projectId),
            h('p', { className: 'pb-meta' },
              `${job.platformLabel || job.platform} · ${job.accountLabel || ''}`,
              job.phase ? ` · ${PHASE_LABEL[job.phase] || job.phase}` : '',
              ` · ${relativeTime(job.createdAt)}`,
            ),
          ),
          h(Pill, { tone: JOB_TONE[job.status] || 'muted' }, JOB_LABEL[job.status] || job.status),
        ),
        job.error ? h('p', { className: 'pb-error' }, job.error) : null,
      );
    }

    function PublishModal({ target, items, accounts, settings, confirmAuto, setConfirmAuto, busy, onClose, onConfirm }) {
      const item = items.find((entry) => entry.projectId === target.projectId);
      const account = accounts.find((entry) => entry.id === target.accountId);
      const auto = settings.submitMode === 'auto';
      if (!item || !account) return null;
      const content = item.packaging?.content || null;
      return h(Modal, { title: '确认发布内容', onClose },
        h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
          h('div', { className: 'pb-kv' }, '作品', h('b', null, item.title || '')),
          h('div', { className: 'pb-kv' }, '账号', h('b', null, `${account.platformLabel || account.platform} · ${account.label}`)),
          h('div', { className: 'pb-kv' }, '方式', h('b', null, auto ? '自动提交' : '发布前确认')),
        ),
        content ? h('div', { style: { display: 'grid', gap: '6px' } },
          h('label', { className: 'pb-label' }, '标题', h('div', { className: 'pb-card', style: { padding: '9px 11px' } }, content.title)),
          h('label', { className: 'pb-label' }, '文案', h('div', { className: 'pb-card', style: { padding: '9px 11px', maxHeight: '160px', overflow: 'auto' } }, content.copy)),
          h('label', { className: 'pb-label' }, '标签', h('div', { className: 'pb-card', style: { padding: '9px 11px' } }, (content.tags || []).map((tag) => `#${tag}`).join(' '))),
        ) : null,
        auto ? h('label', { className: 'pb-label', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: confirmAuto, onChange: (event) => setConfirmAuto(event.target.checked) }),
          '我知道这会直接发布到平台，无需人工确认',
        ) : h('p', { className: 'pb-meta' }, '视频上传并填好标题、标签、封面后，流程会停在发布前。请在打开的浏览器窗口中确认无误后点击发布。'),
        h('div', { className: 'pb-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: Boolean(busy) || (auto && !confirmAuto), onClick: onConfirm },
            busy ? '提交中…' : (auto ? '确认自动发布' : '开始发布')),
        ),
      );
    }

    /* ------------------------------- records ------------------------------- */

    function RecordsPage() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [open, setOpen] = React.useState(null);
      const [shot, setShot] = React.useState(null);

      const reload = React.useCallback(async () => {
        try {
          setState({ jobs: await remote('listJobs') });
        } catch (err) { setError(err); }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);
      React.useEffect(() => {
        const timer = setInterval(() => { void reload(); }, 3000);
        return () => clearInterval(timer);
      }, [reload]);

      const jobs = state?.jobs || [];

      async function openJob(job) {
        setOpen(job); setShot(null);
        if (job.proof.screenshots.length) {
          try { setShot(await remote('evidence', { jobId: job.id, name: job.proof.screenshots.at(-1) })); }
          catch (err) { setError(err); }
        }
      }

      return h('div', { className: 'pb-page' },
        h(PageTop, {
          title: '发布记录',
          copy: '每条发布任务都保留状态、阶段与截图证据。失败时先看最后一张截图，它通常直接指出平台页面哪里变了。',
        }, h('div', { className: 'pb-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: Boolean(busy), onClick: () => { void reload(); } }, '刷新'),
        )),

        h(ErrorNotice, { error: error }),

        jobs.length === 0 ? h(EmptyState, { text: '还没有发布记录。' })
          : h('div', { className: 'pb-list' }, jobs.map((job) => h('article', { key: job.id, className: 'pb-card' },
            h('div', { className: 'pb-card-head' },
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'pb-card-title' }, job.projectTitle || job.projectId),
                h('p', { className: 'pb-meta' },
                  `${job.platformLabel || job.platform} · ${job.accountLabel || ''}`,
                  job.phase ? ` · ${PHASE_LABEL[job.phase] || job.phase}` : '',
                  ` · ${relativeTime(job.createdAt)}`,
                  job.submitMode === 'auto' ? ' · 自动提交' : ' · 发布前确认',
                ),
              ),
              h(Pill, { tone: JOB_TONE[job.status] || 'muted' }, JOB_LABEL[job.status] || job.status),
            ),
            job.error ? h('p', { className: 'pb-error' }, job.error) : null,
            job.proof.remoteUrl ? h('p', { className: 'pb-meta' }, '作品链接：', h('a', { href: job.proof.remoteUrl, target: '_blank', rel: 'noreferrer' }, job.proof.remoteUrl)) : null,
            h('div', { className: 'pb-actions' },
              h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => { void openJob(job); } }, '查看证据'),
              job.cancellable ? h('button', {
                type: 'button', className: 'pb-danger', disabled: Boolean(busy),
                onClick: () => { void (async () => {
                  setBusy(`cancel-${job.id}`); setError(null);
                  try { await remote('cancelJob', { jobId: job.id }); await reload(); }
                  catch (err) { setError(err); }
                  finally { setBusy(''); }
                })(); },
              }, busy === `cancel-${job.id}` ? '取消中…' : '取消任务') : null,
            ),
          ))),

        open ? h(Modal, { title: '发布证据', onClose: () => { setOpen(null); setShot(null); } },
          h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
            h('div', { className: 'pb-kv' }, '作品', h('b', null, open.projectTitle || open.projectId)),
            h('div', { className: 'pb-kv' }, '账号', h('b', null, `${open.platformLabel || open.platform} · ${open.accountLabel || ''}`)),
            h('div', { className: 'pb-kv' }, '提交时间', h('b', null, open.proof.submittedAt ? relativeTime(open.proof.submittedAt) : '未提交')),
          ),
          shot ? h('img', { className: 'pb-shot', alt: '发布证据截图', src: `data:image/png;base64,${shot.data}` }) : null,
          h('p', { className: 'pb-meta', style: { wordBreak: 'break-all' } }, `共 ${open.proof.screenshots.length} 张证据截图：`, open.proof.screenshots.map((name) => String(name).split(/[\\\\/]/u).pop()).join('、') || '无'),
        ) : null,
      );
    }

    async function apply(ctx) {
      connection = ctx.get('connection');
      installStyle();
      ctx.effect(() => ctx.lwbPackClient.register({
        packId: PACK_ID,
        pages: { accounts: AccountsPage, publish: PublishPage, records: RecordsPage },
      }), 'publisher: register capability pages');
    }
    exports.inject = ['connection', 'lwbPackClient'];
    exports.apply = apply;
    return module.exports;
  },
});
