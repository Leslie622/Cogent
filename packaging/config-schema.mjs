import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const ArchSchema = z.enum(['x64', 'arm64'])
const WinFormatSchema = z.enum(['nsis', 'portable', 'zip', 'dir'])
const LinuxFormatSchema = z.enum(['deb', 'dir'])

const StorageDirNameSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const trimmed = value.trim()
      return trimmed !== '' && trimmed !== '.' && trimmed !== '..' && !/[/\\]/.test(trimmed)
    },
    { message: 'storageDirName 必须是单个安全目录名，不能包含路径分隔符或 ..' }
  )

const ExtraResourceSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  filter: z.array(z.string()).optional()
})

const ProjectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9.-]+$/, 'id 必须为合法反向域名 appId（如 com.cogent.desktop）'),
  name: z.string().min(1, 'name 不能为空'),
  executableName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'executableName 必须为小写字母/数字/连字符/下划线'),
  debPackageName: z.string().regex(/^[a-z0-9][a-z0-9+.-]+$/, 'debPackageName 必须符合 Debian 包名规范'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'version 必须为合法 SemVer'),
  description: z.string().min(1),
  homepage: z.string().url().or(z.string().min(1)),
  author: z.object({
    name: z.string().min(1),
    email: z.string().email()
  }),
  iconDir: z.string().min(1),
  storageDirName: StorageDirNameSchema.default('.cogent'),
  nsis: z
    .object({
      oneClick: z.boolean().default(false),
      perMachine: z.boolean().default(false),
      allowToChangeInstallationDirectory: z.boolean().default(true),
      createDesktopShortcut: z.boolean().default(true),
      createStartMenuShortcut: z.boolean().default(true),
      signHookPath: z.string().optional()
    })
    .default({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true
    }),
  deb: z
    .object({
      section: z.string().min(1).default('devel'),
      category: z.string().min(1).default('Development'),
      maintainer: z.string().min(1),
      depends: z.array(z.string().min(1)).default([]),
      executableArgs: z.array(z.string()).default([]),
      afterInstall: z.string().optional(),
      afterRemove: z.string().optional()
    }),
  extraResources: z.array(ExtraResourceSchema).default([])
})

export const PackConfigSchema = z.object({
  active: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  outputDir: z.string().min(1).default('dist'),
  targets: z.object({
    windows: z.object({
      formats: z.array(WinFormatSchema),
      arch: z.array(ArchSchema).default(['x64'])
    }),
    linux: z.object({
      formats: z.array(LinuxFormatSchema),
      arch: z.array(ArchSchema).default(['x64'])
    })
  }),
  wsl: z
    .object({
      enabled: z.boolean().default(true),
      workspace: z.string().min(1).default('~/cogent-pack'),
      builderCacheDir: z.string().min(1).default('~/cogent-pack-builder')
    })
    .default({
      enabled: true,
      workspace: '~/cogent-pack',
      builderCacheDir: '~/cogent-pack-builder'
    }),
  mirrors: z
    .object({
      electron: z.string().url().optional(),
      nodeDist: z.string().url().optional()
    })
    .default({}),
  packaging: z
    .object({
      asar: z.boolean().default(true),
      compression: z.enum(['store', 'normal', 'maximum']).default('normal'),
      electronLanguages: z.array(z.string().min(1)).min(1).default(['en-US', 'zh-CN']),
      excludeOptionalDeps: z.array(z.string().min(1)).default(['@napi-rs/canvas', '@napi-rs/canvas-*']),
      extraExternalRoots: z.array(z.string().min(1)).default([]),
      extraPrunePatterns: z.array(z.string().min(1)).default([])
    })
    .default({
      asar: true,
      compression: 'normal',
      electronLanguages: ['en-US', 'zh-CN'],
      excludeOptionalDeps: ['@napi-rs/canvas', '@napi-rs/canvas-*'],
      extraExternalRoots: [],
      extraPrunePatterns: []
    }),
  projects: z.record(z.string().min(1), ProjectSchema).refine((map) => Object.keys(map).length > 0, {
    message: 'projects 至少需要配置一个项目组'
  })
})

export function parsePackConfig(raw) {
  return PackConfigSchema.parse(raw)
}

export function loadPackConfig(configPath) {
  const abs = resolve(configPath)
  if (!existsSync(abs)) {
    throw new Error(`打包配置文件不存在: ${abs}`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (error) {
    throw new Error(`打包配置 JSON 解析失败 (${abs}): ${error instanceof Error ? error.message : String(error)}`)
  }
  return parsePackConfig(raw)
}

export function resolveSelectedProjects(config, overrideKeys) {
  const requested =
    overrideKeys && overrideKeys.length > 0
      ? overrideKeys
      : config.active === 'all'
        ? Object.keys(config.projects)
        : Array.isArray(config.active)
          ? config.active
          : [config.active]

  const uniqueKeys = [...new Set(requested)]
  if (uniqueKeys.length === 0) {
    throw new Error('未选择任何打包项目组')
  }
  return uniqueKeys.map((key) => {
    const project = config.projects[key]
    if (!project) {
      const available = Object.keys(config.projects).join(', ')
      throw new Error(`未知项目组 "${key}"；可选项目组: ${available}`)
    }
    return [key, project]
  })
}

const REQUIRED_LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]

function nonEmptyFile(filePath) {
  return existsSync(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 0
}

export function validateProjectIcons(iconDirAbs, { windows, linux }) {
  if (!existsSync(iconDirAbs)) {
    throw new Error(`项目组图标目录不存在: ${iconDirAbs}`)
  }
  const missing = []
  if (windows && !nonEmptyFile(join(iconDirAbs, 'icon.ico'))) {
    missing.push('icon.ico')
  }
  if (linux) {
    if (!nonEmptyFile(join(iconDirAbs, 'icon.png'))) missing.push('icon.png')
    if (!nonEmptyFile(join(iconDirAbs, 'tray.png'))) missing.push('tray.png')
    for (const size of REQUIRED_LINUX_ICON_SIZES) {
      const rel = join('linux', `${size}x${size}.png`)
      if (!nonEmptyFile(join(iconDirAbs, rel))) missing.push(rel)
    }
  }
  if (missing.length > 0) {
    throw new Error(`图标目录 (${iconDirAbs}) 缺少必需图标文件: ${missing.join(', ')}`)
  }
}
