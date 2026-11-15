# UI 组件风格切换：Luma → Nova（base-nova）

> 2026-11-15 立项。用户指令「把项目的 shadcn 所有组件换成 Nova 风格」，
> 确认推翻 Luma 方针（2026-11-08 定调 + 2026-11-15 混装清理，记录在
> 约定.md §3，随本次实施同步改写）。切换模式 = 官方 **Merge 智能合并**
> （用户选定：保留本地定制，逐组件合入上游）。

## 目标

- `components/ui/` 的 **23 个 registry 组件** base-luma → base-nova
  （Nova = shadcn 3.x 默认风格：紧凑方正，按钮 rounded-lg/h-8/更紧 padding；
  Luma = 圆润，rounded-4xl/h-9）
- **保留 base-ui 原语**（不换 radix）；保留全部本地定制；保留项目自定义主题
  （薄荷绿 chrome、实色 token、打包字体——preset 不动色板/字体）
- components.json 切到新 schema：style: `base-nova`（命名法对齐 zcode 的
  `radix-mira`）

## 对比结论（规则 7）

- **官方流程（权威依据）**：shadcn-ui/ui 仓 `skills/shadcn/`（官方 AI skill，
  本次已下载研读）。「Switching presets」之 Merge =
  `init --preset base-nova --force --no-reinstall`（只更新 config+CSS，
  不重装组件）→ `info` 列已装组件 → 逐组件 `add <c> --diff` 智能合并
  （SKILL.md「Updating Components」）。skill 明令：禁止手抓 GitHub 源、
  `--overwrite` 须用户显式批准
- **registry 事实**（已逐个 HTTP 200 验证）：base-nova 覆盖全部 23 件；
  `reasoning` / `tool` / `run-trace` 在 base-luma 与 base-nova **均无**
  （本地组合件，官方 pattern 配方，底层 trace/collapsible/code-block 换新后
  自动继承）；`markdown.tsx` 本地 Streamdown 封装，不动
- **reference 对照**：zcode = shadcn 生产用户（packages/ui 的 components.json
  `style: "radix-mira"`，radix 原语）——style 进 components.json 的先例；
  pi / deepseek-harness 无 UI 组件库
- **本地定制清单**（merge 依据；diff 口径 = `--strip-trailing-cr` 本地 vs
  base-luma registry 源）：
  slider 93（thumbAlignment/thumbOnKeyDown 透传，UI布局坑 12/13）、
  dropdown-menu 48（item warning 变体+排除链，坑 2）、select 44、
  context-menu 37、resizable 28、code-block 33（手工修正：lucide 替换
  IconPlaceholder 等）、dialog 19、message-scroller 15、checkbox 14、
  trace 13、input-group 10、input 9、alert-dialog 6、
  collapsible/item/popover/separator/switch/toggle 各 4、
  bubble/button/message/textarea 0

## 设计（步骤）

1. `npx shadcn@latest init --preset base-nova --force --no-reinstall -y`
   （顺带修正 CLI 对旧 schema 的误识别 base:radix → base:base）
2. **git diff 守卫 globals.css**：恢复被动变更的自定义 token
   （--placeholder / --shell-radius / --warning / --empty-hint / 薄荷绿系列 /
   字体栈 / @source streamdown / 滚动条与渐隐段）；标准 token 与 Nova 默认的
   差异逐个判断——无设计理由的跟 Nova 默认（如 --radius）
3. 逐组件 merge：Δ=0 的 4 件（bubble/button/message/textarea）直接放行覆写；
   其余 19 件 `add <c> --diff` 逐文件人工合入（上游 Nova 改动 + 本地定制）
4. typecheck 抓组合件适配（reasoning/tool/run-trace 对新 trace 导出面）
5. 调用处复核：UI布局.md 记录的 luma 特有反制在新风格下是否仍必要
   （input-group rounded-3xl/聚焦 ring 反制、DialogContent sm:max-w 同变体
   反制等）
6. 四关全绿（看完整输出）+ 用户 dev 手动冒烟
   （输入区/菜单/弹窗/滑杆/消息流/设置页）

## 边界

