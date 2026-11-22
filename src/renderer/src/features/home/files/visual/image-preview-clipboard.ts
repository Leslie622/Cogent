/** 与Zcode相同，将当前图像物理像素转PNG；不把图片复制退化成复制路径或URL。 */
export function copyImagePreview(image: HTMLImageElement): Promise<void> {
  // Clipboard在非安全浏览器上下文可能缺失，DOM类型没有表达这个宿主边界。
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (navigator.clipboard?.write === undefined || typeof ClipboardItem === 'undefined') return Promise.reject(new Error('当前环境不支持复制图片'))
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return Promise.reject(new Error('图片尚未加载完成'))
  if (image.naturalWidth * image.naturalHeight > 32_000_000) return Promise.reject(new Error('图片超过3200万像素的剪贴板容量，请下载原图'))
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (context === null) { canvas.width = 0; canvas.height = 0; return Promise.reject(new Error('图片画布不可用')) }
  try { context.drawImage(image, 0, 0) }
  catch (error) { canvas.width = 0; canvas.height = 0; return Promise.reject(error instanceof Error ? error : new Error(String(error))) }
  const png = new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (blob === null) reject(new Error('图片PNG编码失败'))
    else resolve(blob)
  }, 'image/png')).finally(() => { canvas.width = 0; canvas.height = 0 })
  // 在点击栈中提交Promise型ClipboardItem，保留用户激活；两个Promise都有人观察失败。
  let copied: Promise<void>
  try { copied = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]) }
  catch (error) { copied = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
  return Promise.all([copied, png]).then(() => {})
}
