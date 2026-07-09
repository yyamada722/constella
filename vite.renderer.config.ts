import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  // Honor PORT env var so the preview tool's auto-assigned port is used.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  plugins: [react()]
})
