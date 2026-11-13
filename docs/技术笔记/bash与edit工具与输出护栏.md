# bash / edit 工具与输出护栏 —— 批次 3（计划/归档/pi借鉴.md §3）

> 2026-11-11 落地。上游参照 = pi-coding-agent `core/tools/`（MIT）：
> bash.ts(476) / edit.ts(221) / edit-diff.ts(745) / truncate.ts(302) /
> output-accumulator.ts(257) / file-mutation-queue.ts / utils/shell.ts /
> utils/child-process.ts / ls.ts(175) / find.ts(359) / grep.ts(337)。
> 搬运原则见 计划/归档/pi借鉴.md §0：**算法照搬，接线照 Cogent**。

## 0. 批次全景（六步全落地，tools-smoke 39 项全过）

| 步 | 交付 | Cogent 侧新增文件 |
| --- | --- | --- |
| 3.1 输出护栏 | truncate 三件套（truncate / output-accumulator / output-files），read/grep/glob 上限迁移统一截断器 | `tools/truncate.ts` `tools/output-accumulator.ts` `tools/output-files.ts` |
| 3.2 并发写队列 | withFileMutationQueue，write 落盘段入队 | `tools/file-mutation-queue.ts` |
| 3.3 edit 工具 | 精确替换 + CRLF 偏移映射 + 模糊匹配 + 窗口化 diff；diff 进协议（D4）双路径投影 | `tools/edit.ts` `tools/edit-diff.ts` |
| 3.4 bash 工具 | D2 单工具平台路由 + killProcessTree + 超时 + OutputAccumulator + tool.progress 流式（D5） | `tools/bash.ts` `tools/shell.ts` |
| 3.5 UI 与权限 | 工具卡 diff 块 / bash 直播尾行 / 自主模式第四档（D6） | renderer chat store / tool.tsx / PermissionMenu / 协议 PermissionMode+autonomous |
| 3.6 批次 1 加固 | walk 尊重 .gitignore（ignore 包 + 嵌套仓边界）/ grep context / ls 工具 / 文件级搜索 bug 修复 | `tools/walk.ts` 重写 `tools/ls.ts`；`diff`+`ignore` 两依赖 |

## 1. 输出护栏：为什么是"三件套"而不是一个 cap 函数

**上游怎么做**：`truncate.ts` 是纯函数层 —— `truncateHead`（文件读：保头部，续读靠
offset）/ `truncateTail`（命令输出：错误与结果都在末尾）/ `truncateLine`（grep 单行
500 字符 + `[truncated]` 标注）。双上限（行数 2000 / 字节 50KB）独立生效先到先停，
**从不返回半行**（tail 的单行超限例外：保行尾字节段，命令输出的长行是数据不是代码）。
`TruncationResult` 携带全量元数据（totalLines/totalBytes/truncatedBy/outputLines），
调用方据此生成"用 offset=N 续读"的可行动提示。`OutputAccumulator` 是流式版：滚动
窗口只留尾部 2×maxBytes，超限自动转存临时文件（`output-files.ts` 收口：0o600 + wx
标志防符号链接抢占），全文可回看。

**我们怎么做**：原样搬运（算法逐行对齐），read/grep/glob 的零散上限迁过来：
read 字节上限取 64_000（与旧字符上限同数值 —— 字节口径 ≥ 字符口径，只收紧不放浪）；
grep 单行 slice(0,300) 静默切 → truncateLine 500 + 显式标注（模型知道行被切过）；
grep/glob 各补 30KB 总量封顶（旧实现条数有上限但单条长度无界）。bash 流式输出走
accumulator（首个消费者）。

**为什么不同**：没有不同 —— 这一层是纯逻辑，跨进程拓扑无感，是"算法照搬"的
教科书案例。Cogent 侧唯一差异：上游 `output-guard.ts` 在素材清单里写错了名字，
实际三件 = truncate + accumulator + output-files（计划 §1 已勘误）。

## 2. 并发写队列：pi 并行执行同批工具的直接后果

**上游怎么做**：`withFileMutationQueue(path, fn)` 按 **realpath** 键把同文件的写
变更串成 Promise 链（符号链接归一；目标不存在退回 resolve 路径 —— 首写创建文件
后，后续写经 realpath 命中同一条队）；不同文件不互斥。`registrationQueue` 把
"查键-接链"的注册段本身串行，防并发注册在 Map 读写上交错插队。

