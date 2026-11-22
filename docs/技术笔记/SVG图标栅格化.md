# SVG图标栅格化

SVG 保存矢量几何，最终显示仍需栅格化。图标变大后边缘仍有阶梯，不能只用
小尺寸或分数 DPR 解释，也不能从一个搜索图标外推整套图标库的质量。
当前启动策略归[设置页](../模块/设置页.md)，视觉配方归[UI布局](../UI布局.md)。

## 同几何与渲染路径对照

Tabler `node_modules/@tabler/icons-react/dist/esm/icons/IconSearch.mjs:11`
用两段圆弧 path 绘制圆；Lucide
`node_modules/lucide-react/dist/esm/icons/search.mjs:15` 使用 circle。
保留各自的圆心、半径、描边与位置，仅互换 circle / 圆弧 path，当前 GPU
渲染下 circle 的边缘更平滑；这只是该几何样本的结果。

独立 Electron 页面直接渲染两库导出的搜索、设置、时钟、文件夹、主页、拼图、
聊天、圆形、方形与斜箭头，不加载 Cogent CSS。尺寸覆盖 16 / 24 / 32 / 48 /
64 / 96 / 128px；Electron 40.9.3、Windows、本机 DPR 1.3125，并另测 DPR 1。
多个 Tabler 路径在大尺寸仍有阶梯，Lucide 的复杂路径也受影响。

| 启动模式 | rasterization | gpu_compositing | 本机观察 |
| --- | --- | --- | --- |
| Chromium 默认 | enabled | enabled | 多个路径边缘粗糙 |
| 仅 `disable-gpu-rasterization` | disabled_software | enabled | 同一批路径明显平滑 |
| `disableHardwareAcceleration()` | disabled_software | disabled_software | 同一批路径明显平滑 |

`shape-rendering: geometricPrecision` 未消除本机问题。当前证据把问题定位到
GPU 栅格化路径，尚不能区分更深层的 Chromium、ANGLE 或驱动原因。
诊断图片与原始样本位于 `tmp/icon-render-comparison/`；这些是本机证据，不代表
所有显卡、操作系统与 Electron 版本均有相同表现。

## 同主题源码对照与取舍

- zcode `reference/zcode/packages/desktop/src/main/desktopChromiumHardwareAccelerationBootstrap.ts:44–56`
  在主进程启动早期读取设置，关闭时调用 `disableHardwareAcceleration()`；
  `reference/zcode/docs/desktop/chromium-hardware-acceleration-setting.md:9–14`
  规定默认开启、修改后重启，属于硬件加速总开关。
- 随 reference 提供的 Electron 文档
  `reference/zcode/docs/electron/docs/api/app.md:1232–1236` 明确此 API 必须在 ready 前调用。
- Cogent 保留总开关，在 Windows 启动期额外使用已实测的窄开关，将栅格绘制交给 CPU，
  GPU 合成仍可用；不通过替换图标库、修改 SVG 路径或调淡图标掩盖渲染差异。

CPU 栅格化会增加 CPU 绘制工作，不能宣称没有性能代价。非 Windows 平台没有应用
该策略；跨设备性能、其他显卡和其他平台仍需对应环境验证。

## 生产构建验证

`node scripts/check-svg-rendering-electron.mjs` 使用独立存储与 profile，加载真实生产
main / preload / Host，并分别以硬件加速开启、关闭启动。检查实际 GPU feature status，
保存真实侧栏和十种 SVG 在多种尺寸下的截图，不以启动参数字符串代替实际结果。
图片、状态与 renderer 错误记录写入 `tmp/svg-rendering-electron/`；运行前先构建。
