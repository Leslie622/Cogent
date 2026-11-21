/** 设置中的界面主题色选择器：缩略图复用应用色板，单选与键盘交互交给 Nova 原语。 */
import type { CSSProperties } from 'react'
import { RadioGroup, RadioGroupCard } from '@/components/ui/radio-group'
import { INTERFACE_SKINS, INTERFACE_SKIN_IDS, interfaceSkinVariables, type InterfaceSkinId } from '@/lib/interface-skins'

export function InterfaceSkinPicker({
  value, dark, onValueChange,
}: {
  value: InterfaceSkinId
  dark: boolean
  onValueChange: (value: InterfaceSkinId) => void
}) {
  return (
    <RadioGroup
      aria-label="主题色"
      value={value}
      onValueChange={onValueChange}
      className="grid-cols-3 gap-3 @min-[36rem]/settings:grid-cols-6"
    >
      {INTERFACE_SKIN_IDS.map((id) => (
        <RadioGroupCard key={id} value={id} label={INTERFACE_SKINS[id].name} style={interfaceSkinVariables(id, dark) as CSSProperties}>
          <span className="chrome-surface relative block aspect-[1.65]">
            <span className="absolute top-2 left-2 h-1 w-[42%] rounded-full bg-(--visual-radio-color)" />
            <span className="absolute top-3.5 left-2 h-0.5 w-[30%] rounded-full bg-(--visual-radio-color) opacity-20" />
            <span className="absolute top-[36%] bottom-0 left-0 flex w-2 flex-col items-center gap-1 pt-1">
              <span className="size-0.5 rounded-sm bg-(--visual-radio-color)" />
              <span className="size-0.5 rounded-sm bg-(--visual-radio-color) opacity-30" />
              <span className="mt-auto mb-1 size-0.5 rounded-sm bg-(--visual-radio-color) opacity-30" />
            </span>
            <span className="absolute inset-x-2 top-[36%] bottom-0 flex overflow-hidden rounded-tl-md border-t border-l border-foreground/10 bg-background">
              <span className="flex w-[34%] shrink-0 flex-col gap-1 bg-content-sidebar p-1">
                <span className="h-0.5 w-4/5 rounded-full bg-(--visual-radio-color) opacity-40" />
                <span className="h-0.5 w-3/5 rounded-full bg-(--visual-radio-color) opacity-20" />
                <span className="h-0.5 w-4/5 rounded-full bg-(--visual-radio-color) opacity-20" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
                <span className="h-1 w-4/5 rounded-full bg-foreground/20" />
                <span className="h-0.5 w-full rounded-full bg-foreground/10" />
                <span className="h-0.5 w-3/5 rounded-full bg-foreground/10" />
                <span className="mt-auto h-2 w-full rounded-sm border border-foreground/10" />
              </span>
            </span>
          </span>
        </RadioGroupCard>
      ))}
    </RadioGroup>
  )
}
