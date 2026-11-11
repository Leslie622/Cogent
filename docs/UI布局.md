# UI 布局与视觉配方（布局阶段收官总结，AI 操作手册）

> 布局阶段（UI 件 1–7，2026-11-06 ~ 11-08）的定稿配方与技术坑汇总。
> 逐件的实现过程/验收迭代考古看 [路线.md](路线.md)；本文只放"现在怎么写"。
> 区域代号见 [AGENTS.md](../AGENTS.md)「区域代号」；改布局前先读本文。

## 布局结构

```
shell ─┬─ header            40px 拖拽区（AppHeader：折叠开关/菜单/窗口控制）
       └─ body
          ├─ app-sidebar   50px 固定图标栏（AppSidebar：路由钮 + 设置下拉）
          └─ content       白卡（rounded-tl --shell-radius + border-l 自描边 + 紧投影）
             ├─ content-sidebar   240–360px 可拖可折叠（各视图内容在 AppShell 按 view 挂）
             └─ content-main
                ├─ home      HomeMain = [主要区 HomeChat | 标签页区 HomeTabs]
                │            （标签页区 280–520px 可拖折叠、默认收起，动作全空位）
                └─ settings  SettingsMain = 按分区挂内容（常规已落地，其余占位）
```

- 分栏统一 react-resizable-panels v4 + GlowResizeHandle（1px 线 + 把手 + 拖拽光带）：
  拖过下限折叠成 0，折叠后把手贴缘即展开抓取点；点钮折叠 = usePanelRef
  imperative collapse/expand，状态走 onResize 同源同步（AppHeader/HomeChat 两处开关同手法）
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
  行外，hover 已断），折叠箭头**不挂** focus-within（焦点残留会赖着不灭）
- **输入区**（HomeChat.ChatComposer）：白卡 rounded-3xl border-foreground/10，
  无投影、聚焦无任何反馈（has-[focus-visible] 反制掉组件默认 ring）；上方项目
  会话信息区 mx-5 h-9 rounded-t-xl bg-muted —— **新聊天限定**（无项目 = "选择项目"
  单钮；项目内发起 = 回显项目/本地/main；已有对话的会话不显示）。项目胶囊
  （ProjectPicker）已选态 hover：左侧文件夹图标**原位**交叉渐变成灰底白 X 圆徽
  （16px 定宽 span 内两图标 absolute 叠放换透明度，同侧栏文件夹开/合手法）——
  X 是嵌在触发钮里的 role=button span（button 嵌 button 非法），pointerdown +
  click 双路 stopPropagation 拦 base-ui 触发器，点 X = 解绑项目（删绑定空
  脚手架会话防串归属）而非弹菜单；胶囊旁另起独立 X 钮的方案被否
  （2026-11-10 用户定稿：融进胶囊，不是两个按钮）
- **审批卡**（features/home/ApprovalCard.tsx，2026-11-11 工具批次 2）：两态 ——
  pending = AI Elements Confirmation 配方（base-luma `item` 原语 ItemMedia/
  ItemContent/ItemActions + 允许/拒绝双钮，媒体位 warning 盾 IconShieldFilled）；
  终态 = TraceLine 置灰单行（与工具卡 blocked 同族，approved 盾勾 / denied 禁止
  / cancelled 停止，尾标已允许/已拒绝/已取消）—— run 终态替换保留（用户裁决
  痕迹，转录无对应物）。registry 无 confirmation 项：`add item`（连带 separator）
  照官方配方组合即正解
- **「完全访问」钮两态**（ChatComposer，2026-11-11 接线）：关闭 = warning 琥珀
  ghost（原警示态）；开启 = `rounded-full bg-destructive/10 text-destructive`
  （浅红胶囊底 —— bg 透明度允许、文字实色，全局文字色纪律）+ aria-label 随态
  换（关闭/开启完全访问）；new 态 toggle 写 home store 暂存位（不持久化，
  新会话永远回 ask 缺省），chat 态走 session.setPermission
