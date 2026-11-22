/** 独立懒包仍需携带上游版权文本；直接复制已安装包的许可证，不在构建时访问网络。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const sources = [
  ['zcode/LICENSE', 'licenses/file-preview/Zcode-LICENSE'],
  ['zcode/来源说明.md', 'licenses/file-preview/补丁来源说明.md'],
  ['duke-sheets/LICENSE', 'licenses/file-preview/duke-sheets-LICENSE'],
  ...[
    ['@pierre/diffs', 'LICENSE.md'], ['@pierre/diffs/node_modules/shiki', 'LICENSE'],
    ['docx-preview', 'LICENSE'], ['@extend-ai/react-xlsx', 'LICENSE'],
    ['@extend-ai/react-docx', 'LICENSE'], ['@aiden0z/pptx-renderer', 'LICENSE'],
    ['react-pdf', 'LICENSE'], ['pdfjs-dist', 'LICENSE'],
    ['@streamdown/math', 'LICENSE'], ['@streamdown/mermaid', 'LICENSE'],
    ['katex', 'LICENSE'], ['mermaid', 'LICENSE']
  ].map(([name, file]) => [`${name}/${file}`, `node_modules/${name}/${file}`])
]

export function previewLicenses(): Plugin {
  return {
    name: 'cogent-preview-licenses',
    generateBundle() {
      for (const [name, source] of sources) this.emitFile({ type: 'asset', fileName: `licenses/file-preview/${name}`, source: readFileSync(resolve(source)) })
    }
  }
}
