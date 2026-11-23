# Cogent 架构地图

交互式目标架构图。总览、接入和执行共用同一 LikeC4 模型，节点标明对应能力的完成度。
按源码查当前调用关系和进程边界，见[当前架构](../架构.md)。按任务查代码与测试，见[模块索引](../模块/索引.md#按任务追链)。

图从左侧入口开始，可拖动画布或用「适应画布」查看全图。服务层和执行能力可进入细图，
再回到来路。窄屏点选模块直接打开说明，Esc 返回画布。「来源」区按实现、模块与架构、验收、目标与计划分组，链接指向公开仓库。布局与状态见[架构地图模块](../模块/架构地图.md)。

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
修改结构与关系从[模型](模型/架构.c4)开始，修改说明、能力状态与细图入口从[模块说明](src/模块说明.ts)开始。
几何与关系投影在[布局适配](src/布局适配.ts)，选型与源码对照见[技术笔记](../技术笔记/架构地图.md)。

开发、构建与测试前会自动生成 LikeC4 官方布局快照，目录为 `模型/.likec4/`，不入库。
总览的行列和主链权重在 `scripts/layout-architecture.mjs` 维护；开发期间修改模型后，
可执行 `npm --prefix docs/架构地图 run layout` 重新排布。脚本不维护坐标或手写连线。
