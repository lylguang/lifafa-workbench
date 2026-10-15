/**
 * 触发点与钩子库
 *
 * 为什么要单独建库而不是把规则写进提示词：
 * 写稿提示词里写「钩子要有冲击力」等于没说，模型每次自由发挥、每次不一样。
 * 把钩子类型、话术公式和适用边界做成可检索的结构化数据，写稿层就能**挑**，
 * 而不是**想**——挑出来的结果稳定、可累积、可回看哪类真的留住了人。
 *
 * 分类依据是人类决策的三种底层驱动力：想更多（贪婪）、怕失去（恐惧）、想省事（懒惰）。
 * 每一类都给出可直接套用的公式，但**不提供成品文案**——成品文案会被逐字复述，
 * 公式则必须结合当篇稿件的事实来填，这正是我们要保留的部分。
 */

export const TRIGGER_CATEGORIES = Object.freeze([
  {
    id: 'greed',
    name: '贪婪',
    summary: '想要更多、更快、更好——用「更少投入换更多产出」驱动。',
    subtypes: [
      {
        id: 'greed-efficiency',
        name: '效率贪婪',
        core: '用更少时间获得更多成果',
        formulas: [
          '[时间量词] + [动词] + [高价值成果]',
          '[倍数] + [效率提升]',
          '不[重复动作]，直接[结果]',
        ],
        examples: ['30 分钟做完一周的选题', '一键完成，不用手工对表'],
        boundary: '不要承诺无法验证的倍数；没有实测数据就换成具体步骤而不是倍数。',
      },
      {
        id: 'greed-capability',
        name: '能力贪婪',
        core: '获得原本不具备的能力',
        formulas: ['[低门槛身份] + 也能 + [高价值成果]', '不用学也会，[直接得到结果]'],
        examples: ['不会编程的人也能把工具做出来', '零基础也能上手的自动化'],
        boundary: '门槛低不等于零成本，不要暗示跳过必要的学习或核验。',
      },
      {
        id: 'greed-information',
        name: '信息贪婪',
        core: '获取稀缺、一手、独家的信息',
        formulas: ['[权威来源] + [稀缺性描述] + [你能得到的]', '大多数人不知道的[关键点]'],
        examples: ['官方文档里写明但没人提的一条限制'],
        boundary: '稀缺性必须有依据；不要把公开信息包装成内幕。',
      },
    ],
  },
  {
    id: 'fear',
    name: '恐惧',
    summary: '害怕失去、落后、被淘汰——用代价与风险驱动。',
    subtypes: [
      {
        id: 'fear-fomo',
        name: '错失恐惧',
        core: '害怕错过机会或被落下',
        formulas: ['再不用就[代价]', '[人群] 已经在用[变化]'],
        examples: [],
        boundary: '焦虑营销风险最高：不夸大后果，不制造不存在的截止日期。',
      },
      {
        id: 'fear-cost',
        name: '代价放大',
        core: '指出一路走下去的隐性成本',
        formulas: ['每[周期] 都在损失[可量化的东西]', '看似省了[步骤]，实际多付了[代价]'],
        examples: ['每条视频多花两小时手动对表，一年就是九十小时'],
        boundary: '代价要能算出来；不要虚构数字来制造紧迫感。',
      },
    ],
  },
  {
    id: 'sloth',
    name: '懒惰',
    summary: '追求省力、简单、自动化——「躺着就能完成」是最强驱动力。',
    subtypes: [
      {
        id: 'sloth-automation',
        name: '自动化贪婪',
        core: '让流程自己跑',
        formulas: ['[触发条件] 就自动 [动作]', '配一次，之后不用管'],
        examples: ['稿件落地就自动出片'],
        boundary: '不要承诺完全无人值守；需要人复核的环节要说出来。',
      },
      {
        id: 'sloth-template',
        name: '抄作业',
        core: '给一个能直接复制的成品',
        formulas: ['照着这[份清单/模板] 就能 [结果]', '存下来，下次直接用'],
        examples: [],
        boundary: '模板必须真能用；不要给看起来完整但缺关键步骤的伪模板。',
      },
    ],
  },
])

/**
 * 钩子类型库。
 *
 * 与触发点的区别：触发点决定「说什么动机」，钩子类型决定「第一句话怎么开口」。
 * 一篇只能挑一个主钩子——多个钩子叠加会互相稀释，实测表现为「谁都不像」。
 */
