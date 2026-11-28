/**
 * 设置搜索静态目录：
 *   - 页面入口覆盖 SETTINGS_GROUPS 全部 14 个分区（含占位页标题），附准确别名
 *   - 固定配置项覆盖常规、外观、通知、存储中可唯一定位的行
 *   - 标题与静态纯文本说明由本目录与各 Section 共用（SETTING_COPY），避免双份文案漂移
 *   - 不包含配置值、密钥、路径值或用户资源正文
 */
import type { SettingsSectionId } from '@/stores/settings'
import { SETTINGS_GROUPS } from '../data'

export interface SearchEnvironment {
  platform?: string
  backdropSupported?: boolean
  dark?: boolean
}

export interface SettingItemEntry {
  kind: 'item'
  id: string
  section: SettingsSectionId
  /** 组内路径（不含大分组与页面名，如 "对话" 或 "空间占用"） */
  groupLabel: string
  /** 完整展示路径（如 "基础设置 › 外观 › 对话"） */
  path: string
  title: string
  desc: string
  aliases: readonly string[]
  scope?: 'user'
  order: number
  isVisible?: (env: SearchEnvironment) => boolean
}

export interface SettingPageEntry {
  kind: 'page'
  id: string
  section: SettingsSectionId
  groupLabel: string
  path: string
  title: string
  aliases: readonly string[]
  order: number
}

/**
 * 固定配置项文案与搜索目录单写源：各 *Section.tsx 直接引用此处 title/desc，
 * 动态说明（如默认音量百分比、带路径或错误回显）的页面另行组合 ReactNode，
 * 此处保留其稳定语义文本。
 */
