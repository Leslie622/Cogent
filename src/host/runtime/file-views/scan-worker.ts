/** 独立目录 worker；错误回请求方，诊断不得混入 Host JSON-RPC stdout。 */
import { parentPort } from 'node:worker_threads'
import { FileScanEngine, type ScanRequest } from './scan-engine'
const engine = new FileScanEngine()
const active = new Map<string, AbortController>()
let queue = Promise.resolve()
parentPort!.on('message', (message: { id: string; request?: ScanRequest; cancel?: boolean }) => {
  if (message.cancel) { active.get(message.id)?.abort(); return }
  const controller = new AbortController(); active.set(message.id, controller)
  queue = queue.then(() => engine.run(message.request!, controller.signal)).then(
    (result) => parentPort!.postMessage({ id: message.id, result }),
    (error: unknown) => parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  ).finally(() => { active.delete(message.id) })
})
