/**
 * PiSdkKernel 装配工厂（全局架构 D5 / 阶段 1.2）—— 把 pi coding-agent 的
 * createAgentSession 装配为 Cogent 会话内核（南缝唯一实现，阶段 1.3 起正名）。
 *
 * 装配纪律（对照 tmp 探针实证 + reference/pi 行号）：
 * - 会话 id：SessionManager.create(cwd, dir, {id}) 显式指定 —— pi 会话 id =
 *   Cogent 会话 id（uuid 兼容官方校验），恢复走 findById → open；
 * - 持久化：pi JSONL 是转录真源（message_end 时逐条追加），Cogent 侧只存
 *   会话域 summary（置顶/归档/项目绑定是 Cogent 的私域，pi 不知情）；
 * - 凭据：ModelRuntime 全内存（空 CredentialStore 底层 + setRuntimeApiKey，
 *   由 index.ts 的凭据 sink 注入），绝不读写 ~/.pi 的 auth.json —— Cogent 的
 *   key 持久层在壳侧 safeStorage；
 * - 系统提示词：systemPromptOverride 整体注入 Cogent 自拼提示词；pi 在其后
 *   自动追加 <cwd> 环境段（探针实证，重复声明无害，1.4 对账去重）；
 * - 审批（D8）：**链式包裹 agent.beforeToolCall** 而非 InlineExtension 的
 *   tool_call 事件 —— pi AgentSession 装的扩展分发器丢弃核心循环传入的
 *   abort signal（agent-session.ts:719 形参无 signal），挂起审批在中止时会
 *   永悬（agent-loop.ts:739 的 await 无超时无外部 resolve）；链式包裹保住
 *   pi 原钩子（扩展链不失联）且拿回 signal；
 * - 压缩：pi 内置（settings 默认 reserve 16384 / keep 20000，含溢出恢复与
 *   provider 自动重试，全部发生在 prompt() Promise 生命周期内）—— 手搓
 *   L1/L2 与 pi 会话树不兼容（pi 靠 message_end 追加，原位 splice 会分叉），
 *   整体让位。
 */
import { join, resolve } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Agent, AgentMessage, BeforeToolCallResult } from '@earendil-works/pi-agent-core'

/**
 * 会话目录编码（pi session-manager.ts:590 getDefaultSessionDirPath 同款，
 * 该函数未从包导出，此处照抄规则保持文件名/目录可互认）：
 * <agentDir>/sessions/--<cwd 盘符路径分隔符全换 - >--
 */
function piSessionDir(cwd: string, agentDir: string): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(resolve(agentDir), 'sessions', safePath)
}

/** Cogent Host 根（COGENT_HOME ?? ~/.cogent）下的 pi 域目录（全局架构 D5：agentDir） */
export const PI_AGENT_DIR_NAME = 'pi'

/**
 * 只读回查 pi JSONL（惰性会话的历史投影源，D9 保留式呈现的 pi 版）。
 * pi 的 buildSessionProjection 是**上下文口径**（影子区被摘要吸收后丢弃），
 * 而 Cogent 的历史回查是**呈现口径**（保留式：被摘要区原文照旧可滚，D9
 * 验收定稿）—— 故此处不走它，改遍历 getBranch() 全量条目自投影：message
 * 条目原样收，compaction 条目转 compactionSummary（pi 投影同款形状，
 * session-manager sessionEntryToContextMessages 对照），影子区/多代压缩条
 * 全部保留。找不到会话文件返回 undefined（新会话未跑过、或已删除）。
 */
export function readPiTranscript(cwd: string, hostRoot: string, sessionId: string): AgentMessage[] | undefined {
  const sessionDir = piSessionDir(cwd, join(hostRoot, PI_AGENT_DIR_NAME))
  const file = PiSessionManager.findById(cwd, sessionId, sessionDir)
  if (file === undefined) return undefined
  const messages: AgentMessage[] = []
  for (const entry of PiSessionManager.open(file, sessionDir).getBranch()) {
    if (entry.type === 'message') {
      messages.push(entry.message)
    } else if (entry.type === 'compaction') {
      messages.push({
        role: 'compactionSummary',
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime()
      })
    }
  }
  return messages
}

