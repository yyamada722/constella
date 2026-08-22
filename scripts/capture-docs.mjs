// Documentation media generator.
//
// Boots the real Electron app against a throwaway userData dir, loads the demo
// dataset (scripts/docs-media/seed.mjs) through the backup importer, then drives
// the UI with puppeteer-core to produce PNG screenshots and short GIF clips under
// docs/public/media/<section>/. Scenarios live in scripts/docs-media/scenarios/.
//
//   npm run docs:capture                 # build app + capture every section
//   npm run docs:capture -- canvas       # one section
//   npm run docs:capture -- --no-build   # reuse out/ from the last build
//   npm run docs:capture -- --only=canvas-overview   # single scenario by name
//
// Requires ffmpeg on PATH for GIF encoding.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { buildSeed } from './docs-media/seed.mjs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')
const DEBUG_PORT = 9333
const VIEW = { width: 1600, height: 1000 }

const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')
const only = args.find(a => a.startsWith('--only='))?.slice(7)
const sections = args.filter(a => !a.startsWith('--'))

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── app lifecycle ──
function buildApp() {
  console.log('▶ electron-vite build')
  execFileSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: true })
}

function launchApp(userData) {
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: root,
    // Off-screen, exact content size (see forcedBounds() in src/main/index.ts).
    env: { ...process.env, CONSTELLA_USERDATA: userData, CONSTELLA_WINDOW_BOUNDS: `-4000,0,${VIEW.width},${VIEW.height}`, ELECTRON_ENABLE_LOGGING: '0' },
    stdio: 'ignore',
  })
  return child
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null })
      const pages = await browser.pages()
      const page = pages.find(p => /index\.html/.test(p.url()))
      if (page) return { browser, page }
      await browser.disconnect()
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('Electron did not expose a debuggable page')
}

// Load the demo dataset through the real backup importer (hidden <input type=file>
// in the sidebar settings menu) — the app reloads itself afterwards.
async function seed(page, seedPath) {
  await page.waitForSelector('input[type="file"][accept*="json"]', { timeout: 30000 })
  const input = await page.$('input[type="file"][accept*="json"]')
  await input.uploadFile(seedPath)
  // "現在のデータをバックアップの内容で置き換えます" confirm
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '置き換える'), { timeout: 10000 })
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '置き換える').click())
  await page.waitForFunction(() => document.title.includes('札幌ロケハン'), { timeout: 30000 })
  await sleep(800)
}

// Fake cursor so GIFs show where the pointer is (real cursor is never captured).
async function installCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__docs-cursor')) return
    const c = document.createElement('div')
    c.id = '__docs-cursor'
    c.innerHTML = `<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`
    Object.assign(c.style, { position: 'fixed', left: '-50px', top: '-50px', zIndex: '2147483647', pointerEvents: 'none', transition: 'transform 40ms linear' })
    document.body.appendChild(c)
    const ring = document.createElement('div')
    ring.id = '__docs-click'
    Object.assign(ring.style, { position: 'fixed', width: '28px', height: '28px', borderRadius: '50%', border: '3px solid #6366f1', zIndex: '2147483646', pointerEvents: 'none', opacity: '0', transform: 'translate(-50%,-50%)' })
    document.body.appendChild(ring)
    let x = 0, y = 0
    window.addEventListener('mousemove', e => { x = e.clientX; y = e.clientY; c.style.transform = `translate(${x}px,${y}px)` }, true)
    window.addEventListener('mousedown', e => {
      ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px'
      ring.animate([{ opacity: 0.9, transform: 'translate(-50%,-50%) scale(0.5)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.6)' }], { duration: 450 })
    }, true)
  })
}

