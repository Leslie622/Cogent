/**
 * API Key 字段（2026-11-10 从 ModelsSection.tsx 拆出）：自定义与内置 provider
 * 详情共用的密钥输入件。key 走 credentials 域单独通道（不走 saveProviders）：
 * 写 setApiKey / 读 getApiKey（全量回显），状态位走 listApiKeys（经 store 的
 * refreshKeys 同步给左侧清单状态点）。
 */
import { useEffect, useState } from 'react'
import { IconEye, IconEyeOff } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEngineStore } from '@/stores/engine'
import { FIELD_GAP, FIELD_LABEL } from './models-recipes'

/** API Key 字段：全量回显存量 key（挂载即经 credentials:get 拉入），默认密文态、
    点眼睛看明文 —— 眼睛钮 mousedown 不抢焦点，查看不打断输入。失焦/Enter 提交
    有变化的值，清空后提交 = 写空串 = 清除（credentials 链路 has() 按非空判定）。
    已配置 key 时标签行挂「清除」次要动作：走 removeApiKey 通道（壳侧落盘移除 +
    引擎内存表移除，env.d 注释定调的"清 key 正路"），比写空串多删一条落盘记录 */
export function ApiKeyField({ providerId }: { providerId: string }) {
  const [value, setValue] = useState('')
  const [committed, setCommitted] = useState('')
  const [show, setShow] = useState(false)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)

  useEffect(() => {
    void window.cogent.getApiKey(providerId).then((apiKey) => {
      setValue(apiKey)
      setCommitted(apiKey)
    })
  }, [providerId])

  const commit = async () => {
    const key = value.trim()
    if (key === committed) return
    await window.cogent.setApiKey(providerId, key)
    setCommitted(key)
    await refreshKeys()
  }

  /** 清除（仅已配置 key 时出现）：清空显示与提交基线 → removeApiKey 删记录 →
      刷状态位（左栏状态点随之下线）。不动 commit 路径 */
  const clear = async () => {
    setValue('')
    setCommitted('')
    await window.cogent.removeApiKey(providerId)
    await refreshKeys()
  }

  return (
    <div className={FIELD_GAP}>
      <div className="flex items-center justify-between">
        <label className={FIELD_LABEL}>API Key</label>
        {committed !== '' && (
          <Button
            variant="ghost"
            size="xs"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void clear()}
          >
            清除
          </Button>
        )}
      </div>
      <div className="relative mt-1.5">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => event.key === 'Enter' && void commit()}
          placeholder="输入 API Key"
          className="rounded-lg pr-9 text-[13px]"
          autoComplete="off"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShow((v) => !v)}
          aria-label={show ? '隐藏 Key' : '显示 Key'}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
        </button>
      </div>
    </div>
  )
}
