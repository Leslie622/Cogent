/**
 * 会话错误 toast（App 层挂一份）：对话区错误条退役（2026-11-20 用户定调，
 * 报错不进对话流），lastError 的呈现收口到这里 —— watch 活动会话的
 * runtime.lastError（run 失败与发送/续写/压缩/审批应答失败的共同落点），
 * null→文案 的跳变即失败发生时刻，弹错误 toast（呈现配方在
 * components/ui/sonner 的 showErrorToast：顶部居中、8s 自动消失、
 * 右侧 ghost 图标关闭钮）。
 * 同文案连续失败间必有清零（run 启动/完成即清 lastError），跳变判据
 * 覆盖全部路径不漏弹；切换会话不弹：带过来的历史 lastError 不是"刚发生"；
 * 非活动会话的失败不弹：本窗用户没在看它（事件多窗口广播，另一窗的活动
 * 会话自会弹）。
 */
import { useEffect, useRef } from 'react'
import { showErrorToast } from '@/components/ui/sonner'
import { selectLastError, useChatStore } from '@/stores/chat'

export function useErrorToast(): void {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const lastError = useChatStore(selectLastError)
  // 上次快照：sid 换档 = 切会话（历史错误不弹）；同 sid 下 error 变化 = 失败发生
  const seen = useRef<{ sid: string | null; error: string | null }>({ sid: activeSessionId, error: lastError })
  useEffect(() => {
    const prev = seen.current
    seen.current = { sid: activeSessionId, error: lastError }
    if (prev.sid !== activeSessionId) return
    if (lastError === null || prev.error === lastError) return
    showErrorToast(lastError)
  }, [activeSessionId, lastError])
}
