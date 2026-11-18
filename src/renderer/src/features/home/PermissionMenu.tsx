/**
 * 权限模式菜单 + 计划开关项（正交开关 v3，docs/模块/审批与权限.md）——
 * ChatComposer 底部工具行的权限下拉：
 *   顶部「计划模式」toggle 项（勾选 = 开关开启，与外置 PlanToggle chip 同源
 *   同动作）；其下分割线隔开三个真档（计划是正交开关不占档位，线从原
 *   「完全访问上面」挪来 —— 隔的是开关组与档位组两种交互语义，2026-11-16
 *   用户定调）；三档单选（变更前确认 / 自主模式 / 完全访问，warning 琥珀保留）。
 *
 * 触发钮显当前档名 + ⌄：完全访问 warning 琥珀、自主模式 chrome-accent、
 * 其余灰。chat 态读写活动会话 permissionMode（引擎判定矩阵同一真源）；new
 * 态读写 home store 暂存位（undefined = 未选 → 显设置页默认，物化时同链）。
 */
import { useState } from 'react'
import { IconCheck, IconChevronDown, IconClipboardList, IconShieldExclamation, IconShieldQuestion, IconSparkles } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PermissionMode } from '@/env.d'
import { useEngineStore } from '@/stores/engine'
import { useHomeStore, type HomeSession } from '@/stores/home'
import { useChatStore } from '@/stores/chat'
import { FullAccessConfirm } from './FullAccessConfirm'

/** 档位元数据：名称 / 图标 / 一行说明 —— 全 app 档位呈现的单一视觉真源
    （权限菜单本体 + 审批面板的 SwitchModeDropdown 档位下拉共用；计划是
    正交开关不在此表，见 PlanItem） */
export const MODES: Record<PermissionMode, { label: string; icon: typeof IconClipboardList; desc: string }> = {
  ask: { label: '变更前确认', icon: IconShieldQuestion, desc: '写入文件前询问你' },
  autonomous: {
    label: '自主模式',
    icon: IconSparkles,
    desc: '自动修改文件；命令执行前询问'
  },
  auto: { label: '完全访问', icon: IconShieldExclamation, desc: '无需确认，直接执行写操作' },
}

/** 菜单项：图标 + 名称 + 勾选（当前模式）+ 次行说明 —— 导出给
    SwitchModeDropdown 共用，档位呈现只此一份实现 */
export function ModeItem({
  mode,
  current,
  onSelect,
}: {
  mode: PermissionMode
  current: PermissionMode
  onSelect: (mode: PermissionMode) => void
}) {
  const meta = MODES[mode]
  const Icon = meta.icon
  return (
    /* 完全访问的强调 = 警告（warning 琥珀）非错误（2026-11-11 用户定调，曾用
       destructive 红）—— 用原语 warning 变体在 item 层声明：focus 高亮的
       通配黑染会压掉子元素自定义色，变体级才能在 hover 下保持琥珀 */
    <DropdownMenuItem
      /* 事件必须挂 onClick：本组件树是 base-luma（Base UI 原语），MenuItem
         没有 Radix 的 onSelect 语义 —— onSelect 会静默落到 DOM 原生 select
         事件（只在输入框选中文本时触发），菜单项点击永远不响应（验收实录：
         整个权限菜单点了没反应）。项目内其他菜单（ModelMenu/HomeSidebar）
         均用 onClick */
      onClick={() => onSelect(mode)}
      variant={mode === 'auto' ? 'warning' : 'default'}
      className="gap-2.5 py-2"
    >
      {/* 图标 size-4.5（2026-11-11 用户定调两轮：16 太小、20 太大，18px 定稿）。
          strokeWidth 2.25：18px 下默认描边仅 ~1.5px，盾牌/星光的细曲线在
          Windows 缩放分数像素上靠抗锯齿渲染显"锯齿"——加粗一档让曲线立得住
          （Filled 变体更 crisp 但两个盾牌无实心版，混用粗细不一，不取） */}
      <Icon className="size-4.5 shrink-0" strokeWidth={2.25} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px]">{meta.label}</span>
        <span className="text-xs text-muted-foreground">{meta.desc}</span>
      </div>
      {mode === current && <IconCheck className="size-4 shrink-0" />}
    </DropdownMenuItem>
  )
}

/** 计划开关项（菜单内入口，与外置 PlanToggle chip 同数据源同动作）：
    勾选 = 开关开启（toggle 语义，非档位单选） */
function PlanItem({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <DropdownMenuItem onClick={onToggle} className="gap-2.5 py-2">
      <IconClipboardList className="size-4.5 shrink-0" strokeWidth={2.25} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px]">计划模式</span>
        <span className="text-xs text-muted-foreground">
          {active ? '开启中：只读约束生效' : '只读：阅读与分析，不修改文件'}
        </span>
      </div>
      {active && <IconCheck className="size-4 shrink-0" />}
    </DropdownMenuItem>
  )
}

