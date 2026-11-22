/** 审批结果的紧凑呈现：工具行与未配对痕迹共用；授权结果不代表命令执行成功。 */
import { IconBan, IconPlayerStopFilled, IconShieldCheckFilled } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export type ApprovalStatus = 'approved' | 'denied' | 'cancelled'

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  approved: '已允许',
  denied: '已拒绝',
  cancelled: '已取消'
}

export function ApprovalMark({ status }: { status: ApprovalStatus }) {
  const Icon = status === 'approved' ? IconShieldCheckFilled : status === 'denied' ? IconBan : IconPlayerStopFilled
  const label = APPROVAL_LABEL[status]
  return (
    <TooltipProvider delay={400}>
      <Tooltip>
        <TooltipTrigger render={<span role="img" aria-label={label} className="flex size-4 shrink-0 items-center justify-center" />}>
          <Icon className="size-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
