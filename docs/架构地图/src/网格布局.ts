/** 确定性列/泳道网格布局与正交通道路由：不依赖 Graphviz 快照，新增节点只影响局部列/泳道。 */
import { placeLabelsAlongRoutes, polylineToSegments, type BBox, type XYPoint } from '@likec4/core/geometry'
import type { Edge, Node } from '@xyflow/react'
import type { LayoutedView } from 'likec4/model'
import type { ImplementationStatus } from './实现状态'
import { moduleDetails } from './模块说明'
import type { ViewId } from './视图'
import { viewLayouts, type GridSlot, type ViewLayoutSpec } from './视图布局'

export type ViewFilterMode = 'all' | 'implemented' | 'gaps'
export type NodeTone = 'shell' | 'host' | 'services' | 'runtime' | 'storage' | 'flow' | 'planned' | 'external'

export type ArchitectureNode = Node<{
  title: string
  technology: string | null
  description: string | null
  compound: boolean
  status: ImplementationStatus
  tone: NodeTone
  dimmed: boolean
  highlighted: boolean
  onReturnFocus?: () => void
  boundaryNote?: string
  stages: { label: string; x: number; width: number }[]
  laneLabels: { label: string; y: number }[]
}, 'module' | 'boundary'>

export type ArchitectureEdge = Edge<{
  path: string
  route: XYPoint[]
  crossings: XYPoint[]
  labelBox: BBox | null
  bidirectional: boolean
  planned: boolean
  dimmed: boolean
  highlighted: boolean
  line: 'solid' | 'dashed' | 'dotted'
  kind: LayoutedView['edges'][number]['kind']
  head: LayoutedView['edges'][number]['head']
  tail: LayoutedView['edges'][number]['tail']
  description: string | null
}, 'relationship'>

interface BoxNode {
  id: string
  parent: string | null
  children: readonly string[]
  title: string
  technology: string | null
  description: string | null
  x: number
  y: number
  width: number
  height: number
  compound: boolean
}

const cardWidth = 244
const colGap = 168
const laneGap = 86
const rowCardGap = 24
const boundaryInset = { top: 56, bottom: 40, side: 24 }
const stageRowHeight = 32
const portCornerMargin = 14
const trackStep = 10

function textVisualUnits(text: string): number {
  let units = 0
  for (const ch of text) units += ch.charCodeAt(0) > 127 ? 13.5 : 8
  return units
}

function minBoundaryWidth(title: string, technology: string | null): number {
  const heading = textVisualUnits(title) + (technology === null ? 0 : textVisualUnits(technology) + 12) + 84
  return Math.min(380, Math.ceil(heading))
}

function nodeTone(id: string, status: ImplementationStatus, compound: boolean): NodeTone {
  if (!compound && status === 'planned') return 'planned'
  if (!compound && status === 'external') return 'external'
  if (id === 'desktop' || id.startsWith('desktop.')) return 'shell'
  if (id === 'storageRoot' || id.startsWith('storageRoot.')) return 'storage'
  if (id === 'host.runtime' || id.startsWith('host.runtime.') || id === 'host.provider') return 'runtime'
  if (id === 'host.services' || id.startsWith('host.services.')) return 'services'
  if (id === 'host' || id.startsWith('host.') || id === 'access' || id.startsWith('access.') || id === 'mcp') return 'host'
  return 'flow'
}

const centerX = (box: BBox) => box.x + box.width / 2
const centerY = (box: BBox) => box.y + box.height / 2
const right = (box: BBox) => box.x + box.width
const bottom = (box: BBox) => box.y + box.height

function estimateCardSize(id: string): { width: number; height: number } {
  const detail = moduleDetails[id]
  if (detail.features !== undefined) {
    return { width: cardWidth, height: 86 + detail.features.length * 24 }
  }
  if (detail.showStatus === false) {
    return { width: cardWidth, height: 88 }
  }
  return { width: cardWidth, height: 108 }
}

function slotOf(spec: ViewLayoutSpec, id: string): GridSlot | undefined {
  return Object.prototype.hasOwnProperty.call(spec.slots, id) ? spec.slots[id] : undefined
}

function topInsetOf(id: string, spec: ViewLayoutSpec): number {
  return boundaryInset.top + (spec.stages?.[id] !== undefined ? stageRowHeight : 0)
}

function ancestorsOf(id: string, rawMap: ReadonlyMap<string, LayoutedView['nodes'][number]>): string[] {
  const result: string[] = []
  let current = rawMap.get(id)?.parent ?? null
  while (current !== null) {
    result.push(current)
    current = rawMap.get(current)?.parent ?? null
  }
  return result
}

function hasTextDescription(desc: LayoutedView['nodes'][number]['description']): string | null {
  if (desc == null) return null
  return desc.txt !== undefined ? desc.txt : desc.md
}

