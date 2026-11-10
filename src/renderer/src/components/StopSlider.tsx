/**
 * 通用档位滑杆（2026-11-10 从 ContextWindowSlider 抽出泛化）：块状轨道 +
 * 竖条拇指 + 刻度直尺的值域选择器，视觉规格来自用户参考稿 slider-main
 * （桌面 slider 工程），颜色按用户定稿走 shadcn 黑白 token（薄荷绿只是主页
 * chrome 面主题，不进通用件）：轨道 muted、填充 foreground/20 黑低透明软叠
 * （项目全局 hover/active 同配方，比轨道深一档且亮暗两态自动成立）、拇指
 * primary 近黑、刻度 border、标签 muted-foreground/foreground —— 暗色模式
 * 天然兼容。与"上下文窗口"等业务语义零关联，两种用法：
 * - **档位模式**（传 stops）：值吸附在档位上 —— 显示最近档（props 值可以
 *   不在档位上，如目录精确值；只在用户交互后才改写为档位值，不静默篡改），
 *   键盘方向键 = 相邻档步进，轨道下方渲染档位标签（选中加粗）。
 * - **自由模式**（不传 stops）：连续值，按 step 粒度自由滑动，键盘走原语
 *   默认的 step 步进，无标签行只有刻度直尺。
 * 关键机制（为什么这么写）：
 * - thumbAlignment="center"（非 inset）：Indicator 宽度 = value% 直出，顶格
 *   填满轨道 —— inset 模式填充只画到拇指中心（恒差半个拇指 2px），排查
 *   定论见 ui/slider.tsx thumbAlignment 注释。
 * - 档位模式键盘接管（thumbOnKeyDown）：base-ui 均匀 step 步进在不等距
 *   档距下会卡死（如 200K/200K/600K 的中档步进后又被吸回），先
 *   preventDefault() 拦掉内置与原生步进再 ±1 档。
 * - 拇指 margin-inline-start -8px：中心 P%−8px、右缘距填充右缘 6px，
 *   100% 顶格不出轨道右缘（2026-11-10 用户定稿偏移量）。
 * - 填充 width 与拇指位置 280ms ease-out：档位间跳变时"滑过去"的磁吸手感。
 */
import type { KeyboardEvent } from 'react'
import { Slider } from '@/components/ui/slider'
import { cn } from 'cn'

/** 方向键 → 档位步进方向（左右上下四键，参考稿 onKeyDown 同映射）；
    非方向键返回 undefined */
function arrowDirection(key: string): number | undefined {
  if (key === 'ArrowLeft' || key === 'ArrowDown') return -1
  if (key === 'ArrowRight' || key === 'ArrowUp') return 1
  return undefined
}

/** 值 → 最近档位索引（档位模式的显示档与键盘步进基准） */
function nearestStopIndex(stops: readonly number[], value: number): number {
  return stops.reduce(
    (best, stop, index) => (Math.abs(stop - value) < Math.abs(stops[best] - value) ? index : best),
    0
  )
}

