/**
 * 思考力度共享常量与主流模型家族预设（零运行时依赖，renderer / host / tests 共用）。
 *
 * 1. 英文显示档位与 pi/OpenAI/Anthropic 事实枚举 1:1 对齐，消除中文翻译歧义；
 * 2. 模型家族预设表用于在新增自定义模型或从端点拉取裸 ID 时智能填充窗口、视觉、思考档位与 compat 提示；
 * 3. thinkingLevelMap 规范化纯函数保证未启用档位显式落 null，避免 pi 默认放行 minimal。
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ThinkingLevelWithOff = 'off' | ThinkingLevel
export type ThinkingLevelMap = Partial<Record<ThinkingLevelWithOff, string | null>>
export type ThinkingFormat =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'together'
  | 'baseten'
  | 'zai'
  | 'qwen'
  | 'qwen-chat-template'
  | 'chat-template'
  | 'string-thinking'
  | 'ant-ling'

export interface ProviderCompatDef {
  thinkingFormat?: ThinkingFormat
  supportsReasoningEffort?: boolean
  supportsDeveloperRole?: boolean
  thinkingTokenBudgetField?: 'thinking_budget' | 'thinking_budget_tokens' | 'thinking_token_budget'
  supportsThinkingTokenBudget?: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  forceAdaptiveThinking?: boolean
  supportsTemperature?: boolean
}

export type ApiFormat = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export const THINKING_ORDER: readonly ThinkingLevelWithOff[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export const NON_OFF_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** 主流编程客户端事实标准的英文思考档位标签 */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevelWithOff, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

export interface ThinkingPreset {
  id: string
  label: string
  description: string
  map: ThinkingLevelMap
}

/** 构造显式闭合的 thinkingLevelMap：仅选中档位启用，其余非 off 档显式落 null */
export function buildClosedThinkingMap(
  enabled: Partial<Record<ThinkingLevelWithOff, string | undefined>>,
  allowOff: boolean
): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  if (!allowOff) {
    map.off = null
  } else if (typeof enabled.off === 'string' && enabled.off.trim().length > 0) {
    map.off = enabled.off.trim()
  }
  for (const level of NON_OFF_THINKING_LEVELS) {
    const val = enabled[level]
    map[level] = typeof val === 'string' && val.trim().length > 0 ? val.trim() : null
  }
  return map
}

/** 通用推理默认档位（比 pi 默认安全：禁用 minimal，避免多数端点 400） */
export const DEFAULT_REASONING_MAP: ThinkingLevelMap = buildClosedThinkingMap(
  { low: 'low', medium: 'medium', high: 'high' },
  true
)

