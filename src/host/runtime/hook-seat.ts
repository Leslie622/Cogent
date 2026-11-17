/**
 * 钩子座（阶段 4d，docs/计划/钩子座实现.md）—— Host 干预内核循环的统一装配点。
 *
 * 四种形状各归其位，为什么不全走扩展事件：
 * - **段注入**（sections）：`before_agent_start` 扩展事件 —— pi 官方缝，
 *   本文件工厂注册（Pi-meme session.ts:570-795 单工厂集中装配同款形状）；
 * - **审批包裹**（wrapApprovalChain）：链式包裹官方的 `agent.beforeToolCall`
 *   钩子，**不是**扩展 —— pi 的扩展分发器丢 abort signal（AgentSession 适配
 *   器单参，installed 1.5.2 与 reference HEAD 827383a15 均如此，
 *   core/agent-session.ts:716），审批挂起需 signal 兜底 resolve（否则停止钮
 *   按下挂起永悬、run 永不结束）；loop 层是传 signal 的（agent-loop.ts:745），
 *   包裹层因此拿得到。升级 pi 版本时重查此项；
 * - **厂商标量观测**：AgentOptions 三回调（onPayload/onResponse/
 *   onProviderStreamEvent，session.attachInspector 挂装）—— 载荷带 model
 *   上下文而扩展事件版没有（before_provider_request 仅 payload），不等价
 *   故不迁（实现文档 §3.3）；它籍挂本座但物理上留在 inspector。
 * - **请求取消**：链式包裹公开 agent.prepareRequest，原钩子前后检查signal，
 *   接住Host保存并在pi启动时重放的停止意图；不覆盖原钩子或宣称强制打断任意await。
 *
 * 上下文注入（`context` 事件，每次 LLM 调用前可改 messages）：**预留缝未接线**
 * —— pi 自动注入 <cwd> 环境段 + Cogent 工作区注入走系统提示段，无未满足
 * 消费者（实现文档 §3.4 的墙）；出现「需按调用注入动态事实且系统提示段
 * 不适合」的真实场景时经 options.context 接线。
 */
import type { Agent, AgentMessage, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { ApprovalBridge } from '../kernel/pi-session-factory'

/** 钩子座的注入面（pi-session-factory 装配时传入；undefined 项 = 该钩子不挂） */
export interface CogentHooksOptions {
  /**
   * 段表活算：每回合 before_agent_start 现读的 段名→内容 表。值 null = 撤段
   * （pi 段表无 null，删除靠期望侧不出现该键 —— diff 对转录回放的旧段产出
   * 补丁撤下，空墓碑语义）；返回 undefined / 空表 = 本会话无段（不碰
   * sections）。pi 对 sections「变更才追加 patch、回放按名替换」—— 活算 +
   * diff = 回合边界热刷新（权限通告 / 技能清单 / 任务清单 / 已批准计划 共用）。
   */
  sections?: () => Record<string, string | null> | undefined
  /** 上下文注入预留缝（未接线，见文件头）；返回数组 = 整体替换 messages */
  context?: (messages: AgentMessage[]) => AgentMessage[] | void
}

/**
 * 具名内联扩展：段注入的注册地（从 pi-session-factory 的匿名工厂迁入，
 * 逻辑零改动 —— 迁移等价性由既有段相关测试钉住）。
 */
export function createCogentHooks(opts: CogentHooksOptions): InlineExtension {
  return {
    name: 'cogent-hooks',
    factory: (pi) => {
      pi.on('before_agent_start', (event) => {
        const wanted = opts.sections?.()
        if (wanted === undefined || Object.keys(wanted).length === 0) return
        const sections = { ...event.systemPromptOptions.sections }
        for (const [name, text] of Object.entries(wanted)) {
          if (text === null) delete sections[name]
          else sections[name] = text
        }
        event.systemPromptOptions.sections = sections
      })
      if (opts.context !== undefined) {
        pi.on('context', (event) => {
          const replaced = opts.context?.(event.messages)
          if (replaced !== undefined) return { messages: replaced }
        })
      }
    }
  }
}

/**
 * 审批链包裹器（D8）：裁决放行时委托原链 —— 任何挂 tool_call 的扩展不失联；
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
