import { createContext, useContext, useReducer, useEffect, useMemo, useState, useRef, useCallback, ReactNode } from 'react'
import { Note, NoteFolder, Project, Task, ResearchItem, ResearchFolder, MasterProject, Sketch, AIConversation, CanvasCard, CanvasTab, CanvasBoard, CanvasArrow, CanvasGroup, CanvasStroke, CanvasLabel, CanvasRail, CanvasStation, Flow, Plan, PlanFolder, TimelineBand } from './types'
import { loadState, saveState, loadKv, dbEtag, reloadState, consumeDbRecoveryNotice } from './persistence/db'
import { sweepMedia } from './persistence/media'
import { isRemote } from './persistence/runtime'
import { exportBackup } from './persistence/backup'

// The single default master project that all pre-existing data is migrated under.
// Keep this id in sync with db.ts (SQL migration) and mindtrain (workspace id).
export const DEFAULT_MASTER_ID = 'master-default'

export interface AppState {
  // Global master projects + the single active one shared by every tool.
  masterProjects: MasterProject[]
  activeMasterProjectId: string
  notes: Note[]
  noteFolders: NoteFolder[]
  projects: Project[]
  research: ResearchItem[]
  researchFolders: ResearchFolder[]
  sketches: Sketch[]
  flows: Flow[]
  plans: Plan[]
  planFolders: PlanFolder[]
  timelineBands: TimelineBand[]
  aiConversations: AIConversation[]
  canvasBoards: CanvasBoard[]
  canvasTabs: CanvasTab[]
  canvasCards: CanvasCard[]
  canvasArrows: CanvasArrow[]
  canvasGroups: CanvasGroup[]
  canvasStrokes: CanvasStroke[]
  canvasLabels: CanvasLabel[]
  canvasRails: CanvasRail[]
  canvasStations: CanvasStation[]
}

export type Action =
  | { type: 'ADD_MASTER_PROJECT'; payload: MasterProject }
  | { type: 'UPDATE_MASTER_PROJECT'; payload: MasterProject }
  | { type: 'DELETE_MASTER_PROJECT'; payload: string }
  | { type: 'SET_ACTIVE_MASTER_PROJECT'; payload: string }
  | { type: 'ADD_NOTE'; payload: Note }
  | { type: 'UPDATE_NOTE'; payload: Note }
  | { type: 'DELETE_NOTE'; payload: string }
  | { type: 'ADD_NOTE_FOLDER'; payload: NoteFolder }
  | { type: 'UPDATE_NOTE_FOLDER'; payload: NoteFolder }
  | { type: 'DELETE_NOTE_FOLDER'; payload: string }
  | { type: 'ADD_PROJECT'; payload: Project }
  | { type: 'UPDATE_PROJECT'; payload: Project }
  | { type: 'DELETE_PROJECT'; payload: string }
  | { type: 'ADD_TASK'; payload: { projectId: string; task: Task } }
  | { type: 'UPDATE_TASK'; payload: { projectId: string; task: Task } }
  | { type: 'DELETE_TASK'; payload: { projectId: string; taskId: string } }
  | { type: 'SET_PROJECT_TASKS'; payload: { projectId: string; tasks: Task[] } }
  | { type: 'ADD_RESEARCH'; payload: ResearchItem }
  | { type: 'UPDATE_RESEARCH'; payload: ResearchItem }
  | { type: 'DELETE_RESEARCH'; payload: string }
  | { type: 'ADD_RESEARCH_FOLDER'; payload: ResearchFolder }
  | { type: 'UPDATE_RESEARCH_FOLDER'; payload: ResearchFolder }
  | { type: 'DELETE_RESEARCH_FOLDER'; payload: string }
  | { type: 'ADD_SKETCH'; payload: Sketch }
  | { type: 'UPDATE_SKETCH'; payload: Sketch }
  | { type: 'DELETE_SKETCH'; payload: string }
  | { type: 'ADD_TIMELINE_BAND'; payload: TimelineBand }
  | { type: 'UPDATE_TIMELINE_BAND'; payload: TimelineBand }
  | { type: 'DELETE_TIMELINE_BAND'; payload: string }
  | { type: 'ADD_FLOW'; payload: Flow }
  | { type: 'UPDATE_FLOW'; payload: Flow }
  // Same whole-object replace as UPDATE_FLOW, but NOT coalescable — used for
  // discrete structural edits (add/remove node/edge/group, paste) so each is its
  // own undo step. UPDATE_FLOW stays for continuous gestures (drag/resize/typing).
  | { type: 'SET_FLOW'; payload: Flow }
  | { type: 'DELETE_FLOW'; payload: string }
  | { type: 'ADD_PLAN'; payload: Plan }
  | { type: 'UPDATE_PLAN'; payload: Plan }
  | { type: 'DELETE_PLAN'; payload: string }
  | { type: 'ADD_PLAN_FOLDER'; payload: PlanFolder }
  | { type: 'UPDATE_PLAN_FOLDER'; payload: PlanFolder }
  | { type: 'DELETE_PLAN_FOLDER'; payload: string }
  | { type: 'ADD_AI_CONVERSATION'; payload: AIConversation }
  | { type: 'UPDATE_AI_CONVERSATION'; payload: AIConversation }
  | { type: 'DELETE_AI_CONVERSATION'; payload: string }
  | { type: 'ADD_CANVAS_CARD'; payload: CanvasCard }
  | { type: 'UPDATE_CANVAS_CARD'; payload: CanvasCard }
  // View-only card state (undo履歴に乗せない): PDFのページ/表示モード、Webカードの現在URL/タイトル
  | { type: 'SET_CANVAS_CARD_VIEW'; payload: { id: string; pdf?: CanvasCard['pdf']; url?: string; title?: string } }
  | { type: 'DELETE_CANVAS_CARD'; payload: string }
  | { type: 'MOVE_CANVAS_CARD'; payload: { id: string; x: number; y: number } }
  | { type: 'RESIZE_CANVAS_CARD'; payload: { id: string; width: number; height: number } }
  | { type: 'BRING_CARD_FRONT'; payload: string[] }
  | { type: 'SEND_CARD_BACK'; payload: string[] }
  | { type: 'ADD_CANVAS_TAB'; payload: CanvasTab }
  | { type: 'UPDATE_CANVAS_TAB'; payload: CanvasTab }
  | { type: 'DELETE_CANVAS_TAB'; payload: string }
  | { type: 'ADD_CANVAS_BOARD'; payload: CanvasBoard }
  | { type: 'UPDATE_CANVAS_BOARD'; payload: CanvasBoard }
  | { type: 'DELETE_CANVAS_BOARD'; payload: string }
  | { type: 'ADD_CANVAS_ARROW'; payload: CanvasArrow }
  | { type: 'UPDATE_CANVAS_ARROW'; payload: CanvasArrow }
  | { type: 'DELETE_CANVAS_ARROW'; payload: string }
  | { type: 'ADD_CANVAS_GROUP'; payload: CanvasGroup }
  | { type: 'UPDATE_CANVAS_GROUP'; payload: CanvasGroup }
  | { type: 'DELETE_CANVAS_GROUP'; payload: string }
  | { type: 'ADD_CANVAS_STROKE'; payload: CanvasStroke }
  | { type: 'DELETE_CANVAS_STROKE'; payload: string }
  | { type: 'REPLACE_CANVAS_STROKES'; payload: { tabId: string; strokes: CanvasStroke[] } }
  | { type: 'ADD_CANVAS_LABEL'; payload: CanvasLabel }
  | { type: 'UPDATE_CANVAS_LABEL'; payload: CanvasLabel }
  | { type: 'DELETE_CANVAS_LABEL'; payload: string }
  | { type: 'ADD_CANVAS_RAIL'; payload: CanvasRail }
  | { type: 'UPDATE_CANVAS_RAIL'; payload: CanvasRail }
  | { type: 'DELETE_CANVAS_RAIL'; payload: string }
  | { type: 'ADD_CANVAS_STATION'; payload: { station: CanvasStation; railId?: string; index?: number } }
  | { type: 'UPDATE_CANVAS_STATION'; payload: CanvasStation }
  | { type: 'DELETE_CANVAS_STATION'; payload: string }
  | { type: 'APPEND_STATION_TO_RAIL'; payload: { railId: string; stationId: string } }
  | { type: 'DETACH_STATION_FROM_RAIL'; payload: { railId: string; stationId: string } }
  // 複数アクションを1回の dispatch = 1 undo ステップとして適用する（複数カードの
  // 複製・貼り付け・一括削除など）。historyReducer は BATCH を1アクションとして
  // 見るので、past には適用前のスナップショットが1つだけ積まれる。
  | { type: 'BATCH'; payload: Action[] }