export const SETTING_COPY = {
  // 常规
  'general.default-permission': {
    title: '默认权限',
    desc: '开启后新会话默认以完全访问运行（写操作无需确认）；关闭则新会话默认写入前询问',
  },
  'general.auto-title': {
    title: '自动生成会话名称',
    desc: '根据第一条消息概括名称，会额外调用一次模型；手动命名优先。',
  },
  'general.output-verbosity': {
    title: '输出详细程度',
    desc: '简洁模式隐藏工具和思考详情，以及 token、成本等底部统计信息',
  },
  'general.process-usage': {
    title: '显示过程请求详情',
    desc: '在详细模式下显示过程中每次请求的 token、缓存、成本和耗时；不影响最终总体统计',
  },
  'general.duration-precision': {
    title: '耗时显示格式',
    desc: '耗时自动显示为秒、分秒或小时分；此设置仅控制秒位的小数精度。',
  },
  'general.send-shortcut': {
    title: '发送快捷键',
    desc: '在聊天输入框中按下所选组合键发送消息，其余 Enter 组合键换行',
  },
  'general.close-behavior': {
    title: '关闭窗口时',
    desc: '设置关闭最后一个窗口时的行为；最小化将隐藏到系统托盘（引擎继续运行）',
  },
  'general.hardware-acceleration': {
    title: 'Chrome 硬件加速',
    desc: '关闭后可规避部分显卡或驱动导致的白屏、闪退、渲染异常。修改后需重启应用生效。',
  },

  // 外观
  'appearance.color-mode': {
    title: '深色浅色',
    desc: '应用界面的明暗模式；跟随系统时随操作系统设置切换',
  },
  'appearance.interface-skin': {
    title: '主题色',
    desc: '为头部和两侧栏添一点色彩，随深浅模式自动适配',
  },
  'appearance.shell-opacity': {
    title: '外壳不透明度',
    desc: '调节头部与两侧栏的透光程度，100% 时完全不透明',
  },
  'appearance.popover-glass': {
    title: '浮层毛玻璃',
    desc: '开启下拉选择、菜单与轻量浮层的毛玻璃效果，关闭后回落实色',
  },
  'appearance.popover-glass-opacity': {
    title: '浮层不透明度',
    desc: '调节浮层玻璃面纱的不透明度，越低越透出背后内容',
  },
  'appearance.popover-glass-blur': {
    title: '浮层模糊度',
    desc: '调节浮层背后的高斯模糊半径（px），过大时会把细小文字抹平',
  },
  'appearance.popover-glass-saturate': {
    title: '浮层饱和度',
    desc: '调节浮层透出背景的色彩饱和度，越高色彩越鲜明',
  },
  'appearance.hover-slide': {
    title: '开启滑动动画',
    desc: '并列的按钮、列表行与菜单项之间，悬停高亮平滑滑到下一项；关闭后各行各自显示悬停底色',
  },
  'appearance.hover-transition': {
    title: '开启过渡效果',
    desc: '悬停时底色、文字色与边框色的渐变过渡；关闭后即时切换',
  },
  'appearance.hover-transition-duration': {
    title: '过渡时长',
    desc: '悬停高亮与文字颜色的渐变时长，越长越柔',
  },
  'appearance.ui-font-size': {
    title: '界面字号',
    desc: '统一调整界面文字，保留标题与小字层级；聊天正文沿用内容主题',
  },
  'appearance.accent': {
    title: '强调色',
    desc: '链接、模式标识与分屏光带的点缀色',
  },
  'appearance.content-font': {
    title: '内容字体',
    desc: '分别设置对话正文的英文和中文字体',
  },
  'appearance.markdown-theme': {
    title: 'Markdown 主题',
    desc: '对话内容的观感，主题包来自 Themd 主题工场',
  },
  'appearance.code-font': {
    title: '代码字体',
    desc: '分别设置代码块、文件预览与行内代码的英文和中文字体',
  },
  'appearance.code-font-size': {
    title: '代码字体大小',
    desc: '统一调整聊天代码块、文件预览、工具输出和控制台代码；跟随主题时，未指定字号的代码使用 14px',
  },
  'appearance.code-line-numbers': {
    title: '显示代码行号',
    desc: '在代码块与文件预览左侧显示行号',
  },
  'appearance.code-wrap': {
    title: '长行自动换行',
    desc: '代码内容过长时自动换行；关闭则横向滚动',
  },

  // 通知
  'notifications.turn-done': {
    title: '轮次完成通知',
    desc: '设置 Agent 完成一轮后何时提醒你（失败同样按此提醒；自己中止不提醒）',
  },
  'notifications.approval': {
    title: '权限请求通知',
    desc: 'Agent 需要授权才能继续时提醒你',
  },
  'notifications.question': {
    title: '等待回答通知',
    desc: 'Agent 等待你回答问题时提醒你',
  },
  'notifications.toast': {
    title: '系统通知',
    desc: '以系统通知（toast）呈现提醒，点击可回到窗口',
  },
  'notifications.sound-enabled': {
    title: '播放提示音',
    desc: '以应用内提示音呈现提醒（音源在下方「提示音」组配置）',
  },
  'notifications.system-settings': {
    title: '系统通知设置',
    desc: '在系统中配置 Cogent 的通知行为（免打扰、横幅等）',
  },
  'notifications.sound-volume': {
    title: '音量',
    desc: '内置提示音与自定义文件共用',
  },
  'notifications.sound-pitch': {
    title: '音调',
    desc: '默认原音，调节内置提示音的高低（自定义文件不受影响）',
  },
  'notifications.sound-turn-done': {
    title: '轮次完成声音',
    desc: '轮次完成/失败时的提示音',
  },
  'notifications.sound-approval': {
    title: '权限请求声音',
    desc: '等待授权时的提示音',
  },
  'notifications.sound-question': {
    title: '等待回答声音',
    desc: '等待回答时的提示音',
  },

  // 存储
  'storage.usage': {
    title: '空间占用',
    desc: '统计应用数据占用的磁盘空间与分类分布',
  },
  'storage.detail': {
    title: '占用明细',
    desc: '展开查看会话转录与其他数据的空间占用明细',
  },
  'storage.data-folder': {
    title: '应用数据文件夹',
    desc: '应用数据的本地存储根文件夹位置',
  },

} as const

