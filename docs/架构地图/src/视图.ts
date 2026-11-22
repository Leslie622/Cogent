/** 同一模型按总览、传输和执行展开；侧边栏保持单项。 */
export const viewIds = ['overview', 'ingress', 'execution'] as const
export type ViewId = typeof viewIds[number]
export const viewNames: Record<ViewId, string> = { overview: '总览', ingress: '接入', execution: '执行' }
