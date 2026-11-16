/**
 * 审批/方案面板的行内档位下拉（「允许，并切换为 ▾」），两面板共用 ——
 * 项形态复用权限菜单的 MODES/ModeItem（视觉单一真源；2026-11-16 前两面板
 * 各内联一份纯文字档位项：无模式图标、无 warning 琥珀、黑圆勾选中标记，
 * 与权限菜单视觉脱节）。选「完全访问」先过 FullAccessConfirm 危险闸门
 * （2026-11-16 用户定调：任何入口切 auto 都过闸门，此前审批路径直切并记
 * 项目默认，绕过了权限菜单的闸门）。
 *
 * onOpenChange 透传下拉开合：面板借它在开/关时锁所在选项行高亮、关时焦点
 * 还卡容器 —— 弹层是 portal，鼠标移入会触发行的 mouseLeave 清高亮，之后
 * 确认钮/Enter 静默无操作（同日修复的交互根因，事件顺序图见 ApprovalPanel）。
 */
import { useState } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { cn } from 'cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { PermissionMode } from '@/env.d'
import { FullAccessConfirm } from './FullAccessConfirm'
import { MODES, ModeItem } from './PermissionMenu'

export function SwitchModeDropdown({
  modes,
  value,
  onSelect,
  onOpenChange,
  onAutoApproved
}: {
  /** 可选档：审批面板列两档放宽模式，方案面板三档（收紧档 plan 两处都不列） */
  modes: readonly PermissionMode[]
  /** 当前档（面板本地 state —— 选档 ≠ 执行，执行走所在选项行） */
  value: PermissionMode
  onSelect: (mode: PermissionMode) => void
  onOpenChange?: (open: boolean) => void
  /** 闸门确认后的动作：缺省 = 纯选档（onSelect('auto')，选完仍要走行级
      「确认」执行）。审批面板传「允许并切换」执行器 —— 那里闸门就是最终
      确认，再悬一步「确认」会造成过完闸门仍不生效的断裂（2026-11-16
      二次修复：用户过完风险闸门以为切完，实际 respond 还没发） */
  onAutoApproved?: () => void
}) {
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)

  const confirmAuto = onAutoApproved ?? (() => onSelect('auto'))

  const select = (mode: PermissionMode): void => {
    // 与权限菜单同一语义：点当前档无操作；非 auto 态选 auto 先过危险确认
    if (mode === value) return
    if (mode === 'auto') {
      setConfirmingFullAccess(true)
      return
    }
    onSelect(mode)
  }

  const TriggerIcon = MODES[value].icon
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          /* 触发器三色随档（权限菜单触发钮同规范）：完全访问 warning 琥珀、
             自主 chrome-accent、收紧档灰；图标即当前档模式图标（曾用灰圆勾
             IconCircleCheckFilled 模仿 zcode 圆点形态，语义不明已废） */
          <span
            role="button"
            tabIndex={0}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] hover:bg-accent-foreground/10',
              value === 'auto'
                ? 'text-warning'
                : value === 'autonomous'
                  ? 'text-chrome-accent'
                  : 'text-muted-foreground'
            )}
          >
            <TriggerIcon className="size-4" strokeWidth={2.25} aria-hidden="true" />
            {MODES[value].label}
            <IconChevronDown className="size-3.5" aria-hidden="true" />
          </span>
        }
        onClick={(event) => event.stopPropagation()}
      />
      {/* min-w 放宽为布局类：两行档位项（名称+说明）比窄触发器宽。
          onClick 拦冒泡：弹层 DOM 挂 portal，但 React 合成事件沿 React 树
          冒泡 —— 本下拉整个嵌在宿主面板的选项行 <button> 里，菜单项的
          click 会冒到行 onClick 误执行整行（「点完全访问却按旧档允许并
          切换」二次 bug 的根因；trigger 的 stopPropagation 只护住它自己） */}
      <DropdownMenuContent align="start" className="min-w-56" onClick={(event) => event.stopPropagation()}>
        {modes.map((mode) => (
          <ModeItem key={mode} mode={mode} current={value} onSelect={select} />
        ))}
      </DropdownMenuContent>
      {/* 闸门同理：AlertDialog 的按钮点击也沿 React 树冒泡到宿主行，
          包一层拦截（div 仅事件用，不参与布局） */}
      <div onClick={(event) => event.stopPropagation()}>
        <FullAccessConfirm
          open={confirmingFullAccess}
          onOpenChange={setConfirmingFullAccess}
          onConfirm={confirmAuto}
        />
      </div>
    </DropdownMenu>
  )
}
