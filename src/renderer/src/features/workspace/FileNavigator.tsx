/** 文件工作面的导航；数据所有者跨标签保留，视图只承担树与搜索结果的虚拟化。 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type HTMLAttributes, type RefAttributes } from 'react'
import { useTree } from '@headless-tree/react'
import {
  buildProxiedInstance, hotkeysCoreFeature, propMemoizationFeature, syncDataLoaderFeature,
  type ItemInstance, type TreeInstance
} from '@headless-tree/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderX, LoaderCircle, RefreshCw, Search, Square, X } from 'lucide-react'
import type { FileViewContext, FileViewEntry } from '@shared/file-views'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Hint } from '@/components/Hint'
import { FileIcon } from '@/components/FileIcon'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project'
import {
  getFileNavigatorOwner, NAVIGATOR_ROOT, sameNavigatorPath,
  type FileNavigatorOwner, type NavigatorItem, type NavigatorSnapshot
} from './file-navigator-owner'

export interface FileNavigatorProps {
  scopeId: string
  projectId?: string
  sessionId?: string
  grantIds?: string[]
  active?: boolean
  title?: string
  selectedPath?: string
  onOpen: (contextId: string, path: string) => void
  onContextChange?: (context: Pick<FileViewContext, 'contextId' | 'grantIds'>) => void
}

function itemLabel(item: NavigatorItem): string {
  return item.type === 'root' ? item.root.name : item.type === 'entry' ? item.entry.name : item.label
}

function itemFolder(item: NavigatorItem): boolean {
  return item.type === 'root' ? item.root.kind === 'directory'
    : item.type === 'entry' && item.entry.kind === 'directory' && item.entry.blockedReason === undefined
}

function itemPath(item: NavigatorItem): string | undefined {
  return item.type === 'root' ? item.root.path : item.type === 'entry' ? item.entry.path : undefined
}

function FileTree({ owner, snapshot, onOpen, selectedPath }: {
  owner: FileNavigatorOwner
  snapshot: NavigatorSnapshot
  onOpen: FileNavigatorProps['onOpen']
  selectedPath?: string
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const scrollToIndex = useRef<(index: number) => void>(() => undefined)
  const activate = (item: NavigatorItem): void => {
    if (item.type === 'control') {
      if (item.action !== 'none') void owner.loadDirectory(item.directoryId, item.action === 'retry')
      return
    }
    if (item.type === 'entry' && item.entry.blockedReason !== undefined) {
      owner.showNotice(item.entry.blockedReason)
      return
    }
    if (!itemFolder(item)) onOpen(snapshot.context!.contextId, itemPath(item)!)
  }
  const tree = useTree<NavigatorItem>({
    rootItemId: NAVIGATOR_ROOT,
    state: { expandedItems: snapshot.expandedItems, focusedItem: snapshot.focusedItem },
    setExpandedItems: owner.setExpandedItems,
    setFocusedItem: owner.setFocusedItem,
    getItemName: (item) => itemLabel(item.getItemData()),
    isItemFolder: (item) => itemFolder(item.getItemData()),
    onPrimaryAction: (item) => activate(item.getItemData()),
    scrollToItem: (item: ItemInstance<NavigatorItem>) => scrollToIndex.current(item.getItemMeta().index),
    dataLoader: { getItem: owner.getItem, getChildren: owner.getChildren },
    instanceBuilder: buildProxiedInstance,
    features: [syncDataLoaderFeature, hotkeysCoreFeature, propMemoizationFeature],
    hotkeys: {
      customOpenFile: { hotkey: 'Enter', handler: (_event, instance: TreeInstance<NavigatorItem>) => instance.getFocusedItem().primaryAction() }
    }
  })
  const items = useMemo(() => {
    // 先使库的扁平视图失效，再读取同一批目录快照；提交后才重建会短暂引用已删除的控制行。
    tree.scheduleRebuildTree()
    return tree.getItems()
  }, [tree, snapshot.nodes, snapshot.directories, snapshot.roots, snapshot.expandedItems])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 32,
    getItemKey: (index) => items[index].getId(),
    overscan: 8,
    initialRect: { width: 280, height: 400 }
  })
  scrollToIndex.current = (index) => virtualizer.scrollToIndex(index, { align: 'auto' })
  const scrolledKey = useRef<string | undefined>(undefined)
  const selectedIndex = useMemo(
    () => (selectedPath === undefined ? -1 : items.findIndex((item) => sameNavigatorPath(itemPath(item.getItemData()), selectedPath))),
    [items, selectedPath]
  )
  useEffect(() => {
    if (selectedPath === undefined) {
      scrolledKey.current = undefined
      return
    }
    if (selectedIndex >= 0 && scrolledKey.current !== selectedPath) {
      scrolledKey.current = selectedPath
      virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
    }
  }, [selectedIndex, selectedPath, virtualizer])
  return (
    <div ref={viewport} className="min-h-0 flex-1 overflow-auto px-2 pb-2" data-testid="file-navigator-tree-scroll">
      <div
        {...tree.getContainerProps('项目文件') as HTMLAttributes<HTMLDivElement>}
        className="relative min-w-full"
        style={{ height: virtualizer.getTotalSize() }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.closest<HTMLElement>('[data-file-navigator]')?.querySelector<HTMLInputElement>('input')?.focus()
        }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          // 虚拟器可在收拢目录的提交帧暂留旧范围，不能把过期下标当成仍存在的文件。
          const item = items.at(row.index)
          if (item === undefined) return null
          const data = item.getItemData()
          // getProps 的 ref 必须在卸载前捕获；被回收的虚拟项不能在 ref(null) 时再次读取元数据。
          const props = item.getProps() as HTMLAttributes<HTMLDivElement> & RefAttributes<HTMLDivElement>
          const folder = itemFolder(data)
          const activeItem = sameNavigatorPath(itemPath(data), selectedPath)
          return (
            <Hint key={item.getId()} tip={<span className="break-all">{itemPath(data) ?? itemLabel(data)}</span>} side="right"><div
              {...props}
              ref={props.ref}
              data-focused={item.isFocused()}
              aria-current={activeItem ? 'page' : undefined}
              className={cn(
                'absolute inset-x-0 flex h-8 min-w-0 cursor-default items-center gap-1.5 rounded-md pr-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[focused=true]:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-accent-foreground',
                data.type === 'control' && 'text-muted-foreground'
              )}
              style={{ transform: `translateY(${row.start}px)`, paddingLeft: `${8 + item.getItemMeta().level * 14}px` }}
            >
              {folder ? item.isExpanded() ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" /> : <span className="size-3.5 shrink-0" />}
              {data.type === 'control'
                ? snapshot.directories.get(data.directoryId)!.status === 'loading' && <LoaderCircle className="size-4 shrink-0 animate-spin" />
                : folder ? <Folder className="size-4 shrink-0" /> : <FileIcon path={itemPath(data)!} />}
              <span className="min-w-0 truncate">{itemLabel(data)}</span>
              {data.type === 'entry' && data.entry.symlink && <span aria-label="符号链接" className="shrink-0 text-xs text-muted-foreground">↗</span>}
            </div></Hint>
          )
        })}
      </div>
    </div>
  )
}

function SearchResults({ owner, snapshot, onOpen }: {
  owner: FileNavigatorOwner
  snapshot: NavigatorSnapshot
  onOpen: FileNavigatorProps['onOpen']
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const search = snapshot.search
  const virtualizer = useVirtualizer({
    count: search.entries.length, getScrollElement: () => viewport.current,
    estimateSize: () => 52, overscan: 6, initialRect: { width: 280, height: 400 }
  })
  const openEntry = (entry: FileViewEntry): void => {
    if (entry.blockedReason !== undefined) owner.showNotice(entry.blockedReason)
    else if (entry.kind === 'file') onOpen(snapshot.context!.contextId, entry.path)
  }
  return (
    <>
      <div role="status" className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span>{search.status === 'loading' ? '正在搜索…' : `已扫描 ${search.scanned.toLocaleString()} 项 · 第 ${search.pageIndex + 1} 页`}</span>
        {search.status === 'loading' && <Button size="icon-xs" variant="ghost" aria-label="取消搜索" onClick={owner.cancelSearch}><Square /></Button>}
      </div>
      {search.error !== null && <div role="alert" className="px-2 py-2 text-sm">{search.error}<Button size="xs" variant="ghost" onClick={() => void owner.retrySearch()}>重试搜索</Button></div>}
      {search.warnings.map((warning) => <p key={warning} className="px-2 py-1 text-xs text-muted-foreground">{warning}</p>)}
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto" role="list" aria-label="文件搜索结果">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const entry = search.entries.at(row.index)
            if (entry === undefined) return null
            return <div key={entry.id} role="listitem" className="absolute inset-x-0 px-2" style={{ transform: `translateY(${row.start}px)` }}>
              <Hint tip={<span className="break-all">{entry.path}</span>} side="right"><Button variant="ghost" className="w-full justify-start" onClick={() => openEntry(entry)}>
                {entry.kind === 'directory' ? <Folder /> : <FileIcon path={entry.path} />}
                <span className="flex min-w-0 flex-1 flex-col items-start"><span className="max-w-full truncate">{entry.name}</span><span className="max-w-full truncate text-xs text-muted-foreground">{entry.relativePath}</span></span>
              </Button></Hint>
            </div>
          })}
        </div>
        {search.status === 'ready' && search.entries.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">{search.complete ? '没有匹配文件' : '当前已扫描范围内尚无匹配文件'}</p>}
      </div>
      {(search.pageIndex > 0 || search.nextCursor !== undefined) && <div className="flex items-center justify-between gap-2 px-2 py-1">
        <Button variant="ghost" size="sm" disabled={search.pageIndex === 0 || search.status === 'loading'} onClick={() => void owner.previousSearchPage()}>上一页</Button>
        <Button variant="ghost" size="sm" disabled={search.nextCursor === undefined || search.status === 'loading'} onClick={() => void owner.search(true)}>{search.paused ? '继续搜索' : '下一页'}</Button>
      </div>}
      {search.truncated && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">结果超出预算，请缩小搜索范围。</p>}
      {search.paused && search.nextCursor === undefined && !search.truncated && <Button variant="ghost" size="sm" onClick={() => void owner.search()}>重新搜索</Button>}
    </>
  )
}

export function FileNavigator({ scopeId, projectId, sessionId, grantIds, active = true, title, selectedPath, onOpen, onContextChange }: FileNavigatorProps) {
  const rootsKey = useProjectStore(state => JSON.stringify(state.projects.find(project => project.id === projectId)?.cwds))
  const owner = useMemo(() => getFileNavigatorOwner({ scopeId, projectId, sessionId, grantIds }), [scopeId, projectId, sessionId, grantIds, rootsKey])
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  const contextCallback = useRef(onContextChange)
  contextCallback.current = onContextChange
  useEffect(() => { void owner.initialize() }, [owner])
  const revealedTarget = useRef<string>('')
  useEffect(() => {
    if (!active || selectedPath === undefined || snapshot.context === null || snapshot.roots.length === 0 || snapshot.query.trim() !== '') return
    const key = `${snapshot.context.contextId}:${selectedPath}`
    if (revealedTarget.current === key) return
    revealedTarget.current = key
    void owner.revealPath(selectedPath)
  }, [active, owner, selectedPath, snapshot.context, snapshot.query, snapshot.roots.length])
  useEffect(() => {
    if (snapshot.context !== null) contextCallback.current?.({ contextId: snapshot.context.contextId, grantIds: snapshot.context.grantIds })
  }, [snapshot.context])
  useEffect(() => { if (!active) owner.cancelSearch() }, [owner, active])
  useEffect(() => window.cogent.onEngineEvent((event) => {
    if (event.method === 'fileViews.directoryChanged') owner.directoryChanged(event.params, active)
  }), [owner, active])
  const navigationRoots = snapshot.roots.map(id => snapshot.nodes.get(id)!).filter((item): item is Extract<NavigatorItem, { type: 'root' }> => item.type === 'root')
  const rootLabel = title?.trim() || (navigationRoots.length === 0 ? '文件' : navigationRoots[0].root.name)
  const rootHint = navigationRoots.map(item => item.root.path).join('\n') || rootLabel
  return (
    <section data-file-navigator="" className="flex h-full min-h-0 min-w-0 flex-col" aria-label="文件导航">
      <div className="flex items-center gap-1 p-2">
        <InputGroup>
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label="搜索项目文件" placeholder="搜索文件名或路径…" disabled={snapshot.roots.length === 0} value={snapshot.query} onChange={(event) => owner.setQuery(event.target.value)} />
          {snapshot.query !== '' && <InputGroupAddon align="inline-end"><Hint tip="清除文件搜索"><InputGroupButton size="icon-xs" aria-label="清除文件搜索" onClick={() => owner.setQuery('')}><X /></InputGroupButton></Hint></InputGroupAddon>}
        </InputGroup>
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <div className="min-w-0 flex-1"><Hint tip={<span className="whitespace-pre-wrap break-all">{rootHint}</span>}><span className="inline-block max-w-full truncate align-middle text-xs text-muted-foreground" data-file-root-label>{rootLabel}</span></Hint></div>
        {snapshot.roots.length > 0 && <Hint tip="刷新文件"><Button variant="ghost" size="icon-xs" aria-label="刷新文件" disabled={snapshot.opening} onClick={() => void owner.refresh()}><RefreshCw /></Button></Hint>}
      </div>
      {snapshot.query.trim() !== '' && <label className="flex items-center gap-1.5 px-2 pb-2 text-xs"><Checkbox checked={snapshot.includeIgnored} onCheckedChange={owner.setIncludeIgnored} />包含忽略项</label>}
      {snapshot.notice !== null && <div role="status" className="px-2 py-2 text-xs text-muted-foreground">{snapshot.notice}</div>}
      {snapshot.error !== null ? (
        <Empty role="alert" className="p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FolderX aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="break-words">{snapshot.error}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="xs" onClick={() => void owner.openContext()}>重试</Button>
          </EmptyContent>
        </Empty>
      ) : snapshot.opening && snapshot.context === null ? (
        <div role="status" className="flex flex-1 items-center justify-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在打开文件导航…</div>
      ) : snapshot.context !== null && snapshot.roots.length === 0 ? (
        <Empty className="p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FolderOpen aria-hidden="true" /></EmptyMedia>
            <EmptyDescription>当前目录为空</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : snapshot.query.trim() !== '' ? (
        <SearchResults owner={owner} snapshot={snapshot} onOpen={onOpen} />
      ) : (
        <FileTree owner={owner} snapshot={snapshot} onOpen={onOpen} selectedPath={selectedPath} />
      )}
    </section>
  )
}

export { releaseFileNavigatorScope, invalidateFileNavigators, bindFileNavigatorScope } from './file-navigator-owner'
