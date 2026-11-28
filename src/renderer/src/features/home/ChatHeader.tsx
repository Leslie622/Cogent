/** 对话头：会话标题 + [更多 / 标签页区开关]（标题来自 chat store 的活动会话）。
 *  挂在应用头部的中块（AppHeader），与侧栏块、标签页块同处一行，不再占对话列的高度；
 *  数据自取，HomeChat 不经 props 下发开合命令。
 *  头部行是窗口拖拽区：标题簇与右侧钮簇标 no-drag（拖拽区内的元素收不到指针事件，hover
 *  信息卡依赖它），两簇之间的留白留给拖动窗口；标题簇有宽度上限，长标题不会吃光留白。
 *  项目会话的标题区是面包屑「项目名 / 会话标题」（复用 Breadcrumb，与文件查看器的路径面包屑同款；
 *  2026-11-29 用户定调），hover 标题区（图标+面包屑整体）出信息卡（zcode 同款，2026-11-16 定调
 *  替代先前的项目名 tooltip）：标题全文（头部行截断，卡里看全）+ 项目名称/主根路径 + 最近活动；
 *  无项目会话标题前也有一枚会话图标（消息气泡，2026-11-29 用户要求）：与项目态的文件夹图标
 *  同形同位（ghost icon-sm 占位钮），跨分支切换会话时标题起点不横跳；草稿「新聊天」态无
 *  会话标题语义，不显图标（与标题占位同规则）。
 *  git 分支行暂缺 —— 引擎协议与壳桥均无分支通道（UI布局.md 已记录），留工作区面板后续件。
 *  触发区是非交互 span 不包 Button */
import { Expand, PanelRightClose } from 'lucide-react'
import { IconClock, IconDots, IconFolder, IconLayoutSidebarRightExpand, IconMessage } from '@tabler/icons-react'
import { Hint } from '@/components/Hint'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { EMPTY_WORKSPACE, useWorkspaceStore } from '@/stores/workspace'
import { useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useProjectStore } from '@/stores/project'
import { CHROME_HOVER, NO_DRAG } from '@/features/shell/chrome'

/** 相对时间文案（信息卡「最近活动」行用）：刚刚 / N 分钟前 / N 小时前 /
    N 天前，更久落本地日期 —— 会话 updatedAt 随消息推进（chat store），
    项目级无现成字段，由调用方以同项目会话的 max(updatedAt) 下发 */
function relativeTime(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return new Date(ms).toLocaleDateString()
}

