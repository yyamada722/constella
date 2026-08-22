// Copies the in-app help chapters (src/renderer/src/help/NN-id.md) into
// docs/guide/<id>.md so the docs site and the app share one source of truth.
// docs/guide/ is generated — do not edit by hand (it is gitignored).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/renderer/src/help')
const dst = join(root, 'docs/guide')

rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })

// Docs-only footer linking a quick-guide chapter to its deep-dive section. The
// in-app help has no such pages, so the link is appended here, not in the source.
const DEEP_DIVES = {
  notes: { title: 'ノート', link: '/features/notes/' },
  tasks: { title: 'タスク・ガント', link: '/features/tasks/' },
  canvas: { title: 'キャンバス', link: '/features/canvas/' },
  plan: { title: '計画', link: '/features/plan/' },
  pages: { title: 'その他のページ', link: '/features/pages/dashboard' },
}

const files = readdirSync(src).filter(f => /^\d\d-.+\.md$/.test(f)).sort()
for (const f of files) {
  const id = f.replace(/^\d\d-/, '').replace(/\.md$/, '')
  const body = readFileSync(join(src, f), 'utf8')
  const header = `<!-- 自動生成: src/renderer/src/help/${f} を編集してください -->\n\n`
  const deep = DEEP_DIVES[id]
  const footer = deep ? `\n\n---\n\n画像・操作アニメーション付きの詳しい説明は [機能詳細: ${deep.title}](${deep.link}) をご覧ください。\n` : ''
  writeFileSync(join(dst, `${id}.md`), header + body + footer)
}
console.log(`synced ${files.length} chapters → docs/guide/`)
