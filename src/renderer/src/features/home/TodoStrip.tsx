/**
 * 任务清单条（交互座 4c）：内容区右上角浮动卡 —— todo_write 维护的清单
 * 对用户的呈现位（模型落笔 → todos.updated → 整段替换渲染）。
 * 纯展示：清单是模型的状态，用户不在条上交互（增删改走对话）。
 * 浮动而非占位（2026-11-16 用户定调）：清单是跨回合的"进行中"状态，
 * 与消息流叠放不占布局位；折叠收成计数胶囊，让位给正文。
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconListCheck,
  IconProgress
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import type { TodoItem } from '@/env.d'

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  // 完成绿（zcode 对齐，2026-11-16 用户定调）：emerald 实色（HomeSidebar
  // 在线胶囊同族；淡字实色纪律，透明度只许用在底色）
  if (status === 'completed') return <IconCircleCheckFilled className="size-4 shrink-0 text-emerald-600" />
  if (status === 'in_progress') return <IconProgress className="size-4 shrink-0 text-foreground" />
  return <IconCircleDashed className="size-4 shrink-0 text-muted-foreground" />
}

/** 单行条目：状态图标 + 内容（完成划线置灰） */
function TodoRow({ item }: { item: TodoItem }) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      <StatusIcon status={item.status} />
      <span
        className={cn(
          'truncate text-[13px]',
          item.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'
        )}
      >
        {item.content}
      </span>
    </div>
  )
}

/** 无清单会话的稳定空回退：选择器里写 `?? []` 字面量，zustand v5 严格相等下
    每次快照都是新数组 → useSyncExternalStore 死循环（同 HomeChat 的
    EMPTY_MESSAGES，约定.md §1.2 反模式 8） */
const EMPTY_TODOS: TodoItem[] = []

/** 条本体：空清单不挂载（HomeChat 侧由数据源保证，此处空态守一道）。
    absolute 定位生效前提 = 挂载点是内容区的 relative 容器（HomeChat） */
export function TodoStrip() {
  const todos = useChatStore((s) => s.todosBySession[s.activeSessionId ?? ''] ?? EMPTY_TODOS)
  const [collapsed, setCollapsed] = useState(false)
  // 收起冷却（2026-11-16 交互优化）：点击折叠钮的位置与收起后胶囊的位置
  // 几乎重合，收起瞬间指针就压在胶囊上、:hover 立即命中 → 展开图标动画
  // 「收起即触发」的突兀闪烁。收起时挂短冷却，期间禁掉 hover 展开动画；
  // 指针真想展开：移开再回来即可（冷却只压这一小段窗口）
  const [hoverCooldown, setHoverCooldown] = useState(false)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(cooldownTimer.current), [])
  const collapse = (): void => {
    setCollapsed(true)
    setHoverCooldown(true)
    clearTimeout(cooldownTimer.current)
    cooldownTimer.current = setTimeout(() => setHoverCooldown(false), 600)
  }
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    // 折叠"移入"边缘（2026-11-16 用户定调）：收小 + 更贴角（top-1.5
    // right-2.5），展开卡留常规边距；transition 让两态间滑入滑出
    <div
      className={cn(
        'absolute z-10 flex max-w-[calc(100%-2rem)] flex-col items-end transition-all',
        collapsed ? 'top-1.5 right-2.5' : 'top-3 right-4 w-80'
      )}
    >
      {collapsed ? (
        // 折叠 = 计数胶囊（最小占位），整钮可点展开；hover 反馈走 outline
        // 变体原生 hover:bg-muted，展开图标 hover 才以动画加入：默认
        // w-0 + 负 margin 抵消 gap（完全不占位），hover 宽度/外距/透明度
        // 三过渡滑入（group/button 是 Button 本体自带组）
        <Button variant="outline" size="pill" onClick={() => setCollapsed(false)} aria-expanded={false}>
          <IconListCheck className="size-4.5 text-muted-foreground" />
          <span className="font-medium text-foreground">任务清单</span>
          <span className="tabular-nums text-muted-foreground">
            {done}/{todos.length}
          </span>
          {/* 零占位动画的载体是这层 span：Button 基类有
              [&_svg:not([class*='size-'])]:size-4 兜底（specificity 高于
              传入的 w-0，会把 svg 顶回 16px 占位——首验右侧留白的根因），
              span 不受该规则管，w-0 稳定生效；内层 svg 带 size-4
              挡住兜底。冷却期整体摘掉 group-hover 类（见 collapse 注释） */}
          <span
            className={cn(
              '-mr-1.5 flex w-0 overflow-hidden opacity-0 transition-all',
              !hoverCooldown && 'group-hover/button:mr-0 group-hover/button:w-4 group-hover/button:opacity-100'
            )}
          >
            <IconArrowsDiagonal className="size-4 text-muted-foreground" />
          </span>
        </Button>
      ) : (
        <div className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 shadow-sm">
          {/* 头部 = 纯展示行（图标+标题+计数不可点）+ 行尾**独立**折叠钮
              （2026-11-16 用户定调：不与标题做同一按钮）；ghost 原生
              hover:bg-muted 反馈，icon-only 钠带 aria-label */}
          <div className="flex items-center gap-1.5">
            {/* 图标与折叠胶囊同款同尺寸（size-4.5）：两态切换图标不跳。
                字号比条目大半档（标题 14px / 计数 13px），标题压得住清单 */}
            <IconListCheck className="size-4.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">任务清单</span>
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {done}/{todos.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto text-muted-foreground"
              onClick={collapse}
              aria-label="折叠任务清单"
            >
              {/* 收起语义图标（对角收进，与胶囊的展开图标
                  IconArrowsDiagonal 成对，同 size-4） */}
              <IconArrowsDiagonalMinimize2 className="size-4" />
            </Button>
          </div>
          {/* 限高滚动：长清单不把浮动卡撑出内容区 */}
          <div className="mt-1 max-h-56 overflow-y-auto">
            {todos.map((item, i) => (
              <TodoRow key={`${i}-${item.content}`} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
