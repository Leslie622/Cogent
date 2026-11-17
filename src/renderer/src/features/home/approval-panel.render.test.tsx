/**
 * ApprovalPanel / PlanPanel 面板测试（形状同 todo-strip.render.test.tsx）——
 * 钉 2026-11-16 修复的交互根因：档位下拉（portal 弹层）交互把选项高亮清成
 * -1 后，确认钮/Enter 静默无操作（修复前 execute(-1) 被可选链吞掉，用户
 * 「点了完全访问却没切换」）。修复 = 下拉开/关锁所在行高亮 + 无选中时确认
 * 钮置灰。respondApproval/respondPlan 以 store action 替身注入（不触 IPC）。
 * 事件用 fireEvent（jsdom 下 userEvent 的 pointer 序列打不开 Base UI 菜单，
 * 见 switch-mode-dropdown.render.test.tsx 头注）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyBucket, useChatStore, type PendingApproval, type PendingPlan } from '@/stores/chat'
import { ApprovalPanel } from './ApprovalPanel'
import { PlanPanel } from './PlanPanel'

const SID = 's-approval'
const initialState = { ...useChatStore.getState() }
beforeEach(() => {
  useChatStore.setState(initialState, true)
})

const approval: PendingApproval = {
  requestId: 'req-approval',
  toolName: 'write_file',
  toolKind: 'write',
  summary: 'write(C:/tmp/demo.txt, content)'
}
const plan: PendingPlan = { requestId: 'req-plan', plan: '1. 做事\n2. 收尾' }

/** 无根会话（sessions 空）：不显「始终允许此工作区」，选项 = 允许 / 允许并
    切换为 / 拒绝 三项，序号稳定 */
const mountApprovalPanel = (): { respondApproval: ReturnType<typeof vi.fn> } => {
  const respondApproval = vi.fn()
  useChatStore.setState({
    activeSessionId: SID,
    sessions: [],
    bySession: { [SID]: { ...emptyBucket(), pendingApprovals: [approval] } },
    respondApproval
  })
  render(<ApprovalPanel />)
  return { respondApproval }
}

describe('ApprovalPanel 档位交互回归钉', () => {
  it('挂载即首项点亮：确认钮可执行，点确认 = 允许这一次', () => {
    const { respondApproval } = mountApprovalPanel()
    const confirm = screen.getByRole('button', { name: '确认' })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(respondApproval).toHaveBeenCalledWith('req-approval', true, undefined)
  })

  it('高亮被清（mouseLeave）→ 确认钮置灰；打开档位下拉 → 锁回所在行，确认钮复活', () => {
    mountApprovalPanel()
    const switcherRow = screen.getByRole('button', { name: /允许，并切换为/ })
    // 鼠标离行清高亮：无可确认项 → 置灰（2026-11-16 用户定调）
    fireEvent.mouseLeave(switcherRow)
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled()
    // 打开档位下拉（portal 弹层在行外，鼠标必经 mouseLeave）→ 开即锁行
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled()
  })

  it('用户路径钉（二次修复）：下拉选完全访问 → 闸门确认 = 允许并切 auto 一步到位，无需再点「确认」', () => {
    const { respondApproval } = mountApprovalPanel()
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    // 危险闸门：勾风险 + 确认启用 —— 即最终确认，直接执行「允许并切换为」
    //（首修版只落本地 state，用户过完闸门以为切完，还悬着行级「确认」没按）
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }))
    // 恰好一次：portal 弹层 click 曾沿 React 树冒泡到宿主行 button 误执行
    // 整行（带着旧档 autonomous 发出「允许并切换」—— 用户「点了完全访问
    // 没切换」的真根因，断言必须数次数而非只查存在）
    expect(respondApproval).toHaveBeenCalledTimes(1)
    expect(respondApproval).toHaveBeenCalledWith('req-approval', true, {
      switchMode: 'auto'
    })
  })

  it('闸门取消 = 不裁决不切档：面板仍在，允许并切换为保持自主模式', () => {
    const { respondApproval } = mountApprovalPanel()
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    // 取消钮的 click 同样被拦在弹层内，不冒泡误执行宿主行
    expect(respondApproval).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '自主模式' })).toBeInTheDocument()
    expect(screen.getByText('需要权限')).toBeInTheDocument()
  })
})

describe('PlanPanel 裁决回归钉', () => {
  it('批准（正交开关 v3：不切档）：确认 → respondPlan(requestId, true) 无 switchMode', () => {
    const respondPlan = vi.fn()
    useChatStore.setState({
      activeSessionId: SID,
      bySession: { [SID]: { ...emptyBucket(), pendingPlans: [plan] } },
      respondPlan
    })
    render(<PlanPanel />)
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(respondPlan).toHaveBeenCalledWith('req-plan', true)
  })
})