function isBoundaryNode(node: LayoutedView['nodes'][number], spec: ViewLayoutSpec): boolean {
  return node.children.length > 0 && spec.rowContainers?.[node.id] === undefined
}

export function projectLayout(
  view: LayoutedView,
  filter: ViewFilterMode = 'all',
): {
  nodes: ArchitectureNode[]
  edges: ArchitectureEdge[]
  bounds: BBox
  nodeBounds: Map<string, BBox>
  laneLabels: { label: string; y: number }[]
  hiddenPlannedCount: { nodes: number; edges: number }
} {
  const viewId = view.id as ViewId
  const spec = viewLayouts[viewId]
  const rawMap = new Map<string, LayoutedView['nodes'][number]>(view.nodes.map((node) => [node.id, node]))

  // 1. 识别行容器子节点，并收集所有参与网格槽位的条目。
  const rowChildSet = new Set<string>()
  for (const children of Object.values(spec.rowContainers ?? {})) {
    for (const id of children) rowChildSet.add(id)
  }

  const slotEntries = Object.entries(spec.slots).filter(([id]) => rawMap.has(id))
  const maxCol = Math.max(...slotEntries.map(([, slot]) => slot.col), 0)
  const maxLane = Math.max(...slotEntries.map(([, slot]) => slot.lane), 0)

  // 计算每个网格条目的自身尺寸（普通卡或紧凑行容器）。
  const itemSizes = new Map<string, { width: number; height: number }>()
  for (const [id] of slotEntries) {
    const rowChildren = spec.rowContainers?.[id]
    if (rowChildren !== undefined) {
      const sizes = rowChildren.map((childId) => estimateCardSize(childId))
      const width = boundaryInset.side * 2 + sizes.reduce((sum, s) => sum + s.width, 0) + rowCardGap * Math.max(0, sizes.length - 1)
      const height = topInsetOf(id, spec) + Math.max(...sizes.map((s) => s.height)) + boundaryInset.bottom
      itemSizes.set(id, { width, height })
    } else {
      itemSizes.set(id, estimateCardSize(id))
    }
  }

  // 2. 计算非行容器的祖先边界覆盖范围，为嵌套容器边界预留精确间距。
  const containerRanges = new Map<string, { minCol: number; maxCol: number; minLane: number; maxLane: number }>()
  for (const [id, slot] of slotEntries) {
    for (const anc of ancestorsOf(id, rawMap)) {
      const prev = containerRanges.get(anc)
      if (prev === undefined) {
        containerRanges.set(anc, { minCol: slot.col, maxCol: slot.col, minLane: slot.lane, maxLane: slot.lane })
      } else {
        prev.minCol = Math.min(prev.minCol, slot.col)
        prev.maxCol = Math.max(prev.maxCol, slot.col)
        prev.minLane = Math.min(prev.minLane, slot.lane)
        prev.maxLane = Math.max(prev.maxLane, slot.lane)
      }
    }
  }

  const colWidths = Array.from({ length: maxCol + 1 }, (_, c) => {
    const items = slotEntries.filter(([, s]) => s.col === c).map(([id]) => itemSizes.get(id)!.width)
    return items.length > 0 ? Math.max(...items) : cardWidth
  })
  const laneHeights = Array.from({ length: maxLane + 1 }, (_, r) => {
    const items = slotEntries.filter(([, s]) => s.lane === r).map(([id]) => itemSizes.get(id)!.height)
    return items.length > 0 ? Math.max(...items) : 108
  })

  // 计算各列起始 X 与各泳道起始 Y（容器在某边界起/止时自动留出内距）。
  const colX: number[] = []
  let cursorX = 0
  for (let c = 0; c <= maxCol; c++) {
    let openingInset = 0
    let closingInset = 0
    for (const range of containerRanges.values()) {
      if (range.minCol === c) openingInset += boundaryInset.side
      if (c > 0 && range.maxCol === c - 1) closingInset += boundaryInset.side
    }
    if (c === 0) cursorX = openingInset
    else cursorX += colWidths[c - 1] + colGap + closingInset + openingInset
    colX.push(cursorX)
  }

  const laneY: number[] = []
  let cursorY = 0
  for (let r = 0; r <= maxLane; r++) {
    let openingTop = 0
    let closingBottom = 0
    for (const [cid, range] of containerRanges) {
      if (range.minLane === r) openingTop += topInsetOf(cid, spec)
      if (r > 0 && range.maxLane === r - 1) closingBottom += boundaryInset.bottom
    }
    const labelHeadroom = spec.laneLabels?.[r] !== undefined ? 36 : 0
    if (r === 0) cursorY = Math.max(openingTop, labelHeadroom)
    else cursorY += laneHeights[r - 1] + laneGap + closingBottom + Math.max(openingTop, labelHeadroom)
    laneY.push(cursorY)
  }

  // 3. 安放所有叶子节点与紧凑行容器的绝对坐标。
  const boxes = new Map<string, BoxNode>()
  for (const [id, slot] of slotEntries) {
    const raw = rawMap.get(id)!
    const size = itemSizes.get(id)!
    const x = colX[slot.col] + (colWidths[slot.col] - size.width) / 2
    const y = laneY[slot.lane] + (laneHeights[slot.lane] - size.height) / 2
    const rowChildren = spec.rowContainers?.[id]
    if (rowChildren !== undefined) {
      boxes.set(id, {
        id,
        parent: raw.parent,
        children: raw.children,
        title: raw.title,
        technology: raw.technology ?? null,
        description: hasTextDescription(raw.description),
        x,
        y,
        width: size.width,
        height: size.height,
        compound: true,
      })
      const childSizes = rowChildren.map((cid) => estimateCardSize(cid))
      const contentHeight = Math.max(...childSizes.map((s) => s.height))
      let childX = x + boundaryInset.side
      for (let i = 0; i < rowChildren.length; i++) {
        const cid = rowChildren[i]
        const craw = rawMap.get(cid)!
        const csize = childSizes[i]
        boxes.set(cid, {
          id: cid,
          parent: craw.parent,
          children: craw.children,
          title: craw.title,
          technology: craw.technology ?? null,
          description: hasTextDescription(craw.description),
          x: childX,
          y: y + topInsetOf(id, spec) + (contentHeight - csize.height) / 2,
          width: csize.width,
          height: csize.height,
          compound: false,
        })
        childX += csize.width + rowCardGap
      }
    } else {
      boxes.set(id, {
        id,
        parent: raw.parent,
        children: raw.children,
        title: raw.title,
        technology: raw.technology ?? null,
        description: hasTextDescription(raw.description),
        x,
        y,
        width: size.width,
        height: size.height,
        compound: false,
      })
    }
  }

  // 4. 自底向上收紧嵌套容器包围盒。
  const boundaryIds = view.nodes
    .filter((node) => isBoundaryNode(node, spec))
    .map((node) => node.id)

  // 按深度降序收紧，确保子容器先定盒、父容器后包裹。
  const depthOf = (id: string) => ancestorsOf(id, rawMap).length
  for (const bid of [...boundaryIds].sort((a, b) => depthOf(b) - depthOf(a))) {
    const raw = rawMap.get(bid)!
    const childBoxes = raw.children.flatMap((cid) => {
      const child = boxes.get(cid)
      return child === undefined ? [] : [child]
    })
    if (childBoxes.length === 0) continue
    const enclosed = enclosingBounds(childBoxes)
    const top = topInsetOf(bid, spec)
    const naturalWidth = enclosed.width + boundaryInset.side * 2
    const width = Math.max(naturalWidth, minBoundaryWidth(raw.title, raw.technology ?? null))
    const extra = width - naturalWidth
    boxes.set(bid, {
      id: bid,
      parent: raw.parent,
      children: raw.children,
      title: raw.title,
      technology: raw.technology ?? null,
      description: hasTextDescription(raw.description),
      x: enclosed.x - boundaryInset.side - extra / 2,
      y: enclosed.y - top,
      width,
      height: enclosed.height + top + boundaryInset.bottom,
      compound: true,
    })
  }

  // 5. 父节点先于子节点排序，在「仅已实现」模式下真正隐藏纯 planned 节点与规划边。
  const allBoxes = [...boxes.values()]
  const ordered: BoxNode[] = []
  const append = (parent: string | null) => {
    for (const box of allBoxes.filter((b) => b.parent === parent)) {
      ordered.push(box)
      append(box.id)
    }
  }
  append(null)

  const laneLabels: { label: string; y: number }[] = Object.entries(spec.laneLabels ?? {}).map(([r, label]) => ({
    label,
    y: laneY[Number(r)] - 30,
  }))

  const visibleBoxIds = new Set<string>()
  for (const box of ordered) {
    const status = moduleDetails[box.id].status
    if (filter === 'implemented' && !box.compound && status === 'planned') continue
    visibleBoxIds.add(box.id)
  }
  if (filter === 'implemented') {
    for (const box of [...ordered].reverse()) {
      if (!box.compound) continue
      const hasVisibleChild = box.children.some((cid) => visibleBoxIds.has(cid))
      if (!hasVisibleChild) visibleBoxIds.delete(box.id)
    }
  }

  const hiddenNodesCount = ordered.filter((b) => !b.compound && !visibleBoxIds.has(b.id)).length

  const nodes: ArchitectureNode[] = ordered
    .filter((box) => visibleBoxIds.has(box.id))
    .map((box) => {
      const parent = box.parent === null ? null : boxes.get(box.parent)!
      const detail = moduleDetails[box.id]
      const status = detail.status
      const { dimmed, highlighted } = nodeFilterState(status, box.compound, filter)
      const stages = (spec.stages?.[box.id] ?? []).map((stage) => {
        const visibleStageNodes = stage.nodes.filter((nid) => visibleBoxIds.has(nid))
        const stageBox = enclosingBounds((visibleStageNodes.length > 0 ? visibleStageNodes : stage.nodes).map((nid) => boxes.get(nid)!))
        return { label: stage.label, x: stageBox.x - box.x, width: stageBox.width }
      })
      return {
        id: box.id,
        type: box.compound ? 'boundary' : 'module',
        position: { x: box.x - (parent === null ? 0 : parent.x), y: box.y - (parent === null ? 0 : parent.y) },
        ...(box.parent === null ? {} : { parentId: box.parent }),
        style: { width: box.width, height: box.height },
        draggable: false,
        connectable: false,
        focusable: false,
        data: {
          title: box.title,
          technology: box.technology,
          description: box.description,
          compound: box.compound,
          status,
          tone: nodeTone(box.id, status, box.compound),
          dimmed,
          highlighted,
          boundaryNote: spec.notes?.[box.id],
          stages,
          laneLabels: [],
        },
      }
    })

  // 6. 确定性正交通道路由（避开所有非端点叶子卡与同父级外边界，交叉处留白，无共享线段）。
  const leafObstacles = allBoxes.filter((b) => !b.compound)
  const allRouted = routeAllEdges(view.edges, boxes, leafObstacles, spec, laneY, laneHeights, colX, colWidths)
  const routed = filter === 'implemented'
    ? allRouted.filter((item) => !item.planned && visibleBoxIds.has(item.edge.source) && visibleBoxIds.has(item.edge.target))
    : allRouted
  const hiddenEdgesCount = allRouted.length - routed.length

  const labelObstacles: BBox[] = [
    ...leafObstacles,
    ...allBoxes.filter((b) => b.compound).flatMap(borderStrips),
  ]
  const routesForLabels = routed.map((item) => ({
    id: item.edge.id,
    points: item.points,
    segments: polylineToSegments(item.points),
    labelBBox: item.edge.labelBBox == null
      ? null
      : {
          ...item.edge.labelBBox,
          width: item.edge.labelBBox.width + 14 + (item.planned ? 16 : 0),
          height: 30,
        },
  }))
  const labels = placeLabelsAlongRoutes(routesForLabels, labelObstacles)

  const edges: ArchitectureEdge[] = routed.map((item, index) => {
    const { edge, points: route, planned } = item
    const box = labels.get(edge.id)
    const labelBox = box === undefined ? null : { x: box.x + 6, y: box.y + 6, width: box.width - 12, height: box.height - 12 }
    const { dimmed, highlighted } = edgeFilterState(planned, filter)
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'relationship',
      zIndex: 1,
      label: edge.label,
      data: {
        path: roundedPath(route),
        route,
        labelBox,
        crossings: crossingPoints(
          routesForLabels[index].segments,
          routesForLabels.slice(0, index).flatMap((prev) => prev.segments),
        ),
        bidirectional: edge.tail === 'normal',
        planned,
        dimmed,
        highlighted,
        line: edge.line,
        kind: edge.kind,
        head: edge.head,
        tail: edge.tail,
        description: hasTextDescription(edge.description),
      },
      focusable: false,
      selectable: true,
    }
  })

  const nodeBounds = new Map<string, BBox>(allBoxes.filter((b) => visibleBoxIds.has(b.id)).map((b) => [b.id, { x: b.x, y: b.y, width: b.width, height: b.height }]))
  const geometry: BBox[] = [
    ...allBoxes.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
    ...allRouted.flatMap((r) => r.points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 }))),
    ...edges.flatMap((e) => (e.data!.labelBox === null ? [] : [e.data!.labelBox])),
    ...laneLabels.map((l) => ({ x: 0, y: l.y, width: 200, height: 22 })),
  ]
  return {
    nodes,
    edges,
    bounds: enclosingBounds(geometry),
    nodeBounds,
    laneLabels,
    hiddenPlannedCount: { nodes: hiddenNodesCount, edges: hiddenEdgesCount },
  }
}

