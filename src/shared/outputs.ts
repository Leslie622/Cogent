/** 产物域的壳合同；声明与已发布版本分开，正文文件引用不承担交付意图。 */
export type {
  OutputDeclaration,
  OutputItem,
  OutputMethods,
  OutputOutcome,
  OutputTarget,
  TurnOutputs
} from '../protocol/domains'

export const SHELL_OUTPUT_METHODS = ['outputs.get', 'outputs.resolve'] as const
