/** 原生目录选择是HTML资源授权唯一扩大入口；迟到选择不能跨网页生命周期提交。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { BrowserIpcDeps } from '../../../../src/electron/main/ipc/browser'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>>(), pick: vi.fn(), state: vi.fn(), localPreview: vi.fn(), resolve: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: (name: string, handler: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) => mocks.handlers.set(name, handler) }, dialog: { showOpenDialog: mocks.pick } }))
vi.mock('../../../../src/electron/main/browser/runtime', () => ({ installBrowserRuntime: () => ({ state: mocks.state, localPreviewSource: mocks.localPreview }) }))
import { registerBrowserIpc } from '../../../../src/electron/main/ipc/browser'
const frame = {}, sender = { mainFrame: frame }, event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
beforeEach(() => {
  vi.resetAllMocks(); mocks.handlers.clear(); mocks.state.mockReturnValue({ lease: 'browser' }); mocks.resolve.mockResolvedValue({ kind: 'current' }); mocks.localPreview.mockResolvedValue({ lease: 'browser', url: '' })
  registerBrowserIpc({ host: { getHttpPort: () => 19000 }, getWindow: () => ({ webContents: sender }), resolveBrowserPreview: mocks.resolve } as unknown as BrowserIpcDeps)
})
describe('HTML资源目录IPC', () => {
  it('只传递原生选择的目录，renderer伪造路径被剥除', async () => {
    mocks.pick.mockResolvedValue({ canceled: false, filePaths: ['C:/trusted/site'] })
    await mocks.handlers.get('cogent:browser:request')!(event, { method: 'preview', params: { lease: 'browser', source: { leaseId: 'file' }, pickRoot: true, selectedRoot: 'C:/private' } })
    expect(mocks.pick).toHaveBeenCalledWith(expect.anything(), { title: '选择HTML资源目录', properties: ['openDirectory'] })
    expect(mocks.resolve).toHaveBeenCalledWith({ leaseId: 'file' }, 'C:/trusted/site')
  })
  it('取消选择不重载网页或重新创建文件授权', async () => {
    mocks.pick.mockResolvedValue({ canceled: true, filePaths: [] })
    await mocks.handlers.get('cogent:browser:request')!(event, { method: 'preview', params: { lease: 'browser', source: { leaseId: 'file' }, pickRoot: true } })
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.localPreview).not.toHaveBeenCalled()
  })
  it('选择框跨关页迟到时不向Host扩大资源授权', async () => {
    let finish!: (value: unknown) => void
    mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = mocks.handlers.get('cogent:browser:request')!(event, { method: 'preview', params: { lease: 'browser', source: { leaseId: 'file' }, pickRoot: true } })
    await vi.waitFor(() => expect(mocks.pick).toHaveBeenCalled())
    mocks.state.mockImplementation(() => { throw new Error('网页标签已关闭') }); finish({ canceled: false, filePaths: ['C:/late'] })
    await expect(pending).rejects.toThrow('已关闭'); expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