const now = new Date().toISOString()

const initialState: AppState = {
  masterProjects: [
    { id: 'master-default', name: 'メイン', createdAt: now },
  ],
  activeMasterProjectId: 'master-default',
  notes: [
    {
      id: '1',
      masterProjectId: 'master-default',
      title: 'Constellaへようこそ',
      content: 'これはサンプルノートです。\n\n自由にメモやアイデアを記録してください。\n\nマークダウン記法にも対応予定です。',
      tags: ['サンプル', 'はじめに'],
      createdAt: now,
      updatedAt: now
    }
  ],
  noteFolders: [],
  projects: [
    {
      id: '1',
      masterProjectId: 'master-default',
      name: 'Constella 開発',
      description: '情報整理ツールの開発プロジェクト',
      tasks: [
        { id: '1', title: 'UIシェルの構築', description: 'サイドバーとメインレイアウト', status: 'done', tags: ['UI'], createdAt: now },
        { id: '2', title: 'ノート機能', description: 'メモの作成・編集・削除', status: 'in-progress', tags: ['機能'], createdAt: now },
        { id: '3', title: 'データ永続化', description: 'SQLiteでローカル保存', status: 'todo', tags: ['データ'], createdAt: now }
      ],
      createdAt: now
    }
  ],
  research: [
    {
      id: '1',
      masterProjectId: 'master-default',
      title: 'Electron公式ドキュメント',
      url: 'https://www.electronjs.org/docs',
      description: 'Electronの公式リファレンス',
      tags: ['Electron', '公式'],
      category: '技術',
      createdAt: now
    }
  ],
  researchFolders: [],
  sketches: [],
  flows: [],
  plans: [],
  planFolders: [],
  timelineBands: [],
  aiConversations: [],
  canvasBoards: [],
  canvasTabs: [
    { id: 'tab1', projectId: 'master-default', name: '設計', createdAt: now },
    { id: 'tab2', projectId: 'master-default', name: 'タスク', createdAt: now },
  ],
  canvasCards: [
    { id: 'c0', tabId: 'tab1', type: 'text', title: 'プロジェクトノート', content: '', pages: [
      { id: 'p1', name: '概要', content: 'Constella は情報整理のためのデスクトップアプリ。\n\nメモ、TODO、リサーチ、アイデアをキャンバス上に自由に配置して、\n思考の流れを視覚的に整理できる。' },
      { id: 'p2', name: '次のステップ', content: '- データ永続化（SQLite）\n- カード間の接続線\n- マークダウン対応' },
      { id: 'p3', name: '技術メモ', content: 'Electron + Vite + React + TypeScript\nTailwindCSS でスタイリング' },
    ], x: 50, y: 50, width: 360, height: 280, createdAt: now },
    { id: 'c1', tabId: 'tab1', type: 'idea', title: 'Constella のビジョン', content: '情報を自由に配置して\n思考を整理するツール', x: 480, y: 60, width: 240, height: 140, createdAt: now },
    { id: 'c2', tabId: 'tab2', type: 'todo', title: 'MVP機能を完成させる', content: 'ノート・プロジェクト・リサーチ\nキャンバス機能', x: 100, y: 80, width: 220, height: 140, createdAt: now },
    { id: 'c3', tabId: 'tab1', type: 'research', title: '参考ツール調査', content: 'Miro, Figma, Notion\nの良い点を分析', x: 250, y: 320, width: 220, height: 140, createdAt: now },
    { id: 'c4', tabId: 'tab1', type: 'web', title: 'Google', url: 'https://www.google.com', content: '', x: 50, y: 380, width: 480, height: 400, createdAt: now },
    { id: 'c5', tabId: 'tab2', type: 'pdf', title: 'Portacapture X8 マニュアル', url: `${import.meta.env.BASE_URL}portacapture_x8_rm_j_vg.pdf`, content: 'portacapture_x8_rm_j_vg.pdf', x: 380, y: 60, width: 480, height: 560, createdAt: now },
    { id: 'c6', tabId: 'tab1', type: 'image', title: '画像', url: '', content: '', x: 480, y: 240, width: 320, height: 260, createdAt: now },
    { id: 'c7', tabId: 'tab2', type: 'video', title: '動画', url: '', content: '', x: 100, y: 260, width: 480, height: 300, createdAt: now },
  ],
  canvasArrows: [
    { id: 'a1', tabId: 'tab1', x1: 320, y1: 130, x2: 470, y2: 120, fromCardId: 'c0', toCardId: 'c1', createdAt: now },
  ],
  canvasGroups: [
    { id: 'g1', tabId: 'tab1', title: 'コンセプト', x: 30, y: 24, width: 710, height: 326, createdAt: now },
  ],
  canvasStrokes: [],
  canvasLabels: [
    { id: 'l1', tabId: 'tab1', text: 'ラベルの例', x: 560, y: 540, fontSize: 22, color: '#1e293b', createdAt: now },
  ],
  canvasRails: [],
  canvasStations: [],
}

