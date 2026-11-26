import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BUILTIN_SET = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

export const REQUIRED_MAIN_ENTRIES = [
  'index.js',
  'host.js',
  'mcp.js',
  'search-worker.js',
  'attachment-worker.js',
  'file-view-worker.js',
  'change-diff-worker.js'
]

export const FORBIDDEN_RENDERER_AND_DEV_PACKAGES = [
  'react',
  'react-dom',
  'mermaid',
  '@lobehub/icons',
  '@pierre/diffs',
  'katex',
  'vitest',
  'eslint',
  'typescript',
  'patch-package',
  'electron-builder',
  '@napi-rs/canvas'
]

export function packageNameFromSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier === 'electron' ||
    BUILTIN_SET.has(specifier)
  ) {
    return null
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return specifier.split('/')[0]
}

function listJsFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listJsFiles(full))
    else if (entry.isFile() && /\.(?:m|c)?js$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 使用 TypeScript AST 精准提取静态 import / 动态 import() / require() / *.resolve() 的外部包名。 */
export function scanMainExternalImports(outMainDir) {
  const files = listJsFiles(outMainDir)
  if (files.length === 0) {
    throw new Error(`未找到构建产物目录或入口文件: ${outMainDir}`)
  }

  const packages = new Set()
  const recordSpecifier = (spec) => {
    const pkg = packageNameFromSpecifier(spec)
    if (pkg) packages.add(pkg)
  }

  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          recordSpecifier(node.moduleSpecifier.text)
        }
      } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
        const firstArg = node.arguments[0]
        if (ts.isStringLiteral(firstArg)) {
          const expr = node.expression
          const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword
          const isRequire = ts.isIdentifier(expr) && expr.text === 'require'
          const isModuleResolve =
            ts.isPropertyAccessExpression(expr) &&
            expr.name.text === 'resolve' &&
            ((ts.isMetaProperty(expr.expression) &&
              expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
              expr.expression.name.text === 'meta') ||
              (ts.isIdentifier(expr.expression) && expr.expression.text === 'require') ||
              (ts.isCallExpression(expr.expression) &&
                ts.isIdentifier(expr.expression.expression) &&
                expr.expression.expression.text === 'createRequire') ||
              (ts.isCallExpression(expr.expression) &&
                ts.isPropertyAccessExpression(expr.expression.expression) &&
                expr.expression.expression.name.text === 'createRequire'))
          if (isDynamicImport || isRequire || isModuleResolve) {
            recordSpecifier(firstArg.text)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return [...packages].sort()
}

function matchesExclusion(name, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
    return name === pattern
  })
}

