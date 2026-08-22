// Fetches the published screenshots / GIFs from the single-commit `docs-media`
// branch into docs/public/media (which is NOT tracked on main — CI regenerates
// it, see .github/workflows/capture-media.yml). Run before a local docs build
// when you have not captured locally:  npm run docs:media
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'docs/public/media')

execFileSync('git', ['fetch', 'origin', 'docs-media'], { cwd: root, stdio: 'inherit' })
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
// FETCH_HEAD is what the fetch above actually updated — origin/docs-media may be
// stale (force-pushed branch) or absent entirely (single-branch clones).
// git archive → tar keeps this cross-platform (bsdtar ships with Windows 10+).
const tarBuf = execFileSync('git', ['archive', 'FETCH_HEAD'], { cwd: root, maxBuffer: 1024 * 1024 * 200 })
execFileSync('tar', ['-x', '-C', dest], { input: tarBuf })
console.log('docs-media → docs/public/media 取得完了')
