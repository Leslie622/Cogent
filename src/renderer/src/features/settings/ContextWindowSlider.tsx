/**
 * 上下文窗口三档滑杆（ModelDialog 专用；2026-11-10 从 ModelsSection.tsx 拆出，
 * 同步换用 ui/slider 原语替代手搓 pointer 拖拽实现）：索引空间用法 —— 档位
 * 200K/400K/1M 映射为索引 0/1/2，value 传 [索引]、step=1 天然三档吸附（键盘
 * ←→ 步进 / 点击轨道 / 拖拽都只在档位间停留，均为 base-ui 自带，手搓的
 * pointer capture 与键盘分支全部退役）。值不在档位上时（目录精确值）显示
 * 最近档位，但只在用户真正拖动后才改写数值 —— 不静默篡改目录值。刻度标签行
 * 保留为 Slider 下方独立说明层（选中档变色）；原实现里 25 个纯装饰小刻度由
 * 原语 marks 定位点替代，不再单独铺一层。
 */
import { Slider } from '@/components/ui/slider'
import { cn } from 'cn'
import { formatContext } from './models-recipes'

/** 滑杆档位：只认 200K / 400K / 1M 三档（1M 顶格对标参考稿） */
const CONTEXT_STOPS = [200000, 400000, 1048576] as const

/** 值 → 最近档位索引：值不在档位上时的"显示档"（props 仍收发 token 数，对调用方无感） */
function nearestStopIndex(tokens: number): number {
  return CONTEXT_STOPS.reduce(
    (best, stop, index) => (Math.abs(stop - tokens) < Math.abs(CONTEXT_STOPS[best] - tokens) ? index : best),
    0
  )
}

/** 上下文窗口滑杆（对标参考稿）：三档吸附 + 最近档显示，接口与旧手搓实现一致 */
export function ContextWindowSlider({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const activeIndex = nearestStopIndex(value)

  return (
    <div>
      <Slider
        value={[activeIndex]}
        min={0}
        max={CONTEXT_STOPS.length - 1}
        step={1}
        marks={CONTEXT_STOPS.map((_, i) => i)}
        filledThrough={activeIndex}
        fillClassName="bg-foreground/20"
        thumbAriaLabel="上下文窗口"
        getThumbAriaValueText={(_formatted, thumbValue) => formatContext(CONTEXT_STOPS[thumbValue])}
        onValueChange={(next) => onChange(CONTEXT_STOPS[next[0]])}
        className={cn(
          /* 定位点外观（原语 marks 不带外观，见 slider.tsx）：未选灰、选中黑，
             与下方刻度标签行联动变色 */
          '[&_[data-slot=slider-track]>span]:bg-border',
          '[&_[data-slot=slider-track]>span]:transition-colors [&_[data-slot=slider-track]>span]:duration-200',
          '[&_[data-slot=slider-track]>span[data-active]]:bg-foreground'
        )}
      />
      {/* 刻度标签行：Slider 下方独立说明层（档位刻度 + 文案，选中的那档变色）。
          左右定位公式与原语 marks 定位点同式 —— 12px 为拇指半宽（edge 对齐模式
          下拇指中心行程两端各缩 12px），标签才能与定位点垂直对齐 */}
      <div className="relative mt-0.5 h-7">
        {CONTEXT_STOPS.map((stop, index) => (
          <div
            key={stop}
            className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
            style={{ left: `calc(12px + (100% - 24px) * ${index / (CONTEXT_STOPS.length - 1)})` }}
          >
            <span
              className={cn(
                'h-2 w-0.5 transition-colors duration-200',
                index === activeIndex ? 'bg-foreground' : 'bg-border'
              )}
            />
            <span
              className={cn(
                'pt-1.5 text-[10px] leading-none transition-colors duration-200',
                index === activeIndex ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {formatContext(stop)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
