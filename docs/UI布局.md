# UI 布局与视觉配方（AI 操作手册）

> 布局定稿配方与技术坑汇总。
> 本文只放"现在怎么写"；逐件落地的过程考古看 git 历史与 [计划/](计划/)。
> 「布局结构」的区域代号（header / app-sidebar / content-sidebar / content-main）
> 是描述、注释、组件命名的统一词汇；改布局前先读本文。

## 布局结构

```
shell ─┬─ header            40px 拖拽区（AppHeader：折叠开关/菜单/窗口控制）
       └─ body
          ├─ app-sidebar   50px 固定图标栏（AppSidebar：路由钮 + 设置下拉）
          └─ content       白卡（rounded-tl --shell-radius + border-l 自描边 + 紧投影）
             ├─ content-sidebar   240–360px 可拖可折叠（折成 0），微灰底；普通 flex
             │                   像素宽块（不进 RRP）+ localStorage 宽/折叠态记忆
             │                   （各视图内容在 AppShell 按 view 挂）
             └─ content-main
                ├─ home      HomeMain = [主要区 HomeChat | 标签页区 HomeTabs]
                │            （标签页区 280–520px 可拖折叠、默认收起，动作全空位）
                └─ settings  SettingsMain = 按分区挂内容（常规已落地，其余占位）
```

- 分栏分两类引擎（2026-11-12 定）：
  - **content-sidebar = 普通 flex 像素宽块，不进 RRP**（方案同 Themd）：RRP 百分比
    引擎靠 JS 追赶校正，窗口缩放先按旧百分比画脏帧内容抖动，且 4.18.1 的
    `groupResizeBehavior="preserve-pixel-size"` 裸库探针实测无效（三组全部按比例
    跟动）—— 像素宽由 CSS 布局层逐帧保证，窗口缩放零 JS 参与。拖拽 =
    components/SidebarResizeHandle 自绘（pointer capture + rAF 直写 DOM，样式/
    光带/状态机与 GlowResizeHandle 同构；拖过下限先钉在下限做阻力，拖过
    min/2 才折叠、反向对称恢复 —— 对齐 RRP collapsedThreshold 默认；键盘 ±16、
    双击回默认）；折叠开关 = hook 的 toggle（宽度记忆不动）。
    记忆 = hooks/use-content-sidebar-split（localStorage 宽 + 折叠态，挂载直接
    渲染到位，无 imperative 补挂；只有用户手势落盘，窗口缩放天然不写）
  - **content-main 内部分屏**（HomeMain 主要区|标签页区）是真百分比语义，仍走
    react-resizable-panels v4 + GlowResizeHandle：拖过下限折叠成 0，折叠后把手
    贴缘即展开抓取点；点钮折叠 = usePanelRef imperative collapse/expand，状态走
    onResize 同源同步（HomeChat 开关同手法）
- 路由：stores/ui 的 AppView（home/tasks/plugins/settings），页面量少不引 router
- 跨区域共享态走 zustand：stores/home（首页会话 chat|new，驱动信息区/对话流）、
  stores/settings（设置选中分区）；单组件临时状态 useState 不进 store

## 颜色与视觉配方

- **chrome L 面**（header + app-sidebar）= `.chrome-surface` 薄荷渐变
  （135°，#e0f3e9 → #eef7f2 → #fbfdfb）；content-sidebar = `--content-sidebar`
  #f2f8f4（浅于 chrome、深于主体）；content-main 纯白 —— 三层递进
- **hover/active 全局配方 = 黑低透明软叠**（ChatGPT 同款）：`bg-foreground/5` 或
  `bg-accent-foreground/5`；**active = 常驻 hover 色，不加深**（rail/列表行/信息区
  条目同一规则）；行内小钮在白卡上 hover 同 /5，在行底上 /15（深一档才可辨）
- **文字色一律实色 token**（AGENTS.md 方针 3，禁 text-x/75）：次级 muted-foreground、
  placeholder 专用 `--placeholder`(0.71)、层级靠实色深浅；透明度只用于背景/hover 底
- 语义色：destructive（错误红）/ **warning**（琥珀 oklch(0.666 0.155 70)，权限风险类，
  如"完全访问"）/ chrome-accent（唯一品牌蓝 #0231fa：分屏光带 + 文内链接）
- 圆角：大卡 24px（rounded-3xl）/ 设置组卡 12px（rounded-xl）/ 行 6px（rounded-md）/
  信息区条只圆上两角（rounded-t-xl）
- 字号阶梯：页面标题 24 semibold / 侧栏标题 16 semibold / 行标题 14 medium /
  列表行与正文 13 / 说明文字 13 灰 / 时间戳 11-12；**小号中文不上 500**（13px 用 400）
- UI 文字默认不可选中（body `user-select: none`，拖窗/划列表不蓝底成片）；
  正文类内容在容器上 `select-text` 放开（消息流已放开），input/textarea 不受影响

## 关键组件配方

- **列表行**（侧栏/信息区条目通用）：h-8 relative group 容器（hover 底）+ 占满
  button（pr-12 给动作钮让位）+ `absolute right-1` 钮簇 opacity-0
  group-hover:opacity-100；信息区条目的钮簇**保留 focus-within**（菜单 portal 在
  行外，hover 已断），折叠箭头**不挂** focus-within（焦点残留会赖着不灭）。
  **右键菜单 + 菜单开着保高亮**（2026-11-11）：行 div 经 `render` 顶替为
  ContextMenuTrigger（base-nova context-menu，Base UI 原生右键/长按触发，
  Positioner 默认锚指针位置）；菜单开着时行不掉高亮 —— trigger 挂
  `data-popup-open`，行底配 `data-popup-open:`（行自身=右键菜单）+
  `has-[[data-popup-open]]:`（行内「更多」dropdown 开着，:has 只看后代匹配不到
  自身，两条各管一头）同 hover 色，钮簇配 group- 同款两条保显现（此时焦点已被
  Base UI 移进弹层，focus-within 不可靠）。项目行菜单项抽成 actions 数据数组，
  「更多」dropdown 与右键菜单 map 各自的 Item 组件 —— 双入口同权同项不漂移。
  项目弹窗创建/编辑双模式合流（2026-11-12 ProjectDialog，用户定调"编辑与创建
  行为一致"）：编辑 = 直落创建第二步同一张表单（改名 + 目录增删），只有**新加**
  目录走信任确认（已信任过的重复问是噪音），引擎配套 project.update
  （name+cwds 全量替换；rename 保留给纯改名场景）
