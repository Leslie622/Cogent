/**
 * 打包态路径与品牌默认值测试（纯函数，无需 mock Electron）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveIconFilePath, resolveMainEntryPath } from '../../../src/electron/main/app-paths'
import { getAppDisplayName, getStorageDirName, normalizeStorageDirName } from '../../../src/shared/brand'

describe('brand 默认值与目录名校验', () => {
  it('未经过 Vite 注入时返回默认 Cogent 与 .cogent', () => {
    expect(getAppDisplayName()).toBe('Cogent')
    expect(getStorageDirName()).toBe('.cogent')
  })

  it('非法 storageDirName 回退为 .cogent，合法名称原样保留', () => {
    expect(normalizeStorageDirName(undefined)).toBe('.cogent')
    expect(normalizeStorageDirName('')).toBe('.cogent')
    expect(normalizeStorageDirName('.')).toBe('.cogent')
    expect(normalizeStorageDirName('..')).toBe('.cogent')
    expect(normalizeStorageDirName('a/b')).toBe('.cogent')
    expect(normalizeStorageDirName('a\\b')).toBe('.cogent')
    expect(normalizeStorageDirName('.sxz')).toBe('.sxz')
  })
})

describe('app-paths 打包与开发路径分流', () => {
  it('打包态解析到 app.asar.unpacked/out/main（供官方 Node 22 直接读取）', () => {
    const resolved = resolveMainEntryPath({
      isPackaged: true,
      resourcesPath: join('app', 'resources'),
      mainDir: join('app', 'resources', 'app.asar', 'out', 'main'),
      entryName: 'host.js'
    })
    expect(resolved).toBe(join('app', 'resources', 'app.asar.unpacked', 'out', 'main', 'host.js'))
  })

  it('开发态沿用 mainDir 同级入口', () => {
    const mainDir = join('repo', 'out', 'main')
    expect(
      resolveMainEntryPath({
        isPackaged: false,
        resourcesPath: 'ignored',
        mainDir,
        entryName: 'host.js'
      })
    ).toBe(join(mainDir, 'host.js'))
  })

  it('Windows 用 .ico、Linux 用 .png 解析窗口和托盘图标', () => {
    expect(
      resolveIconFilePath({
        isPackaged: true,
        resourcesPath: join('app', 'resources'),
        mainDir: 'ignored',
        platform: 'linux',
        kind: 'tray'
      })
    ).toBe(join('app', 'resources', 'icons', 'tray.png'))

    expect(
      resolveIconFilePath({
        isPackaged: true,
        resourcesPath: join('app', 'resources'),
        mainDir: 'ignored',
        platform: 'win32',
        kind: 'window'
      })
    ).toBe(join('app', 'resources', 'icons', 'icon.ico'))

    expect(
      resolveIconFilePath({
        isPackaged: false,
        resourcesPath: 'ignored',
        mainDir: join('repo', 'out', 'main'),
        platform: 'linux',
        kind: 'window'
      })
    ).toBe(join('repo', 'packaging', 'icons', 'cogent', 'icon.png'))
  })
})
