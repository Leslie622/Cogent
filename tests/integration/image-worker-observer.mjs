/** 只观测真实图片 worker 的结果，防止 SDK 打包后静默回退到主线程。 */
import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'

const ActualWorker = workerThreads.Worker
workerThreads.Worker = class extends ActualWorker {
  constructor(source, ...args) {
    super(source, ...args)
    if (String(source).endsWith('/image-resize-worker.js')) {
      this.once('message', message => writeFileSync(process.env.COGENT_IMAGE_WORKER_OUT,
        JSON.stringify({ source: String(source), ok: !('error' in message) })))
    }
  }
}
syncBuiltinESMExports()
