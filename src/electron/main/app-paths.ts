/**
 * 打包态与开发态的壳侧路径解析。
 *
 * 关键约束：Host（host.js）、对外 MCP（mcp.js）和 4 个 worker 由独立官方 Node 22
 * 执行，官方 Node 不支持读取 Electron app.asar 虚拟文件系统；因此打包期将
 * out/main/** 与运行闭包放入 app.asar.unpacked，本模块统一在 app.isPackaged
 * 下解析到 app.asar.unpacked/out/main/，开发态沿用 import.meta.dirname。
 *
 * 纯函数与 electron 薄壳拆分，便于单元测试无需 mock electron（同 host/runtime.ts）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface MainEntryResolveOptions {
  isPackaged: boolean
  resourcesPath: string
  mainDir: string
  entryName: string
}

export interface IconResolveOptions {
  isPackaged: boolean
  resourcesPath: string
  mainDir: string
  platform: NodeJS.Platform
  kind: 'window' | 'tray'
}

/** 解析 out/main 下供外部 Node 执行的入口路径（如 host.js / mcp.js）。 */
export function resolveMainEntryPath(options: MainEntryResolveOptions): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, 'app.asar.unpacked', 'out', 'main', options.entryName)
  }
  return join(options.mainDir, options.entryName)
}

/** 解析图标文件候选路径；dev 态回退读取默认项目组图标目录。 */
export function resolveIconFilePath(options: IconResolveOptions): string {
  const fileName =
    options.platform === 'win32'
      ? options.kind === 'tray'
        ? 'tray.ico'
        : 'icon.ico'
      : options.kind === 'tray'
        ? 'tray.png'
        : 'icon.png'
  if (options.isPackaged) {
    return join(options.resourcesPath, 'icons', fileName)
  }
  return join(options.mainDir, '..', '..', 'packaging', 'icons', 'cogent', fileName)
}

export function resolveUnpackedMainEntry(entryName: string): string {
  return resolveMainEntryPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: import.meta.dirname,
    entryName
  })
}

export function resolveExistingIconPath(kind: 'window' | 'tray'): string | null {
  const candidate = resolveIconFilePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: import.meta.dirname,
    platform: process.platform,
    kind
  })
  return existsSync(candidate) ? candidate : null
}

/** 解析随包内置技能目录（打包态：resources/skills；开发态：仓库根 resources/skills）。 */
export function resolveBundledSkillsPath(options: {
  isPackaged: boolean
  resourcesPath: string
  mainDir: string
}): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, 'skills')
  }
  return join(options.mainDir, '..', '..', 'resources', 'skills')
}

export function resolveExistingBundledSkillsDir(): string | null {
  const candidate = resolveBundledSkillsPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: import.meta.dirname
  })
  return existsSync(candidate) ? candidate : null
}
