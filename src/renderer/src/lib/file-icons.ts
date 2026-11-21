/** 文件图标只看名称，不探测磁盘；沿用 Material Icon Theme 的完整关联与浅色变体。 */
import { generateManifest } from 'material-icon-theme'

const manifest = generateManifest()
const names = new Map(Object.entries(manifest.fileNames!))
const extensions = new Map(Object.entries(manifest.fileExtensions!))
const lightNames = new Map(Object.entries(manifest.light!.fileNames!))
const lightExtensions = new Map(Object.entries(manifest.light!.fileExtensions!))
// 独立资源随应用打包，避免首次加载就把整套 SVG 塞进脚本，也不依赖在线图床。
const assets = import.meta.glob<string>('../../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?url&no-inline'
})
const sources = new Map(Object.entries(manifest.iconDefinitions!).map(([name, definition]) => {
  const file = definition.iconPath.split('/').at(-1)!
  return [name, assets[`../../../../node_modules/material-icon-theme/icons/${file}`]]
}))

export function getFileIcon(path: string): { name: string; src: string; lightSrc: string } {
  const file = path.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase()
  let name = names.get(file)
  let light = lightNames.get(file)
  if (name === undefined) {
    // 多段扩展名从长到短匹配，保留 d.ts、config.js 等上游已定义的专用图标。
    for (let dot = file.indexOf('.'); dot >= 0; dot = file.indexOf('.', dot + 1)) {
      const extension = file.slice(dot + 1)
      name = extensions.get(extension)
      if (name !== undefined) {
        light = lightExtensions.get(extension)
        break
      }
    }
  }
  const icon = name ?? manifest.file!
  return { name: icon, src: sources.get(icon)!, lightSrc: sources.get(light ?? icon)! }
}