**我们怎么做**：write.ts / edit.ts 的**落盘段整段入队**（mkdir+writeFile 是一次写
变更的两步，中途让位 = 目录建了内容被别人覆盖半截）。冒烟 S5 用"一个 chunk 带 4 个
tool_calls"驱动 pi 并行执行（race×2 同文件 + p1/p2 不同文件）：race.txt 内容 = A 或
B 完整无交错，p1/p2 都落盘。

**为什么不同**：无。上游的教训（这是他们修过竞态后的成品）对三进程拓扑同样成立
—— 竞态发生在引擎进程内部，与宿主无关。

## 3. edit：三段宝藏算法 + diff 进协议

### 3.1 算法（上游 745 行 edit-diff.ts 的三层结构）

1. **匹配在 LF 归一化空间**（BOM 剥离 → CRLF/CR → LF）：模型抄写的 oldText 不会
   带不可见 BOM，行尾也常被方言化，归一化空间匹配容错最高；
2. **模糊匹配回退**：精确 indexOf 失败后按"行尾空白/智能引号/Unicode 连字符/
   特殊空格"归一再匹配（`normalizeForFuzzyMatch`）—— 模型抄引号类字符的高频笔误
   有第二次机会；命中后**行级放大回写**（widenReplacementsToLines：只重写被触碰的
   行，未动行保留原文字节，防归一化后的重复行对齐到错误位置）；
3. **CRLF 偏移映射写回**（`applyReplacementsToOriginal`）：编辑在归一化空间算出
   替换区间，写回时映射回原文 —— **未触碰的行保留原始字节与行尾**（CRLF 文件
   edit 后不会整体变 LF），新文本的换行继承插入点所在行的行尾风格。偏移映射的
   数学：第 n 个 CRLF 的 LF 在归一化文本位于 `p - n`，加回 CRLF 计数即回原偏移。
   我们是 Windows 项目，这段是宝藏（冒烟 S19 断言 CRLF 文件编辑后行尾保真）。

diff 生成是**窗口化**的（替换点前后 32 行窗口，`generateEditDiff`）：时间内存跟随
变更大小而非文件大小，万行文件改一行也秒出；展示格式带老/新双行号 + 上下文折叠
（`...` 行）。

### 3.2 接线（Cogent 化差异）

- **kind 'edit' + 软限界**：上游 resolveToCwd 不限界；我们写类恒走
  resolveWithinRoots（越界 error 结果带可写根），审批矩阵把 edit 当写类处理；
- **diff 进协议（D4 定稿）**：上游 diff 只进 details 给 TUI 渲染器；我们把它升成
  协议字段 —— `ToolCallRecord.diff?` + `tool.completed` 事件 `diff?`（additive），
  流式（tool_execution_end 的 result.details）与历史回查（pi 转录持久化 details，
  toolResult 消息直读）双路径同源，工具卡折叠体首块渲染（+绿 -红 上下文灰）；
- **错误走结果不走异常**：上游 throw 由 pi 包装成 error 结果；我们直接
  errorResult（中文错误文案：找不到/多处命中/重叠/无变更），少一层转换；
- **未搬 prepareArguments**：上游对"模型把 edits 发成 JSON 字符串/单对象"的容错
  归一；pi-schema 参数校验在前，坏形状到不了 execute，校验错误同样引导重试
  （pi 的 AgentTool 其实也支持 prepareArguments 钩子，将来真见高频笔误再接）；
- **未搬 computeEditsDiff**（TUI 执行前预览专用）—— 审批卡内"将要改什么"预览
  是个有趣的后续件，随用随搬。

## 4. bash：进程管理是主战场

### 4.1 平台路由（D2 定稿：单工具）

**上游怎么做**：双工具 —— bash（getShellConfig：Windows 上 Git Bash 已知位置 →
PATH 上的 bash.exe → 报错引导装 Git for Windows）+ powershell（独立工具，pwsh 优先）。

**我们怎么做**：模型侧**恒名 `bash`**，实际 shell 按平台路由 —— Windows =
PowerShell（pwsh → powershell.exe → System32 直查，系统必有），unix = bash。
description 按平台声明方言（"注意用 PowerShell 语法"），系统提示词同步。

