/**
 * 回合分组与容器（ZCode 式两态呈现的装配层，见 docs/计划-回合过程折叠.md）：
 * store 的消息列表保持平铺（事件流逻辑不动），本件在渲染期按相邻关系分组 ——
 * 用户消息到下一用户消息 = 一个回合（run）。回合内两态：
 *   进行中：过程项（思考块/工具卡/中间正文）摊开直播 + 底部 WorkingLine；
 *   终态：过程收进 RunTrace 头条（已工作 Xs/已停止/出错了），末条有正文段 =
 *   终答常驻头条之下，用量聚合一行（过程展开时各段仍带自己的用量小字）。
 * 无过程回合（单段纯文本）也恒挂头条（D8 修订 2026-11-11，ZCode 对齐：
 * 慢本身是信号），只是过程体为空不可展开。
 * 切分/聚合全是纯函数；TurnGroup memo 按项引用比较 —— 流式 delta 只重渲染
 * 活动回合，历史回合零重渲染。
 */
import { memo } from 'react'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { Reasoning } from '@/components/ui/reasoning'
import { RunTrace, WorkingLine } from '@/components/ui/run-trace'
import { ToolCard } from '@/components/ui/tool'
import type { ChatMessage, MessageUsage } from '@/env.d'
import type { MessageItem } from '@/stores/chat'
import { MessageRow, UsageLine } from './MessageRow'
import { ApprovalCard } from './ApprovalCard'
import { CompactionBar, PrunedBar } from './CompactionBar'

/** 回合（一问一答 + 其间全部过程项）；user 缺省 = 无提问头组 —— 压缩折叠条
 *  组（D9 保留式：bar 按时间序原位中插，自成一组并截断当前组；组内只有
 *  bar 与其配对裁剪副行，其后内容另起无头续组）、历史投影尾部前导的兜底组。
 *  startedAt = 无 user 头组的墙钟起点（第八轮验收：压缩条截断出的续组继承
 *  原 user 的 timestamp —— 不继承的话 turnDurationMs 无起点、头条只剩
 *  「已工作」没秒数） */
export interface ChatTurn {
  user?: ChatMessage
  items: MessageItem[]
  startedAt?: number
}

/** 渲染期分组（D1；D9 补压缩条锚定）：用户消息开新回合（user 存 turn.user
 *  槽、不进 items），其后到下一用户消息前的项归本回合；压缩折叠条
 *  （role 'compaction'）自成一组且**截断当前组**（current 置空，其后内容
 *  自起无头续组）—— 不截断的话，bar 按时间序插在触发消息与回复之间时，
 *  流式占位/终态回复/工具卡会落进 bar 组，而 bar 组的渲染分支只认
 *  compaction/pruned 两类（其余映射 null）＝ 回复被整个吞掉（第三轮验收
 *  实测"压缩后无回复"）。[user 泡][bar 行][续组=回复] 正是 Codex 标记行形态 */
export function groupTurns(items: MessageItem[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let current: ChatTurn | undefined
  // 最近一次 user 的 timestamp：压缩条截断出的续组/bar 组继承它作墙钟起点
  let lastUserAt: number | undefined
  for (const item of items) {
    if (item.type === undefined && item.role === 'user') {
      lastUserAt = item.timestamp
      current = { user: item, items: [] }
      turns.push(current)
    } else if (item.type === undefined && item.role === 'compaction') {
      // 截断：current 置空，下一项（非 user）自起无头续组
      current = undefined
      turns.push({ items: [item], startedAt: lastUserAt })
    } else {
      if (current === undefined) {
        current = { items: [], startedAt: lastUserAt }
        turns.push(current)
      }
      current.items.push(item)
    }
  }
  return turns
}

/** 回合相位（live = 进行中；stopped/failed 由 chat store 的停止位/错误位区分） */
export type TurnPhase = 'live' | 'done' | 'stopped' | 'failed'

/**
 * 过程 vs 终答切分（D2）：
 * live —— 流式占位（id 'streaming'）= 输出位置的直播正文（思考 + 已出文本
 * 原样渲染），其余全部是过程；占位被工具事件封段（改名 live-*）后自然归过程。
 * 终态 —— 末条有正文的段 = 终答；answer 剥 thinking（归过程伪段）与
 * usage/durationMs（回合聚合行与头条已表达，不双记）；answerOriginal 保留
 * 原文给**无过程直出分支** —— 该分支没有聚合行，自带用量/耗时不能丢。
 * 终答之后若还有工具项（模型末轮只调工具没收尾的边角）留在过程体，顺序小让步。
 */
function splitTurn(
  items: MessageItem[],
  isLive: boolean
): { process: MessageItem[]; answer?: ChatMessage; answerOriginal?: ChatMessage } {
  if (isLive) {
    const last = items.at(-1)
    if (last !== undefined && last.type === undefined && last.id === 'streaming') {
      return { process: items.slice(0, -1), answer: last }
    }
    return { process: items }
  }
  let answerRaw: ChatMessage | undefined
  let answerIndex = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === undefined && item.content !== '') {
      answerRaw = item
      answerIndex = i
      break
    }
  }
  if (answerRaw === undefined) return { process: items }
  const process = items.filter((_, i) => i !== answerIndex)
  if (answerRaw.thinking !== undefined) {
    process.push({
      ...answerRaw,
      id: `${answerRaw.id}-thinking`,
      content: '',
      usage: undefined,
      durationMs: undefined
    })
  }
  return {
    process,
    answer: { ...answerRaw, thinking: undefined, usage: undefined, durationMs: undefined },
    answerOriginal: answerRaw
  }
}

