/**
 * 「关闭窗口时」询问弹窗（closeBehavior=ask 的关窗入口，shell 级全局件）：
 * main 的 close 拦截器经 window:ask-close 点火，裁决（含取消）回传
 * window:confirm-close；勾「不再询问」时先把所选动作固化进 closeBehavior
 * （engine store 落盘 settings:save），main 只执行动作 —— 设置写入单一通道。
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useEngineStore } from '@/stores/engine'
import { getAppDisplayName } from '@shared/brand'

export function CloseAskDialog() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(
    () =>
      // main → renderer：close 拦截器要求询问（连点重入由 main 侧 asking 挡住，
      // 这里只管开窗；remember 每次重开都复位）
      window.cogent.onAskClose(() => {
        setRemember(false)
        setOpen(true)
      }),
    []
  )

  const answer = (action: 'minimize' | 'quit' | 'cancel'): void => {
    // 「不再询问」：固化所选动作，下次关窗 main 直接执行不再问
    if (action !== 'cancel' && remember) {
      useEngineStore.getState().setCloseBehavior(action)
    }
    setOpen(false)
    void window.cogent.confirmClose({ action, remember })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // ESC / 点遮罩 / 右上角关闭都走取消 —— 不回传会堵死 main 的询问态
        if (!next) answer('cancel')
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>关闭 {getAppDisplayName()}？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          「最小化」将保留在系统托盘（引擎继续运行），「退出」将结束应用。
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
            aria-label="不再询问"
          />
          不再询问
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer('cancel')}>
            取消
          </Button>
          <Button variant="outline" onClick={() => answer('quit')}>
            退出
          </Button>
          {/* 主钮给最小化（安全侧默认：不结束引擎、不丢运行中会话） */}
          <Button onClick={() => answer('minimize')}>最小化</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
