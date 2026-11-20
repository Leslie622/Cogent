/** 浏览器验收面的独立 vite 配置（@/ 别名同应用）。
    与 electron-vite 互不相干：只服务 *.browser.html 真渲染自查页。
    root 必须是项目根：tailwind v4 的源扫描以 vite root 为基准，root 指到
    tests/ 时 src/ 组件里的工具类（w-40/h-1/size-3…）全部不生成 —— 页面
    "看着正常"只是 harness 文件恰好共用基础类的巧合，滑杆类没人共用即
    隐形（2026-11-18 通知页"看不见音量/音调"实况）。访问路径带全目录：
    /tests/renderer/features/<域>/<名>.browser.html */
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { pdfAssets } from '../scripts/pdf-assets'

export default defineConfig({
  root: resolve('.'),
  resolve: {
    alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') }
  },
  plugins: [react(), tailwindcss(), pdfAssets()],
  optimizeDeps: { entries: ['tests/renderer/**/*.browser.html'] },
  server: { watch: { ignored: ['**/reference/**', '**/out/**'] } }
})
