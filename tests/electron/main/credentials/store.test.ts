/** 加密和持久写入均可能失败；失败不能让进程缓存领先磁盘。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { files, encrypt, write } = vi.hoisted(() => ({
  files: new Map<string, string>(), encrypt: vi.fn((value: string) => Buffer.from(value)), write: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/profile' }, safeStorage: {
  isEncryptionAvailable: () => true, encryptString: encrypt, decryptString: (value: Buffer) => value.toString()
} }))
vi.mock('node:fs', () => ({ existsSync: (path: string) => files.has(path), readFileSync: (path: string) => files.get(path) }))
vi.mock('../../../../src/electron/main/storage-root', () => ({ storageRoot: () => '/isolated', ensureRoot: () => {}, migrateFromUserData: () => {}, writeFileAtomic: write }))
import { CredentialStore } from '../../../../src/electron/main/credentials/store'
beforeEach(() => { files.clear(); encrypt.mockReset().mockImplementation(value => Buffer.from(value)); write.mockReset() })
afterEach(() => vi.restoreAllMocks())
it('替换与删除落盘失败保留旧 key，重试只在提交成功后发布', () => {
  const store = new CredentialStore()
  store.write('mock', 'old-synthetic')
  write.mockImplementationOnce(() => { throw new Error('写入失败') })
  expect(() => store.write('mock', 'new-synthetic')).toThrow('写入失败')
  expect(store.read('mock')).toBe('old-synthetic')
  write.mockImplementationOnce(() => { throw new Error('删除失败') })
  expect(() => store.remove('mock')).toThrow('删除失败')
  expect(store.read('mock')).toBe('old-synthetic')
  encrypt.mockImplementationOnce(() => { throw new Error('加密失败') })
  expect(() => store.write('mock', 'new-synthetic')).toThrow('加密失败')
  expect(store.read('mock')).toBe('old-synthetic')
  store.write('mock', 'new-synthetic')
  expect(store.read('mock')).toBe('new-synthetic')
  store.remove('mock')
  expect(store.listConfigured()).toEqual([])
})
