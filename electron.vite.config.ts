import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// アプリのバージョンをレンダラーに埋め込む（LAN リモート配信でも同じビルドが
// 使われるため、IPC ではなくビルド時定数にする）。
const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }).version

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
