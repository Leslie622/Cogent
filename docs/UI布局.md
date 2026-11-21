# UI 布局与视觉配方

> 本文负责区域、视觉配方、组件用法与样式陷阱；功能机制见对应模块页。
> 区域代号用于描述、注释和组件命名。历史过程查 Git，不在本文追加实施流水账。

## 布局结构

主窗口由 Electron 限制最小尺寸为 400×600px；初始尺寸为 1120×730px。

```text
shell ─┬─ header            40px 拖拽区：折叠开关、菜单、窗口控制
       └─ body
          ├─ app-sidebar   50px 固定图标栏：路由、设置
          └─ content       白卡：左上圆角、左描边、紧投影
             ├─ content-sidebar   240–360px 像素宽，可折至 0
             └─ content-main
                ├─ home      HomeChat | HomeTabs（280–520px，默认收起）
                └─ settings  SettingsMain，按分区挂内容
```

- header 的“文件”“编辑”“视图”“帮助”使用文字按钮（Button ghost / header），
  同处一个 `gap-1` 容器；窗口 ≤760px 时文字菜单收进“应用菜单”，保留窗口控制三钮。
- 左下角设置菜单依次为“设置”、分隔线、“运行时控制台”“内嵌页面”、分隔线、“关于”；
  使用带左侧图标的 DropdownMenuItem，菜单沿用 lg 档，向右弹出并底端对齐。
- `app-sidebar` 上区路由钮与底部设置钮统一使用 `Button ghost / icon-lg`（36×36px），
  图标为 20px（`size-5`），普通态与激活态尺寸一致。
- `content-sidebar` 是普通 flex 像素宽块，不进 react-resizable-panels（RRP）；
  CSS 保证缩放时像素宽稳定，避免百分比尺寸经 JS 校正产生脏帧。
- `SidebarResizeHandle` 使用 pointer capture + rAF 直写宽度；拖过下限有阻力，
  越过 min/2 折叠（落点 `collapsedWidth`：侧栏折成 0，模型设置左栏折成 48px
  图标栏），反向对称恢复；键盘 ±16px，双击回默认。
  首页会话列表右侧只显示分割线与拖拽光带，不显示中央胶囊；整条线仍可拖拽调宽。
- `use-content-sidebar-split` 记忆宽度/折叠态，首帧直接还原；只在用户手势后落盘。
  模型设置左栏同方案（`use-provider-rail-split`，像素宽可拖可折）。
- 窗口 ≤1100px 自动折叠右侧标签页区，≤760px 自动折叠会话侧栏；400px 时内容区
  仅显示对话。自动约束不写入手动布局记忆，放宽后恢复原开合/宽度，手动关闭的栏仍关闭；
  自动收起期间禁用展开入口与分割线，收起内容 inert。窗口断点由 `use-window-media-query` 订阅。
- HomeMain 内部分屏是百分比语义，使用 RRP v4 + `GlowResizeHandle`；
  折叠后把手贴缘可展开抓取，按钮通过 `usePanelRef` 的 collapse/expand 操作。
- 路由是 `stores/ui` 的 AppView；`stores/home` 管首页会话，`stores/settings`
  管设置分区；当前按 view 切换挂载。保活目标见 [页面切换状态保留](计划/页面切换状态保留.md)。

## 颜色、字体与空间

| 对象 | 配方 |
| --- | --- |
| header + app-sidebar | `.chrome-surface` 消费主题色的 135° 三段渐变；森林 / 薄荷 / 蜜蜂 / 羊皮纸 / 海盐 / 暮紫各有浅深两套，默认薄荷；共享色板在 `lib/interface-skins.ts` |
| content-sidebar / main | `--content-sidebar` 随主题色与明暗换套；main 沿用 `--background`，浅色纯白、深色中性暗底，形成层级 |
| hover / active | 黑低透明软叠 `bg-foreground/5` 或 `bg-accent-foreground/5`；active 保持同一深度 |
| 行内小钮 | 一律原生 ghost（hover `bg-muted`）；软叠配方只属于自绘行，不落在 Button 调用点 |
| 文字 | 实色 token；次级 `muted-foreground`，placeholder `--placeholder`；层级靠实色深浅 |
| 语义色 | destructive 错误红；warning 琥珀 `oklch(0.666 0.155 70)`；chrome-accent 品牌蓝 `#0231fa` |
| 聚焦 | 组件共用 `--focus-width: 1px` 与 `--focus-color` 内贴实线，浅色 `oklch(0.556 0 0)`、深色 `oklch(0.708 0 0)`，默认 150ms 淡入淡出；已有动效的控件沿用其时长，reduced-motion 直接切换。自定义输入不显示聚焦描边，包括原生 input、自定义外壳内的 `Input variant="embedded"` 与对话输入卡 composer；普通 Input、Textarea、InputGroup 保留统一效果 |
| 圆角 | 内容主体左上角 `--radius-xl`；输入卡 `InputGroup` composer 档 `rounded-2xl`（原生表单仍 `rounded-lg`）；发送/停止钮 `Button icon-sm` 原生圆角；其余按组件变体，信息区条只圆上两角 |
| 字号 | 默认小字/说明 12、正文/列表 14、分组/侧栏/弹窗标题 16、页面标题 24；分别用 text-xs / text-sm / text-base / text-2xl，界面基准 11–16px 统一派生，小字最低 10px |
| 字体 | Inter + HarmonyOS Sans SC；代码 JetBrains Mono，中文注释回落鸿蒙；常规中文用 400 |

