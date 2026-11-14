# MCP 座

> Host 侧管理 **MCP 客户端**配置与授权，pi `createMcpExtension` 官方工厂
> 装配进会话（D7：不造轮子）—— 外部 MCP server 的工具直接进 Agent 循环。
> 不含对外 MCP Server（那是 D9，未立项）。原理与四家对比看
> [../技术笔记/mcp-seat.md](../技术笔记/mcp-seat.md)。

## 是什么 / 在哪

- store：`src/host/runtime/mcp-config.ts` —— 两级文件 + 校验 + 合并；
- 协议方法：`mcp.list`（摘要+诊断，readonly 档）/ `mcp.sync`（全量写
  user 级定义，write 档）—— 注册表在 host-main，HTTP 门档位同表；
- 装配：`kernel/pi-session-factory.ts` —— `extensionFactories` 加入
  `createMcpExtension({ loadConfig, logPath, updateConfig })`；
- 审批投影：`runtime/tool-meta.ts` —— `mcp__*` 前缀 → exec 档。

## 数据与生命周期

```
~/.cogent/mcp.json            # user 级（唯一可定义 server 的地方，mcpServers 通用形状）
<工作区主根>/.cogent/mcp.json  # 项目级（仅 override：enabled/exposure/toolExposure）
```

```
mcp.sync（全量替换 user 级，任一非法整包拒绝不半写）
      │
SessionManager.buildPiSession（pi 内核惰性装配 = 首次 submit）
      │  snapshot(主根) = user 定义 + project override 合并   ← 快照定格点
      │  （Pi-meme 快照语义：之后改配置不影响本会话，新会话生效）
      ▼
createPiSession → createMcpExtension(loadConfig: () => 快照)
      │  session_start（bindExtensions 发）→ 连接后台启动
      │  direct 工具 → 注册并声明给模型（首请求最多等 startupWaitMs=10s）
      ▼
mcp__<server>__<tool> ──经 pi 工具管线──▶ beforeToolCall 审批链（exec 档
      默认 ask；autonomous 下仍逐次询问 —— 未经用户配置的第三方工具保守起步）
```

## 怎么工作（要点）

- **校验**：条目形状用 pi-mcp 的 `validateMcpServerConfig`（名字字符规则、
  stdio/http 判别）；exposure/toolExposure 值域镜像 pi core 校验（该函数
  未从包导出）。损坏 JSON / 项目级越权条目逐条诊断收集，不炸（list/snapshot
  带回 errors，装配期 stderr 留痕）；
- **信任门**：项目级 mcp.json 带 command/url/type（= 定义新 server）直接
  拒绝 —— 低信文件开不了新进程（zcode sha256 工作区信任门的轻量等价物）；
- **工具激活**：createAgentSession 的 `tools` 显式列表会过滤扩展工具 ——
  未列名的 direct MCP 工具注册但不声明给模型。allowlist 追加
  `mcp__*` + 资源三件（tool-meta 的 `MCP_TOOL_ALLOWLIST`）放行；
- **SDK 生命周期**：`createAgentSession` 后必须 `bindExtensions({ mode:'rpc' })`
  —— session_start（MCP 装载配置/启动连接点）由它发出，CLI 各 mode 里调、
  SDK 消费者漏了它则 MCP 扩展零初始化且无诊断（Pi-meme session.ts:917 同款）；
- 日志：`<COGENT_HOME>/pi/mcp.log`（pi 域）；settings 补丁写回（updateConfig）
  按条目来源落 override 文件或 user 文件，默认值语义与 pi 一致。

## 边界（首发不做，出处 docs/计划/MCP座实现.md §4）

- OAuth sign-in 不做（连接需登录时工具不可用；交互式授权流列后续）；
- 无热刷新：配置变更新会话生效（进行中会话持有快照）；
- 不做 `${VAR}` 变量替换、不做 SSE 传输、项目级不能定义 server；
- **MCP 子进程活到 Host 进程退出**：pi 的 `dispose()` 不发 session_shutdown，
  连接不随会话删除回收（与 pi print-mode 同语义）；
- annotations 分级未做：beforeToolCall 载荷拿不到工具定义（见技术笔记）。

验收：`tests/integration/mcp.test.ts` —— mock stdio echo server 经 `mcp.sync`
配置后：direct 工具声明进一轮请求、审批链对 `mcp__mock__echo` 弹 exec 档、
echo 结果回灌二轮闭合、`mcp.sync` 置 disabled 后新会话工具消失；
`mcp-config.test.ts` 单测钉 store 行为（校验/合并/补丁/损坏诊断）。