- **输入区**（HomeChat.ChatComposer）：白卡 rounded-3xl border-foreground/10，
  无投影、聚焦无任何反馈（has-[focus-visible] 反制掉组件默认 ring）；上方项目
  会话信息区 mx-5 h-9 rounded-t-xl bg-muted —— **新聊天限定**（无项目 = "选择项目"
  单钮；项目内发起 = 回显项目/本地/main；已有对话的会话不显示）。**底部工具行**
  五钮（+ / 权限 / 计划 chip / 上下文 / 模型）统一 **h-7（28px，与右侧发送圆钮
  同高）**、圆角走 Button xs 档原生（`min(var(--radius-md),10px)`）不覆写
  （2026-11-16 定调：曾 h-6 偏扁、rounded-xl/8px 混用）；档位图标与模型
  厂商标同 **17px**。项目胶囊
  （ProjectPicker）已选态 hover：左侧文件夹图标**原位**交叉渐变成灰底白 X 圆徽
  （16px 定宽 span 内两图标 absolute 叠放换透明度，同侧栏文件夹开/合手法）——
  X 是嵌在触发钮里的 role=button span（button 嵌 button 非法），pointerdown +
  click 双路 stopPropagation 拦 base-ui 触发器，点 X = 解绑项目（删绑定空
  脚手架会话防串归属）而非弹菜单；胶囊旁另起独立 X 钮的方案被否
  （2026-11-10 用户定稿：融进胶囊，不是两个按钮）
- **会话头部信息卡**（HomeChat.ChatHeader，2026-11-16 对标 zcode，替代先前
  的项目名 tooltip）：**项目会话 hover 标题区**（文件夹图标 + 标题整体，非交互
  span 触发）出 hover-card（components/ui/hover-card = base-nova 装的
  base-ui preview-card 包装，delay 400 同 Hint 口径）—— 卡内三段：**标题
  全文**（头部行截断，卡里看全）+ 项目行（名称 13px + 主根路径 muted 12px，
  多根项目其余目录在工作区面板，同信息区口径）+ 最近活动行（同项目各会话
  updatedAt 的 max 派生，relativeTime 相对文案，selector 返回原始数字防
  重渲染抖动）；非项目会话不显图标不出卡。**坑**：触发区必须 `render={<span>}`
  整体承载（tooltip/HoverCard trigger 嵌别的 trigger 要包外层，塞 render
  里 children 被吞 —— ProjectPicker 同教训）。**git 分支行暂缺**：引擎协议
  与壳桥均无分支数据通道（env.d.ts 全查无），属工作区面板后续件范围
- **审批确认面板**（features/home/ApprovalPanel.tsx，2026-11-11 审批交互升级
  D1/D2；**布局定稿 = 完全模仿用户参考图**的竖排选项列表形态）：**待审批时
  替换输入区**（HomeChat 底部条件切换 hasPendingApproval ? Panel : Composer，
  输入草稿提升 HomeChat 层持有防卸载丢字 —— run 挂起中本就发不出消息）。
  卡片结构逐行对位参考图：「需要权限」小标题 → 参数行（IconPencil + 等待
  确认灰字 + IconFileText + 文件名深色 + 路径灰字 —— 从引擎 summary `write(
  path,…)` 首参拆 basename/dirname，解析失败整条原样显）→ **竖排全宽选项**
  （序号 tabular 灰 + 主文案 + 说明灰字同行；允许/始终允许此工作区（无根
  与**越界写**不显 —— 规则 = 根内信任记忆，序号顺移）/允许并切换为 ▾（自主
  [默认]/完全访问；允许本次 + 切会话模式 + 记项目默认；下拉 = SwitchModeDropdown
  共用组件，见权限模式菜单段）/拒绝）→ 附言输入框（h-9 rounded-lg **border-0
  bg-muted/60** 无框浅灰条，placeholder「告诉模型接下来应该怎么做…」）→
  底部行（ⓘ IconInfoCircle「使用 ↑↓ 选择，回车确认」+ 右侧深色确认主钮
  `bg-foreground text-background`，发送钮同族）。**键盘模型 = 终端式选择的
  GUI 化**：↑↓/Tab 移动**选中态**（React state 浅灰底 bg-muted 高亮，非 DOM
  焦点轮转；hover 同步选中，**mouseLeave/附言框 focus 清高亮** —— 聚焦输入
  框后选项灰底赖着不消是首验翻车点；mouseLeave 的例外 = 档位下拉开着时不清
  （弹层是 portal 在行外，移进弹层必经 mouseLeave，不豁免则高亮丢成 -1、确认
  钮/Enter **静默无操作** —— 2026-11-16 修复的根因），下拉开/关**锁所在行**
  高亮、关时焦点还卡容器（Base UI 关菜单默认还焦点给下拉触发器，Enter 会重弹
  下拉而非确认）），Enter/确认钮 = 执行选中项，点击行 =
  直接执行；**无选中（-1）时确认主钮置灰**（无可确认项不给确认，Enter 同语义
  无动作）；面板出现即聚焦卡容器（tabIndex -1，替换了输入框焦点不能漂移）；
  附言框 Enter = 拒绝并附言（stopPropagation，isComposing 挡输入法）、↑↓
  交还列表；多条挂起竖排多卡（pi 并行工具并发），首卡聚焦。确认主钮反馈
  阶梯：`bg-foreground → hover:/85 → active:/70` —— 近黑底上 hover:/90 只差
  10% 透明度肉眼无感（首验「没 hover」翻车点）；base-nova button 原语**无
  active 按压色阶**（cva 只有 hover + focus ring + active 位移），深色主钮的
  按压色阶自补。
  裁决痕迹行 = ApprovalCard（TraceLine 置灰单行随裁决落消息流，run 终态
  替换保留）