function reducer(state: AppState, action: Action): AppState {
  if (action.type === 'BATCH') return action.payload.reduce(reducer, state)
  switch (action.type) {
    case 'ADD_MASTER_PROJECT':
      // Ignore a re-add of an existing id: the mindtrain reconciliation can fire
      // with an id that already exists, and appending it would create a duplicate
      // master (often with a placeholder name like "プラン 1") that shadows the real
      // one. Idempotent by id keeps that reconciliation safe.
      if (state.masterProjects.some(p => p.id === action.payload.id)) return state
      return { ...state, masterProjects: [...state.masterProjects, action.payload] }
    case 'UPDATE_MASTER_PROJECT':
      return { ...state, masterProjects: state.masterProjects.map(p => p.id === action.payload.id ? action.payload : p) }
    case 'DELETE_MASTER_PROJECT': {
      // Cascade: drop the master project and everything scoped to it across every tool.
      const mid = action.payload
      const removedTabs = new Set(state.canvasTabs.filter(t => t.projectId === mid).map(t => t.id))
      return {
        ...state,
        masterProjects: state.masterProjects.filter(p => p.id !== mid),
        notes: state.notes.filter(n => n.masterProjectId !== mid),
        noteFolders: state.noteFolders.filter(f => f.masterProjectId !== mid),
        projects: state.projects.filter(p => p.masterProjectId !== mid),
        research: state.research.filter(r => r.masterProjectId !== mid),
        researchFolders: state.researchFolders.filter(f => f.masterProjectId !== mid),
        sketches: state.sketches.filter(s => s.masterProjectId !== mid),
        flows: state.flows.filter(f => f.masterProjectId !== mid),
        plans: state.plans.filter(p => p.masterProjectId !== mid),
        planFolders: state.planFolders.filter(f => f.masterProjectId !== mid),
        // timelineBands are GLOBAL personal-schedule spans shown in every project's
        // Gantt, so they intentionally survive a master-project deletion.
        aiConversations: state.aiConversations.filter(c => c.masterProjectId !== mid),
        canvasBoards: state.canvasBoards.filter(b => b.projectId !== mid),
        canvasTabs: state.canvasTabs.filter(t => t.projectId !== mid),
        canvasCards: state.canvasCards.filter(c => !removedTabs.has(c.tabId)).map(c => c.refTabId && removedTabs.has(c.refTabId) ? { ...c, refTabId: undefined } : c),
        canvasArrows: state.canvasArrows.filter(a => !removedTabs.has(a.tabId)),
        canvasGroups: state.canvasGroups.filter(g => !removedTabs.has(g.tabId)),
        canvasStrokes: state.canvasStrokes.filter(s => !removedTabs.has(s.tabId)),
        canvasLabels: state.canvasLabels.filter(l => !removedTabs.has(l.tabId)),
        canvasRails: state.canvasRails.filter(r => !removedTabs.has(r.tabId)),
        canvasStations: state.canvasStations.filter(s => !removedTabs.has(s.tabId)),
      }
    }
    case 'SET_ACTIVE_MASTER_PROJECT':
      return { ...state, activeMasterProjectId: action.payload }
    case 'ADD_NOTE':
      return { ...state, notes: [action.payload, ...state.notes] }
    case 'UPDATE_NOTE':
      return { ...state, notes: state.notes.map(n => n.id === action.payload.id ? action.payload : n) }
    case 'DELETE_NOTE': {
      // Also strip this note's id from every task's linkedNoteIds array AND remove
      // any canvas cards that referenced the note — otherwise we leave orphan
      // "broken" cards and stale cross-references pointing at a note that no
      // longer exists.
      const noteId = action.payload
      return {
        ...state,
        notes: state.notes.filter(n => n.id !== noteId),
        projects: state.projects.map(p => ({
          ...p,
          tasks: p.tasks.map(t => {
            if (!t.linkedNoteIds || !t.linkedNoteIds.includes(noteId)) return t
            const next = t.linkedNoteIds.filter(id => id !== noteId)
            return { ...t, linkedNoteIds: next.length > 0 ? next : undefined }
          }),
        })),
        canvasCards: state.canvasCards.filter(c => c.refNoteId !== noteId),
      }
    }
    case 'ADD_NOTE_FOLDER':
      return { ...state, noteFolders: [...state.noteFolders, action.payload] }
    case 'UPDATE_NOTE_FOLDER':
      return { ...state, noteFolders: state.noteFolders.map(f => f.id === action.payload.id ? action.payload : f) }
    case 'DELETE_NOTE_FOLDER':
      // Cascade-promote: child folders bubble up to root, notes in the deleted folder become unfiled.
      return {
        ...state,
        noteFolders: state.noteFolders
          .filter(f => f.id !== action.payload)
          .map(f => f.parentId === action.payload ? { ...f, parentId: undefined } : f),
        notes: state.notes.map(n => n.folderId === action.payload ? { ...n, folderId: undefined } : n),
      }
    case 'ADD_PROJECT':
      return { ...state, projects: [action.payload, ...state.projects] }
    case 'UPDATE_PROJECT':
      return { ...state, projects: state.projects.map(p => p.id === action.payload.id ? action.payload : p) }
    case 'DELETE_PROJECT': {
      // Sweep any canvas cards that reference a task in the deleted board so we
      // don't strand refTaskId pointers.
      const projectId = action.payload
      const doomedProject = state.projects.find(p => p.id === projectId)
      const doomedTaskIds = new Set(doomedProject ? doomedProject.tasks.map(t => t.id) : [])
      return {
        ...state,
        projects: state.projects.filter(p => p.id !== projectId),
        canvasCards: doomedTaskIds.size > 0
          ? state.canvasCards.filter(c => !c.refTaskId || !doomedTaskIds.has(c.refTaskId))
          : state.canvasCards,
      }
    }
    case 'ADD_TASK': {
      // Mirror UPDATE_TASK's completedAt auto-stamp so bulk-imported 'done' tasks
      // land in state with a completion timestamp — otherwise anything that sorts
      // by completedAt (or displays "✓ YYYY-MM-DD") silently drops them.
      const raw = action.payload.task
      const task = raw.status === 'done' && !raw.completedAt
        ? { ...raw, completedAt: new Date().toISOString() }
        : raw
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === action.payload.projectId
            ? { ...p, tasks: [...p.tasks, task] }
            : p
        ),
      }
    }
    case 'UPDATE_TASK':
      // Auto-stamp completedAt on status transitions so "hide done" / completion-time
      // sorts work without every caller having to remember to set it. Also preserve
      // an existing completedAt if the payload omitted it while status remains 'done'
      // — a partial update shouldn't blank out the original completion time.
      return {
        ...state,
        projects: state.projects.map(p => {
          if (p.id !== action.payload.projectId) return p
          return {
            ...p,
            tasks: p.tasks.map(t => {
              if (t.id !== action.payload.task.id) return t
              const next = action.payload.task
              const wasDone = t.status === 'done'
              const isDone = next.status === 'done'
              if (!wasDone && isDone && !next.completedAt) return { ...next, completedAt: new Date().toISOString() }
              if (wasDone && !isDone) return { ...next, completedAt: undefined }
              // Same-state 'done' updates: preserve existing completedAt when payload omits it.
              if (wasDone && isDone && !next.completedAt && t.completedAt) return { ...next, completedAt: t.completedAt }
              return next
            }),
          }
        }),
      }
    case 'DELETE_TASK': {
      // Also drop canvas cards that hydrate from this task — leaving them would
      // render as permanently "broken" cards after the underlying task is gone.
      const { taskId } = action.payload
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === action.payload.projectId
            ? { ...p, tasks: p.tasks.filter(t => t.id !== taskId) }
            : p
        ),
        canvasCards: state.canvasCards.filter(c => c.refTaskId !== taskId),
      }
    }
    case 'SET_PROJECT_TASKS':
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === action.payload.projectId ? { ...p, tasks: action.payload.tasks } : p
        )
      }
    case 'ADD_RESEARCH':
      return { ...state, research: [action.payload, ...state.research] }
    case 'UPDATE_RESEARCH':
      return { ...state, research: state.research.map(r => r.id === action.payload.id ? action.payload : r) }
    case 'DELETE_RESEARCH':
      return { ...state, research: state.research.filter(r => r.id !== action.payload) }
    case 'ADD_RESEARCH_FOLDER':
      return { ...state, researchFolders: [...state.researchFolders, action.payload] }
    case 'UPDATE_RESEARCH_FOLDER':
      return { ...state, researchFolders: state.researchFolders.map(f => f.id === action.payload.id ? action.payload : f) }
    case 'DELETE_RESEARCH_FOLDER':
      // Preserve orphans on deletion:
      //   - Bookmarks in this folder become unfiled (folderId cleared).
      //   - Child folders are promoted to root (parentId cleared) so they remain accessible.
      return {
        ...state,
        researchFolders: state.researchFolders
          .filter(f => f.id !== action.payload)
          .map(f => f.parentId === action.payload ? { ...f, parentId: undefined } : f),
        research: state.research.map(r => r.folderId === action.payload ? { ...r, folderId: undefined } : r),
      }
    case 'ADD_SKETCH':
      return { ...state, sketches: [action.payload, ...state.sketches] }
    case 'ADD_TIMELINE_BAND':
      return { ...state, timelineBands: [action.payload, ...state.timelineBands] }
    case 'UPDATE_TIMELINE_BAND':
      return { ...state, timelineBands: state.timelineBands.map(b => b.id === action.payload.id ? action.payload : b) }
    case 'DELETE_TIMELINE_BAND':
      return { ...state, timelineBands: state.timelineBands.filter(b => b.id !== action.payload) }
    case 'ADD_FLOW':
      return { ...state, flows: [action.payload, ...state.flows] }
    case 'UPDATE_FLOW':
    case 'SET_FLOW':
      return { ...state, flows: state.flows.map(f => f.id === action.payload.id ? action.payload : f) }
    case 'DELETE_FLOW':
      return { ...state, flows: state.flows.filter(f => f.id !== action.payload) }
    case 'ADD_PLAN':
      return { ...state, plans: [action.payload, ...state.plans] }
    case 'UPDATE_PLAN':
      return { ...state, plans: state.plans.map(p => p.id === action.payload.id ? action.payload : p) }
    case 'DELETE_PLAN':
      return { ...state, plans: state.plans.filter(p => p.id !== action.payload) }
    case 'ADD_PLAN_FOLDER':
      return { ...state, planFolders: [...state.planFolders, action.payload] }
    case 'UPDATE_PLAN_FOLDER':
      return { ...state, planFolders: state.planFolders.map(f => f.id === action.payload.id ? action.payload : f) }
    case 'DELETE_PLAN_FOLDER':
      // Cascade-promote (same as note folders): child folders bubble up to root,
      // plans in the deleted folder become unfiled.
      return {
        ...state,
        planFolders: state.planFolders
          .filter(f => f.id !== action.payload)
          .map(f => f.parentId === action.payload ? { ...f, parentId: undefined } : f),
        plans: state.plans.map(p => p.folderId === action.payload ? { ...p, folderId: undefined } : p),
      }
    case 'UPDATE_SKETCH':
      return { ...state, sketches: state.sketches.map(s => s.id === action.payload.id ? action.payload : s) }
    case 'DELETE_SKETCH':
      return { ...state, sketches: state.sketches.filter(s => s.id !== action.payload) }
    case 'ADD_AI_CONVERSATION':
      return { ...state, aiConversations: [action.payload, ...state.aiConversations] }
    case 'UPDATE_AI_CONVERSATION':
      return { ...state, aiConversations: state.aiConversations.map(c => c.id === action.payload.id ? action.payload : c) }
    case 'DELETE_AI_CONVERSATION':
      return { ...state, aiConversations: state.aiConversations.filter(c => c.id !== action.payload) }
    case 'ADD_CANVAS_CARD':
      return { ...state, canvasCards: [...state.canvasCards, action.payload] }
    case 'UPDATE_CANVAS_CARD':
      return { ...state, canvasCards: state.canvasCards.map(c => c.id === action.payload.id ? action.payload : c) }
    case 'SET_CANVAS_CARD_VIEW': {
      const { id, ...patch } = action.payload
      return { ...state, canvasCards: state.canvasCards.map(c => c.id === id ? { ...c, ...patch } : c) }
    }
    case 'DELETE_CANVAS_CARD':
      // Also drop arrows that used this card as an endpoint — DELETE_CANVAS_TAB
      // already cascades arrows/groups/strokes/labels, but the per-card delete
      // was leaving dangling arrow endpoints that snap to their last stored
      // fallback coords and can silently re-attach if an undo restores a card.
      return {
        ...state,
        canvasCards: state.canvasCards.filter(c => c.id !== action.payload),
        canvasArrows: state.canvasArrows.filter(a => a.fromCardId !== action.payload && a.toCardId !== action.payload),
      }
    case 'MOVE_CANVAS_CARD':
      return { ...state, canvasCards: state.canvasCards.map(c => c.id === action.payload.id ? { ...c, x: action.payload.x, y: action.payload.y } : c) }
    case 'RESIZE_CANVAS_CARD':
      return { ...state, canvasCards: state.canvasCards.map(c => c.id === action.payload.id ? { ...c, width: action.payload.width, height: action.payload.height } : c) }
    case 'BRING_CARD_FRONT': {
      const ids = new Set(action.payload)
      return { ...state, canvasCards: [...state.canvasCards.filter(c => !ids.has(c.id)), ...state.canvasCards.filter(c => ids.has(c.id))] }
    }
    case 'SEND_CARD_BACK': {
      const ids = new Set(action.payload)
      return { ...state, canvasCards: [...state.canvasCards.filter(c => ids.has(c.id)), ...state.canvasCards.filter(c => !ids.has(c.id))] }
    }
    case 'ADD_CANVAS_TAB':
      return { ...state, canvasTabs: [...state.canvasTabs, action.payload] }
    case 'UPDATE_CANVAS_TAB':
      // canvasLink card titles mirror the tab name (they're read by search and
      // the AI context) — keep them in sync when a tab is renamed.
      return {
        ...state,
        canvasTabs: state.canvasTabs.map(t => t.id === action.payload.id ? action.payload : t),
        canvasCards: state.canvasCards.map(c => c.type === 'canvasLink' && c.refTabId === action.payload.id && c.title !== action.payload.name ? { ...c, title: action.payload.name } : c),
      }
    case 'DELETE_CANVAS_TAB':
      // Cascade the tab's own content, and clear canvasLink references from
      // OTHER tabs' cards (same idiom as the refNoteId/refTaskId cascades).
      return { ...state, canvasTabs: state.canvasTabs.filter(t => t.id !== action.payload), canvasCards: state.canvasCards.filter(c => c.tabId !== action.payload).map(c => c.refTabId === action.payload ? { ...c, refTabId: undefined } : c), canvasArrows: state.canvasArrows.filter(a => a.tabId !== action.payload), canvasGroups: state.canvasGroups.filter(g => g.tabId !== action.payload), canvasStrokes: state.canvasStrokes.filter(s => s.tabId !== action.payload), canvasLabels: state.canvasLabels.filter(l => l.tabId !== action.payload), canvasRails: state.canvasRails.filter(r => r.tabId !== action.payload), canvasStations: state.canvasStations.filter(s => s.tabId !== action.payload) }
    case 'ADD_CANVAS_BOARD':
      return { ...state, canvasBoards: [...state.canvasBoards, action.payload] }
    case 'UPDATE_CANVAS_BOARD':
      return { ...state, canvasBoards: state.canvasBoards.map(b => b.id === action.payload.id ? action.payload : b) }
    case 'DELETE_CANVAS_BOARD':
      // Board only — its tabs (and their content) survive, dropping back to 未分類.
      return {
        ...state,
        canvasBoards: state.canvasBoards.filter(b => b.id !== action.payload),
        canvasTabs: state.canvasTabs.map(t => t.boardId === action.payload ? { ...t, boardId: undefined } : t),
      }
    case 'ADD_CANVAS_ARROW':
      return { ...state, canvasArrows: [...state.canvasArrows, action.payload] }
    case 'UPDATE_CANVAS_ARROW':
      return { ...state, canvasArrows: state.canvasArrows.map(a => a.id === action.payload.id ? action.payload : a) }
    case 'DELETE_CANVAS_ARROW':
      return { ...state, canvasArrows: state.canvasArrows.filter(a => a.id !== action.payload) }
    case 'ADD_CANVAS_GROUP':
      return { ...state, canvasGroups: [...state.canvasGroups, action.payload] }
    case 'UPDATE_CANVAS_GROUP':
      return { ...state, canvasGroups: state.canvasGroups.map(g => g.id === action.payload.id ? action.payload : g) }
    case 'DELETE_CANVAS_GROUP':
      return { ...state, canvasGroups: state.canvasGroups.filter(g => g.id !== action.payload) }
    case 'ADD_CANVAS_STROKE':
      return { ...state, canvasStrokes: [...state.canvasStrokes, action.payload] }
    case 'DELETE_CANVAS_STROKE':
      return { ...state, canvasStrokes: state.canvasStrokes.filter(s => s.id !== action.payload) }
    case 'REPLACE_CANVAS_STROKES':
      return { ...state, canvasStrokes: [...state.canvasStrokes.filter(s => s.tabId !== action.payload.tabId), ...action.payload.strokes] }
    case 'ADD_CANVAS_RAIL':
      return { ...state, canvasRails: [...state.canvasRails, action.payload] }
    case 'UPDATE_CANVAS_RAIL':
      return { ...state, canvasRails: state.canvasRails.map(r => r.id === action.payload.id ? action.payload : r) }
    case 'DELETE_CANVAS_RAIL': {
      // Drop the rail, and any of its stations that no OTHER rail threads through
      // (transfer stations survive on their remaining rails).
      const rail = state.canvasRails.find(r => r.id === action.payload)
      if (!rail) return state
      const rails = state.canvasRails.filter(r => r.id !== action.payload)
      const stillUsed = new Set(rails.flatMap(r => r.stationIds))
      return {
        ...state,
        canvasRails: rails,
        canvasStations: state.canvasStations.filter(s => !rail.stationIds.includes(s.id) || stillUsed.has(s.id)),
      }
    }
    case 'ADD_CANVAS_STATION': {
      // Station + its rail-thread entry land in ONE action so undo removes both.
      // `index` inserts mid-line (クリックが既存の線分上だったとき) instead of appending.
      // railId 省略時は unthreaded な駅として追加（複製/ペーストが路線を別途作る）。
      const { station, railId, index } = action.payload
      return {
        ...state,
        canvasStations: [...state.canvasStations, station],
        canvasRails: state.canvasRails.map(r => {
          if (r.id !== railId) return r
          const ids = index != null
            ? [...r.stationIds.slice(0, index), station.id, ...r.stationIds.slice(index)]
            : [...r.stationIds, station.id]
          return { ...r, stationIds: ids }
        }),
      }
    }
    case 'UPDATE_CANVAS_STATION':
      return { ...state, canvasStations: state.canvasStations.map(s => s.id === action.payload.id ? action.payload : s) }
    case 'DELETE_CANVAS_STATION':
      return {
        ...state,
        canvasStations: state.canvasStations.filter(s => s.id !== action.payload),
        canvasRails: state.canvasRails.map(r => r.stationIds.includes(action.payload) ? { ...r, stationIds: r.stationIds.filter(id => id !== action.payload) } : r),
      }
    case 'APPEND_STATION_TO_RAIL': {
      // Thread an EXISTING station onto a rail (乗換駅). No-op if already on it.
      const { railId, stationId } = action.payload
      const rail = state.canvasRails.find(r => r.id === railId)
      if (!rail || rail.stationIds.includes(stationId)) return state
      return { ...state, canvasRails: state.canvasRails.map(r => r.id === railId ? { ...r, stationIds: [...r.stationIds, stationId] } : r) }
    }
    case 'DETACH_STATION_FROM_RAIL': {
      // Un-thread a station from ONE rail; the station itself stays (it keeps its
      // other rails, or floats unthreaded — still selectable/deletable on canvas).
      const { railId, stationId } = action.payload
      return { ...state, canvasRails: state.canvasRails.map(r => r.id === railId ? { ...r, stationIds: r.stationIds.filter(id => id !== stationId) } : r) }
    }
    case 'ADD_CANVAS_LABEL':
      return { ...state, canvasLabels: [...state.canvasLabels, action.payload] }
    case 'UPDATE_CANVAS_LABEL':
      return { ...state, canvasLabels: state.canvasLabels.map(l => l.id === action.payload.id ? action.payload : l) }
    case 'DELETE_CANVAS_LABEL':
      return { ...state, canvasLabels: state.canvasLabels.filter(l => l.id !== action.payload) }
    default:
      return state
  }
}

