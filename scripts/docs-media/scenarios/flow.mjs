// Flow page captures. Output: docs/public/media/flow/
// Demo flow (seed.mjs): 本番撮影の段取り — 5 task nodes + memo, group 現場, edges from 本番撮影.

const HANDLE = '[title="下にドラッグして接続（親→子）/ 空きで子ノード作成"]'

async function openFlow(ctx) {
  await ctx.nav('/flow')
  await ctx.clickText('本番撮影の段取り', { selector: 'button, div, span', wait: 700 })
  await ctx.clickTitle('全体表示', 800)
}

export const scenarios = [
  {
    name: 'overview',
    async run(ctx) {
      await openFlow(ctx)
      await ctx.shot('overview')
    },
  },
  {
    name: 'add-node',
    async run(ctx) {
      await openFlow(ctx)
      await ctx.gif('add-node', async () => {
        const x = ctx.VIEW.width - 360, y = ctx.VIEW.height - 260
        await ctx.moveTo(x, y)
        await ctx.pause()
        await ctx.page.mouse.click(x, y, { clickCount: 2 })
        await ctx.pause(700)
        await ctx.type('納品データの整理')
        await ctx.key('Escape')
      })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'chain',
    async run(ctx) {
      await openFlow(ctx)
      await ctx.gif('tab-enter', async () => {
        const t = await ctx.rectOfValue('機材返却')
        await ctx.moveTo(t.cx, t.cy)
        await ctx.page.mouse.click(t.cx, t.cy)
        await ctx.pause()
        await ctx.key('Tab')
        await ctx.type('レンタル伝票の確認')
        await ctx.key('Enter')
        await ctx.type('返却日の連絡')
        await ctx.key('Escape')
      })
      for (let i = 0; i < 4; i++) await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'connect',
    async run(ctx) {
      await openFlow(ctx)
      await ctx.gif('connect-drag', async () => {
        // the ● handle under 素材バックアップ → drag into empty space = new child node
        const t = await ctx.rectOfValue('素材バックアップ')
        const h = await ctx.page.evaluate(({ sel, x, y }) => {
          const hs = [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width } }).filter(h => h.w > 0)
          // the node's own handle sits just below its title
          hs.sort((a, b) => Math.hypot(a.cx - x, a.cy - (y + 60)) - Math.hypot(b.cx - x, b.cy - (y + 60)))
          return hs[0]
        }, { sel: HANDLE, x: t.cx, y: t.cy })
        // drop into empty space (down-left, clear of 機材返却) → a new child node
        await ctx.drag(h.cx, h.cy, h.cx - 220, h.cy + 200, { ms: 1100 })
        await ctx.type('チェックサム確認')
        await ctx.key('Escape')
      })
      for (let i = 0; i < 3; i++) await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'when-chips',
    async run(ctx) {
      await openFlow(ctx)
      const t = await ctx.rectOfValue('2 日目 藻岩山')
      await ctx.shot('when-chips', { clip: { x: t.x - 40, y: t.y - 30, w: 300, h: 150 }, pad: 0 })
    },
  },
  {
    name: 'convert',
    async run(ctx) {
      await openFlow(ctx)
      await ctx.clickTitle('未変換ノードをまとめて実タスクに変換（エッジ = 親→子）', 800)
      await ctx.shot('convert-dialog')
      await ctx.key('Escape')
    },
  },
]
