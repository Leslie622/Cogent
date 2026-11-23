/** 标题策略归 Host：无界面启动/重启、坏文件与失败提交的生效边界。 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
  expect(existsSync(join(root, 'session-title.json'))).toBe(false)
  const settings = { enabled: false }
  store.set(settings)
  settings.enabled = true
  const snapshot = store.get()
  snapshot.enabled = true
  expect(store.get()).toEqual({ enabled: false })
  expect(new SessionTitleConfig(root).get()).toEqual({ enabled: false })
  store.set({ enabled: true })
  expect(new SessionTitleConfig(root).get()).toEqual({ enabled: true })
})

it.each([true, false])('旧模型配置只保留开关 %s，读取不改文件，保存时只写开关', (enabled) => {
  const path = join(root, 'session-title.json')
  const legacy = { enabled, model: { provider: 'missing', id: 'removed' } }
  const text = JSON.stringify({ version: 1, settings: legacy })
  writeFileSync(path, text)
  const store = new SessionTitleConfig(root)
  expect(store.get()).toEqual({ enabled })
  expect(readFileSync(path, 'utf8')).toBe(text)
  expect(store.set(legacy)).toEqual({ enabled })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, settings: { enabled } })
  expect(new SessionTitleConfig(root).get()).toEqual({ enabled })
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