/* ── Undo/Redo history + localStorage persistence ── */

const STORAGE_KEY = 'maind_set_state_v1'
const HISTORY_LIMIT = 100
const COALESCE_MS = 500
// Continuous-edit actions (drag/resize/typing) coalesce into a single undo step
const COALESCABLE = new Set<Action['type']>([
  'MOVE_CANVAS_CARD', 'RESIZE_CANVAS_CARD', 'UPDATE_CANVAS_CARD',
  'UPDATE_CANVAS_ARROW', 'UPDATE_CANVAS_GROUP', 'UPDATE_CANVAS_LABEL',
  // Dragging a 駅 / typing a 路線 name fires many dispatches — one undo step.
  'UPDATE_CANVAS_STATION', 'UPDATE_CANVAS_RAIL',
  'UPDATE_NOTE', 'UPDATE_PROJECT', 'UPDATE_RESEARCH', 'UPDATE_TASK', 'UPDATE_CANVAS_TAB', 'UPDATE_CANVAS_BOARD',
  'UPDATE_MASTER_PROJECT',
  // Flow node drags / title typing produce many UPDATE_FLOW dispatches — one undo step.
  'UPDATE_FLOW',
  // Plan (計画) markdown typing — one undo step per burst, like notes.
  'UPDATE_PLAN',
  // Dragging/resizing a timeline band fires many UPDATE_TIMELINE_BAND — coalesce.
  'UPDATE_TIMELINE_BAND',
  // AI streaming sends many UPDATE_AI_CONVERSATION dispatches per response — coalesce
  // so a single multi-turn assistant reply doesn't blow up the undo history.
  'UPDATE_AI_CONVERSATION',
])
// View-only / selection state — persisted, but never an undo step. Switching the
// active master project must not become an undo step (an UNDO would teleport the
// user to a different project).
const NO_HISTORY = new Set<Action['type']>(['SET_CANVAS_CARD_VIEW', 'SET_ACTIVE_MASTER_PROJECT'])
// Discrete, atomic edits (add/remove/paste of a flow node/group) that must stay
// their own undo step and NOT absorb a following continuous edit. Without this,
// creating a memo/image then immediately typing/resizing (<500ms) would coalesce
// into the add, so one UNDO removes the whole card instead of the last edit.
// NB: intentionally excludes the multi-dispatch タスク化 conversion, which relies
// on its trailing UPDATE_FLOW coalescing into ADD_PROJECT/SET_PROJECT_TASKS.
// BATCH も同様: 複製/貼り付け直後のドラッグが複製ステップに吸収されると、
// 1回の UNDO で「移動＋複製」がまとめて消えてしまう。
const CLOSES_COALESCE_WINDOW = new Set<Action['type']>(['SET_FLOW', 'BATCH'])