- **交互座三面板**（阶段 4c，交互座 = todo/ask_user/plan 三件工具的
  呈现面；前两者与审批面板同位互斥——都是 run 挂起中的"占位等待"层，
  HomeChat 条件链 hasPendingApproval ? ApprovalPanel : hasPendingPlan ?
  PlanPanel : hasPendingQuestion ? QuestionPanel : Composer）：
  - **任务清单条**（TodoStrip.tsx）：**内容区右上角浮动卡**（w-80，
    absolute top-3 right-4 + shadow-sm——清单是跨回合的"进行中"，
    与消息流叠放不占布局位）；清单非空才挂载，可折叠：折叠收小
    **移入**角内（top-1.5 right-2.5 + transition 滑入滑出）成计数
    胶囊 = Button outline+**pill 档**（button.tsx 自有变体，text-sm/
    px-3，整钮可点展开，IconListCheck size-4.5，IconArrowsDiagonal
    展开图标 **hover 才动画加入**：默认零占位（w-0 + 负 margin 抵
    gap），hover 宽/距/透明度三过渡。**坑**：w-0 必须写在**包裹
    span** 上 —— Button 基类 `[&_svg:not([class*='size-'])]:size-4`
    兜底 specificity 压过传入单类，svg 直写 w-0 会被顶回 16px 占位；
    span 不受该规则管，内层 svg 带 size-4 挡兜底。**收起冷却**：折叠钮
    位置与胶囊几乎重合，收起瞬间指针压在胶囊上 hover 即命中 → 动画
    「收起即触发」，收起时挂 600ms 冷却整体摘掉 group-hover 类，指针
    移开再回来即正常）；
    展开卡头部 = 纯展示行（IconListCheck size-4.5 + 标题 text-sm/
    计数 text-[13px] 比条目行大半档，不可点）+ 行尾**独立折叠钮**
    Button ghost icon-sm（IconArrowsDiagonalMinimize2 折叠语义、
    aria-label，与胶囊展开图标配对——标题与折叠不做同一按钮，首验
    整行可点被否），条目区 max-h-56 限高滚动；条目行 = 状态
    图标（完成 IconCircleCheckFilled **emerald-600 实色**（zcode 对齐）/
    进行中 IconProgress 深色/待办 IconCircleDashed 灰）+ 内容（完成
    划线置灰）；
  - **提问面板**（QuestionPanel.tsx）：zcode AskUserQuestion 同形态的
    **单题向导卡**（2026-11-16 验收定调，替代多问竖排）——头部 = header
    胶囊（rounded-md border）+ 问题正文 truncate + **‹n/m› 问题切换器**
    （IconChevronLeft/Right，到边禁用；单问题不渲染）；选项行带**数字
    序号**（灰 tabular-nums，选中/作答变深；多选在序号后带
    IconCircleCheckFilled 勾选位），白卡直排**无灰内块**（选中
    bg-muted / 高亮与 hover bg-muted/75）；末行「其他」自由输入与选项
    共用序号空间（placeholder「输入你的回答...」，输入非空 = 序号变深
    且提交时覆盖选项选择）；**收题模型（点击即确定，2026-11-16 定调）**：
    单选点选项/键盘选中 = 落草稿并自动推进（末题即整卡提交，点已选中
    项 = 取消留本题重选）；多选点击 = 勾选切换不推进，「继续」收题；
    「其他」输入框内 Enter（isComposing 挡输入法）= 以输入收题推进；
    底部 = 键盘提示「使用 Tab / 上下键选择，回车或空格选中」（zcode
    同句，键盘模型与 PlanPanel 同构：↑↓/Tab 循环高亮含「其他」行，
    Enter/空格与点击同语义，高亮在「其他」行 Enter = 聚焦输入，输入
    框内 ↑↓ 交还列表、空格不吞——无高亮时不拦截冒泡键）+「忽略」
    outline 钮（**分题跳过**：清该题草稿收题——非末题翻页、末题整卡
    提交（该题空串），每题可忽略、卡不留「点了没反应」态）+ 主钮
    （非末题「继续」= 以草稿收题翻页，末题「提交」
    = 整卡提交，answers 按问题序，未答传空串 = 引擎按跳过处理）；
    草稿跨切换保留，面板出现即聚焦卡容器（PlanPanel 同规）；
  - **方案审批面板**（PlanPanel.tsx）：ApprovalPanel 母版同骨架（竖排
    选项 + ↑↓/Enter 键盘模型 + 附言条，无选中时确认钮置灰同规）——
    「实现计划待审批」标题 + 方案预览（pre whitespace-pre-wrap，max-h-64
    滚动限高）+ 两选项：批准（= 退出计划模式，按当前权限档开始执行 ——
    正交开关 v3 起批准不切档，原档自动恢复）/ 拒绝；附言 = 拒绝的
    修改意见（回灌模型修订重提，placeholder 明示）。
- **档位下拉**（features/home/SwitchModeDropdown.tsx，审批面板
  「允许，并切换为 ▾」行内下拉）：**视觉与权限菜单同源** —— 弹层项直接
  复用 PermissionMenu 导出的 `MODES`/`ModeItem`（模式图标 size-4.5 +
  strokeWidth 2.25 + 两行文案 + 当前档 IconCheck 右浮 + 完全访问 warning
  琥珀变体；min-w-56 放宽为布局类），触发器显当前档模式图标 + 档名 + ⌄、
  三色随档（完全访问 = warning 琥珀 / 自主 = chrome-accent / 收紧档 muted，
  权限菜单触发钮同语言）。**选「完全访问」先过 FullAccessConfirm 闸门**
  （2026-11-16 定调：任何入口切 auto 都过闸门；曾直切并记项目默认绕过它），
  **闸门即最终确认**：确认启用 = 允许本次并切 auto 一步到位（onAutoApproved
  执行器；曾只落本地 state，用户过完风险闸门以为切完、实际还悬着行级
  「确认」未按）；取消 = 面板不动。点当前档无操作（权限菜单同语义）。
  **坑（portal 事件冒泡）**：弹层 DOM 挂 body portal，但 React 合成事件沿
  React 树冒泡 —— 本下拉整个嵌在宿主面板的选项行 <button> 里，菜单项/
  闸门按钮的 click 会冒到行 onClick **误执行整行**（「点完全访问却按旧档
  允许并切换」的真根因，2026-11-16 二次修复）—— DropdownMenuContent 与
  闸门外层各包一层 onClick stopPropagation；trigger 的 stopPropagation 只
  护住它自己。
  曾用形态（纯文字项 + IconCircleCheckFilled 黑圆勾选中标记 + 触发器灰圆勾
  模仿 zcode ⊙）语义不明已废。
