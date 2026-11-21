import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { pdfAssets } from './scripts/pdf-assets'

/** 合并 SDK 后仍以原包定位资源，避免图片 worker、扩展别名和包元数据指向 out/。 */
function preservePiModuleUrls(): Plugin {
  const sdkDirectory = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
  return {
    name: 'cogent:pi-resource-urls',
    enforce: 'pre',
    transform(code, id) {
      const modulePath = relative(sdkDirectory, id).replaceAll('\\', '/')
      if (modulePath.startsWith('..') || !modulePath.endsWith('.js') || !code.includes('import.meta.url')) return null
      // 只解析公开入口，不执行原包入口；保留原始 URL，SDK 自己的资源加载规则不变。
      // SDK 的局部路径变量另命名，避免与 electron-vite 注入的 CJS shim 重名。
      return {
        code: `const __cogentPiModuleUrl = new URL(${JSON.stringify(modulePath)}, import.meta.resolve('@earendil-works/pi-coding-agent')).href;\n` + code
          .replaceAll('import.meta.url', '__cogentPiModuleUrl')
          .replaceAll('__filename', '__cogentPiFilename')
          .replaceAll('__dirname', '__cogentPiDirname'),
        map: null
      }
    }
  }
}

export default defineConfig({
  // main 双入口：index = Electron 主进程；host = Host（独立 Node 引擎进程）。
  // host 与主进程同管线构建（产物 out/main/host.js），但运行时由独立
  // Node 拉起（自带 resources/runtime 官方 node22，三级链见
  // src/electron/main/host/runtime.ts），与 Electron 内置 Node 无关。
  // coding-agent 与 TypeBox 合并，消除首次安装时数百个同步文件打开；pi-ai 与
  // 厂商 SDK 保持 external，沿用同一份方言懒加载缓存。资源 URL 由上方插件保留。
  // mcp = 对外 MCP Server（阶段 5a）：外部 MCP 客户端 stdio spawn 的独立
  // 入口（out/main/mcp.js），与 host 同管线同 node22 —— 不经 Electron。
  main: {
    plugins: [preservePiModuleUrls()],
    build: {
      externalizeDeps: {
        exclude: ['@earendil-works/pi-coding-agent', 'typebox'],
        include: ['@earendil-works/pi-tui', '@earendil-works/pi-codemode', '@earendil-works/pi-telemetry',
          'jiti', 'quickjs-wasi', '@silvia-odwyer/photon-node', 'highlight.js', 'lovely-mermaid']
      },
      rollupOptions: {
        input: {
          index: resolve('src/electron/main/index.ts'),
          host: resolve('src/host/index.ts'),
          mcp: resolve('src/host/mcp-server/main.ts'),
          'search-worker': resolve('src/host/runtime/search/worker.ts'),
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
