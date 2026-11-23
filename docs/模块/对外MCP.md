# 对外MCP

> 对外出口座：外部 agent（zcode / Codex / Claude Code 等
> MCP 客户端）经 MCP 驱动**运行中的** Cogent Host —— 与 [MCP座](MCP座.md)
> 方向相反（那是 Cogent 作为客户端消费外部 server）。
> 落点：`src/host/mcp-server/`（独立入口 `out/main/mcp.js`，stdio transport）、
> `src/electron/main/host/mcp-access.ts`（凭据写入）。

## 拓扑与方言边界

```
外部 agent（MCP 客户端，只会标准 MCP）
   │ stdio spawn out/main/mcp.js
cogent-mcp（翻译官：北面标准 MCP，南面 Cogent 方言）
   │ 每次工具调用重读凭据 → HTTP /rpc（Bearer）+ WS（waitMs）
运行中的 Host（GUI 所见即外部所驱动，单 Host 不起第二个引擎）
```

- 方言圈死在 `host-client.ts`：外部只见 `cogent_*` 工具与 JSON 返回，
  `agent.submit` / 事件流等协议名不出 MCP 边界；token 端口永不进错误消息
  （错误投影：no-access / host-unreachable / token-invalid / outcome-
  uncertain / scope-forbidden 各归一词）；
- 流式边界：MCP 无 token 级流式对应物，工具返回即终态快照；submit 的
  `waitMs`（≤120s）内部两段式订阅（**先 WS 就绪再 submit**，事件不重放，
  先提交再订会错过快任务）等 `run.completed/failed`，超时返回
  `run:{state:'timeout'}`（受理是真的，不判失败）。

## 凭据链（mcp-access.json）

```
Host 启动（main/index.ts start 后）
  → settings.externalMcp.enabled？否 → 删遗留文件即止
  → 是：stdio capability.issue(allowWrites?write:readonly) → 票据
    /auth/exchange 换 token → 原子写 ~/.cogent/mcp-access.json {port,token,scope}
  → Host 重启 main 重写；cogent-mcp 每调用重读（换 token/端口无需通知）
```

- `externalMcp` 在 `settings.json` 中手动编辑。重启桌面应用后读取新的开关和写权限，
  关闭时删除遗留凭据文件，已签发 token 随上一代 Host 退出而失效。
- MCP 工具集在入口进程启动时按凭据档位注册。变更档位后重新连接 MCP 入口以刷新工具清单。
- 凭据缺失、JSON 损坏或顶层形状非法时，入口仍可初始化和列出只读工具，实际调用返回凭据不可用的提示。

## 工具面（14：只读 6 + 写组 8）

- 只读：status / projects_list / sessions_list / session_messages /
  models_list / inspect_entries（审批审计对对外可见的窗口）；
- 写组（凭据 scope=write 才**注册**，readonly 档零注册）：session_create
  （**默认开启计划开关**：`planEnabled = 入参 ?? permissionMode 未传`——安全
  默认 + 放开显式，dsh 默认 elicit / Pi-meme schedules 强制 accessMode 同向）、
  session_submit、session_abort、approval/question/plan_respond、
  session_set_permission、session_set_plan_mode；
- annotations 是三层审批的第一层（主位在**客户端侧**：写组标
  destructiveHint，远端的人在自己 agent UI 里批）；第二层 GUI 共址
  （面板照常弹本地用户）；第三层无人值守显式档；
- 不暴露 credentials、mcp/skills 写、capability.issue、delete 类、compact/continue
  与文件读面。凭据面不外露；mcp/skills 写会交出提示词注入与进程配置权，
  capability.issue 是提权面；删除缺少预览/revision 契约，文件读取缺少公共 HostApi
  与根约束。compact/continue 与 inspect 详情未映射，当前出口提供 messages 轮询
  和 inspect 摘要，不据此宣称这些内部能力不可对外提供。
  出口依赖、安全边界与对照见[对外MCP笔记](../技术笔记/对外MCP.md#5-出口范围为什么小于-hostapi)。

- 验收：write 凭据 tools/list 14 个、readonly 6 个（写组零注册）；
  submit waitMs 拿终答 finalText；ask 档写工具 → `cogent_inspect_entries`
  见 approval.asked → `cogent_approval_respond` 允许 → 二轮终答
  （`tests/integration/external-mcp.test.ts` 与 `tests/host/mcp-server/`）。
  手测（zcode 真机驱动）见 [../测试用例/对外MCP.md](../测试用例/对外MCP.md)。
