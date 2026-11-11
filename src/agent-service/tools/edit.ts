/**
 * edit 工具（写类，kind 'edit'）—— 精确文本替换编辑（步骤 3.3，算法搬运自
 * pi 上游 reference/pi/packages/coding-agent/src/core/tools/edit.ts，
 * MIT License, Copyright (c) 2025 Mario Zechner；diff/匹配核心在 edit-diff.ts）。
 *
 * 语义：一次调用可带多条互不重叠的替换；每条 oldText 都对**同一份原文**匹配
 * （非增量），必须唯一命中。与 write 的分工：write = 整文件写/新建，edit =
 * 已有文件的定点修改（token 效率高、diff 可审）。
 *
 * 接线（Cogent 化差异，相对上游）：
 * - 边界走 resolveWithinRoots 软限界（上游 resolveToCwd 不限界；我们写类
 *   限工作区根，越界 error 结果）+ beforeToolCall 审批矩阵（kind 'edit' 同
 *   write：ask 询问 / auto 放行 / plan block）；
 * - 错误走 errorResult（模型可见可纠正的文本结果）而非 throw —— 上游 throw
 *   由 pi 包装成 error 结果，殊途同归，直接返回少一层转换；
 * - 上游 prepareArguments（模型把 edits 发成 JSON 字符串/单对象的容错归一）
 *   未搬：pi-schema 参数校验在前，坏形状到不了 execute，校验错误结果同样
 *   引导模型重试（学习代价记入技术笔记）。
 *
 * Operations 注入（D1 定稿）：fs 操作作接口传入，默认本地实现 —— 冒烟可
 * mock、未来远程写（SSH 等）不改工具本体。
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { arr, obj, str, type Static } from '@earendil-works/pi-schema'
import { errorResult } from './read'
import { withFileMutationQueue } from './file-mutation-queue'
import { outsideRootsMessage, resolveWithinRoots } from './path'
import {
  applyEditsToNormalizedContent,
  applyReplacementsToOriginal,
  generateEditDiff,
  normalizeToLF
} from './edit-diff'

const parameters = obj({
  path: str({ description: '目标文件路径（相对工作区主根或绝对路径；必须在可写根内）' }),
  edits: arr(
    obj({
      oldText: str({
        description: '要替换的原文（必须与文件内容完全一致且在文件中唯一；多条之间不可重叠）'
      }),
      newText: str({ description: '替换后的文本' })
    }),
    { description: '一条或多条定点替换；都针对编辑前的原文件匹配，重叠/嵌套的改动请合并为一条' }
  )
})
type EditParams = Static<typeof parameters>

/** edit 的可插拔 fs 操作（D1 Operations 注入；默认本地实现） */
export interface EditOperations {
  readFile: (absolutePath: string) => Promise<string>
  writeFile: (absolutePath: string, content: string) => Promise<void>
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => readFile(path, 'utf-8'),
  writeFile: (path, content) => writeFile(path, content, 'utf-8')
}

/** BOM 剥离（模型不会把不可见 BOM 抄进 oldText；写回时再补回开头） */
function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content }
}

export function createEditTool(roots: string[], operations?: EditOperations): AgentTool {
  const ops = operations ?? defaultEditOperations
  const tool: AgentTool<typeof parameters> = {
    name: 'edit',
    label: '编辑文件',
    description:
      '用精确文本替换编辑已有文件。每条 edits[].oldText 必须与原文件唯一匹配且互不重叠；相邻/重叠的改动合并为一条。比 write 更适合定点修改。',
    parameters,
    async execute(_toolCallId, p: EditParams): Promise<AgentToolResult> {
      // 写类限界（同 write）：越界 = error 结果（模型可见可写根，自我纠正）
      const absolute = resolveWithinRoots(p.path, roots)
      if (absolute === null) {
        return errorResult(outsideRootsMessage(roots))
      }
      if (!Array.isArray(p.edits) || p.edits.length === 0) {
        return errorResult('edits 至少要有一条替换。')
      }

      // 读改写整段入变更队列（与 write 同队：整写与读改写撞同一文件同样撕裂）
      return withFileMutationQueue(absolute, async () => {
        let raw: string
        try {
          raw = await ops.readFile(absolute)
        } catch {
          return errorResult(`文件不存在或不可读: ${p.path}`)
        }

        try {
          // BOM 剥离后进 LF 归一化空间匹配（模型抄写的 oldText 不会有 BOM）
          const { bom, text } = splitBom(raw)
          const normalizedContent = normalizeToLF(text)
          const { baseContent, newContent, replacements } = applyEditsToNormalizedContent(
            normalizedContent,
            p.edits,
            p.path
          )
          // diff 在写盘前算好：写盘后失败也不会出现"文件已改但拿不出 diff"
          const editDiff = generateEditDiff(p.path, baseContent, newContent, replacements)

          // 拼回原文空间：未触碰的行保留原始字节与行尾（CRLF 文件编辑后不会
          // 整体变 LF）；原文本无 CR 时归一化结果即最终结果
          const finalContent =
            bom +
            (text === normalizedContent
              ? newContent
              : applyReplacementsToOriginal(text, replacements))
          await ops.writeFile(absolute, finalContent)

          return {
            content: [{ type: 'text', text: `已替换 ${p.edits.length} 处（${p.path}）` }],
            // details 进 pi 转录（JsonValue）：undefined 字段不落（firstChangedLine
            // 条件展开），历史回查的 diff 提取只读 diff 字段
            details: {
              path: absolute,
              diff: editDiff.diff,
              patch: editDiff.patch,
              ...(editDiff.firstChangedLine !== undefined
                ? { firstChangedLine: editDiff.firstChangedLine }
                : {})
            }
          }
        } catch (error) {
          // 匹配类失败（找不到/多处命中/重叠/无变更）：error 结果带原因，
          // 模型据此修正 oldText 重试 —— 这类失败是 edit 工具的正常业务路径
          return errorResult((error as Error).message)
        }
      })
    }
  }
  return tool
}
