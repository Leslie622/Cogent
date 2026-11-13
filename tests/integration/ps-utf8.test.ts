/**
 * PowerShell UTF-8 包装集成测试 —— 原 tmp/cogent-smoke/ps-utf8-smoke.mjs
 * 正名迁移（2026-11-11 批次 3 验收修复；断言原样，载体换 Vitest，D6）。
 *
 * 复刻 bash.ts 的调用路径本机真跑（不走引擎 —— 针对性回归命令包装层）：
 * spawn(PowerShell, [-NoProfile -NonInteractive -ExecutionPolicy Bypass
 * -Command <包装后命令>])，stdout/stderr 合流按 UTF-8 解码。包装规则照搬
 * src/host/tools/bash.ts（该文件改包装时本测试必须同步）：
 *  - UTF8_OUTPUT_PREFIX 恒前置（中文控制台程序 GBK → 码页 65001）；
 *  - WINDOWS_POWERSHELL_EXIT_SUFFIX 仅 powershell.exe（PS 5.1）且命令不以
 *    反引号结尾时尾缀（#8842 stderr 错误记录误报修正）。
 *
 * 两种形态同跑（默认解析 pwsh 优先 / --ps51 强制 5.1 由原脚本提供，测试里
 * 以双 describe 表达）：各 6 项断言。仅 Windows（其余平台 skip）。
 *
 * 本机未装 pwsh 7 时（两台开发机均如此）默认解析也落在 powershell.exe 5.1，
 * 双 describe 结果一致属预期而非测试退化 —— 排查别往这引。
 */
import { spawn, execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { basename, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'

const IS_WIN = process.platform === 'win32'

// ———— 照搬 bash.ts 的包装常量（同步纪律见头注） ————
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n'
const WINDOWS_POWERSHELL_EXIT_SUFFIX =
  '\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1'

/** 照搬 bash.ts 的包装分支（唯一的源码镜像点） */
const buildCommand = (shellPath: string, command: string): string => {
  const suffix =
    basename(shellPath).toLowerCase() === 'powershell.exe' && !command.endsWith('`') ? WINDOWS_POWERSHELL_EXIT_SUFFIX : ''
  return `${UTF8_OUTPUT_PREFIX}${command}${suffix}`
}

// ———— 照搬 shell.ts 的 PowerShell 解析（pwsh 优先 → 5.1 兜底） ————
const exists = (p: string): boolean => {
  try {
    accessSync(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
const whereFirstSync = (exe: string): string | null => {
  try {
    const out = execFileSync('where', [exe], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    const first = out.trim().split(/\r?\n/)[0]
    return first || null
  } catch {
    return null
  }
}

function resolveShell(forcePs51: boolean): string {
  if (forcePs51) {
    const systemRoot = process.env.SystemRoot
    const ps51 = win32.join(systemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (!exists(ps51)) throw new Error(`未找到 Windows PowerShell 5.1: ${ps51}`)
    return ps51
  }
  let shell = whereFirstSync('pwsh.exe')
  const programFiles = process.env.ProgramFiles
  if (!shell && programFiles !== undefined) {
    const pwsh7 = win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')
    if (exists(pwsh7)) shell = pwsh7
  }
  shell ??= whereFirstSync('powershell.exe')
  const systemRoot = process.env.SystemRoot
  if (!shell && systemRoot !== undefined) {
    const fallback = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(fallback)) shell = fallback
  }
  if (!shell) throw new Error('未找到 PowerShell（pwsh.exe / powershell.exe）')
  return shell
}

// ———— 复刻 bash.ts 的执行路径：argv 传输 + 合流 + UTF-8 解码 ————
const run = (shell: string, command: string): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    const effective = buildCommand(shell, command)
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', effective], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => chunks.push(d))
    child.on('exit', (code) => resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString('utf-8') }))
    child.on('error', (e) => resolve({ code: 1, output: String(e) }))
  })

/** 各 shell 形态的 6 项断言（原脚本默认跑法，--ps51 变体并列） */
const assertSix = (describeName: string, forcePs51: boolean): void => {
  describe(describeName, { skip: !IS_WIN }, () => {
    const SHELL = resolveShell(forcePs51)
    const SHELL_IS_51 = basename(SHELL).toLowerCase() === 'powershell.exe'

    it('6 项断言（中文往返 / 码页 65001 / 退出码 / #8842 / 失败非零 / 包装构造分支）', { timeout: 60_000 }, async () => {
      const zh = await run(SHELL, "Write-Output '中文往返-OK'")
      expect(zh.output.includes('中文往返-OK'), `1. 纯 PowerShell 中文往返（UTF-8 前置覆盖自身文本输出）—— ${JSON.stringify(zh.output.slice(0, 80))}`).toBe(true)

      const ping = await run(SHELL, 'ping -n 2 127.0.0.1')
      expect(
        ping.output.length > 0 && !ping.output.includes('�') && ping.output.includes('127.0.0.1'),
        `2. 原生控制台程序无 U+FFFD（GBK 中文经码页 65001 出，Node 按 UTF-8 解码不炸）—— ${JSON.stringify(ping.output.slice(0, 120))}`
      ).toBe(true)

      expect(zh.code === 0, `3. 成功语句退 0 —— exit=${zh.code}`).toBe(true)

      const stderrCase = await run(SHELL, 'cmd /c "echo stdout-line & echo stderr-line 1>&2"')
      expect(
        stderrCase.code === 0 && stderrCase.output.includes('stderr-line'),
        `4. #8842 stderr 噪音不误报（命令成功仅 stderr 有输出 → 0；5.1 靠尾缀修正）—— exit=${stderrCase.code} ${JSON.stringify(stderrCase.output.slice(0, 120))}`
      ).toBe(true)

      const failCase = await run(SHELL, 'cmd /c "exit 3"')
      expect(failCase.code !== 0, `5. 失败语句非零（5.1 尾缀压成 1 仍非零，pwsh 透传 3）—— exit=${failCase.code}`).toBe(true)

      const plain = buildCommand(SHELL, 'Get-Date')
      const backtick = buildCommand(SHELL, 'Write-Output a `')
      expect(
        plain.startsWith(UTF8_OUTPUT_PREFIX) &&
          (SHELL_IS_51 ? plain.includes('if ($?)') : !plain.includes('if ($?)')) &&
          !backtick.includes('if ($?)'),
        `6. 包装构造分支（前缀恒在；尾缀仅 5.1 且反引号行尾豁免）—— ${plain.slice(0, 60)}`
      ).toBe(true)
    })
  })
}

assertSix('PowerShell UTF-8 包装（默认解析：pwsh 优先）', false)
assertSix('PowerShell UTF-8 包装（强制 Windows PowerShell 5.1：尾缀生效）', true)