/** 档位滑杆：档位吸附 / 自由滑动两用的值域选择器（样式见文件头） */
export function StopSlider({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  stops,
  tickCount = 30,
  formatValue,
  ariaLabel,
}: {
  value: number
  onChange: (v: number) => void
  /** 量程下界（默认 0） */
  min?: number
  /** 量程上界 */
  max: number
  /** 自由模式的步进粒度（档位模式下值只落档位，step 不参与） */
  step?: number
  /** 档位点（升序、落在量程内）：提供即档位吸附模式，缺省即自由滑动模式 */
  stops?: readonly number[]
  /** 刻度根数-1（均匀装饰直尺，默认 30 → 31 根） */
  tickCount?: number
  /** 档位标签与 aria 数值文案（缺省用原始数值字符串） */
  formatValue?: (v: number) => string
  /** 无障碍名称（落在内部 range input 上） */
  ariaLabel: string
}) {
  // 档位模式的显示档；自由模式显示值钳到量程内（超界值只影响显示，不改写）
  const activeIndex = stops !== undefined ? nearestStopIndex(stops, value) : -1
  const displayValue = stops !== undefined ? stops[activeIndex] : Math.min(Math.max(value, min), max)

  // 档位模式：指针交互（拖拽/点击轨道）产生的连续值 → 吸附最近档；受控值
  // 永远只落档位，拖拽中值逐档跳变（配合 280ms 缓动 = 磁吸手感）。
  // 自由模式：直通。
  const handleValueChange = (next: readonly number[]): void => {
    onChange(stops !== undefined ? stops[nearestStopIndex(stops, next[0])] : next[0])
  }

  // 档位模式键盘相邻档步进：preventDefault 一并拦掉原生 range 步进与
  // base-ui 内置 step 步进（不等距档距下内置步进会卡死，见文件头），再 ±1 档。
  // 自由模式不拦截（undefined），键盘走原语默认 step 步进。
  const handleKeyDown = stops === undefined ? undefined : (event: KeyboardEvent<HTMLInputElement>): void => {
    const direction = arrowDirection(event.key)
    if (direction === undefined) return
    event.preventDefault()
    const next = Math.min(stops.length - 1, Math.max(0, nearestStopIndex(stops, value) + direction))
    onChange(stops[next])
  }

  return (
    <div>
      <Slider
        value={[displayValue]}
        min={min}
        max={max}
        step={step}
        thumbAlignment="center"
        thumbAriaLabel={ariaLabel}
        getThumbAriaValueText={(_formatted, thumbValue) => formatValue?.(thumbValue) ?? String(thumbValue)}
        onValueChange={handleValueChange}
        thumbOnKeyDown={handleKeyDown}
        /* 填充条：全高继承轨道，min-width 5px 保底残条，全圆角 + 黑 20% 软叠
           （比轨道深一档的灰，亮暗两态自动成立），280ms ease-out 缓动手感 */
        fillClassName="min-w-[5px] rounded-[5px] bg-foreground/20 transition-[width] duration-[280ms] ease-out"
        className={cn(
          /* 块状轨道：25px 高 5px 圆角，覆写原语 h-2/rounded-full/bg-input/90
             （特异性见 UI布局.md 坑 11） */
          '[&_[data-slot=slider-track]]:h-[25px]',
          '[&_[data-slot=slider-track]]:rounded-[5px]',
          '[&_[data-slot=slider-track]]:bg-muted',
          /* 竖条拇指：4×19 全圆角 + primary 近黑强调，阴影/描边/hover 光环全关；
             ms -8px = 中心 P%−8px（右缘距填充右缘 6px，用户定稿），100% 顶格
             不出轨道右缘；位置过渡 280ms（原语清单已含 inset-inline-start，
             这里只覆写时长/缓动）。focus-visible 光环保留 —— 键盘用户需要焦点落点 */
          '[&_[data-slot=slider-thumb]]:h-[19px] [&_[data-slot=slider-thumb]]:w-[4px]',
          '[&_[data-slot=slider-thumb]]:rounded-[2px]',
          '[&_[data-slot=slider-thumb]]:bg-primary',
          '[&_[data-slot=slider-thumb]]:shadow-none',
          '[&_[data-slot=slider-thumb]]:ring-0 [&_[data-slot=slider-thumb]]:hover:ring-0',
          '[&_[data-slot=slider-thumb]]:-ms-[8px]',
          '[&_[data-slot=slider-thumb]]:duration-[280ms] [&_[data-slot=slider-thumb]]:ease-out',
          /* 抓握光标只落拖拽区（Control = 25px 轨道行），按下变 grabbing */
          '[&_[data-slot=slider-control]]:cursor-grab',
          '[&_[data-slot=slider-control]]:active:cursor-grabbing'
        )}
      />
      {/* 刻度直尺（aria-hidden：数值语义由拇指 aria-valuetext 承担，刻度与
          标签只是视觉层）：均匀刻度铺底，档位标签白底压在刻度带上遮住身后
          刻度（单层结构）。自由模式无标签行，只留刻度。非末档标签中心对齐
          档位位置，末档右缘对齐（居中会越出右缘） */}
      <div
        aria-hidden="true"
        className={cn('relative', stops !== undefined ? 'mt-[5px] h-[17px]' : 'mt-[5px] h-[9px]')}
      >
        <div className="absolute inset-x-px inset-y-0 flex items-center justify-between">
          {Array.from({ length: tickCount + 1 }, (_, index) => (
            <span className="h-[9px] w-px bg-border" key={index} />
          ))}
        </div>
        {stops?.map((stop, index) => {
          const isLast = index === stops.length - 1
          return (
            <span
              className={cn(
                'absolute top-[1px] bg-background px-[3px] text-xs leading-[14px] whitespace-nowrap',
                index === activeIndex ? 'font-bold text-foreground' : 'text-muted-foreground',
                isLast ? 'right-[1px]' : '-translate-x-1/2'
              )}
              key={stop}
              style={isLast ? undefined : { left: `${((stop - min) / (max - min)) * 100}%` }}
            >
              {formatValue?.(stop) ?? String(stop)}
            </span>
          )
        })}
      </div>
    </div>
  )
}
