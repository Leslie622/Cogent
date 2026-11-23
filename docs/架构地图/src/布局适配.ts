/** 读取 LikeC4 布局，对总览的接入两行、走线通道与执行区做受限投影；依赖关系与其余通道仍由模型提供。 */
import { placeLabelsAlongRoutes, polylineToSegments, splineToPolyline, type BBox, type XYPoint } from '@likec4/core/geometry'
import type { Edge, Node } from '@xyflow/react'
import type { LayoutedView } from 'likec4/model'
import type { ImplementationStatus } from './实现状态'
import { moduleDetails } from './模块说明'

export type ArchitectureNode = Node<{
  title: string
  technology: string | null
  description: string | null
  compound: boolean
  status: ImplementationStatus
  onReturnFocus?: () => void
  /** 容器的阶段标题：坐标相对容器左上角，只对定义了 stages 的模块非空。 */
  stages: { label: string; x: number; width: number }[]
}, 'module' | 'boundary'>

export type ArchitectureEdge = Edge<{
  path: string
  route: XYPoint[]
  crossings: XYPoint[]
  labelBox: BBox | null
  bidirectional: boolean
  planned: boolean
  line: 'solid' | 'dashed' | 'dotted'
  kind: LayoutedView['edges'][number]['kind']
  head: LayoutedView['edges'][number]['head']
  tail: LayoutedView['edges'][number]['tail']
}, 'relationship'>

/** 投影过程中的可变节点副本；LikeC4 的节点 id 是品牌类型，Map 统一按 string 取。 */
type ProjectedNode = LayoutedView['nodes'][number]
type ProjectedNodes = ProjectedNode[]
type NodeMap = ReadonlyMap<string, ProjectedNode>

/** 纵向节奏：场景卡之间、容器底边到绕行通道、通道到 MCP 行共用同一间隙。 */
const verticalGap = 56
/** 容器内距：顶部放标题，底部放 KernelRunner 的安全边界说明。 */
const boundaryInset = { top: 56, bottom: 40, side: 24 }
/** Host 在标题下多出一行阶段标题，卡片随之下移。 */
const stageRowHeight = 32
/** 列间距，与 DSL 的 rankSep 一致；投影重排的卡片沿用同一间距。 */
const rankGap = 160

/** 两端同行、画成两点水平线的接线；总览与执行视图共用。 */
const straightEdges: readonly string[] = [
  'externalAgent>mcp',
  'desktop>access.stdio', 'access.stdio>host.native',
  'customClients>access.network', 'access.network>host.authentication',
  'host.authentication>host.adapter',
  'host.native>host.policy', 'host.policy>host.api', 'host.api>host.services',
  'host.services>host.runtime', 'host.runtime>host.provider', 'host.provider>models',
]

const centerX = (node: ProjectedNode) => node.x + node.width / 2
const centerY = (node: ProjectedNode) => node.y + node.height / 2
const bottom = (node: ProjectedNode) => node.y + node.height