/** 设置弹窗快捷套用的思考档位预设 */
export const THINKING_PRESETS: readonly ThinkingPreset[] = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Off / Low / Medium / High（通用兼容）',
    map: DEFAULT_REASONING_MAP
  },
  {
    id: 'mandatory',
    label: 'Always On',
    description: 'Low / Medium / High（禁 Off，适合 o1/o3 等纯思考模型）',
    map: buildClosedThinkingMap({ low: 'low', medium: 'medium', high: 'high' }, false)
  },
  {
    id: 'gpt-5-2',
    label: 'GPT-5.2+',
    description: 'Off(none) / Low / Medium / High / XHigh',
    map: buildClosedThinkingMap({ off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }, true)
  },
  {
    id: 'claude-4-6',
    label: 'Claude 4.6+',
    description: 'Off / Low / Medium / High / Max',
    map: buildClosedThinkingMap({ low: 'low', medium: 'medium', high: 'high', max: 'max' }, true)
  },
  {
    id: 'claude-4-7',
    label: 'Claude 4.7+',
    description: 'Off / Low / Medium / High / XHigh / Max',
    map: buildClosedThinkingMap(
      { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      true
    )
  },
  {
    id: 'deepseek-v4',
    label: 'DeepSeek V4',
    description: 'Off / Low / High / Max（无 Minimal/Medium）',
    map: buildClosedThinkingMap({ low: 'low', high: 'high', max: 'max' }, true)
  },
  {
    id: 'gemini-3',
    label: 'Gemini 3',
    description: 'Off / Minimal / Low / Medium / High',
    map: buildClosedThinkingMap(
      { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
      true
    )
  }
]

export interface ModelPreset {
  contextWindow: number
  maxTokens: number
  input: Array<'text' | 'image'>
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
  compat?: ProviderCompatDef
}

interface PresetRule {
  test: (id: string) => boolean
  preset: (apiFormat?: ApiFormat, id?: string) => ModelPreset
}

function normalizedModelKey(rawId: string): string {
  const lower = rawId.trim().toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash >= 0 ? lower.slice(slash + 1) : lower
}

const PRESET_RULES: readonly PresetRule[] = [
  // OpenAI GPT-5.4 Pro / 5.5 Pro（禁用 off 与 low）
  {
    test: (id) => /^gpt-5\.[245]-pro/.test(id),
    preset: () => ({
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ medium: 'medium', high: 'high', xhigh: 'xhigh' }, false)
    })
  },
  // OpenAI GPT-5.6+ / GPT-6+
  {
    test: (id) => /^gpt-(?:5\.[6-9]|6(?:\.\d+)?)/.test(id) && !id.includes('chat'),
    preset: (api) => ({
      contextWindow: 272_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        {
          ...(api === 'openai-responses' ? { off: 'none' } : {}),
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max'
        },
        true
      )
    })
  },
  // OpenAI GPT-5.2 / 5.3 / 5.4 / 5.5
  {
    test: (id) => /^gpt-5\.[2-5]/.test(id) && !id.includes('chat'),
    preset: (api) => ({
      contextWindow: 400_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        {
          ...(api === 'openai-responses' ? { off: 'none' } : {}),
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh'
        },
        true
      )
    })
  },
  // OpenAI GPT-5.1
  {
    test: (id) => /^gpt-5\.1/.test(id) && !id.includes('chat'),
    preset: (api) => ({
      contextWindow: 400_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        { ...(api === 'openai-responses' ? { off: 'none' } : {}), low: 'low', medium: 'medium', high: 'high' },
        true
      )
    })
  },
  // OpenAI GPT-5 Pro（仅 high）
  {
    test: (id) => /^gpt-5-pro/.test(id),
    preset: () => ({
      contextWindow: 400_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ high: 'high' }, false)
    })
  },
  // OpenAI GPT-5 / mini / nano（禁 off，含 minimal）
  {
    test: (id) => /^gpt-5(?:-(?:mini|nano))?(?:$|-\d)/.test(id),
    preset: () => ({
      contextWindow: 400_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        false
      )
    })
  },
  // OpenAI o1 / o3 / o4-mini（禁 off，仅 low/medium/high）
  {
    test: (id) => /^o(?:1|3|4)(?:-mini|-pro)?(?:$|-\d)/.test(id),
    preset: () => ({
      contextWindow: 200_000,
      maxTokens: 100_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ low: 'low', medium: 'medium', high: 'high' }, false)
    })
  },
  // OpenAI GPT-4o / 4.1 非推理模型
  {
    test: (id) => /^gpt-4(?:\.1|o)/.test(id),
    preset: () => ({
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ['text', 'image'],
      reasoning: false
    })
  },
  // Anthropic Claude Opus 4.7+ / Sonnet 5+ / Opus 5+
  {
    test: (id) => /^claude-(?:opus-4-[789]|(?:opus|sonnet|haiku)-5|fable-5)/.test(id),
    preset: (api) => ({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        true
      ),
      ...(api === 'anthropic-messages' && { compat: { forceAdaptiveThinking: true } })
    })
  },
  // Anthropic Claude 4.6
  {
    test: (id) => /^claude-(?:opus|sonnet)-4-6/.test(id),
    preset: (api) => ({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ low: 'low', medium: 'medium', high: 'high', max: 'max' }, true),
      ...(api === 'anthropic-messages' && { compat: { forceAdaptiveThinking: true } })
    })
  },
  // Anthropic Claude 3.7 / 4 / 4.5
  {
    test: (id) => /^claude-(?:3-7|sonnet-4|opus-4|haiku-4)/.test(id),
    preset: () => ({
      contextWindow: 200_000,
      maxTokens: 64_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        true
      )
    })
  },
  // DeepSeek V4 / Flash
  {
    test: (id) => /^deepseek-(?:v4|flash)/.test(id),
    preset: (api, id) => ({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: id !== undefined && /^deepseek-flash/.test(id) ? ['text', 'image'] : ['text'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ low: 'low', high: 'high', max: 'max' }, true),
      ...(api === 'openai-completions' && {
        compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
      })
    })
  },
  // DeepSeek R1 / Reasoner（纯推理，禁 off）
  {
    test: (id) => /^deepseek-(?:r1|reasoner)/.test(id),
    preset: (api) => ({
      contextWindow: 128_000,
      maxTokens: 32_768,
      input: ['text'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ high: 'high' }, false),
      ...(api === 'openai-completions' && {
        compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
      })
    })
  },
  // DeepSeek V3 / Chat
  {
    test: (id) => /^deepseek-(?:v3|chat)/.test(id),
    preset: (api) => ({
      contextWindow: 128_000,
      maxTokens: 8_192,
      input: ['text'],
      reasoning: false,
      ...(api === 'openai-completions' && {
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
      })
    })
  },
  // Google Gemini 3.x
  {
    test: (id) => /^gemini-3/.test(id),
    preset: () => ({
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap(
        { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        true
      )
    })
  },
  // Google Gemini 2.5 Pro（禁 off）vs Flash（允许 off）
  {
    test: (id) => /^gemini-2\.5-pro/.test(id),
    preset: () => ({
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ low: 'low', medium: 'medium', high: 'high' }, false)
    })
  },
  {
    test: (id) => /^gemini-2\.5-flash/.test(id),
    preset: () => ({
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: DEFAULT_REASONING_MAP
    })
  },
  // Qwen3 / QwQ 推理模型
  {
    test: (id) => /^(?:qwen3|qwq)/.test(id),
    preset: (api) => ({
      contextWindow: 131_072,
      maxTokens: 32_768,
      input: ['text'],
      reasoning: true,
      thinkingLevelMap: DEFAULT_REASONING_MAP,
      ...(api === 'openai-completions' && { compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false } })
    })
  },
  // GLM-4.5+ / GLM-5.x
  {
    test: (id) => /^glm-(?:4\.[5-9]|5)/.test(id),
    preset: (api) => ({
      contextWindow: 200_000,
      maxTokens: 65_536,
      input: ['text'],
      reasoning: true,
      thinkingLevelMap: DEFAULT_REASONING_MAP,
      ...(api === 'openai-completions' && { compat: { thinkingFormat: 'zai', supportsDeveloperRole: false } })
    })
  },
  // xAI Grok 3 / 4
  {
    test: (id) => /^grok-[34]/.test(id),
    preset: () => ({
      contextWindow: 256_000,
      maxTokens: 64_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: buildClosedThinkingMap({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }, true)
    })
  }
]