- **权限模式菜单**（features/home/PermissionMenu.tsx）：dropdown-menu =
  **顶部「计划模式」开关项**（IconClipboardList，勾选 = 开关开启，toggle
  语义非档位单选；desc 开启态切换「开启中：只读约束生效」）+ **分隔线**
  （隔开关组与档位组两种交互语义，正交开关 v3 从原「完全访问上面」的危险
  分组线挪来）+ **三档真选项**（变更前确认 IconShieldQuestion / 自主模式
  IconSparkles / 完全访问 IconShieldExclamation）；每项两行（名称 + muted
  说明）+ 当前项 IconCheck 右浮；`MODES`/`ModeItem` 导出为全 app 档位呈现
  的**单一视觉真源**（SwitchModeDropdown 共用）；完全访问的强调 =
  **warning 琥珀（警告非错误 —— 曾用 destructive 红
  被推翻）**（菜单项 icon+label 与触发钮同语言）。
  触发钮显**当前档名 + ⌄**：**无常态背景**（含完全访问态，红胶囊常驻底
  已废），仅 `hover:bg-accent-foreground/5` 出底；**三色区分**（完全访问 =
  warning 琥珀、自主模式 = chrome-accent 蓝[链接同款实色 token]、变更
  前确认 = muted-foreground 灰），箭头不单独给色（继承 currentColor）；
  计划开关态不占触发钮（旁侧 PlanToggle chip 常显）。
- **计划开关外置 chip**（features/home/PlanToggle.tsx，权限钮右侧）：
  **只在开关开启时渲染**（非计划态不显示 chip 不置灰——开启入口 =
  菜单开关项，2026-11-16 定调）；左侧矮竖线分隔（h-4 居中裸 span ——
  Separator 组件 self-stretch 撑满行高且 data 变体类覆盖不掉，2026-11-16
  用户定调「横杠太高太粗」后改固定矮线）；IconClipboardList +「计划」+
  **hover 浮现 × 关闭钮**（opacity 过渡不占位，点击关闭）；文字色 =
  **muted-foreground 浅灰**（两轮定调：不要蓝强调、不要主前景色——
  与 ask 档触发钮同级，hover 深一档回 foreground）；与菜单开关项同
  数据源（session.summaryChanged 回流）
  同动作（session.setPlanMode）。
  坑：base-nova dropdown Trigger 是 Base UI `render={<Button/>}` 模式，**不是**
  Radix `asChild`；菜单 side="top"（钮在底部输入区）。
  **坑（Select 弹层宽度）**：base-nova `SelectContent` 默认
  `w-(--anchor-width)` + `min-w-36`。`--anchor-width` 由 Floating UI 写在
  positioner 的 inline style 上（实测恒有值 = 触发器宽；早期「非 Dialog
  布局下不生效」为误诊，当时外扩的真因是 min-w-36 地板 + 调用处按 luma
  触发器宽度配的 w-36 死补偿 —— base-nova 触发器收窄后暴露：144px 菜单
  对 ~110px 触发器）。窄胶囊触发器（w-fit）解法 =
  `className="w-[var(--anchor-width,fit-content)] min-w-0"`（= 触发器宽，
  fit-content 仅兜底；**禁写死宽度** —— 按某代风格触发器配的补偿换装必漂）；
  `w-full` 表单触发器（Dialog 内）不受地板影响，原样即可。官方新版 registry
  源里的 `cn-menu-target` 类是 CLI 安装期 marker（非 CSS 定义），对人工
  合入无增益 —— 不要为追它改组件。
  **坑 2（dropdown item 的强调色必须走原语变体）**：item 的 focus 高亮带
  `**:text-accent-foreground` 通配染色 —— 把**所有后代**文字/svg 强制压黑，
  子元素自己染的 `text-warning` 等强调色在 hover 下必被打掉（权限菜单
  「完全访问」琥珀 hover 变黑的根因）；解法 = 在 item 层声明变体并从通配中
  排除（原语已补 `variant="warning"`，照 destructive 的
  `data-[variant=…]:text-*` + `not-data-[variant=…]:focus:**:` 排除链同款），
  叠子元素类是对抗不了通配选择器优先级的
  **坑 3（`[[data-size=lg]_&]:` 祖先变体产物缺失）**：任意变体以 `[` 开头的
  候选（`[[…]_&]:py-1.5` 形态）经 Tailwind compile API 直喂**有效**，但 vite
  管线的 oxide 提取器扫 TSX 源串时**实际不生成**，产物静默缺规则（touch /
  清 node_modules/.vite 均不恢复，2026-11-16 dropdown lg 档首版实测）；
  解法 = Context 下发尺寸、原语内按条件拼**字面类**（字面类提取百分百可靠）。
  dropdown-menu 原语已内置 `size="lg"` 放大档（MenuSizeContext：面板
  rounded-xl + p-1.5，行/标签/分割线随 context 放大；size 不传 = 继承外层，
  子菜单 portal 不断 context 自动跟随）—— 内容型菜单（模型菜单）用 lg，
  普通动作菜单保持默认紧凑档
- **侧栏等待确认 tag**（HomeSidebar ChatRow，2026-11-11 升级第 4 步；当日用户
  定调修订形态）：**占行尾动作钮簇的位置**（有挂起审批时置顶/归档钮整簇不
  渲染 —— 待审批是行当前的唯一状态；首版「标题右侧小字 + hover 淡出避让」
  被推翻：太小、且 hover 藏 tag 与钮簇互挤）。胶囊 = `bg-emerald-500/15` +
  实色 `text-emerald-700` text-xs px-2 py-0.5（文字色纪律：透明度只许用在
  背景）+ `size-1.5 animate-pulse` 呼吸点（控制台 timeline 同款「进行中」
  语言）；**常显**不随 hover 隐藏，标题 pr 随之收窄（pr-2，无钮簇要让位）。
  派生 = chat store pendingApprovalsBySession 非空即显，useCallback 函数签名
  下传保行级 memo
- **设置页**：SettingsParts 拼装 —— **SettingsPage（详情页统一骨架，zcode
  对齐 2026-11-15：所有分区共用，不各自手写页头）**= 限宽单列
  （mx-auto max-w-3xl px-10 py-8）+ 大标题（24px 粗体居左）+ 可选描述行
  （灰 13px）+ 可选工具行（计数/动作钮）+ 内容；SettingsGroup（组标题 +
  rounded-xl 描边卡 + divide-y 行分隔，label 可省）+ SettingsRow（左标题/
  描述右控件，title 可带内联徽标）；控件全部组件库原生形态（2026-11-15
  定调不覆盖样式）：Switch / Select / Button（outline/secondary 等
  变体档）；路径行（mono 截断 + 更改钮）。唯一例外 = 模型设置
  （master-detail 自撑布局，内容特殊）