export function projectLayout(view: LayoutedView): { nodes: ArchitectureNode[]; edges: ArchitectureEdge[]; bounds: BBox; nodeBounds: Map<string, BBox> } {
  const layoutNodes = placeMcpRow(compactExecutionArea(alignAccessLanes(view), view.id), view.id)
  const originals = new Map<string, ProjectedNode>(layoutNodes.map(node => [node.id, node]))
  // 父节点先于子节点，React Flow 才能正确计算嵌套坐标与视口边界。
  const ordered: ProjectedNodes = []
  function append(parent: string | null) {
    for (const node of layoutNodes.filter(item => item.parent === parent)) {
      ordered.push(node)
      append(node.id)
    }
  }
  append(null)

  const nodes: ArchitectureNode[] = ordered.map(node => {
    const parent = node.parent === null ? null : originals.get(node.parent)!
    const compound = node.children.length > 0
    return {
      id: node.id,
      type: compound ? 'boundary' : 'module',
      position: { x: node.x - (parent === null ? 0 : parent.x), y: node.y - (parent === null ? 0 : parent.y) },
      ...(node.parent === null ? {} : { parentId: node.parent }),
      style: { width: node.width, height: node.height },
      draggable: false,
      connectable: false,
      focusable: false,
      data: {
        title: node.title,
        technology: node.technology ?? null,
        description: node.description == null ? null : node.description.txt !== undefined ? node.description.txt : node.description.md,
        compound,
        status: moduleDetails[node.id].status,
        // 阶段标题按所属卡片的最终位置标出横向范围，坐标相对容器左上角。
        stages: (moduleDetails[node.id].stages ?? []).map(stage => {
          const box = enclosingBounds(stage.nodes.map(id => originals.get(id)!))
          return { label: stage.label, x: box.x - node.x, width: box.width }
        }),
      },
    }
  })

  // 未被投影重画的接线保留 LikeC4 算好的正交通道；重新按两端路由会丢失分支的避让关系。
  const routes = view.edges.map(edge => {
    const points = routeOf(edge, view.id, originals)
    attachToBorder(points, 0, originals.get(edge.source)!)
    attachToBorder(points, points.length - 1, originals.get(edge.target)!)
    // 传输聚合使用 LikeC4 投影后的关系标记，连接状态与两端卡片状态各自负责。
    const planned = edge.tags?.some(tag => tag === 'planned') === true
    return { id: edge.id, points, planned, segments: polylineToSegments(points), labelBBox: edge.labelBBox == null ? null : {
      ...edge.labelBBox, width: edge.labelBBox.width + 12 + (planned ? 16 : 0), height: 32,
    } }
  })
  // 用最终路径共同放置标签，预留 6px 外围间距，不能只检查文字之间的碰撞。
  // 容器边框也压成细条当作障碍：标签有底色，骑在虚线边框上会遮掉一段边框。
  const labels = placeLabelsAlongRoutes(routes, [
    ...layoutNodes.filter(node => node.children.length === 0),
    ...layoutNodes.filter(node => node.children.length > 0).flatMap(borderStrips),
  ])
  const edges: ArchitectureEdge[] = view.edges.map((edge, index) => {
    const { points: route, planned } = routes[index]
    const box = labels.get(edge.id)
    const labelBox = box === undefined ? null : { x: box.x + 6, y: box.y + 6, width: box.width - 12, height: box.height - 12 }
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'relationship',
      zIndex: 1,
      label: edge.label,
      data: {
        path: roundedPath(route), route, labelBox,
        crossings: crossingPoints(routes[index].segments, routes.slice(0, index).flatMap(item => item.segments)),
        bidirectional: edge.tail === 'normal',
        planned,
        // 关系语义由 DSL 决定；完成度只影响状态标记，不再覆盖线型或箭头。
        line: edge.line, kind: edge.kind, head: edge.head, tail: edge.tail,
      },
      focusable: false,
      selectable: false,
    }
  })

  const nodeBounds = new Map<string, BBox>(layoutNodes.map(node => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]))
  const geometry: BBox[] = [
    ...nodeBounds.values(),
    ...routes.flatMap(route => route.points.map(point => ({ ...point, width: 0, height: 0 }))),
    ...edges.flatMap(edge => edge.data!.labelBox === null ? [] : [edge.data!.labelBox]),
  ]
  return { nodes, edges, bounds: enclosingBounds(geometry), nodeBounds }
}

function routeOf(edge: LayoutedView['edges'][number], viewId: string, nodes: NodeMap): XYPoint[] {
  const key = `${edge.source}>${edge.target}`
  if (viewId === 'overview' || viewId === 'execution') {
    if (straightEdges.includes(key)) {
      const source = nodes.get(edge.source)!
      const target = nodes.get(edge.target)!
      return [{ x: source.x + source.width, y: centerY(source) }, { x: target.x, y: centerY(target) }]
    }
    // 执行视图只有主链；接入视图的行列未被投影改动，继续用引擎通道。
    if (viewId === 'overview') {
      const bent = bentRoute(edge, nodes)
      if (bent !== null) return bent
    }
  }
  return splineToPolyline(edge.points)
}

/** 总览里两端不同行、或中间隔着卡片的接线。引擎按对齐前的位置留折点，端点挪动后中间段会穿卡
 * 或贴着容器边框走，所以折点按最终几何重画；落点彼此错开，不在同一张卡上共用端口。 */
function bentRoute(edge: LayoutedView['edges'][number], nodes: NodeMap): XYPoint[] | null {
  const source = nodes.get(edge.source)!
  const target = nodes.get(edge.target)!
  const exit = { x: source.x + source.width, y: centerY(source) }
  switch (`${edge.source}>${edge.target}`) {
    // 原生调用夹在两行之间：折下汇入网络入口顶边。
    case 'nativeClients>access.network': {
      const portX = target.x + 60
      return [exit, { x: portX, y: centerY(source) }, { x: portX, y: target.y }]
    }
    // MCP 行在容器下方：折上汇入网络入口底边。横段长于竖段，标签落在 MCP 卡旁而不是竖线中部。
    case 'mcp>access.network': {
      const portX = target.x + target.width - 60
      return [exit, { x: portX, y: centerY(source) }, { x: portX, y: bottom(target) }]
    }
    // 认证的原生分支折上，汇入原生协议左缘下端口（离底边 12px，避开圆角）；stdio 来的主线占左缘中点。
    case 'host.authentication>host.native': {
      const portY = bottom(target) - 12
      return [{ x: centerX(source), y: source.y }, { x: centerX(source), y: portY }, { x: target.x, y: portY }]
    }
    // 适配分支折上汇入权限入口底边，与原生分支的左缘入口分开落点。
    case 'host.adapter>host.policy':
      return [exit, { x: centerX(target), y: centerY(source) }, { x: centerX(target), y: bottom(target) }]
    // 消费关系点线：中间隔着网络入口与身份认证，从两个容器底边以下绕行，不进任何容器。
    case 'customClients>host.adapter': {
      const channel = channelBelow(['access', 'host'].map(id => nodes.get(id)!))
      return [
        { x: centerX(source), y: bottom(source) }, { x: centerX(source), y: channel },
        { x: centerX(target), y: channel }, { x: centerX(target), y: bottom(target) },
      ]
    }
  }
  return null
}

