/* eslint-disable @typescript-eslint/no-unnecessary-condition -- 动态索引可能不存在；未开启 noUncheckedIndexedAccess，仍需运行期边界检查。 */
/** 只拖动标签头。内容节点在另一个稳定的父节点按创建次序呈现。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronsDown, Expand, File, FileDiff, Folder, Globe, LoaderCircle, Minimize2, PanelRightClose, Plus, Search, X } from 'lucide-react'
import { Tabs, TabsItem, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from '@/components/ui/item'
import { Separator } from '@/components/ui/separator'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'
import { closeWorkspaceTab, closeWorkspaceTabs } from './runtime'
import { useFilePreviewStore } from '@/stores/file-preview'

function TabIcon({ tab }: { tab: WorkspaceTab }) {
  const Icon = tab.kind === 'browser' ? Globe : tab.kind === 'files' ? Folder : tab.kind === 'diff' ? FileDiff : File
  return tab.kind === 'browser' && tab.loading ? <LoaderCircle className="size-4 animate-spin" /> : tab.kind === 'browser' && tab.favicon != null && /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd.microsoft.icon);base64,/.test(tab.favicon) ? <img src={tab.favicon} alt="" className="size-4" /> : <Icon className="size-4" />
}

function TabHeader({ tab, active, onError }: { tab: WorkspaceTab; active: boolean; onError: (error: string) => void }) {
  const sortable = useSortable({ id: tab.id })
  const { role: _dragRole, tabIndex: _dragTabIndex, 'aria-pressed': _dragPressed, ...dragAttributes } = sortable.attributes
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!active) return
    const reveal = () => ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    reveal()
    const list = ref.current?.closest('[role=tablist]')
    const observer = new ResizeObserver(reveal)
    if (list !== null && list !== undefined) observer.observe(list)
    return () => observer.disconnect()
  }, [active])
  const close = (id: string) => { void closeWorkspaceTab(id).catch(e => onError(String(e))) }
  const closeOthers = (rightOnly: boolean) => {
    const scope = useWorkspaceStore.getState().scopes[tab.scopeId]
    const tabs = rightOnly ? scope.tabs.slice(scope.tabs.findIndex(t => t.id === tab.id) + 1) : scope.tabs.filter(t => t.id !== tab.id)
    void closeWorkspaceTabs(tabs.map(tab => tab.id)).catch(e => onError(String(e)))
  }
  const move = (direction: number) => {
    const tabs = useWorkspaceStore.getState().scopes[tab.scopeId].tabs
    const from = tabs.findIndex(t => t.id === tab.id), to = from + direction
    if (to >= 0 && to < tabs.length) useWorkspaceStore.getState().reorder(tab.scopeId, arrayMove(tabs.map(t => t.id), from, to))
  }
  return <ContextMenu>
    <ContextMenuTrigger render={<TabsItem ref={node => { sortable.setNodeRef(node); ref.current = node }} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} onAuxClick={e => { if (e.button === 1) { e.preventDefault(); close(tab.id) } }} />}>
      <Hint tip={tab.title} side="bottom"><TabsTrigger variant="workspace" value={tab.id} id={'workspace-tab-' + tab.id} aria-controls={'workspace-panel-' + tab.id} ref={sortable.setActivatorNodeRef} {...dragAttributes} {...sortable.listeners}>
        <TabIcon tab={tab} /><span className="truncate">{tab.title}</span>
      </TabsTrigger></Hint>
      <Hint tip="关闭标签页" side="bottom"><Button variant="ghost" size="icon-xs" className="mr-1" aria-label={'关闭 ' + tab.title} onClick={() => close(tab.id)}><X /></Button></Hint>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem onClick={() => move(-1)}>向左移动标签页</ContextMenuItem>
      <ContextMenuItem onClick={() => move(1)}>向右移动标签页</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => close(tab.id)}>关闭标签页</ContextMenuItem>
      <ContextMenuItem onClick={() => closeOthers(false)}>关闭其他标签页</ContextMenuItem>
      <ContextMenuItem onClick={() => closeOthers(true)}>关闭右侧标签页</ContextMenuItem>
      <ContextMenuItem onClick={() => {
        const ids = useWorkspaceStore.getState().scopes[tab.scopeId].tabs.map(t => t.id)
        void closeWorkspaceTabs(ids).catch(e => onError(String(e)))
      }}>关闭全部标签页</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => useWorkspaceStore.getState().newTab()}>新建标签页</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
}
export function WorkspaceTabs({ tabs, activeId, expanded = false, onError }: { tabs: WorkspaceTab[]; activeId: string | null; expanded?: boolean; onError: (error: string) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const [listOpen, setListOpen] = useState(false)
  const [query, setQuery] = useState('')
  const header = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // 关闭同级按钮会移除浏览器焦点；仅接回丢失的焦点，不抢走对话或网页输入。
    if (lastFocus.current === null || lastFocus.current.isConnected || document.activeElement !== document.body) return
    const target = listOpen ? document.querySelector<HTMLElement>('[aria-label="搜索标签页"]') : header.current!.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
    target?.focus({ preventScroll: true })
  }, [tabs, activeId, listOpen])
  const filtered = tabs.filter(tab => tab.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const reopen = () => {
    const tab = useWorkspaceStore.getState().reopen()
    if (tab?.kind === 'file') void useFilePreviewStore.getState().loadTab(tab.id)
    setListOpen(false)
  }
  return <div ref={header} onFocusCapture={event => { lastFocus.current = event.target }} data-workspace-header className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2">
    <Popover open={listOpen} onOpenChange={open => { setListOpen(open); if (open) setQuery('') }}>
      <Hint tip="标签页列表" side="bottom"><PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="标签页列表" />}><ChevronsDown /></PopoverTrigger></Hint>
      <PopoverContent align="start" initialFocus={false} className="w-80 max-w-[calc(100vw-1rem)]">
        <InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput aria-label="搜索标签页" placeholder="搜索标签页…" value={query} onChange={event => setQuery(event.target.value)} /></InputGroup>
        <p className="text-xs text-muted-foreground">打开的标签页</p>
        <ItemGroup className="max-h-72 overflow-y-auto">
          {filtered.map(tab => <Item size="xs" variant={tab.id === activeId ? 'muted' : 'default'} className="relative" key={tab.id}>
            <Button variant="ghost" className="absolute inset-0 h-full w-full" aria-label={tab.title} aria-current={tab.id === activeId ? 'page' : undefined} onClick={() => { useWorkspaceStore.getState().activate(tab.id); setListOpen(false) }} />
            <ItemMedia variant="icon" className="pointer-events-none relative"><TabIcon tab={tab} /></ItemMedia>
            <ItemContent className="pointer-events-none relative min-w-0"><span className="truncate">{tab.title}</span></ItemContent>
            <ItemActions className="relative"><Hint tip="关闭标签页"><Button variant="ghost" size="icon-xs" aria-label={'在列表中关闭 ' + tab.title} onClick={() => { void closeWorkspaceTab(tab.id).catch(error => onError(String(error))) }}><X /></Button></Hint></ItemActions>
          </Item>)}
          {filtered.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">没有匹配的标签页</p>}
        </ItemGroup>
        <Separator />
        <Button variant="ghost" className="justify-start" onClick={reopen}>重新打开关闭的标签页</Button>
        <Button variant="ghost" className="justify-start" onClick={() => { setListOpen(false); void closeWorkspaceTabs(tabs.map(tab => tab.id)).catch(error => onError(String(error))) }}>关闭全部标签页</Button>
      </PopoverContent>
    </Popover>
    <Tabs value={activeId} onValueChange={value => { if (typeof value === 'string') useWorkspaceStore.getState().activate(value) }} className="min-w-0 shrink">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
        if (over === null || active.id === over.id) return
        const ids = tabs.map(t => t.id)
        useWorkspaceStore.getState().reorder(tabs[0].scopeId, arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
      }}>
        <SortableContext items={tabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
          <TabsList variant="workspace" aria-label="工作区标签页" onWheel={event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY }}>
            {tabs.map(tab => <TabHeader key={tab.id} tab={tab} active={tab.id === activeId} onError={onError} />)}
          </TabsList>
        </SortableContext>
      </DndContext>
    </Tabs>
    <Hint tip="新建标签页（Ctrl+T）" side="bottom"><Button variant="ghost" size="icon-sm" aria-label="新建标签页" onClick={() => useWorkspaceStore.getState().newTab()}><Plus /></Button></Hint>
    <div className="min-w-0 flex-1" />
    <Hint tip={expanded ? '恢复并排' : '占满内容区'} side="bottom"><Button variant="ghost" size="icon-sm" aria-label={expanded ? '恢复并排' : '展开工作区'} onClick={() => useWorkspaceStore.getState().setLayout({ expanded: !expanded })}>{expanded ? <Minimize2 /> : <Expand />}</Button></Hint>
    <Hint tip="收起工作区" side="bottom"><Button variant="ghost" size="icon-sm" aria-label="收起工作区" onClick={() => useWorkspaceStore.getState().setLayout({ collapsed: true })}><PanelRightClose /></Button></Hint>
  </div>
}
