/** 回合尾部本轮改动列表：汇总净变化文件与行数，点击条目在右侧工作区打开冻结 Diff。 */
import { useContext, useState } from 'react'
import { ChevronRight, ExternalLink, FileDiff, FolderOpen } from 'lucide-react'
import type { TurnChangeItem } from '@shared/changes'
import { FileIcon } from '@/components/FileIcon'
import { Badge } from '@/components/ui/badge'
import { ChangeKindBadge } from '@/components/ui/change-kind-badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Hint } from '@/components/Hint'
import { useChatStore } from '@/stores/chat'
import { useWorkspaceStore } from '@/stores/workspace'
import { FileLinkContext } from './FileLink'

export function TurnChangesBar() {
  const scope = useContext(FileLinkContext)
  const doc = useChatStore((state) =>
    scope?.turnId === undefined ? undefined : state.bySession[scope.sessionId]?.changes[scope.turnId]
  )
  const error = useChatStore((state) =>
    scope?.turnId === undefined ? undefined : state.bySession[scope.sessionId]?.changeErrors[scope.turnId]
  )
  const [open, setOpen] = useState(false)

  if (doc === undefined) {
    return error !== undefined ? <p role="alert" className="text-xs text-destructive">改动追踪失败：{error}</p> : null
  }
  // 仅当统计不完整（partial）、存在告警或有未统计项时保留展示；complete/tools-only 零改动静默隐藏。
  if (doc.items.length === 0 && doc.warnings.length === 0 && doc.incompleteCount === 0 && doc.coverage !== 'partial') {
    return null
  }

  const openDiff = (item: TurnChangeItem) => {
    useWorkspaceStore.getState().openDiff(
      {
        sessionId: doc.sessionId,
        turnId: doc.turnId,
        changeId: item.changeId,
        path: item.path,
        absolutePath: item.absolutePath,
        revision: doc.revision
      },
      doc.sessionId
    )
  }

  const openOriginal = (item: TurnChangeItem) => {
    useWorkspaceStore.getState().openFile(
      { scope: { sessionId: doc.sessionId, turnId: doc.turnId, refs: [] }, target: item.absolutePath },
      doc.sessionId
    )
  }

  return (
    <section aria-label="本轮改动列表" data-turn-changes={doc.turnId} data-changes-coverage={doc.coverage}>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="overflow-hidden rounded-lg bg-card text-card-foreground ring-1 ring-foreground/10"
      >
        <CollapsibleTrigger className="group/changes-trigger flex min-h-10 w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors outline-none select-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded/changes-trigger:rotate-90" />
          <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {doc.items.length > 0 ? `${doc.items.length} 个文件已更改` : '本轮无净文件更改'}
          </span>
          {doc.items.length > 0 && (
            <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{doc.totalAdded}</span>
              <span className="text-red-600 dark:text-red-400">-{doc.totalDeleted}</span>
            </span>
          )}
          {(doc.coverage === 'partial' || doc.incompleteCount > 0) && (
            <Badge variant="outline" size="sm" className="shrink-0 rounded-md">
              {doc.coverage === 'partial' ? '部分统计' : `${doc.incompleteCount} 项未统计`}
            </Badge>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent
          keepMounted
          className="grid min-w-0 grid-rows-[minmax(0,0fr)] transition-[grid-template-rows] duration-200 ease-out data-open:grid-rows-[minmax(0,1fr)] data-starting-style:starting:grid-rows-[minmax(0,0fr)] data-ending-style:grid-rows-[minmax(0,0fr)] motion-reduce:transition-none"
        >
          <div className="min-h-0 min-w-0 overflow-hidden">
            <div className="flex flex-col gap-0.5 border-t px-1.5 py-1.5">
              {doc.warnings.map((warning, index) => (
                <p key={index} role="status" className="px-1.5 py-0.5 text-xs text-muted-foreground">
                  {warning}
                </p>
              ))}
              {doc.items.map((item) => (
                <div
                  key={item.changeId}
                  data-change-item={item.changeId}
                  className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/60"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    onClick={() => openDiff(item)}
                  >
                    <FileIcon path={item.path} className="size-4 shrink-0" />
                    <Hint tip={<span className="break-all">{item.oldPath !== undefined ? `${item.oldPath} → ${item.absolutePath}` : item.absolutePath}</span>}>
                      <span className="min-w-0 flex-1 truncate">
                        {item.oldPath !== undefined ? `${item.oldPath} → ${item.path}` : item.path}
                      </span>
                    </Hint>
                    <ChangeKindBadge kind={item.kind} />
                    <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
                      {item.added !== null && item.deleted !== null ? (
                        <>
                          <span className="text-emerald-600 dark:text-emerald-400">+{item.added}</span>
                          <span className="text-red-600 dark:text-red-400">-{item.deleted}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  </button>
                  <Hint tip={item.kind === 'deleted' ? '定位原文件路径' : '打开当前原文件'}>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`打开原文件 ${item.path}`}
                      onClick={() => openOriginal(item)}
                    >
                      {item.kind === 'deleted' ? <FolderOpen className="size-3.5" /> : <ExternalLink className="size-3.5" />}
                    </Button>
                  </Hint>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
