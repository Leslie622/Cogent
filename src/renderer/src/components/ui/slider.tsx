import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

function Slider<Value extends number | readonly number[]>({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  marks,
  filledThrough,
  thumbAriaLabel,
  getThumbAriaValueText,
  ...props
}: SliderPrimitive.Root.Props<Value> & {
  /** 离散滑块可在轨道上显示定位点；位置仍按 min/max 计算，外观由调用处决定。 */
  marks?: readonly number[]
  /** 小于等于该值的定位点落在已选区内；调用处可用 data-active 单独着色。 */
  filledThrough?: number
  /** 滑块的语义落在内部 range input；业务层可按离散值提供可读文案。 */
  thumbAriaLabel?: string
  getThumbAriaValueText?: SliderPrimitive.Thumb.Props['getAriaValueText']
}) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge-client-only"
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex w-full touch-none items-center overflow-hidden select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative -mx-3 grow overflow-hidden rounded-full bg-input/90 select-none data-horizontal:h-2 data-horizontal:w-full data-vertical:h-full data-vertical:w-2"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
          {marks?.map((mark) => (
            <span
              aria-hidden="true"
              className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform duration-150 ease-out hover:scale-150"
              key={mark}
              data-active={filledThrough !== undefined && mark <= filledThrough ? "" : undefined}
              /* 标记跟随可停靠范围而非轨道边缘，避免端点圆点被 overflow 裁半。
                 12px 对应思考力度滑块的拇指半径。 */
              style={{
                left: `calc(12px + (100% - 24px) * ${((mark - min) / (max - min)).toFixed(4)})`,
              }}
            />
          ))}
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            aria-label={thumbAriaLabel}
            getAriaValueText={getThumbAriaValueText}
            className="block h-4 w-6 shrink-0 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-[color,box-shadow,background-color] select-none not-dark:bg-clip-padding hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-vertical:h-6 data-vertical:w-4"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
