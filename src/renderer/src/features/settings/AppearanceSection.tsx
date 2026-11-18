/**
 * 设置 · 外观分区（首个落地件：聊天正文主题，docs/技术笔记/聊天正文主题.md）。
 * 主题下拉（内置「默认」+ 已导入）+ 导入（file picker 选 .themd.json，
 * parseThemeFile 校验，坏包行内报错不落库）+ 删除（仅用户主题）。
 * 导入失败反馈用行内错误文案而非 toast：全仓无 toast 基建，不为单一
 * 报错引新件（与计划文档「toast 报错」的偏差，行内更朴素且不抢焦点）。
 */
import { useRef, useState } from 'react'
import { IconFileImport, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DEFAULT_THEME_ID, useThemeStore } from '@/stores/theme'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'

export function AppearanceSection() {
  const themes = useThemeStore((s) => s.themes)
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActive = useThemeStore((s) => s.setActive)
  const importTheme = useThemeStore((s) => s.importTheme)
  const removeTheme = useThemeStore((s) => s.removeTheme)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    const raw = await file.text()
    const id = importTheme(raw)
    // 坏包：报错不落库（shape 校验在 parseThemeFile，持久化读取边界）
    setImportError(id ? null : `「${file.name}」不是有效的主题包（缺 name 或格式不合）`)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <SettingsPage
      title="外观"
      desc="聊天正文（Markdown 消息）的主题观感。主题包来自 Themd 主题工场的导出（.themd.json）；「默认」= 不套主题的原生观感。"
    >
      <SettingsGroup label="聊天正文">
        <SettingsRow
          title="正文主题"
          desc={
            importError ?? '切换即时生效，作用于会话里的助手消息正文；删除当前主题自动回落默认。'
          }
        >
          <div className="flex items-center gap-2">
            <Select
              value={activeThemeId}
              onValueChange={(next) => {
                if (next !== null) {
                  setActive(next)
                  setImportError(null)
                }
              }}
            >
              <SelectTrigger aria-label="正文主题" className="w-44">
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
              // 默认主题不可删（空令牌常量，不占用户存储）
              disabled={activeThemeId === DEFAULT_THEME_ID}
              onClick={() => removeTheme(activeThemeId)}
            >
              <IconTrash className="size-3.5" />
              删除
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
