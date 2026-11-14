/**
 * PowerShell UTF-8 冒烟（阶段 1.3 改写：断言对象从自研 bash.ts 的命令包装
 * 换成 **pi 内置 powershell 工具** 的端到端行为）。
 *
 * 历史：原 tmp/cogent-smoke/ps-utf8-smoke.mjs → 2026-11-11 正名迁移（镜像自研
 * 包装常量）→ 1.3 工具切 pi 内置后自研包装删除（D6），本测试改为直接驱动
 * createPowerShellTool.execute —— UTF-8 前置 / #8842 尾缀等包装如今住在
 * pi 的 powershell.ts（Cogent 的旧实现本就是同源照抄），冒烟钉的是
 * 「本机 PowerShell 形态下 pi 工具可用且中文/退出码语义正确」。
 *
 * 双形态同跑（与旧版同思路）：默认解析（pi 的 getPowerShellConfig：pwsh
 * 优先 → 5.1 兜底）/ 强制 5.1（从 PATH 摘掉 pwsh 目录 —— pi 无 env 覆盖口，
 * PATH 是唯一外部开关）。仅 Windows（其余平台 skip）。
 *
 * 本机未装 pwsh 7 时默认解析也落在 powershell.exe 5.1，双 describe 结果一致
 * 属预期而非测试退化 —— 排查别往这引（沿用旧版批注）。
 */
// 深路径直连而非包根 import：pi-coding-agent@1.5.2 根入口连带其嵌套
// undici 8.12.3，后者模块初始化里的 createZstdDecompress.bind 在
// node <22.15（zlib 无 zstd，开发机 22.14）直接 TypeError —— 引擎侧
// 不受影响（esbuild 打包把 undici 摇掉，out/main/host.js 零命中），只有
// 本测试这种「vitest 进程内直接 import 包根」踩雷。dist/core/tools 子树
// 不引 undici；包 exports 未暴露此子路径，用相对路径绕过（版本已锁 1.5.2）
import { createPowerShellTool } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const IS_WIN = process.platform === 'win32'

/** 执行一条 PowerShell 命令，收整段输出与 error 位（pi 工具结果形状） */
const run = async (command: string): Promise<{ isError: boolean; output: string }> => {
  const tool = createPowerShellTool(tmpdir())
  const result = await tool.execute(`ps-utf8-${Math.random().toString(36).slice(2)}`, { command })
  const output = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
  return { isError: result.isError === true, output }
}

/** 各 shell 形态的断言组（forcePs51 = 从 PATH 摘掉 pwsh 逼解析落 5.1） */
const assertSuite = (describeName: string, forcePs51: boolean): void => {
  describe(describeName, { skip: !IS_WIN }, () => {
    const originalPath = process.env.PATH
    beforeAll(() => {
      if (forcePs51) {
        process.env.PATH = (originalPath ?? '')
          .split(';')
          .filter((entry) => !/pwsh/i.test(entry))
          .join(';')
      }
    })
    afterAll(() => {
      process.env.PATH = originalPath
    })

    it('中文往返 / 码页 65001 / #8842 / 失败非零', { timeout: 60_000 }, async () => {
      const zh = await run("Write-Output '中文往返-OK'")
      expect(zh.isError, `1. 中文往返非 error —— ${JSON.stringify(zh.output.slice(0, 80))}`).toBe(false)
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

      // 旧版第 6 项（反引号行尾的包装构造分支）不再保留：该分支只在包装
      // 构造层可观测（命令本身是 ParserError —— 反引号续行后无内容），
      // pi 侧由上游单测覆盖，Cogent 冒烟只钉可执行行为
    })
  })
}

assertSuite('pi powershell 工具（默认解析：pwsh 优先）', false)
assertSuite('pi powershell 工具（强制 Windows PowerShell 5.1：PATH 摘除 pwsh）', true)
