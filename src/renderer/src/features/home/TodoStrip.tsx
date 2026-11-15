/**
 * 任务清单条（交互座 4c）：输入区上方的可折叠常驻条 —— todo_write 维护的
 * 清单对用户的呈现位（模型落笔 → todos.updated → 整段替换渲染）。
 * 纯展示：清单是模型的状态，用户不在条上交互（增删改走对话）。
 */
import { useState } from 'react'
import {
  IconCircleCheckFilled,
  IconChevronDown,
  IconCircleDashed,
  IconProgress
} from '@tabler/icons-react'
import { cn } from 'cn'
import { useChatStore } from '@/stores/chat'
import type { TodoItem } from '@/env.d'

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <IconCircleCheckFilled className="size-4 shrink-0 text-muted-foreground" />
  if (status === 'in_progress') return <IconProgress className="size-4 shrink-0 text-foreground" />
  return <IconCircleDashed className="size-4 shrink-0 text-muted-foreground" />
}

/** 单行条目：状态图标 + 内容（完成划线置灰）+ 高优先级红点提示 */
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
      {item.priority === 'high' && item.status !== 'completed' && (
        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" aria-label="高优先级" />
      )}
    </div>
  )
}

/** 条本体：空清单不挂载（HomeChat 侧由数据源保证，此处空态守一道） */
export function TodoStrip() {
  const todos = useChatStore((s) => s.todosBySession[s.activeSessionId ?? ''] ?? [])
  const [collapsed, setCollapsed] = useState(false)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="shrink-0 px-4 pb-2">
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-background px-3 py-2">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <IconChevronDown
            className={cn('size-3.5 text-muted-foreground transition-transform', collapsed && '-rotate-90')}
          />
          <span className="text-xs font-medium text-foreground">任务清单</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {done}/{todos.length}
          </span>
        </button>
        {!collapsed && (
          <div className="mt-1">
            {todos.map((item, i) => (
              <TodoRow key={`${i}-${item.content}`} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