function findPackageRootFromResolved(resolvedPath, expectedPackageName) {
  if (!resolvedPath || (!resolvedPath.includes('/') && !resolvedPath.includes('\\'))) {
    return null
  }
  let current = dirname(resolve(resolvedPath))
  while (true) {
    const pkgJsonPath = join(current, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        if (!expectedPackageName || parsed.name === expectedPackageName) {
          return { packageRoot: current, packageJsonPath, packageJson: parsed }
        }
      } catch {
        // 继续向上找合法包边界
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function resolvePackage(packageName, parentPackageJsonPath, projectRoot) {
  const resolverBases = parentPackageJsonPath ? [parentPackageJsonPath, join(projectRoot, 'package.json')] : [join(projectRoot, 'package.json')]
  const candidates = BUILTIN_SET.has(packageName) ? [`${packageName}/package.json`] : [`${packageName}/package.json`, packageName]
  for (const base of resolverBases) {
    const req = createRequire(base)
    for (const candidate of candidates) {
      try {
        const resolved = req.resolve(candidate)
        const found = findPackageRootFromResolved(resolved, packageName)
        if (found) return found
      } catch {
        // 某些包未导出 ./package.json 或无 "." 主入口，回落下方直接路径查找
      }
    }
  }

  let dir = resolve(parentPackageJsonPath ? dirname(parentPackageJsonPath) : projectRoot)
  const absProjectRoot = resolve(projectRoot)
  while (true) {
    const candidateRoot = join(dir, 'node_modules', packageName)
    const candidateJson = join(candidateRoot, 'package.json')
    if (existsSync(candidateJson)) {
      return {
        packageRoot: candidateRoot,
        packageJsonPath: candidateJson,
        packageJson: JSON.parse(readFileSync(candidateJson, 'utf8'))
      }
    }
    const parent = dirname(dir)
    if (parent === dir || dir === absProjectRoot) break
    dir = parent
  }
  return null
}

export function collectRuntimeClosure({ rootPackages, projectRoot, excludeOptional = [] }) {
  const absRoot = resolve(projectRoot)
  const visited = new Map()

  const visit = (pkgName, isOptional, parentJsonPath) => {
    if (matchesExclusion(pkgName, excludeOptional)) return

    const resolved = resolvePackage(pkgName, parentJsonPath, absRoot)
    if (!resolved) {
      if (isOptional) return
      throw new Error(`运行时闭包解析失败：找不到依赖 "${pkgName}"（父级：${parentJsonPath ?? 'projectRoot'}）`)
    }

    const realDir = realpathSync(resolved.packageRoot)
    if (visited.has(realDir)) return

    const relativeDir = relative(absRoot, resolved.packageRoot).replaceAll('\\', '/')
    if (relativeDir.startsWith('..')) {
      throw new Error(`依赖 "${pkgName}" 越界到仓库外 (${resolved.packageRoot})，无法安全打包`)
    }

    visited.set(realDir, {
      name: pkgName,
      version: String(resolved.packageJson.version ?? '0.0.0'),
      sourceDir: resolved.packageRoot,
      relativeDir
    })

    const deps = Object.keys(resolved.packageJson.dependencies ?? {}).sort()
    for (const dep of deps) visit(dep, false, resolved.packageJsonPath)

    const optDeps = Object.keys(resolved.packageJson.optionalDependencies ?? {}).sort()
    for (const dep of optDeps) visit(dep, true, resolved.packageJsonPath)
  }

  for (const rootPkg of [...new Set(rootPackages)].sort()) {
    visit(rootPkg, false, null)
  }

  return [...visited.values()].sort((a, b) => a.relativeDir.localeCompare(b.relativeDir))
}

function pruneStagedTree(rootDir, targetPlatformKey, nodeModulesDir = join(rootDir, 'node_modules')) {
  const [targetOs] = targetPlatformKey.split('-')
  const targetWinOrUnixOs = targetOs === 'win32' ? 'win32' : targetOs

  const piTuiNative = join(nodeModulesDir, '@earendil-works', 'pi-tui', 'native')
  if (existsSync(piTuiNative)) {
    for (const osEntry of readdirSync(piTuiNative, { withFileTypes: true })) {
      if (!osEntry.isDirectory()) continue
      const osDir = join(piTuiNative, osEntry.name)
      if (osEntry.name !== targetWinOrUnixOs) {
        rmSync(osDir, { recursive: true, force: true })
        continue
      }
      const prebuildsDir = join(osDir, 'prebuilds')
      if (existsSync(prebuildsDir)) {
        for (const archEntry of readdirSync(prebuildsDir, { withFileTypes: true })) {
          if (archEntry.isDirectory() && archEntry.name !== targetPlatformKey) {
            rmSync(join(prebuildsDir, archEntry.name), { recursive: true, force: true })
          }
        }
      }
    }
  }

  const dropDirNames = new Set(['__tests__', 'test', 'tests', 'example', 'examples'])
  const walkAndPrune = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (dropDirNames.has(entry.name)) {
          rmSync(full, { recursive: true, force: true })
        } else {
          walkAndPrune(full)
        }
        continue
      }
      if (!entry.isFile()) continue
      if (
        entry.name.endsWith('.map') ||
        entry.name.endsWith('.pdb') ||
        entry.name.endsWith('.tsbuildinfo') ||
        /^(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(?:\..+)?$/i.test(entry.name)
      ) {
        rmSync(full, { force: true })
      }
    }
  }
  walkAndPrune(rootDir)
}

/**
 * 构建隔离干净的 electron-builder app 暂存目录：
 * 只包含精简版 package.json、out/（无 .map）与经白名单计算的运行时 node_modules 闭包，
 * 从源头阻止 1.35GB 无关前端库及 devDependencies 进入打包流水线。
 */
export function stagePackagedAppDir({
  projectRoot,
  stagingAppDir,
  stagingNodeModulesDir,
  rootPackageJson,
  projectConfig,
  closure,
  targetPlatformKey
}) {
  rmSync(stagingAppDir, { recursive: true, force: true })
  mkdirSync(stagingAppDir, { recursive: true })
  const nodeModulesTarget = stagingNodeModulesDir ?? join(stagingAppDir, 'node_modules')
  rmSync(nodeModulesTarget, { recursive: true, force: true })
  mkdirSync(nodeModulesTarget, { recursive: true })

  // 复制 out/ 并清理 sourcemap
  const outSrc = join(projectRoot, 'out')
  const outDest = join(stagingAppDir, 'out')
  cpSync(outSrc, outDest, { recursive: true })

  // 写入精简只读 package.json 与空 package-lock.json，阻止 electron-builder 向上爬到仓库根 node_modules
  const minimalPkg = {
    name: projectConfig.debPackageName,
    productName: projectConfig.name,
    version: projectConfig.version,
    description: projectConfig.description,
    main: rootPackageJson.main ?? 'out/main/index.js',
    type: rootPackageJson.type ?? 'module',
    author: projectConfig.author,
    homepage: projectConfig.homepage,
    license: rootPackageJson.license ?? 'MIT'
  }
  ts.sys.writeFile(join(stagingAppDir, 'package.json'), `${JSON.stringify(minimalPkg, null, 2)}\n`)
  ts.sys.writeFile(
    join(stagingAppDir, 'package-lock.json'),
    `${JSON.stringify({ name: projectConfig.debPackageName, version: projectConfig.version, lockfileVersion: 3, requires: true, packages: { '': { name: projectConfig.debPackageName, version: projectConfig.version } } }, null, 2)}\n`
  )

  // 按相对路径精确复制闭包内的每个包（保留嵌套 node_modules 版本隔离）
  const stagingRootForModules = dirname(nodeModulesTarget)
  for (const item of closure) {
    const relFromNodeModules = item.relativeDir.replace(/^node_modules[\\/]/, '')
    const dest = join(nodeModulesTarget, relFromNodeModules)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(item.sourceDir, dest, { recursive: true, dereference: true })
  }

  pruneStagedTree(stagingAppDir, targetPlatformKey)
  pruneStagedTree(nodeModulesTarget, targetPlatformKey, nodeModulesTarget)
}

/** 打包后硬门禁：核查 unpacked 入口、关键原生/WASM 资产、禁用包零泄漏、自带 Node 完整。 */
export function verifyUnpackedBundle({
  resourcesDir,
  requiredExternalPackages,
  targetPlatformKey,
  runtimePlatformDir
}) {
  const unpackedDir = join(resourcesDir, 'app.asar.unpacked')
  const unpackedMainDir = join(unpackedDir, 'out', 'main')
  const unpackedNodeModules = join(unpackedDir, 'node_modules')

  const problems = []

  for (const entry of REQUIRED_MAIN_ENTRIES) {
    if (!existsSync(join(unpackedMainDir, entry))) {
      problems.push(`app.asar.unpacked/out/main 缺少入口: ${entry}`)
    }
  }

  for (const pkg of requiredExternalPackages) {
    const pkgJson = join(unpackedNodeModules, pkg, 'package.json')
    if (!existsSync(pkgJson)) {
      problems.push(`app.asar.unpacked/node_modules 缺少外部依赖: ${pkg}`)
    }
  }

  for (const relAsset of [
    'pdfjs-dist/cmaps',
    'pdfjs-dist/standard_fonts',
    'pdfjs-dist/wasm',
    'quickjs-wasi/quickjs.wasm',
    '@silvia-odwyer/photon-node/photon_rs_bg.wasm'
  ]) {
    if (!existsSync(join(unpackedNodeModules, relAsset))) {
      problems.push(`app.asar.unpacked/node_modules 缺少关键资产: ${relAsset}`)
    }
  }

  for (const forbidden of FORBIDDEN_RENDERER_AND_DEV_PACKAGES) {
    if (existsSync(join(unpackedNodeModules, forbidden))) {
      problems.push(`发现不应进入运行时的禁用包: ${forbidden}`)
    }
  }

  // 检查 pi-tui/native 只存在当前目标平台
  const piTuiNative = join(unpackedNodeModules, '@earendil-works', 'pi-tui', 'native')
  if (existsSync(piTuiNative)) {
    const expectedOs = targetPlatformKey.startsWith('win32') ? 'win32' : 'linux'
    for (const osEntry of readdirSync(piTuiNative, { withFileTypes: true })) {
      if (!osEntry.isDirectory()) continue
      if (osEntry.name !== expectedOs) {
        problems.push(`包含非目标平台原生目录: pi-tui/native/${osEntry.name}`)
      } else {
        const prebuildsDir = join(piTuiNative, osEntry.name, 'prebuilds')
        if (existsSync(prebuildsDir)) {
          for (const archEntry of readdirSync(prebuildsDir, { withFileTypes: true })) {
            if (archEntry.isDirectory() && archEntry.name !== targetPlatformKey) {
              problems.push(`包含非目标架构原生目录: pi-tui/native/${osEntry.name}/prebuilds/${archEntry.name}`)
            }
          }
        }
      }
    }
  }

  // 检查随包 Node 运行时
  if (runtimePlatformDir) {
    const binName = runtimePlatformDir.startsWith('win-') ? 'node.exe' : 'node'
    const nodeBin = join(resourcesDir, 'runtime', runtimePlatformDir, 'bin', binName)
    const runtimeManifest = join(resourcesDir, 'runtime', runtimePlatformDir, 'runtime.json')
    if (!existsSync(nodeBin) || statSync(nodeBin).size === 0) {
      problems.push(`缺少自带 Node 运行时二进制: ${nodeBin}`)
    }
    if (!existsSync(runtimeManifest)) {
      problems.push(`缺少自带 Node 清单: ${runtimeManifest}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`打包后产物审计失败:\n- ${problems.join('\n- ')}`)
  }
}
