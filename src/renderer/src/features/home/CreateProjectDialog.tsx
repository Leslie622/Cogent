/**
 * 创建项目弹窗（参考稿两步流，计划 §3.5；2026-11-09 多目录 + 信任确认）：
 * ① 项目类型三选一卡片（本地默认选中，云端/远程禁选置灰 —— 引擎无对应能力，
 * 是终态不是占位）→ ② 命名 + 多目录列表（每行右 X 移除、底部「添加文件夹」行；
 * 协议 cwds: string[]，跨仓库项目 = 一个项目多根）→ 点「创建项目」出
 * 「信任这些文件夹吗」确认（参考稿流程；信任 = 真提交，取消 = 留在弹窗）。
 *
 * 卡片形态照参考稿：浅灰圆角卡、左上图标右上 radio 点（选中蓝环实心）。
 * 受控 open：入口在 HomeSidebar（项目分区「创建项目」钮）。
 */
import { useState } from 'react'
import {
  IconDeviceDesktop,
  IconFolder,
  IconFolderPlus,
  IconMessageChatbot,
  IconWorld,
  IconX,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useProjectStore } from '@/stores/project'

/** 第一步的三张类型卡（kind: 'cloud'/'remote' 本期禁选，见文件头） */
type ProjectKind = 'local' | 'cloud' | 'remote'
const KIND_CARDS: ReadonlyArray<{
  kind: ProjectKind
  icon: typeof IconDeviceDesktop
  title: string
  description: string
  disabled: boolean
}> = [
  {
    kind: 'cloud',
    icon: IconMessageChatbot,
    title: '云端',
    description: '无需设置即可梳理想法和任务',
    disabled: true
  },
  {
    kind: 'local',
    icon: IconDeviceDesktop,
    title: '本地',
    description: '在你的电脑上编辑、运行和测试文件',
    disabled: false
  },
  {
    kind: 'remote',
    icon: IconWorld,
    title: '远程',
    description: '选择已连接计算机上的文件夹',
    disabled: true
  }
]

/** 类型卡：button + role="radio"（不引 radio-group 原语，三张可选卡自足）。
    禁选卡 = div（不可点、无焦点），样式同卡但 muted + 空心灰点 */
