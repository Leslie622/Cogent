/** 自包含 SVG 图标集（Lucide 风格 24×24），避免跨目录依赖根 node_modules。 */
import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement>
export type IconComponent = (props: IconProps) => React.JSX.Element

function Icon({ children, className = 'size-4', ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const LayersIcon: IconComponent = (p) => (
  <Icon {...p}><path d="m12 2 10 5-10 5L2 7Z" /><path d="m2 12 10 5 10-5" /><path d="m2 17 10 5 10-5" /></Icon>
)
export const ServerIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></Icon>
)
export const GlobeIcon: IconComponent = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Icon>
)
export const NetworkIcon: IconComponent = (p) => (
  <Icon {...p}><rect x="16" y="16" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="9" y="2" width="6" height="6" rx="1" /><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" /><path d="M12 12V8" /></Icon>
)
export const BotIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></Icon>
)
export const PlugIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></Icon>
)
export const TerminalIcon: IconComponent = (p) => (
  <Icon {...p}><polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" /></Icon>
)
export const FingerprintIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" /><path d="M14 13.12c0 2.38 0 6.38-1 8.88" /><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" /><path d="M2 12a10 10 0 0 1 18-6" /><path d="M2 16h.01" /><path d="M21.8 16c.2-2 .131-5.354 0-6" /><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" /><path d="M8.65 22c.21-.66.45-1.32.57-2" /><path d="M9 6.8a6 6 0 0 1 9 5.2v2" /></Icon>
)
export const RouteIcon: IconComponent = (p) => (
  <Icon {...p}><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></Icon>
)
export const ShieldCheckIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></Icon>
)
export const BlocksIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="7" height="7" x="14" y="3" rx="1" /><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" /></Icon>
)
export const CpuIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="16" height="16" x="4" y="4" rx="2" /><rect width="6" height="6" x="9" y="9" rx="1" /><path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" /><path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" /></Icon>
)
export const DatabaseIcon: IconComponent = (p) => (
  <Icon {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></Icon>
)
export const MonitorIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></Icon>
)
export const WorkflowIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></Icon>
)
export const KeyIcon: IconComponent = (p) => (
  <Icon {...p}><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" /><path d="m21 2-9.6 9.6" /><circle cx="7.5" cy="15.5" r="5.5" /></Icon>
)
export const SparklesIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /><path d="M19 3v4" /><path d="M21 5h-4" /></Icon>
)
export const CheckIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M20 6 9 17l-5-5" /></Icon>
)
export const CircleDashedIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M10.1 2.182a10 10 0 0 1 3.8 0" /><path d="M13.9 21.818a10 10 0 0 1-3.8 0" /><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /><path d="M2.182 13.9a10 10 0 0 1 0-3.8" /><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /><path d="M21.818 10.1a10 10 0 0 1 0 3.8" /><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" /></Icon>
)
export const CircleDotIcon: IconComponent = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></Icon>
)
export const ExternalLinkIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Icon>
)
export const ArrowLeftIcon: IconComponent = (p) => (
  <Icon {...p}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Icon>
)
export const ArrowUpRightIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M7 7h10v10" /><path d="M7 17 17 7" /></Icon>
)
export const ArrowDownRightIcon: IconComponent = (p) => (
  <Icon {...p}><path d="m7 7 10 10" /><path d="M17 7v10H7" /></Icon>
)
export const PanelLeftCloseIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" /></Icon>
)
export const PanelLeftOpenIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m14 9 3 3-3 3" /></Icon>
)
export const PanelRightCloseIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /><path d="m8 9 3 3-3 3" /></Icon>
)
export const PanelRightOpenIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /><path d="m10 15-3-3 3-3" /></Icon>
)
export const SunIcon: IconComponent = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></Icon>
)
export const MoonIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Icon>
)
export const MinusIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M5 12h14" /></Icon>
)
export const PlusIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Icon>
)
export const ScanIcon: IconComponent = (p) => (
  <Icon {...p}><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /></Icon>
)
export const Undo2Icon: IconComponent = (p) => (
  <Icon {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></Icon>
)
export const ListChecksIcon: IconComponent = (p) => (
  <Icon {...p}><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></Icon>
)
export const Code2Icon: IconComponent = (p) => (
  <Icon {...p}><path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" /></Icon>
)
export const CopyIcon: IconComponent = (p) => (
  <Icon {...p}><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Icon>
)
