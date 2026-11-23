/** 节点直接使用共享 shadcn 卡片与按钮，避免 LikeC4 shadow DOM 内的第二套 UI。 */
import { Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import type { ArchitectureEdge, ArchitectureNode } from '../布局适配'
import { moduleDetails } from '../模块说明'
import { ImplementationBadge } from './实现标记'
import { FeatureList } from './能力明细'

export function ModuleNode({ id, data, selected }: NodeProps<ArchitectureNode>) {
  const { icon: Icon, features, showStatus, navigateOnClick } = moduleDetails[id]
  return <div className="architecture-node" data-selected={selected} data-status={data.status}>
    <Handle type="target" position={Position.Left} />
    <Card size="sm" className="h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <CardTitle>
            <Button variant="link" size="default" aria-label={`查看${data.title}`}>
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
  return <div className="architecture-boundary">
    <Handle type="target" position={Position.Left} />
    <div className="architecture-boundary-heading">
      <Icon className="size-4" aria-hidden="true" />
      <Button variant="ghost" size="sm" aria-label={`查看${data.title}`}>{data.title}</Button>
      <span className="text-xs text-muted-foreground">{data.technology}</span>
    </div>
    {boundaryNote !== undefined && <p className="architecture-boundary-note text-xs text-muted-foreground">{boundaryNote}</p>}
    <Handle type="source" position={Position.Right} />
  </div>
}

export function RelationshipEdge({ id, data, label }: EdgeProps<ArchitectureEdge>) {
  const { path, labelBox, crossings, bidirectional, planned, line } = data!
  return <g className="architecture-relationship" data-planned={planned} data-bidirectional={bidirectional} data-line={line}>
    {crossings.map(point => <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r={4} fill="var(--background)" data-crossing="true" />)}
    <path id={id} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={line === 'dotted' ? '1 5' : line === 'dashed' ? '5 4' : undefined} strokeLinecap={line === 'dotted' ? 'round' : undefined} markerEnd="url(#architecture-arrow)" markerStart={bidirectional ? 'url(#architecture-arrow)' : undefined} />
    {labelBox !== null && label && <g transform={`translate(${labelBox.x + labelBox.width / 2}, ${labelBox.y + labelBox.height / 2})`}>
      <rect x={-labelBox.width / 2} y={-labelBox.height / 2} width={labelBox.width} height={labelBox.height} rx={4} />
      <text textAnchor="middle" dominantBaseline="central" className="text-xs">{label}</text>
    </g>}
  </g>
}
