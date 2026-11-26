/** 确定性网格布局画布：React Flow 负责平移缩放、连线点选与泳道/图例呈现。 */
import { useEffect, useEffectEvent, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  useViewportStore,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import { useLikeC4Model } from 'likec4:single-project'
import {
  projectLayout,
  type ArchitectureEdge,
  type ArchitectureNode,
  type ViewFilterMode,
} from '../网格布局'
import type { ViewId } from '../视图'
import { CheckIcon, MinusIcon, PlusIcon, ScanIcon, Undo2Icon } from './图标'
import { IconButton } from './图标按钮'
import { BoundaryNode, ModuleNode, RelationshipEdge } from './架构节点'
import { Separator } from './UI'

const nodeTypes: NodeTypes = { module: ModuleNode, boundary: BoundaryNode }
const edgeTypes: EdgeTypes = { relationship: RelationshipEdge }
const canvasPadding = { top: 120, bottom: 80, left: 32, right: 32 }

export function ArchitectureCanvas({
  viewId,
  filter,
  selectedId,
  selectedEdgeId,
  onSelect,
  onSelectEdge,
  returnFocusId,
  onReturnFocus,
}: {
  viewId: ViewId
  filter: ViewFilterMode
  selectedId: string | null
  selectedEdgeId: string | null
  onSelect: (id: string | null) => void
  onSelectEdge: (edge: { id: string; source: string; target: string; label?: string; description?: string | null } | null) => void
  returnFocusId: string | null
  onReturnFocus: () => void
}) {
  const model = useLikeC4Model()
  const layout = model.view(viewId).$layouted
  const graph = useMemo(() => projectLayout(layout, filter), [layout, filter])
  const nodes = useMemo(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedId,
        ...(node.id === returnFocusId && { data: { ...node.data, onReturnFocus } }),
      })),
    [graph.nodes, selectedId, returnFocusId, onReturnFocus],
  )
  const edges = useMemo(
    () =>
      graph.edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId,
      })),
    [graph.edges, selectedEdgeId],
  )

  const flow = useReactFlow<ArchitectureNode, ArchitectureEdge>()
  const { zoom, x: panX, y: panY } = useViewport()
  const width = useViewportStore((state) => state.width)
  const height = useViewportStore((state) => state.height)
  const initialized = useNodesInitialized()
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220

  const fitsCanvas = graph.bounds.width * zoom <= width && graph.bounds.height * zoom <= height
  const extentWidth = Math.max(graph.bounds.width, width / zoom)
  const extentHeight = Math.max(graph.bounds.height, height / zoom)
  const minimapWidth = 288

  function fit() {
    void flow.fitBounds(graph.bounds, { padding: canvasPadding, duration })
  }

  function read() {
    if (width <= 0 || height <= 0) return
    const bounds = graph.bounds
    const availableWidth = width - canvasPadding.left - canvasPadding.right
    const availableHeight = height - canvasPadding.top - canvasPadding.bottom
    const scale = Math.max(0.85, Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height))
    void flow.setViewport(
      {
        x: canvasPadding.left - bounds.x * scale,
        y: canvasPadding.top + Math.max(0, (availableHeight - bounds.height * scale) / 2) - bounds.y * scale,
        zoom: scale,
      },
      { duration },
    )
  }

  const position = useEffectEvent(() => {
    if (selectedId !== null) {
      const box = graph.nodeBounds.get(selectedId)
      if (box !== undefined) void flow.fitBounds(box, { padding: canvasPadding, duration })
    } else {
      read()
    }
  })

  useEffect(() => {
    if (!initialized || width <= 0 || height <= 0) return
    const frame = window.requestAnimationFrame(() => position())
    return () => window.cancelAnimationFrame(frame)
  }, [selectedId, initialized, graph, width, height])

  function reset() {
    onSelect(null)
    onSelectEdge(null)
    read()
  }

  return (
    <section className="architecture-canvas" aria-label="核心架构图" data-testid="architecture-canvas">
      <svg className="absolute size-0" aria-hidden="true">
        <defs>
          <marker id="architecture-arrow-normal" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
          <marker id="architecture-arrow-open" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </marker>
        </defs>
      </svg>
      <ReactFlow<ArchitectureNode, ArchitectureEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.05}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onEdgeClick={(_event, edge) =>
          onSelectEdge({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            label: typeof edge.label === 'string' ? edge.label : undefined,
            description: edge.data?.description ?? null,
          })
        }
        onPaneClick={() => {
          onSelect(null)
          onSelectEdge(null)
        }}
        proOptions={{ hideAttribution: true }}
        aria-label="Cogent 项目地图，可拖动画布、缩放或点击模块与连线查看说明"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
        {!fitsCanvas && (
          <MiniMap<ArchitectureNode>
            ariaLabel="架构缩略图"
            position="bottom-right"
            pannable
            zoomable
            bgColor="var(--background)"
            maskColor="color-mix(in srgb, var(--background) 55%, transparent)"
            maskStrokeColor="var(--muted-foreground)"
            nodeColor={(node) => (node.type === 'boundary' ? 'var(--border)' : 'var(--muted-foreground)')}
            nodeBorderRadius={2}
            style={{
              width: minimapWidth,
              height: Math.round(Math.max(56, Math.min(160, (minimapWidth * extentHeight) / extentWidth))),
              marginBottom: 64,
            }}
          />
        )}
      </ReactFlow>

      {/* 专题流程泳道分隔与胶囊标题跟随画布坐标平移缩放。 */}
      {graph.laneLabels.length > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transformOrigin: '0 0' }}>
            {graph.laneLabels.map((lane) => (
              <div
                key={lane.label}
                className="architecture-lane-band"
                style={{ top: lane.y, left: graph.bounds.x, width: Math.max(420, graph.bounds.width) }}
              >
                <span className="architecture-lane-label">{lane.label}</span>
                <span className="architecture-lane-rule" />
              </div>
            ))}
          </div>
        </div>
      )}

      <ul className="canvas-legend text-xs text-muted-foreground" aria-label="连线图例">
        {[
          ['调用流程', undefined, 'normal'],
          ['配置 / 装配', '5 4', 'open'],
          ['适配依赖', '1 5', 'open'],
        ].map(([name, dash, head]) => (
          <li key={name}>
            <svg viewBox="0 0 40 12" className="h-3 w-10 shrink-0" aria-hidden="true">
              <path
                d="M 0 6 H 38"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray={dash}
                strokeLinecap={dash === '1 5' ? 'round' : undefined}
                markerEnd={`url(#architecture-arrow-${head})`}
              />
            </svg>
            <span>{name}</span>
          </li>
        ))}
        <li>
          <CheckIcon className="size-3.5 text-green-600 dark:text-green-500" aria-hidden="true" />
          <span>已实现</span>
        </li>
        <li>
          <span className="inline-flex items-center gap-0.5" aria-hidden="true">
            <span className="size-1.5 rounded-full bg-green-600 dark:bg-green-500" />
            <span className="size-1.5 rounded-full bg-orange-600 dark:bg-orange-400" />
          </span>
          <span>部分完成</span>
        </li>
        <li>
          <span className="size-2 rounded-full bg-orange-600 dark:bg-orange-400" aria-hidden="true" />
          <span>未实现 / 规划</span>
        </li>
        {(graph.hiddenPlannedCount.nodes > 0 || graph.hiddenPlannedCount.edges > 0) && (
          <li className="rounded-full border border-border bg-muted/70 px-2 py-0.5 text-[11px] text-foreground">
            已隐藏 {graph.hiddenPlannedCount.nodes} 节点 / {graph.hiddenPlannedCount.edges} 规划连线
          </li>
        )}
      </ul>

      <div className="canvas-controls" role="group" aria-label="画布操作">
        <IconButton label="缩小" onClick={() => { void flow.zoomOut({ duration }) }} disabled={zoom <= 0.05}>
          <MinusIcon />
        </IconButton>
        <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-label="当前缩放">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton label="放大" onClick={() => { void flow.zoomIn({ duration }) }} disabled={zoom >= 1.6}>
          <PlusIcon />
        </IconButton>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <IconButton label="适应画布" onClick={fit}>
          <ScanIcon />
        </IconButton>
        <IconButton label="复位画布" onClick={reset}>
          <Undo2Icon />
        </IconButton>
      </div>
    </section>
  )
}
