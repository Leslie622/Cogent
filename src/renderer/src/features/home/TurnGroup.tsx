/**
 * 回合分组与容器（ZCode 式两态呈现的装配层，见 docs/模块/消息呈现.md）：
 * store 的消息列表保持平铺（事件流逻辑不动），本件在渲染期按相邻关系分组 ——
 * 用户消息到下一用户消息 = 一个回合（run）。回合内两态：
 *   进行中：全部项（工具卡/中间正文/活跃占位）在同一平级列表按序直播（各行
 *   单行化，上方高度恒定），正文段 key 用回合内段序数（跨封段/跨终态稳定，
 *   见 docs/模块/消息呈现.md）+ 流内 WorkingLine；
 *   终态：过程收进 RunTrace 头条（已工作 Xs/已停止/出错了），末条有正文段 =
 *   终答常驻头条之下，用量聚合一行（过程展开时各段仍带自己的用量小字）。
 * 无过程回合（单段纯文本）也恒挂头条（D8 修订 2026-11-11，ZCode 对齐：
 * 慢本身是信号），只是过程体为空不可展开。
 * 切分/聚合全是纯函数；TurnGroup memo 按项引用比较 —— 流式 delta 只重渲染
 * 活动回合，历史回合零重渲染。
 */
import { memo, useMemo } from 'react'
import type { FileReference } from '@shared/files'
import { FileLink, FileLinkContext } from './files/FileLink'
import { literalFileTarget } from '@/lib/file-links'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { Reasoning } from '@/components/ui/reasoning'
import { RunTrace, WorkingLine } from '@/components/ui/run-trace'
import { ToolCard } from '@/components/ui/tool'
import type { ChatMessage, MessageUsage } from '@/env.d'
import type { MessageItem } from '@/stores/chat'
import { MessageRow, UsageLine } from './MessageRow'
import { ApprovalCard } from './ApprovalCard'
import { CompactionBar, PrunedBar } from './CompactionBar'
import { OutputCards } from './files/OutputCards'
import { useChatStore } from '@/stores/chat'

/** 回合（一问一答 + 其间全部过程项）；user 缺省 = 无提问头组（历史投影尾部
 *  前导的兜底组）。startedAt = 无 user 头组的墙钟起点（继承最近 user 的
 *  timestamp —— 不继承的话 turnDurationMs 无起点、头条只剩「已工作」没秒数）。
 *  压缩折叠条是**回合内的过程行**：不截断回合、不自成组
 *  —— 一条用户消息恒一个「已工作」头与一份总时长（bar 自成组曾被验收否决：
 *  一回合被多条 bar 切出多个工作头，形似多次独立工作） */
export interface ChatTurn {
  user?: ChatMessage
  items: MessageItem[]
  startedAt?: number
}

/** 渲染期分组：用户消息开新
 *  回合（user 存 turn.user 槽、不进 items），其后到下一用户消息前的项归本
 *  回合。压缩条分两形（判据 = bar 之后、下一 user 前是否还有工作项 ——
 *  轮间 bar 必然晚于上一轮收尾，时间比较分不出两形，只能向后看）：
 *  - **轮间自动压缩**（run 内 checkpoint / 恢复路 continue，之后还有轮次）
 *    → 行内过程条，按时间序插在过程流里（ProcessItem 的 compaction 分支）；
 *  - **回合外压缩**（手动「立即压缩」/ idle，之后直到下一 user 无工作项）
 *    → **独立成行**直接可见 —— 它不是该回合过程的一部分，塞进「已工作」
 *    折叠体等于把用户的显式动作藏起来。
 */
