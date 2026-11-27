/**
 * 端点兼容覆盖（ProviderCompatDef）表单件：被 CustomProviderDetail（供应商级）与
 * ModelDialog（模型级）共用。按 apiFormat 只展示对应方言消费的字段，未选均保持 undefined（自动探测/继承）。
 */
import { useId } from 'react'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import type { CustomProviderDef, ProviderCompatDef, ThinkingFormat } from '@/env.d'
import { FIELD_LABEL } from './models-recipes'

type ApiFormat = NonNullable<CustomProviderDef['apiFormat']>

const THINKING_FORMAT_OPTIONS: ReadonlyArray<{ value: ThinkingFormat | undefined; label: string }> = [
  { value: undefined, label: '自动' },
  { value: 'openai', label: 'openai（reasoning_effort）' },
  { value: 'openrouter', label: 'openrouter（reasoning.effort）' },
  { value: 'deepseek', label: 'deepseek（thinking.type + effort）' },
  { value: 'qwen', label: 'qwen（enable_thinking）' },
  { value: 'zai', label: 'zai（thinking.type + clear_thinking）' },
  { value: 'together', label: 'together（reasoning.enabled）' },
  { value: 'qwen-chat-template', label: 'qwen-chat-template' },
  { value: 'chat-template', label: 'chat-template' },
  { value: 'baseten', label: 'baseten' },
  { value: 'string-thinking', label: 'string-thinking' },
  { value: 'ant-ling', label: 'ant-ling' },
]

const BUDGET_FIELD_OPTIONS: ReadonlyArray<{
  label: string
  value: 'thinking_budget' | 'thinking_budget_tokens' | 'thinking_token_budget' | undefined
}> = [
  { label: '自动', value: undefined },
  { label: 'thinking_budget', value: 'thinking_budget' },
  { label: 'thinking_budget_tokens', value: 'thinking_budget_tokens' },
  { label: 'thinking_token_budget', value: 'thinking_token_budget' },
]

const MAX_TOKENS_FIELD_OPTIONS: ReadonlyArray<{
  label: string
  value: 'max_tokens' | 'max_completion_tokens' | undefined
}> = [
  { label: '自动', value: undefined },
  { label: 'max_tokens', value: 'max_tokens' },
  { label: 'max_completion_tokens', value: 'max_completion_tokens' },
]

const TRI_STATE_BOOL: ReadonlyArray<{ label: string; value: boolean | undefined }> = [
  { label: '自动', value: undefined },
  { label: '开启', value: true },
  { label: '关闭', value: false },
]

function normalizeCompat(next: ProviderCompatDef): ProviderCompatDef | undefined {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined) cleaned[k] = v
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

type ChoiceValue = string | boolean | undefined

/** 共用字段组合只负责排版；选项值与 normalizeCompat 保持原有配置语义。 */
function CompatChoice<Value extends ChoiceValue>({
  label, value, options, onChange, presentation = 'toggles',
}: {
  label: string
  value: Value
  options: ReadonlyArray<{ label: string; value: Value }>
  onChange: (next: Value) => void
  presentation?: 'select' | 'toggles'
}) {
  const id = useId()
  const encode = (option: ChoiceValue): string => option === undefined ? '__auto__' : String(option)
  const items = options.map((option) => ({ label: option.label, value: encode(option.value) }))
  const toggles = presentation === 'toggles' && options.map((option) => (
    <Toggle
      key={encode(option.value)}
      variant="outline"
      size="sm"
      pressed={value === option.value}
      onPressedChange={(on) => on && onChange(option.value)}
    >
      {option.label}
    </Toggle>
  ))

  return (
    <div className="grid gap-2 @min-[26rem]/compat:grid-cols-[10rem_minmax(0,1fr)] @min-[26rem]/compat:items-center @min-[26rem]/compat:gap-4">
      {presentation === 'select'
        ? <label htmlFor={id} className={FIELD_LABEL}>{label}</label>
        : <span id={id} className={FIELD_LABEL}>{label}</span>}
      {presentation === 'select' ? (
        <Select value={encode(value)} items={items} onValueChange={(next) => {
          const option = options.find((item) => encode(item.value) === next)
          if (option) onChange(option.value)
        }}>
          <SelectTrigger id={id} className="w-full min-w-0"><SelectValue /></SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <SelectGroup>
              {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <ButtonGroup aria-labelledby={id} className="@min-[26rem]/compat:justify-self-end">{toggles}</ButtonGroup>
      )}
    </div>
  )
}

export function CompatFields({ value, apiFormat, onChange }: {
  value: ProviderCompatDef | undefined
  apiFormat?: ApiFormat
  onChange: (next: ProviderCompatDef | undefined) => void
}) {
  const current = value ?? {}
  const update = (patch: Partial<ProviderCompatDef>) => onChange(normalizeCompat({ ...current, ...patch }))
  const isAnthropic = apiFormat === 'anthropic-messages'
  const showOpenAiCompletions = !isAnthropic && apiFormat !== 'openai-responses'
  const showOpenAiCommon = !isAnthropic

  return (
    <div className="@container/compat flex flex-col gap-4">
      {showOpenAiCompletions && (
        <CompatChoice label="思考协议格式" value={current.thinkingFormat} options={THINKING_FORMAT_OPTIONS}
          onChange={(next) => update({ thinkingFormat: next })} presentation="select" />
      )}
      {showOpenAiCommon && (
        <CompatChoice label="最大输出字段" value={current.maxTokensField} options={MAX_TOKENS_FIELD_OPTIONS}
          onChange={(next) => update({ maxTokensField: next })} presentation="select" />
      )}
      {showOpenAiCompletions && (
        <CompatChoice label="思考预算字段" value={current.thinkingTokenBudgetField} options={BUDGET_FIELD_OPTIONS}
          onChange={(next) => update({ thinkingTokenBudgetField: next })} presentation="select" />
      )}
      {showOpenAiCommon && (
        <>
          <CompatChoice label="Developer Role" value={current.supportsDeveloperRole} options={TRI_STATE_BOOL}
            onChange={(next) => update({ supportsDeveloperRole: next })} />
          {showOpenAiCompletions && (
            <CompatChoice label="下发 reasoning_effort" value={current.supportsReasoningEffort} options={TRI_STATE_BOOL}
              onChange={(next) => update({ supportsReasoningEffort: next })} />
          )}
        </>
      )}
      {isAnthropic && (
        <>
          <CompatChoice label="Adaptive Thinking（4.6+）" value={current.forceAdaptiveThinking} options={TRI_STATE_BOOL}
            onChange={(next) => update({ forceAdaptiveThinking: next })} />
          <CompatChoice label="允许 Temperature" value={current.supportsTemperature} options={TRI_STATE_BOOL}
            onChange={(next) => update({ supportsTemperature: next })} />
        </>
      )}
    </div>
  )
}