/** 绕行通道：所给容器底边以下一个纵向间隙处；标签在线上方，与容器边框保持距离。 */
const channelBelow = (containers: readonly ProjectedNode[]) => Math.max(...containers.map(bottom)) + verticalGap

/** 引擎权重不保证跨行 y 相等，也不为夹在两行之间的场景卡留位置；总览的两条接入行与场景列由投影确定。 */
function alignAccessLanes(view: LayoutedView): ProjectedNodes {
  const nodes: ProjectedNodes = view.nodes.map(node => ({ ...node }))
  if (view.id !== 'overview') return nodes

  const find = (id: string) => nodes.find(node => node.id === id)!
  const centerOn = (id: string, lane: number) => {
    const node = find(id)
    node.y = lane - node.height / 2
  }
  // 上行锚定原生协议：桌面壳须留在列首上方，不能反过来把整列拽下来；权限与 HostApi 随主链并入上行。
  const upper = centerY(find('host.native'))
  centerOn('desktop', upper)
  for (const id of ['access.stdio', 'host.policy', 'host.api', 'host.services']) centerOn(id, upper)
  // 引擎给的行距只给场景卡留 12px；行距改为由场景列推导——桌面壳与自有协议调用方之间放一张原生调用，各留一个间隙。
  const [desktop, native, custom] = ['desktop', 'nativeClients', 'customClients'].map(find)
  centerOn('nativeClients', bottom(desktop) + verticalGap + native.height / 2)
  const lower = bottom(desktop) + verticalGap + native.height + verticalGap + custom.height / 2
  for (const id of ['customClients', 'access.network', 'host.authentication', 'host.adapter']) centerOn(id, lower)
  // 行距变了，传输入口容器要跟着两行收紧，否则下行卡片掉出容器底边。
  fitBoundaryToChildren(nodes, 'access')
  return nodes
}

/** 无连线的能力卡不参与全局流程排版；仅在执行区把三张原卡紧凑并排，避免全局层距变成内部留白。 */
function compactExecutionArea(nodes: ProjectedNodes, viewId: string) {
  if (viewId !== 'overview' && viewId !== 'execution') return nodes

  const find = (id: string) => nodes.find(node => node.id === id)!
  const services = find('host.services')
  const runtime = find('host.runtime')
  const provider = find('host.provider')
  const models = find('models')
  const cards = ['host.runtime.capabilities', 'host.runtime.kernel', 'host.runtime.alternative'].map(find)
  const cardGap = 24
  const contentHeight = Math.max(...cards.map(node => node.height))
  // 回归钉死：x 不随服务层重定位的话，紧凑后的 Runner 会留在引擎给的最左秩，
  // 主链折返横穿全图（2026-11-23 验收翻车）。
  runtime.x = services.x + services.width + rankGap
  runtime.width = boundaryInset.side * 2 + cards.reduce((width, node) => width + node.width, 0) + cardGap * (cards.length - 1)
  runtime.height = boundaryInset.top + contentHeight + boundaryInset.bottom
  runtime.y = centerY(services) - runtime.height / 2
  let nextX = runtime.x + boundaryInset.side
  for (const card of cards) {
    card.x = nextX
    card.y = runtime.y + boundaryInset.top + (contentHeight - card.height) / 2
    nextX += card.width + cardGap
  }
  provider.x = runtime.x + runtime.width + rankGap
  provider.y = centerY(services) - provider.height / 2
  models.x = provider.x + provider.width + rankGap
  models.y = centerY(services) - models.height / 2

  // Host 的外框由当前内容决定，不能保留自动布局为旧卡片位置留出的空区；执行视图不画 Host。
  const host = nodes.find(node => node.id === 'host')
  if (host !== undefined) fitBoundaryToChildren(nodes, 'host', boundaryInset.top + stageRowHeight)
  return nodes
}

