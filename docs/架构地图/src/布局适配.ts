/** 只转换 LikeC4 的布局坐标；不在页面里再维护一套节点位置或依赖关系。 */
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
}, 'relationship'>

export function projectLayout(view: LayoutedView): { nodes: ArchitectureNode[]; edges: ArchitectureEdge[] } {
  const originals = new Map(view.nodes.map(node => [node.id, node]))
  // 父节点先于子节点，React Flow 才能正确计算嵌套坐标与视口边界。
  const ordered: typeof view.nodes[number][] = []
  function append(parent: string | null) {
    for (const node of view.nodes.filter(item => item.parent === parent)) {
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
    // Graphviz 会把 compound 内的空隙当作通道；业务回接需沿整个执行容器外侧走，避开标题与安全说明。
    if (view.id === 'overview' && edge.source === 'host.api' && edge.target === 'host.services') {
      const source = originals.get(edge.source)!
      const target = originals.get(edge.target)!
      const runtime = originals.get('host.runtime')!
      const laneX = runtime.x - 32
      const laneY = runtime.y - 32
      points = [
        { x: source.x + source.width / 2, y: source.y + source.height },
        { x: source.x + source.width / 2, y: laneY },
        { x: laneX, y: laneY },
        { x: laneX, y: target.y + target.height / 2 },
        { x: target.x + target.width, y: target.y + target.height / 2 },
      ]
    }
    attachToBorder(points, 0, originals.get(edge.source)!)
    attachToBorder(points, points.length - 1, originals.get(edge.target)!)
    return { id: edge.id, points, segments: polylineToSegments(points), labelBBox: edge.labelBBox == null ? null : {
      ...edge.labelBBox, width: edge.labelBBox.width + 12, height: 32,
    } }
  })
  // 用最终路径共同放置标签，预留 6px 外围间距，不能只检查文字之间的碰撞。
  const labels = placeLabelsAlongRoutes(routes, view.nodes.filter(node => node.children.length === 0))
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
        line: edge.line === 'dotted' ? 'dotted' : planned ? 'dashed' : 'solid',
      },
      focusable: false,
      selectable: false,
    }
  })

  return { nodes, edges }
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
