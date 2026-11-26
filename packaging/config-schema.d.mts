export interface ProjectConfig {
  id: string
  name: string
  executableName: string
  debPackageName: string
  version: string
  description: string
  homepage: string
  author: { name: string; email: string }
  iconDir: string
  storageDirName: string
  nsis: {
    oneClick: boolean
    perMachine: boolean
    allowToChangeInstallationDirectory: boolean
    createDesktopShortcut: boolean
    createStartMenuShortcut: boolean
    signHookPath?: string
  }
  deb: {
    section: string
    category: string
    maintainer: string
    depends: string[]
    executableArgs: string[]
    afterInstall?: string
    afterRemove?: string
  }
  extraResources: Array<{ from: string; to: string; filter?: string[] }>
}

export interface PackConfig {
  active: string | string[]
  outputDir: string
  targets: {
    windows: { formats: Array<'nsis' | 'portable' | 'zip' | 'dir'>; arch: Array<'x64' | 'arm64'> }
    linux: { formats: Array<'deb' | 'dir'>; arch: Array<'x64' | 'arm64'> }
  }
  wsl: { enabled: boolean; workspace: string; builderCacheDir: string }
  mirrors: { electron?: string; nodeDist?: string }
  packaging: {
    asar: boolean
    compression: 'store' | 'normal' | 'maximum'
    electronLanguages: string[]
    excludeOptionalDeps: string[]
    extraExternalRoots: string[]
    extraPrunePatterns: string[]
  }
  projects: Record<string, ProjectConfig>
}

export function parsePackConfig(raw: unknown): PackConfig
export function loadPackConfig(configPath: string): PackConfig
export function resolveSelectedProjects(config: PackConfig, overrideKeys?: string[]): Array<[string, ProjectConfig]>
export function validateProjectIcons(iconDirAbs: string, targets: { windows: boolean; linux: boolean }): void
