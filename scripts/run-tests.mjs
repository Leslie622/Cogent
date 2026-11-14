/**
 * 测试引导（阶段 1.3 增）：vitest 进程内会加载 pi 包（node 工程的单元测试
 * import 引擎源码），pi engines 要求 node ≥22.19 —— 系统全局 node 更老时
 * （实测 nvm4w 22.14 无 zlib zstd，pi 嵌套 undici 8.x 模块初始化即
 * TypeError，套件在 import 期崩）切到自带 runtime node 再跑 vitest。
 *
 * 引擎 Node 定位复用生产三级链（src/electron/main/host/runtime.ts 的语义：
 * COGENT_NODE_BIN → resources/runtime/<平台>/bin/node → 当前进程兜底）。
 * 用法：node scripts/run-tests.mjs <vitest 参数…>（如 run / --watch）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/** 当前 node 是否满足 pi 的 engines 门槛（≥22.19） */
function nodeNewEnough(version) {
  const [major, minor] = version.split('.').map(Number)
  if (Number.isNaN(major)) return false
  return major > 22 || (major === 22 && minor >= 19)
}

function bundledNodeBin() {
  const dirByPlatform = { 'win32-x64': 'win-x64', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' }[
    `${process.platform}-${process.arch}`
  ]
  if (dirByPlatform === undefined) return null
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidate = join(process.cwd(), 'resources', 'runtime', dirByPlatform, 'bin', executable)
  return existsSync(candidate) ? candidate : null
}

const vitestEntry = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitestEntry)) {
  console.error('[run-tests] 未找到 vitest 入口（node_modules/vitest/vitest.mjs）—— 先 npm install')
  process.exit(1)
}

// 当前进程的 node 够新（或显式覆盖口存在）→ 直接跑；否则切自带 runtime node。
// 自带也不存在时不静默降级：明确报错指路（fetch:runtime 或升系统 node）
const override = process.env.COGENT_NODE_BIN
const target =
  nodeNewEnough(process.versions.node) || override !== undefined
    ? process.execPath
    : (bundledNodeBin() ?? null)
if (target === null) {
  console.error(
    `[run-tests] 系统 node ${process.versions.node} 低于 pi 要求（≥22.19），且未找到自带 runtime node。\n` +
      '  先跑 npm run fetch:runtime 拉取自带 node，或把系统 node 升到 ≥22.19。'
  )
  process.exit(1)
}

const result = spawnSync(target, [vitestEntry, ...process.argv.slice(2)], { stdio: 'inherit', shell: false })
process.exit(result.status ?? 1)
