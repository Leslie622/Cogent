/** MCP 凭据只加密落盘；加密或提交失败不得污染已发布状态。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { cipher, commit } = vi.hoisted(() => ({
  cipher: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'keychain'),
    encryptString: vi.fn((text: string) => Buffer.from(`cipher:${text}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice(7))
  }, commit: vi.fn()
}))
vi.mock('electron', () => ({ safeStorage: cipher }))
vi.mock('../../../../src/electron/main/storage-root', () => ({ storageRoot: () => '/unused', writeFileAtomic: commit }))
import { McpCredentialStore } from '../../../../src/electron/main/credentials/mcp-store'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cogent-mcp-store-'))
  vi.clearAllMocks()
  cipher.isEncryptionAvailable.mockReturnValue(true)
  cipher.getSelectedStorageBackend.mockReturnValue('keychain')
  cipher.encryptString.mockImplementation((text: string) => Buffer.from(`cipher:${text}`))
  cipher.decryptString.mockImplementation((value: Buffer) => value.toString().slice(7))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  commit.mockImplementation((path: string, content: string) => writeFileSync(path, content))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('仅OAuth状态加密往返，不持久化手动secret表', () => {
  const store = new McpCredentialStore(root)
  store.setOAuthState('server', { serverUrl: 'https://mcp.example', tokens: { access_token: 'synthetic-access-value' } })
  const file = readFileSync(join(root, 'mcp-credentials.json'), 'utf8')
  expect(file).not.toContain('synthetic-access-value')
  expect(JSON.parse(file)).not.toHaveProperty('secrets')
  expect(new McpCredentialStore(root).readAll()).toEqual(store.readAll())
  store.setOAuthState('server', undefined)
  expect(store.readAll()).toEqual({ oauthStates: {} })
  expect(store.status()).toEqual({ error: null })
})

it('写盘/加密失败保留旧OAuth状态；不可用及basic_text后端不写明文', () => {
  const store = new McpCredentialStore(root)
  store.setOAuthState('server', { serverUrl: 'https://mcp.example', token: 'old' })
  const previous = store.readAll()
  const file = readFileSync(join(root, 'mcp-credentials.json'), 'utf8')
  commit.mockImplementationOnce(() => { throw new Error('磁盘故障') })
  expect(() => store.setOAuthState('server', { token: 'new' })).toThrow('磁盘故障')
  expect(store.readAll()).toEqual(previous)
  cipher.encryptString.mockImplementationOnce(() => { throw new Error('加密故障') })
  expect(() => store.setOAuthState('missing', undefined)).toThrow('加密故障')
  expect(store.readAll()).toEqual(previous)
  cipher.isEncryptionAvailable.mockReturnValue(false)
  expect(() => store.setOAuthState('server', { token: 'new' })).toThrow('安全存储不可用')
  cipher.isEncryptionAvailable.mockReturnValue(true)
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  cipher.getSelectedStorageBackend.mockReturnValue('basic_text')
  expect(() => store.setOAuthState('server', { token: 'new' })).toThrow('安全存储不可用')
  expect(store.readAll()).toEqual(previous)
  expect(readFileSync(join(root, 'mcp-credentials.json'), 'utf8')).toBe(file)
})

it.each(['JSON非法', '形状损坏', '解密失败', '安全存储不可用', 'basic_text后端'])('%s降级空快照并保留诊断和原文件，显式保存成功才自愈', (failure) => {
  const path = join(root, 'mcp-credentials.json')
  const content = failure === 'JSON非法' ? '{not-json' : failure === '形状损坏' ? '{"version":1,"oauthStates":null}' :
    JSON.stringify({ version: 1, oauthStates: { old: Buffer.from('cipher:{"serverUrl":"https://old.example"}').toString('base64') } })
  writeFileSync(path, content)
  if (failure === '解密失败') cipher.decryptString.mockImplementationOnce(() => { throw new Error('DPAPI 解密失败') })
  if (failure === '安全存储不可用') cipher.isEncryptionAvailable.mockReturnValue(false)
  if (failure === 'basic_text后端') {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    cipher.getSelectedStorageBackend.mockReturnValue('basic_text')
  }
  const store = new McpCredentialStore(root)
  expect(store.readAll()).toEqual({ oauthStates: {} })
  expect(store.status().error).toEqual(expect.any(String))
  expect(console.error).toHaveBeenCalledWith('[main] MCP credential store degraded:', expect.any(String))
  expect(readFileSync(path, 'utf8')).toBe(content)
  expect(commit).not.toHaveBeenCalled()
  cipher.isEncryptionAvailable.mockReturnValue(true)
  cipher.getSelectedStorageBackend.mockReturnValue('keychain')
  commit.mockImplementationOnce(() => { throw new Error('磁盘故障') })
  expect(() => store.setOAuthState('new', { serverUrl: 'https://new.example' })).toThrow('磁盘故障')
  expect(store.readAll()).toEqual({ oauthStates: {} })
  expect(store.status().error).not.toBeNull()
  expect(readFileSync(path, 'utf8')).toBe(content)
  store.setOAuthState('new', { serverUrl: 'https://new.example' })
  expect(store.status()).toEqual({ error: null })
  expect(new McpCredentialStore(root).readAll()).toEqual({ oauthStates: { new: { serverUrl: 'https://new.example' } } })
  expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('secrets')
})

it('兼容旧版含secrets文件，只解密OAuth状态，读取不改原文件', () => {
  const path = join(root, 'mcp-credentials.json')
  const content = JSON.stringify({ version: 1, secrets: { OLD: 'inaccessible-obsolete-cipher' },
    oauthStates: { old: Buffer.from('cipher:{"serverUrl":"https://mcp.example"}').toString('base64') } })
  writeFileSync(path, content)
  const store = new McpCredentialStore(root)
  expect(store.readAll()).toEqual({ oauthStates: { old: { serverUrl: 'https://mcp.example' } } })
  expect(store.status().error).toBeNull()
  expect(cipher.decryptString).toHaveBeenCalledOnce()
  expect(readFileSync(path, 'utf8')).toBe(content)
  expect(commit).not.toHaveBeenCalled()
})

it('Windows不提供Linux backend API时仍能安全保存并读取OAuth状态', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const backend = cipher.getSelectedStorageBackend
  // 真实 Windows Electron 没有此方法，保留缺失形态验证平台分支。
  Object.defineProperty(cipher, 'getSelectedStorageBackend', { value: undefined, configurable: true, writable: true })
  try {
    const store = new McpCredentialStore(root)
    const state = { serverUrl: 'https://mcp.example', tokens: { access_token: 'windows-test-access' } }
    store.setOAuthState('windows', state)
    expect(new McpCredentialStore(root).readAll()).toEqual({ oauthStates: { windows: state } })
    expect(store.status().error).toBeNull()
    expect(readFileSync(join(root, 'mcp-credentials.json'), 'utf8')).not.toContain('windows-test-access')
    expect(cipher.isEncryptionAvailable).toHaveBeenCalled()
  } finally {
    Object.defineProperty(cipher, 'getSelectedStorageBackend', { value: backend, configurable: true, writable: true })
  }
})
