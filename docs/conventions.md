# 硬规则 — Cogent

写代码前必读。违反本文件的改动直接打回。

## 1. 防御代码政策（对 AI 作者的行为规则，不是描述性条文）

**背景**：AI 生成代码的默认倾向是"处处设防"——因为 AI 不掌握项目的契约与信任边界，
就用防御性写法对冲未知。本节补齐这个信息：**边界在哪里；边界之外必须裸奔**。

**原则：防御只写在信任边界上；边界内信任类型、快速失败（fail-fast）。**

### 1.1 信任边界表（唯一的合法设防位置）

| 边界 | 做法 |
| --- | --- |
| IPC（renderer 不可信） | 每个 `ipcMain.handle` 入口校验参数形状，越界即抛 |
| stdio 帧（跨进程/外部实现） | 逐行 JSON 解析 + `isRpcRequest` 守卫 + handler 入口显式收窄参数 |
| 外部世界（spawn 的 Node、LLM API、工具结果、网络） | 失败是常态：处理并给出可诊断信息，握手类操作设超时 |
| 持久化读取（磁盘旧数据） | 校验版本与形状，损坏数据报错而非静默重建 |

不在这张表上的位置，一个防御词都不许出现。

### 1.2 AI 高频反模式（出现即删，无一例外）

```ts
// ✗ 1. 吞错返回默认值 —— 掩盖故障，调用方拿到假成功
try { await save(session) } catch { return null }
// ✓ 边界内不捕获：让它炸，由最外层边界统一翻译
await save(session)

// ✗ 2. 对类型已保证的参数做存在性检查 —— 永远不会真触发的死分支
function send(text: string) {
  if (!text) throw new Error('text required') // text 非 optional，这行是摆设
}
// ✓ 信任签名；真正不可信的 text 在 IPC 入口校验一次就够

// ✗ 3. 长链可选访问 —— 内部对象关系由类型保证
const name = session?.owner?.profile?.name ?? 'unknown'
// ✓ 直接访问，链上任何一环真可能缺失时改的是类型，不是这里
const name = session.owner.profile.name

// ✗ 4. catch-log-rethrow —— 同一错误翻译两遍，日志重复堆栈污染
catch (error) { console.error('failed', error); throw error }
// ✓ 只在最外层边界 catch 一次

// ✗ 5. 对自家常量/配置做 typeof 校验
if (typeof PROTOCOL_VERSION !== 'number') { /* ... */ }
// ✓ 删

// ✗ 6. 兜底默认值掩盖非法状态 —— mode 越界时静默变成 'auto'
const mode = allowedModes.includes(mode) ? mode : 'auto'
// ✓ 越界直接 throw，让 bug 现场爆炸
```

### 1.3 产出义务（写代码时逐条执行，不是建议）

1. **举证责任反转**：每写一个 `try` / if 守卫 / `??` / `?.`，先回答
   "它防的是 1.1 表格里的哪一行、什么场景"——答不出来就不写。
2. **照抄示范位**：边界处的防御形状以 `agent-service/index.ts` 的 dispatch 为准
   （入口解析 + 守卫 + 显式收窄；handler 内零防御），不自创姿势。
3. **交付自检**：完成标准 = `lint` / `typecheck` / `build` 三关全绿
   **+ 对 diff 过一遍 1.2 反模式清单**。
4. **错题本**：review 抓到的每一起过度防御，回填为 1.2 的新条目（带坏例代码）。
   本政策只允许这样增长——让每次违规都变成下不为例的教材。

### 1.4 为什么 ESLint 兜不了底

`no-unnecessary-condition` 只能抓类型系统层面的冗余判断；吞错、默认值掩盖、
语义性防御机器判不出来。lint（已接入）只是下限，治理主体是 1.3 的
**指令（事前）+ 自证（事中）+ 错题本（事后）**——没有任何单点手段，
三层叠加让 AI 的"防御漂移"容易被发现、发现了有记录。

## 2. 协议纪律（src/protocol/）

- method / event 名一经发布不可改名、不可删；字段只增 optional；
- 破坏性变更必须递增 `PROTOCOL_VERSION`；
- 零运行时依赖：只放类型、常量、纯函数。

## 3. 其他约定

- **注释**：解释"为什么"与"边界"，不复述代码；每个文件头部一段说明它在架构中的
  位置与关键决策；中文注释（项目既定风格）。文档引用一律指向 `docs/` 具体文件。
- **preload**：只暴露显式白名单方法，禁止转发任意 channel。
- **渲染层**：不感知 pi 与协议细节，只消费 `shared/` 的壳契约与 main 转发后的事件。
- **shadcn 组件**：用时按需 `npx shadcn@latest add <component>`，不预先堆料。