/**
 * 回合墙钟时长（D5）：提问 timestamp → 回合末条内容消息 timestamp
 * （含工具执行耗时；各段 durationMs 求和不含，会虚低）。工具卡行没有
 * timestamp，从尾部扫首条内容消息即回合收尾时刻。无 user 头组（D9 压缩条
 * 截断的续组）用继承的 startedAt 起点 —— 墙钟口径不变："用户等了多久"
 */
function turnDurationMs(turn: ChatTurn): number | undefined {
  const start = turn.user?.timestamp ?? turn.startedAt
  if (start === undefined) return undefined
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i]
    if (item.type === undefined) return Math.max(item.timestamp - start, 0)
  }
  return undefined
}

/**
 * 回合用量聚合（D7）：各段求和（工具卡行无 usage 跳过）；成本只在全部段
 * 端点实报时才标实报（任一估价 → 聚合也估价 ≈）
 */
function sumUsage(items: MessageItem[]): MessageUsage | undefined {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalTokens = 0
  let reasoning = 0
  let totalCost: number | undefined
  let allFromProvider = true
  let any = false
  for (const item of items) {
    if (item.type !== undefined) continue
    const u = item.usage
    if (u === undefined) continue
    any = true
    input += u.input
    output += u.output
    cacheRead += u.cacheRead
    cacheWrite += u.cacheWrite
    totalTokens += u.totalTokens
    reasoning += u.reasoning ?? 0
    if (u.totalCost !== undefined) {
      totalCost = (totalCost ?? 0) + u.totalCost
      allFromProvider = allFromProvider && u.totalCostFromProvider !== false
    }
  }
  if (!any) return undefined
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    reasoning,
    totalCost,
    totalCostFromProvider: totalCost === undefined ? undefined : allFromProvider
  }
}

/**
 * 回合接口时长聚合（D7 修订 2026-11-11）：各段 durationMs 求和（工具卡行无此
 * 字段跳过；undefined 段不计 —— 与头条墙钟双口径并存，见终态分支注释）
 */
function sumDurationMs(items: MessageItem[]): number | undefined {
  let total: number | undefined
  for (const item of items) {
    if (item.type !== undefined) continue
    if (item.durationMs !== undefined) total = total === undefined ? item.durationMs : total + item.durationMs
  }
  return total
}

/**
 * 回合工具时长聚合：各工具 [startedAt, endedAt] 区间求**并集**而非简单相加 ——
 * pi 并行执行同批工具（实测 3 个 glob 同毫秒启动），逐个求和会按 CPU 时间口径
 * 重复计墙钟（1.58s 之和 vs 0.55s 实占），与「已工作」墙钟对不上账。并集后
 * 模型 + 工具 ≈ 墙钟（残差 = 引擎开销，毫秒级）。缺打点的工具（blocked /
 * 旧转录 / 流式期事件项）自然跳过；无任何打点返回 undefined（不显示工具项）
 */
