# 技术笔记 — 项目/工作区模型与存储根

> 落点：`runtime/project.ts`（ProjectRegistry）、`electron/main/storage-root.ts`
> （~/.cogent 根 + 旧文件迁移）、workspace IPC、`session.ts` 工作区注入
> （2026-11-09，计划 [计划-工作区与会话真实化.md](../计划-工作区与会话真实化.md)
> 第 2–6 步；存储本体见 [session-storage.md](session-storage.md)）。

## 1. 问题：Agent 客户端的「项目」是什么

对话产品（ChatGPT）里「项目」是消息分组；编码 Agent 里「项目」是**目录绑定**。
Cogent 选后者：项目 = `{ id, name, cwd }` 薄实体，意义全在被会话引用
（`session.projectId` → 继承 cwd）。这与 UI 的「项目 → 子聊天」两级结构同构。

## 2. 工作区对模型意味着什么（四通道）

模型无进程无 cwd，工具收到 `read_file("src/index.ts")` 时路径解析是引擎做的。
工作区经四条通道生效：

1. **文字声明**：systemPrompt 写明工作区路径（`buildSystemPrompt`）；
2. **路径锚点**：工具实现闭包捕获 cwd，相对路径 `path.resolve(cwd, p)`
   （工具层落地时空位 #2 消费）；
3. **权限边界**：目标在工作区内 = 低摩擦、在外 = 审批（`beforeToolCall`，
   空位 #2）；
4. **项目上下文**：启动读 AGENTS.md / git 状态注入。

本次落地的是①④ + submit 时目录存在性复查（防对已删目录输出幻觉操作）；
②③随工具层。**隔离对话的是 transcript（会话），工作区隔离的是工具作用域**
——所以一个项目可挂多会话（共享目录、不共享对话）。

## 3. 环境块与 AGENTS.md（Claude Code 手法）

- 环境块进 systemPrompt：平台 + cwd + git 分支。分支**直读 `.git/HEAD`**
  （解析 `ref: refs/heads/<branch>`），不 spawn `git` 子进程 —— Windows 免
  依赖、零进程开销；代价是 detached/特殊 worktree 读不到（可接受，失败静默
  省略该行）；
- AGENTS.md 只读加载：存在才拼、限长 16k 字符（巨型指令不吃满上下文）、
  读失败跳过不挡会话（指令文件是增益不是必需品）。全局 `~/.cogent/AGENTS.md`
  的用户级指令层未做（additive 可后补）。

## 4. 存储根：~/.cogent（决策 D1/D2）

- **单一第一方根**：`COGENT_HOME ?? ~/.cogent`，引擎（sessions/projects）与
  main（credentials/custom-providers）各写各的子域，互不碰对方文件（单写者
  纪律）。Electron 侧抽 `storage-root.ts`、引擎侧 index.ts 自算同一路径
  （纯 Node `os.homedir()`，零 Electron）——**路径公式两处各写一遍但没有
  共享模块**：引擎禁 import Electron 代码（目录即边界），复制一行公式是
  边界成本，不是坏味道；
- **旧 userData 迁移**：首启发现旧文件 → 读出 → 写新 → **删旧**（迁移不是
  复制，双份并存 = 用户改旧文件"不生效"的排障噩梦）；
- safeStorage 密文按 Windows 用户账户（DPAPI）加密，与路径无关，搬家只是
  文件位移。

## 5. 项目删除语义：不级联

`project.delete` 只删项目，归属会话保留（projectId 悬挂 → UI 显示为无归属）。
理由：会话是用户资产，项目只是组织结构；级联删是危险动作，真要做应由 UI
显式确认后逐会话删。悬挂引用在单机 GUI 里比数据库领域轻得多 —— 显示层
容错即可。

## 6. 与 DeepAgent / 主流 Agent 对比

