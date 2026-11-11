/**
 * 审批卡（写类工具挂起时的用户裁决行）—— AI Elements Confirmation pattern
 * 配方落地（https://ui.shadcn.com/docs/ai-elements/base/confirmation：
 * Item 原语 + Deny/Approve 双钮，官方即"装原语照配方组合"）。
 * 两态呈现对齐消息流家族：pending = Item 卡（行动请求，醒目出钮）；
 * 终态 = TraceLine 置灰单行（裁决痕迹，与工具卡 blocked 同款安静形态）——
 * run.completed 终态替换时保留（转录里无对应物，模型侧只是 error 工具结果）。
 */
import { IconBan, IconPlayerStopFilled, IconShieldCheckFilled, IconShieldFilled } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { useChatStore, type ApprovalItem } from '@/stores/chat'

/** 终态 → 尾标文案（头行右侧小字，口径与工具卡 STATUS_LABEL 对齐） */
const SETTLED_LABEL: Record<Exclude<ApprovalItem['status'], 'pending'>, string> = {
  approved: '已允许',
  denied: '已拒绝',
  cancelled: '已取消'
}

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  if (item.status !== 'pending') {
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

  // 动作直取 getState（点击级低频，不订阅 store；卡状态由 respondApproval 乐观翻转）
  const respond = (approved: boolean) => {
    void useChatStore.getState().respondApproval(item.id, approved)
  }
  return (
    <Item variant="outline" size="sm" className="rounded-xl">
      <ItemMedia variant="icon" className="text-warning">
        <IconShieldFilled className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>允许 {item.toolName} 执行？</ItemTitle>
        <ItemDescription className="font-mono text-xs">{item.summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="outline" size="sm" onClick={() => respond(false)}>
          拒绝
        </Button>
        <Button size="sm" onClick={() => respond(true)}>
          允许
        </Button>
      </ItemActions>
    </Item>
  )
}
