/** 窗口级布局断点：只在跨越阈值时通知，不把逐像素 resize 写进 React 状态。 */
import { useCallback, useSyncExternalStore } from 'react'

export function useWindowMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(query)
    media.addEventListener('change', notify)
    return () => media.removeEventListener('change', notify)
  }, [query])
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot)
}
