/** 架构地图模块与连线说明共享类型，供模块说明与各专题流程说明文件复用。 */
import type { IconComponent } from './components/图标'
import type { ImplementationStatus } from './实现状态'
import type { ViewId } from './视图'

export interface ModuleFeature {
  label: string
  status: 'implemented' | 'planned'
}

export interface SourceRef {
  path: string
  symbol: string
}

export interface PeerComparison {
  repo: 'deepseek-harness' | 'zcode'
  approach: string
  diff: string
}

export interface ModuleDetail {
  name: string
  kind: string
  /** 逻辑版卡片与详情上的执行归属标签（明确在哪做：如 pi 内核托管 / Cogent Host / 桌面前端）。 */
  runtimeOwner?: string
  /** 源码版卡片副标题（展示核心函数、钩子与模块符号）。 */
  codeKind?: string
  /** 画布卡片内直接呈现的精炼机制要点（让图本身讲故事，减少右侧文字堆砌）。 */
  cardPoints?: string[]
  icon: IconComponent
  status: ImplementationStatus
  showStatus?: boolean
  features?: ModuleFeature[]
  summary: string
  responsibilities: string[]
  boundary: string
  /** 开源仓同主题对照（仅基于实读源码的 deepseek-harness 与 zcode）。 */
  comparisons?: PeerComparison[]
  sources: SourceRef[]
  navigateTo?: ViewId
  navigateOnClick?: boolean
  relatedFlows?: ViewId[]
  verifiedAt?: string
}

export interface EdgeDetail {
  title: string
  kind: string
  contract: string
  rules: string[]
  sources: SourceRef[]
}
