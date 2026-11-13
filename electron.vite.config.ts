import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // main 双入口：index = Electron 主进程；host = Host（独立 Node 引擎进程）。
  // host 与主进程同管线构建（产物 out/main/host.js），但运行时由独立
  // Node 拉起（自带 resources/runtime 官方 node22，三级链见
  // src/electron/main/host/runtime.ts），与 Electron 内置 Node 无关。
  // pi 依赖保持 external：provider SDK 是懒加载的，打进 bundle 会破坏该机制。
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/electron/main/index.ts'),
          host: resolve('src/host/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/electron/preload/index.ts')
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
    plugins: [react(), tailwindcss()]
  }
})
