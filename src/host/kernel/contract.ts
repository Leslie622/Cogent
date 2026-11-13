/**
 * CogentKernel —— 南缝窄合同：Host 服务层与内核实现之间的唯一界面
 *（全局架构 D4，阶段 1.1 显式化）。
 *
 * 为什么要有这份合同（D4 复杂度账）：它早已隐式存在于 runtime/session.ts
 *（把 pi Agent 包成协议方法的那段），本文件只是把它写下来。形状 =
 * pi AgentSession 方法面的可序列化子集（agent-session.ts：prompt/steer/
 * followUp/abort/setModel/compact…）+ 事件出口。真正的 N 倍复杂度只在写
 * 第二个内核时出现（D5 明确不写）—— 它是纯期权：若最终只跑 pi，
 * 收益 ≈ 0，费用也 ≈ 0。
 *
 * 南缝纪律（写内核相关代码前必读）：
 * - 服务层（index.ts dispatch 及后续服务模块）只许经本合同驱动内核：
 *   不 import pi-*、不摸内核内部对象（Agent / AgentSession 实例等）；
 * - 合同签名一律是协议可序列化形状（protocol/ 的类型）；内核内部状态
 *   （pi 消息对象、流式累积态）不越缝；
 * - 参照 dsh 教训：不做 waterfall 全量合同、不做 replay 确定性承诺 ——
 *   窄到够用，防复杂度黑洞（150+ 包爆炸是反面教材）；
 * - 阶段 1.1 唯一实现 = runtime/session.ts 的 SessionManager（会话域服务
 *   与内核尚为混体）；1.2 起拆出 PiSdkKernel，steer / setModel 独立化等
 *   目标面届时在此扩展 —— 现合同 = 现状面冻结，零行为变化。
 */
import type { ChatMessage, PermissionMode, ProtocolEvents, SessionSummary } from '../../protocol'

/** 内核事件出口：内核经它上报协议事件（北缝 Notify 的南半段），不关心传输层 */
export type KernelNotifier = <E extends keyof ProtocolEvents>(
  method: E,
  params: ProtocolEvents[E]
) => void

/**
 * 内核合同 —— 会话内核的驱动面（服务层可见的全部）。
 * 方法语义与 runtime/session.ts 的同名实现一一对应。
 */
export interface CogentKernel {
  /** 提交用户输入：同步受理校验（拒绝 throw 协议错误）；LLM 循环异步执行、进度经事件流 */
  submit(
    sessionId: string,
    text: string,
    model?: string,
    thinkingLevel?: string,
    provider?: string
  ): void
  /** 手动续写（末条 length 截断时） */
  continueSession(sessionId: string): Promise<{ ok: true }>
  /** 中止进行中的 run */
  abort(sessionId: string): boolean
  /** 手动压缩（无可压缩 / 失败 throw 协议错误） */
  compactSession(sessionId: string): Promise<{ tokensBefore: number; tokensAfter: number }>
  /** 会话转录投影（历史回查；含按需现算的上下文明细） */
  messages(sessionId: string): ChatMessage[]
  /**
   * 会话级权限切换：内核面 = 权限通告写 transcript（下一轮请求生效），
   * 域面 = summary.permissionMode 落盘 —— 混体方法（1.2 拆分时归位内核侧）
   */
  setPermission(sessionId: string, mode: PermissionMode): SessionSummary
  /** 审批裁决回流：内核内挂起的 beforeToolCall 据此 resolve（配对失败 throw） */
  respondApproval(
    requestId: string,
    approved: boolean,
    message?: string,
    always?: 'workspace'
  ): { ok: true }
  /** 进程退出前统一收尾（abort 全部会话 + 挂起审批 block 收尾） */
  disposeAll(): void
}
