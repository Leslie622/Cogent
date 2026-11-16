# 对外MCP · 手动测试用例

> 阶段 5a（D9 出口座）。自动化覆盖：mcp-server 单测 11 条 +
> external-mcp.test.ts 集成 T1–T4（真 SDK Client × 构建产物全链）；
> 本册管真实 MCP 客户端（zcode）的对接手感。前置：Cogent 桌面应用可运行。

## 〇、开启与接线（一次性）

| # | 操作 | 期望 |
| --- | --- | --- |
| M1 | 编辑 `~/.cogent/settings.json` 加 `"externalMcp": { "enabled": true, "allowWrites": false }` → 启动 Cogent | 主进程日志见「对外 MCP 凭据已写入（scope=readonly, port=…）」；`~/.cogent/mcp-access.json` 出现（port/token/scope） |
| M2 | 把 `allowWrites` 改 true 重启应用 | 凭据文件 scope 变 write（旧文件被原子覆盖） |
| M3 | 把 `enabled` 改 false 重启应用 | 凭据文件被**删除**（关闭态不残留有效 token） |

## 一、zcode 对接（预期消费者）

先拿到 spawn 命令（node 用应用自带 runtime，三级链同引擎）：

```json
{
  "mcpServers": {
    "cogent": {
      "command": "<resources/runtime 里的 node.exe 绝对路径>",
      "args": ["<应用资源内 out/main/mcp.js 绝对路径>"],
      "env": { }
    }
  }
}
```

| # | 操作 | 期望 |
| --- | --- | --- |
| M4 | zcode 配置上述 server → 连接 | MCP 连接成功；`[cogent-mcp] ready（scope=write）` 在 zcode MCP 诊断里可见 |
| M5 | zcode 里问「我有哪些 cogent 工具」→ 调 `cogent_status` | 返回 service=cogent-agent + 协议版本 + scope |
| M6 | `cogent_sessions_list` / `cogent_projects_list` | 与 Cogent GUI 侧栏所见一致（同一 Host 的证明） |
| M7 | 让 zcode 建 Cogent 会话并发问（不传 permissionMode） | 会话出现在 Cogent GUI 侧栏，且带「计划」标记（默认 plan 档） |
| M8 | 让 zcode 用 waitMs 提交一个会答问题的任务 | 一次工具调用直接拿到 finalText（受理 + 终答一体） |

## 二、审批三层（人在哪，闸在哪）

| # | 操作 | 期望 |
| --- | --- | --- |
| M9 | zcode 调 `cogent_session_submit`（destructiveHint） | zcode 侧先弹**它自己的**工具确认（客户端 annotations 层 —— 主位） |
| M10 | M7 的 plan 会话里让模型写文件 | 写被拦截（计划模式裁决），无审批面板、无挂起 —— 只读零挂起成立 |
| M11 | zcode 建会话显式传 `permissionMode:"ask"` + cwd → 让模型写文件 | Cogent GUI 弹审批面板（共址层）；zcode 侧轮询 `cogent_inspect_entries` 能看到 approval.asked 条目 |
| M12 | GUI 面板点「允许」 | 工具执行；zcode 侧再查 messages 见工具卡（含 diff）与后续终答 |

## 三、边界确认

- M13：Cogent 应用退出后 zcode 调 `cogent_status` → 报「无法连接 Cogent
  Host」（host-unreachable，引导语），zcode 的 MCP 连接本身不挂。
- M14：重启 Cogent 应用（token 轮换）→ zcode **不重启**直接再调工具 →
  正常（每调用重读凭据文件吃新 token）。
- M15：删掉 mcp-access.json 重启 zcode 的 server → 工具全变 no-access
  引导错误，但 tools/list 仍可用（只读组常驻）。

已知边界：无 token 级流式（终态快照 + messages 轮询）；无文件读面
（可见 edit diff、拿不到全文）；无幂等键（重试可能重复提交，工具描述已
写明）；HTTP transport 未做（stdio only）。
