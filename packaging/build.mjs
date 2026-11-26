#!/usr/bin/env node
/**
 * Cogent 工程化打包总控入口（单命令 `npm run pack`）。
 *
 * 设计要点（吸收 reference/zcode 与 im-2.0/pack 并避坑）：
 * 1. 单文件配置（packaging/pack.config.json）驱动全部目标与分项目组（id/name/icon）；
 * 2. 不修改仓库根目录 package.json 或图标目录（零工作区污染）；
 * 3. 在 tmp/pack-staging/<project>/app 组装精简构建舞台，仅携带 out/ 与白名单计算出的
 *    最小运行时闭包（彻底隔离前端已内联库与 devDependencies）；
 * 4. Windows 本机直打；Linux .deb 在 Linux 宿主机直打，或在 Windows 下经 WSL 原生盘打；
 * 5. afterPack 强制核验 unpacked 入口、WASM/PDF 资产、原生平台边界与自带 Node 22。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Arch, Platform, build as electronBuilderBuild } from 'electron-builder'
import { loadPackConfig, resolveSelectedProjects, validateProjectIcons } from './config-schema.mjs'
import {
  collectRuntimeClosure,
  scanMainExternalImports,
  stagePackagedAppDir,
  verifyUnpackedBundle
} from './runtime-closure.mjs'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'packaging', 'pack.config.json')

function log(message) {
  console.log(`[pack] ${message}`)
}

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const opts = {
    configPath: process.env.COGENT_PACKAGING_CONFIG || DEFAULT_CONFIG_PATH,
    projects: [],
    winOnly: false,
    debOnly: false,
    dirOnly: false,
    smoke: false,
    skipBuild: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config' && argv[i + 1]) opts.configPath = resolve(argv[++i])
    else if (arg === '--project' && argv[i + 1]) opts.projects.push(...argv[++i].split(',').filter(Boolean))
    else if (arg === '--win-only') opts.winOnly = true
    else if (arg === '--deb-only' || arg === '--linux-only') opts.debOnly = true
    else if (arg === '--dir-only') opts.dirOnly = true
    else if (arg === '--smoke') opts.smoke = true
    else if (arg === '--skip-build') opts.skipBuild = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node packaging/build.mjs [选项]

选项:
  --config <path>     指定配置文件（默认 packaging/pack.config.json）
  --project <keys>    覆盖配置中的 active 项目组（逗号分隔）
  --win-only          仅打包 Windows 目标
  --deb-only          仅打包 Linux .deb 目标
  --dir-only          仅产出解包目录（跳过安装器压缩，适合快速验证）
  --smoke             Windows 打包后自动运行冷启动隔离冒烟
  --skip-build        跳过 electron-vite build（仅限已有匹配 out/ 时使用）`)
      process.exit(0)
    } else {
      fail(`未知参数: ${arg}`)
    }
  }
  if (opts.winOnly && opts.debOnly) {
    fail('--win-only 与 --deb-only 不能同时指定')
  }
  return opts
}

function runSyncOrThrow(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  // Windows 下 npm/npx 是 .cmd 批处理：Node 22+ spawnSync 直接执行 .cmd 会报 EINVAL，走 cmd.exe /d /s /c 避坑
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  const result = useShell
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: true
      })
    : spawnSync(command, args, {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: true
      })
  if (result.error) fail(`执行失败 (${command}): ${result.error.message}`)
  if (result.status !== 0) fail(`命令退出码非 0 (${command} ${args.join(' ')}) -> ${result.status}`)
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function runtimePlatformKey(osName, archName) {
  if (osName === 'win32' && archName === 'x64') return 'win-x64'
  if (osName === 'linux' && archName === 'x64') return 'linux-x64'
  if (osName === 'linux' && archName === 'arm64') return 'linux-arm64'
  return null
}

function ensureRuntimeForTarget(osName, archName, nodeDistMirror) {
  const key = runtimePlatformKey(osName, archName)
  if (!key) {
    log(`提示：平台 ${osName}/${archName} 无自带 Node 22 预设（runtime.ts 将由 Electron 内置 Node 兜底）`)
    return null
  }
  log(`准备自带 Node 运行时: ${key}`)
  const env = { ...process.env }
  if (nodeDistMirror) env.NODE_DIST_MIRROR = nodeDistMirror
  runSyncOrThrow(process.execPath, [join(REPO_ROOT, 'scripts', 'fetch-runtime.mjs'), '--platform', osName, '--arch', archName], {
    env
  })
  return key
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function buildAppBundle(projectConfig) {
  log(`构建产物 (appName="${projectConfig.name}", storageDir="${projectConfig.storageDirName}")`)
  runSyncOrThrow(npmCommand(), ['run', 'build'], {
    env: {
      ...process.env,
      COGENT_APP_NAME: projectConfig.name,
      COGENT_STORAGE_DIR: projectConfig.storageDirName
    }
  })
}

function toElectronArch(archName) {
  if (archName === 'x64') return Arch.x64
  if (archName === 'arm64') return Arch.arm64
  fail(`不支持的架构: ${archName}`)
}

function createBuilderConfig({
  config,
  projectKey,
  projectConfig,
  stagingAppDir,
  stagingNodeModulesDir,
  outputDir,
  iconDirAbs,
  electronVersion,
  targetPlatformKey,
  runtimeDirKey,
  requiredExternalPackages,
  winFormats,
  linuxFormats,
  wslMode = false
}) {
  const extraResources = [
    {
      from: stagingNodeModulesDir,
      to: 'app.asar.unpacked/node_modules',
      filter: ['**/*']
    }
  ]
  if (runtimeDirKey) {
    const runtimeSrc = wslMode
      ? `resources/runtime/${runtimeDirKey}`
      : join(REPO_ROOT, 'resources', 'runtime', runtimeDirKey)
    extraResources.push({
      from: runtimeSrc,
      to: `runtime/${runtimeDirKey}`,
      filter: ['**/*']
    })
  }
  const iconsSrc = wslMode ? 'icons' : iconDirAbs
  extraResources.push(
    { from: join(iconsSrc, 'tray.png'), to: 'icons/tray.png' },
    { from: join(iconsSrc, 'icon.png'), to: 'icons/icon.png' }
  )
  if (!wslMode && existsSync(join(iconDirAbs, 'tray.ico'))) {
    extraResources.push({ from: join(iconDirAbs, 'tray.ico'), to: 'icons/tray.ico' })
    extraResources.push({ from: join(iconDirAbs, 'icon.ico'), to: 'icons/icon.ico' })
  }
  for (const extra of projectConfig.extraResources) {
    extraResources.push({
      from: resolve(REPO_ROOT, extra.from),
      to: extra.to,
      ...(extra.filter ? { filter: extra.filter } : {})
    })
  }

  const builderConfig = {
    appId: projectConfig.id,
    productName: projectConfig.name,
    electronVersion,
    asar: config.packaging.asar,
    compression: config.packaging.compression,
    electronLanguages: config.packaging.electronLanguages,
    npmRebuild: false,
    buildDependenciesFromSource: false,
    directories: {
      output: outputDir
    },
    files: ['out/**/*', 'package.json', '!node_modules/**'],
    asarUnpack: ['out/main/**/*'],
    extraResources,
    ...(config.mirrors.electron
      ? {
          electronDownload: {
            mirror: config.mirrors.electron
          }
        }
      : {}),
    win: {
      icon: join(iconsSrc, 'icon.ico'),
      target: winFormats.map((format) => ({ target: format, arch: [config.targets.windows.arch[0] ?? 'x64'] })),
      artifactName: `${projectConfig.executableName}-\${version}-win-\${arch}.\${ext}`,
      verifyUpdateCodeSignature: false,
      ...(projectConfig.nsis.signHookPath
        ? { signtoolOptions: { sign: resolve(REPO_ROOT, projectConfig.nsis.signHookPath) } }
        : {})
    },
    nsis: {
      oneClick: projectConfig.nsis.oneClick,
      perMachine: projectConfig.nsis.perMachine,
      allowToChangeInstallationDirectory: projectConfig.nsis.allowToChangeInstallationDirectory,
      createDesktopShortcut: projectConfig.nsis.createDesktopShortcut,
      createStartMenuShortcut: projectConfig.nsis.createStartMenuShortcut,
      shortcutName: projectConfig.name,
      installerIcon: join(iconsSrc, 'icon.ico'),
      uninstallerIcon: join(iconsSrc, 'icon.ico'),
      installerHeaderIcon: join(iconsSrc, 'icon.ico'),
      deleteAppDataOnUninstall: false
    },
    linux: {
      icon: join(iconsSrc, 'linux'),
      category: projectConfig.deb.category,
      executableName: projectConfig.executableName,
      maintainer: projectConfig.deb.maintainer,
      ...(projectConfig.deb.executableArgs.length > 0
        ? { executableArgs: projectConfig.deb.executableArgs }
        : {}),
      desktop: {
        entry: {
          Name: projectConfig.name,
          'Name[zh_CN]': projectConfig.name,
          StartupWMClass: projectConfig.executableName
        }
      },
      target: linuxFormats
    },
    deb: {
      packageName: projectConfig.debPackageName,
      packageCategory: projectConfig.deb.section,
      depends: projectConfig.deb.depends,
      artifactName: `${projectConfig.debPackageName}_\${version}_\${arch}.deb`,
      ...(projectConfig.deb.afterInstall
        ? { afterInstall: wslMode ? 'linux/after-install.sh' : resolve(REPO_ROOT, projectConfig.deb.afterInstall) }
        : {}),
      ...(projectConfig.deb.afterRemove
        ? { afterRemove: wslMode ? 'linux/after-remove.sh' : resolve(REPO_ROOT, projectConfig.deb.afterRemove) }
        : {})
    }
  }

  if (!wslMode) {
    builderConfig.afterPack = async (context) => {
      const resourcesDir = join(context.appOutDir, 'resources')
      log(`afterPack 审计 (${projectKey} / ${targetPlatformKey})`)
      verifyUnpackedBundle({
        resourcesDir,
        requiredExternalPackages,
        targetPlatformKey,
        runtimePlatformDir: runtimeDirKey ?? undefined
      })
    }
  }
  return builderConfig
}

