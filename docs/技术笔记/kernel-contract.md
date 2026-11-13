# CogentKernel 合同 —— 南缝的显式化

> 全局架构 D4 / 阶段 1.1。落点：`src/host/kernel/contract.ts`（合同本体）、
> `runtime/session.ts`（SessionManager implements CogentKernel，零行为变化）。

## 1. 问题：Host 服务层与内核之间为什么要一道缝

Host 进程里有两类职责：**服务层**（会话编排 / 协议 dispatch / 项目 / 凭据）与
**内核**（pi Agent 循环的装配与驱动）。没有缝的后果：服务层代码随手 import
pi 类型、直摸 Agent 实例 —— pi 的类型面就从"一个文件的私事"扩散成"全进程的
公害"，将来换内核（PiRpcKernel 子进程版）或加第二个内核时每一处直接引用都是
返工点。缝的本质：**把 pi 依赖关进一个目录，服务层只见可序列化的协议形状**。

## 2. pi 的做法：AgentSession 方法面 + 双入口

pi 官方自己就有"内核化"的形状 —— coding-agent 的 `AgentSession`
（`reference/pi/packages/coding-agent/src/core/agent-session.ts`）公开方法面：

| 方法 | 行号 | CogentKernel 对应 |
| --- | --- | --- |
| `prompt(text, options?)` | :2162 | `submit`（受理校验 + 事件驱动） |
| `steer(...)` / `followUp(...)` | :2363 / :2379 | 1.2 扩展位（现合同未含） |
| `abort()` | :2601 | `abort` |
| `setModel(model)` | :2644 | submit 的 model 参数（1.2 独立化） |
| `compact(instructions?)` | :2923 | `compactSession` |

且 pi 同一内核有 SDK（in-process）与 RPC（`--mode rpc`，rpc-entry.ts /
modes/rpc/rpc-mode.ts）两个宿主入口 —— 内核不绑定宿主形态，这正是南缝
要保住的自由度。

## 3. 对比：四家的缝

| | 缝的形态 | 出处 |
| --- | --- | --- |
| pi | AgentSession 方法面；宿主经 SDK/RPC 进 | agent-session.ts（上表） |
| Pi-meme | **无显式内核合同** —— SdkSession 在 worker_threads 内嵌，Host 只见自家的 HostApi v2（packages/contracts/src/host-runtime.ts） | 内核与 Host 同仓同栈，无换核需求 |
| zcode | agent = stdio 子进程，合同 = Zod schema 协议帧（进程边界即缝） | 调研见 全局架构.md §8 |
| dsh | 全量合同 + replay 确定性承诺 + waterfall —— 150+ 包爆炸的反面教材 | 同上 |

## 4. 取舍

- **窄合同**：8 个方法 + 事件出口（KernelNotifier）—— 全是现状
  SessionManager 已有的面，1.1 是**零行为显式化**（D4 复杂度账：合同早已
  隐式存在，本批只是写下来 + implements 让 typecheck 钉死兼容）；
- **不做** dsh 式全量合同 / replay 承诺 —— 防复杂度黑洞（dsh 是前车之鉴）；
- **纯期权**：若最终只跑 pi，这份合同收益 ≈ 0、费用也 ≈ 0；但 DeepAgent
  形态反向校验（kernel-agnostic 与否）时它是标尺（D5）；
- **混体承认**：setPermission 同时动 summary（域）与 transcript 通告（内核），
  合同先收下、注释标明 1.2 拆分时归位 —— 不为纯度提前拆方法（1.2 换内核时
  这段本来就要重写）。

## 5. 在 Cogent 的落点

- `kernel/contract.ts`：`CogentKernel`（submit / continueSession / abort /
  compactSession / messages / setPermission / respondApproval / disposeAll）
  + `KernelNotifier`（事件出口形状，原 session.ts 的 Notify 挪入）；
- `runtime/session.ts`：`implements CogentKernel` —— 签名兼容由编译器强制，
  1.2 拆分时它是 PiSdkKernel 的对照基线；
- 纪律（合同头注释）：服务层不 import pi-*、不摸内核内部对象；合同签名
  一律 protocol 可序列化形状。
