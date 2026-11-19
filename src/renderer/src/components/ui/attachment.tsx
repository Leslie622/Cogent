/** shadcn base-nova 官方附件原语；业务状态与路线由 AttachmentCards 组合。 */
import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Button } from "@/components/ui/button"

const attachmentVariants = cva(
  "group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 flex-wrap rounded-lg border bg-card text-card-foreground transition-colors has-[>a,>button]:hover:bg-muted/50 data-[state=error]:border-destructive/30 data-[state=idle]:border-dashed",
  {
    variants: {
      size: {
        default:
          "gap-2 text-sm has-data-[slot=attachment-content]:px-2.5 has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-media]:p-2",
        sm: "gap-2.5 text-xs has-data-[slot=attachment-content]:px-2 has-data-[slot=attachment-content]:py-1.5 has-data-[slot=attachment-media]:p-1.5",
        xs: "gap-1.5 rounded-lg text-xs has-data-[slot=attachment-content]:px-1.5 has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-media]:p-1",
      },
      orientation: {
        horizontal: "min-w-40 items-center",
        vertical: "w-24 flex-col has-data-[slot=attachment-content]:w-30",
      },
      variant: {
        default: "",
        file: "h-auto min-h-[45px] w-fit min-w-0 max-w-[min(180px,100%)] flex-nowrap has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-remove]:pr-6",
        image: "size-[45px] min-w-0 flex-nowrap overflow-hidden has-data-[slot=attachment-media]:p-0 [&>[data-slot=attachment-media]]:size-full [&>[data-slot=attachment-media]]:rounded-none [&>[data-slot=attachment-media]>img]:size-full",
      },
    },
  }
)

function Attachment({
  className,
  state = "done",
  size = "default",
  orientation = "horizontal",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof attachmentVariants> & {
    state?: "idle" | "uploading" | "processing" | "error" | "done"
  }) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      data-variant={variant}
      className={cn(attachmentVariants({ size, orientation, variant }), className)}
      {...props}
    />
  )
}

const attachmentMediaVariants = cva(
  "relative flex aspect-square w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-foreground group-data-[orientation=vertical]/attachment:w-full group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[size=xs]/attachment:rounded-md group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive group-data-[orientation=vertical]/attachment:*:data-[slot=spinner]:size-6! [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 group-data-[orientation=vertical]/attachment:[&_svg:not([class*='size-'])]:size-6 group-data-[size=xs]/attachment:[&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        icon: "",
        image:
          "opacity-60 group-data-[state=done]/attachment:opacity-100 group-data-[state=idle]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "icon",
    },
  }
)

function AttachmentMedia({
  className,
  variant = "icon",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof attachmentMediaVariants>) {
  return (
    <div
      data-slot="attachment-media"
      data-variant={variant}
      className={cn(attachmentMediaVariants({ variant }), className)}
      {...props}
    />
  )
}

function AttachmentContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-content"
      className={cn(
        "max-w-full min-w-0 flex-1 leading-tight group-data-[orientation=vertical]/attachment:px-1",
        className
      )}
      {...props}
    />
  )
}

function AttachmentTitle({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-title"
      className={cn(
        "block max-w-full min-w-0 truncate font-medium group-data-[state=processing]/attachment:shimmer group-data-[state=uploading]/attachment:shimmer",
        className
      )}
      {...props}
    />
  )
}

function AttachmentDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-description"
      className={cn(
        "mt-0.5 block min-w-0 truncate text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive/80",
        "max-w-full",
        className
      )}
      {...props}
    />
  )
}

function AttachmentActions({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "overlay" }) {
  return (
    <div
      data-slot="attachment-actions"
      data-variant={variant}
      className={cn(
        "relative z-20 flex shrink-0 items-center group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:top-3 group-data-[orientation=vertical]/attachment:right-3 group-data-[orientation=vertical]/attachment:gap-1",
        variant === "overlay" && "absolute top-0.5 left-0.5 gap-0.5",
        className
      )}
      {...props}
    />
  )
}

function AttachmentAction({
  className,
  variant,
  size = "icon-xs",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="attachment-action"
      variant={variant ?? "ghost"}
      size={size}
      className={cn(className)}
      {...props}
    />
  )
}

function AttachmentTrigger({
  className,
  render,
  type,
  ...props
}: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        type: render ? type : (type ?? "button"),
        className: cn("absolute inset-0 z-10 outline-none", className),
      },
      props
    ),
    render,
    state: {
      slot: "attachment-trigger",
    },
  })
}

function AttachmentRemove({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <AttachmentAction data-slot="attachment-remove" variant="secondary" size="icon-2xs"
    className={cn("pointer-events-none absolute top-0.5 right-0.5 z-30 opacity-0 group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100", className)} {...props} />
}

function AttachmentStatus({ className, state, ...props }: React.ComponentProps<"div"> & { state: "processing" | "error" }) {
  return <div data-slot="attachment-status" data-state={state}
    className={cn("absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1 px-0.5 py-0.5 text-xs leading-tight data-[state=processing]:bg-background/90 data-[state=error]:bg-destructive data-[state=error]:text-destructive-foreground", className)} {...props} />
}

function AttachmentGroup({ className, layout = "scroll", align = "start", ...props }: React.ComponentProps<"div"> & {
  layout?: "scroll" | "wrap" | "composer"
  align?: "start" | "end"
}) {
  return (
    <div
      data-slot="attachment-group"
      data-layout={layout}
      data-align={align}
      className={cn(
        "flex min-w-0 gap-3 py-1 *:data-[slot=attachment]:flex-none",
        layout === "scroll" ? "snap-x snap-mandatory scroll-px-1 scrollbar-none overflow-x-auto overscroll-x-contain *:data-[slot=attachment]:snap-start" : "flex-wrap",
        layout === "composer" && "max-h-40 overflow-y-auto overscroll-y-contain",
        align === "end" && "justify-end",
        className
      )}
      {...props}
    />
  )
}

export {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
  AttachmentRemove,
  AttachmentStatus,
}
