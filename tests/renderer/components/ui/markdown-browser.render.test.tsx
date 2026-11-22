/** 网页链接保持系统浏览器默认行为，内置入口显式归属打开它的工作区。 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/ui/markdown'
import { FileLinkContext, type FileLinkScope } from '@/features/home/files/FileLink'
import { useWorkspaceStore } from '@/stores/workspace'

beforeEach(() => { useWorkspaceStore.getState().reset(); useWorkspaceStore.getState().setScope('current-chat') })
afterEach(() => { useWorkspaceStore.getState().reset(); vi.restoreAllMocks() })
const renderLink = (scope: FileLinkScope, href = 'https://example.com/docs') => render(<FileLinkContext.Provider value={scope}><Markdown content={`[参考网页](${href})`} /></FileLinkContext.Provider>)

describe('Markdown 网页打开入口', () => {
  it('默认点击仍使用系统浏览器，不创建内置标签', () => {
    const external = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderLink({ sessionId: 'current-chat', refs: [] })
    fireEvent.click(screen.getByRole('link', { name: '参考网页' }))
    expect(external).toHaveBeenCalledWith('https://example.com/docs')
    expect(useWorkspaceStore.getState().scopes['current-chat'].tabs).toEqual([])
  })

  it('右键内置入口打开正文来源会话，保留另一会话已开的标签', async () => {
    const external = vi.spyOn(window, 'open').mockImplementation(() => null)
    const existing = useWorkspaceStore.getState().newTab()
    renderLink({ sessionId: 'source-chat', refs: [] })
    fireEvent.contextMenu(screen.getByRole('link', { name: '参考网页' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '内置浏览器打开' }))
    const state = useWorkspaceStore.getState()
    expect(state.activeScopeId).toBe('source-chat')
    expect(state.scopes['source-chat'].tabs).toEqual([expect.objectContaining({ kind: 'browser', url: 'https://example.com/docs', scopeId: 'source-chat' })])
    expect(state.scopes['current-chat'].tabs.map(tab => tab.id)).toEqual([existing])
    expect(external).not.toHaveBeenCalled()
  })

  it('预览中的网页优先归属当前查看工作区，协议相对地址补 HTTPS', async () => {
    renderLink({ sessionId: 'file-origin-chat', workspaceScopeId: 'draft:preview', refs: [] }, '//example.com/docs')
    fireEvent.contextMenu(screen.getByRole('link', { name: '参考网页' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '内置浏览器打开' }))
    expect(useWorkspaceStore.getState().activeScopeId).toBe('draft:preview')
    expect(useWorkspaceStore.getState().scopes['draft:preview'].tabs[0]).toMatchObject({ kind: 'browser', url: 'https://example.com/docs' })
    expect(useWorkspaceStore.getState().scopes['file-origin-chat']).toBeUndefined()
  })
})