应用文字使用 Electron 40.9.3 的原生字体渲染，常规字重保持 400，不施加全局文字描边。
字体选择与绘制边界见[对话内容主题](技术笔记/对话内容主题.md)。
启动参数的对照验证需完整重启应用；字体清晰度与 DPI 的最终结论在实际 Electron 验证。

UI 默认不可选中；正文容器放开 `select-text`，TraceLine/用量/时间等行头收回
`select-none`，折叠内容仍可选。input/textarea 保持原生选择。

## 组件库与安装

- `components.json` 的 style 为 `base-nova`，原语为 Base UI；用现有 variant/size，
  调用点只调整布局。组件选择纪律统一见 [约定](约定.md)。
- 本地组合件包括 Markdown、Reasoning、Tool、RunTrace；它们消费基础组件，
  不应因 registry 没有同名成品而重写整套视觉。
- 更换风格或更新组件使用官方 Merge 流程：先看 diff，再保留本地定制。
  electron-vite 不被 CLI 框架检测支持时，可用临时 Vite 项目取得官方基准后逐项对齐。
  preset 参数为 `--preset nova --base base`，不是把 `base-nova` 当 preset 名。
- 合并时保留自定义 token、字体、`@source streamdown`、滚动条、渐隐与动效。
  Nova 默认基础 radius 与本项目均为 0.625rem；不要顺带更换大卡的圆角阶算法。
- 聚焦视觉由 `globals.css` 的 `:focus-visible` 统一维护，原语和自写组件不另写
  focus ring。附件主触发器、代码块和滑杆拇指只在外层画线；
  自定义输入不参与：原生 input 即使带 tabindex 或 contenteditable 也不加入统一轮廓；
  自定义外壳内复用 Input 时使用 embedded 档，如项目弹窗的名称行，内部和外壳都不画聚焦线。
  InputGroup 普通档在外层画线，composer 档与交互卡（审批、询问、方案）卡体不画聚焦线；
  交互卡内的回答/附言输入使用 embedded 档；聊天滚动视口也不画聚焦线，
  点击对话空白后按 Shift 不改变边缘。卡体和滚动视口仍接收键盘焦点，内部按钮保留焦点提示。错误态保留
  红色边框，菜单保留导航高亮。原理见
  [界面聚焦样式](技术笔记/界面聚焦样式.md)。
- 必须核对的定制：slider 的 `thumbAlignment` / `thumbOnKeyDown` / marks 几何；
  dropdown 的 warning 变体和 lg 尺寸；dialog 限高与中段滚动；code-block 的图标修正；
  trace/collapsible 的挂载与轨道；tabs/separator 的 orientation 属性；
  sonner 的主题源改 appearance store（剥 next-themes）、宽度按条定（错误
  toast 按条覆盖 `--width` 560px，其余缺省 356px）、字体对齐应用
  （fontFamily inherit + text-sm!/text-xs! 挂统一字号档）、
  richColors 按类型着色
  （sonner 内置调色板）、action 槽同色淡底（静息 `bg-current/10`、hover
  加深，图标 text-inherit —— 随 toast 类型着色不串灰；`!` 后缀工具类压
  sonner 样式表）。位置由调用处定（App 挂 `top-center`）。
- registry 源的 `IconPlaceholder` 改为实际图标；`cn-menu-target`、
  `cn-menu-translucent`、`cn-font-heading` 是 CLI style marker，不是待补的 CSS 类。
  安装后清理未用 import、文档站私有引用，并验证构建产物。

## 首页与交互面板

