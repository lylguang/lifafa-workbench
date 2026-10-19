window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-analytics',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    let connection;
    const PACK_ID = 'analytics';
    const PLUGIN_NAME = '@scitiger-ai/lwb-analytics';
    const PAGE_SIZE = 8;

    /* ============ 口径层（内联：client.js 跑在浏览器 bundle 里，
       无法 import 宿主 .mjs。analytics-ui-metrics.mjs 是同一套逻辑的可测试副本，
       两侧测试用同一组固定输入输出，口径漂移会立刻暴露） ============ */
    function metricNumber(value) {
      // 空串、空白串必须先挡掉：Number('') === 0，会把「没有数据」变成「真的是 0」。
      if (value === null || value === undefined) return null;
      if (typeof value === 'string' && !value.trim()) return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return parsed;
    }
    function displayCount(value) {
      const parsed = metricNumber(value);
      if (parsed === null) return '—';
      if (parsed >= 100000000) return `${(parsed / 100000000).toFixed(2)} 亿`;
      if (parsed >= 10000) return `${(parsed / 10000).toFixed(1)} 万`;
      return String(parsed);
    }
    function displayRate(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
      return `${(Number(value) * 100).toFixed(2)}%`;
    }
    function engagementRate(contents) {
      const list = Array.isArray(contents) ? contents : [];
      let views = 0; let interactions = 0; let counted = 0;
      for (const item of list) {
        if (!item || item.bound === false) continue;
        const metrics = item.metrics || {};
        const viewCount = metricNumber(metrics.views);
        if (viewCount === null) continue;
        counted += 1;
        views += viewCount;
        interactions += ['likes', 'comments', 'shares', 'favorites']
          .reduce((sum, key) => sum + (metricNumber(metrics[key]) || 0), 0);
      }
      if (!counted || views <= 0) return null;
      return interactions / views;
    }
    const PLATFORM_LABEL = { douyin: '抖音', bilibili: 'B站', xhs: '小红书', wechat: '视频号', kuaishou: '快手', toutiao: '今日头条', other: '其他' };
    function platformLabel(platform) { if (!platform) return '—'; return PLATFORM_LABEL[platform] || String(platform); }
    function platformBreakdown(platforms) {
      const list = (Array.isArray(platforms) ? platforms : [])
        .map((item) => ({ platform: item && item.platform || null, views: metricNumber(item && item.views) }))
        .filter((item) => item.platform && item.views !== null)
        .sort((a, b) => b.views - a.views);
      const total = list.reduce((sum, item) => sum + item.views, 0);
      return { total, items: list.map((item) => ({ ...item, label: platformLabel(item.platform), share: total > 0 ? item.views / total : null })) };
    }
    function coverage(accounts) {
      const list = Array.isArray(accounts) ? accounts : [];
      const covered = list.filter((item) => metricNumber(item && item.followers) !== null || metricNumber(item && item.publishedCount) !== null).length;
      return { covered, total: list.length, label: `来自 ${covered}/${list.length} 个账号` };
    }
    function localDateKey(value) {
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) return null;
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
    function densifySeries(points, options) {
      const config = options || {};
      const source = (Array.isArray(points) ? points : [])
        .filter((item) => item && item.date)
        .map((item) => ({ date: String(item.date), value: metricNumber(item.value) }));
      const byDate = new Map(source.map((item) => [item.date, item.value]));
      const start = config.from ? new Date(config.from) : null;
      const end = config.to ? new Date(config.to) : null;
      if (!Number.isFinite(start && start.getTime()) || !Number.isFinite(end && end.getTime())) {
        return { points: source, filled: 0 };
      }
      const axis = [];
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      let filled = 0;
      while (cursor.getTime() <= end.getTime()) {
        const key = localDateKey(cursor);
        axis.push(key);
        if (!byDate.has(key)) filled += 1;
        cursor.setDate(cursor.getDate() + 1);
      }
      return { points: axis.map((date) => ({ date, value: byDate.has(date) ? byDate.get(date) : null })), filled };
    }
    function rangeWindow(rangeKey, today) {
      const base = today || new Date();
      const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
      const days = ({ '7d': 7, '30d': 30 })[rangeKey] || 30;
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
      return { rangeKey, days, from: start.toISOString(), to: end.toISOString(), label: `近 ${days} 天` };
    }
    function successRate(published) {
      const count = metricNumber(published && published.count);
      const success = metricNumber(published && published.success);
      if (count === null || success === null || count <= 0) return null;
      return success / count;
    }
    const FUNNEL_LABEL = { 'script-pending': '待写稿', 'script-review': '待确认稿件', voiceover: '待配音 / 字幕', video: '待视频制作', publish: '可发布', topic: '待选题' };
    function funnelRows(funnel) {
      // 后端已经给了 label，优先用它；只有未知 stage 才回退到本地映射表。
      return (Array.isArray(funnel) ? funnel : []).map((item) => ({
        stage: item && item.stage || null,
        label: (item && item.label) || FUNNEL_LABEL[item && item.stage] || (item && item.stage) || '—',
        count: metricNumber(item && item.count),
        page: item && item.page || null,
      }));
    }
    function topContents(contents, metric, limit) {
      const size = limit || 10;
      const read = metric === 'engagement'
        ? (item) => engagementRate([item])
        : (item) => metricNumber(item && item.metrics && item.metrics.views);
      return (Array.isArray(contents) ? contents : [])
        .map((item, index) => ({ item, index, value: read(item) }))
        .filter((row) => row.value !== null)
        .sort((a, b) => b.value - a.value || a.index - b.index)
        .slice(0, size)
        .map((row) => row.item);
    }
    const COLLECTION_STATUS = {
      ok: ['已采集', 'green'], stale: ['数据较旧', 'orange'], expired: ['登录已过期', 'red'],
      failed: ['采集失败', 'red'], never: ['尚未采集', 'muted'],
    };
    function collectionStatusLabel(status) {
      const entry = COLLECTION_STATUS[status];
      return { label: entry ? entry[0] : '未知', tone: entry ? entry[1] : 'muted' };
    }

    const css = `
      .an-page { display:grid; gap:18px; max-width:1420px; margin:0 auto; } .an-page * { box-sizing:border-box; }
      .an-top { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:14px; padding-bottom:14px; border-bottom:1px solid var(--lwb-line); }
      .an-top h1, .an-section h3 { margin:0; font-size:var(--lwb-text-section,18px); }
      .an-top p, .an-meta, .an-card p { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .an-section { display:grid; gap:11px; }
      .an-section-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; }
      .an-section-head span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .an-card { display:grid; gap:9px; padding:14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .an-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); gap:10px; }
      .an-kpi { display:grid; gap:4px; padding:13px 14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .an-kpi-label { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .an-kpi-value { font-size:26px; font-weight:800; letter-spacing:-.01em; line-height:1.15; }
      .an-kpi-hint { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); line-height:1.5; }
      .an-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .an-chips { display:flex; flex-wrap:wrap; gap:6px; }
      .an-chip { min-height:28px; padding:0 11px; border:1px solid var(--lwb-line); border-radius:99px; color:var(--lwb-ink); background:var(--lwb-surface); cursor:pointer; font:inherit; font-size:var(--lwb-text-sm,13px); }
      .an-chip[data-on="true"] { border-color:var(--lwb-blue); color:var(--lwb-blue); background:var(--lwb-blue-soft); font-weight:700; }
      .an-select { height:32px; padding:0 9px; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-sm,13px); }
      .an-chart { width:100%; height:auto; display:block; }
      .an-legend { display:flex; flex-wrap:wrap; gap:12px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .an-legend i { width:9px; height:9px; margin-right:5px; border-radius:2px; display:inline-block; vertical-align:middle; }
      .an-bar-row { display:grid; grid-template-columns:88px minmax(0,1fr) auto; gap:9px; align-items:center; }
      .an-bar-track { height:9px; border-radius:99px; background:var(--lwb-line); overflow:hidden; }
      .an-bar-fill { height:100%; border-radius:99px; background:var(--lwb-blue); }
      .an-funnel { display:grid; gap:8px; }
      .an-funnel-row { display:grid; grid-template-columns:130px minmax(0,1fr) auto; gap:10px; align-items:center; }
      .an-funnel-track { height:26px; border-radius:6px; background:var(--lwb-line); overflow:hidden; }
      .an-funnel-fill { height:100%; border-radius:6px; background:linear-gradient(90deg,var(--lwb-blue),var(--lwb-green)); }
      .an-list { display:grid; gap:8px; }
      .an-row { display:grid; gap:7px; padding:13px 14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .an-row-head { display:flex; min-width:0; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:9px; }
      .an-row-title { min-width:0; overflow:hidden; font-size:var(--lwb-text-md,15px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .an-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(92px,1fr)); gap:8px; }
      .an-stat { display:grid; gap:2px; }
      .an-stat-label { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .an-stat-value { font-size:var(--lwb-text-md,15px); font-weight:700; }
      .an-pill { display:inline-flex; min-height:21px; align-items:center; padding:0 7px; border-radius:5px; color:var(--lwb-blue); background:var(--lwb-blue-soft); font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; }
      .an-pill[data-tone="green"] { color:var(--lwb-green); background:var(--lwb-green-soft); }
      .an-pill[data-tone="orange"] { color:#7a5b17; background:#fff4dd; }
      .an-pill[data-tone="red"] { color:#a94343; background:#ffecec; }
      .an-pill[data-tone="muted"] { color:var(--lwb-muted); background:var(--lwb-line); }
      .an-note, .an-error { margin:0; padding:10px 11px; border:1px solid #bad5ed; border-radius:7px; color:#486277; background:#f7fbff; font-size:var(--lwb-text-sm,13px); line-height:1.55; }
      .an-error { border-color:#e6b5b5; color:#994646; background:#fff7f7; }
      .an-empty { display:grid; gap:6px; padding:30px 14px; border:1px dashed var(--lwb-line); border-radius:9px; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); text-align:center; }
      .an-empty strong { color:var(--lwb-ink); font-size:var(--lwb-text-md,15px); }
      .an-pager { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:flex-end; }
      .an-skeleton { height:14px; border-radius:5px; background:linear-gradient(90deg,var(--lwb-line),var(--lwb-surface),var(--lwb-line)); background-size:200% 100%; animation:an-pulse 1.1s linear infinite; }
      @keyframes an-pulse { from { background-position:200% 0; } to { background-position:-200% 0; } }
      body[data-ds-dark-theme] .an-pill[data-tone="orange"] { color:#e8d9a9; background:#332b1b; }
      body[data-ds-dark-theme] .an-pill[data-tone="red"] { color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .an-note { border-color:#2c5578; color:#a9c9e6; background:#16324a; }
      body[data-ds-dark-theme] .an-error { border-color:#7a4444; color:#e8b9b9; background:#3a2323; }
    `;

    function installStyle() {
      const existing = document.getElementById('lwb-analytics-style');
      // 工作台支持原地重载能力包：整段替换旧规则，避免旧布局样式钉住。
      if (existing) { existing.setAttribute('data-plugin', PLUGIN_NAME); existing.textContent = css; return; }
      const style = document.createElement('style');
      style.id = 'lwb-analytics-style';
      style.setAttribute('data-plugin', PLUGIN_NAME);
      style.textContent = css;
      document.head.appendChild(style);
    }

    async function remote(method, request) {
      if (!connection || !connection.rpc || !connection.rpc.call) throw new Error('工作台连接尚未就绪。');
      const response = await connection.rpc.call('/api', `analytics/${method}`, { args: request === undefined ? {} : { request } });
      if (!response || !response.ok) throw new Error((response && response.error && response.error.message) || '读取数据看板失败。');
      return response.value;
    }

    function formatTime(iso) {
      if (!iso) return '';
      const timestamp = Date.parse(iso);
      if (!Number.isFinite(timestamp)) return '';
      const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
      const day = new Date(timestamp);
      return `${day.getMonth() + 1} 月 ${day.getDate()} 日`;
    }

    function Pill({ tone, children }) {
      return h('span', { className: 'an-pill', 'data-tone': tone || 'blue' }, children);
    }

    function ErrorNotice({ error, onRetry }) {
      if (!error) return null;
      return h('p', { className: 'an-error', role: 'alert' },
        error,
        onRetry ? h('button', { type: 'button', className: 'lwb-plain-button', style: { marginLeft: '10px' }, onClick: onRetry }, '重试') : null,
      );
    }

    /* 空态必须回答两件事：为什么空、下一步去哪。缺一不可。 */
    function EmptyState({ title, hint, action }) {
      return h('div', { className: 'an-empty' },
        h('strong', null, title),
        hint ? h('p', { style: { margin: '0' } }, hint) : null,
        action || null,
      );
    }

    function LoadingBlock({ rows }) {
      return h('div', { className: 'an-section', 'aria-busy': 'true', 'aria-live': 'polite' },
        h('span', { className: 'an-meta' }, '正在读取…'),
        Array.from({ length: rows || 3 }, (_, index) => h('div', { key: index, className: 'an-skeleton', style: { width: `${100 - index * 12}%` } })),
      );
    }

    /* ---------------- 自绘 SVG 图表（零第三方依赖） ---------------- */

    /* 双轴折线：左轴 views，右轴互动；null 断点不连，绝不补 0。 */
    function LineChart({ points, leftLabel, rightLabel }) {
      const width = 760;
      const height = 220;
      const padLeft = 52;
      const padRight = 52;
      const padTop = 14;
      const padBottom = 30;
      const list = Array.isArray(points) ? points : [];
      if (!list.length) return null;
      const values = list.flatMap((item) => [metricNumber(item.views), metricNumber(item.interactions)].filter((value) => value !== null));
      const max = values.length ? Math.max(...values) : 0;
      const innerW = width - padLeft - padRight;
      const innerH = height - padTop - padBottom;
      const step = list.length > 1 ? innerW / (list.length - 1) : 0;
      const xOf = (index) => padLeft + step * index;
      const yOf = (value) => padTop + innerH - (max > 0 ? (value / max) * innerH : 0);
      const path = (read) => {
        let started = false;
        return list.map((item, index) => {
          const value = metricNumber(read(item));
          if (value === null) { started = false; return null; }
          const command = started ? 'L' : 'M';
          started = true;
          return `${command}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`;
        }).filter(Boolean).join(' ');
      };
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * max);
      const labelIndex = [0, Math.floor((list.length - 1) / 2), list.length - 1].filter((index, position, all) => all.indexOf(index) === position && index >= 0);
      const countGap = list.filter((item) => metricNumber(item.views) === null && metricNumber(item.interactions) === null).length;
      return h('div', { className: 'an-section' },
        h('svg', { className: 'an-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `趋势图：${leftLabel}与${rightLabel}，共 ${list.length} 天` },
          ticks.map((tick) => h('g', { key: tick },
            h('line', { x1: padLeft, x2: width - padRight, y1: yOf(tick), y2: yOf(tick), stroke: 'var(--lwb-line)', strokeWidth: 1 }),
            h('text', { x: padLeft - 8, y: yOf(tick) + 4, 'text-anchor': 'end', fill: 'var(--lwb-muted)', fontSize: 10 }, displayCount(tick)),
          )),
          // 缺口用虚线段提示「这段时间没有数据」，而不是把它画成 0。
          list.map((item, index) => (metricNumber(item.views) === null && metricNumber(item.interactions) === null
            ? h('rect', { key: `gap-${index}`, x: xOf(index) - step / 2, y: padTop, width: step || 2, height: innerH, fill: 'var(--lwb-line)', opacity: 0.35 })
            : null)),
          h('path', { d: path((item) => item.views), fill: 'none', stroke: 'var(--lwb-blue)', strokeWidth: 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
          h('path', { d: path((item) => item.interactions), fill: 'none', stroke: 'var(--lwb-green)', strokeWidth: 2, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
          labelIndex.map((index) => h('text', { key: `label-${index}`, x: xOf(index), y: height - 10, 'text-anchor': index === 0 ? 'start' : index === list.length - 1 ? 'end' : 'middle', fill: 'var(--lwb-muted)', fontSize: 10 }, String(list[index] && list[index].date || '').slice(5))),
        ),
        h('div', { className: 'an-legend' },
          h('span', null, h('i', { style: { background: 'var(--lwb-blue)' } }), leftLabel),
          h('span', null, h('i', { style: { background: 'var(--lwb-green)' } }), rightLabel),
          countGap ? h('span', null, `灰色区间为无数据（${countGap} 天），不代表 0`) : null,
        ),
      );
    }

    function BarBreakdown({ rows }) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return null;
      const max = Math.max(...list.map((item) => item.views), 1);
      return h('div', { className: 'an-section' },
        list.map((item) => h('div', { key: item.platform || item.label, className: 'an-bar-row' },
          h('span', { className: 'an-meta' }, item.label),
          h('div', { className: 'an-bar-track' }, h('div', { className: 'an-bar-fill', style: { width: `${Math.max(2, (item.views / max) * 100)}%` } })),
          h('span', { className: 'an-meta' }, displayCount(item.views)),
        )),
      );
    }

    /* 漏斗：定稿 §4.2-1 —— 数据来自 pipelineOverview()，是当前时点存量，
       不随上方时间范围变化，所以标题旁必须挂「当前时点」徽标。 */
    function Funnel({ rows, onOpen }) {
      const list = funnelRows(rows);
      if (!list.length) return null;
      const max = Math.max(...list.map((item) => item.count || 0), 1);
      return h('div', { className: 'an-funnel' },
        list.map((item) => h('div', { key: item.stage || item.label, className: 'an-funnel-row' },
          h('span', { className: 'an-meta' }, item.label),
          h('div', { className: 'an-funnel-track' }, h('div', { className: 'an-funnel-fill', style: { width: `${item.count === null ? 0 : Math.max(2, (item.count / max) * 100)}%` } })),
          h('span', { className: 'an-meta' }, item.count === null ? '—' : String(item.count)),
          item.page && onOpen ? h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => onOpen(item.page) }, '去处理') : null,
        )),
      );
    }

    function StatGrid({ stats }) {
      return h('div', { className: 'an-stats' },
        (Array.isArray(stats) ? stats : []).map((item) => h('div', { key: item.label, className: 'an-stat' },
          h('span', { className: 'an-stat-label' }, item.label),
          h('span', { className: 'an-stat-value' }, item.value),
        )),
      );
    }

    function TopContents({ rows }) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return null;
      return h('div', { className: 'an-list' },
        list.map((item, index) => h('div', { key: item.contentId || index, className: 'an-row' },
          h('div', { className: 'an-row-head' },
            h('span', { className: 'an-row-title' }, `${index + 1}. ${item.title || '未命名作品'}`),
            h(Pill, { tone: 'muted' }, platformLabel(item.platform)),
          ),
          h(StatGrid, { stats: [
            { label: '播放', value: displayCount(item.metrics && item.metrics.views) },
            { label: '点赞', value: displayCount(item.metrics && item.metrics.likes) },
            { label: '互动率', value: displayRate(item.engagementRate ?? engagementRate([item])) },
          ] }),
        )),
      );
    }

    /* ---------------- 数据读取 ---------------- */

    /*
     * 读取失败时自己爬起来（对齐现有执行记录页做法）：
     * 首次失败且没有任何数据时，隔 2 秒自动重试一次，避免工作台刚重启那几秒
     * 打开页面就一直空着。
     */
    function useAnalytics(loader, deps) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const loaderRef = React.useRef(loader);
      loaderRef.current = loader;
      const retryTimer = React.useRef(null);
      const retried = React.useRef(false);
      const load = React.useCallback(async () => {
        try {
          const value = await loaderRef.current();
          setData(value);
          setError(null);
          retried.current = false;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          if (!retried.current) {
            retried.current = true;
            retryTimer.current = setTimeout(() => { void loaderRef.current?.().then((value) => { setData(value); setError(null); }).catch(() => {}); }, 2000);
          }
        } finally {
          setLoading(false);
        }
      }, []);
      React.useEffect(() => {
        retried.current = false;
        setLoading(true);
        void load();
        return () => { if (retryTimer.current) clearTimeout(retryTimer.current); };
      }, deps);
      return { data, error, loading, reload: load };
    }

    /* ---------------- 页面 ---------------- */

    function RangeChips({ value, onChange }) {
      const options = [{ id: '7d', label: '近 7 天' }, { id: '30d', label: '近 30 天' }];
      return h('div', { className: 'an-chips', role: 'group', 'aria-label': '时间范围' },
        options.map((item) => h('button', {
          key: item.id, type: 'button', className: 'an-chip', 'data-on': value === item.id ? 'true' : 'false',
          'aria-pressed': value === item.id ? 'true' : 'false', onClick: () => onChange(item.id),
        }, item.label)),
      );
    }

    function PageHeader({ title, copy, actions }) {
      return h('header', { className: 'an-top' },
        h('div', null, h('h1', null, title), copy ? h('p', null, copy) : null),
        actions || null,
      );
    }

    function OverviewPage() {
      const [rangeKey, setRangeKey] = React.useState('30d');
      const [platform, setPlatform] = React.useState('');
      const window_ = React.useMemo(() => rangeWindow(rangeKey), [rangeKey]);
      const request = React.useMemo(() => ({ from: window_.from, to: window_.to, ...(platform ? { platform } : {}) }), [window_, platform]);
      const summary = useAnalytics(() => remote('analyticsSummary', request), [request]);
      const accounts = useAnalytics(() => remote('analyticsAccounts', request), [request]);

      const kpis = (summary.data && summary.data.kpis) || null;
      const available = summary.data && summary.data.available;
      const funnel = summary.data && summary.data.funnel;
      const platforms = summary.data && summary.data.platforms;
      const contents = useAnalytics(() => remote('analyticsContents', { ...request, limit: 10, sort: 'views', order: 'desc' }), [request]);
      const cover = coverage((accounts.data && accounts.data.items) || []);
      const top = topContents((contents.data && contents.data.items) || [], 'views', 10);
      // 发布成功率由后端按 jobs 直接算好（比率）；不要再从 count/success 二次派生。
      const publishedRate = metricNumber(kpis && kpis.published && kpis.published.successRate);
      const breakdown = platformBreakdown(platforms);

      // 发布量是本地已知事实，采集指标（P2）尚无数据源；两者分别占位，不混画。
      const publishedSeries = Array.isArray(summary.data && summary.data.series) ? summary.data.series : [];

      const actions = h('div', { className: 'an-toolbar' },
        h(RangeChips, { value: rangeKey, onChange: setRangeKey }),
        h('select', { className: 'an-select', value: platform, 'aria-label': '按平台筛选', onChange: (event) => setPlatform(event.target.value) },
          h('option', { value: '' }, '全部平台'),
          Object.keys(PLATFORM_LABEL).map((id) => h('option', { key: id, value: id }, PLATFORM_LABEL[id])),
        ),
      );

      return h('div', { className: 'an-page' },
        h(PageHeader, {
          title: '概览',
          copy: '先看产能与发布表现，再看作品数据。所有指标都标注来源与时间，缺失一律显示「—」，不会用 0 冒充未知。',
          actions,
        }),
        h(ErrorNotice, { error: summary.error, onRetry: summary.reload }),
        /*
         * 兄弟包缺席或读取失败时，后端会把对应区块降级成 available:false + reason。
         * 这些区块各自出提示，其余区块照常可用——看板不会因为缺一个包就整体白屏。
         */
        available && available.publisher === false
          ? h('p', { className: 'an-note', role: 'status' }, `发布数据暂不可用：${available.reason || '发布与账号管理能力包未安装。'}`)
          : null,
        summary.loading && !summary.data ? h(LoadingBlock, { rows: 4 }) : null,

        kpis ? h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '关键指标'), h('span', null, cover.label)),
          h('div', { className: 'an-kpis' },
            h('div', { className: 'an-kpi' }, h('span', { className: 'an-kpi-label' }, '总播放'), h('span', { className: 'an-kpi-value' }, displayCount(kpis.views)), h('span', { className: 'an-kpi-hint' }, '需开启平台采集')),
            h('div', { className: 'an-kpi' }, h('span', { className: 'an-kpi-label' }, '净增粉'), h('span', { className: 'an-kpi-value' }, displayCount(kpis.followers && kpis.followers.netGain)), h('span', { className: 'an-kpi-hint' }, kpis.followers && kpis.followers.netGain === null ? '基线不完整，需要两次快照' : '区间快照差值')),
            h('div', { className: 'an-kpi' }, h('span', { className: 'an-kpi-label' }, '发布数'), h('span', { className: 'an-kpi-value' }, displayCount(kpis.published && kpis.published.count)), h('span', { className: 'an-kpi-hint' }, `${window_.label}`)),
            h('div', { className: 'an-kpi' }, h('span', { className: 'an-kpi-label' }, '发布成功率'), h('span', { className: 'an-kpi-value' }, displayRate(publishedRate)), h('span', { className: 'an-kpi-hint' }, '成功发布 ÷ 全部发布任务')),
            h('div', { className: 'an-kpi' }, h('span', { className: 'an-kpi-label' }, '互动率'), h('span', { className: 'an-kpi-value' }, displayRate(kpis.engagementRate)), h('span', { className: 'an-kpi-hint' }, '(赞+评+转+藏) ÷ 播放')),
          ),
        ) : null,

        !summary.loading && !summary.data && !summary.error
          ? h(EmptyState, { title: '还没有可展示的数据', hint: '看板的数据来自发布记录与流水线。完成一次发布，或到「内容安排」跑一轮流水线，这里就会有内容。' })
          : null,

        publishedSeries.length ? h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '发布量趋势'), h('span', null, `${window_.label} · 每天实际发布条数`)),
          h(LineChart, {
            points: densifySeries(publishedSeries.map((item) => ({ date: item.date, views: metricNumber(item.published) })), { from: window_.from, to: window_.to }).points.map((item) => ({ date: item.date, views: item.value, interactions: null })),
            leftLabel: '发布量', rightLabel: '互动',
          }),
          h('p', { className: 'an-note' }, '平台侧的播放与互动数据需要开启采集后才会有；本图现在只画发布量，缺口区间表示当天没有发布。'),
        ) : null,

        h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' },
            h('h3', null, '生产漏斗'),
            h('span', null, h(Pill, { tone: 'orange' }, '当前时点'), ' 不随时间范围变化'),
          ),
          funnel && funnel.length
            ? h(Funnel, { rows: funnel })
            : available && available.funnel === false
              ? h(EmptyState, { title: '生产漏斗暂不可用', hint: available.funnelReason || '流水线看板所在的能力包没有加载，所以这里暂时读不到存量。' })
              : h(EmptyState, { title: '暂时读不到流水线', hint: '漏斗来自「流水线看板」。如果那条流水线还没跑过或对应包未安装，这里会暂时是空的。' }),
        ),

        h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '平台分布'), h('span', null, '按播放量')),
          breakdown.items.length ? h(BarBreakdown, { rows: breakdown.items }) : h(EmptyState, { title: '还没有平台播放数据', hint: '等开启平台采集后，这里会显示各平台的播放占比。' }),
        ),

        h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '作品表现 TOP'), h('span', null, '按播放量')),
          contents.loading && !contents.data ? h(LoadingBlock, { rows: 2 }) : null,
          top.length ? h(TopContents, { rows: top }) : !contents.loading
            ? h(EmptyState, { title: '还没有可排名的作品', hint: '需要已发布并绑定了平台作品的记录。先到「发布」页投递一条作品。' })
            : null,
        ),
      );
    }

    function AccountsPage() {
      const [rangeKey, setRangeKey] = React.useState('30d');
      const window_ = React.useMemo(() => rangeWindow(rangeKey), [rangeKey]);
      const request = React.useMemo(() => ({ from: window_.from, to: window_.to }), [window_]);
      const accounts = useAnalytics(() => remote('analyticsAccounts', request), [request]);
      const items = (accounts.data && accounts.data.items) || [];
      const cover = coverage(items);
      const grouped = items.reduce((map, item) => {
        const key = item.platform || 'other';
        map[key] = map[key] || { platform: key, followers: 0, publishedCount: 0, net: 0, netKnown: true };
        const followers = metricNumber(item.followers);
        if (followers !== null) map[key].followers += followers;
        map[key].publishedCount += metricNumber(item.publishedCount) || 0;
        const net = metricNumber(item.followersNetGain);
        if (net === null) map[key].netKnown = false; else map[key].net += net;
        return map;
      }, {});

      return h('div', { className: 'an-page' },
        h(PageHeader, {
          title: '账号',
          copy: '按平台账号对照粉丝、发布量与互动率。采集状态为「尚未采集」说明该账号还没有平台数据，不代表出错。',
          actions: h(RangeChips, { value: rangeKey, onChange: setRangeKey }),
        }),
        h(ErrorNotice, { error: accounts.error, onRetry: accounts.reload }),
        accounts.data && accounts.data.available === false
          ? h('p', { className: 'an-note', role: 'status' }, `账号数据暂不可用：${accounts.data.reason || '发布与账号管理能力包未安装。'}`)
          : null,
        accounts.loading && !accounts.data ? h(LoadingBlock, { rows: 4 }) : null,
        !accounts.loading && !items.length && !accounts.error
          ? h(EmptyState, { title: '还没有平台账号', hint: '到「发布与账号管理 → 账号」添加并登录平台账号，这里就会有对照数据。' })
          : null,

        items.length ? h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '按平台汇总'), h('span', null, cover.label)),
          h('div', { className: 'an-list' },
            Object.values(grouped).map((group) => h('div', { key: group.platform, className: 'an-row' },
              h('div', { className: 'an-row-head' },
                h('span', { className: 'an-row-title' }, platformLabel(group.platform)),
                h(Pill, { tone: 'muted' }, `${group.publishedCount} 条发布`),
              ),
              h(StatGrid, { stats: [
                { label: '粉丝合计', value: displayCount(group.followers) },
                { label: '区间净增', value: group.netKnown ? displayCount(group.net) : '—' },
                { label: '账号数', value: String(items.filter((item) => (item.platform || 'other') === group.platform).length) },
              ] }),
            )),
          ),
        ) : null,

        items.length ? h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '账号明细'), h('span', null, `${items.length} 个账号`)),
          h('div', { className: 'an-list' },
            items.map((item) => {
              const status = collectionStatusLabel(item.collectionStatus);
              return h('div', { key: item.accountId, className: 'an-row' },
                h('div', { className: 'an-row-head' },
                  h('span', { className: 'an-row-title' }, item.nickname || item.accountId || '未命名账号'),
                  h('div', { className: 'an-toolbar' },
                    h(Pill, { tone: 'muted' }, platformLabel(item.platform)),
                    h(Pill, { tone: status.tone }, status.label),
                  ),
                ),
                h(StatGrid, { stats: [
                  { label: '粉丝', value: displayCount(item.followers) },
                  { label: '区间净增', value: displayCount(item.followersNetGain) },
                  { label: '发布数', value: displayCount(item.publishedCount) },
                  { label: '互动率', value: displayRate(item.engagementRate) },
                ] }),
                h('p', { className: 'an-meta' }, item.lastCollectedAt ? `最近采集 ${formatTime(item.lastCollectedAt)}` : '尚未采集过平台数据'),
                item.lastError ? h('p', { className: 'an-error' }, item.lastError) : null,
              );
            }),
          ),
        ) : null,
      );
    }

    function ContentsPage() {
      const [rangeKey, setRangeKey] = React.useState('30d');
      const [platform, setPlatform] = React.useState('');
      const [page, setPage] = React.useState(0);
      const window_ = React.useMemo(() => rangeWindow(rangeKey), [rangeKey]);
      const request = React.useMemo(() => ({
        from: window_.from, to: window_.to,
        ...(platform ? { platform } : {}),
        sort: 'views', order: 'desc', offset: page * PAGE_SIZE, limit: PAGE_SIZE,
      }), [window_, platform, page]);
      React.useEffect(() => { setPage(0); }, [rangeKey, platform]);
      const contents = useAnalytics(() => remote('analyticsContents', request), [request]);
      const items = (contents.data && contents.data.items) || [];
      const total = metricNumber(contents.data && contents.data.total) || 0;
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

      return h('div', { className: 'an-page' },
        h(PageHeader, {
          title: '作品',
          copy: '已发布作品的逐条表现。缺失的指标显示「—」而不是 0——当天没有数据与当天真的是 0，是两回事。',
          actions: h('div', { className: 'an-toolbar' },
            h(RangeChips, { value: rangeKey, onChange: setRangeKey }),
            h('select', { className: 'an-select', value: platform, 'aria-label': '按平台筛选', onChange: (event) => setPlatform(event.target.value) },
              h('option', { value: '' }, '全部平台'),
              Object.keys(PLATFORM_LABEL).map((id) => h('option', { key: id, value: id }, PLATFORM_LABEL[id])),
            ),
          ),
        }),
        h(ErrorNotice, { error: contents.error, onRetry: contents.reload }),
        contents.data && contents.data.available === false
          ? h('p', { className: 'an-note', role: 'status' }, `作品数据暂不可用：${contents.data.reason || '发布记录所在的能力包未安装。'}`)
          : null,
        contents.loading && !contents.data ? h(LoadingBlock, { rows: 4 }) : null,
        !contents.loading && !items.length && !contents.error
          ? h(EmptyState, { title: '这个范围内没有作品', hint: '换一段时间范围或平台看看；确认发布记录里有成功提交的作品后，这里就会出现。' })
          : null,

        items.length ? h('section', { className: 'an-section' },
          h('div', { className: 'an-section-head' }, h('h3', null, '作品明细'), h('span', null, `共 ${total} 条`)),
          h('div', { className: 'an-list' },
            items.map((item) => h('div', { key: item.contentId, className: 'an-row' },
              h('div', { className: 'an-row-head' },
                h('span', { className: 'an-row-title' }, item.title || '未命名作品'),
                h(Pill, { tone: 'muted' }, platformLabel(item.platform)),
              ),
              h(StatGrid, { stats: [
                { label: '播放', value: displayCount(item.metrics && item.metrics.views) },
                { label: '点赞', value: displayCount(item.metrics && item.metrics.likes) },
                { label: '评论', value: displayCount(item.metrics && item.metrics.comments) },
                { label: '分享', value: displayCount(item.metrics && item.metrics.shares) },
                { label: '收藏', value: displayCount(item.metrics && item.metrics.favorites) },
                { label: '互动率', value: displayRate(item.engagementRate ?? engagementRate([item])) },
              ] }),
              h('p', { className: 'an-meta' }, [
                item.publishedAt ? `发布于 ${formatTime(item.publishedAt)}` : '发布时间未知',
                item.collectedAt ? ` · 采集于 ${formatTime(item.collectedAt)}` : '',
                item.source ? ` · 来源 ${item.source}` : '',
              ].join('')),
            )),
          ),
          pageCount > 1 ? h('div', { className: 'an-pager' },
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: page <= 0, onClick: () => setPage((current) => Math.max(0, current - 1)) }, '上一页'),
            h('span', { className: 'an-meta' }, `第 ${page + 1} / ${pageCount} 页`),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: page + 1 >= pageCount, onClick: () => setPage((current) => current + 1) }, '下一页'),
          ) : null,
        ) : null,
      );
    }

    async function apply(ctx) {
      connection = ctx.get('connection');
      installStyle();
      ctx.effect(() => ctx.lwbPackClient.register({
        packId: PACK_ID,
        pages: { overview: OverviewPage, accounts: AccountsPage, contents: ContentsPage },
      }), 'analytics: register capability pages');
    }
    exports.inject = ['connection', 'lwbPackClient'];
    exports.apply = apply;
    // 测试与 vm 沙箱直接取用口径函数与页面组件；浏览器运行本身不依赖这些导出。
    exports.__metrics = {
      metricNumber, displayCount, displayRate, engagementRate, platformLabel,
      platformBreakdown, coverage, localDateKey, densifySeries, rangeWindow,
      successRate, funnelRows, topContents, collectionStatusLabel,
    };
    // 供静态层断言做服务端渲染：只验 DOM 结构、暗色 class 与空态文案，
    // 替代不了真机走查——对比度、窄窗坐标轴重叠、Tab 遍历顺序必须真浏览器。
    exports.__pages = { OverviewPage, AccountsPage, ContentsPage };
    exports.__components = { EmptyState, LoadingBlock, Funnel, LineChart, BarBreakdown };
    return module.exports;
  },
});
