#!/usr/bin/env node
/**
 * 构建期自带 Node 运行时下载（全局架构 D11）—— 官方 Node 22 放进
 * resources/runtime/<平台>/，运行时由 main 侧 runtime.ts 三级链消费。
 *
 * 自带官方 Node 22 让引擎版本独立于 Electron，并满足 pi 的 engines >= 22.19；
 * Electron 自带 Node 仅作兜底，git/python 不随包（系统提供）。
 *
 * 纪律照 Pi-meme scripts/node-runtime.mts：官方 SHASUMS256.txt 抽期望值 →
 * 本地 sha256 比对 → 系统 tar 解压（win10+ 自带 bsdtar 可解 zip）→ 只拷
 * 可执行文件 + LICENSE（引擎不需要 npm/corepack，node_modules 在应用侧）→
 * 最后发布 runtime.json。清单与已安装二进制、许可证校验一致才跳过，--force 重下。
 *
 * 布局契约：可执行文件统一放 <平台>/bin/ 下（win zip 归档根的 node.exe 挪进
 * bin/，全平台同构）—— runtime.ts bundledNodeBin 按此布局解析，runtime.test.ts
 * 的「真实布局契约」用例在 fetch 过的机器上强校验两侧一致。
 *
 * 网络：默认官方源，国内可 NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node
 * 覆盖（只换前缀，目录结构同构）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** pin 精确版本：升级只改这里（前提：仍满足 pi engines >= 22.19） */
const NODE_VERSION = '22.23.5'
const MIRROR = process.env.NODE_DIST_MIRROR ?? 'https://nodejs.org/dist'
const FORCE = process.argv.includes('--force')
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..')

function readFlag(name) {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  const prefix = `${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const targetPlatform = readFlag('--platform') ?? process.platform
const targetArch = readFlag('--arch') ?? process.arch

/** 平台 → node 官方归档名片段；与 runtime.ts 的 bundledPlatformDir 目录名对齐 */
function platformDir(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  console.error(`不支持的平台组合：${platform}/${arch}（目标 = win-x64 / linux-x64 / linux-arm64）`)
  process.exit(1)
}

async function download(url, file) {
  // redirect: follow —— 镜像源（npmmirror）靠 302 跳 CDN 工作，属正常路径；
  // 下载完整性不靠重定向策略把关，靠下方 SHA256 对官方 SHASUMS256.txt 校验
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`)
  const buffer = new Uint8Array(await response.arrayBuffer())
  await writeFile(file, buffer)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const dir = platformDir(targetPlatform, targetArch)
const windowsTarget = targetPlatform === 'win32'
const windowsHost = process.platform === 'win32'
const destination = path.join(repoRoot, 'resources', 'runtime', dir)
const executableName = windowsTarget ? 'node.exe' : 'node'
const executable = path.join(destination, 'bin', executableName)
const license = path.join(destination, 'LICENSE')
const manifest = path.join(destination, 'runtime.json')
const distribution = `node-v${NODE_VERSION}-${windowsTarget ? 'win' : 'linux'}-${targetArch}`
const archiveName = `${distribution}.${windowsTarget ? 'zip' : 'tar.gz'}`
const sha256Pattern = /^[a-f\d]{64}$/

async function installationComplete() {
  try {
    const installed = JSON.parse(await readFile(manifest, 'utf8'))
    if (installed === null || installed.nodeVersion !== NODE_VERSION ||
        installed.platform !== targetPlatform || installed.arch !== targetArch ||
        installed.archive !== archiveName || !sha256Pattern.test(installed.sha256)) return false
    const [exeInfo, licenseInfo] = await Promise.all([stat(executable), stat(license)])
    if (!exeInfo.isFile() || exeInfo.size === 0 || !licenseInfo.isFile() || licenseInfo.size === 0 ||
        (!windowsHost && !windowsTarget && (exeInfo.mode & 0o111) === 0)) return false
    const [executableHash, licenseHash] = await Promise.all([sha256(executable), sha256(license)])
    return executableHash === installed.executableSha256 && licenseHash === installed.licenseSha256
  } catch (error) {
    // 清单缺失或损坏可重新安装；路径权限等其他错误保留诊断。
    if (error instanceof SyntaxError || error.code === 'ENOENT' || error.code === 'EISDIR') return false
    throw error
  }
}

if (!FORCE && await installationComplete()) {
  console.log(`自带 Node 已就位，跳过（--force 重下）：${path.relative(repoRoot, executable)}`)
  process.exit(0)
}

// 下载与解压期间，原安装目录保持可用。逐项替换时先移除旧清单，最后提交新清单。
const scratch = await mkdtemp(path.join(tmpdir(), 'cogent-runtime-'))
try {
  const base = `${MIRROR}/v${NODE_VERSION}`
  const archive = path.join(scratch, archiveName)

  await download(`${base}/SHASUMS256.txt`, path.join(scratch, 'SHASUMS256.txt'))
  await download(`${base}/${archiveName}`, archive)

  const expected = (await readFile(path.join(scratch, 'SHASUMS256.txt'), 'utf8'))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0]
  if (!expected || !sha256Pattern.test(expected)) {
    throw new Error(`官方校验清单缺少 ${archiveName} —— 版本号或镜像源有误？`)
  }
  const actual = await sha256(archive)
  if (actual !== expected) {
    throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`)
  }

  // win 上显式用系统自带 bsdtar（System32\tar.exe，win10 1809+ 标配，可解 zip 与 tar.gz）：
  // PATH 里可能排在前的是 Git Bash 的 MSYS GNU tar，它把 "C:\..." 当 host:path
  // 远程语法，报 "Cannot connect to C: resolve failed"
  const tarBin =
    windowsHost ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tarBin, ['-xf', archive, '-C', scratch], { windowsHide: true })
  const runtimeParent = path.dirname(destination)
  await mkdir(runtimeParent, { recursive: true })
  const staging = await mkdtemp(path.join(runtimeParent, '.node-runtime-'))
  try {
    const stagedExecutable = path.join(staging, executableName)
    const stagedLicense = path.join(staging, 'LICENSE')
    const stagedManifest = path.join(staging, 'runtime.json')
    await copyFile(path.join(scratch, distribution, windowsTarget ? 'node.exe' : 'bin/node'), stagedExecutable)
    if (!windowsHost && !windowsTarget) await chmod(stagedExecutable, 0o755)
    await copyFile(path.join(scratch, distribution, 'LICENSE'), stagedLicense)
    const [executableSha256, licenseSha256] = await Promise.all([sha256(stagedExecutable), sha256(stagedLicense)])
    await writeFile(stagedManifest, JSON.stringify({
      nodeVersion: NODE_VERSION, platform: targetPlatform, arch: targetArch,
      archive: archiveName, sha256: expected, executableSha256, licenseSha256
    }, null, 2))
    await mkdir(path.dirname(executable), { recursive: true })
    await rm(manifest, { force: true })
    await rename(stagedExecutable, executable)
    await rename(stagedLicense, license)
    await rename(stagedManifest, manifest)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  console.log(`自带 Node ${NODE_VERSION} 就位：${path.relative(repoRoot, executable)}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
