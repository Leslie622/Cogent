/**
 * webview guest preload（决定 30）：第三方页面与 HostApi 之间的唯一桥。
 *
 * 运行环境：沙箱（webview-policy 在 will-attach-webview 强制），CJS 产物
 * （沙箱 preload 不支持 ESM）—— 本文件不用顶层 await / 动态 import。
 *
 * 产物必须单文件自包含：沙箱 preload 的 require 只认 'electron'，加载不了
 * 相对路径 chunk（rollup 多入口共享模块会拆 chunk）—— channel 常量在此
 * 内联（与 shared/ipc.ts 的 IPC.guestCredentials 保持一致，类型仍从
 * shared 引，type-only 不产生运行时代码）。
 *
 * 暴露面（刻意窄，Doyensec「暴露 ipcRenderer = 解除隔离」教训）：
 * window.cogentHost = { ready, request, onEvent } —— 票据与 token 全程
 * 留在本 preload 的内存（isolated world），页面全局摸不到任何凭证原语。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createGuestSdk } from '../../shared/guest-sdk'

// 与 shared/ipc.ts 的 IPC.guestCredentials 同值（内联原因见文件头）
const GUEST_CREDENTIALS_CHANNEL = 'cogent:guest:credentials'

const sdk = createGuestSdk({
  getCredentials: () => ipcRenderer.invoke(GUEST_CREDENTIALS_CHANNEL),
  // fetch 必须绑定 globalThis：解绑调用（this 不是 window）抛 Illegal invocation
  fetchImpl: fetch.bind(globalThis),
  WebSocketImpl: WebSocket
})

contextBridge.exposeInMainWorld('cogentHost', {
  /** 等凭证就绪；失败（HTTP 门未开等）reject 给页面呈现 */
  ready: (): Promise<string> => sdk.ready(),
  /** 引擎方法调用（method 名受协议约束，档位由 Host 强制） */
  request: sdk.request.bind(sdk),
  /** 订阅引擎事件流（经 WS），返回取消订阅 */
  onEvent: sdk.onEvent.bind(sdk)
})
