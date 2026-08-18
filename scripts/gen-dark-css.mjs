// Dark-theme override generator.
//
// The app's markup uses light-palette Tailwind utilities directly (bg-white,
// text-slate-800, bg-amber-50 …) with no dark: variants. Rather than hand-edit
// ~15k class sites, this script scans the renderer source for every light-ish
// utility actually in use and emits src/renderer/src/dark-overrides.css that
// remaps each one under `.dark`.
//
// Selectors use `:where(.dark)` so each override has the SAME specificity as
// the original utility and simply wins by source order (the file is imported
// after index.css). That keeps Tailwind's cascade semantics intact: an
// unmapped `focus:border-indigo-400` (0,1,1) still beats our remapped base
// `border-slate-200` (0,1,0), and explicit `dark:` variants (0,2,0) beat
// everything here.
//
// Run:  node scripts/gen-dark-css.mjs
// Re-run whenever new light-palette utility classes are added to the source.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const palette = require('tailwindcss/colors')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'renderer', 'src')
const OUT = join(SRC, 'dark-overrides.css')

/* ── collect class tokens ── */

const FAMILIES = ['white', 'black', 'slate', 'gray', 'zinc', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose']
const TOKEN_RE = new RegExp(
  String.raw`(?<variant>group-hover:|hover:|focus:|focus-within:|active:|disabled:|placeholder:)?` +
  String.raw`(?<prop>bg|text|border|ring|divide|placeholder|caret)-` +
  String.raw`(?<family>${FAMILIES.join('|')})` +
  String.raw`(?:-(?<shade>[0-9]{2,3}))?` +
  String.raw`(?:\/(?<alpha>[0-9]{1,3}))?` +
  String.raw`(?![\w/-])`,
  'g'
)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(tsx?|html)$/.test(name)) yield p
  }
}

const tokens = new Set()
for (const file of [...walk(SRC), join(ROOT, 'src', 'renderer', 'index.html')]) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(TOKEN_RE)) tokens.add(m[0])
}

/* ── mapping ── */

const hexToRgb = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [0, 1, 2].map(i => parseInt(full.slice(i * 2, i * 2 + 2), 16))
}
const shadeHex = (family, shade) => {
  const fam = palette[family]
  const hex = typeof fam === 'string' ? fam : fam?.[shade]
  if (!hex) throw new Error(`no palette entry ${family}-${shade}`)
  return hex
}
const cssColor = (family, shade, alpha) => {
  const [r, g, b] = hexToRgb(shadeHex(family, shade))
  return alpha != null ? `rgb(${r} ${g} ${b} / ${alpha / 100})` : `rgb(${r} ${g} ${b})`
}

const BG_LIKE = new Set(['bg', 'border', 'ring', 'divide'])
const TEXT_LIKE = new Set(['text', 'placeholder', 'caret'])

// slate/gray/zinc UI-neutral remaps (shade → dark [family, shade])
const NEUTRAL_BG = { 50: 900, 100: 800, 200: 700, 300: 600, 400: 500, 500: 500 }
const NEUTRAL_BORDER = { 50: 800, 100: 800, 200: 700, 300: 600, 400: 500 }
const NEUTRAL_TEXT = { 300: 600, 400: 500, 500: 400, 600: 400, 700: 300, 800: 200, 900: 100 }
// pastel accent remaps (colored cards / chips)
const COLOR_BG = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600 }
const COLOR_BORDER = { 100: 900, 200: 800, 300: 700, 400: 600 }
const COLOR_TEXT = { 500: 400, 600: 400, 700: 300, 800: 200, 900: 200 }

// The dark UI is deliberately ACHROMATIC: every neutral family (slate/gray/
// zinc/white) lands on Tailwind's pure-gray `neutral` ramp, not blue-tinted
// slate. Chromatic accents keep their hue.
const DARK_NEUTRAL = 'neutral'

// Returns a CSS color string, or null to leave the class untouched in dark mode.
function darkValue(prop, family, shade, alpha) {
  if (family === 'black') return null
  if (family === 'white') {
    if (!BG_LIKE.has(prop)) return null // text-white on accent buttons stays
    return cssColor(DARK_NEUTRAL, prop === 'bg' ? 800 : 700, alpha)
  }
  const s = shade == null ? null : Number(shade)
  if (s == null) return null
  const neutral = family === 'slate' || family === 'gray' || family === 'zinc'
  if (neutral) {
    if (BG_LIKE.has(prop)) {
      // Keep dark chips / modal backdrops (bg-slate-700+) as they are.
      if (s >= 600) return null
      const to = prop === 'bg' ? NEUTRAL_BG[s] : NEUTRAL_BORDER[s]
      return to ? cssColor(DARK_NEUTRAL, to, alpha) : null
    }
    // Light-on-dark chips (text-slate-100/200 on bg-slate-800) stay readable.
    if (s <= 200) return null
    const to = NEUTRAL_TEXT[s]
    return to ? cssColor(DARK_NEUTRAL, to, alpha) : null
  }
  // chromatic families
  if (BG_LIKE.has(prop)) {
    if (s >= 500) return null // solid accent buttons keep their color
    const to = prop === 'bg' || prop === 'divide' ? COLOR_BG[s] : COLOR_BORDER[s]
    return to ? cssColor(family, to, alpha) : null
  }
  if (s <= 400) return null // already bright enough for dark bg
  const to = COLOR_TEXT[s]
  return to ? cssColor(family, to, alpha) : null
}

/* ── emit ── */

const escapeClass = (cls) => cls.replace(/[:/]/g, (ch) => '\\' + ch)

const PSEUDO = {
  'hover:': ':hover',
  'focus:': ':focus',
  'focus-within:': ':focus-within',
  'active:': ':active',
  'disabled:': ':disabled',
  // placeholder: is a pseudo-ELEMENT — without this mapping the override lands on
  // the input's own text color instead of the placeholder.
  'placeholder:': '::placeholder',
}

function ruleFor(token) {
  const m = TOKEN_RE.exec(token); TOKEN_RE.lastIndex = 0
  if (!m) return null
  const { variant, prop, family, shade, alpha } = m.groups
  const value = darkValue(prop, family, shade == null ? null : shade, alpha == null ? null : Number(alpha))
  if (!value) return null

  let selector = `:where(.dark) .${escapeClass(token)}`
  if (variant === 'group-hover:') selector = `:where(.dark) .group:hover .${escapeClass(token)}`
  else if (variant && PSEUDO[variant]) selector += PSEUDO[variant]

  let body
  switch (prop) {
    case 'bg': body = `background-color: ${value};`; break
    case 'text': body = `color: ${value};`; break
    case 'caret': body = `caret-color: ${value};`; break
    case 'border': body = `border-color: ${value};`; break
    case 'ring': body = `--tw-ring-color: ${value};`; break
    case 'placeholder':
      selector += '::placeholder'
      body = `color: ${value};`
      break
    case 'divide':
      selector += ' > :not([hidden]) ~ :not([hidden])'
      body = `border-color: ${value};`
      break
    default: return null
  }
  return `${selector} { ${body} }`
}

const rules = [...tokens].sort().map(ruleFor).filter(Boolean)

const header = `/* AUTO-GENERATED by scripts/gen-dark-css.mjs — do not edit by hand.
 * Remaps every light-palette Tailwind utility found in the source to a dark
 * equivalent under .dark, at equal specificity via :where(). Re-run the script
 * after adding new light-palette classes. ${rules.length} rules. */
`

writeFileSync(OUT, header + rules.join('\n') + '\n')
console.log(`wrote ${OUT} (${rules.length} rules from ${tokens.size} tokens)`)
