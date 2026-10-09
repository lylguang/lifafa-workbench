/**
 * 建好 `lwb/packs/` 下各包的运行期符号链接。
 *
 * 包的 peerDependencies 声明为 `workspace:*`，Node 只能通过包内的
 * `node_modules` 解析成指向 `vendor/deepseek-harness` 的链接。加载一个包时
 * （`linkLwbPackForRuntime`）会建这些链接，但测试直接 import 包的入口文件，
 * 不经过加载流程——在刚 clone 出来、链接还不存在的机器上，`npm test`
 * 会以 ERR_MODULE_NOT_FOUND 失败（@deepseek-ai/dsh-typert-protocol）。
 *
 * 这也是为什么工作副本里测试全绿而干净克隆会挂：那边的链接是历史
 * 遗留的，不是这一步建出来的。客户交付包同理，解压后必须先跑它。
 */
import { linkInRepoPacks } from './pack-runtime-links.mjs'

const linked = await linkInRepoPacks()
console.log(linked.length ? `已链接运行期依赖: ${linked.join(', ')}` : '未发现需要链接的包')