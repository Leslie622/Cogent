/**
 * PiSdkKernel 装配工厂（全局架构 D5）—— 把 pi coding-agent 的
 * createAgentSession 装配为 Cogent 会话内核（南缝唯一实现）。
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
 *   自动追加 <cwd> 环境段（探针实证，重复声明无害，已对账去重）；
 * - 审批（D8）：**链式包裹 agent.beforeToolCall** 而非 InlineExtension 的
 *   tool_call 事件 —— pi AgentSession 装的扩展分发器丢弃核心循环传入的
 *   abort signal（agent-session.ts:719 形参无 signal），挂起审批在中止时会
 *   永悬（agent-loop.ts:739 的 await 无超时无外部 resolve）；链式包裹保住
 *   pi 原钩子（扩展链不失联）且拿回 signal；
 * - 压缩：pi 内置（settings 默认 reserve 16384 / keep 20000，含溢出恢复与
 *   provider 自动重试，全部发生在 prompt() Promise 生命周期内）；Cogent 侧
 *   只做小窗自适应（见 factory 尾部的 settings 链式包裹）。
 */
import { join, resolve } from 'node:path'
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadedMcpConfig,
  type McpServerEntry,
  type ModelRuntime
} from '@earendil-works/pi-coding-agent'
import type { Agent, AgentMessage, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'
import { adaptCompactionToWindow } from '../runtime/compaction'
import type { McpSettingsPatch } from '../runtime/mcp-config'
import { COGENT_TOOL_NAMES, MCP_TOOL_ALLOWLIST } from '../runtime/tool-meta'

/**
 * 投影源里的压缩条：pi 的 CompactionSummaryMessage 不带 usage
 * （createCompactionSummaryMessage 落树时丢弃），而 CompactionEntry 本身有
 * —— readPiTranscript 构造投影源时补挂（仅呈现口径，不回写 pi 树），
 * 历史折叠条的 summaryUsage 小字账由此而来。
 */
export type CompactionBarSource = Extract<AgentMessage, { role: 'compactionSummary' }> & { usage?: Usage }

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
 * session-manager sessionEntryToContextMessages 对照，另补挂 usage 见
 * CompactionBarSource），影子区/多代压缩条全部保留。找不到会话文件返回
 * undefined（新会话未跑过、或已删除）。
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
      const bar: CompactionBarSource = {
        role: 'compactionSummary',
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
        ...(entry.usage !== undefined && { usage: entry.usage })
      }
      messages.push(bar)
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
  /**
   * 权限模式通告段：每轮运行前现读活 mode 的正向文案（四档全设
   * —— 切换 = 内容替换，模型拿到的是当下状态而非考古历史）。经
   * before_agent_start 扩展写进 systemPromptOptions 的自定义 section ——
   * pi 对 sections 做「变更才追加 patch、回放按名替换」（append-only 树
   * 安全，切换不堆积），模型可见的权限告知由此恢复。
   */
  permissionSection?: () => string
  approval: ApprovalBridge
  /** AgentSessionEvent 出口（session.ts 的转译入口；不关心的会话层事件自然落 default） */
  onEvent: (event: AgentSessionEvent) => void
  /** 观测钩装配（inspector 的惰性解析由调用方闭包）—— 链式包裹，见函数体注释 */
  observe: (agent: Agent) => void
  /**
   * MCP 座（阶段 4a）：装配时定格的合并快照（快照语义 —— 会话创建时定格，
   * 之后改配置不影响在跑会话）+ server 日志路径 + `/mcp` 设置写回通道
   * （headless 不可达，保留 createMcpExtension 契约完整）。
   * 缺省 = 不装 MCP 扩展（零配置会话不付连接管理成本）。
   */
  mcp?: {
    snapshot: LoadedMcpConfig
    logPath: string
    updateConfig: (entry: McpServerEntry, patch: McpSettingsPatch) => void
  }
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

    // 压缩参数小窗自适应：pi 的 reserve/keep 固定默认对小窗模型
  // （ctx ≤ keep）会「触发即无可压缩」。链式包裹 getCompactionSettings 按
  // 活模型的 contextWindow 收敛（公式见 adaptCompactionToWindow；标准窗
  // 零变化）。同一实例传 loader 与 session（此前 sdk 会自建第二个实例，
  // 补丁只挂在我们这份上——现在统一单实例，顺带消灭双份）
  const settingsManager = SettingsManager.create(opts.cwd, agentDir)
  const innerCompactionSettings = settingsManager.getCompactionSettings.bind(settingsManager)
  settingsManager.getCompactionSettings = (model) => {
    const resolved = innerCompactionSettings(model)
    if (model === undefined) return resolved
    const window = opts.modelRuntime.getModel(model.provider, model.id)?.contextWindow
    return window === undefined ? resolved : adaptCompactionToWindow(resolved, window)
  }

  // MCP 扩展装配材料（缺省 = 不装）：const 捕获让闭包内的窄化稳定
  const mcp = opts.mcp
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: () => opts.systemPrompt,
    // 权限模式通告：每轮按活 mode 设 cogent_permission section
    // （四档全设正向文案）。pi 对 sections 的 diff 保证树内只留净变更史
    extensionFactories: [
      // MCP 座（4a）：pi 官方工厂 + Host 配置注入（D7 不造轮子）。loadConfig
      // 返回装配期快照（Pi-meme 快照语义）；MCP 工具经 pi 工具管线注册
      // （"Every call runs through pi's tool pipeline" —— mcp/index.ts:20-21），
      // 因此下方链式包裹的 beforeToolCall 审批对 mcp__* 同样生效，零新增链路。
      // 连接后台跑；direct 工具的 server 首请求最多等 startupWaitMs（默认 10s）。
      ...(mcp !== undefined
        ? [
            createMcpExtension({
              loadConfig: () => mcp.snapshot,
              logPath: mcp.logPath,
              updateConfig: mcp.updateConfig
            })
          ]
        : []),
      (pi) => {
        pi.on('before_agent_start', (event) => {
          const text = opts.permissionSection?.()
          if (text === undefined) return
          event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, cogent_permission: text }
        })
      }
    ]
  })
  await resourceLoader.reload()

  const model = opts.modelRuntime.getModel('anthropic', 'claude-sonnet-4-5')
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    modelRuntime: opts.modelRuntime,
    sessionManager: piSessionManager,
    resourceLoader,
    settingsManager,
    ...(model !== undefined && { model }),
    thinkingLevel: 'off',
    // 工具集：pi 内置 8 选 7，shell 项按平台（win=powershell，见
    // tool-meta.ts 的 COGENT_TOOL_NAMES）。显式 allowlist 替换 pi 默认
    // （read/bash/edit/write）—— Cogent 的只读三件（grep/find/ls）也进集；
    // MCP 工具另按 MCP_TOOL_ALLOWLIST 放行（tools 列表会过滤扩展工具，
    // 不列名则 direct 档 mcp__ 工具注册但不声明给模型，见 tool-meta 注释）
    tools: [...COGENT_TOOL_NAMES, ...MCP_TOOL_ALLOWLIST]
  })

  // 扩展生命周期绑定（SDK 消费者必做的一步，Pi-meme session.ts:917 同款）：
  // CLI 各 mode（print/interactive/rpc-mode）在 createAgentSession 后调
  // bindExtensions —— 它向扩展发 session_start（MCP 扩展在此装载配置并
  // 启动连接）并应用 UI/命令绑定。不调它则挂 session_start 的扩展全部
  // 不初始化（4a-1 实测：MCP 工具零装载且无任何诊断）。mode 'rpc' = 无
  // TUI 宿主；uiContext 缺省 = 扩展的 ui.notify 等走 headless 空实现。
  // 已知边界：pi 的 dispose() 不发 session_shutdown —— MCP 连接/子进程
  // 活到 Host 进程退出（与 pi print-mode 同语义，session 删除不回收）。
  await session.bindExtensions({ mode: 'rpc' })

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
