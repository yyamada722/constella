// 保存処理の本体。ポップアップはフォーカスを失うと即座に破棄されるので、
// MHTML の取得と送信はここ (service worker) で完結させる。
import { BridgeError, MAX_CLIP_BYTES, enqueue, flushQueue, getStored, refreshBadge, sendSave } from './lib.js'

const MENU_PAGE = 'constella-save-page'
const MENU_LINK = 'constella-save-link'
const FLUSH_ALARM = 'constella-flush'

function setup() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'このページをリサーチに保存', contexts: ['page', 'selection'] })
    chrome.contextMenus.create({ id: MENU_LINK, title: 'リンク先をリサーチに保存', contexts: ['link'] })
  })
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 })
  void flushQueue()
}
chrome.runtime.onInstalled.addListener(setup)
chrome.runtime.onStartup.addListener(setup)
chrome.alarms.onAlarm.addListener((a) => { if (a.name === FLUSH_ALARM) void flushQueue() })

async function capture(tabId) {
  try {
    const blob = await chrome.pageCapture.saveAsMHTML({ tabId })
    if (!blob) return { warning: 'オフラインクリップを取得できませんでした' }
    if (blob.size > MAX_CLIP_BYTES) return { warning: 'ページが大きすぎるため、クリップなしで保存しました' }
    return { blob }
  } catch {
    return { warning: 'オフラインクリップを取得できませんでした' }
  }
}

// 戻り値 status: created / updated / existed / queued
async function save(meta, tabId, wantClip) {
  const captured = wantClip && tabId != null ? await capture(tabId) : {}
  try {
    const result = await sendSave(meta, captured.blob ?? null)
    return { status: result.updated ? 'updated' : result.existed ? 'existed' : 'created', warning: captured.warning }
  } catch (e) {
    if (e instanceof BridgeError && e.kind === 'offline') {
      await enqueue(meta)
      return { status: 'queued' }
    }
    throw e
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'save') {
    save(msg.meta, msg.tabId, msg.clip).then(reply, (e) => reply({ status: 'error', kind: e.kind, error: e.message }))
    return true // 非同期で reply する
  }
  if (msg?.type === 'flush') {
    flushQueue().then(() => reply({}), () => reply({}))
    return true
  }
})

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setBadgeText({ text })
  setTimeout(() => { void refreshBadge() }, 2500)
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const isLink = info.menuItemId === MENU_LINK
  const url = isLink ? info.linkUrl : info.pageUrl
  if (!/^https?:/i.test(url || '')) return flashBadge('!', '#e11d48')
  const { clip, lastMaster, lastFolder } = await getStored(['clip', 'lastMaster', 'lastFolder'])
  const meta = {
    url,
    title: isLink ? (info.selectionText || url) : (tab?.title || url),
    description: info.selectionText && !isLink ? info.selectionText : '',
    tags: [],
    master: lastMaster,
    folderId: lastMaster ? lastFolder?.[lastMaster] : undefined,
    dedupe: true,
    lenient: true, // 記憶していた保存先が消えていても、今のプロジェクトへ登録する
  }
  try {
    const r = await save(meta, tab?.id, !isLink && !!clip)
    if (r.status === 'queued') await refreshBadge()
    else flashBadge(r.warning ? '!' : r.status === 'existed' ? '済' : '✓', r.warning ? '#d97706' : '#059669')
  } catch {
    flashBadge('!', '#e11d48')
  }
})
