/** 在临时存储根中通过真实注册器验证提示音提交与设置字段归属。 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  userData: vi.fn(),
  pickFile: vi.fn(),
  protocolHandle: vi.fn(),
  fetch: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: mocks.userData },
  ipcMain: { handle: (name: string, fn: (event: unknown, payload: unknown) => unknown) => mocks.handlers.set(name, fn) },
  dialog: { showOpenDialog: mocks.pickFile },
  protocol: { handle: mocks.protocolHandle },
  net: { fetch: mocks.fetch }
}))
import { readSettingsFile, registerSettingsIpc } from '../../../src/electron/main/ipc/settings'
import { registerNotifyIpc } from '../../../src/electron/main/notifications'

let root: string
let previousRoot: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  previousRoot = process.env.COGENT_HOME
  root = mkdtempSync(join(tmpdir(), 'cogent-notify-test-'))
  process.env.COGENT_HOME = root
  mocks.userData.mockReturnValue(join(root, 'legacy-profile'))
  registerSettingsIpc()
  registerNotifyIpc({ getWindow: () => null })
})
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGENT_HOME
  else process.env.COGENT_HOME = previousRoot
  rmSync(root, { recursive: true, force: true })
})

const invoke = (name: string, payload: unknown): unknown => mocks.handlers.get(name)!({}, payload)

it('普通设置拒绝非本通道字段，合法偏好保留其他所有者的设置', () => {
  const settingsPath = join(root, 'settings.json')
  const options = { version: 1, turnDoneSoundFile: 'turn-done-旧音.wav', externalMcp: { enabled: true, allowWrites: false } }
  writeFileSync(settingsPath, JSON.stringify(options))
  expect(invoke(IPC.settingsSave, { soundVolume: 0.2 })).toEqual({ ok: true })
  expect(readSettingsFile()).toMatchObject({ ...options, soundVolume: 0.2 })
  const previous = readFileSync(settingsPath, 'utf8')
  for (const field of ['turnDoneSoundFile', 'externalMcp', 'fileEditor']) {
    expect(() => invoke(IPC.settingsSave, { soundVolume: 0.8, [field]: 'selected' })).toThrow()
    expect(readFileSync(settingsPath, 'utf8')).toBe(previous)
  }
})

it('同名文件重新选择换播放版本，失败保留当前音源，恢复默认后一并清理', async () => {
  const source = join(root, '提示.wav')
  const sounds = join(root, 'sounds')
  writeFileSync(source, '第一次')
  mocks.pickFile.mockResolvedValue({ canceled: false, filePaths: [source] })
  const first = await invoke(IPC.soundPickFile, 'approval') as string
  expect(readSettingsFile().approvalSoundFile).toBe(first)
  expect(readFileSync(join(sounds, first), 'utf8')).toBe('第一次')

  writeFileSync(source, '同名新文件')
  const second = await invoke(IPC.soundPickFile, 'approval') as string
  expect(second).not.toBe(first)
  expect(readSettingsFile().approvalSoundFile).toBe(second)
  expect(readdirSync(sounds)).toEqual([second])
  const protocolHandler = mocks.protocolHandle.mock.calls[0][1] as (request: Request) => Response
  const address = (name: string) => new Request('cogent-sound://local/' + encodeURIComponent(name))
  mocks.fetch.mockReturnValue(new Response('声音'))
  expect(protocolHandler(address(second)).ok).toBe(true)
  expect(protocolHandler(address(first)).status).toBe(404)

  const blocked = join(root, 'settings.json.tmp')
  mkdirSync(blocked)
  await expect(invoke(IPC.soundPickFile, 'approval')).rejects.toThrow()
  expect(() => invoke(IPC.soundClearFile, 'approval')).toThrow()
  expect(readSettingsFile().approvalSoundFile).toBe(second)
  expect(readdirSync(sounds)).toEqual([second])
  rmSync(blocked, { recursive: true })
  expect(invoke(IPC.soundClearFile, 'approval')).toEqual({ ok: true })
  expect(readSettingsFile().approvalSoundFile).toBeUndefined()
  expect(readdirSync(sounds)).toEqual([])
})

// 入口身份合同由 trusted.test.ts 直接验证；本件保留各域参数与资源 owner 回归。
vi.mock('../../../src/electron/main/ipc/trusted', async () => {
  const { ipcMain } = await import('electron')
  return { handleTrusted: (...args: Parameters<typeof ipcMain.handle>) => ipcMain.handle(...args), registerTrustedContents: vi.fn(), checkCurrentCaller: vi.fn() }
})