function nodeFilterState(status: ImplementationStatus, compound: boolean, filter: ViewFilterMode): { dimmed: boolean; highlighted: boolean } {
  if (filter !== 'gaps' || compound) return { dimmed: false, highlighted: false }
  return { dimmed: status === 'implemented' || status === 'external', highlighted: status === 'planned' || status === 'partial' }
}

function edgeFilterState(planned: boolean, filter: ViewFilterMode): { dimmed: boolean; highlighted: boolean } {
  if (filter !== 'gaps') return { dimmed: false, highlighted: false }
  return { dimmed: !planned, highlighted: planned }
}

// ———— 正交通道路由器 ————

type Side = 'left' | 'right' | 'top' | 'bottom'

interface PlannedRoute {
  edge: LayoutedView['edges'][number]
  points: XYPoint[]
  planned: boolean
}

function routeAllEdges(
  edges: readonly LayoutedView['edges'][number][],
  boxes: ReadonlyMap<string, BoxNode>,
  obstacles: readonly BoxNode[],
  spec: ViewLayoutSpec,
  laneY: readonly number[],
  laneHeights: readonly number[],
  colX: readonly number[],
  colWidths: readonly number[],
): PlannedRoute[] {
  // 1. 决定每条边的起止边，确保同一方向自然贴边。
  const sideChoices = edges.map((edge) => {
    const s = boxes.get(edge.source)!
    const t = boxes.get(edge.target)!
    return chooseSides(edge, s, t, spec, obstacles)
  })

  // 2. 按节点边分组并依据对侧坐标排序，给同一边上的多条线分配互不重叠的端口坐标。
  const sideGroups = new Map<string, number[]>()
  sideChoices.forEach((choice, idx) => {
    const sk = `${edges[idx].source}:${choice.sSide}`
    const tk = `${edges[idx].target}:${choice.tSide}`
    sideGroups.set(sk, [...(sideGroups.get(sk) ?? []), idx])
    sideGroups.set(tk, [...(sideGroups.get(tk) ?? []), idx])
  })

  const exitPoints: XYPoint[] = new Array<XYPoint>(edges.length)
  const entryPoints: XYPoint[] = new Array<XYPoint>(edges.length)

  for (const [key, indices] of sideGroups) {
    const [nodeId, side] = key.split(':') as [string, Side]
    const box = boxes.get(nodeId)!
    const isHorizontal = side === 'left' || side === 'right'
    const sorted = [...indices].sort((a, b) => {
      const aOtherId = edges[a].source === nodeId ? edges[a].target : edges[a].source
      const bOtherId = edges[b].source === nodeId ? edges[b].target : edges[b].source
      const aOther = boxes.get(aOtherId)!
      const bOther = boxes.get(bOtherId)!
      return isHorizontal ? centerY(aOther) - centerY(bOther) : centerX(aOther) - centerX(bOther)
    })

    const spanStart = (isHorizontal ? box.y : box.x) + portCornerMargin
    const spanEnd = (isHorizontal ? bottom(box) : right(box)) - portCornerMargin
    const count = sorted.length
    sorted.forEach((edgeIdx, rank) => {
      const otherId = edges[edgeIdx].source === nodeId ? edges[edgeIdx].target : edges[edgeIdx].source
      const other = boxes.get(otherId)!
      // 单条且正对中心时直接对准中心，保持直线美观。
      const pos = count === 1
        ? (isHorizontal ? centerY(box) : centerX(box))
        : spanStart + ((rank + 0.5) / count) * Math.max(0, spanEnd - spanStart)
      // 若多条线中刚好有一条与对方中心同水平/同垂直，优先让该条不歪。
      const alignedCenter = count === 1 && Math.abs((isHorizontal ? centerY(other) - centerY(box) : centerX(other) - centerX(box))) < 2
        ? (isHorizontal ? centerY(other) : centerX(other))
        : pos
      const pt = sidePoint(box, side, Math.max(spanStart, Math.min(spanEnd, alignedCenter)))
      if (edges[edgeIdx].source === nodeId) exitPoints[edgeIdx] = pt
      else entryPoints[edgeIdx] = pt
    })
  }

  // 3. 逐条路由，已占用的水平/垂直通道坐标记录下来，后绘线自动错开至少 trackStep。
  const usedHorizontalY: number[] = []
  const usedVerticalX: number[] = []

  const allocX = (preferred: number, minX: number, maxX: number): number => {
    for (let step = 0; step < 30; step++) {
      const delta = step === 0 ? 0 : (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2) * trackStep
      const candidate = Math.round(preferred + delta)
      if (candidate > minX && candidate < maxX && !usedVerticalX.some((x) => Math.abs(x - candidate) < 6)) {
        usedVerticalX.push(candidate)
        return candidate
      }
    }
    return Math.round(preferred)
  }

  const allocY = (preferred: number, y1: number, y2: number): number => {
    const low = Math.min(y1, y2)
    const high = Math.max(y1, y2)
    for (let step = 0; step < 40; step++) {
      const delta = step === 0 ? 0 : (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2) * trackStep
      const candidate = Math.round(preferred + delta)
      if (candidate > low && candidate < high && !usedHorizontalY.some((y) => Math.abs(y - candidate) < 6)) {
        usedHorizontalY.push(candidate)
        return candidate
      }
    }
    return Math.round(preferred)
  }

  // 全局下方安全通道（绕开所有卡片与容器，供跨区消费线或回流线使用）。
  const globalBottomY = Math.max(...[...boxes.values()].map(bottom)) + 36
  // 各泳道间隙带（自动避让在该泳道结束的容器底边内距）。
  const laneGaps: { yMin: number; yMax: number }[] = []
  for (let r = 0; r < laneY.length - 1; r++) {
    const laneBottom = laneY[r] + laneHeights[r]
    const containerBottoms = [...boxes.values()]
      .filter((b) => b.compound && bottom(b) > laneBottom && bottom(b) < laneY[r + 1])
      .map(bottom)
    const bandTop = Math.max(laneBottom, ...containerBottoms)
    laneGaps.push({ yMin: bandTop + 10, yMax: laneY[r + 1] - 10 })
  }

  return edges.map((edge, idx) => {
    const s = boxes.get(edge.source)!
    const t = boxes.get(edge.target)!
    const { sSide, tSide } = sideChoices[idx]
    const pStart = exitPoints[idx]
    const pEnd = entryPoints[idx]
    const nonEndpointObstacles = obstacles.filter((o) => o.id !== s.id && o.id !== t.id)

    let points: XYPoint[]

    // 直连同水平无障碍（正向或相邻反向回环）
    if (
      ((sSide === 'right' && tSide === 'left') || (sSide === 'left' && tSide === 'right'))
      && Math.abs(pStart.y - pEnd.y) < 1
      && !horizontalBlocked(pStart.x, pEnd.x, pStart.y, nonEndpointObstacles)
    ) {
      const y = Math.round(pStart.y)
      points = [{ x: pStart.x, y }, { x: pEnd.x, y }]
    } else if (
      ((sSide === 'bottom' && tSide === 'top') || (sSide === 'top' && tSide === 'bottom'))
      && Math.abs(pStart.x - pEnd.x) < 1
      && !verticalBlocked(pStart.y, pEnd.y, pStart.x, nonEndpointObstacles)
    ) {
      const x = Math.round(pStart.x)
      points = [{ x, y: pStart.y }, { x, y: pEnd.y }]
    } else if (sSide === 'bottom' && tSide === 'bottom') {
      // 同底边跨区域通道绕行：优先找起点下方第一个无障碍水平间隙带，避免穿过下一泳道卡片。
      const xMin = Math.min(pStart.x, pEnd.x) - 4
      const xMax = Math.max(pStart.x, pEnd.x) + 4
      const containerFloor = [...boxes.values()]
        .filter((b) => b.compound && right(b) > xMin && b.x < xMax && bottom(b) >= Math.min(bottom(s), bottom(t)) && b.y < Math.max(bottom(s), bottom(t)))
        .map(bottom)
      const minTrackY = Math.max(bottom(s), bottom(t), ...containerFloor) + 18
      const band = findFirstClearBand(minTrackY, xMin, xMax, nonEndpointObstacles, laneGaps, globalBottomY)
      const yTrack = allocY(band.preferred, band.min, band.max)
      points = simplifyPolyline([
        pStart,
        { x: pStart.x, y: yTrack },
        { x: pEnd.x, y: yTrack },
        pEnd,
      ])
    } else if (sSide === 'right' && tSide === 'left') {
      const gapLeft = right(s)
      const gapRight = t.x
      // 判断是否直落相邻垂直走廊，且沿路无中间障碍
      const midXPreferred = (gapLeft + gapRight) / 2
      const directVerticalFree = !verticalBlocked(pStart.y, pEnd.y, midXPreferred, nonEndpointObstacles)
      const firstLegFree = !horizontalBlocked(pStart.x, midXPreferred, pStart.y, nonEndpointObstacles)
      const secondLegFree = !horizontalBlocked(midXPreferred, pEnd.x, pEnd.y, nonEndpointObstacles)

      if (directVerticalFree && firstLegFree && secondLegFree) {
        const vx = allocX(midXPreferred, Math.max(pStart.x + 8, gapLeft + 4), Math.min(pEnd.x - 8, gapRight - 4))
        points = simplifyPolyline([
          pStart,
          { x: vx, y: pStart.y },
          { x: vx, y: pEnd.y },
          pEnd,
        ])
      } else {
        // 跨越中间列有障碍：先走起点右侧走廊到清晰的泳道间隙，再进入目标左侧走廊。
        const sSlot = slotOf(spec, s.id)
        const tSlot = slotOf(spec, t.id)
        const exitCorridorMax = sSlot !== undefined && sSlot.col + 1 < colX.length ? colX[sSlot.col + 1] - 4 : gapRight - 4
        const entryCorridorMin = tSlot !== undefined && tSlot.col > 0 ? colX[tSlot.col - 1] + colWidths[tSlot.col - 1] + 4 : gapLeft + 4
        const vx1 = allocX(right(s) + 32, right(s) + 8, Math.max(right(s) + 16, exitCorridorMax))
        const vx2 = allocX(t.x - 32, Math.min(t.x - 16, entryCorridorMin), t.x - 8)
        const targetGap = pickBestLaneGap(pStart.y, pEnd.y, laneGaps, Math.min(vx1, vx2), Math.max(vx1, vx2), nonEndpointObstacles, globalBottomY)
        const yTrack = allocY(targetGap.preferred, targetGap.min, targetGap.max)
        points = simplifyPolyline([
          pStart,
          { x: vx1, y: pStart.y },
          { x: vx1, y: yTrack },
          { x: vx2, y: yTrack },
          { x: vx2, y: pEnd.y },
          pEnd,
        ])
      }
    } else if (sSide === 'right' && (tSide === 'top' || tSide === 'bottom')) {
      // L 形：右出 → 垂直进目标顶边或底边
      points = simplifyPolyline([
        pStart,
        { x: pEnd.x, y: pStart.y },
        pEnd,
      ])
    } else if ((sSide === 'top' || sSide === 'bottom') && tSide === 'left') {
      // L 形：上下出 → 水平进目标左边
      points = simplifyPolyline([
        pStart,
        { x: pStart.x, y: pEnd.y },
        pEnd,
      ])
    } else {
      // 通用垂直或反向折线
      const vx = allocX(Math.min(pStart.x, pEnd.x) - 28, Math.min(s.x, t.x) - 80, Math.min(s.x, t.x) - 8)
      points = simplifyPolyline([
        pStart,
        { x: vx, y: pStart.y },
        { x: vx, y: pEnd.y },
        pEnd,
      ])
    }

    return {
      edge,
      points,
      planned: edge.tags?.some((tag) => tag === 'planned') === true,
    }
  })
}

