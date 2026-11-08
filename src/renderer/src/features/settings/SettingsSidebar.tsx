/**
 * content-sidebar 的设置页内容（UI 件 6，参考稿 ChatGPT 设置栏）：标题 +
 * 搜索框 + 三组分区列表（个人/集成/编码）。行样式与 HomeSidebar 同配方
 * （h-8 圆角行、黑 5% hover/active 软叠、图标 muted + 文字近黑）；选中分区
 * 走 settings store，点行切换，content-main 随之换占位标题。
 * 分区内容本身属后续件（data.ts 登记入口）；搜索只出形（过滤属后续件）。
 */
import { SETTINGS_GROUPS } from './data'
import { cn } from 'cn'
import { IconSearch } from '@tabler/icons-react'
import { useSettingsStore } from '@/stores/settings'

/** 行 hover / active 底色：黑 5% 软叠，active = 常驻 hover 色（全局规则） */
const ROW_HOVER = 'hover:bg-accent-foreground/5'
const ROW_ACTIVE = 'bg-accent-foreground/5'

export function SettingsSidebar() {
  const section = useSettingsStore((s) => s.section)
  const setSection = useSettingsStore((s) => s.setSection)

  return (
    <div className="flex h-full flex-col">
      {/* 头部：路由标题（与 HomeSidebar 同款 16px 粗体） */}
      <div className="flex h-12 shrink-0 items-center pl-4">
        <span className="text-[16px] font-semibold">设置</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* 搜索框：裸 input 手搭（input-group 原语内层 input 高 36px 撑破 32px
            容器还带聚焦 ring，弃用）—— 背景与下方列表 hover 同一黑 5% 软叠
            （alpha 叠侧栏底，非固定灰值），聚焦无 outline；过滤属后续件 */}
        <div className="flex h-8 items-center gap-2 rounded-full bg-accent-foreground/5 px-3">
          <IconSearch className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索"
            className="h-full w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder"
          />
        </div>

        {SETTINGS_GROUPS.map((group) => (
          <section key={group.label} className="mt-4 flex flex-col gap-0.5">
            {/* 分组标题：灰字，非按钮（与 HomeSidebar 分区标题同档 14px） */}
            <div className="flex h-7 items-center px-2 text-sm text-muted-foreground">
              {group.label}
            </div>
            {group.items.map(({ id, label, icon: Icon }) => {
              const active = section === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-foreground',
                    ROW_HOVER,
                    active && ROW_ACTIVE,
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{label}</span>
                </button>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