export function groupTurns(items: MessageItem[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let current: ChatTurn | undefined
  // 最近一次 user 的 timestamp：无头兜底组的墙钟起点
  let lastUserAt: number | undefined
  const isWorkItem = (x: MessageItem): boolean =>
    x.type === 'tool' || x.type === 'approval' || (x.type === undefined && x.role !== 'compaction' && x.role !== 'user')
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type === undefined && item.role === 'user') {
      lastUserAt = item.timestamp
      current = { user: item, items: [] }
      turns.push(current)
    } else if (item.type === undefined && item.role === 'compaction' && current !== undefined && current.items.length > 0) {
      // 向后看到下一个 user：还有工作项 = 轮间（行内）；没有 = 回合外（独立行）
      let hasWorkInTurn = false
      for (let j = i + 1; j < items.length; j++) {
        const next = items[j]
        if (next.type === undefined && next.role === 'user') break
        if (isWorkItem(next)) {
          hasWorkInTurn = true
          break
        }
      }
      if (!(item.compactionInRun ?? hasWorkInTurn)) {
        turns.push({ items: [item] })
        continue
      }
      current.items.push(item)
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

/** 回合相位：live覆盖当前运行，stopped/failed来自所属用户回合的已知终态。 */
export type TurnPhase = 'live' | 'done' | 'stopped' | 'failed'

/**
 * 过程 vs 终答切分（D2，仅终态相位使用 —— live 全项平铺，见 live 分支）：
 * 末条有正文的段 = 终答；answer 剥 thinking（归过程伪段）与 usage/durationMs
 * （回合聚合行与头条已表达，不双记）；answerOriginal 保留原文给**无过程直出
 * 分支** —— 该分支没有聚合行，自带用量/耗时不能丢。终答之后若还有工具项
 * （模型末轮只调工具没收尾的边角）留在过程体，顺序小让步。
 */
function splitTurn(
  items: MessageItem[]
): { process: MessageItem[]; answer?: ChatMessage; answerOriginal?: ChatMessage } {
  let answerRaw: ChatMessage | undefined
  let answerIndex = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    // 压缩条有 content（摘要）但不是回答 —— 行内条进过程流（D1 修订）
    if (item.type === undefined && item.role !== 'compaction' && item.content !== '') {
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
      usage: undefined
      // durationMs 保留：思考行的「持续了 Xs」尾标数据源
    })
  }
  return {
    process,
    answer: { ...answerRaw, thinking: undefined, usage: undefined, durationMs: undefined },
    answerOriginal: answerRaw
  }
}

/**
 * 回合墙钟时长（D5）：提问 timestamp → 回合收尾时刻。
 * 段 timestamp 是**请求开口径**（与历史回查对齐、重启不漂移），
 * 不再天然包含末段自身的模型耗时 —— 收尾 = 末段 timestamp + 该段
 * durationMs（无 durationMs 的旧数据退化为开口径）；末条是纯工具段时取
 * 工具卡 endedAt（执行收尾打点）。各段 durationMs 求和不含工具执行与
 * 轮间隙，会虚低，不用。无 user 头组（D9 压缩条截断的续组）用继承的
 * startedAt 起点 —— 墙钟口径不变："用户等了多久"
 */
function turnDurationMs(turn: ChatTurn): number | undefined {
  const start = turn.user?.timestamp ?? turn.startedAt
  if (start === undefined) return undefined
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i]
    if (item.type === 'tool') {
      if (item.endedAt !== undefined) return Math.max(item.endedAt - start, 0)
      continue
    }
    if (item.type === undefined) {
      // 压缩条跳过：run 后压缩的 bar 时间戳晚于末段（含摘要调用耗时），
      // 计入会把「已工作」撑到下一个 run 的边界 —— 压缩是记账不是工作
      if (item.role === 'compaction') continue
      return Math.max(item.timestamp + (item.durationMs ?? 0) - start, 0)
    }
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
const ProcessItem = memo(function ProcessItem({ item }: { item: MessageItem }) {
  if (item.type === 'tool') {
    return (
      <><ToolCard
        name={item.name}
        summary={item.summary}
        status={item.status}
        result={item.resultSummary}
        progress={item.progress}
        diff={item.diff}
      />
      {item.fileRefs?.map((ref) => <div className="ml-7" key={ref.path}><FileLink target={literalFileTarget(ref.path)}>{ref.path}</FileLink></div>)}
      </>
    )
  }
  if (item.type === 'approval') {
    return <ApprovalCard item={item} />
  }
  // 裁剪副行：折叠条同区的一行「已裁剪 N 处工具输出」
  if (item.type === 'pruned') {
    return <PrunedBar item={item} />
  }
  // 压缩条：回合内的过程行 —— 与工具卡同区，按时间序
  // 原位插在压缩发生的位置；折叠体收起时随过程一起藏（留痕在，展开可见）
  if (item.role === 'compaction') {
    return <CompactionBar message={item} />
  }
  if (item.content === '' && item.thinking !== undefined) {
    return <Reasoning text={item.thinking} running={false} durationMs={item.durationMs} />
  }
  return <MessageRow message={item} />
})

