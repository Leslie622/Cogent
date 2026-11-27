# UI 布局与视觉配方

> 本文负责区域、视觉配方、组件用法与样式陷阱；功能机制见对应模块页。
> 区域代号用于描述、注释和组件命名。历史过程查 Git，不在本文追加实施流水账。

## 设计素材

长期维护的设计素材统一存放在 `resources/design-assets/`，索引见该目录的 `README.md`。
文件状态徽章的 SVG、配色、交互预览与再生成方式归属 `resources/design-assets/change-badges/`。
改动列表使用文字版：占位 44×20px，居中显示 48×28px 画布内的 43×20px 水平底板，保留粗斜体与无感叹号的 NEW；
仅裁去透明留白，不缩小字形或撑高文件行，深浅主题切换本地 SVG，中文语义由 Hint 与屏幕阅读文本保留。

## 架构地图

独立文档站完全自包含，采用系统字体栈、中性侧栏与低饱和语义边界底色（区分桌面壳冷蓝、运行时内核靛蓝、存储根青灰与规划琥珀虚线），适配明暗双色。全高三栏为 236px 左导航（架构地图 + 专题流程 13 项双分组）、弹性画布（支持 `#view=` 定位与胶囊泳道分隔）、340px 说明。999px 及以下收起左栏，699px 及以下也收起右栏，窄屏点选打开覆盖式说明。
大区块无状态标记，已实现节点用绿勾，混合能力分行显示绿点和橙点。关系用实线或点线表达调用与依赖，橙点单独表达待实现；顶部支持 `全部 / 仅已实现 / 高亮缺口` 筛选（`仅已实现` 隐藏未实现项），点击连线看契约，点击来源直接复制路径。
参与布局的视图、确定性网格与导航入口见[架构地图模块](模块/架构地图.md)。

## 布局结构

主窗口由 Electron 限制最小尺寸为 400×600px；初始尺寸为 1120×730px。

启动时由 `index.html` 首帧静态绘制并由 `StartupOverlay` 接管的全窗不透明 `bg-background` 遮罩覆盖外壳，居中放原生 shadcn `Spinner` 同款图标，
不显示额外文案；遮罩处于最顶层并适配当前明暗主题。退出使用 300ms ease-out 的透明度过渡。
等待与交互恢复的机制见[应用启动](模块/应用启动.md)。

```text
shell ─┬─ header            40px 拖拽区：折叠开关、菜单、窗口控制
       └─ body
          ├─ app-sidebar   50px 固定图标栏：路由、设置
          └─ content       白卡：左上圆角、左描边、紧投影
             ├─ content-sidebar   240–360px 像素宽，可折至 0
             └─ content-main
                └─ WorkspaceFrame（常驻）
                   ├─ home / settings 主内容，随路由切换
                   └─ WorkspaceSurface（右侧绝对定位，多标签工作区）
```

- header 的“文件”“编辑”“视图”“帮助”使用文字按钮（Button ghost / header），
  同处一个 `gap-1` 容器；窗口 ≤760px 时文字菜单收进“应用菜单”，保留窗口控制三钮。
- 左下角设置菜单依次为“设置”、分隔线、“运行时控制台”“内嵌页面”、分隔线、“关于”；
  使用带左侧图标的 DropdownMenuItem，菜单沿用 lg 档，向右弹出并底端对齐。
- `app-sidebar` 上区路由钮与底部设置钮统一使用 `Button ghost / icon-lg`（36×36px），
  图标为 20px（`size-5`），普通态与激活态尺寸一致。
- `content-sidebar` 是普通 flex 像素宽块，不进 react-resizable-panels（RRP）；
  CSS 保证缩放时像素宽稳定，避免百分比尺寸经 JS 校正产生脏帧。
  外层裁剪窗收拢宽度，内部保宽、全高内容以 `transform-gpu` 常驻合成层，保持静止图标的栅格稳定。
- `SidebarResizeHandle` 使用 pointer capture + rAF 直写宽度；拖过下限有阻力，
  越过 min/2 折叠（落点 `collapsedWidth`：侧栏折成 0，模型设置左栏折成 48px
  图标栏），反向对称恢复；键盘 ±16px，双击回默认。
  首页会话列表右侧只显示分割线与拖拽光带，不显示中央胶囊；整条线仍可拖拽调宽。
