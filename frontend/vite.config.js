import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies API + WebSocket traffic to FastAPI, so the app uses relative URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
})
