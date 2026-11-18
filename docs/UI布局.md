# UI 布局与视觉配方

> 本文负责区域、视觉配方、组件用法与样式陷阱；功能机制见对应模块页。
> 区域代号用于描述、注释和组件命名。历史过程查 Git，不在本文追加实施流水账。

## 布局结构

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

- header 的“运行时控制台”和“内嵌页面”入口位于“帮助”右侧，使用中文文字按钮
  （Button ghost / sm），不配图标；与前四个菜单按钮同处一个 `gap-1` 容器，
  统一 `h-7 px-2`，不额外加左间距。
- `content-sidebar` 是普通 flex 像素宽块，不进 react-resizable-panels（RRP）；
  CSS 保证缩放时像素宽稳定，避免百分比尺寸经 JS 校正产生脏帧。
- `SidebarResizeHandle` 使用 pointer capture + rAF 直写宽度；拖过下限有阻力，
  越过 min/2 折叠，反向对称恢复；键盘 ±16px，双击回默认。
- `use-content-sidebar-split` 记忆宽度/折叠态，首帧直接还原；只在用户手势后落盘。
- HomeMain 内部分屏是百分比语义，使用 RRP v4 + `GlowResizeHandle`；
  折叠后把手贴缘可展开抓取，按钮通过 `usePanelRef` 的 collapse/expand 操作。
- 路由是 `stores/ui` 的 AppView；`stores/home` 管首页会话，`stores/settings`
  管设置分区；当前按 view 切换挂载。保活目标见 [页面切换状态保留](计划/页面切换状态保留.md)。

## 颜色、字体与空间

| 对象 | 配方 |
| --- | --- |
| header + app-sidebar | `.chrome-surface`，135° 薄荷渐变 `#e0f3e9 → #eef7f2 → #fbfdfb` |
| content-sidebar / main | `--content-sidebar`（`#f2f8f4`）/ 纯白，形成层级 |
| hover / active | 黑低透明软叠 `bg-foreground/5` 或 `bg-accent-foreground/5`；active 保持同一深度 |
| 行内小钮 | 白卡上 hover `/5`，已有行底上 `/15` |
| 文字 | 实色 token；次级 `muted-foreground`，placeholder `--placeholder`；层级靠实色深浅 |
| 语义色 | destructive 错误红；warning 琥珀 `oklch(0.666 0.155 70)`；chrome-accent 品牌蓝 `#0231fa` |
| 圆角 | 大卡 24px、设置组卡 12px、行 6px、信息区条只圆上两角 |
| 字号 | 页面标题 24/semibold、侧栏标题 16/semibold、行标题 14/medium、正文与说明 13、时间 11–12 |
| 字体 | Inter + HarmonyOS Sans SC；代码 JetBrains Mono，中文注释回落鸿蒙；13px 中文用 400 |

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
- 必须核对的定制：slider 的 `thumbAlignment` / `thumbOnKeyDown` / marks 几何；
  dropdown 的 warning 变体和 lg 尺寸；dialog 限高与中段滚动；code-block 的图标修正；
  trace/collapsible 的挂载与轨道；tabs/separator 的 orientation 属性。
- registry 源的 `IconPlaceholder` 改为实际图标；`cn-menu-target`、
  `cn-menu-translucent`、`cn-font-heading` 是 CLI style marker，不是待补的 CSS 类。
  安装后清理未用 import、文档站私有引用，并验证构建产物。

## 首页与交互面板

| 部件 | 视觉与组件配方 |
| --- | --- |
| 列表行 | h-8、relative/group；主按钮占满，pr-12 留动作位；右侧绝对钮簇 hover 显示 |
| 列表菜单 | ContextMenuTrigger 的 `render` 承载整行；动作数据同时供右键和“更多”菜单消费 |
| 侧栏折叠 | `CollapsibleContent variant="navigation"`，200ms ease-out；keepMounted，收起 inert，结束后 hidden |
| 等待确认 tag | 占行尾动作簇的位置，常显；emerald `/15` 背景 + 实色深绿文字 + 小呼吸点 |
| 输入区 | 白卡 rounded-3xl、薄边、无投影、聚焦无反馈；新聊天上方显示项目信息区 |
| 底部工具行 | +、权限、计划 chip、上下文、模型；Button xs 原生档，h-7，与发送钮同高；图标 17px |
| 项目胶囊 | 触发钮内左图标原位交叉渐变为 X；16px 定宽叠层，不能另起独立关闭钮 |
| 会话信息卡 | 项目会话标题整体用非交互 span 触发 hover-card，延迟 400ms；标题全文、项目/主根、最近活动 |
| 审批面板 | 替换输入区；竖排全宽选项、附言条、键盘提示与确认钮；裁决痕迹单行入过程流 |
| TodoStrip | 右上角 w-80 浮卡，独立折叠钮；收起滑入角内成为 outline/pill 计数胶囊 |
| QuestionPanel | 单题向导卡；header、问题、‹n/m›、编号选项、自由输入、忽略与继续/提交 |
| PlanPanel | 审批母版；方案 pre 限高 max-h-64；批准/拒绝两选项，无切档下拉 |

