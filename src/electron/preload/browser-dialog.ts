/** 普通网页唯一 preload：只替换不被 Electron 原生支持的 prompt，不暴露应用 SDK。 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__cogentBrowserPrompt', (kind: 'alert' | 'confirm' | 'prompt', message: string, defaultValue = ''): string | null => {
  const value: unknown = ipcRenderer.sendSync('cogent:browser:prompt', { kind, message: String(message).slice(0, 10000), defaultValue: String(defaultValue).slice(0, 10000) })
  return typeof value === 'string' ? value : null
})
contextBridge.executeInMainWorld({ func: () => {
  const page = globalThis as unknown as { __cogentBrowserPrompt: (kind: 'alert' | 'confirm' | 'prompt', message: string, defaultValue: string) => string | null; prompt: (message?: string, defaultValue?: string) => string | null; alert: (message?: string) => void; confirm: (message?: string) => boolean }
  const bridge = page.__cogentBrowserPrompt
  page.prompt = (message = '', defaultValue = '') => bridge('prompt', String(message), String(defaultValue))
  page.alert = (message = '') => { bridge('alert', String(message), '') }
  page.confirm = (message = '') => bridge('confirm', String(message), '') !== null
  Reflect.deleteProperty(page, '__cogentBrowserPrompt')
} })
