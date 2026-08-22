// Notes page captures. Output: docs/public/media/notes/<name>.{png,gif}
// Demo notes (seed.mjs): 企画/撮影企画ブリーフ(pinned), 企画/機材リスト, ロケ地/大通公園, ロケ地/関係者連絡先(shared)

async function openBrief(ctx, mode = '分割') {
  await ctx.nav('/')
  // Folders start collapsed; expand 企画 if the note isn't visible yet.
  // Folder rows: the name itself is "click to rename" — expand via the chevron.
  await expandFolder(ctx, '企画')
  await ctx.clickText('撮影企画ブリーフ', { selector: 'button, div, span', wait: 700 })
  await ctx.clickText(mode, { selector: 'button', wait: 700 })
}

async function expandFolder(ctx, name) {
  const open = await ctx.page.evaluate(name => {
    const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name)
    return !!b?.parentElement?.querySelector('[title="畳む"]')
  }, name)
  if (!open) await ctx.clickNear(name, '[title="開く"]', { up: 1 })
}

// Scenarios share one live app, so edits made for a GIF must be rolled back.
// execCommand('insertText') goes through the textarea's input event, which keeps
// React state (and the autosave) in sync — unlike assigning .value directly.
async function snapshotEditor(ctx) {
  return ctx.page.evaluate(() => document.querySelector('textarea.typol-editor')?.value ?? null)
}
async function restoreEditor(ctx, snap) {
  if (snap == null) return
  await ctx.page.evaluate(v => {
    const ta = document.querySelector('textarea.typol-editor')
    if (!ta) return
    ta.focus(); ta.select()
    document.execCommand('insertText', false, v)
    ta.blur()
  }, snap)
  await ctx.pause(400)
}

