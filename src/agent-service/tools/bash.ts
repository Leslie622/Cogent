/**
 * bash 工具（exec 类，kind 'exec'）—— shell 命令执行（步骤 3.4）。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/core/tools/bash.ts
 * （MIT License, Copyright (c) 2025 Mario Zechner），进程管理在 shell.ts。
 *
 * D2 定稿（单工具路由）：模型侧工具名恒 `bash`，实际 shell 按平台路由 ——
 * Windows = PowerShell（系统必有；GUI 产品不能像上游 CLI 那样要求装 Git Bash），
 * unix = bash。方言差异靠 description 按平台声明让模型适配。Windows 命令
 * 经 UTF-8 输出前置 + PS 5.1 退出码尾缀包装（见 UTF8_OUTPUT_PREFIX 注释）。
 *
 * 输出护栏：stdout/stderr 合流进 OutputAccumulator（内存只留尾部滚动窗口，
 * 超限转存临时文件），快照走 truncateTail —— 命令输出的错误与最终结果都在
 * 末尾。流式 onUpdate（100ms 节流）经 pi 的 tool_execution_update 事件由
 * 转译层发 tool.progress（D5 定稿）。
 *
 * 生命周期：AbortSignal → killProcessTree 杀整树（孤儿进程教训：命令拉起的
 * 孙进程不随 shell 死，宿主侧 Electron 已踩过，引擎侧 taskkill /T 同样成立）；
 * timeout（秒，可选无默认）→ 同样杀树，exit code 语义照 shell 惯例
 * （128+信号号）。cwd = 会话基根（工作区主根 ?? 主目录）；命令本身不限界
 * —— shell 命令无法可靠静态分析（Claude Code 同口径），闸门在审批矩阵。
 */
import { constants } from 'node:fs'
import { access as fsAccess } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { int, obj, opt, str, type Static } from '@earendil-works/pi-schema'
import { OutputAccumulator } from './output-accumulator'
import {
  getPlatformShellConfig,
  killProcessTree,
  trackDetachedChildPid,
  untrackDetachedChildPid,
  waitForChildProcess,
  type ShellConfig
} from './shell'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from './truncate'

const MAX_TIMEOUT_MS = 2_147_483_647

/** onUpdate 节流（上游 renderers/bash.ts 同值）：命令输出可逐块到达，逐块转发会刷爆事件流 */
const UPDATE_THROTTLE_MS = 100

/**
 * Windows PowerShell 命令包装（上游 powershell.ts 原样照搬，搬运时曾遗漏、
 * 验收时中文 ping 输出乱码回补）：中文系统的控制台程序（ping/ipconfig 等）
 * 默认按 OEM 码页（GBK）写重定向管道，而 Node 侧按 UTF-8 解码 —— 前置
 * [Console]::OutputEncoding=UTF8 会把控制台输出码页一并切到 65001，子进程
 * 继承控制台后按 UTF-8 输出，PowerShell 自身文本输出同走 UTF-8。try/catch：
 * 无控制台句柄的精简环境不炸命令。
 */
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n'

/**
 * Windows PowerShell 5.1 会把重定向的原生 stderr 变成错误记录并置 $? = false，
 * 「命令本身成功但 stderr 有输出」被误报 exit 1（上游 #8842；pwsh 7 无此问题）。
 * 尾缀修正退出码：最后语句成功 → 0；仅因该类错误记录失败且原生命令退出 0 → 0；
 * 否则 1。行尾反引号（行继续符）会把尾缀续接进用户命令，此时不加。
 */
const WINDOWS_POWERSHELL_EXIT_SUFFIX =
  '\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1'

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('无效的 timeout：必须是正的有限秒数')
  }
  const timeoutMs = timeout * 1000
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`无效的 timeout：最大 ${MAX_TIMEOUT_MS / 1000} 秒`)
  }
  return timeoutMs
}

const parameters = obj({
  command: str({
    description: process.platform === 'win32' ? '要执行的 PowerShell 命令' : '要执行的 bash 命令'
  }),
  timeout: opt(int({ description: '超时秒数（可选；不设则一直等到命令结束）', minimum: 1 }))
})
type BashParams = Static<typeof parameters>

/** bash 的可插拔执行操作（D1 Operations 注入；默认本地 shell） */
export interface BashOperations {
  /**
   * 执行命令并流式回传输出；resolve 退出码。信号击杀按 128+信号号上报；
   * exitCode null 视为命令失败。aborted / timeout:N 以异常消息形态抛出
   *（与上游同协议，execute 层统一转结果）。
   */
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
    }
  ) => Promise<{ exitCode: number | null }>
}

