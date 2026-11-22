/** 工作区跨运行不保存；旧专用库只清理，不让启动迁移影响本次新开的标签。 */
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFilePreviewStore } from '@/stores/file-preview'
import { clearLegacyWorkspaceCache } from '@/features/workspace/legacy-cache'

async function seedDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('state').put({ tabs: ['old-secret.pdf'], collapsed: false, url: 'https://old.test' }, 'workspace')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('测试数据库打开失败'))
  })
}

beforeEach(() => {
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  vi.stubGlobal('indexedDB', new IDBFactory())
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
})
afterEach(() => {
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('工作区仅保留运行期内存', () => {
  it('启动只清理旧标签库，不读取旧标签，不清理其他数据库或本次新开的页', async () => {
    const old = await seedDatabase('cogent-workspace'), other = await seedDatabase('unrelated-app')
    old.close(); other.close()
    const open = vi.spyOn(indexedDB, 'open')
    const store = useWorkspaceStore.getState()
    store.setScope('fresh')
    const id = store.openBrowser('https://current.test')
    await clearLegacyWorkspaceCache()
    expect(open).not.toHaveBeenCalled()
    expect((await indexedDB.databases()).map(database => database.name)).toEqual(['unrelated-app'])
    expect(useWorkspaceStore.getState().scopes.fresh.tabs.map(tab => tab.id)).toEqual([id])
  })

  it('切会话、布局、关闭历史和阅读状态只在内存变化，重置后为空且收起', async () => {
    await clearLegacyWorkspaceCache()
    const open = vi.spyOn(indexedDB, 'open'), store = useWorkspaceStore.getState()
    store.setScope('session')
    const file = store.openFile({ scope: { sessionId: 'session', refs: [] }, target: '/work/report.pdf' }, 'session')
    useFilePreviewStore.getState().setView(file, { page: 4, scrollTop: 333, zoom: 1.5 })
    store.setLayout({ width: 600, expanded: true })
    store.setScope('other'); store.setScope('session')
    expect(useWorkspaceStore.getState().scopes.session.tabs[0].id).toBe(file)
    expect(useFilePreviewStore.getState().views[file].page).toBe(4)
    store.remove(file)
    expect(useWorkspaceStore.getState().recent).toHaveLength(1)
    expect(store.reopen()?.title).toBe('report.pdf')
    expect(open).not.toHaveBeenCalled()
    expect(await indexedDB.databases()).toEqual([])
    useFilePreviewStore.getState().resetAll(); store.reset(); store.setScope('session')
    expect(useWorkspaceStore.getState().scopes.session).toMatchObject({ tabs: [], collapsed: true, activeId: null })
    expect(useWorkspaceStore.getState().recent).toEqual([])
    expect(useFilePreviewStore.getState().views).toEqual({})
  })

  it('旧库被占用时明确报错，不读取旧内容或阻止内存工作区使用', async () => {
    const held = await seedDatabase('cogent-workspace')
    try {
      await expect(clearLegacyWorkspaceCache()).rejects.toThrow('另一个窗口占用')
      useWorkspaceStore.getState().setScope('fresh')
      expect(useWorkspaceStore.getState().scopes.fresh).toMatchObject({ tabs: [], collapsed: true })
    } finally { held.close() }
  })
})
