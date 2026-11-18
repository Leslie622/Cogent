/**
 * 通知分区渲染回归：三组结构齐全（通知/提醒方式/提示音），音量/音调滑杆
 * 在 DOM（曾报"没看见音量音色"——钉住渲染事实防回归）。
 */
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NotificationsSection } from '@/features/settings/NotificationsSection'

// 桥接 stub：分区渲染只读 platform（判定系统设置行），动作方法点击时才用；
// 系统通知开关快照默认回「未知」（不亮黄牌分支另有隐性断言：标题无徽标）
vi.stubGlobal('cogent', {
  platform: 'win32',
  pickSoundFile: vi.fn().mockResolvedValue(null),
  clearSoundFile: vi.fn().mockResolvedValue({ ok: true }),
  openNotificationSettings: vi.fn().mockResolvedValue(undefined),
  getSystemNotifyStatus: vi.fn().mockResolvedValue({ enabled: null })
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
  expect(screen.getByRole('group', { name: '合成音基频' })).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '试听' })).toHaveLength(3)
  expect(screen.getAllByRole('button', { name: '选择文件' })).toHaveLength(3)
})
