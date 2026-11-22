/** 真实注册器验证能力只属于主窗口顶层帧，renderer无法自带windowId/路径扩大授权。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { EventEmitter } from 'node:events'
import type { IpcDeps } from '../../../../src/electron/main/ipc'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>(), open: vi.fn(), save: vi.fn(), shell: vi.fn().mockResolvedValue(''), copy: vi.fn(), writeSettings: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>) => mocks.handlers.set(name, callback) }, dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save }, shell: { openPath: mocks.shell, showItemInFolder: vi.fn() } }))
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), copyFile: mocks.copy }))
vi.mock('../../../../src/electron/main/ipc/settings', () => ({ readSettingsFile: () => ({ version: 1 }), writeSettingsFile: mocks.writeSettings }))
import { registerFileViewsIpc } from '../../../../src/electron/main/ipc/file-views'
import { FileViewGrants } from '../../../../src/electron/main/file-views/grants'
const frame = {}; const sender = Object.assign(new EventEmitter(), { id: 11, mainFrame: frame })
const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
const request = vi.fn()
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); sender.removeAllListeners(); mocks.handlers.clear(); request.mockResolvedValue({ ok: true }); registerFileViewsIpc({ host: { request }, getWindow: () => ({ webContents: sender }) } as unknown as IpcDeps) })
describe('文件视图IPC边界', () => {
  it('guest/iframe在Host请求前就被拒绝', async () => {
    const invoke = mocks.handlers.get('fileViews:request')!
    for (const untrusted of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: {} }]) await expect(invoke(untrusted as IpcMainInvokeEvent, { method: 'fileViews.acquire', params: { source: { kind: 'session', sessionId: 's', rawTarget: '/x' }, operationId: 'op' } })).rejects.toThrow('主窗口顶层')
    expect(request).not.toHaveBeenCalled()
  })
  it('内部方法不能转发，合法调用的windowId由main覆盖', async () => {
    const invoke = mocks.handlers.get('fileViews:request')!
    await expect(invoke(event, { method: 'fileViews.registerContext', params: { roots: [{ path: 'C:/private' }] } })).rejects.toThrow('白名单')
    await invoke(event, { method: 'fileViews.release', params: { windowId: 999, leaseId: 'lease' } })
    expect(request).toHaveBeenCalledWith('fileViews.release', { windowId: 11, windowEpoch: 0, leaseId: 'lease' })
  })
  it('项目根从Host当前项目求值，不采纳renderer传入的roots', async () => {
    request.mockImplementation((method: string, params: unknown) => Promise.resolve(method === 'project.list' ? [{ id: 'p', cwds: ['C:/trusted'] }] : { contextId: 'ctx', roots: (params as { roots: unknown }).roots }))
    const result = await mocks.handlers.get('fileViews:request')!(event, { method: 'fileViews.openContext', params: { scopeId: 'draft', projectId: 'p', roots: ['C:/untrusted'] } })
    expect(result).toMatchObject({ roots: [{ path: 'C:/trusted' }] })
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('重载与崩溃推进代次，新请求等待Host清理ACK，iframe或页内导航不推进', async () => {
    const invoke = mocks.handlers.get('fileViews:request')!
    await invoke(event, { method: 'fileViews.release', params: { leaseId: 'old' } })
    sender.emit('did-start-navigation', {}, '/frame', false, false)
    sender.emit('did-start-navigation', {}, '/#anchor', true, true)
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.resetWindow')).toHaveLength(0)
    let ready!: () => void
    request.mockImplementation((method: string) => method === 'fileViews.resetWindow' ? new Promise<void>(resolve => { ready = resolve }) : Promise.resolve({ ok: true }))
    sender.emit('did-start-navigation', {}, '/app', false, true)
    const pending = invoke(event, { method: 'fileViews.release', params: { leaseId: 'new', windowEpoch: 900 } })
    await Promise.resolve()
    expect(request).not.toHaveBeenCalledWith('fileViews.release', expect.objectContaining({ leaseId: 'new' }))
    ready(); await pending
    expect(request).toHaveBeenCalledWith('fileViews.release', { windowId: 11, windowEpoch: 1, leaseId: 'new' })
    request.mockResolvedValue({ ok: true }); sender.emit('render-process-gone')
    await invoke(event, { method: 'fileViews.release', params: { leaseId: 'recovered' } })
    expect(request).toHaveBeenCalledWith('fileViews.release', { windowId: 11, windowEpoch: 2, leaseId: 'recovered' })
  })
  it('重载前项目查询的迟到结果不再登记context', async () => {
    let finish!: (value: unknown) => void
    request.mockImplementation((method: string) => method === 'project.list' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true }))
    const pending = mocks.handlers.get('fileViews:request')!(event, { method: 'fileViews.openContext', params: { scopeId: 'draft', projectId: 'p' } })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    sender.emit('did-start-navigation', {}, '/app', false, true)
    finish([{ id: 'p', cwds: ['C:/trusted'] }])
    await expect(pending).rejects.toThrow('重载')
    expect(request.mock.calls.some(([method]) => method === 'fileViews.registerContext')).toBe(false)
  })
  it('重载前的文件选择框迟到不写授权、不登记新上下文', async () => {
    let finish!: (value: unknown) => void
    mocks.open.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const add = vi.spyOn(FileViewGrants.prototype, 'add')
    const pending = mocks.handlers.get('fileViews:request')!(event, { method: 'fileViews.openContext', params: { scopeId: 'draft', pick: 'file' } })
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled())
    sender.emit('render-process-gone'); finish({ canceled: false, filePaths: ['C:/late.txt'] })
    await expect(pending).rejects.toThrow('重载')
    expect(add).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([method]) => method === 'fileViews.registerContext')).toBe(false)
  })
  it.each(['save', 'editor'])('重载前的%s对话框迟到不复制文件或保存编辑器设置', async action => {
    let finish!: (value: unknown) => void
    request.mockResolvedValue({ path: 'C:/source.txt', name: 'source.txt', kind: 'text' })
    const dialog = action === 'save' ? mocks.save : mocks.open
    dialog.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = mocks.handlers.get('fileViews:request')!(event, { method: 'fileViews.action', params: { leaseId: 'old', action } })
    await vi.waitFor(() => expect(dialog).toHaveBeenCalled())
    sender.emit('did-start-navigation', {}, '/app', false, true)
    finish({ canceled: false, filePath: 'C:/dest.txt', filePaths: ['C:/editor.exe'] })
    await expect(pending).rejects.toThrow('重载')
    expect(mocks.copy).not.toHaveBeenCalled(); expect(mocks.writeSettings).not.toHaveBeenCalled()
  })
  it('Host原生目标的迟到响应不触发open，reset内部方法不对renderer开放', async () => {
    const invoke = mocks.handlers.get('fileViews:request')!
    await expect(invoke(event, { method: 'fileViews.resetWindow', params: { windowEpoch: 88 } })).rejects.toThrow('白名单')
    let finish!: (value: unknown) => void
    request.mockImplementation((method: string) => method === 'fileViews.actionTarget' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true }))
    const pending = invoke(event, { method: 'fileViews.action', params: { leaseId: 'old', action: 'open' } })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    sender.emit('render-process-gone'); finish({ path: 'C:/late.txt', kind: 'text' })
    await expect(pending).rejects.toThrow('重载'); expect(mocks.shell).not.toHaveBeenCalled()
  })
})