function chooseSides(
  edge: LayoutedView['edges'][number],
  s: BoxNode,
  t: BoxNode,
  spec: ViewLayoutSpec,
  obstacles: readonly BoxNode[],
): { sSide: Side; tSide: Side } {
  const key = `${edge.source}>${edge.target}`
  // 已知特例端口分流，防止多分支在同侧重合。
  if (key === 'nativeClients>access.network') return { sSide: 'right', tSide: 'top' }
  if (key === 'host.adapter>host.policy') return { sSide: 'right', tSide: 'bottom' }
  if (key === 'customClients>host.adapter') return { sSide: 'bottom', tSide: 'bottom' }

  const sSlot = slotOf(spec, s.id)
  const tSlot = slotOf(spec, t.id)
  // 同列垂直关系
  if (sSlot !== undefined && tSlot !== undefined && sSlot.col === tSlot.col) {
    return tSlot.lane > sSlot.lane ? { sSide: 'bottom', tSide: 'top' } : { sSide: 'top', tSide: 'bottom' }
  }
  // 目标在左侧：若同一泳道且中间无障碍则直接向左直连，否则从底边通道绕行。
  if (t.x + t.width <= s.x + 1) {
    const nonEndpointObstacles = obstacles.filter((o) => o.id !== s.id && o.id !== t.id)
    if (sSlot !== undefined && tSlot !== undefined && sSlot.lane === tSlot.lane && !horizontalBlocked(right(t), s.x, centerY(s), nonEndpointObstacles)) {
      return { sSide: 'left', tSide: 'right' }
    }
    return { sSide: 'bottom', tSide: 'bottom' }
  }
  return { sSide: 'right', tSide: 'left' }
}