interface History {
  past: AppState[]
  present: AppState
  future: AppState[]
  lastCommitAt: number
}

type HistoryAction = Action | { type: 'UNDO' } | { type: 'REDO' } | { type: '__HYDRATE'; payload: AppState }

function historyReducer(h: History, action: HistoryAction): History {
  if (action.type === '__HYDRATE') {
    // Replace state with the asynchronously-loaded persisted data; reset history.
    return { past: [], present: action.payload, future: [], lastCommitAt: 0 }
  }
  if (action.type === 'UNDO') {
    if (h.past.length === 0) return h
    const previous = h.past[h.past.length - 1]
    return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], lastCommitAt: 0 }
  }
  if (action.type === 'REDO') {
    if (h.future.length === 0) return h
    return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastCommitAt: 0 }
  }
  const present = reducer(h.present, action)
  if (present === h.present) return h // no-op action → don't record history
  // View-only / selection updates advance state (so they persist) but never create
  // an undo step. They DO clear the redo stack: a deliberate navigation like
  // switching the active master project must not be resurrectable by a later REDO
  // (the stale future snapshot would teleport the user back to the old project).
  // View-only actions also break the coalesce chain — a navigation between two
  // typing bursts must sever their undo grouping so a later UNDO doesn't reach
  // past the navigation.
  // past のスナップショットにも同じビュー状態を適用する。さもないと、無関係な編集を
  // UNDO した瞬間に古いビュー状態（Webカードの遷移前URL・PDFのページ・アクティブ
  // プロジェクト）まで巻き戻ってしまう。
  if (NO_HISTORY.has(action.type)) {
    return { ...h, past: h.past.map(s => reducer(s, action)), present, future: [], lastCommitAt: 0 }
  }
  const now = Date.now()
  if (COALESCABLE.has(action.type) && h.lastCommitAt && now - h.lastCommitAt < COALESCE_MS) {
    // coalesce: keep the same undo target, just advance the present
    return { past: h.past, present, future: [], lastCommitAt: now }
  }
  // A discrete atomic action closes the coalesce window (lastCommitAt = 0) so the
  // NEXT continuous edit starts a fresh undo step instead of folding into this one.
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present, future: [], lastCommitAt: CLOSES_COALESCE_WINDOW.has(action.type) ? 0 : now }
}

