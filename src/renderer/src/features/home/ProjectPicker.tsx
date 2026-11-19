/**
 * 「选择项目」弹层（信息区空位接线，参考稿：搜索行 + 项目清单 + 新建项目行）。
 * 触发钮 = 信息区灰条里的「选择项目」/「项目名」胶囊（两态同组件：未选项目时
 * 出"选择项目"，已选时回显项目名、点开可**换绑**）；已选态胶囊 hover 时左侧
 * 文件夹图标原位渐变成灰底白 X 圆徽（嵌在钮内的 role=button span，stopPropagation
 * 拦触发器，点它只清除草稿的项目归属，项目本身由侧栏管理）。
 *
 * 项目只修改未发送草稿的归属；首条提交再随 session.create 落定，选择/解绑不建空会话。
 */
import { useMemo, useState } from 'react'
import {
  IconCheck,
  IconFolder,
  IconFolderPlus,
  IconSearch,
  IconXFilled,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Hint } from '@/components/Hint'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores/project'
import { useHomeStore } from '@/stores/home'
import { ProjectDialog } from './ProjectDialog'

/** 行 hover 底：全局黑 5% 软叠配方（同侧栏行） */
const ROW_HOVER = 'hover:bg-accent-foreground/5'

/** 解绑只改暂存归属，正文、附件与草稿身份继续保留。 */
function unbindProject(): void {
  useHomeStore.getState().updateNewChat({ projectId: undefined })
}

/** 弹层内项目行：folder 图标 + 名称，当前所在项目打勾（触发钮已回显名称时） */
function ProjectOption({
  name,
  active,
  onSelect
}: {
  name: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] text-foreground outline-none',
        ROW_HOVER,
        'focus-visible:bg-accent-foreground/5'
      )}
    >
      <IconFolder className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      {active && <IconCheck className="size-3.5 shrink-0 text-muted-foreground" />}
    </button>
  )
}

export function ProjectPicker({
  projectId,
  onProjectId,
  onAfterPick
}: {
  /** 当前绑定项目 id；undefined = 未选（触发钮显示"选择项目"） */
  projectId?: string
  /** 选中项目时更新同一草稿的归属 */
  onProjectId: (projectId: string) => void
  /** 选完（含新建项目流）后的收尾钩子：主流产品语义 = 选完即聚焦输入框 */
  onAfterPick?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 新建项目流：弹层内点「新建项目」→ 关弹层开创建弹窗（受控）
  const [createOpen, setCreateOpen] = useState(false)
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.load)

  // 搜索过滤：名称子串（大小写不敏感）；弹层每次打开重置输入
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return projects
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, query])

  const pick = (id: string) => {
    setOpen(false)
    // 首次提交才物化，选择项目只通知草稿所有者更新归属。
    onProjectId(id)
    onAfterPick?.()
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setQuery('')
            void loadProjects()
          }
        }}
      >
        {/* 单胶囊整钮（参考稿 1:1）：已选项目时 hover，左侧文件夹图标**原位**
            交叉渐变成灰底白 X 圆徽（两图标 absolute 叠放换透明度，同侧栏文件夹
            开/合手法，不换实例不闪动）；X 是嵌在触发钮里的 span 而非独立 button
            —— button 嵌 button 非法，点 X 时 stopPropagation 拦住冒泡（拦
            pointerdown + click 两路，base-ui 触发器两处都可能挂打开），只解绑
            不弹菜单 */}
        {/* Hint 必须包在 PopoverTrigger **外层**（base-ui 组合规则）：塞进 render
            里 Hint 不转发 children，胶囊图标/文字会被整个吞掉（实测翻车）；包在
            外层则 tooltip props 经 render 合并到触发钮上，两套触发行为共存 */}
        <Hint tip={projectId !== undefined ? '更换项目' : '选择项目'} side="top">
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className={cn(
                  'group gap-1.5 px-1.5 font-normal text-[13px] text-foreground',
                  ROW_HOVER
                )}
              />
            }
          >
            {/* 图标位 16px 定宽：span 包 svg 后 xs 变体的 has-[>svg]:px-1.5 不再
                命中（无直接 svg 子元素），padding 显式 px-1.5 保持原胶囊宽度 */}
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              <IconFolder
                className={cn(
                  'absolute inset-0 size-4 text-muted-foreground transition-opacity duration-150',
                  projectId !== undefined && 'group-hover:opacity-0'
                )}
              />
              {projectId !== undefined && (
                /* X 圆徽嵌在触发钮里（button 嵌 button 非法，见下方文件头注释），
                   内嵌 span 不能再包 Hint（tooltip trigger render 换元素会破坏
                   外层 popover 触发结构）—— 语义已由 aria-label 承载，悬停提示
                   不另加（hover 首帧 X 才浮现，弹气泡反而抢戏） */
                <span
                  role="button"
                  aria-label="移除该项目"
                  className="absolute inset-0 flex items-center justify-center rounded-full bg-muted-foreground text-background opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void unbindProject()
                  }}
                >
                  {/* 实心 X（IconXFilled）12px：① 描边 IconX 缩到 10px 笔画仅
                      0.83px，两条对角线抗锯齿落点不对称（\ 向碎成断点），视觉上
                      "不居中"（实心 fill 栅格化干净）；② 10px 下 IconXFilled 的
                      path 只覆盖 viewBox 56%，墨迹仅 6px 占圆 30% 太小——12px
                      墨迹占圆 38%（参考图 44%），且 12 设备像素（125% 缩放下
                      15px）栅格对称性实测完美（canvas 逐像素验证，中心与圆心
                      严格重合） */}
                  <IconXFilled className="size-3" />
                </span>
              )}
            </span>
            {projectId !== undefined
              ? (projects.find((p) => p.id === projectId)?.name ?? '')
              : '选择项目'}
          </PopoverTrigger>
        </Hint>
        {/* w-auto 覆写原语 w-72（锚点是小胶囊，菜单不必那么宽）；对齐参考稿圆角 */}
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-auto min-w-60 max-w-80 gap-1 rounded-2xl p-1.5"
        >
          {/* 搜索行：灰底胶囊，图标+输入；无独立确认，过滤即时生效 */}
          <div className="flex h-9 items-center gap-2 rounded-xl bg-muted/60 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目"
              className="h-full w-full min-w-0 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {filtered.map((project) => (
              <ProjectOption
                key={project.id}
                name={project.name}
                active={project.id === projectId}
                onSelect={() => pick(project.id)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[13px] text-muted-foreground">无匹配项目</div>
            )}
          </div>
          {/* 新建项目行：转入创建弹窗（两步流），建完经 onCreated 回到选择流 */}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setCreateOpen(true)
            }}
            className={cn(
              'flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] text-foreground outline-none',
              ROW_HOVER,
              'focus-visible:bg-accent-foreground/5'
            )}
          >
            <IconFolderPlus className="size-4 shrink-0 text-muted-foreground" />
            新建项目
          </button>
        </PopoverContent>
      </Popover>

      {/* 新建项目流：创建成功后选为当前草稿的项目，首条发送再绑定会话。
          取消/关闭时 createOpen 落 false，回到界面原状（弹层已关，无残留态） */}
      <ProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          onProjectId(id)
          onAfterPick?.()
        }}
      />
    </>
  )
}
