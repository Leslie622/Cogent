/** 构建产物中的真实 worker 能找到解析器依赖/离线资源，且取消可结束。 */
import { afterEach, describe, expect, it } from 'vitest'
import { resolve, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { parseInWorker } from '../../src/host/runtime/read-attachment'

const sample = (name: string) => resolve('tests/fixtures/附件兼容', name)
const roots: string[] = []
const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function parse(path: string, name: string, extra: { cursor?: number; sheet?: string; range?: string } = {}): Promise<{ result?: { text: string; warnings: string[] }; error?: string }> {
  return new Promise((done, reject) => {
    const worker = new Worker(resolve('out/main/attachment-worker.js'), { workerData: { path, name, cursor: 0, ...extra }, stdout: true, stderr: true })
    workers.push(worker); worker.once('message', done); worker.once('error', reject)
  })
}
describe('附件 worker 构建产物', () => {
  it('两份解析占用时排队可取消，运行中的 worker 也可停止', async () => {
    const previous = process.env.COGENT_ATTACHMENT_WORKER
    process.env.COGENT_ATTACHMENT_WORKER = resolve('out/main/attachment-worker.js')
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const request = { path: sample('中文离线映射.pdf'), name: 'a.pdf', cursor: 0 }
    try {
      const jobs = controllers.map((controller) => parseInWorker(request, controller.signal))
      const settled = Promise.allSettled(jobs)
      await Promise.resolve()
      controllers[2].abort(); controllers[0].abort(); controllers[1].abort()
      const outcomes = await settled
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected'])
      const last = outcomes[2]; expect(last.status === 'rejected' && String(last.reason)).toContain('排队')
    } finally {
      if (previous === undefined) delete process.env.COGENT_ATTACHMENT_WORKER
      else process.env.COGENT_ATTACHMENT_WORKER = previous
    }
  })
  it('PDF 中文离线资源与 Office 依赖可从构建目录加载', async () => {
    const pdf = await parse(sample('中文离线映射.pdf'), '中文.pdf')
    expect(pdf.error).toBeUndefined(); expect(pdf.result?.text).toContain('宋体')
    const pptx = await parse(sample('通用关系与绝对路径.pptx'), '通用关系.pptx')
    expect(pptx.error).toBeUndefined(); expect(pptx.result?.text).toContain('幻灯片 1 / 2')
  })
  it('损坏文档结构化报错，不写出假成功', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cogent-worker-test-')); roots.push(root)
    const path = join(root, 'bad.pdf'); writeFileSync(path, 'bad pdf')
    expect((await parse(path, 'bad.pdf')).error).toBeTruthy()
  })
  it('构建后读取真实命名空间XLSX和通用关系PPTX，保留公式缓存与备注', async () => {
    const xlsx = await parse(sample('命名空间前缀.xlsx'), '命名空间前缀.xlsx', { sheet: '销售', range: 'A1:C3' })
    expect(xlsx.error).toBeUndefined(); expect(xlsx.result?.text).toContain('C2: 公式=B2*F2；缓存=42')
    const pptx = await parse(sample('通用关系与绝对路径.pptx'), '通用关系.pptx', { cursor: 1 })
    expect(pptx.error).toBeUndefined(); expect(pptx.result?.text).toContain('NOTE-B28-5927')
  })
})
