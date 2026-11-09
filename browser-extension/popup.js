import { BridgeError, checkCode, getStored, rpc, setStored } from './lib.js'

const $ = (id) => document.getElementById(id)
const VIEWS = ['view-loading', 'view-blocked', 'view-setup', 'view-form', 'view-done']
const show = (view) => VIEWS.forEach((v) => { $(v).hidden = v !== view })

const MAX_SUGGEST = 18
const MAX_RECENT_TAGS = 20

let tab = null
let online = false
let targets = null // アプリから取得、またはオフライン時は前回の控え
let matches = []
let prefilledId = null
let selectedTags = []
let memory = { lastMaster: undefined, lastFolder: {}, recentTags: [] }

function fail(el, message) {
  el.textContent = message
  el.hidden = !message
}

// ページの選択テキスト (なければ meta description) をメモの初期値にする。
async function readPageSummary(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selected = String(window.getSelection() || '').trim()
        if (selected) return selected
        const meta = document.querySelector('meta[name="description" i], meta[property="og:description" i]')
        return meta?.getAttribute('content')?.trim() || ''
      },
    })
    return String(r?.result || '').slice(0, 2000)
  } catch {
    return '' // ストア等、スクリプトを実行できないページ
  }
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map((o) => {
    const el = document.createElement('option')
    el.value = o.value
    el.textContent = o.label
    return el
  }))
  if (options.some((o) => o.value === value)) select.value = value
}

const currentMaster = () => targets?.masters.find((m) => m.id === $('master').value)

function renderFolders() {
  const master = currentMaster()
  fillSelect($('folder'), [{ value: '', label: '未分類' }, ...(master?.folders ?? []).map((f) => ({ value: f.id, label: f.path }))], memory.lastFolder[master?.id] ?? '')
}

// ── タグ ──

function tagButton(name, on) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = on ? 'tag on' : 'tag'
  b.textContent = name
  b.addEventListener('click', () => {
    if (on) selectedTags = selectedTags.filter((t) => t !== name)
    else { selectedTags.push(name); $('tag-input').value = '' }
    renderTags()
    $('tag-input').focus()
  })
  return b
}

function renderTags() {
  const input = $('tag-input')
  $('tag-box').replaceChildren(...selectedTags.map((t) => tagButton(t, true)), input)
  // 最近使った順 → このプロジェクトでよく使う順 → 全体でよく使う順
  const pool = [...new Set([...memory.recentTags, ...(currentMaster()?.tags ?? []), ...(targets?.tags ?? [])])]
  const q = input.value.trim().toLowerCase()
  const hits = pool.filter((t) => !selectedTags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, MAX_SUGGEST)
  $('tag-suggest').replaceChildren(...hits.map((t) => tagButton(t, false)))
  $('tag-suggest').hidden = !hits.length
}

