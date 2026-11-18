# 对外MCP手动验收

机制与暴露边界见 [对外MCP](../模块/对外MCP.md)。本册使用真实MCP客户端（如zcode）
驱动正在运行的Cogent；步骤是预期，执行时记录实际客户端、应用版本及失败信息。

## 前置接线

在独立测试配置中设置`~/.cogent/settings.json`，由用户启动或重启应用：
`"externalMcp": {"enabled": true, "allowWrites": false}`。
配置真实客户端的stdio server；路径用本机安装位置替换：

```json
{
  "mcpServers": {
    "cogent": {
      "command": "<自带runtime的node.exe绝对路径>",
      "args": ["<应用资源内out/main/mcp.js绝对路径>"]
    }
  }
}
```

不把凭据文件或token贴入客户端对话；只核对文件存在、scope和连通结果。

## 配置、读写与审批

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| M1 | enabled=true、allowWrites=false后启动 | 生成mcp-access.json；客户端readonly工具组可用，无写工具 |
| M2 | allowWrites=true后重启并重连server | 凭据scope=write，写工具可见；tools/list按注册快照切换 |
| M3 | enabled=false后重启 | 遗留凭据删除，外部不能沿用文件继续访问 |
| M4/5 | 客户端连接并调用cogent_status | stdio连接成功，返回service/协议/scope，诊断无敏感材料 |
| M6 | 列项目/会话，与GUI对比 | 两边是同一Host的数据，无第二个独立引擎 |
| M7 | 建会话，不传permissionMode | GUI出现会话且计划开关开启；权限档与计划状态分开核对 |
| M8 | waitMs提交能回答的任务 | 窗口内完成返回finalText；超时返回timeout只代表尚未等到，不判任务失败 |
| M9 | 客户端提交被标destructiveHint的工具 | 按该客户端策略观察其本地工具确认；不同客户端不假定同一弹窗形态 |
| M10 | 默认计划会话中要求写文件 | 计划拦写，无Cogent权限审批挂起 |
| M11 | 显式permissionMode=ask且设置cwd，要求写文件 | Cogent弹审批，外部inspect可查approval.asked |
| M12 | GUI允许或通过授权的MCP裁决工具允许 | 工具执行，messages可见结果/后续终答；裁决只匹配该请求 |

## 生命周期与限制

- M13：关闭Cogent后调用status，应为host-unreachable引导，MCP子进程本身可继续。
- M14：Cogent重启、token轮换后，不重启MCP进程再调用，应重读凭据正常访问。
- M15：移开测试凭据文件后重启MCP server，tools/list仍可用，调用返回no-access引导；测后恢复。
- 当前MCP入口仅stdio；返回终态快照或messages轮询，不提供token级流式。
  无全文文件读面、无幂等键，重试提交可能重复执行；不要把timeout当作安全重试依据。
- 测后关闭测试出口或恢复原settings，移除客户端测试server，不删除个人会话/项目。
