// Tasks page captures (kanban / gantt / calendar). Output: docs/public/media/tasks/
// Demo boards (seed.mjs): 撮影準備 (9 tasks, ロケハン has 3 children), 編集・納品 (3 tasks)

const PILL = '[title^="クリックで状態を切替"]'

// 標準表示 re-fits the range to the tasks (±14 days) — without it the view keeps
// whatever range was last scrolled to and the bars may sit off-screen.
async function openGantt(ctx) {
  await ctx.nav('/projects')
  await ctx.clickTitle('ガント', 900)
  await ctx.clickTitle('標準表示', 700)
}

async function openKanban(ctx) {
  await ctx.nav('/projects')
  await ctx.clickTitle('カンバン', 500)
}

export const scenarios = [
  {
    name: 'overview',
    async run(ctx) {
      await openKanban(ctx)
      await ctx.shot('kanban')
      await ctx.clickTitle('フラット表示', 500)
      await ctx.shot('kanban-flat')
      await ctx.clickTitle('階層表示', 400)
    },
  },
  {
    name: 'header',
    async run(ctx) {
      await openKanban(ctx)
      const a = await ctx.rectOfTitle('階層表示')
      const b = await ctx.rectOfTitle('カレンダー')
      await ctx.shot('header', { clip: { x: a.x - 8, y: a.y, w: b.x + b.w - a.x + 16, h: Math.max(a.h, b.h) }, pad: 8 })
    },
  },
  {
    name: 'status-pill',
    async run(ctx) {
      await openKanban(ctx)
      await ctx.gif('status-pill', async () => {
        await ctx.clickNear('機材手配', PILL, { wait: 900 })
        await ctx.clickNear('機材手配', PILL, { wait: 3200 }) // second click → 完了, then the 2.6 s commit moves it
      }, { tail: 1200 })
      await ctx.key('z', { ctrl: true })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'add-task',
    async run(ctx) {
      await openKanban(ctx)
      await ctx.gif('add-task', async () => {
        await ctx.clickText('＋ 追加', { selector: 'button', wait: 800 })
        await ctx.type('モデルリリースの準備')
        await ctx.key('Enter')
      })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'edit-popover',
    async run(ctx) {
      await openKanban(ctx)
      await ctx.clickNear('機材手配', '[title="編集"]', { wait: 700 })
      await ctx.shot('edit-popover')
      await ctx.key('Escape')
    },
  },
  {
    name: 'subtask-drag',
    async run(ctx) {
      await openKanban(ctx)
      await ctx.gif('nest-drag', async () => {
        const src = await ctx.rectOf('絵コンテ作成')
        const dst = await ctx.rectOf('本番撮影')
        // Kanban cards use native HTML5 drag & drop → needs puppeteer's drag interception.
        await ctx.moveTo(src.cx, src.cy)
        await ctx.pause()
        await ctx.page.setDragInterception(true)
        await ctx.page.mouse.dragAndDrop({ x: src.cx, y: src.cy }, { x: dst.cx, y: dst.cy + 26 }, { delay: 900 })
        await ctx.page.setDragInterception(false)
        await ctx.moveTo(dst.cx, dst.cy + 26)
      })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'bulk-add',
    async run(ctx) {
      await openKanban(ctx)
      await ctx.clickTitle('AI出力やリストから一括でタスクを追加', 700)
      await ctx.shot('bulk-add')
      await ctx.key('Escape')
    },
  },
  {
    name: 'note-panel',
    async run(ctx) {
      await openKanban(ctx)
      // ロケハン has a linked note → selecting it opens the note panel on the right
      const t = await ctx.rectOf('ロケハン')
      await ctx.moveTo(t.cx, t.cy)
      await ctx.page.mouse.click(t.cx, t.cy)
      await ctx.pause(900)
      await ctx.shot('note-panel')
      await ctx.key('Escape')
    },
  },
  {
    name: 'gantt',
    async run(ctx) {
      await openGantt(ctx)
      await ctx.shot('gantt')
      await ctx.clickTitle('3ヶ月表示', 700)
      await ctx.shot('gantt-quarter')
      await ctx.clickTitle('標準表示', 700)
    },
  },
  {
    name: 'gantt-drag',
    async run(ctx) {
      await openGantt(ctx)
      await ctx.gif('gantt-drag', async () => {
        const bar = await ctx.rectOfSel('[title^="機材手配 "]')
        await ctx.drag(bar.cx, bar.cy, bar.cx + 120, bar.cy, { ms: 1000 })
        await ctx.pause(600)
        const bar2 = await ctx.rectOfSel('[title^="機材手配 "]')
        await ctx.drag(bar2.x + bar2.w - 4, bar2.cy, bar2.x + bar2.w + 70, bar2.cy, { ms: 900 })
      })
      await ctx.key('z', { ctrl: true })
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'gantt-undated',
    async run(ctx) {
      await openGantt(ctx)
      await ctx.gif('gantt-undated', async () => {
        // The pill listens on mousedown (pen-drag start) — a real click is needed.
        const pill = await ctx.rectOfTitle('日付未設定 — ドラッグして期間を描く / クリックで割り当て')
        await ctx.moveTo(pill.cx, pill.cy)
        await ctx.page.mouse.click(pill.cx, pill.cy)
        await ctx.pause(900)
        await ctx.clickText('今日 〜 +6日', { selector: 'button', wait: 900 })
      })
      await ctx.key('Escape')
      await ctx.key('z', { ctrl: true })
    },
  },
  {
    name: 'gantt-editor',
    async run(ctx) {
      await openGantt(ctx)
      const bar = await ctx.rectOfSel('[title^="ロケハン "]')
      await ctx.moveTo(bar.cx, bar.cy)
      await ctx.page.mouse.click(bar.cx, bar.cy)
      await ctx.pause(800)
      await ctx.shot('gantt-editor')
      await ctx.key('Escape')
    },
  },
  {
    name: 'calendar',
    async run(ctx) {
      await ctx.nav('/projects')
      await ctx.clickTitle('カレンダー', 900)
      await ctx.shot('calendar')
      await ctx.clickTitle('カンバン', 400)
    },
  },
]