**为什么不同**：GUI 产品不能像 CLI 那样要求用户装 Git Bash（上游为此写了三步安装
引导报错 —— 那是 CLI 用户的语言）；PowerShell 是 Windows 的必有运行时。单名字的
代价是方言漂移，用动态 description 支付。

### 4.2 进程生命周期（孤儿教训引擎侧重演）

`killProcessTree`：Windows = System32 绝对路径的 `taskkill /F /T`（不依赖 PATH）；
unix = 进程组 SIGKILL（spawn detached 建组）→ 失败退化为杀单进程。detached 子进程
登记 `trackedDetachedChildPids`，**引擎退出钩子统一清场**（stdin close / SIGTERM）
—— 宿主侧 Electron 的孤儿进程教训（npm run dev 杀不净）在引擎侧同样成立：引擎死了
没人替我们杀。冒烟 S26 用**心跳文件法**断言无孤儿：abort 后 beat.txt 停止增长。

`waitForChildProcess`（上游 #5303 修复）：短命 shell exit 后，detached 后代可能还
攥着 stdout 管道在写 —— 固定 deadline 会截掉尾部输出；exit 后改等**管道空闲**（每
来一块数据重置 100ms 宽限计时器），安静的句柄宽限期满放行。

超时：timeout 秒数可选（无默认）；到点杀整树，exit code 语义照 shell 惯例
（信号击杀 = 128+信号号，无码 = 1），模型收到"命令在 N 秒后超时（进程树已终止）"
+ 死前输出。

### 4.3 流式呈现（D5 定稿：tool.progress）

**上游怎么做**：onUpdate 节流 100ms → TUI renderers 直接重绘终端。

**我们怎么做**：同样 onUpdate 100ms 节流，但消费方是协议 —— pi 原生
`tool_execution_update` 事件 → 转译层发 `tool.progress`（additive），**快照语义**
（整段尾部文本非增量 delta，UI 无需自己累积截断）；引擎侧再限尾部 2000 字符
（比 resultSummary 的 200 宽 —— 直播窗要看得见量，又比 accumulator 全量窄 ——
100ms 一帧不搬 50KB）。renderer 侧 tool.progress 更新 running 态 ToolItem.progress，
工具卡在单行下挂直播尾行（快照末两行，等宽灰字），终态由 resultSummary 接管。

### 4.4 PowerShell 命令包装：UTF-8 前置 + 退出码尾缀（2026-11-11 验收修复回补）

验收实录：`ping 127.0.0.1` 的中文输出在工具卡里全成乱码 —— 搬运 bash.ts 时
把上游 **powershell.ts 的命令包装层整个落下了**（D2 合并双工具为单工具路由时，
只搬了 bash.ts 主体，没搬 powershell.ts 在 exec 前包的三段东西）：

1. **UTF-8 前置** `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}`：
   中文系统控制台程序（ping/ipconfig 等）默认按 OEM 码页（GBK）写重定向管道，
   Node 侧按 UTF-8 解码即乱码。前置一行把控制台输出码页切到 65001 —— 子进程
   继承同一 conhost 后按 UTF-8 输出，PowerShell 自身文本输出同走 UTF-8；
2. **PS 5.1 退出码尾缀**（上游 #8842）：5.1 把重定向的原生 stderr 变成错误记录
   并置 `$? = false`，「命令成功但 stderr 有输出」（git push、npm run 的常态）
   被误报 exit 1。尾缀按 `$?` / `$LASTEXITCODE` / NativeCommandError 三级判
   exit；代价是 PS 5.1 上原生命令的具体退出码被压平成 0/1（上游同款取舍）。
   pwsh 7 无此问题只吃前缀；行尾反引号（行继续符）会续接尾缀进用户命令，跳过。

验证：`tests/integration/ps-utf8.test.ts`（2026-11-13 自 tmp/cogent-smoke 正名
迁入；6 项断言，pwsh 7 与 `--ps51` 双跑全过；跑法见 ../模块/测试.md）。教训入 §8 勘误。

## 5. 自主模式（D6：第四档权限）

置灰占位半年后兑现：`PermissionMode` + `'autonomous'`（additive）—— 文件写
（write/edit）信任放行（越界仍有工具层软边界兜底），exec/network 逐次询问。
之前不做的理由是"没有 exec/network 工具时它只能是 ask 同义词"（宁缺毋假）；
bash 落地即有料。引擎矩阵一行判定 + system 通告（"文件修改直接执行；shell 命令
属于风险操作"）+ 菜单真选项（desc："自动修改文件；命令执行前询问"）。network
工具（批次 7 件 8）落地后自动落进同一询问分支。踩坑：`isPermissionMode` 运行时
值域守卫（stdio 边界真防御）也要同步扩，否则 setPermission 静默 InvalidParams。

