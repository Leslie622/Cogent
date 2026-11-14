# webview 页面接入 —— 凭证传递与 SDK 暴露面

> 阶段 3a（2026-11-15）：demo 页最小闭环。代码落点见
> [../模块/内嵌页面.md](../模块/内嵌页面.md)。

## 1. 问题

HostApi 的消费者里有"不可信页面"：第三方 HTML 想驱动本地 Agent，但它
不能拿进程权限（im2.0 的 `window.native` 把 accessToken 和进程级 IPC 一起
漏给页面），也不能拿长期凭证（页面可被 XSS）。核心问题：**凭证怎么给到
"够用但拿不走"，权限怎么定到"页面级"**。

## 2. pi 的做法

pi 无桌面壳（CLI/RPC 进程协议），不存在页面接入问题 —— 这一层完全是
Cogent（壳）的职责，参照对象是 zcode / Pi-meme / im2.0。

## 3. 对比（三家 + 教训源）

| | 页面跑在哪 | 凭证传递 | 页面拿到什么 | 出处 |
|---|---|---|---|---|
| **zcode** | `<webview>` + 自定义协议 origin（`zcode-sandbox://`，origin 即边界） | main 签 lease（instance token 留宿主进程，`McpAppInstance` 四元组 + generation 撤销）；MessagePort 中转，页面不持任何 token | 注入式 SDK（`window.zcode`，官方 `@modelcontextprotocol/ext-apps` App + PostMessageTransport）；guest preload **明确不暴露任何 contextBridge API** | `reference/zcode/packages/desktop/src/main/pluginSandbox/guestPolicy.ts:24-58`（will-attach-webview 硬化）、`protocol.ts:25-28`（origin 边界）、`alias.ts:1-45`（SDK） |
| **Pi-meme** | 主窗口 host UI + 浏览器 tab（WebContentsView） | 远程模式 token 由 main 经 `POST /api/auth` 换 **session cookie**，成功后页面内存清空 token（`connection.token = ''`） | preload 白名单对象 `window.piPlatform`（browser/storage/连接管理，无 token getter）；第三方内容 view **不挂 preload** | `reference/Pi-meme/apps/desktop/src/preload/preload.ts:5-32`、`packages/client/src/host-client.ts:331-367`（cookie 换取 + token 清空） |
| **im2.0（教训）** | Electron `<webview>`（远程页面） | accessToken 放 **URL query**；preload `window.native` 暴露进程级 IPC | 页面拿到 key 明文 + 任意 native 调用（越权面失控） | 老项目复盘（全局架构 §7） |
| **Cogent** | `<webview>` 沙箱（will-attach-webview 硬化）+ 同源 demo 页白名单 | main 签一次性票据（30s 即焚）→ preload 内换 token（**不出 isolated world**）→ 页面只见 `request/onEvent` | `window.cogentHost` 三函数；票据/token 页面全局均摸不到 | `src/electron/main/webview-policy.ts`、`src/shared/guest-sdk.ts` |

## 4. 取舍

- **直连 vs 中转（与 zcode 的根本分歧）**：zcode 页面经 MessagePort 中转
  （凭证零出壳，代价是 main 承担全部流量与 lease 生命周期）；Cogent 页面
  **直连** HTTP/WS 门（阶段 2 建的门就是为这个消费者，省一层中转；凭证
  暴露面用"一次性票据 + preload 内存 token"压到最小）。两者共享的底座
  是 will-attach-webview 硬化 —— Cogent 逐条照抄 zcode guestPolicy 的
  删改清单（nodeIntegration/webviewTag/enableBlinkFeatures… + 强制
  sandbox/contextIsolation/webSecurity + preload 覆写）。
- **沙箱 preload 必须单文件 CJS**：沙箱 preload 的 require 只认 `electron`
  （无文件系统、无 ESM）—— 双入口共享 `shared/ipc.ts` 时 rollup 拆出
  相对路径 chunk，沙箱下直接炸。修法 = guest 入口内联 channel 常量
  （type-only import 不影响拆包）。主 preload（sandbox:false）同段转 CJS
  无碍（Electron 非沙箱 preload 两种格式都支持）。
- **src 白名单起步就锁死**（3a 仅同源 demo.html）：硬化钩子先于页面接入
  存在，扩展真实第三方页面时只改白名单与 origin 策略（自定义协议 origin
  = zcode 形状，候选），不重开边界。
- **preload 的 fetch 两个坑（首验实录）**：① `fetch` 以引用传给 SDK 后
  `this` 不再是 window → `Illegal invocation`，必须 `fetch.bind(globalThis)`；
  ② isolated world 以页面 origin 发请求，`127.0.0.1` 永远跨源 → Host 必须回
  CORS 头（否则浏览器拦响应）。两者都只有真 webview 验收能暴露 —— node
  侧测试的 fetch 不执行浏览器同源策略，也不检查 this 绑定。
- **scope 全 guest 统一 write**（3a）：比 admin 低（拿不到签发权）、比
  readonly 高（demo 要发起对话）；session 绑定档等真实页面生态出现再落。

## 5. 在 Cogent 的落点

- `src/electron/main/webview-policy.ts`：`will-attach-webview` 硬化 +
  src 白名单（zcode guestPolicy 精简版）；
- `src/electron/main/ipc/guest.ts`：凭证 IPC（sender 类型校验 + 签发）；
- `src/electron/preload/guest.ts`（guest.cjs）：contextBridge 三函数；
- `src/shared/guest-sdk.ts` + `guest-sdk.test.ts`（6 用例）：票据换 token /
  Bearer 请求 / WS 事件分发的纯逻辑；
- `src/renderer/public/demo.html`：验收载体（列会话/发起对话/收事件流）；
- 入口链：AppHeader 按钮 → `ipc/embedded.ts`（独立窗口 + webviewTag）→
  hash `#embedded` → `EmbeddedDemo.tsx`。
