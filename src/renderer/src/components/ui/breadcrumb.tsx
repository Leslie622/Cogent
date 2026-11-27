/** Nova 面包屑；scroll 档保留原生横向滚动，以主题无关的遮罩提示被裁出的路径。 */
import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "cn"
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"
import { useHorizontalScrollFade, useHorizontalScrollPan } from "@/hooks/use-horizontal-scroll-fade"

function Breadcrumb({ className, variant = "default", ref, children, ...props }: React.ComponentProps<"nav"> & { variant?: "default" | "scroll" }) {
  const viewport = React.useRef<HTMLElement>(null)
  const scrollable = variant === "scroll"
  useHorizontalScrollFade(viewport, scrollable, children)
  useHorizontalScrollPan(viewport, scrollable)
  return useRender({
    defaultTagName: "nav",
    ref: [viewport, ref ?? null],
    props: {
      "aria-label": "breadcrumb",
      "data-slot": "breadcrumb",
      "data-variant": variant,
      className: cn(
        scrollable && "scroll-fade-x scroll-fade-edges overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&[data-scroll-left]:not([data-dragging])]:cursor-grab [&[data-scroll-right]:not([data-dragging])]:cursor-grab data-[dragging]:cursor-grabbing data-[dragging]:**:cursor-grabbing data-[dragging]:select-none",
        className
      ),
      children,
      ...props,
    },
  })
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm wrap-break-word text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn("transition-colors hover:text-foreground", className),
      },
      props
    ),
    render,
    state: {
      slot: "breadcrumb-link",
    },
  })
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? (
        <ChevronRightIcon />
      )}
    </li>
  )
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn(
        "flex size-5 items-center justify-center [&>svg]:size-4",
        className
      )}
      {...props}
    >
      <MoreHorizontalIcon
      />
      <span className="sr-only">More</span>
    </span>
  )
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
