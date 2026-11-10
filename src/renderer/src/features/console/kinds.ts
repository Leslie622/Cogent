/**
 * 观测条目的呈现映射：kind → 图标 / 层（过滤分组）/ 一句话学习注释。
 * 时间线（行图标 + 过滤）与详情面板（类型徽标 + "这是什么"注释）共用，
 * 改呈现只动这里。层色只用于装饰点（背景色），文字仍实色 token（AGENTS 方针 3）。
 */
import type { ComponentType } from 'react'
import {
  IconApi,
  IconArrowsExchange,
  IconCircleCheck,
  IconCircleX,
  IconFileText,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlayerTrackNext,
  IconPrompt,
  IconTool,
  IconWaveSine,
} from '@tabler/icons-react'
import type { InspectEntryKind, InspectEntrySummary } from '@/env.d'
import type { ConsoleLayer } from '@/stores/console'

interface KindPresentation {
  icon: ComponentType<{ className?: string }>
  /** 层归属（过滤开关）+ 层色（装饰点背景类） */
  layer: ConsoleLayer
  /** 详情面板的类型徽标文案 */
  label: string
  /** 学习注释：这条记录在引擎里对应发生了什么（详情面板顶部） */
  explain: string
}

export const LAYERS: Array<{ id: ConsoleLayer; label: string; dot: string }> = [
  { id: 'api', label: '接口', dot: 'bg-blue-500' },
  { id: 'engine', label: '引擎', dot: 'bg-emerald-600' },
  { id: 'tool', label: '工具', dot: 'bg-amber-500' },
  { id: 'session', label: '会话', dot: 'bg-foreground' },
]

/** 层 → 装饰点色类（LAYERS 全集查找；缺项回退黑点属编码错误，不该发生） */
export function layerDot(layer: ConsoleLayer): string {
  return LAYERS.find((l) => l.id === layer)?.dot ?? 'bg-foreground'
}

export const KINDS: Record<InspectEntryKind, KindPresentation> = {
  'run.started': {
    icon: IconPlayerTrackNext,
    layer: 'session',
    label: '会话 · run 开始',
    explain: '你在主窗口发了一条消息（agent.submit 被受理）。一个 run = 一次完整的提问到收尾，下面的一切都发生在它内部。',
  },
  'run.completed': {
    icon: IconCircleCheck,
    layer: 'session',
    label: '会话 · run 完成',
    explain: '引擎循环收尾：最终回复已经过 run.completed 事件送回聊天界面。概览是本轮各轮次的总账（tokens/成本/耗时）。',
  },
  'run.failed': {
    icon: IconCircleX,
    layer: 'session',
    label: '会话 · run 失败',
    explain: 'run 异常收尾（接口报错 / 主动停止）。pi 的失败语义：半截回复保留进转录，错误文案经 run.failed 送回 UI。',
  },
  'system.prompt': {
    icon: IconPrompt,
    layer: 'engine',
    label: '提示词 · 系统提示词',
    explain: '本轮实际生效的系统提示词：基础人设 + 工作区声明 + 环境块 + 各根目录 AGENTS.md 拼装的结果（引擎 buildSystemPrompt 组装）。',
  },
  'turn.started': {
    icon: IconPlayerPlay,
    layer: 'engine',
    label: '引擎 · turn 开始',
    explain: 'pi Agent 循环的一轮开始。一轮 = 一次完整的厂商请求 + （若模型要求）工具执行；带工具的对话一个 run 会有多轮。',
  },
  'turn.completed': {
    icon: IconPlayerStop,
    layer: 'engine',
    label: '引擎 · turn 结束',
    explain: '本轮收尾。详情是 pi 归一化后的 assistant 终态消息（与 api.stream 的原始分片对照着看，就是"归一化前 vs 后"）。',
  },
  'api.request': {
    icon: IconApi,
    layer: 'api',
    label: '接口 · 请求',
    explain: '即将发给厂商的原始 HTTP 请求体（pi onPayload 截获，SDK 发出前一刻）。系统提示词、完整对话上下文、工具定义都在这个 JSON 里 —— 这是"模型真正看到了什么"的最终答案。',
  },
  'api.response': {
    icon: IconArrowsExchange,
    layer: 'api',
    label: '接口 · 响应头',
    explain: '厂商响应头到达（响应体尚未开始消费，pi onResponse 截获）。状态码与请求 id 在这里。',
  },
  'api.stream': {
    icon: IconWaveSine,
    layer: 'api',
    label: '接口 · SSE 流',
    explain: '本次请求的 SSE 原始分片汇总（pi 归一化之前，一行一条）。模型不是"一次生成完整回复"，是一个分片一个分片吐出来的。',
  },
  'tool.started': {
    icon: IconTool,
    layer: 'tool',
    label: '工具 · 开始',
    explain: '引擎开始执行模型要求的工具调用。详情是模型给出的调用参数（模型"想做什么"的结构化表达）。',
  },
  'tool.completed': {
    icon: IconFileText,
    layer: 'tool',
    label: '工具 · 完成',
    explain: '工具执行收尾，结果将作为下一轮请求的上下文发回模型（工具循环的闭环）。Cogent 暂未注册工具，此层记录是给后续路线预留的。',
  },
}

/** 条目行的行尾摘要：概览键值拼一行（完整表格在详情面板）。与标题重复的值
    （如 api.request 的 Provider/模型已在标题里）剔除 —— 行宽有限，摘要只给增量信息 */
export function summarizeOverview(entry: InspectEntrySummary): string {
  return (entry.overview ?? [])
    .filter((o) => o.label !== '长度' && !entry.title.includes(o.value))
    .slice(0, 3)
    .map((o) => o.value)
    .join(' · ')
}
