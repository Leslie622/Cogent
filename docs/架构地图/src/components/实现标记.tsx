/** 已实现用绿色勾减少重复文字，其余状态沿用本地 Badge。 */
import { implementationLabels, type ImplementationStatus } from '../实现状态'
import { CheckIcon, CircleDashedIcon, CircleDotIcon, ExternalLinkIcon } from './图标'
import { Badge } from './UI'

const icons = {
  implemented: CheckIcon,
  partial: CircleDotIcon,
  planned: CircleDashedIcon,
  external: ExternalLinkIcon,
}

export function ImplementationBadge({ status }: { status: ImplementationStatus }) {
  if (status === 'implemented') {
    return <CheckIcon className="size-4 text-green-600 dark:text-green-500" role="img" aria-label={implementationLabels[status]} />
  }
  const Icon = icons[status]
  return (
    <Badge size="sm" variant={status === 'partial' ? 'secondary' : 'outline'}>
      <Icon className="size-3" />{implementationLabels[status]}
    </Badge>
  )
}