- **设置页**：SettingsParts 拼装 —— SettingsGroup（组标题 + rounded-xl 描边卡 +
  divide-y 行分隔）+ SettingsRow（左标题/描述右控件）；控件四款：Switch（选中
  黑底）/ SelectControl（描边圆角 + 值 + 箭头，静态空位）/ SecondaryAction
  （灰底小钮）/ 路径行（mono 截断 + 更改钮）
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
- **品牌图标 ProviderLogo**（components/，模型菜单等按 providerId 复用）：
  @lobehub/icons 按名导入（sideEffects:false 摇树）—— 单色标（Anthropic/OpenAI/
  Grok/ZAI）走 currentColor 随文字色，彩色用 `.Color` 变体（Gemini/DeepSeek/
  OpenRouter 等，OpenRouter 官方色即荧光绿 #C8FF00 非黑）；自定义 provider =
  黑底首字方标。坑：查找表值类型必须显式 `| undefined`（Record 索引访问默认非
  可空，`if (表值)` 会撞 no-unnecessary-condition；`?? 兜底` 则合法）
- **通用档位滑杆 StopSlider**（components/，2026-11-10 参考稿 slider-main
  换装）：块状轨道值域选择器，档位模式（stops 吸附 + 键盘相邻档步进 + 选中
  标签加粗）/ 自由模式（无 stops，step 连续滑）两用。视觉规格：25px 轨道
  rounded-[5px] bg-muted + 填充条全圆角 foreground/20 软叠（黑低透明，比轨道
  深一档、亮暗自动成立）+ 拇指 4×19 rounded-[2px] bg-primary、中心 P%−8px
  （ms 负 margin，右缘距填充右缘 6px，顶格不出轨道）+ 31 格刻度直尺 bg-border
  + 档位标签白底（bg-background）压在刻度带上遮刻度、选中 foreground 加粗 /
  其余 muted-foreground；填充 width 与拇指位置 280ms ease-out（磁吸手感）。
  center 对齐模式（坑 12）+ 键盘接管（坑 13）。上下文窗口滑杆
  （ContextWindowSlider）= 它的域适配（200K/400K/1M + formatContext）
- **对话流**：message-scroller（吸底/滚到底悬浮钮库自带；Provider 开 `autoScroll`
  才会跟随流式增长，Item **不标 `scrollAnchor`** —— 官方语义是"回合起始行"专用，
  标了会在追加时把该行钉到视口顶且流式不跟随，ChatGPT 式吸底两者都不要）；
  **发送即回底**（主流产品语义）：Provider 包到 Composer 外层，send 时调
  `scrollToEnd()` —— 库的 autoScroll 只在"本来就在底部"时跟随（翻上去看历史
  会释放跟随），发送这个动作本身就是回底意图，翻历史/索引刻度跳转后发送
  照样吸底并恢复跟随；
  对话索引轨道手搓
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
- **滚动渐隐** `.scroll-fade-b/-y/-x`（mask 两端 24px 渐变，ChatGPT 同款不硬截；
  base-luma 组件引用了这组类，已补定义）

## 滚动条

globals.css webkit 定制（全应用生效）：轨道 13px、滑块两侧 4px 透明 border
（background-clip: padding-box）→ 可视滑块 5px、离边有缝、命中区整条；黑 18%
软叠、hover 30%。
**坑**：Tailwind v4.1 原生含 scrollbar-thin/none 及 `data-autoscrolling:scrollbar-
thumb-transparent` 一类标准属性工具类 —— 非-auto 的 scrollbar-width/color 会让
Chromium 绕过 webkit 定制走原生 overlay 条（Win11 自动隐藏 = "看不见滚动条"）。
message-scroller 视口已按 data-slot 在 globals.css 拉回 auto；新滚动容器踩到同问题
照抄该规则。

## 图标（Tabler 转正）

`@tabler/icons-react`；**用前 node require 验证存在**（IconCursorMouse/IconAppWindow
等不存在）；active 态用 Filled 实心变体，成对选型（smart-home 无 Filled 已被否）。
lucide 仅存于 shadcn 原语内部小图标，不动。