function hasWslDistro() {
  if (process.platform !== 'win32') return false
  const probe = spawnSync('wsl.exe', ['bash', '-lc', 'echo __COGENT_WSL_OK__'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return probe.status === 0 && probe.stdout.includes('__COGENT_WSL_OK__')
}

function toWslPath(winPath) {
  const norm = resolve(winPath).replaceAll('\\', '/')
  const m = /^([A-Za-z]):\/(.*)$/.exec(norm)
  if (!m) fail(`无法转换路径为 WSL 路径: ${winPath}`)
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`
}

function shellQuote(val) {
  return `'${String(val).replaceAll("'", "'\\''")}'`
}

function runWsl(bashCmd) {
  const res = spawnSync('wsl.exe', ['bash', '-lc', bashCmd], { stdio: 'inherit' })
  if (res.error) fail(`WSL 执行失败: ${res.error.message}`)
  if (res.status !== 0) fail(`WSL 命令失败 (${res.status}): ${bashCmd}`)
}

function buildDebViaWsl({
  config,
  projectKey,
  projectConfig,
  archName,
  stagingRoot,
  outputDir,
  iconDirAbs,
  electronVersion,
  requiredExternalPackages,
  closure
}) {
  if (!hasWslDistro()) {
    fail(
      '配置要求构建 Linux .deb，但当前 Windows 未安装可用的 WSL Linux 分发版。\n' +
        '解决方式：\n' +
        '1. 执行 `wsl --install` 安装 Ubuntu 后再跑 `npm run pack`；\n' +
        '2. 仅打 Windows 包请跑 `npm run pack -- --win-only`；\n' +
        '3. 或在 Linux 机器 / GitHub Actions (ubuntu-latest) 中执行 `npm run pack -- --deb-only`。'
    )
  }

  const targetPlatformKey = `linux-${archName}`
  const runtimeDirKey = ensureRuntimeForTarget('linux', archName, config.mirrors.nodeDist)
  const wslStageDir = join(stagingRoot, `wsl-${targetPlatformKey}`)
  const wslAppDir = join(wslStageDir, 'app')
  const wslNodeModulesDir = join(wslStageDir, 'runtime-node_modules')
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

  stagePackagedAppDir({
    projectRoot: REPO_ROOT,
    stagingAppDir: wslAppDir,
    stagingNodeModulesDir: wslNodeModulesDir,
    rootPackageJson: rootPkg,
    projectConfig,
    closure,
    targetPlatformKey
  })

  cpSync(iconDirAbs, join(wslStageDir, 'icons'), { recursive: true })
  if (runtimeDirKey) {
    cpSync(join(REPO_ROOT, 'resources', 'runtime', runtimeDirKey), join(wslStageDir, 'resources', 'runtime', runtimeDirKey), {
      recursive: true
    })
  }
  mkdirSync(join(wslStageDir, 'linux'), { recursive: true })
  if (projectConfig.deb.afterInstall) {
    cpSync(resolve(REPO_ROOT, projectConfig.deb.afterInstall), join(wslStageDir, 'linux', 'after-install.sh'))
  }
  if (projectConfig.deb.afterRemove) {
    cpSync(resolve(REPO_ROOT, projectConfig.deb.afterRemove), join(wslStageDir, 'linux', 'after-remove.sh'))
  }

  const builderConfig = createBuilderConfig({
    config,
    projectKey,
    projectConfig,
    stagingAppDir: '.',
    stagingNodeModulesDir: '../runtime-node_modules',
    outputDir: '../out-deb',
    iconDirAbs,
    electronVersion,
    targetPlatformKey,
    runtimeDirKey,
    requiredExternalPackages,
    winFormats: [],
    linuxFormats: config.targets.linux.formats,
    wslMode: true
  })
  builderConfig.win.icon = '../icons/icon.ico'
  builderConfig.nsis.installerIcon = '../icons/icon.ico'
  builderConfig.nsis.uninstallerIcon = '../icons/icon.ico'
  builderConfig.nsis.installerHeaderIcon = '../icons/icon.ico'
  builderConfig.linux.icon = '../icons/linux'
  if (builderConfig.deb.afterInstall) builderConfig.deb.afterInstall = '../linux/after-install.sh'
  if (builderConfig.deb.afterRemove) builderConfig.deb.afterRemove = '../linux/after-remove.sh'
  builderConfig.extraResources = builderConfig.extraResources.map((item) => ({
    ...item,
    from: item.from.startsWith('..') ? item.from : `../${item.from}`
  }))
  writeFileSync(join(wslStageDir, 'builder.config.json'), `${JSON.stringify(builderConfig, null, 2)}\n`)

  const wslSrc = toWslPath(wslStageDir)
  const ws = config.wsl.workspace
  const cacheDir = config.wsl.builderCacheDir
  const outWsl = toWslPath(outputDir)

  log(`同步精简舞台到 WSL 原生磁盘: ${ws}`)
  runWsl(
    [
      `mkdir -p ${ws} ${cacheDir} ${shellQuote(outWsl)}`,
      `rsync -a --delete ${shellQuote(wslSrc + '/')} ${ws}/`,
      `chmod 755 ${ws}/resources/runtime/${runtimeDirKey}/bin/node ${ws}/linux/*.sh 2>/dev/null || true`,
      // ELF 魔数与可执行校验（借鉴 im-2.0/pack 9p 完整性门禁）
      `m=$(head -c 4 ${ws}/resources/runtime/${runtimeDirKey}/bin/node | od -An -tx1 | tr -d ' \\n')`,
      `test "$m" = "7f454c46" || { echo "WSL 同步后的 node ELF 魔数校验失败"; exit 1; }`,
      `if [ ! -x ${cacheDir}/node_modules/.bin/electron-builder ]; then npm --prefix ${cacheDir} install --no-save electron-builder@${readInstalledBuilderVersion()} electron@${electronVersion}; fi`,
      `cd ${ws}/app && ${cacheDir}/node_modules/.bin/electron-builder --linux ${config.targets.linux.formats.join(' ')} --${archName} --config ../builder.config.json`,
      `cp -f ${ws}/out-deb/*.deb ${shellQuote(outWsl + '/')}`
    ].join(' && ')
  )
}

function readInstalledBuilderVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', 'electron-builder', 'package.json'), 'utf8'))
  return pkg.version
}

function collectArtifacts(outputDir) {
  const results = []
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!/\.(?:exe|deb|zip)$/i.test(entry.name)) continue
    const full = join(outputDir, entry.name)
    const size = statSync(full).size
    const sha256 = sha256File(full)
    writeFileSync(`${full}.sha256`, `${sha256}  ${entry.name}\n`)
    results.push({ file: entry.name, bytes: size, sha256 })
  }
  return results
}

function gitHeadShort() {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true })
  return res.status === 0 ? res.stdout.trim() : 'unknown'
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const config = loadPackConfig(opts.configPath)
  const selectedProjects = resolveSelectedProjects(config, opts.projects)

  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const electronVersion = String(rootPkg.devDependencies?.electron ?? '').replace(/^[^0-9]*/, '')
  if (!electronVersion) fail('根 package.json 缺少 devDependencies.electron 版本')

  const doWindows = !opts.debOnly && config.targets.windows.formats.length > 0 && config.targets.windows.arch.length > 0
  const doLinux = !opts.winOnly && config.targets.linux.formats.length > 0 && config.targets.linux.arch.length > 0
  if (!doWindows && !doLinux) fail('当前没有启用的打包目标')

  for (const [projectKey, projectConfig] of selectedProjects) {
    log(`开始处理项目组 "${projectKey}" (name="${projectConfig.name}", id="${projectConfig.id}")`)
    const iconDirAbs = resolve(REPO_ROOT, projectConfig.iconDir)
    validateProjectIcons(iconDirAbs, { windows: doWindows, linux: doLinux })

    const outputDir = resolve(REPO_ROOT, config.outputDir, projectKey)
    const stagingRoot = join(tmpdir(), 'cogent-pack-staging', projectKey)
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(stagingRoot, { recursive: true, force: true })
    mkdirSync(outputDir, { recursive: true })

    if (!opts.skipBuild) {
      buildAppBundle(projectConfig)
    }

    const detectedExternal = scanMainExternalImports(join(REPO_ROOT, 'out', 'main'))
    const requiredRoots = [...new Set([...detectedExternal, ...config.packaging.extraExternalRoots])].sort()
    log(`主/引擎 external 根依赖 (${requiredRoots.length}): ${requiredRoots.join(', ')}`)

    const closure = collectRuntimeClosure({
      rootPackages: requiredRoots,
      projectRoot: REPO_ROOT,
      excludeOptional: config.packaging.excludeOptionalDeps
    })
    log(`运行时闭包收口完成: 共 ${closure.length} 个包（已排除前端内联库与 devDependencies）`)

    if (doWindows) {
      if (process.platform !== 'win32') {
        fail('Windows 目标需在 Windows 宿主机（或配备 Wine 的打包环境）中构建')
      }
      for (const archName of config.targets.windows.arch) {
        const targetPlatformKey = `win32-${archName}`
        const runtimeDirKey = ensureRuntimeForTarget('win32', archName, config.mirrors.nodeDist)
        const stagingAppDir = join(stagingRoot, targetPlatformKey, 'app')
        const stagingNodeModulesDir = join(stagingRoot, targetPlatformKey, 'runtime-node_modules')
        stagePackagedAppDir({
          projectRoot: REPO_ROOT,
          stagingAppDir,
          stagingNodeModulesDir,
          rootPackageJson: rootPkg,
          projectConfig,
          closure,
          targetPlatformKey
        })

        const formats = opts.dirOnly ? ['dir'] : config.targets.windows.formats
        const builderConfig = createBuilderConfig({
          config,
          projectKey,
          projectConfig,
          stagingAppDir,
          stagingNodeModulesDir,
          outputDir,
          iconDirAbs,
          electronVersion,
          targetPlatformKey,
          runtimeDirKey,
          requiredExternalPackages: requiredRoots,
          winFormats: formats,
          linuxFormats: []
        })

        log(`执行 Windows 打包 (${formats.join(',')} / ${archName})`)
        await electronBuilderBuild({
          projectDir: stagingAppDir,
          targets: Platform.WINDOWS.createTarget(formats, toElectronArch(archName)),
          config: builderConfig
        })

        if (opts.smoke) {
          const unpackedExe = join(outputDir, 'win-unpacked', `${projectConfig.name}.exe`)
          log(`启动 Windows 产物隔离冒烟: ${unpackedExe}`)
          runSyncOrThrow(process.execPath, [join(REPO_ROOT, 'packaging', 'smoke-packaged.mjs'), unpackedExe])
        }
      }
    }

    if (doLinux) {
      for (const archName of config.targets.linux.arch) {
        if (process.platform === 'linux') {
          const targetPlatformKey = `linux-${archName}`
          const runtimeDirKey = ensureRuntimeForTarget('linux', archName, config.mirrors.nodeDist)
          const stagingAppDir = join(stagingRoot, targetPlatformKey, 'app')
          const stagingNodeModulesDir = join(stagingRoot, targetPlatformKey, 'runtime-node_modules')
          stagePackagedAppDir({
            projectRoot: REPO_ROOT,
            stagingAppDir,
            stagingNodeModulesDir,
            rootPackageJson: rootPkg,
            projectConfig,
            closure,
            targetPlatformKey
          })
          const formats = opts.dirOnly ? ['dir'] : config.targets.linux.formats
          const builderConfig = createBuilderConfig({
            config,
            projectKey,
            projectConfig,
            stagingAppDir,
            stagingNodeModulesDir,
            outputDir,
            iconDirAbs,
            electronVersion,
            targetPlatformKey,
            runtimeDirKey,
            requiredExternalPackages: requiredRoots,
            winFormats: [],
            linuxFormats: formats
          })
          log(`执行 Linux 打包 (${formats.join(',')} / ${archName})`)
          await electronBuilderBuild({
            projectDir: stagingAppDir,
            targets: Platform.LINUX.createTarget(formats, toElectronArch(archName)),
            config: builderConfig
          })
        } else if (config.wsl.enabled) {
          buildDebViaWsl({
            config,
            projectKey,
            projectConfig,
            archName,
            stagingRoot,
            outputDir,
            iconDirAbs,
            electronVersion,
            requiredExternalPackages: requiredRoots,
            closure
          })
        } else {
          fail('当前非 Linux 宿主机且配置关闭了 wsl.enabled，无法打 .deb')
        }
      }
    }

    const artifacts = collectArtifacts(outputDir)
    const manifest = {
      projectKey,
      id: projectConfig.id,
      name: projectConfig.name,
      version: projectConfig.version,
      gitCommit: gitHeadShort(),
      builtAt: new Date().toISOString(),
      signed: Boolean(projectConfig.nsis.signHookPath),
      runtimeExternalRoots: requiredRoots,
      closurePackageCount: closure.length,
      artifacts
    }
    writeFileSync(join(outputDir, 'package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    log(`项目组 "${projectKey}" 出包完成 → ${outputDir}`)
  }
}

main().catch((error) => {
  console.error(`[pack] 失败: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
