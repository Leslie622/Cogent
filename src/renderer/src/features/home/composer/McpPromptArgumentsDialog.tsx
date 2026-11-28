/** MCP 提示词参数在用户选中后收集；这里只保存草稿，不提前执行 prompts/get。 */
import { useId, useState } from 'react'
import type { McpPromptInfo } from '@shared/mcp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function McpPromptArgumentsDialog({ prompt, onCancel, onConfirm }: {
  prompt: McpPromptInfo
  onCancel: () => void
  onConfirm: (args: Record<string, string>) => void
}) {
  const id = useId()
  const [values, setValues] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<string[]>([])
  const args = prompt.arguments ?? []
  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md" onKeyDown={event => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{prompt.name}</DialogTitle>
          <DialogDescription>{prompt.description ?? `来自 ${prompt.server} 的 MCP 提示词`}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-4" onSubmit={event => {
          event.preventDefault()
          const absent = args.filter(argument => argument.required === true && (values[argument.name] ?? '').trim() === '').map(argument => argument.name)
          setMissing(absent)
          if (absent.length > 0) return
          onConfirm(Object.fromEntries(args.filter(argument => (values[argument.name] ?? '') !== '').map(argument => [argument.name, values[argument.name]])))
        }}>
          <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
            {args.map((argument, index) => (
              <div key={argument.name} className="space-y-1.5">
                <label htmlFor={`${id}-${index}`} className="text-sm font-medium">{argument.name}{argument.required === true ? '（必填）' : '（可选）'}</label>
                {argument.description !== undefined && <p className="text-xs text-muted-foreground">{argument.description}</p>}
                <Input id={`${id}-${index}`} autoFocus={index === 0} value={values[argument.name] ?? ''}
                  aria-required={argument.required === true} aria-invalid={missing.includes(argument.name)} onChange={event => setValues(current => ({ ...current, [argument.name]: event.target.value }))} />
              </div>
            ))}
            {missing.length > 0 && <p role="alert" className="text-sm text-destructive">请填写必填参数：{missing.join('、')}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
            <Button type="submit">插入提示词</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
