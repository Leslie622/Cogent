/** 取色面板保留拖动中的 HSVA，避免经 HEX 量化回流丢失色相或精度。 */
import { useState } from 'react'
import { hexToHsva, hsvaToHex, hsvaToRgba, rgbaToHsva, type HsvaColor } from '@uiw/color-convert'
import Alpha from '@uiw/react-color-alpha'
import Hue from '@uiw/react-color-hue'
import Saturation from '@uiw/react-color-saturation'
import Swatch from '@uiw/react-color-swatch'
import { Input } from '@/components/ui/input'
import { isHexColor, type HexColor } from '@/lib/hex-color'

const PRESET_COLORS = [
  '#000000', '#ffffff', '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#22c55e', '#10b981', '#14b8a6', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#ec4899', '#6b7280',
]

function BarPointer({ left }: { left?: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 w-1 rounded-full border border-black/20 bg-white shadow-sm"
      style={{ left }}
    />
  )
}

function ColorChannelInput({ label, value, max, onChange }: {
  label: string
  value: number
  max: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-center text-xs text-muted-foreground">
      {label}
      <Input
        className="font-mono"
        inputMode="numeric"
        value={draft ?? String(value)}
        onChange={(event) => {
          const text = event.target.value
          const number = Number(text)
          setDraft(text)
          if (/^\d{1,3}$/.test(text) && number <= max) onChange(number)
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}

export function ColorPicker({ initialColor, onChange }: {
  initialColor: HexColor
  onChange: (color: HexColor) => void
}) {
  const [hsva, setHsva] = useState(() => hexToHsva(initialColor))
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const rgbHex = hsvaToHex(hsva)
  const rgba = hsvaToRgba(hsva)
  const alphaPercent = Math.round(hsva.a * 100)

  function change(next: HsvaColor) {
    const rgb = hsvaToHex(next)
    const alpha = Math.round(next.a * 255)
    setHsva(next)
    onChange((alpha === 255 ? rgb : `${rgb}${alpha.toString(16).padStart(2, '0')}`) as HexColor)
  }

  return (
    <>
      <Saturation
        hsva={hsva}
        onChange={change}
        radius={6}
        style={{ width: '100%', height: 144 }}
      />
      <Hue hue={hsva.h} pointer={BarPointer} radius={3} onChange={({ h }) => change({ ...hsva, h })} />
      <Alpha
        hsva={hsva}
        pointer={BarPointer}
        radius={3}
        innerProps={{ role: 'slider', 'aria-label': '透明度', 'aria-valuenow': alphaPercent }}
        onChange={({ a }) => change({ ...hsva, a })}
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        HEX
        <Input
          className="font-mono"
          value={hexDraft ?? rgbHex}
          spellCheck={false}
          onChange={(event) => {
            const text = event.target.value
            const hex = `#${text.trim().replace(/^#/, '').toLowerCase()}`
            setHexDraft(text)
            if (isHexColor(hex)) {
              change({ ...hexToHsva(hex), a: hsva.a })
            }
          }}
          onBlur={() => setHexDraft(null)}
        />
      </label>
      <div className="grid grid-cols-4 gap-1.5">
        {(['r', 'g', 'b'] as const).map((channel) => (
          <ColorChannelInput
            key={channel}
            label={channel.toUpperCase()}
            value={rgba[channel]}
            max={255}
            onChange={(value) => change(rgbaToHsva({ ...rgba, [channel]: value }))}
          />
        ))}
        <ColorChannelInput
          label="A (%)"
          value={alphaPercent}
          max={100}
          onChange={(value) => change({ ...hsva, a: value / 100 })}
        />
      </div>
      <Swatch
        colors={PRESET_COLORS}
        color={rgbHex}
        className="gap-1.5"
        role="group"
        aria-label="预设色"
        rectRender={({ color, checked }) => (
          <button
            type="button"
            title={color}
            aria-label={`预设色 ${color}`}
            aria-pressed={checked}
            className="size-4 shrink-0 rounded-sm border border-foreground/15 transition-[transform,translate,scale,rotate,outline-color] hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-ring aria-pressed:ring-offset-1 aria-pressed:ring-offset-popover"
            style={{ background: color }}
            onClick={() => change({ ...hexToHsva(color), a: hsva.a })}
          />
        )}
      />
    </>
  )
}
