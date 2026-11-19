/** 附件入口复用壳的文件/目录选择器，目录与OS粘贴/拖入走同一条草稿识别链。 */
import { IconFile, IconFolder, IconPlus } from '@tabler/icons-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InputGroupButton } from '@/components/ui/input-group'

export function AttachmentMenu({ disabled, onAdd, onError }: {
  disabled: boolean; onAdd: (paths: string[]) => void; onError: (error: unknown) => void
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<InputGroupButton size="icon-xs" disabled={disabled} aria-label="添加附件" />}><IconPlus /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" side="top">
      <DropdownMenuItem onClick={() => { void window.cogent.pickAttachments().then(onAdd, onError) }}><IconFile />添加图片或文件</DropdownMenuItem>
      <DropdownMenuItem onClick={() => { void window.cogent.pickDirectory().then((path) => { if (path !== null) onAdd([path]) }, onError) }}><IconFolder />引用文件夹</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}
