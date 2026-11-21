/**
 * Sonner Toaster 封装（shadcn base-nova registry 版 + 本地最小修正）：
 * - 主题源改 appearance store 的 useIsDarkMode（registry 版绑 next-themes ——
 *   Next.js 生态依赖，本项目 Electron 不引；明暗与 .dark 类同源，见
 *   appearance-dom.ts，跟随应用内设置而非 OS 直读）；
 * - 配色走主题 CSS 变量（--popover/--border/--radius），明暗切换随 token 翻转；
 * - registry 的 toast classNames（cn-toast）是 CLI 安装期 style marker
 *   （约定.md：非真实类），已剥 —— toast 皮肤用 sonner 缺省；
 * - 宽度按条定（2026-11-20 用户定调）：toaster 恒缺省 356px（短反馈紧凑），
 *   长内容的错误 toast 在 showErrorToast 里按条覆盖 --width 560px ——
 *   var 挂在 toast 元素上（styles.css width:var(--width)），内联即覆盖继承；
 * - 字体对齐应用：sonner 硬编码系统栈（Windows 上 Segoe UI/雅黑）+ 13/12px
 *   固定，不跟项目的 Inter + HarmonyOS Sans SC 双字体栈与统一字号档 ——
 *   fontFamily inherit 吃 body 栈，toast/description 挂 text-sm!/text-xs!
 *   （! 压 sonner 样式表）随设置页字号变；
 * - richColors：按 success/info/warning/error 类型着色（sonner 内置调色板，
 *   亮色淡彩底/暗色深彩底随主题翻转，shadcn 文档同款用法）；
 * - action 槽（toast 右侧按钮）同色淡底（2026-11-20 用户定调：ghost 静息太
 *   隐身、黑底填充跳出色系）：静息 bg-current/10、hover 加深 /20，图标
 *   text-inherit —— 按钮始终是 toast 同色系的淡色块（红 toast 淡红、普通
 *   toast 中性，暗色主题自适应）；ml-3 固定外左边距、px-3 内边距（sonner
 *   缺省外距 auto 贴右、内距 8px 偏挤）；! 后缀工具类压 sonner 样式表。
 * showErrorToast：错误 toast 配方（useErrorToast 的呈现端，2026-11-20 用户
 * 定调）：标题「出错了」+ 详情 description、5s 自动消失（详情引擎控制台
 * 留痕）、右侧 action 槽 ghost 图标关闭钮（点击后 sonner 自动 dismiss）。
 */
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { toast } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon, XIcon } from "lucide-react"
import { useIsDarkMode } from "@/stores/appearance"

const Toaster = ({ ...props }: ToasterProps) => {
  const dark = useIsDarkMode()

  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      className="toaster group"
      richColors
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          fontFamily: "inherit",
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          actionButton:
            "ml-3! bg-current/10! px-3! rounded-md! text-inherit! transition-colors! hover:bg-current/20!",
          toast: "text-sm!",
          description: "text-xs!",
        },
      }}
      {...props}
    />
  )
}

/** 错误 toast 配方（见文件头注）；返回 toast id（当前无消费方，留作扩展） */
export function showErrorToast(description: string): string | number {
  return toast.error("出错了", {
    description,
    duration: 5000,
    // 长错误详情专用宽度（见文件头注：宽度按条定）
    style: { "--width": "560px" } as React.CSSProperties,
    action: {
      // onClick 类型必填；sonner 点击 action 后自行 deleteToast，无需手动 dismiss
      onClick: () => {},
      label: (
        <span role="img" aria-label="关闭">
          <XIcon className="size-4" aria-hidden="true" />
        </span>
      ),
    },
  })
}

export { Toaster }