- 不换原语库、不动依赖版本；不动色板/字体/滚动条/渐隐等自定义 CSS
- 不新增组件；纯风格切换，无功能变更
- 回退 = git（工作区当前 clean；切换前打可辨识状态）

## 验收

- components.json style=base-nova 且 `shadcn info` 报 base=base
- 23 件与 base-nova registry 源 diff 仅剩已知定制；无 luma 特征类残留
  （rounded-4xl 等按组件抽样核对）
- slider 透传 / dropdown warning 变体 / code-block 修正逐项在位
- lint / typecheck / build / npm test 全绿
- 用户观感验收通过

## 文档同步（随代码同批）

- 约定.md §3 风格段：Luma → Nova 全段改写（registry 路径
  `r/styles/base-nova/`；混装清理历史句就地改述）
- UI布局.md：base-luma 字样与 luma 特有坑核对更新；圆角阶梯复核
  （Nova 自带更小圆角，视觉配方中手写圆角类与组件默认的搭配需过一遍）
- 模块页「验收：」句核对（消息呈现 / 审批与权限引用组件行为处）

## 实施结果（2026-11-15，当日完成）

- **CLI 适配偏差**：`init --preset` 在本项目（electron-vite 非受支持框架）
  折在框架检测；改走 skill 允许的 scratch 目录对齐法 —— 临时 init 一个
  nova+base 的 vite 项目取官方 components.json / 主题 token 基准，主项目
  手工对齐。命名 preset 不带原语前缀（`--preset nova --base base`），
  纯 `base-nova` 不是合法 preset 名
- **token 对比结论**：nova 默认 `--radius` 与本项目同为 0.625rem；标准
  neutral 色板逐项相同 → **globals.css 零改动**（半径阶保留加法式：若采纳
  nova 比例阶 `3xl=*2.2`，调用处大卡 rounded-3xl 会从 24px 缩成 22px；
  `--radius-md` 两种算法同为 8px，nova 组件无冲突）
- **合并方式**：本地文件 = luma + 安装修正（IconPlaceholder→lucide、剥
  use client/marker 类）已完备，故以「luma→nova diff 移植到本地」完成
  23 件（3 件 lumaΔnova=0 未动：collapsible/resizable/separator）；toggle
  首轮漏网由验收 diff 复检抓回
- **顺带修复**：input.tsx 是混装清理漏网的 new-york 残留（裸 `<input>` +
  rounded-md/shadow-xs），已整体换 base-nova 版（InputPrimitive）
- **slider 联动**：nova 拇指 h-4 w-6 → size-3，marks 定位公式常数同步
  12px/24px → 6px/12px（公式与拇指尺寸耦合，见 UI布局 坑 12）
- **弹窗限高滚动**（2026-11-15 用户报 MCP 弹窗超长溢出 + 滚动条右侧观感
  两轮返修）：dialog.tsx 定制 +1 —— DialogContent 限高 + 纵向 flex + 兜底
  overflow-y-auto；长内容弹窗调用处包中段滚动区（头/尾钉住，-mx-4 px-4
  全出血让滚动条贴右缘 —— 头尾在外，不穿圆角、不截 footer 通栏）；
  tabs 组件 registry add 新装（表单/JSON 胶囊分段用其原生形态）
- **registry 裸 data-值 变体随附即坏**（2026-11-15 MCP 弹窗 Tabs 渲染成
  左右分栏实测）：base-ui 只设 `data-orientation`，`data-horizontal:`/
  `data-vertical:` 编译成 `[data-horizontal]` 存在式选择器永不匹配。
  tabs（新装）与 separator（存量，细线曾因此无尺寸不可见）两文件本体
  改 `data-[orientation=*]` 值匹配，separator 补自渲染属性 —— 坑 14
  记 UI布局.md，新装 registry 组件照查
- **验收**：components.json style=base-nova、`shadcn info` base=base ✓；
  23 件 vs nova 源仅剩已知定制、无 luma 特征类残留 ✓；warning 变体/
  slider 透传/ code-block 修正在位 ✓；lint / typecheck / build / npm test
  （129 例）全绿 ✓；**用户 dev 冒烟观感验收待执行**
