# 自带 Node 运行时分发

> 全局架构 D11。落点：`scripts/fetch-runtime.mjs`（构建期下载）、
> `src/electron/main/host/runtime.ts`（三级链定位）、`manager.ts`（经 options 消费）。

## 1. 问题：引擎进程要一个"确定的 Node"，谁来给

桌面 Agent 客户端的引擎（pi）跑在独立 Node 子进程里，三件事互相顶死：

- **pi 硬性要求**：三包（agent-core / ai / coding-agent）engines 全是
  `node >= 22.19.0`（`reference/pi/packages/coding-agent/package.json:95`）；
- **Electron 内置 Node 跟随桌面壳发版**：40.9.3 内置 24.14.1，满足 pi 要求；
  引擎仍独立固定官方 Node 22，避免把桌面壳升级与引擎运行时升级绑在一起；
- **用户机器不可指望**：node 可能没装、装了版本也不受控（PATH 里那个 node
  是给用户的，不是给应用的）。

结论：应用自带一份官方 Node（版本项目 pin），spawn 引擎优先用它；
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
  Cogent 加第三级 `process.execPath`（Electron 自带 Node）。40.9.3 内置 Node 24.14.1
  满足 pi 要求；兜底仍由 manager 握手后的版本守卫检查实际进程，
  不因壳的声明版本而省略检查。
- **改③ tar 选择**：Git Bash 的 MSYS GNU tar 把 `C:\...` 当 `host:path`
  远程语法（"Cannot connect to C:"，本批实测踩坑）；win 上显式用
  `System32\tar.exe`（win10 1809+ 标配 bsdtar，能解 zip，项目基线就是 win10+）。

桌面壳固定 Electron 40.9.3，其[官方支持说明](https://github.com/electron/electron/blob/v40.9.3/README.md#L43-L46)
列出 Ubuntu 18.04 与 Debian 10；构建于 Ubuntu 22.04 不代表发行包要求相同 glibc。
对官方 x64 / arm64 Linux ZIP 按 SHASUMS256.txt 校验后，读取主程序、沙箱、崩溃处理程序
和全部随包共享库的 ELF 版本需求：两架构各 8 个 ELF，最高引用均为 `GLIBC_2.25`，
未出现额外的非数值 GLIBC ABI 版本需求，低于项目 glibc 2.28 目标。
这属于静态二进制证据，不能代替麒麟目标机的系统库、CPU、图形栈与完整应用验收。
Windows 字体渲染边界见[对话内容主题](对话内容主题.md)。

## 5. 在 Cogent 的落点

- `scripts/fetch-runtime.mjs`：pin `22.23.5`；平台映射 win-x64 / linux-x64 /
  linux-arm64（与 runtime.ts 目录名一一对应）；幂等（目标在即跳过，--force 重下）；
  临时目录解包、校验过了才写 `resources/runtime/`（中断不留半成品）。
- `src/electron/main/host/runtime.ts`：三级链
  `COGENT_NODE_BIN > resources/runtime/<平台>/bin/node > process.execPath`；
  纯函数拆分（env / 存在性注入），electron 只在 `resolveEngineNode` 薄壳出现 ——
  `tests/electron/main/host/runtime.test.ts` 无需 mock electron。
- `manager.ts`：经 `options.nodeBin` 消费（不读环境不摸文件，保持零
  electron import）；仅兜底到 execPath 时补设 `ELECTRON_RUN_AS_NODE=1`。
- `.gitignore` 加 `resources/runtime/`（二进制不入库，换机器重跑脚本）。
- 与协议/审批/存储无交集 —— 引擎进程的启动前置件，对它们透明。

## 6. 握手超时如何定位

握手预算为 60 秒，覆盖整个启动链，不能凭超时就认定 Node 版本、杀毒扫描或最近改动是原因。
wrapper 在动态 import 前输出阶段日志，能区分“还没进入 Host 模块”和模块内的
运行时初始化；main 同时输出实际二进制路径，避免只在成功后才能确认运行时来源。
各阶段使用 `process.uptime()` 的累计时间，输出走 stderr，保留 stdout 的协议边界。
最后收到的阶段只是等待区间的证据，不是更细粒度根因的证明。

对照 pi：`reference/pi/packages/coding-agent/src/core/model-runtime.ts:218`
的 `ModelRuntime.create` 先读模型配置，再初始化运行时并等待 refresh；`:252`
仅在 `allowModelNetwork === true` 时开启目录网络刷新。Cogent 未传该开关，不能
把 create 的等待直接解释成远程目录下载。模型缓存读取经
`reference/pi/packages/coding-agent/src/core/models-store.ts:75` 走文件锁，
其等待与过期窗口在 `core/auth-storage.ts:122` 是 30 秒；这说明需检查锁路径，
不说明每次启动都会等待该锁。只有实际阶段与复现证据吻合，才能据此归因。

收尾由 HostManager 拥有：握手失败 → 终止子进程 → 拒绝并发请求 → failed。
拒绝信息携带原始原因，避免一串无上下文的 `host closed` 掩盖首个错误。

## 7. 首次安装的依赖加载

未合并的 ESM 入口会实际加载再导出的模块图；pi 根入口包含 CLI 与交互模式
（`reference/pi/packages/coding-agent/src/index.ts:421`、`:439`），不能拿 Host
业务 chunk 的大小代表完整启动成本。新文件路径探针曾复现约 42 秒握手，
其中约 35.7 秒停在静态依赖阶段；另一次文件 trace 中同步 open 累计约 10 秒，
紧接着重启相同操作约 75ms。这确认了冷文件打开负担，不足以证明底层等待者就是 Defender。

Cogent 在既有 main 构建中合并 coding-agent 与 TypeBox，pi-ai/厂商 SDK 和需独立
定位资源的包保留 external。源码中的 `import.meta.url` 在合并前改为通过公开
SDK 入口定位的原文件 URL；`__filename/__dirname` 局部变量另名，避免与构建器
的 CJS shim 重名。对照 `reference/pi/packages/coding-agent/src/config.ts:418`
的包根定位、`core/extensions/loader.ts:72` 的扩展别名，以及
`utils/image-resize.ts:92` 的 worker URL，合并代码不能顺带把这些资源锚点搬到 out/。
原 SDK 包与资源仍须随应用分发，并非生成完全独立的单文件引擎。

可选厂商预热使用 setImmediate 排在握手响应的 Promise 续段之后；不提前宣布就绪，
也不把所有首消息优化删除。60 秒是外部冷文件等待的有限预算，进程 error/exit
仍立即失败，不等预算耗尽。测试分别验证超出旧窗口仍成功、真实错误立即失败、
新目录复制的真实依赖首次启动，以及图片实际经过原包 worker，不能只测热缓存。
