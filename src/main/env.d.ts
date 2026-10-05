// Vite の ?raw インポート (ファイル内容を文字列として同梱)
declare module '*?raw' {
  const content: string
  export default content
}
