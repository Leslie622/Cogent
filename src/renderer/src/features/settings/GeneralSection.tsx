/**
 * 设置 · 常规分区：权限与窗口行为落 ~/.cogent/settings.json；
 * 对话显示偏好复用 appearance store，仅由 renderer 消费。
 * 页头/卡片/行全部来自 SettingsParts 通用件（SettingsPage 骨架）。
 */
import { Fragment } from 'react'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useEngineStore, type CloseBehavior, type SendShortcut } from '@/stores/engine'
import { useAppearanceStore, type OutputVerbosity } from '@/stores/appearance'
import type { DurationPrecision } from '@/lib/format-duration'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'
import { SessionTitleSettings } from './SessionTitleSettings'

/** 发送组合键三档（keys 供 kbd 键帽渲染；label 是兜底文案） */
const SEND_SHORTCUTS: Array<{ value: SendShortcut; label: string; keys: string[] }> = [
  { value: 'enter', label: 'Enter', keys: ['Enter'] },
  { value: 'shift+enter', label: 'Shift + Enter', keys: ['Shift', 'Enter'] },
  { value: 'ctrl+enter', label: 'Ctrl + Enter', keys: ['Ctrl', 'Enter'] }
]

/** 关闭行为三档（纯文本选项；ask 档的「不再询问」在询问弹窗里固化） */
const CLOSE_BEHAVIORS: Array<{ value: CloseBehavior; label: string }> = [
  { value: 'minimize', label: '最小化' },
  { value: 'quit', label: '退出' },
  { value: 'ask', label: '每次询问' }
]

const OUTPUT_VERBOSITIES: Array<{ value: OutputVerbosity; label: string }> = [
  { value: 'low', label: '简洁' },
  { value: 'high', label: '详细' },
]

const DURATION_PRECISIONS: Array<{ value: DurationPrecision; label: string }> = [
  { value: 0, label: '整数' },
  { value: 1, label: '1 位小数' },
  { value: 2, label: '2 位小数' },
]

/** 组合键键帽（触发器与菜单项共用）：键帽间以弱色 + 相连，组合读法一目了然 */
function ShortcutKbd({ keys }: { keys: string[] }) {
  return (
    <KbdGroup>
      {keys.map((k, index) => (
        <Fragment key={k}>
          {index > 0 && <span className="text-xs text-muted-foreground">+</span>}
          <Kbd>{k}</Kbd>
        </Fragment>
      ))}
    </KbdGroup>
  )
}

