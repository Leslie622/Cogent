# 技能座 —— Host 管目录，段钩子管注入，read 即加载器

> 阶段 4b（2026-11-15）。代码落点见 [../模块/技能座.md](../模块/技能座.md)；
> 四家横向对比（钉行号）住在 [../计划/技能座实现.md](../计划/技能座实现.md) §2，
> 本文只记原理与**实施期新发现 / 与报审稿的差异**。

## 1. 问题

让 SKILL.md 指令包渐进进入 Agent 循环（清单给路由、正文按需取），但
发现、校验、注入、展开这些轮子不该重造。Cogent 的拆法：**Host 只管
目录与启停**（哪些技能、谁开谁关、正文怎么编辑），**清单注入与加载
全部用 pi 官方机制**。

## 2. pi 的做法（三个现成件）

1. **发现**：`loadSkillsFromDir`（core/skills.ts:168-171）——SKILL.md
   目录即技能根不再递归 / 根下裸 .md / 递归子目录 + ignore 文件遵循；
   名字/描述校验（skills.ts:92-127）与诊断都在里面，包从 index 导出
   —— Host 只选目录，规则全白拿；
2. **注入**：`DefaultResourceLoader` 的 `skillsOverride`（resource-loader.
   ts:324 定义，:892 应用）+ `noSkills`（:882-883 空分支后 override 仍
   应用）——Cogent 传 `noSkills: true` + 空 override，pi 静态技能面全关
   （`.pi` 发现域不扫、扩展动态技能路径不可达 = Pi-meme
   freezeResourceLoader resource-loader.ts:40-47 的等效守门）；
3. **手动调用**：`/skill:name args` 会话内建展开（agent-session.ts:
   2312-2336）。

## 3. 实施期发现

### 3.1 热刷新不走 reload，走 before_agent_start 段钩子（本座的关键机制）

pi 的 `session.reload()`（agent-session.ts:3838-3871）是**重型全量重启**：
发 session_shutdown（reason: reload）→ 作废扩展 runner → 重载设置 →
重建 runtime → 重发 session_start —— MCP 连接会全部弹掉，给技能刷新用
它是杀鸡用牛电机。轻路径是 `_prepareRun` 每回合发 `before_agent_start`，
其 `systemPromptOptions.sections` 可被 handler 改写（agent-session.ts:
2009-2018；**Cogent 权限段已用同一机制**），`_preparePromptAndToolLoadout`
对期望段与转录回放段做 diff、变更才追加系统补丁（:2056-2058 +
system-prompt.ts:216）。技能段每回合用活 store 重算 = **回合边界热刷新**，
UI 改动与手动改文件都生效，且**不需要 Chokidar** —— dsh 要监视器是推
模式+缓存所迫（hot-refresh.md:18-22 编目与正文分离 + digest 整表替换），
拉模式每回合都是完整观察，无中间态可推。

**一个类型事实**：pi 的期望段表是 `Record<string, string>`
（system-prompt.d.ts:56），**没有 null**——删除段靠期望侧缺键，diff 对
转录回放的旧段产出 null 补丁撤下（空墓碑语义）。钩子里 `sections.skills = null`
会被类型拒绝，正确写法是 `delete sections.skills`。

### 3.2 `/skill:` 展开必须搬家（否则与热刷新脱节）

pi 内建展开查 `resourceLoader.getSkills()`（agent-session.ts:2319）——
那是 loader 静态集（只在 reload/extendResources 时更新）。技能段已经
回合热刷新而 `/skill:` 查旧集 = 清单与手动调用可能不一致（新技能看得见
调不动）。修法：Cogent submit 路径先行活展开（session.ts driveRun，
`expandSkillCommand` 用活快照查名，输出形状逐字镜像 agent-session.ts:2325
 的 `<skill name location>` 块），pi 的展开留在树里作兜底不触发。

### 3.3 正文加载器：不造 Skill tool（zcode 对照）

