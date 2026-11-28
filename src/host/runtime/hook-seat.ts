/**
 * 钩子座（阶段 4d，docs/模块/钩子座.md）—— Host 干预内核循环的统一装配点。
 *
 * 干预形状各归其位：
 * - **段注入**（sections）：`before_agent_start` 扩展事件 —— pi 官方缝，
 *   本文件工厂注册（Pi-meme session.ts:570-795 单工厂集中装配同款形状）；
 * - **直接审批**（wrapApprovalChain）：包裹公开 `agent.beforeToolCall`，
 *   保留 core 传入的每次调用 signal，再委托 pi 原链；
 * - **嵌套审批**：ctx.executeTool 直接调用 pi 私有扩展分发器，不经过上述公开链。
 *   官方 tool_call 事件按 parentToolCallId 筛嵌套项，复用同一 ApprovalBridge。
 *   当前宿主工具都不再发起嵌套调用（read_attachment 的媒体委托已移除），分支留作安全网：
 *   今后任何扩展经 ctx.executeTool 调工具，审批照样生效。
 *   当前扩展 context.signal 公开提供 agent.signal；不能把分发器没有第二形参
 *   误读成扩展上下文完全拿不到信号。升级 pi 时重查两条入口；
 * - **厂商标量观测**：AgentOptions 三回调（onPayload/onResponse/
 *   onProviderStreamEvent，session.attachInspector 挂装）—— 载荷带 model
 *   上下文而扩展事件版没有（before_provider_request 仅 payload），不等价
 *   故不迁；它籍挂本座但物理上留在 inspector。
 * - **请求取消**：链式包裹公开 agent.prepareRequest，原钩子前后检查signal，
 *   接住Host保存并在pi启动时重放的停止意图；不覆盖原钩子或宣称强制打断任意await。
 *
 * 上下文注入（context）：每次已有 LLM 请求前检查一次条件产物提醒；不另起模型请求，
 * 不把提醒永久追加到用户转录。工具/工作区长期规则仍走系统提示段。
 */
import type { Agent, AgentMessage, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type {
  InlineExtension,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult
} from '@earendil-works/pi-coding-agent'
import type { ApprovalBridge } from '../kernel/pi-session-factory'

/** 钩子座的注入面（pi-session-factory 装配时传入；undefined 项 = 该钩子不挂） */
export interface CogentHooksOptions {
  /** 嵌套调用走 pi 私有分发器，不经过公开 Agent 包装；用官方事件复用同一审批桥。 */
  nestedApproval?: ApprovalBridge
  /**
   * 段表活算：每回合 before_agent_start 现读的 段名→内容 表。值 null = 撤段
   * （pi 段表无 null，删除靠期望侧不出现该键 —— diff 对转录回放的旧段产出
   * 补丁撤下，空墓碑语义）；返回 undefined / 空表 = 本会话无段（不碰
   * sections）。pi 对 sections「变更才追加 patch、回放按名替换」—— 活算 +
   * diff = 回合边界热刷新（权限通告 / 技能清单 / 任务清单 / 已批准计划 / 压缩后资产 共用）。
   */
  sections?: () => Record<string, string | null> | undefined
  /** 回合前段注入完成后回传 pi 完整渲染的系统提示词（供观测控制台对齐真实发送面）。 */
  onSystemPromptRendered?: (systemPrompt: string) => void
  /** 每次请求的上下文注入；支持异步读取交付状态，返回数组整体替换 messages。 */
  context?: (messages: AgentMessage[]) => AgentMessage[] | void | Promise<AgentMessage[] | void>
  /** 回合前与工具轮结束后执行上下文压力检查（L1 零成本工具结果裁剪）。 */
  onPressureCheck?: () => void
  /** L2 摘要压缩前钩子（注入中文与黑盒约束指令并委托 pi 官方 compact）。 */
  beforeCompact?: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult | undefined>
}

/**
 * 具名内联扩展：段注入、上下文压力裁剪与压缩前指令注入的统一注册地。
 */
export function createCogentHooks(opts: CogentHooksOptions): InlineExtension {
  return {
    name: 'cogent-hooks',
    factory: (pi) => {
      if (opts.nestedApproval !== undefined) {
        pi.on('tool_call', async (event, ctx) => {
          if (event.parentToolCallId === undefined) return
          // 当前 pi 的公开扩展 context.signal 来自 agent.signal；嵌套调用透传同一 run 信号。
          return opts.nestedApproval!.decide(event.toolName, event.toolCallId, event.input, ctx.signal)
        })
      }
      pi.on('before_agent_start', (event) => {
        opts.onPressureCheck?.()
        const wanted = opts.sections?.()
        if (wanted !== undefined && Object.keys(wanted).length > 0) {
          const sections = { ...event.systemPromptOptions.sections }
          for (const [name, text] of Object.entries(wanted)) {
            if (text === null) delete sections[name]
            else sections[name] = text
          }
          event.systemPromptOptions.sections = sections
        }
        opts.onSystemPromptRendered?.(event.systemPrompt)
      })
      if (opts.onPressureCheck !== undefined) {
        pi.on('turn_end', () => {
          opts.onPressureCheck?.()
        })
      }
      if (opts.beforeCompact !== undefined) {
        pi.on('session_before_compact', async (event) => opts.beforeCompact?.(event))
      }
      if (opts.context !== undefined) {
        pi.on('context', async (event) => {
          const replaced = await opts.context?.(event.messages)
          if (replaced !== undefined) return { messages: replaced }
        })
      }
    }
  }
}

/**
 * 审批链包裹器（决定 28）：裁决放行时委托原链 —— 任何挂 tool_call 的扩展不失联；
 * 阻止时返回 block（reason 进模型可见的工具错误结果）。判定/挂起/北向请求
 * 全部住在 session.ts 的 ApprovalBridge 实现（decideApproval），本函数只做
 * 链式包裹这一件事。
 */
export function wrapApprovalChain(
  piBeforeToolCall: Agent['beforeToolCall'],
  approval: ApprovalBridge
): Agent['beforeToolCall'] {
  return async (context, signal) => {
    const verdict = await approval.decide(
      context.toolCall.name,
      context.toolCall.id,
      context.args as Record<string, unknown>,
      signal
    )
    if (verdict.block) return { block: true, reason: verdict.reason } satisfies BeforeToolCallResult
    return piBeforeToolCall?.(context, signal)
  }
}

/**
 * pi在agent_start接到中止后仍会进入请求准备；在其原钩子前后检查同一signal，
 * 让准备期已取消的工作在provider入口前收口。原钩子可能等待外部I/O，必须保留
 * 并在返回后再查一次；此包装不声称能强制终止不合作的异步处理器。
 */
export function wrapRequestCancellation(
  prepareRequest: Agent['prepareRequest']
): NonNullable<Agent['prepareRequest']> {
  return async (request, signal) => {
    signal?.throwIfAborted()
    const update = await prepareRequest?.(request, signal)
    signal?.throwIfAborted()
    if (update !== undefined) return update
  }
}
