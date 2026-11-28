/** 所有窗口共用的外观投影；首帧先应用，存储事件重读后让已打开的控制台同步。 */
import { isDarkMode, useAppearanceStore } from '@/stores/appearance'
import { interfaceSkinVariables } from '@/lib/interface-skins'
import { popoverGlassVariables } from '@/lib/popover-glass'

export function bindAppearanceDom(): () => void {
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  // 只有浅色模式的主窗口且宿主实际启用了系统材质（Win11 22H2+ 且开硬件加速）才启用透明底；
  // 深色模式下系统 Acrylic 会透出浅色亮度导致外壳发灰发白，因此与其他平台及子窗口一并保持实色渐变。
  const backdrop = window.location.hash === '' && 'cogent' in window && Boolean(window.cogent.backdropSupported)
  const apply = () => {
    const {
      colorMode,
      interfaceSkin,
      shellOpacity,
      popoverGlass,
      popoverGlassOpacity,
      popoverGlassBlur,
      popoverGlassSaturate,
      hoverTransition,
      hoverTransitionMs,
      codeWrap,
      accent,
      uiFontSize,
      codeFontSize,
    } = useAppearanceStore.getState()
    const dark = isDarkMode(colorMode, media.matches)
    const effectiveBackdrop = backdrop && !dark
    root.classList.toggle('dark', dark)
    root.dataset.interfaceSkin = interfaceSkin
    root.toggleAttribute('data-backdrop', effectiveBackdrop)
    root.toggleAttribute('data-popover-glass', popoverGlass)
    if (popoverGlass) {
      const glass = popoverGlassVariables(
        { opacity: popoverGlassOpacity, blur: popoverGlassBlur, saturate: popoverGlassSaturate },
        dark,
      )
      root.style.setProperty('--popover-glass', glass['--popover-glass'])
      root.style.setProperty('--popover-glass-sub', glass['--popover-glass-sub'])
      root.style.setProperty('--popover-glass-blur', glass['--popover-glass-blur'])
      root.style.setProperty('--popover-glass-saturate', glass['--popover-glass-saturate'])
    } else {
      root.style.removeProperty('--popover-glass')
      root.style.removeProperty('--popover-glass-sub')
      root.style.removeProperty('--popover-glass-blur')
      root.style.removeProperty('--popover-glass-saturate')
    }
    const skin = interfaceSkinVariables(interfaceSkin, dark, effectiveBackdrop, shellOpacity)
    root.style.setProperty('--chrome-surface', skin['--chrome-surface'])
    root.style.setProperty('--sidebar', skin['--sidebar'])
    root.toggleAttribute('data-code-wrap', codeWrap)
    // 悬停过渡时长：base 层默认规则与对齐后的 duration-(…) 都读它；关 = 0ms（减少动画由 CSS 媒体查询再压成 0）
    root.style.setProperty('--hover-transition-duration', `${hoverTransition ? hoverTransitionMs : 0}ms`)
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
