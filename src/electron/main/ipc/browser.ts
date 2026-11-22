/** 主窗口顶层的浏览器白名单；网页和子 frame 无权请求 lease 或桌面文件资源。 */
import { dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { BROWSER_CHANNEL, type BrowserMethod } from '../../../shared/browser'
import { installBrowserRuntime } from '../browser/runtime'
import type { BrowserPreviewSource } from '../browser/local-preview'
import type { IpcDeps } from './index'

const id = z.string().min(1).max(4096)
const lease = z.object({ lease: id })
const entry = z.object({ url: z.string().max(16384), title: z.string().max(4096) })
const schemas = {
  reserve: z.object({ scopeId: id, tabId: id, privateGroupId: id.optional() }),
  attach: lease.extend({ webContentsId: z.number().int().positive() }),
  navigate: lease.extend({ url: z.string().max(16384) }),
  back: lease, forward: lease, reload: lease, stop: lease, close: lease, release: lease,
  visibility: lease.extend({ active: z.boolean() }),
  find: lease.extend({ text: z.string().max(4096), forward: z.boolean().optional(), findNext: z.boolean().optional() }),
  zoom: lease.extend({ factor: z.number().min(0.25).max(5) }),
  history: lease,
  goTo: lease.extend({ index: z.number().int().min(0) }),
  preferences: lease.extend({ search: z.enum(['bing', 'google', 'duckduckgo']).optional() }),
  restore: lease.extend({ entries: z.array(entry).min(1).max(500), index: z.number().int().min(0) }).refine(value => value.index < value.entries.length),
  permissions: lease,
  permission: lease.extend({ origin: z.string().url(), permission: id, mediaTypes: z.array(z.enum(['audio', 'video'])).min(1).max(2).optional(), decision: z.enum(['ask', 'allow', 'deny']) }),
  downloads: lease,
  download: lease.extend({ id, action: z.enum(['cancel', 'pause', 'resume', 'open', 'reveal']) }),
  clearData: lease.extend({ all: z.boolean() }), external: lease,
  preview: lease.extend({ source: z.object({ leaseId: id }), pickRoot: z.boolean().optional() }),
  promptReply: lease.extend({ requestId: id, value: z.string().max(100000).nullable() })
} satisfies Record<BrowserMethod, z.ZodType>

export interface BrowserIpcDeps extends IpcDeps {
  resolveBrowserPreview?: (source: { leaseId: string }, selectedRoot?: string) => Promise<BrowserPreviewSource>
}
export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  const runtime = installBrowserRuntime({ getProtectedPorts: () => { const port = deps.host.getHttpPort(); return port === undefined ? [] : [port] } })
  ipcMain.on('cogent:browser:prompt', (event, raw: unknown) => {
    const parsed = z.object({ kind: z.enum(['prompt', 'alert', 'confirm']).default('prompt'), message: z.string().max(10000), defaultValue: z.string().max(10000) }).safeParse(raw)
    if (!parsed.success) { event.returnValue = null; return }
    runtime.prompt(event, parsed.data.message, parsed.data.defaultValue, parsed.data.kind)
  })
  ipcMain.handle(BROWSER_CHANNEL.request, async (event, raw: unknown) => {
    const window = deps.getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('浏览器操作仅允许主窗口顶层页面')
    const request = z.object({ method: z.string(), params: z.unknown() }).parse(raw)
    if (!Object.hasOwn(schemas, request.method)) throw new Error('未知浏览器操作')
    const owner = event.sender
    switch (request.method as BrowserMethod) {
      case 'reserve': return runtime.reserve(owner, schemas.reserve.parse(request.params))
      case 'attach': { const p = schemas.attach.parse(request.params); return runtime.attach(owner, p.lease, p.webContentsId) }
      case 'navigate': { const p = schemas.navigate.parse(request.params); return runtime.navigate(owner, p.lease, p.url) }
      case 'back': case 'forward': case 'reload': case 'stop': return runtime.command(owner, lease.parse(request.params).lease, request.method as 'back' | 'forward' | 'reload' | 'stop')
      case 'visibility': { const p = schemas.visibility.parse(request.params); return runtime.visibility(owner, p.lease, p.active) }
      case 'close': return runtime.close(owner, lease.parse(request.params).lease)
      case 'release': return runtime.release(owner, lease.parse(request.params).lease)
      case 'find': { const p = schemas.find.parse(request.params); return runtime.find(owner, p.lease, p.text, p.forward, p.findNext) }
      case 'zoom': { const p = schemas.zoom.parse(request.params); return runtime.zoom(owner, p.lease, p.factor) }
      case 'history': return runtime.history(owner, lease.parse(request.params).lease)
      case 'goTo': { const p = schemas.goTo.parse(request.params); return runtime.goTo(owner, p.lease, p.index) }
      case 'preferences': { const p = schemas.preferences.parse(request.params); return runtime.preferences(owner, p.lease, p.search) }
      case 'restore': { const p = schemas.restore.parse(request.params); return runtime.restore(owner, p.lease, p.entries, p.index) }
      case 'permissions': return runtime.permissions(owner, lease.parse(request.params).lease)
      case 'permission': { const p = schemas.permission.parse(request.params); return runtime.permission(owner, p.lease, p) }
      case 'downloads': return runtime.listDownloads(owner, lease.parse(request.params).lease)
      case 'download': { const p = schemas.download.parse(request.params); return runtime.download(owner, p.lease, p.id, p.action) }
      case 'clearData': { const p = schemas.clearData.parse(request.params); return runtime.clearData(owner, p.lease, p.all) }
      case 'external': return runtime.external(owner, lease.parse(request.params).lease)
      case 'preview': {
        const p = schemas.preview.parse(request.params)
        if (!deps.resolveBrowserPreview) throw new Error('文件网页预览服务尚未连接')
        runtime.state(owner, p.lease)
        let selectedRoot: string | undefined
        if (p.pickRoot) {
          const selected = await dialog.showOpenDialog(window, { title: '选择HTML资源目录', properties: ['openDirectory'] })
          runtime.state(owner, p.lease) // 原生选择框可跨重载/关页存活；迟到结果不重新授权。
          if (selected.canceled) return runtime.state(owner, p.lease)
          selectedRoot = selected.filePaths[0]
        }
        const source = await deps.resolveBrowserPreview(p.source, selectedRoot)
        return runtime.localPreviewSource(owner, p.lease, source)
      }
      case 'promptReply': { const p = schemas.promptReply.parse(request.params); return runtime.promptReply(owner, p.lease, p.requestId, p.value) }
    }
  })
}
