/** 目标职责、模块能力完成度与可追溯的依据，关系状态归 LikeC4 模型。 */
import { Blocks, Bot, Cpu, Fingerprint, Globe, Layers3, Network, Plug, Route, Server, ShieldCheck, Terminal, Users, type LucideIcon } from 'lucide-react'
import type { ImplementationStatus } from './实现状态'
import type { ViewId } from './视图'

export interface ModuleFeature {
  label: string
  status: 'implemented' | 'planned'
}

/** 容器内的阅读阶段：标题标在阶段首张卡片上方，横线覆盖该阶段全部卡片。 */
export interface ModuleStage {
  label: string
  nodes: string[]
}

export interface ModuleDetail {
  name: string
  kind: string
  icon: LucideIcon
  status: ImplementationStatus
  showStatus?: boolean
  features?: ModuleFeature[]
  stages?: ModuleStage[]
  summary: string
  responsibilities: string[]
  boundary: string
  sources: { path: string; symbol: string }[]
  navigateTo?: ViewId
  navigateOnClick?: boolean
  boundaryNote?: string
}

export const moduleDetails: Record<string, ModuleDetail> = {
  desktop: {
    name: '主 UI 桌面壳', kind: 'Electron · 本机客户端', icon: Server, status: 'implemented', showStatus: false,
    summary: '桌面 UI 经 preload 与 IPC 交给 Electron 主进程，再通过 stdio 调用 Host。',
    responsibilities: ['主进程管理 Host 子进程与请求转发。', '图中接线以桌面壳整体表示 IPC 到管道的调用链。'],
    boundary: 'renderer 不直接访问 Host 的 stdin/stdout。',
    sources: [{ path: 'src/electron/main/host/manager.ts', symbol: 'HostManager' }],
  },
  nativeClients: {
    name: 'Cogent 原生调用', kind: '使用 Cogent 原生协议的 UI 或服务', icon: Globe, status: 'external', showStatus: false,
    summary: '直接使用 Cogent 方法、参数和事件约定的 UI 或远程服务。',
    responsibilities: ['通过 HTTP、WebSocket，或组合使用两者。', '完成认证后进入 Cogent 原生协议处理，再经过权限检查与 HostApi。'],
    boundary: '按本次调用所用协议分类；同一个 UI 或服务也可以选择自有协议接入。远程描述部署位置，不限定调用方是否有 UI。',
    sources: [{ path: 'src/host/http/server.ts', symbol: '/rpc · /ws' }],
  },
  customClients: {
    name: '自有协议调用方', kind: '已有自己的接口约定', icon: Network, status: 'external', showStatus: false,
    summary: '自定义协议适配的消费方：已有自己协议的 UI，以及使用自有协议的远程服务。',
    responsibilities: ['UI 可以是远程、内嵌或自定义界面；远程服务也可以完全没有界面。', '点线直接连接自定义协议适配，表示该调用方消费协议适配能力。', '完整调用链仍是：调用方 → 网络传输 → 身份认证 → 自定义协议适配 → 权限检查 → HostApi。'],
    boundary: '这表示需要被兼容的调用场景；Cogent 的自定义协议适配仍待实现。',
    sources: [{ path: 'docs/计划/架构地图目标架构.md', symbol: '自有协议调用方与适配' }],
  },
  externalAgent: {
    name: '外部 Agent', kind: '标准 MCP 客户端', icon: Bot, status: 'external', showStatus: false,
    summary: '通过标准 MCP 发现并调用 Cogent 提供的工具。',
    responsibilities: ['以 stdio 启动并连接 Cogent 的 MCP Server。', '发送 MCP 工具调用，接收标准 MCP 工具结果或错误。'],
    boundary: '外部 Agent 使用 MCP；Cogent 的方法和参数由 MCP Server 负责映射。',
    sources: [{ path: 'src/host/mcp-server/main.ts', symbol: 'StdioServerTransport' }],
  },
  mcp: {
    name: 'MCP 协议适配', kind: 'MCP Server · 独立 Node 进程', icon: Plug, status: 'implemented',
    summary: '在标准 MCP 与 Cogent 原生协议之间转换，入口是 MCP Server 注册的工具处理函数。',
    responsibilities: ['请求映射：例如 MCP 工具 cogent_sessions_list 转成 Cogent 的 session.list 方法与参数，再通过 HTTP 调用 Host。', '结果映射：将 Host 返回值、错误整理成 MCP 的 content 与 isError 结果。', '事件处理：等待任务结果时先建立 WS 订阅，再提交任务，最后把任务结果作为 MCP 工具结果返回。'],
    boundary: '这是已有的 MCP 专用转换，位于 Host 网络入口之前；Host 内待实现的自定义协议适配负责旧 /xxx/chat 等其他接口。两边可同用 JSON-RPC 2.0 消息形式，但方法、参数和结果约定不同。',
    sources: [{ path: 'src/host/mcp-server/main.ts', symbol: 'StdioServerTransport' }, { path: 'src/host/mcp-server/tools.ts', symbol: 'registerTool · toolResult' }, { path: 'src/host/mcp-server/host-client.ts', symbol: 'callHost · subscribeRun' }, { path: 'docs/模块/对外MCP.md', symbol: '工具出口与调用边界' }, { path: 'docs/测试用例/对外MCP.md', symbol: '真实客户端验收' }],
  },
  access: {
    name: '传输入口', kind: 'stdio · HTTP · WebSocket', icon: Network, status: 'implemented', showStatus: false, navigateTo: 'ingress',
    summary: '按传输方式接入同一引擎，客户端可以选择 Cogent 原生协议或既有协议。',
    responsibilities: ['总览区分 stdio 与网络入口，接入视图展开 HTTP、WebSocket 及各场景的独立接线。', '网络入口分别建立请求或连接身份，再交给协议与权限处理。'],
    boundary: '传输通道已实现；用户系统认证、自定义 chat 契约适配与资源权限仍按各节点状态区分。',
    sources: [{ path: 'src/electron/main/host/manager.ts', symbol: 'HostManager' }, { path: 'src/host/http/server.ts', symbol: 'startHttpRpc' }],
  },
  'access.stdio': {
    name: 'stdio JSON-RPC', kind: '进程管道 · 主 UI 桌面壳', icon: Terminal, status: 'implemented',
    summary: '桌面主进程通过子进程 stdin/stdout 交换一行一帧的 Cogent 原生协议。',
    responsibilities: ['主 UI 经 preload 与 IPC 调用 Electron main，再由 main 写入 Host 管道。', '本机调用身份进入 Cogent 原生协议处理；目标统一权限层可按本机身份应用策略。'],
    boundary: '当前 stdio 入口信任本机父进程，无网络 token；统一调用身份与资源策略尚待与权限层接通。',
    sources: [{ path: 'src/electron/main/host/manager.ts', symbol: 'spawn · request' }, { path: 'src/host/host-main.ts', symbol: 'stdin · handleFrame' }],
  },
  'access.network': {
    name: '网络入口', kind: 'HTTP · WebSocket', icon: Globe, status: 'implemented', showStatus: false, navigateTo: 'ingress',
    summary: 'UI、远程服务与 MCP Server 通过网络入口接入 Host；可选择 HTTP、WebSocket 或组合使用。',
    responsibilities: ['HTTP 提供请求与响应，WebSocket 提供持续连接、双向调用和事件推送。', '按本次调用所用协议分为 Cogent 原生调用与自有协议调用；MCP Server 已转换成 Cogent 原生协议。', '总览合并传输接线，接入视图展开独立通道；点线额外标明调用方与适配层的对应关系。'],
    boundary: '这里只合并图中的展示层级；HTTP 与 WebSocket 的传输和认证时机仍分别处理。',
    sources: [{ path: 'src/host/http/server.ts', symbol: '/rpc · /ws' }, { path: 'docs/模块/HTTP通道.md', symbol: 'HTTP、WebSocket 与事件边界' }, { path: 'tests/integration/http-auth.test.ts', symbol: '真实 Host 通道回归' }],
  },
  'access.network.http': {
    name: 'HTTP', kind: '网络传输 · 请求响应', icon: Globe, status: 'implemented',
    summary: '接收 UI 和 MCP Server 的 HTTP 请求，Cogent 原生调用入口为 /rpc。',
    responsibilities: ['每次请求校验凭据，再处理协议与方法权限。', '自定义 /xxx/chat 路由由目标协议适配层提供。'],
    boundary: 'HTTP Cogent 原生调用已实现，旧 chat 路由尚未实现。',
    sources: [{ path: 'src/host/http/server.ts', symbol: '/rpc' }, { path: 'src/host/mcp-server/host-client.ts', symbol: 'callHost' }],
  },
  'access.network.ws': {
    name: 'WebSocket', kind: '网络传输 · 双向消息与事件', icon: Network, status: 'implemented',
    summary: '通过 /ws 建立持续连接，承载方法调用和执行事件推送。',
    responsibilities: ['握手时验证 token，连接建立后复用身份。', '每条调用仍检查方法权限；MCP Server 通过此入口订阅任务结果。'],
    boundary: '连接认证通过不代表可以调用全部方法或访问全部资源。',
    sources: [{ path: 'src/host/http/server.ts', symbol: '/ws · upgrade' }, { path: 'src/host/mcp-server/host-client.ts', symbol: 'subscribeRun' }],
  },
  host: {
    name: '引擎服务（Host）', kind: '独立 Node 进程 · 主体分组', icon: Server, status: 'partial', showStatus: false,
    stages: [
      { label: '接入与协议', nodes: ['host.authentication', 'host.native', 'host.adapter'] },
      { label: '业务分发', nodes: ['host.policy', 'host.api', 'host.services'] },
      { label: '内核执行', nodes: ['host.runtime'] },
      { label: '模型出口', nodes: ['host.provider'] },
    ],
    summary: 'Host 按接入与协议、业务分发、内核执行三个阶段阅读，HostApi 与 KernelRunner 是两个衔接点。',
    responsibilities: ['接入链经身份、协议与权限检查进入 HostApi，再交给 Host 服务层。', '服务层在总览显示摘要卡片；执行能力在 KernelRunner 内显示摘要卡片，点击各自进入详细视图。', 'KernelRunner 包含执行能力、pi SDK 内核和其他内核预留；自带运行时、安全策略作为容器说明呈现。'],
    boundary: '这些职责在同一 Host 进程内；KernelRunner 是 CogentKernel 合同的架构称呼，不增加进程或 RPC。认证抽象、统一资源权限和旧协议适配属于待完成目标。',
    sources: [{ path: 'src/host/host-main.ts', symbol: 'main · handlers · handleFrame' }, { path: 'docs/计划/架构地图目标架构.md', symbol: '目标接线与完成度' }],
  },

  'host.authentication': {
    name: '身份认证', kind: '可替换的凭据验证 · 调用身份', icon: Fingerprint, status: 'partial',
    features: [{ label: 'Host token 校验', status: 'implemented' }, { label: '用户认证与统一身份', status: 'planned' }],
    summary: '确认调用方是谁，将凭据转换为后续权限检查使用的身份。',
    responsibilities: ['现有实现验证 Host 自签 token，并保留票据兑换作为一种凭据获取方式。', '目标允许用户系统 token 直接验证，不强制所有客户端重复票据兑换。', 'WS 建连后复用连接身份，方法调用仍须经过权限检查；失效策略随用户系统实现。'],
    boundary: '已实现 Host token 验证；用户系统接入、统一身份上下文和用户 token 生命周期尚未实现。',
    sources: [{ path: 'src/host/http/auth.ts', symbol: 'verifyToken · createCapabilityStore' }, { path: 'src/host/http/server.ts', symbol: 'HTTP 中间件 · WS upgrade' }, { path: 'docs/计划/架构地图目标架构.md', symbol: '目标认证接口' }],
  },
  'host.native': {
    name: 'Cogent 原生协议', kind: 'Cogent 原生方法 · JSON-RPC 2.0 子集', icon: Plug, status: 'implemented',
    summary: '外部可直接发送 Cogent 方法与参数，无需经过旧协议转换。',
    responsibilities: ['解析 JSON-RPC 请求，将 method 与 params 交给统一调用链。', '将响应、业务错误和事件按 Cogent 的响应与 notification 格式返回。'],
    boundary: '该能力已在 protocol 与 handleFrame 中实现，当前逻辑内联于入口和分发器，并非已经独立拆出的协议模块。',
    sources: [{ path: 'src/protocol/types.ts', symbol: 'RpcRequest · RpcResponse · RpcEvent' }, { path: 'src/host/host-main.ts', symbol: 'handleFrame · notify' }],
  },
  'host.adapter': {
    name: '自定义协议适配', kind: '适配调用方已有协议 · 双向转换', icon: Route, status: 'planned',
    summary: '为自有协议 UI 和远程服务保留接口约定，例如 /xxx/chat，由 Cogent 转换成统一调用。',
    responsibilities: ['调用方：已有自己协议的 UI 或远程服务；通过网络传输并完成身份认证后，直接进入本适配层。', '请求方向：解析调用方的路由、字段、会话标识与取消语义，映射成统一方法调用。', '返回方向：把调用结果、错误和流式事件编码为调用方约定的 JSON、SSE 或 WS 消息。', '转换后的调用进入同一权限检查和 HostApi。MCP Server 已在入口外转换为 Cogent 原生协议，走 Cogent 原生分支。'],
    boundary: '未实现。图定义适配职责，具体字段、流式事件和错误合同在接入实际旧协议时确定。',
    sources: [{ path: 'docs/决定.md', symbol: 'HTTP chat 门面' }, { path: 'docs/计划/架构地图目标架构.md', symbol: 'Cogent 原生 · 适配双分支' }],
  },
  'host.policy': {
    name: '权限检查', kind: '统一方法与资源策略', icon: ShieldCheck, status: 'partial',
    features: [{ label: '方法 scope 校验', status: 'implemented' }, { label: '用户与资源授权', status: 'planned' }],
    summary: '身份认证确认调用者是谁；权限检查结合调用身份、方法和目标资源，决定这次操作是否允许执行。',
    responsibilities: ['现行：HTTP 与 WS 在共享方法分发前校验 readonly、write、admin 等 scope，stdio 直接进入共享分发。', '目标：两种业务协议解析后使用同一方法权限检查，再按用户、项目与会话归属检查资源权限。', '工具执行时仍由审批逻辑按权限档、计划开关和工具类别作裁决。'],
    boundary: '当前 HTTP 与 WS 已有方法 scope 检查；用户/项目/会话归属、可定制的统一策略和本机调用身份接入尚未实现。API 授权通过后，执行层的具体工具操作仍可单独要求审批。',
    sources: [{ path: 'src/host/http/server.ts', symbol: 'METHOD_MIN_SCOPE · scopeAllows' }, { path: 'docs/计划/架构地图目标架构.md', symbol: '统一授权目标' }],
  },
  'host.api': {
    name: 'HostApi 分发', kind: '方法注册表 · 业务调度', icon: Layers3, status: 'implemented',
    summary: '用统一方法集合调度会话、任务与能力服务。',
    responsibilities: ['按 method 查找 handler，传递参数并返回结果或业务错误。', '现行由 stdio、HTTP 和 WebSocket 的原生调用共享方法表。目标中的自定义协议适配也会调用这组业务方法。'],
    boundary: '方法注册与分发已实现；HostApi 是方法集合，不是另一进程。完整的统一身份及资源权限按前置节点标记为部分实现。',
    sources: [{ path: 'src/host/host-main.ts', symbol: 'handlers · handleFrame' }, { path: 'src/protocol/types.ts', symbol: 'ProtocolMethods' }],
  },
  'host.services': {
    name: 'Host 服务层', kind: '会话 · 项目 · 凭据桥 · 观测 · 能力治理', icon: Layers3, status: 'implemented', showStatus: false, navigateTo: 'services', navigateOnClick: true,
    summary: '接收 HostApi 业务调用，管理会话、任务与项目，并协调凭据和能力配置。',
    responsibilities: ['SessionManager 管理任务受理、取消、恢复与业务摘要，项目服务维护工作区归属。', '凭据桥接收宿主注入的密钥，观测服务记录执行过程；能力配置交给对应装配模块。', '当前 Host 直接装配 SessionManager，由它实现 CogentKernel 并持有 pi 会话。Host 事件经 stdout 与 WebSocket 推送，HTTP POST 返回请求结果。'],
    boundary: '这些是 Host 内的服务职责，不是新进程。SessionManager 当前同时承担业务编排和内核合同实现，图按目标职责表达。',
    sources: [{ path: 'src/host/host-main.ts', symbol: 'handlers' }, { path: 'src/host/runtime/session.ts', symbol: 'SessionManager' }, { path: 'src/host/runtime/project.ts', symbol: '项目服务' }, { path: 'src/host/runtime/credentials.ts', symbol: 'CredentialRegistry' }, { path: 'src/host/runtime/inspector.ts', symbol: '观测服务' }],
  },
  'host.runtime.capabilities': {
    name: '执行能力', kind: '工具 · MCP · 技能 · 钩子 · 交互 · 子会话', icon: Blocks, status: 'partial', navigateTo: 'capabilities', navigateOnClick: true,
    features: [{ label: '工具 · MCP · 技能 · 钩子', status: 'implemented' }, { label: '子会话', status: 'planned' }],
    summary: 'KernelRunner 的能力装配清单，将 Host 配置接入 pi 的工具、扩展与提示段；本块用职责清单表达，不作为调用流程或连线支路。',
    responsibilities: ['内置工具与 MCP 进入 pi 工具管线，Skills 和 Hooks 提供知识加载与生命周期干预。', 'customTools 装配提问、方案确认、任务清单等交互工具。', '子会话预留给后续多 Agent 协作，当前未实现子会话调度。'],
    boundary: '本块属于 KernelRunner 的执行能力，与具体内核实现并列。当前复用 pi 内置工具和 MCP 扩展，并注入 Cogent 工具与钩子；PiSdkKernel 负责当前适配，其他内核仍需各自适配。外部 MCP Server 不属于此容器。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'customTools · extensionFactories · createMcpExtension' }, { path: 'src/host/runtime/skill-prompt.ts', symbol: '技能提示段' }, { path: 'src/host/runtime/hook-seat.ts', symbol: 'createCogentHooks' }, { path: 'docs/计划/全局架构.md', symbol: '能力装配与子会话预留' }],
  },
  'host.runtime': {
    name: 'KernelRunner', kind: 'CogentKernel · 执行容器与运行基础', icon: Plug, status: 'implemented', showStatus: false,
    boundaryNote: '安全边界：权限模式 · 计划 · 审批；OS 沙箱预留',
    summary: '统一内核合同的执行容器，包含执行能力、PiSdkKernel 和其他内核预留；能力与具体内核实现并列，运行时与安全策略随容器展示。',
    responsibilities: ['定义提交、取消、续写、压缩、转录读取和审批回填等操作；当前合同名称为 CogentKernel。', '自带 Node 22 按官方 SHA256 校验后分发，为整个 Host 进程提供运行环境；git 和 Python 使用系统环境。', '执行时按权限模式、计划开关和工具风险决定放行、阻止或人工审批；OS 级沙箱仍为预留。', '目标是在服务层和内核之间形成可替换的依赖边界。目前由 SessionManager 实现合同，内核使用 pi SDK。'],
    boundary: 'KernelRunner 是架构容器，没有同名类；CogentKernel 由 SessionManager 实现。运行时说明不代表 Node 只承载内核，应用层审批也不等于 OS 沙箱。',
    sources: [{ path: 'src/host/kernel/contract.ts', symbol: 'CogentKernel · KernelNotifier' }, { path: 'src/host/runtime/session.ts', symbol: 'SessionManager · decideApproval' }, { path: 'src/electron/main/host/runtime.ts', symbol: 'resolveEngineNodeBin' }, { path: 'scripts/fetch-runtime.mjs', symbol: 'NODE_VERSION · SHA256' }, { path: 'src/host/runtime/approvals.ts', symbol: 'ApprovalRegistry' }],
  },
  'host.runtime.kernel': {
    name: 'PiSdkKernel', kind: 'pi AgentSession · 当前内核实现', icon: Cpu, status: 'implemented',
    summary: '通过 pi SDK 运行 Agent 循环，处理模型、工具、上下文压缩和转录。',
    responsibilities: ['createPiSession 装配 pi AgentSession，执行模型与工具调用循环。', '作为 KernelRunner 内部实现消费工具、扩展与模型调用；图上的外部关系统一连接执行容器。', 'pi JSONL 保存会话转录，Host 保存会话业务摘要。'],
    boundary: 'PiSdkKernel 是架构角色，装配入口是 pi-session-factory.ts；通过 SDK 在 Host 进程内运行，当前没有第二套内核。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'createPiSession · createAgentSession' }, { path: 'src/host/kernel/transcript.ts', symbol: 'readPiTranscript' }],
  },
  'host.runtime.alternative': {
    name: '其他内核', kind: 'PiRpcKernel · 其他实现预留', icon: Cpu, status: 'planned',
    summary: '为将来替换内核保留统一接口，目前没有可切换的第二实现。',
    responsibilities: ['PiRpcKernel 预留给独立进程、崩溃隔离或独立版本的执行方式。', '其他内核接入前须验证 CogentKernel 的操作与事件语义。'],
    boundary: '接口预留不等于已有内核切换功能；当前只维护 pi SDK。',
    sources: [{ path: 'docs/决定.md', symbol: '只维护 PiSdkKernel' }, { path: 'src/host/kernel/contract.ts', symbol: 'CogentKernel' }],
  },

  'host.provider': {
    name: '模型协议适配', kind: 'Provider · 出站协议', icon: Route, status: 'partial',
    features: [{ label: 'OpenAI · Anthropic', status: 'implemented' }, { label: '任意出站协议适配', status: 'planned' }],
    summary: 'Cogent 主动请求远端模型时，在这里遵循远端要求的协议。',
    responsibilities: ['现有 OpenAI Completions、Responses 与 Anthropic 方言负责请求和流式响应转换。', '若远端固定为自定义 /xxx/chat 契约，在此扩展出站适配，保留远端字段、错误与取消语义。', '将远端响应还原为内核可消费的模型事件。'],
    boundary: '自定义 Provider 已可配置端点并选择三种现有方言。任意旧接口契约的出站适配仍待实现。入站协议适配由独立的目标节点描述。',
    sources: [{ path: 'src/host/runtime/custom-providers.ts', symbol: 'API_BY_FORMAT · buildCustomProvider' }, { path: 'src/host/kernel/pi-session-factory.ts', symbol: 'modelRuntime' }],
  },
  'host.services.sessions': {
    name: '会话与任务', kind: '受理 · 取消 · 恢复', icon: Layers3, status: 'implemented',
    summary: '管理会话、任务生命周期与业务摘要。', responsibilities: ['SessionManager 受理提交、管理取消与恢复、保存业务摘要，并实现 CogentKernel 合同。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/runtime/session.ts', symbol: 'SessionManager' }, { path: 'docs/模块/会话与对话.md', symbol: '受理、转录与回合' }, { path: 'docs/测试用例/会话与对话.md', symbol: '会话操作验收' }],
  },
  'host.services.projects': {
    name: '项目管理', kind: '工作区 · 会话归属', icon: Layers3, status: 'implemented',
    summary: '维护项目、工作区与会话的对应关系。', responsibilities: ['维护项目、工作区与会话的对应关系。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/runtime/project.ts', symbol: '项目服务' }, { path: 'docs/模块/工作区与项目.md', symbol: '项目与工作区归属' }, { path: 'docs/测试用例/工作区与项目.md', symbol: '项目与侧栏验收' }],
  },
  'host.services.credentials': {
    name: '凭据桥', kind: '宿主密钥注入', icon: Layers3, status: 'implemented',
    summary: '接收宿主提供的凭据，供 Host 的模型与能力调用使用。', responsibilities: ['接收宿主提供的凭据，供 Host 的模型与能力调用使用。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/runtime/credentials.ts', symbol: 'CredentialRegistry' }],
  },
  'host.services.observability': {
    name: '执行观测', kind: '事件 · 运行记录', icon: Layers3, status: 'implemented',
    summary: '记录运行过程并向客户端提供执行观测。', responsibilities: ['记录运行过程并向客户端提供执行观测。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/runtime/inspector.ts', symbol: '观测服务' }, { path: 'docs/模块/运行时控制台.md', symbol: '观测事件与落盘' }, { path: 'docs/测试用例/运行时控制台.md', symbol: '控制台验收' }],
  },
  'host.services.configuration': {
    name: '能力配置', kind: '工具 · MCP · 技能 · 钩子', icon: Layers3, status: 'implemented',
    summary: '把 Host 管理的能力配置交给工具与扩展装配入口。', responsibilities: ['把 Host 管理的能力配置交给工具与扩展装配入口。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'customTools · extensionFactories' }],
  },
  'host.runtime.capabilities.tools': {
    name: '内置工具', kind: '文件 · 搜索 · 执行', icon: Blocks, status: 'implemented',
    summary: '将内置文件、搜索和执行工具装配到 pi 工具管线。', responsibilities: ['将内置文件、搜索和执行工具装配到 pi 工具管线。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'createPiSession' }],
  },
  'host.runtime.capabilities.mcp': {
    name: 'MCP 工具', kind: '外部工具连接与装配', icon: Blocks, status: 'implemented',
    summary: '把 Agent 消费的 MCP 工具装配进内核，区别于对外 MCP Server。', responsibilities: ['把 Agent 消费的 MCP 工具装配进内核，区别于对外 MCP Server。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'createMcpExtension' }],
  },
  'host.runtime.capabilities.skills': {
    name: '技能', kind: '知识与提示段加载', icon: Blocks, status: 'implemented',
    summary: '加载技能知识和提示段，供会话按需使用。', responsibilities: ['加载技能知识和提示段，供会话按需使用。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/runtime/skill-prompt.ts', symbol: '技能提示段' }],
  },
  'host.runtime.capabilities.hooks': {
    name: '钩子', kind: '生命周期干预', icon: Blocks, status: 'implemented',
    summary: '在 Agent 生命周期中执行 Cogent 钩子逻辑。', responsibilities: ['在 Agent 生命周期中执行 Cogent 钩子逻辑。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/runtime/hook-seat.ts', symbol: 'createCogentHooks' }],
  },
  'host.runtime.capabilities.interaction': {
    name: '交互工具', kind: '提问 · 方案 · 任务清单', icon: Blocks, status: 'implemented',
    summary: '装配提问、方案确认和任务清单工具，并与客户端交互。', responsibilities: ['装配提问、方案确认和任务清单工具，并与客户端交互。'],
    boundary: '这是 Host 进程内的职责，不增加独立服务或 RPC。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'customTools' }],
  },
  'host.runtime.capabilities.subagents': {
    name: '子会话', kind: '多 Agent 调度预留', icon: Blocks, status: 'planned',
    summary: '为多 Agent 协作预留子会话调度能力，当前尚未实现。', responsibilities: ['为多 Agent 协作预留子会话调度能力，当前尚未实现。'],
    boundary: '仅为目标扩展位，当前没有子会话调度器。',
    sources: [{ path: 'docs/计划/全局架构.md', symbol: '子会话预留' }],
  },
  users: {
    name: '用户系统', kind: '目标外部身份来源', icon: Users, status: 'planned',
    summary: '为 Host 提供可验证的用户 token 和用户身份。',
    responsibilities: ['用户登录后获得 token，由认证层按用户系统合同验证。', '提供稳定用户身份，供项目与会话权限判断使用。'],
    boundary: '未实现账号系统或其接入；此处不预设 JWT、会话存储或特定身份供应商。',
    sources: [{ path: 'docs/计划/架构地图目标架构.md', symbol: '用户身份接入目标' }],
  },
  models: {
    name: '远端模型 API', kind: '模型服务 · 固定远端契约', icon: Bot, status: 'external',
    summary: '按已有约定接收 Cogent 请求，返回模型结果或流式响应。',
    responsibilities: ['可采用现有标准模型 API，也可保留远端定义的旧 /xxx/chat 契约。', '请求和返回格式差异由 Cogent 出站协议适配承担。'],
    boundary: '外部服务不计为 Cogent 的已实现模块；各 API 的兼容范围按出站适配器实际能力判断。',
    sources: [{ path: 'src/host/runtime/custom-providers.ts', symbol: '远端请求方言' }, { path: 'docs/计划/架构地图目标架构.md', symbol: '出站适配边界' }],
  },
}

