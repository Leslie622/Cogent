/** 全局文件工作面保留每个文件的内容父树；当前scope只显示一份导航与工具行。 */
import { Fragment, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { File, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { projectFileRoots, type FileViewRoot } from '@shared/file-views'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { FilePanel, FileToolbar } from '@/features/home/files/FilePanel'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useProjectStore } from '@/stores/project'
import type { WorkspaceTab } from '@/stores/workspace'
import { FileNavigator, type FileNavigatorProps } from './FileNavigator'
import { getFileNavigatorOwner, type NavigatorSnapshot } from './file-navigator-owner'

export type FileWorkspaceTab = Extract<WorkspaceTab, { kind: 'file' | 'files' }>
export interface FileWorkspacePaneProps {
  tabs: FileWorkspaceTab[]
  scopeId: string
  projectId?: string
  sessionId?: string
  grantIds?: string[]
  active: boolean
  activeTabId: string | null
  onContextChange?: FileNavigatorProps['onContextChange']
}

const normalizedPath = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/, '')
const comparedPath = (path: string): string => /^[a-z]:/i.test(path) ? path.toLowerCase() : path
const subscribeEmpty = (): (() => void) => () => undefined
const emptySnapshot = (): null => null

export function fileBreadcrumbs(projectName: string | undefined, roots: FileViewRoot[], path: string, name: string): string[] {
  const normalized = normalizedPath(path), comparison = comparedPath(normalized)
  const root = roots.filter(root => root.kind === 'directory').sort((a, b) => b.path.length - a.path.length).find(root => {
    const prefix = comparedPath(normalizedPath(root.path))
    return comparison === prefix || comparison.startsWith(prefix + '/')
  })
  if (root === undefined) {
    const segments = (normalized || name).split('/').filter(Boolean)
    if (normalized.startsWith('//')) segments[0] = '//' + segments[0]
    else if (normalized.startsWith('/')) segments.unshift('/')
    return segments
  }
  const relative = normalized.slice(normalizedPath(root.path).length + 1)
  return [projectName ?? root.name, ...relative.split('/').filter(Boolean)]
}

export function FileWorkspacePane({ tabs, scopeId, projectId, sessionId, grantIds, active, activeTabId, onContextChange }: FileWorkspacePaneProps) {
  const [treeOpen, setTreeOpen] = useState(true)
  const breadcrumbRef = useRef<HTMLElement>(null)
  const hasScopeFiles = tabs.some(tab => tab.scopeId === scopeId)
  const project = useProjectStore(state => state.projects.find(project => project.id === projectId))
  // 最后逻辑tab关闭会销毁registry中的owner；常驻面板重开时必须读取新owner。
  const owner = hasScopeFiles ? getFileNavigatorOwner({ scopeId, projectId, sessionId, grantIds }) : null
  const snapshot = useSyncExternalStore<NavigatorSnapshot | null>(owner?.subscribe ?? subscribeEmpty, owner?.getSnapshot ?? emptySnapshot)
  const projectName = project?.name
  const selected = tabs.find(tab => tab.id === activeTabId && tab.scopeId === scopeId)
  const file = selected?.kind === 'file' ? selected : undefined
  const preview = useFilePreviewStore(state => file === undefined ? undefined : state.byTab[file.id])
  const descriptor = preview?.descriptor
  const path = descriptor?.delivery?.sourcePath ?? descriptor?.path ?? file?.source.target
  const roots = projectId === undefined ? [] : projectFileRoots(snapshot?.context?.roots ?? [])
  const parts = path === undefined
    ? [projectName ?? roots.find(root => root.kind === 'directory')?.name ?? '文件']
    : fileBreadcrumbs(projectName, roots, path, descriptor?.name ?? file!.title)
  const breadcrumbText = parts.join(' / ')
  useLayoutEffect(() => {
    // 长路径保留各段原宽；切换文件或恢复显示时先让末尾文件名可见。
    if (active) breadcrumbRef.current!.scrollLeft = breadcrumbRef.current!.scrollWidth
  }, [active, activeTabId, breadcrumbText])
  const toggleLabel = treeOpen ? '收起文件树' : '展开文件树'
  const toggle = <Hint tip={toggleLabel}><Button variant="disclosure" size="icon-sm" aria-label={toggleLabel} aria-expanded={treeOpen} onClick={() => setTreeOpen(value => !value)}>{treeOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</Button></Hint>
  const chooseFile = async (): Promise<void> => {
    const targetTabId = activeTabId!
    const context = await owner!.openContext('file')
    if (context !== null) context.selectedPaths.forEach((path, index) => {
      const source = { contextId: context.contextId, refs: [], workspaceScopeId: scopeId }
      if (index === 0) void useFilePreviewStore.getState().navigate(targetTabId, source, path)
      else void useFilePreviewStore.getState().open(source, path)
    })
  }
  const breadcrumb = <Breadcrumb ref={breadcrumbRef} variant="scroll" aria-label="文件位置" className="min-w-0">
    <BreadcrumbList className="w-max flex-nowrap whitespace-nowrap">
      {parts.map((part, index) => <Fragment key={index}>
        {index > 0 && <BreadcrumbSeparator className="shrink-0" />}
        <BreadcrumbItem className="shrink-0">{index === parts.length - 1 ? <Hint tip={<span className="break-all">{path ?? breadcrumbText}</span>}><BreadcrumbPage>{part}</BreadcrumbPage></Hint> : <span>{part}</span>}</BreadcrumbItem>
      </Fragment>)}
    </BreadcrumbList>
  </Breadcrumb>
  return <div data-file-workspace className="flex h-full min-h-0 min-w-0 flex-col" hidden={!active} inert={!active} style={{ display: active ? 'flex' : 'none' }}>
    <FileToolbar key={file === undefined ? 'files' : file.id + ':' + preview?.generation} tabId={file?.id ?? null} active={active} leading={toggle} label={breadcrumb} onChooseFile={owner === null ? undefined : () => void chooseFile()} choosingFile={snapshot?.opening} />
    <div data-file-workspace-body className="flex min-h-0 min-w-0 flex-1">
      <div data-file-sidebar data-file-workspace-sidebar hidden={!treeOpen} inert={!treeOpen} className="w-56 max-w-[45%] shrink-0 border-r" style={{ display: treeOpen ? 'block' : 'none' }}>
        {hasScopeFiles && <FileNavigator key={scopeId} scopeId={scopeId} projectId={projectId} sessionId={sessionId} grantIds={grantIds} active={active} title={projectName} selectedPath={path} onContextChange={onContextChange}
          onOpen={(contextId, path) => { void useFilePreviewStore.getState().navigate(activeTabId!, { contextId, refs: [], workspaceScopeId: scopeId }, path) }} />}
      </div>
      <div data-file-workspace-preview className="min-h-0 min-w-0 flex-1">
        {tabs.map(tab => {
          const visible = active && tab.scopeId === scopeId && tab.id === activeTabId
          return <section key={tab.id} id={'workspace-panel-' + tab.id} role="tabpanel" aria-labelledby={'workspace-tab-' + tab.id} hidden={!visible} inert={!visible} data-workspace-panel={tab.id} data-tab-kind={tab.kind} className="h-full min-h-0 min-w-0" style={{ display: visible ? 'block' : 'none' }}>
            {tab.kind === 'file' ? <FilePanel tabId={tab.id} active={visible} showHeader={false} /> : <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground"><File className="size-6" /><p className="text-sm">选择文件以预览</p></div>}
          </section>
        })}
      </div>
    </div>
  </div>
}
