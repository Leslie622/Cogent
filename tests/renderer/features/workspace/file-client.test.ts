/** 恢复仅持久化来源；相对链接临时重建父租约，完成、失败和取消均须释放。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileViewContext, FileViewLease, FileViewSource } from '@shared/file-views'
import { acquireFile, cancelFileOperation, releaseFile, restoreFileSource } from '@/features/workspace/file-client'
import { releaseFileNavigatorScope } from '@/features/workspace/file-navigator-owner'
import { useWorkspaceStore, type FileTabSource } from '@/stores/workspace'

const scopeId = 'draft:file-client-recovery'
const sessionScope = { sessionId: 'chat-recovery', refs: [] }
const parent: FileTabSource = { scope: sessionScope, target: 'C:/project/readme.md' }
const childScope = { ...sessionScope, parentSource: parent }
const context = (contextId = 'recovered-context'): FileViewContext => ({ contextId, generation: 2, roots: [], selectedPaths: [], grantIds: ['saved-grant'], canceled: false })
const lease = (leaseId: string): FileViewLease => ({
  leaseId, canonicalKey: leaseId, ownerId: 'owner',
  descriptor: { fileId: leaseId, serviceId: 'host', path: `C:/project/${leaseId}.md`, name: `${leaseId}.md`, kind: 'markdown', mime: 'text/markdown', size: 10, version: '1', source: 'saved' }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function bridge(dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const request = vi.fn(dispatch)
  window.cogent = { fileViewsRequest: request } as unknown as typeof window.cogent
  return request
}

beforeEach(() => {
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope(scopeId, 'project-recovery')
  useWorkspaceStore.getState().setGrants(scopeId, ['saved-grant'])
})
afterEach(async () => {
  await releaseFileNavigatorScope(scopeId)
  useWorkspaceStore.getState().reset()
})

describe('文件来源恢复与父租约生命周期', () => {
  it('重建失效 Markdown 父来源，子文件等待时保留临时父租约，完成后只释放父租约', async () => {
    const child = deferred<FileViewLease>()
    const request = bridge((method, params) => {
      if (method === 'fileViews.acquire') return (params.source as FileViewSource).kind === 'session' && (params.source as { rawTarget: string }).rawTarget === parent.target ? Promise.resolve(lease('parent')) : child.promise
      return Promise.resolve({ ok: true })
    })
    const acquired = acquireFile(childScope, './child.md', 'recover-child')
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('fileViews.acquire', {
      source: { kind: 'session', sessionId: 'chat-recovery', rawTarget: './child.md', relativeTo: 'parent' }, operationId: 'recover-child'
    }))
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.release')).toEqual([])
    child.resolve(lease('child'))
    await expect(acquired).resolves.toEqual(lease('child'))
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.release')).toEqual([['fileViews.release', { leaseId: 'parent' }]])
    await releaseFile('child')
    expect(request).toHaveBeenLastCalledWith('fileViews.release', { leaseId: 'child' })
  })

  it('相对目标仍不存在时显示原错误并释放临时父租约', async () => {
    const missing = new Error('相对文件仍不存在')
    const request = bridge((method, params) => {
      if (method === 'fileViews.acquire') return (params.source as { rawTarget: string }).rawTarget === parent.target ? Promise.resolve(lease('parent')) : Promise.reject(missing)
      return Promise.resolve({ ok: true })
    })
    await expect(acquireFile(childScope, './missing.md', 'missing-child')).rejects.toBe(missing)
    expect(request).toHaveBeenLastCalledWith('fileViews.release', { leaseId: 'parent' })
  })

  it('取消子获取沿用同一个操作 ID，子请求退出后仍释放临时父租约', async () => {
    const child = deferred<FileViewLease>()
    const canceled = new Error('文件操作已取消')
    const request = bridge((method, params) => {
      if (method === 'fileViews.acquire') return (params.source as { rawTarget: string }).rawTarget === parent.target ? Promise.resolve(lease('parent')) : child.promise
      if (method === 'fileViews.cancel') child.reject(canceled)
      return Promise.resolve({ ok: true })
    })
    const acquired = acquireFile(childScope, './child.md', 'cancel-child')
    const rejected = expect(acquired).rejects.toBe(canceled)
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'fileViews.acquire')).toHaveLength(2))
    await cancelFileOperation('cancel-child')
    await rejected
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.acquire').every(([, params]) => params.operationId === 'cancel-child')).toBe(true)
    expect(request).toHaveBeenLastCalledWith('fileViews.release', { leaseId: 'parent' })
  })

  it('父来源重建失败不请求子文件，也不释放未创建的租约', async () => {
    const denied = new Error('父文档无权访问')
    const request = bridge(() => Promise.reject(denied))
    await expect(acquireFile(childScope, './child.md', 'denied-parent')).rejects.toBe(denied)
    expect(request.mock.calls).toEqual([['fileViews.acquire', {
      source: { kind: 'session', sessionId: 'chat-recovery', rawTarget: parent.target, relativeTo: undefined }, operationId: 'denied-parent'
    }]])
  })

  it('仍有效的父租约优先使用，调用方保有其生命周期', async () => {
    const request = bridge(() => Promise.resolve(lease('child')))
    await expect(acquireFile({ ...childScope, relativeTo: 'live-parent' }, './child.md', 'live-child')).resolves.toEqual(lease('child'))
    expect(request.mock.calls).toEqual([['fileViews.acquire', {
      source: { kind: 'session', sessionId: 'chat-recovery', rawTarget: './child.md', relativeTo: 'live-parent' }, operationId: 'live-child'
    }]])
  })

  it('嵌套相对来源逐层重建，释放祖先时不提前释放仍在使用的直接父文件', async () => {
    const directParent: FileTabSource = { scope: childScope, target: './sub/readme.md' }
    const request = bridge((method, params) => {
      if (method === 'fileViews.acquire') {
        const source = params.source as Extract<FileViewSource, { kind: 'session' }>
        return Promise.resolve(lease(source.rawTarget === parent.target ? 'ancestor' : source.rawTarget === directParent.target ? 'parent' : 'child'))
      }
      return Promise.resolve({ ok: true })
    })
    await expect(acquireFile({ ...sessionScope, parentSource: directParent }, './child.md', 'nested-child')).resolves.toEqual(lease('child'))
    const calls = request.mock.calls
    expect(calls.map(([method, params]) => method === 'fileViews.acquire' ? ['acquire', (params.source as { rawTarget: string; relativeTo?: string }).rawTarget, (params.source as { relativeTo?: string }).relativeTo] : ['release', params.leaseId])).toEqual([
      ['acquire', parent.target, undefined], ['acquire', directParent.target, 'ancestor'], ['release', 'ancestor'], ['acquire', './child.md', 'parent'], ['release', 'parent']
    ])
  })

  it('HTML 恢复使用原工作区授权重新打开上下文，不把 restore 发送到获取接口', async () => {
    const request = bridge((method) => Promise.resolve(method === 'fileViews.openContext' ? context() : method === 'fileViews.acquire' ? lease('html') : { ok: true }))
    const source: FileTabSource = { scope: { contextId: 'restore', refs: [], workspaceScopeId: scopeId }, target: 'C:/project/index.html' }
    const restored = await restoreFileSource(source, scopeId)
    await expect(acquireFile(restored.scope, restored.target, 'restore-html')).resolves.toEqual(lease('html'))
    expect(request).toHaveBeenCalledWith('fileViews.openContext', { scopeId, projectId: 'project-recovery', grantIds: ['saved-grant'] })
    expect(request).toHaveBeenCalledWith('fileViews.acquire', { source: { kind: 'context', contextId: 'recovered-context', path: source.target, relativeTo: undefined }, operationId: 'restore-html' })
    expect(source.scope.contextId).toBe('restore')
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(1)
  })

  it('恢复失败的目录 Markdown 相对链接共享重新授权的上下文和临时父租约', async () => {
    const directoryParent: FileTabSource = { scope: { contextId: 'restore', refs: [], workspaceScopeId: scopeId }, target: 'C:/project/readme.md' }
    const request = bridge((method, params) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.acquire') return Promise.resolve(lease((params.source as { path: string }).path === directoryParent.target ? 'parent' : 'child'))
      return Promise.resolve({ ok: true })
    })
    await expect(acquireFile({ ...directoryParent.scope, parentSource: directoryParent }, './child.md', 'restore-directory-child')).resolves.toEqual(lease('child'))
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('fileViews.acquire', { source: { kind: 'context', contextId: 'recovered-context', path: './child.md', relativeTo: 'parent' }, operationId: 'restore-directory-child' })
    expect(request).toHaveBeenLastCalledWith('fileViews.release', { leaseId: 'parent' })
  })

  it('上下文授权失败保留可操作错误，不退回陈旧上下文获取文件', async () => {
    const request = bridge(() => Promise.reject(new Error('保存的目录授权已失效')))
    await expect(acquireFile({ contextId: 'restore', refs: [], workspaceScopeId: scopeId }, 'C:/project/index.html', 'failed-html')).rejects.toThrow('保存的目录授权已失效')
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.acquire')).toEqual([])
  })
})
