/**
 * 内嵌页面 demo 窗口根组件（阶段 3a 验收载体，ipc/embedded.ts 的 '#embedded'
 * 分流）：纯容器 —— 放一个 <webview> 加载 demo.html。
 *
 * 边界（D10）：真正的页面安全边界不在本组件（宿主），在 guest 侧 ——
 * webview-policy.ts 的 will-attach-webview 钩子会强制 sandbox/contextIsolation
 * 并指定 guest preload，renderer 这里写什么都不算数。
 */
// React 19 无全局 JSX namespace，经模块扩展（interface 合并）补 webview 元素
// 声明（Electron 特有标签；属性面只声明用到的一个 —— 其余由 will-attach-webview 覆写）。
// 注意：declare module 块内的类型名解析优先 react 模块自身导出，无需本地 import。
declare module 'react' {
  interface IntrinsicElements {
    webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { src: string }
  }
}

export function EmbeddedDemo() {
  // dev = vite public 的 /demo.html；打包 = out/renderer/demo.html（相对宿主 index.html）
  const src = new URL('demo.html', window.location.href).toString()
  return (
    <div className="h-screen w-screen bg-background">
      <webview src={src} className="h-full w-full" style={{ border: 'none' }} />
    </div>
  )
}
