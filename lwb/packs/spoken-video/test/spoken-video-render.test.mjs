// Regression: a useEffect dependency array referencing an identifier declared
// later in the component body (TDZ) crashes the whole page at render time.
// The other client tests only match source with regexes — they never execute a
// component — so this file renders every registered page once with a minimal
// React stub. A ReferenceError from render surfaces here as a test failure.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const clientPath = new URL('../client.js', import.meta.url)

function makeReactStub() {
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const passthrough = (value) => [value, () => {}];
  for (const name of ['useState', 'useRef', 'useMemo', 'useCallback', 'useSyncExternalStore']) {
    react[name] = (init) => passthrough(typeof init === 'function' ? init() : init);
  }
  // useRef must return { current }, not an array.
  react.useRef = (init) => ({ current: init });
  react.useMemo = (compute) => compute();
  react.useCallback = (compute) => compute;
  react.useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();
  // Effects run their dependency array evaluation during render; the body must
  // NOT run here (we only render once, with no commit phase).
  react.useEffect = (body, deps) => { void deps; };
  return react;
}

function loadClientModule(source) {
  const react = makeReactStub();
  const registered = { pages: null };
  const primitives = {
    IconSettingsOutline16: () => null,
    MarkdownText: () => null,
  };
  const connection = { get: () => { throw new Error('not used during render') } };
  const remoteStreams = { $mount: async () => {} };
  const plugins = [];
  const packClient = {
    register: (entry) => { registered.pages = entry.pages; },
  };
  const ctx = {
    get: (name) => (name === 'connection' ? connection : remoteStreams),
    plugin: (entry) => plugins.push(entry),
    effect: () => {},
    lwbPackClient: packClient,
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (module) => module } },
    require: (id) => (id === 'react' ? react : primitives),
    globalThis: { crypto: {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  // The loader captured the module object; run its factory to get exports.
  return { moduleFactory: null, registered, ctx, sandbox };
}

test('every registered pack page renders without a TDZ crash', async () => {
  const source = await readFile(clientPath, 'utf8');
  const react = makeReactStub();
  const registered = { pages: null, applied: false };
  const primitives = { IconSettingsOutline16: () => null, MarkdownText: () => null };
  const remoteStreams = { $mount: async () => {} };
  const plugins = [];
  const packClient = { register: (entry) => { registered.pages = entry.pages; } };
  const ctx = {
    get: () => remoteStreams,
    plugin: async (entry) => entry.apply({ get: () => remoteStreams, effect: (fn) => fn() }),
    // Effects fire immediately so the register call inside lands synchronously.
    effect: (fn) => fn(),
    lwbPackClient: packClient,
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (module) => { sandbox.module = module; } } },
    require: (id) => (id === 'react' ? react : primitives),
    globalThis: { crypto: {} },
    console,
    document: { getElementById: () => null, createElement: () => ({ setAttribute() {}, style: {} }), head: { appendChild() {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(sandbox.module, 'module loader must have received the pack module');
  const exports = sandbox.module.factory(sandbox.require);
  assert.equal(typeof exports.apply, 'function', 'pack module must export apply');
  await exports.apply(ctx);
  assert.ok(registered.pages, 'apply must register capability pages');

  const pages = registered.pages;
  const pageIds = Object.keys(pages);
  assert.ok(pageIds.length >= 9, `expected at least 9 pages, got ${pageIds.length}`);

  const props = { packId: 'spoken-video', openConversation: () => {}, openPackMenu: () => {} };
  for (const [pageId, Component] of Object.entries(pages)) {
    assert.equal(typeof Component, 'function', `page ${pageId} must be a component`);
    // TDZ and other render-time crashes throw right here.
    assert.doesNotThrow(() => Component(props), `page ${pageId} must render`);
  }
});
