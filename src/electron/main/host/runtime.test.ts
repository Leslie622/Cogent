/**
 * runtime 三级链回归钉 —— 引擎 Node 定位是进程链路的起点，优先级错了
 * （比如静默落到不满足守卫的 execPath）症状会出现在千里之外的握手超时，
 * 这里把链路顺序钉死在纯函数层。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bundledNodeBin, bundledPlatformDir, devResourcesRoot, resolveEngineNodeBin } from './runtime'

describe('bundledPlatformDir', () => {
  it('目标三平台组合映射到 runtime 子目录', () => {
    expect(bundledPlatformDir('win32', 'x64')).toBe('win-x64')
    expect(bundledPlatformDir('linux', 'x64')).toBe('linux-x64')
    expect(bundledPlatformDir('linux', 'arm64')).toBe('linux-arm64')
  })

  it('非目标组合返回 null（darwin / win-arm64 —— fetch-runtime 同样拒绝，口径一致）', () => {
    expect(bundledPlatformDir('darwin', 'arm64')).toBeNull()
    expect(bundledPlatformDir('win32', 'arm64')).toBeNull()
  })
})

describe('bundledNodeBin', () => {
  it('全平台统一 bin/ 子目录（布局契约：fetch-runtime.mjs 落盘同款）', () => {
    const root = join('app', 'resources')
    expect(bundledNodeBin(root, 'win32', 'x64')).toBe(join(root, 'runtime', 'win-x64', 'bin', 'node.exe'))
    expect(bundledNodeBin(root, 'linux', 'x64')).toBe(join(root, 'runtime', 'linux-x64', 'bin', 'node'))
  })

  it('非目标平台返回 null 而不是拼出无人会放的路径', () => {
    expect(bundledNodeBin('whatever', 'darwin', 'arm64')).toBeNull()
  })
})

describe('devResourcesRoot', () => {
  it('从产物 out/main 上溯两级到项目根 resources（getAppPath 在 electron-vite dev 下指向 out/main，不可用）', () => {
    expect(devResourcesRoot(join('proj', 'out', 'main'))).toBe(join('proj', 'resources'))
  })
})

/**
 * 真实布局契约：fetch-runtime.mjs 落盘 ↔ bundledNodeBin 拼装两侧必须一致。
 * 开发机跑过 fetch:runtime（resources/runtime 存在）即强校验；CI 未 fetch 自动跳过。
 * 钉的正是 2026-11-13 dev 翻车：win 落盘在 bin/、解析拼归档根，静默走兜底 Node。
 */
describe('真实布局契约', () => {
  const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const runtimeDirExists = existsSync(join(projectRoot, 'resources', 'runtime'))

  it.skipIf(!runtimeDirExists)('resources/runtime 在 → 本机平台的解析路径必须真实存在', () => {
    const bin = bundledNodeBin(join(projectRoot, 'resources'), process.platform, process.arch)
    expect(bin, '解析路径与 fetch-runtime 落盘布局不一致').toBeTruthy()
    expect(existsSync(bin!), '解析路径与 fetch-runtime 落盘布局不一致').toBe(true)
  })
})

describe('resolveEngineNodeBin 三级链', () => {
  it('COGENT_NODE_BIN 一票优先（显式覆盖口，不与自带争）', () => {
    expect(resolveEngineNodeBin({ COGENT_NODE_BIN: '/custom/node' }, '/bundled/node.exe', '/electron.exe')).toBe(
      '/custom/node'
    )
  })

  it('无覆盖时有自带用自带（Electron 31 时代的唯一通路）', () => {
    expect(resolveEngineNodeBin({}, '/bundled/node.exe', '/electron.exe')).toBe('/bundled/node.exe')
  })

  it('无自带退 execPath —— 降 31 后此级由 manager 版本守卫明确拒绝，链路不静默降级', () => {
    expect(resolveEngineNodeBin({}, null, '/electron.exe')).toBe('/electron.exe')
  })
})
