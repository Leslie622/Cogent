# Cogent

基于 **Electron + [pi](https://github.com/earendil-works/pi)** 的桌面 Agent 客户端（React + shadcn/ui）。

架构、目录地图、协作规范与当前路线见 **[AGENTS.md](AGENTS.md)** —— 项目的唯一入口文档。

## 快速开始

```bash
npm install        # 引擎要求系统 Node >= 22.19
npm run dev        # 开发模式（窗口 + 引擎服务）
npm run build      # 产出 out/
npm run typecheck  # 严格类型检查
```

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 31（ESM；Chromium 125 ≥ Tailwind v4 基线 111） |
| Agent 引擎 | 独立 Node 进程（自带官方 node22，`resources/runtime/`）+ [`@earendil-works/pi-*`](https://github.com/earendil-works/pi)（stdio JSON-RPC） |
| 前端 | React 19 + Tailwind CSS v4 + shadcn/ui |
| 构建 | electron-vite 6 + Vite 8，TypeScript 严格模式 |
