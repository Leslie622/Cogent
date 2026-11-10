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
  fillClassName,
  thumbAriaLabel,
  getThumbAriaValueText,
  ...props
}: SliderPrimitive.Root.Props<Value> & {
  /** 离散滑块可在轨道上显示定位点；位置仍按 min/max 计算，外观（着色、
   * 缩放、hover 反馈）全由调用处决定 —— 调用处的 [&_*] 覆写特异性更高，
   * 原语侧若自带 hover: 变体会被压死（定位点 hover 放大失效即踩过此坑）。 */
  marks?: readonly number[]
  /** 小于等于该值的定位点落在已选区内；调用处可用 data-active 单独着色。 */
  filledThrough?: number
  /** 填充条（Indicator）的样式覆写口：默认只有 bg-primary 实色，复杂填充
   *  （如思考力度的"血流粒子"层叠背景）经此注入全局类，避免几百字符的
   *  任意值工具类。 */
  fillClassName?: string
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
      {/* Control 不裁切（无 overflow-hidden）：轨道（h-2）矮于拇指（h-4），
          拇指与 focus ring 的 ring-offset 都要越出 Control 上下沿渲染，裁了
          圆钮会被削平、聚焦环残缺。轨道自身的圆角裁切由 Track 的
          overflow-hidden 负责。 */}
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col"
      >
        {/* 轨道宽度必须与 Control 一致（不用负 margin 出血）：edge-client-only
            （inset）模式下 Base UI 的滑块中心行程、Indicator 百分比全按 Control
            宽度计算，但渲染在轨道里 —— 轨道一旦更宽，填充条会偏出滑块中心、
            端点定位点压到边缘被裁半。 */}
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-input/90 select-none data-horizontal:h-2 data-horizontal:w-full data-vertical:h-full data-vertical:w-2"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn('bg-primary select-none data-horizontal:h-full data-vertical:w-full', fillClassName)}
          />
          {marks?.map((mark) => (
            <span
              aria-hidden="true"
              className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full before:absolute before:-inset-2 before:content-['']"
              key={mark}
              data-active={filledThrough !== undefined && mark <= filledThrough ? "" : undefined}
              /* 标记跟随可停靠范围而非轨道边缘，避免端点圆点被 overflow 裁半。
                 12px 对应思考力度滑块的拇指半径。
                 命中区：6px 圆点太小，用不可见 ::before 各向外扩 8px（22×22，
                 相邻档位间距 ~40px 不至于互相覆盖）参与命中测试 —— 伪元素盒
                 属于宿主元素，hover/click 落上面即落在点上；上下越出轨道的
                 部分被 Track overflow-hidden 裁掉各 1px，无碍。 */
              style={{
                left: `calc(12px + (100% - 24px) * ${((mark - min) / (max - min)).toFixed(4)})`,
              }}
            />
          ))}
        </SliderPrimitive.Track>
        {/* 拇指位置（inset-inline-start，inset 模式下由 --position 解析而来）与
            阴影/缩放带 150ms 过渡：调档、点轨道、拖拽越过吸附档时都"滑过去"
            而非瞬移 —— 离散吸附滑杆的跳档瞬间正是需要过渡的时刻，拖拽中不杀
            过渡（那是连续滑杆保跟手的做法；这里 150ms 缓动追指针即磁吸手感）。 */}
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            aria-label={thumbAriaLabel}
            getAriaValueText={getThumbAriaValueText}
            className="block h-4 w-6 shrink-0 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-[color,box-shadow,background-color,inset-inline-start,transform] select-none not-dark:bg-clip-padding hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-vertical:h-6 data-vertical:w-4"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