// ── capture context handed to scenarios ──
function makeCtx(page, outDir) {
  let recording = null

  const ctx = {
    page,
    sleep,
    VIEW,
    outDir,
    // Navigate the HashRouter and wait for the page to settle.
    async nav(path) {
      await page.evaluate(p => { location.hash = '#' + p }, path)
      await sleep(700)
      await installCursor(page)
    },
    // Screen-space rect of the first element whose trimmed text equals `text`
    // (optionally narrowed by a CSS selector). Ancestor-climbs to a positioned
    // box when `box` is set, so card titles resolve to the whole card.
    async rectOf(text, { selector = '*', box = false } = {}) {
      return page.evaluate(({ text, selector, box }) => {
        const els = [...document.querySelectorAll(selector)].filter(e => e.childElementCount === 0 ? e.textContent.trim() === text : [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === text))
        let el = els.find(e => e.getBoundingClientRect().width > 0)
        if (!el) return null
        if (box) {
          let p = el
          while (p && p !== document.body) {
            const cs = getComputedStyle(p)
            if (cs.position === 'absolute' && p.getBoundingClientRect().width >= 100) { el = p; break }
            p = p.parentElement
          }
        }
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
      }, { text, selector, box })
    },
    async rectOfTitle(title) {
      return page.evaluate(title => {
        const el = document.querySelector(`[title="${title.replace(/"/g, '\\"')}"]`)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
      }, title)
    },
    // Buttons/menu items: glide the cursor there (for the GIF) then dispatch the
    // click on the element itself, so layout shifts between measure and click
    // can never land the press on a neighbouring control.
    async clickText(text, opts = {}) {
      const r = await ctx.rectOf(text, opts)
      if (!r) throw new Error(`text not found: ${text}`)
      await ctx.moveTo(r.cx, r.cy)
      await page.evaluate(({ text, selector }) => {
        const els = [...document.querySelectorAll(selector)].filter(e => e.childElementCount === 0 ? e.textContent.trim() === text : [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === text))
        const el = els.find(e => e.getBoundingClientRect().width > 0)
        const target = el.closest('button, a, [role="button"], summary, li, div')
        ;(target ?? el).click()
      }, { text, selector: opts.selector ?? '*' })
      await sleep(opts.wait ?? 300)
      return r
    },
    async clickTitle(title, wait = 300) {
      const r = await ctx.rectOfTitle(title)
      if (!r) throw new Error(`title not found: ${title}`)
      await ctx.moveTo(r.cx, r.cy)
      await page.evaluate(title => document.querySelector(`[title="${title.replace(/"/g, '\\"')}"]`).click(), title)
      await sleep(wait)
      return r
    },
    // Smooth pointer travel (so GIFs show motion), ~steps frames.
    async moveTo(x, y, steps = 12) {
      await page.mouse.move(x, y, { steps })
    },
    async drag(x1, y1, x2, y2, { steps = 20, hold = 120 } = {}) {
      await ctx.moveTo(x1, y1)
      await page.mouse.down()
      await sleep(hold)
      await page.mouse.move(x2, y2, { steps })
      await sleep(hold)
      await page.mouse.up()
      await sleep(200)
    },
    async key(k, { ctrl = false, shift = false } = {}) {
      if (ctrl) await page.keyboard.down('Control')
      if (shift) await page.keyboard.down('Shift')
      await page.keyboard.press(k)
      if (shift) await page.keyboard.up('Shift')
      if (ctrl) await page.keyboard.up('Control')
      await sleep(200)
    },
    async type(text, delay = 40) {
      await page.keyboard.type(text, { delay })
    },
    // Hide the fake cursor for still shots.
    async cursor(visible) {
      await page.evaluate(v => { const c = document.getElementById('__docs-cursor'); if (c) c.style.display = v ? '' : 'none' }, visible)
    },
    // PNG at 2x. `clip` = {x,y,w,h} in CSS px (optionally padded) or an element text.
    async shot(name, { clip, pad = 12, scale = 2 } = {}) {
      await ctx.cursor(false)
      await page.setViewport({ ...VIEW, deviceScaleFactor: scale })
      await sleep(250)
      const file = join(outDir, `${name}.png`)
      let region
      if (clip) {
        const r = typeof clip === 'string' ? await ctx.rectOf(clip, { box: true }) : clip
        if (!r) throw new Error(`clip target not found: ${clip}`)
        region = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(VIEW.width, r.w + pad * 2), height: Math.min(VIEW.height, r.h + pad * 2) }
      }
      await page.screenshot({ path: file, clip: region })
      await page.setViewport({ ...VIEW, deviceScaleFactor: 1 })
      await sleep(250)
      await ctx.cursor(true)
      console.log('  📷', `${name}.png`)
    },
    // GIF: frames are grabbed at ~10 fps while `fn` runs, then encoded by ffmpeg.
    async gif(name, fn, { fps = 10, width = 960, tail = 600 } = {}) {
      if (recording) throw new Error('nested gif()')
      const frames = join(tmpdir(), `constella-docs-frames-${Date.now()}`)
      mkdirSync(frames, { recursive: true })
      let n = 0
      let stop = false
      const t0 = Date.now()
      recording = (async () => {
        while (!stop) {
          const t = Date.now()
          try { await page.screenshot({ path: join(frames, `f${String(n++).padStart(4, '0')}.png`) }) } catch { /* page busy */ }
          const wait = 1000 / fps - (Date.now() - t)
          if (wait > 0) await sleep(wait)
        }
      })()
      await ctx.cursor(true)
      await fn()
      await sleep(tail)
      stop = true
      await recording
      recording = null
      // Screenshots are slow (~150–250 ms each), so encode at the fps we actually
      // achieved — otherwise the clip plays back 2× too fast.
      const realFps = Math.max(1, n / ((Date.now() - t0) / 1000)).toFixed(2)
      const file = join(outDir, `${name}.gif`)
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-framerate', realFps, '-i', join(frames, 'f%04d.png'),
        '-vf', `scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
        '-loop', '0', file,
      ], { stdio: 'inherit' })
      rmSync(frames, { recursive: true, force: true })
      console.log('  🎞', `${name}.gif (${n} frames @ ${realFps} fps)`)
    },
  }
  return ctx
}

// ── main ──
async function main() {
  if (!noBuild) buildApp()

  const userData = join(tmpdir(), `constella-docs-${Date.now()}`)
  mkdirSync(userData, { recursive: true })
  const seedPath = join(userData, 'seed.json')
  writeFileSync(seedPath, JSON.stringify(buildSeed()))

  const scenarioDir = join(root, 'scripts/docs-media/scenarios')
  // Files starting with "_" are diagnostics (e.g. _survey) and only run when named.
  const files = readdirSync(scenarioDir).filter(f => f.endsWith('.mjs'))
    .filter(f => sections.length === 0 ? !f.startsWith('_') : sections.includes(f.replace(/\.mjs$/, '')))
  if (files.length === 0) throw new Error('no scenario files matched')

  console.log('▶ launching Electron (userData:', userData + ')')
  const child = launchApp(userData)
  let browser
  try {
    const c = await connect()
    browser = c.browser
    const page = c.page
    // Park the window off-screen: the 10 fps screenshot loop and scale switching
    // would otherwise flicker on the user's desktop. It must stay "visible" to
    // the compositor (not minimized) or Chromium stops painting frames.
    // Adopt the real inner size as the emulated viewport. If the emulation were
    // larger than the window, Chromium would scale the page to fit and mouse
    // coordinates would no longer match getBoundingClientRect().
    const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    VIEW.width = inner.w
    VIEW.height = inner.h
    console.log(`▶ viewport ${VIEW.width}x${VIEW.height}`)
    await page.setViewport({ ...VIEW, deviceScaleFactor: 1 })
    await page.waitForSelector('nav', { timeout: 30000 })
    console.log('▶ seeding demo data')
    await seed(page, seedPath)
    await installCursor(page)

    for (const f of files) {
      const section = f.replace(/\.mjs$/, '')
      const outDir = join(root, 'docs/public/media', section)
      mkdirSync(outDir, { recursive: true })
      const mod = await import(pathToFileURL(join(scenarioDir, f)).href)
      const ctx = makeCtx(page, outDir)
      console.log(`▶ section: ${section}`)
      for (const sc of mod.scenarios) {
        if (only && sc.name !== only) continue
        console.log(` • ${sc.name}`)
        try {
          await sc.run(ctx)
        } catch (e) {
          console.error(`   ✖ ${sc.name}:`, e.message)
          process.exitCode = 1
        }
        await page.keyboard.press('Escape')
      }
    }
  } finally {
    try { await browser?.disconnect() } catch { /* ignore */ }
    child.kill()
    await sleep(500)
    if (!existsSync(userData)) return
    rmSync(userData, { recursive: true, force: true })
  }
  console.log('done')
}

main().catch(e => { console.error(e); process.exit(1) })