export const HOOK_PATTERNS = Object.freeze([
  {
    id: 'counterintuitive',
    name: '反常识结论',
    shape: '大多数人以为 [常见认知]，其实 [相反的事实]。',
    best: '有明确错误认知要纠正的题材',
    avoid: '共识很强的题材（没有「相反」可言）',
  },
  {
    id: 'number-promise',
    name: '数字承诺',
    shape: '[时间/数量] + [动词] + [成果]。',
    best: '方法类、效率类',
    avoid: '没有真实数字可引的题材——不要为了套公式编数字',
  },
  {
    id: 'pain-point',
    name: '痛点直击',
    shape: '如果你 [具体的难受时刻]，这条是给你的。',
    best: '面向明确人群、痛点清晰的题材',
    avoid: '受众不明确时（不知道在对谁说话）',
  },
  {
    id: 'contrast',
    name: '对比冲突',
    shape: '[做法 A] 和 [做法 B] 的差别，其实是 [关键差异]。',
    best: '有正误两套做法的题材',
    avoid: '只有一种做法、没有对照的题材',
  },
  {
    id: 'result-first',
    name: '结果前置',
    shape: '先给 [结果/结论]，再说怎么做到的。',
    best: '有明确产出物的题材（成片、报表、发布）',
    avoid: '结论还不确定的探索类题材',
  },
  {
    id: 'identity',
    name: '身份代入',
    shape: '[具体身份] 才会关心 [具体问题]。',
    best: '垂类内容、身份边界清晰',
    avoid: '泛人群内容（谁都能看 = 谁都不被代入）',
  },
  // —— 故事赛道钩子（民间故事/志怪/传说）：观众要的是被场景抓住，不是被告知结论 ——
  {
    id: 'scene-drop',
    name: '反常场景直入',
    shape: '[时间地点] + [具体的人] + [正在做的反常动作]，不说为什么。',
    best: '画面感强、开头就有异常的故事（讲故事的默认主钩子）',
    avoid: '需要背景知识才能看出反常的题材（观众看不出哪里怪）',
  },
  {
    id: 'folklore-question',
    name: '身边之物悬问',
    shape: '[人人都见过的日常物/习俗] 为什么 [反常的讲究]？',
    best: '民俗来历、老规矩、风物传说——观众每天路过却没想过',
    avoid: '答案一句话就说完的题材（缺口撑不满全片）',
  },
  {
    id: 'rule-statement',
    name: '禁忌开场',
    shape: '老辈人说，[具体禁忌]。[打破它的人] 后来 [留悬念的下场引子]。',
    best: '节令禁忌、劝世故事——规矩感自带张力',
    avoid: '编造的假禁忌；恐怖呈现超出「悬念与回味」层级的题材',
  },
  {
    id: 'character-oddball',
    name: '怪人亮相',
    shape: '[地方] 有个 [人]，全 [地方] 的人都 [对他的一致态度]，只有 [反常细节]。',
    best: '人物轶事、聊斋式故事——先立人再入事',
    avoid: '人物没有记忆点的故事（态度一致 = 没有反差）',
  },
])

/**
 * 按 id 取钩子类型；取不到返回 null，由调用方自由创作。
 * 不猜、不近似匹配——挑错钩子类型比没有提示更糟。
 */
export function findHookPattern(id) {
  return HOOK_PATTERNS.find((pattern) => pattern.id === id) || null
}

/** 按 id 取触发点；同样不猜。 */
export function findTrigger(id) {
  for (const category of TRIGGER_CATEGORIES) {
    const found = category.subtypes.find((subtype) => subtype.id === id)
    if (found) return { category: { id: category.id, name: category.name }, subtype: found }
  }
  return null
}

/**
 * 给写稿层的紧凑参考文本。
 *
 * 只列 id、名称、公式与边界——**不附成品文案**。附了就会被逐字复述，
 * 而复述出来的钩子听感上像模板，看两期就能认出来。
 */
export function buildHookReference() {
  const triggers = TRIGGER_CATEGORIES.map((category) =>
    [
      `【${category.name}】${category.summary}`,
      ...category.subtypes.map(
        (subtype) => `  - ${subtype.name}：${subtype.core}\n    公式：${subtype.formulas.join(' / ')}\n    边界：${subtype.boundary}`,
      ),
    ].join('\n'),
  ).join('\n')

  const hooks = HOOK_PATTERNS.map((pattern) =>
    `  - ${pattern.name}（${pattern.id}）：${pattern.shape}\n    适合：${pattern.best}\n    不适合：${pattern.avoid}`,
  ).join('\n')

  return [
    '钩子类型（每篇只挑一个主钩子，多个叠加会互相稀释）：',
    hooks,
    '',
    '触发点（决定说什么动机，按题材选一个主驱动）：',
    triggers,
  ].join('\n')
}