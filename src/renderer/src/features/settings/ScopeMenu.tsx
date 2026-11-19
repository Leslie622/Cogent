/**
 * 作用域菜单（技能 / MCP 分区共用）：级联二级子菜单 —— 「本机 ▸ 用户」
 * 「项目 ▸ 各项目」（2026-11-15 用户定调：不要 Select 的 group 平铺头，
 * 要箭头展开的子菜单，zcode 同形态）。触发器显「本机 · X」；选择逻辑与
 * 默认跟随语义都在 useProjectScope，这里只管菜单呈现。
 */
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ProjectScope } from '@/hooks/use-project-scope'

export function ScopeMenu({ state }: { state: ProjectScope }) {
  const current = state.items.find((i) => i.value === state.selectValue)?.label ?? '本机 · 用户'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="default" aria-label="作用域" />}>
        {current}
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {state.groups.map((group) => (
          <DropdownMenuSub key={group.label}>
            <DropdownMenuSubTrigger>{group.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {group.items.map((item) => (
                <DropdownMenuItem key={item.value} onClick={() => state.pick(item.value)}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
