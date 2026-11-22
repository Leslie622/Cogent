/** 将混合完成度拆成具体能力行；节点与说明面板共用同一份事实数据。 */
import { Circle } from 'lucide-react'
import type { ModuleFeature } from '../模块说明'

export function FeatureList({ items }: { items: ModuleFeature[] }) {
  return <ul className="architecture-features grid w-full gap-1 text-xs">
    {items.map(item => <li key={item.label} className="flex items-center justify-between gap-2" data-status={item.status}>
      <span>{item.label}</span>
      <Circle className={`size-2 shrink-0 ${item.status === 'implemented' ? 'text-green-600 dark:text-green-500' : 'text-orange-600 dark:text-orange-400'}`} fill="currentColor" strokeWidth={0} role="img" aria-label={item.status === 'implemented' ? '已完成' : '未完成'} />
    </li>)}
  </ul>
}
