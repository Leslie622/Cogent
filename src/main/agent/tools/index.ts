import type { AgentTool } from '@earendil-works/pi-agent-core'
import { timeTools } from './time'

/**
 * Agent 的工具集。
 * 新增工具：在 tools/ 下新建文件导出 AgentTool，然后加入这个数组。
 */
export const tools: AgentTool<any>[] = [...timeTools]