- `use-content-sidebar-split` 记忆宽度/折叠态，首帧直接还原；只在用户手势后落盘。
  模型设置左栏同方案（`use-provider-rail-split`，像素宽可拖可折）。
- 窗口 ≤760px 自动折叠会话侧栏；自动约束不写入手动布局记忆，放宽后恢复原开合/宽度，
  手动关闭的栏仍关闭。自动收起期间禁用侧栏展开入口与分割线，收起内容 inert。
  窗口断点由 `use-window-media-query` 订阅。
- 右侧工作区并排默认 350px，给对话留至少 160px。窗口 ≤760px 自动收起，仍可显式展开；占满与并排共用绝对定位宿主。[状态与寿命](模块/多标签工作区.md#宿主与标签身份)
- 把手复用 `SidebarResizeHandle`，方向反转。可拖至 160px 后再内拖折叠，键盘 ±16px、双击回 350px；开合用 200ms 裁剪，内容层保宽，拖动和减少动画时关闭过渡。
- 工作区只有一行48px标签头，与对话头部顶边、底边对齐；左起为可搜索标签列表、标签项、新建，
  右侧为占满/恢复并排、收起。展开时隐藏对话头部的工作区开关，收起后显示展开入口。
  标签使用 shadcn Tabs 的 workspace 档：圆角完整项、激活浅底、图标与标题、同级关闭钮；
  横向溢出只在标签列表滚动，隐藏滚动条；与路径栏共用24px边缘渐隐，仅尚可滚动的一侧启用。
  关闭钮不嵌套在标签按钮中，列表、新建、占满与收起按钮不进入遮罩。
  标签列表Popover打开时不自动聚焦搜索框，输入由用户点击或键盘导航进入；条目整行激活与hover，标题只作文字呈现，关闭钮独立，不显示打开时长。
- 新标签页标题用text-base，shadcn Item的xs/plain档纵向列出文件、浏览器，去掉横向内距与占位边框，图标左沿和标题对齐；左侧40px图标块内20px图标、中名称与text-xs说明、右打开；
  不显示临时浏览与最近关闭列表，本次运行的关闭历史从标签列表或快捷键恢复。图标块统一消费ItemMedia tile档，圆角用基础rounded-lg，不加4px。
- 文件页是单一工具行和下方左右两栏：工具行为树开关、文件位置面包屑、打开按钮组；
  shadcn ButtonGroup将主“打开”和下拉箭头接为同一轮廓，原更多操作收入下拉菜单。
  未选择文件时主动作打开本地选择器，已选择时用系统应用打开，菜单仍可选择其他本地文件。
  左栏搜索用 InputGroup 将图标与输入融为一体，其下为根目录操作与虚拟树，右栏为文件预览。
  左栏只列会话绑定的项目目录，标题优先项目名，再回退到项目根目录名；未绑定项目时显示“文件”，单独打开的外部文件不加入树。
  文件树开关沿用Button disclosure档，平时透明，仅悬停显示底色；右侧“选择文件以预览”的空态图标为24px。
  无根时以20px文件夹图标配“当前目录为空”，树标题右侧不放打开文件按钮，本地文件选择由顶部打开按钮组提供。
  从树、文件搜索结果或单选本地文件切换时复用当前标签，仅更新文件名与正文；并行查看须显式新建标签。
  项目内文件显示项目相对面包屑，外部文件显示完整路径；长路径使用 Breadcrumb 的 scroll 档，
  隐藏滚动条、保留单行横向滚动（支持纵向滚轮映射与左键拖曳平移），切换文件后先露出末尾文件名。仅尚可滚动的一侧以共享24px遮罩渐隐，
  到达端点后该侧清晰，短路径无渐隐；遮罩透出主题底色，浅深色使用同一配方。
  元信息收进更多的“文件信息”，正文不叠路径说明栏。
- 浏览器为后退/前进/刷新、居中地址输入、更多单行工具栏；历史收入更多子菜单，空页居中显示地球图标与网址提示。
- 浏览器更多菜单使用256px宽度并受视口约束，菜单文字不换行，缩放三钮完整留在菜单内，不提供下载管理入口。
  站点权限使用shadcn Select的sm档，关闭选中项覆盖触发框的定位，弹层在触发框下方右对齐；触发器通过label关联具体权限，摄像头与麦克风分别选择。
  工作区标签、文件导航、浏览器与查看器控件的悬停提示统一使用 Hint/shadcn Tooltip，不使用HTML title。
  完整路径提示仅绑定当前路径文字，根标题提示也只绑定实际文字，工具行及标题行的留白不触发提示。
- PDF工具栏居中单行：图标翻页、Input的xs页码框/总页数、缩放图标与百分比；页码与xs按钮同档，隐藏数字步进钮。
  页码输入、总页数与翻页控件之间统一使用6px间距。
  文本正文不显示常驻“搜索”按钮；Ctrl/Cmd+F按需展开文件内查找，左侧项目文件搜索保持独立。
  百分比以适配宽度为100%，点击可恢复适配；正文预留稳定滚动条位置，加载与缩放不改变适配基准宽度。
  极窄时只让工具栏局部横滚，不将操作拆成多行。
- 页面切换与保活是[设计提案，尚未实施](计划/页面切换状态保留.md)。

## 颜色、字体与空间

| 对象 | 配方 |
| --- | --- |
| header + 两级侧栏 | `.chrome-surface` 统一绘制宽幅漫射渐变（顶部偏左大范围柔光晕 + 135° 对角微跨色相三段色阶，Oklab 插值），仅在**浅色模式**的 Windows 11 22H2+ 且开启硬件加速时垫系统 Acrylic 材质并开放 40–100% 外壳不透明度滑杆（默认 65%，100% 为纯实色）；深色模式、Win10 / macOS / Linux / 国产信创及关闭硬件加速时自动降级为 100% 实色渐变并隐藏滑杆（避免深色下系统 Acrylic 透出浅色亮度发灰）；内容侧栏叠 `--content-sidebar-overlay` 轻雾面（浅色白 34%、深色白 5%），保留通透渐变同时拉开面层。墨色 / 薄荷 / 蜜蜂 / 羊皮纸 / 海盐 / 暮紫各有浅深两套，默认薄荷；共享色板在 `lib/interface-skins.ts` |
| content-main | 阅读面始终独立垫 100% 实色 `--app-canvas`（浅色纯白、深色中性暗底），不透桌面以保证长文与代码可读性；内容区整体保留左上圆角、顶/左细描边（`--shell-main-border`，浅色极淡冷灰、深色微弱白边）与轻紧投影；侧栏折叠后拖拽条视觉收至 0 宽隐藏，仅留隐形热区 |
| hover / active | 玻璃外壳（header / app-sidebar）使用半透明柔光胶囊（`--chrome-hover` / `--chrome-active` + 微高光）；内容侧栏行使用单层磁吸滑动胶囊 `bg-accent-foreground/5` 随指针在行间平滑过渡（减少动画下即时切换）；active 保持清晰层级且不叠色加深 |
| 行内小钮 | 原生 ghost（hover `bg-muted`）；侧栏搜索入口用 Button ghost-soft，与会话行同为 `bg-accent-foreground/5`；软叠由组件变体提供，不落在 Button 调用点 |
| 文字 | 实色 token；次级 `muted-foreground`，placeholder `--placeholder`；层级靠实色深浅 |
| 轻量浮层 | `Select` / `DropdownMenu` / `ContextMenu` / `Popover` / `Combobox` / `HoverCard` 支持「浮层毛玻璃」总开关与独立三维度滑杆（不透明度 `0–100%` 默认 `60%`、模糊度 `0–32px` 默认 `10px`、饱和度 `100–250%` 默认 `140%`，`lib/popover-glass.ts` 投影 `--popover-glass` / `--popover-glass-sub` / `--popover-glass-blur` / `--popover-glass-saturate`），在 `html[data-popover-glass]` 且支持 `backdrop-filter` 时启用 `.popover-glass` 与防嵌套发灰的 `.popover-glass-sub`，并在作用域内将 `--accent` / `--border` 重映射为半透明软叠（浅 6% 黑 / 8% 线，深 9% 白 / 10% 线）保持通透；关闭或不支持时自动回落实色 `bg-popover`。`Dialog` / `AlertDialog` / `CommandDialog` 与 `Tooltip` 保持实色本体 |
| 语义色 | destructive 错误红；warning 琥珀 `oklch(0.666 0.155 70)`；chrome-accent 品牌蓝 `#0231fa` |
| 聚焦 | `--focus-width: 1px` 内贴实线，浅色 `oklch(0.556 0 0)`、深色 `oklch(0.708 0 0)`，默认 150ms 淡入淡出。控件例外见[组件库与安装](#组件库与安装) |
| 圆角 | 内容主体左上角 `--radius-xl`；输入卡 `InputGroup` composer 档 `rounded-2xl`（原生表单仍 `rounded-lg`）；发送/停止钮 `Button icon-sm` 原生圆角；其余按组件变体，信息区条只圆上两角 |
| 字号 | 默认小字/说明 12、正文/列表 14、分组/侧栏/弹窗标题 16、页面标题 24；分别用 text-xs / text-sm / text-base / text-2xl，界面基准 11–16px 统一派生，小字最低 10px |
| 字体 | Inter + HarmonyOS Sans SC；代码 JetBrains Mono，中文注释回落鸿蒙；常规中文用 400 |

应用文字使用 Electron 40.9.3 的原生字体渲染，常规字重保持 400，不施加全局文字描边。
字体选择与绘制边界见[对话内容主题](技术笔记/对话内容主题.md)。
SVG 图标的栅格化策略与硬件加速总开关见[设置页](模块/设置页.md)，
实测对照见[SVG图标栅格化](技术笔记/SVG图标栅格化.md)。
启动参数的对照验证需完整重启应用；字体清晰度与 DPI 的最终结论在实际 Electron 验证。

UI 默认不可选中；正文容器放开 `select-text`，TraceLine/用量/时间等行头收回
`select-none`，折叠内容仍可选。input/textarea 保持原生选择。

## 组件库与安装

- `components.json` 的 style 为 `base-nova`，原语为 Base UI；用现有 variant/size，
  调用点只调整布局。组件选择纪律统一见 [约定](约定.md)。
- 本地组合件包括 Markdown、Reasoning、Tool、RunTrace；它们消费基础组件，
  不应因 registry 没有同名成品而重写整套视觉。
- 更新组件时先比较官方 Merge diff，CLI 检测不了 electron-vite 时用临时 Vite 项目取基准，preset 用 `--preset nova --base base`。保留本地 token、字体、`@source streamdown`、滚动、渐隐与动效，基础 radius 为 `0.625rem`。
- 聚焦由 `globals.css` 的 `:focus-visible` 维护。附件主触发器、代码块、滑杆拇指和普通 InputGroup 只在外层画线。原生 input 和自定义外壳内的 `Input embedded` 不加入公共轮廓，后者的外壳也不画线。
- composer、审批/询问/方案卡和聊天视口本身无聚焦轮廓，保留键盘焦点及内部按钮的焦点提示。错误边框、菜单导航高亮和减少动画规则仍生效。[界面聚焦样式](技术笔记/界面聚焦样式.md)
- 升级原语时核对下方样式陷阱。Sonner 消费 appearance store、继承应用字体；普通宽 356px、错误 560px，action 使用同色淡底，App 挂 top-center。
- registry 的 IconPlaceholder 换实际图标，CLI 标记沿用官方含义。安装后检查构建产物。

## 模型配置弹窗

模型编辑 Dialog 使用 `sm:max-w-xl`、24px 内距，固定头部模型身份、底部保存栏；中段用 shadcn `TabsList line` 分为基础、思考和兼容，各页签独立滚动并保持挂载。
页签去掉额外水平内距，文字和标题、分组、字段共用左沿；组内及组间使用20px间隔，滚动区与底栏同步24px边距。基础页只呈现容量与输入能力，不再重复放置跳转思考页签的摘要入口。
预设和协议选项复用 Select，能力用 Switch、档位用带勾 Toggle；三态兼容选项用 ButtonGroup 组合 Toggle。上下文滑杆沿用 ContextWindowSlider。
低频协议映射与预算只保留一个 Button disclosure / xs 的「高级设置」入口，配 Collapsible 展开两组表单；默认不加通栏分隔或默认值摘要，有覆盖时提示「已自定义」。
供应商详情的「供应商兼容设置」位于模型列表之后，沿用 Button disclosure / xs 与 Collapsible；模型页签只覆盖当前模型，未单独设置的项继续继承。
兼容字段共用按自身容器宽度切换的排版：字符串选项用 Select，三态用单行 ButtonGroup，不平铺长参数按钮。非必要的操作说明和模型列表教学文字不常显，仅保留校验、不可用原因与数值规则。

## 首页与交互面板

| 部件 | 视觉与组件配方 |
| --- | --- |
| 列表行 | h-8、relative/group；会话行使用 `content-visibility:auto` 与 `contain-intrinsic-size:auto 2rem`，屏外保留固定高度占位；主按钮撑满行高与宽度，内边距及项目缩进放在按钮内；常态 pr-4，动作显现时 pr-14；右侧绝对钮簇独立操作，等待确认 tag 放在主按钮内 |
| 列表菜单 | ContextMenuTrigger 的 `render` 承载整行；动作数据同时供右键和“更多”菜单消费 |
| 会话工作状态 | 复用 shadcn Spinner，`absolute right-4` 固定在行尾，标题预留空间；悬停、键盘聚焦或菜单打开时原位隐藏，由绝对定位动作簇覆盖，不挤压或移动 spinner；等待确认 tag 优先 |
| 聊天重命名 | 聊天右键菜单“重命名”打开 Dialog + Input；预填并聚焦全选；原生取消/保存按钮，Enter 保存、Esc 关闭；错误留在弹窗 |
| 项目移除 | “更多”与右键菜单共用 AlertDialog；描述含项目名与保留范围，原生取消钮和 destructive 确认钮；在途显示“移除中…”并禁用按钮，错误留在弹窗；成功反馈用 sonner 短语通知 |
| 侧栏折叠 | `CollapsibleContent variant="navigation"`，200ms ease-out，仅过渡 grid 轨道；裁剪层与自然高度列表分开，间距固定，不整块淡出；起步样式只在恢复显示时生效；keepMounted，收起 inert，结束后 hidden |
| 等待确认 tag | 占行尾动作簇的位置，常显；emerald `/15` 背景 + 实色深绿文字 + 小呼吸点 |
| 输入区 | `InputGroup variant="composer"`：`rounded-2xl` 大圆角、薄边、浮层投影 `shadow-composer` token（浅 `0 4px 12px rgb(0 0 0/0.05)`，深同几何提黑 alpha 0.4；shadcn 无官方阴影 token，自建于 globals.css）；浅色白卡，深色用抬亮的 card 底色。发送钮禁用不降低整卡透明度；聚焦不改变描边、底色与阴影。新聊天的灰色信息条两侧内收 16px、下沿被输入卡覆盖 12px，形成前后叠层；外观原理见[输入区外观](技术笔记/输入区外观.md) |
| 附件区 | 同一 InputGroup 内、正文上方的 block-start addon；空时不占位。输入区 AttachmentGroup 自动换行，最高 160px，超过后纵向滚动；不加边缘渐隐 mask，单卡也完整显示；图片和文件卡外层统一 rounded-lg（10px）；图片用 Attachment image 变体的 45px 正方形缩略图，不显示文件名/大小/读取说明，简短导入/错误状态放底部，重试放左上；文件/视频用 sm、file 变体，最小高 45px、按内容收缩且最大宽度 180px，文件名单行省略，悬停显示全名；关闭统一用 AttachmentRemove 放右上角，悬停卡片或按钮获键盘焦点时显示，图片/文件同位置同尺寸，文件预留按钮位置避免遮挡或跳动；输入与历史沿用同一尺寸规则 |
| 附件反馈 | 排队项显示“等待导入”/图片“等待中”，复制项显示进度；部分接收后的未添加数量位于输入卡底部，ghost/xs按钮打开Popover查看全部文件名与原因，明细最高160px纵向滚动，icon-xs按钮清除提示；不在正常就绪卡添加内部机制说明 |
| 目录引用 | 加号触发DropdownMenu，含“添加图片或文件”“引用文件夹”；目录沿用最小45px高、最大180px、10px圆角文件卡，文件夹图标、名称、路径副标题，整卡可打开目录；无大小/另存，移除仍右上hover显示；历史与普通文件同行靠右 |
| 底部工具行 | +、权限、计划 chip、上下文、模型；加号为InputGroupButton icon-sm（28×28px），与发送/停止钮等高；其余文字操作Button xs原生档、h-7；图标沿组件档位 |
| 项目胶囊 | 使用 Button project 变体，hover 保留 `bg-accent-foreground/5` 软叠背景；未选时文字为次级色，悬停和展开仍保持，已选项目名为主文字色。已选态触发钮内左图标原位交叉渐变为 X；16px 定宽叠层，不能另起独立关闭钮 |
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
  浅灰 PlanToggle 状态 chip + h-4 矮竖线；主体复用 Button ghost/xs 的 hover 外观与
  箭头光标，两侧沿用 xs 的对称内距，点击不切换计划；独立 ghost-soft/icon-2xs
  关闭钮在 hover 或组内键盘聚焦时浮现，悬停关闭钮时叠加独立背景，关闭后整组消失。
- 输入卡工具行以聊天面板宽度做容器查询：≤640px 时权限仅显示档位图标，
  上下文显示无数值圆环，模型仅显示厂商图标；计划 chip 隐藏文字，保留计划图标
  及悬停/聚焦时的独立关闭钮。
  图标按钮保留完整 aria-label 与原菜单/详情入口。宽态模型名称超长省略，
  间距随面板宽度缩小；极窄时工具组换行，不能裁掉发送按钮。
- FullAccessConfirm 用 alert-dialog + checkbox；权限卡列文件/终端，确认钮为
  destructive。每次打开重置勾选；所有切完全访问入口共用这一闸门。
- TodoStrip 条目完成态绿勾/划线灰字，进行中深色，待办虚线圈；内容 max-h-56。
  胶囊展开图标的零宽必须放外层 span，避免 Button 的 SVG size 兜底压过 w-0。
  收起后 600ms 冷却撤掉 group-hover，避免指针原地触发第二段动画。

## 设置页与通用组件

设置内容用 `SettingsHeader` 与 `max-w-3xl px-10 py-8` 居中列，保留稳定滚动槽。首组间隔 `mt-8`，模型整高卡用 `mt-4`。`SettingsGroup` 是带标题、圆角和行分隔线的组卡，`SettingsRow` 左文右控件。
左栏按「基础设置」「Agent 能力」分组，顶部放搜索；分区项为 `text-sm`。搜索结果整行可点，标记继承文字色。交互和保活见[设置](模块/设置页.md)。

| 部件 | 视觉与组件配方 |
| --- | --- |
| 运行时控制台 | Run 整行折叠。详情区用 Button disclosure/console，无展开灰底。主标题加粗，类别与时间归 Table inspect 两列表格，值可折行。详情和分区留 20px，箭头与正文同基线 |
| 控制台数据块 | 标题、层级、搜索、复制及更多同排，窄栏操作可换行。正文一层浅底，元数据与换行开关收进更多，高度限 `min(60cqh,40rem)`。CodeMirror 搜索留在块顶部，JSON 默认两层 |
| 界面色与字体 | 缩略 RadioGroupCard 随明暗，列宽 ≥36rem 时六列，否则三列。字体 Dialog 依次为语言 Tabs、当前字体、搜索、列表与双语预览，打开聚焦英文页签。强调色用棋盘色块、等宽 HEX 与恢复钮。[色板](技术笔记/强调色选择.md) |
| 常规与通知 | 短 Select 与音量、音调滑杆用 `w-40`。快捷键用 KbdGroup 和弱色加号，键帽有描边。提示音行显示内置或截断文件名，用选择、试听、恢复动作。滑杆右侧各有独立恢复钮，默认时禁用 |
| 存储 | `h-4 rounded-sm` 分类条按字节分配，空根时收起；分类条、图例与明细样式见 `storage-view.ts`。明细用 200ms 导航折叠；路径等宽、可复制 |
| 模型 | 主从卡同页头列位。左栏 176–320px、默认 208px、折叠 48px，清单和图标层在 200ms 裁剪时交叉淡出，隐藏层 inert。左右各自滚动。右侧测试/编辑/删除用 sm，悬停或聚焦时显现，测试时常显 |
| MCP 与技能 | ScopeMenu、计数与搜索同组，已安装组提供刷新、导入、新建。MCP 弹窗用表单/JSON Tabs，技能编辑含名称、说明与等宽正文，校验错误留弹窗。文件诊断单列组卡，空态为虚线卡 |
| 图标与 Tooltip | 首选 Tabler，选中用对应 Filled。ProviderLogo 从 `@lobehub/icons` 导入，尺寸用组件变量。通用提示走 Hint，富交互用 Tooltip 原语；箭头无指针命中，键帽用淡边框 |

## 消息流的视觉配方

功能、所有权与事件顺序见 [消息呈现](模块/消息呈现.md)，原理见
[流式呈现动效](技术笔记/流式呈现动效.md)，真机矩阵见 [消息验收](测试用例/消息呈现.md)。

- 用户消息灰气泡，助手平铺；消息段和过程行统一 `gap-3`、回合容器左右零内边距。
  空正文不挂容器，避免纯思考段多吃间距；零工作项的 live 也不渲染空过程容器
  （空盒多吃一个 gap，与终态头条栈高不齐，瞬时失败翻相会跳）。
- 运行态过程单行化，工作行位于流底，图标是 `WorkingSpinner` 三叶动效，
  配标题扫光和 tabular-nums 码表；停止在途文字为“正在停止”。
- WorkingSpinner 使用 1em 尺寸与 0.075em 光学上提。三叶旋转、呼吸与错相由组件和 CSS 维护。[动效配方](技术笔记/流式呈现动效.md)
- 工具图标保持静态，固定类别词运行态扫光，执行前后不换名；人工允许为工具行尾
  16px 盾牌图标，拒绝/取消为对应图标，Tooltip 显示裁决结果；失败仅“执行失败”点状下划线为红，
  Tooltip 提供原因/复制，整行不染红。bash 进度为定高两行尾部 + 扫光细条。
- 工具命令摘要、展开的普通输出与直播尾行统一使用 `text-muted-foreground`，
  展开内容不切成正文黑色；输出颜色由 CodeBlock 默认变体统一提供，明暗主题同口径。
  工具内容不使用边缘渐隐遮罩，普通输出与 diff 均完整显示；长内容保留原生滚动。
- 详细模式的思考默认单行收起，摘要横向滚动并渐隐；展开限高内部滚动。
  简洁模式仅保留思考状态行与耗时，工具与思考均无详情入口，底部统计行不显示。
- 终态“用时 / 已停止 / 出错了”与折叠内容同级左缘，无分割线和导线。
  轨道必须 `minmax(0,0fr) ↔ minmax(0,1fr)`，内层纵向 padding 同曲线收拢；
  keepMounted，折叠体内部不套 content-visibility 包装。
- `home-chat` 查询容器改变 `fixed` 的定位原点。工作行按实际包含块换算坐标，保持在偏离窗口原点的聊天视口内。[跟随与工作行机制](模块/消息呈现.md)
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
- 用量行在正文 footer，使用 `text-xs text-muted-foreground tabular-nums`。统计内容和显示条件见[用量与成本](模块/用量与成本.md)。
- 产物区位于终答与用量之间，使用shadcn Nova Card的sm档横向单行文件行：左侧图标、中间名称与类型同行基线排列、右侧ButtonGroup组合“打开＋下拉”；
  卡片内边距覆盖为py-2/px-2.5，圆角覆盖为rounded-lg（与下方改动条一致），行内gap-2，不预留图标框；文件图标用Material Icon Theme原始彩色SVG，size-5，不加底色或图标框；正文文件链接共用同一组件，size-4。
  不设“交付文件”标题或数量行，另存等动作收进菜单，正常项不常显大小、申报说明或保存状态。首屏3项可展开全部，异常提示与回合Badge保留；
  文件动作失败用AlertDialog与“知道了”关闭钮，长路径可换行滚动。门控和版本机制见[产物文件卡片](模块/产物文件卡片.md)。
- Markdown 使用 Streamdown + Shiki + CJK；本地链接显示Material文件图标与原标签，不加背景，自动识别的文件名使用普通文本链接；
  hover/键盘聚焦用shadcn Tooltip显示可换行的完整路径与原生复制图标钮，复制钮用icon-sm档并与路径垂直居中，400ms延迟；右键用ContextMenu提供文件动作，错误用独立AlertDialog。
  图标与整个标签为两个布局项，文字渐显片段在标签内自然排版，不逐片添加间距；文本预览顶部显示已定位的行列或范围。
  网页链接左击用系统浏览器，右键可选工作区或系统浏览器，脚注走文内跳转。[文件链接机制](模块/正文文件链接.md)
  文件预览使用右侧多标签工作区，布局与尺寸合同见本文“布局结构”；宽度变化保留节点与阅读状态。
  操作菜单沿用 shadcn，正文/代码字号使用共享消费点，预览不另外造字号档。
  Office纸张、表格与幻灯片内的字体/尺寸属于文件内容，保留原版式并限定作用域；不套应用字号或污染聊天。
  lineNumbers 由外观设置「显示代码行号」驱动（默认开，与标签页文件预览共用）、库内 animated、linkSafety
  弹窗关闭，Shiki 传 [github-light, github-dark] 双主题随 html.dark 切换；
  Tailwind 显式 `@source` 扫 Streamdown。深浅色三档（浅/深/跟随系统）切
  html.dark，初值 main.tsx 同步挂防闪白；代码长行换行走 html[data-code-wrap]
  门控。
- 对话内容消费 Themd 令牌，默认正文和代码保留 14px，由用户字体和字号覆盖最终生效。[内容主题](技术笔记/对话内容主题.md)
- 正文短批 300ms 淡入，代码与表格只动新行。完整动效、合批预算和终态见[流式呈现动效](技术笔记/流式呈现动效.md)。
- `.shimmer` 必须用 Tailwind `@utility` 注册；前景实色 + 透明淡带，300% 底、扫 2s 停 2s。
  `.scroll-fade-b/-y/-x` 使用 24px mask，消费区域需留足边距，避免淡化首尾文字。

## 会话搜索浮层

侧栏搜索按钮使用 Lucide SearchIcon，与 Ctrl+K 共用 Nova CommandDialog 的 search 尺寸档：顶部 15vh、
最大宽 2xl，固定高 `min(36rem,70dvh)`；输入自动聚焦，底部保留键盘提示。
侧栏搜索按钮的 Hint 同行显示“搜索”和 Ctrl+K，快捷键用 KbdGroup 与 Kbd 键帽组合。
输入下直接放统一「聊天」分组。行内依次是图标、标题和右侧项目，正文命中摘要占下一行。结果内容和查询语义见[会话搜索](模块/会话搜索.md)。
CommandItem 的 search 变体使用 `px-3 py-2.5`，不预留勾选图标槽，内容左右均留 12px；默认文字/图标为次要色，
只有 hover 时一起转为主色；键盘选中保留背景提示，不自动改变文字色。命中标记继承项颜色。
中段填满剩余空间并独立滚动；加载时由 shadcn Spinner 居中占位，结果/空态不改变高度。
CommandList 的 fill 布局档取消默认限高。原语选择器按 cmdk 的
`data-selected="true"` 匹配，不能把 false 也染选中色；调用处不覆盖组件皮肤。
底部用 `CommandFooter` 通栏浅底槽配 `Kbd` 键帽分置两端（左 `↑`/`↓` 选择与回车打开，右 `Esc` 关闭），不放搜索范围说明。
命中高亮不加底色：标题/摘要通过加粗标记并继承项文字色，原文定位通过下划线提示。
原文定位工具条位于聊天上方。

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

- 运行时控制台的 RRP v4 用 `orientation`；Panel 的 className/style 落内层。无 defaultCollapsed，
  首次初始化用 imperative collapse。已布局尺寸由 flexGrow 承载，过渡作用于 flex-grow。
- 注册后等两轮宏任务再放开尺寸过渡，避免 flexBasis→flexGrow 交接生长；
  不用后台会停发的 rAF 门控。拖拽时以 `:has([data-separator=active])` 关闭过渡。
- 持久化取 `onLayoutChanged` 参数，getSize/onResize 在该时刻可能滞后。
  RRP 4.18.1 的 preserve-pixel-size 不满足侧栏像素语义，所以侧栏与主工作区独立实现。
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
- 后台标签会冻结 CSS 动画与 `requestAnimationFrame`。用运行中的窗口验证像素和动效，测试入口见[测试模块](模块/测试.md#运行与验收)。
