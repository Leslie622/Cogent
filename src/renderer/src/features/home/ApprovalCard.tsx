/**
 * 审批痕迹行（审批交互升级 D1 后收窄）—— 原 pending 卡形态随「pending 不进
 * 消息流」删除，裁决的进行时呈现迁至对话底部确认面板（ApprovalPanel）；本件
 * 只渲染终态痕迹（裁决/中止完成时 chat store 落进消息流），TraceLine 置灰
 * 单行 —— 与工具卡 blocked 同款安静形态，模型转录里无对应物（引擎侧只是
 * 工具结果），run 终态替换时保留。
 */
import { IconBan, IconPlayerStopFilled, IconShieldCheckFilled } from '@tabler/icons-react'
import { TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import type { ApprovalItem } from '@/stores/chat'

/** 终态 → 尾标文案（头行右侧小字，口径与工具卡 STATUS_LABEL 对齐） */
const SETTLED_LABEL: Record<ApprovalItem['status'], string> = {
  approved: '已允许',
  denied: '已拒绝',
  cancelled: '已取消'
}

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  return (
    <TraceLine status="pending">
      <TraceIcon>
        {item.status === 'approved' ? (
          <IconShieldCheckFilled />
        ) : item.status === 'denied' ? (
          <IconBan />
        ) : (
          <IconPlayerStopFilled />
        )}
      </TraceIcon>
      {/* 摘要含路径（等宽对齐，同工具卡）；run 终态替换后它就是这段裁决的全部痕迹 */}
      <TraceTitle className="font-mono text-xs">{item.summary}</TraceTitle>
      <span className="text-[11px]">{SETTLED_LABEL[item.status]}</span>
    </TraceLine>
  )
}
