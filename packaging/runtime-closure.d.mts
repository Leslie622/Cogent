export interface ClosureEntry {
  name: string
  version: string
  sourceDir: string
  relativeDir: string
}

export const REQUIRED_MAIN_ENTRIES: string[]
export const FORBIDDEN_RENDERER_AND_DEV_PACKAGES: string[]

export function packageNameFromSpecifier(specifier: string): string | null
export function scanMainExternalImports(outMainDir: string): string[]
export function collectRuntimeClosure(options: {
  rootPackages: string[]
  projectRoot: string
  excludeOptional?: string[]
}): ClosureEntry[]
export function stagePackagedAppDir(options: {
  projectRoot: string
  stagingAppDir: string
  stagingNodeModulesDir?: string
  rootPackageJson: Record<string, unknown>
  projectConfig: {
    name: string
    debPackageName: string
    version: string
    description: string
    homepage: string
    author: { name: string; email: string }
  }
  closure: ClosureEntry[]
  targetPlatformKey: string
}): void
export function verifyUnpackedBundle(options: {
  resourcesDir: string
  requiredExternalPackages: string[]
  targetPlatformKey: string
  runtimePlatformDir?: string
}): void
