/**
 * 思考力度滑杆（content-main 首页会话视图 → 底部输入卡 → 模型下拉第三段）：
 * 架构位置 = ModelMenu 菜单面板的末段；职责边界 = 纯呈现件 —— 坡道取色 +
 * 渐变滑杆 + 血流粒子 WAAPI 动效，档位值（off = 跟随引擎默认，其余透传
 * agent.submit）由 engine store 的 thinkingLevel 持有，经 value/onChange 单向流过。
 * thinkingVisuals 一并导出：菜单标签文字色需与滑杆填充同取坡道色（ModelMenu 用）。
 */
import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { cn } from 'cn'
import { Slider } from '@/components/ui/slider'
import type { ThinkingLevel } from '@/env.d'

/** 思考力度选项（off = 关闭，跟随引擎默认；其余透传给 agent.submit） */
const THINKING_OPTIONS: ReadonlyArray<{ id: 'off' | ThinkingLevel; label: string }> = [
  { id: 'off', label: '关闭' },
  { id: 'minimal', label: '最低' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
  { id: 'max', label: '最大' },
]

/** 思考力度色彩坡道（低 → 高）：灰蓝(关) → 天蓝 → 主题蓝 → 靛 → 紫 → 品红。
 *  档位越高颜色越"热"、光晕越强 —— 力度感可视化的全部素材都从这条坡道取 */
const THINKING_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [148, 163, 184],
  [56, 189, 248],
  [53, 155, 244],
  [99, 102, 241],
  [168, 85, 247],
  [217, 70, 239],
]

/** 坡道取色：t∈[0,1] 在相邻锚点间线性插值，返回 rgb 三元组 */
function rampColor(t: number): readonly [number, number, number] {
  const scaled = t * (THINKING_RAMP.length - 1)
  const i = Math.min(THINKING_RAMP.length - 2, Math.floor(scaled))
  const f = scaled - i
  const [r1, g1, b1] = THINKING_RAMP[i]
  const [r2, g2, b2] = THINKING_RAMP[i + 1]
  return [
    Math.round(r1 + (r2 - r1) * f),
    Math.round(g1 + (g2 - g1) * f),
    Math.round(b1 + (b2 - b1) * f),
  ]
}

/** 血流粒子的一颗细胞。各参数独立随机（生成处），无任何属性绑定 ——
 *  层序（数组序=叠放序）、相位、纵深、粒径、亮度、tile 宽（=速度）之间
 *  不相关：亮细胞可能被暗细胞压住、小细胞可能比大细胞快 */
interface FlowCell {
  /** 水平 tile 宽（px）：粒子每循环平移一个 tile 宽 → tile 宽即该粒速度 */
  tile: number
  /** 细胞在 tile 内的横向相位（px，圆心） */
  phase: number
  /** 纵深位置（px，圆心；轨道高 20px） */
  y: number
  /** 顺流向拉长的椭圆半径（rx > ry） */
  rx: number
  ry: number
  /** 亮度（0.35–1，乘进细胞各色 stop 的透明度） */
  alpha: number
  /** 是否带白色核心（血球高光），随机对半 */
  core: boolean
}

/** 一颗细胞的背景层字符串：白核（可选）+ 档位色晕，色随 --think-to 走 */
function cellLayer(c: FlowCell): string {
  const halo = `color-mix(in srgb, var(--think-to) ${Math.round(c.alpha * 100)}%, transparent)`
  const head = `radial-gradient(${c.rx.toFixed(1)}px ${c.ry.toFixed(1)}px at ${c.phase.toFixed(1)}px ${c.y.toFixed(1)}px,`
  return c.core
    ? `${head} rgb(255 255 255 / ${c.alpha.toFixed(2)}) 42%, ${halo} 62%, transparent 72%)`
    : `${head} ${halo} 55%, transparent 75%)`
}

/** 随机生成一批细胞（7~9 颗）。菜单每次打开 ThinkingSlider 重新挂载 →
 *  每次打开都是新的一批 */
function randomCells(): FlowCell[] {
  return Array.from({ length: 7 + Math.floor(Math.random() * 3) }, () => {
    const rx = 2 + Math.random() * 2.6
    const tile = 24 + Math.random() * 44
    return {
      tile,
      phase: rx + Math.random() * Math.max(1, tile - 2 * rx),
      y: 4.5 + Math.random() * 11,
      rx,
      ry: rx * (0.65 + Math.random() * 0.2),
      alpha: 0.35 + Math.random() * 0.65,
      core: Math.random() < 0.5,
    }
  })
}

/** 思考力度的视觉呈现：按档位在可用档中的相对位置（而非绝对档名）取坡道色 ——
 *  模型只支持部分档位时，可用档仍铺满整条坡道，"力度递进"不失真。
 *  滑杆（渐变端点/光晕 CSS 变量）与标签文字色共用，保证两处一致。 */