function initHistory(): History {
  // Start from sample data; real persisted state is loaded asynchronously from
  // SQLite in AppProvider and applied via __HYDRATE (children render only after).
  return { past: [], present: initialState, future: [], lastCommitAt: 0 }
}

// One-time migration source: the pre-SQLite localStorage snapshot.
function readLegacyState(): AppState | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return null
    return { ...initialState, ...JSON.parse(saved) }
  } catch { return null }
}

// All live media references: card media URLs plus idb: images embedded in any
// Markdown text (card/page content, note content, task/research descriptions).
function collectMediaRefs(s: AppState): string[] {
  const refs: string[] = []
  const scan = (text?: string) => {
    const m = text?.match(/idb:[A-Za-z0-9]+/g)
    if (m) refs.push(...m)
  }
  for (const c of s.canvasCards) {
    if (c.url) refs.push(c.url)
    c.frames?.forEach(f => { const u = typeof f === 'string' ? f : f?.url; if (u) refs.push(u) })
    scan(c.content)
    c.pages?.forEach(p => scan(p.content))
  }
  s.notes.forEach(n => {
    scan(n.content)
    n.attachments?.forEach(a => { if (a.url) refs.push(a.url) }) // ノート付随資料
  })
  s.projects.forEach(p => p.tasks.forEach(t => scan(t.description)))
  s.research.forEach(r => scan(r.description))
  s.plans.forEach(p => scan(p.content)) // e-ticket attachments referenced as [x](idb:…)
  return refs
}

