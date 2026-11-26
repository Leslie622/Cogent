#!/usr/bin/env node
/**
 * 打包产物隔离冷启动冒烟：
 * - 在独立临时 COGENT_HOME + --user-data-dir 中拉起实际打包后的应用可执行文件；
 * - 校验主进程日志出现 Host ready，且使用随包自带的 resources/runtime Node（而非兜底 execPath）；
 * - 校验日志无 ERR_MODULE_NOT_FOUND / host start failed；
 * - 触发窗口优雅关闭并校验进程正常退出（code 0）且无残留。
 *
 * 用法：node packaging/smoke-packaged.mjs <可执行文件路径>
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exePath = process.argv[2] ? resolve(process.argv[2]) : ''
if (!exePath || !existsSync(exePath)) {
  console.error(`[smoke] 可执行文件不存在: ${exePath || '(未传参数)'}`)
  process.exit(1)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'cogent-packaged-smoke-'))
const homeDir = join(tempRoot, 'home')
const userDataDir = join(tempRoot, 'userdata')
mkdirSync(homeDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(
  join(homeDir, 'settings.json'),
  JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false })
)

const logs = []
let hostReadyLine = null
let preloadOkLine = null
let child = null

function forceKillTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
}

try {
  const env = {
    ...process.env,
    COGENT_HOME: homeDir,
    USERPROFILE: homeDir,
    HOME: homeDir,
    COGENT_SMOKE_EXIT_ON_READY: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.COGENT_NODE_BIN

  const args = [
    `--user-data-dir=${userDataDir}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
  ]
  child = spawn(exePath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  const collect = (chunk) => {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      logs.push(line)
      if (line.includes('[main] host ready')) hostReadyLine = line
      if (line.includes('[smoke] preload ok')) preloadOkLine = line
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error(`打包产物冒烟超时 (30s)\n日志:\n${logs.join('\n')}`)),
      30_000
    )
    child.once('error', (err) => {
      clearTimeout(timer)
      rejectExit(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })

  const fullLog = logs.join('\n')
  if (!hostReadyLine) {
    throw new Error(`未检测到 [main] host ready\n日志:\n${fullLog}`)
  }
  if (!/[\\/]runtime[\\/]/i.test(hostReadyLine)) {
    throw new Error(`Host 未使用随包自带 Node 运行时: ${hostReadyLine}`)
  }
  if (!preloadOkLine) {
    throw new Error(`未检测到 [smoke] preload ok\n日志:\n${fullLog}`)
  }
  if (/ERR_MODULE_NOT_FOUND|host start failed|Cannot find module|\[smoke\] failed/i.test(fullLog)) {
    throw new Error(`日志中出现运行时错误:\n${fullLog}`)
  }
  if (exitCode !== 0) {
    throw new Error(`应用退出码非 0: ${exitCode}\n日志:\n${fullLog}`)
  }

  console.log(JSON.stringify({ ok: true, exePath, hostReadyLine, preloadOkLine, exitCode }, null, 2))
} finally {
  if (child?.pid && child.exitCode === null) forceKillTree(child.pid)
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
