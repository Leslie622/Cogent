/**
 * 对话内容主题注入 hook（无 UI）—— docs/技术笔记/对话内容主题.md 的单点挂载。
 * 编译产物（按当前明暗选 tokens / dark 套）直接作为消息流容器
 * （HomeChat 的 MessageScrollerContent）的 style —— CSS 变量沿 DOM 继承，
 * 消费只存在于 globals.css「对话内容主题」段的 .md-body 规则里，容器外的
 * chrome/侧栏不受影响。
 * 明暗切换 = 容器 style 换套（单管道）：暗色令牌也走 inline style，与门控
 * 选择器 [style*='--t-*'] 的「style 属性探测」天然一致 —— 暗色曾设计为
 * .dark .md-body 的 <style> 块注入，但 <style> 规则设置的变量不在 style
 * 属性里，门控永不匹配，该路线从未跑通（2026-11-18 暗色上线时砍掉）。
 * extraCss 仍走 <style> 元素（@scope 钉在 .md-body 内，compile.ts）；
 * 卸载即拆 <style>；单点挂载（消息流唯一容器），不会重复注入。
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { compileTokens, extraCssToStyle } from '@/lib/theme/compile'
import { useActiveTheme } from '@/stores/theme'
import { buildUserTokens, isDarkMode, useAppearanceStore } from '@/stores/appearance'

/** OS 明暗源（matchMedia 单例；仅 system 档的消费走它，dark/light 直选不看） */
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')

/** 返回值挂消息流容器 style；extraCss 的 <style> 由内部 effect 管理 */
export function useChatTheme(): CSSProperties {
  const theme = useActiveTheme()
  const colorMode = useAppearanceStore((s) => s.colorMode)
  const systemDark = useSyncExternalStore(
    (onChange) => {
      prefersDark.addEventListener('change', onChange)
      return () => prefersDark.removeEventListener('change', onChange)
    },
    () => prefersDark.matches,
    () => false,
  )
  const isDark = isDarkMode(colorMode, systemDark)
  /* 套选择：暗色且主题带 dark 套 → 整面换套；未带 = 亮色套直用（未设键
     回落 CSS 基础值，不回落亮面——theme-file.ts 的 dark 套语义）。
     用户覆盖（外观设置的字号/字体档）在套选择之后合并 —— 压过所有主题
     （含默认 Leslie），"跟随主题"档不写键 = 主题说了算。三字段分开订阅
     原始值再 memo 组装：对象选择器每次新引用会踩 1.2-8 快照不稳定坑 */
  const codeFontSize = useAppearanceStore((s) => s.codeFontSize)
  const contentFont = useAppearanceStore((s) => s.contentFont)
  const codeFont = useAppearanceStore((s) => s.codeFont)
  const activeTokens = isDark && theme.dark ? theme.dark : theme.tokens
  const overrides = useMemo(
    () => buildUserTokens({ codeFontSize, contentFont, codeFont }),
    [codeFontSize, contentFont, codeFont],
  )
  const vars = useMemo(
    () => compileTokens({ ...activeTokens, ...overrides }),
    [activeTokens, overrides],
  )

  const { id, extraCss } = theme
  useEffect(() => {
    const extra = extraCssToStyle(id, extraCss ?? '')
    if (!extra) return
    const el = document.createElement('style')
    el.setAttribute('data-chat-theme', id)
    el.textContent = extra
    document.head.append(el)
    return () => el.remove()
  }, [id, extraCss])

  return vars
}
