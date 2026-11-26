/** 右栏阅读面板：区分视图概览与模块详情，支持连线契约、流程直达与点击来源直接复制路径。 */
import { useState, type Ref } from 'react'
import { viewNames, type ViewId } from '../视图'
import type { EdgeDetail, ModuleDetail, PeerComparison, SourceRef } from '../模块说明'
import {
  ArrowDownRightIcon,
  CheckIcon,
  Code2Icon,
  CopyIcon,
  ListChecksIcon,
  PanelRightCloseIcon,
  RouteIcon,
  WorkflowIcon,
} from './图标'
import { ImplementationBadge } from './实现标记'
import { FeatureList } from './能力明细'
import { Button, IconButton, Separator } from './UI'

const sourceGroups = ['实现', '模块与架构', '验收', '目标与计划'] as const

function sourceGroup(path: string): (typeof sourceGroups)[number] {
  if (path.startsWith('docs/计划/')) return '目标与计划'
  if (path.startsWith('tests/') || path.startsWith('docs/测试用例/')) return '验收'
  if (path.startsWith('docs/')) return '模块与架构'
  return '实现'
}

export function ModulePanel({
  detail,
  edgeDetail,
  isViewOverview,
  headingRef,
  onClose,
  onNavigate,
}: {
  detail: ModuleDetail
  edgeDetail: EdgeDetail | null
  isViewOverview: boolean
  headingRef: Ref<HTMLHeadingElement>
  onClose: () => void
  onNavigate: (id: ViewId) => void
}) {
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  function copyPath(path: string) {
    if (typeof navigator !== 'undefined' && 'clipboard' in navigator) {
      void navigator.clipboard.writeText(path).then(() => {
        setCopiedPath(path)
        window.setTimeout(() => setCopiedPath((current) => (current === path ? null : current)), 1500)
      })
    }
  }

  if (edgeDetail !== null) {
    return (
      <aside className="module-panel select-text" aria-label="架构说明">
        <header className="side-header">
          <div className="flex min-w-0 items-center gap-2">
            <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
            <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold">{edgeDetail.title}</h2>
          </div>
          <IconButton label="折叠右侧栏" aria-expanded aria-controls="architecture-description" onClick={onClose}>
            <PanelRightCloseIcon />
          </IconButton>
        </header>
        <div key={edgeDetail.title} className="module-panel-content" aria-live="polite">
          <p className="text-sm font-medium text-muted-foreground">{edgeDetail.kind}</p>
          <p className="mt-3 text-sm leading-relaxed text-foreground/90">{edgeDetail.contract}</p>
          <Separator className="my-5" />
          <h3 className="text-xs font-medium text-muted-foreground">边界规则</h3>
          <ol className="mt-2.5 space-y-2.5 text-sm">
            {edgeDetail.rules.map((rule) => (
              <li key={rule} className="leading-relaxed text-foreground/90">{rule}</li>
            ))}
          </ol>
          {edgeDetail.sources.length > 0 && (
            <>
              <Separator className="my-5" />
              <SourceList sources={edgeDetail.sources} copiedPath={copiedPath} onCopy={copyPath} />
            </>
          )}
        </div>
      </aside>
    )
  }

  const Icon = detail.icon
  return (
    <aside className="module-panel select-text" aria-label="架构说明">
      <header className="side-header">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold">{detail.name}</h2>
        </div>
        <IconButton label="折叠右侧栏" aria-expanded aria-controls="architecture-description" onClick={onClose}>
          <PanelRightCloseIcon />
        </IconButton>
      </header>
      <div key={detail.name} className="module-panel-content" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          {detail.features !== undefined ? (
            <FeatureList items={detail.features} />
          ) : (
            detail.showStatus !== false && <ImplementationBadge status={detail.status} />
          )}
          {detail.runtimeOwner !== undefined && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
              {detail.runtimeOwner}
            </span>
          )}
          {detail.verifiedAt !== undefined && (
            <span className="text-xs text-muted-foreground">核验 {detail.verifiedAt}</span>
          )}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-foreground/90">{detail.summary}</p>

        {(detail.navigateTo !== undefined || (detail.relatedFlows !== undefined && detail.relatedFlows.length > 0)) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {detail.navigateTo !== undefined && (
              <Button variant="outline" size="sm" onClick={() => onNavigate(detail.navigateTo!)}>
                <ArrowDownRightIcon className="size-3.5" />
                下钻{viewNames[detail.navigateTo]}
              </Button>
            )}
            {detail.relatedFlows?.map((flowId) => (
              <Button key={flowId} variant="outline" size="sm" onClick={() => onNavigate(flowId)}>
                <WorkflowIcon className="size-3.5" />
                {viewNames[flowId]}
              </Button>
            ))}
          </div>
        )}

        <ModuleTabs
          key={`${isViewOverview ? 'view' : 'node'}:${detail.name}`}
          detail={detail}
          isViewOverview={isViewOverview}
          copiedPath={copiedPath}
          onCopy={copyPath}
        />
      </div>
    </aside>
  )
}

