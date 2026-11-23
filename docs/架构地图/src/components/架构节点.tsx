/** 节点直接使用共享 shadcn 卡片与按钮，避免 LikeC4 shadow DOM 内的第二套 UI。 */
import { useEffect, useRef } from 'react'
import { Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import type { ArchitectureEdge, ArchitectureNode } from '../布局适配'
import { moduleDetails } from '../模块说明'
import { ImplementationBadge } from './实现标记'
import { FeatureList } from './能力明细'

function useReturnFocus(onReturnFocus: (() => void) | undefined) {
  const button = useRef<HTMLButtonElement>(null)
  // React Flow 在测量期间隐藏节点，等本节点实际可见再接回焦点。
  useEffect(() => {
    const target = button.current
    const wrapper = target?.closest('.react-flow__node')
    if (onReturnFocus === undefined || target === null || wrapper == null) return
    const restore = () => {
      if (getComputedStyle(target).visibility !== 'visible') return
      observer.disconnect()
      target.focus({ preventScroll: true })
      onReturnFocus()
    }
    const observer = new MutationObserver(restore)
    observer.observe(wrapper, { attributes: true, attributeFilter: ['style', 'class'] })
    restore()
    return () => observer.disconnect()
  }, [onReturnFocus])
  return button
}

export function ModuleNode({ id, data, selected }: NodeProps<ArchitectureNode>) {
  const { icon: Icon, features, showStatus, navigateOnClick } = moduleDetails[id]
  const button = useReturnFocus(data.onReturnFocus)
  return <div className="architecture-node" data-selected={selected} data-status={data.status}>
    <Handle type="target" position={Position.Left} />
    <Card size="sm" className="h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <CardTitle>
            <Button ref={button} variant="link" size="default" aria-label={`查看${data.title}`}>
              {data.title}{navigateOnClick === true && <ArrowUpRight className="size-3" aria-hidden="true" />}
            </Button>
          </CardTitle>
        </div>
        {features !== undefined ? <FeatureList items={features} /> : <>
          <p className="text-xs text-muted-foreground">{data.technology}</p>
          <div className="flex h-5 items-center">{showStatus !== false && <ImplementationBadge status={data.status} />}</div>
        </>}
      </CardHeader>
    </Card>
    <Handle type="source" position={Position.Right} />
  </div>
}

export function BoundaryNode({ id, data }: NodeProps<ArchitectureNode>) {
  const { icon: Icon, boundaryNote } = moduleDetails[id]
  const button = useReturnFocus(data.onReturnFocus)
  return <div className="architecture-boundary">
    <Handle type="target" position={Position.Left} />
    <div className="architecture-boundary-heading">
      <Icon className="size-4" aria-hidden="true" />
      <Button ref={button} variant="ghost" size="sm" aria-label={`查看${data.title}`}>{data.title}</Button>
      <span className="text-xs text-muted-foreground">{data.technology}</span>
    </div>
    {data.stages.map(stage => <span key={stage.label} className="architecture-stage text-xs" style={{ left: stage.x, width: stage.width }}>{stage.label}</span>)}
    {boundaryNote !== undefined && <p className="architecture-boundary-note text-xs text-muted-foreground">{boundaryNote}</p>}
    <Handle type="source" position={Position.Right} />
  </div>
}

export function RelationshipEdge({ id, data, label }: EdgeProps<ArchitectureEdge>) {
  const { path, labelBox, crossings, bidirectional, planned, line, kind, head, tail } = data!
  return <g className="architecture-relationship" data-planned={planned} data-bidirectional={bidirectional} data-line={line} data-kind={kind}>
    {crossings.map(point => <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r={4} fill="var(--background)" data-crossing="true" />)}
    <path id={id} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={line === 'dotted' ? '1 5' : line === 'dashed' ? '5 4' : undefined} strokeLinecap={line === 'dotted' ? 'round' : undefined} markerEnd={head === 'none' ? undefined : `url(#architecture-arrow-${head ?? 'normal'})`} markerStart={tail === undefined || tail === 'none' ? undefined : `url(#architecture-arrow-${tail})`} />
    {labelBox !== null && label && <g transform={`translate(${labelBox.x + labelBox.width / 2}, ${labelBox.y + labelBox.height / 2})`}>
      <rect x={-labelBox.width / 2} y={-labelBox.height / 2} width={labelBox.width} height={labelBox.height} rx={4} />
      {planned && <g role="img" aria-label="未实现关系" className="text-orange-600 dark:text-orange-400"><circle cx={-labelBox.width / 2 + 7} cy={0} r={2.5} fill="currentColor" /></g>}
      <text x={planned ? 8 : 0} textAnchor="middle" dominantBaseline="central" className="text-xs">{label}</text>
    </g>}
  </g>
}
