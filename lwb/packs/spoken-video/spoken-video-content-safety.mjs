// AI 产物源码的静态内容安全检查。
//
// 为什么需要：CreativeVideo.tsx 由视频 Agent 写出，随后被当普通文件分发出去，
// 而求值门只验「能不能跑起来」，不验「跑了什么」——它完全可以 import fs、
// 读 process.env、硬编码本机绝对路径或密钥，而没有任何一层会拦。
//
// 定位是**闸门**不是**清理工**：2026-10-15 扫了 75 个历史产物共 6.6 MB，
// 密钥 / 绝对路径 / 危险 import / 邮箱 / 手机号 11 类模式零命中（唯一一处
// /Users/ 开头是演示用的假路径 `/Users/你/Movies`）。也就是说现存产物是干净的，
// 这道闸防的是以后：Agent 被注入的素材、用户给的文案、或某次改写。
//
// 全部只产 warning、不阻塞渲染。理由是这些形态里有一部分是正当用法——
// `process.env` 读字体路径是合理的，白名单比黑名单更容易写对。
// 阻塞应该留给「确认是密钥」这种证据充分的情形，那是人工判断的事。

/** 凭据形态：这些串只可能是密钥，出现在画面源码里没有正当理由。 */
const SECRET_PATTERNS = [
  // sk- 后面允许连字符分段：真实形态有 sk-proj-xxx、sk-ant-api03-xxx、
  // sk-org-xxx，纯字母数字的写法漏掉这些。
  { name: 'OpenAI/Anthropic 密钥', re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-|org-|svcacct-)?[A-Za-z0-9_-]{32,})/gu },
  { name: 'GitHub 令牌', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/gu },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/gu },
  { name: 'Bearer 令牌', re: /Bearer\s+[A-Za-z0-9._-]{24,}/gu },
  { name: '私有密钥块', re: /-----BEGIN\s+(?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu },
]

/**
 * 占位用户名：写演示文案或示例路径时最常出现这几个，误报代价高于漏报——
 * 泄露一个叫 user 的用户名没有意义，挡住正常产物却会打断管线。
 */
const PLACEHOLDER_USER = /^(?:user|users|name|me|you|test|demo|sample|tmp|temp|admin|root|home|xxx|abc|foo|bar|example|someone|某人|你|我|他|名字|用户名)$/iu

const isPlaceholderUser = (value) => PLACEHOLDER_USER.test(value)

/** 本机绝对路径。只认「真实感」的形态：放过 `/Users/你`、`/home/user` 这类占位。 */
const LOCAL_PATH_PATTERNS = [
  { name: 'Windows 用户目录', re: /[A-Za-z]:\\Users\\(?<user>[A-Za-z0-9._-]{3,})\\/gu },
  { name: 'macOS 用户目录', re: /\/Users\/(?<user>[A-Za-z][A-Za-z0-9._-]{2,})\/(?:Documents|Desktop|Movies|Downloads|Pictures|Library|Projects)\//gu },
  // 子目录可选：/home/liwei 本身就已经泄露了本机用户名，不必再要求后缀。
  { name: 'Linux home 目录', re: /\/home\/(?<user>[a-z][a-z0-9._-]{2,})(?:\/(?:Documents|Desktop|Movies|Downloads|Pictures|\.config)\/)?/gu },
]

/**
 * 画面代码用不上的能力。它们不是恶意信号，但出现在画面源码里通常意味着
 * Agent 在尝试绕路（比如自己读文件、自己发请求），值得让人看一眼。
 */
const FORBIDDEN_IMPORTS = [
  { name: '文件系统', re: /\bfrom\s+['"](?:node:)?(?:fs|fs\/promises)['"]|\brequire\(\s*['"](?:node:)?(?:fs|fs\/promises)['"]\s*\)/gu },
  { name: '子进程', re: /\bfrom\s+['"](?:node:)?child_process['"]|\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/gu },
  { name: '网络', re: /\bfrom\s+['"](?:node:)?(?:net|http|https|dgram|tls)['"]|\brequire\(\s*['"](?:node:)?(?:net|http|https|dgram|tls)['"]\s*\)/gu },
  { name: 'eval/Function 构造', re: /\b(?:eval|new\s+Function)\s*\(/gu },
  { name: 'process 退出/绑定', re: /\bprocess\.(?:exit|abort|kill|binding)\s*\(/gu },
]

/**
 * 自动加载的指令文件。这类文件会被 AI 宿主直接读入当指令，等于让产物里的
 * 一段文字改变后续 Agent 的行为——不是安全漏洞，但是提示词注入面。
 * MotionGit 也把它列为独立违规项（content.auto-loaded）。
 */
const AUTO_LOADED_PATTERN = /['"](CLAUDE\.md|AGENTS\.md|\.cursorrules|\.clinerules|\.windsurfrules)['"]/gu

/**
 * 扫描源码里的凭据、本机路径、不该有的能力和自动加载指令文件。
 *
 * @param source - src/CreativeVideo.tsx 源码
 * @returns [{ code, line, message }]，没有命中返回空数组
 */
export function inspectContentSafety(source) {
  if (typeof source !== 'string' || !source) return []
  const warnings = []
  const report = (code, match, message) => {
    const line = source.slice(0, match.index).split('\n').length
    warnings.push({ code, file: 'src/CreativeVideo.tsx', line, column: 1, message })
  }

  for (const { name, re } of SECRET_PATTERNS) {
    for (const match of source.matchAll(re)) {
      report('secret-pattern', match, `源码里出现疑似${name}。画面渲染用不到凭据，请删除；若确系误伤，请改成从任务输入读取。`)
    }
  }

  for (const { name, re } of LOCAL_PATH_PATTERNS) {
    for (const match of source.matchAll(re)) {
      const user = match.groups?.user
      if (user && isPlaceholderUser(user)) continue
      report('local-path', match, `源码里硬编码了本机${name}（${match[0]}）。产物会被分发，这类路径会泄露本机用户名与目录结构；请改用相对路径或任务输入。`)
    }
  }

  for (const { name, re } of FORBIDDEN_IMPORTS) {
    for (const match of source.matchAll(re)) {
      report('forbidden-capability', match, `画面源码用到了${name}。渲染组件应当只依赖 React 与 Remotion；如确有必要请说明理由。`)
    }
  }

  // process.env 单独提示而非禁止：导演用它读字体路径是合理写法。
  for (const match of source.matchAll(/\bprocess\.env(?:\.[A-Za-z_]\w*|\[[^\]]+\])/gu)) {
    report('env-access', match, '画面源码读取了 process.env。本机环境变量可能包含凭据，且产物会被分发；请确认这里只读字体、路径一类无害配置。')
  }

  for (const match of source.matchAll(AUTO_LOADED_PATTERN)) {
    report('auto-loaded-instructions', match, `源码引用了 AI 宿主会自动加载的指令文件 ${match[1]}。这类文件的内容会被当成指令执行，等于让产物改变后续助手的行为；请从画面代码中移除。`)
  }

  return warnings
}

/** 供测试与排查使用：这份源码里到底命中了哪些类别。 */
export const CONTENT_SAFETY_RULE_NAMES = [...SECRET_PATTERNS, ...LOCAL_PATH_PATTERNS, ...FORBIDDEN_IMPORTS].map((rule) => rule.name)