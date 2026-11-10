/**
 * read 工具（只读，kind 'read'）—— 读单个文本文件，带行号输出（cat -n 风格）。
 *
 * 设计取舍：
 * - 带行号：模型后续引用行号（edit 工具的定位语义），Claude Code Read 同款；
 * - 行数/字节双上限（计划 D8）：工具结果进模型上下文，不设上限一次读穿窗口；
 *   截断时附提示行，模型知道还有余量、可用 offset 分段读；
 * - 二进制文件（含 \0）拒绝而非乱码回灌 —— 乱码既浪费 token 又误导模型。
 *
 * roots 经工厂闭包注入（边界判定需要工作区根，见 path.ts）；pi 的 AgentTool
 * 是声明 + execute，工具实例不持有全局状态，每会话按 roots 现建。
 */
import { readFile, stat } from 'node:fs/promises'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { obj, opt, int, str, type Static } from '@earendil-works/pi-schema'
import { resolveAgainstBase } from './path'

/** 读取上限：行数 2000（Claude Code 同款）且 64KB 字符，先到先停 */
const MAX_LINES = 2000
const MAX_CHARS = 64_000

const parameters = obj({
  path: str({ description: '要读的文件路径（相对工作区主根或绝对路径）' }),
  offset: opt(int({ description: '起始行号（1 起；省略从第 1 行）', minimum: 1 })),
  limit: opt(int({ description: '读取行数（省略读到上限）', minimum: 1 }))
})
type ReadParams = Static<typeof parameters>

/** 错误结果速写：isError 文本结果（模型可见原因，是它自我纠正的依据） */
export function errorResult(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: message }], details: null, isError: true }
}

export function createReadTool(roots: string[]): AgentTool {
  // 先按带参泛型标注（execute 的 params 才能收窄为 ReadParams），
  // 再以 AgentTool（object 缺省）上溯返回 —— 逆变得以通过
  const tool: AgentTool<typeof parameters> = {
    name: 'read',
    label: '读取文件',
    description:
      '读取文本文件内容（带行号）。一次最多 2000 行 / 64KB；更长文件用 offset 分段读。',
    parameters,
    async execute(_toolCallId, p: ReadParams): Promise<AgentToolResult> {
      // 只读不限界（D2 修订）：相对路径相对基根（绑定主根 ?? 主目录），绝对任意
      const absolute = resolveAgainstBase(p.path, roots)

      let info
      try {
        info = await stat(absolute)
      } catch {
        return errorResult(`文件不存在: ${p.path}`)
      }
      if (!info.isFile()) return errorResult(`不是文件（可能是目录）: ${p.path}`)

      const raw = await readFile(absolute, 'utf-8')
      if (raw.includes('\0')) return errorResult(`二进制文件不支持读取: ${p.path}`)

      const lines = raw.split('\n')
      const offset = p.offset ?? 1
      const limit = p.limit ?? MAX_LINES
      if (offset > lines.length) {
        return errorResult(`起始行 ${offset} 超出文件总行数 ${lines.length}`)
      }
      const selected: string[] = []
      let chars = 0
      for (let i = offset - 1; i < lines.length && selected.length < limit; i++) {
        const numbered = `${String(i + 1).padStart(6)}\t${lines[i]}`
        // 字符上限先到先停（首行豁免，保证至少有产出，不给模型空结果）
        if (chars + numbered.length > MAX_CHARS && selected.length > 0) {
          selected.push(`…已达 ${MAX_CHARS} 字符上限，用 offset=${i + 1} 继续读`)
          break
        }
        selected.push(numbered)
        chars += numbered.length
      }
      if (selected.length >= limit && offset + limit - 1 < lines.length) {
        selected.push(`…已读 ${limit} 行（至第 ${offset + limit - 1} 行，共 ${lines.length} 行），用 offset=${offset + limit} 继续读`)
      }
      return {
        content: [{ type: 'text', text: selected.join('\n') }],
        details: { path: absolute, totalLines: lines.length, shown: selected.length, offset }
      }
    }
  }
  return tool
}
