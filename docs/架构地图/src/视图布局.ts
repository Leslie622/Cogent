/** 声明式列/泳道拓扑：增删节点只影响所在列或泳道，其余模块坐标保持稳定。 */
import type { ViewId } from './视图'

export interface GridSlot {
  col: number
  lane: number
}

export interface StageSpec {
  label: string
  nodes: readonly string[]
}

export interface ViewLayoutSpec {
  /** 叶子节点与紧凑行容器的逻辑 (列, 泳道) 槽位。 */
  slots: Record<string, GridSlot>
  /** 将指定容器的子节点单排横向紧凑排列，以容器整体参与外层网格。 */
  rowContainers?: Record<string, readonly string[]>
  /** 容器顶部阶段范围标题。 */
  stages?: Record<string, readonly StageSpec[]>
  /** 容器底部边界说明。 */
  notes?: Record<string, string>
  /** 泳道左侧或顶部标签（仅用于无跨行容器的平行泳道图）。 */
  laneLabels?: Record<number, string>
}

export const viewLayouts: Record<ViewId, ViewLayoutSpec> = {
  overview: {
    slots: {
      desktop: { col: 0, lane: 0 },
      nativeClients: { col: 0, lane: 1 },
      customClients: { col: 0, lane: 2 },
      externalAgent: { col: 0, lane: 3 },

      'access.stdio': { col: 1, lane: 0 },
      'access.network': { col: 1, lane: 2 },
      mcp: { col: 1, lane: 3 },

      'host.native': { col: 2, lane: 0 },
      'host.authentication': { col: 2, lane: 2 },
      'host.adapter': { col: 3, lane: 2 },

      'host.policy': { col: 4, lane: 0 },
      'host.api': { col: 5, lane: 0 },
      'host.services': { col: 6, lane: 0 },
      'host.runtime': { col: 7, lane: 0 },
      'host.provider': { col: 8, lane: 0 },
      models: { col: 9, lane: 0 },
    },
    rowContainers: {
      'host.runtime': ['host.runtime.capabilities', 'host.runtime.kernel', 'host.runtime.alternative'],
    },
    stages: {
      host: [
        { label: '接入与协议', nodes: ['host.authentication', 'host.native', 'host.adapter'] },
        { label: '业务分发', nodes: ['host.policy', 'host.api', 'host.services'] },
        { label: '内核执行', nodes: ['host.runtime'] },
        { label: '模型出口', nodes: ['host.provider'] },
      ],
    },
    notes: {
      'host.runtime': '安全边界：权限模式 · 计划 · 审批；OS 沙箱预留',
    },
  },

  desktopShell: {
    slots: {
      'desktop.renderer.ui': { col: 0, lane: 0 },
      'desktop.renderer.workspace': { col: 0, lane: 2 },
      'desktop.preload.main': { col: 1, lane: 0 },
      'desktop.preload.guest': { col: 1, lane: 2 },
      'desktop.main.ipc': { col: 2, lane: 0 },
      'desktop.main.credentials': { col: 2, lane: 1 },
      'desktop.main.browser': { col: 2, lane: 2 },
      'desktop.main.hostManager': { col: 3, lane: 0 },
      'access.stdio': { col: 4, lane: 0 },
      'access.network': { col: 4, lane: 3 },
    },
    notes: {
      'desktop.renderer': '无 Node 权限；仅消费 window.cogent 白名单',
      'desktop.main': '所有外部输入在 IPC 与 webview 边界强制收窄',
    },
  },

  services: {
    slots: {
      'host.api': { col: 0, lane: 1 },
      'host.services.projects': { col: 1, lane: 0 },
      'host.services.credentials': { col: 1, lane: 1 },
      'host.services.observability': { col: 1, lane: 2 },
      'host.services.sessions': { col: 2, lane: 0 },
      'host.services.configuration': { col: 2, lane: 2 },
      'host.runtime.capabilities': { col: 3, lane: 2 },
    },
  },

  capabilities: {
    slots: {
      'host.services.configuration': { col: 0, lane: 1 },
      'host.runtime.capabilities.tools': { col: 1, lane: 0 },
      'host.runtime.capabilities.mcp': { col: 1, lane: 1 },
      'host.runtime.capabilities.skills': { col: 1, lane: 2 },
      'host.runtime.capabilities.hooks': { col: 2, lane: 0 },
      'host.runtime.capabilities.interaction': { col: 2, lane: 1 },
      'host.runtime.capabilities.subagents': { col: 2, lane: 2 },
      'host.runtime.kernel': { col: 3, lane: 1 },
    },
  },

  storage: {
    slots: {
      'desktop.main': { col: 0, lane: 0 },
      'host.services': { col: 0, lane: 4 },
      'host.runtime.kernel': { col: 0, lane: 8 },

      'storageRoot.shellPrefs': { col: 1, lane: 0 },
      'storageRoot.credentials': { col: 1, lane: 1 },
      'storageRoot.business': { col: 1, lane: 2 },
      'storageRoot.sessions': { col: 1, lane: 3 },
      'storageRoot.outputs': { col: 1, lane: 4 },
      'storageRoot.inspect': { col: 1, lane: 5 },
      'storageRoot.attachments': { col: 1, lane: 6 },
      'storageRoot.searchIndex': { col: 1, lane: 7 },
      'storageRoot.transcript': { col: 1, lane: 8 },
    },
    notes: {
      storageRoot: '单写者纪律：同文件禁止跨进程双写；原子写入先写 .tmp 再 rename 替换',
    },
  },

  // 1a. 身份验证与权限（逻辑版）
  flowAuth: {
    slots: {
      'flow.auth.entries.stdio': { col: 0, lane: 0 },
      'flow.auth.entries.http': { col: 0, lane: 1 },
      'flow.auth.entries.ws': { col: 0, lane: 2 },
      'flow.auth.entries.userSys': { col: 0, lane: 3 },
      'flow.auth.ticket': { col: 1, lane: 1 },
      'flow.auth.verify': { col: 2, lane: 2 },
      'flow.auth.native': { col: 3, lane: 0 },
      'flow.auth.adapter': { col: 3, lane: 2 },
      'flow.auth.scope': { col: 4, lane: 1 },
      'flow.auth.resource': { col: 5, lane: 1 },
      'flow.auth.dispatch': { col: 6, lane: 1 },
    },
    notes: {
      'flow.auth.entries': '三路实装入口共用唯一业务表，网络入口内置 1MB 帧限与并发背压护栏',
    },
  },

  // 1b. 身份验证与权限（源码调用图）
  flowAuthCode: {
    slots: {
      'flow.authCode.ipc': { col: 0, lane: 0 },
      'flow.authCode.manager': { col: 1, lane: 0 },
      'flow.authCode.httpServer': { col: 0, lane: 1 },
      'flow.authCode.capStore': { col: 1, lane: 1 },
      'flow.authCode.wsServer': { col: 0, lane: 2 },
      'flow.authCode.verifyToken': { col: 2, lane: 2 },
      'flow.authCode.parseFrame': { col: 3, lane: 1 },
      'flow.authCode.scopeGate': { col: 4, lane: 1 },
      'flow.authCode.handlers': { col: 5, lane: 1 },
    },
    laneLabels: {
      0: '桌面壳可信 IPC → Host stdio 本机管道',
      1: 'HTTP 入口 · 短票兑换 · 协议解析 · METHOD_ACCESS 门禁与分发',
      2: 'WebSocket 握手与统一恒时验签',
    },
  },

  // 2a. 消息与审批闭环（逻辑版）
  flowApproval: {
    slots: {
      'flow.approval.submit.ui': { col: 0, lane: 1 },
      'flow.approval.submit.gate': { col: 1, lane: 1 },
      'flow.approval.loop': { col: 2, lane: 1 },
      'flow.approval.matrix': { col: 3, lane: 1 },
      'flow.approval.allowFast': { col: 4, lane: 0 },
      'flow.approval.blockPlan': { col: 4, lane: 1 },
      'flow.approval.pending': { col: 4, lane: 2 },
      'flow.approval.panel': { col: 5, lane: 2 },
      'flow.approval.settle': { col: 6, lane: 1 },
      'flow.approval.stream': { col: 6, lane: 0 },
    },
    notes: {
      'flow.approval.submit': '白名单代理隔离高敏通道，Host 同步占位后立即回传运行号',
    },
  },

  // 2b. 消息与审批闭环（源码调用图）
  flowApprovalCode: {
    slots: {
      'flow.approvalCode.chat': { col: 0, lane: 0 },
      'flow.approvalCode.engineIpc': { col: 1, lane: 0 },
      'flow.approvalCode.sessionSubmit': { col: 2, lane: 0 },
      'flow.approvalCode.hookBridge': { col: 3, lane: 0 },
      'flow.approvalCode.decide': { col: 4, lane: 0 },
      'flow.approvalCode.finish': { col: 6, lane: 0 },

      'flow.approvalCode.pendingMap': { col: 4, lane: 1 },
      'flow.approvalCode.panelUi': { col: 5, lane: 1 },
      'flow.approvalCode.approvalIpc': { col: 6, lane: 1 },

      'flow.approvalCode.events': { col: 7, lane: 1 },
    },
    laneLabels: {
      0: '消息提交、双路工具拦截、五级矩阵判定与权威终态',
      1: '无超时挂起表、面板裁决、专属 approval:respond 与流式广播',
    },
  },

  // 3a. MCP 双轨机制（逻辑版）
  flowMcp: {
    slots: {
      'flow.mcpFlow.client.config': { col: 0, lane: 0 },
      'flow.mcpFlow.client.trust': { col: 1, lane: 0 },
      'flow.mcpFlow.client.connect': { col: 2, lane: 0 },
      'flow.mcpFlow.client.guard': { col: 3, lane: 0 },

      'flow.mcpFlow.server.access': { col: 0, lane: 1 },
      'flow.mcpFlow.server.entry': { col: 1, lane: 1 },
      'flow.mcpFlow.server.reread': { col: 2, lane: 1 },
      'flow.mcpFlow.server.fast': { col: 3, lane: 1 },
      'flow.mcpFlow.server.wait': { col: 3, lane: 2 },
      'flow.mcpFlow.server.host': { col: 4, lane: 1 },
    },
    notes: {
      'flow.mcpFlow.client': '用户级唯一定义真源，项目级禁新增服务，首次发消息定格快照',
      'flow.mcpFlow.server': '独立翻译进程不启第二引擎，直连运行中同一 Host，桌面与外部共享状态',
    },
  },

  // 3b. MCP 双轨机制（源码调用图）
  flowMcpCode: {
    slots: {
      'flow.mcpCode.mcpStore': { col: 0, lane: 0 },
      'flow.mcpCode.mcpExt': { col: 1, lane: 0 },
      'flow.mcpCode.mcpAllow': { col: 2, lane: 0 },
      'flow.mcpCode.mcpGuard': { col: 3, lane: 0 },

      'flow.mcpCode.accessFile': { col: 0, lane: 1 },
      'flow.mcpCode.mcpServer': { col: 1, lane: 1 },
      'flow.mcpCode.readAcc': { col: 2, lane: 1 },
      'flow.mcpCode.subRun': { col: 3, lane: 2 },
      'flow.mcpCode.hostEntry': { col: 4, lane: 1 },
    },
    laneLabels: {
      0: 'MCP 座（消费外部）：配置合并 → 扩展连接 → 白名单与审批落盘',
      1: '对外 MCP（暴露服务）：凭据文件 → 独立入口 → 重读直发与唯一 Host',
      2: '等待终态两段式订阅（先 WS ready 再 HTTP /rpc）',
    },
  },

  // 4a. 技能加载机制（逻辑版）
  flowSkills: {
    slots: {
      'flow.skills.writePath.ui': { col: 0, lane: 0 },
      'flow.skills.writePath.store': { col: 1, lane: 0 },
      'flow.skills.discover': { col: 2, lane: 1 },
      'flow.skills.budget': { col: 3, lane: 1 },
      'flow.skills.refresh': { col: 4, lane: 1 },
      'flow.skills.consume.auto': { col: 5, lane: 0 },
      'flow.skills.consume.manual': { col: 5, lane: 2 },
    },
    notes: {
      'flow.skills.writePath': '生态目录只读，自有目录原子写盘，改动在下一回合自然生效',
      'flow.skills.consume': '正文永不缓存，每次现读磁盘最新内容',
    },
  },

  // 4b. 技能加载机制（源码调用图）
  flowSkillsCode: {
    slots: {
      'flow.skillsCode.ui': { col: 0, lane: 0 },
      'flow.skillsCode.save': { col: 1, lane: 0 },
      'flow.skillsCode.scan': { col: 2, lane: 0 },

      'flow.skillsCode.hook': { col: 1, lane: 1 },
      'flow.skillsCode.format': { col: 3, lane: 1 },
      'flow.skillsCode.diff': { col: 4, lane: 1 },
      'flow.skillsCode.consume': { col: 5, lane: 1 },
    },
    laneLabels: {
      0: '配置写盘与四目录无缓存活扫（SkillStore）',
      1: '回合前拉取、20K/250 预算格式化、sections diff 与双路消费',
    },
  },

  // 5a. 钩子与扩展机制（逻辑版）
  flowHooks: {
    slots: {
      'flow.hooks.assembly': { col: 0, lane: 1 },
      'flow.hooks.extHooks.turn': { col: 1, lane: 0 },
      'flow.hooks.extHooks.compact': { col: 2, lane: 0 },
      'flow.hooks.extHooks.nested': { col: 3, lane: 0 },
      'flow.hooks.wrappers.approval': { col: 1, lane: 1 },
      'flow.hooks.wrappers.cancel': { col: 2, lane: 1 },
      'flow.hooks.wrappers.observe': { col: 3, lane: 1 },
      'flow.hooks.extensions.native': { col: 1, lane: 2 },
      'flow.hooks.extensions.plugins': { col: 2, lane: 2 },
    },
    notes: {
      'flow.hooks.extHooks': '沿内核官方事件形状接入，不魔改上游源码',
      'flow.hooks.wrappers': '保留并委托内核原链，绝不覆盖破坏',
      'flow.hooks.extensions': '坚持不自研插件运行时，插件仅作静态打包分发',
    },
  },

  // 5b. 钩子与扩展机制（源码调用图）
  flowHooksCode: {
    slots: {
      'flow.hooksCode.factory': { col: 0, lane: 1 },
      'flow.hooksCode.turnHook': { col: 1, lane: 0 },
      'flow.hooksCode.ctxHook': { col: 2, lane: 0 },
      'flow.hooksCode.fileRef': { col: 3, lane: 0 },

      'flow.hooksCode.beforeTool': { col: 1, lane: 1 },
      'flow.hooksCode.afterTool': { col: 2, lane: 1 },
      'flow.hooksCode.cancelWrap': { col: 3, lane: 1 },
      'flow.hooksCode.inspector': { col: 4, lane: 1 },

      'flow.hooksCode.mcpExt': { col: 1, lane: 2 },
      'flow.hooksCode.nativeExt': { col: 2, lane: 2 },
      'flow.hooksCode.plugins': { col: 3, lane: 2 },
    },
    laneLabels: {
      0: '内联扩展事件总线（cogent-hooks + cogent-file-references）',
      1: '公开 Agent 链式包裹（审批 / 后置结算 / 取消 / 流量观测）',
      2: 'MCP 扩展、原生 .pi/extensions 与本地插件分发规划',
    },
  },

  // 6a. 上下文工程与压缩转录（逻辑版：范本）
  flowCompaction: {
    slots: {
      'flow.compaction.entering.userInput': { col: 0, lane: 0 },
      'flow.compaction.entering.sysRules': { col: 0, lane: 1 },
      'flow.compaction.entering.toolOut': { col: 0, lane: 2 },
      'flow.compaction.check': { col: 1, lane: 1 },
      'flow.compaction.pass': { col: 3, lane: 0 },
      'flow.compaction.prune': { col: 2, lane: 1 },
      'flow.compaction.compacting.cut': { col: 3, lane: 2 },
      'flow.compaction.compacting.summarize': { col: 4, lane: 2 },
      'flow.compaction.compacting.recover': { col: 5, lane: 2 },
      'flow.compaction.store': { col: 6, lane: 1 },
      'flow.compaction.outputs.toModel': { col: 7, lane: 0 },
      'flow.compaction.outputs.toUser': { col: 7, lane: 2 },
    },
    notes: {
      'flow.compaction.entering': '三路来源进入前先控体积，挡住单次大输出',
      'flow.compaction.compacting': '压缩循环与切点由 pi 内核托管，Host 注入中文黑盒约束并恢复附件索引',
      'flow.compaction.outputs': '同一份会话文件，模型与用户各看各的',
    },
  },

  // 6b. 上下文工程与压缩转录（源码调用图：范本）
  flowCompactionCode: {
    slots: {
      'flow.compactionCode.rules': { col: 0, lane: 0 },
      'flow.compactionCode.spill': { col: 0, lane: 1 },
      'flow.compactionCode.meter': { col: 1, lane: 0 },
      'flow.compactionCode.adapt': { col: 2, lane: 0 },
      'flow.compactionCode.l1': { col: 2, lane: 1 },
      'flow.compactionCode.beforeCompact': { col: 3, lane: 0 },
      'flow.compactionCode.assets': { col: 4, lane: 0 },
      'flow.compactionCode.jsonl': { col: 3, lane: 1 },
      'flow.compactionCode.proj': { col: 4, lane: 1 },
      'flow.compactionCode.search': { col: 3, lane: 2 },
      'flow.compactionCode.read': { col: 4, lane: 2 },
    },
    laneLabels: {
      0: '系统规则、水位计量与深度摘要委托链',
      1: '超限落盘、轻度裁剪与模型出站投影',
      2: '完整历史回查与异步全文索引',
    },
  },

  // 7a. 文件边界与产物交付（逻辑版）
  flowOutputs: {
    slots: {
      'flow.outputs.intake.dir': { col: 0, lane: 0 },
      'flow.outputs.intake.file': { col: 0, lane: 2 },
      'flow.outputs.guard': { col: 1, lane: 1 },
      'flow.outputs.deliver.declare': { col: 2, lane: 1 },
      'flow.outputs.deliver.stage': { col: 3, lane: 1 },
      'flow.outputs.deliver.finalize': { col: 4, lane: 1 },
      'flow.outputs.viewer.lease': { col: 5, lane: 0 },
      'flow.outputs.viewer.preview': { col: 5, lane: 2 },
    },
    notes: {
      'flow.outputs.intake': '目录实时引用不复制，文件与图片内容寻址去重并严控配额',
      'flow.outputs.deliver': '两段确认 + 终态复核，源件被删改也不破坏已确认交付副本',
      'flow.outputs.viewer': '仅主窗口顶层可访问，网络与嵌入页整域拒绝',
    },
  },

  // 7b. 文件边界与产物交付（源码调用图）
  flowOutputsCode: {
    slots: {
      'flow.outputsCode.attach': { col: 0, lane: 0 },
      'flow.outputsCode.parse': { col: 1, lane: 0 },
      'flow.outputsCode.boundary': { col: 2, lane: 0 },
      'flow.outputsCode.stage': { col: 3, lane: 0 },
      'flow.outputsCode.commit': { col: 4, lane: 0 },

      'flow.outputsCode.ipc': { col: 4, lane: 1 },
      'flow.outputsCode.lease': { col: 5, lane: 1 },
      'flow.outputsCode.reader': { col: 6, lane: 1 },
      'flow.outputsCode.preview': { col: 7, lane: 1 },
    },
    laneLabels: {
      0: '附件去重解析、写界提醒、显式申报暂存与终态原子提交',
      1: '主窗口租约、SHA-256 核验、有界读取与安全预览导出',
    },
  },

  // 8a. 凭据与模型出站（逻辑版）
  flowModels: {
    slots: {
      'flow.models.creds.store': { col: 0, lane: 0 },
      'flow.models.creds.handshake': { col: 1, lane: 0 },
      'flow.models.creds.memory': { col: 2, lane: 0 },
      'flow.models.catalog': { col: 2, lane: 2 },
      'flow.models.probe': { col: 3, lane: 2 },
      'flow.models.outbound.custom': { col: 4, lane: 0 },
      'flow.models.outbound.dialects': { col: 4, lane: 1 },
      'flow.models.remote': { col: 5, lane: 1 },
      'flow.models.usage': { col: 6, lane: 1 },
    },
    notes: {
      'flow.models.creds': '明文密钥永不落 Host 磁盘，系统加密不可用时绝不降级明文',
      'flow.models.outbound': '主对话、探测、标题与摘要共用同一模型运行时路由',
    },
  },

  // 8b. 凭据与模型出站（源码调用图）
  flowModelsCode: {
    slots: {
      'flow.modelsCode.store': { col: 0, lane: 0 },
      'flow.modelsCode.handshake': { col: 1, lane: 0 },
      'flow.modelsCode.registry': { col: 2, lane: 0 },

      'flow.modelsCode.catalog': { col: 2, lane: 1 },
      'flow.modelsCode.modelSummary': { col: 3, lane: 1 },
      'flow.modelsCode.aux': { col: 4, lane: 2 },
      'flow.modelsCode.dialect': { col: 5, lane: 1 },
      'flow.modelsCode.remote': { col: 6, lane: 1 },
      'flow.modelsCode.usage': { col: 7, lane: 1 },
    },
    laneLabels: {
      0: 'Electron safeStorage 密钥存储、握手队列交接与内存覆盖表',
      1: '自定义目录、模型摘要投影、三方言出站与用量归账',
      2: '连通性探测与自动标题独立辅助调用',
    },
  },

  // 9a. 提示词工程与装配（逻辑版）
  flowPrompts: {
    slots: {
      'flow.prompts.systemLayer.core': { col: 0, lane: 0 },
      'flow.prompts.systemLayer.workspace': { col: 1, lane: 0 },
      'flow.prompts.systemLayer.dynSections': { col: 2, lane: 0 },
      'flow.prompts.toolLayer.defs': { col: 0, lane: 1 },
      'flow.prompts.toolLayer.receipts': { col: 1, lane: 1 },
      'flow.prompts.msgLayer.remind': { col: 0, lane: 2 },
      'flow.prompts.msgLayer.autoCont': { col: 1, lane: 2 },
      'flow.prompts.inspect': { col: 3, lane: 0 },
      'flow.prompts.project': { col: 3, lane: 1 },
      'flow.prompts.auxiliary': { col: 3, lane: 2 },
    },
    notes: {
      'flow.prompts.systemLayer': '静态前缀置顶、动态段由稳到变排布，最大化前缀缓存命中',
      'flow.prompts.toolLayer': '内置工具保持上游只读，宿主 6 工具文案集中收口',
      'flow.prompts.msgLayer': '所有运行态提醒统一封装并转义闭合标签，防误当用户话术',
    },
  },

  // 9b. 提示词工程与装配（源码调用图）
  flowPromptsCode: {
    slots: {
      'flow.promptsCode.core': { col: 0, lane: 0 },
      'flow.promptsCode.sections': { col: 1, lane: 0 },
      'flow.promptsCode.diff': { col: 2, lane: 0 },
      'flow.promptsCode.inspect': { col: 3, lane: 0 },

      'flow.promptsCode.tools': { col: 0, lane: 1 },
      'flow.promptsCode.receipts': { col: 1, lane: 1 },
      'flow.promptsCode.project': { col: 2, lane: 1 },
      'flow.promptsCode.outbound': { col: 3, lane: 1 },

      'flow.promptsCode.reminders': { col: 0, lane: 2 },
      'flow.promptsCode.injections': { col: 1, lane: 2 },
      'flow.promptsCode.auxiliary': { col: 2, lane: 2 },
    },
    laneLabels: {
      0: '系统提示词：静态核心 → 7 段动态活算 → sections diff 与完整观测',
      1: '工具提示词：声明收敛、去内部化回执、协议折叠与出站',
      2: '消息流提醒源与独立辅助调用（PROMPT_INVENTORY）',
    },
  },
}
