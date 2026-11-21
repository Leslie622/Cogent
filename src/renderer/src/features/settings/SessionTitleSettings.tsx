/** 常规页的标题策略编辑器；Host 是真源，读取不回写，保存失败保留已提交的值。 */
import { useEffect, useState } from 'react'
import type { SessionTitleSettings as TitleSettings } from '@shared/session-title'
import { useEngineStore, providerDisplayName } from '@/stores/engine'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { unwrapIpcError } from '@/lib/ipc'
import { SettingsRow } from './SettingsParts'

export function SessionTitleSettings() {
  const [settings, setSettings] = useState<TitleSettings>()
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(true)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const models = useEngineStore((state) => state.models)
  const providers = useEngineStore((state) => state.customProviders)
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
  const options = [{ value: '', label: '跟随对话模型' }, ...models.map((model) => ({
    value: JSON.stringify([model.provider, model.id]),
    label: `${providerDisplayName(model.provider, providers)} / ${model.id}`
  }))]
  const selected = settings?.model === undefined ? '' : JSON.stringify([settings.model.provider, settings.model.id])
  if (selected !== '' && !options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: `${settings!.model!.provider} / ${settings!.model!.id}（不可用）` })
  }
  return <>
    <SettingsRow title="自动生成会话名称" desc="根据第一条消息概括名称，会额外调用一次模型；手动命名优先。">
      <Switch aria-label="自动生成会话名称" checked={settings?.enabled ?? false} disabled={settings === undefined || reading || busy}
        onCheckedChange={(enabled) => { void save({ ...settings!, enabled }) }} />
    </SettingsRow>
    <SettingsRow title="标题模型" desc="仅用于后续新会话的名称生成，不改变对话模型。">
      <Select value={selected} items={options} disabled={settings === undefined || reading || busy || !settings.enabled}
        onValueChange={(value) => {
          if (value === null) return
          const choice = models.find((model) => JSON.stringify([model.provider, model.id]) === value)
          if (value !== '' && choice === undefined) return
          void save({ enabled: settings!.enabled, ...(choice !== undefined && { model: { provider: choice.provider, id: choice.id } }) })
        }}>
        <SelectTrigger aria-label="标题模型" className="w-60 max-w-full"><SelectValue /></SelectTrigger>
        <SelectContent align="end">{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </SettingsRow>
    {error !== undefined && <SettingsRow title={<span role="alert">{error}</span>}>
      <Button variant="outline" disabled={busy || reading} onClick={() => setReload((value) => value + 1)}>重新读取</Button>
    </SettingsRow>}
  </>
}