function KindCard({
  card,
  selected,
  onSelect
}: {
  card: (typeof KIND_CARDS)[number]
  selected: boolean
  onSelect: (kind: ProjectKind) => void
}) {
  const Icon = card.icon
  const shell =
    'relative flex h-[148px] flex-col rounded-xl border bg-muted/60 p-4 text-left transition-colors'
  if (card.disabled) {
    return (
      <div className={cn(shell, 'border-transparent text-muted-foreground')} aria-disabled>
        <Icon className="size-5 text-muted-foreground/70" />
        <div className="mt-auto">
          <div className="text-sm font-medium">{card.title}</div>
          <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground/80">
            {card.description}
          </div>
        </div>
        {/* 禁选 radio 点：空心灰 */}
        <span className="absolute top-4 right-4 size-4 rounded-full border border-muted-foreground/50" />
      </div>
    )
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(card.kind)}
      className={cn(
        shell,
        'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        selected
          ? 'border-transparent bg-muted text-foreground'
          : 'border-transparent bg-muted/40 hover:bg-muted/70 text-foreground'
      )}
    >
      <Icon className="size-5 text-foreground" />
      <div className="mt-auto">
        <div className="text-sm font-medium">{card.title}</div>
        <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
          {card.description}
        </div>
      </div>
      {/* radio 点：选中 = 蓝环实心（参考稿样式），未选 = 空心灰 */}
      <span
        className={cn(
          'absolute top-4 right-4 flex size-4 items-center justify-center rounded-full',
          selected ? 'border-[1.5px] border-[#2563eb]' : 'border border-muted-foreground/50'
        )}
      >
        {selected && <span className="size-2 rounded-full bg-[#2563eb]" />}
      </span>
    </button>
  )
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功回调（侧栏借此展开新项目分区） */
  onCreated?: (projectId: string) => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  /** 已选工作区根目录列表（首个 = 主根；协议 cwds: string[]） */
  const [cwds, setCwds] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const create = useProjectStore((s) => s.create)

  const reset = () => {
    setStep(1)
    setName('')
    setCwds([])
    setConfirming(false)
    setSubmitting(false)
  }

  /** 唯一关闭口：reset + 关弹窗一起做。所有主动关闭（取消钮/信任取消/提交成功）
      都必须走这里 —— 此前取消钮直调 props.onOpenChange 绕过了 reset，关时 step
      停在 2，再开直接落第二步（跳过类型选择的 bug） */
  const close = () => {
    reset()
    onOpenChange(false)
  }

  const addDirectory = async () => {
    const dir = await window.cogent.pickDirectory()
    // 重复目录不重复加（协议允许但 UI 无意义）；替换列表保持选中顺序
    if (dir && !cwds.includes(dir)) setCwds([...cwds, dir])
  }

  /** 点「创建项目」→ 信任确认层（参考稿流程）；确认才真提交 */
  const submit = async () => {
    if (!name.trim() || cwds.length === 0 || submitting) return
    setSubmitting(true)
    try {
      const summary = await create(name, cwds)
      onCreated?.(summary.id)
      close()
    } finally {
      // 引擎报错（磁盘）时 stay：落 submitting 复位，错误经控制台可见
      // （目录经信任确认时都存在，常态失败路径极少）
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
        else onOpenChange(next)
      }}
    >
      {/* sm:max-w-xl 同变体反制 DialogContent 自带的 sm:max-w-md（裸 max-w-xl 压不住，
          两层弹窗会一样宽，见 UI布局.md 技术坑 1） */}
      <DialogContent className="sm:max-w-xl gap-5 rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">创建项目</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <>
            <div className="text-sm font-medium">项目类型</div>
            <div
              role="radiogroup"
              aria-label="项目类型"
              className="grid grid-cols-2 gap-3"
            >
              {KIND_CARDS.map((card) => (
                <KindCard
                  key={card.kind}
                  card={card}
                  // 本地默认选中（计划 §3.5）；云端/远程禁选进不了选中态
                  selected={card.kind === 'local'}
                  onSelect={() => {
                    if (!card.disabled) setStep(2)
                  }}
                />
              ))}
            </div>
            <DialogFooter>
              <Button
                className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90"
                onClick={() => setStep(2)}
              >
                下一步
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3">
              <IconFolder className="size-4 text-muted-foreground" />
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="项目名称"
                className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                autoFocus
              />
            </div>

            {/* 源文件夹（多目录，照参考图）：右上「此电脑」标 + 目录行列表
                （每行右 X 移除）+ 底部「添加文件夹」行 */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">源文件夹</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <IconDeviceDesktop className="size-3.5" />
                  此电脑
                </span>
              </div>
              <div className="flex flex-col overflow-hidden rounded-xl bg-muted/40">
                {cwds.map((dir) => (
                  <div
                    key={dir}
                    className="group flex h-11 items-center gap-2.5 px-4 text-[13px] text-foreground"
                  >
                    <IconFolder className="size-4 shrink-0 text-muted-foreground" />
                    {/* basename 为主显示（参考图样式），title 悬停看全路径 */}
                    <span className="min-w-0 flex-1 truncate" title={dir}>
                      {dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir}
                    </span>
                    <button
                      type="button"
                      aria-label={`移除 ${dir}`}
                      onClick={() => setCwds(cwds.filter((d) => d !== dir))}
                      className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      <IconX className="size-4" />
                    </button>
                  </div>
                ))}
                {/* 添加文件夹行：整行可点（参考图底部行样式） */}
                <button
                  type="button"
                  onClick={() => void addDirectory()}
                  className={cn(
                    'flex h-11 items-center gap-2.5 px-4 text-[13px] text-foreground outline-none',
                    'hover:bg-accent-foreground/5 focus-visible:bg-accent-foreground/5'
                  )}
                >
                  <IconFolderPlus className="size-4 text-muted-foreground" />
                  添加文件夹
                </button>
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" className="text-muted-foreground" onClick={close}>
                取消
              </Button>
              <Button
                className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90"
                disabled={!name.trim() || cwds.length === 0 || submitting}
                onClick={() => setConfirming(true)}
              >
                创建项目
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>

      {/* 信任确认（参考图第二层弹窗）：列出全部目录；信任 = 真提交。
          只在第二步有内容时挂，避免空列表时出现 */}
      {step === 2 && confirming && (
        <TrustConfirmDialog
          cwds={cwds}
          onTrust={() => {
            setConfirming(false)
            void submit()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Dialog>
  )
}

/** 「信任这些文件夹吗」确认层（嵌套 Dialog，居中盖在创建弹窗上）：
    语义 = 用户显式扩大 Agent 的文件访问范围（参考图文案口径，产品名替换） */
function TrustConfirmDialog({
  cwds,
  onTrust,
  onCancel
}: {
  cwds: string[]
  onTrust: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      {/* sm:max-w-md 显式声明（恰好等于 DialogContent 默认值，但写明意图：
          信任层必须窄于外层 sm:max-w-xl 的创建弹窗） */}
      <DialogContent className="sm:max-w-md gap-4 rounded-2xl [&>button]:hidden">
        <DialogHeader className="items-center">
          <DialogTitle className="text-xl font-bold">信任这些文件夹吗？</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-1">
          {cwds.map((dir) => (
            <div key={dir} className="max-w-full truncate text-[13px] text-foreground" title={dir}>
              {dir}
            </div>
          ))}
        </div>
        <p className="text-center text-[13px] leading-relaxed text-muted-foreground">
          Cogent 可以读取、编辑和运行这些文件夹中的文件。即使模型未发出请求，
          文件夹设置也可能触发代码自动运行。请仅在你信任列出的每个文件夹时继续。
        </p>
        <div className="flex flex-col gap-2">
          {/* 主钮：黑底白字整宽（参考图），focus ring 即蓝圈（键盘可达） */}
          <Button
            className="h-10 rounded-full bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={onTrust}
            autoFocus
          >
            信任文件夹
          </Button>
          <Button variant="ghost" className="h-10 rounded-full text-muted-foreground" onClick={onCancel}>
            取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
