/**
 * PowerShell UTF-8 冒烟 —— 断言对象 = **pi 内置 powershell 工具**的端到端
 * 行为：直接驱动 createPowerShellTool.execute，UTF-8 前置 / #8842 尾缀等
 * 包装住在 pi 的 powershell.ts。冒烟钉的是「本机 PowerShell 形态下 pi
 * 工具可用且中文/退出码语义正确」。
 *
 * 分别运行 PowerShell 7 与 Windows PowerShell 5.1，在工具内确认版本与可执行文件。
 * 机器缺少 PowerShell 7 时只执行 5.1，不把同一 shell 算作两份覆盖。
 */
// 深路径直连而非包根 import：pi-coding-agent@1.5.2 根入口连带其嵌套
// undici 8.12.3，后者模块初始化里的 createZstdDecompress.bind 在
// node <22.15（zlib 无 zstd，开发机 22.14）直接 TypeError —— 引擎侧
// 不受影响（esbuild 打包把 undici 摇掉，out/main/host.js 零命中），只有
// 本测试这种「vitest 进程内直接 import 包根」踩雷。dist/core/tools 子树
// 不引 undici；包 exports 未暴露此子路径，用相对路径绕过（版本已锁 1.5.2）
import { createPowerShellTool } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js'
import { getPowerShellConfig } from '../../node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'

const IS_WIN = process.platform === 'win32'
const hasPwsh = IS_WIN && basename(getPowerShellConfig().shell).toLowerCase() === 'pwsh.exe'

/** 执行一条 PowerShell 命令，收整段输出与 error 位（pi 工具结果形状） */
const run = async (command: string): Promise<{ isError: boolean; output: string }> => {
  const tool = createPowerShellTool(tmpdir())
  const result = await tool.execute(`ps-utf8-${Math.random().toString(36).slice(2)}`, { command })
  const output = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
  return { isError: result.isError === true, output }
}

async function verifyBehavior(identity: RegExp): Promise<void> {
  const zh = await run("Write-Output ('Shell={0}:{1}' -f (Split-Path -Leaf (Get-Process -Id $PID).Path), $PSVersionTable.PSVersion); Write-Output '中文往返-OK'")
  expect(zh.isError, `1. 中文往返非 error —— ${JSON.stringify(zh.output.slice(0, 80))}`).toBe(false)
  expect(zh.output).toMatch(identity)
  expect(
    zh.output.includes('中文往返-OK'),
    `1b. 纯 PowerShell 中文输出不炸码（UTF-8 前置覆盖自身文本输出）—— ${JSON.stringify(zh.output.slice(0, 80))}`
  ).toBe(true)

  const ping = await run('ping -n 2 127.0.0.1')
  expect(
    ping.output.length > 0 && !ping.output.includes('�') && ping.output.includes('127.0.0.1'),
    `2. 原生控制台程序无 U+FFFD（GBK 中文经码页 65001 出，Node 按 UTF-8 解码不炸）—— ${JSON.stringify(ping.output.slice(0, 120))}`
  ).toBe(true)

  const stderrCase = await run('cmd /c "echo stdout-line & echo stderr-line 1>&2"')
  expect(
    !stderrCase.isError && stderrCase.output.includes('stderr-line'),
    `3. #8842 stderr 噪音不误报（命令成功仅 stderr 有输出 → 0；5.1 靠尾缀修正）—— error=${stderrCase.isError} ${JSON.stringify(stderrCase.output.slice(0, 120))}`
  ).toBe(true)

  const failCase = await run('cmd /c "exit 3"')
  expect(
    failCase.isError && /Command exited with code \d+/.test(failCase.output),
    `4. 失败语句非零（pi 语义：非零退出码 = error 结果带 code；5.1 的尾缀把真实码压成 1、pwsh 透传 3 —— 只断非零形态，与旧版口径一致）—— ${JSON.stringify(failCase.output.slice(0, 120))}`
  ).toBe(true)
}

it.skipIf(!hasPwsh)('PowerShell 7：实测身份、中文和原生命令退出语义', { timeout: 60_000 }, async () => {
  await verifyBehavior(/Shell=pwsh\.exe:7\./i)
})

it.skipIf(!IS_WIN)('Windows PowerShell 5.1：实测身份、中文和原生命令退出语义', { timeout: 60_000 }, async () => {
  // pi 同时探测 PATH 和 ProgramFiles 中的默认安装位置。
  const withoutPwsh = (process.env.PATH ?? '').split(';')
    .filter((entry) => !existsSync(join(entry.replace(/^"|"$/g, ''), 'pwsh.exe')))
    .join(';')
  vi.stubEnv('PATH', withoutPwsh)
  vi.stubEnv('ProgramFiles', undefined)
  try {
    await verifyBehavior(/Shell=powershell\.exe:5\.1\./i)
  } finally {
    vi.unstubAllEnvs()
  }
})
