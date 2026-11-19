/**
 * 对话内容主题注入 hook（无 UI）—— docs/技术笔记/对话内容主题.md 的单点挂载。
 * 编译产物（按当前明暗选 tokens / dark 套）直接作为消息流容器
 * （HomeChat 的 MessageScrollerContent）的 style —— CSS 变量沿 DOM 继承，
 * 消费只存在于 lib/theme/ 的 .md-body 规则里，容器外的
 * chrome/侧栏不受影响。
 * 明暗令牌同走 inline style。用户选择另编独立变量，由最先声明的重要层消费，
 * 否则只合并 --t-* 仍会被主题子元素声明和 extraCss 的 important 绕过。
 * extraCss 仍走 <style> 元素（@scope 钉在 .md-body 内，compile.ts）；
 * 卸载即拆 <style>；单点挂载（消息流唯一容器），不会重复注入。
 */
import { useEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { compileTokens, extraCssToStyle } from '@/lib/theme/compile'
import { compileUserOverrides } from '@/lib/theme/user-overrides'
import { useActiveTheme } from '@/stores/theme'
import { buildUserTokens, useIsDarkMode, useAppearanceStore } from '@/stores/appearance'

/** 返回值挂消息流容器 style；extraCss 的 <style> 由内部 effect 管理 */
export function useChatTheme(): CSSProperties {
  const theme = useActiveTheme()
  const isDark = useIsDarkMode()
  /* 套选择：暗色且主题带 dark 套 → 整面换套；未带 = 亮色套直用（未设键
     回落 CSS 基础值，不回落亮面——theme-file.ts 的 dark 套语义）。
     用户覆盖（外观设置的字号/字体档）在套选择之后合并 —— 压过所有主题
     （含默认 Leslie），中英文分别覆盖；"跟随主题"的槽位不写键。三字段分别
     订阅再 memo 组装：对象选择器每次新引用会踩 1.2-8 快照不稳定坑 */
  const codeFontSize = useAppearanceStore((s) => s.codeFontSize)
  const contentFont = useAppearanceStore((s) => s.contentFont)
  const codeFont = useAppearanceStore((s) => s.codeFont)
  const activeTokens = isDark && theme.dark ? theme.dark : theme.tokens
  const overrides = useMemo(
    () => buildUserTokens({ codeFontSize, contentFont, codeFont }),
    [codeFontSize, contentFont, codeFont],
  )
  const vars = useMemo(
    () => ({
      ...compileTokens({ ...activeTokens, ...overrides }),
      ...compileUserOverrides(activeTokens, { codeFontSize, contentFont, codeFont }),
    }),
    [activeTokens, overrides, codeFontSize, contentFont, codeFont],
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
