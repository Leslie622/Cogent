/** Host 独占的业务配置：启动恢复、旧默认迁移、候选构造成功后写盘再发布。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SessionDefaults } from '../../shared/host-config'
import type { ProvidersCustomSyncParams } from '../../protocol'

const positive = z.number().finite().positive()
const thinkingWire = z.union([z.string().trim().min(1), z.null()])
const thinkingLevelMap = z.object({
  off: thinkingWire,
  minimal: thinkingWire,
  low: thinkingWire,
  medium: thinkingWire,
  high: thinkingWire,
  xhigh: thinkingWire,
  max: thinkingWire
}).partial().strict().optional()
const compat = z.object({
  thinkingFormat: z.enum([
    'openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai',
    'qwen', 'qwen-chat-template', 'chat-template', 'string-thinking', 'ant-ling'
  ]).optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
  thinkingTokenBudgetField: z.enum(['thinking_budget', 'thinking_budget_tokens', 'thinking_token_budget']).optional(),
  supportsThinkingTokenBudget: z.boolean().optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  forceAdaptiveThinking: z.boolean().optional(),
  supportsTemperature: z.boolean().optional()
})
const model = z.object({ id: z.string().min(1), name: z.string().optional(), contextWindow: positive.optional(), maxTokens: positive.optional(),
  reasoning: z.boolean().optional(), input: z.array(z.enum(['text', 'image'])).min(1).optional(),
  thinkingLevels: z.array(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).optional(),
  thinkingLevelMap,
  compaction: z.object({ thresholdRatio: positive.max(1).optional(), roomFloorTokens: positive.optional() }).optional(),
  thinkingBudgets: z.object({ minimal: positive.optional(), low: positive.optional(), medium: positive.optional(), high: positive.optional() }).optional(),
  compat: compat.optional() })
export const providersSchema: z.ZodType<ProvidersCustomSyncParams> = z.object({
  providers: z.array(z.object({ id: z.string().regex(/^custom\/.+/), name: z.string(), baseUrl: z.string(), models: z.array(z.string().min(1)),
    modelDefs: z.array(model).optional(), apiFormat: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']).optional(),
    disabledModels: z.array(z.string().min(1)).optional(), disabled: z.boolean().optional(), compat: compat.optional() })),
  overrides: z.array(z.object({ providerId: z.string().min(1), baseUrl: z.string(), models: z.array(model).optional(), disabledModels: z.array(z.string().min(1)).optional() }))
}).superRefine((value, ctx) => {
  for (const ids of [value.providers.map(p => p.id), value.overrides.map(p => p.providerId)])
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: '供应商配置身份重复' })
})
export const defaultsSchema = z.object({ defaultPermissionMode: z.enum(['ask', 'auto']) })

export class BusinessConfig {
  defaults: SessionDefaults
  providers: ProvidersCustomSyncParams
  constructor(private root: string) {
    this.defaults = this.read('session-defaults.json', defaultsSchema) ?? this.migrateDefaults()
    this.providers = this.read('custom-providers.json', providersSchema) ?? { providers: [], overrides: [] }
  }
  private read<T>(name: string, schema: z.ZodType<T>): T | undefined {
    const path = join(this.root, name)
    if (!existsSync(path)) return undefined
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const file = z.object({ version: z.literal(1) }).passthrough().parse(raw)
      return schema.parse(file)
    } catch (cause) { throw new Error(`业务配置读取失败（${path}）: ${String(cause)}`, { cause }) }
  }
  private migrateDefaults(): SessionDefaults {
    const legacy = this.read('settings.json', z.object({ defaultPermissionMode: z.enum(['ask', 'auto']).optional() }))
    const value: SessionDefaults = { defaultPermissionMode: legacy?.defaultPermissionMode ?? 'ask' }
    this.write('session-defaults.json', value)
    return value
  }
  private write(name: string, value: object): void {
    mkdirSync(this.root, { recursive: true })
    const path = join(this.root, name), tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, ...value }, null, 2))
    renameSync(tmp, path)
  }
  setDefaults(value: SessionDefaults): SessionDefaults {
    this.write('session-defaults.json', value)
    this.defaults = value
    return { ...value }
  }
  setProviders(value: ProvidersCustomSyncParams, prepare: () => () => number): number {
    const commit = prepare()
    this.write('custom-providers.json', value)
    this.providers = value
    try { return commit() } catch (cause) { throw new Error(`供应商已保存，应用到引擎失败: ${String(cause)}`, { cause }) }
  }
}
