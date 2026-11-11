/**
 * 「选择项目」弹层（信息区空位接线，参考稿：搜索行 + 项目清单 + 新建项目行）。
 * 触发钮 = 信息区灰条里的「选择项目」/「项目名」胶囊（两态同组件：未选项目时
 * 出"选择项目"，已选时回显项目名、点开可**换绑**）；已选态胶囊 hover 时左侧
 * 文件夹图标原位渐变成灰底白 X 圆徽（嵌在钮内的 role=button span，stopPropagation
 * 拦触发器，点它 = 解绑 unbindProject：删绑定空脚手架会话 + 视图态回"无项目"，
 * **不是**删项目 —— 真删走侧栏「移除项目」）。
 *
 * 关键边界：协议里会话与项目的绑定只在 session.create 时可定（无改绑 method），
 * 所以"选项目"不是切视图态就完 —— 必须物化一个绑定会话，否则首条消息会发进
 * 未绑定的会话（串归属）。物化语义对齐侧栏 startNew（空会话复用防垃圾）：
 * 当前会话为空（无消息 + 未命名 + 无归属）→ 删掉再建绑定的；非空 → 直接新建。
 * 已有会话（kind:'chat'）打开弹层时不提供换绑 —— 协议无改绑能力，列了也做不到。
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores/project'
import { useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { ProjectDialog } from './ProjectDialog'

/** 行 hover 底：全局黑 5% 软叠配方（同侧栏行） */
const ROW_HOVER = 'hover:bg-accent-foreground/5'

/**
 * 把当前"新聊天进行中"的空脚手架会话换成绑定项目的新会话。
 * 空会话（无消息 + 未命名 + 无归属）直接删掉再建 —— 对齐侧栏 startNew 的
 * "不复用即不堆垃圾"语义；项目场景下空会话不可复用（归属不同，挂错项目）。
 */
async function rebindSessionToProject(projectId: string): Promise<void> {
  const chat = useChatStore.getState()
  const active = chat.sessions.find((s) => s.id === chat.activeSessionId)
  const scaffold =
    active !== undefined &&
    (chat.messagesBySession[active.id]?.length ?? 0) === 0 &&
    active.title === '新会话' &&
    active.projectId === undefined
  if (scaffold) {
    await chat.deleteSession(active.id)
  }
  await chat.createSession({ projectId })
  // 视图态跟着落：信息区回显从"选择项目"变项目名（同 startNewChat 的效果）
  const created = useChatStore.getState().activeSessionId
  if (created !== null) {
    useHomeStore.setState({ session: { kind: 'new', projectId } })
  }
}

/**
 * X 解绑（与 pick 相反的操作）：删掉选项目时物化的**绑定空脚手架会话**（绑定
 * 只在 session.create 时可定，留着它下条消息就串进该项目），视图态回"无项目"
 * —— 信息区回到「选择项目」。仅解绑不删项目：真删项目走侧栏「移除项目」
 * （引擎语义：项目没了会话落回"最近"）。
 * 会话已被发过消息/改过名时（非脚手架形态）X 不出现，本函数不会被走到；
 * 脚手架判定同 rebind 的口径 —— 消息空 + 未命名，归属必为本项目（该会话就是
 * 为绑定本项目而物化的）。
 */
async function unbindProject(): Promise<void> {
  const chat = useChatStore.getState()
  const active = chat.sessions.find((s) => s.id === chat.activeSessionId)
  if (
    active !== undefined &&
    (chat.messagesBySession[active.id]?.length ?? 0) === 0 &&
    active.title === '新会话' &&
    active.projectId !== undefined
  ) {
    await chat.deleteSession(active.id)
  }
  useHomeStore.setState({ session: { kind: 'new' } })
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
  /** 选中/换绑回调（组件内部先物化会话，再通知视图态） */
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
    // 先物化绑定会话（文件头的关键边界：绑定只在 session.create 时可定，
    // 空脚手架换绑防串归属），再通知视图态回显
    void rebindSessionToProject(id).then(() => {
      onProjectId(id)
      onAfterPick?.()
    })
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
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className={cn(
                'group gap-1.5 px-1.5 font-normal text-[13px] text-foreground',
                ROW_HOVER
              )}
              title={projectId !== undefined ? '更换项目' : '选择项目'}
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
              <span
                role="button"
                aria-label="移除该项目"
                title="移除该项目"
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

      {/* 新建项目流：创建成功 = 选中它（物化绑定会话，回到弹层原本的选中路径）。
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
