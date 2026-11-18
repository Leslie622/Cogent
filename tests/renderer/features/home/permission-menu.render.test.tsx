/**
 * PermissionMenu 全链路测试（mock IPC）—— 钉「点完全访问没切换」的第二
 * 入口：权限菜单选完全访问 → FullAccessConfirm 闸门 → 确认启用 →
 * session.setPermission IPC 带参发出 → 引擎摘要回流 → 触发钮变完全访问。
 * store 用真实实现（setPermission 的 sessions 更新逻辑一起验证），只替
 * window.cogent.engineRequest（jsdom 无 preload）。事件用 fireEvent（jsdom
 * 下 userEvent 的 pointer 序列打不开 Base UI 菜单，见
 * switch-mode-dropdown.render.test.tsx 头注）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/env.d'
import { useChatStore } from '@/stores/chat'
import { PermissionMenu } from '@/features/home/PermissionMenu'

const SID = 's-perm-menu'
const summary = (mode: SessionSummary['permissionMode']): SessionSummary => ({
  id: SID,
  title: '权限菜单测试会话',
  createdAt: 0,
  updatedAt: 0,
  permissionMode: mode
})

const initialState = { ...useChatStore.getState() }
const engineRequest = vi.fn()
beforeEach(() => {
  useChatStore.setState(initialState, true)
  engineRequest.mockReset()
  window.cogent = { engineRequest } as unknown as typeof window.cogent
})

const mount = (mode: SessionSummary['permissionMode'] = 'ask') => {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: [summary(mode)]
  })
  render(<PermissionMenu session={{ kind: 'chat', chatId: SID }} />)
}

describe('PermissionMenu 完全访问切换全链路', () => {
  it('选完全访问 → 过闸门 → setPermission IPC 带参 → 摘要回流后触发钮变「完全访问」', async () => {
    mount('ask')
    expect(screen.getByRole('button', { name: /权限模式：变更前确认/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))

    // 闸门出现且确认前不发 IPC
    expect(screen.getByText('要启用完全访问吗？')).toBeInTheDocument()
    expect(engineRequest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    engineRequest.mockResolvedValue({ summary: summary('auto') })
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }))

    expect(engineRequest).toHaveBeenCalledWith('session.setPermission', {
      sessionId: SID,
      mode: 'auto'
    })
    // 摘要回流是 setPermission 的 async 续段（await IPC 后才 set），waitFor 等
    // 触发钮翻成完全访问（琥珀警示档名）
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /权限模式：完全访问/ })).toBeInTheDocument()
    )
  })

  it('闸门取消 = 不切档：无 IPC、触发钮保持原档', () => {
    mount('ask')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(engineRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /权限模式：变更前确认/ })).toBeInTheDocument()
  })

  it('已是完全访问再点它 = 无操作不弹闸门', () => {
    mount('auto')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    expect(screen.queryByText('要启用完全访问吗？')).not.toBeInTheDocument()
  })

  it('切回收紧档（ask）无闸门直切', async () => {
    mount('auto')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    engineRequest.mockResolvedValue({ summary: summary('ask') })
    fireEvent.click(screen.getByRole('menuitem', { name: /变更前确认/ }))
    expect(engineRequest).toHaveBeenCalledWith('session.setPermission', {
      sessionId: SID,
      mode: 'ask'
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /权限模式：变更前确认/ })).toBeInTheDocument()
    )
  })
})