| 维度 | Cogent | Claude Code | Codex CLI | Cline/Cursor |
| --- | --- | --- | --- | --- |
| 项目/工作区锚点 | 显式绑定（用户选目录，存 projects.json） | 启动 cwd 即工作区，`--add-dir` 加挂 | cwd + 会话文件记 cwd | IDE 打开的文件夹 |
| 工作区→模型 | 四通道的①④（文字声明 + AGENTS.md/环境块） | 每轮环境块注入 cwd/分支/平台 | 环境块 + 沙箱策略注入 | rules 文件 + 上下文索引 |
| 硬边界 | 无（D6：软边界，审批随空位 #2） | 权限规则按路径 + 审批 | **OS 级沙箱**（landlock/seatbelt） | IDE 权限弹窗 |
| 项目级指令 | AGENTS.md 只读（限长） | CLAUDE.md 层级（全局/项目） | config.toml + AGENTS.md | .clinerules/.cursorrules |
| 多会话/项目 | 项目挂多会话（projectId 外键） | cwd 哈希归档（目录即分组） | 无项目概念（平会话流 + cwd 标签） | 天然单工作区 |

三点展开：

1. **显式绑定 vs 启动 cwd**：CLI 生下来就在某个目录里，工作区是"起点"；
   桌面 GUI 生在无目录环境，工作区必须是**用户显式选择的一等实体**。
   这个差异决定了 Cogent 需要 projects.json + 目录选择框 + 会话继承链，
   而 Claude Code 一行配置都不用。DeepAgent（作者前项目）没有工作区概念，
   工具吃绝对路径 —— 用户每次都要说全路径，且"在哪个项目里工作"的上下文
   语义完全缺失，这是本次设计的直接动机。
2. **软边界 vs 沙箱**：Codex 的 OS 级沙箱（seatbelt/landlock）是硬保证，
   Windows 上等价物（AppContainer/受限 token）工程成本高且 Electron 集成
   复杂。Cogent 选软边界（提示词 + 审批判定）与 Claude Code 一致 ——
   Claude Code 没有沙箱也成为了主流工具，说明审批流 + 权限分级在实践上够用。
   沙箱作为长期项留在路上（D6）。
3. **AGENTS.md 生态位**：本项目自己根目录的 AGENTS.md 就是活样例 ——
   「给人写、给模型读」的指令文件已是跨工具事实标准（Claude Code/Codex/
   Cursor 均认）。Cogent 只读消费是零成本接入生态；不发明 `.cogent/`
   内嵌目录（计划 D4）。

## 6.5 多根工作区（2026-11-09 二次决策收编）

用户拍板把「多文件夹聚合」从明示不做收编进本期（跨仓库任务是真实场景：
前端 + 后端两仓库一个项目）。落点：

- **协议**：`ProjectSummary.cwd → cwds: string[]`（≥1，首个 = 主根）。
  这次字段变形发生在协议发布同日内、宿主唯一（Cogent main），直接改形 +
  升盘上版本（v1→v2 启动迁移）而没有走 PROTOCOL_VERSION 递增 ——
  「只增不破」针对的是**已发布给外部宿主**的契约；当日自家的实现变形
  以盘上格式版本与迁移消化。若已有外部宿主在用，正确动作是递增版本号；
- **注入**：声明列全部根（编号列表 + 主根标注）；环境块每根一行（各自
  git 分支）；AGENTS.md 每根各自加载（>1 根时标签带路径区分归属）；
  相对路径解析规则写明「未指明时优先主根」；
- **守卫**：submit 复查全部根，任一根缺失 → 错误帧带具体路径；
- **信任确认**：参考图流程 —— 点「创建项目」先出「信任这些文件夹吗」
  （列全部目录 + 风险文案 + 信任/取消），信任才真提交。语义 = 用户显式
  扩大 Agent 的文件访问范围，每多一个根都是；这与空位 #2 审批流的
  「工作区内低摩擦」判定共用这份根列表；
- **主根在 UI 的呈现**：信息区只露主根 basename（其余根收工作区面板，
  后续件），避免胶囊行被长路径挤爆。

VS Code workspace 与 `--add-dir` 的对比：VS Code 把多根做成一等工作区
模型（storage 按组合键控）；Claude Code 的 `--add-dir` 是运行时附加权限
（会话级，不落盘）。Cogent 选**项目级持久多根**：桌面 GUI 的项目是长期
实体，目录组合属于项目而不是会话。

## 7. 冒烟验证

- 项目域：create/rename/list → 会话挂 projectId → delete（盘上 projects/
  清空、会话保留悬挂）；
- 工作区注入：mock 端点捕获请求体 —— system prompt 含工作区声明、cwd、
  `Git 分支: main`、AGENTS.md 指令全文，四项全 true；
- 已删目录：回合成功后删目录再 submit → 错误帧「工作区目录不存在」，
  引擎存活。