## 6. 批次 1 工具加固（3.6）

- **walk 尊重 .gitignore/.ignore**：上游走 fd 外部命令；我们用 `ignore` 包（git
  规范的权威 JS 实现，自解析否定规则/目录尾斜杠是陷阱重灾区）在自研 BFS 上层叠：
  逐目录建规则层，**嵌套 git 仓库是边界**（外层规则止步 —— 外层要忽略整个子仓
  得靠外层规则命中子仓目录 entry；进入后只受子仓自己的规则约束，上游 #5960 同
  口径）；scanRoot 在仓库深处时向上收集祖先层到 .git 为止。**已知近似**：跨层
  否定反悔（深层 !pattern 反悔浅层忽略）不支持 —— 单文件内否定由 ignore 包正确
  处理，跨文件否定是 git 深水区，fd 全语义代价远超收益；
- **grep context**：`path:N:` 匹配行 / `path-N-` 上下文行 / `--` 组间分隔
  （ripgrep 惯例，模型强先验）；相邻区间融并（gap ≤ 1 行同组）；
- **ls 工具**：目录速览一层（字母序、目录带 / 尾、含点文件、500 条 + 30KB 封顶），
  与 glob 互补（看结构 vs 按模式找）；
- **存量 bug**：grep/glob 的 path 指向**单个文件**时恒空 —— walkFiles 的 readdir
  对文件抛 ENOTDIR 被静默跳过。修复：根 stat 是文件直接进结果（显式给的路径不受
  ignore 规则约束，意图优先）。冒烟 S32 揪出（此前的"文件级搜索"从未被测过）。

## 7. 主流对比（学习产出核心）

| 维度 | Claude Code | Codex | pi 上游 | Cogent |
| --- | --- | --- | --- | --- |
| edit 形态 | old/new 串替换（同款唯一性校验） | patch 应用 | 同 Claude Code + 模糊匹配 + CRLF 映射 | 照搬 pi（含宝藏三段） |
| Windows shell | bash（Git Bash 依赖） | — | bash + powershell 双工具 | 单工具路由 PowerShell（D2） |
| 输出护栏 | Read 2000 行 cap | 截断 | 双上限截断器 + 流式累积器 + 临时文件 | 照搬 pi 三件套 |
| 流式呈现 | 终端直绘 | 终端直绘 | onUpdate → TUI renderers | onUpdate → pi 事件 → tool.progress 协议 → React |
| 杀进程 | 进程组 | 沙箱内 | taskkill /T + 组杀 + detached 登记 | 照搬 + 引擎退出清场钩子 |
| 审批 | 三模式 + 前缀规则 | sandbox+approval | main 无（approvals 分支开发中） | 四档（含 autonomous）+ 工作区级规则（领先） |

**单进程 vs 三进程的分界线**在这批最清晰：上游 onUpdate 100ms 后直接重绘终端；
我们同样的节流之后还要过 pi 事件 → JSON-RPC → IPC → React 四跳，所以协议取
**快照语义**（整段替换）而非增量 —— 序列化成本按帧数而非字节数支付。

## 8. 搬运裁剪记录（审计线索）

照搬：truncate 全家 / file-mutation-queue / edit-diff 核心（applyEditsToNormalized
Content、applyReplacementsToOriginal、generateEditDiff、getDiffWindows）/
killProcessTree / waitForChildProcess / OutputAccumulator / ls 主体 /
**powershell.ts 命令包装（UTF-8 前置 + PS 5.1 退出码尾缀 —— 2026-11-11 验收
乱码后回补，初版搬运时遗漏）**。
裁剪（有理由）：cross-spawn（spawn 的是解析后的 shell 本体）；getShellEnv 的 bin
注入（无 bin 目录）；WSL bash 识别（Windows 走 PowerShell）；sanitizeBinaryOutput
（UI 呈现件，需要时再搬）；computeEditsDiff/generateUnifiedPatch（无消费者）；
prepareArguments（pi-schema 校验在前）；bash structuredContent（codemode 专用）。
