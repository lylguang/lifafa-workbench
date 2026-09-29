window.__ModuleLoader__.load({
  id: '@scitiger-ai/lwb-dsh-bundle',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const { IconSettingsOutline16, IconNewChatOutline16, IconCordisPluginOutline14, IconChevronLeftOutline14, IconArchiveOutline20, IconBranchOutline16, IconEditOutline16, IconEllipsisOutline16, IconProjectAddOutline16, IconTrashOutline16, Menu } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    // Browsers expose crypto.randomUUID only in secure contexts. The workbench
    // also supports authenticated plain-HTTP LAN previews, where getRandomValues
    // remains available; install the missing method once before packs load.
    function installLanCryptoCompatibility() {
      const cryptoApi = globalThis.crypto;
      if (!cryptoApi || typeof cryptoApi.randomUUID === 'function' || typeof cryptoApi.getRandomValues !== 'function') return;
      const randomUUID = () => {
        const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
      try { Object.defineProperty(cryptoApi, 'randomUUID', { value: randomUUID, configurable: true, writable: true }); } catch (_) {}
    }
    installLanCryptoCompatibility();

    const STORAGE_KEY = 'lwb.workbench.v3';
    const SETTINGS_NAMESPACE = 'lwb-workbench';
    const BASE_CONTRACT_VERSION = 9;
    let services;
    let runtimeApi;
    let remoteSettingsCompatibilityWarning = false;

    const defaultState = {
      baseContractVersion: BASE_CONTRACT_VERSION,
      page: 'conversation',
      capabilityPage: null,
    };

    let productState = readState();
    const productListeners = new Set();

    function cloneDefaults() {
      return JSON.parse(JSON.stringify(defaultState));
    }
    function normalizeState(source) {
      const fallback = cloneDefaults();
      const input = source && typeof source === 'object' ? source : {};
      return Object.assign(fallback, {
        baseContractVersion: BASE_CONTRACT_VERSION,
        page: ['packs', 'settings', 'capability'].includes(input.page) ? input.page : fallback.page,
        capabilityPage: typeof input.capabilityPage === 'string' ? input.capabilityPage : null,
        stateUpdatedAt: Number.isFinite(input.stateUpdatedAt) ? input.stateUpdatedAt : undefined,
      });
    }
    function readState() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return normalizeState(saved);
      } catch (_) {
        return cloneDefaults();
      }
    }
    function persistedSnapshot(state) {
      return {
        baseContractVersion: BASE_CONTRACT_VERSION,
        stateUpdatedAt: Number.isFinite(state.stateUpdatedAt) ? state.stateUpdatedAt : Date.now(),
      };
    }
    function persist(state) {
      const snapshot = persistedSnapshot(state);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch (_) {}
      if (runtimeApi?.settings?.mutate) {
        const commit = runtimeApi.settings.mutate({
          ns: SETTINGS_NAMESPACE,
          ops: [{ op: 'set', path: ['state'], value: snapshot }],
        });
        void commit.catch(() => {});
        return commit;
      }
      return Promise.resolve();
    }
    function notify(listeners) {
      listeners.forEach((listener) => listener());
    }
    function updateProduct(update, shouldPersist = true) {
      productState = typeof update === 'function' ? update(productState) : Object.assign({}, productState, update);
      if (shouldPersist) {
        productState = Object.assign({}, productState, { stateUpdatedAt: Date.now() });
        const commit = persist(productState);
        notify(productListeners);
        return commit;
      }
      notify(productListeners);
      return Promise.resolve();
    }
    function useProduct() {
      return React.useSyncExternalStore(
        (listener) => { productListeners.add(listener); return () => productListeners.delete(listener); },
        () => productState,
        () => productState,
      );
    }
    function useObservable(observable, fallback) {
      return React.useSyncExternalStore(
        (listener) => observable?.subscribe ? observable.subscribe(listener) : () => {},
        () => observable?.getSnapshot ? observable.getSnapshot() : fallback,
        () => fallback,
      );
    }

    const LWB_COPY = {
      zh: {
        conversation: '对话', packs: '场景能力包', settings: '设置', capability: '能力包页面',
        packsHint: '可组合的场景能力包', settingsHint: '工作台的系统配置与偏好', capabilityHint: '已加载能力包的页面入口',
        workbench: '工作台', workbenchFeatures: '工作台功能', loadedPacks: '已加载能力包', localWorkbench: '本机单用户工作台',
        collapseSidebar: '收起侧栏', closeNavigation: '关闭导航', openNavigation: '打开导航', openConversationList: '打开会话列表',
        expandPack: (name) => `展开${name}`, collapsePack: (name) => `收起${name}`,
        conversationModule: '对话模块', conversationHistory: '会话历史', closeConversationList: '关闭会话列表',
        session: '会话', newConversation: '新建对话', readingWorkspaces: '正在读取工作区', searchConversations: '搜索对话…',
        searchResults: '搜索结果', workspaces: '工作区', addWorkspace: '添加工作区', loadingWorkspaces: '正在读取 DSH 工作区…',
        noWorkspaces: '尚未添加工作区。', unassignedSessions: '未归属会话', archivedSessions: '已归档会话',
        noArchivedSessions: '暂无已归档会话。', noMatchingSessions: '没有匹配的会话。', noSessionsInWorkspace: '该工作区暂无会话。',
        unnamedWorkspace: '未命名工作区', unnamedConversation: '未命名对话', unnamedFile: '未命名文件', count: (count) => `${count} 个`,
        workspaceAction: (title) => `工作区操作：${title}`, sessionAction: (title) => `会话操作：${title}`,
        newConversationInWorkspace: (title) => `在 ${title} 中新建对话`,
        restoreSession: '恢复会话', restoreToWorkspace: (title) => `恢复到工作区「${title}」`,
        rename: '重命名', forkConversation: '分叉会话', assignWorkspace: (title) => `加入工作区「${title}」`, archiveConversation: '归档会话', deleteWorkspace: '删除工作区',
        dialogNameRequired: '名称不能为空。', dialogProcessing: '正在处理…', close: '关闭', name: '名称', cancel: '取消',
        renameWorkspace: '重命名工作区', renameWorkspaceCopy: '名称只会更新此工作区在对话列表中的显示。', saveName: '保存名称',
        deleteWorkspaceCopy: (title) => `确定删除工作区「${title}」吗？该工作区内的会话、日志和目录都会保留，并显示为未归属会话。`,
        renameConversation: '重命名对话', renameConversationCopy: '名称将同步到 DSH 会话历史。',
        archiveConversationCopy: (title) => `确定归档对话「${title}」吗？归档后会从常规历史中隐藏，但对话内容会保留。`,
        createConversationFailed: '无法创建对话', addWorkspaceFailed: '无法添加工作区', operationFailed: '操作未完成，请稍后重试。',
        sessionAddedToWorkspace: (title) => `已将会话加入工作区「${title}」。`, sessionRestoredToWorkspace: (title) => `已将会话恢复到工作区「${title}」。`, sessionRestoredUnassigned: '已恢复会话；原工作区已不存在，因此会话显示为未归属会话。',
        active: '已加载', mounted: '已挂载', stopped: '已停用', installed: '已安装', available: '可加载', unavailable: '不可用',
        installedTab: '已安装', loadedTab: '已加载', market: '能力市场', updates: '可更新', availableLater: '后续版本开放',
        disable: '停用', reload: '重新加载', load: '加载', unload: '卸载', openMenu: '打开菜单', details: '详情', migrate: '迁移', accept: '验收',
        packFeatures: '包含哪些能力', packGettingStarted: '开始使用前', packJourney: '创作路径', packDataManagement: '数据管理', packLoadAction: '加载能力包', packStartAction: '开始使用', packLoadHint: '加载后，功能入口将出现在左侧导航。', packReadyHint: '能力包已加载，可以开始创作。', packManageHint: '卸载能力包后可管理业务数据与工作区。',
        packType: '场景能力包', noLoadedPacks: '暂无已加载能力包', noInstalledPacks: '尚未安装场景能力包',
        packsEmptyCopy: '尚未发现可加载的场景能力包。可通过通用安装命令注册任意独立能力包。', loadingPacks: '正在读取能力包市场…', packCatalogFailed: '无法读取能力包市场。',
        packDetails: (name) => `${name} 详情`, currentStatus: '当前状态', menuCount: '菜单数量', packDescription: '能力包说明', registeredMenus: '加载后菜单', firstPhaseEmpty: '第一期空态',
        marketSearch: '搜索能力包、标签或功能…', filterAll: '全部', filterLoaded: '已加载', filterAvailable: '可加载', filterCategory: '分类', noMatchingPacks: '没有匹配的能力包。', packWorkflow: '功能流程', packTags: '标签', packOrigin: '来源', loadingPack: '正在加载…', unloadingPack: '正在卸载…', packLoaded: '能力包已加载。', packUnloaded: '能力包已卸载。', workspacePack: '工作区包', localPack: '本地包', unavailablePack: '能力包源不可用，无法加载。',
        noCapability: '能力包尚未加载', noCapabilityCopy: '请在“场景能力包”中安装并加载领域能力包。', goToPacks: '前往能力包',
        capabilityPageCopy: (name) => `“${name}”没有提供此菜单对应的浏览器页面。`, clientUnavailable: '能力包客户端页面不可用',
        capabilityPageFailed: '能力包页面暂时不可用', capabilityPageFailedCopy: '该页面未能正常渲染。工作台导航仍可用，可返回对话或打开场景能力包。',
        returnToConversation: '返回对话', viewPacks: '查看能力包',
        about: '关于', runtime: '运行方式', runtimeHint: '基于 DeepSeek Harness（DSH）构建的本机单用户工作台。', connected: '已连接', connecting: '连接中', disconnected: '连接已断开', basicConfiguration: '基础配置', systemSettings: '系统设置', systemSettingsHint: '配置语言与外观、模型服务、权限、插件及 Agent 预设。', openRuntimeSettings: '打开设置',
        packsIntro: '基础版暂未预装场景能力包；加载后的能力包会实时注入左侧菜单。', settingsIntro: '管理工作台的系统配置与偏好。', capabilityIntro: '已加载能力包的页面入口。',
      },
      en: {
        conversation: 'Conversation', packs: 'Capability Packs', settings: 'Settings', capability: 'Capability Page',
        packsHint: 'Composable capability packs', settingsHint: 'Workbench system configuration and preferences', capabilityHint: 'Entry point for the loaded capability pack',
        workbench: 'WORKBENCH', workbenchFeatures: 'Workbench features', loadedPacks: 'Loaded capability packs', localWorkbench: 'Local single-user workbench',
        collapseSidebar: 'Collapse sidebar', closeNavigation: 'Close navigation', openNavigation: 'Open navigation', openConversationList: 'Open conversation list',
        expandPack: (name) => `Expand ${name}`, collapsePack: (name) => `Collapse ${name}`,
        conversationModule: 'Conversation module', conversationHistory: 'Conversation history', closeConversationList: 'Close conversation list',
        session: 'Sessions', newConversation: 'New conversation', readingWorkspaces: 'Loading workspaces', searchConversations: 'Search conversations...',
        searchResults: 'Search results', workspaces: 'Workspaces', addWorkspace: 'Add workspace', loadingWorkspaces: 'Loading DSH workspaces...',
        noWorkspaces: 'No workspaces added yet.', unassignedSessions: 'Unassigned sessions', archivedSessions: 'Archived sessions',
        noArchivedSessions: 'No archived sessions.', noMatchingSessions: 'No matching sessions.', noSessionsInWorkspace: 'No sessions in this workspace.',
        unnamedWorkspace: 'Untitled workspace', unnamedConversation: 'Untitled conversation', unnamedFile: 'Untitled file', count: (count) => `${count}`,
        workspaceAction: (title) => `Workspace actions: ${title}`, sessionAction: (title) => `Conversation actions: ${title}`,
        newConversationInWorkspace: (title) => `New conversation in ${title}`,
        restoreSession: 'Restore conversation', restoreToWorkspace: (title) => `Restore to ${title}`,
        rename: 'Rename', forkConversation: 'Fork conversation', assignWorkspace: (title) => `Add to ${title}`, archiveConversation: 'Archive conversation', deleteWorkspace: 'Delete workspace',
        dialogNameRequired: 'Name is required.', dialogProcessing: 'Processing...', close: 'Close', name: 'Name', cancel: 'Cancel',
        renameWorkspace: 'Rename workspace', renameWorkspaceCopy: 'This changes only the workspace name shown in the conversation list.', saveName: 'Save name',
        deleteWorkspaceCopy: (title) => `Delete ${title}? Its sessions, logs, and directory will remain and appear as unassigned conversations.`,
        renameConversation: 'Rename conversation', renameConversationCopy: 'The new name will be synced to DSH conversation history.',
        archiveConversationCopy: (title) => `Archive ${title}? It will be hidden from the regular history, while its conversation content is retained.`,
        createConversationFailed: 'Unable to create conversation', addWorkspaceFailed: 'Unable to add workspace', operationFailed: 'The operation could not be completed. Please try again.',
        sessionAddedToWorkspace: (title) => `Added conversation to ${title}.`, sessionRestoredToWorkspace: (title) => `Restored conversation to ${title}.`, sessionRestoredUnassigned: 'The conversation was restored, but its original workspace no longer exists, so it is shown as unassigned.',
        active: 'Loaded', mounted: 'Mounted', stopped: 'Stopped', installed: 'Installed', available: 'Available', unavailable: 'Unavailable',
        installedTab: 'Installed', loadedTab: 'Loaded', market: 'Marketplace', updates: 'Updates', availableLater: 'Available in a later release',
        disable: 'Disable', reload: 'Reload', load: 'Load', unload: 'Unload', openMenu: 'Open menu', details: 'Details', migrate: 'Migrate', accept: 'Accept',
        packFeatures: 'Included capabilities', packGettingStarted: 'Before you start', packJourney: 'Workflow', packDataManagement: 'Data management', packLoadAction: 'Load capability pack', packStartAction: 'Start using', packLoadHint: 'Loading adds these features to the sidebar.', packReadyHint: 'The pack is loaded and ready to open.', packManageHint: 'Unload the pack to manage its data and workspace.',
        packType: 'Capability pack', noLoadedPacks: 'No capability packs loaded', noInstalledPacks: 'No capability packs installed',
        packsEmptyCopy: 'No loadable scenario capability pack was discovered. Register any standalone pack with the generic installer.', loadingPacks: 'Loading capability marketplace...', packCatalogFailed: 'Unable to load capability marketplace.',
        packDetails: (name) => `${name} details`, currentStatus: 'Current status', menuCount: 'Menu items', packDescription: 'Capability pack description', registeredMenus: 'Menus after loading', firstPhaseEmpty: 'First-release placeholder',
        marketSearch: 'Search packs, tags, or functions...', filterAll: 'All', filterLoaded: 'Loaded', filterAvailable: 'Available', filterCategory: 'Category', noMatchingPacks: 'No matching capability packs.', packWorkflow: 'Workflow', packTags: 'Tags', packOrigin: 'Source', loadingPack: 'Loading...', unloadingPack: 'Unloading...', packLoaded: 'Capability pack loaded.', packUnloaded: 'Capability pack unloaded.', workspacePack: 'Workspace pack', localPack: 'Local pack', unavailablePack: 'The package source is unavailable and cannot be loaded.',
        noCapability: 'No capability pack loaded', noCapabilityCopy: 'Install and load a domain capability pack from Capability Packs.', goToPacks: 'Go to capability packs',
        capabilityPageCopy: (name) => `${name} does not provide a browser page for this menu.`, clientUnavailable: 'Capability pack client page is unavailable',
        capabilityPageFailed: 'Capability page is temporarily unavailable', capabilityPageFailedCopy: 'This page could not render. Workbench navigation remains available, so you can return to the conversation or open capability packs.',
        returnToConversation: 'Back to conversation', viewPacks: 'View capability packs',
        about: 'ABOUT', runtime: 'Runtime', runtimeHint: 'A local single-user workbench built on DeepSeek Harness (DSH).', connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', basicConfiguration: 'BASIC CONFIGURATION', systemSettings: 'System settings', systemSettingsHint: 'Configure language, appearance, model providers, permissions, plugins, and agent presets.', openRuntimeSettings: 'Open settings',
        packsIntro: 'The base release has no scenario capability packs preinstalled; loaded packs will appear in the left menu.', settingsIntro: 'Manage the workbench’s system configuration and preferences.', capabilityIntro: 'Entry point for the loaded capability pack.',
      },
    };
    function useLwbCopy() {
      const locale = useObservable(services?.locale, { active: 'zh' });
      return locale.active === 'en' ? LWB_COPY.en : LWB_COPY.zh;
    }
    function currentLwbCopy() {
      return services?.locale?.getSnapshot?.()?.active === 'en' ? LWB_COPY.en : LWB_COPY.zh;
    }

    const PACK_ID = /^[a-z][a-z0-9-]{1,62}$/;
    const PACK_MENU_ID = /^[a-z][a-z0-9-]{0,62}$/;
    let packCatalog = { phase: 'pending', packs: [], error: null };
    let packVisibility = null;
    const packCatalogListeners = new Set();
    let packMarket = { phase: 'pending', packs: [], error: null };
    const packMarketListeners = new Set();
    let lwbPackClient;
    let lwbPackClientRuntime;

    function capabilityRoute(packId, menuId) { return `${packId}:${menuId}`; }
    function capabilityAtRoute(packs, route) {
      if (typeof route !== 'string') return undefined;
      const separator = route.indexOf(':');
      if (separator < 1) return undefined;
      const packId = route.slice(0, separator);
      const menuId = route.slice(separator + 1);
      const pack = packs.find((candidate) => candidate.id === packId);
      const menu = pack?.menus.find((candidate) => candidate.id === menuId);
      return pack && menu ? { pack, menu } : undefined;
    }
    function normalizePackText(value, fallback, maxLength) {
      if (typeof value !== 'string') return fallback;
      const normalized = value.trim();
      return normalized && normalized.length <= maxLength ? normalized : fallback;
    }
    function normalizePackCatalog(value) {
      if (!value || typeof value !== 'object' || !Array.isArray(value.packs)) throw new Error('能力包目录返回了无效的数据。');
      const ids = new Set();
      const packs = value.packs.map((candidate) => {
        if (!candidate || typeof candidate !== 'object') throw new Error('能力包目录包含无效条目。');
        const id = normalizePackText(candidate.id, '', 63);
        if (!PACK_ID.test(id) || ids.has(id)) throw new Error('能力包目录包含重复或无效标识。');
        ids.add(id);
        const menuIds = new Set();
        if (!Array.isArray(candidate.menus) || candidate.menus.length === 0) throw new Error('能力包目录缺少菜单。');
        const menus = candidate.menus.map((menu) => {
          const menuId = normalizePackText(menu?.id, '', 63);
          if (!PACK_MENU_ID.test(menuId) || menuIds.has(menuId)) throw new Error('能力包目录包含重复或无效菜单。');
          menuIds.add(menuId);
          return {
            id: menuId,
            label: normalizePackText(menu.label, menuId, 80),
            glyph: normalizePackText(menu.glyph, '▦', 8),
            tone: ['blue', 'green', 'orange', 'pink', 'red', 'violet'].includes(menu.tone) ? menu.tone : 'blue',
          };
        });
        return {
          id,
          packageName: normalizePackText(candidate.packageName, '', 214),
          name: normalizePackText(candidate.name, id, 120),
          version: normalizePackText(candidate.version, '0.0.0', 64),
          description: normalizePackText(candidate.description, '', 500),
          menus,
          status: 'loaded',
        };
      });
      return { phase: 'ready', packs, error: null, visibility: packVisibility };
    }
    function setPackCatalog(next) {
      packCatalog = Object.assign({}, next, { visibility: packVisibility });
      packCatalogListeners.forEach((listener) => listener());
    }
    function usePackCatalog() {
      return React.useSyncExternalStore(
        (listener) => { packCatalogListeners.add(listener); return () => packCatalogListeners.delete(listener); },
        () => packCatalog,
        () => packCatalog,
      );
    }
    function setPackMarket(next) {
      packMarket = next;
      packMarketListeners.forEach((listener) => listener());
    }
    function usePackMarket() {
      return React.useSyncExternalStore(
        (listener) => { packMarketListeners.add(listener); return () => packMarketListeners.delete(listener); },
        () => packMarket,
        () => packMarket,
      );
    }
    function normalizePackMarket(value) {
      const base = normalizePackCatalog(value);
      const packs = base.packs.map((pack, index) => {
        const candidate = value.packs[index] || {};
        const status = ['loaded', 'available', 'unavailable'].includes(candidate.status) ? candidate.status : 'available';
        const market = candidate.market && typeof candidate.market === 'object' && !Array.isArray(candidate.market) ? candidate.market : {};
        const tags = Array.isArray(market.tags) ? market.tags.map((tag) => normalizePackText(tag, '', 32)).filter(Boolean).slice(0, 8) : [];
        const workflow = Array.isArray(market.workflow) ? market.workflow.map((step) => normalizePackText(step, '', 80)).filter(Boolean).slice(0, 16) : [];
        return Object.assign(pack, {
          status,
          origin: ['workspace', 'local'].includes(candidate.origin) ? candidate.origin : 'workspace',
          category: normalizePackText(market.category, '通用', 48),
          tags,
          workflow,
          introduction: normalizePackText(market.introduction, pack.description, 500),
          workflowHint: normalizePackText(market.workflowHint, '', 240),
          gettingStarted: Array.isArray(market.gettingStarted) ? market.gettingStarted.map((item) => normalizePackText(item, '', 240)).filter(Boolean).slice(0, 8) : [],
          features: pack.menus.map((menu) => {
            const feature = Array.isArray(market.features) ? market.features.find((item) => item?.menuId === menu.id) : null;
            return { menuId: menu.id, title: normalizePackText(feature?.title, menu.label, 80), description: normalizePackText(feature?.description, '', 240), icon: normalizePackText(feature?.icon, 'pack', 32), tone: menu.tone };
          }),
          icon: normalizePackText(market.icon, pack.menus[0]?.glyph || '▦', 8),
          error: typeof candidate.error === 'string' ? candidate.error.slice(0, 500) : null,
        });
      });
      return { phase: 'ready', packs, error: null };
    }
    async function refreshPackCatalog(options = {}) {
      if (!services?.connection?.rpc?.call) return;
      const retain = options.retain === true;
      if (!retain) {
        setPackCatalog({ phase: 'pending', packs: packCatalog.packs, error: null });
        setPackMarket({ phase: 'pending', packs: packMarket.packs, error: null });
      }
      try {
        const [activeResponse, marketResponse, visibilityResponse] = await Promise.all([
          services.connection.rpc.call('/api', 'lwbPacks/list', { args: {} }),
          services.connection.rpc.call('/api', 'lwbPacks/market', { args: {} }),
          services.connection.rpc.call('/api', 'lwbPacks/visibility', { args: {} }),
        ]);
        if (!visibilityResponse?.ok) throw new Error(visibilityResponse?.error?.message || '无法读取能力包工作区归属。');
        packVisibility = visibilityResponse.value;
        if (!activeResponse?.ok) throw new Error(activeResponse?.error?.message || '无法读取已加载能力包。');
        setPackCatalog(normalizePackCatalog(activeResponse.value));
        if (!marketResponse?.ok) throw new Error(marketResponse?.error?.message || '无法读取能力包市场。');
        setPackMarket(normalizePackMarket(marketResponse.value));
      } catch (error) {
        const message = error?.message || '无法读取能力包目录。';
        if (retain) {
          setPackCatalog({ phase: 'ready', packs: packCatalog.packs, error: message });
          setPackMarket({ phase: 'ready', packs: packMarket.packs, error: message });
        } else {
          setPackCatalog({ phase: 'error', packs: [], error: message });
          setPackMarket({ phase: 'error', packs: [], error: message });
        }
        throw error;
      }
    }
    class LwbPackClientRegistry {
      constructor() {
        this.pages = new Map();
        this.listeners = new Set();
        this.version = 0;
      }
      register(contribution) {
        if (!contribution || typeof contribution !== 'object' || !PACK_ID.test(contribution.packId || '')) {
          throw new Error('LWB capability pack client contribution requires a valid packId.');
        }
        if (!contribution.pages || typeof contribution.pages !== 'object' || Array.isArray(contribution.pages)) {
          throw new Error('LWB capability pack client contribution requires a pages object.');
        }
        const entries = Object.entries(contribution.pages);
        if (entries.length === 0) throw new Error('LWB capability pack client contribution requires at least one page.');
        const keys = entries.map(([menuId, Component]) => {
          if (!PACK_MENU_ID.test(menuId) || typeof Component !== 'function') {
            throw new Error('LWB capability pack client contribution contains an invalid page.');
          }
          return [capabilityRoute(contribution.packId, menuId), Component];
        });
        for (const [key] of keys) {
          if (this.pages.has(key)) throw new Error(`LWB capability pack client page is already registered: ${key}`);
        }
        keys.forEach(([key, Component]) => this.pages.set(key, Component));
        this.version += 1;
        this.listeners.forEach((listener) => listener());
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          keys.forEach(([key, Component]) => { if (this.pages.get(key) === Component) this.pages.delete(key); });
          this.version += 1;
          this.listeners.forEach((listener) => listener());
        };
      }
      page(packId, menuId) { return this.pages.get(capabilityRoute(packId, menuId)); }
      subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
      getSnapshot() { return this.version; }
    }
    function useLwbPackClient() {
      React.useSyncExternalStore(
        (listener) => lwbPackClient?.subscribe(listener) || (() => {}),
        () => lwbPackClient?.getSnapshot() || 0,
        () => 0,
      );
      return lwbPackClient;
    }

    function packageId(value) {
      return typeof value === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value) ? value : null;
    }
    function runtimeBundle(value, expectedId) {
      if (!value || typeof value !== 'object') throw new Error('能力包未返回浏览器模块信息。');
      const id = packageId(value.id);
      if (!id || id !== expectedId || id !== packageId(expectedId)) throw new Error('能力包返回了无效的浏览器模块标识。');
      if (typeof value.rev !== 'string' || !value.rev) throw new Error('能力包返回了无效的浏览器模块版本。');
      if (typeof value.url !== 'string') throw new Error('能力包返回了无效的浏览器模块地址。');
      const url = new URL(value.url, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/plugins/') || !url.searchParams.get('rev')) {
        throw new Error('能力包浏览器模块地址不受信任。');
      }
      const list = (field) => {
        if (value[field] === undefined) return [];
        if (!Array.isArray(value[field]) || value[field].some((item) => !packageId(item))) throw new Error(`能力包返回了无效的 ${field} 依赖。`);
        return value[field];
      };
      return { id, rev: value.rev, url: url.href, inject: list('inject'), external: list('external') };
    }
    function moduleName(value) { return typeof value === 'string' && value.endsWith('/client') ? value.slice(0, -7) : value; }
    function loadBundleScript(url) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.async = true;
        script.src = url;
        script.addEventListener('load', () => { script.remove(); resolve(); }, { once: true });
        script.addEventListener('error', () => { script.remove(); reject(new Error('能力包浏览器模块加载失败。')); }, { once: true });
        document.head.append(script);
      });
    }
    function removeOwnedStyles(id) {
      for (const style of document.querySelectorAll('style[data-plugin]')) {
        if (style.getAttribute('data-plugin') === id) style.remove();
      }
    }
    class LwbPackClientRuntime {
      constructor(loader, modules) {
        this.loader = loader;
        this.modules = modules;
        this.tail = Promise.resolve();
        this.bundles = new Map();
      }
      serial(operation) {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => {});
        return result;
      }
      entryFor(packageName) {
        return [...this.loader.entries()].find((entry) => entry.options.name === packageName);
      }
      async removeEntry(entry) {
        this.loader.remove(entry.id);
        while (entry.fiber?.inertia) await entry.fiber.inertia;
      }
      dependenciesReady(bundle) {
        const boot = new Set(this.modules.manifest?.modules?.map((row) => row.id) || []);
        for (const dependency of [...bundle.inject, ...bundle.external].map(moduleName)) {
          if (dependency === bundle.id || boot.has(dependency) || this.entryFor(dependency)) continue;
          throw new Error(`能力包依赖的浏览器模块 ${JSON.stringify(dependency)} 尚未在当前页面加载。`);
        }
      }
      bootBundleFor(packageName) {
        const row = this.modules.manifest?.modules?.find((candidate) => candidate.id === packageName);
        if (!row) return undefined;
        return { id: row.id, url: row.url, rev: row.rev, inject: row.inject, external: row.external };
      }
      bundleFor(pack) {
        const packageName = packageId(pack?.packageName);
        return packageName && (this.bundles.get(packageName) || this.bootBundleFor(packageName));
      }
      async load(pack, value = this.bundleFor(pack)) {
        const bundle = runtimeBundle(value, pack.packageName);
        return this.serial(async () => {
          if (this.entryFor(bundle.id)) return;
          this.dependenciesReady(bundle);
          let entryId;
          try {
            this.modules.invalidate(bundle.id);
            await loadBundleScript(bundle.url);
            entryId = await this.loader.create({ name: bundle.id });
            const fiber = this.loader.resolve(entryId).fiber;
            if (!fiber) throw new Error('能力包浏览器模块未能创建运行实例。');
            await fiber.await();
            this.bundles.set(bundle.id, bundle);
          } catch (error) {
            if (entryId) {
              try { await this.removeEntry(this.loader.resolve(entryId)); } catch (_) {}
            }
            this.modules.invalidate(bundle.id);
            removeOwnedStyles(bundle.id);
            throw error;
          }
        });
      }
      async unload(pack) {
        const packageName = packageId(pack?.packageName);
        if (!packageName) throw new Error('能力包缺少浏览器模块标识。');
        return this.serial(async () => {
          const entries = [...this.loader.entries()].filter((entry) => entry.options.name === packageName);
          for (const entry of entries) await this.removeEntry(entry);
          this.modules.invalidate(packageName);
          removeOwnedStyles(packageName);
          this.bundles.delete(packageName);
        });
      }
    }
    async function archiveRemote(method, request) {
      if (!services?.connection?.rpc?.call) throw new Error('DSH 连接尚未就绪');
      const response = await services.connection.rpc.call('/api', `lwbArchives/${method}`, { args: { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '归档操作失败');
      return response.value;
    }
    function navTo(page, capabilityPage) {
      updateProduct({ page, capabilityPage: capabilityPage || null, mobileNavOpen: false, conversationPanelOpen: false }, false);
      if (page !== 'conversation') persist(productState);
    }
    function showConversation(sessionId) {
      if (sessionId) services?.sessions?.open?.(sessionId);
      updateProduct({ page: 'conversation', capabilityPage: null, mobileNavOpen: false, conversationPanelOpen: false }, false);
    }
    async function refreshRuntime() {
      try {
        if (runtimeApi?.settings?.describe) {
          const settingsResult = await runtimeApi.settings.describe({});
          if (settingsResult?.result?.ok) {
            const namespaces = settingsResult.result.value.namespaces || [];
            const workbench = namespaces.find((item) => item.ns === SETTINGS_NAMESPACE)?.value?.state;
            if (workbench && typeof workbench === 'object') {
              const localUpdatedAt = Number(productState.stateUpdatedAt || 0);
              const remoteUpdatedAt = Number(workbench.stateUpdatedAt || 0);
              if (remoteUpdatedAt >= localUpdatedAt) {
                productState = normalizeState(Object.assign({}, productState, workbench));
                notify(productListeners);
              }
              if (workbench.baseContractVersion !== BASE_CONTRACT_VERSION || localUpdatedAt > remoteUpdatedAt) persist(productState);
            }
          }
        }
      } catch (_) {}
    }

    function warnRemoteSettingsCompatibility(message) {
      if (remoteSettingsCompatibilityWarning) return;
      remoteSettingsCompatibilityWarning = true;
      console.warn(`[LWB] remote settings compatibility disabled: ${message}`);
    }

    function settingsViewUsable(snapshot) {
      return Boolean(snapshot?.view && Array.isArray(snapshot.view.namespaces));
    }

    function validSettingsView(view) {
      return Boolean(view && Array.isArray(view.namespaces)
        && typeof view.writable === 'boolean' && typeof view.hasDocument === 'boolean');
    }

    async function remoteSettingsPolicy() {
      const rpc = services?.connection?.rpc?.call;
      if (typeof rpc !== 'function') return undefined;
      const response = await rpc('/api', 'lwbRemoteSettings/policy', { args: {} });
      if (!response?.ok) throw new Error(response?.error?.message || '无法读取远程设置兼容策略。');
      const mode = response.value?.mode;
      return { mode: ['auto', 'compat', 'disabled'].includes(mode) ? mode : 'auto' };
    }

    /**
     * Keep the upstream settings mirror authoritative. The fallback is only a
     * browser-side bridge for the current non-loopback memory-mode mirror and
     * can disappear once DSH serves settings there itself.
     */
    async function refreshRemoteSettingsCompatibility() {
      if (services?.remote?.$host?.isLoopback === true) return;
      let policy;
      try {
        policy = await remoteSettingsPolicy();
      } catch (error) {
        warnRemoteSettingsCompatibility(error?.message || String(error));
        return;
      }
      if (!policy || policy.mode === 'disabled') return;
      const mirror = services?.settingsScope?.describe?.();
      if (!mirror?.getSnapshot) {
        warnRemoteSettingsCompatibility('DSH settings mirror is unavailable.');
        return;
      }
      try { await mirror.ensure?.(); } catch (_) {}
      let snapshot = mirror.getSnapshot();
      if (settingsViewUsable(snapshot)) return;
      // auto waits for an official answer instead of taking over a transient
      // loading/idle state; compat is the explicit emergency bridge.
      if (policy.mode === 'auto' && snapshot.status !== 'unavailable') return;
      let result;
      if (runtimeApi?.settings?.describe) {
        result = await runtimeApi.settings.describe({});
      } else if (services?.connection?.rpc?.call) {
        // Current DSH exposes the same authenticated operation through the
        // generic Connection RPC even when the legacy connection.api facade is
        // absent. Keep this fallback local so upstream can remove it cleanly.
        result = await services.connection.rpc.call('/api', 'settings/describe', { args: {} });
      } else {
        warnRemoteSettingsCompatibility('DSH settings RPC is unavailable.');
        return;
      }
      const response = result?.result || result;
      if (!response?.ok || !validSettingsView(response.value)) {
        warnRemoteSettingsCompatibility(response?.error?.message || 'settings.describe returned an invalid view.');
        return;
      }
      snapshot = mirror.getSnapshot();
      if (settingsViewUsable(snapshot) || (policy.mode === 'auto' && snapshot.status !== 'unavailable')) return;
      if (typeof mirror.store?.set !== 'function') {
        warnRemoteSettingsCompatibility('DSH settings mirror cannot accept a compatibility view.');
        return;
      }
      mirror.store.set({ status: 'ready', view: response.value, error: null });
    }

    const css = `
      :root { --lwb-text-xs:12px; --lwb-text-sm:13px; --lwb-text-base:14px; --lwb-text-md:15px; --lwb-text-lg:16px; --lwb-text-section:18px; --lwb-text-heading:20px; --lwb-text-title:24px; --lwb-sidebar-width:248px; --lwb-ink:#1d2733; --lwb-muted:#5f6f80; --lwb-line:#e5e9ee; --lwb-page:#f7f9fb; --lwb-surface:#fff; --lwb-blue:#2869d8; --lwb-blue-soft:#edf4ff; --lwb-green:#16865f; --lwb-green-soft:#eaf8f1; --lwb-warm:#b97016; --lwb-warm-soft:#fff5e7; }
      body[data-ds-dark-theme] { --lwb-ink:var(--dsw-alias-label-primary,#edf3f8); --lwb-muted:var(--dsw-alias-label-secondary,#a9b7c5); --lwb-line:var(--dsw-alias-border-l1,#334352); --lwb-page:var(--dsw-alias-bg-base,#131c25); --lwb-surface:var(--dsw-alias-bg-layer-1,#1c2733); --lwb-blue:#78adff; --lwb-blue-soft:#203f64; --lwb-green:#5bd0a0; --lwb-green-soft:#173f34; --lwb-warm:#f0b45b; --lwb-warm-soft:#49351c; }
      body[data-ds-dark-theme] .lwb-sidebar { background:var(--lwb-surface); } body[data-ds-dark-theme] .lwb-nav-caption,body[data-ds-dark-theme] .lwb-conversation-label,body[data-ds-dark-theme] .lwb-conversation-section-toggle { color:#91a2b3; } body[data-ds-dark-theme] .lwb-nav-item,body[data-ds-dark-theme] .lwb-workspace-row,body[data-ds-dark-theme] .lwb-session-row,body[data-ds-dark-theme] .lwb-cap-toggle,body[data-ds-dark-theme] .lwb-field label { color:var(--lwb-ink); } body[data-ds-dark-theme] .lwb-nav-item:hover,body[data-ds-dark-theme] .lwb-cap-toggle:hover,body[data-ds-dark-theme] .lwb-workspace-row:hover,body[data-ds-dark-theme] .lwb-session-row:hover,body[data-ds-dark-theme] .lwb-session-row[data-active="true"] { background:#25384b; } body[data-ds-dark-theme] .lwb-nav-item[data-icon="conversation"] { --nav-soft:#1d4058; } body[data-ds-dark-theme] .lwb-nav-item[data-icon="packs"] { --nav-soft:#52331f; } body[data-ds-dark-theme] .lwb-nav-item[data-icon="settings"],body[data-ds-dark-theme] .lwb-nav-item[data-tone="violet"] { --nav-soft:#303947; } body[data-ds-dark-theme] .lwb-nav-item[data-tone="orange"] { --nav-soft:#513522; } body[data-ds-dark-theme] .lwb-nav-item[data-tone="pink"] { --nav-soft:#4b2f40; } body[data-ds-dark-theme] .lwb-nav-item[data-tone="red"] { --nav-soft:#4c302b; } body[data-ds-dark-theme] .lwb-nav-item[data-tone="green"] { --nav-soft:#1d4438; }
      body[data-ds-dark-theme] .lwb-nav-count,body[data-ds-dark-theme] .lwb-workspace-count,body[data-ds-dark-theme] .lwb-menu-pill { color:#b3c0cc; background:#2a3948; } body[data-ds-dark-theme] .lwb-cap-mark,body[data-ds-dark-theme] .lwb-user-avatar { background:#223c59; } body[data-ds-dark-theme] .lwb-sidebar-foot { border-color:var(--lwb-line); color:var(--lwb-muted); } body[data-ds-dark-theme] .lwb-conversation-pane { background:var(--lwb-page); box-shadow:8px 0 20px rgba(0,0,0,.16); } body[data-ds-dark-theme] .lwb-conversation-pane-head,body[data-ds-dark-theme] .lwb-overlay-head { background:rgba(28,39,51,.96); } body[data-ds-dark-theme] .lwb-conversation-search,body[data-ds-dark-theme] .lwb-select,body[data-ds-dark-theme] .lwb-input,body[data-ds-dark-theme] .lwb-plain-button,body[data-ds-dark-theme] .lwb-detail-close { border-color:#405161; color:var(--lwb-ink); background:#23313f; } body[data-ds-dark-theme] .lwb-conversation-search:focus,body[data-ds-dark-theme] .lwb-input:focus,body[data-ds-dark-theme] .lwb-select:focus { border-color:var(--lwb-blue); box-shadow:0 0 0 2px rgba(120,173,255,.2); }
      body[data-ds-dark-theme] .lwb-pack-card > p,body[data-ds-dark-theme] .lwb-detail-menu-row,body[data-ds-dark-theme] .lwb-detail-fact strong { color:var(--lwb-ink); } body[data-ds-dark-theme] .lwb-pack-empty,body[data-ds-dark-theme] .lwb-settings-section,body[data-ds-dark-theme] .lwb-detail-fact,body[data-ds-dark-theme] .lwb-detail-menu-row { border-color:var(--lwb-line); background:#202d3a; } body[data-ds-dark-theme] .lwb-settings-section,body[data-ds-dark-theme] .lwb-detail-fact small,body[data-ds-dark-theme] .lwb-modal-copy,body[data-ds-dark-theme] .lwb-modal-title { color:var(--lwb-muted); } body[data-ds-dark-theme] .lwb-pack-tab { color:var(--lwb-muted); } body[data-ds-dark-theme] .lwb-pack-tab[data-active="true"] { border-color:#345f8f; } body[data-ds-dark-theme] .lwb-status[data-tone="muted"] { color:#bdc8d2; background:#344250; } body[data-ds-dark-theme] .lwb-danger-button { border-color:#814d4d; color:#ffabab; background:#45292b; } body[data-ds-dark-theme] .lwb-dialog-error { border-color:#804b4b; color:#ffb5b5; background:#48292c; } body[data-ds-dark-theme] .lwb-mobile-nav-trigger,body[data-ds-dark-theme] .lwb-mobile-conversation-trigger { border-color:#405161; color:var(--lwb-ink); background:#23313f; }
      .lwb-sidebar,.lwb-overlay,.lwb-conversation-pane { box-sizing:border-box; font-size:var(--lwb-text-base); line-height:1.55; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; color:var(--lwb-ink); }
      .lwb-sidebar *,.lwb-overlay * { box-sizing:border-box; }
      .lwb-sidebar { display:flex; height:100%; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; flex-direction:column; padding:16px 10px 10px; background:#fff; }
      .lwb-brand,.lwb-nav-item,.lwb-workspace-row,.lwb-session-row { display:flex; width:100%; min-width:0; align-items:center; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
      .lwb-brand { flex-shrink:0; gap:10px; min-height:42px; padding:3px 8px 14px; }
      .lwb-brand-mark { display:grid; width:30px; height:30px; flex:none; place-items:center; border-radius:7px; color:#fff; background:linear-gradient(145deg,#1267c7,#1d8b99 48%,#52a859 49%,#e8ad30); font-size:var(--lwb-text-md,15px); font-weight:800; }
      .lwb-brand-copy,.lwb-session-copy { display:grid; min-width:0; gap:2px; }
      .lwb-brand-copy strong,.lwb-brand-copy small,.lwb-nav-label,.lwb-session-title,.lwb-session-workspace,.lwb-workspace-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .lwb-brand-copy strong { font-size:var(--lwb-text-section,18px); } .lwb-brand-copy small,.lwb-session-workspace { color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .lwb-collapse { width:28px; height:28px; margin-left:auto; border:0; border-radius:6px; color:var(--lwb-muted); background:transparent; font-size:var(--lwb-text-section,18px); cursor:pointer; }
      .lwb-nav-group { display:grid; flex-shrink:0; gap:2px; margin:0 0 15px; } .lwb-nav-caption,.lwb-conversation-label { padding:0 10px 6px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); font-weight:700; letter-spacing:.08em; }
      .lwb-nav-item { min-height:42px; gap:9px; padding:0 9px; border-radius:6px; color:#566473; font-size:var(--lwb-text-base,14px); } .lwb-nav-item:hover { color:#273645; background:#f3f6fa; } .lwb-nav-item[data-active="true"] { color:var(--lwb-blue); background:var(--lwb-blue-soft); font-weight:700; }
      .lwb-nav-icon { display:grid; width:26px; height:26px; flex:none; place-items:center; border-radius:6px; color:var(--nav-color,#667788); background:var(--nav-soft,#edf1f5); } .lwb-nav-item[data-icon="conversation"] { --nav-color:#2579b9; --nav-soft:#e7f4fb; } .lwb-nav-item[data-icon="packs"] { --nav-color:#d57827; --nav-soft:#fff0e2; } .lwb-nav-item[data-icon="settings"] { --nav-color:#667789; --nav-soft:#edf1f5; } .lwb-nav-item[data-tone="violet"] { --nav-color:#8b5cc4; --nav-soft:#f2ebfb; } .lwb-nav-item[data-tone="orange"] { --nav-color:#cf762b; --nav-soft:#fff0e4; } .lwb-nav-item[data-tone="pink"] { --nav-color:#bc5f8c; --nav-soft:#faeaf1; } .lwb-nav-item[data-tone="red"] { --nav-color:#c25f4a; --nav-soft:#fdeae5; } .lwb-nav-item[data-tone="green"] { --nav-color:#238c67; --nav-soft:#e6f6ee; } .lwb-nav-item[data-active="true"] .lwb-nav-icon { color:#fff; background:var(--lwb-blue); }
      .lwb-nav-count { display:grid; min-width:17px; height:17px; margin-left:auto; place-items:center; border-radius:9px; color:#8090a0; background:#eef2f6; font-size:var(--lwb-text-xs,12px); }
      .lwb-capability-nav { gap:5px; } .lwb-cap-group { display:grid; min-width:0; gap:1px; } .lwb-cap-toggle { display:flex; width:100%; min-width:0; min-height:34px; align-items:center; gap:7px; padding:0 8px; border:0; border-radius:6px; color:#324458; background:transparent; font:inherit; font-size:var(--lwb-text-sm,13px); font-weight:700; text-align:left; cursor:pointer; } .lwb-cap-toggle:hover { color:#273645; background:#f3f6fa; } .lwb-cap-group[data-active="true"] .lwb-cap-toggle { color:var(--lwb-blue); } .lwb-cap-mark { display:grid; width:22px; height:22px; flex:none; place-items:center; border-radius:5px; color:var(--lwb-blue); background:#e9f1ff; font-size:var(--lwb-text-xs,12px); } .lwb-cap-chevron { display:grid; width:16px; height:16px; flex:none; place-items:center; color:#8b99a7; transform:rotate(180deg); transition:transform .14s ease; } .lwb-cap-toggle[aria-expanded="true"] .lwb-cap-chevron { transform:rotate(-90deg); } .lwb-cap-menu { display:grid; min-width:0; gap:1px; margin:0 0 3px 11px; padding-left:9px; border-left:1px solid var(--lwb-line); } .lwb-cap-menu .lwb-nav-item { min-height:34px; padding:0 8px; font-size:var(--lwb-text-sm,13px); } .lwb-cap-menu .lwb-nav-icon { width:22px; height:22px; border-radius:5px; font-size:var(--lwb-text-xs,12px); }
      .lwb-workspace-group { margin-bottom:3px; } .lwb-workspace-row-wrap,.lwb-session-item { display:flex; min-width:0; align-items:center; } .lwb-workspace-row { display:grid; flex:1; grid-template-columns:12px minmax(0,1fr) auto; gap:6px; min-height:31px; padding:0 7px; border-radius:5px; color:#526477; } .lwb-workspace-row:hover { color:var(--lwb-blue); background:#f1f6fd; } .lwb-workspace-chevron { font-size:var(--lwb-text-sm,13px); color:#93a1af; } .lwb-workspace-row[data-expanded="true"] .lwb-workspace-chevron { transform:rotate(90deg); } .lwb-workspace-title { font-size:var(--lwb-text-sm,13px); font-weight:700; } .lwb-workspace-count { min-width:17px; border-radius:8px; color:#8795a2; background:#eef2f5; font-size:var(--lwb-text-xs,12px); line-height:16px; text-align:center; }
      .lwb-history-row-actions { display:flex; flex:none; opacity:0; pointer-events:none; } .lwb-workspace-row-wrap:hover .lwb-history-row-actions,.lwb-session-item:hover .lwb-history-row-actions { opacity:1; pointer-events:auto; } .lwb-history-action,.lwb-add-workspace,.lwb-workspace-create { display:grid; width:25px; height:25px; place-items:center; padding:0; border:0; border-radius:5px; color:#5b87c9; background:transparent; cursor:pointer; } .lwb-history-action:hover,.lwb-add-workspace:hover,.lwb-workspace-create:hover { background:#e7f1ff; }
      .lwb-workspace-sessions { display:grid; gap:1px; padding:1px 0 5px 15px; } .lwb-session-row { flex:1; gap:8px; min-height:34px; padding:0 9px; border-radius:6px; color:#5d6b79; font-size:var(--lwb-text-base,14px); } .lwb-session-row:hover,.lwb-session-row[data-active="true"] { background:#f0f5fb; } .lwb-session-dot { width:5px; height:5px; flex:none; border-radius:50%; background:#b6c0cb; } .lwb-session-row[data-running="true"] .lwb-session-dot { background:#29936d; } .lwb-empty-sessions { padding:7px 9px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); }
      .lwb-sidebar-foot { display:flex; min-height:35px; align-items:center; gap:8px; margin-top:auto; padding:10px 8px 0; border-top:1px solid #eef1f4; color:#768493; font-size:var(--lwb-text-sm,13px); } .lwb-user-avatar { display:grid; width:23px; height:23px; place-items:center; border-radius:50%; color:#2869d8; background:#e9f1ff; font-size:var(--lwb-text-xs,12px); font-weight:800; } .lwb-sidebar[data-collapsed="true"] { align-items:center; padding:14px 10px; } .lwb-sidebar[data-collapsed="true"] .lwb-brand { width:36px; justify-content:center; padding:2px 0 15px; } .lwb-sidebar[data-collapsed="true"] .lwb-nav-item,.lwb-sidebar[data-collapsed="true"] .lwb-cap-toggle { width:36px; justify-content:center; padding:0; } .lwb-sidebar[data-collapsed="true"] .lwb-nav-caption,.lwb-sidebar[data-collapsed="true"] .lwb-brand-copy,.lwb-sidebar[data-collapsed="true"] .lwb-collapse,.lwb-sidebar[data-collapsed="true"] .lwb-nav-label,.lwb-sidebar[data-collapsed="true"] .lwb-nav-count,.lwb-sidebar[data-collapsed="true"] .lwb-cap-chevron,.lwb-sidebar[data-collapsed="true"] .lwb-sidebar-foot span { display:none; } .lwb-sidebar[data-collapsed="true"] .lwb-nav-group,.lwb-sidebar[data-collapsed="true"] .lwb-sidebar-foot { width:36px; } .lwb-sidebar[data-collapsed="true"] .lwb-cap-menu { display:none; } .lwb-sidebar[data-collapsed="true"] .lwb-sidebar-foot { justify-content:center; padding:10px 0 0; }
      .lwb-overlay { position:absolute; z-index:1; inset:0 0 0 var(--lwb-sidebar-width); display:flex; flex-direction:column; overflow:hidden; background:var(--lwb-page); } .lwb-conversation-overlay { position:absolute; z-index:1; inset:0 0 0 var(--lwb-sidebar-width); pointer-events:none; --lwb-conversation-panel-width:264px; } .lwb-conversation-pane { display:flex; width:var(--lwb-conversation-panel-width); height:100%; flex-direction:column; overflow:hidden; border-right:1px solid var(--lwb-line); background:#fbfcfd; box-shadow:8px 0 20px rgba(30,48,70,.025); pointer-events:auto; } .lwb-conversation-pane-head { display:flex; min-height:58px; align-items:center; justify-content:space-between; padding:0 15px; border-bottom:1px solid var(--lwb-line); background:#fff; } .lwb-conversation-pane-head button { width:28px; height:28px; border:0; border-radius:5px; color:var(--lwb-blue); background:transparent; font-size:var(--lwb-text-heading,20px); cursor:pointer; } .lwb-conversation-pane-head button:hover { background:var(--lwb-blue-soft); } .lwb-conversation-close,.lwb-conversation-backdrop { display:none; } .lwb-conversation-list { min-height:0; flex:1; overflow:auto; padding:12px 9px 14px; } .lwb-conversation-section { margin-bottom:15px; } .lwb-conversation-label { display:flex; align-items:center; justify-content:space-between; padding:0 6px 7px; } .lwb-conversation-section-toggle { display:flex; width:100%; align-items:center; justify-content:space-between; padding:0 6px 7px; border:0; color:var(--lwb-muted); background:transparent; font-size:var(--lwb-text-xs,12px); font-weight:700; cursor:pointer; } .lwb-conversation-section-toggle:hover,.lwb-conversation-section-toggle:focus-visible { color:var(--lwb-blue); outline:0; } .lwb-conversation-section-toggle-copy { display:flex; min-width:0; align-items:center; gap:6px; } .lwb-conversation-section-toggle i { display:block; color:#91a0ad; font-style:normal; transition:transform .14s ease; } .lwb-conversation-section-toggle[aria-expanded="true"] i { transform:rotate(90deg); } .lwb-conversation-search { width:100%; height:31px; margin-bottom:8px; padding:0 9px; border:1px solid #e1e7ee; border-radius:5px; outline:0; color:#40505f; background:#fff; font-size:var(--lwb-text-sm,13px); } .lwb-conversation-search:focus { border-color:#9fc0f4; box-shadow:0 0 0 2px #eef5ff; } [data-lwb-conversation-active="true"] > div:nth-child(2) { box-sizing:border-box; padding-left:calc(var(--lwb-conversation-panel-width,264px) + 16px); }
      .lwb-overlay-head { display:flex; min-height:58px; align-items:center; justify-content:space-between; padding:0 28px; border-bottom:1px solid var(--lwb-line); background:rgba(255,255,255,.96); } .lwb-overlay-title { display:flex; min-width:0; gap:10px; align-items:center; } .lwb-overlay-title b { font-size:var(--lwb-text-lg,16px); } .lwb-overlay-title span { overflow:hidden; color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); text-overflow:ellipsis; white-space:nowrap; } .lwb-overlay-body { min-height:0; flex:1; overflow:auto; } .lwb-page { width:min(1180px,100%); min-height:100%; margin:0 auto; padding:31px 36px 52px; } .lwb-page-capability { width:100%; max-width:none; margin:0; padding:20px clamp(20px,2.4vw,44px) 52px; } .lwb-page-intro { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:22px; } .lwb-page-capability .lwb-page-intro { min-height:64px; margin-bottom:16px; padding-bottom:14px; border-bottom:1px solid var(--lwb-line); } .lwb-page-capability .lwb-eyebrow { margin-bottom:5px; } .lwb-eyebrow { margin-bottom:8px; color:var(--lwb-blue); font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.12em; } .lwb-page-intro h1 { margin:0; font-size:var(--lwb-text-title,24px); line-height:1.2; } .lwb-page-capability .lwb-page-intro h1 { font-size:var(--lwb-text-heading,20px); } .lwb-page-intro p { max-width:650px; margin:8px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-md,15px); line-height:1.55; } .lwb-page-capability .lwb-page-intro p { max-width:900px; margin-top:4px; font-size:var(--lwb-text-base,14px); }
      .lwb-card { border:1px solid var(--lwb-line); border-radius:7px; background:var(--lwb-surface); box-shadow:0 2px 8px rgba(24,39,56,.025); } .lwb-card-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:15px 17px; border-bottom:1px solid var(--lwb-line); } .lwb-card-heading span { color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); } .lwb-status { display:inline-flex; min-height:21px; align-items:center; padding:0 8px; border-radius:11px; color:var(--lwb-green); background:var(--lwb-green-soft); font-size:var(--lwb-text-sm,13px); font-weight:700; white-space:nowrap; } .lwb-status[data-tone="muted"] { color:#7c8996; background:#f0f3f5; } .lwb-status[data-tone="warm"] { color:var(--lwb-warm); background:var(--lwb-warm-soft); } .lwb-empty-state,.lwb-pack-empty { display:grid; min-height:280px; place-items:center; padding:36px; text-align:center; } .lwb-empty-state p { color:var(--lwb-muted); font-size:var(--lwb-text-base,14px); line-height:1.65; } .lwb-empty-glyph,.lwb-pack-icon { display:grid; place-items:center; border-radius:8px; color:var(--lwb-blue); background:var(--lwb-blue-soft); } .lwb-empty-glyph { width:50px; height:50px; margin:auto; font-size:var(--lwb-text-title,24px); } .lwb-row-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .lwb-plain-button,.lwb-primary-button,.lwb-danger-button { min-height:32px; padding:0 11px; border:1px solid #d7e0e9; border-radius:6px; background:#fff; color:#4f6071; font-size:var(--lwb-text-base,14px); font-weight:600; cursor:pointer; } .lwb-primary-button { border-color:var(--lwb-blue); color:#fff; background:var(--lwb-blue); } .lwb-danger-button { border-color:#dba8a8; color:#a44949; background:#fff7f7; }
      .lwb-pack-tabs { display:flex; gap:4px; margin-bottom:14px; } .lwb-pack-tab { min-height:32px; padding:0 12px; border:1px solid transparent; border-radius:6px; color:#6e7c8a; background:transparent; cursor:pointer; } .lwb-pack-tab[data-active="true"] { border-color:#d6e5f9; color:var(--lwb-blue); background:var(--lwb-blue-soft); } .lwb-market-controls { display:grid; grid-template-columns:minmax(220px,1fr) 142px 142px; gap:9px; margin-bottom:16px; } .lwb-market-search { width:100%; height:34px; padding:0 10px; border:1px solid #d8e2ec; border-radius:6px; outline:0; color:var(--lwb-ink); background:var(--lwb-surface); font-size:var(--lwb-text-base,14px); } .lwb-market-search:focus { border-color:var(--lwb-blue); box-shadow:0 0 0 2px var(--lwb-blue-soft); } .lwb-pack-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(248px,1fr)); gap:13px; } .lwb-pack-card { display:flex; min-height:258px; flex-direction:column; padding:17px; cursor:pointer; } .lwb-pack-card:hover { border-color:#b9d4f4; box-shadow:0 5px 17px rgba(39,78,123,.09); } .lwb-pack-card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:15px; } .lwb-pack-title { display:flex; min-width:0; align-items:center; gap:11px; } .lwb-pack-title > div { min-width:0; } .lwb-pack-icon { width:37px; height:37px; flex:none; font-size:var(--lwb-text-heading,20px); } .lwb-pack-title h3 { overflow:hidden; margin:0; font-size:var(--lwb-text-lg,16px); text-overflow:ellipsis; white-space:nowrap; } .lwb-pack-title p { margin:4px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); } .lwb-pack-card > p { margin:14px 0; color:#657586; font-size:var(--lwb-text-base,14px); line-height:1.6; } .lwb-pack-menu { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px; } .lwb-menu-pill { padding:4px 7px; border-radius:4px; color:#617183; background:#f2f5f8; font-size:var(--lwb-text-xs,12px); } .lwb-pack-actions { margin-top:auto; } .lwb-pack-card-note { min-height:16px; margin:0 0 10px; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); }
      .lwb-pack-empty { border:1px dashed #d6dee7; border-radius:7px; color:#82909e; background:#fbfcfd; font-size:var(--lwb-text-base,14px); }
      .lwb-settings-list { display:block; overflow:hidden; } .lwb-settings-section { padding:13px 19px 7px; color:#7a8997; background:#fbfcfd; font-size:var(--lwb-text-xs,12px); font-weight:800; letter-spacing:.08em; } .lwb-setting-row { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:17px 19px; border-bottom:1px solid var(--lwb-line); } .lwb-setting-row:last-child { border-bottom:0; } .lwb-setting-copy > strong { display:block; font-size:var(--lwb-text-md,15px); } .lwb-setting-copy > span { display:block; margin-top:5px; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); line-height:1.5; } .lwb-select { min-width:110px; height:32px; padding:0 8px; border:1px solid #d7e0e9; border-radius:6px; color:#4f6071; background:#fff; font-size:var(--lwb-text-base,14px); } .lwb-field { display:grid; gap:6px; } .lwb-field label { color:#566879; font-size:var(--lwb-text-sm,13px); font-weight:700; } .lwb-input { width:100%; height:34px; padding:0 10px; border:1px solid #d8e2ec; border-radius:6px; outline:0; color:#40505f; background:#fff; font-size:var(--lwb-text-base,14px); } .lwb-input:focus,.lwb-select:focus { border-color:#9fc0f4; box-shadow:0 0 0 2px #eef5ff; } .lwb-form { display:grid; gap:14px; } .lwb-modal-title { margin:0; color:#253646; font-size:var(--lwb-text-heading,20px); } .lwb-modal-copy { margin:6px 0 0; color:#7a8997; font-size:var(--lwb-text-sm,13px); line-height:1.55; } .lwb-dialog-error { margin:0; padding:9px 10px; border:1px solid #efcfcf; border-radius:6px; color:#a54848; background:#fff7f7; font-size:var(--lwb-text-sm,13px); line-height:1.45; }
      .lwb-modal-backdrop { position:fixed; z-index:20; inset:0; display:grid; place-items:center; padding:24px; background:rgba(27,39,53,.28); pointer-events:auto; } .lwb-pack-drawer-backdrop { position:fixed; z-index:20; inset:0; display:flex; justify-content:flex-end; background:rgba(27,39,53,.28); pointer-events:auto; } .lwb-pack-detail { width:min(560px,100%); max-height:min(720px,calc(100vh - 48px)); overflow:auto; padding:21px; } .lwb-pack-drawer { width:min(510px,100%); height:100%; max-height:none; padding:24px; border-radius:0; box-shadow:-12px 0 32px rgba(20,34,49,.13); } .lwb-pack-detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:15px; margin-bottom:17px; } .lwb-pack-detail-head h2 { margin:0; font-size:var(--lwb-text-heading,20px); } .lwb-pack-detail-head p { margin:5px 0 0; color:var(--lwb-muted); font-size:var(--lwb-text-sm,13px); } .lwb-detail-close { width:30px; height:30px; border:1px solid #d7e0e9; border-radius:6px; color:#647487; background:#fff; cursor:pointer; } .lwb-detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; margin-bottom:17px; } .lwb-detail-fact { padding:12px; border:1px solid #e5e9ee; border-radius:6px; background:#fbfcfd; } .lwb-detail-fact small { display:block; color:var(--lwb-muted); font-size:var(--lwb-text-xs,12px); } .lwb-detail-fact strong { display:block; margin-top:5px; color:#334456; font-size:var(--lwb-text-base,14px); } .lwb-detail-section { padding:14px 0; border-top:1px solid var(--lwb-line); } .lwb-detail-section h3 { margin:0 0 10px; color:#5d6d7d; font-size:var(--lwb-text-sm,13px); letter-spacing:.04em; } .lwb-detail-menu { display:grid; gap:7px; } .lwb-detail-menu-row { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid #e7ebef; border-radius:6px; color:#4d5e6f; background:#fff; font-size:var(--lwb-text-sm,13px); } .lwb-detail-menu-row b { color:var(--lwb-blue); font-size:var(--lwb-text-md,15px); } .lwb-workflow-list { display:grid; gap:7px; padding:0; margin:0; list-style:none; } .lwb-workflow-list li { display:flex; gap:8px; align-items:flex-start; color:var(--lwb-ink); font-size:var(--lwb-text-base,14px); line-height:1.5; } .lwb-workflow-list i { color:var(--lwb-blue); font-style:normal; }
      .lwb-mobile-nav-trigger,.lwb-mobile-conversation-trigger,.lwb-mobile-nav-backdrop { display:none; }
      @media (max-width:680px) { :root { --lwb-sidebar-width:0px !important; } .lwb-sidebar { position:fixed; z-index:80; top:0; bottom:0; left:0; width:248px; transform:translateX(-105%); transition:transform .18s ease; box-shadow:10px 0 30px rgba(24,39,56,.18); } .lwb-sidebar[data-mobile-open="true"] { transform:translateX(0); } .lwb-conversation-overlay,.lwb-overlay { inset:0; } .lwb-conversation-pane { position:fixed; z-index:60; top:0; bottom:0; left:0; transform:translateX(-105%); transition:transform .18s ease; box-shadow:8px 0 26px rgba(24,39,56,.18); } .lwb-conversation-overlay[data-open="true"] .lwb-conversation-pane { transform:translateX(0); } .lwb-conversation-backdrop { position:fixed; z-index:55; inset:0; border:0; background:rgba(24,39,56,.24); } .lwb-conversation-overlay[data-open="true"] .lwb-conversation-backdrop,.lwb-conversation-close { display:block; } .lwb-mobile-nav-trigger,.lwb-mobile-conversation-trigger { position:fixed; z-index:70; top:13px; display:grid; width:32px; height:32px; place-items:center; border:1px solid #dbe4ec; border-radius:6px; background:#fff; cursor:pointer; } .lwb-mobile-nav-trigger { left:12px; } .lwb-mobile-conversation-trigger { left:52px; } .lwb-mobile-nav-backdrop { position:fixed; z-index:75; inset:0; border:0; background:rgba(24,39,56,.24); } .lwb-overlay-head { padding-left:96px; } .lwb-page { padding:24px 16px 40px; } .lwb-page-intro,.lwb-setting-row { display:block; } .lwb-page-intro .lwb-row-actions { margin-top:14px; } .lwb-history-row-actions { opacity:1; pointer-events:auto; } .lwb-market-controls { grid-template-columns:1fr; } .lwb-pack-drawer { width:min(100%,430px); padding:20px; } }
      .lwb-dsh-settings-launcher { flex:0 0 auto; } .lwb-dsh-settings-launcher button[aria-haspopup="dialog"] { display:flex; min-height:32px; align-items:center; padding:0 11px; border:1px solid #b9d1e8; border-radius:5px; color:#245f9b; background:#f7fbff; font:inherit; cursor:pointer; } .lwb-dsh-settings-launcher button[aria-haspopup="dialog"]:hover { color:#174b7d; border-color:#8cb5dc; background:#edf6ff; } .lwb-dsh-settings-trigger { display:flex; align-items:center; gap:7px; font-size:var(--lwb-text-base,14px); font-weight:700; } body[data-ds-dark-theme] .lwb-dsh-settings-launcher button[aria-haspopup="dialog"] { border-color:#405b74; color:#9ecbff; background:#1d344a; } body[data-ds-dark-theme] .lwb-dsh-settings-launcher button[aria-haspopup="dialog"]:hover { color:#d2e8ff; background:#253f58; }

      /* Product controls share readable type and keyboard states; native settings owns its panel. */
      /* Modal drawers live inside the overlay's stacking context, below mobile navigation. */
      body:has(.lwb-overlay [aria-modal="true"]) :is(.lwb-mobile-nav-trigger,.lwb-mobile-conversation-trigger) { visibility:hidden; }
      .lwb-setting-copy { min-width:0; }
      .lwb-setting-copy > span { max-width:70ch; overflow-wrap:anywhere; }
      .lwb-setting-row { padding:22px 20px; }
      .lwb-dsh-settings-launcher button[aria-haspopup="dialog"] { min-height:40px; padding:8px 14px; border-radius:8px; white-space:nowrap; }
      .lwb-dsh-settings-trigger { display:inline-flex; line-height:1.4; font-size:var(--lwb-text-base); }
      .lwb-dsh-settings-trigger svg { flex:none; }
      .lwb-plain-button,.lwb-primary-button,.lwb-danger-button { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:38px; padding:7px 13px; line-height:1.4; }
      .lwb-plain-button:disabled,.lwb-primary-button:disabled,.lwb-danger-button:disabled { opacity:.5; cursor:not-allowed; }
      .lwb-input,.lwb-select,.lwb-market-search,.lwb-conversation-search { min-height:38px; }
      .lwb-pack-tab { font:inherit; }
      .lwb-detail-close,.lwb-history-action,.lwb-add-workspace,.lwb-workspace-create { min-width:32px; min-height:32px; flex:none; }
      .lwb-sidebar :is(button,a):focus-visible,.lwb-overlay :is(button,a,input,select,textarea,summary):focus-visible,.lwb-conversation-pane :is(button,input):focus-visible { outline:2px solid var(--lwb-blue); outline-offset:3px; }
      .lwb-workspace-row-wrap:focus-within .lwb-history-row-actions,.lwb-session-item:focus-within .lwb-history-row-actions { opacity:1; pointer-events:auto; }
      .lwb-overlay-title { flex-wrap:wrap; gap:3px 10px; }
      .lwb-overlay-head > button { flex:none; }
      .lwb-pack-grid { grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr)); }
      body[data-ds-dark-theme] .lwb-modal-title { color:var(--lwb-ink); }
      body[data-ds-dark-theme] .lwb-primary-button { color:#fff; background:#2869d8; border-color:#6898e6; }
      @media (max-width:1000px) { .lwb-market-controls { grid-template-columns:minmax(0,1fr) 120px; } .lwb-market-search { grid-column:1/-1; } }
      @media (max-width:680px) {
        .lwb-sidebar { width:264px; }
        .lwb-overlay-head { min-height:64px; gap:8px; padding-left:56px; padding-right:12px; }
        .lwb-overlay-title span { display:none; }
        .lwb-page-capability { padding:20px 16px 40px; }
        .lwb-dsh-settings-launcher { margin-top:16px; }
        .lwb-setting-row > .lwb-status { margin-top:12px; }
        .lwb-market-controls { grid-template-columns:1fr; }
        .lwb-sidebar .lwb-nav-item,.lwb-plain-button,.lwb-primary-button,.lwb-danger-button { min-height:44px; }
        .lwb-input,.lwb-select,.lwb-market-search,.lwb-conversation-search { font-size:16px; }
      }
      /* Pack details: a native modal keeps background controls inert and traps focus. */
      .lwb-pack-dialog { box-sizing:border-box; position:fixed; inset:0 0 0 auto; margin:0; width:min(760px,100vw); max-width:100vw; height:100dvh; max-height:100dvh; padding:0; border:0; border-left:1px solid var(--lwb-line); border-radius:0; background:var(--lwb-surface); color:var(--lwb-ink); font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; font-size:14px; line-height:1.6; box-shadow:-16px 0 60px rgba(20,34,49,.14); overflow:hidden; }
      .lwb-pack-dialog[open] { display:flex; flex-direction:column; }
      .lwb-pack-dialog::backdrop { background:rgba(15,23,42,.38); backdrop-filter:blur(3px); }
      .lwb-pack-dialog * { box-sizing:border-box; }
      .lwb-pack-dialog-head { display:flex; flex:none; align-items:flex-start; justify-content:space-between; gap:16px; padding:26px 28px 22px; border-bottom:1px solid var(--lwb-line); }
      .lwb-pack-heading { display:flex; align-items:center; gap:14px; min-width:0; }
      .lwb-pack-heading > div { min-width:0; }
      .lwb-pack-heading h2 { margin:3px 0 0; font-size:24px; line-height:1.35; letter-spacing:-.02em; overflow-wrap:anywhere; }
      .lwb-pack-emblem { display:grid; width:48px; height:48px; flex:none; place-items:center; border:1px solid color-mix(in srgb,var(--lwb-blue) 20%,transparent); border-radius:14px; color:var(--lwb-blue); background:var(--lwb-blue-soft); }
      .lwb-pack-emblem svg { width:26px; height:26px; }
      .lwb-pack-meta { margin:0; color:var(--lwb-muted); font-size:12px; }
      .lwb-pack-dialog-body { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:24px 28px; scrollbar-gutter:stable; }
      .lwb-pack-overview { margin-bottom:26px; }
      .lwb-pack-intro { margin:12px 0 0; font-size:15px; line-height:1.85; color:var(--lwb-ink); }
      .lwb-pack-content-section { margin:0 0 26px; }
      .lwb-pack-dialog h3 { margin:0 0 12px; color:var(--lwb-ink); font-size:16px; font-weight:650; line-height:1.5; }
      .lwb-pack-journey { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; padding:0; margin:0; list-style:none; }
      .lwb-pack-journey li { display:flex; align-items:center; gap:9px; padding:10px 12px; border-radius:8px; background:var(--lwb-page); color:var(--lwb-ink); font-size:13px; }
      .lwb-pack-journey li > span { color:var(--lwb-blue); font-size:11px; font-weight:750; font-variant-numeric:tabular-nums; }
      .lwb-pack-section-note { margin:10px 0 0; color:var(--lwb-muted); font-size:13px; }
      .lwb-pack-features { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
      .lwb-pack-feature { display:flex; gap:12px; padding:16px 14px; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-surface); }
      .lwb-pack-feature > div { min-width:0; }
      .lwb-pack-feature h4 { margin:0 0 4px; color:var(--lwb-ink); font-size:14px; line-height:1.5; font-weight:650; }
      .lwb-pack-feature p { margin:0; color:var(--lwb-muted); font-size:14px; line-height:1.65; }
      .lwb-pack-feature-icon { display:grid; flex:none; width:34px; height:34px; place-items:center; border-radius:9px; color:var(--lwb-blue); background:var(--lwb-blue-soft); }
      .lwb-pack-feature[data-tone="violet"] .lwb-pack-feature-icon { color:light-dark(#7653ba,#c4a7ff); background:light-dark(#f3eefb,#31263f); }
      .lwb-pack-feature[data-tone="orange"] .lwb-pack-feature-icon { color:light-dark(#b36a19,#f6bd7c); background:light-dark(#fdf3e7,#3e3024); }
      .lwb-pack-feature[data-tone="green"] .lwb-pack-feature-icon { color:var(--lwb-green); background:var(--lwb-green-soft); }
      .lwb-pack-feature[data-tone="pink"] .lwb-pack-feature-icon { color:light-dark(#b04a87,#efacd4); background:light-dark(#fceef6,#41283a); }
      .lwb-pack-feature[data-tone="red"] .lwb-pack-feature-icon { color:light-dark(#bd534d,#ffb1aa); background:light-dark(#fcefed,#412b2a); }
      .lwb-pack-dialog { color-scheme:light; }
      body[data-ds-dark-theme] .lwb-pack-dialog { color-scheme:dark; }
      .lwb-pack-start-guide { padding:18px 20px; margin-bottom:20px; border:1px solid var(--lwb-line); border-radius:12px; background:var(--lwb-page); }
      .lwb-pack-start-guide ul { padding-left:18px; margin:0; display:grid; gap:8px; color:var(--lwb-muted); font-size:13px; }
      .lwb-pack-start-guide li::marker { color:var(--lwb-blue); }
      .lwb-pack-maintenance { padding-top:16px; border-top:1px solid var(--lwb-line); }
      .lwb-pack-maintenance summary { width:fit-content; cursor:pointer; color:var(--lwb-muted); font-size:13px; }
      .lwb-pack-maintenance[open] summary { margin-bottom:12px; color:var(--lwb-ink); }
      .lwb-pack-maintenance .lwb-modal-copy { font-size:13px; }
      .lwb-pack-dialog-foot { flex:none; padding:16px 28px 20px; border-top:1px solid var(--lwb-line); background:var(--lwb-surface); }
      .lwb-pack-footer-actions { display:flex; gap:16px; align-items:center; justify-content:space-between; }
      .lwb-pack-footer-actions > p { margin:0; flex:1; color:var(--lwb-muted); font-size:12px; }
      .lwb-pack-footer-actions .lwb-row-actions { flex:none; }
      .lwb-pack-footer-actions button { min-height:42px; padding:9px 18px; font-size:14px; }
      .lwb-pack-feedback { margin:0 0 12px; padding:10px 12px; border-radius:8px; background:var(--lwb-blue-soft); color:var(--lwb-ink); font-size:13px; overflow-wrap:anywhere; }
      .lwb-pack-feedback[data-tone="error"] { color:light-dark(#9a3434,#ffc0ba); background:light-dark(#fff0ee,#482b2b); }
      .lwb-pack-feedback[data-tone="success"] { color:var(--lwb-green); background:var(--lwb-green-soft); }
      .lwb-pack-dialog :is(button,summary,[tabindex]):focus-visible { outline:2px solid var(--lwb-blue); outline-offset:3px; }
      @media (max-width:560px) {
        .lwb-pack-dialog-head { padding:20px 18px 16px; gap:10px; }
        .lwb-pack-heading { gap:10px; }
        .lwb-pack-heading h2 { font-size:20px; }
        .lwb-pack-emblem { width:40px; height:40px; border-radius:11px; }
        .lwb-pack-dialog-body { padding:20px 18px; }
        .lwb-pack-features { grid-template-columns:1fr; }
        .lwb-pack-journey { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .lwb-pack-dialog-foot { padding:14px 18px max(16px,env(safe-area-inset-bottom)); }
        .lwb-pack-footer-actions { align-items:stretch; flex-direction:column; gap:10px; }
        .lwb-pack-footer-actions .lwb-row-actions { justify-content:flex-end; }
      }

    `;

    function installStyle() {
      if (document.getElementById('lwb-workbench-style')) return;
      const style = document.createElement('style');
      style.id = 'lwb-workbench-style';
      style.setAttribute('data-plugin', '@scitiger-ai/lwb-dsh-bundle');
      style.textContent = css;
      document.head.appendChild(style);
    }
    function installProductMetadata() {
      const previousTitle = document.title;
      const productTitle = '李发发工作台';
      const restoreTitle = () => { if (document.title !== productTitle) document.title = productTitle; };
      restoreTitle();
      const normalize = (root) => {
        if (!root || root.nodeType !== Node.TEXT_NODE || !root.nodeValue) return;
        const next = root.nodeValue.replace(/\btok\/s\b/g, 'tokens/s').replace(/\btok\b/g, 'token');
        if (next !== root.nodeValue) root.nodeValue = next;
      };
      const rewrite = (root) => {
        if (!root) return;
        if (root.nodeType === Node.TEXT_NODE) { normalize(root); return; }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) normalize(node);
      };
      rewrite(document.body);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') normalize(record.target);
          else record.addedNodes.forEach((node) => rewrite(node));
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const titleObserver = new MutationObserver(restoreTitle);
      titleObserver.observe(document.head, { subtree: true, childList: true, characterData: true });
      return () => { observer.disconnect(); titleObserver.disconnect(); document.title = previousTitle; };
    }
    function glyph(value) {
      const Icon = { '◌': IconNewChatOutline16, '▦': IconCordisPluginOutline14, '⚙': IconSettingsOutline16 }[value];
      return h('span', { className: 'lwb-nav-icon', 'aria-hidden': 'true' }, Icon ? h(Icon, { size: 18 }) : value);
    }
    function button(className, label, onClick, props = {}) {
      return h('button', Object.assign({ type: 'button', className, onClick }, props), label);
    }
    function statusLabel(status, copy = currentLwbCopy()) {
      if (status === 'mounted') return [copy.mounted, 'good'];
      if (status === 'loaded') return [copy.active, 'good'];
      if (status === 'available') return [copy.available, 'warm'];
      if (status === 'unavailable') return [copy.unavailable, 'muted'];
      if (status === 'stopped') return [copy.stopped, 'muted'];
      return [copy.installed, 'warm'];
    }
    function pageChrome(page, selected, copy = currentLwbCopy()) {
      if (page === 'capability' && selected) {
        return {
          title: selected.pack.name,
          hint: selected.menu.label,
          intro: selected.pack.description || copy.capabilityHint,
          eyebrow: 'CAPABILITY PACK',
          ariaLabel: `${selected.pack.name} · ${selected.menu.label}`,
        };
      }
      const pages = {
        packs: { title: copy.packs, hint: copy.packsHint, intro: copy.packsIntro, eyebrow: 'CAPABILITY PACKS' },
        settings: { title: copy.settings, hint: copy.settingsHint, intro: copy.settingsIntro, eyebrow: 'WORKBENCH' },
        capability: { title: copy.capability, hint: copy.capabilityHint, intro: copy.capabilityIntro, eyebrow: 'CAPABILITY PACK' },
      };
      const current = pages[page] || { title: copy.conversation, hint: '', intro: '', eyebrow: 'WORKBENCH' };
      return Object.assign({ ariaLabel: current.title }, current);
    }

    function createConversation(workspaceId) {
      try {
        if (typeof services?.uiWorkspace?.startSession !== 'function') {
          throw new Error(currentLwbCopy().createConversationFailed);
        }
        // DSH owns the selection policy: explicit workspace, current session's
        // workspace, recent workspace, then its native empty-session state.
        services.uiWorkspace.startSession(workspaceId);
        showConversation();
      } catch (error) { window.alert(error?.message || currentLwbCopy().createConversationFailed); }
    }

    function ConversationOverlay({ renderSlot }) {
      const rootRef = React.useRef(null);
      const state = useProduct();
      const copy = useLwbCopy();
      const internal = usePackCatalog().visibility;
      const isOrdinary = (id, item) => !!internal && !!item
        && !internal.sessionIds.includes(id) && !internal.workspacePaths.includes(item.cwd)
        && item.origin !== 'subagent';
      const sessions = useObservable(services?.sessions?.list, { ids: [], byId: {}, current: undefined, phase: 'pending' });
      const workspaces = useObservable(services?.workspaces?.list, { items: [], archivedSessionIds: [] });
      // DSH v0.1.2 exposes Workspace readiness as a stream phase.  Do not
      // gate these controls on the retired `baselinesReady` field: it is not
      // part of WorkspaceSnapshot and would leave every creation action
      // permanently disabled after the baseline has arrived.
      const workspaceReady = workspaces.phase === 'ready';
      const [query, setQuery] = React.useState('');
      const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState([]);
      const [dialog, setDialog] = React.useState(null);
      const [dialogTitle, setDialogTitle] = React.useState('');
      const [dialogError, setDialogError] = React.useState(null);
      const [dialogBusy, setDialogBusy] = React.useState(false);
      const [openMenuId, setOpenMenuId] = React.useState(null);
      const [archivesExpanded, setArchivesExpanded] = React.useState(false);
      const [directoryOpen, setDirectoryOpen] = React.useState(false);
      const [directoryBusy, setDirectoryBusy] = React.useState(false);

      React.useLayoutEffect(() => {
        const frame = rootRef.current?.closest?.('[data-shell-overlay]')?.parentElement;
        if (!frame) return undefined;
        frame.dataset.lwbConversationActive = 'true';
        return () => { delete frame.dataset.lwbConversationActive; };
      }, []);

      const archivedSessionIdSet = new Set(workspaces.archivedSessionIds || []);
      const visibleSessionIds = (sessions.ids || []).filter((id) => {
        const item = sessions.byId[id];
        return isOrdinary(id, item) && !archivedSessionIdSet.has(id)
          && item.origin !== 'subagent'
          && (!item.blank || sessions.current === id);
      });
      const visibleSessionIdSet = new Set(visibleSessionIds);
      const visibleWorkspaceIds = new Set();
      const ordinaryWorkspaces = internal ? (workspaces.items || []).filter((workspace) => !internal.workspacePaths.includes(workspace.path) && !internal.workspaceIds.includes(workspace.workspaceId)) : [];
      const workspaceGroups = ordinaryWorkspaces.map((workspace) => {
        const sessionIds = (workspace.sessionIds || []).filter((id) => {
          if (!visibleSessionIdSet.has(id)) return false;
          visibleWorkspaceIds.add(id);
          return true;
        });
        return Object.assign({}, workspace, { sessionIds });
      });
      const ungroupedSessionIds = visibleSessionIds.filter((id) => !visibleWorkspaceIds.has(id));
      const normalizedQuery = query.trim().toLowerCase();
      const workspaceBySessionId = new Map();
      ordinaryWorkspaces.forEach((workspace) => {
        (workspace.sessionIds || []).forEach((id) => {
          if (!workspaceBySessionId.has(id)) workspaceBySessionId.set(id, workspace.title || workspace.path?.split(/[\\/]/).filter(Boolean).pop() || copy.unnamedWorkspace);
        });
      });
      const archivedSessionIds = (workspaces.archivedSessionIds || []).filter((id) => {
        const item = sessions.byId[id] || {};
        return isOrdinary(id, sessions.byId[id]) && !item.blank;
      });
      const searchSessionIds = normalizedQuery
        ? visibleSessionIds.filter((id) => String(sessions.byId[id]?.displayTitle || id).toLowerCase().includes(normalizedQuery))
        : [];
      const currentWorkspaceId = sessions.current === undefined
        ? undefined
        : workspaceGroups.find((workspace) => workspace.sessionIds.includes(sessions.current))?.workspaceId;
      React.useEffect(() => {
        if (!currentWorkspaceId) return;
        setExpandedWorkspaceIds((current) => current.includes(currentWorkspaceId) ? current : [...current, currentWorkspaceId]);
      }, [currentWorkspaceId]);
      const addWorkspace = () => setDirectoryOpen(true);
      const adoptWorkspaceDirectory = async (path) => {
        setDirectoryBusy(true);
        try {
          if (typeof services?.uiWorkspace?.openWorkspace !== 'function' || typeof services?.workspaces?.create !== 'function') {
            throw new Error('当前 DSH 运行时无法创建工作区。');
          }
          const workspace = await services.workspaces.create({ path });
          await services.uiWorkspace.openWorkspace(workspace.workspaceId);
          showConversation();
        } catch (error) { window.alert(error?.message || copy.addWorkspaceFailed); }
        finally { setDirectoryOpen(false); setDirectoryBusy(false); }
      };
      const openDialog = (next) => {
        setDialog(next);
        setDialogTitle(next.title || '');
        setDialogError(null);
      };
      const closeDialog = () => {
        if (dialogBusy) return;
        setDialog(null);
        setDialogError(null);
      };
      const submitDialog = async (event) => {
        event.preventDefault();
        if (!dialog || dialogBusy) return;
        const isRename = dialog.kind === 'rename-workspace' || dialog.kind === 'rename-session';
        const title = dialogTitle.trim();
        if (isRename && !title) {
          setDialogError(copy.dialogNameRequired);
          return;
        }
        setDialogBusy(true);
        setDialogError(null);
        try {
          if (dialog.kind === 'rename-workspace') {
            if (typeof services?.workspaces?.rename !== 'function') throw new Error('当前 DSH 运行时不支持工作区重命名');
            await services.workspaces.rename(dialog.workspaceId, title);
          } else if (dialog.kind === 'delete-workspace') {
            if (typeof services?.workspaces?.delete !== 'function') throw new Error('当前 DSH 运行时不支持删除工作区');
            await services.workspaces.delete(dialog.workspaceId);
          } else if (dialog.kind === 'rename-session') {
            const session = services?.sessions?.binding?.(dialog.sessionId)?.session;
            if (!session) throw new Error('未找到此会话');
            const result = await session.rename(title);
            if (!result?.ok) throw new Error(result?.error?.message || '无法重命名对话');
          } else if (dialog.kind === 'archive-session') {
            if (typeof services?.workspaces?.archiveSession !== 'function') throw new Error('当前 DSH 运行时不支持归档会话');
            await services.workspaces.archiveSession(dialog.sessionId);
            setArchivesExpanded(true);
          }
          setDialog(null);
        } catch (error) {
          setDialogError(error?.message || copy.operationFailed);
        } finally {
          setDialogBusy(false);
        }
      };
      const forkSession = async (sessionId) => {
        try {
          if (typeof services?.sessions?.fork !== 'function') throw new Error('当前 DSH 运行时不支持分叉会话');
          const childSessionId = await services.sessions.fork({ sessionId, increaseTitle: true });
          if (!childSessionId) throw new Error('DSH 未返回分叉会话');
          services.sessions.open?.(childSessionId);
          showConversation();
        } catch (error) {
          window.alert(error?.message || '无法分叉会话');
        }
      };
      const repairSessionWorkspace = async (sessionId, workspace) => {
        try {
          if (typeof services?.sessions?.create !== 'function') throw new Error('当前 DSH 运行时不支持修复会话归属');
          await services.sessions.create({ sessionId, workspaceId: workspace.workspaceId });
          await services?.workspaces?.refresh?.();
          window.alert(copy.sessionAddedToWorkspace(workspace.title || workspace.path));
        } catch (error) {
          window.alert(error?.message || '无法修复会话归属');
        }
      };
      const restoreArchivedSession = async (sessionId, workspaceTitle) => {
        try {
          const result = await archiveRemote('restore', { sessionId });
          await services?.workspaces?.refresh?.();
          if (result?.restored) {
            window.alert(workspaceTitle
              ? copy.sessionRestoredToWorkspace(workspaceTitle)
              : copy.sessionRestoredUnassigned);
          }
        } catch (error) {
          window.alert(error?.message || '无法恢复归档会话');
        }
      };
      const rowMenu = (menuId, label, items, onSelect) => h('span', { className: 'lwb-history-row-actions' }, h(Menu, {
        open: openMenuId === menuId,
        onClose: () => setOpenMenuId(null),
        items,
        portal: true,
        align: 'end',
        compact: true,
        closeOnPointerLeave: true,
        onSelect: (action) => {
          setOpenMenuId(null);
          onSelect(action);
        },
        anchor: h('button', {
          type: 'button', className: 'lwb-history-action', title: label, 'aria-label': label,
          'aria-expanded': openMenuId === menuId ? 'true' : 'false',
          onClick: (event) => {
            event.stopPropagation();
            setOpenMenuId((current) => current === menuId ? null : menuId);
          },
        }, h(IconEllipsisOutline16, { size: 16 })),
      }));
      const sessionRow = (id, workspaceTitle, options = {}) => {
        const item = sessions.byId[id] || {};
        const title = item.displayTitle || copy.unnamedConversation;
        const archived = options.archived === true;
        const repairWorkspace = workspaceBySessionId.has(id)
          ? undefined
          : workspaceGroups.find((workspace) => item.cwd && workspace.path === item.cwd);
        const menuItems = archived
          ? [{ id: 'restore', label: workspaceTitle ? copy.restoreToWorkspace(workspaceTitle) : copy.restoreSession, icon: h(IconProjectAddOutline16, { size: 16 }) }]
          : [
            { id: 'rename', label: copy.rename, icon: h(IconEditOutline16, { size: 16 }) },
            { id: 'fork', label: copy.forkConversation, icon: h(IconBranchOutline16, { size: 16 }) },
            ...(repairWorkspace ? [{ id: 'assign-workspace', label: copy.assignWorkspace(repairWorkspace.title || repairWorkspace.path), icon: h(IconProjectAddOutline16, { size: 16 }) }] : []),
            { id: 'archive', label: copy.archiveConversation, icon: h(IconArchiveOutline20, { size: 16 }) },
          ];
        return h('div', { key: id, className: 'lwb-session-item' },
          h('button', {
            type: 'button', className: 'lwb-session-row', title,
            'data-active': sessions.current === id ? 'true' : 'false',
            'data-running': item.running ? 'true' : 'false',
            onClick: () => showConversation(id),
          }, h('i', { className: 'lwb-session-dot' }), h('span', { className: 'lwb-session-copy' }, h('span', { className: 'lwb-session-title' }, title), workspaceTitle && h('small', { className: 'lwb-session-workspace' }, workspaceTitle))),
          !item.blank && rowMenu(`session:${id}`, copy.sessionAction(title), menuItems, (action) => {
            if (action === 'restore') void restoreArchivedSession(id, workspaceTitle);
            if (action === 'rename') openDialog({ kind: 'rename-session', sessionId: id, title });
            if (action === 'fork') void forkSession(id);
            if (action === 'assign-workspace' && repairWorkspace) void repairSessionWorkspace(id, repairWorkspace);
            if (action === 'archive') openDialog({ kind: 'archive-session', sessionId: id, title });
          }),
        );
      };
      const toggleWorkspace = (workspaceId) => {
        setExpandedWorkspaceIds((current) => current.includes(workspaceId)
          ? current.filter((id) => id !== workspaceId)
          : [...current, workspaceId]);
      };
      const workspaceRows = workspaceGroups.map((workspace) => {
        const expanded = expandedWorkspaceIds.includes(workspace.workspaceId);
        const title = workspace.title || workspace.path?.split(/[\\/]/).filter(Boolean).pop() || copy.unnamedWorkspace;
        return h('section', { key: workspace.workspaceId, className: 'lwb-workspace-group', 'data-current': currentWorkspaceId === workspace.workspaceId ? 'true' : 'false' },
          h('div', { className: 'lwb-workspace-row-wrap' },
            h('button', { type: 'button', className: 'lwb-workspace-row', title: workspace.path || title, 'data-expanded': expanded ? 'true' : 'false', 'aria-expanded': expanded ? 'true' : 'false', onClick: () => toggleWorkspace(workspace.workspaceId) }, h('span', { className: 'lwb-workspace-chevron', 'aria-hidden': 'true' }, '>'), h('span', { className: 'lwb-workspace-title' }, title), h('span', { className: 'lwb-workspace-count' }, `${workspace.sessionIds.length}`)),
            h('button', { type: 'button', className: 'lwb-workspace-create', title: workspaceReady ? copy.newConversationInWorkspace(title) : copy.readingWorkspaces, 'aria-label': copy.newConversationInWorkspace(title), disabled: !workspaceReady, onClick: () => createConversation(workspace.workspaceId) }, '+'),
            rowMenu(`workspace:${workspace.workspaceId}`, copy.workspaceAction(title), [
              { id: 'rename', label: copy.rename, icon: h(IconEditOutline16, { size: 16 }) },
              { id: 'delete', label: copy.deleteWorkspace, icon: h(IconTrashOutline16, { size: 16 }), danger: true },
            ], (action) => {
              if (action === 'rename') openDialog({ kind: 'rename-workspace', workspaceId: workspace.workspaceId, title });
              if (action === 'delete') openDialog({ kind: 'delete-workspace', workspaceId: workspace.workspaceId, title });
            }),
          ),
          expanded && h('div', { className: 'lwb-workspace-sessions' }, workspace.sessionIds.length ? workspace.sessionIds.map((id) => sessionRow(id)) : h('div', { className: 'lwb-empty-sessions' }, copy.noSessionsInWorkspace)),
        );
      });
      const dialogMeta = dialog && ({
        'rename-workspace': { heading: copy.renameWorkspace, copy: copy.renameWorkspaceCopy, confirm: copy.saveName, rename: true },
        'delete-workspace': { heading: copy.deleteWorkspace, copy: copy.deleteWorkspaceCopy(dialog.title), confirm: copy.deleteWorkspace, danger: true },
        'rename-session': { heading: copy.renameConversation, copy: copy.renameConversationCopy, confirm: copy.saveName, rename: true },
        'archive-session': { heading: copy.archiveConversation, copy: copy.archiveConversationCopy(dialog.title), confirm: copy.archiveConversation },
      })[dialog.kind];
      return h('section', { ref: rootRef, className: 'lwb-conversation-overlay', 'data-open': state.conversationPanelOpen ? 'true' : 'false', 'aria-label': copy.conversationModule },
        h('button', { type: 'button', className: 'lwb-conversation-backdrop', 'aria-label': copy.closeConversationList, onClick: () => updateProduct({ conversationPanelOpen: false }, false) }),
        h('aside', { className: 'lwb-conversation-pane', 'aria-label': copy.conversationHistory },
          h('header', { className: 'lwb-conversation-pane-head' }, h('strong', null, copy.session), h('div', { className: 'lwb-row-actions' }, h('button', { type: 'button', className: 'lwb-conversation-close', title: copy.closeConversationList, 'aria-label': copy.closeConversationList, onClick: () => updateProduct({ conversationPanelOpen: false }, false) }, '×'), h('button', { type: 'button', title: workspaceReady ? copy.newConversation : copy.readingWorkspaces, 'aria-label': copy.newConversation, disabled: !workspaceReady || directoryBusy || !internal, onClick: () => ordinaryWorkspaces.length ? createConversation() : addWorkspace() }, '+'))),
          h('div', { className: 'lwb-conversation-list' },
            h('input', { className: 'lwb-conversation-search', type: 'search', value: query, placeholder: copy.searchConversations, onChange: (event) => setQuery(event.target.value) }),
            normalizedQuery
              ? h('section', { className: 'lwb-conversation-section' }, h('div', { className: 'lwb-conversation-label' }, h('span', null, copy.searchResults), h('span', null, copy.count(searchSessionIds.length))), searchSessionIds.length ? searchSessionIds.map((id) => sessionRow(id, workspaceBySessionId.get(id) || copy.unassignedSessions)) : h('div', { className: 'lwb-empty-sessions' }, copy.noMatchingSessions))
              : h(React.Fragment, null,
                h('section', { className: 'lwb-conversation-section' }, h('div', { className: 'lwb-conversation-label' }, h('span', null, copy.workspaces), h('button', { type: 'button', className: 'lwb-add-workspace', title: workspaceReady ? copy.addWorkspace : copy.readingWorkspaces, 'aria-label': copy.addWorkspace, disabled: !workspaceReady, onClick: addWorkspace }, h(IconProjectAddOutline16, { size: 16 }))), workspaceRows.length ? workspaceRows : h('div', { className: 'lwb-empty-sessions' }, sessions.phase === 'pending' ? copy.loadingWorkspaces : copy.noWorkspaces)),
                ungroupedSessionIds.length > 0 && h('section', { className: 'lwb-conversation-section' }, h('div', { className: 'lwb-conversation-label' }, h('span', null, copy.unassignedSessions), h('span', null, copy.count(ungroupedSessionIds.length))), ungroupedSessionIds.map((id) => sessionRow(id))),
                h('section', { className: 'lwb-conversation-section' },
                  h('button', { type: 'button', className: 'lwb-conversation-section-toggle', 'aria-expanded': archivesExpanded ? 'true' : 'false', onClick: () => setArchivesExpanded((current) => !current) }, h('span', { className: 'lwb-conversation-section-toggle-copy' }, h('i', { 'aria-hidden': 'true' }, '>'), h('span', null, copy.archivedSessions)), h('span', null, copy.count(archivedSessionIds.length))),
                  archivesExpanded && (archivedSessionIds.length
                    ? archivedSessionIds.map((id) => sessionRow(id, workspaceBySessionId.get(id), { archived: true }))
                    : h('div', { className: 'lwb-empty-sessions' }, copy.noArchivedSessions)),
                ),
              ),
          ),
        ),
        renderSlot('sidebar.workspaces.directoryFlow', {
          open: directoryOpen,
          busy: directoryBusy,
          onPicked: (path) => { void adoptWorkspaceDirectory(path); },
          onCancel: () => setDirectoryOpen(false),
          onError: (message) => { setDirectoryOpen(false); window.alert(message || copy.addWorkspaceFailed); },
        }),
        dialogMeta && h('div', { className: 'lwb-modal-backdrop', role: 'presentation', onClick: closeDialog },
          h('form', { className: 'lwb-card lwb-pack-detail lwb-form', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lwb-conversation-dialog-title', onSubmit: submitDialog, onClick: (event) => event.stopPropagation() },
            h('div', { className: 'lwb-pack-detail-head' },
              h('div', null, h('h2', { id: 'lwb-conversation-dialog-title', className: 'lwb-modal-title' }, dialogMeta.heading), h('p', { className: 'lwb-modal-copy' }, dialogMeta.copy)),
              h('button', { type: 'button', className: 'lwb-detail-close', title: copy.close, 'aria-label': copy.close, disabled: dialogBusy, onClick: closeDialog }, '×'),
            ),
            dialogMeta.rename && h('div', { className: 'lwb-field' }, h('label', { htmlFor: 'lwb-conversation-dialog-title-input' }, copy.name), h('input', { id: 'lwb-conversation-dialog-title-input', className: 'lwb-input', value: dialogTitle, maxLength: 80, autoFocus: true, onChange: (event) => setDialogTitle(event.target.value) })),
            dialogError && h('p', { className: 'lwb-dialog-error', role: 'alert' }, dialogError),
            h('div', { className: 'lwb-row-actions', style: { justifyContent: 'flex-end' } },
              button('lwb-plain-button', copy.cancel, closeDialog, { disabled: dialogBusy }),
              button(dialogMeta.danger ? 'lwb-danger-button' : 'lwb-primary-button', dialogBusy ? copy.dialogProcessing : dialogMeta.confirm, () => {}, { type: 'submit', disabled: dialogBusy }),
            ),
          ),
        ),
      );
    }

    function LwbRuntimeSettingsTrigger() {
      const copy = useLwbCopy();
      return h('span', { className: 'lwb-dsh-settings-trigger' }, h(IconSettingsOutline16, { size: 18, 'aria-hidden': true }), h('span', null, copy.openRuntimeSettings));
    }

    function LwbSidebar({ collapsed, width }) {
      const state = useProduct();
      const copy = useLwbCopy();
      const catalog = usePackCatalog();
      const [mobile, setMobile] = React.useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 680px)').matches);
      const [expandedPacks, setExpandedPacks] = React.useState(() => new Set());
      const knownPackIds = React.useRef(new Set());
      const sidebarCollapsed = collapsed && !mobile && !state.mobileNavOpen;
      const wide = !sidebarCollapsed;
      const packs = catalog.packs;
      const activePackId = state.page === 'capability' ? capabilityAtRoute(packs, state.capabilityPage)?.pack.id : undefined;

      React.useEffect(() => {
        document.documentElement.style.setProperty('--lwb-sidebar-width', `${width}px`);
      }, [width]);
      React.useEffect(() => {
        const query = window.matchMedia('(max-width: 680px)');
        const update = () => setMobile(query.matches);
        query.addEventListener?.('change', update);
        return () => query.removeEventListener?.('change', update);
      }, []);
      React.useEffect(() => {
        const current = new Set(packs.map((pack) => pack.id));
        const previousPackIds = knownPackIds.current;
        setExpandedPacks((previous) => {
          const next = new Set([...previous].filter((id) => current.has(id)));
          if (previousPackIds.size === 0) {
            if (packs.length === 1) next.add(packs[0].id);
          } else {
            for (const pack of packs) if (!previousPackIds.has(pack.id)) next.add(pack.id);
          }
          if (activePackId && current.has(activePackId)) next.add(activePackId);
          if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous;
          return next;
        });
        knownPackIds.current = current;
      }, [packs, activePackId]);

      const navItem = (id, label, symbol, count) => h('button', {
        key: id, type: 'button', className: 'lwb-nav-item', title: label,
        'data-icon': id, 'aria-label': label, 'aria-current': state.page === id ? 'page' : undefined,
        'data-active': state.page === id ? 'true' : 'false',
        onClick: () => navTo(id),
      }, glyph(symbol), wide && h('span', { className: 'lwb-nav-label' }, label), wide && count !== undefined && h('span', { className: 'lwb-nav-count' }, String(count)));
      const togglePack = (pack) => {
        if (!wide) {
          navTo('capability', capabilityRoute(pack.id, pack.menus[0].id));
          return;
        }
        setExpandedPacks((previous) => {
          const next = new Set(previous);
          if (next.has(pack.id)) next.delete(pack.id);
          else next.add(pack.id);
          return next;
        });
      };
      const capabilityGroups = packs.map((pack) => {
        const expanded = expandedPacks.has(pack.id);
        const active = activePackId === pack.id;
        const menuId = `lwb-cap-menu-${pack.id}`;
        return h('section', { key: pack.id, className: 'lwb-cap-group', 'data-active': active ? 'true' : 'false', 'data-expanded': expanded ? 'true' : 'false' },
          h('button', {
            type: 'button', className: 'lwb-cap-toggle', title: pack.name,
            'aria-label': wide ? (expanded ? copy.collapsePack(pack.name) : copy.expandPack(pack.name)) : pack.name,
            'aria-expanded': wide ? expanded : undefined, 'aria-controls': wide ? menuId : undefined,
            onClick: () => togglePack(pack),
          }, h('span', { className: 'lwb-cap-mark', 'aria-hidden': 'true' }, pack.name.slice(0, 1)), wide && h('span', { className: 'lwb-nav-label' }, pack.name), wide && h('span', { className: 'lwb-cap-chevron', 'aria-hidden': 'true' }, h(IconChevronLeftOutline14, { size: 14 }))),
          wide && expanded && h('div', { id: menuId, className: 'lwb-cap-menu' }, pack.menus.map((item) => h('button', {
            key: capabilityRoute(pack.id, item.id), type: 'button', className: 'lwb-nav-item', title: item.label,
            'data-tone': item.tone || 'blue', 'aria-label': item.label,
            'aria-current': state.page === 'capability' && state.capabilityPage === capabilityRoute(pack.id, item.id) ? 'page' : undefined,
            'data-active': state.page === 'capability' && state.capabilityPage === capabilityRoute(pack.id, item.id) ? 'true' : 'false',
            onClick: () => navTo('capability', capabilityRoute(pack.id, item.id)),
          }, glyph(item.glyph), h('span', { className: 'lwb-nav-label' }, item.label)))),
        );
      });

      return h('aside', { className: 'lwb-sidebar', 'data-collapsed': sidebarCollapsed ? 'true' : 'false', 'data-mobile-open': state.mobileNavOpen ? 'true' : 'false', 'aria-label': copy.workbenchFeatures },
        h('div', { style: { display: 'flex', alignItems: 'center' } },
          h('button', { type: 'button', className: 'lwb-brand', title: '李发发工作台', onClick: () => navTo('conversation') },
            h('span', { className: 'lwb-brand-mark' }, '李'),
            wide && h('span', { className: 'lwb-brand-copy' }, h('strong', null, '李发发工作台'), h('small', null, 'Lifafa Workbench')),
          ),
          wide && button('lwb-collapse', h(IconChevronLeftOutline14, { size: 18 }), () => services?.layout?.toggleSidebar?.(), { 'aria-label': copy.collapseSidebar, title: copy.collapseSidebar }),
        ),
        h('nav', { className: 'lwb-nav-group', 'aria-label': copy.workbenchFeatures },
          wide && h('div', { className: 'lwb-nav-caption' }, copy.workbench),
          navItem('conversation', copy.conversation, '◌'),
          navItem('packs', copy.packs, '▦'),
          navItem('settings', copy.settings, '⚙'),
        ),
        packs.length > 0 && h('nav', { className: 'lwb-nav-group lwb-capability-nav', 'aria-label': copy.loadedPacks },
          wide && h('div', { className: 'lwb-nav-caption' }, copy.loadedPacks),
          capabilityGroups,
        ),
        h('div', { className: 'lwb-sidebar-foot', title: copy.localWorkbench }, h('span', { className: 'lwb-user-avatar' }, '老'), wide && h('span', null, copy.localWorkbench)),
      );
    }

    async function packOperation(method, request) {
      const response = await services.connection.rpc.call('/api', `lwbPacks/${method}`, { args: { request } });
      if (!response?.ok) throw new Error(response?.error?.message || '能力包操作失败。');
      return response.value;
    }

    function PackWorkspaceSettings({ pack }) {
      const copy = useLwbCopy();
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [confirmation, setConfirmation] = React.useState(null);
      React.useEffect(() => { setMessage(''); setConfirmation(null); }, [pack.id, pack.status]);
      const execute = async (method) => {
        if (busy) return;
        setBusy(true); setMessage('');
        try {
          const value = await packOperation(method, { id: pack.id, confirm: true });
          setMessage(method === 'clearData' ? `业务数据已清空。可恢复副本：${value.retainedDataPath}`
            : '工作区注册已解除，文件和历史记录保留。');
          setConfirmation(null);
          await refreshPackCatalog({ retain: true });
        } catch (error) { setMessage(error.message); }
        finally { setBusy(false); }
      };
      return h('details', { className: 'lwb-pack-maintenance' },
        h('summary', null, copy.packDataManagement),
        pack.status === 'loaded' && h('p', { className: 'lwb-modal-copy' }, copy.packManageHint),
        h('p', { className: 'lwb-modal-copy' }, '加载后自动使用专属工作区，AI 任务沿用 DSH 的模型配置。卸载会保留工作区和数据。'),
        pack.status !== 'loaded' && h('div', { className: 'lwb-row-actions' },
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: () => setConfirmation('clearData') }, '清空业务数据'),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: () => setConfirmation('unregisterWorkspace') }, '解除工作区注册')),
        confirmation && h('div', { role: 'alert' },
          h('p', null, confirmation === 'clearData' ? '清空该包的账号、素材、内容产物、任务及安排？保留工作区注册、连接配置和可恢复副本。'
            : '解除工作区注册？文件继续保留，再次加载会恢复登记。'),
          h('button', { type: 'button', className: 'lwb-danger-button', disabled: busy, onClick: () => void execute(confirmation) }, '确认'),
          h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: () => setConfirmation(null) }, '取消')),
        message && h('p', { role: 'status' }, message));
    }

    function PackFeatureIcon({ name = 'pack' }) {
      const paths = {
        pack: ['M12 3 3 8l9 5 9-5-9-5Z', 'M3 8v9l9 5 9-5V8', 'M12 13v9'],
        target: ['M12 3a9 9 0 1 0 9 9', 'M12 7a5 5 0 1 0 5 5', 'M12 12 21 3', 'M16 3h5v5'],
        signal: ['M4 16v4', 'M9 12v8', 'M14 8v12', 'M19 4v16'],
        idea: ['M9 18h6', 'M9 21h6', 'M8 15c0-2-3-3-3-6a7 7 0 0 1 14 0c0 3-3 4-3 6H8Z', 'M12 6v5'],
        write: ['M14 4H5v16h14v-9', 'm10 14 1-4 8-8 3 3-8 8-4 1Z'],
        audio: ['M3 10v4', 'M7 6v12', 'M12 3v18', 'M17 6v12', 'M21 10v4'],
        video: ['M3 5h18v14H3Z', 'm10 9 5 3-5 3V9Z'],
        publish: ['M12 15V3', 'm7 8 5-5 5 5', 'M4 13v7h16v-7'],
        calendar: ['M3 5h18v16H3Z', 'M7 3v4', 'M17 3v4', 'M3 10h18', 'm8 15 3 3 5-5'],
      };
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        (paths[name] || paths.pack).map((d, index) => h('path', { key: index, d })));
    }

    function PackDetailDialog({ pack, onClose, action, notice, busy }) {
      const copy = useLwbCopy();
      const dialogRef = React.useRef(null);
      const [status, tone] = statusLabel(pack.status, copy);
      React.useLayoutEffect(() => {
        const dialog = dialogRef.current;
        const opener = document.activeElement;
        dialog.showModal();
        return () => {
          dialog.close();
          if (opener?.isConnected) opener.focus({ preventScroll: true });
        };
      }, []);
      return h('dialog', {
        ref: dialogRef, className: 'lwb-pack-dialog', 'aria-labelledby': 'lwb-pack-detail-title', 'aria-describedby': 'lwb-pack-detail-intro',
        onCancel: (event) => { event.preventDefault(); if (!busy) onClose(); },
        onKeyDown: (event) => {
          if (event.key !== 'Tab') return;
          const targets = [...event.currentTarget.querySelectorAll('button,summary,[href],input,select,textarea,[tabindex]')]
            .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length > 0);
          const first = targets[0];
          const last = targets[targets.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        },
        onClick: (event) => {
          if (busy || event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
        },
      },
        h('header', { className: 'lwb-pack-dialog-head' },
          h('div', { className: 'lwb-pack-heading' },
            h('span', { className: 'lwb-pack-emblem' }, h(PackFeatureIcon, { name: 'pack' })),
            h('div', null, h('p', { className: 'lwb-pack-meta' }, `${pack.category} · ${copy.packType} · v${pack.version}`), h('h2', { id: 'lwb-pack-detail-title' }, pack.name))),
          h('button', { type: 'button', className: 'lwb-detail-close', disabled: busy, onClick: onClose, 'aria-label': copy.close }, '×')),
        h('div', { className: 'lwb-pack-dialog-body', tabIndex: 0, 'aria-label': copy.packDetails(pack.name) },
          h('div', { className: 'lwb-pack-overview' },
            h('span', { className: 'lwb-status', 'data-tone': tone }, status),
            h('p', { id: 'lwb-pack-detail-intro', className: 'lwb-pack-intro' }, pack.introduction)),
          pack.workflow.length > 0 && h('section', { className: 'lwb-pack-content-section' },
            h('h3', null, copy.packJourney),
            h('ol', { className: 'lwb-pack-journey' }, pack.workflow.map((step, index) => h('li', { key: step }, h('span', { 'aria-hidden': true }, String(index + 1).padStart(2, '0')), step))),
            pack.workflowHint && h('p', { className: 'lwb-pack-section-note' }, pack.workflowHint)),
          h('section', { className: 'lwb-pack-content-section' }, h('h3', null, copy.packFeatures),
            h('div', { className: 'lwb-pack-features' }, pack.features.map((feature) => h('article', { key: feature.menuId, className: 'lwb-pack-feature', 'data-tone': feature.tone },
              h('span', { className: 'lwb-pack-feature-icon' }, h(PackFeatureIcon, { name: feature.icon })),
              h('div', null, h('h4', null, feature.title), feature.description && h('p', null, feature.description)))))),
          pack.gettingStarted.length > 0 && h('section', { className: 'lwb-pack-start-guide' }, h('h3', null, copy.packGettingStarted),
            h('ul', null, pack.gettingStarted.map((item) => h('li', { key: item }, item)))),
          h(PackWorkspaceSettings, { key: pack.id, pack }),
        ),
        h('footer', { className: 'lwb-pack-dialog-foot', 'aria-busy': busy },
          (notice || pack.error) && h('p', { className: 'lwb-pack-feedback', role: notice?.kind === 'error' || pack.error ? 'alert' : 'status', 'data-tone': notice?.kind || 'error' }, notice?.text || pack.error),
          h('div', { className: 'lwb-pack-footer-actions' }, h('p', null, pack.status === 'loaded' ? copy.packReadyHint : pack.status === 'unavailable' ? copy.unavailablePack : copy.packLoadHint), action)),
      );
    }

    function orderMarketplacePacks(packs) {
      const priority = (pack) => pack.id === 'spoken-video' ? 0 : 1;
      return [...packs].sort((left, right) => priority(left) - priority(right));
    }

    function PacksPage() {
      const copy = useLwbCopy();
      const market = usePackMarket();
      const [detailPack, setDetailPack] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('all');
      const [category, setCategory] = React.useState('all');
      const [operation, setOperation] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const packs = orderMarketplacePacks(market.packs);
      const categories = [...new Set(packs.map((pack) => pack.category).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
      const normalizedQuery = query.trim().toLowerCase();
      const filtered = packs.filter((pack) => {
        if (statusFilter !== 'all' && pack.status !== statusFilter) return false;
        if (category !== 'all' && pack.category !== category) return false;
        if (!normalizedQuery) return true;
        return [pack.name, pack.description, pack.category, ...pack.tags, ...pack.menus.map((menu) => menu.label)]
          .join('\n').toLowerCase().includes(normalizedQuery);
      });
      const switchPack = async (pack, method) => {
        if (operation) return;
        setOperation(`${method}:${pack.id}`);
        setNotice(null);
        try {
          if (!services?.connection?.rpc?.call) throw new Error('DSH 连接尚未就绪。');
          if (!lwbPackClientRuntime) throw new Error('能力包浏览器运行时尚未就绪。');
          if (method === 'unload') {
            const previousBundle = lwbPackClientRuntime.bundleFor(pack);
            await lwbPackClientRuntime.unload(pack);
            const response = await services.connection.rpc.call('/api', 'lwbPacks/unload', { args: { request: { id: pack.id } } });
            if (!response?.ok) {
              await lwbPackClientRuntime.load(pack, previousBundle).catch(() => {});
              throw new Error(response?.error?.message || '能力包操作未完成。');
            }
          } else {
            const response = await services.connection.rpc.call('/api', 'lwbPacks/load', { args: { request: { id: pack.id } } });
            if (!response?.ok) throw new Error(response?.error?.message || '能力包操作未完成。');
            try {
              await lwbPackClientRuntime.load(pack, response.value?.client);
            } catch (error) {
              await lwbPackClientRuntime.unload(pack).catch(() => {});
              await services.connection.rpc.call('/api', 'lwbPacks/unload', { args: { request: { id: pack.id } } }).catch(() => {});
              throw error;
            }
          }
          await refreshPackCatalog({ retain: true });
          setNotice({ kind: 'success', text: method === 'load' ? copy.packLoaded : copy.packUnloaded });
        } catch (error) {
          setNotice({ kind: 'error', text: error?.message || copy.operationFailed });
        } finally {
          setOperation(null);
        }
      };
      const packAction = (selected, drawer = false) => {
        const pack = packs.find((item) => item.id === selected.id) || selected;
        const busy = operation !== null;
        if (pack.status === 'loaded') {
          return h('div', { className: 'lwb-row-actions' },
            h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy, onClick: (event) => { event.stopPropagation(); if (drawer) setDetailPack(null); navTo('capability', capabilityRoute(pack.id, pack.menus[0].id)); } }, drawer ? copy.packStartAction : copy.openMenu),
            h('button', { type: 'button', className: 'lwb-plain-button', disabled: busy, onClick: (event) => { event.stopPropagation(); void switchPack(pack, 'unload'); } }, busy ? copy.unloadingPack : copy.unload),
          );
        }
        return h('div', { className: 'lwb-row-actions' },
          h('button', { type: 'button', className: 'lwb-primary-button', disabled: busy || pack.status === 'unavailable', title: pack.status === 'unavailable' ? copy.unavailablePack : undefined, onClick: (event) => { event.stopPropagation(); void switchPack(pack, 'load'); } }, busy ? copy.loadingPack : drawer ? copy.packLoadAction : copy.load),
          !drawer && h('button', { type: 'button', className: 'lwb-plain-button', onClick: (event) => { event.stopPropagation(); setNotice(null); setDetailPack(pack); }, title: copy.packDetails(pack.name) }, copy.details),
        );
      };
      if (market.phase === 'pending') {
        return h('div', { className: 'lwb-pack-empty' }, h('div', null, h('strong', null, copy.loadingPacks)));
      }
      if (market.phase === 'error') {
        return h('div', { className: 'lwb-pack-empty' }, h('div', null, h('strong', null, copy.packCatalogFailed), h('p', null, market.error)));
      }
      return h(React.Fragment, null,
        h('div', { className: 'lwb-market-controls' },
          h('input', { className: 'lwb-market-search', type: 'search', value: query, placeholder: copy.marketSearch, onChange: (event) => setQuery(event.target.value) }),
          h('select', { className: 'lwb-select', value: statusFilter, onChange: (event) => setStatusFilter(event.target.value), 'aria-label': copy.currentStatus }, h('option', { value: 'all' }, copy.filterAll), h('option', { value: 'loaded' }, copy.filterLoaded), h('option', { value: 'available' }, copy.filterAvailable)),
          h('select', { className: 'lwb-select', value: category, onChange: (event) => setCategory(event.target.value), 'aria-label': copy.filterCategory }, h('option', { value: 'all' }, copy.filterCategory), categories.map((item) => h('option', { key: item, value: item }, item))),
        ),
        notice && !detailPack && h('p', { className: 'lwb-pack-feedback', role: notice.kind === 'error' ? 'alert' : 'status', 'data-tone': notice.kind }, notice.text),
        filtered.length ? h('div', { className: 'lwb-pack-grid' }, filtered.map((pack) => {
          const [status, tone] = statusLabel(pack.status, copy);
          return h('article', { key: pack.id, className: 'lwb-card lwb-pack-card', tabIndex: 0, onClick: (event) => { event.currentTarget.focus(); setNotice(null); setDetailPack(pack); }, onKeyDown: (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setNotice(null); setDetailPack(pack); } } },
            h('div', { className: 'lwb-pack-card-top' }, h('div', { className: 'lwb-pack-title' }, h('span', { className: 'lwb-pack-icon' }, pack.icon), h('div', null, h('h3', null, pack.name), h('p', null, `${pack.category} · v${pack.version}`))), h('span', { className: 'lwb-status', 'data-tone': tone }, status)),
            h('p', null, pack.description),
            h('div', { className: 'lwb-pack-menu' }, (pack.tags.length ? pack.tags : pack.menus.map((item) => item.label)).slice(0, 4).map((item) => h('span', { key: item, className: 'lwb-menu-pill' }, item))),
            h('p', { className: 'lwb-pack-card-note' }, pack.error || `${copy.menuCount} ${pack.menus.length}`),
            h('div', { className: 'lwb-pack-actions' }, packAction(pack)),
          );
        })) : h('div', { className: 'lwb-pack-empty' }, h('div', null, h('strong', null, packs.length ? copy.noMatchingPacks : copy.noLoadedPacks), h('p', null, copy.packsEmptyCopy))),
        detailPack && h(PackDetailDialog, {
          pack: packs.find((item) => item.id === detailPack.id) || detailPack,
          onClose: () => setDetailPack(null),
          action: packAction(detailPack, true), notice, busy: operation !== null,
        })
      );
    }

    function SettingsPage({ renderSlot }) {
      const copy = useLwbCopy();
      const connectionState = useObservable(services?.connection?.state, 'connecting');
      const connectionLabel = connectionState === 'connected' ? copy.connected : connectionState === 'disconnected' ? copy.disconnected : copy.connecting;
      return h('div', { className: 'lwb-card lwb-settings-list' },
        h('div', { className: 'lwb-settings-section' }, copy.basicConfiguration),
        h('div', { className: 'lwb-setting-row' }, h('div', { className: 'lwb-setting-copy' }, h('strong', null, copy.systemSettings), h('span', null, copy.systemSettingsHint)), h('div', { className: 'lwb-dsh-settings-launcher' }, renderSlot('sidebar.settings', { wide: true }))),
        h('div', { className: 'lwb-settings-section' }, copy.about),
        h('div', { className: 'lwb-setting-row' }, h('div', { className: 'lwb-setting-copy' }, h('strong', null, copy.runtime), h('span', null, copy.runtimeHint)), h('span', { className: 'lwb-status', role: 'status', 'data-tone': connectionState === 'connected' ? undefined : 'warm' }, connectionLabel)),
      );
    }

    class CapabilityPageBoundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      render() {
        if (!this.state.failed) return this.props.children;
        const { copy, onReturnToConversation, onViewPacks } = this.props;
        return h('div', { className: 'lwb-card lwb-empty-state' }, h('div', null,
          h('div', { className: 'lwb-empty-glyph' }, '⚠'), h('h2', null, copy.capabilityPageFailed), h('p', null, copy.capabilityPageFailedCopy),
          h('div', { className: 'lwb-row-actions', style: { justifyContent: 'center' } }, button('lwb-plain-button', copy.returnToConversation, onReturnToConversation), button('lwb-primary-button', copy.viewPacks, onViewPacks)),
        ));
      }
    }

    function CapabilityPage() {
      const state = useProduct();
      const copy = useLwbCopy();
      const catalog = usePackCatalog();
      const registry = useLwbPackClient();
      const selected = capabilityAtRoute(catalog.packs, state.capabilityPage);
      if (!selected) return h('div', { className: 'lwb-card lwb-empty-state' }, h('div', null, h('div', { className: 'lwb-empty-glyph' }, '▦'), h('h2', null, copy.noCapability), h('p', null, copy.noCapabilityCopy), button('lwb-primary-button', copy.goToPacks, () => navTo('packs'))));
      const { pack, menu } = selected;
      const Component = registry?.page(pack.id, menu.id);
      if (Component) return h(CapabilityPageBoundary, {
        key: capabilityRoute(pack.id, menu.id), copy,
        onReturnToConversation: () => showConversation(), onViewPacks: () => navTo('packs'),
      }, h(Component, {
        pack,
        menu,
        packId: pack.id,
        openConversation: () => showConversation(),
        openPacks: () => navTo('packs'),
        openPackMenu: (menuId) => { if (pack.menus.some((item) => item.id === menuId)) navTo('capability', capabilityRoute(pack.id, menuId)); },
      }));
      return h('div', { className: 'lwb-card lwb-empty-state' }, h('div', null,
        h('div', { className: 'lwb-empty-glyph' }, menu.glyph), h('h2', null, copy.clientUnavailable),
        h('p', null, copy.capabilityPageCopy(pack.name)),
        h('div', { className: 'lwb-row-actions', style: { justifyContent: 'center' } }, button('lwb-plain-button', copy.returnToConversation, () => showConversation()), button('lwb-primary-button', copy.viewPacks, () => navTo('packs'))),
      ));
    }

    function MobileNavToggle() {
      const state = useProduct();
      const copy = useLwbCopy();
      return h(React.Fragment, null,
        state.mobileNavOpen && h('button', { type: 'button', className: 'lwb-mobile-nav-backdrop', 'aria-label': copy.closeNavigation, onClick: () => updateProduct({ mobileNavOpen: false }, false) }),
        h('button', {
          type: 'button', className: 'lwb-mobile-nav-trigger', title: state.mobileNavOpen ? copy.closeNavigation : copy.openNavigation,
          'aria-label': state.mobileNavOpen ? copy.closeNavigation : copy.openNavigation,
          onClick: () => updateProduct({ mobileNavOpen: !state.mobileNavOpen, conversationPanelOpen: false }, false),
        }, state.mobileNavOpen ? '×' : '☰'),
        state.page === 'conversation' && h('button', {
          type: 'button', className: 'lwb-mobile-conversation-trigger', title: copy.openConversationList, 'aria-label': copy.openConversationList,
          onClick: () => updateProduct({ conversationPanelOpen: true, mobileNavOpen: false }, false),
        }, '◌'),
      );
    }

    function WorkbenchOverlay({ renderSlot }) {
      const state = useProduct();
      const copy = useLwbCopy();
      const catalog = usePackCatalog();
      const selected = state.page === 'capability' ? capabilityAtRoute(catalog.packs, state.capabilityPage) : undefined;
      const chrome = pageChrome(state.page, selected, copy);
      if (state.page === 'conversation') return h(React.Fragment, null, h(MobileNavToggle), h(ConversationOverlay, { renderSlot }));
      const body = state.page === 'packs' ? h(PacksPage) : state.page === 'settings' ? h(SettingsPage, { renderSlot }) : h(CapabilityPage);
      return h(React.Fragment, null, h(MobileNavToggle), h('section', { className: 'lwb-overlay', 'aria-label': chrome.ariaLabel },
        h('header', { className: 'lwb-overlay-head' }, h('div', { className: 'lwb-overlay-title' }, h('b', null, chrome.title), h('span', null, chrome.hint)), button('lwb-plain-button', `← ${copy.conversation}`, () => showConversation())),
        h('main', { className: 'lwb-overlay-body' }, h('div', { className: state.page === 'capability' ? 'lwb-page lwb-page-capability' : 'lwb-page' },
          h('div', { className: 'lwb-page-intro' }, h('div', null, h('div', { className: 'lwb-eyebrow' }, chrome.eyebrow), h('h1', null, chrome.title), h('p', null, chrome.intro)),
            null,
          ), body,
        )),
      ));
    }

    function apply(ctx) {
      runtimeApi = ctx.get('connection')?.api;
      lwbPackClient = new LwbPackClientRegistry();
      ctx.provide('lwbPackClient', lwbPackClient);
      lwbPackClientRuntime = new LwbPackClientRuntime(ctx.get('loader'), ctx.get('modules'));
      services = {
        slots: ctx.get('slots'), connection: ctx.get('connection'), remote: ctx.get('remote'), settingsScope: ctx.get('settingsScope'), sessions: ctx.get('sessions'), workspaces: ctx.get('workspaces'), uiWorkspace: ctx.get('uiWorkspace'), layout: ctx.get('layout'), locale: ctx.get('locale'),
      };
      installStyle();
      const disposeProductMetadata = installProductMetadata();
      void refreshRuntime();
      void refreshRemoteSettingsCompatibility();
      void refreshPackCatalog();
      const disposePackCatalogReset = ctx.on('connection/reset', () => {
        void refreshPackCatalog();
        void refreshRemoteSettingsCompatibility();
      });
      ctx.effect(() => {
        let disposeSidebar;
        const enableSidebar = () => {
          if (disposeSidebar) return;
          disposeSidebar = ctx.slots.inject('sidebar', () => ctx.slots.register({
            name: 'sidebar', priority: -10, registrant: 'lwb-workbench',
          }, LwbSidebar));
        };
        const disableSidebar = () => {
          disposeSidebar?.();
          disposeSidebar = undefined;
        };
        enableSidebar();
        const disposeRuntimeSettingsTrigger = ctx.slots.inject('settings.trigger', () => ctx.slots.register({
          name: 'settings.trigger', priority: -10, registrant: 'lwb-workbench',
        }, LwbRuntimeSettingsTrigger));
        const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'lwb-workbench-management', order: 10, registrant: 'lwb-workbench',
          children: {
            'sidebar.settings': { kind: 'single', scope: 'root' },
            // Both DSH workspace flows must exist for its picker to activate.
            // Our history pane owns the sidebar flow in the replacement shell.
            'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
          },
        }, WorkbenchOverlay));
        return () => {
          disableSidebar();
          disposeRuntimeSettingsTrigger?.();
          disposeOverlay?.();
          disposePackCatalogReset?.();
          disposeProductMetadata();
          lwbPackClient = undefined;
          lwbPackClientRuntime = undefined;
          document.getElementById('lwb-workbench-style')?.remove();
          document.documentElement.style.removeProperty('--lwb-sidebar-width');
        };
      }, 'lwb: unified workbench shell');
    }

    exports.inject = ['slots', 'connection', 'remote', 'settingsScope', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'locale', 'loader', 'modules'];
    exports.apply = apply;
    return module.exports;
  },
});