function sumToolMs(items: MessageItem[]): number | undefined {
  const spans: Array<[number, number]> = []
  for (const item of items) {
    if (item.type !== 'tool') continue
    const { startedAt, endedAt } = item
    // 零/负跨度 = 数据异常（终点先于起点），丢弃而非负进总量
    if (startedAt === undefined || endedAt === undefined || endedAt <= startedAt) continue
    spans.push([startedAt, endedAt])
  }
  if (spans.length === 0) return undefined
  spans.sort((a, b) => a[0] - b[0])
  let total = 0
  let cursor = spans[0][0] // 已合并区间的右端
  for (const [start, end] of spans) {
    if (end <= cursor) continue // 完全落在已合并区间内（并行工具）
    total += end - Math.max(start, cursor)
    cursor = end
  }
  return total
}

/** 过程项渲染：工具卡 / 审批卡 / 纯思考段（终答思考剥出的伪段）/ 中间正文段
 *  （后者带自己的用量小字 —— 展开过程的逐段透明度） */
function ProcessItem({ item }: { item: MessageItem }) {
  if (item.type === 'tool') {
    return (
      <ToolCard
        name={item.name}
        summary={item.summary}
        status={item.status}
        result={item.resultSummary}
        progress={item.progress}
        diff={item.diff}
      />
    )
  }
  if (item.type === 'approval') {
    return <ApprovalCard item={item} />
  }
  // 裁剪副行（完备化 R3/D8）：折叠条同区的一行「已裁剪 N 处工具输出」
  if (item.type === 'pruned') {
    return <PrunedBar item={item} />
  }
  // 压缩条类型分支（常态走 TurnGroupImpl 的独立行快路，不进过程体 ——
  // 塞进「已工作」折叠体里的压缩标记等于看不见；此分支是类型完备兜底）
  if (item.role === 'compaction') {
    return <CompactionBar message={item} />
  }
  if (item.content === '' && item.thinking !== undefined) {
    return <Reasoning text={item.thinking} running={false} />
  }
  return <MessageRow message={item} />
}

