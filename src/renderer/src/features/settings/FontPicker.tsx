/** 字体弹窗在本地编辑中英文草稿，预览与正文共用编译器，保存时整组写入偏好。 */
import { useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxStatus,
} from '@/components/ui/combobox'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { compileTokens } from '@/lib/theme/compile'
import type { ThemeTokens } from '@/lib/theme/tokens'
import {
  buildUserTokens, LOCAL_FONT_PREFIX, type FontChoice, type FontPair, type FontScript, type LocalFontId,
} from '@/stores/appearance'

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<readonly { family: string }[]>
  }
}

const FONT_SCRIPTS = { latin: '英文字体', cjk: '中文字体' } as const
const FONT_SLOTS = ['latin', 'cjk'] as const
const FONT_LABELS = { 'system-ui': '系统界面字体', 'ui-monospace': '系统等宽' }
const THEME_FONTS: FontPair = { latin: 'theme', cjk: 'theme' }
const FONT_PRESETS: Record<'content' | 'code', Record<FontScript, FontChoice[]>> = {
  content: {
    latin: ['local:Inter', 'local:Segoe UI', 'local:Georgia', 'system-ui'],
    cjk: ['local:HarmonyOS Sans SC', 'local:Microsoft YaHei', 'local:SimSun', 'system-ui'],
  },
  code: {
    latin: ['local:JetBrains Mono', 'local:Consolas', 'local:Cascadia Code', 'ui-monospace'],
    cjk: ['local:HarmonyOS Sans SC'],
  },
}

function fontLabel(value: Exclude<FontChoice, 'theme'>): string {
  if (value === 'system-ui' || value === 'ui-monospace') return FONT_LABELS[value]
  return value.slice(LOCAL_FONT_PREFIX.length)
}

function defaultFontLabel(stack: string | undefined): string {
  if (stack === undefined || stack.trim() === '') return '系统默认'
  return (stack.match(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,])+/g) ?? [])
    .map((family) => family.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .join(', ')
}

export type SystemFonts = {
  options: LocalFontId[]
  status: 'idle' | 'loading' | 'ready' | 'failed'
}

export async function readSystemFonts(): Promise<LocalFontId[]> {
  if (!window.queryLocalFonts) throw new Error('Local Font Access 不可用')
  const fonts = await window.queryLocalFonts()
  const families = new Set(fonts.map(({ family }) => family).filter((family) => family.trim() !== ''))
  return [...families]
    .sort(new Intl.Collator('zh-CN', { numeric: true }).compare)
    .map((family): LocalFontId => `${LOCAL_FONT_PREFIX}${family}`)
}

