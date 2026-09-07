import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
  ],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // 生产由 nginx 剥掉 /api 前缀, 本地 dev 同样 rewrite
      '/api': {
        target: 'http://localhost:3001',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  }
})
