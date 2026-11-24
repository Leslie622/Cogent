/**
 * content-sidebar 的设置页内容：标题 + 搜索框 + 两分组分区列表（分组结构
 * 参考 zcode 设置栏，2026-11-15 用户指令：基础设置 / Agent 能力两组）。
 * 行样式与 HomeSidebar 同配方（h-8 圆角行、黑 5% hover/active 软叠、
 * 图标 muted + 文字近黑）；选中分区走 settings store，点行切换，
 * content-main 随之挂内容组件。
 */
import { SETTINGS_GROUPS } from './data'
import { cn } from 'cn'
import { IconSearch } from '@tabler/icons-react'
import { useSettingsStore } from '@/stores/settings'
import { useSidebarHoverPill } from '@/hooks/use-sidebar-hover-pill'

export function SettingsSidebar() {
  const section = useSettingsStore((s) => s.section)
  const setSection = useSettingsStore((s) => s.setSection)
  const { containerRef, pillRef } = useSidebarHoverPill()

  return (
    <div className="flex h-full flex-col">
      {/* 头部：路由标题（与 HomeSidebar 同款 16px 粗体） */}
      <div className="flex h-12 shrink-0 items-center pl-4">
        <span className="text-base font-semibold">设置</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* 搜索图标与原生输入共用软叠底色，不另加聚焦描边；过滤属后续件。
            圆角 lg 档（2026-11-20 用户定调）：与表单控件统一，弃胶囊。 */}
        <div className="flex h-8 items-center gap-2 rounded-lg bg-accent-foreground/5 px-3">
          <IconSearch className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索"
            className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
          />
        </div>

        <div ref={containerRef} className="relative">
          <div
            ref={pillRef}
            aria-hidden="true"
            data-visible="false"
            className="sidebar-hover-pill rounded-md bg-accent-foreground/5"
          />
          {SETTINGS_GROUPS.map((group) => (
            <section key={group.label} className="mt-4 flex flex-col gap-0.5">
              {/* 分组标题：灰字，非按钮（与 HomeSidebar 分区标题同档） */}
              <div className="flex h-7 items-center px-2 text-sm text-muted-foreground">
                {group.label}
              </div>
              {group.items.map(({ id, label, icon: Icon }) => {
                const active = section === id
                return (
                  <button
                    key={id}
                    type="button"
                    data-sidebar-row
                    data-active={active || undefined}
                    onClick={() => setSection(id)}
                    aria-current={active ? 'true' : undefined}
                    className="sidebar-row group relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-foreground"
                  >
                    <Icon
                      className={cn(
                        'sidebar-row-icon size-4 shrink-0 text-muted-foreground',
                        active && 'text-foreground'
                      )}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
