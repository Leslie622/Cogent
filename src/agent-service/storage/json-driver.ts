/**
 * 本地 JSON 存储实现：`<root>/<collection>/<id>.json`，一文档一文件。
 *
 * 形态决策（为什么不是一个大 JSON 或 sqlite）：
 * - 一会话一文件：写放大最小（回合边界只重写本会话文件）、手工可检查
 *   （开发者受众直接翻 ~/.cogent/sessions/ 就是学习材料）、可单文件备份/删除；
 * - 大 JSON 单文件则每次落盘重写全库，长会话场景写放大不可接受；
 * - sqlite 对"文档整体读写"的访问模式是杀鸡牛刀，还引入二进制不可检查性。
 *
 * 信任边界（约定.md §1.1「持久化读取」行）：磁盘旧数据可能损坏/被手改 ——
 * get 校验 JSON 可解析、损坏报错而非静默重建（与 credentials/store.ts 同口径）；
 * 集合名/id 由引擎代码产生（非外部输入），不在驱动层重复校验（边界内裸奔）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { StorageDriver, StoredDocument } from './driver'

export class JsonStorageDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  ids(collection: string): string[] {
    const dir = this.collectionDir(collection)
    if (!existsSync(dir)) return []
    // 文件名即 id（<id>.json）；只收 .json，忽略手工放进来的杂物
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
  }

  get(collection: string, id: string): StoredDocument | null {
    const file = this.documentPath(collection, id)
    if (!existsSync(file)) return null
    // 信任边界：磁盘数据可能损坏（中断写/手改）——报错而非静默重建，
    // 让故障现场暴露给上层
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as StoredDocument
    } catch (error) {
      throw new Error(`存储文档损坏（${file}）: ${(error as Error).message}`)
    }
  }

  put(collection: string, id: string, document: StoredDocument): void {
    const dir = this.collectionDir(collection)
    // 惰性建目录：空库不预创建任何结构，首写才落盘
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(document))
  }

  delete(collection: string, id: string): boolean {
    const file = this.documentPath(collection, id)
    if (!existsSync(file)) return false
    rmSync(file)
    return true
  }

  private collectionDir(collection: string): string {
    return join(this.root, collection)
  }

  private documentPath(collection: string, id: string): string {
    return join(this.root, collection, `${id}.json`)
  }
}
