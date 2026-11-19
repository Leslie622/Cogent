/** 模型菜单与设置共用有效输入声明，标签不根据型号名称猜测。 */
import { Badge } from '@/components/ui/badge'
export function ModelVisionBadge({ input, size = 'sm' }: { input?: readonly string[]; size?: 'default' | 'sm' }) {
  return input?.includes('image') === true ? <Badge variant="secondary" size={size} data-model-capability="vision" aria-label="支持视觉输入">视觉</Badge> : null
}