export function FontPicker({
  label, kind, value, tokens, themeName, systemFonts, onOpen, onSave,
}: {
  label: string
  kind: keyof typeof FONT_PRESETS
  value: FontPair
  tokens: ThemeTokens
  themeName: string
  systemFonts: SystemFonts
  onOpen: () => void
  onSave: (value: FontPair) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [script, setScript] = useState<FontScript>('latin')
  const [query, setQuery] = useState('')
  const firstSlot = useRef<HTMLButtonElement>(null)
  const base = kind === 'content' ? 'root' : 'codeBlock'
  const defaults = {
    latin: defaultFontLabel(tokens[`${base}.fontLatin`]),
    cjk: defaultFontLabel(tokens[`${base}.fontCjk`]),
  }
  const displayFont = (font: FontChoice, slot: FontScript) => font === 'theme' ? defaults[slot] : fontLabel(font)
  const optionLabel = (font: FontChoice) => font === 'theme' ? `${defaults[script]} · 默认` : fontLabel(font)
  const selected = draft[script]
  const items = [...new Set<FontChoice>(['theme', ...FONT_PRESETS[kind][script], ...systemFonts.options, selected])]
  const status = systemFonts.status === 'loading' ? '正在读取系统字体…'
    : systemFonts.status === 'failed' ? '无法读取系统字体，重新打开重试'
    : systemFonts.status === 'ready' && systemFonts.options.length === 0 ? '没有可用的系统字体'
    : null
  const summary = `${displayFont(value.latin, 'latin')} / ${displayFont(value.cjk, 'cjk')}`
  const previewVars = compileTokens({
    ...tokens,
    ...buildUserTokens({
      codeFontSize: null,
      contentFont: kind === 'content' ? draft : THEME_FONTS,
      codeFont: kind === 'code' ? draft : THEME_FONTS,
    }),
  })
  const previewFamily = previewVars[kind === 'content' ? '--t-root-font' : '--t-code-font']
    ?? (kind === 'content' ? 'var(--font-sans)' : 'var(--font-mono)')

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) {
        setDraft(value)
        setScript('latin')
        setQuery('')
        onOpen()
      }
      setOpen(nextOpen)
    }}>
      <DialogTrigger aria-label={`设置${label}`} render={<Button variant="outline" size="default" />} className="w-56 min-w-0">
        <span className="truncate" title={summary}>{summary}</span>
      </DialogTrigger>
      <DialogContent initialFocus={firstSlot} className="sm:max-w-lg">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>分别选择中英文字体，保存后应用。</DialogDescription>
        </DialogHeader>
        <Tabs value={script} className="min-h-0 gap-3" onValueChange={(next: FontScript) => {
          setScript(next)
          setQuery('')
        }}>
          <div className="shrink-0 space-y-2">
            <TabsList className="w-full">
              <TabsTrigger ref={firstSlot} value="latin">英文字体</TabsTrigger>
              <TabsTrigger value="cjk">中文字体</TabsTrigger>
            </TabsList>
            <div className="grid grid-cols-2 gap-4">
              {FONT_SLOTS.map((slot) => (
                <div key={slot} className="flex min-w-0 items-center justify-center gap-1.5" aria-label={`已选${FONT_SCRIPTS[slot]}`}>
                  <span className="truncate" title={displayFont(draft[slot], slot)}>{displayFont(draft[slot], slot)}</span>
                  {draft[slot] === 'theme' && <Badge variant="secondary" size="sm">默认</Badge>}
                </div>
              ))}
            </div>
          </div>
          <Combobox<FontChoice>
            key={script}
            inline
            open
            items={items}
            value={selected}
            inputValue={query}
            itemToStringLabel={optionLabel}
            autoHighlight
            onInputValueChange={(next, { reason }) => { if (reason === 'input-change') setQuery(next) }}
            onValueChange={(option) => { if (option !== null) setDraft({ ...draft, [script]: option }) }}
          >
            <div className="w-full shrink-0">
              <ComboboxInput aria-label={`搜索${FONT_SCRIPTS[script]}`} placeholder="搜索字体…" />
            </div>
            {status && <ComboboxStatus className="text-xs text-muted-foreground">{status}</ComboboxStatus>}
            <div className="min-h-0 basis-48 overflow-y-auto">
              <ComboboxEmpty className="text-sm text-muted-foreground empty:hidden">没有匹配的字体</ComboboxEmpty>
              <ComboboxList className="max-h-none">
                {(font: FontChoice) => <ComboboxItem key={font} value={font}>{optionLabel(font)}</ComboboxItem>}
              </ComboboxList>
            </div>
          </Combobox>
        </Tabs>
        <Separator />
        <div className="shrink-0 space-y-2" role="region" aria-label="字体预览">
          <div className="text-xs text-muted-foreground">预览</div>
          <div className="space-y-1 break-words" style={{ fontFamily: previewFamily }}>
            <p>The quick brown fox jumps over the lazy dog. 0123456789</p>
            <p>用文字记录灵感，让每一次对话清晰自然。</p>
          </div>
          <p className="text-xs text-muted-foreground">默认字体来自「对话内容」样式：{themeName}。</p>
        </div>
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
          <Button onClick={() => { onSave(draft); setOpen(false) }}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
