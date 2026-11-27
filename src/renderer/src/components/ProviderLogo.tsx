/**
 * Provider 品牌图标（官方彩色标，2026-11-08）：
 * - 内置 provider → @lobehub/icons 品牌组件（AI 厂商图标库；包 sideEffects:false，
 *   按名导入可摇树）。单色标（Anthropic/OpenAI/Grok/ZAI）走 currentColor 随文字色，
 *   彩色标用 `.Color` 变体（品牌渐变/多色原样）
 * - 自定义 provider → 黑底首字方标：无品牌可挂，黑方标与厂商黑标同一气质
 * 消费方：设置页供应商清单/详情、聊天模型菜单（按 providerId 分组时）。
 */
import type { ReactNode } from 'react'
import {
  Anthropic,
  Azure,
  Baseten,
  Bedrock,
  Cerebras,
  Cloudflare,
  Codex,
  DeepSeek,
  Fireworks,
  Gemini,
  GithubCopilot,
  Grok,
  Groq,
  HuggingFace,
  Kimi,
  Ling,
  Meta,
  Minimax,
  Mistral,
  Moonshot,
  Nvidia,
  OpenAI,
  OpenCode,
  OpenRouter,
  Qwen,
  Together,
  TypeSafeAI,
  Vercel,
  VertexAI,
  WorkersAI,
  XiaomiMiMo,
  ZAI,
} from '@lobehub/icons'
import { cn } from 'cn'

/** 内置 providerId → 品牌图标（size 等比）。未收录品牌（如 radius / custom/*）回落首字方标 */
const BRAND_ICONS: Record<string, ((size: number) => ReactNode) | undefined> = {
  'amazon-bedrock': (size) => <Bedrock.Color size={size} />,
  'ant-ling': (size) => <Ling.Color size={size} />,
  anthropic: (size) => <Anthropic size={size} className="text-foreground" />,
  azure: (size) => <Azure.Color size={size} />,
  baseten: (size) => <Baseten size={size} className="text-foreground" />,
  cerebras: (size) => <Cerebras.Color size={size} />,
  'cloudflare-ai-gateway': (size) => <Cloudflare.Color size={size} />,
  'cloudflare-workers-ai': (size) => <WorkersAI.Color size={size} />,
  deepseek: (size) => <DeepSeek.Color size={size} />,
  fireworks: (size) => <Fireworks.Color size={size} />,
  'github-copilot': (size) => <GithubCopilot size={size} className="text-foreground" />,
  google: (size) => <Gemini.Color size={size} />,
  'google-vertex': (size) => <VertexAI.Color size={size} />,
  groq: (size) => <Groq size={size} className="text-foreground" />,
  huggingface: (size) => <HuggingFace.Color size={size} />,
  'kimi-coding': (size) => <Kimi.Color size={size} />,
  meta: (size) => <Meta.Color size={size} />,
  minimax: (size) => <Minimax.Color size={size} />,
  'minimax-cn': (size) => <Minimax.Color size={size} />,
  mistral: (size) => <Mistral.Color size={size} />,
  moonshotai: (size) => <Moonshot size={size} className="text-foreground" />,
  'moonshotai-cn': (size) => <Moonshot size={size} className="text-foreground" />,
  nvidia: (size) => <Nvidia.Color size={size} />,
  openai: (size) => <OpenAI size={size} className="text-foreground" />,
  'openai-codex': (size) => <Codex.Color size={size} />,
  opencode: (size) => <OpenCode size={size} className="text-foreground" />,
  'opencode-go': (size) => <OpenCode size={size} className="text-foreground" />,
  openrouter: (size) => <OpenRouter.Color size={size} />,
  'qwen-token-plan': (size) => <Qwen.Color size={size} />,
  'qwen-token-plan-cn': (size) => <Qwen.Color size={size} />,
  'qwen-token-plan-individual': (size) => <Qwen.Color size={size} />,
  'qwen-token-plan-individual-cn': (size) => <Qwen.Color size={size} />,
  together: (size) => <Together.Color size={size} />,
  typesafe: (size) => <TypeSafeAI size={size} className="text-foreground" />,
  'vercel-ai-gateway': (size) => <Vercel size={size} className="text-foreground" />,
  xai: (size) => <Grok size={size} className="text-foreground" />,
  xiaomi: (size) => <XiaomiMiMo size={size} className="text-foreground" />,
  'xiaomi-token-plan-ams': (size) => <XiaomiMiMo size={size} className="text-foreground" />,
  'xiaomi-token-plan-cn': (size) => <XiaomiMiMo size={size} className="text-foreground" />,
  'xiaomi-token-plan-sgp': (size) => <XiaomiMiMo size={size} className="text-foreground" />,
  zai: (size) => <ZAI size={size} className="text-foreground" />,
  'zai-coding-cn': (size) => <ZAI size={size} className="text-foreground" />,
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
  if (brand) {
    return (
      <span
        /* 品牌 svg 尺寸经 CSS 变量 + ! 钉死：Button 基类有
           [&_svg:not([class*='size-'])]:size-4 后代兜底（TodoStrip 同坑）——
           品牌 svg 的尺寸写在 width/height 属性上、没有 Tailwind size 类，
           CSS 必压属性，size prop 落在 Button 里会被无声钉成 16px（模型
           触发钮调大不生效即此）。任意值类吃不进动态数字，尺寸走变量下发；
           ! 是打赢该后代规则的唯一稳口子（同下方字色钉死的处境） */
        className={cn(
          '[&>svg]:size-[var(--provider-logo-size)]!',
          'shrink-0 leading-none',
          className
        )}
        style={
          {
            width: size,
            height: size,
            '--provider-logo-size': `${size}px`,
          } as React.CSSProperties
        }
      >
        {brand(size)}
      </span>
    )
  }

  const letter = (name ?? providerId).trim().slice(0, 1).toUpperCase() || 'P'
  return (
    <span
      /* 字色钉死不跟 hover：菜单 item 聚焦态有 `focus:**:text-accent-foreground`
         （全部后代染文字色，为单色品牌标跟色而设），特异性压过本元素的
         text-background —— 首字变黑没入黑底方标（模型菜单 hover 自定义
         provider 时踩响）。!important 是唯一能赢过该后代规则的口子。 */
      className={cn('flex shrink-0 items-center justify-center rounded-md bg-foreground font-semibold text-background!', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {letter}
    </span>
  )
}
