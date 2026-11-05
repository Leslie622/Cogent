import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ComposerProps {
  /** 未配置模型凭据时禁用输入 */
  disabled: boolean
  running: boolean
  onSend: (text: string) => void
  onAbort: () => void
}

export function Composer({ disabled, running, onSend, onAbort }: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const submit = (): void => {
    const text = value.trim()
    if (!text || disabled || running) return
    onSend(text)
    setValue('')
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 发送、Shift+Enter 换行；输入法组词期间的 Enter 不发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="shrink-0 border-t bg-background px-4 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border bg-card p-2 pl-3 focus-within:ring-1 focus-within:ring-ring">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={
              disabled
                ? '请先配置模型 API Key（见右上角提示）'
                : '给 Cogent 发送消息 · Enter 发送 · Shift+Enter 换行'
            }
            className="max-h-[200px] min-h-7 flex-1 resize-none bg-transparent py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setValue(event.target.value)
              resize()
            }}
            onKeyDown={handleKeyDown}
          />
          {running ? (
            <Button size="icon" variant="outline" className="rounded-lg" aria-label="停止生成" onClick={onAbort}>
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="rounded-lg"
              aria-label="发送"
              disabled={disabled || !value.trim()}
              onClick={submit}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
