/**
 * 对外 MCP 工具面：显式 typed 工具，不透传任意 RPC —— 每个工具
 * 手写 schema/description/annotations，是审校过的 HostApi 子集（Pi-meme
 * tools.ts 同款纪律）。写组注册按启动时的凭据 scope 过滤（快照语义：
 * allowWrites 变更后重启 MCP server 生效，配置即快照 —— Pi-meme README:118
 * 同款）；凭据缺失也保留只读组 —— tools/list 可用、业务调用返回引导
 * 开启的错误（cogent_status 是自查入口）。
 *
 * annotations 是三层审批的第一层：运行时审批的主位在 MCP 客户端
 * 侧 —— 写组标 destructiveHint，远端的人在他们自己的 agent UI 里批。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_WAIT_MS } from './config'
import { callHost, HostError, subscribeRun } from './host-client'

// ———— 纯函数位（单测锚点，不触 McpServer） ————

/** session.create 的 MCP 入参 → HostApi 参数：默认 plan 档的唯一落点 */
export function createSessionParams(input: {
  title?: string
  projectId?: string
  cwd?: string
  permissionMode?: 'ask' | 'auto' | 'autonomous'
  planEnabled?: boolean
}): { title?: string; projectId?: string; cwd?: string; permissionMode?: 'ask' | 'auto' | 'autonomous'; planEnabled?: boolean } {
  // 安全默认 + 放开显式（第三层）：什么档都不传 = 计划模式（只读零
  // 挂起，chat/读类开箱即用）；显式传 permissionMode = 调用方声明了交互
  // 策略，planEnabled 不再兜 true
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    planEnabled: input.planEnabled ?? input.permissionMode === undefined
  }
}

export interface ToolSpec {
  name: string
  write: boolean
}

/** 注册清单（scope 过滤规则的纯函数位）：readonly 凭据 = 写组零注册 */
export function toolSpecs(scope: 'readonly' | 'write' | null): ToolSpec[] {
  const read = [
    'cogent_status',
    'cogent_projects_list',
    'cogent_sessions_list',
    'cogent_session_messages',
    'cogent_models_list',
    'cogent_inspect_entries'
  ]
  const write = [
    'cogent_session_create',
    'cogent_session_submit',
    'cogent_session_abort',
    'cogent_approval_respond',
    'cogent_question_respond',
    'cogent_plan_respond',
    'cogent_session_set_permission',
    'cogent_session_set_plan_mode'
  ]
  return [...read, ...(scope === 'write' ? write : [])].map((name) => ({ name, write: !read.includes(name) }))
}

// ———— schema 公共件 ————

const sessionId = z.string().min(1)
const requestId = z.string().min(1)
const permissionMode = z.enum(['ask', 'auto', 'autonomous'])

/** 公共结果包装：错误一律 isError + {error:{code,message}}（Pi-meme tools.ts:261-264 同款）。
 * args 的 as 断言是唯一信任边界位：SDK 已按 inputSchema 校验过入参，闭包按
 * 自己的参数注解消费（与 host-main「入口收窄一次、handler 内信任」同姿势） */
function toolResult<A>(run: (args: A, extra: { signal: AbortSignal }) => unknown) {
  return async (args: unknown, extra: { signal: AbortSignal }) => {
    try {
      const value = (await run(args as A, extra)) ?? null
      const serialized = JSON.stringify(value)
      return { content: [{ type: 'text' as const, text: serialized }] }
    } catch (cause) {
      if (cause instanceof HostError) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: cause.code, message: cause.message } }) }] }
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'internal', message: message.slice(0, 500) } }) }] }
    }
  }
}

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

// ———— 装配 ————

