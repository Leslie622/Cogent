/**
 * 存储抽象层 —— 「本地优先」架构决策（docs/架构.md §1）的落点：
 * 引擎经此接口读写持久状态，不直接碰文件系统；将来接云存储只换实现，业务零改动。
 *
 * 模型刻意选「文档集合」而不是通用 KV：
 * - 我们的持久域就是两类一形数据：sessions/<id>.json、（第 4 步）projects/<id>.json，
 *   集合 + id 的形状刚好覆盖，接口面最小；
 * - 单文件单文档（一会话一文件）：读写互不牵连、手工可检查可备份 —— 对齐
 *   Claude Code / Codex 的会话文件形态（对比见 docs/技术笔记/session-storage.md）。
 *
 * 边界纪律：StorageDriver 是引擎进程内的抽象，实现只依赖 node:fs ——
 * 零 Electron import（目录即边界，同 runtime/）。存储根由构造方注入
 * （index.ts：COGENT_HOME ?? ~/.cogent，见计划第 2 步），本层不解析环境变量，
 * 便于冒烟测试指临时目录。
 */

/**
 * 文档载荷的接口面：get/list 返回"未知 JSON"，由调用方收窄成领域形状。
 * 独立别名（而非直接 unknown）承载"这里是信任边界转换点"的语义；
 * 存储实现是引擎自有代码，集合名/id 由引擎产生，驱动层不做形状校验。
 */
export interface StoredDocument {
  [key: string]: unknown
}

/**
 * 存储驱动接口：文档集合的 CRUD。
 * 语义约定：
 * - get/list 对"不存在"返回 null/[]（首次启动空库是常态，不是错误）；
 * - put 是整文档覆盖写（无 patch 语义）——会话转录本就是全量替换；写法为
 *   原子替换（临时文件 + rename），进程崩溃/断电不会留下截断的半文件；
 * - delete 对不存在的 id 返回 false（幂等），存在且删除返回 true；
 * - quarantine：把损坏文档改名旁置（<id>.json → <id>.json.corrupt），供启动
 *   恢复"逐文件隔离"用 —— 单文件损坏只损失该文件，不炸整个引擎启动；
 * - 同步 API：本地 JSON 的读写是毫秒级，异步化只会把调用方拖进无谓的 Promise 链。
 */
export interface StorageDriver {
  /** 集合内全部文档 id（不含内容；列表页只要摘要时避免整库加载） */
  ids(collection: string): string[]
  /** 单文档读取；不存在返回 null */
  get(collection: string, id: string): StoredDocument | null
  /** 整文档覆盖写（文件不存在则创建；父目录惰性创建） */
  put(collection: string, id: string, document: StoredDocument): void
  /** 删除文档；返回是否真的删了（不存在 = false） */
  delete(collection: string, id: string): boolean
  /** 损坏文档旁置（启动恢复隔离用）；返回是否真的改名了（不存在 = false） */
  quarantine(collection: string, id: string): boolean
}
