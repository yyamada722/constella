#!/usr/bin/env node
// constella — Constella のタスク / ノートをコマンドラインから読み書きする CLI。
//
// 動いている Constella アプリに localhost で話しかける (データの正はアプリのメモリなので、
// DB ファイルを直接触らない)。アプリが起動していなければ起動してから実行する。
// 書き込みは既定で「プレビューのみ」。-y / --yes を付けると適用 (アプリ側で 1 回の
// Ctrl+Z で戻せる)。
//
// 依存なし (Node 組み込みのみ)。アプリ同梱の `constella` ラッパーはアプリ本体の exe を
// ELECTRON_RUN_AS_NODE=1 で使うので、Node のインストールは不要。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HELP = `constella — Constella のタスク / ノートを CLI で読み書きする

使い方:
  constella status                         アプリとの接続を確認 (未起動なら起動)
  constella masters [--all]                マスタープロジェクト一覧
  constella boards [--master M]            ボード (タスクのプロジェクト) 一覧
  constella folders [--master M]           ノートのフォルダ一覧

  constella tasks [--board B] [--master M] [--status S] [--tag T] [--q 文字]
                  [--where "セレクタ"] [--all] [--full]
                                           タスク一覧 (既定は完了を除く。--all で含める)
  constella task get <id>
  constella task add <タイトル> --board B [--status S] [--tags a,b] [--start D] [--end D]
                  [--priority P1] [--parent <id>] [--desc 説明]
  constella task set <id> key=値 ...       例: status=完了 end=今日+3 tags+=急ぎ priority=P1
                  [--expect key=値]        (現在値が違えば中止 = 競合検出)
  constella task delete <id>               子孫タスクも一緒に削除
  constella task script "<スクリプト>" [--board B | --master M]
                                           一括編集スクリプト (アプリの「一括編集」と同じ文法)

  constella notes [--master M] [--folder F] [--tag T] [--q 文字] [--archived] [--full]
                                           --archived: アーカイブ済みだけを表示
  constella note get <id> [--raw]          --raw: 本文 Markdown だけを出力
  constella note add <タイトル> [--master M] [--folder F] [--tags a,b]
                  [--content 文字 | --file パス | --stdin]
  constella note set <id> [--title T] [--tags a,b] [--content 文字 | --file パス | --stdin]
                  [--append 文字] [--prepend 文字] [--folder F] [--pin | --unpin]
                  [--expect-updated <updatedAt>]
  constella note archive <id> | unarchive <id> | delete <id>

  constella apply <ops.json | ->           操作の JSON 配列をまとめて適用 (1 undo)

共通オプション:
  -y, --yes       書き込みを適用する (付けないとプレビューのみ)
  --json          結果を JSON で出力
  --no-launch     アプリが起動していなくても起動しない
  -h, --help      このヘルプ

値の書き方:
  状態  todo / 進行中 / 完了 (in-progress, done …) またはボードのカスタムステータス名
  日付  YYYY-MM-DD / 今日 / 今日+3 / today-7。空 (start=) で解除
  ボード / マスター  id か名前 (一意になる部分一致も可)
  タグ  カンマ区切り (a,b)。タグ名の中の空白はそのまま

apply の ops 例:
  [{"op":"task.add","board":"開発","title":"設計","as":"d"},
   {"op":"task.add","board":"開発","title":"API","parent":"$d","end":"今日+7"},
   {"op":"task.update","id":"abc","set":{"status":"done"},"expect":{"status":"in-progress"}},
   {"op":"note.update","id":"n1","append":"- 追記"}]
  op: task.add / task.update / task.delete / task.script / note.add / note.update / note.delete
