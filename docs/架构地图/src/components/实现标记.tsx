/** 已实现用绿色勾减少重复文字，其余状态沿用共享 Badge。 */
import { Check, CircleDashed, CircleDot, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { implementationLabels, type ImplementationStatus } from '../实现状态'

const icons = { implemented: Check, partial: CircleDot, planned: CircleDashed, external: ExternalLink }

export function ImplementationBadge({ status }: { status: ImplementationStatus }) {
  if (status === 'implemented') return <Check className="size-4 text-green-600 dark:text-green-500" role="img" aria-label={implementationLabels[status]} />
  const Icon = icons[status]
  return <Badge size="sm" variant={status === 'partial' ? 'secondary' : 'outline'}>
    <Icon aria-hidden="true" />{implementationLabels[status]}
  </Badge>
}