面板动作、键盘语义、互斥顺序与草稿边界分别见 [审批与权限](模块/审批与权限.md)、
[交互座](模块/交互座.md) 和 [交互验收](测试用例/交互座.md)，本文不重复状态机。

- `PermissionMenu` 的 `MODES`/`ModeItem` 是档位视觉真源：两行名称/说明、
  当前项右浮勾、模式图标；完全访问 warning、自主 chrome-accent、确认档 muted。
  `SwitchModeDropdown` 复用它，内容宽至少 min-w-56；触发钮无常态背景，箭头继承文字色。
- 权限菜单顶部是独立计划开关项，其后分隔线再列三档权限；开启时输入区显示
  浅灰 PlanToggle chip + h-4 矮竖线，hover 浮现 ×，关闭后整组消失。
- FullAccessConfirm 用 alert-dialog + checkbox；权限卡列文件/终端，确认钮为
  destructive。每次打开重置勾选；所有切完全访问入口共用这一闸门。
- TodoStrip 条目完成态绿勾/划线灰字，进行中深色，待办虚线圈；内容 max-h-56。
  胶囊展开图标的零宽必须放外层 span，避免 Button 的 SVG size 兜底压过 w-0。
  收起后 600ms 冷却撤掉 group-hover，避免指针原地触发第二段动画。

## 设置页与通用组件

- 通用设置骨架 `SettingsPage`：`max-w-3xl px-10 py-8` 单列，标题/可选描述/
  工具行/内容；`SettingsGroup` 为带组标题的 rounded-xl 描边卡 + divide-y；
  `SettingsRow` 左说明、右原生控件。路径行等宽截断并提供更改钮。
- 模型设置单独用 master-detail：页头 + `mx-10 mb-8 flex-1 min-h-0` 主体卡，
  左栏 w-72，各栏独立滚动；右栏 max-w-2xl 居中。详情按 provider id 挂 key，
  模型行动作区固定宽并 hover 显示，避免布局跳动。
- MCP/技能页共用 ScopeMenu 与两行工具栏：作用域、计数、右侧搜索；
  已安装组右侧刷新/导入/新建。条目有图标、名称、徽标、说明、开关和动作钮。
  项目级和用户级的操作差异见 [MCP座](模块/MCP座.md)、[技能座](模块/技能座.md)。
- MCP 弹窗使用 Tabs 的表单/JSON 双模式；技能编辑使用 name/description/等宽正文。
  引擎校验错误留在弹窗内，文件诊断独立组卡，空态为虚线引导卡。
- 设置侧栏分“基础设置 / Agent 能力”，顶部标题和搜索；未实现分区保持占位。
- ProviderLogo 使用 `@lobehub/icons` 按名导入；单色随 currentColor，彩色走 `.Color`，
  自定义 provider 为黑底首字。尺寸用 CSS 变量 + 本体选择器，避免 Button 把后代 SVG 钉成 16px。
- StopSlider：25px 块状轨道、4×19px 拇指、31 格刻度；档位吸附/相邻键盘步进或自由值，
  填充与拇指 280ms ease-out 同步。ContextWindowSlider 是它的上下文域适配。
- 图标以 `@tabler/icons-react` 为主，使用前验证导出存在；active 用成对 Filled 变体。
  shadcn 原语内部 lucide 图标保持原样。
- 图标提示统一 `Hint`；可交互富内容直接用 tooltip 原语。对话索引细刻度和
  ProjectPicker 内嵌 X 不再套触发器，用 aria-label；组件的标题 prop 不属于 tooltip。

## 消息流的视觉配方

功能、所有权与事件顺序见 [消息呈现](模块/消息呈现.md)，原理见
[流式呈现动效](技术笔记/流式呈现动效.md)，真机矩阵见 [消息验收](测试用例/消息呈现.md)。

- 用户消息灰气泡，助手平铺；消息段和过程行统一 `gap-3`、左缘零缩进。
  空正文不挂容器，避免纯思考段多吃间距。
