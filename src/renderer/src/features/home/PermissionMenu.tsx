/**
 * 权限模式菜单（审批交互升级 D4/D5，对照图 2）—— ChatComposer 底部工具行的
 * 「完全访问」钮升级为下拉菜单：
 *   三档真选项（计划模式 / 变更前确认 / 完全访问）+「自主模式」置灰占位
 *   （= 有风险的操作将询问 —— 需 exec/network 的风险分级才有料，现在实现只
 *   能是 ask 同义词，D4 拍板不提前实做）；完全访问与前三档分隔线分组（危险
 *   组隔离，照图 2）。
 *
 * 触发钮显当前模式名 + ⌄（D5）：完全访问态保持红色胶囊警示，其余态灰盾 +
 * 模式名。chat 态读写活动会话 permissionMode（引擎判定矩阵同一真源）；new
 * 态读写 home store 暂存位（undefined = 未选 → 显设置页默认，物化时同链）。
 */
import { IconCheck, IconChevronDown, IconClipboardList, IconShieldExclamation, IconShieldQuestion, IconSparkles } from '@tabler/icons-react'
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

/** 模式元数据：名称 / 图标 / 一行说明（菜单与触发钮共用） */
const MODES: Record<PermissionMode, { label: string; icon: typeof IconClipboardList; desc: string }> = {
  plan: { label: '计划模式', icon: IconClipboardList, desc: '只读：阅读与分析，不修改文件' },
  ask: { label: '变更前确认', icon: IconShieldQuestion, desc: '写入文件前询问你' },
  autonomous: {
    label: '自主模式',
    icon: IconSparkles,
    desc: '自动修改文件；命令执行前询问'
  },
  auto: { label: '完全访问', icon: IconShieldExclamation, desc: '无需确认，直接执行写操作' },
}

/** 菜单项：图标 + 名称 + 勾选（当前模式）+ 次行说明 */
function ModeItem({
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
      onSelect={() => onSelect(mode)}
      variant={mode === 'auto' ? 'warning' : 'default'}
      className="gap-2.5 py-2"
    >
      <Icon className="size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px]">{meta.label}</span>
        <span className="text-xs text-muted-foreground">{meta.desc}</span>
      </div>
      {mode === current && <IconCheck className="size-4 shrink-0" />}
    </DropdownMenuItem>
  )
}

export function PermissionMenu({ session }: { session: HomeSession }) {
  const setPermission = useChatStore((s) => s.setPermission)
  const sessionMode = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.permissionMode ?? 'ask'
  )
  const stagingMode = useHomeStore((s) =>
    s.session.kind === 'new' ? (s.session.permissionMode ?? undefined) : undefined
  )
  const defaultMode = useEngineStore((s) => s.defaultPermissionMode)
  // new 态显「暂存位 ?? 设置页默认」——未显式选择时菜单勾在默认档上，与物化
  // 链（chat store createSession）同一优先序，所见即所落
  const current: PermissionMode = session.kind === 'new' ? (stagingMode ?? defaultMode) : sessionMode

  const select = (mode: PermissionMode) => {
    const activeId = useChatStore.getState().activeSessionId
    if (session.kind === 'chat' && activeId !== null) {
      void setPermission(activeId, mode)
      return
    }
    useHomeStore.setState((s) =>
      s.session.kind === 'new' ? { session: { ...s.session, permissionMode: mode } } : s
    )
  }

  const TriggerIcon = MODES[current].icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          /* 触发钮无常态背景（含完全访问 —— 2026-11-11 用户定调，曾用红胶囊
            常驻底被推翻），仅 hover 出底；warning 琥珀 = 强调（警告非错误） */
          <Button
            variant="ghost"
            size="xs"
            className="ml-2 gap-1.5 px-2 text-[13px] text-warning has-[>svg]:px-2 hover:bg-accent-foreground/5 hover:text-warning"
            aria-label={`权限模式：${MODES[current].label}（打开菜单）`}
          />
        }
      >
        <TriggerIcon className="size-3.5" />
        {MODES[current].label}
        {/* 箭头不单独给色 —— 继承按钮 warning，与主体统一 */}
        <IconChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-64">
        <ModeItem mode="plan" current={current} onSelect={select} />
        <ModeItem mode="ask" current={current} onSelect={select} />
        {/* 自主模式（D6 定稿，2026-11-11 bash 落地即开）：文件写信任放行、
            exec 类逐次询问 —— 置灰占位的"exec/network 落地后启用"已兑现（network
            类工具落地后自动落进同一询问分支，无需再动这里） */}
        <ModeItem mode="autonomous" current={current} onSelect={select} />
        {/* 危险分组隔离（照图 2）：完全访问与前三档分隔线 */}
        <DropdownMenuSeparator />
        <ModeItem mode="auto" current={current} onSelect={select} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