/**
 * 本地 shell 执行后端：spawn + 超时杀树 + abort 杀树 + exit code 语义。
 * shell 配置每次执行时现解析（运行中系统状态可变，解析本身廉价）。
 */
export function createLocalShellOperations(): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const timeoutMs = resolveTimeoutMs(timeout)
      if (signal?.aborted) {
        throw new Error('aborted')
      }
      const shellConfig: ShellConfig = getPlatformShellConfig()
      try {
        await fsAccess(cwd, constants.F_OK)
      } catch {
        throw new Error(`工作目录不存在: ${cwd}`)
      }

      const commandFromStdin = shellConfig.commandTransport === 'stdin'
      // Windows：PowerShell 命令经 UTF-8 前置 + PS 5.1 退出码尾缀包装（见常量注释）；
      // pwsh 7 无 stderr 错误记录问题，只吃前缀
      let effectiveCommand = command
      if (process.platform === 'win32') {
        const suffix =
          basename(shellConfig.shell).toLowerCase() === 'powershell.exe' && !command.endsWith('`')
            ? WINDOWS_POWERSHELL_EXIT_SUFFIX
            : ''
        effectiveCommand = `${UTF8_OUTPUT_PREFIX}${command}${suffix}`
      }
      const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, effectiveCommand], {
        cwd,
        // unix 上 detached = 独立进程组（组杀的前提）；Windows 上组杀由 taskkill /T 承担
        detached: process.platform !== 'win32',
        stdio: [commandFromStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      if (commandFromStdin) {
        child.stdin?.on('error', () => {})
        child.stdin?.end(command)
      }
      if (child.pid) trackDetachedChildPid(child.pid)
      // 超时标记包对象：setTimeout 回调里的赋值不会重置 TS 对裸 let 的控制流
      // 收窄（裸 let 在检查点会被收窄成 false，属性访问则跨 await 保持 boolean）
      const timed = { hit: false }
      let timeoutHandle: NodeJS.Timeout | undefined
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid)
      }

      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timed.hit = true
            // shell 已退出也照样杀：unix 上组杀仍能到达攥着管道的后台进程
            //（Windows 上 shell pid 没了就找不到它们，尽力而为）
            if (child.pid) killProcessTree(child.pid)
          }, timeoutMs)
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
        const exitCode = await waitForChildProcess(child)
        if (signal?.aborted) {
          throw new Error('aborted')
        }
        // 被信号击杀的 shell 没有 exit code：按 shell 惯例 128+信号号，
        // 别让终止被误读为命令成功
        const signalCode = child.signalCode
        const signals = osConstants.signals as Record<string, number | undefined>
        const resolvedExitCode = exitCode ?? (signalCode ? 128 + (signals[signalCode] ?? 0) : 1)
        if (timed.hit) {
          throw new Error(`timeout:${timeout}`)
        }
        return { exitCode: resolvedExitCode }
      } finally {
        if (child.pid) untrackDetachedChildPid(child.pid)
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

/** （type 别名而非 interface：过 pi 转录 JsonValue 检查，同 TruncationResult 注） */
export type BashToolDetails = {
  truncation?: TruncationResult
  fullOutputPath?: string
  exitCode?: number
  wallTimeSeconds?: number
}

const IS_WINDOWS = process.platform === 'win32'

export function createBashTool(roots: string[], operations?: BashOperations): AgentTool {
  const ops = operations ?? createLocalShellOperations()
  const cwd = roots[0]
  const tool: AgentTool<typeof parameters> = {
    name: 'bash',
    label: '执行命令',
    description:
      (IS_WINDOWS
        ? '在 Windows PowerShell 里执行命令（注意用 PowerShell 语法）'
        : '在 bash 里执行命令') +
      `，工作目录 ${IS_WINDOWS ? '' : ''}是当前工作区。返回合并的 stdout/stderr，输出保留末尾 ${DEFAULT_MAX_LINES} 行 / ${DEFAULT_MAX_BYTES / 1024}KB（先到先停），超限全文存临时文件。可给 timeout 秒数。`,
    parameters,
    async execute(_toolCallId, p: BashParams, signal?, onUpdate?): Promise<AgentToolResult> {
      const output = new OutputAccumulator({ tempFilePrefix: 'cogent-bash' })
      let acceptingOutput = true
      let updateTimer: NodeJS.Timeout | undefined
      let updateDirty = false
      let lastUpdateAt = 0

      const emitOutputUpdate = () => {
        if (!onUpdate || updateDirty === false) return
        updateDirty = false
        lastUpdateAt = Date.now()
        const snapshot = output.snapshot({ persistIfTruncated: true })
        onUpdate({
          content: [{ type: 'text', text: snapshot.content || '' }],
          details: undefined
        })
      }

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer)
          updateTimer = undefined
        }
      }

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return
        updateDirty = true
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt)
        if (delay <= 0) {
          clearUpdateTimer()
          emitOutputUpdate()
          return
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined
          emitOutputUpdate()
        }, delay)
      }

      // 空首发：让 UI 的流式卡先立起来（"已启动、还没有输出"也是状态）
      if (onUpdate) {
        onUpdate({ content: [], details: undefined })
      }

      const handleData = (data: Buffer) => {
        if (!acceptingOutput) return
        output.append(data)
        scheduleOutputUpdate()
      }

      const finishOutput = async () => {
        acceptingOutput = false
        output.finish()
        clearUpdateTimer()
        emitOutputUpdate()
        const snapshot = output.snapshot({ persistIfTruncated: true })
        await output.closeTempFile()
        return snapshot
      }

      /** 快照 → 模型可见文本（截断时附尾部保留说明 + 全文路径） */
      const formatOutput = (
        snapshot: Awaited<ReturnType<typeof finishOutput>>,
        emptyText = '(无输出)'
      ): { text: string; details: BashToolDetails | undefined } => {
        const truncation = snapshot.truncation
        let text = snapshot.content || emptyText
        let details: BashToolDetails | undefined
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath }
          const startLine = truncation.totalLines - truncation.outputLines + 1
          const endLine = truncation.totalLines
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes())
            text += `\n\n[仅显示第 ${endLine} 行的末尾 ${formatSize(truncation.outputBytes)}（该行共 ${lastLineSize}）。全文: ${snapshot.fullOutputPath}]`
          } else if (truncation.truncatedBy === 'lines') {
            text += `\n\n[显示第 ${startLine}–${endLine} 行（共 ${truncation.totalLines} 行）。全文: ${snapshot.fullOutputPath}]`
          } else {
            text += `\n\n[显示第 ${startLine}–${endLine} 行（共 ${truncation.totalLines} 行，${formatSize(DEFAULT_MAX_BYTES)} 上限）。全文: ${snapshot.fullOutputPath}]`
          }
        }
        return { text, details }
      }

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ''}${status}`
      const startedAt = performance.now()

      try {
        let exitCode: number | null
        try {
          const result = await ops.exec(p.command, cwd, { onData: handleData, signal, timeout: p.timeout })
          exitCode = result.exitCode
        } catch (error) {
          // aborted / timeout / spawn 失败：已产出的输出照给模型（它需要看到
          // 命令死前做了什么），状态行说明死因
          const snapshot = await finishOutput()
          const { text } = formatOutput(snapshot, '')
          const message = (error as Error).message
          if (message === 'aborted') {
            return { content: [{ type: 'text', text: appendStatus(text, '命令已中止') }], details: null, isError: true }
          }
          if (message.startsWith('timeout:')) {
            const timeoutSecs = message.split(':')[1]
            return {
              content: [{ type: 'text', text: appendStatus(text, `命令在 ${timeoutSecs} 秒后超时（进程树已终止）`) }],
              details: null,
              isError: true
            }
          }
          return { content: [{ type: 'text', text: appendStatus(text, message) }], details: null, isError: true }
        }

        const snapshot = await finishOutput()
        const { text: outputText, details } = formatOutput(snapshot)
        if (exitCode === null) {
          return {
            content: [{ type: 'text', text: appendStatus(outputText, '命令终止且无退出码') }],
            details: null,
            isError: true
          }
        }
        const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10
        const fullDetails: BashToolDetails = { ...details, exitCode, wallTimeSeconds }
        if (exitCode !== 0) {
          return {
            content: [{ type: 'text', text: appendStatus(outputText, `命令退出码 ${exitCode}`) }],
            details: fullDetails,
            isError: true
          }
        }
        return { content: [{ type: 'text', text: outputText }], details: fullDetails }
      } finally {
        clearUpdateTimer()
      }
    }
  }
  return tool
}
