/** 模型菜单与设置共用有效输入声明，标签不根据型号名称猜测。 */
import { Badge } from '@/components/ui/badge'
export function ModelVisionBadge({ input }: { input?: readonly string[] }) {
  return input?.includes('image') === true ? <Badge variant="secondary" size="sm" data-model-capability="vision" aria-label="支持视觉输入">视觉</Badge> : null
}
