/**
 * 观测记录落盘（inspect 域持久化，2026-11-10）—— 追加式 JSONL。
 *
 * 为什么不走 StorageDriver：文档集合接口是"整文档读写"（与 sessions 转录同
 * 模式，回合边界整写），而观测记录是逐条高频产生 —— 逐条 append 才没有写
 * 放大；裁剪（文件超限重写尾部）只在低频阈值触发。文件布局：
 * `<存储根>/inspect/<sessionId>.jsonl`，一行一条 `{e: 摘要, d?: 详情}`。
 *
 * 动机（用户报告"这个会话是有纪录的啊"）：此前观测只存引擎内存，应用重启
 * 即清零 —— 聊天转录有落盘而观测没有，控制台对"明明聊过的会话"显示 0 条。
 * 落盘后：重启回看最近记录，seq / run 编号接续历史（新 run 不从 #1 重来）。
 *
 * 尽力语义（同 inspector 记录、session persist）：落盘/读取/裁剪失败只记
 * stderr，绝不影响对话主路径 —— 观测数据的可靠性等级低于对话本身。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InspectEntryDetail, InspectEntrySummary } from '../../protocol'

/** 落盘行（摘要必有，详情仅有存档的条目才带） */
export interface InspectRecord {
  e: InspectEntrySummary
  d?: InspectEntryDetail
}

/** 载入/保留的尾部行数（对齐 inspector 摘要环 500 —— 盘上留的不少于内存能装的） */
const MAX_LINES = 500
/** 行数超过此值触发裁剪重写（余量 2.4×，避免每次 load 都重写） */
const TRIM_AT = 1200

export class InspectStore {
  private dir: string

  constructor(root: string) {
    this.dir = join(root, 'inspect')
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`)
  }

  append(sessionId: string, record: InspectRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file(sessionId), `${JSON.stringify(record)}\n`)
    } catch (error) {
      process.stderr.write(`[agent-service] inspect 落盘失败（${sessionId}）: ${(error as Error).message}\n`)
    }
  }

  /**
   * 尾部记录（原顺序 = seq 升序）。磁盘是信任边界（约定.md §1.1 持久化读取行）：
   * 坏行跳过并计数（不静默重建整文件），整文件读失败按"无记录"处理 ——
   * 观测是诊断数据，损坏降级可见即可，不值得挡会话启动。
   */
  load(sessionId: string): InspectRecord[] {
    const file = this.file(sessionId)
    if (!existsSync(file)) return []
    try {
      const lines = readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim() !== '')
      const records: InspectRecord[] = []
      let bad = 0
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Partial<InspectRecord>
          // 第二个条件不需要 ?.：第一个为假时（seq 是 number）e 已被收窄为非空
          if (typeof record.e?.seq !== 'number' || typeof record.e.kind !== 'string') {
            throw new Error('行形状不合法')
          }
          records.push(record as InspectRecord)
        } catch {
          bad += 1
        }
      }
      if (bad > 0) {
        process.stderr.write(`[agent-service] inspect 损坏行已跳过（${sessionId} ×${bad}）\n`)
      }
      const tail = records.length > MAX_LINES ? records.slice(-MAX_LINES) : records
      if (records.length > TRIM_AT) this.rewrite(sessionId, tail)
      return tail
    } catch (error) {
      process.stderr.write(`[agent-service] inspect 读取失败（${sessionId}，按无记录处理）: ${(error as Error).message}\n`)
      return []
    }
  }

  /** 会话删除时连带清理（rmSync force：无文件 = 本就干净） */
  delete(sessionId: string): void {
    try {
      rmSync(this.file(sessionId), { force: true })
    } catch (error) {
      process.stderr.write(`[agent-service] inspect 清理失败（${sessionId}）: ${(error as Error).message}\n`)
    }
  }

  /** 裁剪重写：保留尾部 MAX_LINES 行（引擎是唯一写者，整写同会话转录的既有取舍） */
  private rewrite(sessionId: string, records: InspectRecord[]): void {
    try {
      writeFileSync(this.file(sessionId), records.map((r) => `${JSON.stringify(r)}\n`).join(''))
    } catch (error) {
      process.stderr.write(`[agent-service] inspect 裁剪重写失败（${sessionId}，下次超限再试）: ${(error as Error).message}\n`)
    }
  }
}
