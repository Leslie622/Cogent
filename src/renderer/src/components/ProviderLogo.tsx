/**
 * Provider 品牌图标（官方彩色标，2026-11-08）：
 * - 内置 provider → @lobehub/icons 品牌组件（AI 厂商图标库；包 sideEffects:false，
 *   按名导入可摇树）。单色标（Anthropic/OpenAI/Grok/ZAI）走 currentColor 随文字色，
 *   彩色标用 `.Color` 变体（品牌渐变/多色原样）
 * - 自定义 provider → 黑底首字方标：无品牌可挂，黑方标与厂商黑标同一气质
 * 消费方：设置页供应商清单/详情、聊天模型菜单（按 providerId 分组时）。
 */
import type { ReactNode } from 'react'
import { Anthropic, DeepSeek, Gemini, Grok, OpenAI, OpenRouter, ZAI } from '@lobehub/icons'
import { cn } from 'cn'

/** 内置 providerId → 品牌图标（size 等比）。值可缺失是真实语义（目录 40+ 家
    远多于收录的 7 家），类型显式标 undefined，真值判断才有意义 */
const BRAND_ICONS: Record<string, ((size: number) => ReactNode) | undefined> = {
  anthropic: (size) => <Anthropic size={size} className="text-foreground" />,
  openai: (size) => <OpenAI size={size} className="text-foreground" />,
  google: (size) => <Gemini.Color size={size} />,
  deepseek: (size) => <DeepSeek.Color size={size} />,
  openrouter: (size) => <OpenRouter.Color size={size} />,
  xai: (size) => <Grok size={size} className="text-foreground" />,
  zai: (size) => <ZAI size={size} className="text-foreground" />,
}

export function ProviderLogo({
  providerId,
  name,
  size = 20,
  className,
}: {
  providerId: string
  /** 方标取首字用（自定义 provider 必传；内置可省） */
  name?: string
  size?: number
  className?: string
}) {
  const brand = BRAND_ICONS[providerId]
  if (brand) return <span className={cn('shrink-0 leading-none', className)}>{brand(size)}</span>

  const letter = (name ?? providerId).trim().slice(0, 1).toUpperCase() || 'P'
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md bg-foreground font-semibold text-background', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {letter}
    </span>
  )
}
