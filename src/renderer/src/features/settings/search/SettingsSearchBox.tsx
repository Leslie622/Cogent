/**
 * 设置搜索框与返回入口：侧栏可见时放在侧栏顶部，侧栏折叠时放在主内容顶部。
 * 两者共享 store 的 query 与视图状态，但仅在各自容器可见时挂载，保证唯一焦点顺序。
 */
import { useRef, useState } from 'react'
import { IconArrowLeft, IconSearch, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings'
import { cn } from 'cn'

export function SettingsSearchBox({ className }: { className?: string }) {
  const query = useSettingsStore((s) => s.query)
  const setQuery = useSettingsStore((s) => s.setQuery)
  const inputRef = useRef<HTMLInputElement>(null)
  const [composing, setComposing] = useState(false)
  const hasQuery = query.trim() !== ''

  return (
    <div className={cn('flex h-8 items-center gap-2 rounded-lg bg-accent-foreground/5 px-3', className)}>
      <IconSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          // 输入法组词期间不拦截 Escape / Enter
          if (composing || e.nativeEvent.isComposing) return
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault()
            setQuery('')
          }
        }}
        placeholder="搜索"
        aria-label="搜索设置"
        className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
      />
      {query !== '' && (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => {
            setQuery('')
            inputRef.current?.focus()
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconX className="size-3.5" aria-hidden="true" />
        </button>
      )}
      {!hasQuery && query !== '' && <span className="sr-only">搜索词为空白</span>}
    </div>
  )
}

export function BackToSearchResultsButton({ className }: { className?: string }) {
  const backToResults = useSettingsStore((s) => s.backToResults)
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={backToResults}
      className={cn('justify-start gap-1.5 text-muted-foreground hover:text-foreground', className)}
    >
      <IconArrowLeft className="size-3.5" aria-hidden="true" />
      返回搜索结果
    </Button>
  )
}
