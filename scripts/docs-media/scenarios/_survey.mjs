// Diagnostic: screenshot every page at a narrow viewport to spot layout breakage.
//   npm run docs:capture -- _survey --no-build
// Output goes to docs/public/media/_survey/ (gitignored).
const ROUTES = ['/dashboard', '/', '/projects', '/flow', '/plan', '/research', '/canvas', '/sketch', '/mindtrain', '/search']
const NARROW = { width: 1100, height: 750 }

export const scenarios = ROUTES.map(route => ({
  name: route === '/' ? 'narrow-notes' : `narrow${route.replace(/\//g, '-')}`,
  async run(ctx) {
    await ctx.page.setViewport({ ...NARROW, deviceScaleFactor: 1 })
    await ctx.nav(route)
    await ctx.sleep(600)
    await ctx.cursor(false)
    await ctx.page.screenshot({ path: `${ctx.outDir}/${this.name}.png` })
    await ctx.cursor(true)
    await ctx.page.setViewport({ ...ctx.VIEW, deviceScaleFactor: 1 })
  },
}))
