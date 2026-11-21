/**
 * API 格式下拉 —— shadcn Select 原语（base-nova registry 版，约定.md §3
 * 「shadcn 优先」）：CustomProviderDetail 专用，props 接口为 value /
 * onChange（对调用方无感）。
 */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { CustomProviderDef } from '@/env.d'

/** API 方言三档（协议 CustomProviderDef.apiFormat 的 UI 侧文案）。
    有网关按路由放行模型权限（chat/completions 与 messages 拒、responses 放行），
    三方言即三套可选端点路径，2026-11-10 因此补 responses 档 */
const API_FORMATS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions (/v1/chat/completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses (/v1/responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
] as const

type ApiFormat = NonNullable<CustomProviderDef['apiFormat']>

/** API 格式下拉：方言决定引擎用哪套请求实现与 baseUrl 拼法 —— openai 系两档
    baseUrl 带 /v1（SDK 只拼 /chat/completions 或 /responses），anthropic 填根地址
    （SDK 自拼 /v1/messages） */
export function FormatSelect({
  value,
  onChange,
}: {
  value: CustomProviderDef['apiFormat']
  onChange: (format: CustomProviderDef['apiFormat']) => void
}) {
  const current: ApiFormat = value ?? 'openai-completions'
  return (
    <Select
      value={current}
      items={API_FORMATS}
      onValueChange={(next) => {
        // base-ui 单选的 onValueChange 类型含 null（清选路径）；本列表静态三项、
        // 无清选入口，null 实际不可达 —— 真出现时丢弃不动当前值即可
        if (next !== null) onChange(next)
      }}
    >
      {/* 原生形态（胶囊风即组件库统一形态，2026-11-15 用户定调：不覆盖
          shadcn 样式）；w-full 是表单占满行宽的布局约束 */}
      <SelectTrigger aria-label="API 格式" className="mt-1.5 w-full">
        <SelectValue />
      </SelectTrigger>
      {/* w-auto 覆盖弹层的锚宽钉死（select.tsx 默认 w=锚宽且不增宽）—— 长标签
          （/v1/chat/completions）在窄右栏下会被裁字；放开后弹层取 max(锚宽,
          内容宽)，与 zcode 官方 ProviderApiFormatSelect 的可增宽弹层同行为 */}
      <SelectContent align="start" className="w-auto min-w-[var(--anchor-width,9rem)]">
        {/* SelectGroup 的 p-1 内衬是官方形态的一部分（同 McpSection 注释） */}
        <SelectGroup>
          {API_FORMATS.map((format) => (
            <SelectItem key={format.value} value={format.value}>
              {format.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
