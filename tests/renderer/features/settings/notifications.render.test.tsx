/**
 * 通知分区渲染回归：三组结构齐全（通知/提醒方式/提示音），音量/音调滑杆
 * 在 DOM（曾报"没看见音量音色"——钉住渲染事实防回归）。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { NotificationsSection } from '@/features/settings/NotificationsSection'
import * as notifySound from '@/lib/notify'
import { useEngineStore } from '@/stores/engine'

const initialNotify = { ...useEngineStore.getState().notify }

// 桥接 stub：分区渲染只读 platform（判定系统设置行），动作方法点击时才用；
// 系统通知开关快照默认回「未知」（不亮黄牌分支另有隐性断言：标题无徽标）
vi.stubGlobal('cogent', {
  platform: 'win32',
  pickSoundFile: vi.fn().mockResolvedValue(null),
  clearSoundFile: vi.fn().mockResolvedValue({ ok: true }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  openNotificationSettings: vi.fn().mockResolvedValue(undefined),
  getSystemNotifyStatus: vi.fn().mockResolvedValue({ enabled: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  useEngineStore.setState({ notify: { ...initialNotify } })
})
afterEach(() => {
  useEngineStore.setState({ notify: initialNotify })
  vi.restoreAllMocks()
})

it('三组齐全：条件行、呈现开关、音量/音调滑杆与三类声音源行都在', () => {
  render(<NotificationsSection />)
  // 通知组
  expect(screen.getByRole('combobox', { name: '轮次完成通知' })).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: '权限请求通知' })).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: '等待回答通知' })).toBeInTheDocument()
  // 提醒方式组
  expect(screen.getByRole('switch', { name: '系统通知' })).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: '播放提示音' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '打开系统设置' })).toBeInTheDocument()
  // 提示音组：两滑杆（Root 是 role=group；拇指在 jsdom 不挂载——base-ui 需
  // 真实布局测量，视觉由真机验收）+ 三类声音源
  expect(screen.getByRole('group', { name: '提示音音量' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: '内置提示音音调' })).toBeInTheDocument()
  expect(screen.getAllByText('内置提示音')).toHaveLength(3)
  expect(screen.getAllByRole('button', { name: '试听' })).toHaveLength(3)
  expect(screen.getAllByRole('button', { name: '选择文件' })).toHaveLength(3)
})

it('说明默认音量为50%、音调为原音，默认状态的两个恢复按钮禁用', () => {
  render(<NotificationsSection />)
  expect(screen.getByText(/默认 50%/)).toBeInTheDocument()
  expect(screen.getByText(/默认原音/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '恢复默认音量' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '恢复默认音调' })).toBeDisabled()
})

it('试听加载或恢复输出失败时显示原因，不再无响应', async () => {
  const user = userEvent.setup()
  vi.spyOn(notifySound, 'playNotifySound').mockRejectedValueOnce(new Error('音频设备不可用'))
  const errorToast = vi.spyOn(toast, 'error').mockReturnValue('sound-error')
  render(<NotificationsSection />)
  await user.click(screen.getAllByRole('button', { name: '试听' })[0])
  expect(errorToast).toHaveBeenCalledExactlyOnceWith('无法播放提示音', { description: '音频设备不可用' })
})

it('文件来源按专用 IPC 的结果更新，清除失败仍保留已保存音源', async () => {
  const user = userEvent.setup()
  const managedFile = 'turn-done-45c63885-9749-4521-b552-77bdc8fff405-提示.wav'
  vi.mocked(window.cogent.pickSoundFile).mockResolvedValueOnce(managedFile)
  vi.mocked(window.cogent.clearSoundFile).mockRejectedValueOnce(new Error('配置文件不可写'))
  const errorToast = vi.spyOn(toast, 'error').mockReturnValue('sound-error')
  render(<NotificationsSection />)
  await user.click(screen.getAllByRole('button', { name: '选择文件' })[0])
  expect(screen.getByText('提示.wav')).toBeInTheDocument()
  expect(useEngineStore.getState().notify.turnDoneSoundFile).toBe(managedFile)
  await user.click(screen.getByRole('button', { name: /^恢复默认$/ }))
  expect(useEngineStore.getState().notify.turnDoneSoundFile).toBe(managedFile)
  expect(errorToast).toHaveBeenCalledWith('无法保存提示音设置', { description: '配置文件不可写' })
  await user.click(screen.getByRole('button', { name: /^恢复默认$/ }))
  expect(useEngineStore.getState().notify.turnDoneSoundFile).toBeNull()
  expect(window.cogent.saveSettings).not.toHaveBeenCalled()
})

it.each([
  { soundVolume: 0, soundPitch: 400 },
  { soundVolume: 1, soundPitch: 1200 }
])('修改到%j后，两项独立恢复并保存，不重置自定义音源或提醒条件', async (modified) => {
  const user = userEvent.setup()
  // 从滑杆已保存的修改状态进入，验证用户实际点击的恢复入口与写入载荷。
  const notify = {
    ...initialNotify,
    ...modified,
    turnDoneNotify: 'never' as const,
    turnDoneSoundFile: 'turn-done-custom.wav'
  }
  useEngineStore.setState({ notify })
  render(<NotificationsSection />)
  const volumeReset = screen.getByRole('button', { name: '恢复默认音量' })
  const pitchReset = screen.getByRole('button', { name: '恢复默认音调' })
  expect(volumeReset).toBeEnabled()
  expect(pitchReset).toBeEnabled()

  await user.click(volumeReset)
  expect(useEngineStore.getState().notify).toEqual({ ...notify, soundVolume: 0.5 })
  expect(window.cogent.saveSettings).toHaveBeenLastCalledWith({ soundVolume: 0.5 })
  expect(volumeReset).toBeDisabled()
  expect(pitchReset).toBeEnabled()

  await user.click(pitchReset)
  expect(useEngineStore.getState().notify).toEqual({ ...notify, soundVolume: 0.5, soundPitch: 660 })
  expect(window.cogent.saveSettings).toHaveBeenLastCalledWith({ soundPitch: 660 })
  expect(window.cogent.saveSettings).toHaveBeenCalledTimes(2)
  expect(pitchReset).toBeDisabled()
})