export function thinkingVisuals(
  value: 'off' | ThinkingLevel,
  supportedLevels?: ReadonlyArray<'off' | ThinkingLevel>
) {
  const options =
    supportedLevels === undefined
      ? THINKING_OPTIONS
      : THINKING_OPTIONS.filter((option) => supportedLevels.includes(option.id))
  const index = Math.max(0, options.findIndex((option) => option.id === value))
  // 单档滑杆无从谈"进度"，取坡道起点（最冷静的灰蓝）
  const t = options.length > 1 ? index / (options.length - 1) : 0
  const from = rampColor(t * 0.55)
  const to = rampColor(t)
  return {
    options,
    index,
    t,
    label: THINKING_OPTIONS.find((option) => option.id === value)?.label,
    text: `rgb(${to.join(' ')})`,
    /* 注入滑杆根元素的 CSS 变量：--think-from/to 已在 globals.css 注册为
       可插值颜色（配合 transition 平滑变色）；--think-r/g/b 通道 + 透明度
       组出拇指光晕色（think-pulse 关键帧逐帧驱动 --think-glow-alpha 呼吸）；
       --think-pulse-anim 整段下发 animation 简写（off 档 none 关停）。
       血流粒子不走路里 —— 由下方 effect 用 JS 随机生成 + WAAPI 驱动 */
    vars: {
      '--think-from': `rgb(${from.join(' ')})`,
      '--think-to': `rgb(${to.join(' ')})`,
      '--think-r': to[0],
      '--think-g': to[1],
      '--think-b': to[2],
      '--think-glow-alpha': (0.15 + 0.35 * t).toFixed(3),
      '--think-glow-min': (0.15 + 0.35 * t).toFixed(3),
      '--think-glow-max': Math.min(0.95, 0.55 + 0.4 * t).toFixed(3),
      '--think-glow-blur': `${8 + 12 * t}px`,
      '--think-pulse-anim':
        t === 0 ? 'none' : `think-pulse ${(2.6 - 1.2 * t).toFixed(2)}s ease-in-out infinite`,
    } as CSSProperties,
  }
}

/**
 * 思考力度滑杆（对标参考稿：渐变轨道 + 白色圆滑块，7 档吸附，键盘 ←→ 可调）。
 * 嵌在菜单里：非 MenuItem，点击不会关闭菜单。
 * 只呈现当前模型实际支持的档位，避免把不可选的能力展示成噪音。
 * 档位升高时填充条内的"血流粒子"（JS 挂载时随机生成、WAAPI 流动，每次
 * 打开菜单换一批、全参数独立随机）流速加快、拇指光晕呼吸增强、轨道底色
 * 染上档位色；off 档粒子隐去、动效全关。
 */