## 技术坑（写布局代码前过一遍）

1. **tailwind-merge 变体坑**：覆写带变体的类必须同变体成对写（`px-2
   has-[>svg]:px-2`），裸工具类压不住 xs/icon-xs 自带的 `has-[>svg]:px-1.5`；
   input-group 默认 rounded-3xl/聚焦 ring 用 `has-data-[align=...]`/`has-[[...]:focus-visible]`
   同变体反制；**DialogContent 宽度同坑**：其自带 `sm:max-w-md`，调用处裸写
   `max-w-xl`/`max-w-lg` 桌面端压不住（全部被钉在 448px，嵌套弹窗出现"两层等宽"），
   必须写 `sm:max-w-*` 同变体反制
2. base-ui 触发器无 asChild → `render={<Button/>}` prop
3. react-resizable-panels v4：`orientation` 非 direction；Panel 两层结构 className
   落内层（style prop 亦落内层，可覆写 overflow）；无 defaultCollapsed 入参
   （挂载后 imperative collapse 一次）；**尺寸由内联 flexGrow 承载**（布局注册后
   flexBasis 恒 0、仅挂载兜底渲染一次 —— 过渡 flex-basis 不动，踩过），折叠/
   展开过渡在 Group 原语对 `[data-panel]` 的 flex-grow 做 CSS 过渡，挂载后等
   两轮宏任务再放行（flexBasis→flexGrow 交接否则会放出生长动画；**勿用 rAF
   门控**：页面不可见时 rAF 停发、门控卡死过渡整体失效）；拖拽中以库权威状态
   `:has([data-separator=active])` 杀过渡（同 use-divider-glow 的观察源）——
   库逐帧写内联尺寸，不杀会把跟手拖成 200ms 延迟
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
   `calc(12px + …)` 按 inset 几何推导，center 模式下会偏）
13. **base-ui Slider 键盘接管口（不等距档位必须用）**：Thumb 接受 onKeyDown
   （落在内部 input 上）；mergeProps 让用户 handler **先于**内置步进执行，
   且内置 keydown 开头就检查 `event.defaultPrevented` —— 用户先
   `preventDefault()`（同时拦掉原生 range 步进）即可整体接管方向键。不等距
   档位（如 200K/200K/600K）下内置均匀 step 步进会在窄档卡死（步进后又被
   吸附回原档），StopSlider 的相邻档步进即靠此口（ui/slider 的
   thumbOnKeyDown 透传）

## 视觉对标方法论（"照某图实现"类任务）

1. 实拍我们的界面（`tab.screenshot({ clip })`）+ 参考稿转 dataURL，在应用标签里盖
   覆盖层拼**上下对比图**，再截图
2. 交视觉模型做**纯视觉 diff**（几何/灰度/间距，不复述图里文字），按影响力排序
3. 改 → 重新拼图复检 → 收敛（"轻重症"差异先修，像素级放过）
4. **异形/结构类需求先按最朴素结构复刻**（一个 div 叠另一个 div 就直说），
   别过度解读成浮层/定位/异形切割；问清"谁叠在谁上面、圆角在哪几角"

## 浏览器验证环境（IAB）坑

- HMR 后页面可能白屏：`tab.reload()` + 补 `window.cogent` 桩（9 个方法：onWindowState/
  minimizeWindow/toggleMaximizeWindow/closeWindow/onEngineEvent/engineRequest/
  getCustomProviders/setCustomProviders/listApiKeys）+ 注入 module `<script src="/src/main.tsx?t=...">`
  重挂；动态 import() 在页面桥不可用
- 后台标签冻结渲染：CSS 过渡停在起点（读 computed opacity 是假值，读类名或掐
  transition）、scroll 事件不派发（用 dispatchEvent(new Event('scroll')) 合成驱动）、
  smooth 滚动不动（用 instant + 合成事件）、截图出叠影/超时（重试或以 DOM 为准）
- React onMouseEnter 可用合成 `mouseover`（带 relatedTarget）驱动验证
- click 后等 300ms+ 再读 DOM（同步读会拿到提交前的旧值）
