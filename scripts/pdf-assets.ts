/** PDF.js 浏览器预览的固定只读资源；开发与打包使用同一文件清单，绝不代理用户文件路径。 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
export function pdfAssets(): Plugin {
  const files = new Map<string, string>()
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    const root = resolve('node_modules/pdfjs-dist', directory)
    for (const name of readdirSync(root)) if (/\.(bcmap|pfb|ttf|wasm|js)$/.test(name)) files.set(`pdfjs/${directory}/${name}`, resolve(root, name))
  }
  return {
    name: 'cogent-pdf-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const key = (request.url ?? '').split('?')[0].replace(/^\//, '')
        const file = files.get(key)
        if (file === undefined) return next()
        response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream')
        response.end(readFileSync(file))
      })
    },
    generateBundle() { for (const [fileName, file] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(file) }) },
  }
}