async function focusEditorEnd(ctx) {
  const r = await ctx.page.evaluate(() => { const r = document.querySelector('textarea.typol-editor').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await ctx.moveTo(r.x, r.y)
  await ctx.page.mouse.click(r.x, r.y)
  await ctx.key('End', { ctrl: true })
}

export const scenarios = [
  {
    name: 'overview',
    async run(ctx) {
      await openBrief(ctx, '分割')
      await ctx.shot('overview')
    },
  },
  {
    name: 'sidebar',
    async run(ctx) {
      await openBrief(ctx, '分割')
      // expand the other folder too so the tree is visible
      await expandFolder(ctx, 'ロケ地')
      const a = await ctx.rectOf('ノート', { selector: 'h1, h2, div, span' })
      await ctx.shot('sidebar', { clip: { x: a.x - 16, y: 0, w: 300, h: 520 }, pad: 0 })
    },
  },
  {
    name: 'modes',
    async run(ctx) {
      await openBrief(ctx, 'プレビュー')
      await ctx.shot('preview-mode')
      const a = await ctx.rectOf('編集', { selector: 'button' })
      const b = await ctx.rectOfTitle('文字を大きく')
      await ctx.shot('mode-toggle', { clip: { x: a.x, y: a.y, w: b.x + b.w - a.x, h: Math.max(a.h, b.h) }, pad: 8 })
    },
  },
  {
    name: 'editor-toolbar',
    async run(ctx) {
      await openBrief(ctx, '編集')
      const a = await ctx.rectOfTitle('太字 (**) — Ctrl+B')
      const b = await ctx.rectOfTitle('水平線 (---)')
      await ctx.shot('editor-toolbar', { clip: { x: a.x, y: a.y, w: b.x + b.w - a.x, h: a.h }, pad: 8 })
    },
  },
  {
    name: 'typing',
    async run(ctx) {
      await openBrief(ctx, '分割')
      const snap = await snapshotEditor(ctx)
      await ctx.gif('typing', async () => {
        await focusEditorEnd(ctx)
        await ctx.type('\n## 当日の注意\n\n')
        await ctx.type('朝 7 時集合。')
        await ctx.key('b', { ctrl: true })      // inserts ** ** with the caret inside
        await ctx.type('三脚は各自持参')
        await ctx.key('End')
        await ctx.type('。\n\n- [ ] 天気予報を確認\n')
        await ctx.type('バッテリー充電')           // smart Enter already added "- [ ] "
      }, { tail: 1200 })
      await restoreEditor(ctx, snap)
    },
  },
  {
    name: 'context-menu',
    async run(ctx) {
      await openBrief(ctx, '編集')
      const snap = await snapshotEditor(ctx)
      await ctx.gif('insert-menu', async () => {
        await focusEditorEnd(ctx)
        // Right-click BELOW the last line so the caret stays at the end of the text.
        const r = await ctx.page.evaluate(() => { const r = document.querySelector('textarea.typol-editor').getBoundingClientRect(); return { x: r.x + 120, y: r.bottom - 30 } })
        await ctx.moveTo(r.x, r.y)
        await ctx.page.mouse.click(r.x, r.y, { button: 'right' })
        await ctx.pause(900)
        await ctx.clickText('コールアウト (NOTE)', { selector: 'button', wait: 900 })
      })
      await restoreEditor(ctx, snap)
    },
  },
  {
    name: 'search',
    async run(ctx) {
      await openBrief(ctx, '編集')
      await ctx.gif('find', async () => {
        await focusEditorEnd(ctx)
        await ctx.key('f', { ctrl: true })
        await ctx.pause(400)
        await ctx.type('紅葉')
        await ctx.key('Enter')
        await ctx.key('Enter')
      })
      await ctx.shot('find-bar', { clip: { x: 0, y: 0, w: ctx.VIEW.width, h: 140 }, pad: 0 })
      await ctx.key('Escape')
    },
  },
  {
    name: 'outline',
    async run(ctx) {
      await openBrief(ctx, 'プレビュー')
      await ctx.clickTitle('アウトライン（見出しの目次）', 600)
      await ctx.shot('outline')
      await ctx.clickTitle('アウトライン（見出しの目次）', 300)
    },
  },
  {
    name: 'slideshow',
    async run(ctx) {
      await openBrief(ctx, 'プレビュー')
      await ctx.clickTitle('スライドショー（--- の行でスライドに分割）', 900)
      await ctx.shot('slideshow')
      await ctx.gif('slideshow-nav', async () => {
        await ctx.key('ArrowRight')
        await ctx.pause(800)
        await ctx.key('ArrowRight')
        await ctx.pause(800)
        await ctx.key('ArrowLeft')
      })
      await ctx.key('Escape')
    },
  },
  {
    name: 'new-note',
    async run(ctx) {
      await ctx.nav('/')
      await ctx.gif('new-note', async () => {
        await ctx.clickTitle('ノートを追加', 900)
        await ctx.type('ロケハン当日の持ち物')
      })
      await ctx.key('Escape')
      await ctx.clickTitle('完全削除', 500)
      const confirmed = await ctx.page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(b => /削除/.test(b.textContent) && b.closest('[role="dialog"], .fixed'))
        if (b) b.click()
        return !!b
      })
      if (!confirmed) throw new Error('削除確認ボタンが見つからない — 作成したノートが残ると後続シナリオの画像に写り込む')
      await ctx.pause()
    },
  },
  {
    name: 'attachments',
    async run(ctx) {
      await openBrief(ctx, 'プレビュー')
      await ctx.shot('minimap')
      // 📎 badge in the header opens the attachments panel
      await ctx.page.evaluate(() => document.querySelector('[title="付随資料（PDF・画像・動画などをこのノートに添付）"]').click())
      await ctx.pause(1200)
      await ctx.shot('attachments')
      // the panel state is remembered globally — close it again
      await ctx.page.evaluate(() => document.querySelector('[title="付随資料（PDF・画像・動画などをこのノートに添付）"]').click())
      await ctx.pause(400)
    },
  },
  {
    name: 'shared',
    async run(ctx) {
      await ctx.nav('/')
      await expandFolder(ctx, 'ロケ地')
      await ctx.clickText('関係者連絡先', { selector: 'button, div, span', wait: 700 })
      await ctx.clickText('プレビュー', { selector: 'button', wait: 500 })
      await ctx.shot('shared-note')
    },
  },
]