| 部件 | 视觉与组件配方 |
| --- | --- |
| 列表行 | h-8、relative/group；会话主按钮撑满行高与宽度，内边距及项目缩进放在按钮内；常态 pr-4，动作显现时 pr-14；右侧绝对钮簇独立操作，等待确认 tag 放在主按钮内 |
| 列表菜单 | ContextMenuTrigger 的 `render` 承载整行；动作数据同时供右键和“更多”菜单消费 |
| 聊天重命名 | 聊天右键菜单“重命名”打开 Dialog + Input；预填并聚焦全选；原生取消/保存按钮，Enter 保存、Esc 关闭；错误留在弹窗 |
| 项目移除 | “更多”与右键菜单共用 AlertDialog；描述含项目名与保留范围，原生取消钮和 destructive 确认钮；在途显示“移除中…”并禁用按钮，错误留在弹窗；成功反馈用 sonner 短语通知 |
| 侧栏折叠 | `CollapsibleContent variant="navigation"`，200ms ease-out；keepMounted，收起 inert，结束后 hidden |
| 等待确认 tag | 占行尾动作簇的位置，常显；emerald `/15` 背景 + 实色深绿文字 + 小呼吸点 |
| 输入区 | `InputGroup variant="composer"`：`rounded-2xl` 大圆角、薄边、浮层投影 `shadow-composer` token（浅 `0 4px 12px rgb(0 0 0/0.05)`，深同几何提黑 alpha 0.4；shadcn 无官方阴影 token，自建于 globals.css）；浅色白卡，深色用抬亮的 card 底色。发送钮禁用不降低整卡透明度；聚焦不改变描边、底色与阴影。新聊天的灰色信息条两侧内收 16px、下沿被输入卡覆盖 12px，形成前后叠层；外观原理见[输入区外观](技术笔记/输入区外观.md) |
| 附件区 | 同一 InputGroup 内、正文上方的 block-start addon；空时不占位。输入区 AttachmentGroup 自动换行，最高 160px，超过后纵向滚动；不加边缘渐隐 mask，单卡也完整显示；图片和文件卡外层统一 rounded-lg（10px）；图片用 Attachment image 变体的 45px 正方形缩略图，不显示文件名/大小/读取说明，简短导入/错误状态放底部，重试放左上；文件/视频用 sm、file 变体，最小高 45px、按内容收缩且最大宽度 180px，文件名单行省略，悬停显示全名；关闭统一用 AttachmentRemove 放右上角，悬停卡片或按钮获键盘焦点时显示，图片/文件同位置同尺寸，文件预留按钮位置避免遮挡或跳动；输入与历史沿用同一尺寸规则 |
| 附件反馈 | 排队项显示“等待导入”/图片“等待中”，复制项显示进度；部分接收后的未添加数量位于输入卡底部，ghost/xs按钮打开Popover查看全部文件名与原因，明细最高160px纵向滚动，icon-xs按钮清除提示；不在正常就绪卡添加内部机制说明 |
| 目录引用 | 加号触发DropdownMenu，含“添加图片或文件”“引用文件夹”；目录沿用最小45px高、最大180px、10px圆角文件卡，文件夹图标、名称、路径副标题，整卡可打开目录；无大小/另存，移除仍右上hover显示；历史与普通文件同行靠右 |
| 底部工具行 | +、权限、计划 chip、上下文、模型；加号为InputGroupButton icon-sm（28×28px），与发送/停止钮等高；其余文字操作Button xs原生档、h-7；图标沿组件档位 |
| 项目胶囊 | 触发钮内左图标原位交叉渐变为 X；16px 定宽叠层，不能另起独立关闭钮 |
| 会话信息卡 | 项目会话标题整体用非交互 span 触发 hover-card，延迟 400ms；标题全文、项目/主根、最近活动 |
| 审批面板 | 替换输入区；竖排全宽选项、附言条、键盘提示与确认钮；裁决结果收进对应工具行图标，悬停显示结果；未配对痕迹保留独立审批行 |
| TodoStrip | 右上角 w-80 浮卡，独立折叠钮；收起滑入角内成为 outline/pill 计数胶囊 |
| QuestionPanel | 单题向导卡；header、问题、‹n/m›、编号选项、自由输入、忽略与继续/提交 |
| PlanPanel | 审批母版；方案 pre 限高 max-h-64；批准/拒绝两选项，无切档下拉 |

面板动作、键盘语义、互斥顺序与草稿边界分别见 [审批与权限](模块/审批与权限.md)、
[交互座](模块/交互座.md)、[附件](模块/图片与文件附件.md) 和 [交互验收](测试用例/交互座.md)，本文不重复状态机。

- 用户消息的附件复用 AttachmentCards，整组在文字上方靠右；图片、普通文件各成一行，
  行内按发送顺序排，空间不足时换行，不占整行宽度或横向滚动。纯附件不挂空 Bubble。图片 Dialog 放大，文件
  操作使用 AttachmentAction 定位/另存。文件卡正常只显示文件名和大小，导入中/失败才显示状态，
  不在卡片或悬停里展示保存、解析工具、处理路线等内部说明；未解析引用的发送钮
  保留图标，Hint/aria-label 改“作为文件发送”。对话拖入用局部遮罩，不做全窗上传层。
- 模型选项与当前模型子菜单入口、设置模型行按有效 input 显示“视觉”Badge sm（最小16px高、小字阶）；关闭能力后标签同步移除。模型菜单不显示“输入：…（模型声明）”说明行；
  `DropdownMenuLabel` 使用 Base UI 的分组上下文，不能直接挂在 Content 下。
  PDF/视频不冒充模型能力；MCP 设置用
  SettingsGroup/SettingsRow + Dialog 配置三类分析绑定，显示服务/输入方式诊断。

- `PermissionMenu` 的 `MODES`/`ModeItem` 是档位视觉真源：两行名称/说明、
  当前项右浮勾、模式图标；完全访问 warning、自主 chrome-accent、确认档 muted。
  `SwitchModeDropdown` 复用它，内容宽至少 min-w-56；触发钮无常态背景，箭头继承文字色。
