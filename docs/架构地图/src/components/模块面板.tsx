/** 右栏阅读面板：区分视图概览与模块详情，支持连线契约、流程直达与点击来源直接复制路径。 */
import { useState, type Ref } from 'react'
import { viewNames, type ViewId } from '../视图'
import type { EdgeDetail, ModuleDetail, SourceRef } from '../模块说明'
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
            <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-medium">{edgeDetail.title}</h2>
          </div>
          <IconButton label="折叠右侧栏" aria-expanded aria-controls="architecture-description" onClick={onClose}>
            <PanelRightCloseIcon />
          </IconButton>
        </header>
        <div key={edgeDetail.title} className="module-panel-content" aria-live="polite">
          <p className="text-xs text-muted-foreground">{edgeDetail.kind}</p>
          <p className="mt-4 leading-relaxed">{edgeDetail.contract}</p>
          <Separator className="my-5" />
          <h3 className="text-xs font-medium text-muted-foreground">边界规则</h3>
          <ol className="mt-3 space-y-3 text-sm">
            {edgeDetail.rules.map((rule) => (
              <li key={rule} className="leading-relaxed">{rule}</li>
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
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-medium">{detail.name}</h2>
        </div>
        <IconButton label="折叠右侧栏" aria-expanded aria-controls="architecture-description" onClick={onClose}>
          <PanelRightCloseIcon />
        </IconButton>
      </header>
      <div key={detail.name} className="module-panel-content" aria-live="polite">
        <div className="flex flex-col items-start gap-2">
          {detail.features !== undefined ? (
            <FeatureList items={detail.features} />
          ) : (
            detail.showStatus !== false && <ImplementationBadge status={detail.status} />
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{detail.kind}</span>
            {detail.verifiedAt !== undefined && <span>· 核验 {detail.verifiedAt}</span>}
          </div>
        </div>
        <p className="mt-4 leading-relaxed">{detail.summary}</p>

        {(detail.navigateTo !== undefined || (detail.relatedFlows !== undefined && detail.relatedFlows.length > 0)) && (
          <div className="mt-4 flex flex-wrap gap-2">
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

        {isViewOverview ? (
          <div className="mt-5 space-y-5">
            <div className="boundary-callout">
              <h3 className="text-xs font-medium text-muted-foreground">核心边界</h3>
              <p className="mt-1.5 text-sm leading-relaxed">{detail.boundary}</p>
            </div>
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">视图要点</h3>
              <ol className="mt-2.5 space-y-2.5">
                {detail.responsibilities.map((item) => (
                  <li key={item} className="leading-relaxed">{item}</li>
                ))}
              </ol>
            </section>
            <Separator />
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground">文档与源码依据</h3>
              <GroupedSources sources={detail.sources} copiedPath={copiedPath} onCopy={copyPath} />
            </section>
          </div>
        ) : (
          <ModuleTabs key={detail.name} detail={detail} copiedPath={copiedPath} onCopy={copyPath} />
        )}
      </div>
    </aside>
  )
}

function ModuleTabs({
  detail,
  copiedPath,
  onCopy,
}: {
  detail: ModuleDetail
  copiedPath: string | null
  onCopy: (path: string) => void
}) {
  const [section, setSection] = useState<'responsibilities' | 'sources'>('responsibilities')
  return (
    <>
      <div className="mt-6 flex gap-1 border-b border-border pb-2" role="tablist" aria-label="说明页签">
        <Button
          role="tab"
          aria-selected={section === 'responsibilities'}
          variant={section === 'responsibilities' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setSection('responsibilities')}
        >
          <ListChecksIcon className="size-3.5" />
          职责与边界
        </Button>
        <Button
          role="tab"
          aria-selected={section === 'sources'}
          variant={section === 'sources' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setSection('sources')}
        >
          <Code2Icon className="size-3.5" />
          来源
        </Button>
      </div>

      {section === 'responsibilities' ? (
        <div className="mt-4 space-y-4">
          <div className="boundary-callout">
            <h3 className="text-xs font-medium text-muted-foreground">技术边界</h3>
            <p className="mt-1.5 text-sm leading-relaxed">{detail.boundary}</p>
          </div>
          <section>
            <h3 className="text-xs font-medium text-muted-foreground">核心职责</h3>
            <ol className="mt-2.5 space-y-2.5">
              {detail.responsibilities.map((item) => (
                <li key={item} className="leading-relaxed">{item}</li>
              ))}
            </ol>
          </section>
        </div>
      ) : (
        <div className="mt-4">
          <GroupedSources sources={detail.sources} copiedPath={copiedPath} onCopy={onCopy} />
        </div>
      )}
    </>
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
                <span className="text-xs text-muted-foreground">{source.symbol}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  {copied ? (
                    <>
                      <CheckIcon className="size-3 text-green-600 dark:text-green-500" />
                      <span className="text-green-700 dark:text-green-400">已复制</span>
                    </>
                  ) : (
                    <CopyIcon className="size-3" />
                  )}
                </span>
              </div>
              <code className="mt-1 block break-all text-xs leading-relaxed text-foreground">{source.path}</code>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
