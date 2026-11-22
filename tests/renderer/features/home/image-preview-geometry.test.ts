import { describe, expect, it } from 'vitest'
import { imagePreviewGeometry, imagePreviewPixelRatio } from '@/features/home/files/visual/image-preview-geometry'

describe('图片逻辑尺寸与适配', () => {
  it.each([['C:\\assets\\hero@2x.png', 2], ['logo@3x.PNG', 3], ['hero@1.5x.webp', 1.5], ['folder@2x/logo.png', 1], ['logo@0x.svg', 1], ['logo.png', 1]])('%s的文件密度为%s', (name, density) => {
    expect(imagePreviewPixelRatio(name)).toBe(density)
  })
  it('Retina缩小CSS尺寸，不让适配把小位图放大', () => {
    const natural = { width: 800, height: 400 }, viewport = { width: 1000, height: 700 }
    expect(imagePreviewGeometry(natural, viewport, 'photo@2x.png', 1)).toMatchObject({ width: 400, height: 200, scale: 1 })
    expect(imagePreviewGeometry(natural, viewport, 'photo@2x.png', null)).toMatchObject({ width: 400, height: 200, scale: 1 })
  })
  it('大位图保持宽高比适配；SVG允许填充视口且不套Retina文件密度', () => {
    const viewport = { width: 600, height: 400 }
    expect(imagePreviewGeometry({ width: 1000, height: 500 }, viewport, 'photo.png', null)).toMatchObject({ width: 568, height: 284 })
    expect(imagePreviewGeometry({ width: 100, height: 50 }, viewport, 'drawing@2x.svg', null)).toMatchObject({ width: 568, height: 284 })
  })
  it('显式倍率有界，但超大图片适配后仍可继续缩放', () => {
    const natural = { width: 20000, height: 1000 }, viewport = { width: 400, height: 300 }
    const fit = imagePreviewGeometry(natural, viewport, 'panorama.png', null)
    const small = imagePreviewGeometry(natural, viewport, 'panorama.png', fit.fit / 2)
    expect(small.scale).toBeCloseTo(fit.fit / 2)
    expect(imagePreviewGeometry(natural, viewport, 'panorama.png', 99).scale).toBe(4)
  })
})
