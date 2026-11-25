/** 将混合完成度拆成具体能力行；节点与说明面板共用同一份事实数据。 */
import type { ModuleFeature } from '../模块说明'

export function FeatureList({ items }: { items: ModuleFeature[] }) {
  return (
    <ul className="architecture-features grid w-full gap-1 text-xs">
      {items.map((item) => (
        <li key={item.label} className="flex items-center justify-between gap-2" data-status={item.status}>
          <span>{item.label}</span>
          <span
            role="img"
            aria-label={item.status === 'implemented' ? '已完成' : '未完成'}
            className={`size-2 shrink-0 rounded-full ${item.status === 'implemented' ? 'bg-green-600 dark:bg-green-500' : 'bg-orange-600 dark:bg-orange-400'}`}
          />
        </li>
      ))}
    </ul>
  )
}
