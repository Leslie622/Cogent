/**
 * 审批痕迹行（审批交互升级 D1 后收窄）—— 原 pending 卡形态随「pending 不进
 * 消息流」删除，裁决的进行时呈现迁至对话底部确认面板（ApprovalPanel）；本件
 * 仅渲染缺少对应工具的终态痕迹；有 callId 配对的裁决由 TurnGroup 收进工具行。
 * 原始裁决仍由会话桶持有，run 终态替换时保留，不改模型转录。
 */
import { TraceLine, TraceTitle } from '@/components/ui/trace'
import { APPROVAL_LABEL, ApprovalMark } from '@/components/ui/approval-mark'
import { parseToolSummary } from '@/components/ui/tool-display'
import type { ApprovalItem } from '@/stores/chat'

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  return (
    <TraceLine status="pending">
      <ApprovalMark status={item.status} />
      <TraceTitle className="shrink-0">审批</TraceTitle>
      <span className="min-w-0 truncate font-mono text-xs">{parseToolSummary(item.toolName, item.summary)}</span>
      <span className="text-xs">{APPROVAL_LABEL[item.status]}</span>
    </TraceLine>
  )
}
