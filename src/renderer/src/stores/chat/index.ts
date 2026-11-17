/**
 * chat store 桶文件（2026-11-17 会话状态重构 P2）：`@/stores/chat` 的导入
 * 路径在拆分前后保持不变 —— 全部消费方（组件/测试/设置页）只认本入口。
 * 内部分层：types（类型）/ flatten（纯函数）/ selectors（订阅视图）/
 * store（状态与动作）/ events（引擎事件转译），职责见各文件头。
 */
export { useChatStore, projectDefaultMode, emptyBucket, patchBucket } from './store'
export { bindEngineEvents } from './events'
export { selectRunning, selectStopping, selectLastError, selectTruncated, selectCompacting, EMPTY_MESSAGES } from './selectors'
export { flattenSegments, flatWithApprovals, flatWithCompaction, replaceRunTerminal } from './flatten'
export type {
  ToolItem,
  ApprovalItem,
  PendingApproval,
  PendingQuestion,
  PendingPlan,
  PrunedEntry,
  PrunedItem,
  MessageItem,
  SessionRuntime,
  SessionBucket,
  ChatState
} from './types'
export type { SessionSummary } from './types'