- **设置 · 模型设置（master-detail，2026-11-08）**：页内自撑 `h-full flex-col`
  （SettingsMain 的外层滚动不参与）—— 页头（标题 + 描述行右挂 [圆形刷新钮 +
  黑色添加供应商]）+ `mx-10 mb-8 flex-1 min-h-0 rounded-xl border` 主体卡
  （overflow-hidden，内部两栏各自滚）：左栏 w-72 border-r（分组标签 text-xs 灰 +
  h-9 圆角行 = 品牌标 20px + 名称 + `ml-auto` 状态点 size-1.5 emerald-500/warning），
  右栏 max-w-2xl 居中详情。详情头 = 品牌标 28px + 名称（自定义是行内编辑 input）
  + 右挂开关/更多；字段 = FIELD_LABEL 上 + Input rounded-lg h-9 下（mt-5 组距）；
  模型行容器 = divide-y + rounded-lg border（行 h-12 px-4，徽标紧跟名称不贴右、
  动作簇 w-13 ml-auto hover 显形防跳动）。选中回落派生（selected 缺失 → 首个内置），
  详情组件按 id 挂 key 重置草稿态
- **设置 · 连接（MCP 服务器页，2026-11-15 按 zcode 参考稿重排 + 作用域）**：
  单列分区（max-w-3xl 骨架）—— 页头描述随作用域切换（用户级：新会话生效
  说明；项目级：项目名 + 主根路径 + 覆盖语义）；工具行（zcode 两行形态）=
  作用域 ScopeMenu（**级联子菜单**：本机▸用户 / 项目▸各项目，触发器显
  「本机 · X」；
  useProjectScope 默认跟随活跃会话归属项目、手动挑过即固定）+ 竖分隔线 +
  「服务器 N」+ 搜索胶囊（ml-auto w-56，侧栏同款裸 input）；第二层 =
  SettingsGroup 标题行「已安装 N」+ 右侧动作区（刷新 outline 圆钮 + 用户档
  「导入」outline 钮 + 「新建」黑色主按钮）；条目行
  （SettingsGroup 无标题卡 + divide-y）= size-10 圆角图标方块（stdio 终端 /
  http 地球）+ 名称 + 已禁用/exposure/项目覆盖徽标 + 第二行灰字
  detail·description + 右侧 Switch +（用户档：编辑/删除 icon-xs 灰钮；项目档：
  overrideApplied 时重置 icon-xs）；空态 = 虚线卡（border-dashed）居中主副
  文案 + 「新建 MCP 服务器」主按钮 + 「导入」outline 钮（项目档空态 = 指引
  去用户档添加）；新增/编辑 Dialog = 表单/JSON 双模式（Tabs 胶囊分段独占
  标题下首行；表单：stdio 命令 + 参数/环境变量多行一行一条，http URL +
  请求头，暴露档 Select，name/type 编辑态锁定；JSON：单条生态形状
  `{ "名字": { …条目… } }` 直编，可改表单未暴露的字段如 timeout，坏 JSON
  不放行切回表单，编辑态改名两模式同拒）；
  导入 Dialog = 粘贴 mcpServers JSON（生态互拷形状）合并、重名覆盖；写路径
  = 用户档整表 mcp.sync / 项目档单项 mcp.override（空 patch = 清除回落），
  引擎校验错回显 destructive 红条，文件级诊断单独「配置诊断」组卡。
  **连接状态点（zcode 绿/红）无数据面**：Host headless，连接状态在 pi 会话
  内部（协议扩展列后续）
- **设置 · 技能页（阶段 4b，MCP 页同骨架）**：单列分区 —— 页头描述随
  作用域切换（用户级：渐进加载说明 + **下一回合生效**（与 MCP 的「新会话
  生效」对照）+ 手放目录提示；项目级：项目名 + 主根路径 + 同名覆盖语义 +
  本页可直接新建项目技能）；工具行 = 作用域 ScopeMenu（级联子菜单，与
  MCP 页同一 useProjectScope）+ 竖分隔线 +「技能 N」+ 搜索胶囊；第二层 =
  SettingsGroup 标题行「已安装 N」+ 右侧刷新/新建；条目行 = size-10 书本图标方块 +
  名称 + 已禁用/手动调用/项目定义/项目覆盖徽标 + 第二行灰字 description
  （title=路径）+ Switch +（用户档或项目定义行：编辑/删除 icon-xs；项目档
  override 存在时重置 icon-xs = inherit 回落）；编辑弹窗 = name（编辑锁）+
  description + 正文等宽 Textarea（回填经 skills.read 单取，list 不带
  body）；空态虚线卡 + 手放目录指引；「配置诊断」组卡同 MCP 页
- **设置侧边栏（2026-11-15 重组，zcode 形态）**：两分组「基础设置 / Agent
  能力」（常规/外观/模型设置/浏览器/电脑操控/键盘快捷键/已归档的聊天 +
  插件/MCP 服务器/技能/命令/钩子），命令占位对应阶段 4 后续座
  （技能已落地 4b）；
  顶部保留标题 + 搜索框（占位）
- **品牌图标 ProviderLogo**（components/，模型菜单等按 providerId 复用）：
  @lobehub/icons 按名导入（sideEffects:false 摇树）—— 单色标（Anthropic/OpenAI/
  Grok/ZAI）走 currentColor 随文字色，彩色用 `.Color` 变体（Gemini/DeepSeek/
  OpenRouter 等，OpenRouter 官方色即荧光绿 #C8FF00 非黑）；自定义 provider =
  黑底首字方标。坑：查找表值类型必须显式 `| undefined`（Record 索引访问默认非
  可空，`if (表值)` 会撞 no-unnecessary-condition；`?? 兜底` 则合法）。
  **坑 2（放进 Button 时被 svg 兜底钉 16px）**：Button 基类
  `[&_svg:not([class*='size-'])]:size-4` 对后代 svg 生效 —— 品牌标尺寸写在
  width/height **属性**上（无 Tailwind size 类），CSS 必压属性，size prop 落在
  按钮里被无声钉成 16px（TodoStrip 折叠钮同坑）；解法 = 本体经
  `[&>svg]:size-[var(--provider-logo-size)]!` 变量 + `!` 钉死（同文件字色
  `text-background!` 打赢 menu item 通配染色的先例），任意值类吃不进动态数字，
  尺寸走 CSS 变量下发
