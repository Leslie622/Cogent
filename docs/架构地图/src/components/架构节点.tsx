/** 节点与关系渲染：使用自包含轻组件与 SVG 图标，支持状态过滤与连线契约点选。 */
import { useEffect, useRef } from 'react'
import { Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import type { ArchitectureEdge, ArchitectureNode } from '../网格布局'
import { moduleDetails } from '../模块说明'
import { ArrowUpRightIcon } from './图标'
import { ImplementationBadge } from './实现标记'
import { FeatureList } from './能力明细'
import { Button, Card, CardHeader, CardTitle } from './UI'

function useReturnFocus(onReturnFocus: (() => void) | undefined) {
  const button = useRef<HTMLButtonElement>(null)
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
  const { icon: Icon, features, showStatus, navigateOnClick, runtimeOwner, cardPoints } = moduleDetails[id]
  const button = useReturnFocus(data.onReturnFocus)
  return (
    <div
      className="architecture-node"
      data-selected={selected}
      data-status={data.status}
      data-tone={data.tone}
      data-dimmed={data.dimmed}
      data-highlighted={data.highlighted}
    >
      <Handle type="target" position={Position.Left} />
      <Card size="sm" className="h-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <CardTitle>
              <Button ref={button} variant="link" size="default" aria-label={`查看${data.title}`}>
                {data.title}
                {navigateOnClick === true && <ArrowUpRightIcon className="size-3 shrink-0" />}
              </Button>
            </CardTitle>
          </div>
          {features !== undefined ? (
            <FeatureList items={features} />
          ) : cardPoints !== undefined && cardPoints.length > 0 ? (
            <>
              <ul className="pointer-events-none mt-0.5 space-y-1 text-xs leading-snug text-muted-foreground">
                {cardPoints.map((point) => (
                  <li key={point} className="flex items-start gap-1.5">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden="true" />
                    <span className="truncate">{point}</span>
                  </li>
                ))}
              </ul>
              <div className="pointer-events-none mt-1 flex h-5 items-center gap-1.5">
                {showStatus !== false && <ImplementationBadge status={data.status} />}
                {runtimeOwner !== undefined && (
                  <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {runtimeOwner}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="pointer-events-none truncate text-xs text-muted-foreground">
                {data.technology}
              </p>
              <div className="pointer-events-none flex h-5 items-center gap-1.5">
                {showStatus !== false && <ImplementationBadge status={data.status} />}
                {runtimeOwner !== undefined && (
                  <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {runtimeOwner}
                  </span>
                )}
              </div>
            </>
          )}
        </CardHeader>
      </Card>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export function BoundaryNode({ id, data }: NodeProps<ArchitectureNode>) {
  const { icon: Icon } = moduleDetails[id]
  const button = useReturnFocus(data.onReturnFocus)
  return (
    <div className="architecture-boundary" data-tone={data.tone} data-dimmed={data.dimmed}>
      <Handle type="target" position={Position.Left} />
      <div className="architecture-boundary-heading">
        <Icon className="size-4 shrink-0" />
        <Button ref={button} variant="ghost" size="sm" aria-label={`查看${data.title}`}>
          {data.title}
        </Button>
        <span className="text-xs text-muted-foreground">{data.technology}</span>
      </div>
      {data.stages.map((stage) => (
        <span key={stage.label} className="architecture-stage text-xs" style={{ left: stage.x, width: stage.width }}>
          {stage.label}
        </span>
      ))}
      {data.boundaryNote !== undefined && (
        <p className="architecture-boundary-note text-xs text-muted-foreground">{data.boundaryNote}</p>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export function RelationshipEdge({ id, data, label, selected }: EdgeProps<ArchitectureEdge>) {
  const { path, labelBox, crossings, bidirectional, planned, dimmed, highlighted, line, kind, head, tail } = data!
  return (
    <g
      className="architecture-relationship"
      data-planned={planned}
      data-bidirectional={bidirectional}
      data-line={line}
      data-kind={kind}
      data-dimmed={dimmed}
      data-highlighted={highlighted}
      data-selected={selected}
    >
      {crossings.map((point) => (
        <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r={4} fill="var(--background)" data-crossing="true" />
      ))}
      {/* 透明宽点击热区，方便直接点击连线查看边界契约。 */}
      <path d={path} fill="none" stroke="transparent" strokeWidth="22" pointerEvents="stroke" className="react-flow__edge-interaction" />
      {selected === true && (
        <path
          d={path}
          fill="none"
          pointerEvents="none"
          stroke="color-mix(in srgb, var(--ring) 26%, transparent)"
          strokeWidth="6"
        />
      )}
      <path
        id={id}
        d={path}
        fill="none"
        pointerEvents="none"
        stroke={selected === true ? 'var(--foreground)' : highlighted ? '#d97706' : 'currentColor'}
        strokeWidth={selected === true ? '2.25' : '1.5'}
        strokeDasharray={line === 'dotted' ? '1 5' : line === 'dashed' ? '5 4' : undefined}
        strokeLinecap={line === 'dotted' ? 'round' : undefined}
        markerEnd={head === 'none' ? undefined : `url(#architecture-arrow-${head ?? 'normal'})`}
        markerStart={tail === undefined || tail === 'none' ? undefined : `url(#architecture-arrow-${tail})`}
      />
      {labelBox !== null && label && (
        <g pointerEvents="all" transform={`translate(${labelBox.x + labelBox.width / 2}, ${labelBox.y + labelBox.height / 2})`}>
          <rect
            x={-labelBox.width / 2}
            y={-labelBox.height / 2}
            width={labelBox.width}
            height={labelBox.height}
            rx={4}
            stroke={selected === true ? 'var(--ring)' : 'none'}
            strokeWidth={selected === true ? 1 : 0}
          />
          {planned && (
            <g role="img" aria-label="未实现关系" className="text-orange-600 dark:text-orange-400">
              <circle cx={-labelBox.width / 2 + 7} cy={0} r={2.5} fill="currentColor" />
            </g>
          )}
          <text x={planned ? 8 : 0} textAnchor="middle" dominantBaseline="central" className="text-xs">
            {label}
          </text>
        </g>
      )}
    </g>
  )
}
