/**
 * Host 入口 wrapper（加载顺序保障）。
 *
 * 为什么需要 wrapper：pi 的 tools-manager 在**模块加载期**就执行
 * `const TOOLS_DIR = getBinDir()`（读 PI_CODING_AGENT_DIR）——此后再改这个
 * env 对 fd/rg 的查找目录无效。把赋值写在真身模块体里不够：ESM 的 import
 * 声明先于模块体求值，且打包器（rollup/esbuild external）会把 pi 的静态
 * import 提到产物最顶上，模块体里的赋值永远晚于 pi 加载。
 *
 * 因此本文件【只 import node 内建模块】，先落 env、再动态 import 真身
 * （host-main.ts 与它的 pi 依赖此时才开始加载）。真身的职责与纪律见
 * host-main.ts 头注。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

// pi 域 env 归位：pi 内部走 getAgentDir() 的
// 直读点（fd/rg 管理目录 getBinDir、models.json 兜底路径等）默认指
// ~/.pi/agent —— 统一重定向到 <root>/pi：Host 保持 ~/.cogent 唯一写者
// （全局架构 D1），也不污染/不偷读用户自装 pi CLI 的域。??= 尊重外部显式
// 覆盖（冒烟测试 / 并存调试）
process.env.PI_CODING_AGENT_DIR ??= join(process.env.COGENT_HOME || join(homedir(), '.cogent'), 'pi')

// 必须在动态 import 前留痕：依赖模块求值卡住时，host-main 的任何日志都还执行不到。
process.stderr.write(`[startup] +${Math.round(process.uptime() * 1000)}ms 加载 Host 模块（node ${process.version}）\n`)
await import('./host-main')
