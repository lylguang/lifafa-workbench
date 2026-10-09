window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-whiteboard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    let connection;
    const PACK_ID = 'whiteboard';
    const PLUGIN_NAME = '@scitiger-ai/lwb-whiteboard';

    const css = `
      .wb-page { display:grid; gap:18px; max-width:1420px; margin:0 auto; } .wb-page * { box-sizing:border-box; }
      .wb-top { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:14px; padding-bottom:14px; border-bottom:1px solid var(--lwb-line); }
      .wb-top h1 { margin:0; font-size:var(--lwb-text-section,18px); }
      .wb-top p, .wb-meta, .wb-card p { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .wb-section { display:grid; gap:11px; }
      .wb-section h3 { margin:0; font-size:var(--lwb-text-section,18px); }
      .wb-section-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px; }
      .wb-section-head span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .wb-card, .wb-form { display:grid; gap:9px; padding:14px; border:1px solid var(--lwb-line); border-radius:9px; background:var(--lwb-surface); }
      .wb-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .wb-form-grid .wb-wide { grid-column:1/-1; }
      .wb-label { display:grid; gap:4px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .wb-input, .wb-textarea, .wb-select { width:100%; border:1px solid var(--lwb-line); border-radius:6px; color:var(--lwb-ink); background:var(--lwb-surface); font:inherit; font-size:var(--lwb-text-base,14px); }
      .wb-input, .wb-select { height:36px; padding:0 10px; }
      .wb-textarea { min-height:88px; padding:9px; resize:vertical; line-height:1.6; }
      .wb-input:focus, .wb-textarea:focus, .wb-select:focus { border-color:var(--lwb-blue); outline:0; box-shadow:0 0 0 2px var(--lwb-blue-soft); }
      .wb-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .wb-pill { display:inline-flex; min-height:21px; flex:none; align-items:center; padding:0 7px; border-radius:5px; color:var(--lwb-blue); background:var(--lwb-blue-soft); font-size:var(--lwb-text-xs,12px); font-weight:700; white-space:nowrap; }
      .wb-pill[data-tone="green"] { color:var(--lwb-green); background:var(--lwb-green-soft); }
      .wb-pill[data-tone="orange"] { color:#7a5b17; background:#fff4dd; }
      .wb-pill[data-tone="red"] { color:#a94343; background:#ffecec; }
      .wb-pill[data-tone="muted"] { color:var(--lwb-muted); background:var(--lwb-line); }
      .wb-error, .wb-note { margin:0; padding:10px 11px; border:1px solid #e6b5b5; border-radius:7px; color:#994646; background:#fff7f7; font-size:var(--lwb-text-sm,13px); line-height:1.55; white-space:pre-wrap; }
      .wb-note { border-color:#bad5ed; color:#486277; background:#f7fbff; }
      .wb-empty { padding:34px 12px; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); text-align:center; border:1px dashed var(--lwb-line); border-radius:9px; }
      .wb-list { display:grid; gap:8px; }
      .wb-card-head { display:flex; min-width:0; align-items:flex-start; justify-content:space-between; gap:9px; }
      .wb-card-title { overflow:hidden; font-size:var(--lwb-text-md,15px); font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .wb-log { max-height:240px; margin:0; overflow:auto; padding:10px; border:1px solid var(--lwb-line); border-radius:7px; background:#1b1f26; color:#cfd6e0; font-family:ui-monospace,Consolas,monospace; font-size:12px; line-height:1.55; white-space:pre-wrap; }
      .wb-scene-row { display:grid; grid-template-columns:1fr auto; gap:9px; align-items:center; padding:10px 11px; border:1px solid var(--lwb-line); border-radius:8px; }
      .wb-scene-row strong { font-size:var(--lwb-text-base,14px); }
      .wb-steps { display:grid; gap:7px; margin:0; padding-left:20px; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.6; }
      .wb-steps code { padding:1px 5px; border-radius:4px; background:var(--lwb-line); font-size:12px; }
      body[data-ds-dark-theme] .wb-error { border-color:#7a4444; color:#e8b9b9; background:#3a2323; }
      body[data-ds-dark-theme] .wb-note { border-color:#2c5578; color:#a9c9e6; background:#16324a; }
      body[data-ds-dark-theme] .wb-pill[data-tone="orange"] { color:#e8d9a9; background:#332b1b; }
      body[data-ds-dark-theme] .wb-pill[data-tone="red"] { color:#e8b9b9; background:#3a2323; }
    `;

    function installStyle() {
      const existing = document.getElementById('lwb-whiteboard-style');
      // 包可以在页面会话内反复卸载/加载；替换旧规则，避免更新的样式被旧 bundle 钉住。
      if (existing) { existing.setAttribute('data-plugin', PLUGIN_NAME); existing.textContent = css; return; }
      const style = document.createElement('style');
      style.id = 'lwb-whiteboard-style';
      style.setAttribute('data-plugin', PLUGIN_NAME);
      style.textContent = css;
      document.head.appendChild(style);
    }

    async function remote(method, request) {
      if (!connection?.rpc?.call) throw new Error('工作台连接尚未就绪。');
      const response = await connection.rpc.call('/api', `whiteboard/${method}`, { args: request === undefined ? {} : { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '白板动画操作未完成。');
      return response.value;
    }

    function ErrorNotice({ error }) {
      return error ? h('p', { className: 'wb-error' }, String(error.message || error)) : null;
    }

    function EmptyState({ text }) {
      return h('div', { className: 'wb-empty' }, text);
    }

    function Pill({ tone = 'muted', children }) {
      return h('span', { className: 'wb-pill', 'data-tone': tone }, children);
    }

    /** 步骤指引：把 SKILL.md 的强制流程摆在页面上，避免跳过确认关卡。 */
    function WorkflowSteps() {
      return h('div', { className: 'wb-card' },
        h('div', { className: 'wb-card-title' }, '制作流程'),
        h('p', { className: 'wb-meta' }, '每一步完成后停下来确认，再进入下一步；线稿或标注未定稿时不要开始渲染。'),
        h('ol', { className: 'wb-steps' },
          h('li', null, '解析字幕并确定分幕（每幕 25–35 秒，只表达一个核心意思）。'),
          h('li', null, '按统一的极简手绘规范生成线稿：暖米黄纸底 ', h('code', null, '#F5EBD7'), '，画面不出现任何文字。'),
          h('li', null, '结合字幕与线稿做语义标注：区域用原图整数像素坐标，', h('code', null, 'startMs'), ' 对齐字幕起止。'),
          h('li', null, '在预览台调整区域、顺序、时序与字幕关联并保存。'),
          h('li', null, '渲染单幕成片，多幕项目再合并为一条。'),
        ),
      );
    }

    function ScenesPage() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [form, setForm] = React.useState({ name: '', note: '' });
      const [selected, setSelected] = React.useState('');
      const [scenes, setScenes] = React.useState([]);
      const [srtPath, setSrtPath] = React.useState('');
      const [parsed, setParsed] = React.useState(null);
      const [elementInput, setElementInput] = React.useState('');
      const [canvasWidth, setCanvasWidth] = React.useState('');
      const [canvasHeight, setCanvasHeight] = React.useState('');
      const [planned, setPlanned] = React.useState(null);

      const reload = React.useCallback(async () => {
        try {
          const [status, projects] = await Promise.all([remote('status'), remote('listProjects')]);
          setState({ status, projects });
          setSelected((current) => current || projects[0]?.id || '');
        } catch (err) { setError(err); }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);

      const loadScenes = React.useCallback(async (projectId) => {
        if (!projectId) { setScenes([]); return; }
        try { setScenes(await remote('listScenes', { projectId })); }
        catch (err) { setError(err); }
      }, []);

      React.useEffect(() => { void loadScenes(selected); }, [selected, loadScenes]);

      const createProject = async () => {
        if (!form.name.trim()) { setError(new Error('请填写项目名称。')); return; }
        setBusy('create'); setError(null);
        try {
          const project = await remote('createProject', form);
          setForm({ name: '', note: '' });
          await reload();
          setSelected(project.id);
        } catch (err) { setError(err); } finally { setBusy(''); }
      };

      const removeProject = async (id) => {
        setBusy(`del-${id}`); setError(null);
        try {
          await remote('deleteProject', { id });
          if (selected === id) setSelected('');
          await reload();
        } catch (err) { setError(err); } finally { setBusy(''); }
      };

      const parseSrtFile = async () => {
        if (!srtPath.trim()) { setError(new Error('请填写字幕文件的完整路径。')); return; }
        setBusy('parse'); setError(null);
        try { setParsed(await remote('parseSrt', { srtPath: srtPath.trim() })); }
        catch (err) { setError(err); setParsed(null); } finally { setBusy(''); }
      };

      const planTimeline = async (scene) => {
        const elements = elementInput.split(/[\n,，]/u).map((item) => item.trim()).filter(Boolean);
        if (elements.length === 0) { setError(new Error('请按叙事顺序填写元素名称，每行一个。')); return; }
        const width = Number(canvasWidth); const height = Number(canvasHeight);
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
          setError(new Error('请填写原图的像素宽高（正整数）。')); return;
        }
        setBusy(`plan-${scene.sceneIndex}`); setError(null); setPlanned(null);
        try {
          const value = await remote('planTimeline', {
            srtPath: srtPath.trim(), scene: scene.sceneIndex, elements, width, height,
          });
          setPlanned({ scene: scene.sceneIndex, annotation: value.annotation, log: value.log });
        } catch (err) { setError(err); } finally { setBusy(''); }
      };

      const projects = state?.projects || [];
      const env = state?.status?.engine;

      return h('div', { className: 'wb-page' },
        h('div', { className: 'wb-top' },
          h('div', null,
            h('h1', null, '白板手绘动画'),
            h('p', null, '把字幕做成按叙事顺序落墨的白板手绘视频：区域坐标、出场时间与字幕关联都可在预览台里调整。'),
          ),
          h('div', { className: 'wb-actions' },
            state?.status ? h(Pill, { tone: env?.ready ? 'green' : 'orange' },
              env?.ready ? `引擎就绪${env.pythonSource === 'system' ? '（系统 Python）' : ''}` : '需准备环境') : null,
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => void reload() }, '刷新'),
          ),
        ),
        h(ErrorNotice, { error }),
        env && !env.ready ? h('p', { className: 'wb-note' },
          '尚未找到具备 OpenCV、NumPy、Pillow 的 Python 解释器。点「准备环境」会优先复用系统 Python；系统缺少依赖时才在包内创建隔离环境并安装（首次可能较慢）。') : null,
        h(WorkflowSteps, null),

        h('div', { className: 'wb-section' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '解析字幕'), h('span', null, '第一步：确定分幕')),
          h('div', { className: 'wb-card' },
            h('label', { className: 'wb-label' }, '字幕文件路径（.srt）',
              h('input', { className: 'wb-input', value: srtPath, placeholder: '例如 E:\\\\项目\\\\字幕.srt', onChange: (e) => setSrtPath(e.target.value) }),
            ),
            h('p', { className: 'wb-meta' }, '与口播管线衔接时，这里填配音字幕阶段产出的 SRT（时间轴已对齐真实音频）。'),
            h('div', { className: 'wb-actions' },
              h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy === 'parse', onClick: parseSrtFile },
                busy === 'parse' ? '解析中…' : '解析并给出分幕建议'),
            ),
            parsed ? h('div', null,
              h('p', { className: 'wb-meta' }, `共 ${parsed.cues?.length || 0} 条字幕，建议 ${parsed.scenes?.length || 0} 幕。`),
              h('div', { className: 'wb-form-grid', style: { margin: '8px 0' } },
                h('label', { className: 'wb-label' }, '元素名称（按叙事顺序，每行一个）',
                  h('textarea', { className: 'wb-textarea', value: elementInput, placeholder: '假山与小猴\n大猴抢香蕉\n小朋友围观', onChange: (e) => setElementInput(e.target.value) })),
                h('div', null,
                  h('label', { className: 'wb-label' }, '原图像素宽',
                    h('input', { className: 'wb-input', value: canvasWidth, placeholder: '1672', onChange: (e) => setCanvasWidth(e.target.value) })),
                  h('label', { className: 'wb-label', style: { marginTop: '8px' } }, '原图像素高',
                    h('input', { className: 'wb-input', value: canvasHeight, placeholder: '941', onChange: (e) => setCanvasHeight(e.target.value) })),
                ),
              ),
              h('p', { className: 'wb-meta' }, '点某一幕的「规划时间轴」，把该幕字幕的起止时间分配给这些元素——出场时间来自字幕 cue，不是估计值。区域坐标是占位值，需在预览台拖到实际主体上。'),
              h('div', { className: 'wb-list' }, (parsed.scenes || []).map((scene) => h('div', { key: scene.sceneIndex, className: 'wb-scene-row' },
                h('div', null,
                  h('strong', null, `幕 ${scene.sceneIndex} · ${(scene.sceneDurationMs / 1000).toFixed(1)} 秒`),
                  h('p', { className: 'wb-meta' }, `${(scene.startMs / 1000).toFixed(1)}s – ${(scene.endMs / 1000).toFixed(1)}s · ${scene.text?.slice(0, 60) || ''}`),
                ),
                h('div', { className: 'wb-actions' },
                  h(Pill, { tone: scene.sceneDurationMs < 25000 ? 'orange' : 'green' },
                    scene.sceneDurationMs < 25000 ? '偏短' : '合适'),
                  h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy === `plan-${scene.sceneIndex}`, onClick: () => void planTimeline(scene) },
                    busy === `plan-${scene.sceneIndex}` ? '规划中…' : '规划时间轴'),
                ),
              ))),
              planned ? h('div', null,
                h('p', { className: 'wb-meta' }, `幕 ${planned.scene} 的时间轴分配：`),
                h('div', { className: 'wb-list' }, (planned.annotation.elements || []).map((element) => h('div', { key: element.id, className: 'wb-scene-row' },
                  h('div', null,
                    h('strong', null, `${element.sequence}. ${element.label}`),
                    h('p', { className: 'wb-meta' },
                      `${(element.reveal.startMs / 1000).toFixed(1)}–${((element.reveal.startMs + element.reveal.durationMs) / 1000).toFixed(1)}s · ${element.subtitle}`),
                  ),
                  h(Pill, { tone: 'green' }, `${(element.reveal.durationMs / 1000).toFixed(1)}s`),
                ))),
                h('details', null,
                  h('summary', { className: 'wb-meta' }, '查看标注 JSON'),
                  h('pre', { className: 'wb-log' }, JSON.stringify(planned.annotation, null, 2)),
                ),
              ) : null,
              parsed.log?.length ? h('pre', { className: 'wb-log' }, parsed.log.join('\n')) : null,
            ) : null,
          ),
        ),

        h('div', { className: 'wb-section' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '项目'), h('span', null, `共 ${projects.length} 个`)),
          h('div', { className: 'wb-card wb-form' },
            h('div', { className: 'wb-form-grid' },
              h('label', { className: 'wb-label' }, '项目名称',
                h('input', { className: 'wb-input', value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
              h('label', { className: 'wb-label' }, '备注（可选）',
                h('input', { className: 'wb-input', value: form.note, onChange: (e) => setForm({ ...form, note: e.target.value }) })),
            ),
            h('div', { className: 'wb-actions' },
              h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy === 'create', onClick: createProject },
                busy === 'create' ? '创建中…' : '新建项目'),
            ),
          ),
          projects.length === 0 ? h(EmptyState, { text: '还没有项目。新建一个项目来组织各幕线稿与标注。' })
            : h('div', { className: 'wb-list' }, projects.map((project) => h('div', { key: project.id, className: 'wb-card' },
              h('div', { className: 'wb-card-head' },
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'wb-card-title' }, project.name),
                  h('p', { className: 'wb-meta' }, project.note || '无备注'),
                ),
                h('div', { className: 'wb-actions' },
                  h(Pill, { tone: selected === project.id ? 'green' : 'muted' }, `${project.scenes?.length || 0} 幕`),
                  h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => setSelected(project.id) }, '查看场景'),
                  h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy === `del-${project.id}`, onClick: () => void removeProject(project.id) }, '删除'),
                ),
              ),
            ))),
        ),

        selected ? h('div', { className: 'wb-section' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '场景'), h('span', null, `${scenes.length} 幕`)),
          scenes.length === 0
            ? h(EmptyState, { text: '该项目还没有保存的标注。标注由 Agent 按技能流程写入，或在预览台调整后保存。' })
            : h('div', { className: 'wb-list' }, scenes.map((scene) => h('div', { key: scene.imageName, className: 'wb-scene-row' },
              h('div', null,
                h('strong', null, scene.imageName),
                h('p', { className: 'wb-meta' },
                  `${scene.annotation?.elements?.length || 0} 个区域 · 总时长 ${((scene.sceneDurationMs || 0) / 1000).toFixed(1)} 秒`),
              ),
              h('div', { className: 'wb-actions' },
                h(Pill, { tone: 'green' }, '已标注'),
              ),
            ))),
        ) : null,
      );
    }

    function RenderPage() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [projects, setProjects] = React.useState([]);
      const [projectId, setProjectId] = React.useState('');
      const [scenes, setScenes] = React.useState([]);
      const [imagePath, setImagePath] = React.useState('');
      const [options, setOptions] = React.useState({ inkPath: 'grid', colorFill: 'contour-wipe', penText: '', capLongEdge: '' });
      const [log, setLog] = React.useState([]);
      const [result, setResult] = React.useState(null);
      const [mergeInputs, setMergeInputs] = React.useState('');
      const [mergeOutput, setMergeOutput] = React.useState('');

      const reload = React.useCallback(async () => {
        try {
          const [status, list] = await Promise.all([remote('status'), remote('listProjects')]);
          setState(status); setProjects(list);
          setProjectId((current) => current || list[0]?.id || '');
        } catch (err) { setError(err); }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);

      React.useEffect(() => {
        if (!projectId) { setScenes([]); return; }
        void (async () => {
          try { setScenes(await remote('listScenes', { projectId })); }
          catch (err) { setError(err); }
        })();
      }, [projectId]);

      const prepare = async () => {
        setBusy('prepare'); setError(null); setLog([]);
        try {
          const value = await remote('prepareEnvironment');
          setLog(value.log || []);
          await reload();
        } catch (err) { setError(err); } finally { setBusy(''); }
      };

      const render = async () => {
        if (!projectId) { setError(new Error('请先选择项目。')); return; }
        if (!imagePath.trim()) { setError(new Error('请填写线稿图片的完整路径。')); return; }
        setBusy('render'); setError(null); setResult(null); setLog([]);
        try {
          const request = { projectId, imagePath: imagePath.trim() };
          if (options.inkPath) request.inkPath = options.inkPath;
          if (options.colorFill) request.colorFill = options.colorFill;
          if (options.penText.trim()) request.penText = options.penText.trim();
          if (options.capLongEdge && Number.isFinite(Number(options.capLongEdge))) request.capLongEdge = Number(options.capLongEdge);
          const value = await remote('startRender', request);
          setResult(value);
          setLog((current) => [...current, `渲染已启动：${value.outputPath}`]);
        } catch (err) { setError(err); } finally { setBusy(''); }
      };

      const merge = async () => {
        const inputs = mergeInputs.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
        if (inputs.length < 2) { setError(new Error('合并至少需要两个输入文件，每行一个路径。')); return; }
        if (!mergeOutput.trim()) { setError(new Error('请填写合并输出路径。')); return; }
        setBusy('merge'); setError(null);
        try {
          const value = await remote('mergeScenes', { inputs, output: mergeOutput.trim() });
          setLog(value.log || []);
          setResult(value);
        } catch (err) { setError(err); } finally { setBusy(''); }
      };

      const env = state?.engine;

      return h('div', { className: 'wb-page' },
        h('div', { className: 'wb-top' },
          h('div', null,
            h('h1', null, '渲染成片'),
            h('p', null, '逐幕渲染白板动画，再把各幕按顺序合并为完整视频。'),
          ),
          h('div', { className: 'wb-actions' },
            state ? h(Pill, { tone: env?.ready ? 'green' : 'orange' },
              env?.ready ? `引擎就绪${env.pythonSource === 'system' ? '（系统 Python）' : ''}` : '需准备环境') : null,
            h('button', { type: 'button', className: 'lwb-plain-button', onClick: () => void reload() }, '刷新'),
          ),
        ),
        h(ErrorNotice, { error }),

        !env?.ready ? h('div', { className: 'wb-card' },
          h('div', { className: 'wb-card-title' }, '准备引擎环境'),
          h('p', { className: 'wb-meta' }, '优先复用已具备 OpenCV、NumPy、Pillow 的系统 Python；系统缺少依赖时才在包内创建隔离环境并安装。'),
          h('div', { className: 'wb-actions' },
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy === 'prepare', onClick: prepare },
              busy === 'prepare' ? '准备中…' : '准备环境'),
          ),
        ) : null,

        h('div', { className: 'wb-section' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '渲染单幕'), h('span', null, '纯本机计算，不需要联网')),
          h('div', { className: 'wb-card wb-form' },
            h('div', { className: 'wb-form-grid' },
              h('label', { className: 'wb-label' }, '项目',
                h('select', { className: 'wb-select', value: projectId, onChange: (e) => setProjectId(e.target.value) },
                  h('option', { value: '' }, '选择项目'),
                  projects.map((project) => h('option', { key: project.id, value: project.id }, project.name)),
                )),
              h('label', { className: 'wb-label' }, '线稿图片路径',
                h('input', { className: 'wb-input', value: imagePath, placeholder: '例如 E:\\\\项目\\\\scene-01.png', onChange: (e) => setImagePath(e.target.value) })),
              h('label', { className: 'wb-label' }, '笔迹路径',
                h('select', { className: 'wb-select', value: options.inkPath, onChange: (e) => setOptions({ ...options, inkPath: e.target.value }) },
                  h('option', { value: 'grid' }, '网格（默认，稳定）'),
                  h('option', { value: 'skeleton' }, '骨架追踪（线稿清晰时更贴合）'),
                )),
              h('label', { className: 'wb-label' }, '上色风格',
                h('select', { className: 'wb-select', value: options.colorFill, onChange: (e) => setOptions({ ...options, colorFill: e.target.value }) },
                  h('option', { value: 'contour-wipe' }, '轮廓扫描（默认）'),
                  h('option', { value: 'brush' }, '沿轨迹刷'),
                )),
              h('label', { className: 'wb-label' }, '笔杆文案（可选）',
                h('input', { className: 'wb-input', value: options.penText, placeholder: '留空则笔杆无文字', onChange: (e) => setOptions({ ...options, penText: e.target.value }) })),
              h('label', { className: 'wb-label' }, '输出长边像素（可选）',
                h('input', { className: 'wb-input', value: options.capLongEdge, placeholder: '默认 1080；调试可用 640 加速', onChange: (e) => setOptions({ ...options, capLongEdge: e.target.value }) })),
            ),
            h('p', { className: 'wb-meta' }, '图片需与同名标注文件配对：foo.png 对应 foo.annotation.json。标注请先在预览台确认并保存。'),
            h('div', { className: 'wb-actions' },
              h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy === 'render' || !env?.ready, onClick: render },
                busy === 'render' ? '提交中…' : '开始渲染'),
            ),
            scenes.length ? h('p', { className: 'wb-meta' }, `该项目已保存 ${scenes.length} 幕：${scenes.map((s) => s.imageName).join('、')}`) : null,
          ),
        ),

        h('div', { className: 'wb-section' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '合并多幕'), h('span', null, '按输入顺序拼接')),
          h('div', { className: 'wb-card wb-form' },
            h('label', { className: 'wb-label' }, '输入文件（每行一个路径，按播放顺序）',
              h('textarea', { className: 'wb-textarea', value: mergeInputs, onChange: (e) => setMergeInputs(e.target.value) })),
            h('label', { className: 'wb-label' }, '输出路径',
              h('input', { className: 'wb-input', value: mergeOutput, onChange: (e) => setMergeOutput(e.target.value) })),
            h('div', { className: 'wb-actions' },
              h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy === 'merge' || !env?.ready, onClick: merge },
                busy === 'merge' ? '合并中…' : '合并'),
            ),
          ),
        ),

        log.length ? h('div', { className: 'wb-section' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '运行输出'), h('span', null, `${log.length} 行`)),
          h('pre', { className: 'wb-log' }, log.join('\n')),
        ) : null,

        result?.outputPath ? h('p', { className: 'wb-note' }, `产物：${result.outputPath}`) : null,
      );
    }

    async function apply(ctx) {
      connection = ctx.get('connection');
      installStyle();
      ctx.effect(() => ctx.lwbPackClient.register({
        packId: PACK_ID,
        pages: { scenes: ScenesPage, render: RenderPage },
      }), 'whiteboard: register capability pages');
    }
    exports.inject = ['connection', 'lwbPackClient'];
    exports.apply = apply;
    return module.exports;
  },
});