function sidePoint(box: BoxNode, side: Side, coord: number): XYPoint {
  switch (side) {
    case 'left': return { x: box.x, y: Math.round(coord) }
    case 'right': return { x: right(box), y: Math.round(coord) }
    case 'top': return { x: Math.round(coord), y: box.y }
    case 'bottom': return { x: Math.round(coord), y: bottom(box) }
  }
}

function horizontalBlocked(x1: number, x2: number, y: number, obstacles: readonly BoxNode[]): boolean {
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  return obstacles.some((o) => right(o) > minX + 1 && o.x < maxX - 1 && y >= o.y - 2 && y <= bottom(o) + 2)
}

function verticalBlocked(y1: number, y2: number, x: number, obstacles: readonly BoxNode[]): boolean {
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)
  return obstacles.some((o) => bottom(o) > minY + 1 && o.y < maxY - 1 && x >= o.x - 2 && x <= right(o) + 2)
}

function findFirstClearBand(
  minY: number,
  x1: number,
  x2: number,
  obstacles: readonly BoxNode[],
  laneGaps: readonly { yMin: number; yMax: number }[],
  globalBottomY: number,
): { preferred: number; min: number; max: number } {
  const blocking = obstacles.filter((o) => right(o) > x1 && o.x < x2)
  // 依次检查每条泳道间隙带与下方总通道，找到首个满足 minY 且无障碍的带区。
  for (const gap of laneGaps) {
    const bandMin = Math.max(minY, gap.yMin)
    if (gap.yMax - bandMin >= 20 && !blocking.some((o) => bottom(o) > bandMin - 2 && o.y < gap.yMax + 2)) {
      return { preferred: (bandMin + gap.yMax) / 2, min: bandMin, max: gap.yMax }
    }
  }
  const floor = blocking.length > 0 ? Math.max(...blocking.map(bottom)) + 16 : minY
  const low = Math.max(minY, floor, globalBottomY - 12)
  return { preferred: low + 14, min: low, max: low + 80 }
}

