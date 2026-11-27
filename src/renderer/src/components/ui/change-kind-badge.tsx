/** 文件变化状态徽章：直接消费设计素材，裁去画布留白以保持文件行的紧凑高度。 */
import type { CSSProperties } from 'react'
import type { ChangeKind } from '@shared/changes'
import { Hint } from '@/components/Hint'

const LABELS: Record<ChangeKind, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  'type-changed': '类型变化',
  'mode-changed': '权限变化',
  'eol-or-encoding': '换行或编码变化'
}

// 只导入应用消费的文字版；Vite 输出本地资源，设计源与独立预览继续留在素材库。
const assets = import.meta.glob<string>('../../../../../resources/design-assets/change-badges/*/label/*.svg', {
  eager: true,
  import: 'default',
  query: '?url&no-inline'
})

export function ChangeKindBadge({ kind }: { kind: ChangeKind }) {
  const source = (theme: 'light' | 'dark') => assets[`../../../../../resources/design-assets/change-badges/${theme}/label/${kind}.svg`]

  return (
    <Hint tip={LABELS[kind]}>
      <span
        data-slot="change-kind-badge"
        data-change-kind={kind}
        // 素材画布 48×28，水平居中裁去透明留白，底板仍按原尺寸 43×20 呈现。
        className="inline-flex h-5 w-11 shrink-0 bg-[image:var(--change-badge-light)] bg-center bg-no-repeat [background-size:48px_28px] dark:bg-[image:var(--change-badge-dark)]"
        style={{ '--change-badge-light': `url("${source('light')}")`, '--change-badge-dark': `url("${source('dark')}")` } as CSSProperties}
      >
        <span className="sr-only">{LABELS[kind]}</span>
      </span>
    </Hint>
  )
}
