// Canvas page captures. Output: docs/public/media/canvas/<name>.{png,gif}
// Demo tabs (see seed.mjs): 全体構成 / ロケ地候補 / 工程の下書き / 撮影システム / 進行ロードマップ

async function openTab(ctx, name) {
  await ctx.clickText(name, { selector: 'button, div, span', wait: 500 })
  await ctx.clickTitle('全体表示', 500)
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
        await ctx.page.mouse.click(EMPTY.x, EMPTY.y, { button: 'right' })
        await ctx.sleep(500)
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
      const c = await ctx.rectOf('ドローンで紅葉を俯瞰', { box: true })
      await ctx.gif('move-card', async () => {
        await ctx.drag(c.x + c.w / 2, c.y + 14, c.x + c.w / 2 + 160, c.y + 14 + 90, { steps: 30 })
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
        await ctx.drag(a.cx, a.cy, b.cx, b.cy, { steps: 30 })
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
        await ctx.drag(a.x - 24, a.y - 40, b.x + b.w + 24, b.y + b.h + 24, { steps: 30 })
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
        await ctx.moveTo(a.x - 10, a.y + a.h / 2)
        await ctx.page.mouse.down()
        for (let i = 0; i <= 36; i++) {
          const t = (i / 36) * Math.PI * 2
          await ctx.page.mouse.move(a.cx + (a.w / 2 + 14) * Math.cos(t), a.cy + (a.h / 2 + 14) * Math.sin(t))
          await ctx.sleep(16)
        }
        await ctx.page.mouse.up()
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
        await ctx.page.mouse.wheel({ deltaY: -400 })
        await ctx.sleep(500)
        await ctx.page.mouse.wheel({ deltaY: -300 })
        await ctx.sleep(600)
        await ctx.page.keyboard.down('Space')
        await ctx.drag(EMPTY.x, EMPTY.y - 200, EMPTY.x - 260, EMPTY.y - 60, { steps: 30 })
        await ctx.page.keyboard.up('Space')
        await ctx.sleep(300)
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
      const c = await ctx.rectOf('素材バックアップ', { box: true })
      await ctx.gif('task-draft-chain', async () => {
        // Press the header icon (not the editable title) so the card is selected.
        await ctx.moveTo(c.x + 12, c.y + 12)
        await ctx.page.mouse.click(c.x + 12, c.y + 12)
        await ctx.sleep(300)
        await ctx.key('Enter')
        await ctx.sleep(200)
        await ctx.type('機材返却', 60)
        await ctx.sleep(300)
        await ctx.key('Tab')
        await ctx.sleep(200)
        await ctx.type('レンタル伝票の確認', 60)
        await ctx.sleep(500)
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
      const c = await ctx.rectOf('企画コンセプト', { box: true })
      await ctx.page.mouse.click(c.cx, c.y + 12)
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
