/** 地图视图注册表：左侧栏分为「架构地图」与「专题流程」两组，支持总览下钻与流程逻辑/源码双视图。 */
export const architectureViewIds = ['overview', 'desktopShell', 'services', 'capabilities', 'storage'] as const
export const flowViewIds = [
  'flowAuth',
  'flowApproval',
  'flowMcp',
  'flowSkills',
  'flowHooks',
  'flowCompaction',
  'flowOutputs',
  'flowModels',
  'flowPrompts',
] as const
/** 专题流程对应的源码级详细视图（不重复列入左侧栏，通过顶部「逻辑版 / 源码版」切换）。 */
export const flowCodeViewIds = ['flowCompactionCode'] as const
export const viewIds = [...architectureViewIds, ...flowViewIds, ...flowCodeViewIds] as const

export type ViewId = typeof viewIds[number]

export const viewNames: Record<ViewId, string> = {
  overview: '架构总览',
  desktopShell: '桌面壳内部',
  services: 'Host 服务层',
  capabilities: '执行能力',
  storage: '数据与存储',
  flowAuth: '身份验证与权限',
  flowApproval: '消息与审批闭环',
  flowMcp: 'MCP 双轨机制',
  flowSkills: '技能加载机制',
  flowHooks: '钩子与扩展机制',
  flowCompaction: '上下文工程与压缩转录',
  flowCompactionCode: '上下文工程（源码调用图）',
  flowOutputs: '文件边界与产物交付',
  flowModels: '凭据与模型出站',
  flowPrompts: '提示词工程与装配',
}

export const flowCodeViewMap: Partial<Record<ViewId, ViewId>> = {
  flowCompaction: 'flowCompactionCode',
}

export const viewGroups: readonly { title: string; ids: readonly ViewId[] }[] = [
  { title: '架构地图', ids: architectureViewIds },
  { title: '专题流程', ids: flowViewIds },
]

export const drilldownViewIds = new Set<ViewId>(['desktopShell', 'services', 'capabilities'])
export const isFlowView = (id: ViewId): boolean => (flowViewIds as readonly string[]).includes(id)
