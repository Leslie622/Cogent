# 自带 Node 运行时分发

> 全局架构 D11 / 阶段 0 第一批。落点：`scripts/fetch-runtime.mjs`（构建期下载）、
> `src/electron/main/service/runtime.ts`（三级链定位）、`manager.ts`（经 options 消费）。

## 1. 问题：引擎进程要一个"确定的 Node"，谁来给

桌面 Agent 客户端的引擎（pi）跑在独立 Node 子进程里，三件事互相顶死：

- **pi 硬性要求**：三包（agent-core / ai / coding-agent）engines 全是
  `node >= 22.19.0`（`reference/pi/packages/coding-agent/package.json:95`）；
- **Electron 内置 Node 不受控**：版本绑死发版周期 —— 45 内置 24.x（恰好达标），
  目标版 31 内置 20.15（不达标）。"升不升 Electron"不能变成"引擎能不能跑"的开关；
- **用户机器不可指望**：node 可能没装、装了版本也不受控（PATH 里那个 node
  是给用户的，不是给应用的）。

结论：应用自带一份官方 Node（版本项目 pin），spawn 引擎永远用它；
git / python 不随包（系统提供）—— zcode 与 Pi-meme 同口径。

## 2. pi 的做法：不分发，把义务丢给宿主

pi 是 npm 包，没有运行时分发代码。它的姿势是 engines 声明 + 拒绝在低版本上
跑 —— 对 CLI 用户（开发者，本机必有 node）合理；对桌面客户端不成立：终端用户
没有"宿主 Node"这个概念。所以这个主题 pi 只提供了约束（≥22.19），方案要看
分发型前代怎么做。

## 3. 对比：分发型 Agent 的运行时纪律

| | 带什么 | 校验 | 出处 |
| --- | --- | --- | --- |
| Pi-meme | 自带 node 24.14.0（pin 精确版） | SHASUMS256.txt 抽期望值 → 本地 sha256 assert 相等 | `scripts/release.mts:25`、`scripts/node-runtime.mts:26-33` |
| zcode | 不带 Node（engines ≥24，宿主自带）；bfs/ripgrep/ugrep 三件工具带 | sha256 硬编码清单 + 下载后 createHash 比对 + 64hex 格式校验 + 落盘 marker 复核 | `apps/zcode-cli/packages/cli/src/sea-runtime-tools.ts:123-124,201,226` |
| dsh | 单文件 bundle + 宿主 Node，不带 | 无运行时校验（engines ≥24.9 声明了事） | package.json engines |

Pi-meme 是直接参照，细节纪律四条全部照抄：① pin 精确版本（升级只改一处）；
② 从官方 SHASUMS256.txt 抽当前归档的期望 sha256（并校验它本身是 64hex），
不手抄 hash 进仓库；③ 解压后只拷 `bin/node(.exe)` + LICENSE —— 不带
npm/corepack（引擎是打包产物，依赖在应用 node_modules，用不到包管理器）；
④ 写 runtime.json（版本/平台/归档/sha256）落诊断清单，打包期还断言实际
运行时与 pin 一致（`release.mts:161`）。

## 4. 取舍：Cogent 哪些照抄、哪些改

- **照抄**：四条纪律全收（见上）。
- **改① 镜像源**：Pi-meme 只用官方源 + `redirect: 'error'`；Cogent 加
  `NODE_DIST_MIRROR`（国内 npmmirror）。镜像靠 302 跳 CDN 工作，redirect
  只能 follow —— 完整性不靠重定向策略把关，靠 SHA256 对官方清单，安全性不降。
- **改② 兜底链**：Pi-meme 没有兜底（缺运行时 = 分发 bug，打包期断言）；
  Cogent 加第三级 `process.execPath`（Electron 自带 Node）。已降 Electron 31
  （内置 Node 20.15 < 22.19）：兜底级不再达标，缺自带 runtime 时由 manager
  握手后的版本守卫明确报错，链路不静默降级。
- **改③ tar 选择**：Git Bash 的 MSYS GNU tar 把 `C:\...` 当 `host:path`
  远程语法（"Cannot connect to C:"，本批实测踩坑）；win 上显式用
  `System32\tar.exe`（win10 1809+ 标配 bsdtar，能解 zip，项目基线就是 win10+）。

## 5. 在 Cogent 的落点

- `scripts/fetch-runtime.mjs`：pin `22.23.5`；平台映射 win-x64 / linux-x64 /
  linux-arm64（与 runtime.ts 目录名一一对应）；幂等（目标在即跳过，--force 重下）；
  临时目录解包、校验过了才写 `resources/runtime/`（中断不留半成品）。
- `src/electron/main/service/runtime.ts`：三级链
  `COGENT_NODE_BIN > resources/runtime/<平台>/bin/node > process.execPath`；
  纯函数拆分（env / 存在性注入），electron 只在 `resolveEngineNode` 薄壳出现 ——
  co-located 测试（runtime.test.ts，7 断言）无需 mock electron。
- `manager.ts`：经 `options.nodeBin` 消费（不读环境不摸文件，保持零
  electron import）；仅兜底到 execPath 时补设 `ELECTRON_RUN_AS_NODE=1`。
- `.gitignore` 加 `resources/runtime/`（二进制不入库，换机器重跑脚本）。
- 与协议/审批/存储无交集 —— 引擎进程的启动前置件，对它们透明。
