/** 正文和工具共用文件入口；图标只看名称，预览、hover 和右键动作才按需解析。 */
import { createContext, useContext, type ReactNode } from 'react'
import type { FileReference } from '@shared/files'
import { parseFileTarget } from '@shared/file-target'
import { FileIcon } from '@/components/FileIcon'
import { useFilePreviewStore } from '@/stores/file-preview'
import { FileLinkActions } from './FileLinkActions'

export interface FileLinkScope {
  sessionId: string
  turnId?: string
  refs: readonly FileReference[]
  relativeTo?: string
  preview?: boolean
}
export const FileLinkContext = createContext<FileLinkScope | null>(null)
export const FileLinkNestingContext = createContext(false)
export function FileLink({
  target,
  children,
  title
}: {
  target: string
  children: ReactNode
  title?: string
}) {
  const scope = useContext(FileLinkContext)
  const nested = useContext(FileLinkNestingContext)
  if (scope === null || nested) return <span title={target}>{children}</span>
  const preview = () => void useFilePreviewStore.getState().open(scope, target)
  return (
    <FileLinkNestingContext.Provider value>
      <FileLinkActions key={JSON.stringify([scope.sessionId, scope.turnId, scope.relativeTo, target])} scope={scope} target={target} title={title} onPreview={preview}>
        <a
          href="#"
          data-file-link={target}
          className="inline-flex max-w-full items-baseline gap-1 wrap-anywhere"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            preview()
          }}
        >
          <FileIcon path={parseFileTarget(target)!.path} className="size-4 self-center" />
          {/* 渐显会把文字拆成多个 span，间距只属于图标和整段标签，不能落到每个文字片段上。 */}
          <span className="min-w-0" data-file-link-label>{children}</span>
        </a>
      </FileLinkActions>
    </FileLinkNestingContext.Provider>
  )
}
