/**
 * API 格式下拉（2026-11-10 从 ModelsSection.tsx 拆出，同步换用 shadcn Select
 * 原语 —— base-luma registry 版；此前是 DropdownMenu 手搓的下拉等价物，
 * 按约定.md §3「shadcn 优先」退役）：CustomProviderDetail 专用，props 接口
 * 保持拆分前的形状（value / onChange，对调用方无感）。
 */
import {
  Select,
  SelectContent,
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
      {/* 触发器外观对齐表单字段惯例（h-9 / rounded-lg / 实边框），压掉原语的
          胶囊底（rounded-3xl + 半透明底色）与 w-fit 缺省 */}
      <SelectTrigger
        aria-label="API 格式"
        className="mt-1.5 h-9 w-full justify-between rounded-lg border border-border bg-transparent px-3 text-[13px] font-normal text-foreground hover:bg-accent-foreground/5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" className="min-w-72">
        {API_FORMATS.map((format) => (
          <SelectItem key={format.value} value={format.value}>
            {format.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
