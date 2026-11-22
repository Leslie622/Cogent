/** 文档独立构建；模型预先布局，共享 UI 通过同一 React 实例消费。 */
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { LikeC4VitePlugin } from 'likec4/vite-plugin'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  // 字体与共享组件位于独立项目之外，开发服务需显式允许读取这两处源码。
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), fileURLToPath(new URL('../../src', import.meta.url))] },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../../src/shared', import.meta.url)),
    },
    dedupe: ['react', 'react-dom', 'zustand'],
  },
  plugins: [
    LikeC4VitePlugin({
      workspace: fileURLToPath(new URL('./模型', import.meta.url)),
      throwIfInvalid: true,
    }),
    react(),
    tailwindcss(),
    viteSingleFile(),
  ],
  build: { target: 'es2022', reportCompressedSize: false },
})