- 运行态过程单行化，工作行位于流底，图标是 `WorkingSpinner` 三叶动效，
  配标题扫光和 tabular-nums 码表；停止在途文字为“正在停止”。
- WorkingSpinner 保留 css-loaders l5 的整盒三角、伪元素继承、4s/2s 和质心转轴
  `50% 66%`；叠加 3s 呼吸，三层延迟为 0/-1/-2s。本体透明度与伪元素相乘，
  形成整体明暗及层间错相。前景色跟主题，1em 派生尺寸，光学上提 0.075em。
  替换动效只动本组件与 `.working-spinner` CSS，保持 WorkingLine 接线。
  三角绕质心转 120° 会映射回自身，分相方案不能制造不同叶片位置。
- 工具图标保持静态，类别词运行态扫光；失败仅“执行失败”点状下划线为红，
  Tooltip 提供原因/复制，整行不染红。bash 进度为定高两行尾部 + 扫光细条。
- 思考默认单行收起，摘要横向滚动并渐隐；展开限高内部滚动。
- 终态“已工作 / 已停止 / 出错了”头条下分割线常驻；折叠内容与头条同级无导线。
  轨道必须 `minmax(0,0fr) ↔ minmax(0,1fr)`，内层纵向 padding 同曲线收拢；
  keepMounted，折叠体内部不套 content-visibility 包装。
- 消息流保留库布局/回底钮，关闭库 autoScroll，跟随由本地 controller 独占。
  工作行只渲染一份；跟随溢出时同节点定位，阅读时归流；不加残差 translate/viewport containment。
- 对话索引每消息一刻度，激活项按真实视口/scrollHeight 自算；hover 宽度阶梯
  24/17/14/10px。库的 visibility/scrollable 快照不作为索引判断源。
- 用量行位于正文 footer，`text-[11px] text-muted-foreground tabular-nums`；
  显示输入/输出/缓存/成本/耗时，零值和无数据项省略，格式机制见 [用量与成本](模块/用量与成本.md)。
- Markdown 使用 Streamdown + Shiki + CJK；链接阻止窗口内导航，再 window.open。
  lineNumbers、库内 animated、linkSafety 弹窗关闭；Tailwind 显式 `@source` 扫 Streamdown。
- 正文主题导入 Themd，由 `--t-*` 变量作用于消息流；默认主题为空令牌，保持库原生观感。
  代码/表格拆壳规则须以变量注入的 `[style*]` 门控，避免污染默认态。
- 正文短批逐字/逐词 300ms 淡入；大批单连续片段最多 32 组，同批排期不超过 250ms。
  代码/表格按新挂载行淡入，旧行不重播；单元格或未闭合行内部增长直接显示。
  业务终态立即切换，已有正文淡入自然播完。系统 reduced-motion 禁用相应动效。
- `.shimmer` 必须用 Tailwind `@utility` 注册；前景实色 + 透明淡带，300% 底、扫 2s 停 2s。
  `.scroll-fade-b/-y/-x` 使用 24px mask；渐隐只作用边缘，不裁掉内容。

## 滚动条

全应用 webkit 定制：轨道 13px，滑块两侧 4px 透明 border + padding-box，
可见宽 5px；黑 18%，hover 30%。`use-scrollbar-auto-hide` 在 document 捕获
scroll，给容器挂 `data-scrolling`，静默 600ms 后摘除；悬停 13px 命中区也显示。
轨道占位不随透明度变化，保持 scrollbar-gutter-stable 的防抖语义。

`scrollbar-width/color` 非 auto 会让 Chromium 绕过 webkit 定制；新容器不要随意
加 scrollbar-thin。message-scroller 视口已按 data-slot 恢复 auto，code-block 同理。

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
| 弹窗关闭 | Base UI AlertDialogAction 是裸 Button；确认回调显式 `onOpenChange(false)` |
| 菜单开着保行高亮 | 自身 `data-popup-open:` + 后代 `has-[[data-popup-open]]:`；portal 外焦点不可靠 |
| InputGroup 全宽 | 纵向 items-center 布局里全宽子元素显式 w-full |
| 方向变体 | 核对实际 data 属性；Slider/Tabs/Separator 用 `data-[orientation=…]`，裸 data-horizontal 存在选择器不命中 |
| Tailwind 过渡 | v4 scale/rotate 是独立属性，任意 transition 清单必须包含实际属性；别只写 transform |
| 原语与调用点 | 同属性的基态/激活/hover 在同一层维护；高特异性调用点覆写会压死原语 hover |
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
