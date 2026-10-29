/**
 * 情感故事号的题材与钩子库。
 *
 * 为什么不把规则直接写进提示词：
 * 「钩子要扎心」这类话模型每次都会点头，然后每次给出不一样的东西。把可用钩子
 * 与题材做成可检索的结构化数据之后，写稿层是**挑**而不是**想**——挑出来的结果
 * 稳定、可回看「哪一类真的留住了人」。
 *
 * 与通用口播钩子库的区别：那一份服务于知识类内容（反常识、数字承诺、效率）。
 * 情感故事的观众不是来获取信息的，是来**被放进一个具体场面**的。所以这里的钩子
 * 全部要求「第一句话里有人、有事、有一句对白或一个反常动作」，不提供论说式开场。
 *
 * 另一个刻意的约束：本库**只给公式与边界，不给成品文案**。成品文案会被逐字复述，
 * 复述出来的东西听感上像模板，看两条就能认出来——那正是「AI 味」的来源。
 */

/** 30-40 岁女性受众的情感故事题材，按实际爆款率排序。 */
export const STORY_THEMES = Object.freeze([
  {
    id: 'marriage',
    name: '婚姻与离婚',
    core: '共同生活里被磨掉的期待，和某一个决定性的瞬间。',
    best: '受众共鸣最大的一类；离婚、冷战、婆媳、经济分配都能落进来',
    avoid: '不要写成控诉书；两方都要有可理解的理由，单向的坏人会让故事失去可信度',
  },
  {
    id: 'family-origin',
    name: '原生家庭',
    core: '父母、兄弟姐妹之间长期的偏心、索取与沉默。',
    best: '愤怒与委屈最容易转发；「我哥说你是女儿你多出点」这类一句话就能立住',
    avoid: '不要煽动「天下父母皆祸害」式的整体否定，要落在具体的一件事上',
  },
  {
    id: 'midlife',
    name: '中年危机',
    core: '三十五岁之后被裁员、被降薪、被年龄评价的具体的一天。',
    best: '男性观众也会看；停车场、电梯、公司楼下的便利店都是好场景',
    avoid: '不要给「逆袭成功」的爽文结尾，那会瞬间出戏',
  },
  {
    id: 'late-love',
    name: '中年人的爱',
    core: '过了三十岁之后，爱变成了算账、拖延和不好意思开口。',
    best: '相亲、二婚、迟来的体贴；情绪浓度高但不需要狗血',
    avoid: '不要写成少女偶像剧台词，中年人的爱是具体的（买菜、换灯泡、还房贷）',
  },
  {
    id: 'kinship',
    name: '亲情细碎日常',
    core: '母亲藏起来的工资卡、父亲不肯说的一句软话。',
    best: '催泪与转发最强；适合做周末与节令节点',
    avoid: '不要用「树欲静而风不止」这类成语升华，收在动作上',
  },
  {
    id: 'unresolved',
    name: '意难平',
    core: '分开很久之后仍然会在某个具体场景里想起对方。',
    best: '「凌晨两点我发了句在吗」这类开场天然带悬念',
    avoid: '不要复联成功，也不要苦情到底；停在没做完的动作上最有力',
  },
])

/**
 * 情感故事专用的开场钩子。
 *
 * shape 是句式占位而不是成品句子：每一项都必须填进当篇素材里真实存在的
 * 时间、地点、物品或对白，模型无法靠复用句式糊弄过去。
 */
export const STORY_HOOKS = Object.freeze([
  {
    id: 'key-line',
    name: '关键对白开场',
    shape: '直接甩出某个人说的那一句原话，不加任何交代。',
    best: '素材里本来就有一句话特别扎人的时候（评论区原话、转述的对话）',
    avoid: '对白本身平淡时不要硬包装，观众听不出重量',
  },
  {
    id: 'scene-drop',
    name: '反常场景直入',
    shape: '[具体时间] + [具体地点] + [我] 正在做 [一个反常的动作]，不说为什么。',
    best: '画面感强、行为本身就带着情绪的故事',
    avoid: '需要背景知识才能看出反常的题材',
  },
  {
    id: 'object-hook',
    name: '物件悬问',
    shape: '从一件具体的旧物（一口锅、一张卡、一条微信）开始，先说它现在的状态。',
    best: '线索物贯穿全篇的故事；物件天然可复用为视觉锚点',
    avoid: '物件与情绪没有绑定关系的题材',
  },
  {
    id: 'number-hook',
    name: '数字开场',
    shape: '[具体的年数/岁数/金额/次数] + 一个动作用这个数字讲出来。',
    best: '有真实、可核对的数字（结婚八年、还了三年房贷）',
    avoid: '为了套公式编数字——这是本包最不可接受的编造类型',
  },
  {
    id: 'decision-hook',
    name: '决定开场',
    shape: '我已经 [做了某个决定]，然后回到 [那件事] 的开头。',
    best: '有明确转折点的故事（决定离婚、决定搬走、决定不说话）',
    avoid: '把结局当钩子就等于剧透，只在决定本身不是结局时使用',
  },
])

/** 情感故事的情绪驱动。一条故事只挑一个主驱动，叠加会互相稀释。 */
export const STORY_TRIGGERS = Object.freeze([
  { id: 'injustice', name: '委屈不平', core: '付出被当作理所当然，且没有人替她说话。', boundary: '委屈要来自具体的一件件事，不要沦为泛泛的「女人不容易」。' },
  { id: 'recognition', name: '被看见', core: '长期不被在意的人，在某一刻被别人看见了。', boundary: '「被看见」要由别人的一个具体动作完成，不要靠旁白宣布。' },
  { id: 'loss', name: '失去与遗憾', core: '明知留不住，仍然做了一个多余的动作。', boundary: '遗憾不等于惨；克制比哭喊更有力。' },
  { id: 'anger', name: '愤怒爆发', core: '忍了很久之后，第一次把话说出口。', boundary: '爆发的场合要具体；不要演变成人身攻击或性别对立。' },
])

export function findStoryTheme(id) {
  return STORY_THEMES.find((theme) => theme.id === id) || null
}

export function findStoryHook(id) {
  return STORY_HOOKS.find((hook) => hook.id === id) || null
}

export function findStoryTrigger(id) {
  return STORY_TRIGGERS.find((trigger) => trigger.id === id) || null
}

export function storyThemeNames() {
  return STORY_THEMES.map((theme) => theme.name)
}

/** 给写稿层的紧凑参考文本：只有 id、公式与边界，没有成品文案。 */
export function buildStoryHookReference() {
  const themes = STORY_THEMES.map((theme) => `  - ${theme.name}（${theme.id}）：${theme.core}\n    适合：${theme.best}\n    边界：${theme.avoid}`).join('\n')
  const hooks = STORY_HOOKS.map((hook) => `  - ${hook.name}（${hook.id}）：${hook.shape}\n    适合：${hook.best}\n    不适合：${hook.avoid}`).join('\n')
  const triggers = STORY_TRIGGERS.map((trigger) => `  - ${trigger.name}（${trigger.id}）：${trigger.core}\n    边界：${trigger.boundary}`).join('\n')
  return [
    '题材（每条故事只落在一个题材里）：',
    themes,
    '',
    '开场钩子（每条故事只挑一个主钩子，多个叠加会互相稀释）：',
    hooks,
    '',
    '情绪驱动（每条故事只挑一个主驱动）：',
    triggers,
  ].join('\n')
}
