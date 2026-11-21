/** Host 自有标题策略：启动读取、原子保存；不依赖 renderer 初始化或桌面 settings。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionTitleSettings } from '../../shared/session-title'

/** RPC 与磁盘都属于不可信边界，只在入口校验一次。 */
export function validateTitleSettings(value: unknown): asserts value is SessionTitleSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('enabled' in value) || typeof value.enabled !== 'boolean') throw new Error('自动标题配置需要 enabled: boolean')
  if ('model' in value && value.model !== undefined) {
    const model = value.model
    if (typeof model !== 'object' || model === null || Array.isArray(model) ||
        !('provider' in model) || typeof model.provider !== 'string' || model.provider.trim() === '' ||
        !('id' in model) || typeof model.id !== 'string' || model.id.trim() === '') {
      throw new Error('标题模型需要非空 provider 和 id')
    }
  }
}

export class SessionTitleConfig {
  private value: SessionTitleSettings = { enabled: true }
  private path: string

  constructor(private root: string) {
    this.path = join(root, 'session-title.json')
    if (!existsSync(this.path)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof raw !== 'object' || raw === null || !('version' in raw) || raw.version !== 1 || !('settings' in raw)) {
        throw new Error('版本或形状不合法')
      }
      validateTitleSettings(raw.settings)
      this.value = structuredClone(raw.settings)
    } catch (error) {
      throw new Error(`自动标题配置读取失败（${this.path}）：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  get(): SessionTitleSettings { return structuredClone(this.value) }

  set(settings: SessionTitleSettings): SessionTitleSettings {
    const next = structuredClone(settings)
    mkdirSync(this.root, { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, settings: next }, null, 2), 'utf8')
    renameSync(temporary, this.path)
    this.value = next
    return this.get()
  }
}