function TurnGroupBody({ turn, phase, stopping = false }: { turn: ChatTurn; phase: TurnPhase; stopping?: boolean }) {
  // 回合外压缩条独立行（手动「立即压缩」/idle，groupTurns 按「bar 之后
  // 无工作项」判出）：不套「已工作」头条/统计行 —— 那是一个 run 的语义，
  // 压缩不是 run，且它是用户的显式动作、要直接可见。组内可带 L1 prune
  // 副行（completed 手术一起插入）；其余项走 ProcessItem 兜底（无 user
  // 兜底组以 bar 开头的旧转录边角）
  const first = turn.items[0]
  if (turn.user === undefined && first.type === undefined && first.role === 'compaction') {
    return (
      <div className="flex flex-col gap-2">
        {turn.items.map((item) => (
          <MessageScrollerItem key={item.id} messageId={item.id}>
            {item.type === undefined && item.role === 'compaction' ? (
              <CompactionBar message={item} />
            ) : (
              <ProcessItem item={item} />
            )}
          </MessageScrollerItem>
        ))}
      </div>
    )
  }
  // 零内容组的 done 相位不渲染过程件（D9 截断的副产物：压缩条把回合拆成
  // [user|空组] + [续组]，空组只剩用户泡 —— D8"纯文本恒挂头条"落在它头上
  // 就是凭空的「已工作」空壳，验收实测双头条）。live 例外：乐观消息刚上屏
  // 的工作中行还得有；stopped/failed 不走此路 —— 零产出的中止/失败头条
  // 是有效信息，保留
  if (turn.items.length === 0 && phase === 'done') {
    return turn.user !== undefined ? (
      <><MessageScrollerItem messageId={turn.user.id}>
        <MessageRow message={turn.user} />
      </MessageScrollerItem><OutputCards /></>
    ) : null
  }
  // 段身份（渲染 key）：assistant 正文段用回合内段序数 —— live 占位的 id 是
  // renderer 自造 uuid，终态被权威快照整段替换后对不上；序数在两条来源间天然
  // 对齐（占位只在收到 delta 时建 = 段化只在有正文/思考时落段，flatten.ts）。
  // 封段只翻 placeholder、终态换 id，序数都不变：正文段跨封段零重挂，终答行
  // 跨终态保留旧 DOM（尾部渐显得以自然收完，见 turn-terminal 回归）。zcode
  // 对应物是协议 rowId（其轮/行 key 只依赖协议稳定 id）；工具/审批/裁剪/
  // 压缩条自带协议稳定 id（callId 等），直接用。
  let segmentSeq = 0
  const itemKeys = turn.items.map((item) =>
    item.type === undefined && item.role === 'assistant' ? `seg-${segmentSeq++}` : item.id
  )
  const tailKey = `seg-${segmentSeq - 1}`
  if (phase === 'live') {
    // 进行中：全部项（工具卡/中间正文/活跃占位）在同一平级列表按序直播（各行
    // 单行化，上方高度恒定）；工作中行留在内容流，短回复紧跟正文，阅读态也
    // 保留业务与布局源。正文段与封段后走同一渲染链（MessageScrollerItem +
    // MessageRow）：封段 = 原项翻 placeholder 留在原位 + 尾部追加新项，
    // key/父容器/位置三不变，正文行零重挂（计划/正文衔接连续性修复）。
    // 容器与终态折叠头**平级同款**（无导线缩进，2026-11-16 用户定调）：
    // ask_user 挂起会把 live 阶段拉得很长，相邻回合同屏时两态左缘必须
    // 逐像素一致（曾差 23px 即「图标没对齐」）—— 导线退役后两侧一同
    // 归 0，收尾翻折叠横向零位移的约束不变。中间正文段随之呈过程灰
    // （text-muted-foreground 继承）—— 过程语义本就如此，与终态折叠
    // 体内一致
    return (
      <>
        {turn.user !== undefined && (
          <MessageScrollerItem messageId={turn.user.id}>
            <MessageRow message={turn.user} />
          </MessageScrollerItem>
        )}
        <div className="flex min-w-0 flex-col gap-3">
          {turn.items.map((item, index) => (
            <MessageScrollerItem key={itemKeys[index]} messageId={item.id}>
              {item.type === undefined && item.role === 'assistant' ? (
                <MessageRow message={item} />
              ) : (
                <ProcessItem item={item} />
              )}
            </MessageScrollerItem>
          ))}
        </div>
        <OutputCards />
        <div data-slot="live-working-line-source">
          <WorkingLine startTs={turn.user?.timestamp ?? turn.startedAt ?? Date.now()} stopping={stopping} />
        </div>
      </>
    )
  }
  const { process, answer, answerOriginal } = splitTurn(turn.items)
  if (phase === 'done' && process.length === 0) {
    // 无过程回合（D8 修订 2026-11-11）：纯文本也恒挂「已工作」头条（ZCode
    // 实测对齐：无思考无工具的问候也显示"已工作 4 秒"—— 慢本身是信号，
    // 原"直出不挂条"让用户看着计时器数到 5s 后整行消失）；空过程体在
    // RunTrace 内退化为不可展开单行。统计行渲染**原文**（自带 usage/接口
    // 时长 —— 此分支没有聚合行，剥过的副本会丢统计，首验即栽过）
    return (
      <>
        {turn.user !== undefined && (
          <MessageScrollerItem messageId={turn.user.id}>
            <MessageRow message={turn.user} />
          </MessageScrollerItem>
        )}
        {/* 与 live 同一个平级容器 + 段 key 对齐 = 终答行跨终态保留旧 DOM；
            RunTrace 显式 key：容器子级在 live 是段/工具 key 数组，隐式位置
            匹配会有歧义 */}
        <div className="flex min-w-0 flex-col gap-3">
          <RunTrace key="trace" phase="done" durationMs={turnDurationMs(turn)} />
          {answerOriginal !== undefined && (
            <MessageScrollerItem key={tailKey} messageId={answerOriginal.id}>
              <MessageRow message={{ ...answerOriginal, usage: undefined, durationMs: undefined }} />
            </MessageScrollerItem>
          )}
        </div>
        <OutputCards />
        <UsageLine usage={answerOriginal?.usage} durationMs={answerOriginal?.durationMs} />
      </>
    )
  }
  // 终态（D2/D6）：过程收进头条折叠体，终答常驻，用量聚合一行。时长双口径
  // 并存（2026-11-11 用户定调）：头条墙钟 = 用户等了多久；统计行接口时长
  // = 模型净耗时（不含排队/引擎处理），两个数不冲突
  return (
    <>
      {turn.user !== undefined && (
        <MessageScrollerItem messageId={turn.user.id}>
          <MessageRow message={turn.user} />
        </MessageScrollerItem>
      )}
      <div className="flex min-w-0 flex-col gap-3">
        {/* 折叠体条目**不套** MessageScrollerItem：那会给每条挂
            content-visibility:auto —— 开合动画期间条目随裁切边缘进出
            渲染态、10rem 占位翻真实高度，grid 轨道分母（= 内容自然高度）
            被中途改动，收起动画肉眼卡顿（2026-11-16 用户实测，决定 17；
            zcode 折叠体同为纯 div）。定位/刻度无消费方：scrollToMessage
            只有索引刻度在调、目标恒为 user 消息（顶层另有包装） */}
        <RunTrace key="trace" phase={phase} durationMs={turnDurationMs(turn)}>
          {process.map((item) => (
            <ProcessItem key={item.id} item={item} />
          ))}
        </RunTrace>
        {answer !== undefined && (
          <MessageScrollerItem key={tailKey} messageId={answer.id}>
            <MessageRow message={answer} />
          </MessageScrollerItem>
        )}
      </div>
      <OutputCards />
      <UsageLine
        usage={sumUsage(turn.items)}
        durationMs={sumDurationMs(turn.items)}
        toolMs={sumToolMs(turn.items)}
      />
    </>
  )
}

