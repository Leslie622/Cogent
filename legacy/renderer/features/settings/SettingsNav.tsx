/**
 * 设置页左导航：返回工作区 + 分组菜单（配置驱动，加项只改 NAV 数组）。
 */
import { Button } from '@/components/ui/button'
import { ArrowLeft, Boxes, Bot, Brain, Cable, Clock, Command, Cpu, Folder, HardDrive, Languages, ListTree, Palette, Plug, Puzzle, Scan, User, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'
import type { SettingsSectionId } from './sections'

interface NavItem {
  /** 分区 id；'back' 是特殊项（返回工作区的动作，不是分区） */
  id: SettingsSectionId | 'back'
  label: string
  icon: typeof Languages
}

interface NavGroup {
  label: string | null
  items: NavItem[]
}

/** 导航配置：分组 + 项（图2 的结构；后续按实现进度增删） */
const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ id: 'back', label: '返回工作区', icon: ArrowLeft }]
  },
  {
    label: '基础设置',
    items: [
      { id: 'general', label: '常规', icon: Languages },
      { id: 'appearance', label: '外观', icon: Palette },
      { id: 'models', label: '模型设置', icon: Cpu },
      { id: 'shortcuts', label: '键盘快捷键', icon: Command }
    ]
  },
  {
    label: 'Agent 能力',
    items: [
      { id: 'persona', label: '个性化', icon: User },
      { id: 'memory', label: '记忆', icon: Brain },
      { id: 'subagents', label: '子智能体', icon: Bot },
      { id: 'plugins', label: '插件', icon: Puzzle },
      { id: 'mcp', label: 'MCP 服务器', icon: Plug },
      { id: 'skills', label: '技能', icon: Wrench },
      { id: 'hooks', label: '钩子', icon: Cable }
    ]
  },
  {
    label: '数据与统计',
    items: [
      { id: 'usage', label: '使用统计', icon: HardDrive },
      { id: 'projects', label: '项目', icon: Folder },
      { id: 'sessions', label: '会话管理', icon: ListTree },
      { id: 'automation', label: '自动化', icon: Clock },
      { id: 'browser', label: '浏览器控制', icon: Scan },
      { id: 'boxes', label: '设备', icon: Boxes }
    ]
  }
]

interface SettingsNavProps {
  active: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
}

export function SettingsNav({ active, onSelect }: SettingsNavProps) {
  const setView = useUiStore((s) => s.setView)

  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 border-r p-3">
      {NAV.map((group, gi) => (
        <div key={gi} className="flex flex-col gap-1">
          {group.label && <p className="px-2 pt-3 pb-1 text-xs text-muted-foreground">{group.label}</p>}
          {group.items.map((item) => {
            const Icon = item.icon
            // 「返回工作区」是动作不是分区；其余项为导航
            const isBack = item.id === 'back'
            return (
              <Button
                key={item.id}
                variant="ghost"
                className={cn('justify-start gap-2', !isBack && active === item.id && 'bg-accent')}
                onClick={() => (isBack ? setView('chat') : onSelect(item.id as SettingsSectionId))}
              >
                <Icon size={16} />
                {item.label}
              </Button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