export function GeneralSection() {
  const outputVerbosity = useAppearanceStore((s) => s.outputVerbosity)
  const setOutputVerbosity = useAppearanceStore((s) => s.setOutputVerbosity)
  const showProcessUsage = useAppearanceStore((s) => s.showProcessUsage)
  const setShowProcessUsage = useAppearanceStore((s) => s.setShowProcessUsage)
  const durationPrecision = useAppearanceStore((s) => s.durationPrecision)
  const setDurationPrecision = useAppearanceStore((s) => s.setDurationPrecision)
  // 「默认权限」：开关两态 = 新会话默认 ask ↔ auto（plan 不进默认 ——
  // 临时切入的工作方式而非开局常态，2026-11-11 拍板）；
  // 落 ~/.cogent/settings.json，chat store createSession 在显式选择缺席时消费
  const defaultPermissionMode = useEngineStore((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = useEngineStore((s) => s.setDefaultPermissionMode)
  // 「发送快捷键」：输入框按下所选组合发送、其余 Enter 组合换行（HomeChat 消费）
  const sendShortcut = useEngineStore((s) => s.sendShortcut)
  const setSendShortcut = useEngineStore((s) => s.setSendShortcut)
  // 「关闭窗口时」：main 侧 close 拦截消费（读盘即时生效），此处撑显示与落盘
  const closeBehavior = useEngineStore((s) => s.closeBehavior)
  const setCloseBehavior = useEngineStore((s) => s.setCloseBehavior)
  // 「Chrome 硬件加速」：main 启动期消费（disableHardwareAcceleration 只准
  // ready 前调），此处撑显示与落盘，改后重启生效
  const hardwareAcceleration = useEngineStore((s) => s.hardwareAcceleration)
  const setHardwareAcceleration = useEngineStore((s) => s.setHardwareAcceleration)
  // 键帽渲染查表：受控 value 恒在表内（store 值域与表同源）
  const current = SEND_SHORTCUTS.find((option) => option.value === sendShortcut)

  return (
    <SettingsPage title="常规">
      {/* 权限组：默认权限开关，完整访问带风险说明的行属后续件 */}
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
      </SettingsGroup>

      <SettingsGroup label="对话">
        <SessionTitleSettings />
        <SettingsRow
          title="输出详细程度"
          desc="简洁模式隐藏工具和思考详情，以及 token、成本等底部统计信息"
        >
          <Select
            value={outputVerbosity}
            items={OUTPUT_VERBOSITIES}
            onValueChange={(next) => {
              if (next !== null) setOutputVerbosity(next)
            }}
          >
            <SelectTrigger aria-label="输出详细程度" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {OUTPUT_VERBOSITIES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          title="显示过程请求详情"
          desc="在详细模式下显示过程中每次请求的 token、缓存、成本和耗时；不影响最终总体统计"
        >
          <Switch
            checked={showProcessUsage}
            onCheckedChange={setShowProcessUsage}
            aria-label="显示过程请求详情"
          />
        </SettingsRow>
        <SettingsRow
          title="耗时显示格式"
          desc="耗时自动显示为秒、分秒或小时分；此设置仅控制秒位的小数精度。"
        >
          <Select
            value={durationPrecision}
            items={DURATION_PRECISIONS}
            onValueChange={(next) => {
              if (next !== null) setDurationPrecision(next)
            }}
          >
            <SelectTrigger aria-label="耗时显示格式" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {DURATION_PRECISIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="常规">
        <SettingsRow
          title="发送快捷键"
          desc="在聊天输入框中按下所选组合键发送消息，其余 Enter 组合键换行"
        >
          {/* shadcn Select 原生形态（base-nova 版）；w-40 布局类定行控件宽
              （约定允许），w-fit 胶囊只包文字会塌成一小条 */}
          <Select
            value={sendShortcut}
            items={SEND_SHORTCUTS}
            onValueChange={(next) => {
              // base-ui 单选的 onValueChange 类型含 null（清选路径）；静态三档
              // 无清选入口，null 实际不可达 —— 真出现时丢弃不动当前值
              if (next !== null) setSendShortcut(next)
            }}
          >
            <SelectTrigger aria-label="发送快捷键" className="w-40">
              {/* children 覆盖默认 label 渲染，键帽显示当前组合 */}
              <SelectValue>{current && <ShortcutKbd keys={current.keys} />}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {SEND_SHORTCUTS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <ShortcutKbd keys={option.keys} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          title="关闭窗口时"
          desc="设置关闭最后一个窗口时的行为；最小化将隐藏到系统托盘（引擎继续运行）"
        >
          <Select
            value={closeBehavior}
            items={CLOSE_BEHAVIORS}
            onValueChange={(next) => {
              // 同上：null = base-ui 清选路径的类型宽度，静态三档不可达，丢弃
              if (next !== null) setCloseBehavior(next)
            }}
          >
            <SelectTrigger aria-label="关闭窗口时" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {CLOSE_BEHAVIORS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          title="Chrome 硬件加速"
          desc="关闭后可规避部分显卡或驱动导致的白屏、闪退、渲染异常。修改后需重启应用生效。"
        >
          <Switch
            checked={hardwareAcceleration}
            onCheckedChange={setHardwareAcceleration}
            aria-label="Chrome 硬件加速"
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