function pickBestLaneGap(
  y1: number,
  y2: number,
  laneGaps: readonly { yMin: number; yMax: number }[],
  x1: number,
  x2: number,
  obstacles: readonly BoxNode[],
  globalBottomY: number,
): { preferred: number; min: number; max: number } {
  const mid = (y1 + y2) / 2
  const clearGaps = laneGaps
    .filter((gap) => gap.yMax - gap.yMin >= 20)
    .filter((gap) => !obstacles.some((o) => right(o) > x1 && o.x < x2 && bottom(o) > gap.yMin && o.y < gap.yMax))
    .sort((a, b) => Math.abs((a.yMin + a.yMax) / 2 - mid) - Math.abs((b.yMin + b.yMax) / 2 - mid))

  if (clearGaps.length > 0) {
    const best = clearGaps[0]
    return { preferred: (best.yMin + best.yMax) / 2, min: best.yMin, max: best.yMax }
  }
  return { preferred: globalBottomY, min: globalBottomY - 10, max: globalBottomY + 80 }
}

function simplifyPolyline(points: readonly XYPoint[]): XYPoint[] {
  const clean: XYPoint[] = []
  for (const pt of points) {
    const prev = clean.at(-1)
    if (prev !== undefined && prev.x === pt.x && prev.y === pt.y) continue
    clean.push({ x: Math.round(pt.x), y: Math.round(pt.y) })
  }
  const result: XYPoint[] = []
  for (const pt of clean) {
    if (result.length >= 2) {
      const a = result[result.length - 2]
      const b = result[result.length - 1]
      if ((a.x === b.x && b.x === pt.x) || (a.y === b.y && b.y === pt.y)) {
        result[result.length - 1] = pt
        continue
      }
    }
    result.push(pt)
  }
  return result
}