/**
 * 审批桥：判定与挂起语义住在 session.ts（mode 活值/规则表/北向请求都在那）。
 * 放行返回 { block: false }；block 时 reason 进 pi 的 error tool result
 * （模型可见）。ask 场景内部发 approval.request 并挂起 —— async 未返回前
 * 工具不执行（agent-loop 的 await 钩子）；signal abort 时桥方负责 resolve
 * （block '已中止'），否则中止后 Promise 永悬、run 永不结束。
 */
export interface ApprovalBridge {
  decide(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<{ block: boolean; reason?: string }>
}

export interface PiSessionOptions {
  /** 会话主根（pi 的 cwd：项目发现 + 会话目录编码；无绑定根时调用方兜底主目录） */
  cwd: string
  /** Cogent Host 根（pi 域 = <hostRoot>/pi） */
  hostRoot: string
  /** Cogent 会话 id = pi 会话 id */
  sessionId: string
  modelRuntime: ModelRuntime
  /** Cogent 自拼系统提示词（buildSystemPrompt 的产物，会话生命周期内不变） */
  systemPrompt: string
  /** 自研工具过渡（1.3 切 pi 内置后此参数清空） */
  customTools: ToolDefinition[]
  approval: ApprovalBridge
  /** AgentSessionEvent 出口（session.ts 的转译入口；不关心的会话层事件自然落 default） */
  onEvent: (event: AgentSessionEvent) => void
  /** 观测钩装配（inspector 的惰性解析由调用方闭包）—— 链式包裹，见函数体注释 */
  observe: (agent: Agent) => void
}

/** 装配一个 Cogent 会话的 pi 内核。createdNew = 新建会话树（false = 恢复已有 JSONL） */
export async function createPiSession(opts: PiSessionOptions): Promise<{
  session: AgentSession
  piSessionManager: PiSessionManager
  createdNew: boolean
}> {
  const agentDir = join(opts.hostRoot, PI_AGENT_DIR_NAME)
  const sessionDir = piSessionDir(opts.cwd, agentDir)

  // pi 会话定位：先找旧（本 Cogent 会话已落过 pi JSONL），没有则新建（id 对齐）
  const existingFile = PiSessionManager.findById(opts.cwd, opts.sessionId, sessionDir)
  const createdNew = existingFile === undefined
  const piSessionManager = createdNew
    ? PiSessionManager.create(opts.cwd, sessionDir, { id: opts.sessionId })
    : PiSessionManager.open(existingFile, sessionDir)

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    settingsManager: SettingsManager.create(opts.cwd, agentDir),
    systemPromptOverride: () => opts.systemPrompt
  })
  await resourceLoader.reload()

  const model = opts.modelRuntime.getModel('anthropic', 'claude-sonnet-4-5')
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    modelRuntime: opts.modelRuntime,
    sessionManager: piSessionManager,
    resourceLoader,
    ...(model !== undefined && { model }),
    thinkingLevel: 'off',
    customTools: opts.customTools,
    // 自研工具经 customTools 过渡（1.2a）：内置工具集显式关闭，行为面与
    // 现状对齐（1.3 才切换内置 read/bash/edit/write…）
    noTools: 'builtin'
  })

  // 审批链（D8）：包住 pi 的 beforeToolCall（构造时已被 AgentSession 装成扩展
  // 分发器，agent-session.ts:714）。裁决放行时委托原链 —— 未来任何挂 tool_call
  // 的扩展不失联；裁决阻止时返回 block（reason 进模型可见的工具错误结果）。
  const piBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    const verdict = await opts.approval.decide(
      context.toolCall.name,
      context.toolCall.id,
      context.args as Record<string, unknown>,
      signal
    )
    if (verdict.block) return { block: true, reason: verdict.reason } satisfies BeforeToolCallResult
    return piBeforeToolCall?.(context, signal)
  }

  // 观测三钩直挂（官方先例手法：pi 不占这些字段；inspector 惰性由调用方闭包）
  opts.observe(session.agent)
  session.subscribe((event) => opts.onEvent(event))

  return { session, piSessionManager, createdNew }
}
