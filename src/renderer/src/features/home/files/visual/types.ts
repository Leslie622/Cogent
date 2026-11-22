/** 可视化Office只消费已授权字节；来源、租约和版本仍由FilePanel上游持有。 */
export interface VisualPreviewProps {
  buffer: ArrayBuffer
  name: string
  tabId: string
  active: boolean
  onOpenUrl: (url: string) => void
}
