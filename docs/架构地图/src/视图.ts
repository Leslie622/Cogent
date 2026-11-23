/** 同一模型按总览、传输和执行展开；侧边栏保持单项。 */
export const primaryViewIds = ['overview', 'ingress', 'execution'] as const
export const viewIds = [...primaryViewIds, 'services', 'capabilities'] as const
export type ViewId = typeof viewIds[number]
export const viewNames: Record<ViewId, string> = { overview: '总览', ingress: '接入', execution: '执行', services: '服务层详情', capabilities: '能力总线详情' }