function ModuleTabs({
  detail,
  isViewOverview,
  copiedPath,
  onCopy,
}: {
  detail: ModuleDetail
  isViewOverview: boolean
  copiedPath: string | null
  onCopy: (path: string) => void
}) {
  const hasComparisons = detail.comparisons !== undefined && detail.comparisons.length > 0
  const [section, setSection] = useState<'overview' | 'compare' | 'sources'>('overview')
  return (
    <>
      <div className="mt-5 flex gap-1 border-b border-border pb-2" role="tablist" aria-label="说明页签">
        <Button
          role="tab"
          aria-selected={section === 'overview'}
          variant={section === 'overview' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setSection('overview')}
        >
          <ListChecksIcon className="size-3.5" />
          {isViewOverview ? '要点' : '职责'}
        </Button>
        {hasComparisons && (
          <Button
            role="tab"
            aria-selected={section === 'compare'}
            variant={section === 'compare' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setSection('compare')}
          >
            <WorkflowIcon className="size-3.5" />
            开源对照
          </Button>
        )}
        <Button
          role="tab"
          aria-selected={section === 'sources'}
          variant={section === 'sources' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setSection('sources')}
        >
          <Code2Icon className="size-3.5" />
          源码
        </Button>
      </div>

      {section === 'overview' ? (
        <div className="mt-4 space-y-4">
          <div className="boundary-callout">
            <h3 className="text-xs font-medium text-muted-foreground">{isViewOverview ? '核心边界' : '技术边界'}</h3>
            <p className="mt-1.5 text-sm leading-relaxed">{detail.boundary}</p>
          </div>
          <section>
            <h3 className="text-xs font-medium text-muted-foreground">{isViewOverview ? '关键规则' : '核心职责'}</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {detail.responsibilities.map((item) => (
                <li key={item} className="leading-relaxed text-foreground/90">{item}</li>
              ))}
            </ul>
          </section>
        </div>
      ) : section === 'compare' && detail.comparisons !== undefined ? (
        <div className="mt-4">
          <PeerComparisonList items={detail.comparisons} />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {detail.codeKind !== undefined && (
            <p className="rounded bg-muted/60 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground/80">
              {detail.codeKind}
            </p>
          )}
          <GroupedSources sources={detail.sources} copiedPath={copiedPath} onCopy={onCopy} />
        </div>
      )}
    </>
  )
}

function PeerComparisonList({ items }: { items: readonly PeerComparison[] }) {
  return (
    <div className="space-y-3.5">
      {items.map((item) => (
        <article key={item.repo} className="overflow-hidden rounded-lg border border-border bg-card text-sm">
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3.5 py-2">
            <span className="font-mono text-sm font-semibold text-foreground">{item.repo}</span>
            <span className="text-xs text-muted-foreground">开源实读对照</span>
          </div>
          <div className="divide-y divide-border/70">
            <div className="px-3.5 py-2.5">
              <div className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                对方做法
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-foreground">{item.approach}</p>
            </div>
            <div className="bg-muted/25 px-3.5 py-2.5">
              <div className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-xs font-semibold text-foreground">
                Cogent 取舍
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-foreground">{item.diff}</p>
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}

function GroupedSources({
  sources,
  copiedPath,
  onCopy,
}: {
  sources: readonly SourceRef[]
  copiedPath: string | null
  onCopy: (path: string) => void
}) {
  return (
    <div className="space-y-4">
      {sourceGroups.map((group) => {
        const groupSources = sources.filter((source) => sourceGroup(source.path) === group)
        if (groupSources.length === 0) return null
        return (
          <section key={group}>
            <h4 className="text-xs font-medium text-muted-foreground">{group}</h4>
            <div className="mt-2">
              <SourceList sources={groupSources} copiedPath={copiedPath} onCopy={onCopy} />
            </div>
          </section>
        )
      })}
    </div>
  )
}

function SourceList({
  sources,
  copiedPath,
  onCopy,
}: {
  sources: readonly SourceRef[]
  copiedPath: string | null
  onCopy: (path: string) => void
}) {
  return (
    <ul className="space-y-2">
      {sources.map((source) => {
        const copied = copiedPath === source.path
        return (
          <li key={source.path}>
            <button
              type="button"
              aria-label={`复制路径 ${source.path}`}
              className="source-item-button"
              onClick={() => onCopy(source.path)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{source.symbol}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {copied ? (
                    <>
                      <CheckIcon className="size-3.5 text-green-600 dark:text-green-500" />
                      <span className="text-green-700 dark:text-green-400">已复制</span>
                    </>
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                </span>
              </div>
              <code className="mt-1 block break-all text-sm leading-relaxed text-foreground">{source.path}</code>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
