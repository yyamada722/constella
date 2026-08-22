// Canvas page captures. Output: docs/public/media/canvas/<name>.{png,gif}
// Demo tabs (see seed.mjs): 全体構成 / ロケ地候補 / 工程の下書き / 撮影システム / 進行ロードマップ

async function openTab(ctx, name) {
  await ctx.clickText(name, { selector: 'button, div, span', wait: 600 })
  await ctx.clickTitle('全体表示', 900)
}

async function selectTool(ctx) { await ctx.clickTitle('選択 / 移動', 150) }

// Empty spot on the canvas background (below the hero cards, right side).
const EMPTY = { x: 700, y: 700 }

export const scenarios = [
  {
    name: 'overview',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.shot('overview')
    },
  },
  {
    name: 'boards-panel',
    async run(ctx) {
      await ctx.nav('/canvas')
      const r = await ctx.rectOf('進行ロードマップ', { selector: 'button, div, span' })
      await ctx.shot('boards-panel', { clip: { x: r.x - 40, y: 0, w: 260, h: 420 }, pad: 0 })
    },
  },
  {
    name: 'toolbar',
    async run(ctx) {
      await ctx.nav('/canvas')
      const a = await ctx.rectOfTitle('選択 / 移動')
      const b = await ctx.rectOfTitle('このキャンバス内を検索')
      await ctx.shot('toolbar', { clip: { x: a.x, y: a.y, w: b.x + b.w - a.x, h: Math.max(a.h, b.h) }, pad: 8 })
    },
  },
  {
    name: 'context-menu',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.page.mouse.click(EMPTY.x, EMPTY.y, { button: 'right' })
      await ctx.sleep(400)
      const r = await ctx.rectOf('カードを追加', { selector: 'div' })
      await ctx.shot('context-menu', { clip: { x: r.x - 12, y: r.y - 60, w: 250, h: 520 }, pad: 0 })
      await ctx.key('Escape')
    },
  },
  {
    name: 'add-card',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.gif('add-card', async () => {
        await ctx.moveTo(EMPTY.x, EMPTY.y)
        await ctx.pause()
        await ctx.page.mouse.click(EMPTY.x, EMPTY.y, { button: 'right' })
        await ctx.pause(800)
        await ctx.clickText('アイデア', { selector: '.fixed.z-50 button span', wait: 900 })
      })
      await ctx.key('Escape')
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'move-card',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await selectTool(ctx)
      await ctx.gif('move-card', async () => {
        // Press on the title text itself (the card box includes an outer hit area).
        const t = await ctx.rectOf('ドローンで紅葉を俯瞰')
        await ctx.drag(t.cx + 40, t.cy, t.cx + 200, t.cy + 90)
      })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'arrow',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.gif('arrow', async () => {
        await ctx.clickTitle('矢印を引く', 400)
        // Measure AFTER the tool is active: its option strip can re-flow the toolbar.
        const a = await ctx.rectOf('札幌市 撮影許可', { box: true })
        const b = await ctx.rectOf('ロケハン', { box: true })
        await ctx.drag(a.cx, a.cy, b.cx, b.cy)
      })
      await selectTool(ctx)
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'group',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, 'ロケ地候補')
      await ctx.gif('group', async () => {
        await ctx.clickTitle('グループエリアを描く', 400)
        const a = await ctx.rectOf('大通公園', { box: true })
        const b = await ctx.rectOf('テレビ塔', { box: true })
        await ctx.drag(a.x - 24, a.y - 40, b.x + b.w + 24, b.y + b.h + 24)
      })
      await selectTool(ctx)
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'pen',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, 'ロケ地候補')
      await ctx.gif('pen', async () => {
        await ctx.clickTitle('ペン（手書き）', 400)
        const a = await ctx.rectOf('藻岩山', { box: true })
        await ctx.moveTo(a.x - 14, a.cy)
        await ctx.pause()
        await ctx.page.mouse.down()
        for (let i = 0; i <= 48; i++) {
          const t = Math.PI + (i / 48) * Math.PI * 2
          await ctx.page.mouse.move(a.cx + (a.w / 2 + 14) * Math.cos(t), a.cy + (a.h / 2 + 14) * Math.sin(t))
          await ctx.sleep(30)
        }
        await ctx.page.mouse.up()
        await ctx.pause()
      })
      await selectTool(ctx)
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'pan-zoom',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.gif('pan-zoom', async () => {
        await ctx.moveTo(EMPTY.x, EMPTY.y - 200)
        await ctx.pause()
        for (let i = 0; i < 4; i++) { await ctx.page.mouse.wheel({ deltaY: -120 }); await ctx.sleep(160) }
        await ctx.pause(900)
        await ctx.page.keyboard.down('Space')
        await ctx.drag(EMPTY.x, EMPTY.y - 200, EMPTY.x - 260, EMPTY.y - 60, { ms: 1000 })
        await ctx.page.keyboard.up('Space')
      })
      await ctx.clickTitle('全体表示', 300)
    },
  },
  {
    name: 'shapes',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '撮影システム')
      await ctx.shot('shapes')
      await ctx.page.mouse.click(EMPTY.x, EMPTY.y, { button: 'right' })
      await ctx.sleep(400)
      const r = await ctx.rectOf('シェイプを追加', { selector: 'div' })
      await ctx.shot('shape-menu', { clip: { x: r.x - 12, y: r.y - 8, w: 250, h: 250 }, pad: 0 })
      await ctx.key('Escape')
    },
  },
  {
    name: 'rails',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '進行ロードマップ')
      await ctx.shot('rails')
    },
  },
  {
    name: 'task-draft',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '工程の下書き')
      await ctx.shot('task-draft')
      await selectTool(ctx)
      await ctx.gif('task-draft-chain', async () => {
        // Press the header icon left of the title (the title itself is an input).
        const t = await ctx.rectOf('素材バックアップ')
        await ctx.moveTo(t.x - 14, t.cy)
        await ctx.page.mouse.click(t.x - 14, t.cy)
        await ctx.pause()
        await ctx.key('Enter')
        await ctx.type('機材返却')
        await ctx.key('Tab')
        await ctx.type('レンタル伝票の確認')
      })
      await ctx.key('Escape')
      await ctx.key('z', { ctrl: true })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'props-panel',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await selectTool(ctx)
      const t = await ctx.rectOf('企画コンセプト')
      await ctx.page.mouse.click(t.x - 14, t.cy)
      await ctx.sleep(400)
      await ctx.shot('props-panel', { clip: { x: ctx.VIEW.width - 300, y: 0, w: 300, h: 800 }, pad: 0 })
      await ctx.key('Escape')
    },
  },
  {
    name: 'minimap-list',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.clickTitle('ミニマップ', 400)
      await ctx.shot('minimap')
      await ctx.clickTitle('ミニマップ', 200)
      await ctx.clickTitle('リスト', 500)
      await ctx.shot('list-view')
      await ctx.clickTitle('キャンバス', 300)
    },
  },
  {
    name: 'export-menu',
    async run(ctx) {
      await ctx.nav('/canvas')
      await openTab(ctx, '全体構成')
      await ctx.clickTitle('共有用HTMLを書き出し（Constellaがない人もブラウザでそのまま閲覧・動画再生できます）', 600)
      await ctx.shot('export-share')
      await ctx.key('Escape')
    },
  },
]
