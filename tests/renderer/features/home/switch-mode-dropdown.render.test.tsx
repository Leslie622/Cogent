/**
 * SwitchModeDropdown 组件测试（形状同 todo-strip.render.test.tsx）—— 钉
 * 2026-11-16 修复的两件事：档位下拉与权限菜单同源视觉（模式图标 + 当前档
 * 右侧勾 + 完全访问 warning 琥珀变体；修复前是纯文字项 + 黑色实心圆勾选中
 * 标记）；选「完全访问」先过 FullAccessConfirm 危险闸门（修复前审批路径
 * 直切并记项目默认，绕过权限菜单的闸门）。
 *
 * 事件全用 fireEvent 而非 userEvent：Base UI 菜单触发器监听 mousedown 打开，
 * jsdom 下 userEvent 的 pointerdown 前置序列反而不触发（fireEvent.click 直开，
 * 调试实录见修复当日记录）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SwitchModeDropdown } from '@/features/home/SwitchModeDropdown'

/** 审批面板的两档放宽（最小档集；三档形态同理由 ModeItem 共用保证） */
const MODES = ['autonomous', 'auto'] as const

const setup = (value: (typeof MODES)[number] = 'autonomous') => {
  const onSelect = vi.fn()
  render(<SwitchModeDropdown modes={MODES} value={value} onSelect={onSelect} />)
  return { onSelect }
}

const openMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /自主模式/ }))
}

describe('SwitchModeDropdown 档位下拉', () => {
  it('触发器显当前档模式图标 + 档名：自主模式为 chrome-accent 蓝，完全访问为 warning 琥珀', () => {
    const { rerender } = render(
      <SwitchModeDropdown modes={MODES} value="autonomous" onSelect={vi.fn()} />
    )
    const autonomousTrigger = screen.getByRole('button', { name: /自主模式/ })
    expect(autonomousTrigger.className).toContain('text-chrome-accent')
    expect(autonomousTrigger.querySelector('svg')).not.toBeNull()

    rerender(<SwitchModeDropdown modes={MODES} value="auto" onSelect={vi.fn()} />)
    const autoTrigger = screen.getByRole('button', { name: /完全访问/ })
    expect(autoTrigger.className).toContain('text-warning')
  })

  it('下拉项 = 模式图标 + 名称 + 说明 + 当前档右侧勾；完全访问项带 warning 变体（视觉同源钉）', () => {
    setup('autonomous')
    openMenu()

    const items = screen.getAllByRole('menuitem')
    // 两档放宽，渲染序 = SWITCH_MODES：自主模式（当前，带右侧勾）+ 完全访问
    // （危险组 warning 变体）。innerHTML 断言避开 textContent 的 string|null 判空
    const [autonomousItem, autoItem] = items
    expect(autoItem).toHaveAttribute('data-variant', 'warning')
    expect(autoItem.innerHTML).toContain('无需确认，直接执行写操作')
    expect(autonomousItem.innerHTML).toContain('自动修改文件；命令执行前询问')
    // 当前档右侧勾：选中项比未选档多一枚图标（模式图标 + 勾）
    expect(autonomousItem.querySelectorAll('svg').length).toBeGreaterThan(
      autoItem.querySelectorAll('svg').length
    )
  })

  it('选「完全访问」不直切：先弹危险闸门，勾风险并确认启用后才 onSelect(auto)', () => {
    const { onSelect } = setup('autonomous')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))

    // 闸门出现且未确认前不落档
    expect(screen.getByText('要启用完全访问吗？')).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }))
    expect(onSelect).toHaveBeenCalledWith('auto')
  })

  it('传 onAutoApproved（审批面板场景）：闸门确认走执行器且不落 onSelect', () => {
    const onSelect = vi.fn()
    const onAutoApproved = vi.fn()
    render(
      <SwitchModeDropdown
        modes={MODES}
        value="autonomous"
        onSelect={onSelect}
        onAutoApproved={onAutoApproved}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }))
    expect(onAutoApproved).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalledWith('auto')
  })

  it('闸门取消 = 不切档（无 onSelect）', () => {
    const { onSelect } = setup('autonomous')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('点当前档 = 无操作（不发同值 onSelect —— 权限菜单同语义）', () => {
    const { onSelect } = setup('autonomous')
    openMenu()
    // menuitem 的 accessible name 含次行说明，用子串匹配
    fireEvent.click(screen.getByRole('menuitem', { name: /自主模式/ }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('非危险档直选不弹闸门：三档形态下选 ask → 直接 onSelect', () => {
    const onSelect = vi.fn()
    render(
      <SwitchModeDropdown
        modes={['autonomous', 'auto', 'ask']}
        value="autonomous"
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /变更前确认/ }))
    expect(onSelect).toHaveBeenCalledWith('ask')
    expect(screen.queryByText('要启用完全访问吗？')).not.toBeInTheDocument()
  })
})
