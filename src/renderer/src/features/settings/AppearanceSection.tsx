/**
 * 设置 · 外观分区：「界面样式」（应用级：深浅色 / 主题色 / 界面字号 / 强调色）与
 * 「对话」（内容区：双字体 / 字号 / 内容主题 / 代码行号 / 换行）两组。
 * 偏好落 localStorage（appearance/theme 两个 persist store——
 * 纯渲染端视觉偏好不进 settings.json，theme store 先例定调）。
 * 对话内容主题（首个落地件，docs/技术笔记/对话内容主题.md）：下拉（内置
 * 「默认」+ 已导入）+ 导入（file picker 选 .themd.json，parseThemeFile
 * 校验，坏包行内报错不落库）+ 删除（仅用户主题）。
 * 导入失败反馈用行内错误文案而非 toast：全仓无 toast 基建，不为单一
 * 报错引新件（与计划文档「toast 报错」的偏差，行内更朴素且不抢焦点）。
 */
import { useRef, useState } from 'react'
import { IconArrowBackUp, IconChevronDown, IconFileImport, IconTrash } from '@tabler/icons-react'
import { ColorPicker } from '@/components/ColorPicker'
import { InterfaceSkinPicker } from '@/components/InterfaceSkinPicker'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DEFAULT_THEME_ID, useActiveTheme, useThemeStore } from '@/stores/theme'
import type { HexColor } from '@/lib/hex-color'
import { interfaceThemeColors } from '@/lib/interface-skins'
import {
  CODE_FONT_SIZES,
  UI_FONT_SIZES,
  useAppearanceStore,
  useIsDarkMode,
  type ColorMode,
} from '@/stores/appearance'
import { FontPicker, readSystemFonts, type SystemFonts } from './FontPicker'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'

/** 明暗三档（UI 文案；system = 跟随 OS 设置） */
const COLOR_MODES: Array<{ value: ColorMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/** 跟随主题档（字体/字号下拉的首项统一文案） */
const FOLLOW_THEME = '跟随主题'

function AccentControl() {
  const accent = useAppearanceStore((s) => s.accent)
  const setAccent = useAppearanceStore((s) => s.setAccent)
  const isDark = useIsDarkMode()
  // default 档无存储色值，按钮 HEX 与取色种子共用明暗回落（暗档为 CSS 变量蓝的近似）
  const shownAccent: HexColor = accent === 'default' ? (isDark ? '#5f9cff' : '#0231fa') : accent
  const [pickerSeed, setPickerSeed] = useState<HexColor>('#0231fa')
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5" role="group" aria-label="强调色">
      <Popover onOpenChange={(open) => { if (open) setPickerSeed(shownAccent) }}>
        <PopoverTrigger
          aria-label="选择颜色"
          render={<Button variant="outline" />}
          className="group"
        >
          {/* 圆角长方形色块：棋盘底衬出透明度，颜色读 --chrome-accent（含默认档明暗） */}
          <span
            aria-hidden="true"
            className="h-5 w-7 shrink-0 overflow-hidden rounded-sm bg-muted bg-[conic-gradient(var(--border)_25%,transparent_0_50%,var(--border)_0_75%,transparent_0)] bg-size-[8px_8px]"
          >
            <span className="block size-full rounded-[inherit] border border-foreground/10 bg-(--chrome-accent)" />
          </span>
          <span className="font-mono">{shownAccent}</span>
          <IconChevronDown
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground motion-safe:transition-transform group-data-popup-open:rotate-180"
          />
        </PopoverTrigger>
        <PopoverContent aria-label="强调色选择器" align="end" variant="color-picker">
          <ColorPicker key={pickerSeed} initialColor={pickerSeed} themeColors={interfaceThemeColors(isDark)} onChange={setAccent} />
        </PopoverContent>
      </Popover>
      {/* 图标钮与 McpSection 重置钮同款（ghost + IconArrowBackUp），无文字 */}
      <Button
        variant="ghost"
        size="default"
        disabled={accent === 'default'}
        onClick={() => setAccent('default')}
        aria-label="恢复默认强调色"
      >
        <IconArrowBackUp className="size-4" />
      </Button>
    </div>
  )
}

