/**
 * 「完全访问」启用确认弹窗（2026-11-11 用户验收定调，照参考图）—— 权限菜单
 * 选完全访问不再直接切换，先过这道危险确认闸门：
 *   警告图标 + 标题 / 说明 / 权限项卡片列表（图标 + 名称 + 一行描述，分隔线）
 *   / 风险提示小字 / 「我已了解风险」勾选门控（未勾时确认钮禁用）/ 取消 + 红色确认。
 *
 * 权限项只列**已落地**的能力（文件写 / 终端命令）；network 工具落地（pi借鉴
 * D10，批次 7 件 8）后在此补第三行「网络和应用」，菜单占位文案同批去掉 exec only。
 * 确认钮 destructive 红：这是危险动作的确认闸门语义（与权限菜单触发钮的
 * warning 琥珀强调 = 两个语境，后者是常态警示，D5 定调不变）。
 */
import { useEffect, useState } from 'react'
import { IconAlertTriangle, IconFolder, IconTerminal2 } from '@tabler/icons-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'

/** 权限项说明卡的一行：图标 + 名称 + 描述 */
function PermissionRow({
  icon: Icon,
  name,
  desc
}: {
  icon: typeof IconFolder
  name: string
  desc: string
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </div>
    </div>
  )
}

export function FullAccessConfirm({
  open,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 用户勾选风险确认并点「确认启用」；关闭弹窗由本组件自理 */
  onConfirm: () => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  // 每次打开重置勾选：风险确认不能跨次残留（上次勾过不代表这次想过脑）
  useEffect(() => {
    if (open) setAcknowledged(false)
  }, [open])

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md gap-0">
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle className="flex items-center gap-2.5">
            <IconAlertTriangle className="size-5 shrink-0 text-foreground" />
            要启用完全访问吗？
          </AlertDialogTitle>
          <AlertDialogDescription>
            启用后，任务可以直接执行以下操作，无需逐次请求你确认。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="mt-4 flex flex-col rounded-xl bg-muted">
          <PermissionRow
            icon={IconFolder}
            name="文件和文件夹"
            desc="读取、创建、修改和删除可访问的文件。"
          />
          <Separator className="bg-border/60" />
          <PermissionRow
            icon={IconTerminal2}
            name="终端命令"
            desc="运行命令、安装软件或修改系统配置。"
          />
        </div>

        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          这些操作可能造成数据丢失或泄露。请仅在信任任务内容时启用。你可以随时切回其他权限模式。
        </p>

        <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm">
          <Checkbox checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} />
          我已了解风险，并对自己的数据安全负责。
        </label>

        <AlertDialogFooter className="mt-5">
          <AlertDialogCancel size="sm">取消</AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={!acknowledged}
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            确认启用
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