export function PermissionMenu({ session }: { session: HomeSession }) {
  const setPermission = useChatStore((s) => s.setPermission)
  const setPlanMode = useChatStore((s) => s.setPlanMode)
  const sessionMode = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.permissionMode ?? 'ask'
  )
  const sessionPlanOn = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.planEnabled === true
  )
  const stagingMode = useHomeStore((s) =>
    s.session.kind === 'new' ? (s.session.permissionMode ?? undefined) : undefined
  )
  const stagingPlanOn = useHomeStore((s) =>
    s.session.kind === 'new' ? s.session.planEnabled === true : false
  )
  const defaultMode = useEngineStore((s) => s.defaultPermissionMode)
  // new 态显「暂存位 ?? 设置页默认」——未显式选择时菜单勾在默认档上，与物化
  // 链（chat store createSession）同一优先序，所见即所落
  const current: PermissionMode = session.kind === 'new' ? (stagingMode ?? defaultMode) : sessionMode
  const planOn = session.kind === 'new' ? stagingPlanOn : sessionPlanOn

  /** 完全访问确认弹窗开合（2026-11-11 用户验收定调）：选 auto 先过危险确认闸门 */
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)

  const applyMode = (mode: PermissionMode) => {
    const activeId = useChatStore.getState().activeSessionId
    if (session.kind === 'chat' && activeId !== null) {
      void setPermission(activeId, mode)
      return
    }
    useHomeStore.setState((s) =>
      s.session.kind === 'new' ? { session: { ...s.session, permissionMode: mode } } : s
    )
  }

  const select = (mode: PermissionMode) => {
    // 点当前档 = 无操作（含已是完全访问再点：不弹闸门也不发幂等 IPC）
    if (mode === current) return
    // 切完全访问先过危险确认闸门
    if (mode === 'auto') {
      setConfirmingFullAccess(true)
      return
    }
    applyMode(mode)
  }

  /** 计划开关（toggle 语义）：与外置 PlanToggle chip 完全同路 —— chat 态走
      引擎 setPlanMode（session.summaryChanged 回流即联动），new 态翻暂存位 */
  const togglePlan = () => {
    const activeId = useChatStore.getState().activeSessionId
    if (session.kind === 'chat' && activeId !== null) {
      void setPlanMode(activeId, !planOn)
      return
    }
    useHomeStore.setState((s) =>
      s.session.kind === 'new' ? { session: { ...s.session, planEnabled: !planOn } } : s
    )
  }

  const TriggerIcon = MODES[current].icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
            /* 触发钮无常态背景（含完全访问 —— 2026-11-11 用户定调，曾用红胶囊
            常驻底被推翻），仅 hover 出底；配色按档位区分（2026-11-11 用户定调）：
            完全访问 = warning 琥珀（警告），自主模式 = chrome-accent 蓝（链接
            同款实色 token），变更前确认 = 灰；计划开关态由旁侧 PlanToggle chip
            常显，触发钮不重复表达。文字色一律实色 token */
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              // 内距压半（pl-2 pr-1 → 2026-11-16 三块紧凑定调）；ml 已删 ——
              // 与 + 钮的间距由 addon 的 gap-1 统一接管（曾 ml-2+gap-2 双层叠加）；
              // h-7：工具行统一 28px 高（2026-11-16 定调，曾 h-6 偏扁），圆角走
              // xs 档原生不覆写
              'h-7 gap-1.5 pl-2 pr-1 text-[13px] hover:bg-accent-foreground/5',
              current === 'auto'
                ? 'text-warning hover:text-warning'
                : current === 'autonomous'
                  ? 'text-chrome-accent hover:text-chrome-accent'
                  : 'text-muted-foreground hover:text-foreground'
            )}
            aria-label={`权限模式：${MODES[current].label}（打开菜单）`}
          />
        }
      >
        {/* 档位图标 17px（2026-11-16 与模型触发钮厂商标同步定 17；曾 size-4.5=18） */}
        <TriggerIcon className="size-[17px]" strokeWidth={2.25} />
        <span className="composer-label">{MODES[current].label}</span>
        {/* 箭头不单独给色 —— 继承按钮主体色，与主体统一；随主体大一号（14→15px） */}
        <IconChevronDown className="composer-chevron size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-64">
        {/* 计划开关置顶（toggle 语义）；分割线隔开开关组与档位组 —— 线从原
            「完全访问上面」挪来（2026-11-16 用户定调） */}
        <PlanItem active={planOn} onToggle={togglePlan} />
        <DropdownMenuSeparator />
        <ModeItem mode="ask" current={current} onSelect={select} />
        {/* 自主模式（D6 定稿）：文件写信任放行、exec 类逐次询问 */}
        <ModeItem mode="autonomous" current={current} onSelect={select} />
        {/* 完全访问 warning 琥珀（颜色警示与分割线分家） */}
        <ModeItem mode="auto" current={current} onSelect={select} />
      </DropdownMenuContent>
      <FullAccessConfirm
        open={confirmingFullAccess}
        onOpenChange={setConfirmingFullAccess}
        onConfirm={() => applyMode('auto')}
      />
    </DropdownMenu>
  )
}