- 权限菜单顶部是独立计划开关项，其后分隔线再列三档权限；开启时输入区显示
  浅灰 PlanToggle chip + h-4 矮竖线，hover 浮现 ×，关闭后整组消失。
- 输入卡工具行以聊天面板宽度做容器查询：≤640px 时权限仅显示档位图标，
  上下文显示无数值圆环，模型仅显示厂商图标；计划 chip 也只留图标。
  图标按钮保留完整 aria-label 与原菜单/详情入口。宽态模型名称超长省略，
  间距随面板宽度缩小；极窄时工具组换行，不能裁掉发送按钮。
- FullAccessConfirm 用 alert-dialog + checkbox；权限卡列文件/终端，确认钮为
  destructive。每次打开重置勾选；所有切完全访问入口共用这一闸门。
- TodoStrip 条目完成态绿勾/划线灰字，进行中深色，待办虚线圈；内容 max-h-56。
  胶囊展开图标的零宽必须放外层 span，避免 Button 的 SVG size 兜底压过 w-0。
  收起后 600ms 冷却撤掉 group-hover，避免指针原地触发第二段动画。

## 设置页与通用组件

- 运行时控制台 Run 标题和右侧状态共用整条折叠按钮；详情分区使用 Button
  disclosure 变体与 console 尺寸，展开不铺灰底。文字与按钮走界面阶，代码走独立代码字号，
  主标题仅加粗；页头仅留主标题，类别与时间归入“记录信息”的两列 Table inspect
  变体。字段为行表头，值可换行；仅表格保留行分隔线。详情外边距20px、分区间距20px，
  折叠箭头、正文块共用左基线，按钮内距由负外边距抵消，不叠加多层缩进。
  数据块标题、层级、搜索、复制与更多共用一行，窄栏允许操作组换行；字符/行数/格式、
  原文和换行开关收入更多菜单。正文只用一层浅底，无外框、横线和行号栏分隔线。
  详情页声明 size 查询容器，原文与代码块高度上限为 `min(60cqh, 40rem)`，按实际面板高度
  给元信息与操作区留空间；长块内部滚动并阻止边缘滚动串到详情页；
  CodeMirror 搜索栏在块顶部保持可见，详情页仅承担区块间滚动。JSON默认展开2层；
  完整回复优先展开，思考与有正文时的原始消息 JSON 默认收起。

- 通用设置骨架 `SettingsPage`：`max-w-3xl px-10 py-8` 单列，标题/可选描述/
  工具行/内容；页头块独立成 `SettingsHeader`（标题/描述/工具行），页头的
  列位与上、左右边距是模板量，所有分区一致；页头 → 第一个内容（组卡或
  加载/空态卡）统一 mt-8，不逐页手写。内容区滚动容器挂
  `scrollbar-gutter-stable` 且切分区回顶（防抖机制见 [模块/设置页](模块/设置页.md)）。
  `SettingsGroup` 为带组标题的 rounded-lg 描边卡 + divide-y（2026-11-20 用户定调：
  设置页容器与搜索框统一 lg 档、与原生表单控件同阶，弃 xl 大容器档与胶囊搜索底；
  各分区空态/加载卡、模型页整高卡与凭据横幅、归档列表卡、模型页刷新钮同批改齐）；
  `SettingsRow` 左说明、右原生控件。设置页及其弹窗的文字 Button、SelectTrigger、Toggle
  和模型能力徽标统一使用 default；包括 MCP 服务器弹窗的保存／取消与列表行操作。
  调用处不再用高度／边长覆写尺寸档；模型行测试／编辑／删除动作簇 sm 档、绝对定位悬浮
  于开关左侧（零布局占位 —— 行中不留死区，悬停不推挤开关）。
  路径行等宽截断并提供更改钮。
- 界面主题色紧随深色浅色行，标题和说明下铺紧凑缩略卡；内容列≥36rem 时六列一行，否则三列。
  `InterfaceSkinPicker` 复用 `RadioGroupCard`，预览按头部/图标栏/内容侧栏/正文区分层，
  圆角 lg；选中描边与圆点使用各套主题色的点缀色，名称加粗。预览随当前明暗换套，
  单选组支持方向键；聚焦仍走公共内贴轮廓。
- 外观的两行字体按钮显示中英文字体名，分别打开 Dialog。弹窗依次为语言 Tabs、
  两槽当前字体、填满内容区的紧凑搜索框、可滚动列表、中英文预览和保存／取消区。
  当前字体与搜索框以留白衔接；默认档显示具体字体名，「默认」标签使用 Badge sm；打开时聚焦英文页签，不聚焦搜索框。
- 强调色入口显示圆角长方形色块（棋盘底衬透明度）、等宽 HEX 色值和下拉箭头；默认档色值按明暗回落
  （亮 #0231fa／暗 #5f9cff）；旁边保留恢复默认图标钮（IconArrowBackUp，无文字）；取色浮层不显示标题，
  依次为饱和度／明度、色相、透明度、HEX、RGBA 四格（A 用百分比）和 Themd 的 16 色色板；
  底部以细线分出「主题色」，六个小色块带名称，三列两行；预设色、分隔线、标题和
  主题色块共用浮层内容区的左右边距，各组不另加居中缩进。首行两端贴齐内容边界，
  内部色块与名称靠左，各行沿同一列起点排列；16个预设色的第二行也沿首行左端对齐。
  颜色复用界面主题色的当前明暗套点缀色。浮层使用 `PopoverContent color-picker` 档，
  沿窗口边界平移，避免窄窗上下两侧空间不足时翻到窗口外。