export function createCogentMcpServer(scope: 'readonly' | 'write' | null): McpServer {
  const server = new McpServer(
    { name: 'cogent', version: '0.1.0' },
    {
      instructions:
        '先调用 cogent_status 确认 Host 与凭据档位，再用 cogent_sessions_list / cogent_projects_list 选定会话。' +
        'cogent_session_submit 返回受理而非完成：waitMs 超时或省略时用 cogent_session_messages 查询结果；重试可能重复提交，先查再发。' +
        '默认创建的会话是计划模式（只读）：需要无人值守写操作时显式传 permissionMode:"auto"。' +
        '会话内层审批挂起时，本地 GUI 会弹面板由用户裁决，本工具面可用 cogent_inspect_entries 观察进度。'
    }
  )
  const has = (name: string): boolean => toolSpecs(scope).some((spec) => spec.name === name)

  // ———— 只读组 ————

  server.registerTool(
    'cogent_status',
    {
      description: 'Cogent Host 状态自查：服务标识、协议版本、凭据档位（readonly/write）。无凭据/连不上时返回错误码与引导。',
      inputSchema: {},
      annotations: READ_ANNOTATIONS
    },
    toolResult(() => callHost<{ service: string; protocolVersion: number }>('initialize', { client: 'cogent-mcp', protocolVersion: 3 }))
  )

  server.registerTool(
    'cogent_projects_list',
    { description: '列出 Cogent 项目（含名称、工作区根、默认权限档）。', inputSchema: {}, annotations: READ_ANNOTATIONS },
    toolResult(() => callHost('project.list', {}))
  )

  server.registerTool(
    'cogent_sessions_list',
    { description: '列出会话摘要（id、标题、状态、权限档、计划开关）。', inputSchema: {}, annotations: READ_ANNOTATIONS },
    toolResult(() => callHost('session.list', {}))
  )

  server.registerTool(
    'cogent_session_messages',
    {
      description: '读取会话消息投影：正文、工具卡（含 edit 的 diff）、压缩标记。判断 submit 结果与观察进度的正路。',
      inputSchema: { sessionId },
      annotations: READ_ANNOTATIONS
    },
    toolResult((args: { sessionId: string }) => callHost('session.messages', { sessionId: args.sessionId }))
  )

  server.registerTool(
    'cogent_models_list',
    { description: '列出可用模型目录（不暴露 API Key 与凭据）。', inputSchema: {}, annotations: READ_ANNOTATIONS },
    toolResult(() => callHost('models.list', {}))
  )

  server.registerTool(
    'cogent_inspect_entries',
    {
      description: '读取会话观测流摘要：模型请求/响应、工具调用、审批审计对（approval.asked/decided）—— 观察挂起与裁决去向的窗口。',
      inputSchema: { sessionId },
      annotations: READ_ANNOTATIONS
    },
    toolResult((args: { sessionId: string }) => callHost('inspect.entries', { sessionId: args.sessionId }))
  )

  // ———— 写组（scope 快照为 write 才注册） ————

  if (has('cogent_session_create')) {
    server.registerTool(
      'cogent_session_create',
      {
        description:
          '创建新会话。默认计划模式（只读，写类工具被拦截、不产生审批挂起）；显式传 permissionMode 才放开 —— "auto" 为完全放行（含越界写），请谨慎。不发送消息。',
        inputSchema: {
          title: z.string().min(1).max(200).optional(),
          projectId: z.string().min(1).optional(),
          cwd: z.string().min(1).optional(),
          permissionMode: permissionMode.optional()
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      toolResult((args: { title?: string; projectId?: string; cwd?: string; permissionMode?: 'ask' | 'auto' | 'autonomous' }) =>
        callHost('session.create', createSessionParams(args))
      )
    )
  }

  if (has('cogent_session_submit')) {
    server.registerTool(
      'cogent_session_submit',
      {
        description:
          '向会话提交任务：可能调用模型（产生费用）并执行其工具（读写文件/执行命令，受会话权限档约束）。返回受理而非完成；waitMs 内等到终态则附最终回复，超时/省略则用 cogent_session_messages 查询。重试前先查 —— 重复提交会重复执行。',
        inputSchema: {
          sessionId,
          text: z.string().min(1).max(100000),
          model: z.string().min(1).optional(),
          provider: z.string().min(1).optional(),
          thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
          waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional()
        },
        annotations: WRITE_ANNOTATIONS
      },
      toolResult((args: { sessionId: string; text: string; model?: string; provider?: string; thinkingLevel?: string; waitMs?: number }, extra: { signal: AbortSignal }) =>
        (async () => {
          if (args.waitMs === undefined || args.waitMs === 0) {
            return callHost<{ accepted: boolean }>('agent.submit', {
              sessionId: args.sessionId,
              text: args.text,
              ...(args.model !== undefined ? { model: args.model } : {}),
              ...(args.provider !== undefined ? { provider: args.provider } : {}),
              ...(args.thinkingLevel !== undefined ? { thinkingLevel: args.thinkingLevel } : {})
            })
          }
          // 两段式（host-client.subscribeRun 头注）：先 WS 就绪、再 submit ——
          // 事件不重放，先提交再订阅会错过快任务的 completed
          const subscription = subscribeRun(args.sessionId)
          let submit: { accepted: boolean; runId?: string }
          try {
            await subscription.ready()
            submit = await callHost<{ accepted: boolean; runId?: string }>('agent.submit', {
              sessionId: args.sessionId,
              text: args.text,
              ...(args.model !== undefined ? { model: args.model } : {}),
              ...(args.provider !== undefined ? { provider: args.provider } : {}),
              ...(args.thinkingLevel !== undefined ? { thinkingLevel: args.thinkingLevel } : {})
            })
          } catch (cause) {
            subscription.close()
            throw cause
          }
          if (submit.runId === undefined) { subscription.close(); throw new HostError('outcome-uncertain', 'Host 未返回运行身份，请更新 Host 后查询消息确认结果') }
          subscription.bindRun(submit.runId)
          const outcome = await subscription.awaitOutcome(args.waitMs, extra.signal)
          return {
            ...submit,
            run:
              outcome.state === 'completed'
                ? { state: 'completed', finalText: outcome.message?.content ?? undefined, stopReason: outcome.stopReason }
                : outcome.state === 'failed'
                  ? { state: 'failed', failure: outcome.failure }
                  : { state: 'timeout', hint: '已受理但等待超时：用 cogent_session_messages 查询，勿盲目重发' }
          }
        })()
      )
    )
  }

  if (has('cogent_session_abort')) {
    server.registerTool(
      'cogent_session_abort',
      { description: '中止会话当前运行（模型循环与在途工具调用）。', inputSchema: { sessionId }, annotations: WRITE_ANNOTATIONS },
      toolResult((args: { sessionId: string }) => callHost('agent.abort', { sessionId: args.sessionId }))
    )
  }

  if (has('cogent_approval_respond')) {
    server.registerTool(
      'cogent_approval_respond',
      {
        description:
          '裁决会话内层审批（写/执行工具的人工确认）：允许/拒绝，可选附言与"始终允许此工作区"。开启写闸并使用本工具 = 外部 agent 代行人裁决权。',
        inputSchema: {
          requestId,
          approved: z.boolean(),
          message: z.string().max(2000).optional(),
          always: z.literal('workspace').optional()
        },
        annotations: WRITE_ANNOTATIONS
      },
      toolResult((args: { requestId: string; approved: boolean; message?: string; always?: 'workspace' }) =>
        callHost('approval.respond', {
          requestId: args.requestId,
          approved: args.approved,
          ...(args.message !== undefined ? { message: args.message } : {}),
          ...(args.always !== undefined ? { always: args.always } : {})
        })
      )
    )
  }

  if (has('cogent_question_respond')) {
    server.registerTool(
      'cogent_question_respond',
      { description: '回答会话挂起的 ask_user 问题（选项单选传 string，多选传 string[]）。', inputSchema: { requestId, answers: z.array(z.union([z.string(), z.array(z.string())])).min(1) }, annotations: WRITE_ANNOTATIONS },
      toolResult((args: { requestId: string; answers: (string | string[])[] }) =>
        callHost('question.respond', { requestId: args.requestId, answers: args.answers })
      )
    )
  }

  if (has('cogent_plan_respond')) {
    server.registerTool(
      'cogent_plan_respond',
      {
        description: '裁决计划模式下的方案审批：批准即关闭计划开关（会话转入放行），拒绝可附反馈（模型修订后重提）。',
        inputSchema: { requestId, approved: z.boolean(), message: z.string().max(2000).optional() },
        annotations: WRITE_ANNOTATIONS
      },
      toolResult((args: { requestId: string; approved: boolean; message?: string }) =>
        callHost('plan.respond', {
          requestId: args.requestId,
          approved: args.approved,
          ...(args.message !== undefined ? { message: args.message } : {})
        })
      )
    )
  }

  if (has('cogent_session_set_permission')) {
    server.registerTool(
      'cogent_session_set_permission',
      { description: '切换会话权限档（ask/auto/autonomous）。切 auto/autonomous 是放行升级，请谨慎。', inputSchema: { sessionId, mode: permissionMode }, annotations: WRITE_ANNOTATIONS },
      toolResult((args: { sessionId: string; mode: 'ask' | 'auto' | 'autonomous' }) =>
        callHost('session.setPermission', { sessionId: args.sessionId, mode: args.mode })
      )
    )
  }

  if (has('cogent_session_set_plan_mode')) {
    server.registerTool(
      'cogent_session_set_plan_mode',
      { description: '开关会话的计划模式（只读闸，与权限档正交）。', inputSchema: { sessionId, enabled: z.boolean() }, annotations: WRITE_ANNOTATIONS },
      toolResult((args: { sessionId: string; enabled: boolean }) =>
        callHost('session.setPlanMode', { sessionId: args.sessionId, enabled: args.enabled })
      )
    )
  }

  return server
}
