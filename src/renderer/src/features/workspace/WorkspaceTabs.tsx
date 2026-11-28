/** 只拖动标签头。内容节点在另一个稳定的父节点按创建次序呈现。
 *  标签头本身由 WorkspaceSurface portal 进应用头部的标签页区块（AppHeader 右块），与面板同一
 *  宽度、同一开合；头部是窗口拖拽区，这里的按钮沿用外壳面的悬停柔光并标 no-drag。 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronsDown, Expand, File, FileDiff, Folder, Globe, LoaderCircle, Minimize2, PanelRightClose, Plus, Search, X } from 'lucide-react'
import { Tabs, TabsItem, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { useHoverSlide } from '@/hooks/use-hover-slide'
import { Hint } from '@/components/Hint'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from '@/components/ui/item'
import { Separator } from '@/components/ui/separator'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'
import { closeWorkspaceTab, closeWorkspaceTabs } from './runtime'
import { useFilePreviewStore } from '@/stores/file-preview'
import { CHROME_HOVER, NO_DRAG } from '@/features/shell/chrome'

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
    // 只滚标签条；scrollIntoView 会连同 overflow-hidden 的头部祖先一起滚动，
    // 在分栏过渡中把整条应用头和内容挤偏，导致新页看起来插到了错误位置。
    const reveal = () => {
      const item = ref.current
      const list = item?.closest<HTMLElement>('[role=tablist]')
      if (item == null || list == null) return
      const viewport = list.getBoundingClientRect(), tab = item.getBoundingClientRect()
      if (tab.left < viewport.left) list.scrollLeft += tab.left - viewport.left
      else if (tab.right > viewport.right) list.scrollLeft += tab.right - viewport.right
    }
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
  // 活动标签不是滑动行：它的底色靠 :has([data-active]) 落在整项上，克隆副本没有子节点读不出这层底色，
  // 会被误判成"悬停改底色"而把胶囊滑上去（2026-11-28 探针实录）。注释写在 return 之前：
  // JSX 子节点位置的 /* */ 不是注释而是文本，会被渲染进标签条（2026-11-28 用户截图实录）
  // max-w-full：标签头在应用头部里要给行右端的窗口三钮让位，并排面板窄时标签条比一枚标签（w-44）还窄 ——
  // 标签随标签条收窄（标题先截断），关闭钮留在可视区；标签条不窄时仍是原宽
  return <ContextMenu>
    <ContextMenuTrigger render={<TabsItem className="max-w-full" data-hover-slide={active ? undefined : ''} ref={node => { sortable.setNodeRef(node); ref.current = node }} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} onAuxClick={e => { if (e.button === 1) { e.preventDefault(); close(tab.id) } }} />}>
      <Hint tip={tab.title} side="bottom"><TabsTrigger variant="workspace" value={tab.id} id={'workspace-tab-' + tab.id} aria-controls={'workspace-panel-' + tab.id} ref={sortable.setActivatorNodeRef} {...dragAttributes} {...sortable.listeners}>
        <TabIcon tab={tab} /><span className="truncate">{tab.title}</span>
      </TabsTrigger></Hint>
      <Hint tip="关闭标签页" side="bottom"><Button variant="ghost" size="icon-xs" className={cn('mr-1', CHROME_HOVER)} aria-label={'关闭 ' + tab.title} onClick={() => close(tab.id)}><X /></Button></Hint>
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
export function WorkspaceTabs({ tabs, activeId, expanded = false, tools = false, onError }: {
  tabs: WorkspaceTab[]
  activeId: string | null
  expanded?: boolean
  /** 在标签头右端渲染「占满 / 收起」两枚开关。并排与收起态它们在对话头（ChatHeader）——
   *  并排时标签头右端要给钉在行右端的窗口三钮让位，放不下；工作区占满后对话头让位、标签头
   *  占满整行，开关回到这里（仍在右端） */
  tools?: boolean
  onError: (error: string) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const [listOpen, setListOpen] = useState(false)
  const [query, setQuery] = useState('')
  const header = useRef<HTMLDivElement>(null)
  /* 标签列表弹层里的并列行（各标签 + 底部两个动作钮）之间加悬停滑动（2026-11-28）：胶囊挂在弹层上，
     搜索框与说明文字不是行；由外观「开启滑动动画」全局控制 */
  const slide = useHoverSlide()
  // 标签条（活动标签自带底色，不停上去）与右端的「占满 / 收起」两钮（仅占满时渲染）各一组；新建钮不入组
  const tabSlide = useHoverSlide()
  const toolsSlide = useHoverSlide()
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
  /* 标签头 portal 进应用头部（窗口拖拽区）：整条 no-drag 保住标签拖拽排序、弹层与悬停滑动；
     中间的弹性留白单独标回 drag —— 工作区占满、侧栏又收起时，行里只剩这一段可以拖动窗口 */
  const drag = { WebkitAppRegion: 'drag' } as CSSProperties
  return <div ref={node => { header.current = node; toolsSlide.containerRef(node) }} onFocusCapture={event => { lastFocus.current = event.target }} data-workspace-header style={NO_DRAG} className={cn(toolsSlide.containerClassName, 'flex h-12 min-w-0 shrink-0 items-center gap-1 px-2')}>
    {toolsSlide.pill}
    <Popover open={listOpen} onOpenChange={open => { setListOpen(open); if (open) setQuery('') }}>
      <Hint tip="标签页列表" side="bottom"><PopoverTrigger render={<Button variant="ghost" size="icon-sm" className={CHROME_HOVER} aria-label="标签页列表" />}><ChevronsDown /></PopoverTrigger></Hint>
      <PopoverContent
        ref={slide.containerRef}
        align="start"
        initialFocus={false}
        className={cn(slide.containerClassName, 'w-80 max-w-[calc(100vw-1rem)]')}
      >
        {slide.pill}
        <InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput aria-label="搜索标签页" placeholder="搜索标签页…" value={query} onChange={event => setQuery(event.target.value)} /></InputGroup>
        <p className="text-xs text-muted-foreground">打开的标签页</p>
        <ItemGroup className="max-h-72 overflow-y-auto">
          {filtered.map(tab => <Item size="xs" variant={tab.id === activeId ? 'muted' : 'default'} className="relative" key={tab.id}>
            <Button variant="ghost" className="absolute inset-0 h-full w-full" data-hover-slide aria-label={tab.title} aria-current={tab.id === activeId ? 'page' : undefined} onClick={() => { useWorkspaceStore.getState().activate(tab.id); setListOpen(false) }} />
            <ItemMedia variant="icon" className="pointer-events-none relative"><TabIcon tab={tab} /></ItemMedia>
            <ItemContent className="pointer-events-none relative min-w-0"><span className="truncate">{tab.title}</span></ItemContent>
            <ItemActions className="relative"><Hint tip="关闭标签页"><Button variant="ghost" size="icon-xs" aria-label={'在列表中关闭 ' + tab.title} onClick={() => { void closeWorkspaceTab(tab.id).catch(error => onError(String(error))) }}><X /></Button></Hint></ItemActions>
          </Item>)}
          {filtered.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">没有匹配的标签页</p>}
        </ItemGroup>
        <Separator />
        <Button variant="ghost" className="justify-start" data-hover-slide onClick={reopen}>重新打开关闭的标签页</Button>
        <Button variant="ghost" className="justify-start" data-hover-slide onClick={() => { setListOpen(false); void closeWorkspaceTabs(tabs.map(tab => tab.id)).catch(error => onError(String(error))) }}>关闭全部标签页</Button>
      </PopoverContent>
    </Popover>
    <Tabs value={activeId} onValueChange={value => { if (typeof value === 'string') useWorkspaceStore.getState().activate(value) }} className="min-w-0 shrink">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
        if (over === null || active.id === over.id) return
        const ids = tabs.map(t => t.id)
        useWorkspaceStore.getState().reorder(tabs[0].scopeId, arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
      }}>
        <SortableContext items={tabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
          <TabsList ref={tabSlide.containerRef} variant="workspace" aria-label="工作区标签页" className={tabSlide.containerClassName} onWheel={event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY }}>
            {tabSlide.pill}
            {tabs.map(tab => <TabHeader key={tab.id} tab={tab} active={tab.id === activeId} onError={onError} />)}
          </TabsList>
        </SortableContext>
      </DndContext>
    </Tabs>
    <Hint tip="新建标签页（Ctrl+T）" side="bottom"><Button variant="ghost" size="icon-sm" className={CHROME_HOVER} aria-label="新建标签页" onClick={() => useWorkspaceStore.getState().newTab()}><Plus /></Button></Hint>
    <div className="min-w-0 flex-1" style={drag} />
    {tools && <>
      <Hint tip={expanded ? '恢复并排' : '占满内容区'} side="bottom"><Button variant="ghost" size="icon-sm" className={CHROME_HOVER} data-hover-slide aria-label={expanded ? '恢复并排' : '展开工作区'} onClick={() => useWorkspaceStore.getState().setLayout({ expanded: !expanded })}>{expanded ? <Minimize2 /> : <Expand />}</Button></Hint>
      <Hint tip="收起工作区" side="bottom"><Button variant="ghost" size="icon-sm" className={CHROME_HOVER} data-hover-slide aria-label="收起工作区" onClick={() => useWorkspaceStore.getState().setLayout({ collapsed: true })}><PanelRightClose /></Button></Hint>
    </>}
  </div>
}
