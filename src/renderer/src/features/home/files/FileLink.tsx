/** 正文和工具共用文件入口；只在点击后 resolve，不让 token 更新触发磁盘探测。 */
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { File } from 'lucide-react'
import type { FileReference } from '@shared/files'
import { useFilePreviewStore } from '@/stores/file-preview'

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
  const [resolved, setResolved] = useState<string | null>(null)
  const requested = useRef<string | null>(null)
  if (scope === null || nested) return <span title={target}>{children}</span>
  const resolveHint = () => {
    const identity = `${scope.sessionId}/${scope.turnId}/${target}`
    if (requested.current === identity) return
    requested.current = identity
    void window.cogent
      .engineRequest('files.resolve', {
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        rawTarget: target,
        relativeTo: scope.relativeTo
      })
      .then(
        (file) => {
          if (requested.current === identity) setResolved(file.path)
        },
        (error: unknown) => {
          if (requested.current === identity)
            setResolved(`${target}\n${error instanceof Error ? error.message : String(error)}`)
        }
      )
  }
  return (
    <FileLinkNestingContext.Provider value>
      <a
        href="#"
        data-file-link={target}
        className="inline-flex max-w-full items-baseline gap-1 wrap-anywhere"
        title={title === undefined ? (resolved ?? target) : `${title}\n${resolved ?? target}`}
        onMouseEnter={resolveHint}
        onFocus={resolveHint}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void useFilePreviewStore.getState().open(scope, target)
        }}
      >
        <File className="size-3 shrink-0 self-center" aria-hidden="true" />
        {/* 渐显会把文字拆成多个 span，间距只属于图标和整段标签，不能落到每个文字片段上。 */}
        <span className="min-w-0" data-file-link-label>{children}</span>
      </a>
    </FileLinkNestingContext.Provider>
  )
}