- 常规页依次为「权限」「对话」「常规」三组；「对话」用 Switch 控制自动会话名称，
  标题模型用 `w-60 max-w-full` 的 Select；输出详细程度与耗时显示格式也使用 Select。
  「显示过程请求详情」使用 Switch，默认关闭；说明注明只作用于过程中的每次请求，
  不影响最终总体统计。
  发送快捷键、关闭窗口时使用 Select，短选项控件统一 w-40；
  快捷键选项用 kbd 键帽组合（`KbdGroup` + 弱色 `+` 相连），
  键帽带细描边以在菜单 hover 灰底上保持轮廓。「关闭窗口时」的 ask 档弹
  CloseAskDialog（shell 级，勾「不再询问」固化所选动作）。
- 通知页三组：通知（三行触发条件，Select/Switch）+ 提醒方式（toast/提示音
  两个正交 Switch + 系统设置跳转按钮，Linux 隐藏）+ 提示音（音量/音调滑杆
  w-40 + 三类声音源行：缺省显示「内置提示音」，自定义文件名截断显示 +
  选择文件/试听/恢复默认）；两条滑杆右侧各配 `Button ghost / icon` 回退图标，
  Hint 与 aria-label 分别为「恢复默认音量」「恢复默认音调」，已为默认值时禁用；
  说明标出默认50%与默认原音。音调只调整内置音频。试听使用带声波的喇叭图标
  `Button ghost / icon`，配「试听」Hint 与同名 aria-label。
- 存储页两组：空间占用 = 总量行（正文阶 + semibold tabular-nums 数值，行尾
  outline icon-sm 刷新钮）+ 分类分段条（h-4 rounded-sm，2026-11-20 用户定调弃胶囊；
  条高仅 16px，CSS 把 ≥8px 圆角钳成半圆，sm 6px 才收得出方角端头；段宽按字节
  flexGrow 分配，免百分比取整误差；空根不画）+ 图例（size-2 色点 + 标签 + 小字阶
  数值）+ 「占用明细」折叠（裸 button 组头、箭头 -90° 旋转语言，开合走
  Collapsible 导航变体 200ms 过渡，归档组同款；行只有两档 —— 会话转录单列 +
  「其他」聚合，不铺内部条目清单）；数据文件夹 =
  SettingsRow + 等宽路径（select-text、break-all）+ 浏览钮（default 档）。
  分类色板真源在 storage-view.ts（amber/emerald/blue/violet + 主题灰做
  「配置与其他」，深色档提亮一档）。
- 模型设置单独用 master-detail：页头同走 `SettingsHeader`（与其余分区同列位，
  切页标题不跳位），主体卡与页头同列（外层 `mx-auto max-w-3xl px-10`，卡片边 =
  列边，同其余分区组卡的对齐语言；zcode 官方 master-detail 亦同容器无限宽例外）。
  页头→卡间距 `mt-4`（非全分区 mt-8 模板量：本页唯一整高卡，取 zcode
  SectionLayout `space-y-4` 同量）。
  左栏像素宽 176–320 可拖（默认 208），拖过下限折成 48px 图标栏（品牌标钮 +
  角标状态点，title 提示名，组间细分隔线），宽与折叠态 localStorage 记忆。
  换挡（折叠↔展开）是 200ms 收拢动画：栏 = 裁剪窗 + 清单层/图标层交叉淡出
  （展开区间拖动两层同宽直写、逐帧回流；收拢时清单层保宽被裁，隐藏层 inert），
  换挡瞬间 `data-snap` 放行宽度过渡（其余拖拽段仍杀过渡保跟手）；分屏线 =
  1px 线 + 把手胶囊 + 悬停光带（同 content-sidebar 形态，栏本体不叠 border
  避免双线加粗）。
  各栏独立滚动；右栏 max-w-2xl 居中、上边距 24px。详情按 provider id 挂 key，
  模型行动作区零占位悬浮，hover 或键盘聚焦时显示；测试中保持可见，测试钮转圈并禁用。
  测试入口用连接图标与「测试模型」Hint，反馈使用统一 Toast，带供应商、模型和耗时或错误原因。
- MCP/技能页共用 ScopeMenu 与两行工具栏：作用域、计数、右侧搜索；
  已安装组右侧刷新/导入/新建。条目有图标、名称、徽标、说明、开关和动作钮。
  项目级和用户级的操作差异见 [MCP座](模块/MCP座.md)、[技能座](模块/技能座.md)。
- MCP 弹窗使用 Tabs 的表单/JSON 双模式；技能编辑使用 name/description/等宽正文。
  引擎校验错误留在弹窗内，文件诊断独立组卡，空态为虚线引导卡。
