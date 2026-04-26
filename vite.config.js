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
  }
})
