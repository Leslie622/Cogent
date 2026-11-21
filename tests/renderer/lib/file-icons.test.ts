/** 名称匹配与实际资源表：区分类型、完整文件名优先、长扩展名及主题变体。 */
import { describe, expect, it } from 'vitest'
import { generateManifest } from 'material-icon-theme'
import { getFileIcon } from '@/lib/file-icons'

describe('Material 文件图标', () => {
  it.each([
    ['报告 A #%.txt', 'document'],
    ['数据.CSV', 'table'],
    ['说明.md', 'markdown'],
    ['README.md', 'readme'],
    ['package.json', 'nodejs'],
    ['tsconfig.json', 'tsconfig'],
    ['Dockerfile', 'docker'],
    ['C:\\项目\\文件夹\\类型.d.ts', 'typescript-def'],
    ['/work/src/app.tsx', 'react_ts'],
    ['合同.docx', 'word'],
    ['报告.pdf', 'pdf'],
    ['表格.xlsx', 'table'],
    ['演示.pptx', 'powerpoint'],
    ['照片.png', 'image'],
    ['归档.zip', 'zip'],
    ['无扩展名', 'file'],
    ['数据.unknown-extension', 'file']
  ])('%s 匹配 %s', (path, icon) => {
    expect(getFileIcon(path).name).toBe(icon)
  })
  it('浅色专用资源与深色资源分别保留', () => {
    const icon = getFileIcon('配置.toml')
    expect(icon.src).toContain('/toml.svg')
    expect(icon.lightSrc).toContain('/toml_light.svg')
  })
  it('整套上游名称和扩展名关联都能找到本地资源，避免未验证的图标名导致破图', () => {
    const manifest = generateManifest()
    for (const path of [...Object.keys(manifest.fileNames!), ...Object.keys(manifest.fileExtensions!).map((extension) => `文件.${extension}`)]) {
      const icon = getFileIcon(path)
      expect(icon.src, path).toMatch(/\.svg(?:\?|$)/)
      expect(icon.lightSrc, path).toMatch(/\.svg(?:\?|$)/)
    }
  })
})