function borderStrips(box: BBox): BBox[] {
  return [
    { x: box.x, y: box.y, width: box.width, height: 1 },
    { x: box.x, y: box.y + box.height - 1, width: box.width, height: 1 },
    { x: box.x, y: box.y, width: 1, height: box.height },
    { x: box.x + box.width - 1, y: box.y, width: 1, height: box.height },
  ]
}

function enclosingBounds(boxes: readonly BBox[]): BBox {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  }
}

function crossingPoints(
  current: ReturnType<typeof polylineToSegments>,
  previous: ReturnType<typeof polylineToSegments>,
): XYPoint[] {
  const crossings: XYPoint[] = []
  for (const [a, b] of current) {
    for (const [c, d] of previous) {
      if ((a.y === b.y) === (c.y === d.y)) continue
      const [hStart, hEnd, vStart, vEnd] = a.y === b.y ? [a, b, c, d] : [c, d, a, b]
      const point = { x: vStart.x, y: hStart.y }
      if (
        point.x > Math.min(hStart.x, hEnd.x) && point.x < Math.max(hStart.x, hEnd.x)
        && point.y > Math.min(vStart.y, vEnd.y) && point.y < Math.max(vStart.y, vEnd.y)
      ) {
        if (!crossings.some((other) => other.x === point.x && other.y === point.y)) crossings.push(point)
      }
    }
  }
  return crossings
}

function roundedPath(points: readonly XYPoint[]): string {
  let path = `M${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const corner = points[i]
    const next = points[i + 1]
    const before = Math.hypot(corner.x - prev.x, corner.y - prev.y)
    const after = Math.hypot(next.x - corner.x, next.y - corner.y)
    const radius = Math.min(8, before / 2, after / 2)
    if (radius <= 0) {
      path += ` L${corner.x} ${corner.y}`
      continue
    }
    const entry = {
      x: corner.x + (prev.x - corner.x) * radius / before,
      y: corner.y + (prev.y - corner.y) * radius / before,
    }
    const exit = {
      x: corner.x + (next.x - corner.x) * radius / after,
      y: corner.y + (next.y - corner.y) * radius / after,
    }
    path += ` L${entry.x} ${entry.y} Q${corner.x} ${corner.y} ${exit.x} ${exit.y}`
  }
  const end = points[points.length - 1]
  return `${path} L${end.x} ${end.y}`
}