function TurnGroupImpl({ turn, phase }: { turn: ChatTurn; phase: TurnPhase }) {
  // 压缩折叠条独立行：无用户消息的单独回合组（D9 保留式：bar 原位插在
  // 压缩发生位置，其上是保留的影子区历史、其下保留区以 user 消息另起回合；
  // 多次压缩多条 bar 各自成组）—— 不套「已工作」头条/统计行（那是一个
  // run 的语义，压缩不是 run）。组内可带 L1 prune 副行（completed 手术把
  // [折叠条, 副行] 一起插在切点后）
  const first = turn.items[0]
  if (turn.user === undefined && first.type === undefined && first.role === 'compaction') {
    return (
      <div className="flex flex-col gap-2">
        {turn.items.map((item) =>
          item.type === 'pruned' ? (
            <MessageScrollerItem key={item.id} messageId={item.id}>
              <PrunedBar item={item} />
            </MessageScrollerItem>
          ) : item.type === undefined && item.role === 'compaction' ? (
            <MessageScrollerItem key={item.id} messageId={item.id}>
              <CompactionBar message={item} />
            </MessageScrollerItem>
          ) : null
        )}
      </div>
    )
  }
  const split = splitTurn(turn.items, phase === 'live')
  const { process, answer, answerOriginal } = split
  // live 切分增量（2026-11-10 用户定调：结果出来了就直接折叠，不等终态事件）：
  // 终答正文一开流，本轮思考即收进过程（与终态结构同构，收尾翻转零位移）
  let liveProcess = split.process
  let liveAnswer = split.answer
  if (liveAnswer !== undefined && liveAnswer.content !== '' && liveAnswer.thinking !== undefined) {
    liveProcess = [
      ...liveProcess,
      {
        ...liveAnswer,
        id: `${liveAnswer.id}-thinking`,
        content: '',
        usage: undefined,
        durationMs: undefined
      }
    ]
    liveAnswer = { ...liveAnswer, thinking: undefined }
  }
  // 终答开流且有过程可收 → 头条模式（过程即时折叠，工作中态头条）；否则过程
  // 摊开直播 + 底部工作中行（等首轮 delta / 思考直播 / 工具执行 / 轮间往返）。
  // 若正文后又来工具调用（正文其实是中间段），占位被封段 → 回到直播态重新摊开
  const answerStarted = liveAnswer !== undefined && liveAnswer.content !== ''
  const headerMode = phase === 'live' && answerStarted && liveProcess.length > 0
  // 零内容组的 done 相位不渲染过程件（D9 截断的副产物：压缩条把回合拆成
  // [user|空组] + [续组]，空组只剩用户泡 —— D8"纯文本恒挂头条"落在它头上
  // 就是凭空的「已工作」空壳，验收实测双头条）。live 例外：乐观消息刚上屏
  // 的工作中行还得有；stopped/failed 不走此路 —— 零产出的中止/失败头条
  // 是有效信息，保留
  if (turn.items.length === 0 && phase === 'done') {
    return turn.user !== undefined ? (
      <MessageScrollerItem messageId={turn.user.id}>
        <MessageRow message={turn.user} />
      </MessageScrollerItem>
    ) : null
  }
  return (
    <>
      {turn.user !== undefined && (
        <MessageScrollerItem messageId={turn.user.id}>
          <MessageRow message={turn.user} />
        </MessageScrollerItem>
      )}
      {headerMode ? (
        <>
          <RunTrace phase="live" startTs={turn.user?.timestamp ?? turn.startedAt ?? Date.now()}>
            {liveProcess.map((item) => (
              <MessageScrollerItem key={item.id} messageId={item.id}>
                <ProcessItem item={item} />
              </MessageScrollerItem>
            ))}
          </RunTrace>
          {liveAnswer !== undefined && (
            <MessageScrollerItem messageId={liveAnswer.id}>
              <MessageRow message={liveAnswer} />
            </MessageScrollerItem>
          )}
        </>
      ) : phase === 'live' ? (
        // 进行中（D3）：过程摊开直播，流式占位在输出位置，底部常驻工作中行
        <>
          {process.map((item) => (
            <MessageScrollerItem key={item.id} messageId={item.id}>
              <ProcessItem item={item} />
            </MessageScrollerItem>
          ))}
          {answer !== undefined && (
            <MessageScrollerItem messageId={answer.id}>
              <MessageRow message={answer} />
            </MessageScrollerItem>
          )}
          <WorkingLine startTs={turn.user?.timestamp ?? turn.startedAt ?? Date.now()} />
        </>
      ) : phase === 'done' && process.length === 0 ? (
        // 无过程回合（D8 修订 2026-11-11）：纯文本也恒挂「已工作」头条（ZCode
        // 实测对齐：无思考无工具的问候也显示"已工作 4 秒"—— 慢本身是信号，
        // 原"直出不挂条"让用户看着计时器数到 5s 后整行消失）；空过程体在
        // RunTrace 内退化为不可展开单行。统计行渲染**原文**（自带 usage/接口
        // 时长 —— 此分支没有聚合行，剥过的副本会丢统计，首验即栽过）
        <>
          <RunTrace phase="done" durationMs={turnDurationMs(turn)} />
          {answerOriginal !== undefined && (
            <MessageScrollerItem messageId={answerOriginal.id}>
              <MessageRow message={answerOriginal} />
            </MessageScrollerItem>
          )}
        </>
      ) : (
        // 终态（D2/D6）：过程收进头条折叠体，终答常驻，用量聚合一行。时长双口径
        // 并存（2026-11-11 用户定调）：头条墙钟 = 用户等了多久；统计行接口时长
        // = 模型净耗时（不含排队/引擎处理），两个数不冲突
        <>
          <RunTrace phase={phase} durationMs={turnDurationMs(turn)}>
            {process.map((item) => (
              <MessageScrollerItem key={item.id} messageId={item.id}>
                <ProcessItem item={item} />
              </MessageScrollerItem>
            ))}
          </RunTrace>
          {answer !== undefined && (
            <MessageScrollerItem messageId={answer.id}>
              <MessageRow message={answer} />
            </MessageScrollerItem>
          )}
          <UsageLine
            usage={sumUsage(turn.items)}
            durationMs={sumDurationMs(turn.items)}
            toolMs={sumToolMs(turn.items)}
          />
        </>
      )}
    </>
  )
}

/** 比较按项引用：groupTurns 每次渲染重建数组/回合对象，但历史回合的项引用
 *  稳定 —— 流式 delta 只让活动回合比较失败重渲染，历史回合全部短路 */
export const TurnGroup = memo(
  TurnGroupImpl,
  (prev, next) =>
    prev.phase === next.phase &&
    prev.turn.user === next.turn.user &&
    prev.turn.items.length === next.turn.items.length &&
    prev.turn.items.every((item, i) => item === next.turn.items[i])
)
