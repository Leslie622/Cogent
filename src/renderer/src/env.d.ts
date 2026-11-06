/// <reference types="vite/client" />
/**
 * window.cogent 的类型声明（与 electron/preload/index.ts 的 api 形状保持一致）。
 * 不直接 import preload 源码的类型：preload 属 tsconfig.node 工程，renderer 属
 * tsconfig.web —— eslint 的 projectService 解析不了跨工程引用（报 cannot be
 * resolved），改为本地声明窄接口，同时呼应"白名单窄接口"纪律：这里写的就是
 * renderer 能看到的全部能力。preload 侧形状变更时两处同步改。
 */
declare global {
  interface Window {
    cogent: {
      /** 查询 Agent 引擎服务连接状态（诊断） */
      getStatus: () => Promise<{
        state: 'starting' | 'running' | 'stopped' | 'failed'
        nodeVersion: string | null
        error: string | null
      }>
      /** 窗口控制（自绘 header 专用） */
      minimizeWindow: () => Promise<void>
      toggleMaximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      /** 订阅最大化状态变化，返回取消订阅函数 */
      onWindowState: (callback: (isMaximized: boolean) => void) => () => void
    }
  }
}

export {}
