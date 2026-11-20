/** 模型直调申报工具；model-only 确保所有发布均经过公开 afterToolCall 的最终确认。 */
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { OutputDeclaration, TurnOutputs } from '../../../shared/outputs'
const description = '明确申报这轮需要单独交给用户的现有文件。终答前调用；普通参考资料和仅修改源码不必申报。每次 deliverables 完整替换上一份，[] 明确撤回全部；任何路径失败则保留旧清单。相对路径按工具 cwd 解析，path 是字面路径而非链接，不加行列。可申报任何普通文件，目录请先打包。预算内保存交付副本；超预算明确仅引用当前原文件。Markdown 依赖需一起申报。工具成功后仍可修改文件，Host 收尾会复核最终版本。'
const parameters = Type.Object({ deliverables: Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 32768 }), note: Type.Optional(Type.String({ maxLength: 200 })) }), { maxItems: 100 }) })
export function outputReceipt(doc: TurnOutputs) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ turnId: doc.turnId, revision: doc.revision, deliverables: doc.active }) }], details: { turnId: doc.turnId, revision: doc.revision } }
}
export function createReportOutputsTool(stage: (callId: string, declarations: OutputDeclaration[], cwd: string, signal?: AbortSignal) => Promise<TurnOutputs>): ToolDefinition {
  return defineTool({ name: 'report_outputs', label: '申报产物', description, parameters, exposure: 'model-only',
    execute: async (callId, params, signal, _update, ctx) => outputReceipt(await stage(callId, params.deliverables, ctx.cwd, signal)) })
}
export function outputToolDeclaration() { return { name: 'report_outputs', description, parameters } }
