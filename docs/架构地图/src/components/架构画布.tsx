/** LikeC4 提供布局，React Flow 负责平移缩放；所有交互控件由共享 shadcn 呈现。 */
import { useEffect, useEffectEvent, useMemo } from 'react'
import { Background, BackgroundVariant, ReactFlow, useNodesInitialized, useReactFlow, useViewportStore, useViewport, type NodeTypes, type EdgeTypes } from '@xyflow/react'
import { useLikeC4Model } from 'likec4:single-project'
import { Minus, Plus, Scan, Undo2 } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { projectLayout, type ArchitectureNode, type ArchitectureEdge } from '../布局适配'
import { BoundaryNode, ModuleNode, RelationshipEdge } from './架构节点'
import { IconButton } from './图标按钮'
import type { ViewId } from '../视图'

const nodeTypes: NodeTypes = { module: ModuleNode, boundary: BoundaryNode }
const edgeTypes: EdgeTypes = { relationship: RelationshipEdge }
const canvasPadding = { top: 120, bottom: 80, left: 32, right: 32 }

export function ArchitectureCanvas({ viewId, selectedId, onSelect }: { viewId: ViewId; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const model = useLikeC4Model()
  const layout = model.view(viewId).$layouted
  const graph = useMemo(() => projectLayout(layout), [layout])
  const nodes = useMemo(() => graph.nodes.map(node => ({ ...node, selected: node.id === selectedId })), [graph.nodes, selectedId])
  const flow = useReactFlow<ArchitectureNode, ArchitectureEdge>()
  const { zoom } = useViewport()
  const width = useViewportStore(state => state.width)
  const height = useViewportStore(state => state.height)
  const initialized = useNodesInitialized()
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220
  function fit() {
    void flow.fitBounds(graph.bounds, { padding: canvasPadding, duration })
  }
  function read() {
    const bounds = graph.bounds
    const availableWidth = width - canvasPadding.left - canvasPadding.right
    const availableHeight = height - canvasPadding.top - canvasPadding.bottom
    // 横向全图很宽；默认保持文字可读，从左侧入口开始，适应按钮再用于查看全貌。
    const scale = Math.max(0.85, Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height))
    void flow.setViewport({
      x: canvasPadding.left - bounds.x * scale,
      y: canvasPadding.top + Math.max(0, (availableHeight - bounds.height * scale) / 2) - bounds.y * scale,
      zoom: scale,
    }, { duration })
  }

  // React Flow 实例对象会随渲染更新；只让选择、布局和尺寸变化触发定位，避免用户缩放被复位。
  const position = useEffectEvent(() => {
    if (selectedId !== null) {
      void flow.fitBounds(graph.nodeBounds.get(selectedId)!, { padding: canvasPadding, duration })
    } else read()
  })
  useEffect(() => {
    if (initialized) position()
  }, [selectedId, initialized, graph, width, height])

  function reset() {
    onSelect(null)
    read()
  }

  return <section className="architecture-canvas" aria-label="核心架构图" data-testid="architecture-canvas">
      <svg className="absolute size-0" aria-hidden="true"><defs>
        <marker id="architecture-arrow-normal" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" /></marker>
        <marker id="architecture-arrow-open" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" /></marker>
      </defs></svg>
      <ReactFlow<ArchitectureNode, ArchitectureEdge>
        nodes={nodes}
        edges={graph.edges}
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
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
        aria-label="Cogent 核心架构，可拖动画布、缩放或点击模块查看说明"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
      </ReactFlow>
      <ul className="canvas-legend text-xs text-muted-foreground" aria-label="连线图例">
        {[
          ['调用流程', undefined, 'normal'],
          ['适配依赖', '1 5', 'open'],
        ].map(([name, dash, head]) => <li key={name}>
          <svg viewBox="0 0 40 12" className="h-3 w-10 shrink-0" aria-hidden="true"><path d="M 0 6 H 38" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} strokeLinecap={dash === '1 5' ? 'round' : undefined} markerEnd={`url(#architecture-arrow-${head})`} /></svg>
          <span>{name}</span>
        </li>)}
        <li><span className="size-2 rounded-full bg-orange-600 dark:bg-orange-400" aria-hidden="true" /><span>未实现关系</span></li>
      </ul>
      <div className="canvas-controls" role="group" aria-label="画布操作">
        <IconButton label="缩小" onClick={() => { void flow.zoomOut({ duration }) }} disabled={zoom <= 0.05}><Minus /></IconButton>
        <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-label="当前缩放">{Math.round(zoom * 100)}%</span>
        <IconButton label="放大" onClick={() => { void flow.zoomIn({ duration }) }} disabled={zoom >= 1.6}><Plus /></IconButton>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <IconButton label="适应画布" onClick={fit}><Scan /></IconButton>
        <IconButton label="恢复总览" onClick={reset}><Undo2 /></IconButton>
      </div>
  </section>
}
