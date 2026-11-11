/**
 * write 工具（写类，kind 'write'）—— 整文件写/覆盖 + 创建目录（计划-工具
 * 系统与审批.md 第 4 步，批次 2 首个写类工具，审批链路的端到端验收载体）。
 *
 * 与只读工具的边界差异（D2 修订后的口径）：
 * - 只读不限界（read/glob/grep，resolveAgainstBase）；
 * - 写类**软限界**：resolveWithinRoots 必须落在工作区根（绑定根，无绑定 =
 *   用户主目录）内，越界以 error 结果返回（模型可见可写根，自我纠正），
 *   不静默拒绝也不崩进程 —— OS 级硬沙箱不做（前计划 D6）。
 *   真正的闸门在 beforeToolCall 审批矩阵（session.ts），本工具只管"边界内
 *   放行后的落盘"；审批发生在引擎层，与工具本体解耦（同一矩阵将来管
 *   exec/network，无需各工具自接）。
 *
 * 整文件写（非 patch）：edit 增量改写属批次 3，本工具 = Claude Code Write 同款。
 * 空内容合法（清空文件是明确的用户意图，不设防）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { obj, str, type Static } from '@earendil-works/pi-schema'
import { errorResult } from './read'
import { outsideRootsMessage, resolveWithinRoots } from './path'

const parameters = obj({
  path: str({ description: '目标文件路径（相对工作区主根或绝对路径；必须在可写根内）' }),
  content: str({ description: '完整文件内容（整文件覆盖写；空串 = 清空文件）' })
})
type WriteParams = Static<typeof parameters>

export function createWriteTool(roots: string[]): AgentTool {
  const tool: AgentTool<typeof parameters> = {
    name: 'write',
    label: '写入文件',
    description:
      '把内容整体写入文件（已存在则覆盖，不存在则连同父目录创建）。只能写工作区根目录内的路径。',
    parameters,
    async execute(_toolCallId, p: WriteParams) {
      // 写类限界（D2）：越界 = error 结果（非 throw —— 模型可见原因与可写根，
      // 是它改路径重试的依据；工具结果的消费者是模型不是开发者）
      const absolute = resolveWithinRoots(p.path, roots)
      if (absolute === null) {
        return errorResult(outsideRootsMessage(roots))
      }
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, p.content, 'utf-8')
      // 成功结果保持一行短摘要：工具结果全文进模型上下文，回显 content 纯浪费
      const lines = p.content === '' ? 0 : p.content.split('\n').length
      return {
        content: [{ type: 'text', text: `已写入 ${p.path}（${lines} 行，${p.content.length} 字符）` }],
        details: { path: absolute, bytes: Buffer.byteLength(p.content, 'utf-8') }
      }
    }
  }
  return tool
}