export type SettingItemId = keyof typeof SETTING_COPY

const SECTION_META = new Map<
  SettingsSectionId,
  { groupLabel: string; pageLabel: string; order: number }
>()

let sectionOrder = 0
for (const group of SETTINGS_GROUPS) {
  for (const item of group.items) {
    SECTION_META.set(item.id, {
      groupLabel: group.label,
      pageLabel: item.label,
      order: sectionOrder++,
    })
  }
}

const PAGE_ALIASES: Record<SettingsSectionId, readonly string[]> = {
  general: ['通用', '权限', '快捷键', '托盘', 'GPU'],
  appearance: ['主题', '样式', '字体', '皮肤', '深色', '浅色'],
  notifications: ['提醒', '声音', '提示音', '音效'],
  models: ['供应商', 'Provider', 'API Key', 'Base URL', '模型', '推理', '上下文'],
  'archived-chats': ['已归档的聊天', '归档会话', '恢复会话'],
  storage: ['磁盘', '清理', '缓存', '数据目录'],
  browser: ['内置浏览器', '网页'],
  'computer-control': ['桌面控制', '自动化'],
  shortcuts: ['快捷键', '热键'],
  plugins: ['扩展', 'Plugin'],
  connections: ['MCP', '服务器', 'Tools'],
  skills: ['Skill', '技能包', '指令'],
  commands: ['斜杠命令', 'Command'],
  hooks: ['Hook', '生命周期钩子'],
}

export const SETTING_PAGE_ENTRIES: readonly SettingPageEntry[] = SETTINGS_GROUPS.flatMap(
  (group) =>
    group.items.map((item) => {
      const meta = SECTION_META.get(item.id)!
      return {
        kind: 'page' as const,
        id: `page.${item.id}`,
        section: item.id,
        groupLabel: group.label,
        path: `${group.label} › ${item.label}`,
        title: item.label,
        aliases: PAGE_ALIASES[item.id],
        order: meta.order,
      }
    }),
)

function item(
  id: SettingItemId,
  section: SettingsSectionId,
  groupLabel: string,
  aliases: readonly string[],
  order: number,
  options?: {
    scope?: 'user'
    isVisible?: (env: SearchEnvironment) => boolean
  },
): SettingItemEntry {
  const meta = SECTION_META.get(section)!
  const copy = SETTING_COPY[id]
  return {
    kind: 'item',
    id,
    section,
    groupLabel,
    path: `${meta.groupLabel} › ${meta.pageLabel} › ${groupLabel}`,
    title: copy.title,
    desc: copy.desc,
    aliases,
    scope: options?.scope,
    order: meta.order * 100 + order,
    isVisible: options?.isVisible,
  }
}