export function AppearanceSection() {
  const theme = useActiveTheme()
  const isDark = useIsDarkMode()
  const fontTokens = isDark && theme.dark ? theme.dark : theme.tokens
  const themes = useThemeStore((s) => s.themes)
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActive = useThemeStore((s) => s.setActive)
  const importTheme = useThemeStore((s) => s.importTheme)
  const removeTheme = useThemeStore((s) => s.removeTheme)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 外观偏好由公共窗口入口同步投影，分区只维护设置值。
  const colorMode = useAppearanceStore((s) => s.colorMode)
  const setColorMode = useAppearanceStore((s) => s.setColorMode)
  const interfaceSkin = useAppearanceStore((s) => s.interfaceSkin)
  const setInterfaceSkin = useAppearanceStore((s) => s.setInterfaceSkin)
  const uiFontSize = useAppearanceStore((s) => s.uiFontSize)
  const setUiFontSize = useAppearanceStore((s) => s.setUiFontSize)
  const showLineNumbers = useAppearanceStore((s) => s.showLineNumbers)
  const setShowLineNumbers = useAppearanceStore((s) => s.setShowLineNumbers)
  const codeWrap = useAppearanceStore((s) => s.codeWrap)
  const setCodeWrap = useAppearanceStore((s) => s.setCodeWrap)
  const codeFontSize = useAppearanceStore((s) => s.codeFontSize)
  const setCodeFontSize = useAppearanceStore((s) => s.setCodeFontSize)
  const contentFont = useAppearanceStore((s) => s.contentFont)
  const setContentFont = useAppearanceStore((s) => s.setContentFont)
  const codeFont = useAppearanceStore((s) => s.codeFont)
  const setCodeFont = useAppearanceStore((s) => s.setCodeFont)
  const [systemFonts, setSystemFonts] = useState<SystemFonts>({ options: [], status: 'idle' })

  const loadSystemFonts = () => {
    if (systemFonts.status === 'loading' || systemFonts.status === 'ready') return
    setSystemFonts({ options: [], status: 'loading' })
    void readSystemFonts().then(
      (options) => setSystemFonts({ options, status: 'ready' }),
      () => setSystemFonts({ options: [], status: 'failed' }),
    )
  }

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    const raw = await file.text()
    const id = importTheme(raw)
    // 坏包：报错不落库（shape 校验在 parseThemeFile，持久化读取边界）
    setImportError(id ? null : `「${file.name}」不是有效的主题包（缺 name 或格式不合）`)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <SettingsPage title="外观">
      <SettingsGroup label="界面样式">
        <SettingsRow title="深色浅色" desc="应用界面的明暗模式；跟随系统时随操作系统设置切换">
          <Select
            value={colorMode}
            items={COLOR_MODES}
            onValueChange={(next) => {
              // base-ui 清选路径的 null 类型宽度，静态三档不可达，丢弃
              if (next !== null) setColorMode(next)
            }}
          >
            <SelectTrigger aria-label="深色浅色" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {COLOR_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <div className="space-y-3 px-5 py-4">
          <div>
            <div className="text-sm font-medium">主题色</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">为头部和两侧栏添一点色彩，随深浅模式自动适配</div>
          </div>
          <InterfaceSkinPicker value={interfaceSkin} dark={isDark} onValueChange={setInterfaceSkin} />
        </div>
        <SettingsRow title="界面字号" desc="统一调整界面文字，保留标题与小字层级；聊天正文沿用内容主题">
          <Select
            value={String(uiFontSize)}
            items={UI_FONT_SIZES.map((size) => ({ value: String(size), label: `${size} px` }))}
            onValueChange={(next) => { if (next !== null) setUiFontSize(Number(next)) }}
          >
            <SelectTrigger aria-label="界面字号" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {UI_FONT_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} px</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow title="强调色" desc="链接、模式标识与分屏光带的点缀色">
          <AccentControl />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup label="对话">
        <SettingsRow
          title="内容字体"
          desc="分别设置对话正文的英文和中文字体"
        >
          <FontPicker
            label="内容字体"
            kind="content"
            value={contentFont}
            themeName={theme.name}
            tokens={fontTokens}
            systemFonts={systemFonts}
            onOpen={loadSystemFonts}
            onSave={setContentFont}
          />
        </SettingsRow>
        <SettingsRow title="代码字体" desc="分别设置代码块与行内代码的英文和中文字体">
          <FontPicker
            label="代码字体"
            kind="code"
            value={codeFont}
            themeName={theme.name}
            tokens={fontTokens}
            systemFonts={systemFonts}
            onOpen={loadSystemFonts}
            onSave={setCodeFont}
          />
        </SettingsRow>
        <SettingsRow
          title="代码字体大小"
          desc="统一调整聊天代码块、工具输出和控制台代码；跟随主题时，未指定字号的代码使用 14px"
        >
          <Select
            value={codeFontSize === null ? 'theme' : String(codeFontSize)}
            items={[
              { value: 'theme', label: FOLLOW_THEME },
              ...CODE_FONT_SIZES.map((size) => ({ value: String(size), label: `${size} px` })),
            ]}
            onValueChange={(next) => {
              // theme = 清覆盖（null）；档位 id 与档位表同源，越界不可达
              if (next === null) return
              setCodeFontSize(next === 'theme' ? null : Number(next))
            }}
          >
            <SelectTrigger aria-label="代码字体大小" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                <SelectItem value="theme">{FOLLOW_THEME}</SelectItem>
                {CODE_FONT_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} px
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          title="Markdown 主题"
          desc={importError ?? '对话内容的观感，主题包来自 Themd 主题工场'}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={activeThemeId}
              items={[
                { value: DEFAULT_THEME_ID, label: '默认' },
                ...themes.map((t) => ({ value: t.id, label: t.name })),
              ]}
              onValueChange={(next) => {
                if (next !== null) {
                  setActive(next)
                  setImportError(null)
                }
              }}
            >
              <SelectTrigger aria-label="Markdown 主题" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" className="min-w-44">
                <SelectGroup>
                  <SelectItem value={DEFAULT_THEME_ID}>默认</SelectItem>
                  {themes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* 导入：隐藏 file input 由按钮代触发（accept 限主题包扩展名） */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".themd.json,.json"
              className="hidden"
              onChange={(e) => void onPickFile(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              aria-label="导入主题包"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconFileImport className="size-3.5" />
              导入
            </Button>
            <Button
              variant="outline"
              aria-label="删除当前主题"
              // 默认主题不可删（内置常量，不占用户存储）
              disabled={activeThemeId === DEFAULT_THEME_ID}
              onClick={() => removeTheme(activeThemeId)}
            >
              <IconTrash className="size-3.5" />
              删除
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow title="显示代码行号" desc="在对话内容的代码块左侧显示行号">
          <Switch
            checked={showLineNumbers}
            onCheckedChange={setShowLineNumbers}
            aria-label="显示代码行号"
          />
        </SettingsRow>
        <SettingsRow title="长行自动换行" desc="代码内容过长时自动换行；关闭则横向滚动">
          <Switch checked={codeWrap} onCheckedChange={setCodeWrap} aria-label="长行自动换行" />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
