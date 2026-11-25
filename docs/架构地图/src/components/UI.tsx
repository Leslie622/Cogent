/** 自包含轻 UI 原语：保留一致的中性色视觉、可读焦点环与 ARIA 语义，无外部组件库耦合。 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

function cx(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(' ')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'ghost' | 'outline' | 'link'
  size?: 'default' | 'sm' | 'icon'
}

export function Button({ variant = 'default', size = 'default', className, type = 'button', ref, ...props }: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    />
  )
}

export function Card({ size = 'default', className, children, ...props }: HTMLAttributes<HTMLDivElement> & { size?: 'default' | 'sm' }) {
  return (
    <div data-slot="card" data-size={size} className={cx('ui-card', className)} {...props}>
      {children}
    </div>
  )
}

export function CardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('ui-card-header', className)} {...props}>{children}</div>
}

export function CardTitle({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('ui-card-title', className)} {...props}>{children}</div>
}

export function Badge({ variant = 'secondary', size = 'default', className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { variant?: 'secondary' | 'outline'; size?: 'default' | 'sm' }) {
  return (
    <span className={cx('ui-badge', `ui-badge-${variant}`, `ui-badge-${size}`, className)} {...props}>
      {children}
    </span>
  )
}

export function Separator({ orientation = 'horizontal', className, ...props }: HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cx('ui-separator', `ui-separator-${orientation}`, className)}
      {...props}
    />
  )
}

export function IconButton({ label, className, children, ref, ...props }: ButtonProps & { label: string; ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={className}
      {...props}
    >
      {children}
    </Button>
  )
}

export function CollapsiblePanel({
  open,
  id,
  className,
  children,
  onKeyDown,
}: {
  open: boolean
  id: string
  className?: string
  children: ReactNode
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div className={className} data-collapsed={!open} inert={!open} onKeyDown={onKeyDown}>
      <div id={id} className="architecture-side-content">
        {children}
      </div>
    </div>
  )
}
