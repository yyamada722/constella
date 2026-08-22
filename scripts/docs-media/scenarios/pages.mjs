// The remaining pages: dashboard, research, sketch, 路線図 (mindtrain), search.
// Output: docs/public/media/pages/

export const scenarios = [
  {
    name: 'dashboard',
    async run(ctx) {
      await ctx.nav('/dashboard')
      await ctx.clickText('やること', { selector: 'button, span', wait: 800 })
      await ctx.shot('dashboard-agenda')
      await ctx.clickText('ガント', { selector: 'button, span', wait: 800 })
      await ctx.clickTitle('標準表示', 700)
      await ctx.shot('dashboard-gantt')
      await ctx.clickText('プロジェクト別', { selector: 'button, span', wait: 800 })
      await ctx.shot('dashboard-summary')
    },
  },
  {
    name: 'research',
    async run(ctx) {
      await ctx.nav('/research')
      await ctx.pause(2500) // let the embedded page load
      await ctx.shot('research')
    },
  },
  {
    name: 'sketch',
    async run(ctx) {
      await ctx.nav('/sketch')
      await ctx.clickText('絵コンテ 大通公園', { selector: 'button, div, span', wait: 800 })
      await ctx.clickTitle('全体表示', 700).catch(() => {})
      await ctx.shot('sketch')
      await ctx.gif('sketch-pen', async () => {
        const r = await ctx.page.evaluate(() => { const c = [...document.querySelectorAll('svg')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]; const b = (c ?? document.body).getBoundingClientRect(); return { x: b.x + b.width * 0.62, y: b.y + b.height * 0.42 } })
        await ctx.moveTo(r.x, r.y)
        await ctx.pause()
        await ctx.page.mouse.down()
        for (let i = 0; i <= 40; i++) {
          const t = (i / 40) * Math.PI * 2
          await ctx.page.mouse.move(r.x + 70 * Math.cos(t), r.y + 45 * Math.sin(t))
          await ctx.sleep(30)
        }
        await ctx.page.mouse.up()
      })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'mindtrain',
    async run(ctx) {
      await ctx.nav('/mindtrain')
      await ctx.pause(800)
      await ctx.clickTitle('全体表示（すべてが見えるように調整）', 800).catch(() => {})
      await ctx.shot('mindtrain')
      const st = await ctx.rectOf('許可申請')
      await ctx.moveTo(st.cx, st.cy + 22)
      await ctx.page.mouse.click(st.cx, st.cy + 22)
      await ctx.pause(800)
      await ctx.shot('mindtrain-station')
      await ctx.key('Escape')
    },
  },
  {
    name: 'search',
    async run(ctx) {
      await ctx.nav('/search')
      await ctx.gif('search', async () => {
        const r = await ctx.rectOfSel('input')
        await ctx.moveTo(r.cx, r.cy)
        await ctx.page.mouse.click(r.cx, r.cy)
        await ctx.type('大通')
        await ctx.key('Enter')
        await ctx.pause(900)
      })
      await ctx.shot('search')
    },
  },
]
