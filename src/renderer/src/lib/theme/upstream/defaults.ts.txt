import type { TokenKey } from './tokens'

/**
 * 基础样式表 var() 回落值的单一来源(与 theme-base.css 逐项同步)。
 *
 * `theme-base.css` 里每条 `var(--t-*, 回落值)` 的回落值,与主题工场字段
 * 未设置时的占位符(placeholder)表达的是同一件事:「令牌不存在时的观感」。
 * 两者曾靠人肉同步,密度调整改了 CSS 漏改占位符导致回显失真(行高 1.75→1.6、
 * 段间距 1.25em→0.8em 均中过招)——现在 size/number 类占位符一律从本表派生,
 * 一致性由守门测试(defaults-sync.test.ts)机械锁定:改 CSS 回落值不同步本表
 * (或反之)测试立刻红。
 *
 * 两类条目:
 * - 标量(size/number/select 等,占位符直接展示):size/leading/padding 类
 * - 颜色与继承类(color/inherit/transparent 等):仅参与同步校验;颜色字段的
 *   占位符走运行时实测(resolveFallbackColors),实测不到才「未设置」,不用
 *   这里的静态值——inherit/currentColor 展示出来没有信息量
 * 字体栈回落(三套 monospace 等)是长列表,占位符场景用不到,不进表。
 * CSS 文件本身仍是权威渲染样式,本表是它的镜像。
 */