zcode 造了专用 `Skill` tool（`<skill_content>` 外壳 + readOnly +
maxOutputBytes 100k，tool/handlers/skill.ts:79-116）——因为它要权限/
预算/trace 收口。Cogent 声明了 pi 的 read 工具（tool-meta.ts COGENT_
TOOL_NAMES）且 pi read 无 cwd 圈禁（tools/read.ts:71 仅查可读性），
工作区外的 `~/.cogent/skills/...` 可读 —— **read 即加载器**，零成本获得
zcode 两层加载的第二层。100KB 硬上限不做：pi read 自带输出截断护栏。

### 3.4 生态兼容目录 `.agents/skills`（2026-11-15 手测反馈并入）

zcode 的双根形状：同一目录基下 `.zcode` 原生 + `.agents` 兼容**合并加载
而非 fallback**（adapters/skills/roots.ts:112-118 注释：用户可能同时装
原生与兼容版；同级仍 `.zcode` 优先）。Cogent 把这形状搬到自己的两级：
`.cogent` + `.agents` 各 user/project 两处，但生态侧**只读** —— 发现/
清单/启停/`/skill:` 全兼容，新建/编辑/删除仍只写 `.cogent`（两套工具不
改对方的文件；与 zcode 对 plugin 源「拒绝 symlink 即拒绝逃逸，不判指向」
同思路，scan.ts:14-23）。同名优先级由加目录序编码：项目 .cogent >
项目 .agents > 用户 .cogent > 用户 .agents。pi 无此层 —— loader 只管
单目录内的规则，选哪些目录归 Host，D7 白拿不冲突。

## 4. 取舍

- **同名优先级跟 zcode/dsh 不跟 pi**：pi 的 loadSkills user 先加先得
  （skills.ts:457-459 user 胜）是异类；zcode 与 dsh
  （layered-skill-registry.md:18 近层胜）及 Claude 生态都是 project 胜。
  **注意出处口径（2026-11-15 实读修正）**：zcode 的 project 胜是其
  **设计文档**（skill.md §优先级「同名取高优先级项，重复进 diagnostics」）；
  其适配器实现实际**不按名去重** —— discoverSkills 按 path 收录，同名
  两枚都进清单（adapters/skills/index.ts:80-84 注释「路径才是安装项
  身份」），按名 loadSkill 稳定排序取先插入者 = **user 先得**，与设计
  文档相反。Cogent 实现的是设计文档语义（同名 project 胜 + 冲突诊断），
  对照源码时以本条为准。
  技能是被动文本，项目级允许定义（对照：MCP 座拒项目定义是进程信任门）；
- **快照（MCP 座）vs 活算（本座）**：MCP 连接是装配期资源（pi 扩展持有），
  只能快照；技能是纯文本，每回合重读两目录的 I/O 可忽略，活算即热刷新。
  两座语义差异在 UI 明示（MCP「新会话生效」/ 技能「下一回合生效」）；
- **预算模型抄 zcode**（sections/skills.ts:8-9,50-57：20k 总预算 + 250/条
  + names-only 降级），但 names-only 档**保留 location** —— zcode 的
  Skill tool 按 name 调用可以全去描述，Cogent 的 read 需要 location 才能
  读文件；再加一档兜底（截条目 + 省略计数）。

## 5. 与报审稿的差异

- 新增 `skills.read`（readonly，编辑表单回填正文；zcode `skills inspect`
  同位）——报审稿四方法没拆正文读取，实施时 list 不带 body（正文可能
  很大，每次刷新全量传浪费），拆出只读单条；
- 其余按稿实施（四家对比与边界判定见实现文档 §2/§4）。

## 6. 在 Cogent 的落点

- `src/host/runtime/skill-store.ts`：四目录 store（.cogent 两级写路径 +
  .agents 两级生态只读；发现/合并/启停/save-delete-read/`/skill:` 展开）；
- `src/host/runtime/skill-prompt.ts`：预算 formatter（镜像 pi XML 形状）；
- `src/host/kernel/pi-session-factory.ts`：noSkills + 空覆盖 + 段钩子；
- `src/host/runtime/session.ts`：snapshot 闭包 + submit 活展开；
- `src/host/host-main.ts`：`skills.list/read/save/delete/setEnabled`；
- `tests/integration/skills.test.ts`：端到端（合并视图/清单注入/read
  闭环/同会话热刷新/活展开）+ 同址单测两份。
