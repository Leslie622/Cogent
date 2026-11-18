/**
 * 正文主题注入 hook（无 UI）—— docs/技术笔记/聊天正文主题.md 的单点挂载。
 * 亮色变量：编译产物直接作为消息流容器（HomeChat 的 MessageScrollerContent）
 * 的 style —— CSS 变量沿 DOM 继承，消费只存在于 globals.css「聊天正文主题」
 * 段的 .md-body 规则里，容器外的 chrome/侧栏不受影响。
 * 暗色变量 + extraCss：注入 <style> 元素 —— 暗色块带 .dark 前缀**待命**
 * （Cogent 暗色切换未上线，.dark 休眠期间是死代码，上线即生效）；
 * extraCss 经 compile.ts 的 @scope 钉在 .md-body 内。
 * 卸载即拆 <style>；单点挂载（消息流唯一容器），不会重复注入。
 */
import { useEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { compileTokens, extraCssToStyle } from '@/lib/theme/compile'
import { useActiveTheme } from '@/stores/theme'

function varsToCss(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}:${value};`)
    .join('')
}

/** 返回值挂消息流容器 style；暗色/extraCss 的 <style> 由内部 effect 管理 */
export function useChatTheme(): CSSProperties {
  const theme = useActiveTheme()
  /* isDark 恒 false：暗色未上线。真上暗色时改为观测 .dark 再切换编译套，
     本 hook 的返回/注入结构不用动 */
  const lightVars = useMemo(() => compileTokens(theme.tokens), [theme.tokens])

  const { id, extraCss, dark } = theme
  useEffect(() => {
    const parts: string[] = []
    if (dark) parts.push(`.dark .md-body{${varsToCss(compileTokens(dark))}}`)
    const extra = extraCssToStyle(id, extraCss ?? '')
    if (extra) parts.push(extra)
    if (parts.length === 0) return
    const el = document.createElement('style')
    el.setAttribute('data-chat-theme', id)
    el.textContent = parts.join('\n')
    document.head.append(el)
    return () => el.remove()
  }, [id, extraCss, dark])

  return lightVars
}