/** 比较按项引用：groupTurns 每次渲染重建数组/回合对象，但历史回合的项引用
 *  稳定 —— 流式 delta 只让活动回合比较失败重渲染，历史回合全部短路 */
function TurnGroupImpl(props: { turn: ChatTurn; phase: TurnPhase; stopping?: boolean; sessionId?: string }) {
  const source = props.turn.items.find((item): item is ChatMessage => item.type === undefined && item.turnId !== undefined)
  const turnId = props.turn.user?.turnId ?? source?.turnId
  const outputs = useChatStore((state) => props.sessionId === undefined || turnId === undefined ? undefined : state.bySession[props.sessionId]?.outputs[turnId])
  const serialized = JSON.stringify([...props.turn.items.flatMap((item) => item.type === 'tool' ? item.fileRefs ?? [] : []), ...(outputs?.active ?? []).map((item) => ({ path: item.sourcePath, turnId }))])
  const refs = useMemo(() => JSON.parse(serialized) as FileReference[], [serialized])
  const scope = useMemo(() => props.sessionId === undefined ? null : { sessionId: props.sessionId, turnId, refs }, [props.sessionId, turnId, refs])
  return <FileLinkContext.Provider value={scope}><TurnGroupBody {...props} /></FileLinkContext.Provider>
}

export const TurnGroup = memo(
  TurnGroupImpl,
  (prev, next) =>
    prev.phase === next.phase &&
    prev.sessionId === next.sessionId &&
    prev.stopping === next.stopping &&
    prev.turn.user === next.turn.user &&
    prev.turn.items.length === next.turn.items.length &&
    prev.turn.items.every((item, i) => item === next.turn.items[i])
)
