// Ad-hoc DOM probe: npm run docs:capture -- _debug --no-build
export const scenarios = [{
  name: 'probe',
  async run(ctx) {
    await ctx.nav('/projects')
    await ctx.clickTitle('ガント', 900)
    await ctx.clickTitle('標準表示', 700)
    const bar = await ctx.rectOfSel('[title^="機材手配 "]')
    await ctx.moveTo(bar.cx, bar.cy)
    await ctx.pause(300)
    const info = await ctx.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      const c = document.getElementById('__docs-cursor')
      return { under: el?.getAttribute('title')?.slice(0, 20) || el?.tagName + '.' + el?.className?.toString().slice(0, 40), cursor: c?.style.transform, dpr: window.devicePixelRatio, inner: [window.innerWidth, window.innerHeight], scrollY: window.scrollY }
    }, { x: bar.cx, y: bar.cy })
    console.log('bar', JSON.stringify(bar), JSON.stringify(info))
    await ctx.page.screenshot({ path: ctx.outDir + '/probe.png' })
  },
}]
