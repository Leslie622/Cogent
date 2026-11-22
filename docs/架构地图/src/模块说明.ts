/** 目标职责、能力完成度与源码依据；图上状态以此为唯一来源，不把设计当作实现。 */
import { Blocks, Bot, Cpu, Fingerprint, Globe, Layers3, Network, Plug, Route, Server, ShieldCheck, Terminal, Users, type LucideIcon } from 'lucide-react'
import type { ImplementationStatus } from './实现状态'
import type { ViewId } from './视图'

export interface ModuleFeature {
  label: string
  status: 'implemented' | 'planned'
}

export interface ModuleDetail {
  name: string
  kind: string
  icon: LucideIcon
  status: ImplementationStatus
  showStatus?: boolean
  features?: ModuleFeature[]
  summary: string
  responsibilities: string[]
  boundary: string
  sources: { path: string; symbol: string }[]
  navigateTo?: ViewId
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
    sources: [{ path: 'src/host/mcp-server/main.ts', symbol: 'StdioServerTransport' }, { path: 'src/host/mcp-server/tools.ts', symbol: 'registerTool · toolResult' }, { path: 'src/host/mcp-server/host-client.ts', symbol: 'callHost · subscribeRun' }],
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
    sources: [{ path: 'src/host/http/server.ts', symbol: '/rpc · /ws' }],
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
    name: '引擎服务（Host）', kind: '独立 Node 进程 · 目标分层', icon: Server, status: 'partial', showStatus: false,
    summary: '在同一进程承载接入处理、业务调度、Agent 执行和出站模型调用。',
    responsibilities: ['Cogent 原生协议与自定义协议各自处理输入输出，统一进入权限检查及 HostApi。', '会话服务通过 CogentKernel 驱动 pi，能力通过工具、扩展和提示段装配。'],
    boundary: 'Host、Cogent 原生调用与 pi 已运行；图中的认证抽象、统一资源权限和旧协议适配属于待完成目标。',
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
    sources: [{ path: 'docs/计划/全局架构.md', symbol: 'D15 HTTP chat 门面' }, { path: 'docs/计划/架构地图目标架构.md', symbol: 'Cogent 原生 · 适配双分支' }],
  },
  'host.policy': {
    name: '权限检查', kind: '统一方法与资源策略', icon: ShieldCheck, status: 'partial',
    features: [{ label: '方法 scope 校验', status: 'implemented' }, { label: '用户与资源授权', status: 'planned' }],
    summary: '身份认证确认调用者是谁；权限检查结合调用身份、方法和目标资源，决定这次操作是否允许执行。',
    responsibilities: ['方法权限：按 readonly、write、admin 等 scope 判断能否读取、修改或执行管理方法；Cogent 原生协议与自定义协议转换后的调用使用同一套判断。', '资源权限（目标）：检查用户能否访问指定项目或会话。例如可以读取自己的会话，也不能因此读取其他用户的会话。', '调用检查：HTTP 每次请求、WS 每条调用都检查权限；WS 连接认证通过后复用身份，不能跳过具体操作的授权。', '策略扩展（目标）：权限规则可以按用户角色、项目成员和会话归属定制；调用通过后交给 HostApi 分发，拒绝时直接返回权限错误。'],
    boundary: '当前 HTTP 与 WS 已有方法 scope 检查；用户/项目/会话归属、可定制的统一策略和本机调用身份接入尚未实现。API 授权通过后，执行层的具体工具操作仍可单独要求审批。',
    sources: [{ path: 'src/host/http/server.ts', symbol: 'METHOD_MIN_SCOPE · scopeAllows' }, { path: 'docs/计划/架构地图目标架构.md', symbol: '统一授权目标' }],
  },
  'host.api': {
    name: 'HostApi 分发', kind: '方法注册表 · 业务调度', icon: Layers3, status: 'implemented',
    summary: '用统一方法集合调度会话、任务与能力服务。',
    responsibilities: ['按 method 查找 handler，传递参数并返回结果或业务错误。', 'Cogent 原生入口与旧协议适配入口复用同一组业务方法。'],
    boundary: '方法注册与分发已实现；HostApi 是方法集合，不是另一进程。完整的统一身份及资源权限按前置节点标记为部分实现。',
    sources: [{ path: 'src/host/host-main.ts', symbol: 'handlers · handleFrame' }, { path: 'src/protocol/types.ts', symbol: 'ProtocolMethods' }],
  },
  'host.runtime': {
    name: 'Agent 执行', kind: '会话 · 内核 · 能力', icon: Cpu, status: 'implemented', showStatus: false, navigateTo: 'execution',
    summary: '管理任务生命周期，装配能力并让 pi 执行 Agent 循环。',
    responsibilities: ['SessionManager 负责受理、恢复、取消和业务状态。', 'pi 执行模型与工具循环，工具、MCP、技能、钩子和审批在此消费。'],
    boundary: '执行层位于 Host 内，不为不同 UI 或外部协议复制引擎。当前内核只维护 pi SDK。',
    sources: [{ path: 'src/host/runtime/session.ts', symbol: 'SessionManager' }, { path: 'src/host/kernel/pi-session-factory.ts', symbol: 'createPiSession' }],
  },
  'host.runtime.sessions': {
    name: '会话与任务', kind: 'SessionManager · 业务生命周期', icon: Layers3, status: 'implemented',
    summary: '把已受理调用组织成有会话身份和生命周期的任务。',
    responsibilities: ['管理任务受理、取消、恢复和业务摘要。', '经 CogentKernel 调用内核，并将执行结果投影成 Host 事件。'],
    boundary: '任务受理不代表模型执行完成。pi JSONL 转录与 Host 业务摘要分域保存。',
    sources: [{ path: 'src/host/runtime/session.ts', symbol: 'SessionManager · submit' }, { path: 'src/host/kernel/contract.ts', symbol: 'CogentKernel' }],
  },
  'host.runtime.capabilities': {
    name: 'Agent 能力', kind: '工具 · MCP · Skills · Hooks · 交互', icon: Blocks, status: 'implemented',
    summary: '通过工具、扩展和提示段为 Agent 提供环境操作与用户协作能力。',
    responsibilities: ['工具与 MCP 进入 pi 工具管线；Skills 与 Hooks 负责知识加载和执行节点干预。', '交互工具连接提问、方案确认与任务清单，工具审批决定具体操作是否继续。'],
    boundary: '工具执行审批与入口 API 授权是不同检查，二者均需保留；能力分类不是独立进程。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'customTools · extensionFactories' }, { path: 'src/host/runtime/hook-seat.ts', symbol: 'createCogentHooks' }, { path: 'src/host/runtime/interact-tools.ts', symbol: '交互工具' }],
  },
  'host.runtime.kernel': {
    name: 'pi 内核', kind: 'AgentSession · SDK', icon: Cpu, status: 'implemented',
    summary: '运行 Agent 循环，处理工具、上下文、压缩和会话转录。',
    responsibilities: ['执行模型请求与工具调用循环。', '消费 Host 装配的能力，并通过事件回报执行过程。'],
    boundary: '通过 SDK 在 Host 进程内运行。CogentKernel 是 TypeScript 接口，不是另一条 RPC 通道。',
    sources: [{ path: 'src/host/kernel/pi-session-factory.ts', symbol: 'createAgentSession' }, { path: 'src/host/kernel/transcript.ts', symbol: 'readPiTranscript' }],
  },
  'host.provider': {
    name: '模型协议适配', kind: 'Provider · 出站协议', icon: Route, status: 'partial',
    features: [{ label: 'OpenAI · Anthropic', status: 'implemented' }, { label: '自定义模型接口', status: 'planned' }],
    summary: 'Cogent 主动请求远端模型时，在这里遵循远端要求的协议。',
    responsibilities: ['现有 OpenAI Completions、Responses 与 Anthropic 方言负责请求和流式响应转换。', '若远端固定为自定义 /xxx/chat 契约，在此扩展出站适配，保留远端字段、错误与取消语义。', '将远端响应还原为内核可消费的模型事件。'],
    boundary: '已有三种模型方言；任意自定义旧契约的适配尚未实现。这里是 Cogent 调用远端，区别于外部调用 Cogent 的入站协议适配。',
    sources: [{ path: 'src/host/runtime/custom-providers.ts', symbol: 'API_BY_FORMAT · buildCustomProvider' }, { path: 'src/host/kernel/pi-session-factory.ts', symbol: 'modelRuntime' }],
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
  summary: 'Cogent 原生协议直接接入，自定义协议双向适配；二者经统一权限检查进入同一个 HostApi。',
  responsibilities: ['双向箭头表示请求及响应、事件的正反方向；点线表示协议适配关系，长虚线表示待实现调用，交叉处留白表示跨过连线。', '接入视图展开传输、认证、Cogent 原生与适配分支；执行视图展开会话、pi、能力与出站调用。', '节点完成度描述已有能力，部分逻辑目前内联于入口与分发器，尚未按目标结构物理拆分。'],
  boundary: '本图用于指导后续实现。本批没有实现用户系统、资源权限或自定义协议接口。',
  sources: [{ path: 'docs/计划/架构地图目标架构.md', symbol: '目标接线、状态与依据' }, { path: 'docs/架构.md', symbol: '当前进程与依赖边界' }],
}