function commitTagInput() {
  const input = $('tag-input')
  const names = input.value.split(/[,、，]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
  for (const n of names) if (!selectedTags.includes(n)) selectedTags.push(n)
  input.value = ''
  renderTags()
}

// ── フォーム ──

function currentMatch() {
  return online ? matches.find((m) => m.masterId === $('master').value) : undefined
}

function renderDuplicate() {
  const hit = currentMatch()
  fail($('duplicate'), hit ? '登録済みのページです。内容を編集して上書きできます。' : '')
  // 上書きで既存のメモ・タグ・フォルダーを消さないよう、今の内容から編集を始める。
  if (hit && prefilledId !== hit.id) {
    prefilledId = hit.id
    $('title').value = hit.title
    $('description').value = hit.description
    selectedTags = [...hit.tags]
    $('folder').value = hit.folderId ?? ''
  }
  $('add-anyway').hidden = !hit
  $('save').textContent = hit ? '上書き' : '保存'
}

async function connect() {
  show('view-loading')
  online = false
  try {
    targets = await rpc('research.targets')
    matches = (await rpc('research.lookup', { url: tab.url })).matches
    online = true
    await setStored({ targetsCache: targets })
    void chrome.runtime.sendMessage({ type: 'flush' })
  } catch (e) {
    if (e instanceof BridgeError && e.kind === 'unauthorized') return show('view-setup')
    if (!(e instanceof BridgeError && e.kind === 'offline')) fail($('form-error'), e.message)
    targets = (await getStored(['targetsCache'])).targetsCache ?? null
  }
  await renderForm()
}

async function renderForm() {
  const stored = await getStored(['clip', 'lastMaster', 'lastFolder', 'recentTags'])
  memory = { lastMaster: stored.lastMaster, lastFolder: stored.lastFolder || {}, recentTags: stored.recentTags || [] }

  $('domain').textContent = new URL(tab.url).hostname.replace(/^www\./, '')
  if (tab.favIconUrl) {
    $('favicon').src = tab.favIconUrl
    $('favicon').onload = () => { $('favicon').hidden = false }
  }
  $('title').value = tab.title || tab.url
  $('description').value = await readPageSummary(tab.id)
  $('clip').checked = !!stored.clip
  $('offline').hidden = online
  $('clip-row').hidden = !online // 未送信キューにはクリップを積まない
  document.querySelectorAll('.row-target').forEach((el) => { el.hidden = !targets })

  if (targets) {
    const remembered = targets.masters.some((m) => m.id === memory.lastMaster)
    fillSelect($('master'), targets.masters.map((m) => ({ value: m.id, label: m.name })), remembered ? memory.lastMaster : targets.active)
    renderFolders()
    renderDuplicate()
  }
  renderTags()
  show('view-form')
  $('title').focus()
  $('title').select()
}

async function save(forceNew) {
  fail($('form-error'), '')
  commitTagInput()
  const master = targets ? $('master').value : undefined
  const folderId = targets ? $('folder').value : undefined
  const hit = forceNew ? undefined : currentMatch()
  const meta = {
    url: tab.url,
    title: $('title').value,
    description: $('description').value,
    tags: selectedTags,
    master,
    folderId,
    updateId: hit?.id,
  }
  const clip = online && $('clip').checked
  $('save').disabled = true
  $('add-anyway').disabled = true
  $('save').textContent = clip ? 'クリップ中' : '保存中'

  const r = await chrome.runtime.sendMessage({ type: 'save', meta, tabId: tab.id, clip })
  if (r.status === 'error') {
    if (r.kind === 'unauthorized') return show('view-setup')
    $('save').disabled = false
    $('add-anyway').disabled = false
    renderDuplicate()
    return fail($('form-error'), r.error)
  }

  // 成功したときだけ記憶する (失敗した宛先を次回の既定にしない)
  await setStored({
    ...(online ? { clip } : {}),
    ...(master ? { lastMaster: master, lastFolder: { ...memory.lastFolder, [master]: folderId } } : {}),
    recentTags: [...new Set([...selectedTags, ...memory.recentTags])].slice(0, MAX_RECENT_TAGS),
  })

  const text = $('done-text')
  text.textContent = r.status === 'queued' ? '次の起動時に登録します' : r.status === 'updated' ? '上書きしました' : '保存しました'
  if (r.warning) text.append(document.createElement('br'), r.warning)
  show('view-done')
  setTimeout(() => window.close(), r.warning ? 2500 : 800)
}

$('master').addEventListener('change', () => { renderFolders(); renderDuplicate(); renderTags() })
$('view-form').addEventListener('submit', (e) => { e.preventDefault(); void save(false) })
$('add-anyway').addEventListener('click', () => { void save(true) })
$('change-code').addEventListener('click', () => { $('code').value = ''; show('view-setup') })

$('title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('view-form').requestSubmit() }
})

$('tag-input').addEventListener('keydown', (e) => {
  if (e.isComposing) return
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault() // タグ確定の Enter を続けて押しても保存されないように
    commitTagInput()
  } else if (e.key === 'Backspace' && !e.target.value && selectedTags.length) {
    selectedTags.pop()
    renderTags()
    $('tag-input').focus()
  }
})
$('tag-input').addEventListener('input', (e) => {
  if (!e.isComposing && /[,、，]/.test(e.target.value)) commitTagInput()
  else renderTags()
  e.target.focus()
})
$('tag-input').addEventListener('compositionend', (e) => {
  if (/[,、，]/.test(e.target.value)) { commitTagInput(); e.target.focus() }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('view-form').hidden) {
    e.preventDefault()
    $('view-form').requestSubmit()
  }
})

$('connect').addEventListener('click', async () => {
  const code = $('code').value.trim()
  fail($('setup-error'), '')
  if (!code) return
  $('connect').disabled = true
  try {
    await checkCode(code)
    await setStored({ code })
    await connect()
  } catch (e) {
    fail($('setup-error'), e.kind === 'unauthorized' ? '接続コードが違います。設定画面のコードを確認してください。' : 'Constella に接続できません。アプリを起動してからやり直してください。')
  } finally {
    $('connect').disabled = false
  }
})

async function init() {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !/^https?:/i.test(tab.url || '')) return show('view-blocked')
  const { code } = await getStored(['code'])
  if (!code) return show('view-setup')
  await connect()
}
void init()
