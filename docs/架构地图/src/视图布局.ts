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
  /** 泳道左侧或顶部标签（常用于专题流程泳道分隔）。 */
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

  flowAuth: {
    slots: {
      'flow.auth.stdio': { col: 0, lane: 0 },
      'flow.auth.http': { col: 0, lane: 1 },
      'flow.auth.ws': { col: 0, lane: 2 },
      'flow.auth.userSys': { col: 0, lane: 3 },
      'flow.auth.ticket': { col: 1, lane: 1 },
      'flow.auth.verify': { col: 2, lane: 2 },
      'flow.auth.native': { col: 3, lane: 0 },
      'flow.auth.adapter': { col: 3, lane: 2 },
      'flow.auth.scope': { col: 4, lane: 1 },
      'flow.auth.resource': { col: 5, lane: 1 },
      'flow.auth.dispatch': { col: 6, lane: 1 },
    },
    laneLabels: {
      0: '本机受信任入口',
      1: 'HTTP 请求通道',
      2: 'WS 与自适应协议',
      3: '规划身份源',
    },
  },

  flowApproval: {
    slots: {
      'flow.approval.send': { col: 0, lane: 0 },
      'flow.approval.ipc': { col: 1, lane: 0 },
      'flow.approval.submit': { col: 2, lane: 0 },
      'flow.approval.piLoop': { col: 3, lane: 0 },
      'flow.approval.stream': { col: 4, lane: 1 },
      'flow.approval.hook': { col: 4, lane: 0 },
      'flow.approval.decide': { col: 5, lane: 0 },
      'flow.approval.pending': { col: 6, lane: 0 },
      'flow.approval.panel': { col: 6, lane: 1 },
      'flow.approval.respondIpc': { col: 5, lane: 1 },
    },
    laneLabels: {
      0: '主执行链路',
      1: '流式回传与人机裁决回路',
    },
  },

  flowMcp: {
    slots: {
      'flow.mcpFlow.config': { col: 0, lane: 0 },
      'flow.mcpFlow.snapshot': { col: 1, lane: 0 },
      'flow.mcpFlow.ext': { col: 2, lane: 0 },
      'flow.mcpFlow.toolExec': { col: 3, lane: 0 },

      'flow.mcpFlow.extAgent': { col: 0, lane: 1 },
      'flow.mcpFlow.server': { col: 1, lane: 1 },
      'flow.mcpFlow.cred': { col: 2, lane: 1 },
      'flow.mcpFlow.bridge': { col: 3, lane: 1 },
      'flow.mcpFlow.hostApi': { col: 4, lane: 1 },
    },
    laneLabels: {
      0: 'MCP 座：Cogent 消费外部 MCP Server',
      1: '对外 MCP：外部 Agent 驱动 Cogent Host',
    },
  },

  flowSkills: {
    slots: {
      'flow.skills.ui': { col: 0, lane: 0 },
      'flow.skills.store': { col: 1, lane: 0 },
      'flow.skills.files': { col: 2, lane: 0 },

      'flow.skills.hook': { col: 1, lane: 1 },
      'flow.skills.snap': { col: 2, lane: 1 },
      'flow.skills.format': { col: 3, lane: 1 },
      'flow.skills.diff': { col: 4, lane: 1 },
      'flow.skills.consume': { col: 5, lane: 1 },
    },
    laneLabels: {
      0: '配置写路径（磁盘真源）',
      1: '回合边界拉取与热刷新',
    },
  },

  flowHooks: {
    slots: {
      'flow.hooks.factory': { col: 0, lane: 2 },
      'flow.hooks.sections': { col: 1, lane: 0 },
      'flow.hooks.approval': { col: 1, lane: 1 },
      'flow.hooks.cancel': { col: 1, lane: 2 },
      'flow.hooks.observe': { col: 1, lane: 3 },
      'flow.hooks.nativeExt': { col: 1, lane: 4 },
      'flow.hooks.plugins': { col: 2, lane: 4 },
    },
    laneLabels: {
      0: '系统提示段',
      1: '工具审批链',
      2: '装配与请求取消',
      3: '观测与产物声明',
      4: '原生扩展与插件分发',
    },
  },

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

  flowOutputs: {
    slots: {
      'flow.outputs.attach': { col: 0, lane: 0 },
      'flow.outputs.writeRoot': { col: 1, lane: 0 },
      'flow.outputs.remind': { col: 2, lane: 0 },

      'flow.outputs.tool': { col: 2, lane: 1 },
      'flow.outputs.stage': { col: 3, lane: 1 },
      'flow.outputs.commit': { col: 4, lane: 1 },
      'flow.outputs.lease': { col: 5, lane: 1 },
      'flow.outputs.preview': { col: 6, lane: 1 },
    },
    laneLabels: {
      0: '输入隔离、工作区写边界与申报提醒',
      1: '显式申报、暂存核验、受管交付与预览租约',
    },
  },

  flowModels: {
    slots: {
      'flow.models.safeStorage': { col: 0, lane: 0 },
      'flow.models.handshake': { col: 1, lane: 0 },
      'flow.models.overlay': { col: 2, lane: 0 },

      'flow.models.catalog': { col: 2, lane: 1 },
      'flow.models.probe': { col: 3, lane: 2 },
      'flow.models.dialect': { col: 4, lane: 1 },
      'flow.models.remote': { col: 5, lane: 1 },
      'flow.models.usage': { col: 6, lane: 1 },
    },
    laneLabels: {
      0: 'Electron safeStorage 凭据生命周期（不落 Host 磁盘）',
      1: '目录合并、三方言出站与用量投影',
      2: '设置页独立连通性探测',
    },
  },

  flowPrompts: {
    slots: {
      'flow.prompts.core': { col: 0, lane: 0 },
      'flow.prompts.workspace': { col: 1, lane: 0 },
      'flow.prompts.sections': { col: 2, lane: 0 },
      'flow.prompts.diff': { col: 3, lane: 0 },
      'flow.prompts.inspect': { col: 4, lane: 0 },

      'flow.prompts.piTools': { col: 0, lane: 1 },
      'flow.prompts.hostTools': { col: 1, lane: 1 },
      'flow.prompts.receipts': { col: 2, lane: 1 },
      'flow.prompts.project': { col: 3, lane: 1 },
      'flow.prompts.outbound': { col: 4, lane: 1 },

      'flow.prompts.reminders': { col: 0, lane: 2 },
      'flow.prompts.injections': { col: 1, lane: 2 },
      'flow.prompts.auxiliary': { col: 3, lane: 2 },
    },
    laneLabels: {
      0: '系统提示词：静态前缀 → 动态段活算与观测',
      1: '工具提示词：声明收敛、去内部化回执与协议出站',
      2: '消息流注入：<system-reminder> 隔离与独立辅助调用',
    },
  },
}
