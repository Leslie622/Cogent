/** 所有窗口共用的外观投影；首帧先应用，存储事件重读后让已打开的控制台同步。 */
import { isDarkMode, useAppearanceStore } from '@/stores/appearance'
import { interfaceSkinVariables } from '@/lib/interface-skins'

export function bindAppearanceDom(): () => void {
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  // 只有主窗口且宿主实际启用了系统材质（Win11 22H2+ 且开硬件加速）才启用透明底；
  // 其他平台（Win10 / macOS / Linux / 国产信创 / 关硬件加速）与子窗口保持实色渐变。
  const backdrop = window.location.hash === '' && 'cogent' in window && Boolean(window.cogent.backdropSupported)
  const apply = () => {
    const { colorMode, interfaceSkin, shellOpacity, popoverGlass, codeWrap, accent, uiFontSize, codeFontSize } = useAppearanceStore.getState()
    const dark = isDarkMode(colorMode, media.matches)
    root.classList.toggle('dark', dark)
    root.dataset.interfaceSkin = interfaceSkin
    root.toggleAttribute('data-backdrop', backdrop)
    root.toggleAttribute('data-popover-glass', popoverGlass)
    const skin = interfaceSkinVariables(interfaceSkin, dark, backdrop, shellOpacity)
    root.style.setProperty('--chrome-surface', skin['--chrome-surface'])
    root.style.setProperty('--sidebar', skin['--sidebar'])
    root.toggleAttribute('data-code-wrap', codeWrap)
    root.style.setProperty('--ui-font-size', `${uiFontSize}px`)
    if (codeFontSize === null) root.style.removeProperty('--app-code-size')
    else root.style.setProperty('--app-code-size', `${codeFontSize}px`)
    if (accent === 'default') root.style.removeProperty('--chrome-accent')
    else root.style.setProperty('--chrome-accent', accent)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === null || event.key === useAppearanceStore.persist.getOptions().name)) {
      void useAppearanceStore.persist.rehydrate()
    }
  }
  apply()
  const unsubscribe = useAppearanceStore.subscribe(apply)
  media.addEventListener('change', apply)
  window.addEventListener('storage', onStorage)
  return () => {
    unsubscribe()
    media.removeEventListener('change', apply)
    window.removeEventListener('storage', onStorage)
  }
}
