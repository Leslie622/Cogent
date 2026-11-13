/**
 * glob 工具（只读，kind 'read'）—— 按通配模式枚举文件路径。
 *
 * 输出**相对路径**（posix 风格）：相对根的路径模型可直接回填给 read 的 path
 * 参数（read 的相对路径解析规则同根），比绝对路径省 token 且多根下无盘符噪音。
 * 结果上限（步骤 3.1 迁移到统一截断器口径）：200 条 + 总量 30KB 字节封顶
 * （旧实现条数有上限但单条路径长度无界，深目录长路径能刷穿上下文）。
 * 列表类结果的目的是"让模型挑"，不是"全量搬运"，截断提示引导模型用更具体
 * 的模式缩小。
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { obj, opt, str, type Static } from '@earendil-works/pi-schema'
import { resolveAgainstBase } from './path'
import { formatSize } from './truncate'
import { globToRegex, relativeDisplay, walkFiles } from './walk'

const MAX_MATCHES = 200
/** 结果总量字节封顶：匹配路径累计超此值即停 */
const MAX_TOTAL_BYTES = 30_000

const parameters = obj({
  pattern: str({ description: '通配模式，如 "**/*.ts"、"src/**/*.tsx"、"*.json"' }),
  path: opt(str({ description: '限定搜索的子目录（相对工作区根；省略搜全部根）' }))
})
type GlobParams = Static<typeof parameters>

export function createGlobTool(roots: string[]): AgentTool {
  // 同 read.ts：带参泛型标注后上溯返回
  const tool: AgentTool<typeof parameters> = {
    name: 'glob',
    label: '查找文件',
    description:
      '按通配模式列出工作区内匹配的文件（相对路径）。最多返回 200 条；默认忽略 node_modules 与 .git。',
    parameters,
    async execute(_toolCallId, p: GlobParams): Promise<AgentToolResult> {
      // 扫描基（D2 修订：只读不限界）：给了 path 就扫那个目录（绝对任意、
      // 相对基根解析），缺省扫全部基根（绑定根 ?? 主目录由注册表传入）
      const scanRoots = p.path !== undefined ? [resolveAgainstBase(p.path, roots)] : roots
      const regex = globToRegex(p.pattern)
      const { files, truncated } = await walkFiles(scanRoots)
      const matches: string[] = []
      let totalBytes = 0
      let bytesCapped = false
      for (const file of files) {
        // 基根内显示相对路径（模型可直接回填给 read）；基外回退绝对路径
        const rel = relativeDisplay(file, scanRoots) ?? file
        if (regex.test(rel)) {
          matches.push(rel)
          totalBytes += Buffer.byteLength(rel, 'utf-8') + 1
          if (matches.length >= MAX_MATCHES || totalBytes > MAX_TOTAL_BYTES) {
            bytesCapped = totalBytes > MAX_TOTAL_BYTES
            break
          }
        }
      }
      const notes: string[] = []
      if (truncated) notes.push('（遍历达上限被截断，建议用 path 限定子目录缩小范围）')
      if (matches.length >= MAX_MATCHES) notes.push(`（仅显示前 ${MAX_MATCHES} 条，请用更具体的模式）`)
      if (bytesCapped) notes.push(`（结果总量达 ${formatSize(MAX_TOTAL_BYTES)} 上限，请用更具体的模式）`)
      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `没有匹配的文件: ${p.pattern}` }],
          details: { pattern: p.pattern, count: 0 },
          // 空结果是正常业务结果（不是执行错误）：isError 会误导模型以为调用方式错了
          isError: false
        }
      }
      return {
        content: [{ type: 'text', text: matches.join('\n') + (notes.length > 0 ? `\n${notes.join('')}` : '') }],
        details: { pattern: p.pattern, count: matches.length, truncated }
      }
    }
  }
  return tool
}
