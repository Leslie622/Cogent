# Cogent 架构地图

正式架构页面，与主仓库一起维护，独立构建。侧边栏只有「架构总览」。
UI 复用仓库 `base-nova` shadcn 组件与字体，使用中性色。左侧导航、中央画布、右侧说明，
左右侧栏可独立折叠。画布包含总览、接入、执行三个横向视图，节点标明能力状态；
默认从左侧开始，以可读字号显示，拖动横向阅读，点击「适应画布」查看全图。

在仓库根目录执行，首次使用先安装根项目依赖：

```powershell
npm ci
npm --prefix docs/架构地图 ci
npm --prefix docs/架构地图 run dev
```

生成可离线双击打开的单文件页面：

```powershell
npm --prefix docs/架构地图 run build
```

产物为 [dist/index.html](dist/index.html)。字体也嵌入文件，不需要外部服务。
`dist/` 与 `node_modules/` 均不入库；页面展示内容不连接实际 Host。

检查命令：

本项目也参与[根目录与 CI 检查](../模块/测试.md)，须先完成上面的两处依赖安装。

```powershell
npm --prefix docs/架构地图 run lint
npm --prefix docs/架构地图 run typecheck
npm --prefix docs/架构地图 test
npm --prefix docs/架构地图 run test:browser
```

浏览器检查使用本机 Chrome，将截图存入仓库 `tmp/架构地图验收/`，退出时关闭浏览器。
修改结构、关系与视图从 [模型/架构.c4](模型/架构.c4) 开始；修改说明、能力状态和细图入口从
[src/模块说明.ts](src/模块说明.ts) 开始。LikeC4 负责布局与正交路径，React Flow 读取布局数据，
共享 shadcn 负责节点与控件。当前使用自定义数据适配，不是 LikeC4 官方图组件。机制与维护边界见
[模块文档](../模块/架构地图.md)，选型依据见[技术笔记](../技术笔记/架构地图.md)。
