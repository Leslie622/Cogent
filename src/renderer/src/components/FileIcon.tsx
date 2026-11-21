/** 正文链接与产物共用的装饰图标；背景图不受 Markdown 内容图片的尺寸与阴影令牌影响。 */
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { getFileIcon } from '@/lib/file-icons'

export function FileIcon({ path, className }: { path: string; className?: string }) {
  const icon = getFileIcon(path)
  return <span
    aria-hidden="true"
    data-file-icon={icon.name}
    className={cn('inline-block size-4 shrink-0 bg-[image:var(--file-icon-light)] bg-contain bg-center bg-no-repeat dark:bg-[image:var(--file-icon-dark)]', className)}
    style={{ '--file-icon-light': `url("${icon.lightSrc}")`, '--file-icon-dark': `url("${icon.src}")` } as CSSProperties}
  />
}
