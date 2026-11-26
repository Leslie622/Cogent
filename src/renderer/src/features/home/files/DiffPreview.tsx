/** 工作区冻结 Diff 查看器：按需加载回合首尾文本并在 Pierre MultiFileDiff 中渲染统一/双栏对比。 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MultiFileDiff, Virtualizer, type MultiFileDiffProps } from '@pierre/diffs/react'
import type { VirtualizedFileDiff } from '@pierre/diffs'
import { Columns2, ExternalLink, RotateCw, Rows3 } from 'lucide-react'
import type { TurnFileDiff } from '@shared/changes'
import { FileIcon } from '@/components/FileIcon'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { useAppearanceStore, useIsDarkMode } from '@/stores/appearance'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'
import { cn } from '@/lib/utils'

type DiffTab = Extract<WorkspaceTab, { kind: 'diff' }>

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function nonTextCopy(diff: TurnFileDiff): { title: string; description: string } {
  switch (diff.status) {
    case 'binary':
      return {
        title: '二进制文件',
        description: '二进制内容不支持逐行文本差异对比。'
      }
    case 'oversized':
      return {
        title: '超出单文件大小上限',
        description: '文件超出 20 MiB 快照或差异对比预算，仅保留变更记录与元数据。'
      }
    case 'timeout':
      return {
        title: '差异计算超时',
        description: '本次文本差异计算超过时间预算，未能生成逐行对比。'
      }
    case 'non-text-change':
      return {
        title: '非普通文本变更',
        description: diff.reason ?? '仅符号链接或文件类型发生变化。'
      }
    case 'unreadable':
      return {
        title: '文件不可读',
        description: diff.reason ?? '读取快照或原文件失败。'
      }
    default:
      return {
        title: '差异暂不可用',
        description: diff.reason ?? '未能获取该文件的文本差异内容。'
      }
  }
}

export default function DiffPreview({ tab, active }: { tab: DiffTab; active: boolean }) {
  const [diff, setDiff] = useState<TurnFileDiff | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified')
  const [reloadSeq, setReloadSeq] = useState(0)
  const dark = useIsDarkMode()
  const showLineNumbers = useAppearanceStore((s) => s.showLineNumbers)
  const codeWrap = useAppearanceStore((s) => s.codeWrap)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const scrollPos = useRef({ top: 0, left: 0 })
  const instanceRef = useRef<VirtualizedFileDiff | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void window.cogent
      .engineRequest('changes.diff', {
        sessionId: tab.sessionId,
        turnId: tab.turnId,
        revision: tab.revision,
        changeId: tab.changeId
      })
      .then(
        (result) => {
          if (!alive) return
          setDiff(result)
          setLoading(false)
        },
        (err: unknown) => {
          if (!alive) return
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      )
    return () => { alive = false }
  }, [tab.sessionId, tab.turnId, tab.revision, tab.changeId, reloadSeq])

  // 重新激活隐藏的 Diff 标签时恢复滚动位置并确保虚拟行重绘。
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      if (scrollerRef.current !== null) {
        scrollerRef.current.scrollTop = scrollPos.current.top
        scrollerRef.current.scrollLeft = scrollPos.current.left
      }
      const instance = instanceRef.current as unknown as { setVisibility?: (v: boolean) => void; rerender?: () => void } | null
      instance?.setVisibility?.(true)
      instance?.rerender?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  const postRender = useCallback((_node: HTMLElement, instance: unknown) => {
    instanceRef.current = instance as VirtualizedFileDiff
  }, [])

  const options = useMemo<NonNullable<MultiFileDiffProps<undefined>['options']>>(() => ({
    diffStyle,
    disableFileHeader: true,
    disableLineNumbers: !showLineNumbers,
    overflow: codeWrap ? 'wrap' : 'scroll',
    theme: { light: 'pierre-light', dark: 'pierre-dark' },
    themeType: dark ? 'dark' : 'light',
    preferredHighlighter: 'shiki-wasm',
    tokenizeMaxLineLength: 1000,
    useTokenTransformer: false,
    onPostRender: postRender,
    unsafeCSS: `:host { --diffs-gap-block: 0px; } ${codeWrap ? '' : '[data-code] { overflow-x: visible; }'}`
  }), [codeWrap, dark, diffStyle, postRender, showLineNumbers])

  const style = useMemo<CSSProperties>(() => ({ colorScheme: dark ? 'dark' : 'light' }), [dark])
  const oldFile = useMemo(
    () => diff === null ? null : { name: diff.oldPath ?? diff.path, contents: diff.beforeText ?? '' },
    [diff]
  )
  const newFile = useMemo(
    () => diff === null ? null : { name: diff.path, contents: diff.afterText ?? '' },
    [diff]
  )

  const openCurrentFile = () => {
    useWorkspaceStore.getState().openFile(
      { scope: { sessionId: tab.sessionId, turnId: tab.turnId, refs: [] }, target: tab.absolutePath },
      tab.scopeId
    )
  }

  const isTextDiff = diff === null || diff.status === 'text'
  const fallback = diff !== null && diff.status !== 'text' ? nonTextCopy(diff) : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-diff-preview={tab.changeId}>
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2" data-diff-toolbar>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <FileIcon path={tab.path} className="size-4 shrink-0" />
          <Hint tip={<span className="break-all">{diff?.oldPath !== undefined ? `${diff.oldPath} → ${tab.absolutePath}` : tab.absolutePath}</span>}>
            <span className="truncate">{tab.path}</span>
          </Hint>
          {diff !== null && (
            <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
              {diff.added !== null && diff.deleted !== null ? (
                <>
                  <span className="text-emerald-600 dark:text-emerald-400">+{diff.added}</span>
                  <span className="text-red-600 dark:text-red-400">-{diff.deleted}</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
          )}
        </div>
        {isTextDiff && (
          <ButtonGroup className="shrink-0" aria-label="差异视图模式">
            <Hint tip="统一视图">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="统一视图"
                aria-pressed={diffStyle === 'unified'}
                className={cn(diffStyle === 'unified' && 'bg-muted text-foreground hover:bg-muted')}
                onClick={() => setDiffStyle('unified')}
              >
                <Rows3 />
              </Button>
            </Hint>
            <Hint tip="双栏对照">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="双栏对照"
                aria-pressed={diffStyle === 'split'}
                className={cn(diffStyle === 'split' && 'bg-muted text-foreground hover:bg-muted')}
                onClick={() => setDiffStyle('split')}
              >
                <Columns2 />
              </Button>
            </Hint>
          </ButtonGroup>
        )}
        <Hint tip="打开当前原文件">
          <Button size="sm" variant="outline" onClick={openCurrentFile}>
            <ExternalLink />原文件
          </Button>
        </Hint>
      </header>

      {loading && (
        <div className="p-4 text-sm text-muted-foreground">正在加载差异…</div>
      )}
      {!loading && error !== null && (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-destructive">加载差异失败：{error}</p>
          <Button size="sm" variant="outline" onClick={() => setReloadSeq(v => v + 1)}>
            <RotateCw />重试
          </Button>
        </div>
      )}
      {!loading && error === null && diff !== null && fallback !== null && (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/60">
              <FileIcon path={tab.path} className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">{fallback.title}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{fallback.description}</p>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">
              <span>{diff.beforeExists ? formatByteSize(diff.beforeSize ?? 0) : '不存在'}</span>
              <span aria-hidden="true">→</span>
              <span className="text-foreground">{diff.afterExists ? formatByteSize(diff.afterSize ?? 0) : '不存在'}</span>
            </div>
          </div>
        </div>
      )}
      {!loading && error === null && diff !== null && diff.status === 'text' && oldFile !== null && newFile !== null && (
        <div className="flex min-h-0 flex-1 flex-col" data-code-preview>
          {diff.kind === 'eol-or-encoding' && (
            <p role="status" className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              仅换行符或编码变化（{diff.beforeEncoding ?? '未知'} → {diff.afterEncoding ?? '未知'}），文本行内容一致。
            </p>
          )}
          {diff.kind === 'renamed' && (
            <p role="status" className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              按内容匹配为重命名：{diff.oldPath} → {diff.path}
            </p>
          )}
          <div
            ref={scrollerRef}
            className="code-typography min-h-0 flex-1 overflow-auto"
            onScroll={(e) => {
              if (!active) return
              scrollPos.current = { top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft }
            }}
          >
            <Virtualizer className={codeWrap ? 'h-full overflow-auto' : 'scrollbar-native h-full overflow-auto'} contentClassName={codeWrap ? 'min-h-full' : 'min-h-full w-max min-w-full'}>
              <MultiFileDiff
                key={`${diff.revision}:${diffStyle}`}
                oldFile={oldFile}
                newFile={newFile}
                options={options}
                className="min-h-full"
                style={style}
              />
            </Virtualizer>
          </div>
        </div>
      )}
    </div>
  )
}
