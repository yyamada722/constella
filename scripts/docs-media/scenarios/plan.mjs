// Plan (itinerary) page captures. Output: docs/public/media/plan/
// Demo plan (seed.mjs): ロケハン行程 — 2 days, flights/train/hotel, price lines, NOTE alert.

async function openPlan(ctx, mode) {
  await ctx.nav('/plan')
  await ctx.clickText('ロケハン行程', { selector: 'button, div, span', wait: 700 })
  if (mode) await ctx.clickText(mode, { selector: 'button', wait: 700 })
}

async function snapshotEditor(ctx) {
  return ctx.page.evaluate(() => document.querySelector('main textarea')?.value ?? null)
}
async function restoreEditor(ctx, snap) {
  if (snap == null) return
  await ctx.page.evaluate(v => { const ta = document.querySelector('main textarea'); if (!ta) return; ta.focus(); ta.select(); document.execCommand('insertText', false, v); ta.blur() }, snap)
  await ctx.pause(400)
}

export const scenarios = [
  {
    name: 'overview',
    async run(ctx) {
      await openPlan(ctx, '分割')
      await ctx.shot('overview')
      await ctx.clickText('プレビュー', { selector: 'button', wait: 700 })
      await ctx.shot('timeline')
    },
  },
  {
    name: 'syntax-help',
    async run(ctx) {
      await openPlan(ctx, '分割')
      await ctx.clickTitle('記法ヘルプ', 700)
      const r = await ctx.rectOfTitle('記法ヘルプ')
      await ctx.shot('syntax-help', { clip: { x: r.x - 420, y: r.y, w: 520, h: 560 }, pad: 0 })
      await ctx.key('Escape')
    },
  },
  {
    name: 'toolbar',
    async run(ctx) {
      await openPlan(ctx, '分割')
      const a = await ctx.rectOfTitle('ファイルを添付（アプリ内に取り込み、[名前](idb:…) を挿入）')
      const b = await ctx.rectOfTitle('この計画をPDFに書き出し（添付のPDF・画像は別紙ページ化し、目次から飛べます）')
      await ctx.shot('toolbar', { clip: { x: a.x, y: a.y, w: b.x + b.w - a.x, h: Math.max(a.h, b.h) }, pad: 8 })
    },
  },
  {
    name: 'typing',
    async run(ctx) {
      await openPlan(ctx, '分割')
      const snap = await snapshotEditor(ctx)
      await ctx.gif('typing', async () => {
        const r = await ctx.page.evaluate(() => { const r = document.querySelector('main textarea').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
        await ctx.moveTo(r.x, r.y)
        await ctx.page.mouse.click(r.x, r.y)
        await ctx.key('End', { ctrl: true })
        await ctx.type('> [18:30] meal 打ち上げ :: すすきの\n')
        await ctx.type('> - price: JPY {5000*3}\n')
      }, { tail: 1500 })
      await restoreEditor(ctx, snap)
    },
  },
  {
    name: 'sidebar',
    async run(ctx) {
      await openPlan(ctx, '分割')
      const a = await ctx.rectOfTitle('新しい計画')
      await ctx.shot('sidebar', { clip: { x: a.x - 200, y: 0, w: 260, h: 240 }, pad: 0 })
    },
  },
]
