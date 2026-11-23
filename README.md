# Cogent

基于 Electron + pi 的本地优先桌面 Agent 客户端。[pi 源码](https://github.com/earendil-works/pi)

参与开发从 [AGENTS.md](AGENTS.md) 开始。查当前进程边界看[架构](docs/架构.md)，
按任务定位源码和验证看[模块索引](docs/模块/索引.md#按任务追链)，查看后续接线看[交互式目标图](docs/架构地图/README.md)。

## 快速开始

本地开发建议使用与 CI 一致的 Node 24。

```bash
npm ci
npm run dev
```

构建产物在 `out/`。运行完整本地检查还需安装架构地图的依赖，步骤见[测试](docs/模块/测试.md)。
