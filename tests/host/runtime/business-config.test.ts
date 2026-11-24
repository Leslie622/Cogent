/** 配置从 Host 恢复，不依赖 renderer；坏配置与写盘故障不修改活值。 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BusinessConfig, providersSchema } from '../../../src/host/runtime/business-config'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cogent-business-config-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('旧默认只迁一次，新文件优先；坏 JSON 和非法业务值保留原件并拒绝启动', () => {
  const legacy = join(root, 'settings.json')
  writeFileSync(legacy, JSON.stringify({ version: 1, defaultPermissionMode: 'auto' }))
  const first = new BusinessConfig(root)
  expect(first.defaults.defaultPermissionMode).toBe('auto')
  first.setDefaults({ defaultPermissionMode: 'ask' })
  expect(new BusinessConfig(root).defaults.defaultPermissionMode).toBe('ask')
  rmSync(join(root, 'session-defaults.json'))
  writeFileSync(legacy, JSON.stringify({ version: 1, defaultPermissionMode: 'oops' }))
  expect(() => new BusinessConfig(root)).toThrow()
  expect(readFileSync(legacy, 'utf8')).toContain('oops')
  writeFileSync(legacy, '{broken')
  expect(() => new BusinessConfig(root)).toThrow('settings.json')
  expect(readFileSync(legacy, 'utf8')).toBe('{broken')
})

it('候选构造或写盘失败不会发布；保存成功但提交异常明确报告', () => {
  const config = new BusinessConfig(root)
  mkdirSync(join(root, 'session-defaults.json.tmp'))
  expect(() => config.setDefaults({ defaultPermissionMode: 'auto' })).toThrow()
  expect(config.defaults.defaultPermissionMode).toBe('ask')
  const value = { providers: [{ id: 'custom/test', name: 'Test', baseUrl: 'http://localhost/v1', models: ['one'] }], overrides: [] }
  const commit = vi.fn(() => 1)
  expect(() => config.setProviders(value, () => { throw new Error('构造失败') })).toThrow('构造失败')
  mkdirSync(join(root, 'custom-providers.json.tmp'))
  expect(() => config.setProviders(value, () => commit)).toThrow()
  expect(commit).not.toHaveBeenCalled()
  expect(config.providers.providers).toEqual([])
  rmSync(join(root, 'custom-providers.json.tmp'), { recursive: true })
  expect(() => config.setProviders(value, () => () => { throw new Error('运行时拒绝') })).toThrow('已保存，应用到引擎失败')
  expect(new BusinessConfig(root).providers).toEqual(value)
})

it('磁盘与 RPC 共用字段校验，拒绝空项、重复身份和非法模型参数', () => {
  for (const providers of [[null], [{ id: 'builtin' }], [{ id: 'custom/x', name: 'x', baseUrl: '', models: [], modelDefs: [{ id: 'm', maxTokens: -1 }] }]])
    expect(() => providersSchema.parse({ providers, overrides: [] })).toThrow()
  writeFileSync(join(root, 'custom-providers.json'), '{broken')
  expect(() => new BusinessConfig(root)).toThrow('custom-providers.json')
  expect(readFileSync(join(root, 'custom-providers.json'), 'utf8')).toBe('{broken')
})
