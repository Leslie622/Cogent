/**
 * grep 工具（只读，kind 'read'）—— 工作区内全文搜索（正则）。
 *
 * 输出 `相对路径:行号:行文本`（ripgrep 恒例格式，模型对此格式有强先验）。
 * 上限（步骤 3.1 迁移到统一截断器口径）：100 个匹配行 + 单行走 truncateLine
 * （500 字符 + `[truncated]` 标注，取代旧 slice(0,300) 静默切）+ 结果总量
 * 30KB 字节封顶（旧实现最坏 100×300 字符无总量闸，此处补上）+ 单文件 1MB
 * 跳过 + 二进制跳过 —— 搜索结果的目的是定位，读全文交给 read。
 */
import { readFile } from 'node:fs/promises'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { bool, int, obj, opt, str, type Static } from '@earendil-works/pi-schema'
import { resolveAgainstBase } from './path'
import { errorResult } from './read'
import { formatSize, truncateLine } from './truncate'
import { relativeDisplay, walkFiles } from './walk'

const MAX_MATCH_LINES = 100
/** 结果总量字节封顶：匹配行累计超此值即停（防超长路径×百行把上下文刷满） */
const MAX_TOTAL_BYTES = 30_000
/** 单文件大小上限：超过的大文件（数据集/打包产物）逐行扫是纯浪费，跳过并提示 */
const MAX_FILE_BYTES = 1_000_000

const parameters = obj({
  pattern: str({ description: '正则表达式（JavaScript 语法）' }),
  path: opt(str({ description: '限定搜索的文件或子目录（相对工作区根；省略搜全部根）' })),
  ignoreCase: opt(bool({ description: '忽略大小写（省略 = 区分）' })),
  context: opt(int({ description: '每个匹配行前后各显示的上下文行数（省略 = 只显匹配行）', minimum: 0 }))
})
type GrepParams = Static<typeof parameters>

export function createGrepTool(roots: string[]): AgentTool {
  // 同 read.ts：带参泛型标注后上溯返回
  const tool: AgentTool<typeof parameters> = {
    name: 'grep',
    label: '全文搜索',
    description:
      '在工作区文件里按正则搜索文本，返回 `路径:行号:行`（最多 100 条）。默认忽略 node_modules 与 .git。',
    parameters,
    async execute(_toolCallId, p: GrepParams): Promise<AgentToolResult> {
      // 搜索基（D2 修订：只读不限界）：path 绝对任意、相对基根解析；缺省全部基根
      const scanRoots = p.path !== undefined ? [resolveAgainstBase(p.path, roots)] : roots
      let regex: RegExp
      try {
        // 无效正则是模型的高频笔误：作为 error 结果返回让它修正模式，
        // 而不是抛异常（pi 同样转 error 结果，但这里能带上原文与建议）
        regex = new RegExp(p.pattern, p.ignoreCase === true ? 'i' : '')
      } catch (error) {
        return errorResult(`无效的正则表达式 "${p.pattern}": ${(error as Error).message}`)
      }

      const { files, truncated: walkTruncated } = await walkFiles(scanRoots)
      const hits: string[] = []
      let scanned = 0
      let skippedLarge = 0
      let totalBytes = 0
      let bytesCapped = false
      const context = p.context ?? 0
      for (const file of files) {
        if (hits.length >= MAX_MATCH_LINES || bytesCapped) break
        let raw: string
        try {
          // 大文件用 readFile 前先 stat 会双倍 IO；直接读入再判长（UTF-8 解码后
          // 判 \0 与长度，1MB 上限按解码后字符近似 —— 量级控制而非精确字节）
          raw = await readFile(file, 'utf-8')
        } catch {
          continue // 单文件读失败不中断整个搜索（锁定的日志文件等，外部世界常态）
        }
        if (raw.includes('\0')) continue
        if (raw.length > MAX_FILE_BYTES) {
          skippedLarge++
          continue
        }
        scanned++
        // 搜索基内显示相对路径（省 token）；基外（绝对 path 扫别的目录）回退绝对
        const rel = relativeDisplay(file, scanRoots) ?? file
        const lines = raw.split('\n')
        if (context > 0) {
          // 上下文模式（步骤 3.6 ③，ripgrep 惯例）：匹配行 path:N: 前缀、
          // 上下文行 path-N- 前缀、不相邻组间 "--" 分隔 —— 模型对该格式有
          // 强先验。先收匹配行号，再按区间展开（含 context 融并相邻组）
          const matchLines: number[] = []
          for (let i = 0; i < lines.length && matchLines.length < MAX_MATCH_LINES; i++) {
            if (regex.test(lines[i])) matchLines.push(i)
          }
          if (matchLines.length === 0) continue
          // 区间展开 + 融并（两区间间隔 ≤ 2*context 时合并，ripgrep 同款）
          const ranges: Array<[number, number]> = []
          for (const m of matchLines) {
            const start = Math.max(0, m - context)
            const end = Math.min(lines.length - 1, m + context)
            const last = ranges.at(-1)
            if (last !== undefined && start <= last[1] + 1) {
              last[1] = Math.max(last[1], end)
            } else {
              ranges.push([start, end])
            }
          }
          for (let r = 0; r < ranges.length && !bytesCapped; r++) {
            if (r > 0) hits.push('--')
            const [start, end] = ranges[r]
            for (let i = start; i <= end; i++) {
              // 单行走统一截断器：超长行截 500 字符 + 显式标注
              const line = truncateLine(lines[i]).text
              const hit = regex.test(lines[i]) ? `${rel}:${i + 1}:${line}` : `${rel}-${i + 1}-${line}`
              totalBytes += Buffer.byteLength(hit, 'utf-8') + 1
              if (totalBytes > MAX_TOTAL_BYTES) {
                bytesCapped = true
                break
              }
              hits.push(hit)
            }
          }
          continue
        }
        for (let i = 0; i < lines.length && hits.length < MAX_MATCH_LINES; i++) {
          if (!regex.test(lines[i])) continue
          // 单行走统一截断器：超长行截 500 字符 + 显式标注（模型知道行被切过）
          const line = truncateLine(lines[i]).text
          const hit = `${rel}:${i + 1}:${line}`
          totalBytes += Buffer.byteLength(hit, 'utf-8') + 1
          if (totalBytes > MAX_TOTAL_BYTES) {
            bytesCapped = true
            break
          }
          hits.push(hit)
        }
      }
      const notes: string[] = []
      if (walkTruncated) notes.push('（遍历达上限，结果可能不完整，建议用 path 限定范围）')
      if (skippedLarge > 0) notes.push(`（跳过 ${skippedLarge} 个超大文件）`)
      if (hits.length >= MAX_MATCH_LINES) notes.push('（仅显示前 100 条，请用更具体的模式）')
      if (bytesCapped) notes.push(`（结果总量达 ${formatSize(MAX_TOTAL_BYTES)} 上限，请用更具体的模式）`)
      const text =
        hits.length > 0
          ? hits.join('\n') + (notes.length > 0 ? `\n${notes.join('')}` : '')
          : `没有匹配: ${p.pattern}（已扫描 ${scanned} 个文件）${notes.join('')}`
      return {
        content: [{ type: 'text', text }],
        details: { pattern: p.pattern, hits: hits.length, scanned }
      }
    }
  }
  return tool
}