export function ChatHeader() {
  const session = useHomeStore((s) => s.session)
  // 活动会话（标题与项目反查的共源）：已有会话按 id 查；"新聊天进行中"态无会话
  // 标题语义 → undefined（标题落「新聊天」占位、不显图标）。视图态优先于
  // activeSessionId，与 submit 物化同一口径 —— 防新聊天漏清残留 id 时头部闪旧会话
  const activeChat = useChatStore((s) =>
    session.kind === 'chat' ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined
  )
  const title = activeChat?.title ?? '新聊天'
  // 项目会话归属项目（头部信息卡用）：按 projectId 反查 project store。
  // lastActiveAt = 同项目各会话 updatedAt 的 max（项目级无现成字段，派生），
  // selector 返回原始值数字，引用稳定不引起额外重渲染
  const activeProjectId = activeChat?.projectId
  const project = useProjectStore((s) =>
    activeProjectId !== undefined ? s.projects.find((p) => p.id === activeProjectId) : undefined
  )
  const lastActiveAt = useChatStore((s) => {
    if (activeProjectId === undefined) return undefined
    let max = 0
    for (const x of s.sessions) {
      if (x.projectId === activeProjectId && x.updatedAt > max) max = x.updatedAt
    }
    return max > 0 ? max : undefined
  })
  // 标签页区收起 = 窗口断点自动收起或手动收起（与 HomeMain 此前下发的 tabsCollapsed 同一判式）
  const scope = useWorkspaceStore((s) => s.scopes[s.activeScopeId] ?? EMPTY_WORKSPACE)
  const autoCollapsed = useWorkspaceStore((s) => s.autoCollapsed)
  const tabsCollapsed = autoCollapsed || scope.collapsed

  return (
    <div data-chat-header className="flex h-12 min-w-0 flex-1 items-center gap-2 pr-2 pl-4">
      {/* 标题簇：宽度上限给右侧拖拽留白让位 —— 宽时留 160px，窄时按 30% 收敛、标题优先 */}
      <div className="flex min-w-0 max-w-[calc(100%_-_min(160px,_30%))] items-center gap-2" style={NO_DRAG}>
        {project !== undefined ? (
          <HoverCard>
            {/* delay/closeDelay 是 preview-card Trigger 的 prop（Root 没有）；
                400 同 Hint 口径 —— 划过标题不闪卡 */}
            <HoverCardTrigger
              delay={400}
              closeDelay={0}
              render={
                <span className="flex min-w-0 cursor-default items-center gap-1.5" />
              }
            >
              {/* 图标是按钮（同「更多」钮 ghost 同款，hover 出底）；点击行为空位
                  —— 同头部「更多」钮先占位后接线的惯例 */}
              <Button variant="ghost" size="icon-sm" className={CHROME_HOVER} aria-label={`项目：${project.name}`}>
                <IconFolder className="size-4.5" />
              </Button>
              {/* 面包屑：项目名 / 会话标题。项目名不参与压缩（上限四成），挤不下先截标题 ——
                  项目名通常短，按内容比例收缩会先把它截没 */}
              <Breadcrumb aria-label="会话位置" className="min-w-0">
                <BreadcrumbList className="flex-nowrap gap-2.5 whitespace-nowrap">
                  <BreadcrumbItem className="max-w-[40%] shrink-0">
                    <span className="min-w-0 truncate">{project.name}</span>
                  </BreadcrumbItem>
                  {/* 分隔符用「/」，不用组件默认的右尖括号（2026-11-29 用户定调） */}
                  <BreadcrumbSeparator className="shrink-0 text-muted-foreground/50">/</BreadcrumbSeparator>
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </HoverCardTrigger>
            {/* 排版对照 ContextIndicator 的 PopoverContent（13px 主文案 + muted
                次行 + border-t 分组）；卡片纯展示无动作行。align=start：默认居中对齐
                会让卡片飘到中块中部 —— 左对齐到触发区左缘（图标处）即 zcode 位置 */}
            <HoverCardContent side="bottom" align="start" sideOffset={8} className="w-72 gap-0 p-3">
              <div className="flex items-center gap-2">
                <IconFolder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
              </div>
              <div className="mt-3 flex items-center gap-2 border-t pt-3">
                <IconFolder className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{project.name}</div>
                  {/* 主根路径（多根项目其余目录在工作区面板看，同信息区口径） */}
                  <div className="truncate text-xs text-muted-foreground">{project.cwds[0]}</div>
                </div>
              </div>
              {lastActiveAt !== undefined && (
                <div className="mt-3 flex items-center gap-2">
                  <IconClock className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm text-foreground">
                    最近活动 {relativeTime(lastActiveAt)}
                  </span>
                </div>
              )}
            </HoverCardContent>
          </HoverCard>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            {/* 无项目会话：标题前也有图标（消息气泡）——与项目态的文件夹图标同形
                同位（ghost icon-sm + 外壳柔光悬停），跨分支切换时标题起点不横跳；
                点击行为空位，同项目图标「先占位后接线」的惯例 */}
            {activeChat !== undefined && (
              <Button variant="ghost" size="icon-sm" className={CHROME_HOVER} aria-label={`会话：${title}`}>
                <IconMessage className="size-4.5" />
              </Button>
            )}
            <span className="min-w-0 truncate text-sm text-foreground">{title}</span>
          </span>
        )}
      </div>
      {/* 两簇之间留给窗口拖拽（头部行是拖拽区，这里不标 no-drag） */}
      <div className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-2" style={NO_DRAG}>
        <Hint tip="更多" side="bottom">
          <Button variant="ghost" size="icon-sm" className={CHROME_HOVER} aria-label="更多">
            <IconDots className="size-4" />
          </Button>
        </Hint>
        {/* 工作区的开关恒在这一位（面板左缘）：收起时是展开入口，并排时是占满与收起。
            它们原在标签头右端 —— 窗口三钮钉到行右端后标签头要让出槽位，开关留在那里会把
            标签列表挤到放不下一枚标签的关闭钮。占满时对话头让位，两枚开关回到标签头右端
            （WorkspaceTabs tools）。 */}
        {tabsCollapsed ? (
          <Hint tip="展开标签页区" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className={CHROME_HOVER}
              aria-label="展开标签页区"
              onClick={() => useWorkspaceStore.getState().toggle()}
            >
              <IconLayoutSidebarRightExpand className="size-[19px]" />
            </Button>
          </Hint>
        ) : !scope.expanded ? (
          <>
            <Hint tip="占满内容区" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                className={CHROME_HOVER}
                aria-label="展开工作区"
                onClick={() => useWorkspaceStore.getState().setLayout({ expanded: true })}
              >
                <Expand />
              </Button>
            </Hint>
            <Hint tip="收起工作区" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                className={CHROME_HOVER}
                aria-label="收起工作区"
                onClick={() => useWorkspaceStore.getState().setLayout({ collapsed: true })}
              >
                <PanelRightClose />
              </Button>
            </Hint>
          </>
        ) : null}
      </div>
    </div>
  )
}