- **通用档位滑杆 StopSlider**（components/，2026-11-10 参考稿 slider-main
  换装）：块状轨道值域选择器，档位模式（stops 吸附 + 键盘相邻档步进 + 选中
  标签加粗）/ 自由模式（无 stops，step 连续滑）两用。视觉规格：25px 轨道
  rounded-[5px] bg-muted + 填充条全圆角 foreground/20 软叠（黑低透明，比轨道
  深一档、亮暗自动成立）+ 拇指 4×19 rounded-[2px] bg-primary、中心 P%−8px
  （ms 负 margin，右缘距填充右缘 6px，顶格不出轨道）+ 31 格刻度直尺 bg-border
  + 档位标签白底（bg-background）压在刻度带上遮刻度、选中 foreground 加粗 /
  其余 muted-foreground；填充 width 与拇指位置 280ms ease-out（磁吸手感）。
  center 对齐模式（坑 12）+ 键盘接管（坑 13）。上下文窗口滑杆
  （ContextWindowSlider）= 它的域适配（100K/200K/400K/1M + formatContext；
  100K 档 2026-11-12 为压缩验证补入）
- **对话流**：message-scroller（吸底/滚到底悬浮钮库自带；Provider 开 `autoScroll`
  才会跟随流式增长，Item **不标 `scrollAnchor`** —— 官方语义是"回合起始行"专用，
  标了会在追加时把该行钉到视口顶且流式不跟随，ChatGPT 式吸底两者都不要）；
  **发送即回底**（主流产品语义）：Provider 包到 Composer 外层，send 时调
  `scrollToEnd()` —— 库的 autoScroll 只在"本来就在底部"时跟随（翻上去看历史
  会释放跟随），发送这个动作本身就是回底意图，翻历史/索引刻度跳转后发送
  照样吸底并恢复跟随；
  对话索引轨道自绘
  （每消息一颗刻度，激活项**自算**：视口顶边压着的消息 + 真实 scrollHeight 口径
  吸底点亮末条 —— 库的 visibility/scrollable 快照挂载后为空且受 content-visibility
  干扰，勿用；点击 scrollToMessage 平滑定位，按 messageId 查表不依赖锚点）；
  索引 hover 阶梯 = 悬停 24px、
  两侧 17/14/10 递减、颜色同步减淡；
  **assistant 元信息行**（UsageLine，2026-11-09）：token 用量/缓存/成本/耗时挂
  正文下的 footer 位，`text-[11px] text-muted-foreground tabular-nums`（时间戳/
  徽标同口径，实色 token），格式 `↑ 41 · ↓ 1.2K · 缓存读 8.2K · $0.0031 · 2.4s`；
  **零值省略**（缓存 0/无定价不显示对应项，"没发生"≠"值为 0"）、数据无则整行
  不渲染（流式态天然没有，随 run.completed 出现）；
  **assistant 正文 Markdown 渲染**（2026-11-10）：Streamdown 封装
  `components/ui/markdown.tsx`（包内样式按 shadcn token 写，自动吃主题；正文
  容器层 text-sm 定基调）。链接 = chrome-accent 实色（此前裸变量已补
  `--color-chrome-accent` 映射）+ **点击 preventDefault 后 window.open** ——
  主进程只有 setWindowOpenHandler 守卫，裸 `<a>` 窗口内导航无人拦会把应用窗口
  带到外链（Electron 特有坑）。lineNumbers/animated/linkSafety 弹窗均关（主流
  聊天产品口径）。**坑**：Tailwind v4 自动扫描不进 node_modules，包内类必须
  `@source '../../../node_modules/streamdown/dist'` 显式声明才生成 CSS。代码等宽
  = JetBrains Mono 随包（可变字重）+ `--font-mono` token（CJK 注释回落鸿蒙）
- **过程行（2026-11-16，zcode 形态）**：工具行 = 图标（**静态**）+ 类别词 +
  主文案（mono text-xs truncate）+ diff 尾标（`+N` 绿 `-M` 红 text-[11px]）+
  状态词 —— 类别词双形（正在读取/已读取…，tool-display.ts），运行态挂
  `.shimmer` 扫光（**全线无旋转 spinner**：图标静态 + 文案扫光，旋转图标
  长期占用渲染资源）；失败 = 行尾「执行失败」destructive 点状下划线 + hover
  Tooltip（原因 line-clamp-3 + 复制钮，shadcn tooltip），整行不变红；思考行
  默认收起单行 + 末行摘要横向滚动（`scroll-fade-x` 渐隐）+「持续了 Xs」；
  bash 运行中 = 定高两行尾行 + `.progress-sweep` 扫光细条（globals.css，
  reduced-motion 降级）；折叠体动画 = grid 轨道 `0fr↔1fr`（免高度测量，
  此前 Base UI 首测高度被 content-visibility 10rem 估值污染 → 闪烁/高度
  跳变），间距用 padding 不用 margin（margin 不随轨道裁切）
- **滚动渐隐** `.scroll-fade-b/-y/-x`（mask 两端 24px 渐变，ChatGPT 同款不硬截；
  base-nova 组件引用了这组类，已补定义）
- **悬停提示 Hint**（components/Hint.tsx，2026-11-16 全量换装）：原生 `title`
  属性全 app 禁用，统一走本件（shadcn tooltip 四件套的单组件包装，自带
  Provider 零样板；`<Hint tip="文案" side>…</Hint>`）。文案纪律 = 简洁准确：
  图标钮给名词（「运行时控制台」「刷新模型目录」），内容件给一句话/全文
  （截断路径给全路径、Toggle 给 API id）；rich 内容（多行 + 交互钮）不用本件、
  直接 tooltip 原语（tool.tsx 失败原因同款）。三处例外有因：对话索引刻度
  （3px 目标弹气泡遮相邻刻度，删 title 留 aria-label）、ProjectPicker 内嵌
  X 圆徽（嵌在 popover 触发钮里不能再包 trigger，aria-label 承载）、
  ConversationIndex 同前。组件 `title` prop（SectionHeader/SettingsRow 等
  分组标题文字）不是 tooltip，不在换装范围
