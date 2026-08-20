import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// electron.vite.config.ts と同じくアプリのバージョンを埋め込む。
const appVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }).version

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  // Honor PORT env var so the preview tool's auto-assigned port is used.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  plugins: [react()]
})