- 设置侧栏分“基础设置 / Agent 能力”，分区列表项使用正文阶（默认14px，`text-sm`）；顶部标题和搜索；
  未实现分区保持占位。
- ProviderLogo 使用 `@lobehub/icons` 按名导入；单色随 currentColor，彩色走 `.Color`，
  自定义 provider 为黑底首字。尺寸用 CSS 变量 + 本体选择器，避免 Button 把后代 SVG 钉成 16px。
- StopSlider：25px 块状轨道、4×19px 拇指、31 格刻度；档位吸附/相邻键盘步进或自由值，
  填充与拇指 280ms ease-out 同步。ContextWindowSlider 是它的上下文域适配。
- 图标以 `@tabler/icons-react` 为主，使用前验证导出存在；active 用成对 Filled 变体。
  shadcn 原语内部 lucide 图标保持原样。
- 图标提示统一 `Hint`；可交互富内容直接用 tooltip 原语；装饰箭头不参与指针命中，避免挡住下方链接。对话索引细刻度和
  ProjectPicker 内嵌 X 不再套触发器，用 aria-label；组件的标题 prop 不属于 tooltip。

## 消息流的视觉配方

功能、所有权与事件顺序见 [消息呈现](模块/消息呈现.md)，原理见
[流式呈现动效](技术笔记/流式呈现动效.md)，真机矩阵见 [消息验收](测试用例/消息呈现.md)。

- 用户消息灰气泡，助手平铺；消息段和过程行统一 `gap-3`、回合容器左右零内边距。
  空正文不挂容器，避免纯思考段多吃间距；零工作项的 live 也不渲染空过程容器
  （空盒多吃一个 gap，与终态头条栈高不齐，瞬时失败翻相会跳）。
- 运行态过程单行化，工作行位于流底，图标是 `WorkingSpinner` 三叶动效，
  配标题扫光和 tabular-nums 码表；停止在途文字为“正在停止”。
- WorkingSpinner 保留 css-loaders l5 的整盒三角、伪元素继承、4s/2s 和质心转轴
  `50% 66%`；叠加 3s 呼吸，三层延迟为 0/-1/-2s。本体透明度与伪元素相乘，
  形成整体明暗及层间错相。前景色跟主题，1em 派生尺寸（text-xs 档，比行内
  正文小一号），光学上提 0.075em。
  替换动效只动本组件与 `.working-spinner` CSS，保持 WorkingLine 接线。
  三角绕质心转 120° 会映射回自身，分相方案不能制造不同叶片位置。
- 工具图标保持静态，固定类别词运行态扫光，执行前后不换名；人工允许为工具行尾
  16px 盾牌图标，拒绝/取消为对应图标，Tooltip 显示裁决结果；失败仅“执行失败”点状下划线为红，
  Tooltip 提供原因/复制，整行不染红。bash 进度为定高两行尾部 + 扫光细条。
- 工具命令摘要、展开的普通输出与直播尾行统一使用 `text-muted-foreground`，
  展开内容不切成正文黑色；输出颜色由 CodeBlock 默认变体统一提供，明暗主题同口径。
  工具内容不使用边缘渐隐遮罩，普通输出与 diff 均完整显示；长内容保留原生滚动。
- 详细模式的思考默认单行收起，摘要横向滚动并渐隐；展开限高内部滚动。
  简洁模式仅保留思考状态行与耗时，工具与思考均无详情入口，底部统计行不显示。
- 终态“用时 / 已停止 / 出错了”头条，下无分割线（2026-11-20 取消常驻线）；
  折叠内容与头条同级无导线。
  轨道必须 `minmax(0,0fr) ↔ minmax(0,1fr)`，内层纵向 padding 同曲线收拢；
  keepMounted，折叠体内部不套 content-visibility 包装。
- 消息流保留库布局/回底钮，关闭库 autoScroll，跟随由本地 controller 独占。
  工作行只渲染一份；跟随溢出时同节点定位，阅读时归流；不加残差 translate/viewport containment。
  `home-chat` 查询容器会改变 fixed 定位原点，工作行按实际包含块换算坐标，
  保证带顶部/侧栏偏移的长对话中仍在视口内；机制见[消息呈现](模块/消息呈现.md)。
- 正文与输入卡共用 `.chat-column` 的水平基准：正文最大 48rem，双侧留白按
  `clamp(28px,8cqw,64px)` 连续变化；输入卡每侧外扩按
  `clamp(6px,(100cqw−320px)/16,20px)` 连续变化，宽度充裕时各超出 20px，
  窄面板逐步收敛至 6px，两者始终同轴。消息视口用双侧稳定滚动条槽，避免单侧占位推偏正文；
  留白需覆盖滚动条槽并保留正文呼吸空间，不能只验证列宽相差 20px 而忽略真实视口裁切。
