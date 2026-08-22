// Demo dataset for documentation captures — a fictional "札幌ロケハン 2026" project.
// Emitted as a Constella backup JSON (same shape persistence/backup.ts imports),
// so the capture runner can load it through the real "バックアップを読み込み" path.
// Keep every id stable: scenarios reference them.

const T0 = '2026-08-01T09:00:00.000Z'
let seq = 0
const id = (p) => `${p}-${String(++seq).padStart(3, '0')}`

export const MASTER_ID = 'docs-master'

export function buildSeed() {
  const m = MASTER_ID

  // ── Notes ──
  const folderPlan = { id: 'nf-plan', masterProjectId: m, name: '企画', createdAt: T0, color: 'indigo' }
  const folderLoc = { id: 'nf-loc', masterProjectId: m, name: 'ロケ地', createdAt: T0, color: 'emerald' }
  const notes = [
    {
      id: 'note-brief', masterProjectId: m, folderId: 'nf-plan', pinned: true, tags: ['企画', '重要'],
      title: '撮影企画ブリーフ', createdAt: T0, updatedAt: T0,
      content: `# 撮影企画ブリーフ

## 目的

札幌市内の**観光プロモーション映像**（90 秒）の素材撮影。秋の紅葉シーズンに合わせて 2 日間で回る。

## 納品物

| 項目 | 仕様 |
| --- | --- |
| 本編 | 90 秒 / 4K / 16:9 |
| SNS 用 | 15 秒 × 3 本 / 9:16 |
| 静止画 | 20 カット以上 |

## スケジュール

\`\`\`mermaid
graph LR
  A[企画確定] --> B[ロケハン] --> C[本番撮影] --> D[編集] --> E[納品]
\`\`\`

> [!IMPORTANT]
> 大通公園の撮影は **許可申請が 2 週間前まで**。忘れずに。

- [x] 企画書提出
- [ ] ロケハン日程調整
- [ ] 機材リスト確定
`,
    },
    {
      id: 'note-gear', masterProjectId: m, folderId: 'nf-plan', tags: ['機材'],
      title: '機材リスト', createdAt: T0, updatedAt: T0,
      content: `# 機材リスト

- カメラ本体 ×2（予備バッテリー 6 本）
- 24-70mm / 70-200mm
- ジンバル
- ドローン（==飛行許可要確認==）
- 三脚 ×2、ND フィルター
`,
    },
    {
      id: 'note-odori', masterProjectId: m, folderId: 'nf-loc', tags: ['ロケ地'],
      title: '大通公園', createdAt: T0, updatedAt: T0,
      content: `# 大通公園

- 撮影許可: 札幌市公園管理課（申請 2 週間前）
- ベストタイム: 朝 7:00 前後（人が少ない）
- テレビ塔を背景に東向きで撮る
`,
    },
    {
      id: 'note-contacts', masterProjectId: m, folderId: 'nf-loc', tags: ['連絡先'], shared: true,
      title: '関係者連絡先', createdAt: T0, updatedAt: T0,
      content: `# 関係者連絡先

| 担当 | 名前 | 連絡先 |
| --- | --- | --- |
| クライアント | 佐藤 | sato@example.com |
| ロケコーディネーター | 高橋 | takahashi@example.com |
`,
    },
  ]

  // ── Tasks ──
  const boardPrep = {
    id: 'board-prep', masterProjectId: m, name: '撮影準備', description: '', createdAt: T0, color: 'indigo',
    tasks: [
      { id: 'task-permit', title: '撮影許可の申請', description: '大通公園・時計台', status: 'done', tags: [], createdAt: T0, startDate: '2026-08-03', endDate: '2026-08-05', priority: 1, completedAt: T0 },
      { id: 'task-locscout', title: 'ロケハン', description: '', status: 'in-progress', tags: [], createdAt: T0, startDate: '2026-08-18', endDate: '2026-08-19', priority: 2, linkedNoteIds: ['note-odori'] },
      { id: 'task-loc-odori', title: '大通公園', description: '', status: 'done', tags: [], createdAt: T0, startDate: '2026-08-18', endDate: '2026-08-18', parentId: 'task-locscout' },
      { id: 'task-loc-tower', title: '時計台・テレビ塔', description: '', status: 'in-progress', tags: [], createdAt: T0, startDate: '2026-08-18', endDate: '2026-08-18', parentId: 'task-locscout' },
      { id: 'task-loc-moiwa', title: '藻岩山 夜景', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-08-19', endDate: '2026-08-19', parentId: 'task-locscout' },
      { id: 'task-gear', title: '機材手配', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-08-20', endDate: '2026-08-25', priority: 2, linkedNoteIds: ['note-gear'] },
      { id: 'task-shoot', title: '本番撮影', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-09-01', endDate: '2026-09-02', priority: 1 },
      { id: 'task-edit', title: '編集・納品', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-09-03', endDate: '2026-09-12' },
      { id: 'task-storyboard', title: '絵コンテ作成', description: '', status: 'todo', tags: [], createdAt: T0, priority: 3 },
    ],
  }
  const boardPost = {
    id: 'board-post', masterProjectId: m, name: '編集・納品', description: '', createdAt: T0, color: 'amber',
    tasks: [
      { id: 'task-rough', title: 'ラフカット', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-09-03', endDate: '2026-09-06' },
      { id: 'task-color', title: 'カラーグレーディング', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-09-07', endDate: '2026-09-09' },
      { id: 'task-deliver', title: '納品', description: '', status: 'todo', tags: [], createdAt: T0, startDate: '2026-09-12', endDate: '2026-09-12', priority: 1 },
    ],
  }

  // ── Canvas ──
  const boardKikaku = { id: 'cb-kikaku', projectId: m, name: '企画', color: 'indigo', createdAt: T0 }
  const boardSys = { id: 'cb-sys', projectId: m, name: '機材・システム', color: 'sky', createdAt: T0 }
  const tabMain = { id: 'ct-main', projectId: m, boardId: 'cb-kikaku', name: '全体構成', createdAt: T0 }
  const tabLoc = { id: 'ct-loc', projectId: m, boardId: 'cb-kikaku', name: 'ロケ地候補', createdAt: T0 }
  const tabDraft = { id: 'ct-draft', projectId: m, boardId: 'cb-kikaku', name: '工程の下書き', createdAt: T0 }
  const tabSys = { id: 'ct-sys', projectId: m, boardId: 'cb-sys', name: '撮影システム', createdAt: T0 }
  const tabRail = { id: 'ct-rail', projectId: m, boardId: 'cb-sys', name: '進行ロードマップ', createdAt: T0 }

  const card = (tabId, type, title, x, y, w, h, extra = {}) => ({
    id: id('card'), tabId, type, title, content: '', x, y, width: w, height: h, createdAt: T0, ...extra,
  })

  const cards = [
    // 全体構成 — the hero tab
    card('ct-main', 'text', '企画コンセプト', 80, 80, 360, 240, {
      content: `## 秋の札幌、朝の光

**テーマ**: 朝 7 時の静かな街と、紅葉の色。

- 大通公園 → 時計台 → テレビ塔の導線
- ドローンは藻岩山の夜景のみ
- 人物は地元の人 2 名（要モデルリリース）`,
      color: 'indigo',
    }),
    card('ct-main', 'note', '撮影企画ブリーフ', 500, 80, 260, 170, { refNoteId: 'note-brief' }),
    card('ct-main', 'todo', 'ロケハン', 500, 290, 260, 150, { refTaskId: 'task-locscout' }),
    card('ct-main', 'idea', 'ドローンで紅葉を俯瞰', 80, 380, 220, 140, { content: '藻岩山ロープウェイ駅付近から。\n日没 30 分前がベスト。', color: 'amber' }),
    card('ct-main', 'research', '札幌市 撮影許可', 340, 380, 220, 140, { content: '公園管理課 / 申請 2 週間前', url: 'https://www.city.sapporo.jp/', color: 'sky' }),
    card('ct-main', 'web', 'Constella on GitHub', 820, 80, 420, 360, { url: 'https://github.com/yyamada722/constella' }),
    card('ct-main', 'canvasLink', 'ロケ地候補へ', 820, 480, 240, 190, { refTabId: 'ct-loc' }),

    // ロケ地候補
    card('ct-loc', 'idea', '大通公園', 80, 80, 220, 140, { content: '朝 7:00 / 東向き / テレビ塔バック', color: 'emerald' }),
    card('ct-loc', 'idea', '時計台', 340, 80, 220, 140, { content: '外観のみ。車通りに注意', color: 'emerald' }),
    card('ct-loc', 'idea', 'テレビ塔', 600, 80, 220, 140, { content: '展望台からの俯瞰', color: 'emerald' }),
    card('ct-loc', 'idea', '藻岩山', 80, 300, 220, 140, { content: '夜景 / ドローン', color: 'violet' }),
    card('ct-loc', 'idea', '北海道大学', 340, 300, 220, 140, { content: 'イチョウ並木（10 月下旬）', color: 'amber' }),
    card('ct-loc', 'note', '大通公園（ノート）', 600, 300, 260, 150, { refNoteId: 'note-odori' }),

    // 工程の下書き — taskDraft cards with arrows (parent → child)
    card('ct-draft', 'taskDraft', '本番撮影', 120, 100, 210, 112, { draftWhen: 'monthStart' }),
    card('ct-draft', 'taskDraft', '1 日目 市内', 60, 300, 210, 112, { draftWhen: 'monthStart' }),
    card('ct-draft', 'taskDraft', '2 日目 藻岩山', 320, 300, 210, 112, { draftWhen: 'earlyMonth' }),
    card('ct-draft', 'taskDraft', '素材バックアップ', 580, 300, 210, 112, { draftWhen: 'earlyMonth' }),

    // 撮影システム — shapes
    card('ct-sys', 'shape', 'カメラ A', 80, 120, 160, 100, { shape: 'pc' }),
    card('ct-sys', 'shape', 'カメラ B', 80, 300, 160, 100, { shape: 'pc' }),
    card('ct-sys', 'shape', 'ドローン', 80, 480, 160, 100, { shape: 'hexagon' }),
    card('ct-sys', 'shape', '現場 NAS', 400, 300, 180, 110, { shape: 'cylinder' }),
    card('ct-sys', 'shape', 'クラウド', 700, 300, 180, 110, { shape: 'cloud' }),
    card('ct-sys', 'shape', '編集室', 1000, 300, 180, 110, { shape: 'server' }),
    card('ct-sys', 'shape', 'ディレクター', 700, 80, 140, 120, { shape: 'person' }),
  ]
  const byTitle = (t) => cards.find(c => c.title === t).id

  const arrow = (tabId, from, to, extra = {}) => ({
    id: id('arrow'), tabId, x1: 0, y1: 0, x2: 0, y2: 0, fromCardId: from, toCardId: to, createdAt: T0, ...extra,
  })
  const arrows = [
    arrow('ct-main', byTitle('企画コンセプト'), byTitle('撮影企画ブリーフ'), { label: '詳細' }),
    arrow('ct-main', byTitle('撮影企画ブリーフ'), byTitle('ロケハン'), { curved: true }),
    arrow('ct-main', byTitle('ドローンで紅葉を俯瞰'), byTitle('札幌市 撮影許可'), { label: '要申請', color: '#f59e0b' }),
    arrow('ct-draft', byTitle('本番撮影'), byTitle('1 日目 市内')),
    arrow('ct-draft', byTitle('本番撮影'), byTitle('2 日目 藻岩山')),
    arrow('ct-draft', byTitle('本番撮影'), byTitle('素材バックアップ')),
    arrow('ct-sys', byTitle('カメラ A'), byTitle('現場 NAS'), { fromPort: 'e', toPort: 'w' }),
    arrow('ct-sys', byTitle('カメラ B'), byTitle('現場 NAS'), { fromPort: 'e', toPort: 'w' }),
    arrow('ct-sys', byTitle('ドローン'), byTitle('現場 NAS'), { fromPort: 'e', toPort: 'w' }),
    arrow('ct-sys', byTitle('現場 NAS'), byTitle('クラウド'), { label: '夜間同期', width: 3 }),
    arrow('ct-sys', byTitle('クラウド'), byTitle('編集室')),
    arrow('ct-sys', byTitle('ディレクター'), byTitle('クラウド'), { curved: true, color: '#10b981', label: '確認' }),
  ]

  const groups = [
    { id: 'grp-ideas', tabId: 'ct-main', title: 'アイデア', x: 50, y: 340, width: 540, height: 210, createdAt: T0 },
    { id: 'grp-cams', tabId: 'ct-sys', title: '現場', x: 40, y: 60, width: 260, height: 560, createdAt: T0 },
    { id: 'grp-post', tabId: 'ct-sys', title: 'ポスプロ', x: 660, y: 260, width: 560, height: 190, createdAt: T0 },
  ]
  const labels = [
    { id: 'lbl-main', tabId: 'ct-main', text: '札幌ロケハン 2026 — 全体構成', x: 80, y: 20, fontSize: 22, color: '#334155', createdAt: T0 },
    { id: 'lbl-sys', tabId: 'ct-sys', text: '素材の流れ', x: 400, y: 60, fontSize: 20, color: '#334155', createdAt: T0 },
  ]

  // A quick freehand circle around the idea card (pen tool output)
  const circle = []
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2
    circle.push(190 + 135 * Math.cos(a), 450 + 90 * Math.sin(a))
  }
  const strokes = [{ id: 'stroke-1', tabId: 'ct-main', points: circle, color: '#f43f5e', width: 3, createdAt: T0 }]

  // Rails (canvas-native route map)
  const st = (name, x, y, status) => ({ id: id('st'), tabId: 'ct-rail', name, x, y, status, createdAt: T0 })
  const stations = [
    st('企画確定', 120, 200, 'done'), st('ロケハン', 320, 200, 'done'), st('許可取得', 520, 200, 'doing'),
    st('本番撮影', 720, 200, 'todo'), st('編集', 920, 200, 'todo'), st('納品', 1120, 200, 'todo'),
    st('SNS 素材', 720, 380, 'todo'), st('SNS 公開', 1120, 380, 'todo'),
  ]
  const sid = (n) => stations.find(s => s.name === n).id
  const rails = [
    { id: 'rail-main', tabId: 'ct-rail', name: '本編', color: '#6366f1', stationIds: ['企画確定', 'ロケハン', '許可取得', '本番撮影', '編集', '納品'].map(sid), createdAt: T0 },
    { id: 'rail-sns', tabId: 'ct-rail', name: 'SNS', color: '#f59e0b', stationIds: ['本番撮影', 'SNS 素材', 'SNS 公開'].map(sid), createdAt: T0 },
  ]

  // ── Plan ──
  const plan = {
    id: 'plan-locscout', masterProjectId: m, name: 'ロケハン行程', createdAt: T0, updatedAt: T0,
    content: `---
title: 札幌ロケハン
timezone: Asia/Tokyo
currency: JPY
---

## 2026-08-18

> [07:30] flight JAL503 from 羽田^HND to 新千歳^CTS
> - price: JPY {28000*2}
> - note: 機材は預け入れ 2 個
> [10:00] train 快速エアポート from 新千歳^CTS to 札幌
> [11:30] meal 昼食 :: 札幌駅周辺
> [13:00] - [15:00] location 大通公園 ロケハン at 大通公園
> [15:30] - [16:30] location 時計台・テレビ塔 at 時計台
> [18:00] hotel チェックイン :: 札幌グランドホテル
> - price: JPY 14000

> [!NOTE] 持ち物
> 三脚 ×2、ND フィルター、予備バッテリー

## 2026-08-19

> [09:00] meeting 撮影打合せ :: 高橋さん事務所
> [pm] location 藻岩山 ロケハン at 藻岩山ロープウェイ
> - note: 日没 18:20 / ドローン飛行エリア確認
> [20:30] flight JAL526 from 新千歳^CTS to 羽田^HND
> - price: JPY {28000*2}
`,
  }

  // ── Flow ──
  const flow = {
    id: 'flow-shoot', masterProjectId: m, name: '本番撮影の段取り', createdAt: T0, updatedAt: T0,
    nodes: [
      { id: 'fn-1', title: '本番撮影', x: 320, y: 40, when: 'monthStart', whenMonth: 9 },
      { id: 'fn-2', title: '1 日目 市内', x: 120, y: 220, whenInherit: true },
      { id: 'fn-3', title: '2 日目 藻岩山', x: 380, y: 220, when: 'earlyMonth', whenMonth: 9 },
      { id: 'fn-4', title: '素材バックアップ', x: 640, y: 220, when: 'earlyMonth', whenMonth: 9 },
      { id: 'fn-5', title: '機材返却', x: 640, y: 400, when: 'midMonth', whenMonth: 9 },
      { id: 'fn-memo', title: 'メモ', x: 60, y: 400, kind: 'memo', body: '雨天の場合は 2 日目を予備日に。', width: 220, height: 110 },
    ],
    edges: [
      { id: 'fe-1', fromId: 'fn-1', toId: 'fn-2' },
      { id: 'fe-2', fromId: 'fn-1', toId: 'fn-3' },
      { id: 'fe-3', fromId: 'fn-1', toId: 'fn-4' },
      { id: 'fe-4', fromId: 'fn-4', toId: 'fn-5' },
    ],
    groups: [{ id: 'fg-1', title: '現場', x: 80, y: 190, width: 520, height: 180, createdAt: T0 }],
  }

  // ── Research ──
  const research = [
    { id: 'rs-1', masterProjectId: m, title: '札幌市 公園での撮影について', url: 'https://www.city.sapporo.jp/', description: '撮影許可の申請窓口', tags: ['許可'], category: '', createdAt: T0, folderId: 'rf-permit' },
    { id: 'rs-2', masterProjectId: m, title: '藻岩山ロープウェイ', url: 'https://mt-moiwa.jp/', description: '営業時間・夜景', tags: ['ロケ地'], category: '', createdAt: T0 },
  ]
  const researchFolders = [{ id: 'rf-permit', masterProjectId: m, name: '許可・申請', createdAt: T0, color: 'rose' }]

  const state = {
    masterProjects: [
      { id: m, name: '札幌ロケハン 2026', createdAt: T0, folder: '映像制作' },
      { id: 'docs-master-2', name: '社内サイト リニューアル', createdAt: T0 },
      { id: 'docs-master-3', name: '2025 展示会（終了）', createdAt: T0, archivedAt: T0 },
    ],
    activeMasterProjectId: m,
    notes,
    noteFolders: [folderPlan, folderLoc],
    projects: [boardPrep, boardPost],
    research,
    researchFolders,
    sketches: [],
    flows: [flow],
    plans: [plan],
    planFolders: [],
    timelineBands: [],
    aiConversations: [],
    canvasBoards: [boardKikaku, boardSys],
    canvasTabs: [tabMain, tabLoc, tabDraft, tabSys, tabRail],
    canvasCards: cards,
    canvasArrows: arrows,
    canvasGroups: groups,
    canvasStrokes: strokes,
    canvasLabels: labels,
    canvasRails: rails,
    canvasStations: stations,
  }

  return { app: 'constella', version: 2, exportedAt: T0, state, media: {} }
}
