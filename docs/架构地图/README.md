# Cogent 架构地图

正式架构页面，与主仓库一起维护，独立构建。侧边栏只有「架构总览」。
UI 复用仓库 `base-nova` shadcn 组件与字体，使用中性色。左侧导航、中央画布、右侧说明，
左右侧栏可独立折叠。总览保留 Host 大框，服务层与能力总线在框内显示摘要，点击进入各自的详细视图，
并可返回总览。KernelRunner 是包含 PiSdkKernel 与其他内核的执行容器；Node 运行时和安全边界随容器文字说明。
接入和执行视图保留作局部阅读，节点标明能力状态；
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

浏览器检查默认使用本机 Chrome；可通过 `COGENT_BROWSER_CHANNEL=msedge` 选择已安装的 Edge。
截图存入仓库 `tmp/架构地图验收/`，退出时关闭浏览器。
修改结构、关系与视图从 [模型/架构.c4](模型/架构.c4) 开始；修改说明、能力状态和细图入口从
[src/模块说明.ts](src/模块说明.ts) 开始。LikeC4 负责布局与正交路径，React Flow 读取布局数据，
共享 shadcn 负责节点与控件。当前使用自定义数据适配，不是 LikeC4 官方图组件。机制与维护边界见
[模块文档](../模块/架构地图.md)，选型依据见[技术笔记](../技术笔记/架构地图.md)。

开发、构建与测试前会自动生成 LikeC4 官方布局快照，目录为 `模型/.likec4/`，不入库。
总览的行列和主链权重在 `scripts/layout-architecture.mjs` 维护；开发期间修改模型后，
可执行 `npm --prefix docs/架构地图 run layout` 重新排布。脚本不维护坐标或手写连线。