export const overviewDetail: ModuleDetail = {
  name: '架构总览', kind: '目标架构 · 按能力标注完成度', icon: Layers3, status: 'partial', showStatus: false,
  summary: '接入与协议处理后进入 HostApi，沿服务层直达 KernelRunner，再连接模型出口。HostApi 与 KernelRunner 是两个衔接点。',
  responsibilities: ['Host 大框按接入与协议、业务分发、内核执行、模型出口排列；KernelRunner 内部包含执行能力、PiSdkKernel 与其他内核预留。', '服务层与执行能力在总览显示摘要卡片，点击进入详细视图；运行时与安全策略合并为 KernelRunner 容器说明。', '实线表示调用流程，点线表示协议适配关系，标签旁的橙点表示尚未实现的关系，交叉留白表示跨线。内核替换、子会话和 OS 沙箱保留待完成状态。'],
  boundary: '本图描述目标接线。实际进程与调用顺序见《当前架构》，节点状态反映能力进度。',
  sources: [
    { path: 'docs/架构.md', symbol: '当前进程与依赖边界' },
    { path: 'docs/模块/索引.md', symbol: '按任务追踪实现与验收' },
    { path: 'docs/模块/测试.md', symbol: '测试命令与手测入口' },
    { path: 'docs/计划/架构地图目标架构.md', symbol: '目标接线、状态与依据' },
  ],
}

