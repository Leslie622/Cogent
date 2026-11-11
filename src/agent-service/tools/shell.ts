/**
 * shell 执行基建（步骤 3.4）—— bash 工具的进程管理层。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/utils/shell.ts +
 * utils/child-process.ts（MIT License, Copyright (c) 2025 Mario Zechner）。
 * Cogent 化裁剪：去掉 cross-spawn 依赖（我们 spawn 的是解析到绝对路径的 shell
 * 本体，不经 .bat shebang 场景）、getShellEnv 的 pi bin 目录注入（无此物）、
 * WSL bash 识别与 sanitizeBinaryOutput（Windows 走 PowerShell 路线用不上）。
 *
 * 平台路由（D2 定稿：单工具，模型侧恒名 `bash`）：win32 → PowerShell
 * （pwsh 优先，Windows PowerShell 兜底 —— 系统必有，GUI 产品不能要求用户
 * 装 Git Bash）；unix → bash（/bin/bash → PATH → sh 兜底）。方言差异由工具
 * description 按平台声明，让模型适配。
 *
 * 孤儿进程教训（ Electron 宿主侧已踩过、引擎侧同样成立）：shell 的子进程
 * （命令拉起的孙进程）不随 shell 退出而死 —— killProcessTree 用 Windows
 * taskkill /T（进程树）或 Unix 进程组 SIGKILL 杀整树；detached 子进程登记
 * 进 trackedDetachedChildPids，引擎退出时统一清场。
 */

import { accessSync, constants as fsConstants } from 'node:fs'
import { join, win32 } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

export interface ShellConfig {
  shell: string
  args: string[]
  /** 命令经 argv 还是 stdin 传入（stdin 用于老 WSL bash 的 -s 形态） */
  commandTransport?: 'argv' | 'stdin'
}

function shellPathExists(path: string): boolean {
  try {
    // 不用 existsSync：Windows 上它的额外 stat 会拒绝可执行的 Store 别名
    //（nodejs/node#36790，上游同注）
    accessSync(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function findExecutableOnPath(executable: string): string | null {
  // Windows 用 where、unix 用 which；只信状态码 0 的首行
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = spawnSync(finder, [executable], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0]
      if (firstMatch) return firstMatch
    }
  } catch {
    // 查找器本身失败按"没找到"处理
  }
  return null
}

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Windows 的 PowerShell 解析：pwsh（7+）优先，Windows PowerShell 兜底 */
export function getPowerShellConfig(): ShellConfig {
  let shell = findExecutableOnPath('pwsh.exe')
  // 安装目录可能在任意盘符且不一定在 PATH
  const programFiles = process.env.ProgramFiles
  if (!shell && programFiles) {
    const pwsh7 = win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')
    if (shellPathExists(pwsh7)) shell = pwsh7
  }
  shell ??= findExecutableOnPath('powershell.exe')
  const systemRoot = process.env.SystemRoot
  if (!shell && systemRoot) {
    const windowsPowerShell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (shellPathExists(windowsPowerShell)) shell = windowsPowerShell
  }
  if (!shell) {
    throw new Error('未找到 PowerShell 可执行文件（pwsh.exe / powershell.exe）。')
  }
  return { shell, args: [...POWERSHELL_ARGS] }
}

/** unix 的 bash 解析：/bin/bash → PATH → sh 兜底 */
export function getBashShellConfig(): ShellConfig {
  if (shellPathExists('/bin/bash')) {
    return { shell: '/bin/bash', args: ['-c'] }
  }
  const bashOnPath = findExecutableOnPath('bash')
  if (bashOnPath) return { shell: bashOnPath, args: ['-c'] }
  return { shell: 'sh', args: ['-c'] }
}

/** D2 单工具路由：按平台给 shell 配置（模型侧工具名恒 bash） */
export function getPlatformShellConfig(): ShellConfig {
  return process.platform === 'win32' ? getPowerShellConfig() : getBashShellConfig()
}

/**
 * detached 子进程登记表：引擎退出时对全部登记 pid 杀树收尾
 * （宿主进程死了没人替我们杀 —— 收尾钩子在 agent-service/index.ts 接）
 */
const trackedDetachedChildPids = new Set<number>()

export function trackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.add(pid)
}

export function untrackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.delete(pid)
}

export function killTrackedDetachedChildren(): void {
  for (const pid of trackedDetachedChildPids) {
    killProcessTree(pid)
  }
  trackedDetachedChildPids.clear()
}

/** 杀掉进程及其全部子孙（跨平台） */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // 用可信的 System32 绝对路径：清场不依赖 PATH（上游同注）
    try {
      const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), [
        '/F',
        '/T',
        '/PID',
        String(pid)
      ], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      // 失败的 spawn 异步发 error 事件；吞掉避免炸 Node
      child.once('error', () => {})
    } catch {
      // taskkill 失败即失败（进程可能已死）
    }
  } else {
    // Unix：杀整个进程组；失败退化为杀单进程
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 进程已死
      }
    }
  }
}

/** exit 后管道空闲判定窗口：短命子进程 exit 时，detached 后代还攥着输出管道 */
const EXIT_STDIO_GRACE_MS = 100

/**
 * 等子进程终止，不在被继承的 stdio 句柄上挂死。
 *
 * 子进程 exit 后 detached 后代可能仍持有 stdout/stderr 管道在写 —— 固定
 * deadline 会丢还在写的尾部输出（earendil-works/pi#5303）。exit 后改为等
 * 管道空闲：每来一块数据重置宽限计时器（活跃写手让我们继续读），安静的
 * 被继承句柄（如 Windows 守护化的后代永远不发 close）在宽限期后放行。
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let postExitTimer: NodeJS.Timeout | undefined
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer)
        postExitTimer = undefined
      }
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('end', onStdoutEnd)
      child.stderr?.removeListener('end', onStderrEnd)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
    }

    const finalize = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(code)
    }

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode)
      }
    }

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer)
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS)
    }

    const onData = () => {
      // exit 后仍有输出到达：推迟定稿，不在写一半时销毁管道截掉尾部
      if (exited && !settled) armIdleTimer()
    }

    const onStdoutEnd = () => {
      stdoutEnded = true
      maybeFinalizeAfterExit()
    }
    const onStderrEnd = () => {
      stderrEnded = true
      maybeFinalizeAfterExit()
    }

    const onError = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onExit = (code: number | null) => {
      exited = true
      exitCode = code
      maybeFinalizeAfterExit()
      if (!settled) {
        armIdleTimer()
      }
    }

    const onClose = (code: number | null) => {
      finalize(code)
    }

    child.stdout?.once('end', onStdoutEnd)
    child.stderr?.once('end', onStderrEnd)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
  })
}