- 对话索引每轮提问一刻度，激活项按真实视口/scrollHeight 自算；hover 宽度阶梯
  24/17/14/10px；常态刻度 15%、激活 35%，hover 阶梯 40/30/20/15% 前景透明度。
  200ms 悬停后显示右侧 HoverCard：问题最多两行、已完成回答摘要最多三行；
  生成中、停止、失败回合只显示问题，摘要剥除 Markdown 标记并压平空白。
  索引在正文列外的左侧留白，按 `home-chat` 容器宽度判断：
  大于 760px 时显示，760px 及以下外壳宽度 24→0px、透明度 1→0，200ms ease-out；结束后隐藏，
  立即停止指针命中，恢复宽度时反向展开。reduced-motion 直接切换。
  库的 visibility/scrollable 快照不作为索引判断源。
- 用量行位于正文 footer，`text-[11px] text-muted-foreground tabular-nums`；
  显示输入/输出/缓存/成本/耗时，零值和无数据项省略，格式机制见 [用量与成本](模块/用量与成本.md)。
  过程请求的用量行默认不占位，开启相应开关后在详细模式显示，最终总体统计保持原布局。
- 产物区位于终答与用量之间，使用shadcn Nova Card的sm档横向文件行：左侧图标、中间名称/类型、右侧ButtonGroup组合“打开＋下拉”；
  文件图标用Material Icon Theme原始彩色SVG，size-6，不加底色或图标框；正文文件链接共用同一组件，size-4。
  不设“交付文件”标题或数量行，另存等动作收进菜单，正常项不常显大小、申报说明或保存状态。首屏3项可展开全部，异常提示与回合Badge保留；
  文件动作失败用AlertDialog与“知道了”关闭钮，长路径可换行滚动。门控和版本机制见[产物文件卡片](模块/产物文件卡片.md)。
- Markdown 使用 Streamdown + Shiki + CJK；本地链接显示Material文件图标与原标签，不加背景，自动识别的文件名使用普通文本链接；
  hover/键盘聚焦用shadcn Tooltip显示可换行的完整路径与原生复制图标钮，复制钮用icon-sm档并与路径垂直居中，400ms延迟；右键用ContextMenu提供文件动作，错误用独立AlertDialog。
  图标与整个标签为两个布局项，文字渐显片段在标签内自然排版，不逐片添加间距；文本预览顶部显示已定位的行列或范围。
  网页链接阻止窗口内导航，再 window.open，脚注走文内跳转。文件机制见[正文文件链接](模块/正文文件链接.md)。
  文件预览沿用右侧 HomeTabs 区域，≤1100px 用 Dialog；宽窄切换不保留空白遮罩。
  操作菜单沿用 shadcn，正文/代码字号使用共享消费点，预览不另外造字号档。
  lineNumbers 由外观设置「显示代码行号」驱动（默认关）、库内 animated、linkSafety
  弹窗关闭，Shiki 传 [github-light, github-dark] 双主题随 html.dark 切换；
  Tailwind 显式 `@source` 扫 Streamdown。深浅色三档（浅/深/跟随系统）切
  html.dark，初值 main.tsx 同步挂防闪白；代码长行换行走 html[data-code-wrap]
  门控。
- 对话内容主题导入 Themd，由 `--t-*` 变量作用于消息流；「默认」主题 = 内置
  Cogent 主题包令牌集，显式保留14px正文/代码；用户主题相对 Themd 基础样式做稀疏差异。
  基础 CSS 由本地快照生成，代码/表格/图片包装由 content.css 适配；空主题也采用源默认值。
  暗色只调整未显式指定的缺省色；用户字体/代码字号的独立重要层优先于主题附加 CSS。
- 正文短批逐字/逐词 300ms 淡入；大批单连续片段最多 32 组，同批排期不超过 250ms。
  代码/表格按新挂载行淡入，旧行不重播；单元格或未闭合行内部增长直接显示。
  业务终态立即切换，已有正文淡入自然播完。系统 reduced-motion 禁用相应动效。
- `.shimmer` 必须用 Tailwind `@utility` 注册；前景实色 + 透明淡带，300% 底、扫 2s 停 2s。
  `.scroll-fade-b/-y/-x` 使用 24px mask，消费区域需留足边距，避免淡化首尾文字。

## 滚动条

默认 webkit 定制：轨道 13px，滑块两侧 4px 透明 border + padding-box，
可见宽 5px；黑 18%，hover 30%。`use-scrollbar-auto-hide` 在 document 捕获
scroll，给容器挂 `data-scrolling`，静默 600ms 后摘除；默认滑块随标记隐藏，悬停 13px 命中区也显示。
会话列表使用 `scrollbar-native`：标准 `scrollbar-width: thin` 与 `scrollbar-color`
交给 Chromium 原生绘制，保留系统上下箭头；滑块黑 12%、轨道透明，鼠标移开和静默后均不隐藏。
Windows/Electron 40 的细轨道实测为 10px，尺寸及箭头形态由系统主题决定，不手绘按钮。
列表使用 `overflow-y-auto`，只在内容溢出时占用轨道宽度；空列表、短列表及
收起后不再溢出的列表不预留滚动条槽。已有轨道的占位不随滑块透明度变化。
需要防止居中列横跳的设置页和消息视口仍显式保留稳定槽。

