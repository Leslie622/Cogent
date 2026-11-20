/** 产物域的壳合同；声明与已发布版本分开，正文文件引用不承担交付意图。 */
import type { FileDescriptor } from './files'

export interface OutputDeclaration { path: string; note?: string }
export interface OutputItem {
  outputId: string
  sourcePath: string
  realPath: string
  name: string
  note?: string
  size: number
  confirmedAt: number
  copy: { status: 'saved'; relativePath: string; sha256: string } | { status: 'source-only'; reason: string }
  warning?: string
}
export type OutputOutcome = 'completed' | 'aborted' | 'error'
export interface TurnOutputs {
  version: 1
  sessionId: string
  turnId: string
  revision: number
  state: 'running' | 'finalizing' | 'ready' | 'interrupted'
  declared: boolean
  active: OutputItem[]
  published: OutputItem[]
  outcome?: OutputOutcome
  warning?: string
}
export interface OutputTarget {
  sessionId: string
  turnId: string
  revision: number
  outputId: string
  version: 'delivery' | 'current'
}
export interface OutputMethods {
  'outputs.get': { params: { sessionId: string; turnId?: string }; result: TurnOutputs[] }
  'outputs.resolve': { params: OutputTarget; result: FileDescriptor }
}
export const SHELL_OUTPUT_METHODS = ['outputs.get', 'outputs.resolve'] as const
