/** 沿用Zcode的懒页管线；模型只是数据，真正需要显式释放的是每页DOM/图表/媒体handle。 */
import { buildPresentation, parseZipLazyMedia, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer/browser'
import type { PresentationData, SlideHandle } from '@aiden0z/pptx-renderer'

export const PPTX_MIN_ZOOM = 25
export const PPTX_MAX_ZOOM = 300
export const PPTX_ZOOM_STEP = 25

export async function openPptxPresentation(buffer: ArrayBuffer): Promise<PresentationData> {
  const files = await parseZipLazyMedia(buffer, RECOMMENDED_ZIP_LIMITS)
  const presentation = buildPresentation(files, { lazySlides: true })
  // 尺寸来自外部OOXML，非法值不能进入DOM尺寸与缩放计算。
  if (!Number.isFinite(presentation.width) || !Number.isFinite(presentation.height) || presentation.width <= 0 || presentation.height <= 0) throw new Error('PPTX 幻灯片尺寸无效')
  return presentation
}

export function disposePptxSlide(handle: SlideHandle): void {
  // 上游handle只撤Blob/图表；已开始播放的HTML媒体还要主动停机并释放解码器。
  for (const media of handle.element.querySelectorAll<HTMLMediaElement>('audio,video')) {
    media.pause()
    media.removeAttribute('src')
    for (const source of media.querySelectorAll('source')) source.removeAttribute('src')
    media.load()
  }
  handle.dispose()
  handle.element.remove()
}
