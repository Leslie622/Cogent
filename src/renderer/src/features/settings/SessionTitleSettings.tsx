/** 常规页的自动名称开关；Host 是真源，读取不回写，保存失败保留已提交的值。 */
import { useEffect, useState } from 'react'
import type { SessionTitleSettings as TitleSettings } from '@shared/session-title'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { unwrapIpcError } from '@/lib/ipc'
import { SettingsRow } from './SettingsParts'

export function SessionTitleSettings() {
  const [settings, setSettings] = useState<TitleSettings>()
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(true)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setReading(true)
    void window.cogent.engineRequest('session.titleSettings.get', {}).then(
      (value) => { if (active) { setSettings(value); setError(undefined); setReading(false) } },
      (cause: unknown) => { if (active) { setError(unwrapIpcError(cause)); setReading(false) } }
    )
    return () => { active = false }
  }, [reload])
  const save = async (next: TitleSettings) => {
    setBusy(true)
    try { setSettings(await window.cogent.engineRequest('session.titleSettings.set', next)); setError(undefined) }
    catch (cause) { setError(unwrapIpcError(cause)) }
    finally { setBusy(false) }
  }
  return <>
    <SettingsRow title="自动生成会话名称" desc="根据第一条消息概括名称，会额外调用一次模型；手动命名优先。">
      <Switch aria-label="自动生成会话名称" checked={settings?.enabled ?? false} disabled={settings === undefined || reading || busy}
        onCheckedChange={(enabled) => { void save({ enabled }) }} />
    </SettingsRow>
    {error !== undefined && <SettingsRow title={<span role="alert">{error}</span>}>
      <Button variant="outline" disabled={busy || reading} onClick={() => setReload((value) => value + 1)}>重新读取</Button>
    </SettingsRow>}
  </>
}
