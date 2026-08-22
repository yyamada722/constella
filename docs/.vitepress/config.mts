import { defineConfig } from 'vitepress'
import mark from 'markdown-it-mark'

// Chapter order mirrors src/renderer/src/help/index.ts (HELP_CHAPTERS).
const guide = [
  { text: 'はじめに', link: '/guide/intro' },
  { text: 'ノート', link: '/guide/notes' },
  { text: 'タスク・ガント', link: '/guide/tasks' },
  { text: 'キャンバス', link: '/guide/canvas' },
  { text: '計画', link: '/guide/plan' },
  { text: 'その他のページ', link: '/guide/pages' },
  { text: 'ショートカット', link: '/guide/shortcuts' },
  { text: 'データとバックアップ', link: '/guide/data' },
]

// Per-feature deep dives with screenshots / GIFs (docs/features/**, media from
// `npm run docs:capture`).
const features = [
  {
    text: 'キャンバス',
    collapsed: false,
    items: [
      { text: '全体像', link: '/features/canvas/' },
      { text: 'カードの種類と操作', link: '/features/canvas/cards' },
      { text: 'ツール', link: '/features/canvas/tools' },
      { text: '移動・ズーム・表示', link: '/features/canvas/navigation' },
      { text: 'タスク下書きからタスクへ', link: '/features/canvas/task-draft' },
      { text: '書き出しと共有', link: '/features/canvas/export' },
    ],
  },
]

const reference = [
  { text: 'Markdown 記法リファレンス', link: '/reference/markdown' },
  { text: '計画（旅程）記法リファレンス', link: '/reference/plan-syntax' },
  { text: 'よくある質問', link: '/reference/faq' },
]

export default defineConfig({
  lang: 'ja-JP',
  title: 'Constella',
  description: 'ノート・タスク・キャンバス・旅程をひとつにまとめる情報整理デスクトップアプリ',
  base: '/constella/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/constella/favicon.svg' }]],
  markdown: {
    config(md) {
      md.use(mark)
      // ```mermaid fences → <Mermaid> client component (registered in theme/index.ts).
      const fence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx]
        if (t.info.trim().split(/\s+/)[0] === 'mermaid') {
          return `<Mermaid code="${encodeURIComponent(t.content)}" />`
        }
        return fence(tokens, idx, options, env, self)
      }
    },
  },
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'ガイド', link: '/guide/intro', activeMatch: '/guide/' },
      { text: '機能詳細', link: '/features/canvas/', activeMatch: '/features/' },
      { text: 'リファレンス', link: '/reference/markdown', activeMatch: '/reference/' },
      { text: 'ダウンロード', link: 'https://github.com/yyamada722/constella/releases/latest' },
    ],
    sidebar: [
      { text: 'ガイド', items: guide },
      { text: '機能詳細', items: features },
      { text: 'リファレンス', items: reference },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/yyamada722/constella' }],
    search: { provider: 'local', options: { translations: { button: { buttonText: '検索', buttonAriaLabel: '検索' }, modal: { noResultsText: '見つかりませんでした', resetButtonTitle: 'クリア', footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' } } } } },
    outline: { label: 'このページの内容', level: [2, 3] },
    docFooter: { prev: '前へ', next: '次へ' },
    lastUpdated: { text: '最終更新' },
    returnToTopLabel: 'トップへ戻る',
    sidebarMenuLabel: 'メニュー',
    darkModeSwitchLabel: 'テーマ',
    editLink: {
      pattern: ({ filePath }) =>
        filePath.startsWith('guide/')
          ? `https://github.com/yyamada722/constella/edit/main/src/renderer/src/help/`
          : `https://github.com/yyamada722/constella/edit/main/docs/${filePath}`,
      text: 'GitHub でこのページを編集',
    },
    footer: { message: 'Constella — 情報整理デスクトップアプリ', copyright: '© Yusuke Yamada' },
  },
})
