/** 读取 LikeC4 布局，仅对展开的执行区做紧凑投影；依赖关系与其余通道仍由模型提供。 */
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

export function projectLayout(view: LayoutedView): { nodes: ArchitectureNode[]; edges: ArchitectureEdge[]; bounds: BBox; nodeBounds: Map<string, BBox> } {
  const layoutNodes = compactExecutionArea(view)
  const originals = new Map(layoutNodes.map(node => [node.id, node]))
  // 父节点先于子节点，React Flow 才能正确计算嵌套坐标与视口边界。
  const ordered: typeof layoutNodes = []
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
      },
    }
  })

  // 保留 LikeC4 算好的正交通道；重新按两端路由会丢失分支的避让关系。
  const routes = view.edges.map(edge => {
    let points = splineToPolyline(edge.points)
    // 内部三卡只表达包含关系；收紧执行区后，外部主链统一连接整个容器的左右中点。
    if ((view.id === 'overview' || view.id === 'execution') && (
      edge.source === 'host.services' && edge.target === 'host.runtime'
      || edge.source === 'host.runtime' && edge.target === 'host.provider'
      || edge.source === 'host.provider' && edge.target === 'models'
    )) {
      const source = originals.get(edge.source)!
      const target = originals.get(edge.target)!
      points = [
        { x: source.x + source.width, y: source.y + source.height / 2 },
        { x: target.x, y: target.y + target.height / 2 },
      ]
    }
    attachToBorder(points, 0, originals.get(edge.source)!)
    attachToBorder(points, points.length - 1, originals.get(edge.target)!)
    const planned = moduleDetails[edge.source].status === 'planned' || moduleDetails[edge.target].status === 'planned'
    return { id: edge.id, points, segments: polylineToSegments(points), labelBBox: edge.labelBBox == null ? null : {
      ...edge.labelBBox, width: edge.labelBBox.width + 12 + (planned ? 16 : 0), height: 32,
    } }
  })
  // 用最终路径共同放置标签，预留 6px 外围间距，不能只检查文字之间的碰撞。
  const labels = placeLabelsAlongRoutes(routes, layoutNodes.filter(node => node.children.length === 0))
  const edges: ArchitectureEdge[] = view.edges.map((edge, index) => {
    const route = routes[index].points
    const box = labels.get(edge.id)
    const labelBox = box === undefined ? null : { x: box.x + 6, y: box.y + 6, width: box.width - 12, height: box.height - 12 }
    const planned = moduleDetails[edge.source].status === 'planned' || moduleDetails[edge.target].status === 'planned'
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

/** 无连线的能力卡不参与全局流程排版；仅在执行区把三张原卡紧凑并排，避免全局层距变成内部留白。 */
function compactExecutionArea(view: LayoutedView) {
  const nodes = view.nodes.map(node => ({ ...node }))
  if (view.id !== 'overview' && view.id !== 'execution') return nodes

  const runtime = nodes.find(node => node.id === 'host.runtime')!
  const services = nodes.find(node => node.id === 'host.services')!
  const provider = nodes.find(node => node.id === 'host.provider')!
  const models = nodes.find(node => node.id === 'models')!
  const cards = ['host.runtime.capabilities', 'host.runtime.kernel', 'host.runtime.alternative'].map(id => nodes.find(node => node.id === id)!)
  const contentHeight = Math.max(...cards.map(node => node.height))
  const centerY = services.y + services.height / 2
  runtime.width = 48 + cards.reduce((width, node) => width + node.width, 0) + 24 * (cards.length - 1)
  runtime.height = 56 + contentHeight + 40
  runtime.y = centerY - runtime.height / 2
  let nextX = runtime.x + 24
  for (const card of cards) {
    card.x = nextX
    card.y = runtime.y + 56 + (contentHeight - card.height) / 2
    nextX += card.width + 24
  }
  provider.x = runtime.x + runtime.width + 160
  provider.y = centerY - provider.height / 2
  models.x = provider.x + provider.width + 160
  models.y = centerY - models.height / 2

  // Host 的外框由当前内容决定，不能保留自动布局为旧卡片位置留出的空区。
  const host = nodes.find(node => node.id === 'host')
  if (host !== undefined) {
    const content = enclosingBounds(nodes.filter(node => node.parent === 'host'))
    host.x = content.x - 24
    host.y = content.y - 56
    host.width = content.width + 48
    host.height = content.height + 80
  }
  return nodes
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