export const viewDetails: Record<ViewId, ModuleDetail> = {
  services: { ...moduleDetails['host.services'], navigateTo: undefined, name: 'Host 服务层详情' },
  capabilities: { ...moduleDetails['host.runtime.capabilities'], navigateTo: undefined, name: '执行能力详情' },
  overview: overviewDetail,
  ingress: {
    ...overviewDetail,
    name: '接入链路', kind: '传输 → 认证 → 协议 → 权限 → HostApi',
    summary: '外部可直接使用 Cogent 原生协议，也可沿用既有协议，由适配器转换请求和返回。',
    responsibilities: ['现行：POST /rpc 校验请求凭据，WebSocket /ws 在建连时验证凭据，两者先检查方法 scope 再进入共享分发。stdio 直接进入共享分发。', '现行：POST 只返回本次响应，运行事件经 stdout 与 WebSocket 推送。', '目标：原生和自定义协议解析后汇入统一授权；用户 token 认证、资源权限及旧 chat 适配属于该目标。'],
    boundary: '已实现 Cogent 原生通道、Host token 和方法 scope；用户系统、统一资源策略与自定义协议适配仍按节点标注推进。',
  },
  execution: {
    ...overviewDetail,
    name: '执行链路', kind: '服务 · 能力 · 内核 · 运行基础',
    summary: 'Host 管业务生命周期，pi 管执行循环；入站 API 授权、工具审批与出站模型适配分别处理。',
    responsibilities: ['现行：Host 装配 SessionManager，由它编排会话并在进程内驱动 pi SDK。', '执行能力装配工具、MCP、技能、钩子与交互工具；自带 Node 提供运行环境，安全边界约束具体工具操作。', '模型协议适配处理出站请求与流式返回。图中的 KernelRunner 表示目标职责边界，其他内核、子会话及 OS 沙箱仍待实现。'],
    boundary: 'pi SDK 与现有能力已接通；第二内核、子会话、OS 沙箱及任意旧模型契约适配尚未实现。',
  },
}
