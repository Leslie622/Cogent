# 模块事实文档

> 一模块一文件，只描述**当前实现的事实**（是什么 / 在哪 / 怎么工作 / 边界）；
> 实现有改动必须同步对应文件（顺带核对「验收：」句仍成立）。历史与决策
> 过程看 [../计划/](../计划/)，原理对比看 [../技术笔记/](../技术笔记/README.md)。

| 模块 | 拥有 |
| --- | --- |
| [会话与对话](会话与对话.md) | SessionManager、submit 受理校验、流式段化、转录持久化与恢复、abort 语义 |
| [HTTP通道](HTTP通道.md) | HostApi 第二扇门：POST /rpc 传输层、handleFrame 双门共用、事件归属（stdout 唯一出口）、loopback fail-closed |
| [内嵌页面](内嵌页面.md) | webview 沙箱硬化、guest preload 三函数 SDK、票据传递链（main 签发 → preload 兑换 → 页面直连）、demo 页验收 |
| [消息呈现](消息呈现.md) | 回合分组两态、Markdown 渲染、工具卡、思考呈现、审批痕迹行、压缩条呈现 |
| [工具系统](工具系统.md) | pi 内置 8 选 7（win=powershell）、glob→find 映射、fd/rg 依赖与降级、ToolKind 投影、fd/rg 获取链与降级 |
| [MCP座](MCP座.md) | 两级 mcp.json 配置（user 定义 + 项目仅 override）、createMcpExtension 装配（快照语义）、mcp.list/sync 协议方法、mcp__ 工具 exec 档审批投影 |
| [技能座](技能座.md) | 两级技能目录（同名 project 胜）、skillsOverride+段钩子注入（回合边界热刷新）、read 渐进加载、/skill: 活展开、清单预算 |
| [交互座](交互座.md) | todo_write / ask_user / plan 闭环三件套：customTools 注入 + 挂起/回填（pendingApprovals 同款骨架）+ 三面板；todo 与已批准 plan 的段双通道防失忆、批准切档、拒绝停轮（terminate） |
| [审批与权限](审批与权限.md) | 判定矩阵与优先序、挂起收尾、工作区规则表、权限通告、确认面板与 tag |
| [上下文压缩](上下文压缩.md) | 触发公式、checkpoint 摘要、L1 裁剪、溢出恢复、保留式转录表示 |
| [工作区与项目](工作区与项目.md) | ~/.cogent 存储根、项目域多根、侧栏分区语义、工作区注入、信任与归档 |
| [凭据与模型目录](凭据与模型目录.md) | key 存取链路、自定义 provider、override 合并、显示口径、思考档位 |
| [用量与成本](用量与成本.md) | usage 采集投影、统计行格式、contextEstimate、窗口指示器与明细 |
| [运行时控制台](运行时控制台.md) | inspect 域协议、观测记录器、JSONL 落盘、控制台窗口 |
| [测试](测试.md) | 三层 project 布局、global-setup、CI 四关、测试原则与跑法 |
