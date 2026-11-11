/**
 * read 工具（只读，kind 'read'）—— 读单个文本文件，带行号输出（cat -n 风格）。
 *
 * 设计取舍：
 * - 带行号：模型后续引用行号（edit 工具的定位语义），Claude Code Read 同款；
 * - 上限走统一截断器 truncate.ts（步骤 3.1 迁移，取代原先各工具零散上限）：
 *   行数 2000 / 64KB 字节双上限先到先停。字节上限与旧字符上限数值相同 ——
 *   多字节内容下字节口径恒 ≥ 字符口径，只收紧不放水；
 * - 截断提示带"用 offset=N 续读"（截断元数据 TruncationResult 供弹药），
 *   模型知道余量在哪、怎么翻页，而不是一句干巴巴的"已截断"；
 * - 单行超字节上限（压缩/打包文件典型）：给行头片段 + 指引，不给空结果
 *   （空结果让模型以为调用失败）；
 * - 二进制文件（含 \0）拒绝而非乱码回灌 —— 乱码既浪费 token 又误导模型。
 *
 * roots 经工厂闭包注入（边界判定需要工作区根，见 path.ts）；pi 的 AgentTool
 * 是声明 + execute，工具实例不持有全局状态，每会话按 roots 现建。
 */
import { readFile, stat } from 'node:fs/promises'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { obj, opt, int, str, type Static } from '@earendil-works/pi-schema'
import { resolveAgainstBase } from './path'
import { formatSize, sliceHead, truncateHead } from './truncate'

/** 行数上限（默认 limit 同值：不给 limit 时读到这个行数为止） */
const MAX_LINES = 2000
/** 字节上限：与旧字符上限同数值（64_000），字节口径下只收紧不放水 */
const MAX_BYTES = 64_000
/** 单行超限场景显示的行头字符量（保底产出：通常文件头/元数据就在开头） */
const OVERFLOW_LINE_HEAD_CHARS = 20_000

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

      // 业务切片（offset/limit 翻页）先行，护栏截断在后 —— 用户指定的 limit
      // 决定"选哪些行"，统一截断器决定"这些行里放多少进上下文"
      const end = Math.min(offset - 1 + limit, lines.length)
      const numbered: string[] = []
      for (let i = offset - 1; i < end; i++) {
        numbered.push(`${String(i + 1).padStart(6)}\t${lines[i]}`)
      }

      const trunc = truncateHead(numbered.join('\n'), { maxLines: MAX_LINES, maxBytes: MAX_BYTES })
      const totalLines = lines.length

      // 单行超字节上限：截断器按约定返回空内容 + 标记；给行头片段 + 指引替代
      if (trunc.firstLineExceedsLimit) {
        const firstRaw = lines[offset - 1]
        const head = sliceHead(firstRaw, OVERFLOW_LINE_HEAD_CHARS)
        const text =
          `${String(offset).padStart(6)}\t${head}\n` +
          `…第 ${offset} 行单行 ${formatSize(Buffer.byteLength(firstRaw, 'utf-8'))}，超过 ${formatSize(MAX_BYTES)} 上限` +
          `（多为压缩/打包文件），仅显示开头。可用 grep 提取目标片段`
        return {
          content: [{ type: 'text', text }],
          details: { path: absolute, totalLines, shown: 1, offset, truncated: true }
        }
      }

      let text = trunc.content
      if (trunc.truncated) {
        // 截断提示 = 可行动续读指令（行号可从 outputLines 精确算出）
        const endLine = offset + trunc.outputLines - 1
        const reason = trunc.truncatedBy === 'bytes' ? `${formatSize(MAX_BYTES)} 上限` : '行数上限'
        text += `\n…已截断：显示第 ${offset}–${endLine} 行（共 ${totalLines} 行，${reason}）。用 offset=${endLine + 1} 继续读`
      } else if (numbered.length >= limit && offset - 1 + limit < totalLines) {
        // 用户 limit 停得比文件短（截断器未介入）：同样给续读提示
        text += `\n…已读 ${limit} 行（至第 ${offset - 1 + limit} 行，共 ${totalLines} 行），用 offset=${offset + limit} 继续读`
      }
      return {
        content: [{ type: 'text', text }],
        details: { path: absolute, totalLines, shown: trunc.outputLines, offset, truncated: trunc.truncated }
      }
    }
  }
  return tool
}
