import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

function Slider<Value extends number | readonly number[]>({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  marks,
  thumbSizePx = 12,
  filledThrough,
  fillClassName,
  thumbAriaLabel,
  getThumbAriaValueText,
  thumbOnKeyDown,
  thumbAlignment = "edge-client-only",
  ...props
}: SliderPrimitive.Root.Props<Value> & {
  /** 离散滑块可在轨道上显示定位点；位置仍按 min/max 计算，外观（着色、
   * 缩放、hover 反馈）全由调用处决定 —— 调用处的 [&_*] 覆写特异性更高，
   * 原语侧若自带 hover: 变体会被压死（定位点 hover 放大失效即踩过此坑）。 */
  marks?: readonly number[]
  /** 拇指宽（px），marks 端点对齐用：定位点 center = 拇指停靠行程的极限位
   *  （两端各缩半个拇指宽）。inset（edge-client-only）模式下该行程由拇指
   *  实宽决定，而原语拇指默认 size-3（12px），调用处覆写拇指尺寸后公式必须
   *  跟着换，否则端点圆点落在行程外、贴住轨道圆角端部（思考力度拇指 size-6
   *  时踩过）。仅影响 marks 定位；拇指自身的尺寸仍归调用处覆写。 */
  thumbSizePx?: number
  /** 小于等于该值的定位点落在已选区内；调用处可用 data-active 单独着色。 */
  filledThrough?: number
  /** 填充条（Indicator）的样式覆写口：默认只有 bg-primary 实色，复杂填充
   *  （如思考力度的"血流粒子"层叠背景）经此注入全局类，避免几百字符的
   *  任意值工具类。 */
  fillClassName?: string
  /** 滑块的语义落在内部 range input；业务层可按离散值提供可读文案。 */
  thumbAriaLabel?: string
  getThumbAriaValueText?: SliderPrimitive.Thumb.Props['getAriaValueText']
  /** 键盘拦截口（落在内部 input 上，事件目标 HTMLInputElement）：mergeProps
   * 让用户 handler 先于 base-ui 内置步进执行，且内置 keydown 开头就检查
   * event.defaultPrevented —— 用户先 preventDefault() 即可整体接管方向键
   * （不等距档位的相邻档步进需要此举：均匀 step 在窄档处会来回卡死）。 */
  thumbOnKeyDown?: SliderPrimitive.Thumb.Props['onKeyDown']
  /** 拇指对齐模式透传（默认维持 edge-client-only = 既有 ThinkingSlider 行为
   *  与 marks 定位公式的前提）。两种模式的本质差异（2026-11-10 上下文窗口
   *  滑杆"1M 顶格填充差 2px"排查定论）：inset（edge*）模式下 Indicator 宽度
   *  不是 value% 直出，而是"拇指中心实测百分比"（getInsetPosition：halfThumb +
   *  (W-thumbW)*P，range 滑杆的填充=首末拇指中心之间的语义）—— 顶格恒差
   *  半个拇指宽；center 模式 Indicator=valueToPercent 直出、拇指中心恰在 P%，
   *  填充需要精确到轨道边缘的滑杆（上下文窗口）用 center。注意 marks 的
   *  calc(12px + …) 公式按 inset 几何推导，center 模式下定位点会偏。 */
  thumbAlignment?: SliderPrimitive.Root.Props['thumbAlignment']
}) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    // 方向变体必须写 data-[orientation=horizontal]: 而不是 data-horizontal:：
    // Base UI 渲染的属性是 data-orientation="horizontal"（state key 直出），
    // Tailwind 的 data-horizontal: 只匹配属性"存在性"（[data-horizontal]），
    // 永远不命中 —— 轨道 h-2 / w-full 会整条失效（高度塌 0 → 轨道隐身，
    // 2026-11-10 上下文窗口滑杆踩响；ThinkingSlider 当时靠自覆写 h-5 掩埋）。
    <SliderPrimitive.Root
      className={cn(
        // w-full 平铺（不走 orientation 变体）：变体版是"类+属性"双选择器，
        // 特异性压过调用处的普通宽度类（w-40 等）→ 调用点定宽失效、宽度退回
        // 父容器（shrink-0 内容宽）形成环塌（通知页滑杆隐形实况）。平铺后与
        // 调用处的宽度类同特异性，tailwind-merge 同组后写者胜 —— 调用处可
        // 随意定宽。竖直滑杆（当前无消费者）不受 w-full 影响：其宽度本 auto
        "w-full data-[orientation=vertical]:h-full",
        className
      )}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment={thumbAlignment}
      {...props}
    >
      {/* 轨道矮于拇指，Control 不裁切圆钮；轨道圆角由 Track 自身裁切，
          键盘聚焦的内描边由全局样式画在拇指上。 */}
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col"
      >
        {/* 轨道宽度必须与 Control 一致（不用负 margin 出血）：edge-client-only
            （inset）模式下 Base UI 的滑块中心行程、Indicator 百分比全按 Control
            宽度计算，但渲染在轨道里 —— 轨道一旦更宽，填充条会偏出滑块中心、
            端点定位点压到边缘被裁半。 */}
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
        >
          {/* 填充条宽度与拇指（inset-inline-start）必须同参数过渡（同为 Tailwind
              默认 150ms + 默认缓动，两者才逐帧重合）：inset 几何下填充端恒等于
              拇指中心、顶格时轨道末端恒差半个拇指宽且全程由拇指右半盖住 ——
              拇指滑 150ms 而填充瞬跳的话，向高变档填充先冲过拇指、末端灰头在
              拇指到达前裸露；向低变档填充先缩、拇指左侧漏一段底色（2026-11-16
              思考力度滑杆两个方向的瞬态露灰踩响）。对照 zcode 参考实现
              composer-thought-slider.css:17-25：fill(width)/thumb(left) 同
              duration 同 ease 成对过渡即此意。竖直滑杆（当前无消费者）应过渡
              height，届时按 orientation 补。 */}
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn('bg-primary transition-[width] select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full', fillClassName)}
          />
          {marks?.map((mark) => (
            <span
              aria-hidden="true"
              className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full before:absolute before:-inset-2 before:content-['']"
              key={mark}
              data-active={filledThrough !== undefined && mark <= filledThrough ? "" : undefined}
              /* 标记跟随可停靠范围而非轨道边缘，避免端点圆点被 overflow 裁半。
                 两端各缩半个拇指宽 = inset 模式下拇指中心的行程极限（默认
                 12px 拇指即 6px）；thumbSizePx 由调用处按真实拇指宽下发。
                 命中区：6px 圆点太小，用不可见 ::before 各向外扩 8px（22×22，
                 相邻档位间距 ~40px 不至于互相覆盖）参与命中测试 —— 伪元素盒
                 属于宿主元素，hover/click 落上面即落在点上；上下越出轨道的
                 部分被 Track overflow-hidden 裁掉各 1px，无碍。 */
              style={{
                left: `calc(${thumbSizePx / 2}px + (100% - ${thumbSizePx}px) * ${((mark - min) / (max - min)).toFixed(4)})`,
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
            onKeyDown={thumbOnKeyDown}
            className="relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,outline-color,box-shadow,inset-inline-start,transform] select-none after:absolute after:-inset-2 hover:ring-3 active:ring-3 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