export const SETTING_ITEM_ENTRIES: readonly SettingItemEntry[] = [
  // 常规
  item('general.default-permission', 'general', '权限', ['自动批准', '完全访问', '写入前询问', 'permission'], 1),
  item('general.auto-title', 'general', '对话', ['会话标题', '自动命名', '标题生成'], 2),
  item('general.output-verbosity', 'general', '对话', ['简洁模式', '详细模式', '工具详情', 'verbosity'], 3),
  item('general.process-usage', 'general', '对话', ['token', '成本', '耗时', '过程统计', 'usage'], 4),
  item('general.duration-precision', 'general', '对话', ['小数精度', '时间格式', 'duration'], 5),
  item('general.send-shortcut', 'general', '常规', ['Enter', 'Shift+Enter', 'Ctrl+Enter', '换行'], 6),
  item('general.close-behavior', 'general', '常规', ['最小化到托盘', '退出', '每次询问'], 7),
  item('general.hardware-acceleration', 'general', '常规', ['GPU', '显卡', '白屏', '硬件加速'], 8),

  // 外观
  item('appearance.color-mode', 'appearance', '界面样式', ['夜间模式', '暗色模式', '日间模式', '跟随系统', 'theme'], 1),
  item('appearance.interface-skin', 'appearance', '界面样式', ['皮肤', '墨色', '薄荷', '蜜蜂', '羊皮纸', '海盐', '暮紫'], 2),
  item('appearance.shell-opacity', 'appearance', '界面样式', ['透明度', '毛玻璃', '透光', 'acrylic'], 3, {
    isVisible: (env) => Boolean(env.backdropSupported) && !env.dark,
  }),
  item('appearance.popover-glass', 'appearance', '界面样式', ['毛玻璃', '下拉', '菜单', '浮层', 'glass'], 4),
  item('appearance.popover-glass-opacity', 'appearance', '界面样式', ['毛玻璃', '不透明度', '半透明', '透明度', '透光', 'alpha'], 5),
  item('appearance.popover-glass-blur', 'appearance', '界面样式', ['毛玻璃', '模糊度', '模糊半径', '磨砂', 'blur'], 6),
  item('appearance.popover-glass-saturate', 'appearance', '界面样式', ['毛玻璃', '饱和度', '鲜艳', 'saturate'], 7),
  item('appearance.hover-slide', 'appearance', '界面样式', ['滑动', '胶囊', '磁吸', 'hover', '动画'], 8),
  item('appearance.hover-transition', 'appearance', '界面样式', ['过渡', '渐变', '动画', 'hover', 'transition'], 9),
  item('appearance.hover-transition-duration', 'appearance', '界面样式', ['过渡', '时长', '渐变', 'duration'], 10),
  item('appearance.ui-font-size', 'appearance', '界面样式', ['字体大小', '缩放', '字号'], 11),
  item('appearance.accent', 'appearance', '界面样式', ['主题强调色', '点缀色', 'accent'], 12),
  item('appearance.content-font', 'appearance', '对话', ['字体风格', '正文字体', '中文字体', '英文字体'], 13),
  item('appearance.markdown-theme', 'appearance', '对话', ['Themd', '主题包', '内容主题', '导入主题'], 14),
  item('appearance.code-font', 'appearance', '代码', ['等宽字体', '代码块字体', 'monospace'], 15),
  item('appearance.code-font-size', 'appearance', '代码', ['代码字号'], 16),
  item('appearance.code-line-numbers', 'appearance', '代码', ['行号', 'line numbers'], 17),
  item('appearance.code-wrap', 'appearance', '代码', ['自动换行', 'word wrap'], 18),

  // 通知
  item('notifications.turn-done', 'notifications', '通知', ['完成提醒', '轮次提醒'], 1),
  item('notifications.approval', 'notifications', '通知', ['授权提醒', '审批通知'], 2),
  item('notifications.question', 'notifications', '通知', ['提问提醒', '等待输入'], 3),
  item('notifications.toast', 'notifications', '提醒方式', ['桌面通知', 'toast'], 4),
  item('notifications.sound-enabled', 'notifications', '提醒方式', ['声音提醒', '提示音开关'], 5),
  item('notifications.system-settings', 'notifications', '提醒方式', ['免打扰', '系统通知权限', '横幅'], 6, {
    isVisible: (env) => env.platform !== 'linux',
  }),
  item('notifications.sound-volume', 'notifications', '提示音', ['声音大小', 'volume'], 7),
  item('notifications.sound-pitch', 'notifications', '提示音', ['频率', '音高', 'pitch'], 8),
  item('notifications.sound-turn-done', 'notifications', '提示音', ['自定义音效', '完成提示音'], 9),
  item('notifications.sound-approval', 'notifications', '提示音', ['自定义音效', '授权提示音'], 10),
  item('notifications.sound-question', 'notifications', '提示音', ['自定义音效', '回答提示音'], 11),

  // 存储
  item('storage.usage', 'storage', '空间占用', ['磁盘空间', '容量', '重新统计'], 1),
  item('storage.detail', 'storage', '空间占用', ['会话转录大小', '磁盘明细'], 2),
  item('storage.data-folder', 'storage', '数据文件夹', ['存储路径', '打开文件夹', 'cogent 目录'], 3),

]
