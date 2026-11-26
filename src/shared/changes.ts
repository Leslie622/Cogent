/** 本轮改动列表的壳合同；桌面主窗口只读摘要与按需对比，不向 HTTP/WS 开放。 */
export type {
  ChangeCoverage,
  ChangeKind,
  ChangeMethods,
  ChangeOutcome,
  TurnChangeItem,
  TurnChangesSummary,
  TurnFileDiff
} from '../protocol/domains'

export const SHELL_CHANGE_METHODS = ['changes.get', 'changes.diff'] as const
