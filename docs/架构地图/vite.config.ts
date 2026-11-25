/** 完全自包含的静态文档构建；不依赖主应用的 src/ 或外部字体资源。 */
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { LikeC4VitePlugin } from 'likec4/vite-plugin'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url))] },
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
