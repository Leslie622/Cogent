/** 模型直调申报工具；model-only 确保所有发布均经过公开 afterToolCall 的最终确认。 */
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { OutputDeclaration, TurnOutputs } from '../../../shared/outputs'
import { formatReportOutputsReceipt, REPORT_OUTPUTS_DESCRIPTION } from '../prompts/tools'
const description = REPORT_OUTPUTS_DESCRIPTION
const parameters = Type.Object({ deliverables: Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 32768 }), note: Type.Optional(Type.String({ maxLength: 200 })) }), { maxItems: 100 }) })
export function outputReceipt(doc: TurnOutputs) {
  return {
    content: [{ type: 'text' as const, text: formatReportOutputsReceipt(doc.active.map((item) => item.sourcePath)) }],
    details: { turnId: doc.turnId, revision: doc.revision }
  }
}
export function createReportOutputsTool(stage: (callId: string, declarations: OutputDeclaration[], cwd: string, signal?: AbortSignal) => Promise<TurnOutputs>): ToolDefinition {
  return defineTool({ name: 'report_outputs', label: '申报产物', description, parameters, exposure: 'model-only',
    execute: async (callId, params, signal, _update, ctx) => outputReceipt(await stage(callId, params.deliverables, ctx.cwd, signal)) })
}
export function outputToolDeclaration() { return { name: 'report_outputs', description, parameters } }
