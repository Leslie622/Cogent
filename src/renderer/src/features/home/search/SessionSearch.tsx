/** 壳层常驻搜索入口：仅保活 Ctrl+K 快捷键，首次打开时懒加载搜索弹窗。 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { useSearchStore } from '@/stores/search'

const SessionSearchDialog = lazy(() =>
  import('./SessionSearchDialog').then((m) => ({ default: m.SessionSearchDialog }))
)

export function SessionSearch() {
  const open = useSearchStore((state) => state.open)
  const setOpen = useSearchStore((state) => state.setOpen)
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.altKey || event.shiftKey) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !(event.target instanceof Element && event.target.closest('.cm-editor'))) {
        event.preventDefault(); setOpen(!useSearchStore.getState().open)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [setOpen])

  if (!mounted) return null
  return (
    <Suspense fallback={null}>
      <SessionSearchDialog />
    </Suspense>
  )
}
