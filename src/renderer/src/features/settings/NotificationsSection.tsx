/**
 * 设置 · 通知分区：触发条件（何时提醒）× 呈现方式（toast/提示音）正交 ——
 * 见 docs/模块/通知与提醒.md。三组：
 *   通知（三行触发条件） / 提醒方式（两个呈现开关 + 系统设置跳转） /
 *   提示音（音量/音调 + 三类声音源：内置提示音或自定义文件）。
 * 全部真接线（engine store notify 域，落 settings.json）；试听复用
 * lib/notify 的播放器（同一代码路径，试听即真实效果）。
 */
import { useEffect, useState } from 'react'
import { IconArrowBackUp, IconVolume } from '@tabler/icons-react'
import { NOTIFY_SOUND_FILE_FIELDS } from '@shared/ipc'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { playNotifySound } from '@/lib/notify'
import { NOTIFY_SOUND_DEFAULTS, useEngineStore, type NotifyKind, type NotifyPatch } from '@/stores/engine'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'

const TURN_DONE_MODES: Array<{ value: 'always' | 'never' | 'unfocused'; label: string }> = [
  { value: 'always', label: '始终' },
  { value: 'never', label: '从不' },
  { value: 'unfocused', label: '仅在未聚焦时' }
]

/** 三类声音源行共用（kind 决定读哪个文件字段） */
function SoundFileRow({ kind, title, desc }: { kind: NotifyKind; title: string; desc: string }) {
  const file = useEngineStore((s) => s.notify[NOTIFY_SOUND_FILE_FIELDS[kind]])
  const setNotifySoundFile = useEngineStore((s) => s.setNotifySoundFile)
  const [saving, setSaving] = useState(false)
  // 显示原件名称；受管类别和缓存版本 ID 留在存储与播放链路。
  const name = file?.replace(/^(?:turn-done|approval|question)-(?:[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}-)?/i, '')

  const changeSource = async (clear: boolean): Promise<void> => {
    setSaving(true)
    try {
      if (clear) {
        await window.cogent.clearSoundFile(kind)
        setNotifySoundFile(kind, null)
      } else {
        const selected = await window.cogent.pickSoundFile(kind)
        if (selected !== null) setNotifySoundFile(kind, selected)
      }
    } catch (error) {
      toast.error('无法保存提示音设置', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }
  const preview = (): void => {
    void playNotifySound(useEngineStore.getState().notify, kind).catch((error: unknown) => {
      toast.error('无法播放提示音', { description: error instanceof Error ? error.message : String(error) })
    })
  }

  return (
    <SettingsRow title={title} desc={desc}>
      <div className="flex items-center gap-2">
        {/* 当前声音源：自定义文件名截断显示，缺省使用随应用分发的音频。 */}
        <span className="max-w-40 truncate text-xs text-muted-foreground">{name ?? '内置提示音'}</span>
        <Button variant="outline" size="default" disabled={saving} onClick={() => void changeSource(false)}>
          选择文件
        </Button>
        <Hint tip="试听">
          <Button variant="ghost" size="icon" onClick={preview} aria-label="试听">
            <IconVolume />
          </Button>
        </Hint>
        {file !== null && (
          <Button variant="ghost" size="default" disabled={saving} onClick={() => void changeSource(true)}>
            恢复默认
          </Button>
        )}
      </div>
    </SettingsRow>
  )
}

export function NotificationsSection() {
  const notify = useEngineStore((s) => s.notify)
  const setNotifySetting = useEngineStore((s) => s.setNotifySetting)
  const patch = (p: NotifyPatch): void => setNotifySetting(p)
  const isLinux = window.cogent.platform === 'linux'

  // 系统通知开关快照（OS 无变更事件）：进页查一次，改了系统设置重进刷新。
  // null（非 Windows/未知）不提示 —— 只在明确查到「已关」时亮黄牌
  const [systemNotifyOff, setSystemNotifyOff] = useState(false)
  useEffect(() => {
    void window.cogent.getSystemNotifyStatus().then((status) => {
      setSystemNotifyOff(status.enabled === false)
    })
  }, [])

  return (
    <SettingsPage title="通知">
      <SettingsGroup label="通知">
        <SettingsRow
          title="轮次完成通知"
          desc="设置 Agent 完成一轮后何时提醒你（失败同样按此提醒；自己中止不提醒）"
        >
          <Select
            value={notify.turnDoneNotify}
            items={TURN_DONE_MODES}
            onValueChange={(next) => {
              // base-ui 清选路径的类型宽度（null），静态三档不可达，丢弃
              if (next !== null) patch({ turnDoneNotify: next })
            }}
          >
            <SelectTrigger aria-label="轮次完成通知" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {TURN_DONE_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow title="权限请求通知" desc="Agent 需要授权才能继续时提醒你">
          <Switch
            checked={notify.approvalNotify}
            onCheckedChange={(approvalNotify) => patch({ approvalNotify })}
            aria-label="权限请求通知"
          />
        </SettingsRow>
        <SettingsRow title="等待回答通知" desc="Agent 等待你回答问题时提醒你">
          <Switch
            checked={notify.questionNotify}
            onCheckedChange={(questionNotify) => patch({ questionNotify })}
            aria-label="等待回答通知"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="提醒方式">
        <SettingsRow title="系统通知" desc="以系统通知（toast）呈现提醒，点击可回到窗口">
          <Switch
            checked={notify.toastEnabled}
            onCheckedChange={(toastEnabled) => patch({ toastEnabled })}
            aria-label="系统通知"
          />
        </SettingsRow>
        <SettingsRow title="播放提示音" desc="以应用内提示音呈现提醒（音源在下方「提示音」组配置）">
          <Switch
            checked={notify.soundEnabled}
            onCheckedChange={(soundEnabled) => patch({ soundEnabled })}
            aria-label="播放提示音"
          />
        </SettingsRow>
        {/* Linux 无统一通知设置入口（zcode 麦克风设置同款决定），整行不渲染 */}
        {!isLinux && (
          <SettingsRow
            title={
              systemNotifyOff ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  系统通知设置
                  {/* 黄牌：OS 无变更事件（快照），明确查到系统层关了才亮 */}
                  <span className="rounded bg-amber-100 px-1 py-px text-xs font-normal text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                    系统已关闭 Cogent 通知，请到系统设置中开启
                  </span>
                </span>
              ) : (
                '系统通知设置'
              )
            }
            desc="在系统中配置 Cogent 的通知行为（免打扰、横幅等）"
          >
            <Button
              variant="outline"
              size="default"
              onClick={() => void window.cogent.openNotificationSettings()}
            >
              打开系统设置
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup label="提示音">
        <SettingsRow
          title="音量"
          desc={`默认 ${Math.round(NOTIFY_SOUND_DEFAULTS.soundVolume * 100)}%，内置提示音与自定义文件共用`}
        >
          <div className="flex items-center gap-2">
            <Slider
              value={[Math.round(notify.soundVolume * 100)]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => patch({ soundVolume: v[0] / 100 })}
              className="w-40"
              aria-label="提示音音量"
              thumbAriaLabel="提示音音量"
            />
            <Hint tip="恢复默认音量">
              <Button
                variant="ghost"
                size="icon"
                disabled={notify.soundVolume === NOTIFY_SOUND_DEFAULTS.soundVolume}
                onClick={() => patch({ soundVolume: NOTIFY_SOUND_DEFAULTS.soundVolume })}
                aria-label="恢复默认音量"
              >
                <IconArrowBackUp />
              </Button>
            </Hint>
          </div>
        </SettingsRow>
        <SettingsRow title="音调" desc="默认原音，调节内置提示音的高低（自定义文件不受影响）">
          <div className="flex items-center gap-2">
            <Slider
              value={[notify.soundPitch]}
              min={400}
              max={1200}
              step={10}
              onValueChange={(v) => patch({ soundPitch: v[0] })}
              className="w-40"
              aria-label="内置提示音音调"
              thumbAriaLabel="内置提示音音调"
            />
            <Hint tip="恢复默认音调">
              <Button
                variant="ghost"
                size="icon"
                disabled={notify.soundPitch === NOTIFY_SOUND_DEFAULTS.soundPitch}
                onClick={() => patch({ soundPitch: NOTIFY_SOUND_DEFAULTS.soundPitch })}
                aria-label="恢复默认音调"
              >
                <IconArrowBackUp />
              </Button>
            </Hint>
          </div>
        </SettingsRow>
        <SoundFileRow kind="turn-done" title="轮次完成声音" desc="轮次完成/失败时的提示音" />
        <SoundFileRow kind="approval" title="权限请求声音" desc="等待授权时的提示音" />
        <SoundFileRow kind="question" title="等待回答声音" desc="等待回答时的提示音" />
      </SettingsGroup>
    </SettingsPage>
  )
}