export function ThinkingSlider({
  value,
  supportedLevels,
  onChange,
}: {
  value: 'off' | ThinkingLevel
  /** 当前模型支持的档（含 off）；缺省 = 全档可用（无模型/旧数据兼容） */
  supportedLevels?: ReadonlyArray<'off' | ThinkingLevel>
  onChange: (level: 'off' | ThinkingLevel) => void
}) {
  const { options, index, t, vars } = thinkingVisuals(value, supportedLevels)
  const wrapRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<Animation | null>(null)

  /* 血流粒子：挂载时随机一批（依赖 []，拖档中途不重抽），粒子层 + 血管
     底色以内联 background-* 叠到填充条上（覆写 .think-cells 类的纯血管），
     WAAPI 从 0 平移到各自 tile 宽 —— 每颗一个速度，无缝循环。off 档不铺
     粒子（回落到类的纯血管渐变）。WAAPI 不受 CSS animation 属性控制，
     motion-reduce 在此自查：只铺粒子不流动 */
  const cells = useMemo(randomCells, [])
  const enabled = t > 0
  useEffect(() => {
    const range = wrapRef.current?.querySelector<HTMLElement>('[data-slot="slider-range"]')
    if (!range || !enabled) return
    const vessel = 'linear-gradient(90deg, var(--think-from), var(--think-to))'
    range.style.backgroundImage = `${cells.map(cellLayer).join(',')},${vessel}`
    range.style.backgroundSize = `${cells.map((c) => `${c.tile.toFixed(1)}px 100%`).join(',')},100% 100%`
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const anim = range.animate(
      [
        { backgroundPosition: `${cells.map(() => '0 0').join(',')},0 0` },
        { backgroundPosition: `${cells.map((c) => `${c.tile.toFixed(1)}px 0`).join(',')},0 0` },
      ],
      { duration: 2000, iterations: Infinity, easing: 'linear' }
    )
    animRef.current = anim
    return () => {
      animRef.current = null
      anim.cancel()
      range.style.backgroundImage = ''
      range.style.backgroundSize = ''
    }
  }, [enabled, cells])

  /* 调速只动 playbackRate（基准 2s/周期，1.1x → 3.3x ≈ 1.8s → 0.6s）：
     不重建动画，拖档时粒子相位连续、不归零跳变 */
  useEffect(() => {
    if (animRef.current) animRef.current.playbackRate = 1.1 + 2.2 * t
  }, [t])

  return (
    <div ref={wrapRef} className="px-3 pb-3 pt-1">
      {/* 用项目的 shadcn Slider 封装；它内部完整保留 Base UI 的 Control，
          因此点击、拖拽和键盘操作都落在同一个可访问控件上。 */}
      <Slider
        value={[index]}
        min={0}
        max={options.length - 1}
        step={1}
        marks={options.map((_, i) => i)}
        filledThrough={index}
        thumbAriaLabel="思考力度"
        getThumbAriaValueText={() => options[index].label}
        onValueChange={(next) => {
          onChange(options[next[0]].id)
        }}
        style={vars}
        fillClassName="think-cells"
        className={cn(
          'py-2',
          /* 档位色平滑过渡：--think-from/to 已注册为颜色（globals.css），
             渐变才能逐帧插值而非跳色 */
          '[transition-property:--think-from,--think-to] duration-200',
          /* 光晕呼吸：关键帧在根元素上驱动 --think-glow-alpha（alpha 继承到
             拇指的 box-shadow），off 档变量为 none 即静止 */
          '[animation:var(--think-pulse-anim)] motion-reduce:[animation:none]',
          /* 轨道底色混入档位色（未填充段也随力度微微"升温"） */
          '[&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-track]]:bg-[color-mix(in_srgb,var(--think-to)_14%,#e5e7eb)] [&_[data-slot=slider-track]]:transition-colors [&_[data-slot=slider-track]]:duration-200 [&_[data-slot=slider-track]]:shadow-[inset_0_1px_1px_rgb(15_23_42/0.06)]',
          /* 填充条宽度过渡：随拇指滑过去（离散跳档不杀过渡，理由同拇指）；
             粒子层与流动动画在上方 effect 里以内联样式 + WAAPI 挂载 */
          '[&_[data-slot=slider-range]]:transition-[width] [&_[data-slot=slider-range]]:duration-150',
          /* 定位点：激活/熄灭带 300ms 颜色+缩放过渡 —— 拖动时点亮沿档位
             逐个泛起（涟漪般尾随拇指），替代硬切换；hover（放大 1.5 + 颜色
             提亮一档）也定义在此（原语 marks 不带外观，见 slider.tsx）。
             注意 Tailwind v4 的 scale-* 走独立 scale 属性（不是 transform），
             过渡清单必须点名 scale；基态显式 scale-100（两端都有具体值，
             1 → 1.25 插值最稳）；激活点的 hover 须 span[data-active]:hover
             单独压过 scale-125 / bg-white/55 —— 两者同为 0,3,1 特异性时
             胜负看生成顺序，别赌 */
          '[&_[data-slot=slider-track]>span]:scale-100 [&_[data-slot=slider-track]>span]:bg-[#aeb3ba] [&_[data-slot=slider-track]>span]:transition-[background-color,scale] [&_[data-slot=slider-track]>span]:duration-300 [&_[data-slot=slider-track]>span]:ease-out [&_[data-slot=slider-track]>span]:hover:scale-150 [&_[data-slot=slider-track]>span]:hover:bg-white/70 [&_[data-slot=slider-track]>span[data-active]]:scale-125 [&_[data-slot=slider-track]>span[data-active]]:bg-white/55 [&_[data-slot=slider-track]>span[data-active]]:hover:scale-150 [&_[data-slot=slider-track]>span[data-active]]:hover:bg-white/80',
          /* 拇指必须是轨道之上的不透明层；此前未显式设层级，端点的轨道色会
             从圆点下方透出来，视觉上像圆点没有盖住条。光晕色由通道变量 +
             呼吸中的 --think-glow-alpha 现场组出（think-pulse 驱动）。 */
          '[&_[data-slot=slider-thumb]]:z-10 [&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:border [&_[data-slot=slider-thumb]]:border-border [&_[data-slot=slider-thumb]]:bg-white',
          '[&_[data-slot=slider-thumb]]:shadow-[0_1px_4px_rgb(15_23_42/0.18),0_0_var(--think-glow-blur)_rgb(var(--think-r)_var(--think-g)_var(--think-b)/var(--think-glow-alpha))] [&_[data-slot=slider-thumb]]:hover:scale-105 [&_[data-slot=slider-thumb]]:active:scale-95',
          '[&_[data-slot=slider-thumb]]:focus-visible:ring-2 [&_[data-slot=slider-thumb]]:focus-visible:ring-[#3498f4] [&_[data-slot=slider-thumb]]:focus-visible:ring-offset-2'
        )}
      />
    </div>
  )
}
