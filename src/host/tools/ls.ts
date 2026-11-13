/**
 * ls 工具（只读，kind 'read'）—— 列目录一层内容（步骤 3.6 ④，搬运自 pi
 * 上游 reference/pi/packages/coding-agent/src/core/tools/ls.ts，MIT License,
 * Copyright (c) 2025 Mario Zechner；截断走统一截断器口径）。
 *
 * 定位：目录速览（"这个文件夹里有什么"），与 glob 互补 —— glob 按模式递归
 * 找文件，ls 看某目录的直接结构（含子目录名、点文件）。输出相对显示路径，
 * 目录带 / 尾（ls -p 惯例），字母序（调用方排序稳定性 = 结果可复现）。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { obj, opt, str, type Static } from '@earendil-works/pi-schema'
import { resolveAgainstBase } from './path'
import { errorResult } from './read'
import { relativeDisplay } from './walk'

/** 条目上限：目录速览不需要千行列表（上游同值 500） */
const MAX_ENTRIES = 500
/** 结果总量字节封顶（对齐 glob 口径） */
const MAX_TOTAL_BYTES = 30_000

const parameters = obj({
  path: opt(str({ description: '要列出的目录（相对工作区主根或绝对路径；省略 = 主根）' }))
})
type LsParams = Static<typeof parameters>

export function createLsTool(roots: string[]): AgentTool {
  const tool: AgentTool<typeof parameters> = {
    name: 'ls',
    label: '列出目录',
    description:
      '列出目录一层的内容（含点文件，目录带 / 尾，字母序）。最多 500 条；要看深层结构用 glob。',
    parameters,
    async execute(_toolCallId, p: LsParams): Promise<AgentToolResult> {
      const absolute = resolveAgainstBase(p.path ?? '.', roots)

      let info
      try {
        info = await stat(absolute)
      } catch {
        return errorResult(`目录不存在: ${p.path ?? '.'}`)
      }
      if (!info.isDirectory()) return errorResult(`不是目录（可能是文件）: ${p.path}`)

      let entries
      try {
        entries = await readdir(absolute, { withFileTypes: true })
      } catch {
        return errorResult(`目录不可读: ${p.path}`)
      }
      // 字母序（不区分类型混排；上游同款排序口径）
      entries.sort((a, b) => a.name.localeCompare(b.name))

      const lines: string[] = []
      let totalBytes = 0
      let truncated = false
      for (const entry of entries) {
        if (lines.length >= MAX_ENTRIES) {
          truncated = true
          break
        }
        // 显示相对基根路径（模型可直接回填给 read/glob）；基外回退绝对
        const full = join(absolute, entry.name)
        const rel = relativeDisplay(full, roots) ?? full.replace(/\\/g, '/')
        const line = entry.isDirectory() ? `${rel}/` : rel
        totalBytes += Buffer.byteLength(line, 'utf-8') + 1
        if (totalBytes > MAX_TOTAL_BYTES) {
          truncated = true
          break
        }
        lines.push(line)
      }
      const notes: string[] = []
      if (truncated) notes.push(`（条目过多，仅显示前 ${lines.length} 条，请用更具体的 path）`)
      if (lines.length === 0) {
        return {
          content: [{ type: 'text', text: '（空目录）' }],
          details: { path: absolute, count: 0 },
          isError: false
        }
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') + (notes.length > 0 ? `\n${notes.join('')}` : '') }],
        details: { path: absolute, count: lines.length, truncated }
      }
    }
  }
  return tool
}
