/** 常规页的自动名称开关；Host 是真源，读取不回写，保存失败保留已提交的值。 */
import { useEffect, useState } from 'react'
import type { SessionTitleSettings as TitleSettings } from '@shared/session-title'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { unwrapIpcError } from '@/lib/ipc'
import { SettingsRow } from './SettingsParts'
import { SETTING_COPY } from './search/catalog'

export function SessionTitleSettings() {
  const [settings, setSettings] = useState<TitleSettings>()
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(true)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  // 首次异步回填直接静默落位，避免挂载后从 false → true 误播切换动画
  const [animatable, setAnimatable] = useState(false)

  useEffect(() => {
    let active = true
    setReading(true)
    void window.cogent.engineRequest('session.titleSettings.get', {}).then(
      (value) => { if (active) { setSettings(value); setError(undefined); setReading(false) } },
      (cause: unknown) => { if (active) { setError(unwrapIpcError(cause)); setReading(false) } }
    )
    return () => { active = false }
  }, [reload])

  useEffect(() => {
    if (settings === undefined || animatable) return
    const id = requestAnimationFrame(() => setAnimatable(true))
    return () => cancelAnimationFrame(id)
  }, [settings, animatable])

  const save = async (next: TitleSettings) => {
    setBusy(true)
    try { setSettings(await window.cogent.engineRequest('session.titleSettings.set', next)); setError(undefined) }
    catch (cause) { setError(unwrapIpcError(cause)) }
    finally { setBusy(false) }
  }

  return <>
    <SettingsRow
      searchId="general.auto-title"
      title={SETTING_COPY['general.auto-title'].title}
      desc={SETTING_COPY['general.auto-title'].desc}
    >
      <Switch
        aria-label="自动生成会话名称"
        checked={settings?.enabled ?? false}
        disabled={settings === undefined || reading || busy}
        className={animatable ? undefined : 'transition-none [&_[data-slot=switch-thumb]]:transition-none'}
        onCheckedChange={(enabled) => { void save({ enabled }) }}
      />
    </SettingsRow>
    {error !== undefined && <SettingsRow title={<span role="alert">{error}</span>}>
      <Button variant="outline" disabled={busy || reading} onClick={() => setReload((value) => value + 1)}>重新读取</Button>
    </SettingsRow>}
  </>
}