/** 外部 Agent 与 MCP 适配不在主链上，引擎按对齐前的位置安放；贴着绕行通道下方排成一行，消除空带。 */
function placeMcpRow(nodes: ProjectedNodes, viewId: string) {
  if (viewId !== 'overview') return nodes

  const row = nodes.filter(node => node.id === 'externalAgent' || node.id === 'mcp')
  const channel = channelBelow(nodes.filter(node => node.id === 'access' || node.id === 'host'))
  const rowCenter = channel + verticalGap + Math.max(...row.map(node => node.height)) / 2
  for (const node of row) node.y = rowCenter - node.height / 2
  return nodes
}

/** 容器外框由直接子节点包围盒决定；顶部内距可加大，给 Host 的阶段标题行让位。 */
function fitBoundaryToChildren(nodes: ProjectedNodes, id: string, top = boundaryInset.top) {
  const boundary = nodes.find(node => node.id === id)!
  const content = enclosingBounds(nodes.filter(node => node.parent === id))
  boundary.x = content.x - boundaryInset.side
  boundary.y = content.y - top
  boundary.width = content.width + boundaryInset.side * 2
  boundary.height = content.height + top + boundaryInset.bottom
}

/** 容器的四条边框压成 1px 细条，只挡标签，不占容器内部空间。 */
function borderStrips(box: BBox): BBox[] {
  return [
    { x: box.x, y: box.y, width: box.width, height: 1 },
    { x: box.x, y: box.y + box.height - 1, width: box.width, height: 1 },
    { x: box.x, y: box.y, width: 1, height: box.height },
    { x: box.x + box.width - 1, y: box.y, width: 1, height: box.height },
  ]
}

function enclosingBounds(boxes: readonly BBox[]): BBox {
  const x = Math.min(...boxes.map(box => box.x))
  const y = Math.min(...boxes.map(box => box.y))
  return {
    x, y,
    width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y,
  }
}

/** 布局引擎保留多对多关系的交叉；只记录后绘制线的跨越点，不重新路由或合并通道。 */
function crossingPoints(current: ReturnType<typeof polylineToSegments>, previous: ReturnType<typeof polylineToSegments>): XYPoint[] {
  const crossings: XYPoint[] = []
  for (const [a, b] of current) {
    for (const [c, d] of previous) {
      if ((a.y === b.y) === (c.y === d.y)) continue
      const [horizontalStart, horizontalEnd, verticalStart, verticalEnd] = a.y === b.y ? [a, b, c, d] : [c, d, a, b]
      const point = { x: verticalStart.x, y: horizontalStart.y }
      if (point.x > Math.min(horizontalStart.x, horizontalEnd.x) && point.x < Math.max(horizontalStart.x, horizontalEnd.x)
        && point.y > Math.min(verticalStart.y, verticalEnd.y) && point.y < Math.max(verticalStart.y, verticalEnd.y)) {
        if (!crossings.some(other => other.x === point.x && other.y === point.y)) crossings.push(point)
      }
    }
  }
  return crossings
}

/** 原生路径为箭头留有端距；延伸到卡片边框，并避开圆角，邻接折点随端口平移。 */
function attachToBorder(points: XYPoint[], index: number, box: BBox) {
  const point = points[index]
  const adjacent = points[index === 0 ? 1 : index - 1]
  if (point.y === adjacent.y) {
    point.x = point.x < box.x + box.width / 2 ? box.x : box.x + box.width
    point.y = Math.max(box.y + 12, Math.min(box.y + box.height - 12, point.y))
    adjacent.y = point.y
  } else {
    point.y = point.y < box.y + box.height / 2 ? box.y : box.y + box.height
    point.x = Math.max(box.x + 12, Math.min(box.x + box.width - 12, point.x))
    adjacent.x = point.x
  }
}

/** 只把既有直角替换成小圆角，不改变通道、端口或分支间距。 */
function roundedPath(points: XYPoint[]): string {
  let path = `M${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]
    const corner = points[index]
    const next = points[index + 1]
    const before = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const after = Math.hypot(next.x - corner.x, next.y - corner.y)
    const radius = Math.min(8, before / 2, after / 2)
    const entry = { x: corner.x + (previous.x - corner.x) * radius / before, y: corner.y + (previous.y - corner.y) * radius / before }
    const exit = { x: corner.x + (next.x - corner.x) * radius / after, y: corner.y + (next.y - corner.y) * radius / after }
    path += ` L${entry.x} ${entry.y} Q${corner.x} ${corner.y} ${exit.x} ${exit.y}`
  }
  const end = points[points.length - 1]
  return `${path} L${end.x} ${end.y}`
}
