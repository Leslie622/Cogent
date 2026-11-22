/** 标题策略归 Host：无界面启动/重启、坏文件与失败提交的生效边界。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionTitleConfig, validateTitleSettings } from '../../../src/host/runtime/session-title-config'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cogent-title-config-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

it('缺文件默认开启且只读不写；保存和重启恢复同一策略，返回快照不能改内存', () => {
  const store = new SessionTitleConfig(root)
  expect(store.get()).toEqual({ enabled: true })
  const settings = { enabled: false, model: { provider: 'custom/a', id: 'same' } }
  store.set(settings)
  settings.model.provider = 'custom/b'
  const snapshot = store.get()
  snapshot.enabled = true
  expect(new SessionTitleConfig(root).get()).toEqual({ enabled: false, model: { provider: 'custom/a', id: 'same' } })
  store.set({ enabled: true })
  expect(new SessionTitleConfig(root).get()).toEqual({ enabled: true })
})

it.each([null, [], {}, { enabled: 1 }, { enabled: true, model: {} }, { enabled: true, model: { provider: '', id: 'x' } }])('非法配置 %j 在入口拒绝', (value) => {
  expect(() => validateTitleSettings(value)).toThrow()
})

it.each(['{', JSON.stringify({ version: 2, settings: { enabled: true } }), JSON.stringify({ version: 1, settings: { enabled: 'yes' } })])('坏文件不静默覆盖', (text) => {
  const path = join(root, 'session-title.json')
  writeFileSync(path, text)
  expect(() => new SessionTitleConfig(root)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(text)
})

it('原子替换失败时不发布新设置', () => {
  const store = new SessionTitleConfig(root)
  mkdirSync(join(root, 'session-title.json'))
  expect(() => store.set({ enabled: false })).toThrow()
  expect(store.get()).toEqual({ enabled: true })
})