- **危险确认弹窗**（FullAccessConfirm，2026-11-11 照用户参考图）：alert-dialog +
  checkbox 经 base-nova registry 安装；结构 = 警告三角图标 + 标题「要启用完全访问
  吗？」/ 说明 / 权限项卡片（`rounded-xl bg-muted` 内每行 图标 size-5 muted + 名称
  font-medium + 描述 text-xs，`Separator bg-border/60` 分隔）/ 风险提示 text-xs
  muted / 勾选门控行（label 包 Checkbox，Base UI 的 checkbox 根是 button——HTML
  labelable，label 点击自然联动）/ footer 取消 outline + 确认 **destructive 红**
  （危险动作闸门语境，与权限触发钮 warning 琥珀 = 两个语境并存）；勾选态
  `useEffect(open) → false` 每次打开重置（风险确认不跨次残留）。权限项只列已落地
  能力（文件 / 终端），network 工具落地后补第三行。选「完全访问」先过此闸门
  （权限菜单与审批面板的档位下拉两入口同规，2026-11-16 定调 —— 曾只有
  权限菜单过闸、审批路径直切并记项目默认绕过；已是 auto 再点不弹）；
  **Base UI 的 AlertDialogAction 是裸 Button 不自动关窗**，
  确认回调里手动 `onOpenChange(false)`

## 滚动条

globals.css webkit 定制（全应用生效）：轨道 13px、滑块两侧 4px 透明 border
（background-clip: padding-box）→ 可视滑块 5px、离边有缝、命中区整条；黑 18%
软叠、hover 30%。**不滚动即隐藏**：滑块默认全透明，滚动中显形 ——
hooks/use-scrollbar-auto-hide（App 挂载一次）在 document 捕获 scroll（滚轮/
键盘/拖拽滑块/程序化 scrollTo 都派发）给滚动容器挂 data-scrolling，静默 600ms
摘除；悬停滑块命中区（整条 13px）也显形并加深 —— 隐藏态下唯一的常驻显形
入口，否则滑块抓不到。经典条占位不随显隐变化（透明 ≠ overlay），
scrollbar-gutter-stable 的防抖语义不受影响。
**坑**：Tailwind v4.1 原生含 scrollbar-thin/none 及 `data-autoscrolling:scrollbar-
thumb-transparent` 一类标准属性工具类 —— 非-auto 的 scrollbar-width/color 会让
Chromium 绕过 webkit 定制走原生条（自动隐藏随 OS 设置漂移，不受本应用显隐
控制；deepseek-harness 即此路线，外观与显隐都交给引擎）。message-scroller
视口按 data-slot 在 globals.css 拉回 auto，code-block 不用 scrollbar-thin；
新滚动容器踩到同问题照抄该规则。

## 图标（Tabler 转正）

`@tabler/icons-react`；**用前 node require 验证存在**（IconCursorMouse/IconAppWindow
等不存在）；active 态用 Filled 实心变体，成对选型（smart-home 无 Filled 已被否）。
lucide 仅存于 shadcn 原语内部小图标，不动。

## 技术坑（写布局代码前过一遍）

1. **tailwind-merge 变体坑**：覆写带变体的类必须同变体成对写（`px-2
   has-[>svg]:px-2`），裸工具类压不住 xs/icon-xs 自带的 `has-[>svg]:px-1.5`；
   input-group 的聚焦 ring（`has-[[data-slot=input-group-control]:focus-visible]`
   一族）同样要同变体反制（ChatComposer 输入区聚焦无反馈即此写法）；
   **DialogContent 宽度同坑**：其自带 `sm:max-w-sm`（base-nova 从 md 收小），
   调用处裸写 `max-w-xl`/`max-w-lg` 桌面端压不住（全部被钉在 384px，嵌套弹窗
   出现"两层等宽"），必须写 `sm:max-w-*` 同变体反制；
   **高度溢出的分工**（2026-11-15 MCP 新建表单超视口、保存钮够不着实测）：
   组件本体限高 `max-h-[calc(100%-2rem)]` + 纵向 flex；长内容弹窗在调用处给
   中段包 `min-h-0 flex-1 overflow-y-auto` 滚动区，头/尾钉住，配 `-mx-4
   px-4` 全出血让滚动条贴右缘（头/尾在滚动区外，轨道不穿圆角、不截 footer
   通栏；首版整弹窗滚动即栽此坑）；本体 overflow-y-auto 仅作未包滚动区时的兜底
2. base-ui 触发器无 asChild → `render={<Button/>}` prop
3. react-resizable-panels v4：`orientation` 非 direction；Panel 两层结构 className
   落内层（style prop 亦落内层，可覆写 overflow）；无 defaultCollapsed 入参
   （挂载后 imperative collapse 一次）；**尺寸由内联 flexGrow 承载**（布局注册后
   flexBasis 恒 0、仅挂载兜底渲染一次 —— 过渡 flex-basis 不动，踩过），折叠/
   展开过渡在 Group 原语对 `[data-panel]` 的 flex-grow 做 CSS 过渡，挂载后等
   两轮宏任务再放行（flexBasis→flexGrow 交接否则会放出生长动画；**勿用 rAF
   门控**：页面不可见时 rAF 停发、门控卡死过渡整体失效）；拖拽中以库权威状态
   `:has([data-separator=active])` 杀过渡（同 use-divider-glow 的观察源）——
   库逐帧写内联尺寸，不杀会把跟手拖成 200ms 延迟；**onLayoutChanged 时面板
   getSize()/onResize 都滞后一步**（键盘步进实测 300→360 时仍回旧值），要落盘
   取回调首个 layout 参数（变更后百分比）换算像素，别读面板现状
   （此坑是 content-sidebar 记忆首版踩的，侧栏现已退出 RRP，坑对 HomeMain
   及后续 RRP 分屏的持久化仍有效）；**groupResizeBehavior="preserve-pixel-size"
   在 4.18.1 无效**（裸库探针：窗口缩放按比例跟动，与未设置无异）
4. InputGroup 纵向布局 items-center：全宽子元素必须 `w-full`（否则缩成内容宽居中）
5. JSX 属性值禁直引号嵌套（`value="仅在使用"关闭"快捷键"` 炸解析），中文弯引号无碍
6. 对话索引激活项自算，不用库的 visibility/scrollable 快照（见上）
7. 视觉模型自由估计像素会前后矛盾 —— 对标任务走拼图对比闭环（下节）
8. **base-ui Slider inset 模式坐标系**：`thumbAlignment="edge-client-only"` 下
   滑块中心行程与 Indicator 百分比全按 **Control 宽度**计算但渲染在 Track 里 ——
   Track 用负 margin 出血（比 Control 宽）会让填充条偏出滑块中心（档位左端露
   蓝色细条）、端点定位点被裁半；Control 的 overflow-hidden 还会削平高于轨道的
   圆钮。轨道宽 = Control 宽、Control 不裁切（见 components/ui/slider.tsx 注释）
