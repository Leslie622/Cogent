/** 状态标注按能力完成度，不代表源码已按目标架构物理拆分。 */
export type ImplementationStatus = 'implemented' | 'partial' | 'planned' | 'external'
export const implementationLabels: Record<ImplementationStatus, string> = {
  implemented: '已实现',
  partial: '部分实现',
  planned: '未实现',
  external: '外部系统',
}
