import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // main 双入口：index = Electron 主进程；service = Agent 服务。
  // service 与主进程同管线构建（产物 out/main/service.js），但运行时由独立
  // 系统 Node 拉起，与 Electron 无关（架构见 AGENTS.md）。
  // pi 依赖保持 external：provider SDK 是懒加载的，打进 bundle 会破坏该机制。
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/electron/main/index.ts'),
          service: resolve('src/agent-service/index.ts')
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
