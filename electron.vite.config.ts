import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { pdfAssets } from './scripts/pdf-assets'

export default defineConfig({
  // main 双入口：index = Electron 主进程；host = Host（独立 Node 引擎进程）。
  // host 与主进程同管线构建（产物 out/main/host.js），但运行时由独立
  // Node 拉起（自带 resources/runtime 官方 node22，三级链见
  // src/electron/main/host/runtime.ts），与 Electron 内置 Node 无关。
  // pi 依赖保持 external：provider SDK 是懒加载的，打进 bundle 会破坏该机制。
  // mcp = 对外 MCP Server（阶段 5a）：外部 MCP 客户端 stdio spawn 的独立
  // 入口（out/main/mcp.js），与 host 同管线同 node22 —— 不经 Electron。
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/electron/main/index.ts'),
          host: resolve('src/host/index.ts'),
          mcp: resolve('src/host/mcp-server/main.ts'),
          'attachment-worker': resolve('src/host/runtime/attachment-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 双入口：index = 主 UI/console 宿主（sandbox:false）；guest = webview
        // 第三方页面桥（sandbox:true —— 沙箱 preload 不支持 ESM，故全段
        // 输出 CJS，index 同转 CJS 由 Electron 非沙箱 preload 兼容）
        input: {
          index: resolve('src/electron/preload/index.ts'),
          guest: resolve('src/electron/preload/guest.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss(), pdfAssets()]
  }
})