// Ensure the master-project layer is well-formed for state from any source: older
// DBs (no master_projects), the pre-master localStorage snapshot, or an imported
// backup of pre-master data. Guarantee at least one master project, a valid active
// one, and attach every orphaned note/task-project/research/canvas-category to a
// master so nothing is filtered out of existence after the per-master scoping.
function normalizeMasterProjects(s: AppState): AppState {
  let masterProjects = s.masterProjects ?? []
  if (masterProjects.length === 0) {
    masterProjects = [{ id: DEFAULT_MASTER_ID, name: 'メイン', createdAt: new Date().toISOString() }]
  }
  const ids = new Set(masterProjects.map(p => p.id))
  const fallback = ids.has(DEFAULT_MASTER_ID) ? DEFAULT_MASTER_ID : masterProjects[0].id

  let changed = masterProjects !== s.masterProjects
  const fixScope = <T extends { masterProjectId: string }>(arr: T[]): T[] =>
    arr.map(it => {
      if (!it.masterProjectId || !ids.has(it.masterProjectId)) { changed = true; return { ...it, masterProjectId: fallback } }
      return it
    })
  const notes = fixScope(s.notes)
  const noteFolders = fixScope(s.noteFolders ?? [])
  const projects = fixScope(s.projects)
  const research = fixScope(s.research)
  const researchFolders = fixScope(s.researchFolders ?? [])
  const sketches = fixScope(s.sketches)
  const flows = fixScope(s.flows ?? [])
  const plans = fixScope(s.plans ?? [])
  const planFolders = fixScope(s.planFolders ?? [])
  const timelineBands = fixScope(s.timelineBands ?? [])
  const aiConversations = fixScope(s.aiConversations)
  // Canvas categories (tabs) and boards carry the owning master id in `projectId`.
  const canvasTabs = s.canvasTabs.map(t => {
    if (!t.projectId || !ids.has(t.projectId)) { changed = true; return { ...t, projectId: fallback } }
    return t
  })
  if (!s.canvasBoards) changed = true // pre-board snapshots: materialize the field
  const canvasBoards = (s.canvasBoards ?? []).map(b => {
    if (!b.projectId || !ids.has(b.projectId)) { changed = true; return { ...b, projectId: fallback } }
    return b
  })
  let activeMasterProjectId = s.activeMasterProjectId
  if (!activeMasterProjectId || !ids.has(activeMasterProjectId)) { changed = true; activeMasterProjectId = fallback }

  if (!changed) return s
  return { ...s, masterProjects, notes, noteFolders, projects, research, researchFolders, sketches, flows, plans, planFolders, timelineBands, aiConversations, canvasTabs, canvasBoards, activeMasterProjectId }
}