`

// ── 引数 ──

function parseArgs(argv) {
  const pos = []
  const opt = {}
  const FLAGS = new Set(['yes', 'json', 'no-launch', 'help', 'all', 'full', 'archived', 'raw', 'stdin', 'pin', 'unpin'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-y') { opt.yes = true; continue }
    if (a === '-h') { opt.help = true; continue }
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) { pushOpt(opt, key, a.slice(eq + 1)); continue }
      if (FLAGS.has(key)) { opt[key] = true; continue }
      const v = argv[i + 1]
      if (v === undefined) die(`--${key} に値がありません`)
      pushOpt(opt, key, v); i++
      continue
    }
    pos.push(a)
  }
  return { pos, opt }
}
function pushOpt(opt, k, v) {
  if (k === 'expect') { (opt.expect ??= []).push(v); return }
  opt[k] = v
}

function die(msg, code = 1) {
  process.stderr.write(`constella: ${msg}\n`)
  process.exit(code)
}

// ── 接続 ──

function userDataDir() {
  if (process.env.CONSTELLA_USERDATA) return process.env.CONSTELLA_USERDATA
  // アプリが userData/bin に置いた CLI なら、1 つ上が userData。
  const here = dirname(fileURLToPath(import.meta.url))
  if (existsSync(join(here, '..', 'cli.json'))) return join(here, '..')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'constella')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'constella')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'constella')
}

function readInfo() {
  try { return JSON.parse(readFileSync(join(userDataDir(), 'cli.json'), 'utf8')) } catch { return null }
}

function post(info, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = request({
      host: '127.0.0.1', port: info.port, path: '/rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: `Bearer ${info.token}` },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let json
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json = { ok: false, error: `HTTP ${res.statusCode}` } }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(data)
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function launchApp(info) {
  const exe = process.env.CONSTELLA_APP || info?.launch
  if (!exe || !existsSync(exe)) {
    die('Constella が起動していません。アプリを起動してから再実行してください' + (exe ? ` (起動ファイルが見つかりません: ${exe})` : ''), 3)
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['--cli-launch'], { detached: true, stdio: 'ignore', env }).unref()
}

let launched = false
async function call(method, params, opt) {
  const deadline = Date.now() + 60000
  let info = readInfo()
  let rejected = null // 401 を返した接続情報 (再起動直後の古い cli.json なら読み直しで直る)
  for (;;) {
    if (info?.port && info?.token) {
      try {
        const { status, json } = await post(info, { method, params })
        if (status === 503 && json.retry && Date.now() < deadline) { await sleep(300); continue }
        if (status === 401) {
          if (rejected?.port === info.port && rejected.token === info.token) die('認証に失敗しました (cli.json のトークンが一致しません)', 2)
          rejected = { port: info.port, token: info.token }
          info = readInfo()
          continue
        }
        if (!json.ok) die(json.error || `HTTP ${status}`, 2)
        return json.result
      } catch (e) {
        if (!['ECONNREFUSED', 'ECONNRESET'].includes(e.code) && e.message !== 'timeout') die(`接続に失敗しました: ${e.message}`)
        if (e.message === 'timeout') die('アプリが応答しません (タイムアウト)')
      }
    }
    if (!launched) {
      if (opt['no-launch']) die('Constella が起動していません', 3)
      launchApp(info ?? readInfo())
      launched = true
      process.stderr.write('Constella を起動しています…\n')
    }
    if (Date.now() > deadline) die('アプリの起動を待ちきれませんでした (60 秒)', 3)
    await sleep(400)
    const next = readInfo()
    if (next?.port && next.token) info = next
    else info = null
  }
}

// ── 入力ヘルパ ──

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}
function contentFrom(opt, { allowStdinDash = true } = {}) {
  if (opt.file != null) {
    try { return readFileSync(opt.file, 'utf8') } catch (e) { die(`ファイルを読めません: ${opt.file} (${e.message})`) }
  }
  if (opt.stdin || (allowStdinDash && opt.content === '-')) return readStdin()
  return opt.content
}
function scope(opt) {
  const p = {}
  if (opt.master != null) p.master = opt.master
  if (opt.board != null) p.board = opt.board
  return p
}
// "a=1" / "tags+=x" / "tags-=x"
function parseAssignments(list) {
  const set = {}
  for (const a of list) {
    const m = /^([A-Za-z]+)(\+=|-=|=)([\s\S]*)$/.exec(a)
    if (!m) die(`"${a}" は key=値 の形ではありません`)
    let [, k, op, v] = m
    k = { desc: 'description', due: 'end', parentId: 'parent' }[k] ?? k
    if (op === '+=') { if (k !== 'tags') die(`+= は tags にだけ使えます`); set.addTags = v; continue }
    if (op === '-=') { if (k !== 'tags') die(`-= は tags にだけ使えます`); set.removeTags = v; continue }
    set[k] = v === '' ? null : v
  }
  return set
}

// ── 出力 ──

const STATUS_MARK = { todo: '○', 'in-progress': '◐', done: '●' }
const out = (s) => process.stdout.write(s + '\n')

function printTasks(list) {
  if (!list.length) return out('(該当なし)')
  for (const t of list) {
    const bits = [`${STATUS_MARK[t.status] ?? ''} ${t.statusLabel}`.padEnd(6), t.title]
    if (t.priority) bits.push(`P${t.priority}`)
    if (t.tags?.length) bits.push(t.tags.map(x => '#' + x).join(' '))
    const dates = t.start && t.end && t.start !== t.end ? `${t.start}〜${t.end}` : (t.end || t.start)
    if (dates) bits.push(`[${dates}]`)
    out(`${t.id}  ${bits.join('  ')}  — ${t.board}`)
  }
}
function printNotes(list) {
  if (!list.length) return out('(該当なし)')
  for (const n of list) {
    const bits = [n.pinned ? '📌 ' + n.title : n.title]
    if (n.tags?.length) bits.push(n.tags.map(x => '#' + x).join(' '))
    if (n.folder) bits.push(`📁${n.folder}`)
    if (n.archivedAt) bits.push('(アーカイブ)')
    out(`${n.id}  ${bits.join('  ')}  — ${n.master}  ${(n.updatedAt || '').slice(0, 10)}`)
  }
}
function fmtVal(v) {
  if (v === undefined || v === null) return '∅'
  if (Array.isArray(v)) return v.length ? v.join(',') : '∅'
  const s = String(v)
  return s.length > 40 ? JSON.stringify(s.slice(0, 40) + '…') : s
}
function printApply(r) {
  const head = r.dryRun ? 'プレビュー (適用するには -y を付けて再実行)' : (r.applied ? '適用しました (アプリで Ctrl+Z 1 回で戻せます)' : '変更はありません')
  const L = { 'task.add': '＋タスク', 'task.update': '✎タスク', 'task.delete': '−タスク', 'note.add': '＋ノート', 'note.update': '✎ノート', 'note.delete': '−ノート' }
  for (const c of r.changes) {
    if (c.warning) { out(`  ⚠ ${c.warning}`); continue }
    let line = `  ${L[c.op] ?? c.op}  ${c.title ?? ''}  (${c.id}${c.board ? ', ' + c.board : c.master ? ', ' + c.master : ''})`
    if (c.withDescendants) line += `  +子孫 ${c.withDescendants} 件`
    out(line)
    for (const [k, [b, a]] of Object.entries(c.diff ?? {})) out(`      ${k}: ${fmtVal(b)} → ${fmtVal(a)}`)
    if (c.content) out(`      本文: ${c.content.before} → ${c.content.after} 文字`)
  }
  const n = r.changes.filter(c => !c.warning).length
  out(`${n ? n + ' 件 — ' : ''}${head}`)
  if (Object.keys(r.refs ?? {}).length) out(`作成 id: ${Object.entries(r.refs).map(([k, v]) => `$${k}=${v}`).join(' ')}`)
}

// ── メイン ──

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2))
  if (opt.help || !pos.length) { out(HELP); return }
  const [cmd, sub, ...rest] = pos
  const json = !!opt.json
  const show = (result, printer) => json ? out(JSON.stringify(result, null, 2)) : printer(result)
  const apply = async (ops) => {
    const r = await call('apply', { ops, dryRun: !opt.yes }, opt)
    show(r, printApply)
  }

  switch (cmd) {
    case 'status': {
      const v = await call('version', {}, opt)
      await call('ping', {}, opt)
      return show({ ...v, connected: true }, r => out(`接続 OK — Constella ${r.version} (pid ${r.pid})`))
    }
    case 'masters':
      return show(await call('masters', { all: !!opt.all }, opt), list => list.forEach(m => out(`${m.id}  ${m.active ? '★ ' : ''}${m.name}  ボード${m.boards} / ノート${m.notes}${m.archivedAt ? '  (アーカイブ)' : ''}`)))
    case 'boards':
      return show(await call('boards', scope(opt), opt), list => list.forEach(b => out(`${b.id}  ${b.name}  未完了${b.open}/${b.tasks}  — ${b.master}${b.customStatuses ? '  状態: ' + b.customStatuses.map(d => d.name).join(',') : ''}`)))
    case 'folders':
      return show(await call('folders', scope(opt), opt), list => list.forEach(f => out(`${f.id}  ${f.name}  — ${f.master}`)))

    case 'tasks':
      if (sub && sub !== 'list') die(`tasks ${sub} は不明です (task get/add/set/delete/script を使ってください)`)
      return show(await call('tasks.list', { ...scope(opt), status: opt.status, tag: opt.tag, q: opt.q, where: opt.where, all: !!opt.all || opt.status != null, full: !!opt.full }, opt), printTasks)
    case 'task': {
      const id = rest[0]
      switch (sub) {
        case 'get': {
          if (!id) die('task get <id>')
          return show(await call('tasks.get', { id }, opt), t => { printTasks([t]); if (t.description) out('\n' + t.description) })
        }
        case 'add': {
          const title = rest.join(' ')
          if (!title) die('task add <タイトル> --board B')
          if (opt.board == null) die('--board でボードを指定してください (constella boards で一覧)')
          return apply([{ op: 'task.add', ...scope(opt), title, status: opt.status, tags: opt.tags, start: opt.start, end: opt.end ?? opt.due, priority: opt.priority, parent: opt.parent, description: opt.desc }])
        }
        case 'set': case 'update': {
          if (!id) die('task set <id> key=値 ...')
          const set = parseAssignments(rest.slice(1))
          if (!Object.keys(set).length) die('変更内容 (key=値) がありません')
          const expect = opt.expect ? parseAssignments(opt.expect) : undefined
          return apply([{ op: 'task.update', id, set, expect }])
        }
        case 'delete': case 'rm': {
          if (!id) die('task delete <id>')
          return apply(rest.map(x => ({ op: 'task.delete', id: x })))
        }
        case 'script': {
          const src = rest[0] === '-' || (!rest.length && opt.file == null) ? readStdin() : opt.file != null ? readFileSync(opt.file, 'utf8') : rest.join(' ')
          return apply([{ op: 'task.script', script: src, ...scope(opt) }])
        }
        default: die(`task ${sub ?? ''} は不明です (get / add / set / delete / script)`)
      }
      return
    }

    case 'notes':
      if (sub && sub !== 'list') die(`notes ${sub} は不明です (note get/add/set/... を使ってください)`)
      return show(await call('notes.list', { master: opt.master, folder: opt.folder, tag: opt.tag, q: opt.q, archived: !!opt.archived, full: !!opt.full }, opt), printNotes)
    case 'note': {
      const id = rest[0]
      switch (sub) {
        case 'get': {
          if (!id) die('note get <id>')
          const n = await call('notes.get', { id }, opt)
          if (opt.raw) return process.stdout.write(n.content)
          // updatedAt は --expect-updated にそのまま渡せる完全な値を出す
          return show(n, x => { printNotes([x]); out(`updatedAt: ${x.updatedAt}`); out('\n' + x.content) })
        }
        case 'add': {
          const title = rest.join(' ')
          if (!title) die('note add <タイトル>')
          return apply([{ op: 'note.add', master: opt.master, folder: opt.folder, title, tags: opt.tags, content: contentFrom(opt) ?? '' }])
        }
        case 'set': case 'update': {
          if (!id) die('note set <id> ...')
          const o = { op: 'note.update', id }
          const content = contentFrom(opt)
          if (content !== undefined) o.content = content
          for (const k of ['title', 'tags', 'append', 'prepend', 'folder']) if (opt[k] !== undefined) o[k] = opt[k]
          if (opt.pin) o.pinned = true
          if (opt.unpin) o.pinned = false
          if (opt['expect-updated']) o.expectUpdatedAt = opt['expect-updated']
          if (Object.keys(o).length <= 2) die('変更内容がありません (--title / --content / --append など)')
          return apply([o])
        }
        case 'archive': case 'unarchive': {
          if (!id) die(`note ${sub} <id>`)
          return apply(rest.map(x => ({ op: 'note.update', id: x, archived: sub === 'archive' })))
        }
        case 'delete': case 'rm': {
          if (!id) die('note delete <id>')
          return apply(rest.map(x => ({ op: 'note.delete', id: x })))
        }
        default: die(`note ${sub ?? ''} は不明です (get / add / set / archive / unarchive / delete)`)
      }
      return
    }

    case 'apply': {
      const src = !sub || sub === '-' ? readStdin() : (() => { try { return readFileSync(sub, 'utf8') } catch (e) { return die(`ファイルを読めません: ${sub} (${e.message})`) } })()
      let ops
      try { ops = JSON.parse(src) } catch (e) { die(`JSON として読めません: ${e.message}`) }
      return apply(Array.isArray(ops) ? ops : ops.ops)
    }
    case 'help':
      return out(HELP)
    default:
      die(`不明なコマンド: ${cmd} (constella --help)`)
  }
}

main().catch(e => die(e?.message ?? String(e)))
