/**
 * 设置页内容区：id → 分区组件。
 * 「常规」按图2 卡片行样式演示（Card + Select/Switch/Input）；其余分区统一占位，
 * 随各设置项落地逐个替换。
 */
import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { SettingRow } from '@/components/SettingRow'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'models'
  | 'shortcuts'
  | 'persona'
  | 'memory'
  | 'subagents'
  | 'plugins'
  | 'mcp'
  | 'skills'
  | 'hooks'
  | 'usage'
  | 'projects'
  | 'sessions'
  | 'automation'
  | 'browser'
  | 'boxes'

/** 「常规」分区：演示卡片行，设置项均为展示占位（持久化等 storage/凭据落地） */
function GeneralSection() {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">常规</h1>
      <Card>
        <CardContent className="divide-y px-4">
          <SettingRow title="界面语言" desc="选择应用 UI 的显示语言。">
            <Select defaultValue="system">
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">系统默认</SelectItem>
                <SelectItem value="zh-CN">简体中文</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="界面模式" desc="简洁模式只看摘要与结果；详细模式显示命令、输出和代码变更详情。">
            <Select defaultValue="detail">
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">简洁模式</SelectItem>
                <SelectItem value="detail">详细模式</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="主动任务推荐" desc="仅在简洁模式下支持。">
            <Switch />
          </SettingRow>
          <SettingRow title="终端字体" desc="留空时自动探测系统终端配置。">
            <div className="flex items-center gap-2">
              <Input placeholder="留空自动继承" className="w-56" />
              <Button variant="secondary" size="sm">
                保存
              </Button>
            </div>
          </SettingRow>
        </CardContent>
      </Card>
    </>
  )
}

/** 占位分区：标题 + 待实现提示 */
function PlaceholderSection({ title }: { title: string }) {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">该设置分区待实现。</p>
    </>
  )
}

const TITLES: Record<Exclude<SettingsSectionId, 'general'>, string> = {
  appearance: '外观',
  models: '模型设置',
  shortcuts: '键盘快捷键',
  persona: '个性化',
  memory: '记忆',
  subagents: '子智能体',
  plugins: '插件',
  mcp: 'MCP 服务器',
  skills: '技能',
  hooks: '钩子',
  usage: '使用统计',
  projects: '项目',
  sessions: '会话管理',
  automation: '自动化',
  browser: '浏览器控制',
  boxes: '设备'
}

/** id → 分区组件（SettingsPage 据此渲染） */
export const settingsSections: Record<SettingsSectionId, ReactNode> = {
  general: <GeneralSection />,
  ...Object.fromEntries(Object.entries(TITLES).map(([id, title]) => [id, <PlaceholderSection title={title} />]))
} as Record<SettingsSectionId, ReactNode>