const AppContext = createContext<{
  state: AppState
  dispatch: React.Dispatch<Action>
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  syncNow: () => Promise<void>
} | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [history, dispatch] = useReducer(historyReducer, undefined, initHistory)
  const [hydrated, setHydrated] = useState(false)
  // Set when the DB was auto-restored from a backup at load time (corruption
  // recovery) — rendered as a dismissible banner over the app.
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  // If the DB exists but could not be read, we must NOT seed/overwrite it — that
  // would turn a transient read failure into permanent data loss. Render sample
  // data but never persist over the real (currently-unreadable) database.
  const [loadFailed, setLoadFailed] = useState(false)
  // Latest committed state, for flushing on teardown without re-subscribing.
  const latest = useRef(history.present)
  latest.current = history.present
  // Version token of the DB as we last loaded/saved it — used to detect when another
  // device (iPad over the LAN) changed it so we reload on focus. Guards re-entrancy.
  const lastEtag = useRef('')
  const syncing = useRef(false)

  // Pull the latest DB from the server and re-hydrate (used by focus-sync and the
  // manual Sync button). Pull-only by design: in one-device-at-a-time use you press
  // it on the device you want to refresh, so it never pushes a stale view.
  const reloadFromServer = useCallback(async () => {
    if (syncing.current) return
    syncing.current = true
    try {
      const loaded = await reloadState()
      if (loaded) {
        dispatch({ type: '__HYDRATE', payload: normalizeMasterProjects(loaded) })
        try { lastEtag.current = await dbEtag() } catch { /* ignore */ }
      }
    } catch { /* ignore */ } finally { syncing.current = false }
  }, [])

  // Load persisted state from SQLite once; a genuinely fresh DB (loadState → null)
  // migrates the old localStorage snapshot or falls back to sample data and seeds
  // the DB. A thrown error means the DB exists but is unreadable → do not seed.
  useEffect(() => {
    let alive = true
    ;(async () => {
      let loaded: AppState | null
      try {
        loaded = await loadState()
      } catch {
        if (alive) { dispatch({ type: '__HYDRATE', payload: initialState }); setLoadFailed(true); setHydrated(true) }
        return
      }
      if (loaded === null) {
        loaded = normalizeMasterProjects(readLegacyState() ?? initialState)
        try { await saveState(loaded) } catch { /* ignore */ }
      } else {
        loaded = normalizeMasterProjects(loaded)
      }
      if (!alive) return
      // Reclaim blobs no longer referenced by anything (safe here: no undo history
      // exists yet, so the loaded state is the full live set). References come from
      // card.url AND any idb: image embedded in Markdown content/descriptions, plus
      // idb: image refs inside the 路線図 (mindtrain) store blob.
      const refs = collectMediaRefs(loaded)
      try {
        const mt = await loadKv('mindtrain')
        const m = mt?.match(/idb:[A-Za-z0-9]+/g)
        if (m) refs.push(...m)
      } catch { /* ignore */ }
      if (!alive) return
      sweepMedia(refs).catch(() => { /* ignore */ })
      try { lastEtag.current = await dbEtag() } catch { /* ignore */ }
      if (!alive) return
      dispatch({ type: '__HYDRATE', payload: loaded })
      setHydrated(true)
      // If the DB was auto-restored from a backup (corruption at load time),
      // surface it as a dismissible banner. (Not alert(): Electron's blocking
      // alert during boot is unreliable and would freeze first paint.)
      const notice = consumeDbRecoveryNotice()
      if (notice) setRecoveryNotice(notice)
    })()
    return () => { alive = false }
  }, [])

  // Persist to SQLite (debounced). Never write before hydration or after a load
  // failure, or we'd clobber the stored data.
  useEffect(() => {
    if (!hydrated || loadFailed) return
    const id = setTimeout(() => {
      saveState(history.present)
        .then(() => dbEtag())
        .then(e => { if (e) lastEtag.current = e })
        .catch(() => { /* ignore */ })
    }, 400)
    return () => clearTimeout(id)
  }, [history.present, hydrated, loadFailed])

  // Flush the latest state immediately when the page is hidden or closing, so an
  // edit made within the 400ms debounce window isn't lost on reload/quit.
  useEffect(() => {
    if (!hydrated || loadFailed) return
    const flush = () => { saveState(latest.current).then(() => dbEtag()).then(e => { if (e) lastEtag.current = e }).catch(() => { /* ignore */ }) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    // 'blur' = the window lost focus (e.g. user picked up the iPad): flush now so the
    // other device reads our latest on its next focus (LAN one-device-at-a-time sync).
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hydrated, loadFailed])

  // Cross-device focus-sync: when LAN access is in play (this is a remote client, or
  // the desktop has the server enabled), reload the DB on focus if another device
  // wrote it. No-op for the default desktop (server off) — behavior is unchanged.
  useEffect(() => {
    if (!hydrated || loadFailed) return
    const onFocus = async () => {
      if (syncing.current) return
      if (!isRemote) {
        try {
          const st = await (window as unknown as { api?: { remote?: { status?: () => Promise<{ enabled: boolean }> } } }).api?.remote?.status?.()
          if (!st?.enabled) return
        } catch { return }
      }
      let e = ''
      try { e = await dbEtag() } catch { return }
      if (!e || e === lastEtag.current) return // only reload if another device wrote
      await reloadFromServer()
    }
    const onVis = () => { if (document.visibilityState === 'visible') onFocus() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVis) }
  }, [hydrated, loadFailed, reloadFromServer])

  const value = useMemo(() => ({
    state: history.present,
    dispatch: dispatch as React.Dispatch<Action>,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => dispatch({ type: 'UNDO' }),
    redo: () => dispatch({ type: 'REDO' }),
    syncNow: reloadFromServer,
  }), [history, reloadFromServer])

  if (!hydrated) {
    return <div className="h-screen w-screen flex items-center justify-center text-slate-400 text-sm">読み込み中…</div>
  }

  return (
    <AppContext.Provider value={value}>
      {children}
      {recoveryNotice && (
        <div
          data-db-recovery-banner="1"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] max-w-[560px] flex items-start gap-2 px-4 py-2.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs shadow-lg"
        >
          <span className="font-semibold shrink-0">⚠ 自動復元</span>
          <span className="flex-1">{recoveryNotice}</span>
          <button
            onClick={async () => {
              try {
                await exportBackup(latest.current)
                try { localStorage.setItem('constella.lastBackupExport', new Date().toISOString()) } catch { /* ignore */ }
              } catch { /* ignore */ }
            }}
            className="shrink-0 px-2 py-0.5 rounded border border-amber-300 hover:bg-amber-100 font-semibold text-[11px]"
            title="現在のデータをバックアップファイルに書き出します"
          >
            今すぐバックアップを書き出し
          </button>
          <button
            onClick={() => setRecoveryNotice(null)}
            className="shrink-0 px-1.5 rounded hover:bg-amber-100 font-semibold"
            title="閉じる"
          >
            ×
          </button>
        </div>
      )}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used within AppProvider')
  return context
}
