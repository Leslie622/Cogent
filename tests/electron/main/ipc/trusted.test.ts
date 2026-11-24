/** 直接驱动统一入口：登记不等于永久信任，页面/顶层 frame/角色/代次均须匹配。 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { IPC } from '../../../../src/shared/ipc'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) } }))
import { captureCaller, checkCurrentCaller, handleTrusted, isAppDocument, registerTrustedContents } from '../../../../src/electron/main/ipc/trusted'

const url = 'https://cogent.test/index.html'
function page(role: 'main' | 'console' | 'guest' = 'main') {
  let current = url
  const frame = { url, isDestroyed: () => false }
  const emitter = Object.assign(new EventEmitter(), { getURL: () => current, mainFrame: frame, isDestroyed: () => false })
  const contents = emitter as unknown as WebContents
  registerTrustedContents(contents, role, url)
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { emitter, contents, frame, event, navigate: (target: string) => { current = target; frame.url = target } }
}
beforeEach(() => { handlers.clear(); vi.stubEnv('ELECTRON_RENDERER_URL', url) })
afterEach(() => vi.unstubAllEnvs())

it('拒绝未登记页面、iframe 与主窗口导航后的外来文档', async () => {
  const action = vi.fn(() => 'secret')
  handleTrusted(IPC.credentialsGet, action)
  const invoke = handlers.get(IPC.credentialsGet)!
  const main = page()
  await expect(invoke(main.event)).resolves.toBe('secret')
  await expect(invoke({ sender: {}, senderFrame: {} })).rejects.toThrow('未获授权')
  await expect(invoke({ sender: main.contents, senderFrame: {} })).rejects.toThrow('未获授权')
  main.navigate('https://foreign.test/')
  await expect(invoke(main.event)).rejects.toThrow('未获授权')
  expect(action).toHaveBeenCalledOnce()
})

it('控制台可读观测，不能读取密钥或修改会话', async () => {
  const consolePage = page('console')
  handleTrusted(IPC.credentialsGet, vi.fn())
  handleTrusted(IPC.engineRequest, (_event, payload: { method: string }) => payload.method)
  await expect(handlers.get(IPC.credentialsGet)!(consolePage.event)).rejects.toThrow('未获授权')
  await expect(handlers.get(IPC.engineRequest)!(consolePage.event, { method: 'inspect.entries' })).resolves.toBe('inspect.entries')
  await expect(handlers.get(IPC.engineRequest)!(consolePage.event, { method: 'session.delete' })).rejects.toThrow('无权')
})

it('同 URL 重载使在途请求和异步写入失效', async () => {
  const main = page()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const write = vi.fn()
  handleTrusted(IPC.settingsSave, async () => { await wait; checkCurrentCaller(); write() })
  const pending = handlers.get(IPC.settingsSave)!(main.event)
  const assertion = expect(pending).rejects.toThrow('文档已失效')
  main.emitter.emit('did-start-navigation', {}, url, false, true)
  release()
  await assertion
  expect(write).not.toHaveBeenCalled()
  expect(() => captureCaller(main.event, ['main'])).not.toThrow()
})

it('不允许外来导航与重定向，demo 精确匹配具体页面', () => {
  const main = page()
  const preventDefault = vi.fn()
  main.emitter.emit('will-frame-navigate', { url: 'https://foreign.test/', isMainFrame: true, preventDefault })
  main.emitter.emit('will-redirect', { preventDefault }, 'https://foreign.test/', false, true)
  expect(preventDefault).toHaveBeenCalledTimes(2)
  expect(isAppDocument('https://cogent.test/demo.html', 'demo.html')).toBe(true)
  for (const target of ['https://cogent.test/sub/demo.html', 'https://foreign.test/demo.html', 'file:///tmp/demo.html', 'https://cogent.test/demo.html?other'])
    expect(isAppDocument(target, 'demo.html')).toBe(false)
})
