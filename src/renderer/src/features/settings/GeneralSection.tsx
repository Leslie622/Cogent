/**
 * 设置 · 常规分区（UI 件 7，参考稿 ChatGPT 桌面端常规页）：两卡四类控件
 * 定风格 —— 开关（Switch，选中黑底合应用黑白系）、静态下拉钮（菜单属
 * 后续件）、路径 + 更改钮、动作钮。开关状态本地 useState 演示（设置持久化
 * 属引擎后续件）；文案按参考稿原样（ChatGPT→Cogent）。
 * 页头/卡片/行全部来自 SettingsParts 通用件（SettingsPage 骨架），
 * 后续分区照此拼装。
 */
import { useState } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useEngineStore } from '@/stores/engine'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'

/** 下拉占位钮：outline 变体 + 值 + 箭头（点击出菜单属后续件）。
    组件原生形态（2026-11-15 用户定调：不覆盖 shadcn 样式，用变体档位） */
function SelectControl({ value, label }: { value: string; label: string }) {
  return (
    <Button variant="outline" size="sm" aria-label={label}>
      {value}
      <IconChevronDown className="size-3.5 text-muted-foreground" />
    </Button>
  )
}

/** 次级动作钮（更改 / 打开"启动应用"）：secondary 变体原生形态 */
function SecondaryAction({ label }: { label: string }) {
  return (
    <Button variant="secondary" size="sm" aria-label={label}>
      {label}
    </Button>
  )
}

export function GeneralSection() {
  // 「默认权限」真接线（审批交互升级 D6）：开关两态 = 新会话默认 ask ↔ auto
  // （plan 不进默认 —— 临时切入的工作方式而非开局常态，2026-11-11 拍板）；
  // 落 ~/.cogent/settings.json，chat store createSession 在显式选择缺席时消费
  const defaultPermissionMode = useEngineStore((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = useEngineStore((s) => s.setDefaultPermissionMode)
  // 其余开关仍为演示态：设置持久化接入引擎后由 store 替换
  const [fullAccess, setFullAccess] = useState(true)
  const [fullView, setFullView] = useState(false)

  return (
    <SettingsPage title="常规">
      {/* 权限组：两个开关，完整访问带风险说明 + 了解更多（面板属后续件） */}
      <SettingsGroup label="权限">
        <SettingsRow
          title="默认权限"
          desc="开启后新会话默认以完全访问运行（写操作无需确认）；关闭则新会话默认写入前询问"
        >
          <Switch
            checked={defaultPermissionMode === 'auto'}
            onCheckedChange={(checked) => setDefaultPermissionMode(checked ? 'auto' : 'ask')}
            aria-label="默认权限"
          />
        </SettingsRow>
        <SettingsRow
          title="完整访问权限"
          desc={
            <>
              当 Cogent 以完整访问权限运行时，它无需你的批准即可编辑你电脑上的任何文件，并运行可访问网络的命令。这会显著增加数据丢失、泄露或意外行为的风险。
              {/* 链接色用 chrome-accent（应用唯一品牌蓝，分屏线光带同源） */}
              <button
                type="button"
                className="text-chrome-accent hover:underline"
                aria-label="了解更多：关于风险升高的信息"
              >
                了解更多
              </button>
              关于风险升高的信息。
            </>
          }
        >
          <Switch
            checked={fullAccess}
            onCheckedChange={setFullAccess}
            aria-label="完整访问权限"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* 常规组：路径 + 四个下拉 + 开关 + 动作钮 */}
      <SettingsGroup label="常规">
        <SettingsRow
          title="项目外聊天文件夹"
          desc="在项目外发起的聊天，其数据的默认存储位置。"
        >
          <div className="flex items-center gap-3">
            {/* 中性占位（真值 = ~/.cogent，存储根 D1；后续件接目录选择时替换）。
                不得硬编码开发机路径 —— 那是作者机器的用户名，泄漏进用户 UI */}
            <span className="max-w-52 truncate text-xs text-muted-foreground">~/.cogent</span>
            <SecondaryAction label="更改" />
          </div>
        </SettingsRow>
        <SettingsRow title="默认文件打开位置" desc="默认打开文件和文件夹的位置">
          <SelectControl value="VS Code" label="默认文件打开位置" />
        </SettingsRow>
        <SettingsRow title="智能体环境" desc="选择智能体在 Windows 上的运行位置">
          <SelectControl value="Windows 原生" label="智能体环境" />
        </SettingsRow>
        <SettingsRow title="集成终端 Shell" desc="选择要在集成终端中打开的 Shell。">
          <SelectControl value="PowerShell" label="集成终端 Shell" />
        </SettingsRow>
        <SettingsRow title="语言" desc="应用界面语言">
          <SelectControl value="简体中文" label="语言" />
        </SettingsRow>
        <SettingsRow
          title="关闭窗口前确认"
          desc="使用关闭标签页的快捷键会导致窗口关闭时，显示警告"
        >
          <SelectControl value="仅在使用“关闭”快捷键时" label="关闭窗口前确认" />
        </SettingsRow>
        <SettingsRow title="默认使用完整视图" desc="在新聊天中以完整视图打开内容标签页">
          <Switch
            checked={fullView}
            onCheckedChange={setFullView}
            aria-label="默认使用完整视图"
          />
        </SettingsRow>
        <SettingsRow title="登录时启动" desc="开启">
          <SecondaryAction label="打开“启动应用”" />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
