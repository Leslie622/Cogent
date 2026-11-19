/** 批量准入只列真实未加入的文件；明细用浮层查看，避免挤掉输入区的发送入口。 */
import { IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { AttachmentRejection } from '@shared/attachments'
export function AttachmentRejections({ items, onClear }: { items: AttachmentRejection[]; onClear: () => void }) {
  return <div className="flex w-full min-w-0 items-center justify-between gap-2" role="alert">
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="xs" />} aria-label="查看未添加的文件">
        {items.length} 个文件未添加
      </PopoverTrigger>
      <PopoverContent side="top" align="start">
        <ul className="max-h-40 space-y-2 overflow-y-auto select-text">
          {items.map((item, index) => <li key={index} className="break-words"><span>{item.name}</span>：{item.reason}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
    <Button variant="ghost" size="icon-xs" aria-label="清除未添加提示" onClick={onClear}><IconX /></Button>
  </div>
}
