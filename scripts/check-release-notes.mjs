// リリースノート (release-notes/v<version>.md) の存在と書式を検査する。
// PR の CI (Build) とリリース (Release) の両方で実行し、書き忘れ・書式崩れを止める。
// 書式は release-notes/README.md を参照。
//
//   node scripts/check-release-notes.mjs            package.json の version を検査
//   node scripts/check-release-notes.mjs v0.8.8     指定タグを検査
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tag = process.argv[2] || `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`
const rel = `release-notes/${tag}.md`
const file = join(root, rel)

const errors = []
if (!existsSync(file)) {
  errors.push(`${rel} がありません。version を上げたら同じ PR でリリースノートを書いてください (release-notes/README.md)`)
} else {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const first = lines.find(l => l.trim() !== '')
  if (!first || !/^\*\*.+\*\*$/.test(first.trim())) errors.push('1 行目は **太字の要約** にしてください')

  const SECTIONS = ['## ✨ 新機能', '## 🛠 改善', '## 🐞 修正', '## ⚠️ ご注意']
  let inFence = false
  const h2 = []
  lines.forEach((l, i) => {
    // 書きかけはコード例の中でも検出する
    if (/\bTODO\b|TBD|要記入|あとで書く/i.test(l)) errors.push(`${i + 1} 行目: 書きかけの記述が残っています`)
    if (l.startsWith('```')) inFence = !inFence
    if (inFence) return
    if (/^#\s/.test(l)) errors.push(`${i + 1} 行目: # 見出しは使わないでください (タイトルはリリース名が付きます)`)
    if (/^##\s/.test(l)) {
      if (!SECTIONS.includes(l.trim())) errors.push(`${i + 1} 行目: 見出し「${l.trim()}」は使えません (${SECTIONS.join(' / ')})`)
      else h2.push(l.trim())
    }
  })
  if (!h2.length) errors.push(`節がありません (${SECTIONS.join(' / ')} のいずれか)`)
  const order = h2.map(h => SECTIONS.indexOf(h))
  if (order.some((v, i) => i > 0 && v <= order[i - 1])) errors.push(`節は ${SECTIONS.join(' → ')} の順で、各 1 回だけにしてください`)
}

if (errors.length) {
  for (const e of errors) console.error(`::error file=${rel}::${e}`)
  process.exit(1)
}
console.log(`✓ ${rel}`)