export const THEME_BASE_DEFAULTS: Partial<Record<TokenKey, string>> = {
  // ── 基础(标量)──
  'root.size': '16px',
  'root.leading': '1.6',
  'root.spacing': 'normal',
  'root.width': '48rem',
  'p.marginBottom': '0.8em',
  'p.indent': '0',
  'p.align': 'start',
  // ── 标题(共用)──
  'heading.weight': '650',
  'heading.leading': '1.3',
  'heading.marginTop': '1.6em',
  'heading.marginBottom': '0.6em',
  // ── 标题各级 ──
  'h1.size': '2em',
  'h2.size': '1.5em',
  'h3.size': '1.22em',
  'h4.size': '1.05em',
  'h5.size': '1em',
  'h6.size': '0.9em',
  'h1.borderWidth': '0',
  'h2.borderWidth': '0',
  'h1.paddingBottom': '0',
  'h2.paddingBottom': '0',
  'h1.borderColor': 'oklch(0.9 0 0)',
  'h2.borderColor': 'oklch(0.9 0 0)',
  // ── 行内元素 ──
  'strong.weight': '700',
  'strong.padding': '0',
  'strong.margin': '0',
  'em.style': 'italic',
  'em.padding': '0',
  'em.margin': '0',
  // 自绘删除线的回落:未设 offset 时线在正中(0px 偏移)、未设 thickness 时 1px;
  // 字段占位符也取这里(auto 是原生 line-through 态的语义,进自绘态就不对了)
  'del.thickness': '1px',
  'del.offset': '0px',
  'del.padding': '0',
  'del.margin': '0',
  'a.underlineHeight': 'auto',
  'a.transition': '0s',
  'a.underlineColor': 'currentColor',
  'a.padding': '0',
  'a.margin': '0',
  'inlineCode.size': '0.875em',
  'inlineCode.padding': '0.2em 0.35em',
  'inlineCode.margin': '0',
  'inlineCode.radius': '4px',
  'inlineCode.borderWidth': '0',
  // ── 列表 ──
  'list.indent': '1.5em',
  'li.spacing': '0.375em',
  'list.position': 'outside',
  'list.marginBottom': '1.25em',
  'ul.markerShape': 'disc',
  'ul.markerShape2': 'circle',
  'ul.markerShape3': 'square',
  'ul.markerText': 'normal',
  'ul.markerSize': '1em',
  'ol.markerSize': '1em',
  'ol.markerStyle': 'decimal',
  'ol.markerStyle2': 'lower-alpha',
  'ol.markerStyle3': 'lower-roman',
  'ol.markerText': 'normal',
  // ── 引用 ──
  'quote.borderWidth': '3px',
  'quote.radius': '0',
  'quote.padding': '0.25em 1em',
  'quote.style': 'normal',
  // ── 代码块 ──
  'codeBlock.size': '0.875em',
  'codeBlock.leading': '1.6',
  'codeBlock.padding': '1em 1.25em',
  'codeBlock.radius': '8px',
  'codeBlock.borderWidth': '0',
  // ── 表格 ──
  'table.radius': '0',
  'table.collapse': 'collapse',
  'cell.padding': '0.5em 0.85em',
  'th.weight': '600',
  // ── 分隔线/图片 ──
  'hr.thickness': '1px',
  'hr.margin': '2em 0',
  'hr.padding': '0',
  'img.radius': '4px',
  'img.width': 'auto',
  'img.height': 'auto',
  'img.align': '0',
  'img.borderWidth': '0',
  'img.maxWidth': '100%',
  'img.shadow': 'none',
  'img.margin': '0',
  'cell.rowLine': 'solid',
  'cell.colLine': 'none',
  'cell.borderWidth': '1px',

  // ── 颜色与继承类(仅同步校验,颜色字段占位符走运行时实测)──
  // 字体双令牌(latin/cjk)不进常表:CSS 消费点是编译器拼栈(theme-base.css
  // 只消费合并后的 --t-*-font),回落语义在 compile.ts FONT_FALLBACK_TAILS
  'root.bg': 'transparent',
  'heading.color': 'inherit',
  'strong.color': 'inherit',
  'strong.bg': 'transparent',
  'em.weight': 'inherit',
  'em.color': 'inherit',
  'em.bg': 'transparent',
  'del.weight': 'inherit',
  'del.color': 'inherit',
  'del.textColor': 'currentColor',
  'del.bg': 'transparent',
  'a.weight': 'inherit',
  'a.color': 'inherit',
  // hover 态的回落是链式(hoverColor→color、hoverLine→underlineColor),
  // CSS 里 var() 的第二参本身是变量;这里记链的最终静态端,校验在测试豁免
  'a.bg': 'transparent',
  'inlineCode.weight': 'inherit',
  'inlineCode.color': 'inherit',
  'inlineCode.bg': 'oklch(0.96 0 0)',
  'inlineCode.borderColor': 'oklch(0.9 0 0)',
  'ul.markerColor': 'currentColor',
  'ol.markerColor': 'currentColor',
  'task.accent': 'oklch(0.55 0 0)',
  'task.size': '1em',
  'task.radius': '3px',
  'task.borderWidth': '1px',
  'task.borderColor': 'oklch(0.7 0 0)',
  'task.doneColor': 'inherit',
  'task.todoColor': 'inherit',
  'quote.bg': 'transparent',
  'quote.color': 'inherit',
  'quote.borderColor': 'oklch(0.9 0 0)',
  'callout.borderWidth': '3px',
  'callout.radius': '6px',
  'callout.padding': '0.75em 1em',
  'callout.bgOpacity': '8%',
  'callout.note': 'oklch(0.55 0.16 255)',
  'callout.tip': 'oklch(0.6 0.15 150)',
  'callout.important': 'oklch(0.55 0.2 300)',
  'callout.warning': 'oklch(0.6 0.13 75)',
  'callout.caution': 'oklch(0.58 0.19 25)',
  'codeBlock.bg': 'oklch(0.97 0 0)',
  'codeBlock.borderColor': 'oklch(0.9 0 0)',
  'table.borderColor': 'oklch(0.9 0 0)',
  'row.hoverBg': 'transparent',
  'th.bg': 'transparent',
  'table.stripeBg': 'transparent',
  'hr.color': 'oklch(0.9 0 0)',
  'img.borderColor': 'oklch(0.9 0 0)',
}
