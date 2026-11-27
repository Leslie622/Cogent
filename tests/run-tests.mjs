/**
 * 测试引导：vitest 进程内会加载 pi 包（node 工程的单元测试
 * import 引擎源码），pi engines 要求 node ≥22.19 —— 系统全局 node 更老时
 * （实测 nvm4w 22.14 无 zlib zstd，pi 嵌套 undici 8.x 模块初始化即
 * TypeError，套件在 import 期崩）切到自带 runtime node 再跑 vitest。
 *
 * 显式指定 COGENT_NODE_BIN 时，测试进程与被测 Host 使用同一个 Node。
 * 未指定时，测试优先使用满足版本要求的当前 Node，旧版才回退到自带运行时。
 * 用法：node tests/run-tests.mjs <vitest 参数…>（如 run / --watch）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const target = process.env.COGENT_NODE_BIN ||
  (nodeNewEnough(process.versions.node) ? process.execPath : bundledNodeBin())
if (target === null) {
  console.error(
    `[run-tests] 系统 node ${process.versions.node} 低于 pi 要求（≥22.19），且未找到自带 runtime node。\n` +
      '  先跑 npm run fetch:runtime 拉取自带 node，或把系统 node 升到 ≥22.19。'
  )
  process.exit(1)
}

/** 沙箱环境常把 TEMP/TMP 放在以 `.` 开头的隐藏目录（如 `.t3`），会触发网页预览敏感目录守卫；
 *  仅在检测到隐藏目录段时为测试子进程重定向到仓库内 gitignored 的 `tmp/test-temp`，不放宽产品安全守卫。 */
function hasHiddenSegment(dir) {
  return typeof dir === 'string' && dir.split(/[\\/]+/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')
}

const env = { ...process.env }
const currentTemp = env.TEMP || env.TMP || env.TMPDIR || tmpdir()
if (hasHiddenSegment(currentTemp)) {
  const safeTemp = join(process.cwd(), 'tmp', 'test-temp')
  mkdirSync(safeTemp, { recursive: true })
  env.TEMP = safeTemp
  env.TMP = safeTemp
  env.TMPDIR = safeTemp
}

const result = spawnSync(target, [vitestEntry, ...process.argv.slice(2)], { stdio: 'inherit', shell: false, env })
if (result.error) console.error(`[run-tests] 无法启动测试 Node ${target}: ${result.error.message}`)
process.exit(result.status ?? 1)
