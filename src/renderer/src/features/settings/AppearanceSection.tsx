/**
 * 设置 · 外观分区：「界面样式」一组（深浅色 / 对话内容主题 / 代码行号 /
 * 换行）。偏好落 localStorage（appearance/theme 两个 persist store——
 * 纯渲染端视觉偏好不进 settings.json，theme store 先例定调）。
 * 对话内容主题（首个落地件，docs/技术笔记/对话内容主题.md）：下拉（内置
 * 「默认」+ 已导入）+ 导入（file picker 选 .themd.json，parseThemeFile
 * 校验，坏包行内报错不落库）+ 删除（仅用户主题）。
 * 导入失败反馈用行内错误文案而非 toast：全仓无 toast 基建，不为单一
 * 报错引新件（与计划文档「toast 报错」的偏差，行内更朴素且不抢焦点）。
 */
import { useRef, useState } from 'react'
import { IconFileImport, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DEFAULT_THEME_ID, useThemeStore } from '@/stores/theme'
import {
  ACCENT_OPTIONS,
  CODE_FONT_OPTIONS,
  CODE_FONT_SIZES,
  CONTENT_FONT_OPTIONS,
  useAppearanceStore,
  type ColorMode,
} from '@/stores/appearance'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'

/** 明暗三档（UI 文案；system = 跟随 OS 设置） */
const COLOR_MODES: Array<{ value: ColorMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/** 跟随主题档（字体/字号下拉的首项统一文案） */
const FOLLOW_THEME = '跟随主题'

/** 强调色板（行内一排色块；shadcn 无 color-picker 件，小组件照 ShortcutKbd
    先例落在本文件）：默认档以品牌蓝图钉代表（值 = 不覆盖变量） */
function AccentSwatches() {
  const accent = useAppearanceStore((s) => s.accent)
  const setAccent = useAppearanceStore((s) => s.setAccent)
  const colorMode = useAppearanceStore((s) => s.colorMode)
  // 色块预览按当前面取值（深色面看亮档），选中态 ring 2px
  const dark = colorMode === 'dark'
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="强调色">
      <button
        type="button"
        aria-label="默认（品牌蓝）"
        onClick={() => setAccent('default')}
        className={`size-5 rounded-full ring-offset-2 ring-offset-background ${
          accent === 'default' ? 'ring-2 ring-ring' : ''
        }`}
        style={{ background: dark ? 'oklch(0.72 0.21 264)' : '#0231fa' }}
      />
      {ACCENT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          onClick={() => setAccent(option.value)}
          className={`size-5 rounded-full ring-offset-2 ring-offset-background ${
            accent === option.value ? 'ring-2 ring-ring' : ''
          }`}
          style={{ background: dark ? option.dark : option.light }}
        />
      ))}
    </div>
  )
}

export function AppearanceSection() {
  const themes = useThemeStore((s) => s.themes)
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActive = useThemeStore((s) => s.setActive)
  const importTheme = useThemeStore((s) => s.importTheme)
  const removeTheme = useThemeStore((s) => s.removeTheme)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 外观偏好（appearance store；DOM 落点 html.dark / data-code-wrap / 强调色由 App 层挂）
  const colorMode = useAppearanceStore((s) => s.colorMode)
  const setColorMode = useAppearanceStore((s) => s.setColorMode)
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
        <SettingsRow title="强调色" desc="链接、模式标识与分屏光带的点缀色；色板按明暗双值切换">
          <AccentSwatches />
        </SettingsRow>
        <SettingsRow
          title="内容字体"
          desc="对话内容正文的字体；跟随主题时不覆盖主题包设定"
        >
          <Select
            value={contentFont}
            items={[{ value: 'theme', label: FOLLOW_THEME }, ...CONTENT_FONT_OPTIONS]}
            onValueChange={(next) => {
              if (next !== null) setContentFont(next)
            }}
          >
            <SelectTrigger aria-label="内容字体" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                <SelectItem value="theme">{FOLLOW_THEME}</SelectItem>
                {CONTENT_FONT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow title="代码字体" desc="代码块与行内代码的等宽字体">
          <Select
            value={codeFont}
            items={[{ value: 'theme', label: FOLLOW_THEME }, ...CODE_FONT_OPTIONS]}
            onValueChange={(next) => {
              if (next !== null) setCodeFont(next)
            }}
          >
            <SelectTrigger aria-label="代码字体" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                <SelectItem value="theme">{FOLLOW_THEME}</SelectItem>
                {CODE_FONT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          title="代码字体大小"
          desc="代码块的基础字号；跟随主题时与正文字号一致"
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
          title="对话内容"
          desc={
            importError ??
            '对话内容（Markdown）的主题观感，主题包来自 Themd 主题工场导出（.themd.json）；删除当前主题自动回落默认'
          }
        >
          <div className="flex items-center gap-2">
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
              <SelectTrigger aria-label="对话内容主题" className="w-44">
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
              size="sm"
              aria-label="导入主题包"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconFileImport className="size-3.5" />
              导入
            </Button>
            <Button
              variant="outline"
              size="sm"
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
