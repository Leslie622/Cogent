/**
 * approval 域 IPC：审批裁决的宿主专属通道（docs/计划/工具系统与审批.md D3）。
 *
 * 为什么不走 engine:request 通用代理：架构.md §2 既定意图「宿主侧裁决不经
 * renderer 通用代理」—— 审批是安全边界，通道显式独立（一条通道一个 method，
 * 白名单天然收窄到 approval.respond 本身）；引擎侧它仍是普通协议 method，
 * 其他宿主（冒烟脚本）照常直驱。
 *
 * 事件侧（approval.request 引擎 → renderer）不走本文件：广播是既有语义
 * （ipc/engine.ts 的 setEventSink 全窗口转发，主窗口渲染审批卡）。
 */
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { IpcDeps } from './index'

export function registerApprovalIpc({ service }: IpcDeps): void {
  // 信任边界：renderer 不可信 —— 载荷形状在此收窄（业务校验在引擎 dispatch）。
  // optional 的 message（拒绝附言）/ always（落工作区级规则）带了就约束形状，
  // 语义矛盾（always + approved=false）在引擎入口拦 —— 这里只管传输形状
  ipcMain.handle(IPC.approvalRespond, async (_event, raw: unknown) => {
    const payload = raw as { requestId: unknown; approved: unknown; message?: unknown; always?: unknown }
    if (typeof payload.requestId !== 'string' || payload.requestId.length === 0 || typeof payload.approved !== 'boolean') {
      throw new Error('approval:respond 非法调用：需要 { requestId: string, approved: boolean }')
    }
    if (payload.message !== undefined && typeof payload.message !== 'string') {
      throw new Error('approval:respond 非法调用：message 必须是 string')
    }
    if (payload.always !== undefined && payload.always !== 'workspace') {
      throw new Error("approval:respond 非法调用：always 只支持 'workspace'")
    }
    return service.request('approval.respond', {
      requestId: payload.requestId,
      approved: payload.approved,
      ...(payload.message !== undefined && { message: payload.message }),
      ...(payload.always !== undefined && { always: payload.always })
    })
  })
}
