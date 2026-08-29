// In-app manual chapters. Each chapter is a bundled markdown file rendered with
// the Typol pipeline (renderMarkdown + renderMermaidIn) inside HelpModal.
import intro from './01-intro.md?raw'
import notes from './02-notes.md?raw'
import tasks from './03-tasks.md?raw'
import canvas from './04-canvas.md?raw'
import plan from './05-plan.md?raw'
import pages from './06-pages.md?raw'
import shortcuts from './07-shortcuts.md?raw'
import data from './08-data.md?raw'
import sync from './09-sync.md?raw'

export interface HelpChapter {
  id: string
  title: string
  body: string
}

export const HELP_CHAPTERS: HelpChapter[] = [
  { id: 'intro', title: 'はじめに', body: intro },
  { id: 'notes', title: 'ノート', body: notes },
  { id: 'tasks', title: 'タスク・ガント', body: tasks },
  { id: 'canvas', title: 'キャンバス', body: canvas },
  { id: 'plan', title: '計画', body: plan },
  { id: 'pages', title: 'その他のページ', body: pages },
  { id: 'shortcuts', title: 'ショートカット', body: shortcuts },
  { id: 'data', title: 'データとバックアップ', body: data },
  { id: 'sync', title: '同期と受け渡し', body: sync },
]
