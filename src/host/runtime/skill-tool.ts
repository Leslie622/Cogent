/**
 * 专用技能加载工具（docs/计划/技能座升级实现.md §3.1）——
 * 通过 pi customTools 注入 `skill` 工具，取代「模型用 read 工具硬读 SKILL.md」的旧链路。
 *
 * 收口收益：
 * - 与用户显式触发（$`/` 实体、`/skill:`）共用同一套 `SkillStore.loadForExecution`；
 * - 统一完成 `disable-model-invocation` 校验、100KB 正文预算截断、通用变量替换与附属资源索引；
 * - 工具层与 UI 层可识别专属 `skill` 卡片与 `skill.loaded` 审计轨迹。
 */
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { SKILL_TOOL_DESCRIPTION } from './prompts/tools'
import type { LoadedSkillResult } from './skill-store'

export interface SkillToolBridge {
  load(name: string, args: string | undefined): LoadedSkillResult | Promise<LoadedSkillResult>
}

const SKILL_TOOL_PARAMS = Type.Object({
  name: Type.String({ description: '可用技能清单中的精确技能名（不含前导斜杠或 $）' }),
  args: Type.Optional(Type.String({ description: '可选：传给该技能的参数或任务上下文' }))
})

/** 创建 `skill` 工具实例（bridge 闭包绑定当前会话工作区与观测器） */
export function createSkillTool(bridge: SkillToolBridge): ToolDefinition {
  return defineTool({
    name: 'skill',
    label: '加载技能',
    description: SKILL_TOOL_DESCRIPTION,
    parameters: SKILL_TOOL_PARAMS,
    execute: async (_callId, params) => {
      const loaded = await bridge.load(params.name, params.args)
      return {
        content: [{ type: 'text', text: loaded.content }],
        details: {
          name: loaded.name,
          baseDir: loaded.baseDir,
          origin: loaded.origin,
          truncated: loaded.truncated,
          resourceCount: loaded.resourceFiles.length
        }
      }
    }
  })
}

/** 供 tool-meta.ts 重建 toolDefs 估算用（静态声明，无运行时闭包） */
export function skillToolDeclaration(): { name: string; description: string; parameters: unknown } {
  return {
    name: 'skill',
    description: SKILL_TOOL_DESCRIPTION,
    parameters: SKILL_TOOL_PARAMS
  }
}

/** tool-meta 参数摘要：提取技能名，保持工具卡头行清爽 */
export function summarizeSkillArgs(args: unknown): string {
  const name = typeof args === 'object' && args !== null ? (args as { name?: unknown }).name : undefined
  return typeof name === 'string' && name.trim().length > 0 ? `skill(${name.trim()})` : 'skill()'
}
