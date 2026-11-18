/** 控制台分区沿用 shadcn 折叠原语，独立开合，避免概览挤占正文空间。 */
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export function DetailSection({ title, defaultOpen = true, actions, trailing, appearance = 'plain', children }: {
  title: string
  defaultOpen?: boolean
  actions?: ReactNode
  trailing?: ReactNode
  appearance?: 'plain' | 'row'
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 shrink-0">
    <div className={appearance === 'row' ? 'flex flex-wrap items-center gap-1 py-1' : '-mx-2 flex flex-wrap items-center gap-1'}>
      <CollapsibleTrigger render={<Button variant={appearance === 'row' ? 'ghost' : 'disclosure'} size={appearance === 'row' ? 'sm' : 'console'} className="min-w-0 flex-1 justify-start" />}>
        <ChevronDown className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="min-w-0 truncate" title={title}>{title}</span>
        {trailing}
      </CollapsibleTrigger>
      {actions}
    </div>
    <CollapsibleContent keepMounted>{children}</CollapsibleContent>
  </Collapsible>
}