/** 按模型 ID 与 API 方言匹配主流模型家族能力预设；未命中返回 undefined */
export function matchModelPreset(
  modelId: string,
  apiFormat?: ApiFormat
): ModelPreset | undefined {
  const key = normalizedModelKey(modelId)
  if (!key) return undefined
  for (const rule of PRESET_RULES) {
    if (rule.test(key)) return rule.preset(apiFormat, key)
  }
  return undefined
}

/** 根据 thinkingLevelMap 与 reasoning 状态解析有效支持档（与 pi getSupportedThinkingLevels 同构） */
export function resolveSupportedThinkingLevels(
  reasoning: boolean,
  map?: ThinkingLevelMap
): ThinkingLevelWithOff[] {
  if (!reasoning) return ['off']
  return THINKING_ORDER.filter((level) => {
    const mapped = map?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** 从思考档位列表生成紧凑摘要，供设置页模型行展示 */
export function formatThinkingSummary(levels: readonly ThinkingLevelWithOff[]): {
  badge: string
  tooltip: string
} {
  const active = levels.filter((l) => l !== 'off')
  const allowOff = levels.includes('off')
  const labels = levels.map((l) => THINKING_LEVEL_LABELS[l]).join(' / ')
  if (active.length === 0) {
    return { badge: '思考', tooltip: labels }
  }
  const suffix = allowOff ? `${active.length} 档` : `${active.length} 档 · 必思考`
  return {
    badge: `思考 · ${suffix}`,
    tooltip: `支持档位：${labels}`
  }
}