`scrollbar-width/color` 非 auto 会让 Chromium 绕过 webkit 定制；会话列表有意使用这条原生路径，
其余沿用定制样式的容器不要随意加 scrollbar-thin。message-scroller 视口已按 data-slot 恢复 auto，code-block 同理。

## 样式与组件陷阱

| 场景 | 当前做法与原因 |
| --- | --- |
| Tailwind 合并 | 带变体的类同变体覆写：`px-2 has-[>svg]:px-2`；裸类压不住组件变体 |
| Dialog 宽度 | 默认 `sm:max-w-sm`；扩大须同写 `sm:max-w-*`，裸 max-w 在桌面不生效 |
| 长 Dialog | 本体 `max-h-[calc(100%-2rem)]` + flex；中段 `min-h-0 flex-1 overflow-y-auto -mx-4 px-4`，头尾在外 |
| Base UI 触发器 | 使用 `render={<Button/>}`，不使用 Radix 的 asChild；复合触发器的内容放外层 children |
| Portal 事件 | React 沿组件树冒泡；下拉/风险窗内容层各自 stopPropagation，trigger 只能保护自身 |
| Select 窄触发器 | `w-[var(--anchor-width,fit-content)] min-w-0`；不写代际相关的固定宽度补偿 |
| 菜单强调色 | warning 在 item 本体设 variant，并从 focus 通配染色排除；不能靠后代类对抗 |
| 菜单 lg 尺寸 | Context 传尺寸，原语条件拼字面类；`[[data-size=lg]_&]` 经构建提取曾无产物 |
| 菜单分隔线 | DropdownMenuSeparator 保留 h-px 占位，用 border-t border-border 画线；由浏览器统一取整边框宽度，避免 125% 缩放下背景色细条随纵向位置变成 1 / 2 行物理像素。原理见[菜单分隔线](技术笔记/菜单分隔线.md) |
| 弹窗关闭 | Base UI AlertDialogAction 是裸 Button；确认回调显式 `onOpenChange(false)` |
| 菜单开着保行高亮 | 自身 `data-popup-open:` + 后代 `has-[[data-popup-open]]:`；portal 外焦点不可靠 |
| InputGroup 全宽 | 纵向 items-center 布局里全宽子元素显式 w-full |
| 方向变体 | 核对实际 data 属性；Slider/Tabs/Separator 用 `data-[orientation=…]`，裸 data-horizontal 存在选择器不命中 |
| Tailwind 过渡 | v4 scale/rotate 是独立属性，任意 transition 清单必须包含实际属性；别只写 transform |
| 原语与调用点 | 同属性的基态/激活/hover 在同一层维护；高特异性调用点覆写会压死原语 hover |
| 组合按钮尺寸 | InputGroupButton 把 size 同时传给 Button 原语，不能只覆写外层宽高；否则底层默认 min-h-8 会把 24px 图标钮撑成 24×32px |
| JSX 文字 | 属性内的引号使用合法转义或中文弯引号，避免裸引号截断属性 |

### 分栏与滑杆

- RRP v4 用 `orientation`；Panel 的 className/style 落内层。无 defaultCollapsed，
  首次初始化用 imperative collapse。已布局尺寸由 flexGrow 承载，过渡作用于 flex-grow。
- 注册后等两轮宏任务再放开尺寸过渡，避免 flexBasis→flexGrow 交接生长；
  不用后台会停发的 rAF 门控。拖拽时以 `:has([data-separator=active])` 关闭过渡。
- 持久化取 `onLayoutChanged` 参数，getSize/onResize 在该时刻可能滞后。
  RRP 4.18.1 的 preserve-pixel-size 不满足侧栏像素语义，所以侧栏独立实现。
- Slider inset 以 Control 宽计算拇指中心；Track 不做负 margin 出血，Control 不裁切圆钮。
  公式 `halfThumb + (W-thumbW)·P` 决定填充与 marks，顶格自然距边半个拇指。
- 要填充到边缘的 StopSlider 用 center；ThinkingSlider 用 edge-client-only。
  调拇指尺寸须同步 `thumbSizePx`；填充与拇指使用相同 duration/easing，避免瞬态脱节。
- 不等距档位通过 `thumbOnKeyDown` 接管：用户 handler 先 preventDefault，
  阻止库与原生 range 的均匀步进，再按相邻档移动。

## 验证方法

- 对标图先明确谁叠谁、圆角在哪；实拍与参考拼同尺度上下对比，再改再拍。
  不用主观像素估计替代对照，保留实际布局与颜色证据。
- IAB 只用于同环境对比；主题/缩放/滚动与窗口恢复的最终结论在实际 Electron 验。
- HMR 白屏先 reload，并按 `env.d.ts` 补齐 window.cogent 桩；必要时重新挂 main 模块。
- 后台标签会冻结 CSS/rAF/scroll；合成事件能测接线，不能据此宣称动画或像素稳定。
  React hover 可用带 relatedTarget 的 mouseover；交互后等待 React 提交再读 DOM。
