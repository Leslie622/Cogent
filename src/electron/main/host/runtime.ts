/**
 * 引擎 Node 二进制定位 —— spawn 决策的唯一入口（manager 只消费结果，不查环境不摸文件）。
 *
 * 三级链（优先级从高到低，全局架构 D1/D11）：
 * 1. COGENT_NODE_BIN：显式覆盖口（开发调试 / 旧宿主复用引擎时指向任意 Node ≥ 22.19）；
 * 2. resources/runtime/<平台>/bin/node(.exe)：构建期 scripts/fetch-runtime.mjs 放入的
 *    官方 Node 22 —— Electron 31 内置 Node 20.15 < pi 要求 22.19，自带是唯一通路；
 * 3. process.execPath：Electron 自带 Node 兜底（manager 判定补设 ELECTRON_RUN_AS_NODE）。
 *    降 31 后此级不再满足版本守卫 —— 由 manager 握手后的守卫明确报错，绝不静默降级。
 *
 * 解析逻辑全部拆为纯函数（env / 存在性结果注入），electron 依赖只出现在
 * resolveEngineNode 薄壳里 —— co-located 测试无需 mock electron。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** resources/runtime 下的平台子目录名 —— 与 fetch-runtime.mjs 的归档布局一一对应 */
export type BundledPlatformDir = 'win-x64' | 'linux-x64' | 'linux-arm64'

/** 目标平台 → runtime 子目录名；非目标组合（darwin / win-arm64…）返回 null = 无自带可言 */
export function bundledPlatformDir(platform: NodeJS.Platform, arch: string): BundledPlatformDir | null {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  return null
}

/**
 * 自带 node 可执行文件路径（纯拼装不查存在性）。
 * 布局契约：fetch-runtime.mjs 把可执行文件统一放 <平台>/bin/ 下（win 官方 zip
 * 里 node.exe 在归档根，脚本落盘时挪进 bin/，全平台同构 —— Pi-meme 同款）。
 * runtime.test.ts 的「真实布局契约」用例在开发机 fetch 过 runtime 时强校验两侧一致
 * （2026-11-13 dev 实测翻车根因：win 解析拼了归档根、落盘在 bin/，静默走兜底）。
 */
export function bundledNodeBin(resourcesRoot: string, platform: NodeJS.Platform, arch: string): string | null {
  const dir = bundledPlatformDir(platform, arch)
  if (!dir) return null
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  return join(resourcesRoot, 'runtime', dir, 'bin', executable)
}

/** 三级链纯逻辑；bundled 传入前须完成存在性检查（不存在 = null，落到 execPath 兜底） */
export function resolveEngineNodeBin(env: NodeJS.ProcessEnv, bundled: string | null, fallback: string): string {
  if (env.COGENT_NODE_BIN) return env.COGENT_NODE_BIN
  return bundled ?? fallback
}

/**
 * 开发态资源根：main 产物在 out/main/，项目根 resources/ 在其上两级。
 * 不能用 app.getAppPath() —— electron-vite dev 以文件路径
 * `electron out/main/index.js` 启动，getAppPath 返回 out/main 而非项目根
 * （dev 实测：引擎静默落到 Electron 兜底 Node 的根因）。
 * import.meta.dirname 在产物中指向 out/main（manager 的 entryPath 同款依赖）。
 */
export function devResourcesRoot(mainDir: string): string {
  return join(mainDir, '..', '..', 'resources')
}

/** electron 薄壳：资源根 = 打包态 process.resourcesPath / 开发态上溯两级 */
export function resolveEngineNode(): string {
  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : devResourcesRoot(import.meta.dirname)
  const candidate = bundledNodeBin(resourcesRoot, process.platform, process.arch)
  return resolveEngineNodeBin(
    process.env,
    candidate !== null && existsSync(candidate) ? candidate : null,
    process.execPath
  )
}
