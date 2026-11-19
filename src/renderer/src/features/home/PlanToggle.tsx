/**
 * 计划模式外置 chip（正交开关 v3，docs/模块/审批与权限.md）——
 * **只在开关开启时渲染**（非计划态不显示 chip，开启入口 = 权限菜单顶部
 * 开关项；关闭入口 = 本 chip hover 浮现的 ×，2026-11-16 用户定调，zcode
 * 「💡 计划」点亮态同款）：点亮 = 计划中（只读约束生效），不用点开菜单
 * 即见。与菜单开关项同数据源（summary.planEnabled，session.summaryChanged
 * 回流）同动作（setPlanMode），双入口天然同步 —— 组件只做状态呈现与
 * 关闭触发。chip 左侧竖向分隔线把「档位区」与「计划状态区」隔开
 * （与 chip 同生同灭）。
 */
import { IconClipboardList, IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useHomeStore, type HomeSession } from '@/stores/home'
import { useChatStore } from '@/stores/chat'

export function PlanToggle({ session }: { session: HomeSession }) {
  const setPlanMode = useChatStore((s) => s.setPlanMode)
  const sessionPlanOn = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.planEnabled === true
  )
  const stagingPlanOn = useHomeStore((s) =>
    s.session.kind === 'new' ? s.session.planEnabled === true : false
  )
  const planOn = session.kind === 'new' ? stagingPlanOn : sessionPlanOn
  // 非计划态整组不渲染（分隔线与 chip 同生同灭）—— 开启走菜单开关项
  if (!planOn) return null

  const close = () => {
    const activeId = useChatStore.getState().activeSessionId
    if (session.kind === 'chat' && activeId !== null) {
      void setPlanMode(activeId, false)
      return
    }
    useHomeStore.getState().updateNewChat({ planEnabled: false })
  }

  /* 视觉规范同权限触发钮（ghost 无常态底 + hover 出底；文字色 =
     muted-foreground 浅灰 —— 2026-11-16 用户定调两轮：不要蓝强调、
     不要主前景色，与 ask 档触发钮同级的浅灰）。
   × 关闭钮 hover 浮现（group 控制透明度过渡，不占布局位）。
   分隔线：h-4 矮线居中（Separator 组件的 self-stretch 会撑满行高且
   data 变体类覆盖不掉 —— 固定矮高度是本处形态，直接裸 span，同色 token） */
  return (
    <>
      <span aria-hidden className="h-4 w-px shrink-0 self-center bg-border" />
      <Hint tip="计划模式开启中" side="top">
        <Button
          variant="ghost"
          size="xs"
          aria-label="关闭计划模式"
          onClick={close}
          className={cn(
            // pl-1：左内距压半（8→4px）—— 与分隔线/权限钮组的收紧（三块紧凑）；
            // h-7：工具行统一 28px 高（2026-11-16 定调），圆角走 xs 档原生不覆写
            'group h-7 gap-1.5 pl-1 pr-2 text-xs text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground'
          )}
        >
          <IconClipboardList className="size-4.5" strokeWidth={2.25} />
          <span className="composer-label">计划</span>
          <IconX
            className="composer-chevron size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="关闭计划模式"
          />
        </Button>
      </Hint>
    </>
  )
}
