/** 图片仍由浏览器解码；文件名密度按Zcode折算CSS尺寸，物理像素继续用于复制。 */
export interface ImagePreviewSize { width: number; height: number }

export function imagePreviewPixelRatio(sourceName: string): number {
  const name = sourceName.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const match = /@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(name)
  const ratio = match === null ? 1 : Number(match[1])
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
}

export function imagePreviewGeometry(natural: ImagePreviewSize, viewport: ImagePreviewSize, name: string, zoom: number | null) {
  const svg = /\.svg$/i.test(name)
  const density = svg ? 1 : Math.max(1, imagePreviewPixelRatio(name))
  const logicalWidth = natural.width / density, logicalHeight = natural.height / density
  const fit = Math.min(svg ? Infinity : 1, Math.max(1, viewport.width - 32) / logicalWidth, Math.max(1, viewport.height - 32) / logicalHeight)
  // Fit可以小于10%或将小SVG放大；显式缩放仍能在适配倍率附近继续操作。
  const minScale = Math.min(0.1, fit / 2), maxScale = Math.max(4, fit * 3)
  const scale = zoom === null ? fit : Math.min(maxScale, Math.max(minScale, zoom))
  return { scale, fit, minScale, maxScale, width: logicalWidth * scale, height: logicalHeight * scale }
}
