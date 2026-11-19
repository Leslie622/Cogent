/** 独立解析执行单元；父进程持有超时/取消和输出预算。 */
import { parentPort, workerData } from 'node:worker_threads'
import { parseAttachment, type ParseRequest } from './attachment-parser'

const diagnostics: string[] = []
for (const method of ['log', 'warn'] as const) {
  const original = console[method].bind(console)
  console[method] = (...values: unknown[]) => {
    if (diagnostics.length < 8) diagnostics.push(values.map((value) => String(value)).join(' ').slice(0, 512))
    original(...values)
  }
}

void parseAttachment(workerData as ParseRequest).then(
  (result) => parentPort!.postMessage({ result: { ...result, warnings: [...result.warnings, ...diagnostics] } }),
  (error: unknown) => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
)