export const viewDetails: Record<ViewId, ModuleDetail> = {
  overview: overviewDetail,
  ingress: {
    ...overviewDetail,
    name: '接入链路', kind: '传输 → 认证 → 协议 → 权限 → HostApi',
    summary: '外部可直接使用 Cogent 原生协议，也可沿用既有协议，由适配器转换请求和返回。',
    responsibilities: ['HTTP 与 WS 先验证连接身份，再按 Cogent 原生 /rpc、/ws 或既有 /xxx/chat 分流。', '两条协议分支均进入同一个权限检查，再交 HostApi 分发；返回沿反向路径编码为 Cogent 原生通知或旧协议流。', 'stdio 代表受信任本机调用，进入 Cogent 原生协议分支；用户 token 校验由可替换的认证实现提供。'],
    boundary: '已实现 Cogent 原生通道、Host token 和方法 scope；用户系统、统一资源策略与自定义协议适配仍按节点标注推进。',
  },
  execution: {
    ...overviewDetail,
    name: '执行链路', kind: '业务服务 → pi → 出站协议',
    summary: 'Host 管业务生命周期，pi 管执行循环；入站 API 授权、工具审批与出站模型适配分别处理。',
    responsibilities: ['会话服务通过 CogentKernel 在进程内驱动 pi。', '工具、MCP、技能、钩子和交互能力按 pi 的工具与扩展机制装配，具体工具操作仍须审批。', 'Cogent 调用远端时由模型协议适配器处理请求和流式返回；与外部调用 Cogent 的入站适配器职责分开。'],
    boundary: 'pi SDK 与现有能力已接通；任意远端旧 /xxx/chat 的出站适配尚未实现。',
  },
}
