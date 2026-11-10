/**
 * 上下文窗口指示器（content-main 首页会话视图 → 底部输入卡工具行，模型下拉
 * 左侧）：架构位置 = ChatComposer 工具行的常驻只读仪表；职责边界 = 从 chat
 * store 聚合会话 usage 得占用量、从 engine store 取活动模型的 contextWindow
 * 做分母，纯展示（横条 + 百分比 + 点击悬浮卡），不发起任何写操作；分类明细
 * 与压缩预警线属上下文压缩后续件。
 * formatTokens 在此导出：HomeChat 的 UsageLine（消息用量行）同需 token 紧凑
 * 格式，单一实现避免两处口径漂移。
 */
import { useMemo } from 'react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useChatStore } from '@/stores/chat'
import type { MessageItem } from '@/stores/chat'
import { findActiveModel, useEngineStore } from '@/stores/engine'
import type { HomeSession } from '@/stores/home'
import type { MessageUsage } from '@/env.d'

/** token 数紧凑格式：1234 → 1.2K、1.05M；千以下原样（tabular-nums 保证列对齐） */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${parseFloat((n / 1000).toFixed(1))}K`
  return `${parseFloat((n / 1e6).toFixed(2))}M`
}

/** 非聊天视图（新聊天）时的稳定空回退：selector 返回 undefined，若在组件体内
    写 `?? []` 字面量，每次渲染新建数组 → 下方 usage 聚合的 useMemo 全程失效
    逐帧重算。模块级常量让引用恒定（同 HomeChat 里 ChatMessages 的先例） */
// 消息联合（含工具卡行）：usage 扫描经 type 判别跳过工具行（见下方 useMemo）
const EMPTY_MESSAGES: MessageItem[] = []

/** 横条本体：斜纹轨道（用户参照稿图1；透明度只落在背景，合 UI 方针 3）+ 实色填充 */
function ContextBar({ pct, tone, className }: { pct: number; tone: string; className?: string }) {
  return (
    <span className={cn('relative block overflow-hidden rounded-full bg-muted', className)}>
      <span className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--color-border)_3px_4px)]" />
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300', tone)}
        style={{ width: `${pct * 100}%` }}
      />
    </span>
  )
}

/**
 * 上下文窗口指示器（输入卡工具行，模型下拉左侧）+ 点击悬浮卡（用户参照稿图2
 * 骨架：标题/进度条/缓存命中率）。口径：占用 = 末条带 usage 的 assistant 消息
 * input+cacheRead+cacheWrite+output —— pi 每轮全量重发上下文，三项和即该轮
 * 实发量，加 output 为"下一轮将重发"；与 Claude Code status 同源（末轮端点
 * 实报而非实时计数，流式中保持上一轮值）。分母 = 活动模型 contextWindow
 * （不上网络的客户端元数据；自定义模型缺省 128K 偏保守 → 百分比偏高不偏低）。
 * 分类明细/压缩预警线待工具/MCP、上下文压缩模块落地再上（主流对照见
 * 技术笔记/token-usage.md §6）。
 */
export function ContextIndicator({ session }: { session: HomeSession }) {
  const messages =
    useChatStore((s) => (session.kind === 'chat' ? s.messagesBySession[session.chatId] : undefined)) ?? EMPTY_MESSAGES
  // 分母模型与 ModelMenu 同源（findActiveModel 双键）：同名模型跨 provider 收录时
  // id 单键命中错家 —— 未配 key 的收录家、或都配了 key 时目录在前的那家（后者
  // 上下文窗口大小还可能与自定义网关那份不同，分母就错了）
  const contextWindow = useEngineStore(
    (s) =>
      findActiveModel(s.models, s.keyConfigured, s.activeModelId, s.activeProviderId)?.contextWindow ?? 0
  )

  const { used, cacheHit } = useMemo(() => {
    let usage: MessageUsage | undefined
    let cacheRead = 0
    let cacheDen = 0
    // 从后往前扫：首条命中即"末条已完成回答"的 usage（流式中末条还没有 usage）；
    // 命中率顺路全会话聚合，分母 = input（未命中部分）+ cacheRead（命中部分）。
    // 工具卡行没有 usage，先判别跳过（消息联合见 stores/chat MessageItem）
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (item.type !== undefined) continue
      const u = item.usage
      if (!u) continue
      if (!usage) usage = u
      cacheRead += u.cacheRead
      cacheDen += u.input + u.cacheRead
    }
    return {
      used: usage ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output : 0,
      // 端点不报缓存的模型 cacheRead 恒 0，"0%" 是误导 → 不显示（零值省略同 UsageLine）
      cacheHit: cacheRead > 0 && cacheDen > 0 ? cacheRead / cacheDen : undefined
    }
  }, [messages])

  const pct = Math.min(used / contextWindow, 1)
  // 两位小数：低占用时整数百分比信息量不足（6% 与 6.25% 是两回事）；>0 却四舍
  // 五入到 0.00 的极小占用显示 <0.01%，避免 "0.00%" 的尴尬假 0（used===0 已在
  // 上方整体不渲染，这里 pct 恒 >0）
  const pctNum = pct * 100
  const pctLabel = pctNum < 0.005 ? '<0.01' : pctNum.toFixed(2)
  // 三档变色只落在 bar（文字恒实色 muted）；阈值 75/90 与主流预警习惯对齐
  const tone = pct >= 0.9 ? 'bg-destructive' : pct >= 0.75 ? 'bg-warning' : 'bg-foreground'

  // 没有对话（首答前无实报数据）整个指示器不渲染：0% 横条 + 空态悬浮卡都是
  // 噪音（用户定调），首答产出 usage 后自然出现
  if (used === 0) return null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 rounded-xl px-2 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
            aria-label="上下文窗口用量"
          />
        }
      >
        <ContextBar pct={pct} tone={tone} className="h-1.5 w-20" />
        <span className="text-xs tabular-nums">{pctLabel}%</span>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64 gap-0 rounded-2xl p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold">上下文容量</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {formatTokens(used)}/{formatTokens(contextWindow)}（{pctLabel}%）
          </span>
        </div>
        <ContextBar pct={pct} tone={tone} className="mt-3 h-1.5" />
        {cacheHit !== undefined && (
          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <span className="text-[13px]">平均缓存命中率</span>
            <span className="text-[13px] font-semibold tabular-nums">
              {parseFloat((cacheHit * 100).toFixed(1))}%
            </span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
