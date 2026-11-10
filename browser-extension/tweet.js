// X (Twitter) のツイート。本文・画像・動画の取得はアプリ側 (src/main/tweetClip.ts) が
// 公開埋め込み API で行う。ここでは、鍵アカウント等で API が使えないときの代わりに、
// 表示中のページからツイートの内容を読む。

// src/main/tweetClip.ts の STATUS_RE と揃える。
const STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,30}|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})/i

export const tweetIdOf = (url) => STATUS_RE.exec(String(url || ''))?.[2] ?? null

// 右クリックメニューの対象 (タイムラインの各ツイートの日時リンク等)
export const TWEET_LINK_PATTERNS = [
  'https://x.com/*/status/*', 'https://twitter.com/*/status/*',
  'https://mobile.x.com/*/status/*', 'https://mobile.twitter.com/*/status/*',
]

// ページ内で実行される (chrome.scripting.executeScript の func)。外の変数は参照できない。
function readTweetInPage(id) {
  const articles = [...document.querySelectorAll('article[data-testid="tweet"], article')]
  // 引用ツイートの中のリンクは除く: 自分の article 直下の時刻リンクで判定する
  const own = (a) => [...a.querySelectorAll(`a[href*="/status/${id}"] time`)].some((t) => t.closest('article') === a)
  const art = articles.find(own) || (articles.length === 1 ? articles[0] : null)
  if (!art) return null
  // 引用ツイート (article 内の role=link ブロック) の中身は本体として拾わない
  const inQuote = (el) => {
    const q = el.closest('div[role="link"]')
    return !!q && art.contains(q) && q !== art
  }
  const textEl = [...art.querySelectorAll('[data-testid="tweetText"]')].find((el) => !inQuote(el))
  const nameBox = art.querySelector('[data-testid="User-Name"]')
  const spans = nameBox ? [...nameBox.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean) : []
  const handle = spans.find((t) => /^@\w{1,30}$/.test(t))
  const links = textEl ? [...textEl.querySelectorAll('a[href]')]
    .filter((a) => /^https?:\/\/t\.co\//.test(a.href) || (/^https?:/.test(a.href) && !/^https?:\/\/(x|twitter)\.com\//.test(a.href)))
    .map((a) => {
      // 表示は省略 (…) されるが、textContent には省略前の URL が入っている
      const full = a.textContent.replace(/…$/, '').trim()
      return { url: /^https?:\/\//.test(full) ? full : a.href, display: a.innerText.trim() }
    }) : []
  const images = [...art.querySelectorAll('[data-testid="tweetPhoto"] img')]
    .filter((img) => !inQuote(img))
    .map((img) => img.src)
  const videos = [...art.querySelectorAll('video')]
    .filter((v) => !inQuote(v))
    .map((v) => ({ poster: v.poster || undefined }))
  const avatar = art.querySelector('[data-testid="Tweet-User-Avatar"] img')
  return {
    text: textEl ? textEl.innerText : '',
    authorName: spans[0] || '',
    authorHandle: handle ? handle.slice(1) : '',
    avatarUrl: avatar?.src,
    createdAt: [...art.querySelectorAll('time')].find((t) => t.closest('article') === art && !inQuote(t))?.getAttribute('datetime') || undefined,
    images: [...new Set(images)],
    videos,
    links,
  }
}

export async function readTweetFromPage(tabId, url) {
  const id = tweetIdOf(url)
  if (!id || tabId == null) return null
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readTweetInPage, args: [id] })
    return r?.result ?? null
  } catch {
    return null
  }
}

export function tweetTitleOf(t) {
  if (!t) return ''
  const body = String(t.text || '').replace(/\s+/g, ' ').trim()
  const head = `${t.authorName || ''}${t.authorHandle ? ` (@${t.authorHandle})` : ''}`.trim()
  if (!head) return ''
  return body ? `${head}: ${body.length > 80 ? body.slice(0, 80) + '…' : body}` : head
}
