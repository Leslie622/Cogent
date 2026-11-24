/**
 * guest 域 IPC：webview guest preload 的凭证入口（决定 23 票据生命周期的 main 侧）。
 *
 * 语义：guest preload 启动即来要票据（一次性 30s），main 是血缘全权的
 * 签发起点 —— 校验 sender 必须是 webview 型 guest（webview-policy 已在
 * will-attach-webview 硬化过它的配置），再经 HostManager 签发。
 * scope 定档：3a demo 页 = write（列会话 + 发起对话 + 收事件流）。
 * 页面级细档（session 绑定）= 决定 30 的后续批次。
 */
import { handleTrusted } from './trusted'
import { IPC, type GuestCredentialsResult } from '../../../shared/ipc'
import type { IpcDeps } from './index'
import { isTrustedAppGuest } from '../webview-policy'

export function registerGuestIpc(deps: IpcDeps): void {
  handleTrusted(IPC.guestCredentials, async (event): Promise<GuestCredentialsResult> => {
    // 信任边界：sender 是跨信任边界的外部页面环境（经硬化 webview），在此做
    // 唯一一次校验 —— 非 webview guest（主 UI preload 伪造调用等）直接拒
    if (!isTrustedAppGuest(event.sender) || event.senderFrame !== event.sender.mainFrame || event.sender.hostWebContents === null) {
      throw new Error('凭证入口仅对已登记的可信应用页面开放')
    }
    const port = deps.host.getHttpPort()
    if (port === undefined) {
      throw new Error('HTTP 门未开（引擎未就绪或未启用）')
    }
    const issued = await deps.host.issueCapability('write')
    return { ticket: issued.ticket, expiresAt: issued.expiresAt, httpPort: port, scope: 'write' }
  })
}