9. **Tailwind v4 的 scale-*/rotate-* 走独立属性**：不是 transform —— 自写
   `transition-[...]` 清单若只列 transform，缩放瞬跳不过渡（`transition-transform`
   工具类 v4 已内置 transform,translate,scale,rotate，别用任意值清单"精简"它）；
   思考力度滑杆定位点的涟漪过渡即 `transition-[background-color,scale]`
10. **调用处任意变体覆写会压死原语内的 variant 类**：`[&_[data-slot=…]]:scale-100`
   生成 `.类 [data-slot=…]>span`（类+属性+元素，0,2,1），特异性高于元素自身的
   `hover:scale-150`（类+伪类，0,2,0）—— 调用处一旦给该属性定基态，原语里的
   hover 反馈就永远不触发（思考力度定位点 hover 不放大即此，bff92d8 的涟漪
   覆写引入）。教训：同一属性的各级状态（基态/激活/hover）要么全在原语、要么
   全在调用处，别劈开 —— 定位点 scale 体系（100/125/150）已全数收归
   ThinkingSlider，原语 marks 不再带任何外观（含 hover）。同特异性对赌生成
   顺序也不行：激活点 hover 用 `span[data-active]:hover`（0,4,1）显式压过
   `scale-125`
11. **base-ui Slider 的方向变体必须写 `data-[orientation=…]:`**：Base UI 渲染的
   属性是 data-orientation="horizontal"（state key 直出），Tailwind 的
   `data-horizontal:` 快捷变体编译成属性**存在性**选择器 `[data-horizontal]`，
   永远不命中 —— 轨道 `data-horizontal:h-2` 整条失效、高度塌 0 轨道隐身
   （2026-11-10 上下文窗口滑杆改走 ui/slider 原语时踩响；ThinkingSlider 当时
   靠自覆写 `h-5` 掩埋了原语的坑）。验证特异性对赌时留意：调用处
   `[data-slot=slider-track]]:h-5` 与原语 `data-[orientation=horizontal]:h-2`
   同为 0,2,0，构建产物中 h-5 规则靠后取胜（当前成立，升级 Tailwind 后若轨道
   高度异常先查这里）
12. **base-ui Slider inset（edge*）模式 Indicator ≠ value%**：`thumbAlignment`
   为 edge / edge-client-only 时（inset=true），填充条宽度不是 valueToPercent
   直出，而是**拇指中心位置的实测百分比**（SliderThumb.getInsetPosition：
   `halfThumb + (W−thumbW)·P`，range 滑杆"填充 = 首末拇指中心之间"的语义）——
   顶格恒差半个拇指宽（2026-11-10 用户发现上下文窗口滑杆"1M 没填满"差 2px
   的根因；拇指的视觉 margin 不参与该计算，实测只量拇指宽度）。center 模式
   （非 inset）Indicator=value% 直出、拇指中心恰在 P% 且不走实测管线 —— 填充
    需要精确到轨道边缘的滑杆用 center。ui/slider 已加 thumbAlignment 透传
    （默认 edge-client-only 保 ThinkingSlider 既有行为；marks 定位公式
    `calc(thumbSizePx/2 + …)` 按 inset 几何推导 —— 两端各缩半个拇指宽 =
    拇指中心停靠行程极限，调用处覆写拇指尺寸后必须以 thumbSizePx 下发
    真实宽（思考力度拇指 size-6 → 24），否则端点定位点落在行程外贴住
    轨道圆角端部；center 模式下该公式同样会偏）
13. **base-ui Slider 键盘接管口（不等距档位必须用）**：Thumb 接受 onKeyDown
   （落在内部 input 上）；mergeProps 让用户 handler **先于**内置步进执行，
   且内置 keydown 开头就检查 `event.defaultPrevented` —— 用户先
   `preventDefault()`（同时拦掉原生 range 步进）即可整体接管方向键。不等距
   档位（如 200K/200K/600K）下内置均匀 step 步进会在窄档卡死（步进后又被
   吸附回原档），StopSlider 的相邻档步进即靠此口（ui/slider 的
   thumbOnKeyDown 透传）
14. **registry 的裸 `data-horizontal:`/`data-vertical:` 变体随附即坏**：
   base-ui 只设 `data-orientation`，这两个变体编译成 `[data-horizontal]`
   存在式选择器**永远不匹配**（2026-11-15 MCP 弹窗 Tabs 渲染成左右分栏
   实测；separator 同款写法，细线曾因此无尺寸不可见）。已修 tabs/separator
   两文件本体为 `data-[orientation=*]` 显式值匹配（tabs 自渲染属性，
   separator 补自渲染）——**新装 registry 组件凡见裸 data-值 变体先核
   base-ui 实际设的属性名**

## 视觉对标方法论（"照某图实现"类任务）

1. 实拍我们的界面（`tab.screenshot({ clip })`）+ 参考稿转 dataURL，在应用标签里盖
   覆盖层拼**上下对比图**，再截图
2. 交视觉模型做**纯视觉 diff**（几何/灰度/间距，不复述图里文字），按影响力排序
3. 改 → 重新拼图复检 → 收敛（"轻重症"差异先修，像素级放过）
4. **异形/结构类需求先按最朴素结构复刻**（一个 div 叠另一个 div 就直说），
   别过度解读成浮层/定位/异形切割；问清"谁叠在谁上面、圆角在哪几角"

## 浏览器验证环境（IAB）坑

- HMR 后页面可能白屏：`tab.reload()` + 补 `window.cogent` 桩（方法清单以 env.d.ts
  桥接口为准逐方法补全，别照抄本文件旧数 —— 2026-11-12 实测缺 getStatus/getSettings
  即白屏）+ 注入 module `<script src="/src/main.tsx?t=...">`
  重挂；动态 import() 在页面桥不可用
- 后台标签冻结渲染：CSS 过渡停在起点（读 computed opacity 是假值，读类名或掐
  transition）、scroll 事件不派发（用 dispatchEvent(new Event('scroll')) 合成驱动）、
  smooth 滚动不动（用 instant + 合成事件）、截图出叠影/超时（重试或以 DOM 为准）
- React onMouseEnter 可用合成 `mouseover`（带 relatedTarget）驱动验证
- click 后等 300ms+ 再读 DOM（同步读会拿到提交前的旧值）
