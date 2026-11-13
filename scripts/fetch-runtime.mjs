#!/usr/bin/env node
/**
 * 构建期自带 Node 运行时下载（全局架构 D11）—— 官方 Node 22 放进
 * resources/runtime/<平台>/，运行时由 main 侧 runtime.ts 三级链消费。
 *
 * 为什么必须自带：Electron 31 内置 Node 20.15 < pi 的 engines >= 22.19，
 * 自带官方 node 22 是引擎进程的唯一通路；git/python 不随包（系统提供）。
 *
 * 纪律照 Pi-meme scripts/node-runtime.mts：官方 SHASUMS256.txt 抽期望值 →
 * 本地 sha256 比对 → 系统 tar 解压（win10+ 自带 bsdtar 可解 zip）→ 只拷
 * 可执行文件 + LICENSE（引擎不需要 npm/corepack，node_modules 在应用侧）→
 * 落 runtime.json 诊断清单。幂等：目标已存在即跳过，--force 重下。
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
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** pin 精确版本：升级只改这里（前提：仍满足 pi engines >= 22.19） */
const NODE_VERSION = '22.23.5'
const MIRROR = process.env.NODE_DIST_MIRROR ?? 'https://nodejs.org/dist'
const FORCE = process.argv.includes('--force')
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..')

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

const dir = platformDir(process.platform, process.arch)
const windows = process.platform === 'win32'
const destination = path.join(repoRoot, 'resources', 'runtime', dir)
const executable = path.join(destination, 'bin', windows ? 'node.exe' : 'node')

if (existsSync(executable) && !FORCE) {
  console.log(`自带 Node 已就位，跳过（--force 重下）：${path.relative(repoRoot, executable)}`)
  process.exit(0)
}

// 临时目录解包，校验通过才写进 resources —— 中断/失败不留半成品在目标位置
const scratch = await mkdtemp(path.join(tmpdir(), 'cogent-runtime-'))
try {
  const distribution = `node-v${NODE_VERSION}-${windows ? 'win' : 'linux'}-${process.arch}`
  const archiveName = `${distribution}.${windows ? 'zip' : 'tar.gz'}`
  const base = `${MIRROR}/v${NODE_VERSION}`
  const archive = path.join(scratch, archiveName)

  await download(`${base}/SHASUMS256.txt`, path.join(scratch, 'SHASUMS256.txt'))
  await download(`${base}/${archiveName}`, archive)

  const expected = (await readFile(path.join(scratch, 'SHASUMS256.txt'), 'utf8'))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0]
  if (!expected || !/^[a-f\d]{64}$/.test(expected)) {
    throw new Error(`官方校验清单缺少 ${archiveName} —— 版本号或镜像源有误？`)
  }
  const actual = await sha256(archive)
  if (actual !== expected) {
    throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`)
  }

  // win 上显式用系统自带 bsdtar（System32\tar.exe，win10 1809+ 标配，可解 zip）：
  // PATH 里可能排在前的是 Git Bash 的 MSYS GNU tar，它把 "C:\..." 当 host:path
  // 远程语法，报 "Cannot connect to C: resolve failed"
  const tarBin =
    process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tarBin, ['-xf', archive, '-C', scratch], { windowsHide: true })
  await mkdir(path.dirname(executable), { recursive: true })
  await copyFile(path.join(scratch, distribution, windows ? 'node.exe' : 'bin/node'), executable)
  if (!windows) await chmod(executable, 0o755)
  await copyFile(path.join(scratch, distribution, 'LICENSE'), path.join(destination, 'LICENSE'))
  await writeFile(
    path.join(destination, 'runtime.json'),
    JSON.stringify(
      { nodeVersion: NODE_VERSION, platform: process.platform, arch: process.arch, archive: archiveName, sha256: expected },
      null,
      2
    )
  )
  console.log(`自带 Node ${NODE_VERSION} 就位：${path.relative(repoRoot, executable)}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
